import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localDir } from "./volume";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "volume-"));
});

const text = (data: Uint8Array) => new TextDecoder().decode(data);

describe("localDir", () => {
  test("open 建好目录；localPath 是它的绝对路径", async () => {
    const dir = join(root, "not", "yet");
    const volume = localDir(dir);
    expect(existsSync(dir)).toBe(false);

    await volume.open();
    expect(existsSync(dir)).toBe(true);
    expect(volume.localPath).toBe(dir);
  });

  test("写：父目录自动建，整个替换，不留临时文件；读、stat、list、mkdir", async () => {
    const volume = localDir(root);

    await volume.write("a/b/c.txt", "一");
    await volume.write("a/b/c.txt", new TextEncoder().encode("二"));
    expect(text(await volume.read("a/b/c.txt"))).toBe("二");
    expect(await readdir(join(root, "a/b"))).toEqual(["c.txt"]);
    expect(await volume.stat("a/b/c.txt")).toMatchObject({ kind: "file", size: 3 });
    expect(await volume.stat("a")).toMatchObject({ kind: "dir" });
    expect(await volume.stat("nope")).toBeUndefined();
    await volume.mkdir("d/e");
    expect((await volume.list(".")).sort()).toEqual(["a", "d"]);
  });

  test("glob：在 dir 下找文件，路径相对 dir；ignore 跳过，limit 封顶", async () => {
    const volume = localDir(root);
    for (const path of ["src/a.ts", "src/b.ts", "src/gen/c.ts", "readme.md"]) await volume.write(path, "");

    expect((await volume.glob("**/*.ts")).sort()).toEqual(["src/a.ts", "src/b.ts", "src/gen/c.ts"]);
    expect((await volume.glob("**/*.ts", { dir: "src", ignore: ["gen/**"] })).sort()).toEqual(["a.ts", "b.ts"]);
    expect(await volume.glob("**/*", { limit: 1 })).toHaveLength(1);
  });

  test("越不出去：.. 与绝对路径拒绝；符号链接指向外面也拒绝；出错信息里是相对路径", async () => {
    const outside = await mkdtemp(join(tmpdir(), "volume-outside-"));
    await writeFile(join(outside, "secret"), "机密");
    await symlink(outside, join(root, "link"));
    const volume = localDir(root);

    for (const path of ["../x", "a/../../x", "/etc/passwd"]) {
      expect(volume.read(path)).rejects.toThrow(`path escapes the volume: ${path}`);
    }
    expect(volume.read("link/secret")).rejects.toThrow("path escapes the volume via symlink: link/secret");
    expect(volume.write("link/new", "x")).rejects.toThrow("path escapes the volume via symlink: link/new");
    const missing = await volume.read("dir/missing").catch((err: Error) => err.message);
    expect(missing).toBe("ENOENT: dir/missing");
  });

  test("sub：子目录当作一块独立的存储，越不出它；还不存在也能用，写的时候建出来", async () => {
    const volume = localDir(root);
    const store = volume.sub("store/chat");

    expect(await store.stat("x.json")).toBeUndefined();
    await store.write("x.json", "{}");
    expect(text(await volume.read("store/chat/x.json"))).toBe("{}");
    expect(store.localPath).toBe(join(root, "store/chat"));
    expect(store.read("../other/x.json")).rejects.toThrow("path escapes the volume");
    expect(() => volume.sub("../elsewhere")).toThrow("path escapes the volume: ../elsewhere");
  });
});
