import { expect, test } from "bun:test";
import { join } from "node:path";
import { pluginViolations } from "pkg/layers";

test("这个应用的插件不直接做 IO，只用注入的基建（约束见 pkg/layers.ts）", async () => {
  expect(await pluginViolations(join(import.meta.dir, "plugins"))).toEqual([]);
});
