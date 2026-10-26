/** 测试用插件：声明需要 store，把注入进来的基建交给配置里的 got */

import { plugin } from "../../plugin";

export default plugin({ needs: ["store"] }, (config: { got?: (infra: object) => void }, infra) => {
  config.got?.(infra);
  return {};
});
