/**
 * kv 插件：按包分开的键值存储。script 包（应用层）拿不到基建，要存状态就调它。
 * 每个包只读写自己的：按调用方所在的包（ctx.callerPackage）分开，存在 kv 自己那块持久存储下的 <包名>/<键>.json，
 * 一个键一个文件，值是 JSON，整个替换（不留半截）。公开（script 能调），不交给模型当工具。
 * 方案里 store 是服务、按消费方隔离（6.3）；这里写成按调用方分开的 Operation。
 */

import { z } from "zod";
import { op, plugin, type Ctx } from "stdlib";

const key = z.string().regex(/^[\w-]+$/, "key: letters, digits, _ and -");

export default plugin({ needs: ["store"] }, (_config, { store }) => {
  const file = (ctx: Ctx, key: string) => {
    if (!ctx.callerPackage) throw new Error("kv keeps data per calling package: call it from an operation");
    return `${ctx.callerPackage}/${key}.json`;
  };

  return {
    operations: {
      get: op({
        usage: "读调用方这个包的一个键，返回它的值（JSON）；没存过返回 null",
        public: true,
        tool: false,
        input: z.object({ key }),
        impl: async (ctx, input): Promise<unknown> => {
          const path = file(ctx, input.key);
          return (await store.stat(path)) ? JSON.parse(new TextDecoder().decode(await store.read(path))) : null;
        },
      }),

      set: op({
        usage: "把调用方这个包的一个键整个替换成给的值（JSON）",
        public: true,
        tool: false,
        input: z.object({ key, value: z.unknown() }),
        impl: async (ctx, input): Promise<void> => store.write(file(ctx, input.key), JSON.stringify(input.value)),
      }),
    },
  };
});
