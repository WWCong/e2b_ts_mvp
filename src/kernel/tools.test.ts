import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Kernel } from "./kernel";
import type { ToolSpec } from "./run";

function setup() {
  const kernel = new Kernel();
  const noop = async () => null;
  kernel.register({ name: "fs.write", usage: "写文件", public: true, input: z.object({ path: z.string() }), impl: noop });
  kernel.register({
    name: "fs.list",
    usage: "列目录",
    public: true,
    input: z.object({ path: z.string().describe("目录").default(".") }),
    impl: noop,
  });
  kernel.register({ name: "fs.secret", input: z.null(), impl: noop });
  kernel.register({ name: "web.search", usage: "搜索", public: true, input: z.object({ q: z.string() }), impl: noop });
  return kernel;
}

describe("ctx.tools()", () => {
  test("列出能力面里的公开 Operation，按名字排序；入参 schema 按调用方要填的形状生成", async () => {
    const kernel = setup();
    let tools: ToolSpec[] = [];
    kernel.register({
      name: "demo.agent",
      input: z.null(),
      only: ["fs"],
      impl: async (ctx) => {
        tools = ctx.tools();
      },
    });
    await kernel.reap(kernel.start("demo.agent", null));

    // fs.secret 不公开，web.search 不在能力面
    expect(tools.map((t) => t.name)).toEqual(["fs.list", "fs.write"]);
    expect(tools[0]).toEqual({
      name: "fs.list",
      description: "列目录",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { path: { type: "string", description: "目录", default: "." } },
      },
    });
  });

  test("装饰器拿到的 ctx.tools() 为空", async () => {
    const kernel = setup();
    let tools: ToolSpec[] | undefined;
    kernel.registerDecorator({
      id: "demo.peek",
      onError: "closed",
      fn: async (ctx, _run, next) => {
        tools = ctx.tools();
        return next();
      },
    });
    kernel.register({ name: "demo.agent", input: z.null(), decorators: ["demo.peek"], impl: async () => null });
    await kernel.reap(kernel.start("demo.agent", null));

    expect(tools).toEqual([]);
  });

  test("公开的 Operation 没写 usage、或入参转不成 JSON Schema：注册时就报错", () => {
    const kernel = new Kernel();
    const noop = async () => null;

    expect(() => kernel.register({ name: "demo.a", public: true, input: z.null(), impl: noop })).toThrow(
      "public operation needs usage: demo.a",
    );
    expect(() =>
      kernel.register({ name: "demo.b", usage: "b", public: true, input: z.object({ at: z.date() }), impl: noop }),
    ).toThrow("Date cannot be represented in JSON Schema");
  });
});
