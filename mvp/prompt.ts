/**
 * 在终端里回答 park：认得 ui 插件约定的 payload（Question），一次问一个，把回答 unpark 回去。
 * 方案里由 UI 渲染 agent-ui 格式的 park（3.5）；这里是入口程序的一个订阅者。
 */

import type { Interface } from "node:readline";
import type { Kernel } from "../src/kernel/kernel";
import type { Question } from "./plugins/ui";

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
    const { question, options } = e.payload as Question;
    queue = queue.then(async () => {
      // 轮到时已不在等的（比如被取消）跳过；回答不符合 schema 就再问
      while (open.has(e.runId)) {
        process.stdout.write(`\n? ${question}${options ? ` [${options.join("/")}]` : ""}\n> `);
        const line = await lines.next();
        if (line.done) {
          if (open.has(e.runId)) kernel.withdraw(e.runId, "输入已结束");
          return;
        }
        try {
          kernel.unpark(e.runId, line.value.trim());
        } catch (err) {
          console.log((err as Error).message);
        }
      }
    });
  });
}
