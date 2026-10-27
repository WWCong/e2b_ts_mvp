/**
 * 终端客户端画 Run 树时，MVP 各 Operation 的入参、出参怎么摘要：历史只给条数；model_complete 只取要点
 * （几条消息几个工具，模型要调谁或回答了什么）；model_compact 只看压没压；agent_assist 与 chat_say 只看这一句与回答；
 * harness_park 的入参只看 payload（要问的问题）。只影响显示；返回 undefined 用缺省的截断 JSON
 */

import type { Brief } from "stdlib/clients/console";
import { short } from "stdlib/clients/console/tree";

export const brief: Brief = (operation, side, value) => {
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
};
