import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type ToolResultMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { HarnessEvent } from "../../kernel/events";
import { Kernel } from "../../kernel/kernel";
import { loadPlugin } from "../../kernel/loader";
import { models } from "../model/models";

const faux = fauxProvider();
let kernel: Kernel;
let events: HarnessEvent[];
let workspace: string;
/** 每次发给模型的请求 */
let requests: TranscriptContext[];

beforeAll(async () => {
  models.setProvider(faux.provider);
  kernel = new Kernel();
  kernel.events.subscribe((e) => events.push(e));
  for (const pkg of ["fs", "model", "agent"]) await loadPlugin(kernel, join(import.meta.dir, "..", pkg));
});

beforeEach(async () => {
  process.env.MODEL = `${faux.provider.id}/${faux.getModel().id}`;
  workspace = await mkdtemp(join(tmpdir(), "agent-"));
  process.env.WORKSPACE_DIR = workspace;
  events = [];
  requests = [];
});

/** 剧本的一步：记下这次请求，再给出预设的回复 */
const step =
  (...content: AssistantMessage["content"]) =>
  (context: TranscriptContext) => {
    requests.push(context);
    const toolUse = content.some((b) => b.type === "toolCall");
    return fauxAssistantMessage(content, toolUse ? { stopReason: "toolUse" } : undefined);
  };

const assist = (prompt: string) => kernel.reap(kernel.start("agent_assist", { prompt }));

/** 某次请求里发给模型的工具结果 */
const toolResultsIn = (i: number) =>
  requests[i]!.messages.filter((m): m is ToolResultMessage => m.role === "toolResult").map((m) => ({
    name: m.toolName,
    isError: m.isError,
    text: m.content[0]?.type === "text" ? m.content[0].text : "",
  }));

describe("agent_assist", () => {
  test("读文件 → 写文件 → 回答：工具结果回给模型，每次调用都是 agent_assist 的子 Run", async () => {
    await writeFile(join(workspace, "notes.md"), "明天下午三点开会");
    faux.setResponses([
      step(fauxToolCall("fs_read", { path: "notes.md" })),
      step(fauxToolCall("fs_write", { path: "summary.md", content: "三点开会" })),
      step(fauxText("已写入 summary.md")),
    ]);

    expect(await assist("总结 notes.md 写到 summary.md")).toEqual({ ok: true, value: { answer: "已写入 summary.md" } });
    expect(await readFile(join(workspace, "summary.md"), "utf8")).toBe("三点开会");

    // 交给模型的工具只有 fs 的公开原语
    const tools = requests[0]!.messages.find((m) => m.role === "system")?.toolsAdded?.map((t) => t.name);
    expect(tools).toEqual(["fs_list", "fs_read", "fs_write"]);
    expect(toolResultsIn(1)).toEqual([{ name: "fs_read", isError: false, text: "明天下午三点开会" }]);

    const [root, ...children] = events.filter((e) => e.type === "run.started");
    expect(root).toMatchObject({ operation: "agent_assist", depth: 0 });
    expect(children.map((e) => [e.operation, e.parent])).toEqual([
      ["model_complete", root!.runId],
      ["fs_read", root!.runId],
      ["model_complete", root!.runId],
      ["fs_write", root!.runId],
      ["model_complete", root!.runId],
    ]);
  });

  test("被拒绝的调用作为出错的工具结果交给模型，由它改道", async () => {
    faux.setResponses([
      step(fauxToolCall("fs_read", { path: "../secret.md" }), fauxToolCall("web_search", { q: "x" })),
      step(fauxText("读不了工作区外的文件")),
    ]);

    expect(await assist("读 ../secret.md")).toEqual({ ok: true, value: { answer: "读不了工作区外的文件" } });
    expect(toolResultsIn(1)).toEqual([
      {
        name: "fs_read",
        isError: true,
        text: JSON.stringify({ rejectedBy: "fs_pathGuard", reason: "path escapes workspace: ../secret.md", retryable: true }),
      },
      {
        name: "web_search",
        isError: true,
        text: JSON.stringify({ rejectedBy: "kernel", reason: "web_search is not in the surface of agent_assist", retryable: false }),
      },
    ]);
  });

  test("模型出错：agent_assist 以拒绝退出", async () => {
    faux.setResponses([]);

    expect(await assist("hi")).toMatchObject({
      ok: false,
      by: "agent_assist",
      reason: "model_complete rejected by model_complete: No more faux responses queued",
    });
  });
});
