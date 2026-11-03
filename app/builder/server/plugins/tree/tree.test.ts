import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, loadPlugin } from "stdlib";
import { localDir } from "stdlib/infra/volume";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "builder-tree-"));
});

async function setup() {
  const kernel = new Kernel();
  const tree = localDir(root);
  await tree.open();
  await loadPlugin(kernel, import.meta.dir, {}, { workspace: tree });
  await kernel.boot();
  return (name: string, input: unknown = {}) => kernel.reap(kernel.submit(name, input));
}

describe("tree", () => {
  test("整棵树：目录是结构，.chat 是聊天（主聊天在前），别的文件是产物；点开头的不算", async () => {
    await mkdir(join(root, "feat_x"));
    await mkdir(join(root, "weekly_report"));
    for (const [path, text] of [
      ["skill_eval.html", "<p>"],
      ["main.chat", ""],
      ["feat_x/prd.md", "# PRD"],
      ["feat_x/status.html", "<p>"],
      ["feat_x/zhang-review.chat", ""],
      ["feat_x/main.chat", ""],
      [".hidden", ""],
    ]) {
      await writeFile(join(root, path!), text!);
    }
    const run = await setup();

    expect(await run("tree_list")).toEqual({
      ok: true,
      value: {
        name: "",
        path: "",
        artifacts: [{ name: "skill_eval.html", path: "skill_eval.html" }],
        chats: [{ name: "main", path: "main.chat" }],
        structures: [
          {
            name: "feat_x",
            path: "feat_x",
            artifacts: [
              { name: "prd.md", path: "feat_x/prd.md" },
              { name: "status.html", path: "feat_x/status.html" },
            ],
            chats: [
              { name: "main", path: "feat_x/main.chat" },
              { name: "zhang-review", path: "feat_x/zhang-review.chat" },
            ],
            structures: [],
          },
          { name: "weekly_report", path: "weekly_report", artifacts: [], chats: [], structures: [] },
        ],
      },
    });
  });

  test("建子结构：返回路径；父结构要在，名字只许字母、数字、_ 与 -，已有的不再建", async () => {
    const run = await setup();

    expect(await run("tree_create", { name: "feat_x" })).toEqual({ ok: true, value: "feat_x" });
    expect(await run("tree_create", { parent: "feat_x", name: "代码评审" })).toEqual({ ok: true, value: "feat_x/代码评审" });
    expect(await run("tree_create", { name: "feat_x" })).toMatchObject({ ok: false, reason: "already exists: feat_x" });
    expect(await run("tree_create", { parent: "nope", name: "a" })).toMatchObject({ ok: false, reason: "no such structure: nope" });
    // 入参不对：对外的调用直接报错，不起树
    for (const name of ["a/b", ".x", "a b", ""]) expect(() => run("tree_create", { name })).toThrow("invalid input for tree_create");
    expect(() => run("tree_create", { parent: "../x", name: "a" })).toThrow("invalid input for tree_create");
  });
});
