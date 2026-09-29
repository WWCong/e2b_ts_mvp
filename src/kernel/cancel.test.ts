import { describe, expect, test } from "bun:test";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import type { HarnessEvent } from "./events";
import { Kernel } from "./kernel";
import type { Rejected } from "./run";

const cancelled: Rejected = { ok: false, by: "kernel", reason: "cancelled", retryable: false };

/** demo_parent 调 demo_child；demo_child 卡在 gate 上，直到测试放行 */
function setup() {
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
  const idOf = (operation: string) => {
    const started = events.find((e) => e.type === "run.started" && e.operation === operation);
    if (!started) throw new Error(`${operation} has not started`);
    return started.runId;
  };
  return { kernel, events, gate, idOf };
}

describe("取消", () => {
  test("取消根 Run：连同子孙转 killed，收割得到内核的拒绝，不再有 run.exited", async () => {
    const { kernel, events, idOf } = setup();
    const root = kernel.start("demo_parent", null);

    expect(kernel.cancel(root)).toBe(true);
    expect(await kernel.reap(root)).toEqual(cancelled);
    await Bun.sleep(1);
    expect(events.map((e) => [e.type, e.runId])).toEqual([
      ["run.started", root],
      ["run.started", idOf("demo_child")],
      ["run.killed", root],
      ["run.killed", idOf("demo_child")],
    ]);
  });

  test("取消子 Run：父拿到内核的拒绝，照常往下执行", async () => {
    const { kernel, idOf } = setup();
    const root = kernel.start("demo_parent", null);

    kernel.cancel(idOf("demo_child"));
    expect(await kernel.reap(root)).toEqual({ ok: true, value: cancelled });
  });

  test("ctx.signal：取消时 abort，子孙的也一样；传给支持它的 API 就能当场中止 IO", async () => {
    const { kernel } = setup();
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
    const root = kernel.start("demo_outer", null);

    kernel.cancel(root);
    await Bun.sleep(1);
    expect(aborted).toMatchObject({ name: "AbortError" });
    expect(await kernel.reap(root)).toEqual(cancelled);
  });

  test("不理会 ctx.signal 的实现会跑完，但结果作废；之后它发起的调用以拒绝返回", async () => {
    const { kernel, events, gate } = setup();
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
    const id = kernel.start("demo_stubborn", null);

    kernel.cancel(id);
    gate.resolve();
    await Bun.sleep(1);
    expect(late).toMatchObject({ ok: false, by: "kernel", reason: "caller is killed" });
    expect(events.map((e) => e.type)).toEqual(["run.started", "run.killed", "call.rejected"]);
    expect(await kernel.reap(id)).toEqual(cancelled);
  });

  test("装饰器还没走到实现时被取消：实现不再开始", async () => {
    const { kernel, gate } = setup();
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
    const id = kernel.start("demo_work", null);

    kernel.cancel(id);
    gate.resolve();
    await Bun.sleep(1);
    expect(calls).toBe(0);
    expect(await kernel.reap(id)).toEqual(cancelled);
  });

  test("取消已结束或不存在的 Run：返回 false", async () => {
    const { kernel, gate } = setup();
    gate.resolve();
    const root = kernel.start("demo_parent", null);
    await kernel.reap(root);

    expect(kernel.cancel(root)).toBe(false);
    expect(kernel.cancel("nope")).toBe(false);
  });
});

describe("关停", () => {
  test("不再接受新的外部调用；在途的树在超时前收敛就正常退出，树内的子调用照常进行", async () => {
    const { kernel, gate } = setup();
    kernel.register({
      name: "demo_later",
      input: z.null(),
      impl: async (ctx) => {
        await gate.promise;
        return ctx.call("demo_child", null);
      },
    });
    const root = kernel.start("demo_later", null);

    const stopping = kernel.stop(1_000);
    expect(() => kernel.start("demo_later", null)).toThrow("harness is stopping");
    gate.resolve();
    await stopping;
    expect(await kernel.reap(root)).toEqual({ ok: true, value: { ok: true, value: "late" } });
  });

  test("到超时仍在途的树按 killed 处理，原因是 shutdown", async () => {
    const { kernel, events } = setup();
    const root = kernel.start("demo_parent", null);

    await kernel.stop(5);
    expect(await kernel.reap(root)).toEqual({ ok: false, by: "kernel", reason: "shutdown", retryable: false });
    expect(events.filter((e) => e.type === "run.killed").map((e) => [e.operation, e.reason])).toEqual([
      ["demo_parent", "shutdown"],
      ["demo_child", "shutdown"],
    ]);
  });
});
