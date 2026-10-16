/** 测试用应用：一个入口 probe；用法 bun main.ts <mode> <journalDir> */

import { join } from "node:path";
import { host } from "../../host";

const [mode, journalDir] = process.argv.slice(2);
await host({ journalDir, graceMs: 5000, plugins: [[join(import.meta.dir, "probe"), { mode }]] });
