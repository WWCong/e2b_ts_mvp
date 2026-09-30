import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { HarnessEvent } from "./events";
import { Kernel, type KernelConfig } from "./kernel";
import type { Rejected } from "./run";
import { digest, type Snapshot } from "./snapshot";

const YES_NO = z.toJSONSchema(z.boolean());
const cancelled: Rejected = { ok: false, by: "kernel", reason: "cancelled", retryable: false };

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "snapshot-"));
});

/** demo_park 把 ctx.park 包成 Operation；demo_echo 原样返回入参 */
function setup(config: KernelConfig = { snapshotDir: dir }) {
  const kernel = new Kernel(config);
  const events: HarnessEvent[] = [];
  kernel.events.subscribe((e) => events.push(e));
  kernel.register({
    name: "demo_park",
    input: z.object({ schema: z.record(z.string(), z.unknown()), payload: z.unknown() }),
    impl: (ctx, input) => ctx.park(input),
  });
  kernel.register({ name: "demo_echo", input: z.unknown(), impl: async (_ctx, input) => input });
  const ask = (payload: unknown) => ({ schema: YES_NO, payload });
  const read = (root: string): Snapshot => JSON.parse(readFileSync(join(dir, `${root}.json`), "utf8"));
  const exists = (root: string) => existsSync(join(dir, `${root}.json`));
  const parkIds = () => events.filter((e) => e.type === "park.opened").map((e) => e.runId);
  const seen = (...types: string[]) => events.filter((e) => types.includes(e.type)).map((e) => e.type);
  return { kernel, events, ask, read, exists, parkIds, seen };
}

describe("写快照", () => {
  test("树空闲时写：树里每个 Run、按发起顺序的调用记录（含装饰器的调用、内核拒绝的调用）、等待中的 park", async () => {
    const { kernel, ask, read, parkIds } = setup();
    kernel.registerDecorator({
      id: "test_log",
      onError: "closed",
      fn: async (ctx, _run, next) => {
        await ctx.call("demo_echo", "decorator");
        return next();
      },
    });
    kernel.register({
      name: "demo_flow",
      input: z.string(),
      decorators: ["test_log"],
      impl: async (ctx, question: string) => {
        await ctx.call("demo_echo", "hi");
        await ctx.call("demo_nope", null);
        return ctx.call("demo_park", ask(question));
      },
    });
    const root = kernel.start("demo_flow", "删除 a.txt？");
    await Bun.sleep(1);
    const park = parkIds()[0]!;

    expect(read(root)).toEqual({
      root,
      runs: [
        {
          runId: root,
          operation: "demo_flow",
          input: "删除 a.txt？",
          depth: 0,
          calls: [
            { target: "demo_echo", input: digest("decorator"), child: expect.any(String), result: { ok: true, value: "decorator" }, order: 0 },
            { target: "demo_echo", input: digest("hi"), child: expect.any(String), result: { ok: true, value: "hi" }, order: 1 },
            {
              target: "demo_nope",
              input: digest(null),
              result: { ok: false, by: "kernel", reason: "unknown operation: demo_nope", retryable: false },
              order: 2,
            },
            { target: "demo_park", input: digest(ask("删除 a.txt？")), child: park },
          ],
        },
        {
          runId: park,
          operation: "demo_park",
          input: ask("删除 a.txt？"),
          depth: 1,
          parent: root,
          calls: [],
          park: { schema: YES_NO, payload: "删除 a.txt？" },
        },
      ],
    });
  });

  test("送值前先删快照，再关 park；树退出后没有快照", async () => {
    const { kernel, ask, exists, parkIds, seen } = setup();
    kernel.register({ name: "demo_ask", input: z.null(), impl: (ctx) => ctx.call("demo_park", ask("?")) });
    const root = kernel.start("demo_ask", null);
    expect(exists(root)).toBe(true);

    kernel.unpark(parkIds()[0]!, true);
    expect(exists(root)).toBe(false);
    expect(seen("park.opened", "park.closed", "snapshot.written", "snapshot.deleted")).toEqual([
      "park.opened",
      "snapshot.written",
      "snapshot.deleted",
      "park.closed",
    ]);
    expect(await kernel.reap(root)).toEqual({ ok: true, value: { ok: true, value: true } });
  });

  test("有 Run 还在 running 时不写：两个 park 先后开出，第二个开出前删掉、开出后重写", async () => {
    const { kernel, ask, read, parkIds, seen } = setup();
    kernel.register({
      name: "demo_both",
      input: z.null(),
      impl: (ctx) => Promise.all([ctx.call("demo_park", ask("a")), ctx.call("demo_park", ask("b"))]),
    });
    const root = kernel.start("demo_both", null);

    expect(seen("park.opened", "snapshot.written", "snapshot.deleted")).toEqual([
      "park.opened",
      "snapshot.written",
      "snapshot.deleted",
      "park.opened",
      "snapshot.written",
    ]);
    expect(read(root).runs.map((r) => r.runId)).toEqual([root, ...parkIds()]);
  });

  test("空闲期间取消其中一支：它的调用记录补上结果，重写快照", async () => {
    const { kernel, ask, read, parkIds } = setup();
    kernel.register({
      name: "demo_both",
      input: z.null(),
      impl: (ctx) => Promise.all([ctx.call("demo_park", ask("a")), ctx.call("demo_park", ask("b"))]),
    });
    const root = kernel.start("demo_both", null);
    const [a, b] = parkIds() as [string, string];

    kernel.cancel(a);
    const { runs } = read(root);
    expect(runs.map((r) => r.runId)).toEqual([root, b]);
    expect(runs[0]!.calls).toEqual([
      { target: "demo_park", input: digest(ask("a")), child: a, result: cancelled, order: 0 },
      { target: "demo_park", input: digest(ask("b")), child: b },
    ]);
  });

  test("取消整棵树：删快照；关停：快照保留，重启后接着等", async () => {
    const { kernel, ask, exists } = setup();
    kernel.register({ name: "demo_ask", input: z.null(), impl: (ctx) => ctx.call("demo_park", ask("?")) });
    const cancelledRoot = kernel.start("demo_ask", null);
    const stoppedRoot = kernel.start("demo_ask", null);

    kernel.cancel(cancelledRoot);
    expect(exists(cancelledRoot)).toBe(false);
    await kernel.stop(5);
    expect(exists(stoppedRoot)).toBe(true);
  });

  test("没配 snapshotDir：不写快照", async () => {
    const { kernel, ask, seen } = setup({});
    kernel.register({ name: "demo_ask", input: z.null(), impl: (ctx) => ctx.call("demo_park", ask("?")) });
    kernel.start("demo_ask", null);

    expect(seen("park.opened", "snapshot.written")).toEqual(["park.opened"]);
  });
});
