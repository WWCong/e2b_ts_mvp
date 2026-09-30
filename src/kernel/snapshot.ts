/**
 * 快照（3.6）：树空闲时写，树里有 Run 重新进入 running 之前删；原子写入内核专属目录（R11）。
 * 后续加入：恢复时读取与重放；产物摘要。
 */

import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Result } from "./run";

/**
 * 一次调用的记录（附 A 的 calls）。实现与装饰器发起的调用记在同一个 Run 名下，按发起顺序排列，下标即序号。
 * 恢复时重新执行的 Run 按「序号、目标、入参」比对它：已完成的回送 result，在途的接回 child。
 * 结果要能 JSON 序列化，否则回放拿到的与原来不同。
 * 后续加入（script）：after、取到的时间与随机数；spawn。
 */
export type CallRecord = {
  target: string;
  /** 入参摘要：只用来比对，不存原文 */
  input: string;
  /** 建了子 Run 时它的 runId；在内核就被拒的调用没有 */
  child?: string;
  /** 结果与完成顺序（这个 Run 第几个完成的调用）：已完成的调用才有 */
  result?: Result;
  order?: number;
};

/** 快照里的一个 Run：都在 waiting，等子 Run 或等 park */
export type SnapshotRun = {
  runId: string;
  operation: string;
  input: unknown;
  depth: number;
  parent?: string;
  calls: CallRecord[];
  park?: { schema: Record<string, unknown>; payload: unknown };
};

/** 一棵空闲的树；runs 里父在子前 */
export type Snapshot = { root: string; runs: SnapshotRun[] };

export function digest(input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(input) ?? "")
    .digest("base64url");
}

/** 快照目录：一棵树一个文件，以根 runId 命名。同步读写：删除必须先于送值，同步最简单（R11） */
export class SnapshotStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  /** 先写临时文件再改名：崩溃时不会留下写了一半的快照 */
  write(snapshot: Snapshot): void {
    const file = this.file(snapshot.root);
    writeFileSync(`${file}.tmp`, JSON.stringify(snapshot, null, 2));
    renameSync(`${file}.tmp`, file);
  }

  delete(root: string): void {
    rmSync(this.file(root), { force: true });
  }

  private file(root: string): string {
    return join(this.dir, `${root}.json`);
  }
}
