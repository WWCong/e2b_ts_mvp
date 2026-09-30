/**
 * 写前日志：一棵树一个只追加的文件（JSON Lines），放在内核专属目录，任何原语不可达（R11）。
 * 调用发起、调用完成、park 关闭，都先落盘再继续；恢复时据它重建没结束的树。
 * 后续加入：恢复时读取；长期存在的树压缩日志。
 */

import { closeSync, fsyncSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Result } from "./run";

/**
 * 日志的一行。runId 是这行所属的 Run；它发起的调用按发起顺序编号（seq），实现与装饰器的调用一起编号。
 * 入参只存摘要：恢复时重新执行的 Run 会再发起同样的调用，按「序号、目标、入参摘要」比对。
 */
export type Entry =
  /** 第一行：树的根与外部给的入参 */
  | { type: "root"; runId: string; operation: string; input: unknown }
  /** 发起了一个调用；建了子 Run 时记下它的 runId，在内核就被拒的没有 */
  | { type: "call"; runId: string; seq: number; target: string; input: string; child?: string }
  /** 第 seq 个调用完成。同一个 Run 的 done 行的先后就是完成顺序 */
  | { type: "done"; runId: string; seq: number; result: Result }
  /** park 关闭：送来了值，或被撤回 */
  | { type: "park"; runId: string; result: Result };

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
