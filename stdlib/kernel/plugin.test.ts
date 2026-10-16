import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { HarnessEvent } from "./events";
import { decorator, op, type PluginObject } from "./plugin";
import { Kernel } from "./kernel";

const YES_NO = z.toJSONSchema(z.boolean());

/** console.error 收进 errors：挂点出错只记下 */
let errors: unknown[][];
const origError = console.error;
beforeEach(() => {
  errors = [];
  console.error = (...args: unknown[]) => errors.push(args);
});
afterEach(() => {
  console.error = origError;
});

/** demo 插件：wait 经 ctx.park 等一个布尔值；gate 卡在 gate 上，直到测试放行 */
function demo(gate = Promise.withResolvers<void>()): PluginObject {
  return {
    operations: {
      wait: op({ input: z.null(), impl: (ctx) => ctx.park({ schema: YES_NO, payload: null }) }),
      gate: op({
        input: z.null(),
        impl: async () => {
          await gate.promise;
          return "open";
        },
      }),
    },
  };
}

describe("装上插件", () => {
  test("插件对象里的 Operation 与装饰器注册为「包名_键名」", async () => {
    const kernel = new Kernel();
    kernel.use("demo", {
      operations: { echo: op({ input: z.string(), decorators: ["demo_shout"], impl: async (_ctx, s) => s }) },
      decorators: {
        shout: decorator({
          fn: async (_ctx, _run, next) => {
            const r = await next();
            return r.ok ? { ok: true, value: `${r.value}!` } : r;
          },
        }),
      },
    });
    await kernel.boot();

    expect(await kernel.reap(kernel.submit("demo_echo", "hi"))).toEqual({ ok: true, value: "hi!" });
  });

  test("挂点方法名拼错了、键名不合命名规则、包重复：装上时就报错", () => {
    const kernel = new Kernel();
    const typo = { afterRunExited() {} } as PluginObject;

    expect(() => kernel.use("demo", typo)).toThrow("demo: unknown key in plugin object: afterRunExited");
    expect(() => kernel.use("demo", { decorators: { "a-b": decorator({ fn: (_c, _r, next) => next() }) } })).toThrow(
      "invalid name: demo_a-b",
    );
    kernel.use("other", {});
    expect(() => kernel.use("other", {})).toThrow("duplicate plugin: other");
  });
});

describe("启动", () => {
  test("onStart 逐个等完（没有依赖时按装载顺序），然后恢复没跑完的树，最后通知 afterStart；返回恢复的树", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plugin-"));
    const one = new Kernel({ journalDir: dir });
    one.use("demo", demo());
    await one.boot();
    const root = one.submit("demo_wait", null);

    const kernel = new Kernel({ journalDir: dir });
    const order: string[] = [];
    kernel.use("demo", demo());
    kernel.use("slow", {
      async onStart() {
        await Bun.sleep(5);
        order.push("slow.onStart");
      },
      afterTreeRecover: (e) => void order.push(`slow.afterTreeRecover ${e.runId === root}`),
      afterStart: () => void order.push("slow.afterStart"),
    });
    kernel.use("fast", { onStart: () => void order.push("fast.onStart") });

    expect(await kernel.boot()).toEqual([root]);
    expect(order).toEqual(["slow.onStart", "fast.onStart", "slow.afterTreeRecover true", "slow.afterStart"]);
  });

  test("boot 之前不能 start，boot 之后不能 use，boot 只能一次", async () => {
    const kernel = new Kernel();
    kernel.use("demo", demo());

    expect(() => kernel.submit("demo_gate", null)).toThrow("harness is assembling");
    await kernel.boot();
    expect(() => kernel.use("late", {})).toThrow("cannot use late: harness is running");
    await expect(kernel.boot()).rejects.toThrow("harness is running");
  });

  test("onStart 抛异常：启动失败，后面的插件不再 onStart，不接受调用", async () => {
    const kernel = new Kernel();
    const started: string[] = [];
    kernel.use("demo", demo());
    kernel.use("broken", {
      onStart() {
        throw new Error("no disk");
      },
    });
    kernel.use("after", { onStart: () => void started.push("after") });

    await expect(kernel.boot()).rejects.toThrow("broken.onStart failed: no disk");
    expect(started).toEqual([]);
    expect(() => kernel.submit("demo_gate", null)).toThrow("harness is booting");
  });
});

