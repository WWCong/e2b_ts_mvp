import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, loadPlugin } from "stdlib";
import { localDir } from "stdlib/infra/volume";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "builder-chat-"));
  await mkdir(join(root, "feat_x"));
});

async function setup() {
  const kernel = new Kernel();
  const tree = localDir(root);
  await tree.open();
  await loadPlugin(kernel, import.meta.dir, {}, { workspace: tree });
  await kernel.boot();
  const outside = kernel.outside("test");
  /** who 说的（调用者）；不给就是没有调用者 */
  const run = (name: string, input: unknown, who?: string) => kernel.reap(outside.submit(name, input, who));
  return { run };
}

describe("chat", () => {
  test("说话：说话的人是调用者，追加进结构里的 .chat 文件（一行一条），读出来按先后", async () => {
    const { run } = await setup();

    const said = await run("chat_post", { path: "feat_x/main.chat", text: "  PRD 谁来写？ " }, "张三");
    expect(said).toMatchObject({ ok: true, value: { path: "feat_x/main.chat", author: "张三", text: "PRD 谁来写？", id: expect.any(String), at: expect.any(Number) } });
    await run("chat_post", { path: "feat_x/main.chat", text: "我来" }, "李四");
    await run("chat_post", { path: "main.chat", text: "根上的" });

    const read = await run("chat_read", { path: "feat_x/main.chat" });
    expect(read.ok && (read.value as { author: string; text: string }[]).map((m) => [m.author, m.text])).toEqual([
      ["张三", "PRD 谁来写？"],
      ["李四", "我来"],
    ]);
    expect((await readFile(join(root, "feat_x/main.chat"), "utf8")).trim().split("\n")).toHaveLength(2);
    expect(await run("chat_read", { path: "main.chat" })).toMatchObject({ ok: true, value: [{ author: "匿名", text: "根上的" }] });
    expect(await run("chat_read", { path: "feat_x/other.chat" })).toEqual({ ok: true, value: [] });
  });

  test("同时说：同一个聊天的不互相覆盖", async () => {
    const { run } = await setup();

    await Promise.all(Array.from({ length: 20 }, (_, i) => run("chat_post", { path: "feat_x/main.chat", text: `第 ${i} 句` }, "张三")));
    const read = await run("chat_read", { path: "feat_x/main.chat" });
    expect(read.ok && (read.value as unknown[]).length).toBe(20);
  });

  test("路径要是已有结构下的 名字.chat；空话不收", async () => {
    const { run } = await setup();

    expect(await run("chat_post", { path: "nope/main.chat", text: "hi" })).toMatchObject({ ok: false, reason: "no such structure: nope" });
    // 入参不对：对外的调用直接报错，不起树
    for (const path of ["feat_x/prd.md", "../main.chat", "feat_x/.main.chat", "feat_x/a b.chat"]) {
      expect(() => run("chat_post", { path, text: "hi" })).toThrow("invalid input for chat_post");
    }
    expect(() => run("chat_post", { path: "feat_x/main.chat", text: "   " })).toThrow("invalid input for chat_post");
  });
});
