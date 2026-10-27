/**
 * 内容块：文字与图片，插件之间约定的形状（与 pi-ai 的 TextContent / ImageContent 同形，可以原样交给模型）。
 * 内核不解释它们。
 * - 工具结果带图片时是 ToolContent（比如 fs_read 读到图片），调模型的一方（agent）把 content 原样放进工具结果
 * - 用户随一句话发来的图片用 image 校验
 */

import { z } from "zod";

export type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** 工具结果带图片时的形状；只有文字的结果直接是字符串 */
export type ToolContent = { content: ContentBlock[] };

/** 值是不是 ToolContent */
export function isToolContent(value: unknown): value is ToolContent {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as ToolContent).content) &&
    (value as ToolContent).content.every((b) => b?.type === "text" || b?.type === "image")
  );
}

/** 一张图片：类型与 base64。模型都认这几种 */
export const image = z.object({
  mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  data: z.base64(),
});
