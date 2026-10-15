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
import { Kernel, loadPlugin, type ToolSpec } from "stdlib";
import { models } from "./models";

const faux = fauxProvider();
let sent: TranscriptContext | undefined;
let run: (input: unknown) => ReturnType<Kernel["reap"]>;
let compact: (input: unknown) => ReturnType<Kernel["reap"]>;

beforeAll(async () => {
  models.setProvider(faux.provider);
  const kernel = new Kernel();
  await loadPlugin(kernel, import.meta.dir, { model: `${faux.provider.id}/${faux.getModel().id}` });
  await kernel.boot();
  run = (input) => kernel.reap(kernel.start("model_complete", input));
  compact = (input) => kernel.reap(kernel.start("model_compact", input));
});

beforeEach(() => {
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

  test("配置的模型不存在：装载失败", async () => {
    await expect(loadPlugin(new Kernel(), import.meta.dir, { model: "nope/x" })).rejects.toThrow("unknown model: nope/x");
  });
});

describe("model_compact", () => {
  /** 三轮历史：读 a.md（工具调用与结果）→ 问 b.md → 让它总结 */
  const toolCall = fauxAssistantMessage([fauxToolCall("fs_read", { path: "a.md" }, { id: "call-1" })], { stopReason: "toolUse" });
  const history: Message[] = [
    ask("读 a.md"),
    toolCall,
    { role: "toolResult", toolCallId: "call-1", toolName: "fs_read", content: [{ type: "text", text: "你好" }], isError: false, timestamp: 0 },
    fauxAssistantMessage([fauxText("a.md 写着你好")]),
    ask("b.md 呢？"),
    fauxAssistantMessage([fauxText("b.md 是空的")]),
    ask("总结一下"),
    fauxAssistantMessage([fauxText("读过 a.md 与 b.md")]),
  ];

  test("没超过阈值：原样返回，不调模型", async () => {
    faux.setResponses([]);

    expect(await compact({ history, over: 10_000 })).toEqual({ ok: true, value: { history, compacted: false } });
  });

  test("超过阈值：最近 keep 轮原样保留，更早的由模型写成摘要，并进保留的第一条用户消息", async () => {
    faux.setResponses([replyWith(fauxAssistantMessage([fauxText("- 读过 a.md，内容是你好\n- b.md 是空的")]))]);

    const result = await compact({ history, over: 10, keep: 1 });
    expect(result).toEqual({
      ok: true,
      value: {
        compacted: true,
        history: [
          { ...history[6], content: "[之前对话的摘要]\n- 读过 a.md，内容是你好\n- b.md 是空的\n\n[接着对话]\n总结一下" },
          history[7],
        ],
      },
    });
    // 交给模型的是要压的那两轮写成的纯文本记录，不带工具定义；保留的那一轮不在里面
    const record = sent?.messages.filter((m): m is Message => m.role !== "system");
    expect(record).toHaveLength(1);
    expect(record![0]!.content).toBe(
      ["用户：读 a.md", '助手调用 fs_read：{"path":"a.md"}', "fs_read 返回：你好", "助手：a.md 写着你好", "用户：b.md 呢？", "助手：b.md 是空的"].join("\n\n"),
    );
    expect(sent?.messages.find((m): m is SystemMessage => m.role === "system")?.toolsAdded ?? []).toEqual([]);
  });

  test("轮数不超过 keep：超过阈值也没有可压的，原样返回", async () => {
    faux.setResponses([]);

    expect(await compact({ history, over: 1, keep: 3 })).toMatchObject({ ok: true, value: { compacted: false } });
  });

  test("写摘要时模型出错：以 model_compact 的拒绝返回", async () => {
    faux.setResponses([]);

    expect(await compact({ history, over: 1, keep: 1 })).toMatchObject({ ok: false, by: "model_compact" });
  });
});
