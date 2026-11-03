/**
 * HTTP 服务接口（装配配置 serve.http）。只提供装配配置 expose 里列出的 Operation（都须声明了 api，宿主启动前查过）。
 * 请求头 harness-client 是调用方自报的名字，记进树的 origin（http:名字），客户端重连后据它认出自己发起的树；
 * 它只是个标签。调用者（Ctx.caller）从哪来：配了 callers 时，请求带的 authorization: Bearer <令牌>（网关签发的 JWT）
 * 记进调用者的凭据，调用者是令牌认出的（见 stdlib/infra/callers.ts）；配了 callerHeader 时，是网关带来的这个请求头的值
 * （请求头只能放 ASCII，值按 URI 编码，这里解码）。
 * 谁能调哪个 Operation 由前面的网关校验，这里不查。visibility 缺省是 caller：每个调用者只看得到自己的树，runs、parks、
 * 回答问题与事件流都按调用者分开（没有调用者的算一个）；all：谁都看得到所有的树（如 builder，会话对所有人公开）。
 * 配了 files 时，不是下面这些路由的 GET 按路径前缀交给目录里的静态文件（网页、产物），目录是 index.html。
 * 请求与响应都是 JSON：
 * - GET  /operations        对外的 Operation：名字、说明、入参与出参的 JSON Schema
 * - POST /operations/:name  调用，请求体是入参（空即 {}）。等到结束，返回 { runId, result } 并取走结果；
 *                           等的途中断开，树照常跑完，结果留着，之后按 runId 取。带 ?async 立即返回 202 { runId }
 * - GET  /runs              结果还没被取走的树：{ runId, operation, origin, caller, done }
 * - GET  /runs/:id          等这棵树结束并取走结果：{ runId, result }；等的途中断开不取
 * - GET  /parks             等待中的问题：{ id, root, operation, schema, payload, caller }
 * - POST /parks/:id         回答 { value }，或撤回 { withdraw: 原因 }
 * - GET  /events            事件流（SSE），每条 data 是一个事件；只推连上之后的，现状用 /runs 与 /parks 取。
 *                           没有事件时每隔几秒发一行注释，免得被当成空闲连接断开
 * 调用被拒（result.ok 为 false）也是 200：拒绝是调用的结果（R16）。请求本身不成立（不是 api、入参不符、
 * 没有这个 park、正在关停等）是 400，没对外的 Operation、没有这棵树或这个路由是 404，响应体 { error }。
 * 监听 Unix socket（本地；文件权限只给本用户）或 TCP（缺省只绑 127.0.0.1）。没有认证：TCP 只开在本机，
 * 或放在把关的网关后面（如沙盒应用：沙盒在隔离的内网，进来的请求都经业务网关）。
 */

import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { HarnessEvent } from "../kernel/events";
import type { Outside } from "../kernel/outside";
import type { Callers } from "../infra/callers";
import type { Service } from "./service";

/**
 * socket 与 port 二选一；expose：对外的 Operation，不在里面的一律当作没有。
 * callers：记下请求带的调用者令牌，或 callerHeader：网关带来的调用者的请求头；visibility：看得到谁的树，缺省 caller。
 * files：路径前缀 → 目录，如 { "/": 网页的目录, "/tree/": 产物的目录 }
 */
export type HttpConfig = {
  socket?: string;
  port?: number;
  hostname?: string;
  expose: string[];
  callers?: Callers;
  callerHeader?: string;
  visibility?: "caller" | "all";
  files?: Record<string, string>;
};

/** 服务接口自己的路由的第一段：其余的 GET 才交给静态文件 */
const ROUTES = new Set(["operations", "runs", "parks", "events"]);

const encoder = new TextEncoder();

/** 连着的事件流 → 它的调用者 */
type Streams = Map<ReadableStreamDefaultController<Uint8Array>, string | undefined>;

