import { describe, expect, test } from "bun:test";
import {
  KERNEL,
  RUN_TRANSITIONS,
  Rejected,
  canTransition,
  isTerminal,
  ok,
  rejection,
  unwrap,
  type RunStatus,
} from "../../src/kernel/types.ts";

describe("Run 状态机", () => {
  const all: RunStatus[] = ["init", "running", "waiting", "exited", "killed"];
  const allowed = new Set([
    "init>running",
    "running>waiting",
    "running>exited",
    "running>killed",
    "waiting>running",
    "waiting>killed",
  ]);

  test("只允许 3.4 图里的转换", () => {
    for (const from of all) {
      for (const to of all) {
        expect(canTransition(from, to)).toBe(allowed.has(`${from}>${to}`));
      }
    }
  });

  test("exited 与 killed 是终态", () => {
    expect(all.filter(isTerminal)).toEqual(["exited", "killed"]);
    expect(RUN_TRANSITIONS.exited).toEqual([]);
    expect(RUN_TRANSITIONS.killed).toEqual([]);
  });
});

describe("产出与拒绝", () => {
  test("rejection 缺省不可重试，error 只在指定时出现", () => {
    expect(rejection("safety", "blocked")).toEqual({
      ok: false,
      by: "safety",
      reason: "blocked",
      retryable: false,
    });
    expect(rejection("fs.read", "ENOENT", { retryable: true, error: true })).toEqual({
      ok: false,
      by: "fs.read",
      reason: "ENOENT",
      retryable: true,
      error: true,
    });
  });

  test("unwrap 取出成功值", () => {
    expect(unwrap(ok({ text: "hi" }))).toEqual({ text: "hi" });
  });

  test("unwrap 遇到拒绝抛 Rejected，带同样的字段", () => {
    const r = rejection(KERNEL, "depth exceeded", { retryable: false });
    let thrown: unknown;
    try {
      unwrap(r);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Rejected);
    const err = thrown as Rejected;
    expect(err.name).toBe("Rejected");
    expect(err.by).toBe("kernel");
    expect(err.reason).toBe("depth exceeded");
    expect(err.retryable).toBe(false);
    expect(err.error).toBe(false);
    expect(err.message).toBe("rejected by kernel: depth exceeded");
  });

  test("Rejected 能还原成拒绝结果", () => {
    for (const r of [
      rejection("budget", "over", { retryable: true }),
      rejection("x.y", "boom", { error: true }),
    ]) {
      expect(new Rejected(r).toRejection()).toEqual(r);
    }
  });
});
