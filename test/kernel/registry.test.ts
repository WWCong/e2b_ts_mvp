import { describe, expect, test } from "bun:test";
import { Registry, RegistryError, type RegistryInput } from "../../src/kernel/registry.ts";
import { deco, on, op, pkg } from "./helpers.ts";

const read = async (input: { path: string }) => ({ text: input.path });

/** 一份接近真实装配的包集合 */
function packages() {
  return [
    pkg("harness", { operations: [op("park", { public: true })] }),
    pkg("fs", {
      version: "2.1.0",
      operations: [
        op("read", { public: true, decorators: ["fs.pathGuard"], limits: { bytes: 1024 } }),
        op("write", { public: true, decorators: ["fs.pathGuard"] }),
        op("delete", { public: true }),
      ],
      decorators: [deco("fs.pathGuard")],
      module: { read },
    }),
    pkg("web", {
      operations: [op("search", { public: true, only: ["web.searchRaw", "model"] }), op("searchRaw")],
    }),
    pkg("model", { operations: [op("complete", { public: true })] }),
    pkg("safety", { decorators: [deco("safety")] }),
    pkg("budget", { decorators: [deco("budget")] }),
    pkg("memory", {
      operations: [op("save", { public: true })],
      decorators: [deco("memory.recall", { public: true, onError: "open" })],
      handlers: [on("run.exited", "curateLater")],
    }),
    pkg("agent", {
      form: "script",
      operations: [op("assist", { decorators: ["memory.recall"], exclude: ["fs.delete"] })],
      handlers: [on("park.opened", "notify")],
    }),
    pkg("video-analysis", {
      form: "script",
      operations: [op("completionScore", { only: ["fs.read", "model"] })],
    }),
  ];
}

function build(extra: Partial<RegistryInput> = {}) {
  return Registry.build({ packages: packages(), defaultDecorators: ["safety", "budget"], ...extra });
}

function issuesOf(input: RegistryInput): readonly string[] {
  try {
    Registry.build(input);
  } catch (e) {
    expect(e).toBeInstanceOf(RegistryError);
    return (e as RegistryError).issues;
  }
  throw new Error("expected RegistryError");
}

describe("注册", () => {
  test("Operation 名为 包名.导出名，带上来源与版本", () => {
    const r = build();
    const entry = r.operation("fs.read")!;
    expect(entry.name).toBe("fs.read");
    expect(entry.package).toBe("fs");
    expect(entry.version).toBe("2.1.0");
    expect(entry.form).toBe("native");
    expect(entry.public).toBe(true);
    expect(entry.usage).toBe("read usage");
    expect(entry.limits).toEqual({ bytes: 1024 });
    expect(entry.fn).toBe(read);
    expect(r.operation("agent.assist")!.form).toBe("script");
    expect(r.operation("nope.nope")).toBeUndefined();
  });

  test("按包的装载顺序列出", () => {
    expect(build().operations.map((o) => o.name)).toEqual([
      "harness.park",
      "fs.read",
      "fs.write",
      "fs.delete",
      "web.search",
      "web.searchRaw",
      "model.complete",
      "memory.save",
      "agent.assist",
      "video-analysis.completionScore",
    ]);
  });

  test("停用的不注册，也不出现在任何能力面里", () => {
    const r = build({ disable: ["fs.write", "fs.delete"] });
    expect(r.operation("fs.write")).toBeUndefined();
    expect(r.disabled).toEqual(["fs.write", "fs.delete"]);
    for (const o of r.operations) {
      expect(o.surface.has("fs.write")).toBe(false);
    }
  });

  test("条目冻结", () => {
    const entry = build().operation("fs.read")!;
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.chain)).toBe(true);
    expect(Object.isFrozen(entry.limits)).toBe(true);
  });

  test("清单在建表时定格，之后改原清单不影响", () => {
    const sources = packages();
    const r = Registry.build({ packages: sources });
    sources[1]!.manifest.operations[0]!.limits = { bytes: 1 };
    expect(r.operation("fs.read")!.limits).toEqual({ bytes: 1024 });
  });
});

