/** 测试用入口：把拿到的对外接口交给配置里的 expose；serve 调一次配置里的 served 就结束 */

import { entry, type Outside } from "../../entry";

export default entry((config: { expose?: (outside: Outside) => void; served?: () => void }, outside) => {
  config.expose?.(outside);
  return {
    async serve() {
      config.served?.();
    },
  };
});
