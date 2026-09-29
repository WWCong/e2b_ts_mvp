import { expect, test } from "bun:test";
import { z } from "zod";
import type { HarnessEvent } from "../../kernel/events";
import { Kernel } from "../../kernel/kernel";
import { loadPlugin } from "../../kernel/loader";

test("stdlib_park：挂起调用方的子 Run，unpark 送来的值作为结果返回；撤回时 by 为 stdlib_park", async () => {
  const kernel = new Kernel();
  const opened: string[] = [];
  kernel.events.subscribe((e: HarnessEvent) => e.type === "park.opened" && opened.push(e.runId));
  await loadPlugin(kernel, import.meta.dir);
  const schema = z.toJSONSchema(z.enum(["yes", "no"]));
  kernel.register({
    name: "demo_ask",
    input: z.null(),
    impl: (ctx) => Promise.all([0, 1].map(() => ctx.call("stdlib_park", { schema, payload: null }))),
  });
  const root = kernel.start("demo_ask", null);

  kernel.unpark(opened[0]!, "yes");
  kernel.withdraw(opened[1]!, "timeout");
  expect(await kernel.reap(root)).toEqual({
    ok: true,
    value: [
      { ok: true, value: "yes" },
      { ok: false, by: "stdlib_park", reason: "timeout", retryable: false },
    ],
  });
});
