import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import type { HarnessEvent } from "../kernel/events";
import { Kernel } from "../kernel/kernel";
import { loadScript } from "../kernel/loader";

const fixture = (name: string) => join(import.meta.dir, "__fixtures__", name);

/** 装上测试用的 script 包，外加几个原生的：公开的 demo_now、不公开的 demo_secret、永不返回的 demo_forever */
async function setup(pkg: string) {
  const kernel = new Kernel();
  const events: HarnessEvent[] = [];
  kernel.events.subscribe((e) => events.push(e));
  kernel.register({ name: "demo_now", usage: "现在", public: true, input: z.null(), impl: async () => 42 });
  kernel.register({ name: "demo_secret", input: z.null(), impl: async () => "secret" });
  kernel.register({ name: "demo_forever", usage: "不返回", public: true, tool: false, input: z.null(), impl: () => new Promise(() => {}) });
  kernel.register({ name: "demo_outer", input: z.null(), impl: (ctx) => ctx.call(`${pkg}_echo`, { text: "嗨" }) });
  await loadScript(kernel, fixture(pkg), { sliceMs: 100 });
  await kernel.boot();
  const run = (name: string, input: unknown = null) => kernel.reap(kernel.submit(name, input));
  return { kernel, events, run };
}

describe("script 包在解释器里跑", () => {
  test("入参按 JSON Schema 校验、填缺省值；包内的模块与文本资源内联；调用经内核；出参按 schema 校验", async () => {
    const { kernel, run } = await setup("probe");

    expect(await run("probe_echo", { text: "嗨" })).toEqual({
      ok: true,
      value: { text: "嗨 嗨", greeting: "你好", tools: ["demo_now", "probe_echo", "probe_fail", "probe_globals", "probe_hang", "probe_reach"], callerPackage: null, runs: 1, now: { ok: true, value: 42 } },
    });
    expect(() => kernel.submit("probe_echo", { text: 1 })).toThrow("invalid input for probe_echo");
  });

  test("每个 Run 一个全新的解释器：模块级的状态不跨 Run；callerPackage 是调用方的包", async () => {
    const { run } = await setup("probe");

    await run("probe_echo", { text: "a" });
    expect(await run("probe_echo", { text: "b" })).toMatchObject({ ok: true, value: { runs: 1 } });
    expect(await run("demo_outer")).toMatchObject({ ok: true, value: { ok: true, value: { runs: 1, callerPackage: "demo" } } });
  });

  test("没有宿主对象与定时器；时间与随机数还没有", async () => {
    const { run } = await setup("probe");

    const unavailable = (what: string) => `throws: ${what} is not available in scripts yet: call time_now`;
    expect(await run("probe_globals")).toEqual({
      ok: true,
      value: {
        types: ["process", "Bun", "fetch", "require", "setTimeout", "setInterval", "performance", "console"].map((name) => [name, "undefined"]),
        now: unavailable("Date.now()"),
        newDate: unavailable("new Date()"),
        epoch: "1970-01-01T00:00:00.000Z",
        random: unavailable("Math.random()"),
      },
    });
  });

  test("只能调公开的，不能直接挂起；抛的异常成为拒绝的原因", async () => {
    const { run } = await setup("probe");

    expect(await run("probe_reach")).toEqual({
      ok: true,
      value: {
        secret: { ok: false, by: "kernel", reason: "demo_secret is not public: probe_reach is a script", retryable: false },
        park: "a script cannot park directly: call an operation",
      },
    });
    expect(await run("probe_fail")).toEqual({ ok: false, by: "probe_fail", reason: "坏了", retryable: false });
  });

  test("被取消：在等的解释器丢掉，Run 以内核的拒绝结束", async () => {
    const { kernel, events } = await setup("probe");
    const root = kernel.submit("probe_hang", null);
    while (!events.some((e) => e.type === "run.started" && e.operation === "demo_forever")) await Bun.sleep(1);

    expect(kernel.cancel(root)).toBe(true);
    expect(await kernel.reap(root)).toEqual({ ok: false, by: "kernel", reason: "cancelled", retryable: false });
  });

  test("一段同步执行太久、或超出内存：这个 Run 失败", async () => {
    const { run } = await setup("spin");

    expect(await run("spin_loop")).toEqual({ ok: false, by: "spin_loop", reason: "a synchronous stretch ran longer than 100 ms", retryable: false });
    expect(await run("spin_hog")).toMatchObject({ ok: false, by: "spin_hog", reason: expect.stringContaining("out of memory") });
  });
});

describe("装载", () => {
  test("只能 import stdlib、zod 与包里的文件：别的打包即失败", async () => {
    await expect(loadScript(new Kernel(), fixture("nodefs"))).rejects.toThrow(
      "nodefs: index.ts imports node:fs: a script package can only import stdlib, zod and its own files",
    );
    await expect(loadScript(new Kernel(), fixture("outside"))).rejects.toThrow(
      "outside: index.ts imports ../probe/twice: a script package can only import stdlib, zod and its own files",
    );
  });

  test("默认导出不是 script()、schema 转不成 JSON Schema：装载失败", async () => {
    await expect(loadScript(new Kernel(), fixture("notscript"))).rejects.toThrow("notscript: default export is not script()");
    await expect(loadScript(new Kernel(), fixture("custom"))).rejects.toThrow("custom: custom_at: Date cannot be represented in JSON Schema");
  });
});
