/**
 * 模型集合与当前模型。只挂 deepseek 与 anthropic 两个 provider，key 由 provider 从环境变量读
 * （DEEPSEEK_API_KEY、ANTHROPIC_API_KEY）。用哪个模型由环境变量 MODEL 指定：「provider/模型 id」，
 * 缺省 deepseek/deepseek-flash。测试往 models 里挂 faux provider，再把 MODEL 指过去。
 */

import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

export const models = createModels();
models.setProvider(deepseekProvider());
models.setProvider(anthropicProvider());

export function currentModel() {
  const spec = process.env.MODEL ?? "deepseek/deepseek-flash";
  const slash = spec.indexOf("/");
  const model = models.getModel(spec.slice(0, slash), spec.slice(slash + 1));
  if (!model) throw new Error(`unknown model: ${spec}`);
  return model;
}
