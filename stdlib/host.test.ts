import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "host-"));
});

/** 起一个跑着测试应用的进程；until 等它打印出某段文字 */
function launch(mode: string, ...args: string[]) {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "__fixtures__", "host", "main.ts"), mode, dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let out = "";
  const reading = (async () => {
    for await (const chunk of proc.stdout) out += new TextDecoder().decode(chunk);
  })();
  const until = async (text: string) => {
    while (!out.includes(text)) await Bun.sleep(5);
  };
  const exited = async () => {
    const code = await proc.exited;
    await reading;
    return { code, out };
  };
  const stderr = () => new Response(proc.stderr).text();
  return { proc, until, exited, stderr };
}

describe("宿主", () => {
  test("入口都结束服务就关停：插件 onStop 之后退出", async () => {
    expect(await launch("leave").exited()).toEqual({ code: 0, out: "serving, recovered 0\nstopped\n" });
  });

  test("SIGINT 优雅关停，树停在 park 上、日志保留；再启动时入口认领到上次的树", async () => {
    const one = launch("park");
    await one.until("parked");
    one.proc.kill("SIGINT");
    expect(await one.exited()).toEqual({ code: 0, out: "serving, recovered 0\nparked\nstopped\n" });
    expect(await readdir(dir)).toHaveLength(1);

    // 恢复的树重新开出 park；入口不收割就结束服务，宿主关停，日志照旧保留
    const two = await launch("leave").exited();
    expect(two).toEqual({ code: 0, out: "parked\nserving, recovered 1\nstopped\n" });
    expect(await readdir(dir)).toHaveLength(1);
  });

  test("关停中再收到一次信号就强杀，不等在途的调用", async () => {
    const app = launch("busy");
    await app.until("busy");
    const t0 = performance.now();
    app.proc.kill("SIGINT");
    await Bun.sleep(100);
    app.proc.kill("SIGINT");
    const { code, out } = await app.exited();
    expect(performance.now() - t0).toBeLessThan(2000);
    expect([code, out]).toEqual([0, "serving, recovered 0\nbusy\nstopped\n"]);
  });

  test("serve.http：启动后在 socket 上对外服务；同一个 socket 已有服务时第二个起不来；SIGINT 关停后删掉 socket", async () => {
    const socket = join(dir, "h.sock");
    const app = launch("http", socket);
    const call = () =>
      fetch("http://harness/operations/echo_say", { unix: socket, method: "POST", body: JSON.stringify({ text: "hi" }) }).then((r) => r.json());
    let reply: unknown;
    while (!reply) reply = await call().catch(() => undefined);
    expect(reply).toMatchObject({ result: { ok: true, value: "echo: hi" } });

    const second = launch("http", socket);
    expect((await second.exited()).code).not.toBe(0);
    expect(await second.stderr()).toContain(`a harness is already serving on ${socket}`);

    app.proc.kill("SIGINT");
    expect((await app.exited()).code).toBe(0);
    expect(existsSync(socket)).toBe(false);
  });
});
