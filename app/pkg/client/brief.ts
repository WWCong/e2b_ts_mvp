/**
 * 终端界面画 Run 树时，stdlib 自带插件的 Operation 的入参、出参怎么摘要：kv 里存的对话历史只给条数；
 * harness_park 的入参只看 payload（要问的问题）；harness_exec 的入参只看脚本有几行。
 * 应用的 brief 先摘自己的 Operation，别的交给它。只影响显示；返回 undefined 用缺省的截断 JSON
 */

import type { Brief } from "./console";
import { short } from "./console/tree";

export const stdlibBrief: Brief = (operation, side, value) => {
  switch (`${operation} ${side}`) {
    case "harness_park input":
      return short((value as { payload: unknown }).payload);
    case "harness_exec input":
      return `(${(value as { source: string }).source.trim().split("\n").length} 行脚本)`;
    case "kv_get input":
      return (value as { key: string }).key;
    case "kv_get output":
      return Array.isArray(value) ? `→ (${value.length} 条消息)` : undefined;
    case "kv_set input": {
      const { key, value: stored } = value as { key: string; value: unknown };
      return Array.isArray(stored) ? `${key} (${stored.length} 条消息)` : undefined;
    }
  }
};
