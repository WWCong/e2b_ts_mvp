import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import type { HarnessEvent } from "../../../src/kernel/events";
import { Kernel } from "../../../src/kernel/kernel";
import { loadPlugin } from "../../../src/kernel/loader";

/** demo_delete 自选 ui_approval；deleted 记下实现有没有执行 */
async function setup() {
  const kernel = new Kernel();
  const events: HarnessEvent[] = [];
  kernel.events.subscribe((e) => events.push(e));
  await loadPlugin(kernel, join(import.meta.dir, "..", "..", "..", "src", "plugins", "stdlib"));
  await loadPlugin(kernel, import.meta.dir);
  const deleted: string[] = [];
  kernel.register({
    name: "demo_delete",
    input: z.object({ path: z.string() }),
    decorators: ["ui_approval"],
    impl: async (_ctx, input: { path: string }) => deleted.push(input.path),
  });
  const lastPark = () => events.filter((e) => e.type === "park.opened").at(-1)!;
  /** 起一个 Run，等它开出 park 后送去 answer，返回收割结果 */
  const answer = (name: string, input: unknown, value: unknown) => {
    const id = kernel.start(name, input);
    kernel.unpark(lastPark().runId, value);
    return kernel.reap(id);
  };
  return { kernel, deleted, lastPark, answer };
}

describe("ui_ask", () => {
  test("给了 options：payload 按约定格式交给外部；回答是选项，可带补充说明，也可只写文字", async () => {
    const { kernel, lastPark, answer } = await setup();
    const input = { question: "用哪种格式？", options: ["md", "txt"] };

    const root = kernel.start("ui_ask", input);
    expect(lastPark().payload).toEqual(input);
    expect(() => kernel.unpark(lastPark().runId, { option: "pdf" })).toThrow("invalid value for park");
    kernel.unpark(lastPark().runId, { option: "md", text: "标题用日期" });
    expect(await kernel.reap(root)).toEqual({ ok: true, value: { option: "md", text: "标题用日期" } });

    expect(await answer("ui_ask", input, { text: "都不要，用 pdf" })).toEqual({ ok: true, value: { text: "都不要，用 pdf" } });
  });

  test("没给 options：回答是文字；被撤回时以 ui_ask 的拒绝返回", async () => {
    const { kernel, lastPark, answer } = await setup();
    const input = { question: "文件名叫什么？" };
    expect(await answer("ui_ask", input, { text: "summary.md" })).toEqual({ ok: true, value: { text: "summary.md" } });

    const withdrawn = kernel.start("ui_ask", input);
    kernel.withdraw(lastPark().runId, "用户不回答");
    expect(await kernel.reap(withdrawn)).toMatchObject({ ok: false, by: "ui_ask", reason: "用户不回答" });
  });
});

describe("ui_approval", () => {
  test("先问人：选 yes 才执行；带补充说明时结果连同说明一起交回", async () => {
    const { kernel, deleted, lastPark, answer } = await setup();

    const id = kernel.start("demo_delete", { path: "a.txt" });
    expect(lastPark().payload).toEqual({ question: '允许执行 demo_delete？{"path":"a.txt"}', options: ["yes", "no"] });
    kernel.unpark(lastPark().runId, { option: "yes" });
    expect(await kernel.reap(id)).toEqual({ ok: true, value: 1 });

    expect(await answer("demo_delete", { path: "b.txt" }, { option: "yes", text: "下次先问我" })).toEqual({
      ok: true,
      value: { result: 2, userNote: "下次先问我" },
    });
    expect(deleted).toEqual(["a.txt", "b.txt"]);
  });

  test("不批准：选 no 不可重试；写了说明（带不带 no 都算）则原因带上说明，可改了再试", async () => {
    const { deleted, answer } = await setup();
    const input = { path: "a.txt" };

    expect(await answer("demo_delete", input, { option: "no" })).toEqual({
      ok: false,
      by: "ui_approval",
      reason: "用户拒绝了这次调用",
      retryable: false,
    });
    for (const value of [{ option: "no", text: "删 b.txt" }, { text: "删 b.txt" }]) {
      expect(await answer("demo_delete", input, value)).toEqual({
        ok: false,
        by: "ui_approval",
        reason: "用户没有批准：删 b.txt",
        retryable: true,
      });
    }
    expect(deleted).toEqual([]);
  });

  test("审批被撤回：拒绝，原因取撤回的原因", async () => {
    const { kernel, deleted, lastPark } = await setup();
    const id = kernel.start("demo_delete", { path: "a.txt" });

    kernel.withdraw(lastPark().runId, "用户不回答：不确定");
    expect(await kernel.reap(id)).toMatchObject({ ok: false, by: "ui_approval", reason: "用户不回答：不确定" });
    expect(deleted).toEqual([]);
  });
});
