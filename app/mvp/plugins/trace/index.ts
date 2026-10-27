/**
 * trace 插件：把事件流按 Run 树缩进打印到终端，观察一次任务的全过程。
 * 只读事件（afterAny），不提供 Operation。方案里事件由投递插件送往观测平台（9.2），这里是最简单的一种：打到终端。
 * 各 Operation 的入参与出参怎么摘要写在这里，只影响显示；形状对不上时退回截断的 JSON。
 */

import { isToolContent, plugin, type HarnessEvent } from "stdlib";

export default plugin(() => {
  /** runId → 深度，用来缩进；Run 结束后移除 */
  const depths = new Map<string, number>();
  const depthOf = (runId: string) => depths.get(runId) ?? 0;

  function print(e: HarnessEvent): void {
    switch (e.type) {
      case "run.started":
        depths.set(e.runId, e.depth);
        return line(e.depth, `▶ ${e.operation} ${brief(e.operation, "input", e.input)}${e.attempt ? `（第 ${e.attempt} 次）` : ""}`);
      case "tree.recovered": {
        const changed = e.artifactChanged ? "；代码改过，逐步比对" : "";
        return line(0, `↻ 接着做 ${e.operation}：${e.replayed.length} 步已完成、不再执行，${e.inflight.length} 个重新执行${changed}`);
      }
      case "run.exited": {
        const depth = depthOf(e.runId);
        depths.delete(e.runId);
        const r = e.result;
        return line(depth, r.ok ? `✓ ${e.operation} ${brief(e.operation, "output", r.value)}` : `✗ ${e.operation} ${r.by}: ${r.reason}`);
      }
      case "run.killed":
        line(depthOf(e.runId), `✗ ${e.operation} killed (${e.reason})`);
        return void depths.delete(e.runId);
      case "call.rejected":
        return line(depthOf(e.runId) + 1, `✗ ${e.target} ${e.result.by}: ${e.result.reason}`);
      case "decorator.rewrote":
        return line(depthOf(e.runId) + 1, `· ${e.decorator} rewrote ${e.phase}`);
      case "decorator.rejected":
        return line(depthOf(e.runId) + 1, `· ${e.decorator} rejected: ${e.result.reason}`);
      case "decorator.failed":
        return line(depthOf(e.runId) + 1, `· ${e.decorator} failed (${e.onError}): ${e.error}`);
    }
  }

  return { afterAny: print };
});

function line(depth: number, text: string): void {
  console.log(`${"  ".repeat(depth)}${text}`);
}

/**
 * 一行摘要。历史只给条数；model_complete 只取要点：几条消息几个工具，模型要调谁或回答了什么；
 * model_compact 只看压没压；agent_assist 与 chat_say 只看这一句与回答；harness_park 的入参只看 payload（要问的问题）
 */
function brief(operation: string, side: "input" | "output", value: unknown): string {
  // 带图片的工具结果：文字照常，图片只写类型，不打出 base64
  if (isToolContent(value)) value = value.content.map((c) => (c.type === "text" ? c.text : `[图片 ${c.mimeType}]`)).join(" ");
  const plain = side === "output" ? `→ ${short(value)}` : short(value);
  try {
    return summarize(operation, side, value) ?? plain;
  } catch {
    return plain;
  }
}

function summarize(operation: string, side: "input" | "output", value: unknown): string | undefined {
  switch (`${operation} ${side}`) {
    case "harness_park input":
      return short((value as { payload: unknown }).payload);
    case "chat_say input": {
      const { text, images } = value as { text: unknown; images?: unknown[] };
      return `${short(text)}${images?.length ? `（带 ${images.length} 张图）` : ""}`;
    }
    case "chat_load output":
      return `→ (${(value as unknown[]).length} 条消息)`;
    case "chat_save input":
      return `(${(value as { history: unknown[] }).history.length} 条消息)`;
    case "model_compact input":
      return `(${(value as { history: unknown[] }).history.length} 条消息)`;
    case "model_compact output": {
      const { history, compacted } = value as { history: unknown[]; compacted?: boolean };
      return compacted ? `→ 压成 ${history.length} 条` : "→ 不用压";
    }
    case "agent_assist input": {
      const { prompt, images, history } = value as { prompt: string; images?: unknown[]; history?: unknown[] };
      const extra = [images?.length ? `${images.length} 张图` : "", history?.length ? `${history.length} 条历史` : ""].filter(Boolean);
      return `${short(prompt)}${extra.length ? `（带 ${extra.join("、")}）` : ""}`;
    }
    case "agent_assist output":
      return `→ ${short((value as { answer: unknown }).answer)}`;
    case "model_complete input": {
      const { messages, tools } = value as { messages: unknown[]; tools: unknown[] };
      return `(${messages.length} 条消息, ${tools.length} 个工具)`;
    }
    case "model_complete output": {
      const { calls, answer } = value as { calls: { name: string; arguments: unknown }[]; answer: string | null };
      return calls.length > 0 ? `→ ${calls.map((c) => `${c.name} ${short(c.arguments)}`).join(", ")}` : `→ ${short(answer)}`;
    }
  }
}

function short(value: unknown, max = 80): string {
  const text = (typeof value === "string" ? value : (JSON.stringify(value) ?? "")).replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
