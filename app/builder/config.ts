/** builder 的配置，从环境变量读；变量名带 BUILDER_，不与别的应用混 */

const env = process.env;

/** 本地的根：tree/ 是树（结构、产物、聊天，机器把它同步到对象存储），state/ 是持久状态（写前日志、插件的存储） */
export const home = env.BUILDER_HOME || ".builder";
/** 内网上的端口与监听的地址 */
export const port = Number(env.BUILDER_PORT || 8090);
export const hostname = env.BUILDER_HOST || "127.0.0.1";
/** 网关把调用者的身份放在哪个请求头里（网关怎么带还没定）；本机开发时网页自己带上填的名字 */
export const userHeader = env.BUILDER_USER_HEADER || "x-builder-user";
