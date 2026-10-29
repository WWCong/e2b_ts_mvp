import { describe, expect, test } from "bun:test";
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

/** 起一个沙盒应用的服务端，状态放在临时目录；env 覆盖缺省的配置 */
async function launch(env: Record<string, string> = {}) {
  const home = await mkdtemp(join(tmpdir(), "sandbox-"));
  const port = freePort();
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts")], {
    env: { ...process.env, SANDBOX_HOME: home, SANDBOX_ADMIN_PORT: String(port), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exited = async () => ({ code: await proc.exited, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() });
  return { proc, port, exited };
}

describe("沙盒应用的服务端", () => {
  test("管理口：对外 admin_say、admin_reset、admin_greet；SIGINT 优雅关停", async () => {
    const app = await launch();
    const target = { url: `http://127.0.0.1:${app.port}` };
    while (!(await reachable(target))) {
      if (app.proc.exitCode !== null) throw new Error(`exited: ${(await app.exited()).stderr}`);
      await Bun.sleep(20);
    }
    const admin = httpClient({ ...target, name: "test" });

    expect((await admin.operations()).map((o) => o.name)).toEqual(["admin_greet", "admin_reset", "admin_say"]);
    expect(await admin.call("admin_greet", {})).toMatchObject({ result: { ok: true, value: "" } });
    expect(await admin.call("admin_reset", {})).toMatchObject({ result: { ok: true, value: "已开始新对话" } });

    app.proc.kill("SIGINT");
    const { code, stdout } = await app.exited();
    expect(code).toBe(0);
    expect(stdout).toBe(`harness 在 http://127.0.0.1:${app.port} 上服务，对外：admin_say、admin_reset、admin_greet\n`);
  });
});
