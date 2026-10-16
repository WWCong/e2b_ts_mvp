import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Kernel, loadPlugin, op, type HarnessEvent } from "stdlib";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "chat-"));
  file = join(dir, "state", "conversation.json");
});

/**
 * 假的 agent：回答「答：这句」，历史追加这一问一答；「坏」就失败，「等等」先 park 等外部的值。
 * prompts 记下每次收到的这一句与带来的历史条数
 */
async function setup(journalDir?: string) {
  const kernel = new Kernel({ journalDir });
  const events: HarnessEvent[] = [];
  kernel.events.subscribe((e) => events.push(e));
  const prompts: [string, number][] = [];
  kernel.use("agent", {
    operations: {
      assist: op({
        input: z.object({ prompt: z.string(), history: z.array(z.any()).default([]) }),
        impl: async (ctx, { prompt, history }) => {
          prompts.push([prompt, history.length]);
          if (prompt === "坏") throw new Error("模型挂了");
          if (prompt === "等等") await ctx.park({ schema: z.toJSONSchema(z.string()), payload: "等什么？" });
          const answer = `答：${prompt}`;
          return { answer, history: [...history, { role: "user", content: prompt }, { role: "assistant", content: answer }] };
        },
      }),
    },
  });
  await loadPlugin(kernel, import.meta.dir, { file });
  const roots = await kernel.boot();
  const run = (name: string, input: unknown) => kernel.reap(kernel.submit(name, input));
  const saved = () => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { history: unknown[] }).history : undefined);
  return { kernel, events, prompts, roots, run, saved };
}

describe("chat 插件", () => {
  test("说两句：每轮带上之前的历史交给 agent，更新后的历史存进文件，返回回答；开场白报出有多少条", async () => {
    const { prompts, run, saved } = await setup();
    expect(await run("chat_greet", {})).toEqual({ ok: true, value: "" });

    expect(await run("chat_say", { text: "你好" })).toEqual({ ok: true, value: "答：你好" });
    expect(await run("chat_say", { text: "再见" })).toEqual({ ok: true, value: "答：再见" });
    expect(prompts).toEqual([
      ["你好", 0],
      ["再见", 2],
    ]);
    expect(saved()).toHaveLength(4);
    expect(await run("chat_greet", {})).toEqual({ ok: true, value: "接着之前的对话（4 条消息）；/new 开始新对话" });
  });

  test("一轮三步都是子调用：读历史、agent、存历史", async () => {
    const { events, run } = await setup();
    await run("chat_say", { text: "你好" });

    expect(events.filter((e) => e.type === "run.started").map((e) => [e.operation, e.depth])).toEqual([
      ["chat_say", 0],
      ["chat_load", 1],
      ["agent_assist", 1],
      ["chat_save", 1],
    ]);
  });

  test("失败的一轮不存：历史不变，原因带上是谁拒的", async () => {
    const { run, saved } = await setup();
    await run("chat_say", { text: "你好" });

    expect(await run("chat_say", { text: "坏" })).toEqual({
      ok: false,
      by: "chat_say",
      reason: "agent_assist: 模型挂了",
      retryable: false,
    });
    expect(saved()).toHaveLength(2);
  });

  test("reset：清空历史", async () => {
    const { run, saved } = await setup();
    await run("chat_say", { text: "你好" });

    expect(await run("chat_reset", {})).toEqual({ ok: true, value: "已开始新对话" });
    expect(saved()).toEqual([]);
    expect(await run("chat_greet", {})).toEqual({ ok: true, value: "" });
  });

  test("停在半路：重启后接着做完这一轮并存下，已读过的历史不再读", async () => {
    const journal = join(dir, "journal");
    const one = await setup(journal);
    one.kernel.submit("chat_say", { text: "等等" });
    while (!one.events.some((e) => e.type === "park.opened")) await Bun.sleep(1);
    await one.kernel.stop(1000);
    expect(one.saved()).toBeUndefined();

    const two = await setup(journal);
    const park = () => two.events.find((e) => e.type === "park.opened");
    while (!park()) await Bun.sleep(1);
    two.kernel.unpark(park()!.runId, "好了");
    expect(await two.kernel.reap(two.roots[0]!)).toEqual({ ok: true, value: "答：等等" });
    expect(two.saved()).toHaveLength(2);
    expect(two.events.filter((e) => e.type === "run.started").map((e) => e.operation)).toEqual(["chat_say", "agent_assist", "chat_save"]);
  });
});
