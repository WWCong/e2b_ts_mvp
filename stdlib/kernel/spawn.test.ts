import { beforeEach, describe, expect, test } from "bun:test";
import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { HarnessEvent } from "./events";
import type { Entry } from "./journal";
import { Kernel, type KernelConfig } from "./kernel";
import type { Ctx } from "./run";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "spawn-"));
});

const ask = (payload: unknown) => ({ schema: { type: "string" }, payload });

/**
 * 装配一个内核（还没启动）：demo_start 用 spawn 起 demo_bg 就返回；demo_bg 等 gate 后返回入参的两倍；
 * demo_flow 先 spawn demo_bg 再 park；demo_ask 在 park 上等。flow 可以换掉 demo_flow 的实现
 */
function assemble(config: KernelConfig = {}, flow?: (ctx: Ctx) => Promise<unknown>) {
  const kernel = new Kernel(config);
  const events: HarnessEvent[] = [];
  kernel.events.subscribe((e) => events.push(e));
  const gate = Promise.withResolvers<void>();
  kernel.register({ name: "demo_start", input: z.number(), impl: (ctx, n: number) => ctx.spawn("demo_bg", n) });
  kernel.register({
    name: "demo_bg",
    input: z.number(),
    impl: async (_ctx, n: number) => {
      await gate.promise;
      return n * 2;
    },
  });
  kernel.register({ name: "demo_ask", input: z.string(), impl: (ctx, q: string) => ctx.park(ask(q)) });
  kernel.register({
    name: "demo_flow",
    input: z.null(),
    impl: flow ?? (async (ctx) => [await ctx.spawn("demo_ask", "后台"), await ctx.park(ask("前台"))]),
  });
  const of = <T extends HarnessEvent["type"]>(type: T) => events.filter((e): e is Extract<HarnessEvent, { type: T }> => e.type === type);
  return { kernel, events, gate, of };
}

async function boot(config: KernelConfig = {}, flow?: (ctx: Ctx) => Promise<unknown>) {
  const assembled = assemble(config, flow);
  const roots = await assembled.kernel.boot();
  return { ...assembled, roots };
}

/** 等到条件成立，最多一秒 */
async function until(cond: () => boolean) {
  for (let t0 = Date.now(); !cond(); await Bun.sleep(1)) if (Date.now() - t0 > 1000) throw new Error("timed out");
}

