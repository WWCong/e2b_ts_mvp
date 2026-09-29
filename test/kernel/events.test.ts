import { describe, expect, test } from "bun:test";
import { EVENT_TYPES, EventBus, levelOf, type AnyEvent } from "../../src/kernel/events.ts";
import { ok, rejection } from "../../src/kernel/types.ts";

function bus(opts: { errors?: unknown[] } = {}) {
  let t = 1000;
  return new EventBus({
    now: () => t++,
    onSubscriberError: (error) => opts.errors?.push(error),
  });
}

const run = { runId: "r2", rootId: "r1", parentId: "r1", operation: "fs.read" };

describe("信封", () => {
  test("序号从 1 单调递增，时间取注入的时钟", () => {
    const b = bus();
    expect(b.seq).toBe(0);
    const e1 = b.emit("run.started", {}, run);
    const e2 = b.emit("run.resumed", {}, run);
    expect([e1.seq, e2.seq, b.seq]).toEqual([1, 2, 2]);
    expect([e1.ts, e2.ts]).toEqual([1000, 1001]);
  });

  test("字段顺序固定，序列化逐字节稳定", () => {
    const e = bus().emit("run.exited", { outcome: ok(1), durationMs: 5 }, run);
    expect(JSON.stringify(e)).toBe(
      '{"seq":1,"ts":1000,"type":"run.exited","level":"critical",' +
        '"runId":"r2","rootId":"r1","parentId":"r1","operation":"fs.read",' +
        '"data":{"outcome":{"ok":true,"value":1},"durationMs":5}}',
    );
  });

  test("与 Run 无关的事件不带 Run 字段；根 Run 不带 parentId", () => {
    const b = bus();
    const e = b.emit("harness.shutdown", { reason: "sigterm" });
    expect(Object.keys(e)).toEqual(["seq", "ts", "type", "level", "data"]);
    const root = b.emit("run.started", {}, { runId: "r1", rootId: "r1", parentId: null, operation: "a.b" });
    expect("parentId" in root).toBe(false);
  });
});

describe("级别", () => {
  test("按目录决定", () => {
    expect(levelOf("run.created", {} as never)).toBe("critical");
    expect(levelOf("run.delta", { delta: "x" })).toBe("stream");
    expect(levelOf("emit", { name: "todo", data: [] })).toBe("observe");
  });

  test("链上放行是观测级，拒绝与改写是关键级", () => {
    const step = (disposition: "pass" | "reject" | "rewrite") =>
      levelOf("chain.step", { decorator: "safety", index: 0, disposition });
    expect(step("pass")).toBe("observe");
    expect(step("reject")).toBe("critical");
    expect(step("rewrite")).toBe("critical");
  });
});

describe("快照", () => {
  test("发出后改原对象不影响事件", () => {
    const input = { history: [{ role: "user", text: "hi" }] };
    const e = bus().emit(
      "run.created",
      { form: "native", input, depth: 0, operations: [], decorators: [], limits: {} },
      run,
    );
    input.history.push({ role: "user", text: "later" });
    input.history[0]!.text = "changed";
    expect(e.data.input).toEqual({ history: [{ role: "user", text: "hi" }] });
  });

  test("信封与数据逐层冻结", () => {
    const e = bus().emit("emit", { name: "todo", data: { items: [{ a: 1 }] } }, run);
    expect(Object.isFrozen(e)).toBe(true);
    expect(Object.isFrozen(e.data)).toBe(true);
    const items = (e.data.data as { items: { a: number }[] }).items;
    expect(Object.isFrozen(items)).toBe(true);
    expect(Object.isFrozen(items[0])).toBe(true);
    expect(() => {
      items[0]!.a = 2;
    }).toThrow(TypeError);
  });
});

