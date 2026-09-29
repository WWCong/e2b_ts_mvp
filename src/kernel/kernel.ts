/**
 * 内核：注册表、Run 的创建与执行、对外的调用、收割、取消与关停接口。
 */

import { z } from "zod";
import { runChain, type DecoratorCtx, type DecoratorDef } from "./chain";
import { EventStream } from "./events";
import { reject, transition, type Ctx, type Rejected, type Result, type Run, type ToolSpec } from "./run";
import { inSurface, type Surface } from "./surface";

/** ctx 之外恰好一个入参、返回 Promise；ctx 不算入参，不进 schema */
export type OperationImpl = (ctx: Ctx, input: any) => Promise<unknown>;

/**
 * 注册表里的一项 Operation。插件用 op() 声明，装载器补上名字（harness.ts、loader.ts）。
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

/** 装配配置里内核关心的部分。后续加入：snapshotDir 等 */
export type KernelConfig = {
  /** 包住所有调用的装饰器，从外到内 */
  defaultDecorators?: string[];
  /** 资源保险丝（3.4）。后续加入：同时等待的 park 数上限 */
  kernel?: { maxDepth?: number; maxLiveRuns?: number };
};

const FUSE_DEFAULTS = { maxDepth: 32, maxLiveRuns: 1024 };

/** 通过检查、待执行的 Run */
type Admitted = { run: Run; op: Operation; chain: DecoratorDef[] };

/** 在途 Run 的内核侧记录；Run 退出或被杀后移除 */
type LiveRun = {
  run: Run;
  parent?: LiveRun;
  /** 在途的子 Run；不为空时 run 处于 waiting */
  children: Set<LiveRun>;
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

  constructor(private readonly config: KernelConfig = {}) {
    this.fuse = { ...FUSE_DEFAULTS, ...config.kernel };
  }

  /** 公开的 Operation 须写 usage；入参 schema 转不成 JSON Schema 的（如 z.date()）在这里就报错 */
  register(op: Operation): void {
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
    this.exits.set(admitted.run.runId, this.execute(admitted));
    return admitted.run.runId;
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
   * 在途树内部的子调用照常进行，好让它们收敛。
   * 后续加入：harness.stopping 责任链（投递插件 flush、各插件清理）；空闲的树落快照。
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
    let admitted: Admitted | Rejected;
    if (run.status === "exited" || run.status === "killed") admitted = reject("kernel", `caller is ${run.status}`);
    else if (surface && !inSurface(surface, name)) admitted = reject("kernel", `${name} is not in the surface of ${run.operation}`);
    else admitted = this.admit(name, input, run);
    if ("ok" in admitted) {
      this.events.emit({ type: "call.rejected", runId: run.runId, target: name, input, result: admitted });
      return Promise.resolve(admitted);
    }

    // 先转 waiting 再执行：子 Run 的实现在 execute 里同步开始
    if (caller.children.size === 0) transition(run, "waiting");
    return this.execute(admitted, caller);
  }

  /**
   * 建 Run 前的检查（目标存在、保险丝、链能解析、入参符合 schema），通过则建出 Run；
   * 不通过以拒绝返回，不建 Run。
   */
  private admit(name: string, input: unknown, parent?: Run): Admitted | Rejected {
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
      runId: crypto.randomUUID(),
      operation: name,
      input: parsed.data,
      status: "init",
      depth,
      parent: parent?.runId,
    };
    return { run, op, chain };
  }

  private execute({ run, op, chain }: Admitted, parent?: LiveRun): Promise<Result> {
    const live: LiveRun = {
      run,
      parent,
      children: new Set(),
      done: Promise.withResolvers(),
      abort: new AbortController(),
    };
    this.lives.set(run.runId, live);
    parent?.children.add(live);
    transition(run, "running");
    this.events.emit({
      type: "run.started",
      runId: run.runId,
      operation: run.operation,
      input: run.input,
      parent: run.parent,
      depth: run.depth,
      chain: chain.map((d) => d.id),
    });

    // 实现的调用查它自己的能力面；装饰器的调用同样记在这个 Run 名下，但不查它的能力面（4.1）
    const { signal } = live.abort;
    const ctx: Ctx = {
      call: (name, input) => this.callChild(live, name, input, op),
      signal,
      tools: () => this.toolsIn(op),
    };
    const decoratorCtx: DecoratorCtx = { call: (name, input) => this.callChild(live, name, input), signal };

    const settle = async () => {
      const result = await runChain(decoratorCtx, run, chain, () => this.invoke(ctx, run, op), this.events);
      // 实现没等完的子调用，等它们都返回再退出，不留悬空的子 Run
      while (live.children.size > 0) await Promise.all([...live.children].map((c) => c.done.promise));
      // 已被杀：不理会 ctx.signal 的实现照样跑完（JS 无法抢占），但结果作废
      if (run.status === "killed") return;

      transition(run, "exited");
      this.forget(live);
      this.events.emit({ type: "run.exited", runId: run.runId, operation: run.operation, result });
      live.done.resolve(result);
    };
    void settle();
    return live.done.promise;
  }

  /** 杀掉 live 及其子孙：自己先转 killed 并 abort 它的 signal，再杀子 Run；等它的一方拿到内核的拒绝结果 */
  private kill(live: LiveRun, reason: "cancelled" | "shutdown"): void {
    transition(live.run, "killed");
    this.events.emit({ type: "run.killed", runId: live.run.runId, operation: live.run.operation, reason });
    live.abort.abort();
    for (const child of [...live.children]) this.kill(child, reason);
    this.forget(live);
    live.done.resolve(reject("kernel", reason));
  }

  /** 能力面里的公开 Operation，按名字排序 */
  private toolsIn(surface: Surface): ToolSpec[] {
    return [...this.tools.values()]
      .filter((tool) => inSurface(surface, tool.name))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** Run 退出或被杀后从内核移除；父不再等任何子 Run 时回到 running */
  private forget(live: LiveRun): void {
    this.lives.delete(live.run.runId);
    const { parent } = live;
    if (!parent) return;
    parent.children.delete(live);
    if (parent.children.size === 0 && parent.run.status === "waiting") transition(parent.run, "running");
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
