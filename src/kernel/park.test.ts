import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { HarnessEvent } from "./events";
import { Kernel, type KernelConfig } from "./kernel";
import type { Rejected, Run } from "./run";

const YES_NO = z.toJSONSchema(z.boolean());
const cancelled: Rejected = { ok: false, by: "kernel", reason: "cancelled", retryable: false };

/** demo_ask 经 harness_park 等一个布尔值；默认装饰器 test_spy 按 Operation 名记下 Run，好查状态 */
function setup(config: KernelConfig = {}) {
  const kernel = new Kernel({ defaultDecorators: ["test_spy"], ...config });
  const events: HarnessEvent[] = [];
  kernel.events.subscribe((e) => events.push(e));
  const runs = new Map<string, Run>();
  kernel.registerDecorator({
    id: "test_spy",
    onError: "closed",
    fn: (_ctx, run, next) => {
      runs.set(run.operation, run);
      return next();
    },
  });
  kernel.register({
    name: "demo_ask",
    input: z.string(),
    impl: (ctx, question: string) => ctx.call("harness_park", { schema: YES_NO, payload: { question } }),
  });
  const opened = () => events.filter((e) => e.type === "park.opened");
  const parkId = (i = 0) => {
    const open = opened()[i];
    if (!open) throw new Error(`park #${i} has not opened`);
    return open.runId;
  };
  return { kernel, events, runs, opened, parkId };
}

describe("park 与 unpark", () => {
  test("park：Run 转 waiting，发 park.opened；unpark 送值后转回 running，值作为结果交给调用方", async () => {
    const { kernel, events, runs, opened, parkId } = setup();
    const root = kernel.start("demo_ask", "删除 a.txt？");

    expect(opened()).toEqual([
      expect.objectContaining({ runId: parkId(), schema: YES_NO, payload: { question: "删除 a.txt？" } }),
    ]);
    const park = runs.get("harness_park")!;
    expect(park.runId).toBe(parkId());
    expect([runs.get("demo_ask")!.status, park.status]).toEqual(["waiting", "waiting"]);

    kernel.unpark(parkId(), true);
    expect(park.status).toBe("running");
    expect(await kernel.reap(root)).toEqual({ ok: true, value: { ok: true, value: true } });
    expect(events.map((e) => [e.type, e.runId])).toEqual([
      ["run.started", root],
      ["run.started", parkId()],
      ["park.opened", parkId()],
      ["park.closed", parkId()],
      ["run.exited", parkId()],
      ["run.exited", root],
    ]);
    expect(events.find((e) => e.type === "park.closed")).toMatchObject({ result: { ok: true, value: true } });
  });

  test("值不符合 schema：unpark 抛异常，park 照旧等待；改对了再送", async () => {
    const { kernel, runs, parkId } = setup();
    const root = kernel.start("demo_ask", "?");

    expect(() => kernel.unpark(parkId(), "yes")).toThrow(`invalid value for park ${parkId()}`);
    expect(runs.get("harness_park")!.status).toBe("waiting");
    kernel.unpark(parkId(), false);
    expect(await kernel.reap(root)).toEqual({ ok: true, value: { ok: true, value: false } });
  });

  test("撤回：park 以拒绝结果返回，by 为 harness_park", async () => {
    const { kernel, events, parkId } = setup();
    const root = kernel.start("demo_ask", "?");
    const withdrawn: Rejected = { ok: false, by: "harness_park", reason: "用户没回答", retryable: false };

    kernel.withdraw(parkId(), "用户没回答");
    expect(await kernel.reap(root)).toEqual({ ok: true, value: withdrawn });
    expect(events.find((e) => e.type === "park.closed")).toMatchObject({ result: withdrawn });
  });

  test("不在等待的 Run：unpark 与撤回都抛异常", async () => {
    const { kernel, parkId } = setup();
    const root = kernel.start("demo_ask", "?");

    expect(() => kernel.unpark(root, true)).toThrow(`not parked: ${root}`);
    kernel.unpark(parkId(), true);
    await kernel.reap(root);
    expect(() => kernel.unpark(parkId(), true)).toThrow(`not parked: ${parkId()}`);
    expect(() => kernel.withdraw("nope", "x")).toThrow("not parked: nope");
  });

  test("多个 park 同时等待：各自送值，先后不限", async () => {
    const { kernel, opened, parkId } = setup();
    kernel.register({
      name: "demo_both",
      input: z.null(),
      impl: (ctx) => Promise.all([ctx.call("demo_ask", "a"), ctx.call("demo_ask", "b")]),
    });
    const root = kernel.start("demo_both", null);

    expect(opened().map((e) => e.payload)).toEqual([{ question: "a" }, { question: "b" }]);
    kernel.unpark(parkId(1), false);
    kernel.unpark(parkId(0), true);
    const answer = (value: boolean) => ({ ok: true, value: { ok: true, value } });
    expect(await kernel.reap(root)).toEqual({ ok: true, value: [answer(true), answer(false)] });
  });

  test("schema 不是合法的 JSON Schema：park 以拒绝返回，不进入等待", async () => {
    const { kernel, opened } = setup();
    kernel.register({
      name: "demo_bad",
      input: z.null(),
      impl: (ctx) => ctx.call("harness_park", { schema: { type: "nope" }, payload: null }),
    });

    const result = await kernel.reap(kernel.start("demo_bad", null));
    expect(result).toMatchObject({ ok: true, value: { ok: false, by: "harness_park" } });
    expect(opened()).toEqual([]);
  });
});

