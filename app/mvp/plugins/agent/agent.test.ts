import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { cpSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
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
import { Kernel, loadPlugin, type HarnessEvent } from "stdlib";
import { models } from "../model/models";
import type { Answer } from "../ui";

const faux = fauxProvider();
let kernel: Kernel;
let events: HarnessEvent[];
let workspace: string;
/** 每次发给模型的请求 */
let requests: TranscriptContext[];
/** 人依次给出的回答：每开一个 park 取一个 */
let answers: Answer[];

beforeAll(() => {
  models.setProvider(faux.provider);
});

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "agent-"));
  requests = [];
  answers = [];
  ({ kernel, events } = await boot());
});

/**
 * 与入口相同的装配：fs 的工作区是 workspace，model 用 faux 模型。
 * 每开一个 park，人从 answers 里取一个回答；没有了就不答，park 一直等着
 */
async function boot(journalDir?: string) {
  const k = new Kernel({ journalDir });
  const log: HarnessEvent[] = [];
  k.events.subscribe((e) => log.push(e));
  k.events.subscribe((e) => {
    if (e.type === "park.opened" && answers.length > 0) queueMicrotask(() => k.unpark(e.runId, answers.shift()));
  });
  const config: Record<string, unknown> = {
    fs: { workspace },
    model: { model: `${faux.provider.id}/${faux.getModel().id}` },
  };
  for (const pkg of ["harness", "time"]) await loadPlugin(k, `stdlib/plugins/${pkg}`);
  for (const pkg of ["fs", "model", "ui", "agent"]) await loadPlugin(k, join(import.meta.dir, "..", pkg), config[pkg]);
  const roots = await k.boot();
  return { kernel: k, events: log, roots };
}

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
  test("读文件 → 写文件（人批准）→ 回答：工具结果回给模型，每次调用都是 agent_assist 的子 Run", async () => {
    await writeFile(join(workspace, "notes.md"), "明天下午三点开会");
    answers = [{ option: "yes" }];
    faux.setResponses([
      step(fauxToolCall("fs_read", { path: "notes.md" })),
      step(fauxToolCall("fs_write", { path: "summary.md", content: "三点开会" })),
      step(fauxText("已写入 summary.md")),
    ]);

    expect(await assist("总结 notes.md 写到 summary.md")).toEqual({ ok: true, value: { answer: "已写入 summary.md" } });
    expect(await readFile(join(workspace, "summary.md"), "utf8")).toBe("三点开会");

    // 交给模型的工具：能力面里 fs 与 ui 的公开 Operation
    const tools = requests[0]!.messages.find((m) => m.role === "system")?.toolsAdded?.map((t) => t.name);
    expect(tools).toEqual(["fs_list", "fs_read", "fs_write", "ui_ask"]);
    expect(toolResultsIn(1)).toEqual([{ name: "fs_read", isError: false, text: "明天下午三点开会" }]);

    const [root, ...children] = events.filter((e) => e.type === "run.started");
    expect(root).toMatchObject({ operation: "agent_assist", depth: 0 });
    const write = children.find((e) => e.operation === "fs_write")!;
    expect(children.map((e) => [e.operation, e.parent])).toEqual([
      // 消息的时间戳经 time_now 取：用户消息一次，每轮工具结果一次
      ["time_now", root!.runId],
      ["model_complete", root!.runId],
      ["fs_read", root!.runId],
      ["time_now", root!.runId],
      ["model_complete", root!.runId],
      ["fs_write", root!.runId],
      // 审批装饰器的调用记在 fs_write 名下
      ["harness_park", write.runId],
      ["time_now", root!.runId],
      ["model_complete", root!.runId],
    ]);
  });

  test("人不批准写文件：拒绝作为出错的工具结果交给模型，文件不写", async () => {
    answers = [{ option: "no" }];
    faux.setResponses([
      step(fauxToolCall("fs_write", { path: "a.md", content: "x" })),
      step(fauxText("你没有批准，所以没写")),
    ]);

    expect(await assist("写 a.md")).toEqual({ ok: true, value: { answer: "你没有批准，所以没写" } });
    expect(toolResultsIn(1)).toEqual([
      {
        name: "fs_write",
        isError: true,
        text: JSON.stringify({ rejectedBy: "ui_approval", reason: "用户拒绝了这次调用", retryable: false }),
      },
    ]);
    expect(await readdir(workspace)).toEqual([]);
  });

  test("模型用 ui_ask 问人：选项与补充说明作为工具结果交给模型", async () => {
    answers = [{ option: "txt", text: "标题用日期" }];
    faux.setResponses([
      step(fauxToolCall("ui_ask", { question: "用哪种格式？", options: ["md", "txt"] })),
      step(fauxText("好的，用 txt")),
    ]);

    expect(await assist("写个笔记")).toEqual({ ok: true, value: { answer: "好的，用 txt" } });
    expect(toolResultsIn(1)).toEqual([{ name: "ui_ask", isError: false, text: '{"option":"txt","text":"标题用日期"}' }]);
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

describe("崩溃恢复", () => {
  const opened = (log: HarnessEvent[]) => log.filter((e) => e.type === "park.opened").map((e) => e.runId);

  test("问人时进程没了：恢复后不重复调模型，问题用原 id 重新开出，回答后接着跑完", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-journal-"));
    faux.setResponses([
      step(fauxToolCall("ui_ask", { question: "用哪种格式？", options: ["md", "txt"] })),
      step(fauxText("好的，用 txt")),
    ]);
    const one = await boot(dir);
    const root = one.kernel.start("agent_assist", { prompt: "写个笔记" });
    await Bun.sleep(5);
    expect(opened(one.events)).toHaveLength(1);

    // 「崩溃」：把此刻的日志拷一份，新内核启动时从拷贝恢复
    const copy = `${dir}-crash`;
    cpSync(dir, copy, { recursive: true });
    const two = await boot(copy);
    expect(two.roots).toEqual([root]);
    await Bun.sleep(5);
    expect(opened(two.events)).toEqual(opened(one.events));

    two.kernel.unpark(opened(two.events)[0]!, { option: "txt" });
    expect(await two.kernel.reap(root)).toEqual({ ok: true, value: { answer: "好的，用 txt" } });
    // 第一轮的模型调用从日志回放，没有再发请求：两次请求分别来自崩溃前与恢复后
    expect(requests).toHaveLength(2);
    expect(toolResultsIn(1)).toEqual([{ name: "ui_ask", isError: false, text: '{"option":"txt"}' }]);
  });
});
