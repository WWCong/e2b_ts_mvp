/**
 * harness 包的运行时函数（附 A）：插件与 script 包都经这里发起调用。
 * 后续加入：emit、spawn。
 */

import { current } from "./kernel";
import { reject, type Result } from "./run";

/**
 * 当前 Run 的子调用：等结果，拒绝作为结果返回（5.3）。
 * 在装饰器里调用时记在被装饰的 Run 名下；拿不到当前 Run 时以拒绝返回（6.2）。
 */
export function call(name: string, input: unknown): Promise<Result> {
  const frame = current.getStore();
  if (!frame) return Promise.resolve(reject("kernel", "call outside of a run"));
  return frame.kernel.callChild(frame, name, input);
}