describe("通知类挂点", () => {
  test("after* 接对应的事件，afterAny 接所有事件；没实现的不调", async () => {
    const kernel = new Kernel();
    const seen: string[] = [];
    kernel.use("demo", demo());
    kernel.use("watch", {
      afterRunStart: (e) => void seen.push(`start ${e.operation}`),
      afterParkOpen: (e) => void seen.push(`park ${e.schema.type}`),
      afterRunExit: (e) => void seen.push(`exit ${e.operation} ${e.result.ok}`),
    });
    const all: HarnessEvent[] = [];
    kernel.use("log", { afterAny: (e) => void all.push(e) });
    await kernel.boot();

    const root = kernel.submit("demo_wait", null);
    kernel.unpark(root, true);
    await kernel.reap(root);
    expect(seen).toEqual(["start demo_wait", "park boolean", "exit demo_wait true"]);
    expect(all.map((e) => e.type)).toEqual(["run.started", "park.opened", "park.closed", "run.exited", "run.reaped"]);
  });

  test("挂点出错（同步抛出或 async 拒绝）只记下，不影响 Run 与其他插件", async () => {
    const kernel = new Kernel();
    const exits: string[] = [];
    const gate = Promise.withResolvers<void>();
    gate.resolve();
    kernel.use("demo", demo(gate));
    kernel.use("sync", {
      afterRunStart() {
        throw new Error("sync down");
      },
    });
    kernel.use("async", {
      async afterAny() {
        throw new Error("async down");
      },
    });
    kernel.use("ok", { afterRunExit: (e) => void exits.push(e.runId) });
    await kernel.boot();

    const root = kernel.submit("demo_gate", null);
    expect(await kernel.reap(root)).toEqual({ ok: true, value: "open" });
    await Bun.sleep(1);
    expect(exits).toEqual([root]);
    expect(errors.map((args) => args[0])).toEqual([
      "[harness] sync.afterRunStart on event #1 failed",
      "[harness] async.afterAny on event #1 failed",
      "[harness] async.afterAny on event #2 failed",
      "[harness] async.afterAny on event #3 failed",
    ]);
  });
});

describe("关停", () => {
  test("在途的树杀掉之后，逆序逐个等完 onStop（没有依赖时按装载的逆序）；出错只记下；重复 stop 只跑一次", async () => {
    const kernel = new Kernel();
    const order: string[] = [];
    kernel.use("demo", {
      ...demo(),
      onStop: () => void order.push("demo.onStop"),
      afterRunKill: (e) => void order.push(`killed ${e.reason}`),
    });
    kernel.use("broken", {
      onStop() {
        throw new Error("flush failed");
      },
    });
    kernel.use("slow", {
      async onStop() {
        await Bun.sleep(5);
        order.push("slow.onStop");
      },
    });
    await kernel.boot();
    kernel.submit("demo_gate", null);

    await Promise.all([kernel.stop(60_000), kernel.stop(0)]);
    expect(order).toEqual(["killed shutdown", "slow.onStop", "demo.onStop"]);
    expect(errors.map((args) => args[0])).toEqual(["[harness] broken.onStop failed"]);
  });

  test("boot 之前不能 stop", async () => {
    await expect(new Kernel().stop(0)).rejects.toThrow("harness is assembling");
  });
});

