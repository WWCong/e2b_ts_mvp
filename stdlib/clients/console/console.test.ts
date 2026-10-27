import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { Kernel } from "../../kernel/kernel";
import { loadPlugin } from "../../kernel/loader";
import { op } from "../../kernel/plugin";
import { httpService } from "../../serve/http";
import type { Service } from "../../serve/service";
import { httpClient } from "../http";
import { render } from "./prompt";
import { runConsole, type ConsoleConfig } from ".";

const services: Service[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.stop(true);
});

const question = { question: "选哪个？", options: ["a", "b"] };

/**
 * Harness：demo_say 「问我」就经 ui_ask 问人，「坏」就失败，别的原样回显；demo_reset、demo_greet 只回一句话——
 * 这几个对外；demo_secret 没对外。终端客户端经 socket 连上它
 */
async function harness() {
  const socket = join(await mkdtemp(join(tmpdir(), "console-")), "h.sock");
  const kernel = new Kernel();
  await loadPlugin(kernel, "stdlib/plugins/harness");
  await loadPlugin(kernel, "stdlib/plugins/ui");
  kernel.use("demo", {
    operations: {
      say: op({
        api: true,
        usage: "说一句",
        input: z.object({ text: z.string() }),
        output: z.string(),
        impl: async (ctx, { text }) => {
          if (text === "坏") throw new Error("坏了");
          if (text !== "问我") return `echo: ${text}`;
          const r = await ctx.ops.ui.ask(question);
          if (!r.ok) throw new Error(r.reason);
          return `选了 ${r.value.option}`;
        },
      }),
      reset: op({ api: true, usage: "清空", input: z.object({}), output: z.string(), impl: async () => "清空了" }),
      greet: op({ api: true, usage: "开场", input: z.object({}), output: z.string(), impl: async () => "你好" }),
      secret: op({ api: true, usage: "没对外", input: z.object({ text: z.string() }), output: z.string(), impl: async () => "x" }),
    },
  });
  const service = await httpService({ socket, expose: ["demo_say", "demo_reset", "demo_greet"] });
  services.push(service);
  await kernel.boot();
  service.listen({ outside: (origin) => kernel.outside(origin), subscribe: (fn) => kernel.events.subscribe(fn) });
  return { kernel, socket, client: httpClient({ socket, name: "console" }) };
}

/** 开一个终端客户端：输入是 lines（end 时随后结束），输出收进 printed；不画 Run 树，输出好比对 */
function open(socket: string, lines: string[], config: Partial<ConsoleConfig> = {}, end = true) {
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = "";
  output.on("data", (chunk) => (printed += String(chunk)));
  for (const line of lines) input.write(`${line}\n`);
  if (end) input.end();
  const client = httpClient({ socket, name: "console" });
  const done = runConsole({ client, say: "demo_say", commands: { new: "demo_reset" }, greet: "demo_greet", tree: false, input, output, ...config });
  return { done, printed: () => printed, input };
}

describe("终端客户端", () => {
  test("开场后连续对话：普通一行交给 say，/命令调对应的 Operation，问题在中途问人；/exit 退出", async () => {
    const { socket } = await harness();
    const session = open(socket, ["hi", "问我", "2", "/foo", "/new", "坏", "/exit", "不会读到"]);

    expect(await session.done).toEqual({ pending: false });
    const prompt = "\n你> ";
    expect(session.printed()).toBe(
      [
        "\n你好\n",
        prompt,
        "\necho: hi\n",
        prompt,
        render(question),
        "\n选了 b\n",
        // 不认得的命令当普通一行
        prompt,
        "\necho: /foo\n",
        prompt,
        "\n清空了\n",
        prompt,
        "\n失败（demo_say）：坏了\n",
        prompt,
      ].join(""),
    );
  });

  test("say 没对外：调不起来，显示原因", async () => {
    const { socket } = await harness();
    const session = open(socket, ["hi"], { say: "demo_secret", greet: undefined });
    await session.done;

    expect(session.printed()).toContain("\n失败：not exposed: demo_secret\n");
  });

  test("问题等着时输入结束：客户端退出，那一轮在服务端照常等着；再连上时先问那个问题，再拿到那一轮的结果", async () => {
    const { socket, client } = await harness();
    const one = open(socket, ["问我"]);
    expect(await one.done).toEqual({ pending: true });
    expect(one.printed()).toEndWith(render(question));
    expect(await client.parks()).toHaveLength(1);
    expect((await client.runs()).map((r) => [r.operation, r.origin, r.done])).toEqual([["demo_say", "http:console", false]]);

    const two = open(socket, ["1"]);
    expect(await two.done).toEqual({ pending: false });
    expect(two.printed()).toBe(["\n你好\n", "\n接着等上次没做完的 demo_say…\n", render(question), "\n选了 a\n", "\n你> "].join(""));
    expect(await client.runs()).toEqual([]);
  });

  test("Harness 停下：事件流断开，客户端退出，在等的那一轮算 pending", async () => {
    const { socket, kernel } = await harness();
    const session = open(socket, ["问我"], {}, false);
    while (!session.printed().includes("选哪个")) await Bun.sleep(5);

    await kernel.stop(1000);
    services.splice(0).forEach((s) => s.stop(true));
    expect(await session.done).toEqual({ pending: true });
    expect(session.printed()).toContain("Harness 断开了");
  });

  test("画 Run 树：事件流按树缩进，摘要用应用给的规则", async () => {
    const { socket } = await harness();
    const session = open(socket, ["hi"], {
      greet: undefined,
      tree: true,
      brief: (operation, side, value) => (operation === "demo_say" && side === "input" ? `说：${(value as { text: string }).text}` : undefined),
    });
    await session.done;

    expect(session.printed()).toContain("▶ demo_say 说：hi\n✓ demo_say → echo: hi\n");
  });
});