describe("投递", () => {
  test("按订阅顺序交给每个订阅者", () => {
    const b = bus();
    const seen: string[] = [];
    b.subscribe((e) => void seen.push(`A${e.seq}`));
    b.subscribe((e) => void seen.push(`B${e.seq}`));
    b.emit("run.started", {}, run);
    b.emit("run.resumed", {}, run);
    expect(seen).toEqual(["A1", "B1", "A2", "B2"]);
  });

  test("订阅者里再发的事件排队，每个订阅者看到的序号严格递增", () => {
    const b = bus();
    const a: number[] = [];
    const c: number[] = [];
    b.subscribe((e) => {
      a.push(e.seq);
      if (e.type === "run.exited") {
        const inner = b.emit("emit", { name: "reaction", data: null }, run);
        expect(inner.seq).toBe(2);
      }
    });
    b.subscribe((e) => void c.push(e.seq));
    b.emit("run.exited", { outcome: rejection("x", "y"), durationMs: 0 }, run);
    b.emit("run.started", {}, run);
    expect(a).toEqual([1, 2, 3]);
    expect(c).toEqual([1, 2, 3]);
  });

  test("订阅者抛错或 Promise 失败不影响其他订阅者", async () => {
    const errors: unknown[] = [];
    const b = bus({ errors });
    const seen: number[] = [];
    b.subscribe(() => {
      throw new Error("sync");
    });
    b.subscribe(async () => {
      throw new Error("async");
    });
    b.subscribe((e) => void seen.push(e.seq));
    b.emit("run.started", {}, run);
    b.emit("run.resumed", {}, run);
    await Promise.resolve();
    expect(seen).toEqual([1, 2]);
    expect(errors.map((e) => (e as Error).message).sort()).toEqual(["async", "async", "sync", "sync"]);
  });

  test("报错钩子自己抛错也不打断事件流", () => {
    const b = new EventBus({
      onSubscriberError: () => {
        throw new Error("hook");
      },
    });
    const seen: number[] = [];
    b.subscribe(() => {
      throw new Error("sub");
    });
    b.subscribe((e) => void seen.push(e.seq));
    expect(() => b.emit("run.started", {}, run)).not.toThrow();
    expect(seen).toEqual([1]);
  });

  test("按级别与类型过滤", () => {
    const b = bus();
    const critical: string[] = [];
    const exits: string[] = [];
    b.subscribe((e) => void critical.push(e.type), { levels: ["critical"] });
    b.subscribe((e) => void exits.push(e.type), { types: ["run.exited"] });
    b.emit("run.delta", { delta: "x" }, run);
    b.emit("emit", { name: "n", data: 1 }, run);
    b.emit("run.exited", { outcome: ok(null), durationMs: 1 }, run);
    expect(critical).toEqual(["run.exited"]);
    expect(exits).toEqual(["run.exited"]);
  });

  test("取消订阅后不再收到", () => {
    const b = bus();
    const seen: number[] = [];
    const off = b.subscribe((e) => void seen.push(e.seq));
    b.emit("run.started", {}, run);
    off();
    b.emit("run.resumed", {}, run);
    expect(seen).toEqual([1]);
  });

  test("投递中途取消的订阅者不再收到这一条", () => {
    const b = bus();
    const seen: number[] = [];
    let offB = () => {};
    b.subscribe(() => offB());
    offB = b.subscribe((e) => void seen.push(e.seq));
    b.emit("run.started", {}, run);
    expect(seen).toEqual([]);
  });

  test("投递中途加入的订阅者从下一条开始收", () => {
    const b = bus();
    const late: number[] = [];
    let added = false;
    b.subscribe(() => {
      if (added) return;
      added = true;
      b.subscribe((e) => void late.push(e.seq));
    });
    b.emit("run.started", {}, run);
    b.emit("run.resumed", {}, run);
    expect(late).toEqual([2]);
  });

  test("订阅者拿到的事件按 type 收窄", () => {
    const b = bus();
    const reasons: string[] = [];
    b.subscribe((e: AnyEvent) => {
      if (e.type === "run.killed") reasons.push(e.data.reason);
    });
    b.emit("run.killed", { reason: "cancelled" }, run);
    expect(reasons).toEqual(["cancelled"]);
  });
});

test("EVENT_TYPES 列出目录里的全部类型", () => {
  expect(EVENT_TYPES).toContain("run.exited");
  expect(EVENT_TYPES).toContain("harness.shutdown");
  expect(EVENT_TYPES).not.toContain("harness.stopping");
  expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
});
