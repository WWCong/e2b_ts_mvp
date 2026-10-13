/**
 * 内核：注册表、插件与生命周期、Run 的创建与执行、挂起，对外的调用、收割、送值与撤回、取消、关停接口。
 * 内核不注册任何 Operation，注册表里的全部来自装载的插件；park 的 Operation 形式是 harness 插件的 harness_park。
 */

import { z } from "zod";
import { runChain, type DecoratorCtx, type DecoratorDef } from "./chain";
import { EventStream, notify, type EventBody, type HarnessEvent } from "./events";
import { AFTER, PLUGIN_KEYS, type BeforeEvent, type BeforeHook, type PluginObject } from "./plugin";
import { checkName, checkPackageName } from "./names";
import { calls } from "./ops";
import { reject, transition, type Ctx, type Rejected, type Result, type Run, type ToolSpec } from "./run";
import { digest, fold, Journal, type Recorded, type RunLog } from "./journal";
import { isDone, Replay } from "./replay";
import { inSurface, type Surface } from "./surface";

/** ctx 之外恰好一个入参、返回 Promise；ctx 不算入参，不进 schema */
export type OperationImpl = (ctx: Ctx, input: any) => Promise<unknown>;

/**
 * 注册表里的一项 Operation。插件用 op() 声明，kernel.use 补上名字「包名_键名」（plugin.ts、names.ts）。
 * 后续加入：limits。
 */
export type Operation = Surface & {
  name: string;
  /** 用法说明：交给模型时即工具的 description */
  usage?: string;
  /** 公开的才会作为工具交给模型（7.2）；缺省不公开 */
  public?: boolean;
  /** 入参契约：建 Run 前按它校验，实现拿到解析后的值；也是交给模型的工具 schema（z.toJSONSchema） */
  input: z.ZodType;
  impl: OperationImpl;
  /** 自选装饰器，按书写顺序从外到内 */
  decorators?: string[];
};

/** 装配配置里内核关心的部分 */
export type KernelConfig = {
  /** 包住所有调用的装饰器，从外到内 */
  defaultDecorators?: string[];
  /** 写前日志的目录：持久卷上、任何原语不可达（R11）。不配就不记 */
  journalDir?: string;
  /** 资源保险丝（3.4）。后续加入：同时等待的 park 数上限 */
  kernel?: { maxDepth?: number; maxLiveRuns?: number };
};

const FUSE_DEFAULTS = { maxDepth: 32, maxLiveRuns: 1024 };

/** 等待中的 park：它是这个 Run 的第 seq 步；送来的值按 schema 校验；closed 在关闭时带着产出兑现 */
type Park = { seq: number; schema: z.ZodType; closed: PromiseWithResolvers<Result> };

/** 恢复时重新执行一个 Run：沿用原 runId，attempt 加一；logs 是这棵树里每个 Run 在日志里的记录 */
type Resume = { runId: string; attempt: number; logs: Map<string, RunLog> };

/** 通过检查、待执行的 Run；raw 是调用方给的原样入参（进 run.started、日志比对用它）；恢复时重新执行的带着树的日志记录 */
type Admitted = { run: Run; op: Operation; chain: DecoratorDef[]; raw: unknown; logs?: Map<string, RunLog> };

/** 在途 Run 的内核侧记录；Run 退出或被杀后移除 */
type LiveRun = {
  run: Run;
  parent?: LiveRun;
  /** 这个 Run 是父的第几个调用；根 Run 没有 */
  seq?: number;
  /** 这个 Run 已发起的调用与 park 的个数，即下一个的序号 */
  issued: number;
  /** 恢复中的树里每个 Run 在日志里的记录：在途的子 Run 重新执行时从这里取它的 */
  logs?: Map<string, RunLog>;
  /** 恢复时重新执行的 Run 按序号回放它自己的记录 */
  replay?: Replay;
  /** 关停时被停在调用边界上：在等一个不会开始的调用或 park */
  held?: boolean;
  /** 在途的子 Run */
  children: Set<LiveRun>;
  /** 经 ctx.park 等值时才有 */
  park?: Park;
  /** Run 的结果：正常退出与被杀，谁先到算谁 */
  done: PromiseWithResolvers<Result>;
  /** 被杀时 abort，即 ctx.signal */
  abort: AbortController;
};

