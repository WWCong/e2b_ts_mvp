/**
 * 能力面（4.1、R13）：一个 Run 能调用的 Operation 集合。
 * 缺省全开、只能收窄、不继承、Run 内静态。
 * 收窄不承担安全职责，安全由公开表决定（7.2、R5）。
 */
import { KERNEL, packageOf, rejection, type Form, type OperationName, type Rejection } from "./types.ts";

export class Surface {
  /** 排序去重，序列化逐字节稳定 */
  readonly names: readonly OperationName[];
  readonly #set: ReadonlySet<OperationName>;

  constructor(names: Iterable<OperationName>) {
    this.#set = new Set(names);
    this.names = Object.freeze([...this.#set].sort());
  }

  has(name: OperationName): boolean {
    return this.#set.has(name);
  }

  get size(): number {
    return this.#set.size;
  }
}

/** `@only` / `@exclude` 的一项：含点的是 Operation 名，不含点的是包名 */
export function selects(selector: string, name: OperationName): boolean {
  return selector.includes(".") ? selector === name : packageOf(name) === selector;
}

/**
 * 先 `@only` 再 `@exclude`。
 * 没有收窄时原样返回 base，让同一形态的 Operation 共用一份。
 */
export function narrow(base: Surface, only: readonly string[] | null, exclude: readonly string[]): Surface {
  if (only === null && exclude.length === 0) return base;
  return new Surface(
    base.names.filter(
      (name) => (only === null || only.some((s) => selects(s, name))) && !exclude.some((s) => selects(s, name)),
    ),
  );
}

/** 调用从哪里发出 */
export type CallScope =
  /** Operation 本体：查发起方自己的能力面 */
  | { kind: "body"; operation: OperationName; form: Form; surface: Surface }
  /** 装饰器或处理器：不查被装饰 Run 的能力面；内侧的不查，外侧的只查公开表 */
  | { kind: "decorator" | "handler"; form: Form };

export interface CallTarget {
  public: boolean;
}

/**
 * 调用能否发出（4.1、7.2）：能则返回 null，否则返回内核的拒绝。
 * target 为 undefined 表示没有注册，包括已停用的。
 */
export function admit(scope: CallScope, name: OperationName, target: CallTarget | undefined): Rejection | null {
  // 外侧看不到不公开的 Operation：与不存在同样回答，不泄露它的存在
  if (!target || (scope.form === "script" && !target.public)) {
    return rejection(KERNEL, `unknown operation: ${name}`, { retryable: true });
  }
  if (scope.kind === "body" && !scope.surface.has(name)) {
    return rejection(KERNEL, `${name} is not in the capability surface of ${scope.operation}`);
  }
  return null;
}
