/** 测试用：import 包外的文件 */
import { twice } from "../probe/twice";
import { op, script } from "stdlib";
import { z } from "zod";

export default script({ operations: { go: op({ usage: "走", input: z.null(), impl: async () => twice("a", 2) }) } });
