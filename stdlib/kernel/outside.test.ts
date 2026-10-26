import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { HarnessEvent } from "./events";
import { Kernel, type KernelConfig } from "./kernel";
import { op } from "./plugin";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "outside-"));
});

/**
 * demo_ask 声明了 api：先调不对外的 demo_inner，再 park 等外部的值。demo_once 也声明了 api，记下自己执行了几次。
 * 对外接口的 origin 是 web
 */
async function setup(config: KernelConfig = {}) {
  const kernel = new Kernel(config);
  const events: HarnessEvent[] = [];
  kernel.events.subscribe((e) => events.push(e));
  let runs = 0;
  kernel.use("demo", {
    operations: {
      ask: op({
        api: true,
        usage: "问一句",
        input: z.object({ q: z.string(), loud: z.boolean().default(false) }),
        output: z.string(),
        impl: async (ctx, { q }) => {
          await ctx.call("demo_inner", null);
          return ctx.park({ schema: z.toJSONSchema(z.string()), payload: q });
        },
      }),
      once: op({ api: true, usage: "数一次", input: z.object({}), output: z.string(), impl: async () => `第 ${++runs} 次` }),
      inner: op({ input: z.null(), impl: async () => "inner" }),
    },
  });
  const roots = await kernel.boot();
  const outside = kernel.outside("web");
  const parked = async () => {
    while (outside.parks().length === 0) await Bun.sleep(1);
    return outside.parks()[0]!;
  };
  return { kernel, events, roots, outside, parked, runs: () => runs };
}

const file = (runId: string) => join(dir, `${runId}.jsonl`);

describe("对外接口", () => {
  test("只能调声明了 api 的 Operation；发起的树的根记下 origin，子 Run 不记；宿主什么都能调，不记 origin", async () => {
    const { kernel, events, outside, parked } = await setup();

    for (const name of ["demo_inner", "demo_nope"]) {
      expect(() => outside.submit(name, null)).toThrow(`not an api operation: ${name}`);
    }
    const root = outside.submit("demo_ask", { q: "哪个？" });
    outside.unpark((await parked()).id, "这个");
    expect(await outside.reap(root)).toEqual({ ok: true, value: "这个" });
    expect(await kernel.reap(kernel.submit("demo_inner", null))).toEqual({ ok: true, value: "inner" });

    const started = events.filter((e) => e.type === "run.started");
    expect(started.map((e) => [e.operation, e.origin])).toEqual([
      ["demo_ask", "web"],
      ["demo_inner", undefined],
      ["demo_inner", undefined],
    ]);
  });

  test("operations：声明了 api 的，带说明、入参（调用方要填的形状）与出参的 JSON Schema", async () => {
    const { outside } = await setup();

    expect(outside.operations().map((o) => o.name)).toEqual(["demo_ask", "demo_once"]);
    const ask = outside.operations()[0]!;
    expect(ask.usage).toBe("问一句");
    expect(ask.input).toMatchObject({ type: "object", required: ["q"], properties: { q: { type: "string" } } });
    expect(ask.output).toMatchObject({ type: "string" });
  });

  test("runs 列出结果还没被取走的树；parks 列出等待中的 park，带所在的树、schema 与 payload", async () => {
    const { outside, parked } = await setup();
    const root = outside.submit("demo_ask", { q: "哪个？" });
    const park = await parked();

    expect(outside.runs()).toEqual([{ runId: root, operation: "demo_ask", origin: "web", done: false }]);
    expect(park).toEqual({ id: expect.any(String), root, operation: "demo_ask", schema: z.toJSONSchema(z.string()), payload: "哪个？" });

    outside.unpark(park.id, "这个");
    expect(await outside.wait(root)).toEqual({ ok: true, value: "这个" });
    expect(outside.parks()).toEqual([]);
    expect(outside.runs()).toEqual([{ runId: root, operation: "demo_ask", origin: "web", done: true }]);
    await outside.reap(root);
    expect(outside.runs()).toEqual([]);
  });

  test("每棵树的结果只能取一次", async () => {
    const { outside } = await setup();
    const root = outside.submit("demo_once", {});

    const [first, second] = await Promise.allSettled([outside.reap(root), outside.reap(root)]);
    expect(first).toEqual({ status: "fulfilled", value: { ok: true, value: "第 1 次" } });
    expect(second).toMatchObject({ status: "rejected", reason: new Error(`already reaped: ${root}`) });
    expect(outside.reap(root)).rejects.toThrow(`unknown run: ${root}`);
  });
});

