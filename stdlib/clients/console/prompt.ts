/**
 * 终端里按行读输入，渲染与解析给人看的问题（ui 插件约定的格式：Question → Answer）。
 */

import type { Interface } from "node:readline";
import type { Answer, Question } from "../../plugins/ui";

const HINT_OPTIONS = "输入序号或选项选择，后面可空格接补充说明；也可以直接写别的回答。/skip [原因] 不回答";
const HINT_TEXT = "直接写回答。/skip [原因] 不回答";

/** 先显示提示，再读一行；输入结束返回 undefined */
export type ReadLine = (prompt: string) => Promise<string | undefined>;

/** 按行读。排队：前一次读完才轮到下一次，对话与回答问题不会抢同一行 */
export function lineReader(rl: Interface, write: (text: string) => void): ReadLine {
  // 用异步迭代器按行取：会缓存已读到的行（管道输入时 rl.question 会丢行）
  const lines = rl[Symbol.asyncIterator]();
  let queue: Promise<unknown> = Promise.resolve();
  return (prompt) => {
    const read = queue.then(async () => {
      write(prompt);
      const line = await lines.next();
      return line.done ? undefined : String(line.value);
    });
    queue = read.catch(() => {});
    return read;
  };
}

/** 问题的提示：约定格式的列出选项与说明；别的 payload 原样给出 */
export function render(payload: unknown): string {
  const { question, options } = (payload ?? {}) as Partial<Question>;
  if (typeof question !== "string") return `\n? ${JSON.stringify(payload)}\n> `;
  const choices = options?.map((o, i) => `  ${i + 1}. ${o}\n`).join("") ?? "";
  return `\n? ${question}\n${choices}（${options ? HINT_OPTIONS : HINT_TEXT}）\n> `;
}

/** 一行输入 → 回答或撤回；空行返回 undefined */
export function parse({ options }: Partial<Question>, line: string): Answer | { skip: string } | undefined {
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
