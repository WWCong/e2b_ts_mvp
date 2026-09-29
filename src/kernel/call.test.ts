import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { HarnessEvent } from "./events";
import { Kernel, type KernelConfig } from "./kernel";
import type { Result, Run } from "./run";

function setup(config: KernelConfig = {}) {
  const kernel = new Kernel(config);
  const events: HarnessEvent[] = [];
  kernel.events.subscribe((e) => events.push(e));
  kernel.register({ name: "math.double", input: z.number(), impl: async (_ctx, n: number) => n * 2 });
  const run = (name: string, input: unknown) => kernel.reap(kernel.start(name, input));
  const started = () => events.filter((e) => e.type === "run.started");
  return { kernel, events, run, started };
}

describe("子调用", () => {
  test("子 Run 记下父与深度；父在等子时处于 waiting，子返回后回到 running", async () => {
    const { kernel, events, run } = setup();
    let parentRun: Run | undefined;
    const seen: string[] = [];
    kernel.registerDecorator({
      id: "spy",
      onError: "closed",
      fn: (_ctx, r, next) => {
        parentRun = r;
        return next();
      },
    });
    kernel.register({
      name: "demo.parent",
      input: z.number(),
      decorators: ["spy"],
      impl: async (ctx, n: number) => {
        const r = await ctx.call("demo.child", n);
        seen.push(`after call: ${parentRun?.status}`);
        return r;
      },
    });
    kernel.register({
      name: "demo.child",
      input: z.number(),
      impl: async (_ctx, n: number) => {
        seen.push(`in child: ${parentRun?.status}`);
        return n + 1;
      },
    });

    expect(await run("demo.parent", 1)).toEqual({ ok: true, value: { ok: true, value: 2 } });
    expect(seen).toEqual(["in child: waiting", "after call: running"]);

    const [p, c] = events.filter((e) => e.type === "run.started");
    expect(p).toMatchObject({ operation: "demo.parent", depth: 0, parent: undefined });
    expect(c).toMatchObject({ operation: "demo.child", depth: 1, parent: p!.runId });
    expect(events.map((e) => [e.type, e.runId])).toEqual([
      ["run.started", p!.runId],
      ["run.started", c!.runId],
      ["run.exited", c!.runId],
      ["run.exited", p!.runId],
    ]);
  });

  test("装饰器里的 call 记在被装饰的 Run 名下", async () => {
    const { kernel, run, started } = setup();
    kernel.registerDecorator({
      id: "pre",
      onError: "closed",
      fn: async (ctx, _r, next) => {
        await ctx.call("math.double", 1);
        return next();
      },
    });
    kernel.register({ name: "demo.noop", input: z.null(), decorators: ["pre"], impl: async () => null });

    await run("demo.noop", null);
    const [outer, inner] = started();
    expect(inner).toMatchObject({ operation: "math.double", parent: outer?.runId });
  });

  test("目标不存在：以内核的拒绝返回，不建子 Run，发 call.rejected", async () => {
    const { kernel, events, run, started } = setup();
    kernel.register({ name: "demo.parent", input: z.null(), impl: (ctx) => ctx.call("nope.nope", 1) });

    const rejected = { ok: false, by: "kernel", reason: "unknown operation: nope.nope", retryable: false };
    expect(await run("demo.parent", null)).toEqual({ ok: true, value: rejected });
    expect(started()).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "call.rejected", target: "nope.nope", result: rejected }),
    );
  });

  test("入参不符合 schema：以内核的拒绝返回，retryable 为 true", async () => {
    const { kernel, run, started } = setup();
    kernel.register({ name: "demo.parent", input: z.null(), impl: (ctx) => ctx.call("math.double", "two") });

    expect(await run("demo.parent", null)).toMatchObject({
      ok: true,
      value: { ok: false, by: "kernel", reason: expect.stringContaining("invalid input for math.double"), retryable: true },
    });
    expect(started()).toHaveLength(1);
  });

  test("深度保险丝：超过最大深度的调用以拒绝返回", async () => {
    const { kernel, events, run, started } = setup({ kernel: { maxDepth: 3 } });
    kernel.register({ name: "demo.recurse", input: z.null(), impl: (ctx) => ctx.call("demo.recurse", null) });

    await run("demo.recurse", null);
    expect(started().map((e) => e.depth)).toEqual([0, 1, 2, 3]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "call.rejected", result: expect.objectContaining({ reason: "max depth 3 exceeded" }) }),
    );
  });

  test("存活 Run 数保险丝：超出的调用以拒绝返回", async () => {
    const { kernel, run } = setup({ kernel: { maxLiveRuns: 2 } });
    kernel.register({
      name: "demo.fanout",
      input: z.null(),
      impl: (ctx) => Promise.all([ctx.call("math.double", 1), ctx.call("math.double", 2)]),
    });

    const result = (await run("demo.fanout", null)) as { ok: true; value: Result[] };
    expect(result.value).toEqual([
      { ok: true, value: 2 },
      { ok: false, by: "kernel", reason: "max live runs 2 exceeded", retryable: false },
    ]);
  });

  test("实现没等子调用就返回：等子 Run 返回后父才退出", async () => {
    const { kernel, events, run } = setup();
    kernel.register({
      name: "demo.forget",
      input: z.null(),
      impl: async (ctx) => {
        ctx.call("demo.slow", null);
        return "done";
      },
    });
    kernel.register({ name: "demo.slow", input: z.null(), impl: () => Bun.sleep(5) });

    expect(await run("demo.forget", null)).toEqual({ ok: true, value: "done" });
    expect(events.filter((e) => e.type === "run.exited").map((e) => e.operation)).toEqual([
      "demo.slow",
      "demo.forget",
    ]);
  });

  test("发起方已退出后再用它的 ctx 调用：以拒绝返回", async () => {
    const { kernel, run } = setup();
    let late: Promise<Result> | undefined;
    kernel.register({
      name: "demo.leak",
      input: z.null(),
      impl: async (ctx) => {
        late = new Promise((resolve) => setTimeout(() => resolve(ctx.call("math.double", 1)), 5));
      },
    });

    await run("demo.leak", null);
    expect(await late).toMatchObject({ ok: false, reason: "caller is exited" });
  });
});
