import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 借一个空闲端口 */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

describe("builder 的服务端", () => {
  test("内网上：打开网页与产物；建结构、在主聊天里说话，说话的人是网关带来的身份，别人经事件流实时看到；SIGINT 优雅关停", async () => {
    const home = await mkdtemp(join(tmpdir(), "builder-"));
    const port = freePort();
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts")], {
      env: { ...process.env, BUILDER_HOME: home, BUILDER_PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const url = `http://127.0.0.1:${port}`;
    for (;;) {
      if (proc.exitCode !== null) throw new Error(await new Response(proc.stderr).text());
      if (await fetch(`${url}/operations`).then(() => true, () => false)) break;
      await Bun.sleep(20);
    }
    const as = (user: string) => async (name: string, input: unknown) => {
      const res = await fetch(`${url}/operations/${name}`, { method: "POST", headers: { "x-builder-user": encodeURIComponent(user) }, body: JSON.stringify(input) });
      return ((await res.json()) as { result: unknown }).result;
    };
    const [zhang, li] = [as("张三"), as("李四")];

    expect(await (await fetch(`${url}/`)).text()).toContain("<title>builder</title>");
    for (const path of ["/app.js", "/style.css", "/vendor/marked/marked.umd.js"]) expect((await fetch(`${url}${path}`)).status).toBe(200);

    // 李四开着网页（事件流），张三建结构、说话
    const reader = (await fetch(`${url}/events`)).body!.getReader();
    expect(await zhang("tree_create", { name: "feat_x" })).toEqual({ ok: true, value: "feat_x" });
    expect(await zhang("chat_post", { path: "feat_x/main.chat", text: "PRD 谁来写？" })).toMatchObject({ ok: true, value: { author: "张三" } });
    let text = "";
    while (!text.includes("PRD 谁来写？")) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(await li("chat_read", { path: "feat_x/main.chat" })).toMatchObject({ ok: true, value: [{ author: "张三", text: "PRD 谁来写？" }] });

    // 产物就是树里的文件
    await writeFile(join(home, "tree", "feat_x", "prd.md"), "# PRD");
    expect(await (await fetch(`${url}/tree/feat_x/prd.md`)).text()).toBe("# PRD");
    expect(await li("tree_list", {})).toMatchObject({
      ok: true,
      value: { structures: [{ path: "feat_x", artifacts: [{ path: "feat_x/prd.md" }], chats: [{ path: "feat_x/main.chat" }] }] },
    });

    proc.kill("SIGINT");
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe(`harness 在 ${url} 上服务，对外：tree_list、tree_create、chat_read、chat_post\n`);
  });
});
