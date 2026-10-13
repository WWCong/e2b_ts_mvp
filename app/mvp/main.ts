/**
 * 运行入口：装配内核、装载插件，把事件流按 Run 树打印出来，最后输出回答。Ctrl-C 取消整棵树。
 * 任务中途要人回答的（ui_ask 的问题、fs_write 的审批）在终端里问。
 * 用法：bun start "读一下 notes.md，总结后写到 summary.md"
 * 配置见 .env.example（Bun 会自动读取 .env），在这里转成各插件的配置。
 */

import { join } from "node:path";
import { createInterface } from "node:readline";
import { Kernel, loadPlugin } from "stdlib";
import { answerParks } from "./prompt";
import { printEvent } from "./trace";

const prompt = process.argv.slice(2).join(" ");
if (!prompt) {
  console.error('用法：bun start "<要做的事>"');
  process.exit(1);
}

/** 插件包名 → 配置；没列的不要配置 */
const config: Record<string, unknown> = {
  fs: { workspace: process.env.WORKSPACE_DIR },
  model: { model: process.env.MODEL },
};

const kernel = new Kernel();
kernel.events.subscribe(printEvent);
const rl = createInterface({ input: process.stdin, output: process.stdout });
answerParks(kernel, rl);
for (const pkg of ["harness", "time"]) await loadPlugin(kernel, `stdlib/plugins/${pkg}`);
for (const pkg of ["fs", "model", "ui", "agent"]) await loadPlugin(kernel, join(import.meta.dir, "plugins", pkg), config[pkg]);
await kernel.boot();

const runId = kernel.start("agent_assist", { prompt });
// 在等输入时 Ctrl-C 由 readline 收到
const cancel = () => kernel.cancel(runId);
process.on("SIGINT", cancel);
rl.on("SIGINT", cancel);
const result = await kernel.reap(runId);

console.log(result.ok ? `\n${(result.value as { answer: string }).answer}` : `\n失败（${result.by}）：${result.reason}`);
// 模型客户端可能还留着连接，显式退出
process.exit(result.ok ? 0 : 1);