describe("能力面", () => {
  test("native 缺省能调全部 Operation，含不公开的", () => {
    const r = build();
    const s = r.operation("fs.read")!.surface;
    expect(s.size).toBe(r.operations.length);
    expect(s.has("web.searchRaw")).toBe(true);
    expect(s.has("agent.assist")).toBe(true);
  });

  test("script 缺省只能调公开表，含其他 script 包导出的", () => {
    const r = build();
    const s = r.operation("agent.assist")!.surface;
    expect(s.has("web.searchRaw")).toBe(false);
    expect(s.has("video-analysis.completionScore")).toBe(true);
    expect(s.has("fs.delete")).toBe(false); // @exclude
    expect(s.has("fs.read")).toBe(true);
  });

  test("收窄：包名与 Operation 名", () => {
    const r = build();
    expect(r.operation("web.search")!.surface.names).toEqual(["model.complete", "web.searchRaw"]);
    expect(r.operation("video-analysis.completionScore")!.surface.names).toEqual(["fs.read", "model.complete"]);
  });

  test("没有收窄的同形态 Operation 共用一份", () => {
    const r = build();
    expect(r.operation("fs.read")!.surface).toBe(r.operation("model.complete")!.surface);
  });

  test("收窄点名的 Operation 被停用了，只是不在能力面里", () => {
    const r = build({ disable: ["web.searchRaw"] });
    expect(r.operation("web.search")!.surface.names).toEqual(["model.complete"]);
  });
});

describe("链序", () => {
  test("默认装饰器在外，自选在内", () => {
    const r = build();
    expect(r.operation("fs.read")!.chain.map((d) => d.id)).toEqual(["safety", "budget", "fs.pathGuard"]);
    expect(r.operation("agent.assist")!.chain.map((d) => d.id)).toEqual(["safety", "budget", "memory.recall"]);
    expect(r.operation("model.complete")!.chain.map((d) => d.id)).toEqual(["safety", "budget"]);
  });

  test("自选里与默认集重复的沿用默认集的位置", () => {
    const r = build({ defaultDecorators: ["safety", "fs.pathGuard"] });
    expect(r.operation("fs.read")!.chain.map((d) => d.id)).toEqual(["safety", "fs.pathGuard"]);
  });

  test("装饰器条目", () => {
    const d = build().decorator("memory.recall")!;
    expect(d.package).toBe("memory");
    expect(d.form).toBe("native");
    expect(d.public).toBe(true);
    expect(d.onError).toBe("open");
    expect(typeof d.fn).toBe("function");
  });
});

describe("处理器与挂点", () => {
  test("按挂点取处理器", () => {
    const r = build();
    expect(r.handlers("run.exited").map((h) => `${h.package}.${h.export}`)).toEqual(["memory.curateLater"]);
    expect(r.handlers("park.opened")[0]!.form).toBe("script");
    expect(r.handlers("run.killed")).toEqual([]);
  });

  test("通知公开，生命周期挂点不公开，自定义挂点按声明", () => {
    const r = build({ hooks: [{ name: "memory.beforeSave", public: true }, { name: "fs.internal", public: false }] });
    expect(r.hook("run.exited")!.public).toBe(true);
    expect(r.hook("harness.stopping")!.public).toBe(false);
    expect(r.hook("run.cancelling")!.public).toBe(false);
    expect(r.hook("memory.beforeSave")!.public).toBe(true);
    expect(r.hook("fs.internal")!.public).toBe(false);
  });

  test("native 处理器可以挂生命周期挂点", () => {
    const r = Registry.build({ packages: [pkg("delivery", { handlers: [on("harness.stopping", "flush")] })] });
    expect(r.handlers("harness.stopping")).toHaveLength(1);
  });
});

describe("公开表与 dump", () => {
  test("公开表只含公开的 Operation、装饰器与挂点", () => {
    const t = build({ hooks: [{ name: "memory.beforeSave", public: true }] }).publicTable();
    expect(t.operations).toEqual([
      "agent.assist",
      "fs.delete",
      "fs.read",
      "fs.write",
      "harness.park",
      "memory.save",
      "model.complete",
      "video-analysis.completionScore",
      "web.search",
    ]);
    expect(t.decorators).toEqual(["memory.recall"]);
    expect(t.hooks).toContain("memory.beforeSave");
    expect(t.hooks).toContain("run.exited");
    expect(t.hooks).not.toContain("harness.stopping");
  });

  test("dump 列出每个 Operation 的能力面、说明、链序、来源与版本，可序列化", () => {
    const d = build({ disable: ["fs.delete"], hooks: [{ name: "memory.beforeSave", public: true }] }).dump();
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
    expect(d.defaultDecorators).toEqual(["safety", "budget"]);
    expect(d.disabled).toEqual(["fs.delete"]);
    expect(d.operations.find((o) => o.name === "web.search")).toEqual({
      name: "web.search",
      package: "web",
      version: "1.0.0",
      form: "native",
      public: true,
      usage: "search usage",
      limits: {},
      surface: ["model.complete", "web.searchRaw"],
      chain: ["safety", "budget"],
    });
    expect(d.handlers).toEqual([
      { on: "run.exited", package: "memory", export: "curateLater", form: "native" },
      { on: "park.opened", package: "agent", export: "notify", form: "script" },
    ]);
    expect(d.hooks).toEqual([{ name: "memory.beforeSave", public: true }]);
  });
});

