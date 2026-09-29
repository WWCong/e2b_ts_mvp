import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { HarnessEvent } from "./events";
import { Kernel } from "./kernel";
import type { Rejected } from "./run";

function setup() {
  const kernel = new Kernel();
  const events: HarnessEvent[] = [];
  kernel.events.subscribe((e) => events.push(e));
  kernel.register({
    name: "math.double",
    input: z.object({ n: z.number() }),
    impl: async (_ctx, input: { n: number }) => ({ n: input.n * 2 }),
  });
  kernel.register({
    name: "demo.fail",
    input: z.object({}),
    impl: async () => {
      throw new Error("boom");
    },
  });
  return { kernel, events };
}

describe("Kernel", () => {
  test("调用并收割：得到结果，事件流依次为 run.started、run.exited", async () => {
    const { kernel, events } = setup();
    const runId = kernel.start("math.double", { n: 21 });

    expect(await kernel.reap(runId)).toEqual({ ok: true, value: { n: 42 } });
    expect(events.map((e) => [e.seq, e.type, e.runId])).toEqual([
      [1, "run.started", runId],
      [2, "run.exited", runId],
    ]);
    expect(events[1]).toMatchObject({ operation: "math.double", result: { ok: true, value: { n: 42 } } });
  });

  test("实现抛异常：以拒绝结果退出，by 为该 Operation", async () => {
    const { kernel, events } = setup();
    const runId = kernel.start("demo.fail", {});

    const rejected: Rejected = { ok: false, by: "demo.fail", reason: "boom", retryable: false };
    expect(await kernel.reap(runId)).toEqual(rejected);
    expect(events.at(-1)).toMatchObject({ type: "run.exited", result: rejected });
  });

  test("结果保留到收割；收割后 Run 从内核移除", async () => {
    const { kernel, events } = setup();
    const runId = kernel.start("math.double", { n: 1 });
    await Bun.sleep(0);
    expect(events.at(-1)?.type).toBe("run.exited");

    expect(await kernel.reap(runId)).toEqual({ ok: true, value: { n: 2 } });
    await expect(kernel.reap(runId)).rejects.toThrow("unknown run");
  });

  test("未注册的名字与重复注册都直接报错", () => {
    const { kernel } = setup();
    expect(() => kernel.start("nope.nope", {})).toThrow("unknown operation");
    expect(() => kernel.register({ name: "math.double", input: z.any(), impl: async () => 0 })).toThrow("duplicate operation");
  });

  test("入参按 schema 校验：不符合时 start 报错；实现拿到解析后的值", async () => {
    const { kernel } = setup();
    kernel.register({
      name: "demo.greet",
      input: z.object({ name: z.string(), times: z.number().default(1) }),
      impl: async (_ctx, input) => input,
    });

    expect(() => kernel.start("demo.greet", { name: 1 })).toThrow("invalid input for demo.greet");
    expect(await kernel.reap(kernel.start("demo.greet", { name: "张三", extra: true }))).toEqual({
      ok: true,
      value: { name: "张三", times: 1 },
    });
  });

  test("订阅者出错不影响 Run 与其他订阅者", async () => {
    const { kernel, events } = setup();
    kernel.events.subscribe(() => {
      throw new Error("subscriber down");
    });
    const origError = console.error;
    console.error = () => {};
    try {
      const runId = kernel.start("math.double", { n: 2 });
      expect(await kernel.reap(runId)).toEqual({ ok: true, value: { n: 4 } });
    } finally {
      console.error = origError;
    }
    expect(events.map((e) => e.type)).toEqual(["run.started", "run.exited"]);
  });
});
