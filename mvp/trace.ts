/**
 * 把事件流按 Run 树缩进打印到终端，供 MVP 观察一次任务的全过程。
 * 方案里事件由投递插件送往观测平台（9.2）；这里只是入口程序的一个订阅者。
 */

import type { HarnessEvent } from "../src/kernel/events";

/** runId → 深度，用来缩进；Run 结束后移除 */
const depths = new Map<string, number>();

export function printEvent(e: HarnessEvent): void {
  switch (e.type) {
    case "run.started":
      depths.set(e.runId, e.depth);
      return line(e.depth, `▶ ${e.operation} ${brief(e.operation, "input", e.input)}`);
    case "run.exited": {
      const depth = depths.get(e.runId) ?? 0;
      depths.delete(e.runId);
      const r = e.result;
      return line(depth, r.ok ? `✓ ${e.operation} ${brief(e.operation, "output", r.value)}` : `✗ ${e.operation} ${r.by}: ${r.reason}`);
    }
    case "run.killed":
      line(depths.get(e.runId) ?? 0, `✗ ${e.operation} killed (${e.reason})`);
      return void depths.delete(e.runId);
    case "call.rejected":
      return line((depths.get(e.runId) ?? 0) + 1, `✗ ${e.target} ${e.result.by}: ${e.result.reason}`);
    case "decorator.rewrote":
      return line((depths.get(e.runId) ?? 0) + 1, `· ${e.decorator} rewrote ${e.phase}`);
    case "decorator.rejected":
      return line((depths.get(e.runId) ?? 0) + 1, `· ${e.decorator} rejected: ${e.result.reason}`);
    case "decorator.failed":
      return line((depths.get(e.runId) ?? 0) + 1, `· ${e.decorator} failed (${e.onError}): ${e.error}`);
  }
}

function line(depth: number, text: string): void {
  console.log(`${"  ".repeat(depth)}${text}`);
}

/**
 * 一行摘要。model_complete 的入参与出参太长，只取要点：几条消息几个工具，模型要调谁或回答了什么；
 * stdlib_park 的入参只看 payload（要问的问题），不看 schema
 */
function brief(operation: string, side: "input" | "output", value: unknown): string {
  if (operation === "stdlib_park" && side === "input") return short((value as { payload: unknown }).payload);
  if (operation === "model_complete") {
    if (side === "input") {
      const { messages, tools } = value as { messages: unknown[]; tools: unknown[] };
      return `(${messages.length} 条消息, ${tools.length} 个工具)`;
    }
    const { calls, answer } = value as { calls: { name: string; arguments: unknown }[]; answer: string | null };
    return calls.length > 0 ? `→ ${calls.map((c) => `${c.name} ${short(c.arguments)}`).join(", ")}` : `→ ${short(answer)}`;
  }
  return short(value);
}

function short(value: unknown, max = 80): string {
  const text = (typeof value === "string" ? value : JSON.stringify(value) ?? "").replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
