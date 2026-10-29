/**
 * 模型后端（基建，方案的 model-backend）：只交给 model 插件，别的插件要智能只能调 model_complete（R17）。
 * 凭据与供应商只在这一层：插件不读环境变量、不知道调的是哪家。凭据可以是这一层自己的（如环境变量里的 key），
 * 也可以是调用者的：插件把 Run 的调用者（ctx.caller）交过来，这一层取出调用者的令牌带上（callers.ts）。
 */

import { createModels, type AssistantMessage, type Context, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import type { Callers } from "./callers";

export interface Llm {
  /** 给人看的说明，如 deepseek/deepseek-flash */
  readonly name: string;
  /**
   * 一次补全：消息与工具用 pi-ai 的格式，用户消息与工具结果里可以有图片。模型看不了图的，实现把图片换成占位文字，
   * 不交给它。出错（含被中止）时返回的消息 stopReason 为 error / aborted。
   * caller：这次是替谁调的（Run 的调用者）；用调用者凭据的实现据它取令牌，取不到（没有调用者）就抛异常
   */
  complete(context: Context, options?: { signal?: AbortSignal; caller?: string }): Promise<AssistantMessage>;
}

/** 模型看不了图时，图片换成这句（连着的几张只留一句） */
export const NO_VISION = "（这里有图片，当前模型看不了图，已略去）";

type Provider = Parameters<ReturnType<typeof createModels>["setProvider"]>[0];

/**
 * 经 pi-ai 调模型。model：「provider/模型 id」，建的时候就找，配错了装配即失败。
 * 缺省只挂 deepseek 与 anthropic，key 由 provider 从环境变量读（DEEPSEEK_API_KEY、ANTHROPIC_API_KEY）；
 * providers 换掉缺省的（测试挂 faux provider）。
 * baseUrl：换掉模型的地址（如经业务网关）；callers：用调用者的令牌当 key（等不到新令牌时一直等，Run 被杀才停），
 * 不再读环境变量
 */
export function piLlm(options: { model: string; providers?: Provider[]; baseUrl?: string; callers?: Callers }): Llm {
  const models = createModels();
  for (const provider of options.providers ?? [deepseekProvider(), anthropicProvider()]) models.setProvider(provider);
  const slash = options.model.indexOf("/");
  const model = models.getModel(options.model.slice(0, slash), options.model.slice(slash + 1));
  if (!model) throw new Error(`unknown model: ${options.model}`);
  const target = options.baseUrl ? { ...model, baseUrl: options.baseUrl } : model;
  const vision = model.input.includes("image");
  const { callers } = options;
  return {
    name: options.model,
    complete: async (context, { signal, caller } = {}) => {
      if (callers && caller === undefined) throw new Error("no caller to call the model for: the run was not started by a request carrying a token");
      const apiKey = callers && (await callers.get(caller!, signal));
      return models.complete(target, vision ? context : withoutImages(context), { signal, apiKey });
    },
  };
}

/** 用户消息与工具结果里的图片换成占位文字（pi-ai 各家接口的实现大多也这样做，这里统一做，不依赖它们） */
function withoutImages(context: Context): Context {
  const strip = (content: (TextContent | ImageContent)[]): (TextContent | ImageContent)[] =>
    content.flatMap((block, i) =>
      block.type !== "image" ? [block] : content[i - 1]?.type === "image" ? [] : [{ type: "text" as const, text: NO_VISION }],
    );
  return {
    ...context,
    messages: context.messages.map((m) =>
      m.role === "user" && typeof m.content !== "string"
        ? { ...m, content: strip(m.content) }
        : m.role === "toolResult"
          ? { ...m, content: strip(m.content) }
          : m,
    ),
  } as Context;
}
