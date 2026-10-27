/** 服务端（server/main.ts）与客户端（client/main.ts、start.ts）共用的位置：持久状态的目录与服务接口的 socket */

import { join } from "node:path";

export const stateDir = process.env.STATE_DIR ?? ".harness";
export const socket = join(stateDir, "harness.sock");
