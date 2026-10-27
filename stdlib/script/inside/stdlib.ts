/**
 * 解释器里的 stdlib：script 包 import "stdlib" 拿到的只有这些（类型照旧来自 stdlib 的入口）。
 * 别的（host、Kernel、loadPlugin…）不在这里，script 包 import 了打包即失败。
 */

export { op, opaque, script } from "../../kernel/plugin";
export { image, isToolContent } from "../../content";
