import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Kernel, loadPlugin, type HarnessEvent } from "stdlib";

/** harness 插件，外加公开的 demo_double（记下被调了几次）、demo_wait（等外部的值），不公开的 demo_secret */
async function setup(journalDir?: string) {
  const kernel = new Kernel({ journalDir });
  const events: HarnessEvent[] = [];
  kernel.events.subscribe((e) => events.push(e));
  const doubled: number[] = [];
  await loadPlugin(kernel, import.meta.dir);
  kernel.register({
    name: "demo_double",
    usage: "乘二",
    public: true,
    input: z.number(),
    impl: async (_ctx, n: number) => (doubled.push(n), n * 2),
  });
  kernel.register({ name: "demo_wait", usage: "等", public: true, input: z.null(), impl: (ctx) => ctx.park({ schema: { type: "string" }, payload: "等什么？" }) });
  kernel.register({ name: "demo_secret", input: z.null(), impl: async () => "secret" });
  const roots = await kernel.boot();
  const exec = (source: string, input?: unknown) => kernel.reap(kernel.submit("harness_exec", { source, input }));
  return { kernel, events, doubled, roots, exec };
}

describe("harness_exec", () => {
  test("一段源码在解释器里跑：调工具（ctx.call 或 ctx.ops）、按结果分支，返回值与 console 的输出一起交回", async () => {
    const { exec, events } = await setup();
    const source = `
      export default async (ctx, input: { from: number }) => {
        const out: number[] = [];
        for (let n = input.from; n < input.from + 3; n++) {
          const r = await ctx.call("demo_double", n);
          if (r.ok) out.push(r.value);
        }
        console.log("算完了", out.length, { last: out.at(-1) });
        return out;
      };`;

    expect(await exec(source, { from: 1 })).toEqual({ ok: true, value: { value: [2, 4, 6], logs: ['算完了 3 {"last":6}'] } });
    // 每次调用都是 harness_exec 的子 Run
    const exec_ = events.find((e) => e.type === "run.started" && e.operation === "harness_exec")!;
    expect(events.filter((e) => e.type === "run.started" && e.operation === "demo_double").map((e) => e.type === "run.started" && e.parent)).toEqual([
      exec_.runId,
      exec_.runId,
      exec_.runId,
    ]);
  });

  test("只能调公开的；没有返回值时结果是 null", async () => {
    const { exec } = await setup();

    expect(await exec(`export default async (ctx) => { console.log((await ctx.call("demo_secret", null)).reason); }`)).toEqual({
      ok: true,
      value: { value: null, logs: ["demo_secret is not public: harness_exec is a script"] },
    });
  });

  test("源码写错、import 了不许的、默认导出不是函数：以拒绝返回，原因说清楚", async () => {
    const { exec } = await setup();

    expect(await exec("export default async (ctx) => { return 1 +; }")).toMatchObject({ ok: false, by: "harness_exec", reason: expect.stringMatching(/^1:\d+ Unexpected/) });
    expect(await exec('import { readFileSync } from "node:fs"; export default async () => readFileSync("/etc/hostname");')).toMatchObject({
      ok: false,
      reason: "source imports node:fs: a script can only import stdlib and zod",
    });
    expect(await exec("export default 42;")).toMatchObject({ ok: false, reason: "default export is not a function: export default async (ctx, input) => …" });
  });

  test("最多调 100 次：再调就抛异常", async () => {
    const { exec } = await setup();
    const source = `
      export default async (ctx) => {
        let n = 0;
        try { for (;;) { await ctx.call("demo_double", 1); n++; } } catch (err) { return [n, err.message]; }
      };`;

    expect(await exec(source)).toEqual({ ok: true, value: { value: [100, "more than 100 calls"], logs: [] } });
  });

  test("等人时停下：重启后源码重新跑，已完成的调用回放、不再执行，接着等原来的问题", async () => {
    const journal = await mkdtemp(join(tmpdir(), "exec-"));
    const source = `
      export default async (ctx) => {
        const a = await ctx.call("demo_double", 21);
        const answer = await ctx.call("demo_wait", null);
        return [a.value, answer.value];
      };`;
    const one = await setup(journal);
    const root = one.kernel.submit("harness_exec", { source });
    while (!one.events.some((e) => e.type === "park.opened")) await Bun.sleep(1);
    await one.kernel.stop(1000);
    expect(one.doubled).toEqual([21]);

    const two = await setup(journal);
    expect(two.roots).toEqual([root]);
    while (!two.events.some((e) => e.type === "park.opened")) await Bun.sleep(1);
    two.kernel.unpark(two.events.find((e) => e.type === "park.opened")!.runId, "好了");
    expect(await two.kernel.reap(root)).toEqual({ ok: true, value: { value: [42, "好了"], logs: [] } });
    expect(two.doubled).toEqual([]);
  });
});
