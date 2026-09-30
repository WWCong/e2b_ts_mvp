import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { HarnessEvent } from "./events";
import { digest, type Entry } from "./journal";
import { Kernel } from "./kernel";
import type { Rejected } from "./run";

const YES_NO = z.toJSONSchema(z.boolean());
const cancelled: Rejected = { ok: false, by: "kernel", reason: "cancelled", retryable: false };
const ask = (payload: unknown) => ({ schema: YES_NO, payload });

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "journal-"));
});

/** demo_park 把 ctx.park 包成 Operation；demo_echo 原样返回入参；demo_both 同时开两个 park，都答完再开第三个 */
function setup() {
  const kernel = new Kernel({ journalDir: dir });
  const events: HarnessEvent[] = [];
  kernel.events.subscribe((e) => events.push(e));
  kernel.register({
    name: "demo_park",
    input: z.object({ schema: z.record(z.string(), z.unknown()), payload: z.unknown() }),
    impl: (ctx, input) => ctx.park(input),
  });
  kernel.register({ name: "demo_echo", input: z.unknown(), impl: async (_ctx, input) => input });
  kernel.register({
    name: "demo_both",
    input: z.null(),
    impl: async (ctx) => {
      await Promise.all([ctx.call("demo_park", ask("a")), ctx.call("demo_park", ask("b"))]);
      return ctx.call("demo_park", ask("c"));
    },
  });
  const file = (root: string) => join(dir, `${root}.jsonl`);
  const lines = (root: string): Entry[] =>
    readFileSync(file(root), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const parkIds = () => events.filter((e) => e.type === "park.opened").map((e) => e.runId);
  return { kernel, events, file, lines, parkIds };
}

describe("写前日志", () => {
  test("根与外部入参；调用发起记 call（带子 Run），完成记 done；实现与装饰器的调用一起编号，内核拒绝的也记", async () => {
    const { kernel, lines, parkIds } = setup();
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

    const child = expect.any(String);
    expect(lines(root)).toEqual([
      { type: "root", runId: root, operation: "demo_flow", input: "删除 a.txt？" },
      { type: "call", runId: root, seq: 0, target: "demo_echo", input: digest("decorator"), child },
      { type: "done", runId: root, seq: 0, result: { ok: true, value: "decorator" } },
      { type: "call", runId: root, seq: 1, target: "demo_echo", input: digest("hi"), child },
      { type: "done", runId: root, seq: 1, result: { ok: true, value: "hi" } },
      { type: "call", runId: root, seq: 2, target: "demo_nope", input: digest(null) },
      {
        type: "done",
        runId: root,
        seq: 2,
        result: { ok: false, by: "kernel", reason: "unknown operation: demo_nope", retryable: false },
      },
      { type: "call", runId: root, seq: 3, target: "demo_park", input: digest(ask("删除 a.txt？")), child: parkIds()[0] },
    ]);
  });

  test("先记后做：park 的值落盘后才关 park，子 Run 的结果落盘后才交给父；树结束删日志", async () => {
    const { kernel, events, file, lines, parkIds } = setup();
    kernel.register({ name: "demo_ask", input: z.null(), impl: (ctx) => ctx.call("demo_park", ask("?")) });
    const root = kernel.start("demo_ask", null);
    const park = parkIds()[0]!;
    // 事件发出时读日志，看此刻落盘了什么
    const lastLineAt: Record<string, Entry | undefined> = {};
    kernel.events.subscribe((e) => {
      if (e.type === "park.closed" || (e.type === "run.exited" && e.runId === park)) lastLineAt[e.type] = lines(root).at(-1);
    });

    kernel.unpark(park, true);
    await Bun.sleep(1);
    expect(lastLineAt).toEqual({
      "park.closed": { type: "park", runId: park, result: { ok: true, value: true } },
      "run.exited": { type: "done", runId: root, seq: 0, result: { ok: true, value: true } },
    });
    expect(events.at(-1)).toMatchObject({ type: "run.exited", runId: root });
    expect(existsSync(file(root))).toBe(false);
  });

  test("完成顺序：同一个 Run 的 done 行按完成的先后排", async () => {
    const { kernel, lines, parkIds } = setup();
    const root = kernel.start("demo_both", null);
    const [a, b] = parkIds() as [string, string];

    kernel.unpark(b, true);
    kernel.unpark(a, false);
    await Bun.sleep(1);
    const dones = lines(root).filter((l) => l.type === "done");
    expect(dones.map((l) => l.type === "done" && [l.seq, l.result])).toEqual([
      [1, { ok: true, value: true }],
      [0, { ok: true, value: false }],
    ]);
  });

  test("取消其中一支：父的 done 记下取消的拒绝；取消整棵树：删日志", () => {
    const { kernel, file, lines, parkIds } = setup();
    const root = kernel.start("demo_both", null);

    kernel.cancel(parkIds()[0]!);
    expect(lines(root).at(-1)).toEqual({ type: "done", runId: root, seq: 0, result: cancelled });
    kernel.cancel(root);
    expect(existsSync(file(root))).toBe(false);
  });

  test("关停：日志保留，停在被杀之前，不记关停造成的结果", async () => {
    const { kernel, lines } = setup();
    const root = kernel.start("demo_both", null);

    await kernel.stop(5);
    expect(lines(root).map((l) => l.type)).toEqual(["root", "call", "call"]);
  });
});
