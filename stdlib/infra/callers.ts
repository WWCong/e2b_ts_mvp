/**
 * 调用者的凭据（基建）。请求经业务网关进来，带着签发给调用者的 JWT（authorization: Bearer）；Harness 相信它的内容，
 * 调别的服务（大模型 API、MCP、数据服务等）时以调用者的身份带上它。
 * 服务接口把进来的令牌记在这里（每个调用者留最新的一个），树记下调用者的 id（Run.caller）；
 * 基建调外部服务时按 Run 的调用者取出来。令牌只在内存里，不进日志与事件；插件拿不到令牌。
 * 过期（JWT 的 exp）或进程重启后还没有的，等这个调用者的下一个请求带来新的。
 */

export interface Callers {
  /** 记下一个调用者的令牌，同一个调用者留最新的；返回调用者的 id */
  put(token: string): string;
  /** 调用者现在的令牌；还没有或已过期，就等下一个请求带来新的。signal 中止时以它的原因拒绝 */
  get(caller: string, signal?: AbortSignal): Promise<string>;
}

/**
 * 从令牌认出调用者：JWT 的 sub，exp 是过期的时刻（秒）。只读内容、不验签（网关签发，沙盒相信它）。
 * 不是 JWT 或没有 sub 的，id 取令牌的摘要：令牌本身不进日志与事件
 */
export function callerOf(token: string): { id: string; exp?: number } {
  let claims: { sub?: unknown; exp?: unknown } = {};
  const parts = token.split(".");
  if (parts.length === 3) {
    try {
      claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    } catch {
      // 不是 JWT：当作不透明的令牌
    }
  }
  const id = typeof claims.sub === "string" && claims.sub ? claims.sub : `token-${new Bun.CryptoHasher("sha256").update(token).digest("hex").slice(0, 16)}`;
  return { id, exp: typeof claims.exp === "number" ? claims.exp : undefined };
}

/** 内存里的调用者凭据 */
export function callers(): Callers {
  const tokens = new Map<string, { token: string; exp?: number }>();
  /** 在等某个调用者的新令牌的 */
  const waiting = new Map<string, Set<() => void>>();
  const usable = (entry?: { exp?: number }) => entry !== undefined && (entry.exp === undefined || entry.exp * 1000 > Date.now());

  return {
    put(token) {
      const { id, exp } = callerOf(token);
      tokens.set(id, { token, exp });
      if (usable({ exp })) {
        for (const wake of waiting.get(id) ?? []) wake();
        waiting.delete(id);
      }
      return id;
    },

    async get(caller, signal) {
      for (;;) {
        signal?.throwIfAborted();
        const entry = tokens.get(caller);
        if (usable(entry)) return entry!.token;
        await new Promise<void>((resolve, reject) => {
          const set = waiting.get(caller) ?? new Set();
          waiting.set(caller, set);
          const settle = () => {
            set.delete(wake);
            signal?.removeEventListener("abort", abort);
          };
          const wake = () => (settle(), resolve());
          const abort = () => (settle(), reject(signal!.reason));
          set.add(wake);
          signal?.addEventListener("abort", abort, { once: true });
        });
      }
    },
  };
}
