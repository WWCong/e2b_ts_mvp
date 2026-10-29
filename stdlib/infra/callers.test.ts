import { describe, expect, test } from "bun:test";
import { callerOf, callers } from "./callers";

const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const now = () => Math.floor(Date.now() / 1000);

describe("调用者的凭据", () => {
  test("认出调用者：JWT 的 sub；不是 JWT 或没有 sub 的取令牌的摘要，不带令牌本身", () => {
    expect(callerOf(jwt({ sub: "user-1", exp: 123 }))).toEqual({ id: "user-1", exp: 123 });
    const opaque = callerOf("sk-plain-key");
    expect(opaque.id).toMatch(/^token-[0-9a-f]{16}$/);
    expect(opaque.id).not.toContain("sk-plain-key");
    expect(callerOf(jwt({ exp: 1 })).id).toMatch(/^token-/);
  });

  test("每个调用者留最新的令牌；还没有的等下一个请求带来", async () => {
    const store = callers();
    const id = store.put(jwt({ sub: "u", n: 1 }));
    expect(await store.get(id)).toBe(jwt({ sub: "u", n: 1 }));
    store.put(jwt({ sub: "u", n: 2 }));
    expect(await store.get("u")).toBe(jwt({ sub: "u", n: 2 }));

    const later = store.get("v");
    store.put(jwt({ sub: "v" }));
    expect(await later).toBe(jwt({ sub: "v" }));
  });

  test("过期的不给，等新的；中止时以中止的原因拒绝", async () => {
    const store = callers();
    store.put(jwt({ sub: "u", exp: now() - 10 }));
    let got: string | undefined;
    const waiting = store.get("u").then((t) => (got = t));
    await Bun.sleep(5);
    expect(got).toBeUndefined();
    const fresh = jwt({ sub: "u", exp: now() + 60 });
    store.put(fresh);
    await waiting;
    expect(got).toBe(fresh);

    const abort = new AbortController();
    const gone = store.get("nobody", abort.signal);
    abort.abort(new Error("killed"));
    await expect(gone).rejects.toThrow("killed");
  });
});
