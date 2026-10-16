import { describe, expect, test } from "bun:test";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import type { HarnessEvent } from "./events";
import { Kernel } from "./kernel";
import type { Rejected } from "./run";

const cancelled: Rejected = { ok: false, by: "kernel", reason: "cancelled", retryable: false };

/** demo_parent 调 demo_child；demo_child 卡在 gate 上，直到测试放行 */
async function setup() {
  const kernel = new Kernel();
  const events: HarnessEvent[] = [];
  kernel.events.subscribe((e) => events.push(e));
  const gate = Promise.withResolvers<void>();
  kernel.register({ name: "demo_parent", input: z.null(), impl: (ctx) => ctx.call("demo_child", null) });
  kernel.register({
    name: "demo_child",
    input: z.null(),
    impl: async () => {
      await gate.promise;
      return "late";
    },
  });
  await kernel.boot();
  const idOf = (operation: string) => {
    const started = events.find((e) => e.type === "run.started" && e.operation === operation);
    if (!started) throw new Error(`${operation} has not started`);
    return started.runId;
  };
  return { kernel, events, gate, idOf };
}

describe("取消", () => {
  test("取消根 Run：连同子孙转 killed，收割得到内核的拒绝，不再有 run.exited", async () => {
    const { kernel, events, idOf } = await setup();
    const root = kernel.submit("demo_parent", null);

    expect(kernel.cancel(root)).toBe(true);
    expect(await kernel.reap(root)).toEqual(cancelled);
    await Bun.sleep(1);
    expect(events.map((e) => [e.type, e.runId])).toEqual([
      ["run.started", root],
      ["run.started", idOf("demo_child")],
      ["run.killed", root],
      ["run.killed", idOf("demo_child")],
      ["run.reaped", root],
    ]);
  });

  test("取消子 Run：父拿到内核的拒绝，照常往下执行", async () => {
    const { kernel, idOf } = await setup();
    const root = kernel.submit("demo_parent", null);

    kernel.cancel(idOf("demo_child"));
    expect(await kernel.reap(root)).toEqual({ ok: true, value: cancelled });
  });

  test("ctx.signal：取消时 abort，子孙的也一样；传给支持它的 API 就能当场中止 IO", async () => {
    const { kernel } = await setup();
    let aborted: unknown;
    kernel.register({ name: "demo_outer", input: z.null(), impl: (ctx) => ctx.call("demo_sleep", null) });
    kernel.register({
      name: "demo_sleep",
      input: z.null(),
      impl: async (ctx) => {
        try {
          await setTimeout(60_000, undefined, { signal: ctx.signal });
        } catch (err) {
          aborted = err;
        }
      },
    });
    const root = kernel.submit("demo_outer", null);

    kernel.cancel(root);
    await Bun.sleep(1);
    expect(aborted).toMatchObject({ name: "AbortError" });
    expect(await kernel.reap(root)).toEqual(cancelled);
  });

  test("不理会 ctx.signal 的实现会跑完，但结果作废；之后它发起的调用以拒绝返回", async () => {
    const { kernel, events, gate } = await setup();
    let late: unknown;
    kernel.register({
      name: "demo_stubborn",
      input: z.null(),
      impl: async (ctx) => {
        await gate.promise;
        late = await ctx.call("demo_child", null);
        return "ignored";
      },
    });
    const id = kernel.submit("demo_stubborn", null);

    kernel.cancel(id);
    gate.resolve();
    await Bun.sleep(1);
    expect(late).toMatchObject({ ok: false, by: "kernel", reason: "caller is killed" });
    expect(events.map((e) => e.type)).toEqual(["run.started", "run.killed", "call.rejected"]);
    expect(await kernel.reap(id)).toEqual(cancelled);
  });

  test("装饰器还没走到实现时被取消：实现不再开始", async () => {
    const { kernel, gate } = await setup();
    let calls = 0;
    kernel.registerDecorator({
      id: "demo_hold",
      onError: "closed",
      fn: async (_ctx, _run, next) => {
        await gate.promise;
        return next();
      },
    });
    kernel.register({
      name: "demo_work",
      input: z.null(),
      decorators: ["demo_hold"],
      impl: async () => {
        calls++;
        return "done";
      },
    });
    const id = kernel.submit("demo_work", null);

    kernel.cancel(id);
    gate.resolve();
    await Bun.sleep(1);
    expect(calls).toBe(0);
    expect(await kernel.reap(id)).toEqual(cancelled);
  });

  test("取消已结束或不存在的 Run：返回 false", async () => {
    const { kernel, gate } = await setup();
    gate.resolve();
    const root = kernel.submit("demo_parent", null);
    await kernel.reap(root);

    expect(kernel.cancel(root)).toBe(false);
    expect(kernel.cancel("nope")).toBe(false);
  });
});

describe("关停", () => {
  test("优雅关停：不再接受新的外部调用；正在执行的跑完，树里新发起的调用停在边界上不执行，随后按 shutdown 杀掉", async () => {
    const { kernel, events, gate } = await setup();
    kernel.register({
      name: "demo_later",
      input: z.null(),
      impl: async (ctx) => {
        await gate.promise;
        return ctx.call("demo_child", null);
      },
    });
    const root = kernel.submit("demo_later", null);

    // 超时给得很长：停下来靠的是「没有正在执行的了」，不是超时
    const stopping = kernel.stop(60_000);
    expect(() => kernel.submit("demo_later", null)).toThrow("harness is stopping");
    gate.resolve();
    await stopping;
    expect(await kernel.reap(root)).toEqual({ ok: false, by: "kernel", reason: "shutdown", retryable: false });
    expect(events.filter((e) => e.type === "run.started").map((e) => e.operation)).toEqual(["demo_later"]);
  });

  test("到超时仍有正在执行的：按 killed 处理，原因是 shutdown", async () => {
    const { kernel, events } = await setup();
    const root = kernel.submit("demo_parent", null);

    await kernel.stop(5);
    expect(await kernel.reap(root)).toEqual({ ok: false, by: "kernel", reason: "shutdown", retryable: false });
    expect(events.filter((e) => e.type === "run.killed").map((e) => [e.operation, e.reason])).toEqual([
      ["demo_parent", "shutdown"],
      ["demo_child", "shutdown"],
    ]);
  });

  test("stop(0) 强杀：什么也不等，立即按 shutdown 杀掉", async () => {
    const { kernel, events, gate } = await setup();
    const root = kernel.submit("demo_parent", null);

    await kernel.stop(0);
    gate.resolve();
    expect(await kernel.reap(root)).toMatchObject({ ok: false, reason: "shutdown" });
    expect(events.filter((e) => e.type === "run.killed")).toHaveLength(2);
  });
});
