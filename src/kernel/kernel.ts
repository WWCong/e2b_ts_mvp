/**
 * 内核：注册表、Run 的创建与执行、挂起，对外的调用、收割、送值与撤回、取消、关停与恢复接口。
 * 内核不注册任何 Operation，注册表里的全部来自装载的插件；park 的 Operation 形式在 stdlib 插件里。
 */

import { z } from "zod";
import { runChain, type DecoratorCtx, type DecoratorDef } from "./chain";
import { EventStream } from "./events";
import { checkName } from "./names";
import { reject, transition, type Ctx, type Rejected, type Result, type Run, type ToolSpec } from "./run";
import { digest, fold, Journal, type Entry, type Recorded, type RunLog } from "./journal";
import { inSurface, type Surface } from "./surface";

/** ctx 之外恰好一个入参、返回 Promise；ctx 不算入参，不进 schema */
export type OperationImpl = (ctx: Ctx, input: any) => Promise<unknown>;

/**
 * 注册表里的一项 Operation。插件用 op() 声明，装载器补上名字「包名_导出名」（harness.ts、loader.ts、names.ts）。
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

/** 通过检查、待执行的 Run；恢复时重新执行的带着树的日志记录 */
type Admitted = { run: Run; op: Operation; chain: DecoratorDef[]; logs?: Map<string, RunLog> };

/** 在途 Run 的内核侧记录；Run 退出或被杀后移除 */
type LiveRun = {
  run: Run;
  parent?: LiveRun;
  /** 这个 Run 是父的第几个调用；根 Run 没有 */
  seq?: number;
  /** 这个 Run 已发起的调用、step、park 的个数，即下一个的序号 */
  issued: number;
  /** 恢复中的树里每个 Run 在日志里的记录：重新执行时按序号回放 */
  logs?: Map<string, RunLog>;
  /** 在途的子 Run */
  children: Set<LiveRun>;
  /** 经 ctx.park 等值时才有 */
  park?: Park;
  /** Run 的结果：正常退出与被杀，谁先到算谁 */
  done: PromiseWithResolvers<Result>;
  /** 被杀时 abort，即 ctx.signal */
  abort: AbortController;
};

export class Kernel {
  readonly events = new EventStream();
  private readonly operations = new Map<string, Operation>();
  private readonly decorators = new Map<string, DecoratorDef>();
  /** 公开 Operation 的工具描述，注册时生成 */
  private readonly tools = new Map<string, ToolSpec>();
  /** runId → 退出结果。结果保留到调用方收割，收割后移除（3.4） */
  private readonly exits = new Map<string, Promise<Result>>();
  /** runId → 在途 Run */
  private readonly lives = new Map<string, LiveRun>();
  private readonly fuse: { maxDepth: number; maxLiveRuns: number };
  private stopping = false;
  private readonly journal?: Journal;

  constructor(private readonly config: KernelConfig = {}) {
    this.fuse = { ...FUSE_DEFAULTS, ...config.kernel };
    if (config.journalDir) this.journal = new Journal(config.journalDir);
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
  }

  /** 注册只是放进注册表；进不进默认集由装配配置决定（6.4） */
  registerDecorator(def: DecoratorDef): void {
    if (this.decorators.has(def.id)) throw new Error(`duplicate decorator: ${def.id}`);
    this.decorators.set(def.id, def);
  }

  /** 对外接口·调用：按名字起一棵 Run 树，返回根 Run 的 runId */
  start(name: string, input: unknown): string {
    if (this.stopping) throw new Error("harness is stopping");
    const admitted = this.admit(name, input);
    if ("ok" in admitted) throw new Error(admitted.reason);
    const { runId } = admitted.run;
    this.journal?.append(runId, { type: "root", runId, operation: name, input });
    this.exits.set(runId, this.execute(admitted));
    return admitted.run.runId;
  }

