/**
 * agent：最小的 agent 循环（3.3），script 包（应用层）：只调 Operation，不碰基建。
 * 调模型 → 模型要调工具就逐个 ctx.call → 结果追加进历史 → 再调模型，
 * 直到模型不再调工具。被拒绝的调用原样作为出错的工具结果交给模型，由它改道或重试。
 * 多轮对话：入参带之前的 history，出参是回答与更新后的 history（含这一轮的工具调用与结果），下一轮原样传回，
 * 交给模型的前缀逐字节不变。对话存在哪由调用方决定，agent 本身不存状态。
 * 图片：这一句可以带图片（images，base64），与文字一起作为用户消息交给模型；工具结果带图片的（ToolContent，
 * 如 fs_read 读到图片）原样放进工具结果。模型不支持看图时由 pi-ai 换成占位文字。
 * 每轮开头经 model_compact 检查一次历史，超过 COMPACT_OVER（估计的 token 数）就压缩（8.3）；
 * 压缩后的历史随出参交回，下一轮从它开始，同一段只压一次。
 * 人设、压缩时机、轮数上限都写在这里：要换就复制这个包改（R7）。
 */

import type { Message, ToolCall } from "@earendil-works/pi-ai";
import { z } from "zod";
import { image, isToolContent, op, opaque, script, type Ctx, type Result } from "stdlib";

const PERSONA =
  "你是工作区助手。需要查看或修改文件时使用工具；要连着调很多次工具（批量读、统计、按结果分支）时，用 harness_exec 写一段脚本一次做完。" +
  "用户要你写 script 包时，在工作区里写草稿，用 harness_exec 试跑，跑通了再用 package_install 装上。" +
  "信息不够或有几种做法需要用户拍板时，用 ui_ask 问用户。做完后用中文简要回答用户。";
const MAX_TURNS = 20;
/** 历史估计超过这么多 token 就在轮初压缩 */
const COMPACT_OVER = 60_000;

const assist = op({
  usage: "工作区助手：把这一句（可带图片）连同之前的历史交给模型，模型按需读写文件、问用户，返回回答与更新后的历史",
  input: z.object({
    prompt: z.string(),
    /** 随这一句发来的图片 */
    images: z.array(image).default([]),
    /** 之前几轮的历史：上一轮出参里的 history，原样传回 */
    history: z.array(opaque<Message>()).default([]),
  }),
  only: ["fs", "model", "ui", "time", "harness_exec", "package_install"],
  impl: async (ctx, input) => {
    const tools = ctx.tools();
    const compacted = await ctx.ops.model.compact({ history: input.history, over: COMPACT_OVER });
    if (!compacted.ok) throw new Error(`model_compact rejected by ${compacted.by}: ${compacted.reason}`);
    const content = input.images.length > 0 ? [{ type: "text" as const, text: input.prompt }, ...input.images.map((i) => ({ type: "image" as const, ...i }))] : input.prompt;
    const history: Message[] = [...compacted.value.history, { role: "user", content, timestamp: await now(ctx) }];

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const r = await ctx.ops.model.complete({ systemPrompt: PERSONA, messages: history, tools });
      if (!r.ok) throw new Error(`model_complete rejected by ${r.by}: ${r.reason}`);
      const { message, calls, answer } = r.value;
      history.push(message);
      if (calls.length === 0) return { answer, history };

      // 模型挑的工具：名字是变量，按名字调
      const results = await Promise.all(calls.map((call) => ctx.call(call.name, call.arguments)));
      const timestamp = await now(ctx);
      calls.forEach((call, i) => history.push(toolResult(call, results[i]!, timestamp)));
    }
    throw new Error(`no answer after ${MAX_TURNS} turns`);
  },
});

export default script({ requires: ["model", "time"], operations: { assist } });

/** 消息的时间戳经 time_now 取：恢复重放时回送当初的值，交给模型的历史与原来一致，调用才比对得上 */
async function now(ctx: Ctx): Promise<number> {
  const r = await ctx.ops.time.now(null);
  if (!r.ok) throw new Error(`time_now rejected by ${r.by}: ${r.reason}`);
  return r.value;
}

/** 调用结果写成给模型看的工具结果：成功给值（带图片的原样给内容块），被拒给拒绝的来由 */
function toolResult(call: ToolCall, result: Result, timestamp: number): Message {
  const text = result.ok
    ? typeof result.value === "string"
      ? result.value
      : JSON.stringify(result.value)
    : JSON.stringify({ rejectedBy: result.by, reason: result.reason, retryable: result.retryable });
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: result.ok && isToolContent(result.value) ? result.value.content : [{ type: "text", text }],
    isError: !result.ok,
    timestamp,
  };
}
