import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Kernel } from "./kernel";
import type { ToolSpec } from "./run";

function setup() {
  const kernel = new Kernel();
  const noop = async () => null;
  kernel.register({ name: "fs_write", usage: "写文件", public: true, input: z.object({ path: z.string() }), impl: noop });
  kernel.register({
    name: "fs_list",
    usage: "列目录",
    public: true,
    input: z.object({ path: z.string().describe("目录").default(".") }),
    impl: noop,
  });
  kernel.register({ name: "fs_secret", input: z.null(), impl: noop });
  kernel.register({ name: "web_search", usage: "搜索", public: true, input: z.object({ q: z.string() }), impl: noop });
  return kernel;
}

describe("ctx.tools()", () => {
  test("列出能力面里的公开 Operation，按名字排序；入参 schema 按调用方要填的形状生成", async () => {
    const kernel = setup();
    let tools: ToolSpec[] = [];
    kernel.register({
      name: "demo_agent",
      input: z.null(),
      only: ["fs"],
      impl: async (ctx) => {
        tools = ctx.tools();
      },
    });
    await kernel.reap(kernel.start("demo_agent", null));

    // fs_secret 不公开，web_search 不在能力面
    expect(tools.map((t) => t.name)).toEqual(["fs_list", "fs_write"]);
    expect(tools[0]).toEqual({
      name: "fs_list",
      description: "列目录",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { path: { type: "string", description: "目录", default: "." } },
      },
    });
  });

  test("装饰器的 ctx 没有 tools()：类型上就不给", async () => {
    const kernel = setup();
    let hasTools: boolean | undefined;
    kernel.registerDecorator({
      id: "demo_peek",
      onError: "closed",
      fn: async (ctx, _run, next) => {
        // @ts-expect-error 装饰器里写 ctx.tools 编译不过
        ctx.tools;
        hasTools = "tools" in ctx;
        return next();
      },
    });
    kernel.register({ name: "demo_agent", input: z.null(), decorators: ["demo_peek"], impl: async () => null });
    await kernel.reap(kernel.start("demo_agent", null));

    expect(hasTools).toBe(false);
  });

  test("公开的 Operation 没写 usage、或入参转不成 JSON Schema：注册时就报错", () => {
    const kernel = new Kernel();
    const noop = async () => null;

    expect(() => kernel.register({ name: "demo_a", public: true, input: z.null(), impl: noop })).toThrow(
      "public operation needs usage: demo_a",
    );
    expect(() =>
      kernel.register({ name: "demo_b", usage: "b", public: true, input: z.object({ at: z.date() }), impl: noop }),
    ).toThrow("Date cannot be represented in JSON Schema");
  });
});
