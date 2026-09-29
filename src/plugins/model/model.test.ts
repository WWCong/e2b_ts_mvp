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

const readTool: ToolSpec = {
  name: "fs.read",
  description: "读文件",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { path: { type: "string" } },
  },
};

describe("model.complete", () => {
  test("工具名发出前转成 fs__read、去掉 $schema；模型的工具调用转回 fs.read", async () => {
    faux.setResponses([replyWith(fauxAssistantMessage([fauxToolCall("fs__read", { path: "a.md" })], { stopReason: "toolUse" }))]);

    const result = await run({ messages: [{ role: "user", content: "读 a.md", timestamp: 0 }], tools: [readTool] });

    const system = sent?.messages.find((m): m is SystemMessage => m.role === "system");
    expect(system?.toolsAdded).toEqual([
      { name: "fs__read", description: "读文件", parameters: { type: "object", properties: { path: { type: "string" } } } },
    ]);
    expect(result).toMatchObject({
      ok: true,
      value: { calls: [{ type: "toolCall", name: "fs.read", arguments: { path: "a.md" } }], answer: null },
    });
  });

  test("历史里的工具名同样转写；没有工具调用时 answer 是回复文本", async () => {
    faux.setResponses([replyWith(fauxAssistantMessage([fauxText("a.md 里写着你好")]))]);
    const history: Message[] = [
      { role: "user", content: "读 a.md", timestamp: 0 },
      fauxAssistantMessage([fauxToolCall("fs.read", { path: "a.md" }, { id: "call-1" })], { stopReason: "toolUse" }),
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "fs.read",
        content: [{ type: "text", text: "你好" }],
        isError: false,
        timestamp: 0,
      },
    ];

    const result = await run({ messages: history, tools: [readTool] });

    const names = sent?.messages.flatMap((m) =>
      m.role === "assistant" ? m.content.flatMap((b) => (b.type === "toolCall" ? [b.name] : [])) : m.role === "toolResult" ? [m.toolName] : [],
    );
    expect(names).toEqual(["fs__read", "fs__read"]);
    expect(result).toMatchObject({ ok: true, value: { calls: [], answer: "a.md 里写着你好" } });
  });

  test("模型出错：以 model.complete 的拒绝返回", async () => {
    faux.setResponses([]);

    expect(await run({ messages: [{ role: "user", content: "hi", timestamp: 0 }] })).toMatchObject({
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
