/**
 * 能力面：一个 Run 能调用的 Operation 集合（4.1）。
 * 由被调 Operation 自己的声明静态决定，不继承调用方；收窄只省 token、收敛模型行为，不承担安全职责。
 */

/** 项是 Operation 名（fs.read）或包名（fs）。都不写即全开 */
export type Surface = { only?: string[]; exclude?: string[] };

/** 先 only 收窄到所列，再 exclude 去掉所列 */
export function inSurface(surface: Surface, target: string): boolean {
  const pkg = target.slice(0, target.indexOf("."));
  const hit = (list: string[]) => list.includes(target) || list.includes(pkg);
  if (surface.only && !hit(surface.only)) return false;
  return !(surface.exclude && hit(surface.exclude));
}
