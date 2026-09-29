/**
 * 内核：注册表、Run 的创建与执行、对外的调用与收割接口。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { runChain, type DecoratorDef } from "./chain";
import { EventStream } from "./events";
import { reject, transition, type Rejected, type Result, type Run } from "./run";

/** 恰好一个入参、返回 Promise */
export type OperationImpl = (input: any) => Promise<unknown>;

/**
 * 注册表里的一项 Operation。
 * 后续由包装载器从导出函数与 JSDoc 生成，并加入 usage、limits、@only / @exclude、public。
 */
export type Operation = {
  name: string;
  impl: OperationImpl;
  /** 自选装饰器（@decorators），按书写顺序从外到内 */
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

/** 在途 Run 的运行时记录，经 AsyncLocalStorage 绑定为当前 Run（6.2） */
export type Frame = {
  kernel: Kernel;
  run: Run;
  /** 还没返回的子调用 */
  pending: Set<Promise<Result>>;
};

/** 内核执行实现与装饰器时绑定当前 Run。后续加入：调用来自 Operation 本体还是哪个装饰器 */
export const current = new AsyncLocalStorage<Frame>();

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
   * harness.call 的实现：发起 frame.run 的子调用并等它返回。
   * 有子调用没返回时，发起方处于 waiting。
   */
  callChild(frame: Frame, name: string, input: unknown): Promise<Result> {
    const caller = frame.run;
    const admitted =
      caller.status === "exited" ? reject("kernel", "caller has exited") : this.admit(name, input, caller);
    if ("ok" in admitted) {
      this.events.emit({ type: "call.rejected", runId: caller.runId, target: name, input, result: admitted });
      return Promise.resolve(admitted);
    }

    // 先转 waiting 再执行：子 Run 的实现在 execute 里同步开始
    if (frame.pending.size === 0) transition(caller, "waiting");
    const settled = this.execute(admitted).then((result) => {
      frame.pending.delete(settled);
      if (frame.pending.size === 0) transition(caller, "running");
      return result;
    });
    frame.pending.add(settled);
    return settled;
  }

  /**
   * 建 Run 前的检查，通过则建出 Run；不通过以拒绝返回，不建 Run。
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

    const run: Run = { runId: crypto.randomUUID(), operation: name, input, status: "init", depth, parent: parent?.runId };
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

    const frame: Frame = { kernel: this, run, pending: new Set() };
    const result = await current.run(frame, () => runChain(run, chain, () => this.invoke(run, op), this.events));
    // 实现没等完的子调用，等它们都返回再退出，不留悬空的子 Run
    while (frame.pending.size > 0) await Promise.all(frame.pending);

    transition(run, "exited");
    this.live--;
    this.events.emit({ type: "run.exited", runId: run.runId, operation: run.operation, result });
    return result;
  }

  /** 实现抛出的异常也转成结果，不留悬空调用 */
  private async invoke(run: Run, op: Operation): Promise<Result> {
    try {
      return { ok: true, value: await op.impl(run.input) };
    } catch (err) {
      return reject(run.operation, err);
    }
  }
}