const lines = (journalDir: string, root: string) =>
  readFileSync(join(journalDir, `${root}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Entry);

describe("spawn", () => {
  test("另起一棵树，不等它：返回新树根的 runId；新树没有父，记下发起方，深度接着往下数；结果没人取，只在事件里", async () => {
    const { kernel, gate, of } = await boot();

    const root = kernel.submit("demo_start", 1);
    const result = await kernel.reap(root);
    expect(result).toEqual({ ok: true, value: { ok: true, value: expect.any(String) } });
    const child = (result as { value: { value: string } }).value.value;

    expect(of("run.started").find((e) => e.runId === child)).toMatchObject({
      operation: "demo_bg",
      parent: undefined,
      spawnedBy: root,
      step: 0,
      depth: 1,
      skipDecorators: ["demo"],
      artifact: expect.any(String),
    });
    expect(of("run.spawned")).toEqual([expect.objectContaining({ runId: root, step: 0, target: "demo_bg", input: 1, child })]);
    // 发起方的 run.spawned 紧跟在新树根的 run.started 之后
    const order = [...of("run.started"), ...of("run.spawned")].sort((a, b) => a.seq - b.seq);
    expect(order.map((e) => [e.type, e.runId])).toEqual([
      ["run.started", root],
      ["run.started", child],
      ["run.spawned", root],
    ]);
    // 发起方早结束了，新树还在跑；它不在等人取结果的树里
    expect(of("run.exited").map((e) => e.runId)).toEqual([root]);
    expect(kernel.runs()).toEqual([]);

    gate.resolve();
    await until(() => of("run.exited").length === 2);
    expect(of("run.exited")[1]).toMatchObject({ runId: child, result: { ok: true, value: 2 } });
    await expect(kernel.reap(child)).rejects.toThrow(`unknown run: ${child}`);
  });

  test("与调用同样的检查，被拒以拒绝返回、不起树，发 call.rejected（带 spawn）；script 只能 spawn 公开的", async () => {
    const { kernel, of } = await boot();
    kernel.register({ name: "demo_hidden", input: z.null(), impl: async () => null });
    kernel.register({ name: "demo_open", usage: "公开的", public: true, input: z.null(), impl: async () => null });
    kernel.register({
      name: "demo_tries",
      input: z.null(),
      only: ["demo_bg", "demo_nope"],
      impl: (ctx) => Promise.all([ctx.spawn("demo_nope", null), ctx.spawn("demo_bg", "x"), ctx.spawn("demo_start", 1)]),
    });
    kernel.register({
      name: "demo_script",
      input: z.null(),
      script: true,
      impl: (ctx) => Promise.all([ctx.spawn("demo_hidden", null), ctx.spawn("demo_open", null)]),
    });

    const tries = await kernel.reap(kernel.submit("demo_tries", null));
    expect(tries).toEqual({
      ok: true,
      value: [
        { ok: false, by: "kernel", reason: "unknown operation: demo_nope", retryable: false },
        { ok: false, by: "kernel", reason: expect.stringContaining("invalid input for demo_bg"), retryable: true },
        { ok: false, by: "kernel", reason: "demo_start is not in the surface of demo_tries", retryable: false },
      ],
    });
    expect(of("call.rejected").map((e) => [e.target, e.step, e.spawn])).toEqual([
      ["demo_nope", 0, true],
      ["demo_bg", 1, true],
      ["demo_start", 2, true],
    ]);

    expect(await kernel.reap(kernel.submit("demo_script", null))).toEqual({
      ok: true,
      value: [
        { ok: false, by: "kernel", reason: "demo_hidden is not public: demo_script is a script", retryable: false },
        { ok: true, value: expect.any(String) },
      ],
    });
    expect(of("run.started").map((e) => e.operation)).toEqual(["demo_tries", "demo_script", "demo_open"]);
  });

  test("发起的包的装饰器不包新树，从新树里再 spawn 的接着不包：装饰器互相 spawn 也停得下来", async () => {
    const { kernel, of } = assemble({ defaultDecorators: ["audit_log", "grade_sample"] });
    kernel.registerDecorator({
      id: "audit_log",
      onError: "closed",
      fn: async (ctx, _run, next) => {
        const r = await next();
        await ctx.spawn("audit_flush", null);
        return r;
      },
    });
    kernel.registerDecorator({
      id: "grade_sample",
      onError: "closed",
      fn: async (ctx, run, next) => {
        const r = await next();
        await ctx.spawn("grade_score", run.operation);
        return r;
      },
    });
    kernel.register({ name: "demo_work", input: z.null(), impl: async () => "done" });
    kernel.register({ name: "audit_flush", input: z.null(), impl: async () => null });
    kernel.register({ name: "grade_score", input: z.string(), impl: async () => 1 });
    await kernel.boot();

    expect(await kernel.reap(kernel.submit("demo_work", null))).toEqual({ ok: true, value: "done" });
    await until(() => of("run.exited").length === 5);
    await Bun.sleep(5);
    expect(of("run.started").map((e) => [e.operation, e.chain, e.skipDecorators])).toEqual(
      expect.arrayContaining([
        ["demo_work", ["audit_log", "grade_sample"], undefined],
        ["audit_flush", ["grade_sample"], ["audit"]],
        ["grade_score", [], ["audit", "grade"]],
        ["grade_score", ["audit_log"], ["grade"]],
        ["audit_flush", [], ["grade", "audit"]],
      ]),
    );
    expect(of("run.started")).toHaveLength(5);
  });

  test("取消发起方不碰新树；新树能单独取消；深度保险丝照样管", async () => {
    const { kernel, of } = await boot({ kernel: { maxDepth: 2 } });
    kernel.register({
      name: "demo_hold",
      input: z.null(),
      impl: async (ctx) => {
        await ctx.spawn("demo_ask", "后台");
        return ctx.park(ask("前台"));
      },
    });
    kernel.register({ name: "demo_loop", input: z.number(), impl: (ctx, n: number) => ctx.spawn("demo_loop", n + 1) });

    const root = kernel.submit("demo_hold", null);
    await until(() => of("park.opened").length === 2);
    const child = of("run.spawned")[0]!.child;
    kernel.cancel(root);
    expect(await kernel.reap(root)).toMatchObject({ ok: false, reason: "cancelled" });
    expect(kernel.parks().map((p) => [p.id, p.root])).toEqual([[child, child]]);
    expect(kernel.cancel(child)).toBe(true);
    expect(of("run.killed").map((e) => [e.runId, e.reason])).toEqual([
      [root, "cancelled"],
      [child, "cancelled"],
    ]);

    await kernel.reap(kernel.submit("demo_loop", 0));
    await until(() => of("call.rejected").length === 1);
    expect(of("run.started").filter((e) => e.operation === "demo_loop").map((e) => e.depth)).toEqual([0, 1, 2]);
    expect(of("call.rejected")[0]).toMatchObject({ target: "demo_loop", spawn: true, result: { reason: "max depth 2 exceeded" } });
  });

  test("写前日志：新树一个文件，root 行记下发起方；发起方记 spawn 行；新树结束即删（没人取），被取消也删", async () => {
    const { kernel, gate, of } = await boot({ journalDir: dir });

    const root = kernel.submit("demo_start", 1);
    await kernel.wait(root);
    const child = of("run.spawned")[0]!.child;
    expect(lines(dir, child)).toEqual([
      expect.objectContaining({ type: "root", runId: child, operation: "demo_bg", input: 1, spawnedBy: root, step: 0, depth: 1, skipDecorators: ["demo"] }),
    ]);
    expect(lines(dir, root).map((e) => e.type)).toEqual(["root", "spawn", "exit"]);
    expect(lines(dir, root)[1]).toEqual({ type: "spawn", runId: root, seq: 0, target: "demo_bg", input: expect.any(String), result: { ok: true, value: child } });

    await kernel.reap(root);
    gate.resolve();
    await until(() => of("run.exited").length === 2);
    expect(readdirSync(dir)).toEqual([]);

    const flow = kernel.submit("demo_flow", null);
    await until(() => of("park.opened").length === 2);
    const asked = of("run.spawned")[1]!.child;
    kernel.cancel(asked);
    expect(readdirSync(dir)).toEqual([`${flow}.jsonl`]);
  });

  test("关停后重启：新树也恢复，但不在要收割的树里；发起方重新执行到 spawn 不再发起，拿回原来的 runId", async () => {
    const one = await boot({ journalDir: dir });
    const root = one.kernel.submit("demo_flow", null);
    await until(() => one.of("park.opened").length === 2);
    const child = one.of("run.spawned")[0]!.child;
    await one.kernel.stop(100);
    expect(one.of("run.killed").map((e) => e.reason)).toEqual(["shutdown", "shutdown"]);
    expect(readdirSync(dir).sort()).toEqual([`${child}.jsonl`, `${root}.jsonl`].sort());

    const two = await boot({ journalDir: dir });
    expect(two.roots).toEqual([root]);
    await until(() => two.of("park.opened").length === 2);
    expect(two.of("run.started").map((e) => [e.operation, e.runId, e.attempt])).toEqual(
      expect.arrayContaining([
        ["demo_flow", root, 2],
        ["demo_ask", child, 2],
      ]),
    );
    expect(two.of("run.started")).toHaveLength(2);
    expect(two.of("run.spawned")).toEqual([]);

    two.kernel.unpark(root, "好");
    expect(await two.kernel.reap(root)).toEqual({ ok: true, value: [{ ok: true, value: child }, "好"] });
    two.kernel.unpark(child, "也好");
    await until(() => two.of("run.exited").length === 2);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("崩溃在新树的 root 行与发起方的 spawn 行之间：重启后发起方接回那棵树，不再起一棵", async () => {
    const one = await boot({ journalDir: dir });
    const root = one.kernel.submit("demo_flow", null);
    await until(() => one.of("park.opened").length === 2);
    const child = one.of("run.spawned")[0]!.child;
    const crashed = `${dir}-crash`;
    cpSync(dir, crashed, { recursive: true });
    const file = join(crashed, `${root}.jsonl`);
    writeFileSync(file, `${lines(crashed, root).filter((e) => e.type !== "spawn").map((e) => JSON.stringify(e)).join("\n")}\n`);

    const two = await boot({ journalDir: crashed });
    expect(two.roots).toEqual([root]);
    await until(() => two.of("park.opened").length === 2);
    expect(two.of("run.started").map((e) => [e.operation, e.runId])).toEqual(
      expect.arrayContaining([
        ["demo_flow", root],
        ["demo_ask", child],
      ]),
    );
    expect(two.of("run.started")).toHaveLength(2);
    expect(two.of("run.spawned")).toEqual([expect.objectContaining({ runId: root, step: 0, child })]);
    expect(lines(crashed, root).map((e) => e.type)).toEqual(["root", "retry", "spawn"]);
  });

  test("重放时这一步 spawn 的不是原来的：对不上，整棵树按 killed 处理", async () => {
    const one = await boot({ journalDir: dir });
    const root = one.kernel.submit("demo_flow", null);
    await until(() => one.of("park.opened").length === 2);
    await one.kernel.stop(100);

    const two = await boot({ journalDir: dir }, async (ctx) => [await ctx.spawn("demo_start", 1)]);
    expect(await two.kernel.reap(root)).toMatchObject({
      ok: false,
      reason: "diverged at #0 of demo_flow: journal has spawn demo_ask, got spawn demo_start",
    });
  });
});
