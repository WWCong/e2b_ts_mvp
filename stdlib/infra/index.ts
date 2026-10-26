/**
 * 基建层：Harness 外面提供的能力，在装配配置的 infra 里建好，宿主管启停（host.ts），
 * 插件在 plugin({ needs }) 里声明需要哪些，装载时注入（loader.ts）。插件不自己读环境变量、不直接做 IO。
 * - llm：模型后端（llm.ts）
 * - workspace：工作区，模型的工具读写的文件（volume.ts）
 * - state：持久状态，宿主切成互不相干的几块：内核的写前日志在 journal/（要求有 localPath，日志同步落盘）；
 *   每个插件的存储在 store/<包名>/，插件声明 store 拿到的就是自己那块，看不到别的插件的，也碰不到日志
 * 换实现（如 workspace 换成 rclone+FUSE 挂载）只改装配配置，插件不动。
 */

import type { Llm } from "./llm";
import type { Volume } from "./volume";

export type { Llm } from "./llm";
export type { Stat, Volume } from "./volume";

/** 装配配置里的基建 */
export type Infra = { llm?: Llm; workspace?: Volume; state?: Volume };

/** 插件能声明需要的基建，与它拿到的东西 */
export type Granted = { llm: Llm; workspace: Volume; store: Volume };
export type Need = keyof Granted;

/** 按插件声明的需要从装配的基建里取；装配没提供的，装载失败 */
export function grant(pkg: string, needs: readonly string[], infra: Infra): Partial<Granted> {
  const granted: Partial<Granted> = {};
  const missing = (what: string) => new Error(`${pkg} needs ${what}, which the assembly does not provide`);
  for (const need of needs) {
    if (need === "store") {
      if (!infra.state) throw missing("store (from state)");
      granted.store = infra.state.sub(`store/${pkg}`);
    } else if (need === "llm" || need === "workspace") {
      const it = infra[need];
      if (!it) throw missing(need);
      Object.assign(granted, { [need]: it });
    } else {
      throw new Error(`${pkg}: unknown need: ${need}`);
    }
  }
  return granted;
}

/** 内核写前日志的目录：state 里的 journal/，必须在本地文件系统上（同步写、fsync） */
export function journalDir(state: Volume | undefined): string | undefined {
  if (!state) return undefined;
  const dir = state.sub("journal").localPath;
  if (!dir) throw new Error(`state (${state.name}) has no local path: the journal writes synchronously and needs one`);
  return dir;
}
