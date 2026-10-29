import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { httpClient, reachable } from "pkg/client/http";

/** 借一个空闲端口 */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

const jwt = (sub: string) => `e30.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.sig`;

/** 假的大模型 API（OpenAI 协议，流式）：记下每次请求带的 authorization，回答「收到」 */
function fakeLlm() {
  const authorizations: (string | null)[] = [];
  const chunk = (body: object) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "deepseek-flash", ...body })}\n\n`;
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      authorizations.push(req.headers.get("authorization"));
      const body = [
        chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "收到" }, finish_reason: null }] }),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
        "data: [DONE]\n\n",
      ].join("");
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, authorizations, stop: () => server.stop(true) };
}

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

/** 起一个沙盒应用的服务端，状态放在临时目录，大模型 API 指到 llmUrl；等它开始服务 */
async function launch(llmUrl: string) {
  const home = await mkdtemp(join(tmpdir(), "sandbox-"));
  const port = freePort();
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts")], {
    env: { ...process.env, SANDBOX_HOME: home, SANDBOX_PORT: String(port), SANDBOX_LLM_URL: llmUrl },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exited = async () => ({ code: await proc.exited, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() });
  const url = `http://127.0.0.1:${port}`;
  while (!(await reachable({ url }))) {
    if (proc.exitCode !== null) throw new Error(`exited: ${(await exited()).stderr}`);
    await Bun.sleep(20);
  }
  return { proc, url, exited };
}

describe("沙盒应用的服务端", () => {
  test("服务口：请求带的 JWT 认出调用者，调大模型 API 时带上它；每个调用者一段对话；SIGINT 优雅关停", async () => {
    const llm = fakeLlm();
    cleanups.push(llm.stop);
    const app = await launch(llm.url);
    const alice = httpClient({ url: app.url, token: jwt("alice"), name: "test" });
    const bob = httpClient({ url: app.url, token: jwt("bob"), name: "test" });

    expect((await alice.operations()).map((o) => o.name)).toEqual(["manager_greet", "manager_reset", "manager_say"]);
    expect(await alice.call("manager_say", { text: "你好" })).toMatchObject({ result: { ok: true, value: "收到" } });
    expect(llm.authorizations).toEqual([`Bearer ${jwt("alice")}`]);
    expect(await alice.call("manager_greet", {})).toMatchObject({ result: { ok: true, value: "接着之前的对话（2 条消息）；/new 开始新对话" } });
    expect(await bob.call("manager_greet", {})).toMatchObject({ result: { ok: true, value: "" } });

    app.proc.kill("SIGINT");
    const { code, stdout } = await app.exited();
    expect(code).toBe(0);
    expect(stdout).toBe(`harness 在 ${app.url} 上服务，对外：manager_say、manager_reset、manager_greet\n`);
  });

  test("没带令牌的请求没有调用者：调不了大模型 API，这一轮以拒绝结束", async () => {
    const llm = fakeLlm();
    cleanups.push(llm.stop);
    const app = await launch(llm.url);
    cleanups.push(() => app.proc.kill("SIGKILL"));

    expect(await httpClient({ url: app.url, name: "test" }).call("manager_say", { text: "你好" })).toMatchObject({
      result: { ok: false, reason: expect.stringContaining("no caller to call the model for") },
    });
    expect(llm.authorizations).toEqual([]);
  });
});