describe("park 与取消、关停", () => {
  test("取消等待中的树：park 转 killed 并发 park.closed，收割得到内核的拒绝", async () => {
    const { kernel, events, parkId } = setup();
    const root = kernel.start("demo_ask", "?");
    const id = parkId();

    kernel.cancel(root);
    expect(await kernel.reap(root)).toEqual(cancelled);
    await Bun.sleep(1);
    expect(events.slice(3).map((e) => [e.type, e.runId])).toEqual([
      ["run.killed", root],
      ["run.killed", id],
      ["park.closed", id],
    ]);
    expect(events.at(-1)).toMatchObject({ result: cancelled });
    expect(() => kernel.unpark(id, true)).toThrow(`not parked: ${id}`);
  });

  test("关停：等 park 的树不会自己收敛，到超时被杀", async () => {
    const { kernel } = setup();
    const root = kernel.start("demo_ask", "?");

    await kernel.stop(5);
    expect(await kernel.reap(root)).toMatchObject({ ok: false, by: "kernel", reason: "shutdown" });
  });
});

describe("装饰器与 park", () => {
  test("挂起：审批装饰器在 next() 之前调 harness_park，据回答放行或拒绝", async () => {
    const { kernel, parkId } = setup();
    kernel.registerDecorator({
      id: "test_approval",
      onError: "closed",
      fn: async (ctx, run, next) => {
        const r = await ctx.call("harness_park", { schema: YES_NO, payload: { approve: run.operation } });
        if (r.ok && r.value === true) return next();
        return { ok: false, by: "test_approval", reason: "not approved", retryable: false };
      },
    });
    kernel.register({ name: "demo_delete", input: z.null(), decorators: ["test_approval"], impl: async () => "deleted" });

    const yes = kernel.start("demo_delete", null);
    kernel.unpark(parkId(0), true);
    expect(await kernel.reap(yes)).toEqual({ ok: true, value: "deleted" });

    const no = kernel.start("demo_delete", null);
    kernel.unpark(parkId(1), false);
    expect(await kernel.reap(no)).toMatchObject({ ok: false, by: "test_approval", reason: "not approved" });
  });

  test("无人值守：默认装饰器把 park 短路成拒绝，不再等待", async () => {
    const unattended: Rejected = { ok: false, by: "test_unattended", reason: "unattended", retryable: false };
    const { kernel, opened } = setup({ defaultDecorators: ["test_unattended"] });
    kernel.registerDecorator({
      id: "test_unattended",
      onError: "closed",
      fn: async (_ctx, run, next) => (run.operation === "harness_park" ? unattended : next()),
    });

    expect(await kernel.reap(kernel.start("demo_ask", "?"))).toEqual({ ok: true, value: unattended });
    expect(opened()).toEqual([]);
  });
});
