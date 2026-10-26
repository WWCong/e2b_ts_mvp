/**
 * 测试用入口：serve 先报出认领到几棵恢复的树，再按 mode 行事：
 * leave 直接结束服务；park 调 probe_wait 停在 park 上；busy 调 probe_busy 一直在执行。关停时打印 stopped
 */

import { z } from "zod";
import { entry } from "../../../kernel/entry";
import { op } from "../../../kernel/plugin";

export default entry((config: { mode: "leave" | "park" | "busy" }, outside) => ({
  operations: {
    wait: op({
      api: true,
      usage: "停在 park 上",
      input: z.null(),
      output: z.unknown(),
      impl: (ctx) => ctx.park({ schema: z.toJSONSchema(z.string()), payload: "等" }),
    }),
    busy: op({ api: true, usage: "一直在执行", input: z.null(), output: z.unknown(), impl: () => new Promise(() => console.log("busy")) }),
  },
  afterParkOpen() {
    console.log("parked");
  },
  async serve() {
    console.log(`serving, recovered ${outside.recovered().length}`);
    if (config.mode === "park") await outside.reap(outside.submit("probe_wait", null));
    if (config.mode === "busy") await outside.reap(outside.submit("probe_busy", null));
  },
  onStop() {
    console.log("stopped");
  },
}));
