/**
 * 运行入口：装配内核、装载插件，在终端里连续对话。每一轮把事件流按 Run 树打印出来，最后输出回答。
 * 任务中途要人回答的（ui_ask 的问题、fs_write 的审批）在终端里问。
 * 本地状态都在 STATE_DIR 下：写前日志（journal/）与对话历史（conversation.json）。
 * Ctrl-C 停下并保留进度（再按一次不等在途的调用），进程被杀也一样；再运行 bun start 先接着做没做完的那一轮，
 * 已完成的步骤不再执行，停在的问题原样再问一次；之后接着之前的对话。
 * 用法：bun start 进入对话；bun start "第一句话" 从这句开始。/new 开始新对话，/exit 或 Ctrl-D 退出
 * 配置见 .env.example（Bun 会自动读取 .env），在这里转成内核与各插件的配置。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Message } from "@earendil-works/pi-ai";
import { Kernel, loadPlugin } from "stdlib";
import { answerParks, lineReader } from "./prompt";
import { printEvent } from "./trace";

/** agent_assist 一轮的出参 */
type Turn = { answer: string; history: Message[] };

/** 插件包名 → 配置；没列的不要配置 */
const config: Record<string, unknown> = {
  fs: { workspace: process.env.WORKSPACE_DIR },
  model: { model: process.env.MODEL },
};

// 状态目录在工作区之外：任何原语都碰不到它
const stateDir = process.env.STATE_DIR ?? ".harness";
const conversationFile = join(stateDir, "conversation.json");
const kernel = new Kernel({ journalDir: join(stateDir, "journal") });
kernel.events.subscribe(printEvent);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const read = lineReader(rl);
answerParks(kernel, read);
for (const pkg of ["harness", "time"]) await loadPlugin(kernel, `stdlib/plugins/${pkg}`);
for (const pkg of ["fs", "model", "ui", "agent"]) await loadPlugin(kernel, join(import.meta.dir, "plugins", pkg), config[pkg]);
const recovered = await kernel.boot();

// Ctrl-C：优雅关停，进度留在日志里；再按一次强杀。在等输入时 Ctrl-C 由 readline 收到
let stopped: Promise<void> | undefined;
const halted = Promise.withResolvers<undefined>();
const stop = () => {
  stopped = kernel.stop(stopped ? 0 : 10_000);
  halted.resolve(undefined);
};
process.on("SIGINT", stop);
rl.on("SIGINT", stop);

let history = loadConversation();
/** 正在进行的那一轮；Ctrl-C 时有它才需要提示「接着做」 */
let running: string | undefined;
if (history.length > 0) console.log(`接着之前的对话（${history.length} 条消息）；/new 开始新对话`);

// 先做完没做完的那一轮，再接着对话
for (const root of recovered) await finish(root);
let line: string | undefined = process.argv.slice(2).join(" ").trim() || undefined;
while (!stopped) {
  line ??= (await Promise.race([read("\n你> "), halted.promise]))?.trim();
  if (line === undefined || line === "/exit") break;
  if (line === "/new") {
    history = [];
    saveConversation();
    console.log("已开始新对话");
  } else if (line) {
    await finish(kernel.start("agent_assist", { prompt: line, history }));
  }
  line = undefined;
}

if (stopped) {
  await stopped;
  if (running) console.log("\n已停下，进度已保存；再运行 bun start 接着做");
}
// 模型客户端可能还留着连接，显式退出
process.exit(0);

/**
 * 等一轮结束：成功就打印回答、记下更新后的历史；失败只打印，历史不变（这句话可以再说一遍）。
 * 后续：日志删掉之后、对话写下之前崩溃会丢这一轮的结果，等内核支持「结果留到调用方确认收到」
 */
async function finish(root: string): Promise<void> {
  running = root;
  const result = await kernel.reap(root);
  if (stopped) return;
  running = undefined;
  if (!result.ok) return void console.log(`\n失败（${result.by}）：${result.reason}`);
  const turn = result.value as Turn;
  console.log(`\n${turn.answer}`);
  history = turn.history;
  saveConversation();
}

function loadConversation(): Message[] {
  if (!existsSync(conversationFile)) return [];
  return (JSON.parse(readFileSync(conversationFile, "utf8")) as { history: Message[] }).history;
}

/** 先写临时文件再改名：写到一半崩溃也不会留下半截的对话 */
function saveConversation(): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(`${conversationFile}.tmp`, JSON.stringify({ history }));
  renameSync(`${conversationFile}.tmp`, conversationFile);
}
