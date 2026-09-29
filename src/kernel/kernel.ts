/**
 * 内核：注册表、Run 的创建与执行、对外的调用与收割接口。
 */

import { runChain, type DecoratorDef } from "./chain";
import { EventStream } from "./events";
import { reject, transition, type Result, type Run } from "./run";

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

/** 装配配置里内核关心的部分。后续加入：kernel（资源保险丝）、snapshotDir 等 */
export type KernelConfig = {
  /** 包住所有调用的装饰器，从外到内 */
  defaultDecorators?: string[];
};

export class Kernel {
  readonly events = new EventStream();
  private readonly operations = new Map<string, Operation>();
  private readonly decorators = new Map<string, DecoratorDef>();
  /** runId → 退出结果。结果保留到调用方收割，收割后移除（3.4） */
  private readonly exits = new Map<string, Promise<Result>>();

  constructor(private readonly config: KernelConfig = {}) {}

  register(op: Operation): void {
    if (this.operations.has(op.name)) throw new Error(`duplicate operation: ${op.name}`);
    this.operations.set(op.name, op);
  }

  /** 注册只是放进注册表；进不进默认集由装配配置决定（6.4） */
  registerDecorator(def: DecoratorDef): void {
    if (this.decorators.has(def.id)) throw new Error(`duplicate decorator: ${def.id}`);
    this.decorators.set(def.id, def);
  }

  /** 对外接口·调用：按名字起一棵 Run 树（当前只有根 Run），返回 runId */
  start(name: string, input: unknown): string {
    const op = this.operations.get(name);
    if (!op) throw new Error(`unknown operation: ${name}`);
    const run: Run = { runId: crypto.randomUUID(), operation: name, input, status: "init" };
    this.exits.set(run.runId, this.execute(run, op, this.resolveChain(op)));
    return run.runId;
  }

  /** 对外接口·收割：等 Run 退出并取走结果 */
  async reap(runId: string): Promise<Result> {
    const exit = this.exits.get(runId);
    if (!exit) throw new Error(`unknown run: ${runId}`);
    const result = await exit;
    this.exits.delete(runId);
    return result;
  }

  /** 默认装饰器在外，自选装饰器在内。后续由装配期校验提前发现未注册的 id */
  private resolveChain(op: Operation): DecoratorDef[] {
    const ids = [...(this.config.defaultDecorators ?? []), ...(op.decorators ?? [])];
    return ids.map((id) => {
      const def = this.decorators.get(id);
      if (!def) throw new Error(`unknown decorator: ${id} (operation ${op.name})`);
      return def;
    });
  }

  private async execute(run: Run, op: Operation, chain: DecoratorDef[]): Promise<Result> {
    transition(run, "running");
    this.events.emit({
      type: "run.started",
      runId: run.runId,
      operation: run.operation,
      input: run.input,
      chain: chain.map((d) => d.id),
    });

    const result = await runChain(run, chain, () => this.invoke(run, op), this.events);

    transition(run, "exited");
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
