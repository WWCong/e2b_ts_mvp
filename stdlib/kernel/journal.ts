/**
 * 写前日志：一棵树一个只追加的文件（JSON Lines），放在内核专属目录，任何原语不可达（R11）。
 * 它是事件流的持久投影：内核在提交阶段把每条事件先交给 commit，日志行都由事件推出，落盘后事件才交给插件、
 * 内核才往下走（先记后做）。插件看不到这一步，也拦不了。恢复时据它重建没结束的树（kernel.ts recover）。
 * 后续加入：长期存在的树压缩日志。
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, truncateSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { HarnessEvent } from "./events";
import { reject, type Result } from "./run";

/**
 * 日志的一行。runId 是这行所属的 Run；它发起的调用与 park 按发起顺序一起编号（seq），实现与装饰器的也一起编号。
 * 入参只存摘要：恢复时重新执行的 Run 会再发起同样的调用，按「序号、目标、入参摘要」比对。
 */
export type Entry =
  /**
   * 第一行：树的根与外部给的入参；artifact 是当时装配的产物摘要，恢复时比对；origin 是谁发起的，caller 是调用者。
   * spawn 起的树还有：发起它的 Run 与那是它的第几步（spawnedBy、step）、根的深度、不装载哪些包的装饰器
   */
  | {
      type: "root";
      runId: string;
      operation: string;
      input: unknown;
      artifact: string;
      origin?: string;
      caller?: string;
      spawnedBy?: string;
      step?: number;
      depth?: number;
      skipDecorators?: string[];
    }
  /** 发起了一个调用；建了子 Run 时记下它的 runId，在内核就被拒的没有 */
  | { type: "call"; runId: string; seq: number; target: string; input: string; child?: string }
  /** 第 seq 步 spawn：起了一棵树（结果是它根的 runId），或被拒。发起即完成，在新树的 root 行之后写 */
  | { type: "spawn"; runId: string; seq: number; target: string; input: string; result: Result }
  /** 第 seq 个调用完成。同一个 Run 的 done 行的先后就是完成顺序 */
  | { type: "done"; runId: string; seq: number; result: Result }
  /** 第 seq 步的 park 关闭：送来了值，或被撤回 */
  | { type: "park"; runId: string; seq: number; result: Result }
  /** 恢复时重新执行了这个 Run，这是第 attempt 次 */
  | { type: "retry"; runId: string; attempt: number }
  /** 最后一行：根 Run 结束了（退出或被取消），结果留到被取走（run.reaped）再删；at 是结束的时刻 */
  | { type: "exit"; runId: string; result: Result; at: number };

/**
 * 日志里一个序号上记下的东西：调用（完成了才有 result），或关闭了的 park 的产出。
 * order 是完成顺序：这个 Run 的第几个完成的（调用与 park 一起数），已完成的才有。
 */
export type Recorded =
  | { type: "call"; target: string; input: string; child?: string; result?: Result; order?: number }
  | { type: "spawn"; target: string; input: string; result: Result; order: number }
  | { type: "park"; result: Result; order: number };

/** 一个 Run 在日志里的记录：按序号记下的东西，与已执行了几次 */
export type RunLog = { entries: Map<number, Recorded>; attempt: number };

/** 一棵树：根，与树里每个 Run 的记录；已结束、结果还没被取走的带着 exit */
export type Tree = {
  root: Omit<Extract<Entry, { type: "root" }>, "type">;
  runs: Map<string, RunLog>;
  exit?: { result: Result; at: number };
};

/** 把一棵树的日志按行归并成每个 Run 的记录 */
export function fold(entries: Entry[]): Tree {
  let root: Tree["root"] | undefined;
  let exit: Tree["exit"];
  const runs = new Map<string, RunLog>();
  const completed = new Map<string, number>();
  const nextOrder = (runId: string) => {
    const order = completed.get(runId) ?? 0;
    completed.set(runId, order + 1);
    return order;
  };
  const of = (runId: string): RunLog => {
    let log = runs.get(runId);
    if (!log) runs.set(runId, (log = { entries: new Map(), attempt: 1 }));
    return log;
  };
  for (const e of entries) {
    if (e.type === "root") {
      const { type: _, ...rest } = e;
      root = rest;
    } else if (e.type === "call") of(e.runId).entries.set(e.seq, { type: "call", target: e.target, input: e.input, child: e.child });
    else if (e.type === "spawn") of(e.runId).entries.set(e.seq, { type: "spawn", target: e.target, input: e.input, result: e.result, order: nextOrder(e.runId) });
    else if (e.type === "park") of(e.runId).entries.set(e.seq, { type: "park", result: e.result, order: nextOrder(e.runId) });
    else if (e.type === "retry") of(e.runId).attempt = e.attempt;
    else if (e.type === "exit") exit = { result: e.result, at: e.at };
    else {
      const call = of(e.runId).entries.get(e.seq);
      if (call?.type === "call") Object.assign(call, { result: e.result, order: nextOrder(e.runId) });
    }
  }
  if (!root) throw new Error("journal without root");
  return { root, runs, exit };
}

export function digest(input: unknown): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(input) ?? "").digest("base64url");
}

/** 在途 Run 在日志里的位置：所在树的根（文件），父与它是父的第几步；spawned：所在的树是 spawn 起的 */
type Place = { root: string; parent?: string; step?: number; spawned?: boolean };

