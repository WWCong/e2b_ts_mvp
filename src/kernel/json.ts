/**
 * JSON 形态的值：事件数据、清单、调用记录都要在某一刻定格。
 */
import type { Json } from "./types.ts";

/**
 * 取值在这一刻的 JSON 形态的深拷贝，并逐层冻结。
 * 事件缓冲后才投递，发出方之后改动原对象不能改变已发出的事实。
 *
 * 语义同 `JSON.stringify`：尊重 `toJSON`；对象里的 undefined、函数、symbol 省略，
 * 数组里的变为 null；非有限数变为 null。另外永不抛错：bigint 转字符串，
 * Error 取 name 与 message，环引用记为 "[Circular]"，抛错的 getter 或 toJSON 记为 "[Unserializable: …]"。
 */
export function snapshot<T>(value: T): T {
  return toJson(value, new Set()) as T;
}

function toJson(value: unknown, ancestors: Set<object>): Json {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "bigint":
      return value.toString();
    case "undefined":
    case "function":
    case "symbol":
      return null;
  }
  if (value === null) return null;

  const obj = value as object;
  if (ancestors.has(obj)) return "[Circular]";
  ancestors.add(obj);
  try {
    if (obj instanceof Error) return Object.freeze({ name: obj.name, message: obj.message });
    if (typeof (obj as { toJSON?: unknown }).toJSON === "function") {
      return toJson((obj as { toJSON(): unknown }).toJSON(), ancestors);
    }
    if (Array.isArray(obj)) return Object.freeze(obj.map((item) => toJson(item, ancestors))) as Json[];

    const out: Record<string, Json> = {};
    for (const [key, item] of Object.entries(obj)) {
      if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
      out[key] = toJson(item, ancestors);
    }
    return Object.freeze(out);
  } catch (error) {
    // 抛错的 getter 或 toJSON
    return `[Unserializable: ${error instanceof Error ? error.message : String(error)}]`;
  } finally {
    ancestors.delete(obj);
  }
}
