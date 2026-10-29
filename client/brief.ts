/**
 * 终端界面画 Run 树时，stdlib 自带插件的 Operation 的入参、出参怎么摘要：历史只给条数（kv 里存的对话历史也是）；
 * model_complete 只取要点（几条消息几个工具，模型要调谁或回答了什么）；model_compact 只看压没压；
 * harness_park 的入参只看 payload（要问的问题）；harness_exec 的入参只看脚本有几行。
 * 应用的 brief 先摘自己的 Operation，别的交给它。只影响显示；返回 undefined 用缺省的截断 JSON
 */

import type { Brief } from "./console";
import { short } from "./console/tree";

export const stdlibBrief: Brief = (operation, side, value) => {
  switch (`${operation} ${side}`) {
    case "harness_park input":
      return short((value as { payload: unknown }).payload);
    case "harness_exec input":
      return `(${(value as { source: string }).source.trim().split("\n").length} 行脚本)`;
    case "kv_get input":
      return (value as { key: string }).key;
    case "kv_get output":
      return Array.isArray(value) ? `→ (${value.length} 条消息)` : undefined;
    case "kv_set input": {
      const { key, value: stored } = value as { key: string; value: unknown };
      return Array.isArray(stored) ? `${key} (${stored.length} 条消息)` : undefined;
    }
    case "model_compact input":
      return `(${(value as { history: unknown[] }).history.length} 条消息)`;
    case "model_compact output": {
      const { history, compacted } = value as { history: unknown[]; compacted?: boolean };
      return compacted ? `→ 压成 ${history.length} 条` : "→ 不用压";
    }
    case "model_complete input": {
      const { messages, tools } = value as { messages: unknown[]; tools: unknown[] };
      return `(${messages.length} 条消息, ${tools.length} 个工具)`;
    }
    case "model_complete output": {
      const { calls, answer } = value as { calls: { name: string; arguments: unknown }[]; answer: string | null };
      return calls.length > 0 ? `→ ${calls.map((c) => `${c.name} ${short(c.arguments)}`).join(", ")}` : `→ ${short(answer)}`;
    }
  }
};
