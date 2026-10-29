/**
 * 客户端这一侧的 HTTP 客户端：经服务接口（服务端见 stdlib/serve/http.ts）用 Harness，各个应用的客户端共用。
 * 它在 Harness 外面，只能做服务接口允许的事：调 expose 里的 Operation、取结果、回答问题、看事件。
 * 连本地的 Unix socket，或一个 URL（TCP，如沙盒的公网地址），后者可带服务接口要的令牌。
 * client 是自报的名字，记进它发起的树的 origin（http:名字），重连后据它认出自己上次发起的树。
 */

import type { ApiInfo, HarnessEvent, ParkInfo, Result, RunInfo } from "stdlib";

/** 服务接口回了错误（请求本身不成立，如没对外、入参不符）。连不上、连接断了抛的是别的异常 */
export class ServiceError extends Error {}

/** 调用都可能抛异常：服务接口回了错误是 ServiceError，别的表示连接出了问题（Harness 停下或走了） */
export type Client = {
  /** 自报的名字 */
  readonly name: string;
  /** 这个客户端发起的树记的 origin */
  readonly origin: string;
  operations(): Promise<ApiInfo[]>;
  /** 调用并等到结束，取走结果。signal 中止（客户端不等了）时树照常跑完，结果留在服务端，之后按 runId 取 */
  call(name: string, input: unknown, signal?: AbortSignal): Promise<{ runId: string; result: Result }>;
  /** 结果还没被取走的树 */
  runs(): Promise<RunInfo[]>;
  /** 等这棵树结束并取走结果 */
  result(runId: string, signal?: AbortSignal): Promise<{ runId: string; result: Result }>;
  /** 等待中的问题 */
  parks(): Promise<ParkInfo[]>;
  answer(id: string, value: unknown): Promise<void>;
  withdraw(id: string, reason: string): Promise<void>;
  /**
   * 订阅事件流，每条交给 onEvent。连上了才返回（之后的事件都收得到，可以接着用 runs、parks 取现状）；
   * closed 在连接断开（服务端关停）或 signal 中止时兑现
   */
  events(onEvent: (event: HarnessEvent) => void, signal?: AbortSignal): Promise<{ closed: Promise<void> }>;
};

/** 连哪个服务接口：本地的 Unix socket，或 URL（如 http://127.0.0.1:8081）；token 是服务接口要的令牌 */
export type Target = { socket: string } | { url: string; token?: string };

/** 一次请求：Target 决定连哪、带什么头 */
function send(target: Target, path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
  if ("socket" in target) return fetch(`http://harness${path}`, { ...init, unix: target.socket });
  const headers = target.token ? { ...init.headers, authorization: `Bearer ${target.token}` } : init.headers;
  return fetch(`${target.url.replace(/\/$/, "")}${path}`, { ...init, headers });
}

/** 连 HTTP 服务接口 */
export function httpClient(options: Target & { name: string }): Client {
  const { name } = options;
  const request = async (method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> => {
    const res = await send(options, path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { "harness-client": name },
      signal,
    });
    if (!res.ok) throw new ServiceError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
    return res;
  };
  const json = async <T>(method: string, path: string, body?: unknown, signal?: AbortSignal) =>
    (await (await request(method, path, body, signal)).json()) as T;

  return {
    name,
    origin: `http:${name}`,
    operations: () => json("GET", "/operations"),
    call: (op, input, signal) => json("POST", `/operations/${encodeURIComponent(op)}`, input, signal),
    runs: () => json("GET", "/runs"),
    result: (runId, signal) => json("GET", `/runs/${encodeURIComponent(runId)}`, undefined, signal),
    parks: () => json("GET", "/parks"),
    answer: async (id, value) => void (await request("POST", `/parks/${encodeURIComponent(id)}`, { value })),
    withdraw: async (id, reason) => void (await request("POST", `/parks/${encodeURIComponent(id)}`, { withdraw: reason })),
    events: async (onEvent, signal) => {
      const res = await request("GET", "/events", undefined, signal);
      const read = async () => {
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          for await (const chunk of res.body!) {
            buffer += decoder.decode(chunk, { stream: true });
            let end: number;
            while ((end = buffer.indexOf("\n\n")) >= 0) {
              const block = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              if (block.startsWith("data: ")) onEvent(JSON.parse(block.slice("data: ".length)) as HarnessEvent);
            }
          }
        } catch {
          // 中止或服务端断开：事件流结束
        }
      };
      return { closed: read() };
    },
  };
}

/** 那里有没有活着的服务（连得上就算，令牌不对也算：服务在） */
export async function reachable(target: Target): Promise<boolean> {
  try {
    await send(target, "/operations", { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}
