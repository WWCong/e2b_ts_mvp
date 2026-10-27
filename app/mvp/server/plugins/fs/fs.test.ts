import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isToolContent, Kernel, loadPlugin, type HarnessEvent, type Volume } from "stdlib";
import { localDir } from "stdlib/infra/volume";

let workspace: string;

/** 1×1 的红点 PNG */
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "fs-plugin-"));
});

/** fs_write、fs_edit 要审批：装上 ui 与 harness，审批一律答 yes。volume 缺省是 workspace 这个本地目录 */
async function setup(volume: Volume = localDir(workspace)) {
  const kernel = new Kernel();
  const events: HarnessEvent[] = [];
  kernel.events.subscribe((e) => events.push(e));
  kernel.events.subscribe((e) => e.type === "park.opened" && queueMicrotask(() => kernel.unpark(e.runId, { option: "yes" })));
  await volume.open();
  await loadPlugin(kernel, "stdlib/plugins/harness");
  await loadPlugin(kernel, import.meta.dir, {}, { workspace: volume });
  await loadPlugin(kernel, "stdlib/plugins/ui");
  await kernel.boot();
  const run = (name: string, input: unknown) => kernel.reap(kernel.submit(name, input));
  const parks = () => events.filter((e) => e.type === "park.opened").length;
  return { run, parks };
}

describe("fs 插件", () => {
  test("写、改、读、列、查找：用的是 pi 的工具，结果是给模型看的文字；写与改先问人", async () => {
    const { run, parks } = await setup();

    expect(await run("fs_write", { path: "notes/b.md", content: "你好\n世界\n" })).toMatchObject({ ok: true });
    expect(await run("fs_edit", { path: "notes/b.md", edits: [{ oldText: "世界", newText: "大家" }] })).toEqual({
      ok: true,
      value: "Successfully replaced 1 block(s) in notes/b.md.",
    });
    expect(parks()).toBe(2);
    expect(await run("fs_read", { path: "notes/b.md" })).toEqual({ ok: true, value: "你好\n大家\n" });
    // 模型看到的根是 /workspace：按它写的绝对路径也认
    expect(await run("fs_read", { path: "/workspace/notes/b.md" })).toEqual({ ok: true, value: "你好\n大家\n" });
    expect(await run("fs_list", {})).toEqual({ ok: true, value: "notes/" });
    expect(await run("fs_find", { pattern: "**/*.md" })).toEqual({ ok: true, value: "notes/b.md" });
  });

  test("读图片：按文件头认出来，结果是文字说明加图片块（base64），交给模型看", async () => {
    const { run } = await setup();
    // 1×1 的 PNG；扩展名故意不对，按文件头认
    await writeFile(join(workspace, "pixel.dat"), Buffer.from(PNG_1X1, "base64"));

    const result = await run("fs_read", { path: "pixel.dat" });
    const content = result.ok && isToolContent(result.value) ? result.value.content : [];
    const [note, image] = content as [{ type: string; text: string }, { type: string; mimeType: string; data: string }];
    expect(content).toHaveLength(2);
    expect([note.type, image.type, image.mimeType]).toEqual(["text", "image", "image/png"]);
    expect(note.text).toStartWith("Read image file [image/png]");
    expect(Buffer.from(image.data, "base64").subarray(1, 4).toString()).toBe("PNG");
  });

  test.if(Boolean(Bun.which("rg")))("搜索：fs_grep 在工作区的本地路径上走 ripgrep", async () => {
    const { run } = await setup();
    await writeFile(join(workspace, "a.md"), "第一行\n要找的在这\n");

    expect(await run("fs_grep", { pattern: "要找" })).toEqual({ ok: true, value: "a.md:2: 要找的在这" });
    expect(await run("fs_grep", { pattern: "要找", path: "/workspace" })).toEqual({ ok: true, value: "a.md:2: 要找的在这" });
  });

  test("工作区没有本地路径（比如纯远程的存储）：别的工具照常，fs_grep 以拒绝返回", async () => {
    const { localPath: _, ...remote } = localDir(workspace);
    const { run } = await setup({ ...remote, name: "remote:test" });

    expect(await run("fs_write", { path: "a.md", content: "要找的在这" })).toMatchObject({ ok: true });
    expect(await run("fs_read", { path: "a.md" })).toEqual({ ok: true, value: "要找的在这" });
    expect(await run("fs_grep", { pattern: "要找" })).toMatchObject({
      ok: false,
      by: "fs_grep",
      reason: "fs_grep needs the workspace on a local path, remote:test has none",
    });
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
      const result = await run(name, input);
      const reason = result.ok ? "" : result.reason;
      expect(result).toMatchObject({ ok: false, by: name });
      expect(reason).toContain("escapes the volume via symlink");
    }
  });

  test("出错：路径不带宿主机的目录；改不上时说明原因", async () => {
    const { run } = await setup();
    await mkdir(join(workspace, "notes"));
    await writeFile(join(workspace, "notes/a.md"), "原文");

    for (const [name, input, where] of [
      ["fs_read", { path: "notes/missing.md" }, "notes/missing.md"],
      ["fs_list", { path: "nope" }, "/workspace/nope"],
    ] as const) {
      const result = await run(name, input);
      // 先取出原因：toMatchObject 配 expect.stringContaining 时 Bun 会改写被比对的对象
      const reason = result.ok ? "" : result.reason;
      expect(result).toMatchObject({ ok: false, by: name });
      expect(reason).toContain(where);
      expect(reason).not.toContain(workspace);
    }
    expect(await run("fs_edit", { path: "notes/a.md", edits: [{ oldText: "不存在", newText: "x" }] })).toMatchObject({
      ok: false,
      by: "fs_edit",
      reason: expect.stringContaining("Could not find the exact text"),
    });
  });
});
