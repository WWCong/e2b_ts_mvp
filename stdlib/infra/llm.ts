/**
 * 模型后端（基建，方案的 model-backend）：只交给 model 插件，别的插件要智能只能调 model_complete（R17）。
 * 凭据与供应商只在这一层：插件不读环境变量、不知道调的是哪家。
 */

import { createModels, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

export interface Llm {
  /** 给人看的说明，如 deepseek/deepseek-flash */
  readonly name: string;
  /** 一次补全：消息与工具用 pi-ai 的格式。出错（含被中止）时返回的消息 stopReason 为 error / aborted */
  complete(context: Context, options?: { signal?: AbortSignal }): Promise<AssistantMessage>;
}

type Provider = Parameters<ReturnType<typeof createModels>["setProvider"]>[0];

/**
 * 经 pi-ai 调模型。model：「provider/模型 id」，建的时候就找，配错了装配即失败。
 * 缺省只挂 deepseek 与 anthropic，key 由 provider 从环境变量读（DEEPSEEK_API_KEY、ANTHROPIC_API_KEY）；
 * providers 换掉缺省的（测试挂 faux provider）
 */
export function piLlm(options: { model: string; providers?: Provider[] }): Llm {
  const models = createModels();
  for (const provider of options.providers ?? [deepseekProvider(), anthropicProvider()]) models.setProvider(provider);
  const slash = options.model.indexOf("/");
  const model = models.getModel(options.model.slice(0, slash), options.model.slice(slash + 1));
  if (!model) throw new Error(`unknown model: ${options.model}`);
  return {
    name: options.model,
    complete: (context, { signal } = {}) => models.complete(model, context, { signal }),
  };
}
