import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { HarnessEvent } from "./events";
import { Kernel } from "./kernel";
import { op, type PluginObject } from "./plugin";
import type { Rejected } from "./run";

const YES_NO = z.toJSONSchema(z.boolean());

let dir: string;
let errors: unknown[][];
const origError = console.error;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "before-"));
  errors = [];
  console.error = (...args: unknown[]) => errors.push(args);
});
afterEach(() => {
  console.error = origError;
});

/**
 * demo 插件：echo 原样返回；twice 调两次 echo；wait 经 ctx.park 等一个布尔值；flow 调两次 echo 再调 wait。
 * ran 记下 echo 真正执行了几次。policy 是要装的拦截插件
 */
async function setup(policy: PluginObject, journalDir?: string) {
  const kernel = new Kernel({ journalDir });
  const events: HarnessEvent[] = [];
  kernel.events.subscribe((e) => events.push(e));
  const ran = { echo: 0 };
  kernel.use("demo", {
    operations: {
      echo: op({
        input: z.string(),
        impl: async (_ctx, s) => {
          ran.echo++;
          return s;
        },
      }),
      twice: op({ input: z.null(), impl: async (ctx) => [await ctx.call("demo_echo", "a"), await ctx.call("demo_echo", "b")] }),
      wait: op({ input: z.null(), impl: (ctx) => ctx.park({ schema: YES_NO, payload: null }) }),
      flow: op({
        input: z.null(),
        impl: async (ctx) => [await ctx.call("demo_echo", "a"), await ctx.call("demo_echo", "b"), await ctx.call("demo_wait", null)],
      }),
    },
  });
  kernel.use("policy", policy);
  const roots = await kernel.boot();
  const run = (name: string, input: unknown) => kernel.reap(kernel.submit(name, input));
  return { kernel, events, ran, roots, run };
}

const by = (reason: string): Rejected => ({ ok: false, by: "policy", reason, retryable: false });

describe("beforeRunStart", () => {
  test("拦下子调用：以拒绝返回，不建子 Run，发 call.rejected；挂点拿到将要发出的 run.started", async () => {
    const seen: unknown[] = [];
    const { events, ran, run } = await setup({
      beforeRunStart(e) {
        seen.push([e.operation, e.input, e.step]);
        if (e.input === "b") return { veto: "不许 b" };
      },
    });

    expect(await run("demo_twice", null)).toEqual({ ok: true, value: [{ ok: true, value: "a" }, by("不许 b")] });
    expect(seen).toEqual([
      ["demo_twice", null, undefined],
      ["demo_echo", "a", 0],
      ["demo_echo", "b", 1],
    ]);
    expect(ran.echo).toBe(1);
    expect(events.filter((e) => e.type === "run.started").map((e) => e.input)).toEqual([null, "a"]);
    expect(events).toContainEqual(expect.objectContaining({ type: "call.rejected", step: 1, result: by("不许 b") }));
  });

  test("拦下外部调用：start 抛异常，什么也不发", async () => {
    const { kernel, events } = await setup({ beforeRunStart: (e) => (e.depth === 0 ? { veto: "下班了" } : undefined) });

    expect(() => kernel.submit("demo_echo", "x")).toThrow("rejected by policy: 下班了");
    expect(events).toEqual([]);
  });

  test("没有依赖时按装载顺序问，第一个拦下的生效，后面的不再问", async () => {
    const asked: string[] = [];
    const kernel = new Kernel();
    kernel.use("demo", { operations: { echo: op({ input: z.string(), impl: async (_ctx, s) => s }) } });
    kernel.use("first", { beforeRunStart: () => void asked.push("first") });
    kernel.use("second", { beforeRunStart: () => (asked.push("second"), { veto: "no", retryable: true }) });
    kernel.use("third", { beforeRunStart: () => void asked.push("third") });
    await kernel.boot();

    expect(() => kernel.submit("demo_echo", "x")).toThrow("rejected by second: no");
    expect(asked).toEqual(["first", "second"]);
  });

  test("挂点抛异常或是 async：按拦下处理（出错必须中断），记下错误", async () => {
    const thrown = await setup({
      beforeRunStart(e) {
        if (e.depth > 0) throw new Error("boom");
      },
    });
    expect(await thrown.run("demo_twice", null)).toMatchObject({
      ok: true,
      value: [{ ok: false, by: "policy", reason: "beforeRunStart failed: boom" }, { ok: false }],
    });
    expect(errors.map((args) => args[0])).toContain("[harness] policy.beforeRunStart failed");

    const policy = { beforeRunStart: async () => {} } as unknown as PluginObject;
    const async = await setup(policy);
    expect(() => async.kernel.submit("demo_echo", "x")).toThrow("rejected by policy: beforeRunStart must be synchronous");
  });
});

