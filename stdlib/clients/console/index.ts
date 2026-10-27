/**
 * 终端客户端：在终端里连续对话。它在 Harness 外面，经 HTTP 服务接口（stdlib/clients/http.ts）用 Harness，
 * 能做的就是任何客户端能做的：调 expose 里的 Operation、回答问题、看事件。
 * - 普通一行交给 say（入参 { text }），「/命令」调对应的 Operation（入参 {}），/exit、输入结束或 Ctrl-C 退出
 * - 要人回答的问题（park，ui 插件约定的格式）一次问一个：事件流里新开的，加上连上时已经在等的
 * - 连上时先开场（greet），再接着等自己上次发起、还没取走结果的树（断开或 Harness 重启过的），然后进入对话
 * - 事件流按 Run 树画出来（tree），各 Operation 的摘要规则由应用给（brief）
 * 输入只有一份：对话与回答问题排队读，不抢同一行；问题都在开场之后问，所以 greet 不能问人。
 * 退出只是客户端走了：在途的那一轮在服务端照常跑，结果留着，问题照旧等着，下次连上接着显示。
 * Harness 停下（事件流断开）时客户端也退出。
 * 约定：返回给人看的文字（不是文字的按 JSON 显示，空文字不显示）。
 */

import { createInterface } from "node:readline";
import type { Result } from "../../kernel/run";
import type { Client } from "../http";
import { lineReader, parse, render, type ReadLine } from "./prompt";
import { eventTree, type Brief } from "./tree";

export type { Brief } from "./tree";

export type ConsoleConfig = {
  client: Client;
  /** 普通一行交给它 */
  say: string;
  /** 命令名 → Operation：输入「/命令名」时调它；/exit 固定为退出 */
  commands?: Record<string, string>;
  /** 连上时调一次，显示它返回的文字 */
  greet?: string;
  /** 第一句：有就先说它，再等输入 */
  first?: string;
  /** 画 Run 树；缺省画 */
  tree?: boolean;
  brief?: Brief;
  /** 外面要它退出（比如还没开始读输入时的 Ctrl-C） */
  signal?: AbortSignal;
  /** 缺省为进程的标准输入与输出（测试时换掉） */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
};

/** 退出时：pending 表示还有这个客户端发起的一轮没拿到结果（在服务端接着做，或随 Harness 停下、重启后接着做） */
export async function runConsole(config: ConsoleConfig): Promise<{ pending: boolean }> {
  const { client } = config;
  const output = config.output ?? process.stdout;
  const print = (text: string) => void output.write(`${text}\n`);

  // 退出：不再等任何东西，在途的请求中止（服务端照常），事件流断开
  const abort = new AbortController();
  const quit = () => abort.abort();
  config.signal?.addEventListener("abort", quit, { once: true });

  let rl: ReturnType<typeof createInterface> | undefined;
  let reader: ReadLine | undefined;
  /** 读一行；输入结束即退出 */
  const read = async (prompt: string): Promise<string | undefined> => {
    if (!reader) {
      rl = createInterface({ input: config.input ?? process.stdin, output });
      rl.on("SIGINT", quit);
      reader = lineReader(rl, (text) => output.write(text));
    }
    const line = await reader(prompt);
    if (line === undefined) quit();
    return line;
  };
  abort.signal.addEventListener("abort", () => rl?.close(), { once: true });

  /** 正在等结果的调用；退出时还有，或有一轮随 Harness 停下了（stalled），就是 pending */
  let busy = 0;
  let stalled = false;
  const pending = () => busy > 0 || stalled;
  /** 等人回答的问题：id → payload */
  const open = new Map<string, unknown>();
  /** 开场之后才开始问 */
  const greeted = Promise.withResolvers<void>();
  let questions = greeted.promise;

  /** 一个问题排进队；已经在队里的不重复问 */
  const offer = (id: string, payload: unknown) => {
    if (open.has(id)) return;
    open.set(id, payload);
    questions = questions.then(() => ask(id)).catch((err) => print(String(err)));
  };

  /** 问一个问题，直到回答被收下；轮到时已不在等的（被别人答了、被取消）跳过，空行再问 */
  async function ask(id: string): Promise<void> {
    while (open.has(id) && !abort.signal.aborted) {
      const payload = open.get(id);
      const line = await read(render(payload));
      if (line === undefined || !open.has(id)) return;
      const reply = parse(payload ?? {}, line.trim());
      if (!reply) continue;
      try {
        if ("skip" in reply) await client.withdraw(id, reply.skip);
        else await client.answer(id, reply);
        open.delete(id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 已经不在等了（比如刚被别的客户端答了）
        if (message.startsWith("not parked")) return void open.delete(id);
        print(message);
      }
    }
  }

  /** 等一次调用的结果并显示；退出了，或 Harness 停下（树被关停）就返回 false，不再往下 */
  async function show(reply: Promise<{ runId: string; result: Result }>): Promise<boolean> {
    busy++;
    let result: Result;
    try {
      ({ result } = await reply);
    } catch (err) {
      // 退出了：不等了，那一轮在服务端照常（busy 留着，算 pending）
      if (abort.signal.aborted) return false;
      busy--;
      print(`\n失败：${err instanceof Error ? err.message : String(err)}`);
      return true;
    }
    busy--;
    if (!result.ok && result.by === "kernel" && result.reason === "shutdown") {
      stalled = true;
      quit();
      return false;
    }
    if (!result.ok) print(`\n失败（${result.by}）：${result.reason}`);
    else if (text(result.value)) print(`\n${text(result.value)}`);
    return true;
  }

  const call = (name: string, input: unknown) => show(client.call(name, input, abort.signal));

  /** 「/命令名」对应的 Operation；不是命令返回 undefined，当普通一行 */
  const commandOf = (line: string) => {
    const word = /^\/(\S+)$/.exec(line)?.[1];
    return word !== undefined && config.commands && Object.hasOwn(config.commands, word) ? config.commands[word] : undefined;
  };

  // 先接上事件流，再取现状：之后开出的问题都收得到
  const tree = config.tree === false ? undefined : eventTree(print, config.brief);
  const { closed } = await client.events((e) => {
    tree?.(e);
    if (e.type === "park.opened") offer(e.runId, e.payload);
    // 关停时 park 不关（不发 park.closed），只有 run.killed
    if (e.type === "park.closed" || e.type === "run.killed") open.delete(e.runId);
  }, abort.signal);
  void closed.then(() => {
    if (abort.signal.aborted) return;
    print("\nHarness 断开了");
    quit();
  });

  try {
    if (config.greet && !(await call(config.greet, {}))) return { pending: pending() };
    // 自己上次发起、还没取走结果的：先说一声，问完还在等的问题，再接着等它们的结果
    const mine = (await client.runs()).filter((r) => r.origin === client.origin);
    if (mine.length > 0) print(`\n接着等上次没做完的 ${mine.map((r) => r.operation).join("、")}…`);
    for (const park of await client.parks()) offer(park.id, park.payload);
    greeted.resolve();
    for (const run of mine) if (!(await show(client.result(run.runId, abort.signal)))) return { pending: pending() };
    let line = config.first?.trim() || undefined;
    while (!abort.signal.aborted) {
      line ??= (await read("\n你> "))?.trim();
      if (line === undefined || line === "/exit") break;
      const command = commandOf(line);
      if (command && !(await call(command, {}))) break;
      if (!command && line && !(await call(config.say, { text: line }))) break;
      line = undefined;
    }
  } finally {
    quit();
    await closed;
  }
  return { pending: pending() };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
}
