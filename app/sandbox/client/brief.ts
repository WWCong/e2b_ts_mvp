/**
 * 和管理 agent 对话的终端画 Run 树时，这个应用自己的 Operation 怎么摘要：manager_say 与 agent_assist 只看这一句与回答；
 * model_complete 只取要点（几条消息几个工具，模型要调谁或回答了什么）。
 * stdlib 自带插件的交给 pkg/client/brief.ts。只影响显示；返回 undefined 用缺省的截断 JSON
 */

import { stdlibBrief } from "pkg/client/brief";
import type { Brief } from "pkg/client/console";
import { short } from "pkg/client/console/tree";

export const brief: Brief = (operation, side, value) => {
  switch (`${operation} ${side}`) {
    case "manager_say input": {
      const { text, images } = value as { text: unknown; images?: unknown[] };
      return `${short(text)}${images?.length ? `（带 ${images.length} 张图）` : ""}`;
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
  return stdlibBrief(operation, side, value);
};
