/** 测试用：入参转不成 JSON Schema */
import { op, script } from "stdlib";
import { z } from "zod";

export default script({ operations: { at: op({ usage: "时间", input: z.object({ at: z.date() }), impl: async () => null }) } });
