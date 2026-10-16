/**
 * 宿主：一个进程里跑一个 Harness。只有它握着内核：按装配配置建内核、按顺序装载插件、启动，再调各入口的 serve。
 * 启停是机器的信号，只在这里处理：所有入口的 serve 都结束，或收到 SIGINT / SIGTERM，就优雅关停
 * （等在途的调用跑完，最多 graceMs），关停中再收到一次就强杀；关停完退出进程。进度都在写前日志里，再启动接着做。
 * 后续加入：约定一个退出码表示要重启（harness_restart），由外层重新拉起进程。
 */

import { Kernel, type KernelConfig } from "./kernel/kernel";
import { loadPlugin } from "./kernel/loader";

/** 装配配置（附 A）：内核的配置，加上装哪些插件 */
export type Assembly = KernelConfig & {
  /** 按顺序装载（同级插件按这个顺序排先后）：插件包目录，或 [目录, 配置] */
  plugins: (string | [dir: string, config: unknown])[];
  /** 优雅关停时最多等在途的调用多久，缺省 10 秒 */
  graceMs?: number;
};

export async function host(assembly: Assembly): Promise<never> {
  const { plugins, graceMs = 10_000, ...config } = assembly;
  const kernel = new Kernel(config);
  const serves: (() => Promise<void>)[] = [];
  for (const item of plugins) {
    const [dir, pluginConfig] = typeof item === "string" ? [item, undefined] : item;
    const serve = await loadPlugin(kernel, dir, pluginConfig);
    if (serve) serves.push(serve);
  }
  await kernel.boot();

  let stopped: Promise<void> | undefined;
  const halted = Promise.withResolvers<void>();
  const stop = () => {
    stopped = kernel.stop(stopped ? 0 : graceMs);
    halted.resolve();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let code = 0;
  Promise.all(serves.map((serve) => serve())).then(
    () => stopped ?? stop(),
    (err) => {
      console.error("[harness] serve failed", err);
      code = 1;
      if (!stopped) stop();
    },
  );
  await halted.promise;
  await stopped;
  // 模型客户端等可能还留着连接，显式退出
  process.exit(code);
}
