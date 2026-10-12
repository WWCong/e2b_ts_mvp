import { beforeEach, describe, expect, test } from "bun:test";
import { cpSync, readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { HarnessEvent } from "./events";
import { Kernel } from "./kernel";
import type { Ctx } from "./run";

const ask = (payload: unknown) => ({ schema: z.toJSONSchema(z.unknown()), payload });

let dir: string;
let copies = 0;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "recover-"));
});

/** 「崩溃」：把此刻的日志目录原样拷一份，新内核从拷贝恢复；旧内核留在原地不再理会 */
function crash(from: string): string {
  const to = `${from}-crash${++copies}`;
  cpSync(from, to, { recursive: true });
  return to;
}

/**
 * 起一个内核，注册同样的 Operation：
 * demo_flow 先调 demo_count 再调 demo_park；demo_mail 调 demo_send，demo_send 卡在 gate 上；
 * demo_clock 用 step 取时间再 park。impls 记下实现真正执行过的，chained 记下过了装饰器链的。
 */
function boot(journalDir: string, options: { flow?: (ctx: Ctx) => Promise<unknown>; clock?: () => number } = {}) {
  const kernel = new Kernel({ journalDir, defaultDecorators: ["test_spy"] });
  const events: HarnessEvent[] = [];
  kernel.events.subscribe((e) => events.push(e));
  const impls: string[] = [];
  const chained: string[] = [];
  const sends: { runId: string; attempt: number }[] = [];
  const gate = Promise.withResolvers<void>();
  kernel.registerDecorator({
    id: "test_spy",
    onError: "closed",
    fn: (_ctx, run, next) => {
      chained.push(run.operation);
      return next();
    },
  });
  const register = (name: string, impl: (ctx: Ctx, input: any) => Promise<unknown>) =>
    kernel.register({
      name,
      input: z.unknown(),
      impl: (ctx, input) => {
        impls.push(name);
        return impl(ctx, input);
      },
    });
  register("demo_park", (ctx, input) => ctx.park(input));
  register("demo_count", async (_ctx, n: number) => n * 10);
  register(
    "demo_flow",
    options.flow ?? (async (ctx) => [await ctx.call("demo_count", 1), await ctx.call("demo_park", ask("?"))]),
  );
  register("demo_send", async (ctx) => {
    sends.push({ runId: ctx.runId, attempt: ctx.attempt });
    await gate.promise;
    return "sent";
  });
  register("demo_mail", (ctx) => ctx.call("demo_send", null));
  register("demo_clock", async (ctx) => {
    const now = await ctx.step("now", options.clock ?? (() => 0));
    return ctx.call("demo_park", ask(now));
  });
  const parks = () => events.filter((e) => e.type === "park.opened");
  return { kernel, events, impls, chained, sends, gate, parks };
}

describe("恢复", () => {
  test("已完成的调用回送记下的结果，不执行、不过链；park 用原 id 重新开出，回答后接着跑，日志删除", async () => {
    const one = boot(dir);
    const root = one.kernel.start("demo_flow", null);
    await Bun.sleep(1);
    const parkId = one.parks()[0]!.runId;

    const twoDir = crash(dir);
    const two = boot(twoDir);
    expect(two.kernel.recover()).toEqual([root]);
    await Bun.sleep(1);
    expect(two.parks().map((e) => e.runId)).toEqual([parkId]);
    expect(two.impls).toEqual(["demo_flow", "demo_park"]);
    expect(two.chained).toEqual(["demo_flow", "demo_park"]);

    two.kernel.unpark(parkId, "yes");
    expect(await two.kernel.reap(root)).toEqual({
      ok: true,
      value: [
        { ok: true, value: 10 },
        { ok: true, value: "yes" },
      ],
    });
    expect(readdirSync(twoDir)).toEqual([]);
  });

  test("崩溃时正在执行的 Run 用原 runId 重新执行，ctx.attempt 加一；再崩一次接着加", async () => {
    const one = boot(dir);
    const root = one.kernel.start("demo_mail", null);
    await Bun.sleep(1);

    const twoDir = crash(dir);
    const two = boot(twoDir);
    two.kernel.recover();
    await Bun.sleep(1);
    const three = boot(crash(twoDir));
    three.kernel.recover();
    three.gate.resolve();

    expect(await three.kernel.reap(root)).toEqual({ ok: true, value: { ok: true, value: "sent" } });
    const send = one.sends[0]!.runId;
    expect([...one.sends, ...two.sends, ...three.sends]).toEqual([
      { runId: send, attempt: 1 },
      { runId: send, attempt: 2 },
      { runId: send, attempt: 3 },
    ]);
    expect(three.events.find((e) => e.type === "run.started" && e.runId === root)).toMatchObject({ attempt: 3 });
  });

  test("step：第一次执行 fn 并记下值；重放时给回记下的值，不再执行", async () => {
    let calls = 0;
    const one = boot(dir, { clock: () => 1000 });
    one.kernel.start("demo_clock", null);
    await Bun.sleep(1);

    const two = boot(crash(dir), { clock: () => ++calls });
    two.kernel.recover();
    await Bun.sleep(1);
    expect(two.parks()[0]!.payload).toBe(1000);
    expect(calls).toBe(0);
  });

  test("park 已回答、回答已落盘，还没交给父就崩了：恢复后直接拿到回答，不再问", async () => {
    const one = boot(dir);
    const root = one.kernel.start("demo_flow", null);
    await Bun.sleep(1);
    one.kernel.unpark(one.parks()[0]!.runId, "no");
    const twoDir = crash(dir);

    const two = boot(twoDir);
    two.kernel.recover();
    expect(await two.kernel.reap(root)).toMatchObject({ ok: true, value: [{ value: 10 }, { value: "no" }] });
    expect(two.parks()).toEqual([]);
  });

  test("比对不上（代码改了）：整棵树按 killed 处理，日志删除，根拿到 diverged 的拒绝", async () => {
    const one = boot(dir);
    const root = one.kernel.start("demo_flow", null);
    await Bun.sleep(1);
    const [otherTarget, otherInput] = [crash(dir), crash(dir)];

    for (const [journalDir, flow, got] of [
      [otherTarget, (ctx: Ctx) => ctx.call("demo_park", ask("?")), "call demo_park"],
      [otherInput, (ctx: Ctx) => ctx.call("demo_count", 2), "call demo_count with different input"],
    ] as const) {
      const two = boot(journalDir, { flow });
      two.kernel.recover();
      expect(await two.kernel.reap(root)).toEqual({
        ok: false,
        by: "kernel",
        reason: `diverged at #0 of demo_flow: journal has call demo_count, got ${got}`,
        retryable: false,
      });
      expect(two.parks()).toEqual([]);
      expect(readdirSync(journalDir)).toEqual([]);
    }
  });

  test("根都建不起来（Operation 没了）：恢复失败，日志删除", async () => {
    const one = boot(dir);
    const root = one.kernel.start("demo_flow", null);
    await Bun.sleep(1);
    const twoDir = crash(dir);

    const bare = new Kernel({ journalDir: twoDir });
    expect(bare.recover()).toEqual([root]);
    expect(await bare.reap(root)).toMatchObject({ ok: false, by: "kernel", reason: "unknown operation: demo_flow" });
    expect(readdirSync(twoDir)).toEqual([]);
  });
});
