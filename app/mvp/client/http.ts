/**
 * MVP 客户端这一侧的 HTTP 客户端：经服务接口（服务端见 stdlib/serve/http.ts）用 Harness。
 * 协议是通用的，以后别的应用也要时再抽成共享的包。
 * 它在 Harness 外面，只能做服务接口允许的事：调 expose 里的 Operation、取结果、回答问题、看事件。
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

/** 经 Unix socket 连 HTTP 服务接口 */
export function httpClient(options: { socket: string; name: string }): Client {
  const { socket, name } = options;
  const request = async (method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> => {
    const res = await fetch(`http://harness${path}`, {
      unix: socket,
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

/** socket 上有没有活着的服务 */
export async function reachable(socket: string): Promise<boolean> {
  try {
    await fetch("http://harness/operations", { unix: socket, signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}
