import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { HarnessEvent } from "./events";
import { Kernel } from "./kernel";
import { loadPlugin, scanTags } from "./loader";

const fixture = (name: string) => join(import.meta.dir, "__fixtures__", name);

async function setup() {
  const kernel = new Kernel();
  const events: HarnessEvent[] = [];
  kernel.events.subscribe((e) => events.push(e));
  await loadPlugin(kernel, fixture("greet"));
  const run = (name: string, input: unknown) => kernel.reap(kernel.start(name, input));
  return { events, run };
}

describe("装载插件包", () => {
  test("导出函数注册为「包名.函数名」，@decorators 引用的装饰器进链", async () => {
    const { events, run } = await setup();

    expect(await run("greet.hello", { name: "张三" })).toEqual({ ok: true, value: "hello 尊敬的张三" });
    expect(await run("greet.bye", { name: "张三" })).toEqual({ ok: true, value: "bye 张三" });
    expect(events.filter((e) => e.type === "run.started").map((e) => [e.operation, e.chain])).toEqual([
      ["greet.hello", ["greet.polite"]],
      ["greet.bye", []],
    ]);
  });

  test("@onError open 生效：装饰器出错时跳过", async () => {
    const { events, run } = await setup();

    expect(await run("greet.hello", { name: "" })).toEqual({ ok: true, value: "hello " });
    expect(events).toContainEqual(expect.objectContaining({ type: "decorator.failed", onError: "open" }));
  });

  test("导出了非函数：装载失败", async () => {
    await expect(loadPlugin(new Kernel(), fixture("bad"))).rejects.toThrow("bad: export version is not a function");
  });
});

describe("scanTags", () => {
  test("只取紧挨着导出函数的 JSDoc，标签须在行首", () => {
    const source = `
/** 包简介 */
import { x } from "y";

/**
 * 说明里的 a@b.com 不是标签
 * @decorators a.x, b.y
 * @decorator
 */
export async function f() {}

export function g() {}
`;
    expect(scanTags(source)).toEqual(
      new Map([["f", new Map([["decorators", "a.x, b.y"], ["decorator", ""]])]]),
    );
  });
});
