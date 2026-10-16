/**
 * 宿主：一个进程里跑一个 Harness。只有它握着内核：建内核、按顺序装载插件、启动（恢复上次没做完的树），
 * 再按装配配置 serve 打开对外的服务接口（stdlib/serve）。
 * 启停是机器的信号，只在这里处理：收到 SIGINT / SIGTERM 就优雅关停——先停止接新请求，再等在途的调用跑完
 * （最多 graceMs），关停中再收到一次就强杀，内核关停完断开连接、退出进程。进度都在写前日志里，再启动接着做。
 * 装了入口（entry()，只剩终端，改成客户端后去掉）时，入口都结束服务也关停。
 * 后续加入：约定一个退出码表示要重启（harness_restart），由外层重新拉起进程。
 */

import { Kernel, type KernelConfig } from "./kernel/kernel";
import { loadPlugin } from "./kernel/loader";
import { httpService, type HttpConfig } from "./serve/http";
import type { Service } from "./serve/service";

/** 装配配置（附 A）：内核的配置，加上装哪些插件、开哪些服务接口 */
export type Assembly = KernelConfig & {
  /** 能力：按顺序装载（同级插件按这个顺序排先后），插件包目录，或 [目录, 配置] */
  plugins: (string | [dir: string, config: unknown])[];
  /** 对外的服务接口：开哪些、各自监听在哪 */
  serve?: { http?: HttpConfig };
  /** 优雅关停时最多等在途的调用多久，缺省 10 秒 */
  graceMs?: number;
};

export async function host(assembly: Assembly): Promise<never> {
  const { plugins, serve = {}, graceMs = 10_000, ...config } = assembly;
  // 先占住服务接口要监听的地址：被占了（同一个状态目录已有 Harness 在跑）就不往下启动，不碰日志
  const services: Service[] = [];
  if (serve.http) services.push(await httpService(serve.http));

  const kernel = new Kernel(config);
  const serves: (() => Promise<void>)[] = [];
  for (const item of plugins) {
    const [dir, pluginConfig] = typeof item === "string" ? [item, undefined] : item;
    const serve = await loadPlugin(kernel, dir, pluginConfig);
    if (serve) serves.push(serve);
  }
  await kernel.boot();
  for (const service of services) {
    service.listen({ outside: (origin) => kernel.outside(origin), subscribe: (fn) => kernel.events.subscribe(fn) });
  }

  let stopped: Promise<void> | undefined;
  const halted = Promise.withResolvers<void>();
  const stop = () => {
    if (!stopped) for (const service of services) service.stop(false);
    stopped = kernel.stop(stopped ? 0 : graceMs);
    halted.resolve();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let code = 0;
  if (serves.length > 0) {
    Promise.all(serves.map((serve) => serve())).then(
      () => stopped ?? stop(),
      (err) => {
        console.error("[harness] serve failed", err);
        code = 1;
        if (!stopped) stop();
      },
    );
  }
  await halted.promise;
  await stopped;
  for (const service of services) service.stop(true);
  // 模型客户端等可能还留着连接，显式退出
  process.exit(code);
}
