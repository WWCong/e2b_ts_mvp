import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Kernel, loadPlugin, type HarnessEvent } from "stdlib";
import { localDir } from "stdlib/infra/volume";
import { installedScripts } from "../../script/installed";

/** 草稿 stats：count 把数乘二后加起来；reply 是它多返回的一句话，换版本用 */
const draft = (reply: string) => `
  import { z } from "zod";
  import { op, script } from "stdlib";
  export default script({
    operations: {
      count: op({
        usage: "加起来",
        input: z.object({ items: z.array(z.number()) }),
        impl: async (ctx, { items }) => {
          const doubled = await Promise.all(items.map((n) => ctx.call("demo_double", n)));
          return [doubled.reduce((sum, r) => sum + r.value, 0), ${JSON.stringify(reply)}];
        },
      }),
    },
  });`;

/**
 * 与宿主一样的装法：harness、ui、package 插件，装上的包在 state/scripts；装配里有个 script 包叫 chat。
 * 人对每个问题都答 answer（审批时 yes 或 no）
 */
async function setup(root: string, answer: "yes" | "no" = "yes") {
  const kernel = new Kernel();
  const events: HarnessEvent[] = [];
  kernel.events.subscribe((e) => events.push(e));
  kernel.events.subscribe((e) => e.type === "park.opened" && queueMicrotask(() => kernel.unpark(e.runId, { option: answer })));
  const installed = installedScripts(kernel, join(root, "state", "scripts"), new Set(["chat"]));
  const infra = { workspace: localDir(join(root, "ws")), scripts: installed.scripts };
  await infra.workspace.open();
  for (const pkg of ["harness", "ui", "package"]) await loadPlugin(kernel, join(import.meta.dir, "..", pkg), {}, infra);
  kernel.register({ name: "demo_double", usage: "乘二", public: true, input: z.number(), impl: async (_ctx, n: number) => n * 2 });
  await installed.loadAll();
  await kernel.boot();
  const run = (name: string, input: unknown) => kernel.reap(kernel.submit(name, input));
  return { kernel, events, run };
}

describe("package_install", () => {
  test("问过人，把草稿装进运行中的 Harness：之后就能调，重启后还在；再装同名的换掉", async () => {
    const root = await mkdtemp(join(tmpdir(), "install-"));
    await Bun.write(join(root, "ws/drafts/stats/index.ts"), draft("v1"));
    const one = await setup(root);

    expect(await one.run("package_install", { dir: "drafts/stats" })).toEqual({ ok: true, value: ["stats_count"] });
    expect(one.events.some((e) => e.type === "park.opened")).toBe(true);
    expect(await one.run("stats_count", { items: [1, 2] })).toEqual({ ok: true, value: [6, "v1"] });
    expect(readdirSync(join(root, "state/scripts"))).toEqual(["stats"]);

    await Bun.write(join(root, "ws/drafts/stats/index.ts"), draft("v2"));
    expect(await one.run("package_install", { dir: "drafts/stats" })).toEqual({ ok: true, value: ["stats_count"] });
    expect(await one.run("stats_count", { items: [1] })).toEqual({ ok: true, value: [2, "v2"] });

    const two = await setup(root);
    expect(await two.run("stats_count", { items: [3] })).toEqual({ ok: true, value: [6, "v2"] });
  });

  test("人不批准、草稿写错、名字与装配里的重：都不装，盘上什么也不留", async () => {
    const root = await mkdtemp(join(tmpdir(), "install-"));
    await Bun.write(join(root, "ws/drafts/stats/index.ts"), draft("v1"));
    await Bun.write(join(root, "ws/drafts/broken/index.ts"), "export default 1 +;");

    const denied = await setup(root, "no");
    expect(await denied.run("package_install", { dir: "drafts/stats" })).toMatchObject({ ok: false, by: "ui_approval" });
    expect(() => denied.kernel.submit("stats_count", { items: [] })).toThrow("unknown operation: stats_count");

    const { run } = await setup(root);
    expect(await run("package_install", { dir: "drafts/broken" })).toMatchObject({ ok: false, reason: "broken: 1:19 Unexpected ;" });
    expect(await run("package_install", { dir: "drafts/stats", name: "chat" })).toMatchObject({
      ok: false,
      reason: "chat is part of the assembly: change it there",
    });
    expect(await run("package_install", { dir: "drafts/stats", name: "Stats" })).toMatchObject({ ok: false, reason: "invalid package name: Stats (lowercase letters, digits and -)" });
    expect(await run("package_install", { dir: "drafts/none" })).toMatchObject({ ok: false, reason: "no drafts/none/index.ts in the workspace" });
    expect(existsSync(join(root, "state/scripts")) ? readdirSync(join(root, "state/scripts")) : []).toEqual([]);
  });
});