export async function httpService(config: HttpConfig): Promise<Service> {
  const { socket, port, hostname = "127.0.0.1" } = config;
  const expose = new Set(config.expose);
  if ((socket === undefined) === (port === undefined)) throw new Error("serve.http needs exactly one of socket and port");
  if (socket) await claim(socket);
  let server: ReturnType<typeof Bun.serve> | undefined;
  /** 连着的事件流，各自的调用者 */
  const streams: Streams = new Map();
  /** 推给 to 认可的调用者的事件流 */
  const send = (chunk: Uint8Array, to: (caller: string | undefined) => boolean) => {
    for (const [stream, caller] of streams) {
      if (!to(caller)) continue;
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
      const all = config.visibility === "all";
      // 只推给这棵树的调用者（看得到所有的树时推给所有人）
      ctx.subscribe((event: HarnessEvent) => send(encoder.encode(`data: ${JSON.stringify(event)}\n\n`), (caller) => all || caller === event.caller));
      // 事件流可能很久没有事件，Bun 会当它空闲断开（缺省 10 秒，Unix socket 上也是）：隔几秒发一行注释
      heartbeat = setInterval(() => send(encoder.encode(": \n\n"), () => true), 5_000);
      const callerOf = (req: Request) => {
        if (config.callerHeader) return decode(req.headers.get(config.callerHeader)?.trim() ?? "") || undefined;
        const token = req.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
        return (token && config.callers?.put(token)) || undefined;
      };
      const files = config.files && staticFiles(config.files);
      const fetch = (req: Request) => {
        const first = new URL(req.url).pathname.split("/")[1] ?? "";
        if (files && !ROUTES.has(first) && (req.method === "GET" || req.method === "HEAD")) return files(req);
        return route(req, outsideOf(req), callerOf(req), all, expose, streams);
      };
      // 等结果的请求也可能很久不说话：TCP 关掉空闲超时
      server = socket ? Bun.serve({ unix: socket, fetch }) : Bun.serve({ port, hostname, idleTimeout: 0, fetch });
      if (socket) chmodSync(socket, 0o600);
    },
    stop(closeConnections) {
      server?.stop(closeConnections);
      if (!closeConnections) return;
      clearInterval(heartbeat);
      for (const stream of streams.keys()) stream.close();
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
  caller: string | undefined,
  all: boolean,
  expose: Set<string>,
  streams: Streams,
): Promise<Response> {
  // 每个调用者只看得到自己的树（看得到所有的树时不筛）
  const runs = () => outside.runs().filter((r) => all || r.caller === caller);
  const parks = () => outside.parks().filter((p) => all || p.caller === caller);
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
        const runId = outside.submit(id!, await body(req), caller);
        if (searchParams.has("async")) return json({ runId }, 202);
        return await deliver(outside, runId, req.signal);
      }
      case "GET /runs":
        return json(runs());
      case "GET /runs/:id":
        if (!runs().some((r) => r.runId === id)) return error(404, `unknown run: ${id}`);
        return await deliver(outside, id!, req.signal);
      case "GET /parks":
        return json(parks());
      case "POST /parks/:id": {
        if (!parks().some((p) => p.id === id)) return error(400, `not parked: ${id}`);
        const answer = (await body(req)) as { value?: unknown; withdraw?: unknown };
        if (typeof answer.withdraw === "string") outside.withdraw(id!, answer.withdraw);
        else if ("value" in answer) outside.unpark(id!, answer.value);
        else return error(400, "body must be { value } or { withdraw: reason }");
        return json({ ok: true });
      }
      case "GET /events":
        return events(streams, caller);
      default:
        return error(404, `no route: ${req.method} ${pathname}`);
    }
  } catch (err) {
    return error(400, err instanceof Error ? err.message : String(err));
  }
}

/**
 * 静态文件：按最长的路径前缀找到目录，交出里面的文件（类型按扩展名），目录交它的 index.html。
 * 只认目录里的：按解开符号链接后的真实路径查，越出目录的与没有的都是 404
 */
function staticFiles(mounts: Record<string, string>): (req: Request) => Response {
  const prefixes = Object.keys(mounts).sort((a, b) => b.length - a.length);
  return (req) => {
    const pathname = decodeURIComponent(new URL(req.url).pathname);
    const prefix = prefixes.find((p) => pathname.startsWith(p));
    if (prefix === undefined) return error(404, `no route: ${req.method} ${pathname}`);
    const root = realpathSync(mounts[prefix]!);
    let path = resolve(root, `.${sep}${pathname.slice(prefix.length)}`);
    try {
      if (statSync(path).isDirectory()) path = join(path, "index.html");
      path = realpathSync(path);
    } catch {
      return error(404, `no such file: ${pathname}`);
    }
    if (path !== root && !path.startsWith(root + sep)) return error(404, `no such file: ${pathname}`);
    if (!statSync(path).isFile()) return error(404, `no such file: ${pathname}`);
    return new Response(Bun.file(path), { headers: { "cache-control": "no-cache" } });
  };
}

/** 等树结束，取走结果交给调用方；调用方等的途中断开就不取，结果留着 */
async function deliver(outside: Outside, runId: string, signal: AbortSignal): Promise<Response> {
  const gone = new Promise<undefined>((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
  const result = await Promise.race([outside.wait(runId), gone]);
  if (!result || signal.aborted) return new Response(null, { status: 499 });
  return json({ runId, result: await outside.reap(runId) });
}

function events(streams: Streams, caller: string | undefined): Response {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      streams.set(c, caller);
      c.enqueue(encoder.encode(": connected\n\n"));
    },
    cancel() {
      streams.delete(controller);
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

/** URI 编码的值解码；不是编码过的（含不成对的 %）原样用 */
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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
