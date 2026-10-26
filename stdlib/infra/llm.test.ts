import { describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxProvider, fauxText, type TranscriptContext } from "@earendil-works/pi-ai";
import { piLlm } from "./llm";

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

  test("模型不存在：建的时候就失败（装配即失败）", () => {
    const faux = fauxProvider();
    expect(() => piLlm({ model: "nope/x", providers: [faux.provider] })).toThrow("unknown model: nope/x");
  });
});
