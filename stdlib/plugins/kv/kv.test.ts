import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Kernel, loadPlugin, op } from "stdlib";
import { localDir } from "stdlib/infra/volume";

/** 两个 script 包用同一个键存取：各存各的 */
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "kv-"));
  const kernel = new Kernel();
  await loadPlugin(kernel, import.meta.dir, {}, { state: localDir(dir) });
  for (const pkg of ["alpha", "beta"]) {
    kernel.useScript(pkg, {
      operations: {
        put: op({ usage: "存", input: z.unknown(), impl: (ctx, value) => ctx.ops.kv.set({ key: "notes", value }) }),
        take: op({ usage: "取", input: z.null(), impl: (ctx) => ctx.ops.kv.get({ key: "notes" }) }),
      },
    });
  }
  await kernel.boot();
  const run = (name: string, input: unknown) => kernel.reap(kernel.submit(name, input));
  return { dir, kernel, run };
}

test("kv：按调用方所在的包分开；没存过的取到 null；值整个替换，存在 kv 那块存储下的 <包名>/<键>.json", async () => {
  const { dir, run } = await setup();
  expect(await run("alpha_take", null)).toEqual({ ok: true, value: { ok: true, value: null } });

  await run("alpha_put", { list: [1, 2] });
  await run("beta_put", "b 的");
  await run("alpha_put", { list: [3] });
  expect(await run("alpha_take", null)).toEqual({ ok: true, value: { ok: true, value: { list: [3] } } });
  expect(await run("beta_take", null)).toEqual({ ok: true, value: { ok: true, value: "b 的" } });
  expect(JSON.parse(readFileSync(join(dir, "store", "kv", "alpha", "notes.json"), "utf8"))).toEqual({ list: [3] });
});

test("kv：外部直接调（没有调用方的包）失败；键只能是字母、数字、_ 与 -", async () => {
  const { kernel, run } = await setup();

  expect(await run("kv_get", { key: "notes" })).toMatchObject({ ok: false, by: "kv_get", reason: "kv keeps data per calling package: call it from an operation" });
  expect(() => kernel.submit("kv_get", { key: "../alpha/notes" })).toThrow("invalid input for kv_get");
});