describe("依赖与先后", () => {
  test("requires：插件按依赖排先后，同级按装载顺序；onStart 依赖先，onStop 依赖后", async () => {
    const kernel = new Kernel();
    const order: string[] = [];
    const track = (pkg: string, requires?: string[]): PluginObject => ({
      requires,
      onStart: () => void order.push(`start ${pkg}`),
      onStop: () => void order.push(`stop ${pkg}`),
    });
    kernel.use("app", track("app", ["db"]));
    kernel.use("log", track("log"));
    kernel.use("db", track("db", ["cache"]));
    kernel.use("cache", track("cache"));
    await kernel.boot();
    await kernel.stop(0);

    expect(order).toEqual([
      ...["log", "cache", "db", "app"].map((pkg) => `start ${pkg}`),
      ...["app", "db", "cache", "log"].map((pkg) => `stop ${pkg}`),
    ]);
  });

  test("缺了依赖、依赖成环：启动失败", async () => {
    const missing = new Kernel();
    missing.use("app", { requires: ["db"] });
    await expect(missing.boot()).rejects.toThrow("app requires db, which is not loaded");

    const cycle = new Kernel();
    cycle.use("a", { requires: ["b"] });
    cycle.use("b", { requires: ["a"] });
    await expect(cycle.boot()).rejects.toThrow("plugins require each other: b → a → b");
  });

  test("事件挂点缺省依赖先调；order 只在写了的挂点上把自己排到依赖前面，没装的插件忽略", async () => {
    const kernel = new Kernel();
    const calls: string[] = [];
    kernel.use("demo", demo());
    kernel.use("policy", {
      requires: ["audit"],
      order: { beforeRunStart: { before: ["audit", "absent"] } },
      beforeRunStart: (e) => (calls.push(`policy before ${e.operation}`), e.operation === "demo_gate" ? { veto: "no" } : undefined),
      afterRunExit: () => void calls.push("policy after"),
    });
    kernel.use("audit", {
      beforeRunStart: () => void calls.push("audit before"),
      afterRunExit: () => void calls.push("audit after"),
    });
    await kernel.boot();

    const gate = kernel.submit("demo_wait", null);
    kernel.unpark(gate, true);
    await kernel.reap(gate);
    expect(calls).toEqual(["policy before demo_wait", "audit before", "audit after", "policy after"]);

    // 第一个拦下的生效：排在前面的 policy 拦下了，audit 不再被问
    calls.length = 0;
    expect(() => kernel.submit("demo_gate", null)).toThrow("rejected by policy: no");
    expect(calls).toEqual(["policy before demo_gate"]);
  });

  test("order 写了非事件挂点、排出环：装上或启动时报错", async () => {
    const kernel = new Kernel();
    expect(() => kernel.use("bad", { order: { onStart: {} } } as PluginObject)).toThrow(
      "bad: order only applies to event hooks, got onStart",
    );

    const cycle = new Kernel();
    cycle.use("a", { order: { afterRunStart: { before: ["b"] } }, afterRunStart() {} });
    cycle.use("b", { order: { afterRunStart: { before: ["a"] } }, afterRunStart() {} });
    await expect(cycle.boot()).rejects.toThrow("order of afterRunStart has a cycle");
  });

  test("装饰器的引用启动时就查：引用别的包的装饰器，那个包要在 requires 里", async () => {
    const guard: PluginObject = { decorators: { check: decorator({ fn: (_ctx, _run, next) => next() }) } };
    const app = (requires?: string[]): PluginObject => ({
      requires,
      operations: { run: op({ input: z.null(), decorators: ["guard_check"], impl: async () => "ok" }) },
    });

    const undeclared = new Kernel();
    undeclared.use("guard", guard);
    undeclared.use("app", app());
    await expect(undeclared.boot()).rejects.toThrow("app_run uses guard_check: add guard to the requires of app");

    const declared = new Kernel();
    declared.use("guard", guard);
    declared.use("app", app(["guard"]));
    await declared.boot();
    expect(await declared.reap(declared.submit("app_run", null))).toEqual({ ok: true, value: "ok" });
  });
});
