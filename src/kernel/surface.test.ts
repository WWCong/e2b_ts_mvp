import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { HarnessEvent } from "./events";
import { Kernel } from "./kernel";
import type { Surface } from "./surface";
import { inSurface } from "./surface";

describe("inSurface", () => {
  test("都不写即全开；项可以是 Operation 名或包名；先 only 再 exclude", () => {
    const check = (surface: Surface, targets: string[]) => targets.map((t) => inSurface(surface, t));
    const targets = ["fs_read", "fs_delete", "web_search", "web_fetch"];

    expect(check({}, targets)).toEqual([true, true, true, true]);
    expect(check({ only: ["fs"] }, targets)).toEqual([true, true, false, false]);
    expect(check({ exclude: ["web"] }, targets)).toEqual([true, true, false, false]);
    expect(check({ only: ["fs", "web_search"], exclude: ["fs_delete"] }, targets)).toEqual([true, false, true, false]);
  });
});

describe("能力面检查", () => {
  function setup() {
    const kernel = new Kernel();
    const events: HarnessEvent[] = [];
    kernel.events.subscribe((e) => events.push(e));
    kernel.register({ name: "fs_read", input: z.null(), impl: async () => "content" });
    kernel.register({ name: "web_search", input: z.null(), impl: async () => "results" });
    const run = (name: string) => kernel.reap(kernel.start(name, null));
    return { kernel, events, run };
  }

  test("目标不在发起方的能力面里：以内核的拒绝返回，不建子 Run，发 call.rejected", async () => {
    const { kernel, events, run } = setup();
    kernel.register({
      name: "demo_reader",
      input: z.null(),
      only: ["fs"],
      impl: (ctx) => Promise.all([ctx.call("fs_read", null), ctx.call("web_search", null)]),
    });

    const rejected = { ok: false, by: "kernel", reason: "web_search is not in the surface of demo_reader", retryable: false };
    expect(await run("demo_reader")).toEqual({ ok: true, value: [{ ok: true, value: "content" }, rejected] });
    expect(events.filter((e) => e.type === "run.started").map((e) => e.operation)).toEqual(["demo_reader", "fs_read"]);
    expect(events).toContainEqual(expect.objectContaining({ type: "call.rejected", target: "web_search", result: rejected }));
  });

  test("不继承：子 Run 的能力面只看它自己的声明", async () => {
    const { kernel, run } = setup();
    kernel.register({ name: "demo_outer", input: z.null(), only: ["demo_inner"], impl: (ctx) => ctx.call("demo_inner", null) });
    kernel.register({ name: "demo_inner", input: z.null(), impl: (ctx) => ctx.call("web_search", null) });

    // outer 的值是 inner 的调用结果，inner 的值是 web_search 的调用结果
    expect(await run("demo_outer")).toEqual({ ok: true, value: { ok: true, value: { ok: true, value: "results" } } });
  });

  test("装饰器发起的调用不查被装饰 Run 的能力面", async () => {
    const { kernel, run } = setup();
    let seen: unknown;
    kernel.registerDecorator({
      id: "demo_peek",
      onError: "closed",
      fn: async (ctx, _run, next) => {
        seen = await ctx.call("web_search", null);
        return next();
      },
    });
    kernel.register({ name: "demo_reader", input: z.null(), only: ["fs"], decorators: ["demo_peek"], impl: async () => "done" });

    expect(await run("demo_reader")).toEqual({ ok: true, value: "done" });
    expect(seen).toEqual({ ok: true, value: "results" });
  });
});
