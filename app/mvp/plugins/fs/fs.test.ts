import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, loadPlugin, type HarnessEvent } from "stdlib";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "fs-plugin-"));
});

/** fs_write、fs_edit 要审批：装上 ui 与 harness，审批一律答 yes */
async function setup() {
  const kernel = new Kernel();
  const events: HarnessEvent[] = [];
  kernel.events.subscribe((e) => events.push(e));
  kernel.events.subscribe((e) => e.type === "park.opened" && queueMicrotask(() => kernel.unpark(e.runId, { option: "yes" })));
  await loadPlugin(kernel, "stdlib/plugins/harness");
  await loadPlugin(kernel, import.meta.dir, { workspace });
  await loadPlugin(kernel, join(import.meta.dir, "..", "ui"));
  await kernel.boot();
  const run = (name: string, input: unknown) => kernel.reap(kernel.start(name, input));
  const parks = () => events.filter((e) => e.type === "park.opened").length;
  return { run, parks };
}

describe("fs 插件", () => {
  test("启动时建好工作区", async () => {
    workspace = join(workspace, "not", "yet");
    expect(existsSync(workspace)).toBe(false);

    await setup();
    expect(existsSync(workspace)).toBe(true);
  });

  test("写、改、读、列、查找：用的是 pi 的工具，结果是给模型看的文字；写与改先问人", async () => {
    const { run, parks } = await setup();

    expect(await run("fs_write", { path: "notes/b.md", content: "你好\n世界\n" })).toMatchObject({ ok: true });
    expect(await run("fs_edit", { path: "notes/b.md", edits: [{ oldText: "世界", newText: "大家" }] })).toEqual({
      ok: true,
      value: "Successfully replaced 1 block(s) in notes/b.md.",
    });
    expect(parks()).toBe(2);
    expect(await run("fs_read", { path: "notes/b.md" })).toEqual({ ok: true, value: "你好\n大家\n" });
    expect(await run("fs_list", {})).toEqual({ ok: true, value: "notes/" });
    expect(await run("fs_find", { pattern: "**/*.md" })).toEqual({ ok: true, value: "notes/b.md" });
  });

  test.if(Boolean(Bun.which("rg")))("搜索：fs_grep 走 ripgrep", async () => {
    const { run } = await setup();
    await writeFile(join(workspace, "a.md"), "第一行\n要找的在这\n");

    expect(await run("fs_grep", { pattern: "要找" })).toEqual({ ok: true, value: "a.md:2: 要找的在这" });
  });

  test("越出工作区的路径（含 ~ 与 pi 认的 @ 前缀）：直接拒绝，可改了再试，不去问人", async () => {
    const { run, parks } = await setup();

    for (const path of ["../outside.md", "/etc/passwd", "notes/../../outside.md", "~/outside.md", "@../outside.md"]) {
      expect(await run("fs_write", { path, content: "x" })).toEqual({
        ok: false,
        by: "fs_pathGuard",
        reason: `path escapes workspace: ${path}`,
        retryable: true,
      });
    }
    expect(parks()).toBe(0);
    expect(await readdir(workspace)).toEqual([]);
  });

  test("底层守边界：工作区里的符号链接指向外面，按字面看在里面，也读不到", async () => {
    const outside = await mkdtemp(join(tmpdir(), "fs-outside-"));
    await writeFile(join(outside, "secret.md"), "机密");
    await symlink(outside, join(workspace, "link"));
    const { run } = await setup();

    for (const [name, input] of [
      ["fs_read", { path: "link/secret.md" }],
      ["fs_list", { path: "link" }],
    ] as const) {
      expect(await run(name, input)).toMatchObject({ ok: false, by: name, reason: expect.stringContaining("escapes workspace via symlink") });
    }
  });

  test("出错：原因里的路径是相对工作区的，不带宿主机的绝对路径；改不上时说明原因", async () => {
    const { run } = await setup();
    await mkdir(join(workspace, "notes"));
    await writeFile(join(workspace, "notes/a.md"), "原文");

    const missing = await run("fs_read", { path: "notes/missing.md" });
    // 先取出原因：toMatchObject 配 expect.stringContaining 时 Bun 会改写被比对的对象
    const reason = missing.ok ? "" : missing.reason;
    expect(missing).toMatchObject({ ok: false, by: "fs_read" });
    expect(reason).toContain("notes/missing.md");
    expect(reason).not.toContain(workspace);
    expect(await run("fs_edit", { path: "notes/a.md", edits: [{ oldText: "不存在", newText: "x" }] })).toMatchObject({
      ok: false,
      by: "fs_edit",
      reason: expect.stringContaining("Could not find the exact text"),
    });
  });
});
