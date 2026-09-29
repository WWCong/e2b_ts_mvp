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
  const parks = () => events.filter((e) => e.type === "park.opened");
  const lastPark = () => parks().at(-1)!;
  return { kernel, deleted, parks, lastPark };
}

describe("ui_ask", () => {
  test("给了 options：payload 按约定格式交给外部，回答只能是其中之一", async () => {
    const { kernel, lastPark } = await setup();
    const root = kernel.start("ui_ask", { question: "用哪种格式？", options: ["md", "txt"] });

    expect(lastPark().payload).toEqual({ question: "用哪种格式？", options: ["md", "txt"] });
    expect(() => kernel.unpark(lastPark().runId, "pdf")).toThrow("invalid value for park");
    kernel.unpark(lastPark().runId, "md");
    expect(await kernel.reap(root)).toEqual({ ok: true, value: "md" });
  });

  test("没给 options：回答任意文本；被撤回时以 ui_ask 的拒绝返回", async () => {
    const { kernel, lastPark } = await setup();
    const answered = kernel.start("ui_ask", { question: "文件名叫什么？" });
    kernel.unpark(lastPark().runId, "summary.md");
    expect(await kernel.reap(answered)).toEqual({ ok: true, value: "summary.md" });

    const withdrawn = kernel.start("ui_ask", { question: "文件名叫什么？" });
    kernel.withdraw(lastPark().runId, "输入已结束");
    expect(await kernel.reap(withdrawn)).toMatchObject({ ok: false, by: "ui_ask", reason: "输入已结束" });
  });
});

describe("ui_approval", () => {
  test("先问人：回答 yes 才执行；no 则拒绝，实现不执行", async () => {
    const { kernel, deleted, lastPark } = await setup();

    const yes = kernel.start("demo_delete", { path: "a.txt" });
    expect(lastPark().payload).toEqual({ question: '允许执行 demo_delete？{"path":"a.txt"}', options: ["yes", "no"] });
    kernel.unpark(lastPark().runId, "yes");
    expect(await kernel.reap(yes)).toEqual({ ok: true, value: 1 });

    const no = kernel.start("demo_delete", { path: "b.txt" });
    kernel.unpark(lastPark().runId, "no");
    expect(await kernel.reap(no)).toEqual({ ok: false, by: "ui_approval", reason: "用户拒绝了这次调用", retryable: false });
    expect(deleted).toEqual(["a.txt"]);
  });

  test("审批被撤回：拒绝，原因取撤回的原因", async () => {
    const { kernel, deleted, lastPark } = await setup();
    const id = kernel.start("demo_delete", { path: "a.txt" });

    kernel.withdraw(lastPark().runId, "输入已结束");
    expect(await kernel.reap(id)).toMatchObject({ ok: false, by: "ui_approval", reason: "输入已结束" });
    expect(deleted).toEqual([]);
  });
});
