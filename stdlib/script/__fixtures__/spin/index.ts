/** 测试用：死循环、吃内存 */
import { op, script } from "stdlib";
import { z } from "zod";

export default script({
  operations: {
    loop: op({
      usage: "转",
      input: z.null(),
      impl: async () => {
        for (;;);
      },
    }),
    hog: op({
      usage: "吃",
      input: z.null(),
      impl: async () => {
        const chunks: string[] = [];
        for (let i = 0; i < 1e6; i++) chunks.push("x".repeat(1 << 26) + i);
        return chunks.length;
      },
    }),
  },
});
