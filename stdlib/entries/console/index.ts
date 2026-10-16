/**
 * 终端入口：在终端里连续对话。普通一行交给装配指定的 Operation（say），「/命令」调对应的 Operation；
 * 要人回答的问题（park，ui 插件约定的格式）一次问一个，把回答 unpark 回去。
 * 输入只有一份：对话与回答问题排队读，不抢同一行。
 * 开始服务时先开场（greet），再收割上次由它发起、没做完的树（停着的问题会再问一次），然后进入对话；
 * 问题都在开场之后问，所以 greet 不能问人。
 * 启停是宿主的事：Ctrl-C 转给宿主（优雅关停，再按一次强杀）；/exit 或输入结束即不再服务，宿主随之关停。
 * 约定：say 的入参是 { text }，命令与 greet 的入参是 {}；返回给人看的文字（不是文字的按 JSON 显示，空文字不显示）。
 * 这些 Operation 都须声明 api。
 */

import { createInterface } from "node:readline";
import { entry } from "../../kernel/entry";
import type { Result } from "../../kernel/run";
import { lineReader, parse, render, type ReadLine } from "./prompt";

type Config = {
  /** 普通一行交给它 */
  say: string;
  /** 命令名 → Operation：输入「/命令名」时调它；/exit 固定为退出 */
  commands?: Record<string, string>;
  /** 开始服务时调一次，显示它返回的文字 */
  greet?: string;
  /** 第一句：有就先说它，再等输入 */
  first?: string;
  /** 缺省为进程的标准输入与输出（测试时换掉） */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
};

export default entry((config: Config, outside) => {
  const output = config.output ?? process.stdout;
  const print = (text: string) => void output.write(`${text}\n`);

  // 第一次读时才接上输入：装载、启动失败时不占着终端
  let rl: ReturnType<typeof createInterface> | undefined;
  let reader: ReadLine | undefined;
  const read: ReadLine = (prompt) => {
    if (!reader) {
      rl = createInterface({ input: config.input ?? process.stdin, output });
      // Ctrl-C 是机器的信号，交给宿主：等输入时它由 readline 收到，转给进程
      rl.on("SIGINT", () => process.kill(process.pid, "SIGINT"));
      reader = lineReader(rl, (text) => output.write(text));
    }
    return reader(prompt);
  };

  /** 正在等的树；关停时还在等就提示接着做 */
  let running: string | undefined;
  /** 等人回答的 park */
  const open = new Set<string>();
  /** 开场之后才开始问：恢复的树在启动时就会重新开出问题，不抢在开场白前面 */
  const greeted = Promise.withResolvers<void>();
  let questions = greeted.promise;

  /** 等树结束，显示结果或失败原因；关停了（树被杀）返回 false，不再往下 */
  async function finish(root: string): Promise<boolean> {
    running = root;
    const result = await outside.reap(root);
    if (shutdown(result)) return false;
    running = undefined;
    if (!result.ok) print(`\n失败（${result.by}）：${result.reason}`);
    else if (text(result.value)) print(`\n${text(result.value)}`);
    return true;
  }

  /** 发起一次调用并等它结束；发不起来（不是 api、入参不符等）显示原因 */
  function call(name: string, input: unknown): Promise<boolean> {
    let root: string;
    try {
      root = outside.submit(name, input);
    } catch (err) {
      print(`\n失败：${err instanceof Error ? err.message : String(err)}`);
      return Promise.resolve(true);
    }
    return finish(root);
  }

  /** 「/命令名」对应的 Operation；不是命令返回 undefined，当普通一行 */
  function commandOf(line: string): string | undefined {
    const word = /^\/(\S+)$/.exec(line)?.[1];
    return word !== undefined && config.commands && Object.hasOwn(config.commands, word) ? config.commands[word] : undefined;
  }

  /** 问一个问题，直到回答被收下；轮到时已不在等的（比如被取消）跳过，空行再问 */
  async function ask(id: string, payload: unknown): Promise<void> {
    while (open.has(id)) {
      const line = await read(render(payload));
      try {
        if (line === undefined) {
          if (open.has(id)) outside.withdraw(id, "输入已结束");
          return;
        }
        const reply = parse(payload ?? {}, line.trim());
        if (!reply) continue;
        if ("skip" in reply) outside.withdraw(id, reply.skip);
        else outside.unpark(id, reply);
      } catch (err) {
        print(err instanceof Error ? err.message : String(err));
      }
    }
  }

  return {
    afterParkOpen(e) {
      open.add(e.runId);
      // 一个问题出了错不能卡住后面的
      questions = questions.then(() => ask(e.runId, e.payload)).catch((err) => print(String(err)));
    },
    afterParkClose(e) {
      open.delete(e.runId);
    },
    // 关停时 park 不关（不发 park.closed），只有 run.killed
    afterRunKill(e) {
      open.delete(e.runId);
    },

    async serve() {
      if (config.greet && !(await call(config.greet, {}))) return;
      greeted.resolve();
      for (const root of outside.recovered()) if (!(await finish(root))) return;
      let line = config.first?.trim() || undefined;
      for (;;) {
        line ??= (await read("\n你> "))?.trim();
        if (line === undefined || line === "/exit") return;
        const command = commandOf(line);
        if (command && !(await call(command, {}))) return;
        if (!command && line && !(await call(config.say, { text: line }))) return;
        line = undefined;
      }
    },

    onStop() {
      if (running) print("\n已停下，进度已保存；再启动接着做");
      rl?.close();
    },
  };
});

/** 树在关停时被杀：进度在日志里，不算失败 */
function shutdown(result: Result): boolean {
  return !result.ok && result.by === "kernel" && result.reason === "shutdown";
}

function text(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
}
