import { describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Kernel, loadPlugin, type HarnessEvent, type Infra } from "stdlib";
import { localDir } from "stdlib/infra/volume";

/** harness 插件，外加公开的 demo_double（记下被调了几次）、demo_wait（等外部的值），不公开的 demo_secret */
async function setup(journalDir?: string, infra: Infra = {}) {
  const kernel = new Kernel({ journalDir });
  const events: HarnessEvent[] = [];
  kernel.events.subscribe((e) => events.push(e));
  const doubled: number[] = [];
  await loadPlugin(kernel, import.meta.dir, {}, infra);
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
  test("一段源码在解释器里跑：调工具、按结果分支，返回值是结果；console 的输出记成这个 Run 的日志，不交回", async () => {
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

    expect(await exec(source, { from: 1 })).toEqual({ ok: true, value: [2, 4, 6] });
    const exec_ = events.find((e) => e.type === "run.started" && e.operation === "harness_exec")!;
    expect(events.filter((e) => e.type === "run.logged")).toEqual([
      expect.objectContaining({ runId: exec_.runId, operation: "harness_exec", level: "info", text: '算完了 3 {"last":6}' }),
    ]);
    // 每次调用都是 harness_exec 的子 Run
    expect(events.filter((e) => e.type === "run.started" && e.operation === "demo_double").map((e) => e.type === "run.started" && e.parent)).toEqual([
      exec_.runId,
      exec_.runId,
      exec_.runId,
    ]);
  });

  test("只能调公开的；没有返回值时结果是 null", async () => {
    const { exec } = await setup();

    expect(await exec(`export default async (ctx) => { await ctx.call("demo_secret", null); }`)).toEqual({ ok: true, value: null });
    expect(await exec(`export default async (ctx) => (await ctx.call("demo_secret", null)).reason`)).toEqual({
      ok: true,
      value: "demo_secret is not public: harness_exec is a script",
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

    expect(await exec(source)).toEqual({ ok: true, value: [100, "more than 100 calls"] });
  });

  test("等人时停下：重启后源码重新跑，已完成的调用回放、不再执行，接着等原来的问题；回放期间的日志不再发", async () => {
    const journal = await mkdtemp(join(tmpdir(), "exec-"));
    const source = `
      export default async (ctx) => {
        console.log("开始");
        const a = await ctx.call("demo_double", 21);
        console.log("等回答");
        const answer = await ctx.call("demo_wait", null);
        console.log("拿到回答");
        return [a.value, answer.value];
      };`;
    const logged = (events: HarnessEvent[]) => events.flatMap((e) => (e.type === "run.logged" ? [e.text] : []));
    const one = await setup(journal);
    const root = one.kernel.submit("harness_exec", { source });
    while (!one.events.some((e) => e.type === "park.opened")) await Bun.sleep(1);
    await one.kernel.stop(1000);
    expect(one.doubled).toEqual([21]);
    expect(logged(one.events)).toEqual(["开始", "等回答"]);

    const two = await setup(journal);
    expect(two.roots).toEqual([root]);
    while (!two.events.some((e) => e.type === "park.opened")) await Bun.sleep(1);
    two.kernel.unpark(two.events.find((e) => e.type === "park.opened")!.runId, "好了");
    expect(await two.kernel.reap(root)).toEqual({ ok: true, value: [42, "好了"] });
    expect(two.doubled).toEqual([]);
    // 「等回答」写在已完成的 demo_double 之后、停下时在等的 demo_wait 之前：重新执行时还要再发起 demo_wait，不算回放
    expect(logged(two.events)).toEqual(["等回答", "拿到回答"]);
  });
});

describe("harness_exec 跑工作区里的 script 包草稿", () => {
  /** 工作区里一个草稿 drafts/report：包内模块、文本资源，调公开的 demo_double */
  async function workspace() {
    const root = await mkdtemp(join(tmpdir(), "exec-ws-"));
    await Bun.write(
      join(root, "drafts/report/index.ts"),
      `import { z } from "zod";
       import { op, script } from "stdlib";
       import { total } from "./sum";
       import title from "./title.txt" with { type: "text" };
       export default script({
         operations: {
           weekly: op({
             usage: "周报",
             input: z.object({ items: z.array(z.number()), unit: z.string().default("个") }),
             output: z.string(),
             impl: async (ctx, input) => {
               const doubled = await Promise.all(input.items.map((n) => ctx.call("demo_double", n)));
               return \`\${title.trim()}：\${total(doubled.map((r) => r.value))}\${input.unit}\`;
             },
           }),
         },
       });`,
    );
    await Bun.write(join(root, "drafts/report/sum.ts"), "export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);");
    await Bun.write(join(root, "drafts/report/title.txt"), "本周合计\n");
    return root;
  }

  test("给目录与 Operation：打包整个草稿（包内模块、文本资源），按它的 schema 校验，调用记在 harness_exec 名下", async () => {
    const root = await workspace();
    const { kernel, events } = await setup(undefined, { workspace: localDir(root) });
    const run = (input: unknown) => kernel.reap(kernel.submit("harness_exec", input));

    expect(await run({ dir: "drafts/report", operation: "weekly", input: { items: [1, 2, 3] } })).toEqual({ ok: true, value: "本周合计：12个" });
    const exec = events.find((e) => e.type === "run.started" && e.operation === "harness_exec")!;
    expect(events.filter((e) => e.type === "run.started" && e.operation === "demo_double").every((e) => e.type === "run.started" && e.parent === exec.runId)).toBe(true);

    expect(await run({ dir: "drafts/report", operation: "weekly", input: { items: "x" } })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^invalid input for report_weekly/),
    });
    expect(await run({ dir: "drafts/report", operation: "daily" })).toMatchObject({ ok: false, reason: "report has no operation daily (it has: weekly)" });
    expect(await run({ dir: "drafts/report", source: "export default async () => 1" })).toMatchObject({ ok: false, reason: "give either source, or dir and operation" });
  });

  test("越出工作区的目录、指到外面的符号链接、没有工作区：都不跑", async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "exec-outside-"));
    await Bun.write(join(outside, "secret.txt"), "密码");
    await Bun.write(join(root, "drafts/leak/index.ts"), 'import s from "./secret.txt" with { type: "text" }; export default s;');
    symlinkSync(join(outside, "secret.txt"), join(root, "drafts/leak/secret.txt"));
    const { kernel } = await setup(undefined, { workspace: localDir(root) });
    const run = (input: unknown) => kernel.reap(kernel.submit("harness_exec", input));

    expect(await run({ dir: "../outside", operation: "x" })).toMatchObject({ ok: false, reason: "path escapes the volume: ../outside/index.ts" });
    expect(await run({ dir: "drafts/leak", operation: "x" })).toMatchObject({
      ok: false,
      reason: "leak: index.ts imports ./secret.txt: a script package can only import stdlib, zod and its own files",
    });

    const bare = await setup();
    expect(await bare.kernel.reap(bare.kernel.submit("harness_exec", { dir: "drafts/report", operation: "weekly" }))).toMatchObject({
      ok: false,
      reason: "no workspace: running a draft needs one",
    });
  });
});
