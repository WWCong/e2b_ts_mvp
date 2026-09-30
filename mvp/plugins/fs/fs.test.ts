import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent } from "../../../src/kernel/events";
import { Kernel } from "../../../src/kernel/kernel";
import { loadPlugin } from "../../../src/kernel/loader";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "fs-plugin-"));
  process.env.WORKSPACE_DIR = workspace;
});

/** fs_write 要审批：装上 ui 与 stdlib，审批一律答 yes */
async function setup() {
  const kernel = new Kernel();
  const events: HarnessEvent[] = [];
  kernel.events.subscribe((e) => events.push(e));
  kernel.events.subscribe((e) => e.type === "park.opened" && queueMicrotask(() => kernel.unpark(e.runId, { option: "yes" })));
  await loadPlugin(kernel, join(import.meta.dir, "..", "..", "..", "src", "plugins", "stdlib"));
  for (const pkg of ["fs", "ui"]) await loadPlugin(kernel, join(import.meta.dir, "..", pkg));
  const run = (name: string, input: unknown) => kernel.reap(kernel.start(name, input));
  return { events, run };
}

describe("fs 插件", () => {
  test("写、读、列：写时自动建目录，列出结果按名字排序", async () => {
    const { run } = await setup();

    expect(await run("fs_write", { path: "notes/b.md", content: "你好" })).toEqual({
      ok: true,
      value: { written: "notes/b.md", bytes: 6 },
    });
    await run("fs_write", { path: "notes/a.md", content: "a" });
    expect(await run("fs_read", { path: "notes/b.md" })).toEqual({ ok: true, value: "你好" });
    expect(await run("fs_list", {})).toEqual({ ok: true, value: [{ name: "notes", type: "dir" }] });
    expect(await run("fs_list", { path: "notes" })).toEqual({
      ok: true,
      value: [
        { name: "a.md", type: "file" },
        { name: "b.md", type: "file" },
      ],
    });
  });

  test("pathGuard：越出工作区的路径被拒绝，可改了再试，实现不执行，也不去问人", async () => {
    const { events, run } = await setup();

    for (const path of ["../outside.md", "/etc/passwd", "notes/../../outside.md"]) {
      expect(await run("fs_write", { path, content: "x" })).toEqual({
        ok: false,
        by: "fs_pathGuard",
        reason: `path escapes workspace: ${path}`,
        retryable: true,
      });
    }
    expect(await readdir(workspace)).toEqual([]);
    expect(events.filter((e) => e.type === "decorator.rejected")).toHaveLength(3);
    expect(events.some((e) => e.type === "park.opened")).toBe(false);
  });

  test("pathGuard 只看字面上是否越界：以 .. 开头的普通文件名照常放行", async () => {
    const { run } = await setup();

    expect(await run("fs_write", { path: "..notes.md", content: "x" })).toMatchObject({ ok: true });
  });

  test("读不存在的文件：以 fs_read 的拒绝返回", async () => {
    const { run } = await setup();

    expect(await run("fs_read", { path: "missing.md" })).toMatchObject({
      ok: false,
      by: "fs_read",
      reason: expect.stringContaining("ENOENT"),
    });
  });
});
