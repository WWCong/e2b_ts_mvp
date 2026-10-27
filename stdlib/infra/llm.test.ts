import { describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxProvider, fauxText, type TranscriptContext } from "@earendil-works/pi-ai";
import { NO_VISION, piLlm } from "./llm";

describe("piLlm", () => {
  test("按「provider/模型 id」找模型，complete 把请求交给它", async () => {
    const faux = fauxProvider();
    let sent: TranscriptContext | undefined;
    faux.setResponses([
      (context) => {
        sent = context;
        return fauxAssistantMessage([fauxText("你好")]);
      },
    ]);
    const llm = piLlm({ model: `${faux.provider.id}/${faux.getModel().id}`, providers: [faux.provider] });

    const reply = await llm.complete({ systemPrompt: "简短", messages: [{ role: "user", content: "hi", timestamp: 1 }] });
    expect(reply.content).toEqual([{ type: "text", text: "你好" }]);
    expect(sent?.messages.filter((m) => m.role === "user")).toMatchObject([{ content: "hi" }]);
    expect(llm.name).toBe(`${faux.provider.id}/${faux.getModel().id}`);
  });

  test("模型看不了图：用户消息与工具结果里的图片换成占位文字，连着的几张只留一句；看得了图的原样交过去", async () => {
    const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
    const context = {
      messages: [
        { role: "user" as const, content: [{ type: "text" as const, text: "看图" }, image, image], timestamp: 1 },
        { role: "toolResult" as const, toolCallId: "1", toolName: "fs_read", content: [image], isError: false, timestamp: 2 },
      ],
    };
    const sent: TranscriptContext[] = [];
    const reply = (c: TranscriptContext) => (sent.push(c), fauxAssistantMessage([fauxText("好")]));
    const blind = fauxProvider({ provider: "blind", models: [{ id: "text", input: ["text"] }] });
    const seeing = fauxProvider({ provider: "seeing", models: [{ id: "vision", input: ["text", "image"] }] });
    blind.setResponses([reply]);
    seeing.setResponses([reply]);

    await piLlm({ model: "blind/text", providers: [blind.provider] }).complete(context);
    await piLlm({ model: "seeing/vision", providers: [seeing.provider] }).complete(context);
    const [toBlind, toSeeing] = sent.map((c) => c.messages.filter((m) => m.role !== "system").map((m) => (m as { content: unknown }).content));
    expect(toBlind).toEqual([[{ type: "text", text: "看图" }, { type: "text", text: NO_VISION }], [{ type: "text", text: NO_VISION }]]);
    expect(toSeeing).toEqual([[{ type: "text", text: "看图" }, image, image], [image]]);
  });

  test("模型不存在：建的时候就失败（装配即失败）", () => {
    const faux = fauxProvider();
    expect(() => piLlm({ model: "nope/x", providers: [faux.provider] })).toThrow("unknown model: nope/x");
  });
});