describe("建表检查", () => {
  test("包名与导出", () => {
    const issues = issuesOf({
      packages: [
        pkg("a.b"),
        pkg("fs", { operations: [op("read")] }),
        pkg("fs"),
        pkg("x", { operations: [op("missing")], module: { missing: undefined } }),
        pkg("y", { operations: [op("dup"), op("dup")] }),
        pkg("z", { operations: [op("bad-name")] }),
      ],
    });
    expect(issues).toEqual([
      'package "a.b": name must match /^[A-Za-z0-9_-]+$/',
      "package fs: loaded twice",
      "package x: operation export missing is not a function",
      "package y: export dup is declared more than once",
      'package z: operation export "bad-name" is not an identifier',
    ]);
  });

  test("script 包的导出必须公开", () => {
    const source = pkg("s", { form: "script", operations: [op("run")], decorators: [deco("s.wrap")] });
    source.manifest.operations[0]!.public = false;
    source.manifest.decorators[0]!.public = false;
    expect(issuesOf({ packages: [source] })).toEqual([
      "operation s.run: script package exports are always public",
      "decorator s.wrap: script package exports are always public",
    ]);
  });

  test("装饰器 id 必须归属本包且全局唯一，不与 Operation 同名", () => {
    const issues = issuesOf({
      packages: [
        pkg("a", { operations: [op("guard")], decorators: [deco("b.x"), deco("a.guard", { export: "g" })] }),
        pkg("b", { decorators: [deco("b"), deco("b", { export: "again" })] }),
      ],
    });
    expect(issues).toEqual([
      'decorator b.x in package a: id must be "a" or "a.<identifier>"',
      "decorator b: registered twice",
      "decorator a.guard: id collides with an operation name",
    ]);
  });

  test("停用项与默认装饰器", () => {
    const issues = issuesOf({
      packages: [...packages(), pkg("s", { form: "script", decorators: [deco("s.wrap")] })],
      disable: ["fs.nope"],
      defaultDecorators: ["safety", "nope", "s.wrap", "safety"],
    });
    expect(issues).toEqual([
      "disable: unknown operation fs.nope",
      "defaultDecorators: unknown decorator nope",
      "defaultDecorators: s.wrap is from a script package",
      "defaultDecorators: safety listed twice",
    ]);
  });

  test("@only / @exclude 点名的对象存在；script 包点名的还要公开", () => {
    const issues = issuesOf({
      packages: [
        pkg("web", { operations: [op("searchRaw")] }),
        pkg("n", { operations: [op("run", { only: ["ghost", "web.ghost"], exclude: ["web"] })] }),
        pkg("s", { form: "script", operations: [op("run", { only: ["web.searchRaw"], exclude: ["web"] })] }),
      ],
    });
    expect(issues).toEqual([
      "operation n.run: @only ghost names no package",
      "operation n.run: @only web.ghost names no operation",
      "operation s.run: @only web.searchRaw is not public",
      "operation s.run: @exclude web has no public operation",
    ]);
  });

  test("自选装饰器：native 只能引用内侧的，script 只能引用公开的", () => {
    const issues = issuesOf({
      packages: [
        pkg("guard", { decorators: [deco("guard.hidden"), deco("guard.shared", { public: true })] }),
        pkg("s", {
          form: "script",
          operations: [op("ok", { decorators: ["guard.shared", "s.wrap"] }), op("bad", { decorators: ["guard.hidden"] })],
          decorators: [deco("s.wrap")],
        }),
        pkg("n", { operations: [op("run", { decorators: ["s.wrap", "nope", "guard.hidden", "guard.hidden"] })] }),
      ],
    });
    expect(issues).toEqual([
      "operation s.bad: @decorators guard.hidden names no public decorator",
      "operation n.run: @decorators s.wrap is from a script package; native operations can only use native decorators",
      "operation n.run: @decorators nope names no decorator",
      "operation n.run: @decorators guard.hidden listed twice",
    ]);
  });

  test("处理器挂在存在的挂点上；script 包只能挂公开的", () => {
    const issues = issuesOf({
      packages: [
        pkg("n", { handlers: [on("nope", "h")] }),
        pkg("s", { form: "script", handlers: [on("harness.stopping", "h1"), on("fs.internal", "h2")] }),
      ],
      hooks: [{ name: "fs.internal", public: false }, { name: "run.exited", public: true }],
    });
    expect(issues).toEqual([
      "hook run.exited: defined twice or shadows a built-in hook",
      "handler n.h: @on nope names no hook",
      "handler s.h1: @on harness.stopping names no public hook",
      "handler s.h2: @on fs.internal names no public hook",
    ]);
  });
});