describe("beforeRunExit / beforeParkOpen / beforeParkClose", () => {
  test("beforeRunExit 拦下：结果换成拒绝，run.exited 带的也是它，父拿到的也是它", async () => {
    const { events, run } = await setup({
      beforeRunExit: (e) => (e.result.ok && e.result.value === "b" ? { veto: "b 不能出去" } : undefined),
    });

    expect(await run("demo_twice", null)).toEqual({ ok: true, value: [{ ok: true, value: "a" }, by("b 不能出去")] });
    expect(events.filter((e) => e.type === "run.exited").map((e) => e.result)).toContainEqual(by("b 不能出去"));
  });

  test("beforeParkOpen 拦下：不开出、不等待，park 直接以拒绝关闭", async () => {
    const { events, run } = await setup({ beforeParkOpen: () => ({ veto: "无人值守" }) });

    expect(await run("demo_wait", null)).toMatchObject({ ok: false, by: "demo_wait", reason: "无人值守" });
    expect(events.map((e) => e.type)).toEqual(["run.started", "park.closed", "run.exited"]);
    expect(events[1]).toMatchObject({ step: 0, result: by("无人值守") });
  });

  test("beforeParkClose 拦下：unpark 与撤回抛异常，park 照旧等待；放行后照常送值", async () => {
    let allow = false;
    const { kernel } = await setup({ beforeParkClose: () => (allow ? undefined : { veto: "还不能答" }) });
    const root = kernel.submit("demo_wait", null);

    expect(() => kernel.unpark(root, true)).toThrow(`park ${root} close rejected by policy: 还不能答`);
    expect(() => kernel.withdraw(root, "算了")).toThrow("还不能答");
    allow = true;
    kernel.unpark(root, true);
    expect(await kernel.reap(root)).toEqual({ ok: true, value: true });
  });
});

describe("拦下与恢复", () => {
  /** 「崩溃」：把此刻的日志目录拷一份 */
  const crash = () => {
    const to = `${dir}-crash`;
    cpSync(dir, to, { recursive: true });
    return to;
  };

  test("被拦下的结果照常记进日志；恢复时原样回送，不再问挂点", async () => {
    const one = await setup({ beforeRunStart: (e) => (e.input === "b" ? { veto: "不许 b" } : undefined) }, dir);
    const root = one.kernel.submit("demo_flow", null);
    await Bun.sleep(5);

    // 恢复时挂点已不再拦，也不该再被问到已完成的那两步
    const asked: unknown[] = [];
    const two = await setup({ beforeRunStart: (e) => void asked.push(e.operation) }, crash());
    await Bun.sleep(5);
    const park = two.events.find((e) => e.type === "park.opened")!.runId;
    two.kernel.unpark(park, true);
    expect(await two.kernel.reap(root)).toEqual({
      ok: true,
      value: [{ ok: true, value: "a" }, by("不许 b"), { ok: true, value: true }],
    });
    expect(asked).toEqual(["demo_flow", "demo_wait"]);
    expect(two.ran.echo).toBe(0);
  });

  test("beforeTreeRecover 拦下：这棵树不恢复，以 run.killed 结束，日志移到 diverged/", async () => {
    const one = await setup({}, dir);
    const root = one.kernel.submit("demo_wait", null);
    const twoDir = crash();

    const two = await setup({ beforeTreeRecover: (e) => (e.runId === root ? { veto: "太旧了" } : undefined) }, twoDir);
    expect(two.roots).toEqual([root]);
    expect(await two.kernel.reap(root)).toEqual(by("太旧了"));
    expect(two.events.map((e) => e.type)).toEqual(["tree.recovered", "run.killed"]);
    expect(two.events[1]).toMatchObject({ reason: "rejected by policy: 太旧了" });
    expect(readdirSync(join(twoDir, "diverged"))).toEqual([`${root}.jsonl`]);
  });
});
