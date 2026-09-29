/**
 * 内核：注册表、Run 的创建与执行、对外的调用与收割接口。
 */

import { EventStream } from "./events";
import { transition, type Result, type Run } from "./run";

/** 恰好一个入参、返回 Promise */
export type OperationImpl = (input: any) => Promise<unknown>;

/**
 * 注册表里的一项 Operation。
 * 后续由包装载器从导出函数与 JSDoc 生成，并加入 usage、limits、decorators、@only / @exclude、public。
 */
export type Operation = { name: string; impl: OperationImpl };

export class Kernel {
  readonly events = new EventStream();
  private readonly operations = new Map<string, Operation>();
  /** runId → 退出结果。结果保留到调用方收割，收割后移除（3.4） */
  private readonly exits = new Map<string, Promise<Result>>();

  register(op: Operation): void {
    if (this.operations.has(op.name)) throw new Error(`duplicate operation: ${op.name}`);
    this.operations.set(op.name, op);
  }

  /** 对外接口·调用：按名字起一棵 Run 树（当前只有根 Run），返回 runId */
  start(name: string, input: unknown): string {
    const op = this.operations.get(name);
    if (!op) throw new Error(`unknown operation: ${name}`);
    const run: Run = { runId: crypto.randomUUID(), operation: name, input, status: "init" };
    this.exits.set(run.runId, this.execute(run, op));
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

  private async execute(run: Run, op: Operation): Promise<Result> {
    transition(run, "running");
    this.events.emit({ type: "run.started", runId: run.runId, operation: run.operation, input: run.input });

    let result: Result;
    try {
      result = { ok: true, value: await op.impl(run.input) };
    } catch (err) {
      // 实现抛出的异常也转成结果，不留悬空调用
      const reason = err instanceof Error ? err.message : String(err);
      result = { ok: false, by: run.operation, reason, retryable: false };
    }

    transition(run, "exited");
    this.events.emit({ type: "run.exited", runId: run.runId, operation: run.operation, result });
    return result;
  }
}