  /**
   * 对外接口·恢复：读写前日志，重建所有没结束的树，返回它们根的 runId 供收割。装载完插件后调用。
   * 根与崩溃时正在执行的 Run 用原 runId 重新执行，attempt 加一。重新执行时按序号回放：
   * 已完成的调用回送记下的结果（不执行、不过链），step 给回记下的值，已回答的 park 直接拿到回答，没回答的用原 id 重新开出。
   */
  recover(): string[] {
    if (!this.journal) return [];
    return this.journal.readAll().map((entries) => {
      const { root, runs } = fold(entries);
      const admitted = this.admit(root.operation, root.input, undefined, this.resume(root.runId, root.runId, runs));
      if ("ok" in admitted) {
        // 根都建不起来（Operation 没了、入参不再合法）：恢复失败，日志删除
        this.journal?.delete(root.runId);
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
    this.closePark(live, live.park, { ok: true, value: parsed.data });
  }

  /** 对外接口·撤回：等待中的 park 以拒绝结果返回，by 为挂起的那个 Operation（如 stdlib_park） */
  withdraw(id: string, reason: string): void {
    const live = this.lives.get(id);
    if (!live?.park) throw new Error(`not parked: ${id}`);
    this.closePark(live, live.park, reject(live.run.operation, reason));
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
   * 对外接口·关停（9.2）：不再接受新的外部调用，等在途的 Run 树收敛；到 timeoutMs 仍在途的按 killed 处理。
   * 在途树内部的子调用照常进行，好让它们收敛。等 park 的树不会自己收敛，到时同样被杀，但 park 不关（不发 park.closed）。
   * 被杀的树日志保留，停在被杀之前，重启后接着跑。
   * 后续加入：harness.stopping 责任链（投递插件 flush、各插件清理）；
   * 只剩 park 在等的树不必等到超时：日志已落盘，可以直接退出。
   */
  async stop(timeoutMs: number): Promise<void> {
    this.stopping = true;
    const roots = [...this.lives.values()].filter((live) => !live.parent);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)));
    await Promise.race([Promise.all(roots.map((live) => live.done.promise)), timeout]);
    clearTimeout(timer);
    for (const live of roots) if (this.lives.has(live.run.runId)) this.kill(live, "shutdown");
  }

  /**
   * ctx.call 的实现：发起 caller 的子调用并等它返回。
   * 给了 surface 就检查目标在不在里面；装饰器发起的调用不给。
   */
  private callChild(caller: LiveRun, name: string, input: unknown, surface?: Surface): Promise<Result> {
    const { run } = caller;
    const seq = caller.issued++;
    const inputDigest = digest(input);
    const alive = run.status === "running" || run.status === "waiting";

    // 恢复重放：这个序号上日志里有记录，先比对
    const recorded = alive ? recordedAt(caller, seq) : undefined;
    let resume: Resume | undefined;
    if (recorded) {
      if (recorded.type !== "call" || recorded.target !== name || recorded.input !== inputDigest) {
        const same = recorded.type === "call" && recorded.target === name;
        return Promise.resolve(this.diverge(caller, seq, recorded, `call ${name}${same ? " with different input" : ""}`));
      }
      // 已完成：回送记下的结果，不执行、不过链、不再记
      if (recorded.result) return Promise.resolve(recorded.result);
      // 崩溃时在途：子 Run 用原 runId 重新执行
      if (recorded.child) resume = this.resume(recorded.child, rootOf(caller).run.runId, caller.logs!);
    }

    let admitted: Admitted | Rejected;
    if (!alive) admitted = reject("kernel", `caller is ${run.status}`);
    else if (surface && !inSurface(surface, name)) admitted = reject("kernel", `${name} is not in the surface of ${run.operation}`);
    else admitted = this.admit(name, input, run, resume);

    // 先记后做：调用连同它建的子 Run 落盘之后才开始执行。在途的调用日志里已有，不再记
    if (!recorded) {
      const child = "ok" in admitted ? undefined : admitted.run.runId;
      this.record(caller, { type: "call", runId: run.runId, seq, target: name, input: inputDigest, child });
    }
    if ("ok" in admitted) {
      this.record(caller, { type: "done", runId: run.runId, seq, result: admitted });
      this.events.emit({ type: "call.rejected", runId: run.runId, target: name, input, result: admitted });
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
    return { run, op, chain, logs: resume?.logs };
  }

  /** 恢复时重新执行一个 Run：attempt 在上次的基础上加一，先记一行 retry（再崩一次还能接着加） */
  private resume(runId: string, root: string, logs: Map<string, RunLog>): Resume {
    const attempt = (logs.get(runId)?.attempt ?? 1) + 1;
    this.journal?.append(root, { type: "retry", runId, attempt });
    return { runId, attempt, logs };
  }

  private execute({ run, op, chain, logs }: Admitted, parent?: LiveRun, seq?: number): Promise<Result> {
    const live: LiveRun = {
      run,
      parent,
      seq,
      issued: 0,
      logs,
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
    this.events.emit({
      type: "run.started",
      runId: run.runId,
      operation: run.operation,
      input: run.input,
      parent: run.parent,
      depth: run.depth,
      chain: chain.map((d) => d.id),
      attempt: run.attempt > 1 ? run.attempt : undefined,
    });

    // 实现的调用查它自己的能力面；装饰器的调用同样记在这个 Run 名下，但不查它的能力面（4.1）
    const { signal } = live.abort;
    const { runId, attempt } = run;
    const step: Ctx["step"] = (name, fn) => this.step(live, name, fn);
    const ctx: Ctx = {
      runId,
      attempt,
      call: (name, input) => this.callChild(live, name, input, op),
      signal,
      tools: () => this.toolsIn(op),
      park: (req) => this.park(live, req),
      step,
    };
    const decoratorCtx: DecoratorCtx = { runId, attempt, call: (name, input) => this.callChild(live, name, input), signal, step };

    const settle = async () => {
      const result = await runChain(decoratorCtx, run, chain, () => this.invoke(ctx, run, op), this.events);
      // 实现没等完的子调用与 park，等它们都结束再退出，不留悬空的子 Run
      while (live.children.size > 0 || live.park) {
        await Promise.all([...[...live.children].map((c) => c.done.promise), live.park?.closed.promise]);
      }
      // 已被杀：不理会 ctx.signal 的实现照样跑完（JS 无法抢占），但结果作废
      if (run.status === "killed") return;

      transition(run, "exited");
      this.forget(live, result);
      // 整棵树结束：日志不再需要
      if (!live.parent) this.journal?.delete(run.runId);
      this.events.emit({ type: "run.exited", runId: run.runId, operation: run.operation, result });
      live.done.resolve(result);
    };
    void settle();
    return live.done.promise;
  }

  /**
   * 杀掉 live 及其子孙：自己先转 killed（关掉它的 park）、abort 它的 signal，再杀子 Run；
   * 等它的一方拿到内核的拒绝结果。reason：cancelled、shutdown，或重放比对不上时的 diverged …
   * 关停不关 park、不删日志：它们没被回答、没被取消，重启后接着跑。
   */
  private kill(live: LiveRun, reason: string): void {
    transition(live.run, "killed");
    this.events.emit({ type: "run.killed", runId: live.run.runId, operation: live.run.operation, reason });
    if (reason !== "shutdown") {
      // 整棵树作废：日志随之删除
      if (!live.parent) this.journal?.delete(live.run.runId);
      if (live.park) this.closePark(live, live.park, reject("kernel", reason));
    }
    live.abort.abort();
    for (const child of [...live.children]) this.kill(child, reason);
    const result = reject("kernel", reason);
    this.forget(live, result);
    live.done.resolve(result);
  }

  /** 能力面里的公开 Operation，按名字排序 */
  private toolsIn(surface: Surface): ToolSpec[] {
    return [...this.tools.values()]
      .filter((tool) => inSurface(surface, tool.name))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** Run 退出或被杀后从内核移除：结果先落盘（父的 done）再交给父；父不再等任何东西时回到 running */
  private forget(live: LiveRun, result: Result): void {
    this.lives.delete(live.run.runId);
    const { parent, seq } = live;
    if (!parent || seq === undefined) return;
    this.record(parent, { type: "done", runId: parent.run.runId, seq, result });
    parent.children.delete(live);
    this.refresh(parent);
  }

  /** 在途 Run 在等子 Run 或等 unpark 时为 waiting，否则为 running（R8）；已结束的不动 */
  private refresh(live: LiveRun): void {
    const { run } = live;
    if (run.status !== "running" && run.status !== "waiting") return;
    const to = live.children.size > 0 || live.park ? "waiting" : "running";
    if (run.status !== to) transition(run, to);
  }

  /**
   * 往 owner 所在树的日志追加一行，落盘后才返回（先记后做）。
   * owner 已结束或被杀就不记：取消时日志整个删掉，关停时日志停在被杀之前，重启后接着跑。
   */
  private record(owner: LiveRun, entry: Entry): void {
    if (owner.run.status !== "running" && owner.run.status !== "waiting") return;
    this.journal?.append(rootOf(owner).run.runId, entry);
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
    const seq = live.issued++;

    // 恢复重放：崩溃前已回答或撤回的，直接拿日志里的产出，不再问
    const recorded = recordedAt(live, seq);
    if (recorded && recorded.type !== "park") throw new Error(this.diverge(live, seq, recorded, "park").reason);
    let result = recorded?.result;
    if (!result) {
      const closed = Promise.withResolvers<Result>();
      live.park = { seq, schema: z.fromJSONSchema(schema), closed };
      this.refresh(live);
      this.events.emit({ type: "park.opened", runId: run.runId, schema, payload });
      result = await closed.promise;
    }
    if (!result.ok) throw new Error(result.reason);
    return result.value;
  }

  /** ctx.step 的实现：重放时给回日志里记下的值；否则执行 fn，值落盘后才返回 */
  private async step<T>(live: LiveRun, name: string, fn: () => T | Promise<T>): Promise<T> {
    const { run } = live;
    if (run.status !== "running" && run.status !== "waiting") throw new Error(`run is ${run.status}`);
    const seq = live.issued++;
    const recorded = recordedAt(live, seq);
    if (recorded) {
      if (recorded.type === "step" && recorded.name === name) return recorded.value as T;
      throw new Error(this.diverge(live, seq, recorded, `step ${name}`).reason);
    }
    const value = await fn();
    this.record(live, { type: "step", runId: run.runId, seq, name, value });
    return value;
  }

  /** 重放时比对不上：执行路径变了，前提已不成立，整棵树按 killed 处理、日志删除（R12） */
  private diverge(live: LiveRun, seq: number, recorded: Recorded, actual: string): Rejected {
    const expected = recorded.type === "call" ? `call ${recorded.target}` : recorded.type === "step" ? `step ${recorded.name}` : "park";
    const reason = `diverged at #${seq} of ${live.run.operation}: journal has ${expected}, got ${actual}`;
    this.kill(rootOf(live), reason);
    return reject("kernel", reason);
  }

  /** 先落盘，再转回 running（被杀的除外）、发 park.closed，最后把结果交给等待的实现 */
  private closePark(live: LiveRun, park: Park, result: Result): void {
    this.record(live, { type: "park", runId: live.run.runId, seq: park.seq, result });
    live.park = undefined;
    this.refresh(live);
    this.events.emit({ type: "park.closed", runId: live.run.runId, result });
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

/** 恢复时这个 Run 在日志里该序号上记下的东西；不在恢复中，或已越过记录的末尾时没有 */
function recordedAt(live: LiveRun, seq: number): Recorded | undefined {
  return live.logs?.get(live.run.runId)?.entries.get(seq);
}

function rootOf(live: LiveRun): LiveRun {
  while (live.parent) live = live.parent;
  return live;
}
