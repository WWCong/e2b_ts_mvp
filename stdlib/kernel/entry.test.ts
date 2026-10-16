import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Outside } from "./entry";
import { Kernel } from "./kernel";
import { loadPlugin } from "./loader";

describe("入口", () => {
  test("装载器把对外接口交给入口的工厂，serve 交回给调用方，不当作插件对象的键", async () => {
    const kernel = new Kernel();
    let outside: Outside | undefined;
    let served = 0;
    const door = await loadPlugin(kernel, join(import.meta.dir, "__fixtures__", "door"), {
      expose: (o: Outside) => (outside = o),
      served: () => served++,
    });
    await kernel.boot();

    expect(outside?.operations()).toEqual([]);
    expect(served).toBe(0);
    await door!();
    expect(served).toBe(1);
  });
});
