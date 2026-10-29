/**
 * 压缩历史用到的纯函数：估历史有多大、在哪切开、把要压的部分写成给模型看的记录、把摘要并进保留的第一条消息。
 */

import type { Message, UserMessage } from "@earendil-works/pi-ai";

/** 交给模型写摘要时，一条工具结果最多带多少字 */
const TOOL_RESULT_CHARS = 2000;

/** 一张图片大约多少 token：各家按尺寸算，常见的一千多，这里取一个粗估的数，免得带图的历史迟迟不压 */
const IMAGE_TOKENS = 1600;

/**
 * 历史大约多少 token：按文字粗估，中日韩等宽字符一个算一个，其余四个字符算一个；每张图片按 IMAGE_TOKENS 算。
 * 不用模型回报的 usage：压缩后保留的旧回复还带着压缩前的用量，会让下一轮误以为还要压
 */
export function estimateTokens(history: readonly Message[]): number {
  let tokens = 0;
  for (const message of history) {
    const text = render(message);
    const wide = text.match(/[⺀-鿿가-힯豈-﫿＀-￯]/g)?.length ?? 0;
    tokens += wide + Math.ceil((text.length - wide) / 4) + images(message) * IMAGE_TOKENS;
  }
  return tokens;
}

/** 一条消息里的图片张数（用户消息与工具结果里才有） */
function images(message: Message): number {
  if (message.role !== "user" && message.role !== "toolResult") return 0;
  const { content } = message;
  return typeof content === "string" ? 0 : content.filter((c) => c.type === "image").length;
}

/**
 * 在哪切开：保留最近 keep 轮（一轮从一条用户消息开始），返回保留部分的起点。
 * 轮数不超过 keep 时返回 0，没有可压的。按轮切，工具调用与它的结果不会被拆开
 */
export function splitAt(history: readonly Message[], keep: number): number {
  const starts = history.flatMap((m, i) => (m.role === "user" ? [i] : []));
  return starts.length > keep ? starts[starts.length - keep]! : 0;
}

/** 要压的那段历史写成纯文本记录：工具调用与结果都写成文字，免得模型要求带上工具定义 */
export function transcript(history: readonly Message[]): string {
  return history
    .map(render)
    .filter(Boolean)
    .join("\n\n");
}

/** 摘要并进保留部分的第一条用户消息，放在原话前面；不另起一条，免得出现连续两条用户消息 */
export function withSummary(summary: string, first: UserMessage): UserMessage {
  const prefix = `[之前对话的摘要]\n${summary}\n\n[接着对话]\n`;
  const content = typeof first.content === "string" ? prefix + first.content : [{ type: "text" as const, text: prefix }, ...first.content];
  return { ...first, content };
}

function render(message: Message): string {
  switch (message.role) {
    case "user":
      return `用户：${typeof message.content === "string" ? message.content : message.content.map((c) => (c.type === "text" ? c.text : "[图片]")).join("")}`;
    case "assistant":
      return message.content
        .flatMap((c) => {
          if (c.type === "text") return c.text ? [`助手：${c.text}`] : [];
          if (c.type === "toolCall") return [`助手调用 ${c.name}：${JSON.stringify(c.arguments)}`];
          return [];
        })
        .join("\n");
    case "toolResult": {
      const text = message.content.map((c) => (c.type === "text" ? c.text : "[图片]")).join("");
      const clipped = text.length > TOOL_RESULT_CHARS ? `${text.slice(0, TOOL_RESULT_CHARS)}…（截断）` : text;
      return `${message.toolName} 返回${message.isError ? "（出错）" : ""}：${clipped}`;
    }
    case "system":
      return "";
  }
}
