import { beforeEach, describe, expect, test } from "bun:test";
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
  type Message,
  type ToolResultMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Kernel, loadPlugin, loadScript, type HarnessEvent, type Infra } from "stdlib";
import { piLlm } from "stdlib/infra/llm";
import { localDir } from "stdlib/infra/volume";
import type { Answer } from "stdlib/plugins/ui";

const faux = fauxProvider();
let kernel: Kernel;
let events: HarnessEvent[];
let workspace: string;
/** 每次发给模型的请求 */
let requests: TranscriptContext[];
/** 人依次给出的回答：每开一个 park 取一个 */
let answers: Answer[];

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "agent-"));
  requests = [];
  answers = [];
  ({ kernel, events } = await boot());
});

/**
 * 与入口相同的装配：基建的工作区是 workspace，模型后端用 faux 模型。
 * 每开一个 park，人从 answers 里取一个回答；没有了就不答，park 一直等着
 */
async function boot(journalDir?: string) {
  const k = new Kernel({ journalDir });
  const log: HarnessEvent[] = [];
  k.events.subscribe((e) => log.push(e));
  k.events.subscribe((e) => {
    if (e.type === "park.opened" && answers.length > 0) queueMicrotask(() => k.unpark(e.runId, answers.shift()));
  });
  const infra: Infra = {
    llm: piLlm({ model: `${faux.provider.id}/${faux.getModel().id}`, providers: [faux.provider] }),
    workspace: localDir(workspace),
  };
  await infra.workspace!.open();
  for (const pkg of ["harness", "time", "ui"]) await loadPlugin(k, `stdlib/plugins/${pkg}`);
  for (const pkg of ["fs", "model"]) await loadPlugin(k, `stdlib/plugins/${pkg}`, {}, infra);
  await loadScript(k, import.meta.dir);
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

const assist = (prompt: string, history: Message[] = [], images: { mimeType: string; data: string }[] = []) =>
  kernel.reap(kernel.submit("agent_assist", { prompt, history, images }));

/** 1×1 的红点 PNG */
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** 某次请求里发给模型的对话消息（去掉系统消息） */
const messagesIn = (i: number) => requests[i]!.messages.filter((m): m is Message => m.role !== "system");

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

    expect(await assist("总结 notes.md 写到 summary.md")).toMatchObject({ ok: true, value: { answer: "已写入 summary.md" } });
    expect(await readFile(join(workspace, "summary.md"), "utf8")).toBe("三点开会");

    // 交给模型的工具：能力面里 fs、ui、harness_exec 的公开 Operation（这里没装 package 插件）
    const tools = requests[0]!.messages.find((m) => m.role === "system")?.toolsAdded?.map((t) => t.name);
    expect(tools).toEqual(["fs_edit", "fs_find", "fs_grep", "fs_list", "fs_read", "fs_write", "harness_exec", "ui_ask"]);
    expect(toolResultsIn(1)).toEqual([{ name: "fs_read", isError: false, text: "明天下午三点开会" }]);

    const [root, ...children] = events.filter((e) => e.type === "run.started");
    expect(root).toMatchObject({ operation: "agent_assist", depth: 0 });
    const write = children.find((e) => e.operation === "fs_write")!;
    expect(children.map((e) => [e.operation, e.parent])).toEqual([
      // 轮初检查一次要不要压缩历史；消息的时间戳经 time_now 取：用户消息一次，每轮工具结果一次
      ["model_compact", root!.runId],
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

    expect(await assist("写 a.md")).toMatchObject({ ok: true, value: { answer: "你没有批准，所以没写" } });
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

    expect(await assist("写个笔记")).toMatchObject({ ok: true, value: { answer: "好的，用 txt" } });
    expect(toolResultsIn(1)).toEqual([{ name: "ui_ask", isError: false, text: '{"option":"txt","text":"标题用日期"}' }]);
  });

  test("被拒绝的调用作为出错的工具结果交给模型，由它改道", async () => {
    faux.setResponses([
      step(fauxToolCall("fs_read", { path: "../secret.md" }), fauxToolCall("web_search", { q: "x" })),
      step(fauxText("读不了工作区外的文件")),
    ]);

    expect(await assist("读 ../secret.md")).toMatchObject({ ok: true, value: { answer: "读不了工作区外的文件" } });
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

describe("图片", () => {
  test("用户随这一句发来的图片与文字一起交给模型；fs_read 读到的图片原样放进工具结果", async () => {
    await writeFile(join(workspace, "pixel.png"), Buffer.from(PNG_1X1, "base64"));
    faux.setResponses([step(fauxToolCall("fs_read", { path: "pixel.png" }, { id: "call-1" })), step(fauxText("都是红点"))]);

    const result = await assist("这两张图里是什么？", [], [{ mimeType: "image/png", data: PNG_1X1 }]);
    expect(result).toMatchObject({ ok: true, value: { answer: "都是红点" } });
    const asked = messagesIn(0).find((m) => m.role === "user")!;
    expect(asked.content).toEqual([
      { type: "text", text: "这两张图里是什么？" },
      { type: "image", mimeType: "image/png", data: PNG_1X1 },
    ]);
    const read = messagesIn(1).find((m) => m.role === "toolResult")!;
    expect(read.content.map((c) => [c.type, c.type === "image" ? c.mimeType : ""])).toEqual([
      ["text", ""],
      ["image", "image/png"],
    ]);
  });
});

describe("多轮对话", () => {
  /** 一轮对话的出参 */
  type Turn = { answer: string; history: Message[] };
  const turn = async (prompt: string, history?: Message[]) => {
    const r = await assist(prompt, history);
    if (!r.ok) throw new Error(r.reason);
    return r.value as Turn;
  };

  test("出参的 history 含这一轮的工具调用与结果；下一轮原样传回，交给模型的前缀与上一轮一致", async () => {
    await writeFile(join(workspace, "a.md"), "第一版");
    faux.setResponses([
      step(fauxToolCall("fs_read", { path: "a.md" })),
      step(fauxText("a.md 写着第一版")),
      step(fauxText("你刚才问的是 a.md")),
    ]);

    const one = await turn("a.md 写着什么？");
    expect(one.history.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    const two = await turn("我刚才问的是哪个文件？", one.history);
    expect(two.answer).toBe("你刚才问的是 a.md");
    expect(two.history.slice(0, one.history.length)).toEqual(one.history);
    expect(two.history.map((m) => m.role).slice(one.history.length)).toEqual(["user", "assistant"]);
    // 第二轮的请求：上一轮的历史原样在前，后面是这一轮的提问
    expect(messagesIn(2).slice(0, one.history.length)).toEqual(one.history);
    expect(messagesIn(2).at(-1)).toMatchObject({ role: "user", content: "我刚才问的是哪个文件？" });
  });

  test("第二轮问人时进程没了：恢复后接着这一轮，出参的 history 前面是第一轮", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-turns-"));
    faux.setResponses([
      step(fauxText("你好")),
      step(fauxToolCall("ui_ask", { question: "用哪种格式？", options: ["md", "txt"] })),
      step(fauxText("好的，用 md")),
    ]);
    const one = await boot(dir);
    const first = await one.kernel.reap(one.kernel.submit("agent_assist", { prompt: "你好" }));
    if (!first.ok) throw new Error(first.reason);
    const history = (first.value as Turn).history;
    const root = one.kernel.submit("agent_assist", { prompt: "写个笔记", history });
    await Bun.sleep(5);

    const copy = `${dir}-crash`;
    cpSync(dir, copy, { recursive: true });
    const two = await boot(copy);
    await Bun.sleep(5);
    const park = two.events.find((e) => e.type === "park.opened")!.runId;
    two.kernel.unpark(park, { option: "md" });
    const second = await two.kernel.reap(root);
    if (!second.ok) throw new Error(second.reason);
    expect((second.value as Turn).answer).toBe("好的，用 md");
    expect((second.value as Turn).history.slice(0, history.length)).toEqual(history);
    expect(requests).toHaveLength(3);
  });
});

describe("压缩历史", () => {
  test("历史超过阈值：这一轮开头先压缩，交给模型的是压缩后的历史，出参的 history 从它开始", async () => {
    // 第一句就超过阈值（6 万多个汉字，估计一字一个 token）：只要轮数超过 model_compact 缺省保留的 2 轮就压
    faux.setResponses([step(fauxText("答一")), step(fauxText("答二")), step(fauxText("答三")), step(fauxText("摘要：问过一")), step(fauxText("答四"))]);

    let history: Message[] = [];
    for (const prompt of [`问一${"长".repeat(60_000)}`, "问二", "问三"]) {
      const r = await assist(prompt, history);
      if (!r.ok) throw new Error(r.reason);
      history = (r.value as { history: Message[] }).history;
    }
    // 前三轮都不超过保留的轮数，没有压：每轮一次请求
    expect(requests).toHaveLength(3);

    const four = await assist("问四", history);
    if (!four.ok) throw new Error(four.reason);
    // 第四轮：先一次写摘要的请求，再一次正常的请求；第一轮换成摘要，并进第二轮的提问
    expect(requests).toHaveLength(5);
    expect(messagesIn(4).map((m) => (m.role === "user" ? m.content : m.role))).toEqual([
      "[之前对话的摘要]\n摘要：问过一\n\n[接着对话]\n问二",
      "assistant",
      "问三",
      "assistant",
      "问四",
    ]);
    expect((four.value as { history: Message[] }).history).toEqual([...messagesIn(4), expect.objectContaining({ role: "assistant" })]);
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
    const root = one.kernel.submit("agent_assist", { prompt: "写个笔记" });
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
    expect(await two.kernel.reap(root)).toMatchObject({ ok: true, value: { answer: "好的，用 txt" } });
    // 第一轮的模型调用从日志回放，没有再发请求：两次请求分别来自崩溃前与恢复后
    expect(requests).toHaveLength(2);
    expect(toolResultsIn(1)).toEqual([{ name: "ui_ask", isError: false, text: '{"option":"txt"}' }]);
  });
});