/** 日志目录：文件以根 runId 命名。同步写并 fsync：落盘之后才返回，沙箱被突然回收也不丢 */
export class Journal {
  /** 根 runId → 打开着的文件 */
  private readonly files = new Map<string, number>();
  /** 在途 Run → 位置。Run 结束或被杀即移除：之后它的事件（如被杀后还在跑的代码发起的调用）不再记 */
  private readonly places = new Map<string, Place>();

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  /**
   * 提交阶段：由事件推出日志行并落盘。
   * - run.started：根记 root 行（外部给的原样入参、产物摘要与谁发起的；spawn 起的还有发起方等）；子 Run 记父的 call 行（入参只存摘要）；
   *   恢复时重新执行的（带 attempt）只记 retry 行，它的 call 行已在日志里
   * - run.spawned：发起方的 spawn 行，在新树的 root 行之后：两行之间崩溃，恢复时发起方重新执行到这一步，接回这棵树（kernel.ts recover）
   * - call.rejected：发起方的 call 行（没有子 Run）与 done 行；spawn 被拒是 spawn 行
   * - run.exited / run.killed：父还在就记父的 done 行（被杀的记内核的拒绝）。根退出或被取消记 exit 行，结果留到被取走，
   *   spawn 起的没人取，直接删；关停保留，重启后接着跑；别的原因（diverged、恢复时根建不起来）移到 diverged/ 留着排查
   * - run.reaped：结果取走了（或过期），删日志
   * - park.closed：park 行
   * - tree.recovered：记下恢复的树的根
   */
  commit(event: HarnessEvent): void {
    switch (event.type) {
      case "tree.recovered":
        return void this.places.set(event.runId, { root: event.runId });
      case "run.started": {
        const parent = event.parent === undefined ? undefined : this.places.get(event.parent);
        if (event.parent !== undefined && !parent) return;
        const spawned = parent?.spawned ?? event.spawnedBy !== undefined;
        const place: Place = { root: parent?.root ?? event.runId, parent: event.parent, step: event.step, spawned };
        this.places.set(event.runId, place);
        const { runId, operation, input } = event;
        if (event.attempt) return this.append(place.root, { type: "retry", runId, attempt: event.attempt });
        if (event.parent === undefined) {
          const { artifact, origin, caller, spawnedBy, step, depth, skipDecorators } = event;
          const spawn = spawnedBy === undefined ? {} : { spawnedBy, step, depth, skipDecorators };
          return this.append(runId, { type: "root", runId, operation, input, artifact: artifact!, origin, caller, ...spawn });
        }
        return this.append(place.root, {
          type: "call",
          runId: event.parent,
          seq: event.step!,
          target: operation,
          input: digest(input),
          child: runId,
        });
      }
      case "run.spawned": {
        const place = this.places.get(event.runId);
        const { runId, step: seq, target } = event;
        if (place) this.append(place.root, { type: "spawn", runId, seq, target, input: digest(event.input), result: { ok: true, value: event.child } });
        return;
      }
      case "call.rejected": {
        const place = this.places.get(event.runId);
        if (!place) return;
        const { runId, step: seq, target, result } = event;
        if (event.spawn) return this.append(place.root, { type: "spawn", runId, seq, target, input: digest(event.input), result });
        this.append(place.root, { type: "call", runId, seq, target, input: digest(event.input) });
        return this.append(place.root, { type: "done", runId, seq, result });
      }
      case "park.closed": {
        const place = this.places.get(event.runId);
        if (place) this.append(place.root, { type: "park", runId: event.runId, seq: event.step, result: event.result });
        return;
      }
      case "run.exited":
      case "run.killed": {
        const place = this.places.get(event.runId);
        if (!place) return;
        this.places.delete(event.runId);
        if (place.parent === undefined) return this.end(place, event);
        // 父已结束或被杀（整棵树在被杀）：不记
        if (!this.places.has(place.parent)) return;
        const result = event.type === "run.exited" ? event.result : reject("kernel", event.reason);
        return this.append(place.root, { type: "done", runId: place.parent, seq: place.step!, result });
      }
      case "run.reaped":
        return this.delete(event.runId);
    }
  }

  /** 树结束：退出或被取消记 exit 行，结果留到被取走（spawn 起的没人取，直接删）；关停只关文件；别的原因移到 diverged/ */
  private end({ root, spawned }: Place, event: Extract<HarnessEvent, { type: "run.exited" | "run.killed" }>): void {
    if (event.type === "run.killed" && event.reason === "shutdown") return this.close(root);
    if (event.type === "run.killed" && event.reason !== "cancelled") return this.retire(root);
    if (spawned) return this.delete(root);
    const result = event.type === "run.exited" ? event.result : reject("kernel", event.reason);
    this.append(root, { type: "exit", runId: root, result, at: event.ts });
    this.close(root);
  }

  private append(root: string, entry: Entry): void {
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

  private delete(root: string): void {
    this.close(root);
    rmSync(this.path(root), { force: true });
  }

  private retire(root: string): void {
    this.close(root);
    if (!existsSync(this.path(root))) return;
    mkdirSync(join(this.dir, "diverged"), { recursive: true });
    renameSync(this.path(root), join(this.dir, "diverged", `${root}.jsonl`));
  }

  private close(root: string): void {
    const fd = this.files.get(root);
    if (fd !== undefined) closeSync(fd);
    this.files.delete(root);
  }

  private path(root: string): string {
    return join(this.dir, `${root}.jsonl`);
  }
}
