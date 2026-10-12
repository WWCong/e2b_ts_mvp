import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { HarnessEvent } from "./events";
import { Kernel } from "./kernel";
import { loadPlugin } from "./loader";

const fixture = (name: string) => join(import.meta.dir, "__fixtures__", name);

async function setup(config?: unknown) {
  const kernel = new Kernel();
  const events: HarnessEvent[] = [];
  kernel.events.subscribe((e) => events.push(e));
  await loadPlugin(kernel, fixture("greet"), config);
  await kernel.boot();
  const run = (name: string, input: unknown) => kernel.reap(kernel.start(name, input));
  return { events, run };
}

describe("装载插件包", () => {
  test("插件对象里的 Operation 与装饰器注册为「包名_键名」，decorators 引用的装饰器进链", async () => {
    const { events, run } = await setup();

    expect(await run("greet_hello", { name: "张三" })).toEqual({ ok: true, value: "hello 尊敬的张三" });
    expect(await run("greet_bye", { name: "张三" })).toEqual({ ok: true, value: "bye 张三" });
    expect(events.filter((e) => e.type === "run.started").map((e) => [e.operation, e.chain])).toEqual([
      ["greet_hello", ["greet_polite"]],
      ["greet_bye", []],
    ]);
  });

  test("配置交给工厂；每个内核各调一次工厂，各有各的实例", async () => {
    const [hi, plain] = [await setup({ greeting: "hi" }), await setup()];

    expect(await hi.run("greet_hello", { name: "张三" })).toEqual({ ok: true, value: "hi 尊敬的张三" });
    expect(await plain.run("greet_hello", { name: "张三" })).toEqual({ ok: true, value: "hello 尊敬的张三" });
  });

  test("onError open 生效：装饰器出错时跳过", async () => {
    const { events, run } = await setup();

    expect(await run("greet_hello", { name: "" })).toEqual({ ok: true, value: "hello " });
    expect(events).toContainEqual(expect.objectContaining({ type: "decorator.failed", onError: "open" }));
  });

  test("包名不合命名规则：装载失败", async () => {
    await expect(loadPlugin(new Kernel(), fixture("bad_pkg"))).rejects.toThrow("invalid package name: bad_pkg");
  });

  test("默认导出不是 plugin()：装载失败", async () => {
    await expect(loadPlugin(new Kernel(), fixture("bad"))).rejects.toThrow("bad: default export is not plugin()");
  });
});
