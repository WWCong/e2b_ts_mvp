import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Outside } from "./entry";
import type { HarnessEvent } from "./events";
import { Kernel } from "./kernel";
import { loadPlugin } from "./loader";
import { op } from "./plugin";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "entry-"));
});

/**
 * demo_ask 声明了 api，它调不对外的 demo_inner，再 park 等外部的值；demo_inner 自己没声明 api。
 * 入口 door 由装载器装上，拿到对外接口（fixture 把它交出来）
 */
async function setup(journalDir?: string) {
  const kernel = new Kernel({ journalDir });
  const events: HarnessEvent[] = [];
  kernel.events.subscribe((e) => events.push(e));
  kernel.use("demo", {
    operations: {
      ask: op({
        api: true,
        input: z.object({ q: z.string() }),
        impl: async (ctx, { q }) => {
          await ctx.call("demo_inner", null);
          return ctx.park({ schema: z.toJSONSchema(z.string()), payload: q });
        },
      }),
      inner: op({ input: z.null(), impl: async () => "inner" }),
    },
  });
  let outside: Outside | undefined;
  let served = 0;
  const door = await loadPlugin(kernel, join(import.meta.dir, "__fixtures__", "door"), {
    expose: (o: Outside) => (outside = o),
    served: () => served++,
  });
  const roots = await kernel.boot();
  const parked = () => events.filter((e) => e.type === "park.opened").at(-1)!.runId;
  return { kernel, events, door, roots, outside: outside!, parked, served: () => served };
}

describe("入口与对外接口", () => {
  test("入口只能调声明了 api 的 Operation；它发起的树的根记下入口的包名，子 Run 不记", async () => {
    const { kernel, events, outside, parked } = await setup();

    for (const name of ["demo_inner", "demo_nope"]) {
      expect(() => outside.submit(name, null)).toThrow(`not an api operation: ${name}`);
    }
    const root = outside.submit("demo_ask", { q: "哪个？" });
    await Bun.sleep(1);
    outside.unpark(parked(), "这个");
    expect(await outside.reap(root)).toEqual({ ok: true, value: "这个" });

    const started = events.filter((e) => e.type === "run.started");
    expect(started.map((e) => [e.operation, e.origin])).toEqual([
      ["demo_ask", "door"],
      ["demo_inner", undefined],
    ]);
    // 宿主（握着内核的）什么都能调，不记 origin
    expect(await kernel.reap(kernel.submit("demo_inner", null))).toEqual({ ok: true, value: "inner" });
    const last = events.filter((e) => e.type === "run.started").at(-1)!;
    expect([last.operation, last.origin]).toEqual(["demo_inner", undefined]);
  });

  test("origin 写进日志的根行；重启恢复后 tree.recovered 带上根的 Operation 与 origin，入口只认领自己发起的树", async () => {
    const one = await setup(dir);
    const mine = one.outside.submit("demo_ask", { q: "哪个？" });
    const hosts = one.kernel.submit("demo_ask", { q: "宿主问的" });
    await Bun.sleep(1);
    const line = JSON.parse((await readFile(join(dir, `${mine}.jsonl`), "utf8")).split("\n")[0]!);
    expect(line).toMatchObject({ type: "root", operation: "demo_ask", origin: "door" });
    await one.kernel.stop(1000);
    expect((await readdir(dir)).sort()).toEqual([`${hosts}.jsonl`, `${mine}.jsonl`].sort());

    const two = await setup(dir);
    expect(two.roots.sort()).toEqual([hosts, mine].sort());
    expect(two.outside.recovered()).toEqual([mine]);
    expect(two.events.filter((e) => e.type === "tree.recovered").map((e) => [e.runId, e.operation, e.origin])).toContainEqual([
      mine,
      "demo_ask",
      "door",
    ]);
    // 重新执行的根仍带 origin
    expect(two.events.find((e) => e.type === "run.started" && e.runId === mine)).toMatchObject({ origin: "door", attempt: 2 });
    await Bun.sleep(1);
    for (const e of two.events.filter((e) => e.type === "park.opened")) two.outside.unpark(e.runId, "好");
    expect(await two.outside.reap(mine)).toEqual({ ok: true, value: "好" });
  });

  test("装载器把对外接口交给入口的工厂，serve 交回给调用方，不当作插件对象的键", async () => {
    const { door, served } = await setup();
    expect(served()).toBe(0);
    await door!();
    expect(served()).toBe(1);
  });
});
