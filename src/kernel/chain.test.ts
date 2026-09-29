import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { Decorator, OnError } from "./chain";
import type { HarnessEvent } from "./events";
import { Kernel } from "./kernel";

/** echo_say 把收到的入参原样返回，并记下被调用的次数 */
function setup(defaultDecorators: string[], decorators: Record<string, Decorator | [Decorator, OnError]>) {
  const kernel = new Kernel({ defaultDecorators });
  const events: HarnessEvent[] = [];
  kernel.events.subscribe((e) => events.push(e));
  for (const [id, d] of Object.entries(decorators)) {
    const [fn, onError] = Array.isArray(d) ? d : [d, "closed" as const];
    kernel.registerDecorator({ id, onError, fn });
  }
  const echo = { calls: 0 };
  const own = Object.keys(decorators).filter((id) => !defaultDecorators.includes(id));
  kernel.register({
    name: "echo_say",
    input: z.string(),
    decorators: own,
    impl: async (_ctx, input) => {
      echo.calls++;
      return input;
    },
  });
  const call = (input: unknown) => kernel.reap(kernel.start("echo_say", input));
  const decoratorEvents = () => events.filter((e) => e.type.startsWith("decorator."));
  return { call, events, decoratorEvents, echo };
}

describe("装饰器链", () => {
  test("默认装饰器在外、自选装饰器在内，同层按书写顺序嵌套", async () => {
    const log: string[] = [];
    const tracing =
      (id: string): Decorator =>
      async (_ctx, _run, next) => {
        log.push(`${id}>`);
        const r = await next();
        log.push(`<${id}`);
        return r;
      };
    const { call, events } = setup(["d1"], { d1: tracing("d1"), a: tracing("a"), b: tracing("b") });

    expect(await call("x")).toEqual({ ok: true, value: "x" });
    expect(log).toEqual(["d1>", "a>", "b>", "<b", "<a", "<d1"]);
    expect(events[0]).toMatchObject({ type: "run.started", chain: ["d1", "a", "b"] });
  });

  test("放行不发事件；改写入参与结果各发一条事件", async () => {
    const { call, decoratorEvents } = setup([], {
      pass: (_ctx, _run, next) => next(),
      upper: async (_ctx, run, next) => {
        run.input = String(run.input).toUpperCase();
        const r = await next();
        return r.ok ? { ok: true, value: `${r.value}!` } : r;
      },
    });

    expect(await call("hi")).toEqual({ ok: true, value: "HI!" });
    expect(decoratorEvents()).toMatchObject([
      { type: "decorator.rewrote", decorator: "upper", phase: "input", value: "HI" },
      { type: "decorator.rewrote", decorator: "upper", phase: "result", value: { ok: true, value: "HI!" } },
    ]);
  });

  test("拒绝：不调 next 直接返回拒绝结果，实现不执行", async () => {
    const denied = { ok: false as const, by: "guard", reason: "no", retryable: true };
    const { call, decoratorEvents, echo } = setup(["guard"], { guard: async () => denied });

    expect(await call("x")).toEqual(denied);
    expect(echo.calls).toBe(0);
    expect(decoratorEvents()).toMatchObject([{ type: "decorator.rejected", decorator: "guard", result: denied }]);
  });

  test("配置冻结：next 之后改入参会出错", async () => {
    const { call, decoratorEvents } = setup([], {
      late: async (_ctx, run, next) => {
        const r = await next();
        run.input = "changed";
        return r;
      },
    });

    expect(await call("x")).toMatchObject({ ok: false, by: "late", reason: expect.stringContaining("readonly") });
    expect(decoratorEvents()).toMatchObject([{ type: "decorator.failed", decorator: "late", onError: "closed" }]);
  });

  test("onError open：出错跳过这一环，并撤销它对入参的改写", async () => {
    const { call, decoratorEvents } = setup([], {
      flaky: [
        async (_ctx, run) => {
          run.input = "half-done";
          throw new Error("oops");
        },
        "open",
      ],
    });

    expect(await call("x")).toEqual({ ok: true, value: "x" });
    expect(decoratorEvents()).toMatchObject([{ type: "decorator.failed", onError: "open", error: "oops" }]);
  });

  test("onError closed：出错中断 Run，以该装饰器的拒绝结果退出", async () => {
    const { call, echo } = setup(["strict"], {
      strict: async () => {
        throw new Error("oops");
      },
    });

    expect(await call("x")).toEqual({ ok: false, by: "strict", reason: "oops", retryable: false });
    expect(echo.calls).toBe(0);
  });

  test("next 只能调一次", async () => {
    const { call, echo } = setup([], {
      twice: async (_ctx, _run, next) => {
        await next();
        return next();
      },
    });

    expect(await call("x")).toMatchObject({ ok: false, by: "twice", reason: "decorator twice called next() twice" });
    expect(echo.calls).toBe(1);
  });

  test("引用未注册的装饰器：start 直接报错", () => {
    const kernel = new Kernel({ defaultDecorators: ["ghost"] });
    kernel.register({ name: "echo_say", input: z.any(), impl: async (_ctx, x) => x });
    expect(() => kernel.start("echo_say", {})).toThrow("unknown decorator: ghost");
  });
});
