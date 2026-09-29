import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Message,
  type SystemMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Kernel } from "../../kernel/kernel";
import { loadPlugin } from "../../kernel/loader";
import type { ToolSpec } from "../../kernel/run";
import { models } from "./models";

const faux = fauxProvider();
let sent: TranscriptContext | undefined;
let run: (input: unknown) => ReturnType<Kernel["reap"]>;

beforeAll(async () => {
  models.setProvider(faux.provider);
  const kernel = new Kernel();
  await loadPlugin(kernel, import.meta.dir);
  run = (input) => kernel.reap(kernel.start("model.complete", input));
});

beforeEach(() => {
  process.env.MODEL = `${faux.provider.id}/${faux.getModel().id}`;
  sent = undefined;
});

/** 剧本的一步：记下发给模型的请求，再给出预设的回复 */
const replyWith = (reply: ReturnType<typeof fauxAssistantMessage>) => (context: TranscriptContext) => {
  sent = context;
  return reply;
};

const tool = (name: string): ToolSpec => ({
  name,
  description: "读文件",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { path: { type: "string" } },
  },
});

const ask = (content: string): Message => ({ role: "user", content, timestamp: 0 });

describe("model.complete", () => {
  test("工具名发出时 fs.read → fs_read、去掉 $schema；工具调用按本轮的表查回 Operation 名", async () => {
    faux.setResponses([
      replyWith(
        fauxAssistantMessage([fauxToolCall("fs_read", { path: "a.md" }), fauxToolCall("fs_delete", {})], {
          stopReason: "toolUse",
        }),
      ),
    ]);

    const result = await run({ messages: [ask("读 a.md")], tools: [tool("fs.read")] });

    const system = sent?.messages.find((m): m is SystemMessage => m.role === "system");
    expect(system?.toolsAdded).toEqual([
      { name: "fs_read", description: "读文件", parameters: { type: "object", properties: { path: { type: "string" } } } },
    ]);
    // fs_delete 不在本轮的工具列表里，查不回 Operation 名
    expect(result).toMatchObject({
      ok: true,
      value: {
        calls: [
          { name: "fs_read", operation: "fs.read", arguments: { path: "a.md" } },
          { name: "fs_delete", operation: undefined },
        ],
        answer: null,
      },
    });
  });

  test("历史原样发出，不改写；没有工具调用时 answer 是回复文本", async () => {
    faux.setResponses([replyWith(fauxAssistantMessage([fauxText("a.md 里写着你好")]))]);
    const history: Message[] = [
      ask("读 a.md"),
      fauxAssistantMessage([fauxToolCall("fs_read", { path: "a.md" }, { id: "call-1" })], { stopReason: "toolUse" }),
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "fs_read",
        content: [{ type: "text", text: "你好" }],
        isError: false,
        timestamp: 0,
      },
    ];

    const result = await run({ messages: history, tools: [tool("fs.read")] });

    expect(sent?.messages.filter((m): m is Message => m.role !== "system")).toEqual(history);
    expect(result).toMatchObject({ ok: true, value: { calls: [], answer: "a.md 里写着你好" } });
  });

  test("两个 Operation 转成同一个工具名：以拒绝返回，不发请求", async () => {
    faux.setResponses([replyWith(fauxAssistantMessage([fauxText("不该走到这里")]))]);

    expect(await run({ messages: [ask("hi")], tools: [tool("a.b_c"), tool("a_b.c")] })).toMatchObject({
      ok: false,
      by: "model.complete",
      reason: "tool name collision: a.b_c and a_b.c are both a_b_c",
    });
    expect(sent).toBeUndefined();
  });

  test("模型出错：以 model.complete 的拒绝返回", async () => {
    faux.setResponses([]);

    expect(await run({ messages: [ask("hi")] })).toMatchObject({
      ok: false,
      by: "model.complete",
      reason: "No more faux responses queued",
    });
  });

  test("MODEL 指向不存在的模型：以拒绝返回", async () => {
    process.env.MODEL = "nope/x";

    expect(await run({ messages: [] })).toMatchObject({ ok: false, reason: "unknown model: nope/x" });
  });
});
