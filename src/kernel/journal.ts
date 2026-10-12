/**
 * 写前日志：一棵树一个只追加的文件（JSON Lines），放在内核专属目录，任何原语不可达（R11）。
 * 调用发起、调用完成、park 关闭，都先落盘再继续；恢复时据它重建没结束的树。
 * 后续加入：长期存在的树压缩日志。
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, truncateSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Result } from "./run";

/**
 * 日志的一行。runId 是这行所属的 Run；它发起的调用与 park 按发起顺序一起编号（seq），实现与装饰器的也一起编号。
 * 入参只存摘要：恢复时重新执行的 Run 会再发起同样的调用，按「序号、目标、入参摘要」比对。
 */
export type Entry =
  /** 第一行：树的根与外部给的入参 */
  | { type: "root"; runId: string; operation: string; input: unknown }
  /** 发起了一个调用；建了子 Run 时记下它的 runId，在内核就被拒的没有 */
  | { type: "call"; runId: string; seq: number; target: string; input: string; child?: string }
  /** 第 seq 个调用完成。同一个 Run 的 done 行的先后就是完成顺序 */
  | { type: "done"; runId: string; seq: number; result: Result }
  /** 第 seq 步的 park 关闭：送来了值，或被撤回 */
  | { type: "park"; runId: string; seq: number; result: Result }
  /** 恢复时重新执行了这个 Run，这是第 attempt 次 */
  | { type: "retry"; runId: string; attempt: number };

/** 日志里一个序号上记下的东西：调用（完成了才有 result），或关闭了的 park 的产出 */
export type Recorded =
  | { type: "call"; target: string; input: string; child?: string; result?: Result }
  | { type: "park"; result: Result };

/** 一个 Run 在日志里的记录：按序号记下的东西，与已执行了几次 */
export type RunLog = { entries: Map<number, Recorded>; attempt: number };

/** 一棵没结束的树：根，与树里每个 Run 的记录 */
export type Tree = { root: { runId: string; operation: string; input: unknown }; runs: Map<string, RunLog> };

/** 把一棵树的日志按行归并成每个 Run 的记录 */
export function fold(entries: Entry[]): Tree {
  let root: Tree["root"] | undefined;
  const runs = new Map<string, RunLog>();
  const of = (runId: string): RunLog => {
    let log = runs.get(runId);
    if (!log) runs.set(runId, (log = { entries: new Map(), attempt: 1 }));
    return log;
  };
  for (const e of entries) {
    if (e.type === "root") root = { runId: e.runId, operation: e.operation, input: e.input };
    else if (e.type === "call") of(e.runId).entries.set(e.seq, { type: "call", target: e.target, input: e.input, child: e.child });
    else if (e.type === "park") of(e.runId).entries.set(e.seq, { type: "park", result: e.result });
    else if (e.type === "retry") of(e.runId).attempt = e.attempt;
    else {
      const call = of(e.runId).entries.get(e.seq);
      if (call?.type === "call") call.result = e.result;
    }
  }
  if (!root) throw new Error("journal without root");
  return { root, runs };
}

export function digest(input: unknown): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(input) ?? "").digest("base64url");
}

/** 日志目录：文件以根 runId 命名。同步写并 fsync：落盘之后才返回，沙箱被突然回收也不丢 */
export class Journal {
  /** 根 runId → 打开着的文件 */
  private readonly files = new Map<string, number>();

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  append(root: string, entry: Entry): void {
    let fd = this.files.get(root);
    if (fd === undefined) {
      fd = openSync(this.path(root), "a");
      this.files.set(root, fd);
    }
    writeSync(fd, `${JSON.stringify(entry)}\n`);
    fsyncSync(fd);
  }

  /** 读出目录里每棵树的日志。崩溃时写了一半的末行截掉，免得之后追加的行接在它后面 */
  readAll(): Entry[][] {
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => {
        const path = join(this.dir, name);
        const text = readFileSync(path, "utf8");
        const complete = text.slice(0, text.lastIndexOf("\n") + 1);
        if (complete.length < text.length) truncateSync(path, Buffer.byteLength(complete));
        return complete
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Entry);
      });
  }

  /** 树结束或被取消：关掉并删除它的日志 */
  delete(root: string): void {
    const fd = this.files.get(root);
    if (fd !== undefined) closeSync(fd);
    this.files.delete(root);
    rmSync(this.path(root), { force: true });
  }

  private path(root: string): string {
    return join(this.dir, `${root}.jsonl`);
  }
}
