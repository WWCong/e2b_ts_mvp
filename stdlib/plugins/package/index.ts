/**
 * package 插件：把工作区里试好的 script 包草稿（harness_exec 试跑，见 harness 插件）装进运行中的 Harness。
 * 装之前问人（ui_approval）；装上的在持久状态的 scripts/ 下，重启后还在。装进内核用的是宿主给的 scripts（见 stdlib/infra）。
 */

import { basename, join } from "node:path";
import { z } from "zod";
import { op, plugin } from "stdlib";

export default plugin({ needs: ["scripts", "workspace"] }, (_config, { scripts, workspace }) => ({
  requires: ["ui"],
  operations: {
    install: op({
      usage:
        "把工作区里试好的 script 包草稿装进运行中的 Harness（会先问用户）：装上后就能按「包名_键名」调它的 Operation，重启后还在；" +
        "已装上的同名包会被换掉。dir 是草稿目录，name 是包名（小写字母、数字与 -，缺省取目录名）。返回装上的 Operation 名",
      public: true,
      decorators: ["ui_approval"],
      input: z.object({ dir: z.string(), name: z.string().optional() }),
      output: z.array(z.string()),
      impl: async (_ctx, { dir, name }) => {
        if ((await workspace.stat(join(dir, "index.ts")))?.kind !== "file") throw new Error(`no ${join(dir, "index.ts")} in the workspace`);
        return scripts.install(name ?? basename(dir), workspace.sub(dir));
      },
    }),
  },
}));
