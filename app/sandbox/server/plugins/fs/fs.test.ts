import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, loadPlugin, type HarnessEvent, type Volume } from "stdlib";
import { localDir } from "stdlib/infra/volume";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "sandbox-fs-"));
});

/** volume 缺省是 workspace 这个本地目录 */
async function setup(volume: Volume = localDir(workspace)) {
  const kernel = new Kernel();
  const events: HarnessEvent[] = [];
  kernel.events.subscribe((e) => events.push(e));
  await volume.open();
  await loadPlugin(kernel, import.meta.dir, {}, { workspace: volume });
  await kernel.boot();
  const run = (name: string, input: unknown) => kernel.reap(kernel.submit(name, input));
  return { run, events };
}

describe("fs 插件（沙盒应用的）", () => {
  test("写、改、读、列、查找：用的是 pi 的工具，结果是给模型看的文字；写与改不问人", async () => {
    const { run, events } = await setup();

    expect(await run("fs_write", { path: "drafts/b.md", content: "你好\n世界\n" })).toMatchObject({ ok: true });
    expect(await run("fs_edit", { path: "drafts/b.md", edits: [{ oldText: "世界", newText: "大家" }] })).toEqual({
      ok: true,
      value: "Successfully replaced 1 block(s) in drafts/b.md.",
    });
    expect(events.some((e) => e.type === "park.opened")).toBe(false);
    expect(await run("fs_read", { path: "/workspace/drafts/b.md" })).toEqual({ ok: true, value: "你好\n大家\n" });
    expect(await run("fs_list", {})).toEqual({ ok: true, value: "drafts/" });
    expect(await run("fs_find", { pattern: "**/*.md" })).toEqual({ ok: true, value: "drafts/b.md" });
  });

  test("越出工作区的路径（含 ~ 与 pi 认的 @ 前缀）：以拒绝返回，什么也不写", async () => {
    const { run } = await setup();

    for (const path of ["../outside.md", "/etc/passwd", "drafts/../../outside.md", "~/outside.md", "@../outside.md"]) {
      expect(await run("fs_write", { path, content: "x" })).toMatchObject({ ok: false, by: "fs_write", reason: `path escapes workspace: ${path}` });
    }
    expect(await readdir(workspace)).toEqual([]);
  });

  test("底层守边界：工作区里的符号链接指向外面，按字面看在里面，也读不到", async () => {
    const outside = await mkdtemp(join(tmpdir(), "sandbox-fs-outside-"));
    await writeFile(join(outside, "secret.md"), "机密");
    await symlink(outside, join(workspace, "link"));
    const { run } = await setup();

    const result = await run("fs_read", { path: "link/secret.md" });
    const reason = result.ok ? "" : result.reason;
    expect(result).toMatchObject({ ok: false, by: "fs_read" });
    expect(reason).toContain("escapes the volume via symlink");
  });

  test("工作区没有本地路径：别的工具照常，fs_grep 以拒绝返回；出错信息不带宿主机的目录", async () => {
    const { localPath: _, ...remote } = localDir(workspace);
    const { run } = await setup({ ...remote, name: "remote:test" });

    expect(await run("fs_write", { path: "a.md", content: "要找的在这" })).toMatchObject({ ok: true });
    expect(await run("fs_grep", { pattern: "要找" })).toMatchObject({
      ok: false,
      by: "fs_grep",
      reason: "fs_grep needs the workspace on a local path, remote:test has none",
    });
    const missing = await run("fs_read", { path: "missing.md" });
    const reason = missing.ok ? "" : missing.reason;
    expect(reason).toContain("missing.md");
    expect(reason).not.toContain(workspace);
  });
});
