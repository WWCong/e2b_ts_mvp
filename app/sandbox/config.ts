/** 服务端（server/main.ts）与终端（client/main.ts）共用的配置，从环境变量读；变量名带 SANDBOX_，不与别的应用混 */

const env = process.env;

/** 本地的根：state/ 是持久状态（写前日志、插件的存储、装上的 script 包），workspace/ 是工作区 */
export const home = env.SANDBOX_HOME || ".sandbox";
/** 服务口的端口 */
export const port = Number(env.SANDBOX_PORT || 8080);
