/**
 * 服务接口：Harness 对外提供服务的协议层（HTTP；以后 gRPC 等），由宿主按装配配置 serve 启停（host.ts）。
 * 只在 stdlib 里写：对外接口只交给它们，插件拿不到。
 */

import type { Subscriber } from "../kernel/events";
import type { Outside } from "../kernel/outside";

/** 服务接口拿到的：对外接口（按 origin 取，即这次调用是谁发起的）与事件订阅 */
export type ServeContext = { outside(origin: string): Outside; subscribe(fn: Subscriber): void };

/**
 * 一个服务接口。建出来时先占住要监听的地址（被占了就报错，宿主不再往下启动）；
 * 内核启动完成后 listen 开始接请求；关停时 stop(false) 先停止接新连接（连着的照常），关停完 stop(true) 断开连接
 */
export type Service = {
  listen(ctx: ServeContext): void;
  stop(closeConnections: boolean): void;
};
