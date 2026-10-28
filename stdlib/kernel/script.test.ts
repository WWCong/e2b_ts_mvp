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
    await expect(loadScript(new Kernel(), fixture("greet"))).rejects.toThrow('greet: 4:10 No matching export in "harness-base:stdlib" for import "decorator"');
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

describe("运行中换掉 script 包", () => {
  /** script 包 demo：say 先等 demo_gate 放行再回答版本号；demo_gate 是公开的原生 Operation，release 放行 */
  async function setup() {
    const kernel = new Kernel();
    let release = () => {};
    kernel.register({
      name: "gate_wait",
      usage: "等放行",
      public: true,
      input: z.null(),
      impl: () => new Promise((resolve) => (release = () => resolve(null))),
    });
    const version = (v: string) => ({
      operations: {
        say: op({ usage: "说版本", input: z.object({ wait: z.boolean().default(false) }), impl: async (ctx, { wait }) => (wait && (await ctx.call("gate_wait", null)), v) }),
      },
    });
    kernel.useScript("demo", version("v1"));
    kernel.use("other", {
      operations: { tools: op({ input: z.null(), only: ["demo", "fresh"], impl: async (ctx) => ctx.tools().map((t) => t.name) }) },
    });
    await kernel.boot();
    const run = (input: unknown = {}) => kernel.reap(kernel.submit("demo_say", input));
    return { kernel, version, run, release: () => release() };
  }

  test("之后的调用用新的；正在跑的 Run 用旧的跑完", async () => {
    const { kernel, version, run, release } = await setup();
    const inflight = kernel.submit("demo_say", { wait: true });
    await Bun.sleep(5);

    kernel.installScript("demo", version("v2"));
    expect(await run()).toEqual({ ok: true, value: "v2" });
    release();
    expect(await kernel.reap(inflight)).toEqual({ ok: true, value: "v1" });
  });

  test("新的里没有的 Operation 之后调用即 unknown，新加的能调，工具列表跟着变", async () => {
    const { kernel } = await setup();
    const tools = () => kernel.reap(kernel.submit("other_tools", null));
    expect(await tools()).toEqual({ ok: true, value: ["demo_say"] });
    kernel.installScript("demo", { operations: { hello: op({ usage: "打招呼", input: z.null(), impl: async () => "hi" }) } });

    expect(() => kernel.submit("demo_say", {})).toThrow("unknown operation: demo_say");
    expect(await kernel.reap(kernel.submit("demo_hello", null))).toEqual({ ok: true, value: "hi" });
    expect(await tools()).toEqual({ ok: true, value: ["demo_hello"] });
  });

  test("新的有问题：抛异常，旧的照旧；只能换装上的 script 包", async () => {
    const { kernel, run } = await setup();

    expect(() => kernel.installScript("demo", { requires: ["web"], operations: {} })).toThrow("demo requires web, which is not loaded");
    expect(() =>
      kernel.installScript("demo", {
        operations: { a: op({ usage: "a", input: z.null(), impl: async () => 1 }), b: op({ input: z.null(), impl: async () => 2 }) },
      }),
    ).toThrow("public operation needs usage: demo_b");
    expect(await run()).toEqual({ ok: true, value: "v1" });
    expect(() => kernel.installScript("other", { operations: {} })).toThrow("other is a plugin, not a script package");
    expect(() => kernel.installScript("Bad", { operations: {} })).toThrow("invalid package name: Bad");
  });

  test("装上一个新的 script 包：之后就能调；有问题就什么也没装", async () => {
    const { kernel } = await setup();
    expect(() => kernel.installScript("fresh", { requires: ["web"], operations: {} })).toThrow("fresh requires web, which is not loaded");
    expect(() => kernel.submit("fresh_hi", null)).toThrow("unknown operation: fresh_hi");

    kernel.installScript("fresh", { operations: { hi: op({ usage: "嗨", input: z.null(), impl: async () => "嗨" }) } });
    expect(await kernel.reap(kernel.submit("fresh_hi", null))).toEqual({ ok: true, value: "嗨" });
    expect(await kernel.reap(kernel.submit("other_tools", null))).toEqual({ ok: true, value: ["demo_say", "fresh_hi"] });
  });
});

