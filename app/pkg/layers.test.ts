import { expect, test } from "bun:test";
import { violations } from "./layers";

test("认得出违规的写法", () => {
  expect(violations('import { readFile } from "node:fs/promises";')).toEqual(["imports node:fs/promises"]);
  expect(violations('import { spawn } from "child_process";')).toEqual(["imports child_process"]);
  expect(violations('import { createModels } from "@earendil-works/pi-ai";')).toEqual(["imports @earendil-works/pi-ai at runtime"]);
  expect(violations('import type { Message } from "@earendil-works/pi-ai";')).toEqual([]);
  expect(violations("const key = process.env.KEY;")).toEqual(["uses \\bprocess\\.env\\b"]);
  expect(violations('await import("node:fs");')).toEqual(["loads node:fs dynamically"]);
  expect(violations('import { posix } from "node:path";\nimport { op } from "stdlib";')).toEqual([]);
});
