import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { callers } from "../infra/callers";
import { Kernel } from "../kernel/kernel";
import type { ParkInfo } from "../kernel/outside";
import { op } from "../kernel/plugin";
import { httpService } from "./http";
import type { Service } from "./service";

const services: Service[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.stop(true);
});

/** demo_ask 问一句（park）；demo_echo 回显；demo_fail 失败——这三个对外。demo_hidden 声明了 api 但没列进 expose；demo_secret 没声明 api */
async function setup(socket?: string) {
  socket ??= join(await mkdtemp(join(tmpdir(), "http-")), "h.sock");
  const kernel = new Kernel();
  kernel.use("demo", {
    operations: {
      ask: op({
        api: true,
        usage: "问一句",
        input: z.object({ q: z.string() }),
        output: z.string(),
        impl: (ctx, { q }) => ctx.park({ schema: z.toJSONSchema(z.string()), payload: q }),
      }),
      echo: op({ api: true, usage: "回显", input: z.object({ text: z.string() }), output: z.string(), impl: async (_ctx, { text }) => `echo: ${text}` }),
      fail: op({
        api: true,
        usage: "总是失败",
        input: z.object({}),
        output: z.string(),
        impl: async () => {
          throw new Error("坏了");
        },
      }),
      hidden: op({ api: true, usage: "没对外", input: z.object({}), output: z.string(), impl: async () => "hidden" }),
      secret: op({ input: z.object({}), impl: async () => "secret" }),
    },
  });
  const service = await httpService({ socket, expose: ["demo_ask", "demo_echo", "demo_fail"] });
  services.push(service);
  await kernel.boot();
  service.listen({ outside: (origin) => kernel.outside(origin), subscribe: (fn) => kernel.events.subscribe(fn) });

  const request = (method: string, path: string, body?: unknown, init: RequestInit = {}) =>
    fetch(`http://harness${path}`, {
      unix: socket,
      method,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      headers: { "harness-client": "test" },
      ...init,
    });
  const get = async (path: string) => (await request("GET", path)).json();
  const parked = async () => {
    for (;;) {
      const parks = (await get("/parks")) as ParkInfo[];
      if (parks.length > 0) return parks[0]!;
      await Bun.sleep(1);
    }
  };
  return { kernel, service, socket, request, get, parked };
}

