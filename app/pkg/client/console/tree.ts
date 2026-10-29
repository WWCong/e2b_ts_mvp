/**
 * 把事件流按 Run 树缩进写成一行行，给人看一次任务的全过程。
 * 各 Operation 的入参、出参怎么摘要由应用给（brief），只影响显示；没给或对不上时退回截断的 JSON。
 */

import { isToolContent, type HarnessEvent } from "stdlib";

/** 一行摘要；返回 undefined 用缺省的 */
export type Brief = (operation: string, side: "input" | "output", value: unknown) => string | undefined;

export function eventTree(write: (line: string) => void, brief?: Brief): (event: HarnessEvent) => void {
  /** runId → 深度，用来缩进；Run 结束后移除 */
  const depths = new Map<string, number>();
  const depthOf = (runId: string) => depths.get(runId) ?? 0;
  /** spawn 起的树的根：它和发起方各跑各的，结束那行常夹在别的 Run 下面，标出来 */
  const spawned = new Set<string>();
  const ended = (runId: string) => (spawned.delete(runId) ? "（另起的树）" : "");
  const line = (depth: number, text: string) => write(`${"  ".repeat(depth)}${text}`);
  const summary = (operation: string, side: "input" | "output", value: unknown) => {
    // 带图片的结果：文字照常，图片只写类型，不打出 base64
    if (isToolContent(value)) value = value.content.map((c) => (c.type === "text" ? c.text : `[图片 ${c.mimeType}]`)).join(" ");
    const plain = side === "output" ? `→ ${short(value)}` : short(value);
    try {
      return brief?.(operation, side, value) ?? plain;
    } catch {
      return plain;
    }
  };

  return (e) => {
    switch (e.type) {
      case "run.started": {
        depths.set(e.runId, e.depth);
        // spawn 起的树：缩进接着发起方，不是它的子调用
        const [mark, note] = e.spawnedBy ? ["⇢", "（另起一棵树）"] : ["▶", ""];
        if (e.spawnedBy) spawned.add(e.runId);
        return line(e.depth, `${mark} ${e.operation} ${summary(e.operation, "input", e.input)}${note}${e.attempt ? `（第 ${e.attempt} 次）` : ""}`);
      }
      case "tree.recovered": {
        const changed = e.artifactChanged ? "；代码改过，逐步比对" : "";
        return line(0, `↻ 接着做 ${e.operation}：${e.replayed.length} 步已完成、不再执行，${e.inflight.length} 个重新执行${changed}`);
      }
      case "run.exited": {
        const depth = depthOf(e.runId);
        depths.delete(e.runId);
        const r = e.result;
        const note = ended(e.runId);
        return line(depth, r.ok ? `✓ ${e.operation} ${summary(e.operation, "output", r.value)}${note}` : `✗ ${e.operation} ${r.by}: ${r.reason}${note}`);
      }
      case "run.killed":
        line(depthOf(e.runId), `✗ ${e.operation} killed (${e.reason})${ended(e.runId)}`);
        return void depths.delete(e.runId);
      case "call.rejected":
        return line(depthOf(e.runId) + 1, `✗ ${e.target} ${e.result.by}: ${e.result.reason}`);
      case "run.logged":
        return line(depthOf(e.runId) + 1, `· ${e.level === "info" ? "" : `[${e.level}] `}${e.text}`);
      case "decorator.rewrote":
        return line(depthOf(e.runId) + 1, `· ${e.decorator} rewrote ${e.phase}`);
      case "decorator.rejected":
        return line(depthOf(e.runId) + 1, `· ${e.decorator} rejected: ${e.result.reason}`);
      case "decorator.failed":
        return line(depthOf(e.runId) + 1, `· ${e.decorator} failed (${e.onError}): ${e.error}`);
    }
  };
}

export function short(value: unknown, max = 80): string {
  const text = (typeof value === "string" ? value : (JSON.stringify(value) ?? "")).replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
