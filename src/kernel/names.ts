/**
 * 命名规则：Operation 名是「包名_导出名」，原样就是模型的工具名（模型只接受字母、数字、_ 和 -，最长 64），
 * 事件、历史与日志里处处同名。包名只含小写字母、数字与 -，导出名只含字母与数字，所以名字里恰好一个 _，就是分隔符。
 */

const PACKAGE = /^[a-z][a-z0-9-]*$/;
const EXPORT = /^[a-zA-Z][a-zA-Z0-9]*$/;
const MAX_LENGTH = 64;

/** 插件的包名；harness 留给内核自带的 Operation（如 harness_park） */
export function checkPackageName(pkg: string): void {
  if (!PACKAGE.test(pkg)) throw new Error(`invalid package name: ${pkg} (lowercase letters, digits and -)`);
  if (pkg === "harness") throw new Error("package name harness is reserved for the kernel");
}

export function checkName(name: string): void {
  const [pkg = "", exp = "", ...rest] = name.split("_");
  if (rest.length > 0 || !PACKAGE.test(pkg) || !EXPORT.test(exp) || name.length > MAX_LENGTH) {
    throw new Error(`invalid name: ${name} (<package>_<export>, at most ${MAX_LENGTH} chars)`);
  }
}

export function packageOf(name: string): string {
  return name.slice(0, name.indexOf("_"));
}