describe("HTTP 服务接口", () => {
  test("GET /operations：只列 expose 里的，带说明、入参与出参的 JSON Schema", async () => {
    const { get } = await setup();
    const operations = (await get("/operations")) as { name: string; usage?: string; input: unknown }[];

    expect(operations.map((o) => o.name)).toEqual(["demo_ask", "demo_echo", "demo_fail"]);
    expect(operations[0]).toMatchObject({ usage: "问一句", input: { type: "object", required: ["q"] }, output: { type: "string" } });
  });

  test("调用：等到结束返回 { runId, result } 并取走；被拒也是 200；请求不成立是 400，没对外的与没有的是 404", async () => {
    const { request, get } = await setup();

    const echo = await request("POST", "/operations/demo_echo", { text: "hi" });
    expect([echo.status, await echo.json()]).toEqual([200, { runId: expect.any(String), result: { ok: true, value: "echo: hi" } }]);
    expect(await get("/runs")).toEqual([]);

    const fail = await request("POST", "/operations/demo_fail");
    expect([fail.status, await fail.json()]).toMatchObject([200, { result: { ok: false, by: "demo_fail", reason: "坏了" } }]);

    for (const name of ["demo_hidden", "demo_secret", "demo_nope"]) {
      const res = await request("POST", `/operations/${name}`, {});
      expect([res.status, await res.json()]).toEqual([404, { error: `not exposed: ${name}` }]);
    }
    for (const [path, body, error] of [
      ["/operations/demo_echo", {}, "invalid input for demo_echo"],
      ["/operations/demo_echo", "{", "request body is not valid JSON"],
    ] as const) {
      const res = await request("POST", path, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(error);
    }
    expect((await request("GET", "/runs/nope")).status).toBe(404);
    expect((await request("GET", "/whatever")).status).toBe(404);
  });

  test("异步调用与回答问题：?async 立即返回 runId；/parks 列出问题，POST 回答；GET /runs/:id 取走结果", async () => {
    const { request, get, parked } = await setup();

    const submitted = await request("POST", "/operations/demo_ask?async", { q: "哪个？" });
    const { runId } = (await submitted.json()) as { runId: string };
    expect(submitted.status).toBe(202);
    expect(await get("/runs")).toEqual([{ runId, operation: "demo_ask", origin: "http:test", done: false }]);
    const park = await parked();
    expect(park).toEqual({ id: runId, root: runId, operation: "demo_ask", schema: z.toJSONSchema(z.string()), payload: "哪个？" });

    const wrong = await request("POST", `/parks/${park.id}`, { value: 1 });
    expect(wrong.status).toBe(400);
    expect((await request("POST", `/parks/${park.id}`, { value: "这个" })).status).toBe(200);
    expect(await get(`/runs/${runId}`)).toEqual({ runId, result: { ok: true, value: "这个" } });
    expect(await get("/runs")).toEqual([]);
    expect((await request("GET", `/runs/${runId}`)).status).toBe(404);
  });

  test("撤回：POST /parks/:id { withdraw }，调用以拒绝结束", async () => {
    const { request, get, parked } = await setup();
    const { runId } = (await (await request("POST", "/operations/demo_ask?async", { q: "哪个？" })).json()) as { runId: string };

    await request("POST", `/parks/${(await parked()).id}`, { withdraw: "不想答" });
    expect(await get(`/runs/${runId}`)).toEqual({ runId, result: { ok: false, by: "demo_ask", reason: "不想答", retryable: false } });
  });

  test("调用方等的途中断开：树照常跑完，结果留着，之后按 runId 取", async () => {
    const { request, get, parked } = await setup();
    const abort = new AbortController();
    const waiting = request("POST", "/operations/demo_ask", { q: "哪个？" }, { signal: abort.signal }).catch(() => "断开");

    const park = await parked();
    abort.abort();
    expect(await waiting).toBe("断开");
    await request("POST", `/parks/${park.id}`, { value: "这个" });
    await Bun.sleep(5);

    expect(await get("/runs")).toEqual([{ runId: park.root, operation: "demo_ask", origin: "http:test", done: true }]);
    expect(await get(`/runs/${park.root}`)).toEqual({ runId: park.root, result: { ok: true, value: "这个" } });
  });

  test("事件流：连上之后的事件逐条推送", async () => {
    const { request } = await setup();
    const reader = (await request("GET", "/events")).body!.getReader();
    const decoder = new TextDecoder();
    let text = "";

    const { runId } = (await (await request("POST", "/operations/demo_echo", { text: "hi" })).json()) as { runId: string };
    while (!text.includes('"run.reaped"')) text += decoder.decode((await reader.read()).value);
    const events = text
      .split("\n\n")
      .filter((block) => block.startsWith("data: "))
      .map((block) => JSON.parse(block.slice("data: ".length)) as { type: string; runId: string; origin?: string });
    expect(events.map((e) => [e.type, e.runId])).toEqual([
      ["run.started", runId],
      ["run.exited", runId],
      ["run.reaped", runId],
    ]);
    expect(events[0]!.origin).toBe("http:test");
    await reader.cancel();
  });

  test("调用者：配了 callers，请求带的 Bearer 令牌记进调用者的凭据，发起的树记下调用者；没带的没有调用者", async () => {
    const socket = join(await mkdtemp(join(tmpdir(), "http-")), "h.sock");
    const kernel = new Kernel();
    kernel.use("demo", {
      operations: { who: op({ api: true, usage: "是谁", input: z.object({}), output: z.string(), impl: async (ctx) => ctx.caller ?? "没人" }) },
    });
    const store = callers();
    const service = await httpService({ socket, expose: ["demo_who"], callers: store });
    services.push(service);
    await kernel.boot();
    service.listen({ outside: (origin) => kernel.outside(origin), subscribe: (fn) => kernel.events.subscribe(fn) });
    const who = async (headers: Record<string, string> = {}) =>
      ((await (await fetch("http://harness/operations/demo_who", { unix: socket, method: "POST", body: "{}", headers })).json()) as { result: { value: string } })
        .result.value;
    const token = `e30.${Buffer.from(JSON.stringify({ sub: "alice" })).toString("base64url")}.sig`;

    expect(await who({ authorization: `Bearer ${token}` })).toBe("alice");
    expect(await store.get("alice")).toBe(token);
    expect(await who()).toBe("没人");
  });

  test("socket 已有活着的服务：报错，不去动它；上次留下的死 socket 文件删掉再监听；关停完删掉 socket 文件", async () => {
    const { socket, service } = await setup();
    expect(httpService({ socket, expose: [] })).rejects.toThrow(`a harness is already serving on ${socket}`);

    service.stop(true);
    expect(existsSync(socket)).toBe(false);
    writeFileSync(socket, "");
    const { get } = await setup(socket);
    expect(await get("/runs")).toEqual([]);
  });
});