/**
 * 生命周期：assembling 装配中（use、register）→ booting 插件 onStart 中 → running 接受调用 → stopping 关停中。
 * 启动失败停在 booting
 */
type Phase = "assembling" | "booting" | "running" | "stopping";

export class Kernel {
  readonly events: EventStream;
  private phase: Phase = "assembling";
  /** 包名 → 插件对象，按装载顺序 */
  private readonly plugins = new Map<string, PluginObject>();
  /** 插件的 onStop 只跑一次：重复 stop（比如优雅关停中又强杀）共用它 */
  private stopped?: Promise<void>;
  private readonly operations = new Map<string, Operation>();
  private readonly decorators = new Map<string, DecoratorDef>();
  /** 公开 Operation 的工具描述，注册时生成 */
  private readonly tools = new Map<string, ToolSpec>();
  /** runId → 退出结果。结果保留到调用方收割，收割后移除（3.4） */
  private readonly exits = new Map<string, Promise<Result>>();
  /** runId → 在途 Run */
  private readonly lives = new Map<string, LiveRun>();
  private readonly fuse: { maxDepth: number; maxLiveRuns: number };
  /** 关停时，没有正在执行的调用了（只剩停住的与 park）就兑现 */
  private quiet?: PromiseWithResolvers<void>;
  private readonly journal?: Journal;
  /** 产物摘要的缓存；注册了新的 Operation 或装饰器就作废 */
  private artifactDigest?: string;

  constructor(private readonly config: KernelConfig = {}) {
    this.fuse = { ...FUSE_DEFAULTS, ...config.kernel };
    if (config.journalDir) this.journal = new Journal(config.journalDir);
    // 提交阶段：每条事件先交给写前日志落盘，再交给插件（journal.ts commit）
    const journal = this.journal;
    this.events = new EventStream(journal && ((event) => journal.commit(event)));
  }

  /**
   * 装上一个插件实例（loader 以装配配置调完工厂后交来）：注册它的 Operation 与装饰器，名字取「包名_键名」；
   * 挂点方法订阅事件流。只能在 boot 之前：boot 时要调它的 onStart
   */
  use(pkg: string, plugin: PluginObject): void {
    if (this.phase !== "assembling") throw new Error(`cannot use ${pkg}: harness is ${this.phase}`);
    checkPackageName(pkg);
    if (this.plugins.has(pkg)) throw new Error(`duplicate plugin: ${pkg}`);
    for (const key of Object.keys(plugin)) {
      if (!PLUGIN_KEYS.has(key)) throw new Error(`${pkg}: unknown key in plugin object: ${key}`);
    }
    for (const [key, decl] of Object.entries(plugin.operations ?? {})) this.register({ name: `${pkg}_${key}`, ...decl });
    for (const [key, decl] of Object.entries(plugin.decorators ?? {})) {
      const id = `${pkg}_${key}`;
      checkName(id);
      this.registerDecorator({ id, ...decl });
    }
    this.plugins.set(pkg, plugin);
    this.events.subscribe((event) => {
      const hook = AFTER[event.type];
      const fn = plugin[hook] as ((event: HarnessEvent) => unknown) | undefined;
      if (fn) notify(`${pkg}.${hook} on event #${event.seq}`, () => fn.call(plugin, event));
      if (plugin.afterAny) notify(`${pkg}.afterAny on event #${event.seq}`, () => plugin.afterAny!(event));
    });
  }

