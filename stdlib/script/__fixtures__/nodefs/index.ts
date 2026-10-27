/** 测试用：import Node 的模块 */
import { readFileSync } from "node:fs";
import { op, script } from "stdlib";
import { z } from "zod";

export default script({ operations: { read: op({ usage: "读", input: z.null(), impl: async () => readFileSync("/etc/hostname", "utf8") }) } });
