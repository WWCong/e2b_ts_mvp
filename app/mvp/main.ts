/**
 * 运行入口：装配内核、装载插件，把事件流按 Run 树打印出来，最后输出回答。
 * 任务中途要人回答的（ui_ask 的问题、fs_write 的审批）在终端里问。
 * 进度记在写前日志里（JOURNAL_DIR）：Ctrl-C 停下并保留进度（再按一次不等在途的调用），进程被杀也一样；
 * 再运行 bun start 先接着做没做完的任务，已完成的步骤不再执行，停在的问题原样再问一次。
 * 用法：bun start "读一下 notes.md，总结后写到 summary.md"；只接着做没做完的：bun start
 * 配置见 .env.example（Bun 会自动读取 .env），在这里转成内核与各插件的配置。
 */

import { join } from "node:path";
import { createInterface } from "node:readline";
import { Kernel, loadPlugin } from "stdlib";
import { answerParks } from "./prompt";
import { printEvent } from "./trace";

const prompt = process.argv.slice(2).join(" ");

/** 插件包名 → 配置；没列的不要配置 */
const config: Record<string, unknown> = {
  fs: { workspace: process.env.WORKSPACE_DIR },
  model: { model: process.env.MODEL },
};

// 日志目录在工作区之外：任何原语都碰不到它
const kernel = new Kernel({ journalDir: process.env.JOURNAL_DIR ?? ".journal" });
kernel.events.subscribe(printEvent);
const rl = createInterface({ input: process.stdin, output: process.stdout });
answerParks(kernel, rl);
for (const pkg of ["harness", "time"]) await loadPlugin(kernel, `stdlib/plugins/${pkg}`);
for (const pkg of ["fs", "model", "ui", "agent"]) await loadPlugin(kernel, join(import.meta.dir, "plugins", pkg), config[pkg]);
const recovered = await kernel.boot();
if (!prompt && recovered.length === 0) {
  console.error('用法：bun start "<要做的事>"；有没做完的任务时不带参数即接着做');
  process.exit(1);
}
const roots = [...recovered, ...(prompt ? [kernel.start("agent_assist", { prompt })] : [])];

// Ctrl-C：优雅关停，进度留在日志里；再按一次强杀。在等输入时 Ctrl-C 由 readline 收到
let stopped: Promise<void> | undefined;
const stop = () => {
  stopped = kernel.stop(stopped ? 0 : 10_000);
};
process.on("SIGINT", stop);
rl.on("SIGINT", stop);

let failed = false;
for (const root of roots) {
  const result = await kernel.reap(root);
  if (stopped) continue;
  console.log(result.ok ? `\n${(result.value as { answer: string }).answer}` : `\n失败（${result.by}）：${result.reason}`);
  failed ||= !result.ok;
}
if (stopped) {
  await stopped;
  console.log("\n已停下，进度已保存；再运行 bun start 接着做");
}
// 模型客户端可能还留着连接，显式退出
process.exit(failed ? 1 : 0);
