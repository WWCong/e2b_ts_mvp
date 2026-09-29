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
import { Kernel } from "../../../src/kernel/kernel";
import { loadPlugin } from "../../../src/kernel/loader";
import type { ToolSpec } from "../../../src/kernel/run";
import { models } from "./models";

const faux = fauxProvider();
let sent: TranscriptContext | undefined;
let run: (input: unknown) => ReturnType<Kernel["reap"]>;

beforeAll(async () => {
  models.setProvider(faux.provider);
  const kernel = new Kernel();
  await loadPlugin(kernel, import.meta.dir);
  run = (input) => kernel.reap(kernel.start("model_complete", input));
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

const readTool: ToolSpec = {
  name: "fs_read",
  description: "读文件",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { path: { type: "string" } },
  },
};

const ask = (content: string): Message => ({ role: "user", content, timestamp: 0 });

describe("model_complete", () => {
  test("工具以 Operation 名原样发出、去掉 $schema；模型的工具调用进 calls，answer 为 null", async () => {
    faux.setResponses([replyWith(fauxAssistantMessage([fauxToolCall("fs_read", { path: "a.md" })], { stopReason: "toolUse" }))]);

    const result = await run({ messages: [ask("读 a.md")], tools: [readTool] });

    const system = sent?.messages.find((m): m is SystemMessage => m.role === "system");
    expect(system?.toolsAdded).toEqual([
      { name: "fs_read", description: "读文件", parameters: { type: "object", properties: { path: { type: "string" } } } },
    ]);
    expect(result).toMatchObject({
      ok: true,
      value: { calls: [{ type: "toolCall", name: "fs_read", arguments: { path: "a.md" } }], answer: null },
    });
  });

  test("历史原样发出；没有工具调用时 answer 是回复文本", async () => {
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

    const result = await run({ messages: history, tools: [readTool] });

    expect(sent?.messages.filter((m): m is Message => m.role !== "system")).toEqual(history);
    expect(result).toMatchObject({ ok: true, value: { calls: [], answer: "a.md 里写着你好" } });
  });

  test("模型出错：以 model_complete 的拒绝返回", async () => {
    faux.setResponses([]);

    expect(await run({ messages: [ask("hi")] })).toMatchObject({
      ok: false,
      by: "model_complete",
      reason: "No more faux responses queued",
    });
  });

  test("MODEL 指向不存在的模型：以拒绝返回", async () => {
    process.env.MODEL = "nope/x";

    expect(await run({ messages: [] })).toMatchObject({ ok: false, reason: "unknown model: nope/x" });
  });
});
