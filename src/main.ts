/**
 * 运行入口：装配内核、装载插件，把事件流按 Run 树打印出来，最后输出回答。Ctrl-C 取消整棵树。
 * 用法：bun start "读一下 notes.md，总结后写到 summary.md"
 * 配置见 .env.example（Bun 会自动读取 .env）。
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Kernel } from "./kernel/kernel";
import { loadPlugin } from "./kernel/loader";
import { printEvent } from "./trace";

const prompt = process.argv.slice(2).join(" ");
if (!prompt) {
  console.error('用法：bun start "<要做的事>"');
  process.exit(1);
}

// fs 插件只在工作区里读写，先确保工作区存在（缺省目录与 fs 插件一致）
await mkdir(process.env.WORKSPACE_DIR ?? "workspace", { recursive: true });

const kernel = new Kernel();
kernel.events.subscribe(printEvent);
for (const pkg of ["fs", "model", "agent"]) await loadPlugin(kernel, join(import.meta.dir, "plugins", pkg));

const runId = kernel.start("agent_assist", { prompt });
process.on("SIGINT", () => kernel.cancel(runId));
const result = await kernel.reap(runId);

console.log(result.ok ? `\n${(result.value as { answer: string }).answer}` : `\n失败（${result.by}）：${result.reason}`);
// 模型客户端可能还留着连接，显式退出
process.exit(result.ok ? 0 : 1);