describe("结果留到被取走", () => {
  test("树结束后日志留到 exit 行；重启后不再执行，取到的是记下的结果，取走才删日志", async () => {
    const one = await setup({ journalDir: dir });
    const root = one.outside.submit("demo_once", {});
    await one.outside.wait(root);
    await one.kernel.stop(1000);
    expect(JSON.parse((await readFile(file(root), "utf8")).trim().split("\n").at(-1)!)).toMatchObject({
      type: "exit",
      result: { ok: true, value: "第 1 次" },
    });

    const two = await setup({ journalDir: dir });
    expect(two.roots).toEqual([root]);
    expect(two.outside.recovered()).toEqual([root]);
    expect(two.outside.runs()).toEqual([{ runId: root, operation: "demo_once", origin: "web", done: true }]);
    expect(two.events.map((e) => e.type)).toEqual([]);
    expect(await two.outside.reap(root)).toEqual({ ok: true, value: "第 1 次" });
    expect(two.runs()).toBe(0);
    expect(two.events.map((e) => [e.type, e.runId])).toEqual([["run.reaped", root]]);
    expect(existsSync(file(root))).toBe(false);
  });

  test("origin 写进日志的根行；重启后接着做的树带上根的 Operation 与 origin，重新执行的根仍带 origin", async () => {
    const one = await setup({ journalDir: dir });
    const root = one.outside.submit("demo_ask", { q: "哪个？" });
    await one.parked();
    expect(JSON.parse((await readFile(file(root), "utf8")).split("\n")[0]!)).toMatchObject({ type: "root", origin: "web" });
    await one.kernel.stop(1000);

    const two = await setup({ journalDir: dir });
    expect(two.events.find((e) => e.type === "tree.recovered")).toMatchObject({ runId: root, operation: "demo_ask", origin: "web" });
    expect(two.events.find((e) => e.type === "run.started" && e.runId === root)).toMatchObject({ origin: "web", attempt: 2 });
    two.outside.unpark((await two.parked()).id, "好");
    expect(await two.outside.reap(root)).toEqual({ ok: true, value: "好" });
  });

  test("关停时被杀的树：取到的是关停造成的拒绝，不算取走，日志留着，重启后接着做", async () => {
    const one = await setup({ journalDir: dir });
    const root = one.outside.submit("demo_ask", { q: "哪个？" });
    await one.parked();
    const reaped = one.outside.reap(root);
    await one.kernel.stop(1000);
    expect(await reaped).toEqual({ ok: false, by: "kernel", reason: "shutdown", retryable: false });
    expect(one.events.some((e) => e.type === "run.reaped")).toBe(false);
    expect(await readdir(dir)).toEqual([`${root}.jsonl`]);

    const two = await setup({ journalDir: dir });
    two.outside.unpark((await two.parked()).id, "好");
    expect(await two.outside.reap(root)).toEqual({ ok: true, value: "好" });
  });

  test("放得比 resultTtlMs 久没人取：启动时清掉，发 run.reaped（expired）", async () => {
    const one = await setup({ journalDir: dir });
    const root = one.outside.submit("demo_once", {});
    await one.outside.wait(root);
    await Bun.sleep(5);

    const two = await setup({ journalDir: dir, resultTtlMs: 1 });
    expect(two.roots).toEqual([]);
    expect(two.events).toEqual([expect.objectContaining({ type: "run.reaped", runId: root, operation: "demo_once", expired: true })]);
    expect(existsSync(file(root))).toBe(false);
  });
});

describe("对外的契约", () => {
  test("api 的 Operation 必须写 usage 与 output，注册时就报错", () => {
    const kernel = new Kernel();
    expect(() => kernel.use("bad", { operations: { a: op({ api: true, input: z.object({}), output: z.string(), impl: async () => "" }) } })).toThrow(
      "api operation needs usage: bad_a",
    );
    expect(() => kernel.use("worse", { operations: { a: op({ api: true, usage: "u", input: z.object({}), impl: async () => "" }) } })).toThrow(
      "api operation needs output: worse_a",
    );
  });

  test("写了 output 的，返回前按它校验：对不上算这个 Operation 失败；对得上交出解析后的值", async () => {
    const kernel = new Kernel();
    kernel.use("demo", {
      operations: {
        wrong: op({ input: z.null(), output: z.string(), impl: async () => 42 as unknown as string }),
        strip: op({ input: z.null(), output: z.object({ a: z.number() }), impl: async () => ({ a: 1, extra: true }) }),
      },
    });
    await kernel.boot();

    const wrong = await kernel.reap(kernel.submit("demo_wrong", null));
    const reason = wrong.ok ? "" : wrong.reason;
    expect(wrong).toMatchObject({ ok: false, by: "demo_wrong" });
    expect(reason).toStartWith("invalid output:");
    expect(await kernel.reap(kernel.submit("demo_strip", null))).toEqual({ ok: true, value: { a: 1 } });
  });
});