  /** 名字须合命名规则；公开的 Operation 须写 usage；入参 schema 转不成 JSON Schema 的（如 z.date()）在这里就报错 */
  register(op: Operation): void {
    checkName(op.name);
    if (this.operations.has(op.name)) throw new Error(`duplicate operation: ${op.name}`);
    if (op.public) {
      if (!op.usage) throw new Error(`public operation needs usage: ${op.name}`);
      // io: "input" 按调用方要填的形状生成：带默认值的字段是可选的
      const inputSchema = z.toJSONSchema(op.input, { io: "input" }) as Record<string, unknown>;
      this.tools.set(op.name, { name: op.name, description: op.usage, inputSchema });
    }
    this.operations.set(op.name, op);
    this.artifactDigest = undefined;
  }

  /** 注册只是放进注册表；进不进默认集由装配配置决定（6.4） */
  registerDecorator(def: DecoratorDef): void {
    if (this.decorators.has(def.id)) throw new Error(`duplicate decorator: ${def.id}`);
    this.decorators.set(def.id, def);
    this.artifactDigest = undefined;
  }

  /**
   * 对外接口·启动：装配完后调一次。按装载顺序逐个 await 插件的 onStart，有一个抛异常就启动失败；
   * 然后开始接受调用，从写前日志恢复没结束的树，最后通知各插件 afterStart。返回恢复的树的根 runId，供收割。
   * 先恢复再接受外部调用：boot 之前 start 的树会被恢复时再执行一遍，所以 start 必须在 boot 之后。
   */
  async boot(): Promise<string[]> {
    if (this.phase !== "assembling") throw new Error(`harness is ${this.phase}`);
    this.phase = "booting";
    for (const [pkg, plugin] of this.plugins) {
      try {
        await plugin.onStart?.();
      } catch (err) {
        throw new Error(`${pkg}.onStart failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
    }
    this.phase = "running";
    const roots = this.recover();
    for (const [pkg, plugin] of this.plugins) if (plugin.afterStart) notify(`${pkg}.afterStart`, () => plugin.afterStart!());
    return roots;
  }

  /** 对外接口·调用：按名字起一棵 Run 树，返回根 Run 的 runId */
  start(name: string, input: unknown): string {
    if (this.phase !== "running") throw new Error(`harness is ${this.phase}`);
    const admitted = this.admit(name, input);
    if ("ok" in admitted) throw new Error(admitted.reason);
    const veto = this.before("beforeRunStart", this.started(admitted));
    if (veto) throw new Error(`rejected by ${veto.by}: ${veto.reason}`);
    const { runId } = admitted.run;
    this.exits.set(runId, this.execute(admitted));
    return runId;
  }

  /**
   * 启动时恢复：读写前日志，重建所有没结束的树，返回它们根的 runId。
   * 根与崩溃时正在执行的 Run 用原 runId 重新执行，attempt 加一。重新执行时按序号回放：
   * 已完成的调用回送记下的结果（不执行、不过链），已回答的 park 直接拿到回答，没回答的用原 id 重新开出。
   */
  private recover(): string[] {
    if (!this.journal) return [];
    return this.journal.readAll().map((entries) => {
      const { root, runs } = fold(entries);
      const logs = [...runs];
      const tree: BeforeEvent<"beforeTreeRecover"> = {
        type: "tree.recovered",
        runId: root.runId,
        replayed: logs.flatMap(([runId, log]) =>
          [...log.entries].filter(([, recorded]) => isDone(recorded)).map(([seq, recorded]) => ({ runId, seq, ...recorded })),
        ),
        inflight: [
          root.runId,
          ...logs.flatMap(([, log]) =>
            [...log.entries.values()].flatMap((r) => (r.type === "call" && !r.result && r.child ? [r.child] : [])),
          ),
        ],
        artifactChanged: root.artifact !== this.artifact(),
      };
      const veto = this.before("beforeTreeRecover", tree);
      this.events.emit(tree);
      let admitted = veto ?? this.admit(root.operation, root.input, undefined, this.resume(root.runId, runs));
      if (!("ok" in admitted)) admitted = this.before("beforeRunStart", this.started(admitted)) ?? admitted;
      if ("ok" in admitted) {
        // 被拦下，或根都建不起来（Operation 没了、入参不再合法）：不恢复，日志随 run.killed 移到 diverged/ 留着排查
        const reason = admitted.by === "kernel" ? admitted.reason : `rejected by ${admitted.by}: ${admitted.reason}`;
        this.events.emit({ type: "run.killed", runId: root.runId, operation: root.operation, reason });
        this.exits.set(root.runId, Promise.resolve(admitted));
      } else {
        this.exits.set(root.runId, this.execute(admitted));
      }
      return root.runId;
    });
  }

  /** 对外接口·收割：等 Run 退出并取走结果 */
  async reap(runId: string): Promise<Result> {
    const exit = this.exits.get(runId);
    if (!exit) throw new Error(`unknown run: ${runId}`);
    const result = await exit;
    this.exits.delete(runId);
    return result;
  }

  /**
   * 对外接口·送值：把值送给等待中的 park（id 为 park 的 runId），按它的 schema 校验。
   * 不在等待或值不符时抛异常，park 照旧等待。
   */
  unpark(id: string, value: unknown): void {
    const live = this.lives.get(id);
    if (!live?.park) throw new Error(`not parked: ${id}`);
    const parsed = live.park.schema.safeParse(value);
    if (!parsed.success) throw new Error(`invalid value for park ${id}:\n${z.prettifyError(parsed.error)}`);
    this.closeFromOutside(live, live.park, { ok: true, value: parsed.data });
  }

  /** 对外接口·撤回：等待中的 park 以拒绝结果返回，by 为挂起的那个 Operation（如 harness_park） */
  withdraw(id: string, reason: string): void {
    const live = this.lives.get(id);
    if (!live?.park) throw new Error(`not parked: ${id}`);
    this.closeFromOutside(live, live.park, reject(live.run.operation, reason));
  }

  /** 外部送值或撤回：先问 beforeParkClose，被拦下就抛异常、park 照旧等待 */
  private closeFromOutside(live: LiveRun, park: Park, result: Result): void {
    const { runId } = live.run;
    const veto = this.before("beforeParkClose", { type: "park.closed", runId, step: park.seq, result });
    if (veto) throw new Error(`park ${runId} close rejected by ${veto.by}: ${veto.reason}`);
    this.closePark(live, park, result);
  }

  /**
   * 对外接口·取消：取消一个在途 Run 及其子孙，返回是否取消了（已结束或不存在返回 false）。
   * 被取消的 Run 以内核的拒绝结果交给等它的一方：父 Run，或收割方。
   * 正在做 IO 的实现经 ctx.signal 得知取消。
   */
  cancel(runId: string): boolean {
    const live = this.lives.get(runId);
    if (!live) return false;
    this.kill(live, "cancelled");
    return true;
  }

  /**
   * 对外接口·关停（9.2）。不再接受新的外部调用，树里也不再开始新的：新发起的调用与 park 停在边界上，不执行、不记日志。
   * 等正在执行的调用跑完；没有正在执行的了（只剩停住的与 park），或到 timeoutMs，就把在途的树按 shutdown 杀掉。
   * stop(0) 即强杀，什么也不等。日志都保留：
   * - 优雅关停停在干净的边界上，重启后已完成的回放、停住的调用照常发起，没有执行到一半的
   * - 超时或强杀等同崩溃，在途的调用重启后重新执行，attempt 加一
   * 被杀的树 park 不关（不发 park.closed）：它们没被回答，重启后用原 id 接着等。
   * 树都杀掉之后调各插件的 onStop（投递插件 flush、清理资源），按装载的逆序：后装的可能依赖先装的。
   */
  async stop(timeoutMs: number): Promise<void> {
    if (this.phase !== "running" && this.phase !== "stopping") throw new Error(`harness is ${this.phase}`);
    this.phase = "stopping";
    if (timeoutMs > 0) {
      this.quiet = Promise.withResolvers();
      this.checkQuiet();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)));
      await Promise.race([this.quiet.promise, timeout]);
      clearTimeout(timer);
    }
    const roots = [...this.lives.values()].filter((live) => !live.parent);
    for (const live of roots) if (this.lives.has(live.run.runId)) this.kill(live, "shutdown");
    this.stopped ??= this.stopPlugins();
    await this.stopped;
  }

  private async stopPlugins(): Promise<void> {
    for (const [pkg, plugin] of [...this.plugins].reverse()) {
      try {
        await plugin.onStop?.();
      } catch (err) {
        console.error(`[harness] ${pkg}.onStop failed`, err);
      }
    }
  }

  /**
   * 能拦的挂点：按装载顺序问各插件，第一个拦下的生效，返回拒绝结果（by 为它的包名）；都放行返回 undefined。
   * 挂点抛异常或返回 Promise（不是同步的）都按拦下处理。
   */
  private before<H extends BeforeHook>(hook: H, event: BeforeEvent<H>): Rejected | undefined {
    for (const [pkg, plugin] of this.plugins) {
      const fn = plugin[hook] as ((event: EventBody) => unknown) | undefined;
      if (!fn) continue;
      let verdict: unknown;
      try {
        verdict = fn.call(plugin, event);
      } catch (err) {
        console.error(`[harness] ${pkg}.${hook} failed`, err);
        return reject(pkg, `${hook} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (verdict instanceof Promise) {
        verdict.catch(() => {});
        return reject(pkg, `${hook} must be synchronous`);
      }
      if (verdict && typeof verdict === "object" && "veto" in verdict) {
        const { veto, retryable } = verdict as { veto: unknown; retryable?: unknown };
        return { ok: false, by: pkg, reason: String(veto), retryable: retryable === true };
      }
    }
    return undefined;
  }

  /**
   * ctx.call 的实现：发起 caller 的子调用并等它返回。
   * 给了 surface 就检查目标在不在里面；装饰器发起的调用不给。
   */
  private callChild(caller: LiveRun, name: string, input: unknown, surface?: Surface): Promise<Result> {
    const { run } = caller;
    const alive = run.status === "running" || run.status === "waiting";
    if (alive && this.phase === "stopping") return this.hold(caller);
    const seq = caller.issued++;

    // 恢复重放：这个序号上日志里有记录，先比对目标与入参摘要
    const recorded = alive ? caller.replay?.at(seq) : undefined;
    const same = recorded?.type === "call" && recorded.target === name && recorded.input === digest(input) ? recorded : undefined;
    // 已完成的那一步对不上：代码看过它的结果、据此往下走过，判为对不上。
    // 崩溃时在途的那一步对不上（比如 attempt > 1 时先查重）：结果从没交给过代码，允许换路，旧的在途调用作废
    if (recorded && !same && isDone(recorded)) {
      const target = recorded.type === "call" && recorded.target === name;
      return Promise.resolve(this.diverge(caller, seq, recorded, `call ${name}${target ? " with different input" : ""}`));
    }
    let resume: Resume | undefined;
    if (same) {
      // 已完成：按原完成顺序回送记下的结果，不执行、不过链、不再记
      if (same.result) return caller.replay!.deliver(same.order!, same.result);
      // 崩溃时在途：子 Run 用原 runId 重新执行（日志里已有它的 call 行，只记 retry）
      if (same.child) resume = this.resume(same.child, caller.logs!);
    }

    let admitted: Admitted | Rejected;
    if (!alive) admitted = reject("kernel", `caller is ${run.status}`);
    else if (surface && !inSurface(surface, name)) admitted = reject("kernel", `${name} is not in the surface of ${run.operation}`);
    else admitted = this.admit(name, input, run, resume);
    if (!("ok" in admitted)) admitted = this.before("beforeRunStart", this.started(admitted, seq)) ?? admitted;

    // 先记后做：run.started 或 call.rejected 的提交阶段把这次调用落盘之后，子 Run 才开始执行、拒绝才交给调用方。
    // 换路的新调用记一行覆盖旧的
    if ("ok" in admitted) {
      this.events.emit({ type: "call.rejected", runId: run.runId, step: seq, target: name, input, result: admitted });
      return Promise.resolve(admitted);
    }
    return this.execute(admitted, caller, seq);
  }

  /**
   * 建 Run 前的检查（目标存在、保险丝、链能解析、入参符合 schema），通过则建出 Run；
   * 不通过以拒绝返回，不建 Run。
   */
  private admit(name: string, input: unknown, parent?: Run, resume?: Resume): Admitted | Rejected {
    const op = this.operations.get(name);
    if (!op) return reject("kernel", `unknown operation: ${name}`);

    const depth = parent ? parent.depth + 1 : 0;
    if (depth > this.fuse.maxDepth) return reject("kernel", `max depth ${this.fuse.maxDepth} exceeded`);
    if (this.lives.size >= this.fuse.maxLiveRuns) return reject("kernel", `max live runs ${this.fuse.maxLiveRuns} exceeded`);

    // 默认装饰器在外，自选装饰器在内。后续由装配期校验提前发现未注册的 id
    const chain: DecoratorDef[] = [];
    for (const id of [...(this.config.defaultDecorators ?? []), ...(op.decorators ?? [])]) {
      const def = this.decorators.get(id);
      if (!def) return reject("kernel", `unknown decorator: ${id} (operation ${name})`);
      chain.push(def);
    }

    // 入参不对是「这次没写对」，改了能再试
    const parsed = op.input.safeParse(input);
    if (!parsed.success) {
      return { ...reject("kernel", `invalid input for ${name}:\n${z.prettifyError(parsed.error)}`), retryable: true };
    }

    const run: Run = {
      runId: resume?.runId ?? crypto.randomUUID(),
      operation: name,
      input: parsed.data,
      status: "init",
      depth,
      parent: parent?.runId,
      attempt: resume?.attempt ?? 1,
    };
    return { run, op, chain, raw: input, logs: resume?.logs };
  }

  /** 恢复时重新执行一个 Run：attempt 在上次的基础上加一（run.started 的提交阶段记 retry 行，再崩一次还能接着加） */
  private resume(runId: string, logs: Map<string, RunLog>): Resume {
    const attempt = (logs.get(runId)?.attempt ?? 1) + 1;
    return { runId, attempt, logs };
  }

  /** 一个 Run 开始时发的 run.started；step 是它在父里的第几步 */
  private started({ run, chain, raw }: Admitted, step?: number): BeforeEvent<"beforeRunStart"> {
    return {
      type: "run.started",
      runId: run.runId,
      operation: run.operation,
      input: raw,
      parent: run.parent,
      step,
      depth: run.depth,
      chain: chain.map((d) => d.id),
      attempt: run.attempt > 1 ? run.attempt : undefined,
      artifact: run.parent ? undefined : this.artifact(),
    };
  }

  private execute(admitted: Admitted, parent?: LiveRun, seq?: number): Promise<Result> {
    const { run, op, chain, logs } = admitted;
    const log = logs?.get(run.runId);
    const live: LiveRun = {
      run,
      parent,
      seq,
      issued: 0,
      logs,
      replay: log && new Replay(log),
      children: new Set(),
      done: Promise.withResolvers(),
      abort: new AbortController(),
    };
    this.lives.set(run.runId, live);
    if (parent) {
      parent.children.add(live);
      // 父先转 waiting：子 Run 的实现在下面同步开始
      this.refresh(parent);
    }
    transition(run, "running");
    this.events.emit(this.started(admitted, seq));

    // 实现的调用查它自己的能力面；装饰器的调用同样记在这个 Run 名下，但不查它的能力面（4.1）
    const { signal } = live.abort;
    const { runId, attempt } = run;
    const ctx: Ctx = {
      runId,
      attempt,
      ...calls((name, input) => this.callChild(live, name, input, op)),
      signal,
      tools: () => this.toolsIn(op),
      park: (req) => this.park(live, req),
    };
    const decoratorCtx: DecoratorCtx = {
      runId,
      attempt,
      ...calls((name, input) => this.callChild(live, name, input)),
      signal,
    };

    const settle = async () => {
      const result = await runChain(decoratorCtx, run, chain, () => this.invoke(ctx, run, op), this.events);
      // 实现没等完的子调用与 park，等它们都结束再退出，不留悬空的子 Run
      while (live.children.size > 0 || live.park) {
        await Promise.all([...[...live.children].map((c) => c.done.promise), live.park?.closed.promise]);
      }
      // 已被杀：不理会 ctx.signal 的实现照样跑完（JS 无法抢占），但结果作废
      if (run.status === "killed") return;
      // 重新执行的 Run 结束了，日志里却还有没走到的已完成记录：它的效果发生过，新的路径不知道它
      const missed = live.replay?.unreached(live.issued);
      if (missed) return void this.diverge(live, ...missed, "exit");

      const exited = { type: "run.exited", runId: run.runId, operation: run.operation, result } as const;
      const veto = this.before("beforeRunExit", exited);
      transition(run, "exited");
      this.forget(live);
      // 提交阶段：结果落盘（父的 done 行；整棵树结束则删日志）之后才交给父
      this.events.emit(veto ? { ...exited, result: veto } : exited);
      live.done.resolve(veto ?? result);
    };
    void settle();
    return live.done.promise;
  }

  /**
   * 杀掉 live 及其子孙：自己先转 killed（关掉它的 park）、abort 它的 signal，再杀子 Run；
   * 等它的一方拿到内核的拒绝结果。reason：cancelled、shutdown，或重放比对不上时的 diverged …
   * 关停不关 park：它们没被回答、没被取消，重启后接着跑。日志怎么处置由提交阶段按 reason 决定（journal.ts）。
   */
  private kill(live: LiveRun, reason: string): void {
    transition(live.run, "killed");
    this.events.emit({ type: "run.killed", runId: live.run.runId, operation: live.run.operation, reason });
    if (reason !== "shutdown" && live.park) this.closePark(live, live.park, reject("kernel", reason));
    live.abort.abort();
    for (const child of [...live.children]) this.kill(child, reason);
    this.forget(live);
    live.done.resolve(reject("kernel", reason));
  }

  /**
   * 产物摘要：装配了哪些 Operation 与装饰器、它们的声明与代码，加上默认装饰器集。
   * 写进日志的根行，恢复时比对：不同只在 tree.recovered 里提示，逐个调用比对兜底。
   */
  private artifact(): string {
    this.artifactDigest ??= digest({
      operations: [...this.operations.values()]
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map(({ name, usage, public: isPublic, decorators, only, exclude, impl }) => [name, usage, isPublic, decorators, only, exclude, String(impl)]),
      decorators: [...this.decorators.values()]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map(({ id, onError, fn }) => [id, onError, String(fn)]),
      defaultDecorators: this.config.defaultDecorators,
    });
    return this.artifactDigest;
  }

  /** 能力面里的公开 Operation，按名字排序 */
  private toolsIn(surface: Surface): ToolSpec[] {
    return [...this.tools.values()]
      .filter((tool) => inSurface(surface, tool.name))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** Run 退出或被杀后从内核移除；父不再等任何东西时回到 running */
  private forget(live: LiveRun): void {
    this.lives.delete(live.run.runId);
    const { parent } = live;
    if (parent) {
      parent.children.delete(live);
      this.refresh(parent);
    }
    this.checkQuiet();
  }

  /** 关停时停住 live 新发起的调用或 park：不执行、不记日志，永不兑现（进程随后退出，重启后照常发起） */
  private hold(live: LiveRun): Promise<never> {
    live.held = true;
    this.checkQuiet();
    return new Promise(() => {});
  }

  /** 关停中：在途的 Run 都在等子 Run、等 park 或被停住，没有正在执行的了 */
  private checkQuiet(): void {
    if (!this.quiet) return;
    if ([...this.lives.values()].every((live) => live.held || live.run.status === "waiting")) this.quiet.resolve();
  }

  /** 在途 Run 在等子 Run 或等 unpark 时为 waiting，否则为 running（R8）；已结束的不动 */
  private refresh(live: LiveRun): void {
    const { run } = live;
    if (run.status !== "running" && run.status !== "waiting") return;
    const to = live.children.size > 0 || live.park ? "waiting" : "running";
    if (run.status !== to) transition(run, to);
  }

  /**
   * ctx.park 的实现：Run 转 waiting 并发 park.opened，等 unpark、撤回或取消。
   * 返回送来的值；被撤回或取消时抛异常（取消时结果本就作废）。
   * 后续加入：同时等待的 park 数上限（保险丝）。
   */
  private async park(live: LiveRun, { schema, payload }: { schema: Record<string, unknown>; payload: unknown }): Promise<unknown> {
    const { run } = live;
    // 与 callChild 一样：不理会 ctx.signal、被杀后还在跑的代码不能再挂起
    if (run.status !== "running" && run.status !== "waiting") throw new Error(`run is ${run.status}`);
    if (live.park) throw new Error(`run ${run.runId} is already parked`);
    if (this.phase === "stopping") return this.hold(live);
    const seq = live.issued++;

    // 恢复重放：崩溃前已回答或撤回的，按原完成顺序拿日志里的产出，不再问。
    // 这一步日志里是已完成的调用：对不上；是在途的调用：换路，照常开出
    const recorded = live.replay?.at(seq);
    let result: Result;
    if (recorded?.type === "park") {
      result = await live.replay!.deliver(recorded.order, recorded.result);
    } else {
      if (recorded && isDone(recorded)) throw new Error(this.diverge(live, seq, recorded, "park").reason);
      const parsed = z.fromJSONSchema(schema);
      const veto = this.before("beforeParkOpen", { type: "park.opened", runId: run.runId, schema, payload });
      if (veto) {
        // 被拦下：不开出、不等待，直接以拒绝关闭（日志照常记 park 行）
        this.events.emit({ type: "park.closed", runId: run.runId, step: seq, result: veto });
        result = veto;
      } else {
        const closed = Promise.withResolvers<Result>();
        live.park = { seq, schema: parsed, closed };
        this.refresh(live);
        this.events.emit({ type: "park.opened", runId: run.runId, schema, payload });
        result = await closed.promise;
      }
    }
    if (!result.ok) throw new Error(result.reason);
    return result.value;
  }

  /**
   * 重放时比对不上：代码看过的结果与它现在走的路接不上，前提已不成立（R12）。
   * 整棵树按 killed 处理，日志由提交阶段移到 diverged/ 下留着排查。
   */
  private diverge(live: LiveRun, seq: number, recorded: Recorded, actual: string): Rejected {
    const expected = recorded.type === "call" ? `call ${recorded.target}` : "park";
    const reason = `diverged at #${seq} of ${live.run.operation}: journal has ${expected}, got ${actual}`;
    this.kill(rootOf(live), reason);
    return reject("kernel", reason);
  }

  /** 转回 running（被杀的除外）、发 park.closed（提交阶段先落盘），最后把结果交给等待的实现 */
  private closePark(live: LiveRun, park: Park, result: Result): void {
    live.park = undefined;
    this.refresh(live);
    this.events.emit({ type: "park.closed", runId: live.run.runId, step: park.seq, result });
    park.closed.resolve(result);
  }

  /** 实现抛出的异常也转成结果，不留悬空调用 */
  private async invoke(ctx: Ctx, run: Run, op: Operation): Promise<Result> {
    // 装饰器还没走到实现时 Run 就被杀了：不再开始执行实现（结果本就作废）
    if (run.status === "killed") return reject("kernel", "killed");
    try {
      return { ok: true, value: await op.impl(ctx, run.input) };
    } catch (err) {
      return reject(run.operation, err);
    }
  }
}

function rootOf(live: LiveRun): LiveRun {
  while (live.parent) live = live.parent;
  return live;
}
