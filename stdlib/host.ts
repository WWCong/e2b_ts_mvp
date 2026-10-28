/**
 * 宿主：一个进程里跑一个 Harness。只有它握着内核。装配配置分四块，对应四层：
 * infra（基建：Harness 外面给的能力）、plugins（领域：插件）、scripts（应用：编排，script 包）、
 * serve（接口：哪些 Operation 怎么对外）。
 * 启动：先占住服务接口要监听的地址，打开基建（建目录、挂载…），建内核（写前日志在 state 的 journal/），
 * 按顺序装载插件、注入它们声明需要的基建，再装载 script 包，启动（恢复上次没做完的树），最后服务接口开始监听，
 * 每个服务接口只提供它 expose 里列的 Operation。装配配置 watch 时，script 包改了运行中重新装载（插件改了要重启）。
 * 启停是机器的信号，只在这里处理：收到 SIGINT / SIGTERM 就优雅关停——先停止接新请求，再等在途的调用跑完
 * （最多 graceMs），关停中再收到一次就强杀，内核关停完断开连接、关掉基建（落盘、卸载…），退出进程。进度都在写前日志里，再启动接着做。
 * 后续加入：约定一个退出码表示要重启（harness_restart），由外层重新拉起进程。
 */

import { watch, type FSWatcher } from "node:fs";
import { basename } from "node:path";
import { journalDir, type Infra } from "./infra";
import type { Volume } from "./infra/volume";
import { Kernel, type KernelConfig } from "./kernel/kernel";
import { loadPlugin, loadScript } from "./kernel/loader";
import { packageOf } from "./kernel/names";
import type { ApiName } from "./kernel/ops";
import { compileScript } from "./script/sandbox";
import { httpService, type HttpConfig } from "./serve/http";
import type { Service } from "./serve/service";

/** 装配配置（附 A）：内核的配置，加上基建、装哪些插件与 script 包、开哪些服务接口。写前日志的位置由基建的 state 决定 */
export type Assembly = Omit<KernelConfig, "journalDir"> & {
  /** 基建：Harness 外面给的能力（stdlib/infra）。插件只拿得到它声明需要、这里又给了的 */
  infra?: Infra;
  /** 领域：插件，按顺序装载（同级插件按这个顺序排先后），插件包目录，或 [目录, 配置] */
  plugins: (string | [dir: string, config: unknown])[];
  /** 应用：script 包目录，在插件之后装载。只能调公开的 Operation，没有配置、不注入基建 */
  scripts?: string[];
  /**
   * 对外的服务接口：开哪些、各自监听在哪、对外哪些 Operation（expose）。
   * expose 只能填声明了 api 的（注册表推出，写错类型检查即报错；启动前再查一遍），不在里面的不对外
   */
  serve?: { http?: Omit<HttpConfig, "expose"> & { expose: ApiName[] } };
  /** 优雅关停时最多等在途的调用多久，缺省 10 秒 */
  graceMs?: number;
  /** 盯着 scripts 的目录：改了就重新装载，不用重启（开发时用）。正在跑的 Run 用旧的跑完 */
  watch?: boolean;
};

export async function host(assembly: Assembly): Promise<never> {
  const { plugins, scripts = [], infra = {}, serve = {}, graceMs = 10_000, watch: watching = false, ...config } = assembly;
  // 先占住服务接口要监听的地址：被占了（同一个状态目录已有 Harness 在跑）就不往下启动，不碰日志
  const services: Service[] = [];
  if (serve.http) services.push(await httpService(serve.http));

  const volumes = [infra.workspace, infra.state].filter((v): v is Volume => v !== undefined);
  for (const volume of volumes) await volume.open();

  const kernel = new Kernel({ ...config, journalDir: journalDir(infra.state) });
  for (const item of plugins) {
    const [dir, pluginConfig] = typeof item === "string" ? [item, undefined] : item;
    await loadPlugin(kernel, dir, pluginConfig, infra);
  }
  for (const dir of scripts) await loadScript(kernel, dir);
  // 对外哪些是装配的决定：列的不是 api 的，启动失败
  const apis = new Set(kernel.operationsApi().map((o) => o.name));
  for (const [name, config] of Object.entries(serve)) {
    for (const op of config.expose) if (!apis.has(op)) throw new Error(`serve.${name} exposes ${op}, which is not an api operation`);
  }
  await kernel.boot();
  for (const [i, service] of services.entries()) {
    service.listen({ outside: (origin) => kernel.outside(origin), subscribe: (fn) => kernel.events.subscribe(fn) });
    console.log(`harness 在 ${service.address} 上服务，对外：${Object.values(serve)[i]!.expose.join("、") || "（无）"}`);
  }
  const exposed: string[] = Object.values(serve).flatMap((s) => s.expose);
  const watchers = watching ? scripts.map((dir) => watchScript(kernel, dir, exposed)) : [];

  let stopped: Promise<void> | undefined;
  const halted = Promise.withResolvers<void>();
  const stop = () => {
    if (!stopped) for (const service of services) service.stop(false);
    stopped = kernel.stop(stopped ? 0 : graceMs);
    halted.resolve();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await halted.promise;
  for (const watcher of watchers) watcher.close();
  await stopped;
  for (const service of services) service.stop(true);
  for (const volume of volumes.reverse()) await volume.close();
  // 模型客户端等可能还留着连接，显式退出
  process.exit(0);
}

/**
 * 盯着一个 script 包的目录：文件变了，等一会儿（一次保存常有几个改动）重新打包、读声明，换进内核（replaceScript）。
 * 新的有问题（写错了、对外的 Operation 不再是 api 的等），旧的照旧。结果打在标准错误上
 */
function watchScript(kernel: Kernel, dir: string, exposed: string[]): FSWatcher {
  const pkg = basename(dir);
  const reload = async () => {
    try {
      const script = await compileScript(pkg, dir);
      const apis = Object.entries(script.operations).flatMap(([key, op]) => (op.api ? [`${pkg}_${key}`] : []));
      const lost = exposed.filter((name) => packageOf(name) === pkg && !apis.includes(name));
      if (lost.length > 0) throw new Error(`exposed but no longer an api operation: ${lost.join(", ")}`);
      kernel.replaceScript(pkg, script);
      console.error(`harness：script 包 ${pkg} 改过了，已重新装载`);
    } catch (err) {
      console.error(`harness：script 包 ${pkg} 重新装载失败，仍用原来的：${err instanceof Error ? err.message : String(err)}`);
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reloading = Promise.resolve();
  return watch(dir, { recursive: true }, () => {
    clearTimeout(timer);
    // 一个接一个地重新装载，后改的后换
    timer = setTimeout(() => (reloading = reloading.then(reload)), 100);
  });
}
