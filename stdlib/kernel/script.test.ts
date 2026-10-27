import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import type { HarnessEvent } from "./events";
import { Kernel } from "./kernel";
import { loadPlugin, loadScript } from "./loader";
import { op } from "./plugin";

const fixture = (name: string) => join(import.meta.dir, "__fixtures__", name);

/** 公开的 fs_read、不公开的 fs_secret，加一个 script 包 demo */
async function setup(operations: Parameters<Kernel["useScript"]>[1]["operations"]) {
  const kernel = new Kernel();
  const events: HarnessEvent[] = [];
  kernel.events.subscribe((e) => events.push(e));
  kernel.register({ name: "fs_read", usage: "读", public: true, input: z.null(), impl: async () => "content" });
  kernel.register({ name: "fs_secret", input: z.null(), impl: async () => "secret" });
  kernel.useScript("demo", { operations });
  await kernel.boot();
  const run = (name: string, input: unknown = null) => kernel.reap(kernel.submit(name, input));
  return { kernel, events, run };
}

describe("script 包", () => {
  test("只能调公开的 Operation：不公开的以内核的拒绝返回、不建子 Run；不存在的照常是 unknown", async () => {
    const { events, run } = await setup({
      read: op({
        usage: "读三样",
        input: z.null(),
        impl: (ctx) => Promise.all(["fs_read", "fs_secret", "fs_nope"].map((name) => ctx.call(name, null))),
      }),
    });

    const hidden = { ok: false, by: "kernel", reason: "fs_secret is not public: demo_read is a script", retryable: false };
    expect(await run("demo_read")).toEqual({
      ok: true,
      value: [{ ok: true, value: "content" }, hidden, { ok: false, by: "kernel", reason: "unknown operation: fs_nope", retryable: false }],
    });
    expect(events.filter((e) => e.type === "run.started").map((e) => e.operation)).toEqual(["demo_read", "fs_read"]);
    expect(events).toContainEqual(expect.objectContaining({ type: "call.rejected", target: "fs_secret", result: hidden }));
  });

  test("它的 Operation 都公开：别的 script 能调，也作为工具交给模型；所以必须写 usage", async () => {
    const { run } = await setup({
      echo: op({ usage: "回声", input: z.string(), impl: async (_ctx, text) => text }),
      relay: op({ usage: "转给 echo", input: z.null(), impl: (ctx) => ctx.call("demo_echo", "hi") }),
      tools: op({ usage: "看工具", input: z.null(), only: ["demo"], impl: async (ctx) => ctx.tools().map((t) => t.name) }),
    });

    expect(await run("demo_relay")).toEqual({ ok: true, value: { ok: true, value: "hi" } });
    expect(await run("demo_tools")).toEqual({ ok: true, value: ["demo_echo", "demo_relay", "demo_tools"] });
    expect(() => new Kernel().useScript("demo", { operations: { echo: op({ input: z.null(), impl: async () => null }) } })).toThrow(
      "public operation needs usage: demo_echo",
    );
    expect(() =>
      new Kernel().useScript("demo", { operations: { echo: op({ usage: "x", public: false, input: z.null(), impl: async () => null }) } }),
    ).toThrow("script operations are public: demo_echo");
  });

  test("不能直接挂起：ctx.park 抛异常，只能调 Operation", async () => {
    const { run } = await setup({
      wait: op({ usage: "等", input: z.null(), impl: (ctx) => ctx.park({ schema: {}, payload: null }) }),
    });

    expect(await run("demo_wait")).toEqual({ ok: false, by: "demo_wait", reason: "a script cannot park directly: call an operation", retryable: false });
  });

  test("对象里只认 requires 与 operations：没有装饰器、挂点；requires 的包没装，启动失败", async () => {
    const kernel = new Kernel();
    expect(() => kernel.useScript("demo", { operations: {}, onStart() {} } as never)).toThrow("demo: unknown key in script object: onStart");

    kernel.useScript("demo", { requires: ["fs"], operations: {} });
    await expect(kernel.boot()).rejects.toThrow("demo requires fs, which is not loaded");
  });

  test("loadScript：默认导出须是 script()；插件与 script 包不能互相冒充", async () => {
    const kernel = new Kernel();
    await loadScript(kernel, fixture("relay"));
    await kernel.boot();
    expect(await kernel.reap(kernel.submit("relay_bye", { name: "张三" }))).toEqual({ ok: true, value: "再见，张三" });

    // 插件 import 的 plugin、decorator 在解释器里的 stdlib 没有：打包即失败
    await expect(loadScript(new Kernel(), fixture("greet"))).rejects.toThrow('greet: No matching export in "harness-base:stdlib" for import "decorator"');
    await expect(loadPlugin(new Kernel(), fixture("relay"))).rejects.toThrow("relay: default export is not plugin()");
  });
});

describe("ctx.callerPackage", () => {
  test("父 Run 的 Operation 所在的包；外部发起的根 Run 没有", async () => {
    const kernel = new Kernel();
    kernel.register({ name: "kv_who", input: z.null(), impl: async (ctx) => ctx.callerPackage ?? null });
    kernel.register({ name: "demo_ask", input: z.null(), impl: (ctx) => ctx.call("kv_who", null) });
    await kernel.boot();

    expect(await kernel.reap(kernel.submit("kv_who", null))).toEqual({ ok: true, value: null });
    expect(await kernel.reap(kernel.submit("demo_ask", null))).toEqual({ ok: true, value: { ok: true, value: "demo" } });
  });
});
