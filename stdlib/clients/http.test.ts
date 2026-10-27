import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { HarnessEvent } from "../kernel/events";
import { Kernel } from "../kernel/kernel";
import { op } from "../kernel/plugin";
import { httpService } from "../serve/http";
import type { Service } from "../serve/service";
import { httpClient, reachable } from "./http";

const services: Service[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.stop(true);
});

/** demo_ask 停在 park 上等一句话；demo_echo 回显。都对外 */
async function setup() {
  const socket = join(await mkdtemp(join(tmpdir(), "client-")), "h.sock");
  const kernel = new Kernel();
  kernel.use("demo", {
    operations: {
      ask: op({
        api: true,
        usage: "问",
        input: z.object({}),
        output: z.string(),
        impl: (ctx) => ctx.park({ schema: z.toJSONSchema(z.string()), payload: "?" }) as Promise<string>,
      }),
      echo: op({ api: true, usage: "回显", input: z.object({ text: z.string() }), output: z.string(), impl: async (_c, { text }) => text }),
    },
  });
  const service = await httpService({ socket, expose: ["demo_ask", "demo_echo"] });
  services.push(service);
  await kernel.boot();
  service.listen({ outside: (origin) => kernel.outside(origin), subscribe: (fn) => kernel.events.subscribe(fn) });
  return { socket, client: httpClient({ socket, name: "t" }) };
}

describe("HTTP 客户端", () => {
  test("调用、列出对外的、撤回问题；请求不成立时抛出服务端说的原因", async () => {
    const { client } = await setup();

    expect((await client.operations()).map((o) => o.name)).toEqual(["demo_ask", "demo_echo"]);
    expect(await client.call("demo_echo", { text: "hi" })).toMatchObject({ result: { ok: true, value: "hi" } });
    const asking = client.call("demo_ask", {});
    while ((await client.parks()).length === 0) await Bun.sleep(1);
    await client.withdraw((await client.parks())[0]!.id, "不答");
    expect(await asking).toMatchObject({ result: { ok: false, by: "demo_ask", reason: "不答" } });
    expect(client.call("demo_nope", {})).rejects.toThrow("not exposed: demo_nope");
    expect(client.result("nope")).rejects.toThrow("unknown run: nope");
  });

  test("事件流：连上了才返回，之后的事件都收得到，带上自报的名字；中止即结束", async () => {
    const { client } = await setup();
    const events: HarnessEvent[] = [];
    const abort = new AbortController();

    const { closed } = await client.events((e) => events.push(e), abort.signal);
    await client.call("demo_echo", { text: "hi" });
    while (!events.some((e) => e.type === "run.reaped")) await Bun.sleep(1);
    expect(events.map((e) => e.type)).toEqual(["run.started", "run.exited", "run.reaped"]);
    expect(events[0]).toMatchObject({ origin: client.origin });
    abort.abort();
    await closed;
  });

  test("reachable：socket 上有没有活着的服务", async () => {
    const { socket } = await setup();
    expect(await reachable(socket)).toBe(true);
    expect(await reachable(`${socket}.nope`)).toBe(false);
  });
});
