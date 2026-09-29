/**
 * 内核：注册表、Run 的创建与执行、对外的调用与收割接口。
 */

import { z } from "zod";
import { runChain, type DecoratorDef } from "./chain";
import { EventStream } from "./events";
import { reject, transition, type Ctx, type Rejected, type Result, type Run } from "./run";
import { inSurface, type Surface } from "./surface";

/** ctx 之外恰好一个入参、返回 Promise；ctx 不算入参，不进 schema */
export type OperationImpl = (ctx: Ctx, input: any) => Promise<unknown>;

/**
 * 注册表里的一项 Operation。插件用 op() 声明，装载器补上名字（harness.ts、loader.ts）。
 * 后续加入：usage、limits、public。
 */
export type Operation = Surface & {
  name: string;
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

export class Kernel {
  readonly events = new EventStream();
  private readonly operations = new Map<string, Operation>();
  private readonly decorators = new Map<string, DecoratorDef>();
  /** runId → 退出结果。结果保留到调用方收割，收割后移除（3.4） */
  private readonly exits = new Map<string, Promise<Result>>();
  private readonly fuse: { maxDepth: number; maxLiveRuns: number };
  /** 已建、未退出的 Run 数 */
  private live = 0;

  constructor(private readonly config: KernelConfig = {}) {
    this.fuse = { ...FUSE_DEFAULTS, ...config.kernel };
  }

  register(op: Operation): void {
    if (this.operations.has(op.name)) throw new Error(`duplicate operation: ${op.name}`);
    this.operations.set(op.name, op);
  }

  /** 注册只是放进注册表；进不进默认集由装配配置决定（6.4） */
  registerDecorator(def: DecoratorDef): void {
    if (this.decorators.has(def.id)) throw new Error(`duplicate decorator: ${def.id}`);
    this.decorators.set(def.id, def);
  }

  /** 对外接口·调用：按名字起一棵 Run 树，返回根 Run 的 runId */
  start(name: string, input: unknown): string {
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
   * ctx.call 的实现：发起 caller 的子调用并等它返回。
   * pending 是 caller 还没返回的子调用；不为空时 caller 处于 waiting。
   * 给了 surface 就检查目标在不在里面；装饰器发起的调用不给。
   */
  private callChild(
    caller: Run,
    pending: Set<Promise<Result>>,
    name: string,
    input: unknown,
    surface?: Surface,
  ): Promise<Result> {
    let admitted: Admitted | Rejected;
    if (caller.status === "exited") admitted = reject("kernel", "caller has exited");
    else if (surface && !inSurface(surface, name)) admitted = reject("kernel", `${name} is not in the surface of ${caller.operation}`);
    else admitted = this.admit(name, input, caller);
    if ("ok" in admitted) {
      this.events.emit({ type: "call.rejected", runId: caller.runId, target: name, input, result: admitted });
      return Promise.resolve(admitted);
    }

    // 先转 waiting 再执行：子 Run 的实现在 execute 里同步开始
    if (pending.size === 0) transition(caller, "waiting");
    const settled = this.execute(admitted).then((result) => {
      pending.delete(settled);
      if (pending.size === 0) transition(caller, "running");
      return result;
    });
    pending.add(settled);
    return settled;
  }

  /**
   * 建 Run 前的检查（目标存在、保险丝、链能解析、入参符合 schema），通过则建出 Run；
   * 不通过以拒绝返回，不建 Run。
   * 后续加入：能力面检查。
   */
  private admit(name: string, input: unknown, parent?: Run): Admitted | Rejected {
    const op = this.operations.get(name);
    if (!op) return reject("kernel", `unknown operation: ${name}`);

    const depth = parent ? parent.depth + 1 : 0;
    if (depth > this.fuse.maxDepth) return reject("kernel", `max depth ${this.fuse.maxDepth} exceeded`);
    if (this.live >= this.fuse.maxLiveRuns) return reject("kernel", `max live runs ${this.fuse.maxLiveRuns} exceeded`);

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

  private async execute({ run, op, chain }: Admitted): Promise<Result> {
    this.live++;
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

    const pending = new Set<Promise<Result>>();
    // 实现的调用查它自己的能力面；装饰器的调用同样记在这个 Run 名下，但不查它的能力面（4.1）
    const ctx: Ctx = { call: (name, input) => this.callChild(run, pending, name, input, op) };
    const decoratorCtx: Ctx = { call: (name, input) => this.callChild(run, pending, name, input) };
    const result = await runChain(decoratorCtx, run, chain, () => this.invoke(ctx, run, op), this.events);
    // 实现没等完的子调用，等它们都返回再退出，不留悬空的子 Run
    while (pending.size > 0) await Promise.all(pending);

    transition(run, "exited");
    this.live--;
    this.events.emit({ type: "run.exited", runId: run.runId, operation: run.operation, result });
    return result;
  }

  /** 实现抛出的异常也转成结果，不留悬空调用 */
  private async invoke(ctx: Ctx, run: Run, op: Operation): Promise<Result> {
    try {
      return { ok: true, value: await op.impl(ctx, run.input) };
    } catch (err) {
      return reject(run.operation, err);
    }
  }
}
