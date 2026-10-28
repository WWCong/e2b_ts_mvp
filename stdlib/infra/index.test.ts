import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel } from "../kernel/kernel";
import { loadPlugin } from "../kernel/loader";
import { grant, journalDir, type Infra } from ".";
import { localDir } from "./volume";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "infra-"));
});

describe("基建的注入", () => {
  test("插件只拿到它声明需要的：store 是持久状态里属于它的那一块", async () => {
    const infra: Infra = { state: localDir(root), workspace: localDir(join(root, "ws")) };
    let got: Record<string, unknown> = {};
    await loadPlugin(new Kernel(), join(import.meta.dir, "..", "kernel", "__fixtures__", "keeper"), { got: (i: object) => (got = { ...i }) }, infra);

    expect(Object.keys(got)).toEqual(["store"]);
    expect((got.store as { localPath: string }).localPath).toBe(join(root, "store", "keeper"));
  });

  test("各插件的 store 互相看不到，也碰不到写前日志", async () => {
    const state = localDir(root);
    const a = grant("a", ["store"], { state }).store!;
    const b = grant("b", ["store"], { state }).store!;

    await a.write("x.json", "a 的");
    expect(await b.stat("x.json")).toBeUndefined();
    expect(b.read("../a/x.json")).rejects.toThrow("path escapes the volume");
    expect(a.read("../../journal/t.jsonl")).rejects.toThrow("path escapes the volume");
  });

  test("装配没提供插件需要的：装载失败；不认得的需要也失败", async () => {
    await expect(loadPlugin(new Kernel(), join(import.meta.dir, "..", "kernel", "__fixtures__", "keeper"))).rejects.toThrow(
      "keeper needs store (from state), which the assembly does not provide",
    );
    expect(() => grant("x", ["llm"], {})).toThrow("x needs llm, which the assembly does not provide");
    expect(() => grant("x", ["disk"], {})).toThrow("x: unknown need: disk");
  });

  test("wants 里的有就给，没有也不失败", () => {
    const workspace = localDir(join(root, "ws"));
    expect(grant("x", [], { workspace }, ["workspace"])).toEqual({ workspace });
    expect(grant("x", [], {}, ["workspace", "store"])).toEqual({});
  });

  test("写前日志在 state 的 journal/，要求本地路径", () => {
    expect(journalDir(localDir(root))).toBe(join(root, "journal"));
    expect(journalDir(undefined)).toBeUndefined();
    const { localPath: _, ...remote } = localDir(root);
    const noLocal = { ...remote, name: "remote:x", sub: () => ({ ...remote, name: "remote:x/journal" }) };
    expect(() => journalDir(noLocal)).toThrow("state (remote:x) has no local path: the journal writes synchronously and needs one");
  });
});
