import { describe, expect, test } from "bun:test";
import { snapshot } from "../../src/kernel/json.ts";

describe("snapshot", () => {
  test("语义同 JSON.stringify", () => {
    const value = {
      keep: 1,
      undef: undefined,
      fn: () => 1,
      nan: NaN,
      inf: -Infinity,
      date: new Date("2026-01-02T03:04:05.000Z"),
      list: [undefined, () => 1, 2],
      map: new Map([["a", 1]]),
    };
    expect(snapshot(value)).toEqual(JSON.parse(JSON.stringify(value)));
  });

  test("JSON.stringify 会抛的情况也不抛", () => {
    const cyclic: Record<string, unknown> = { name: "a" };
    cyclic.self = cyclic;
    const shared = { x: 1 };
    const value = {
      big: 10n,
      err: new TypeError("bad"),
      cyclic,
      twice: [shared, shared],
      getter: Object.defineProperty({}, "boom", {
        enumerable: true,
        get() {
          throw new Error("nope");
        },
      }),
    };
    expect(snapshot(value) as unknown).toEqual({
      big: "10",
      err: { name: "TypeError", message: "bad" },
      cyclic: { name: "a", self: "[Circular]" },
      twice: [{ x: 1 }, { x: 1 }],
      getter: "[Unserializable: nope]",
    });
  });

  test("逐层冻结，原对象不受影响", () => {
    const value = { a: [{ b: 1 }] };
    const copy = snapshot(value);
    expect(copy).not.toBe(value);
    expect(Object.isFrozen(copy.a[0])).toBe(true);
    expect(Object.isFrozen(value.a[0])).toBe(false);
  });
});
