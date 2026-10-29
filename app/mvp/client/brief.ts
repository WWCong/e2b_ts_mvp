/**
 * 终端客户端画 Run 树时，MVP 自己的 Operation 怎么摘要：agent_assist 与 chat_say 只看这一句与回答；
 * stdlib 自带插件的交给 client/brief.ts。只影响显示；返回 undefined 用缺省的截断 JSON
 */

import { stdlibBrief } from "client/brief";
import type { Brief } from "client/console";
import { short } from "client/console/tree";

export const brief: Brief = (operation, side, value) => {
  switch (`${operation} ${side}`) {
    case "chat_say input": {
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
  }
  return stdlibBrief(operation, side, value);
};
