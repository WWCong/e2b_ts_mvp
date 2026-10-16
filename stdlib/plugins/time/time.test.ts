import { expect, test } from "bun:test";
import { Kernel, loadPlugin } from "stdlib";

test("time_now：返回当前时间（毫秒）", async () => {
  const kernel = new Kernel();
  await loadPlugin(kernel, import.meta.dir);
  await kernel.boot();
  const before = Date.now();

  const result = await kernel.reap(kernel.submit("time_now", null));
  if (!result.ok) throw new Error(result.reason);
  expect(result.value).toBeGreaterThanOrEqual(before);
});
