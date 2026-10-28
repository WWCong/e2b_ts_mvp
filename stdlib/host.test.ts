import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParkInfo, RunInfo } from "./kernel/outside";

let dir: string;
let socket: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "host-"));
  socket = join(dir, "h.sock");
});

/** 起一个跑着测试应用的进程，等到它开始服务 */
async function launch(...args: string[]) {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "__fixtures__", "host", "main.ts"), dir, socket, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exited = async () => ({ code: await proc.exited, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() });
  return { proc, exited };
}

async function reachable() {
  try {
    await fetch("http://harness/operations", { unix: socket, signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

async function serving(proc: Bun.Subprocess) {
  while (!(await reachable())) {
    if (proc.exitCode !== null) throw new Error("harness exited before serving");
    await Bun.sleep(10);
  }
}

/** 直接用 HTTP 服务接口（客户端是应用的事，这里不依赖） */
const request = async <T>(method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://harness${path}`, {
    unix: socket,
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "harness-client": "test" },
  });
  return (await res.json()) as T;
};

const client = () => ({
  call: (op: string, input: unknown) => request("POST", `/operations/${op}`, input),
  runs: () => request<RunInfo[]>("GET", "/runs"),
  result: (runId: string) => request("GET", `/runs/${runId}`),
  parks: () => request<ParkInfo[]>("GET", "/parks"),
  answer: (id: string, value: unknown) => request("POST", `/parks/${id}`, { value }),
});

describe("宿主", () => {
  test("在 socket 上对外服务，一直跑到收到信号；SIGINT 优雅关停，删掉 socket，打印在哪服务", async () => {
    const app = await launch();
    await serving(app.proc);
    expect(await client().call("echo_say", { text: "hi" })).toMatchObject({ result: { ok: true, value: "echo: hi" } });

    app.proc.kill("SIGINT");
    const { code, stdout } = await app.exited();
    expect(code).toBe(0);
    expect(stdout).toBe(`harness 在 unix:${socket} 上服务，对外：echo_say、echo_wait、echo_busy\n`);
    expect(existsSync(socket)).toBe(false);
  });

  test("停在 park 上的树：关停时日志保留；再启动后客户端按 runId 接着等，回答后取到结果", async () => {
    const one = await launch();
    await serving(one.proc);
    const res = await fetch("http://harness/operations/echo_wait?async", { unix: socket, method: "POST", body: "{}" });
    const { runId } = (await res.json()) as { runId: string };
    while ((await client().parks()).length === 0) await Bun.sleep(5);
    one.proc.kill("SIGINT");
    expect((await one.exited()).code).toBe(0);
    expect(await readdir(join(dir, "journal"))).toEqual([`${runId}.jsonl`]);

    const two = await launch();
    await serving(two.proc);
    expect(await client().runs()).toEqual([{ runId, operation: "echo_wait", origin: "http", done: false }]);
    const [park] = await client().parks();
    await client().answer(park!.id, "好");
    expect(await client().result(runId)).toEqual({ runId, result: { ok: true, value: "好" } });
    two.proc.kill("SIGINT");
    await two.exited();
  });

  test("关停中再收到一次信号就强杀，不等在途的调用", async () => {
    const app = await launch();
    await serving(app.proc);
    void fetch("http://harness/operations/echo_busy?async", { unix: socket, method: "POST", body: "{}" });
    while ((await client().runs()).length === 0) await Bun.sleep(5);
    const t0 = performance.now();
    app.proc.kill("SIGINT");
    await Bun.sleep(100);
    app.proc.kill("SIGINT");
    expect((await app.exited()).code).toBe(0);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  test("同一个 socket 已有服务时第二个起不来；expose 列了不是 api 的，启动失败、不开服务", async () => {
    const app = await launch();
    await serving(app.proc);
    const second = await (await launch()).exited();
    expect(second.code).not.toBe(0);
    expect(second.stderr).toContain(`a harness is already serving on ${socket}`);
    app.proc.kill("SIGINT");
    await app.exited();

    const bad = await (await launch("bad")).exited();
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain("serve.http exposes echo_nope, which is not an api operation");
    expect(existsSync(socket)).toBe(false);
  });

  test("watch：改了 script 包，运行中重新装载；改坏了、对外的没了，仍用原来的", async () => {
    const pkg = join(dir, "greeter");
    const greeter = (reply: string, api = true) =>
      `import { z } from "zod"; import { op, script } from "stdlib";
       export default script({ operations: { hello: op({ api: ${api}, usage: "打招呼", input: z.object({}), output: z.string(), impl: async () => ${JSON.stringify(reply)} }) } });`;
    const hello = async () => ((await client().call("greeter_hello", {})) as { result: unknown }).result;
    /** 改了之后等它换上：最多等 5 秒 */
    const until = async (expected: unknown) => {
      for (let t0 = Date.now(); Date.now() - t0 < 5000; await Bun.sleep(50)) if (Bun.deepEquals(await hello(), expected)) return;
      throw new Error(`still ${JSON.stringify(await hello())}`);
    };
    await Bun.write(join(pkg, "index.ts"), greeter("v1"));
    const app = await launch(`watch=${pkg}`);
    await serving(app.proc);
    expect(await hello()).toEqual({ ok: true, value: "v1" });

    await Bun.write(join(pkg, "index.ts"), greeter("v2"));
    await until({ ok: true, value: "v2" });
    await Bun.write(join(pkg, "index.ts"), "export default 1 +;");
    await Bun.sleep(300);
    await Bun.write(join(pkg, "index.ts"), greeter("v3", false));
    await Bun.sleep(300);
    expect(await hello()).toEqual({ ok: true, value: "v2" });

    app.proc.kill("SIGINT");
    const { stderr } = await app.exited();
    expect(stderr).toContain("harness：script 包 greeter 改过了，已重新装载");
    expect(stderr).toContain("harness：script 包 greeter 重新装载失败，仍用原来的：greeter: 1:19 Unexpected ;");
    expect(stderr).toContain("harness：script 包 greeter 重新装载失败，仍用原来的：exposed but no longer an api operation: greeter_hello");
  });
});

