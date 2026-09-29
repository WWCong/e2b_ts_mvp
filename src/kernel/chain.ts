/**
 * 装饰器链：包裹一次调用的拦截与改写单元（5.2）。
 * 链从外到内：默认装饰器在外、自选装饰器在内，同层按书写顺序嵌套。
 */

import type { EventStream } from "./events";
import { freeze, reject, type Result, type Run } from "./run";

/** open：出错跳过这一环；closed：出错中断 Run。管控类必须 closed */
export type OnError = "open" | "closed";

/**
 * next 之前：整体替换 run.input 改写入参，或不调 next 直接返回结果（拒绝，或如缓存那样给出结果）。
 * next 之后：返回另一个结果即改写。拒绝以结果返回，不抛异常。
 * 后续加入：往 run.context 放条目；调 harness.park 挂起。
 */
export type Decorator = (run: Run, next: () => Promise<Result>) => Promise<Result>;

export type DecoratorDef = { id: string; onError: OnError; fn: Decorator };

/** 依次穿过 chain，走到最内层时冻结配置、执行实现 */
export function runChain(
  run: Run,
  chain: readonly DecoratorDef[],
  impl: () => Promise<Result>,
  events: EventStream,
): Promise<Result> {
  const through = (i: number): Promise<Result> => {
    const dec = chain[i];
    if (!dec) {
      freeze(run);
      return impl();
    }
    return link(run, dec, () => through(i + 1), events);
  };
  return through(0);
}

/**
 * 链上的一环。放行不发事件（链序已在 run.started 里）；
 * 改写、拒绝、出错各发一条事件。
 */
async function link(
  run: Run,
  dec: DecoratorDef,
  inner: () => Promise<Result>,
  events: EventStream,
): Promise<Result> {
  const base = { runId: run.runId, operation: run.operation, decorator: dec.id };
  const entryInput = run.input;
  let innerResult: Promise<Result> | undefined;

  const next = (): Promise<Result> => {
    if (innerResult) throw new Error(`decorator ${dec.id} called next() twice`);
    if (run.input !== entryInput) {
      events.emit({ type: "decorator.rewrote", ...base, phase: "input", value: run.input });
    }
    innerResult = inner();
    return innerResult;
  };

  try {
    const result = await dec.fn(run, next);
    if (innerResult && result === (await innerResult)) return result;
    events.emit(
      result.ok
        ? { type: "decorator.rewrote", ...base, phase: "result", value: result }
        : { type: "decorator.rejected", ...base, result },
    );
    return result;
  } catch (err) {
    const rejected = reject(dec.id, err);
    events.emit({ type: "decorator.failed", ...base, onError: dec.onError, error: rejected.reason });
    if (dec.onError === "closed") return rejected;
    // open：跳过这一环。已调过 next 就沿用内层结果，否则撤销它对入参的改写后继续
    if (innerResult) return innerResult;
    run.input = entryInput;
    return next();
  }
}
