/** 测试用 script 包：道别 */

import { z } from "zod";
import { op, script } from "stdlib";

export default script({
  operations: {
    bye: op({
      usage: "替人道别",
      input: z.object({ name: z.string() }),
      impl: async (_ctx, input) => `再见，${input.name}`,
    }),
  },
});
