/**
 * 对外接口（Kernel.outside）：宿主交给服务接口（stdlib/serve）的那一份。
 * 调用只能调声明了 api 的 Operation；发起的树的根记下 origin（谁发起的），写进日志、重启后还在。
 * 根 Run 的结果留到被取走（reap）为止：调用方不在、或中途重启过，回来按 runId 还取得到（journal.ts 的 exit 行）。
 */

import type { Result } from "./run";

/** 结果还没被取走的树：done 表示已结束、结果在等人取 */
export type RunInfo = { runId: string; operation: string; origin?: string; done: boolean };

/** 等待中的 park：id 是 park 的 runId（unpark 用它），root 是所在树的根；schema 是等的值的 JSON Schema */
export type ParkInfo = { id: string; root: string; operation: string; schema: Record<string, unknown>; payload: unknown };

/** 能对外的 Operation：名字、说明、入参（调用方要填的形状）与出参的 JSON Schema */
export type ApiInfo = { name: string; usage: string; input: Record<string, unknown>; output: Record<string, unknown> };

export type Outside = {
  /** 按名字起一棵 Run 树，返回根的 runId；只能调声明了 api 的 Operation */
  submit(name: string, input: unknown): string;
  /** 结果还没被取走的树（谁发起的都列）。后续：有了认证按调用方过滤 */
  runs(): RunInfo[];
  /** 等树结束，不取走结果 */
  wait(runId: string): Promise<Result>;
  /** 等树结束并取走结果；每棵树只能取一次，取走后不再保留 */
  reap(runId: string): Promise<Result>;
  /** 等待中的 park（谁发起的树里的都列） */
  parks(): ParkInfo[];
  /** 把值送给等待中的 park，按它的 schema 校验；不在等待或值不符时抛异常 */
  unpark(id: string, value: unknown): void;
  /** 撤回等待中的 park，它以拒绝返回 */
  withdraw(id: string, reason: string): void;
  /** 能对外的 Operation（声明了 api 的）；服务接口再按装配配置的 expose 筛 */
  operations(): ApiInfo[];
};
