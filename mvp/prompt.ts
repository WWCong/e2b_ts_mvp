/**
 * 在终端里回答 park：认得 ui 插件约定的格式（Question → Answer），一次问一个，把回答 unpark 回去。
 * 方案里由 UI 渲染 agent-ui 格式的 park（3.5）；这里是入口程序的一个订阅者。
 */

import type { Interface } from "node:readline";
import type { Kernel } from "../src/kernel/kernel";
import type { Answer, Question } from "./plugins/ui";

const HINT_OPTIONS = "输入序号或选项选择，后面可空格接补充说明；也可以直接写别的回答。/skip [原因] 不回答";
const HINT_TEXT = "直接写回答。/skip [原因] 不回答";

export function answerParks(kernel: Kernel, rl: Interface): void {
  // 用异步迭代器按行取：会缓存已读到的行（管道输入时 rl.question 会丢行）
  const lines = rl[Symbol.asyncIterator]();
  const open = new Set<string>();
  let queue = Promise.resolve();

  kernel.events.subscribe((e) => {
    // 关停时 park 不发 park.closed，只有 run.killed
    if (e.type === "park.closed" || e.type === "run.killed") open.delete(e.runId);
    if (e.type !== "park.opened") return;
    open.add(e.runId);
    const q = e.payload as Question;
    queue = queue.then(async () => {
      // 轮到时已不在等的（比如被取消）跳过；空行再问
      while (open.has(e.runId)) {
        process.stdout.write(render(q));
        const line = await lines.next();
        if (line.done) {
          if (open.has(e.runId)) kernel.withdraw(e.runId, "输入已结束");
          return;
        }
        const reply = parse(q, line.value.trim());
        if (!reply) continue;
        try {
          if ("skip" in reply) kernel.withdraw(e.runId, reply.skip);
          else kernel.unpark(e.runId, reply);
        } catch (err) {
          console.log((err as Error).message);
        }
      }
    });
  });
}

function render({ question, options }: Question): string {
  const choices = options?.map((o, i) => `  ${i + 1}. ${o}\n`).join("") ?? "";
  return `\n? ${question}\n${choices}（${options ? HINT_OPTIONS : HINT_TEXT}）\n> `;
}

/** 一行输入 → 回答或撤回；空行返回 undefined */
export function parse({ options }: Question, line: string): Answer | { skip: string } | undefined {
  if (!line) return undefined;
  const skip = /^\/skip(?:\s+(.*))?$/.exec(line);
  if (skip) return { skip: skip[1] ? `用户不回答：${skip[1]}` : "用户不回答" };
  if (!options) return { text: line };

  // 选项可以写序号，也可以原样写（不分大小写，多个都匹配时取最长的）；
  // 后面须是空白或行尾，空白后是补充说明。「2点开会」不算选了 2
  const byNumber = /^(\d+)(?:\s+(.*))?$/.exec(line);
  const numbered = byNumber && options[Number(byNumber[1]) - 1];
  if (numbered) return withNote(numbered, byNumber[2]);
  const named = options
    .filter((o) => line.slice(0, o.length).toLowerCase() === o.toLowerCase() && /^(\s|$)/.test(line.slice(o.length)))
    .sort((a, b) => b.length - a.length)[0];
  if (named) return withNote(named, line.slice(named.length));
  return { text: line };
}

function withNote(option: string, note = ""): Answer {
  const text = note.trim();
  return text ? { option, text } : { option };
}
