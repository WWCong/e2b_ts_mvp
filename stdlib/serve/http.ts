/**
 * HTTP 服务接口（装配配置 serve.http）。只提供装配配置 expose 里列出的 Operation（都须声明了 api，宿主启动前查过）。
 * 请求头 harness-client 是调用方自报的名字，记进树的 origin（http:名字），客户端重连后据它认出自己发起的树；
 * 还没有认证，它只是个标签。请求与响应都是 JSON：
 * - GET  /operations        对外的 Operation：名字、说明、入参与出参的 JSON Schema
 * - POST /operations/:name  调用，请求体是入参（空即 {}）。等到结束，返回 { runId, result } 并取走结果；
 *                           等的途中断开，树照常跑完，结果留着，之后按 runId 取。带 ?async 立即返回 202 { runId }
 * - GET  /runs              结果还没被取走的树：{ runId, operation, origin, done }
 * - GET  /runs/:id          等这棵树结束并取走结果：{ runId, result }；等的途中断开不取
 * - GET  /parks             等待中的问题：{ id, root, operation, schema, payload }
 * - POST /parks/:id         回答 { value }，或撤回 { withdraw: 原因 }
 * - GET  /events            事件流（SSE），每条 data 是一个事件；只推连上之后的，现状用 /runs 与 /parks 取。
 *                           没有事件时每隔几秒发一行注释，免得被当成空闲连接断开
 * 调用被拒（result.ok 为 false）也是 200：拒绝是调用的结果（R16）。请求本身不成立（不是 api、入参不符、
 * 没有这个 park、正在关停等）是 400，没对外的 Operation、没有这棵树或这个路由是 404，响应体 { error }。
 * 监听 Unix socket（本地；文件权限只给本用户）或 TCP（缺省只绑 127.0.0.1）。没有认证：TCP 只开在本机，
 * 或放在把关的网关后面（如沙盒应用：沙盒在隔离的内网，进来的请求都经业务网关）。
 */

import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { HarnessEvent } from "../kernel/events";
import type { Outside } from "../kernel/outside";
import type { Service } from "./service";

/** socket 与 port 二选一；expose：对外的 Operation，不在里面的一律当作没有 */
export type HttpConfig = { socket?: string; port?: number; hostname?: string; expose: string[] };

const encoder = new TextEncoder();

export async function httpService(config: HttpConfig): Promise<Service> {
  const { socket, port, hostname = "127.0.0.1" } = config;
  const expose = new Set(config.expose);
  if ((socket === undefined) === (port === undefined)) throw new Error("serve.http needs exactly one of socket and port");
  if (socket) await claim(socket);
  let server: ReturnType<typeof Bun.serve> | undefined;
  /** 连着的事件流 */
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const broadcast = (chunk: Uint8Array) => {
    for (const stream of streams) {
      try {
        stream.enqueue(chunk);
      } catch {
        streams.delete(stream);
      }
    }
  };
  let heartbeat: Timer | undefined;

  return {
    address: socket ? `unix:${socket}` : `http://${hostname}:${port}`,
    listen(ctx) {
      const outsides = new Map<string, Outside>();
      const outsideOf = (req: Request) => {
        const client = req.headers.get("harness-client");
        const origin = client ? `http:${client}` : "http";
        let outside = outsides.get(origin);
        if (!outside) outsides.set(origin, (outside = ctx.outside(origin)));
        return outside;
      };
      ctx.subscribe((event: HarnessEvent) => broadcast(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)));
      // 事件流可能很久没有事件，Bun 会当它空闲断开（缺省 10 秒，Unix socket 上也是）：隔几秒发一行注释
      heartbeat = setInterval(() => broadcast(encoder.encode(": \n\n")), 5_000);
      const fetch = (req: Request) => route(req, outsideOf(req), expose, streams);
      // 等结果的请求也可能很久不说话：TCP 关掉空闲超时
      server = socket ? Bun.serve({ unix: socket, fetch }) : Bun.serve({ port, hostname, idleTimeout: 0, fetch });
      if (socket) chmodSync(socket, 0o600);
    },
    stop(closeConnections) {
      server?.stop(closeConnections);
      if (!closeConnections) return;
      clearInterval(heartbeat);
      for (const stream of streams) stream.close();
      streams.clear();
      if (socket) rmSync(socket, { force: true });
    },
  };
}

/** 先占住 socket：已有活着的服务就报错（同一个状态目录不能跑两个 Harness）；上次留下的死 socket 文件删掉 */
async function claim(socket: string): Promise<void> {
  mkdirSync(dirname(socket), { recursive: true });
  if (!existsSync(socket)) return;
  const alive = await fetch("http://harness/operations", { unix: socket, signal: AbortSignal.timeout(1000) }).then(
    () => true,
    () => false,
  );
  if (alive) throw new Error(`a harness is already serving on ${socket}`);
  rmSync(socket);
}

async function route(
  req: Request,
  outside: Outside,
  expose: Set<string>,
  streams: Set<ReadableStreamDefaultController<Uint8Array>>,
): Promise<Response> {
  const { pathname, searchParams } = new URL(req.url);
  const [resource = "", id, ...rest] = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const at = `${req.method} /${resource}${id === undefined ? "" : "/:id"}`;
  if (rest.length > 0) return error(404, `no route: ${req.method} ${pathname}`);
  try {
    switch (at) {
      case "GET /operations":
        return json(outside.operations().filter((o) => expose.has(o.name)));
      case "POST /operations/:id": {
        if (!expose.has(id!)) return error(404, `not exposed: ${id}`);
        const runId = outside.submit(id!, await body(req));
        if (searchParams.has("async")) return json({ runId }, 202);
        return await deliver(outside, runId, req.signal);
      }
      case "GET /runs":
        return json(outside.runs());
      case "GET /runs/:id":
        if (!outside.runs().some((r) => r.runId === id)) return error(404, `unknown run: ${id}`);
        return await deliver(outside, id!, req.signal);
      case "GET /parks":
        return json(outside.parks());
      case "POST /parks/:id": {
        const answer = (await body(req)) as { value?: unknown; withdraw?: unknown };
        if (typeof answer.withdraw === "string") outside.withdraw(id!, answer.withdraw);
        else if ("value" in answer) outside.unpark(id!, answer.value);
        else return error(400, "body must be { value } or { withdraw: reason }");
        return json({ ok: true });
      }
      case "GET /events":
        return events(streams);
      default:
        return error(404, `no route: ${req.method} ${pathname}`);
    }
  } catch (err) {
    return error(400, err instanceof Error ? err.message : String(err));
  }
}

/** 等树结束，取走结果交给调用方；调用方等的途中断开就不取，结果留着 */
async function deliver(outside: Outside, runId: string, signal: AbortSignal): Promise<Response> {
  const gone = new Promise<undefined>((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
  const result = await Promise.race([outside.wait(runId), gone]);
  if (!result || signal.aborted) return new Response(null, { status: 499 });
  return json({ runId, result: await outside.reap(runId) });
}

function events(streams: Set<ReadableStreamDefaultController<Uint8Array>>): Response {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      streams.add(c);
      c.enqueue(encoder.encode(": connected\n\n"));
    },
    cancel() {
      streams.delete(controller);
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

/** 请求体：JSON，空即 {} */
async function body(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("request body is not valid JSON");
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function error(status: number, message: string): Response {
  return json({ error: message }, status);
}
