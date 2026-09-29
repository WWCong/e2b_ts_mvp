import { describe, expect, test } from "bun:test";
import { admit, narrow, selects, Surface, type CallScope } from "../../src/kernel/capability.ts";

describe("Surface", () => {
  test("排序去重", () => {
    const s = new Surface(["fs.write", "agent.assist", "fs.write", "fs.read"]);
    expect(s.names).toEqual(["agent.assist", "fs.read", "fs.write"]);
    expect(s.size).toBe(3);
    expect(s.has("fs.read")).toBe(true);
    expect(s.has("fs")).toBe(false);
    expect(Object.isFrozen(s.names)).toBe(true);
  });
});

describe("selects", () => {
  test("含点的按 Operation 名，不含点的按包名", () => {
    expect(selects("fs.read", "fs.read")).toBe(true);
    expect(selects("fs.read", "fs.write")).toBe(false);
    expect(selects("fs", "fs.write")).toBe(true);
    expect(selects("fs", "fsx.read")).toBe(false);
    expect(selects("video-analysis", "video-analysis.completionScore")).toBe(true);
  });
});

describe("narrow", () => {
  const base = new Surface(["fs.read", "fs.write", "fs.delete", "model.complete", "python.run"]);

  test("没有收窄时原样返回同一份", () => {
    expect(narrow(base, null, [])).toBe(base);
  });

  test("@only 可写包名与 Operation 名", () => {
    expect(narrow(base, ["fs", "python.run"], []).names).toEqual(["fs.delete", "fs.read", "fs.write", "python.run"]);
  });

  test("先 @only 再 @exclude", () => {
    expect(narrow(base, ["fs"], ["fs.delete", "fs.write"]).names).toEqual(["fs.read"]);
    expect(narrow(base, null, ["fs"]).names).toEqual(["model.complete", "python.run"]);
  });

  test("只能收窄，点名 base 里没有的不会加进来", () => {
    expect(narrow(base, ["web.search"], []).names).toEqual([]);
  });
});

describe("admit", () => {
  const surface = new Surface(["fs.read", "web.searchRaw"]);
  const nativeBody: CallScope = { kind: "body", operation: "web.search", form: "native", surface };
  const scriptBody: CallScope = { kind: "body", operation: "agent.assist", form: "script", surface };
  const pub = { public: true };
  const hidden = { public: false };

  test("在能力面里就放行", () => {
    expect(admit(nativeBody, "fs.read", pub)).toBeNull();
    expect(admit(nativeBody, "web.searchRaw", hidden)).toBeNull();
  });

  test("没注册的：可重试的内核拒绝", () => {
    expect(admit(nativeBody, "fs.raed", undefined)).toEqual({
      ok: false,
      by: "kernel",
      reason: "unknown operation: fs.raed",
      retryable: true,
    });
  });

  test("不在发起方能力面里：不可重试", () => {
    expect(admit(nativeBody, "python.run", pub)).toEqual({
      ok: false,
      by: "kernel",
      reason: "python.run is not in the capability surface of web.search",
      retryable: false,
    });
  });

  test("外侧调不公开的，与不存在同样回答", () => {
    expect(admit(scriptBody, "web.searchRaw", hidden)).toEqual(admit(scriptBody, "web.searchRaw", undefined));
    expect(admit({ kind: "decorator", form: "script" }, "web.searchRaw", hidden)?.reason).toBe(
      "unknown operation: web.searchRaw",
    );
  });

  test("装饰器与处理器不查被装饰 Run 的能力面：内侧的不查，外侧的只查公开表", () => {
    expect(admit({ kind: "decorator", form: "native" }, "python.run", hidden)).toBeNull();
    expect(admit({ kind: "handler", form: "native" }, "python.run", hidden)).toBeNull();
    expect(admit({ kind: "decorator", form: "script" }, "python.run", pub)).toBeNull();
    expect(admit({ kind: "handler", form: "script" }, "python.run", pub)).toBeNull();
  });
});
