import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { Kernel, loadPlugin, op, type HarnessEvent } from "stdlib";
import { render } from "./prompt";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "console-"));
});

const question = { question: "选哪个？", options: ["a", "b"] };

/**
 * demo_say：「问我」就经 ui_ask 问人，「坏」就失败，别的原样回显；demo_reset、demo_greet 只回一句话；
 * demo_secret 没声明 api。终端入口的输入是 lines（end 时随后结束），输出收进 printed
 */
async function setup(lines: string[], options: { journalDir?: string; end?: boolean; config?: Record<string, unknown> } = {}) {
  const kernel = new Kernel({ journalDir: options.journalDir });
  const events: HarnessEvent[] = [];
  kernel.events.subscribe((e) => events.push(e));
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
      secret: op({ input: z.object({ text: z.string() }), impl: async () => "不该被调到" }),
    },
  });
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = "";
  output.on("data", (chunk) => (printed += String(chunk)));
  const config = { say: "demo_say", commands: { new: "demo_reset" }, greet: "demo_greet", input, output, ...options.config };
  const serve = (await loadPlugin(kernel, import.meta.dir, config))!;
  await kernel.boot();
  for (const line of lines) input.write(`${line}\n`);
  if (options.end ?? true) input.end();
  const parked = async () => {
    while (!events.some((e) => e.type === "park.opened")) await Bun.sleep(1);
  };
  return { kernel, events, serve, printed: () => printed, parked };
}

describe("终端入口", () => {
  test("开场后连续对话：普通一行交给 say，/命令调对应的 Operation，问题在中途问人；/exit 结束服务", async () => {
    const { serve, printed } = await setup(["hi", "问我", "2", "/foo", "/new", "坏", "/exit", "不会读到"]);
    await serve();

    const prompt = "\n你> ";
    expect(printed()).toBe(
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

  test("第一句来自配置，先说它；输入结束即结束服务，等着的问题撤回", async () => {
    const { serve, printed } = await setup(["问我"], { config: { first: "hi", greet: undefined } });
    await serve();

    expect(printed()).toBe(["\necho: hi\n", "\n你> ", render(question), "\n失败（demo_say）：输入已结束\n", "\n你> "].join(""));
  });

  test("say 不是 api 的：说不出去，显示原因", async () => {
    const { serve, printed } = await setup(["hi"], { config: { say: "demo_secret", greet: undefined } });
    await serve();

    expect(printed()).toContain("\n失败：not an api operation: demo_secret\n");
  });

  test("关停时停在问题上：提示进度已保存；重启后先接着做完上次那一轮（问题再问一次），再进入对话", async () => {
    const one = await setup(["问我"], { journalDir: dir, end: false });
    const served = one.serve();
    await one.parked();
    await one.kernel.stop(1000);
    await served;
    expect(one.printed()).toEndWith(`${render(question)}\n已停下，进度已保存；再启动接着做\n`);

    const two = await setup(["1"], { journalDir: dir });
    await two.serve();
    expect(two.printed()).toBe(["\n你好\n", render(question), "\n选了 a\n", "\n你> "].join(""));
  });
});
