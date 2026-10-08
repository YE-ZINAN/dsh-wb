/**
 * dsh-wb —— WorkBuddy 四件套合并（sync + bridge + chat + gui）
 *
 * 合并动机与收益：
 *   - 一次安装、一条 patch 条目、一份配置（现在是四份）
 *   - **包内相对 import 是允许的**（实测：`dsh-wb-chat/index.js` 本来就 `import './wb-lite.js'`），
 *     而跨包相对 import 会被加载器拒绝（`failed to import`）—— 所以合并是共享代码的**唯一**途径
 *   - 25 个工具零重名、inject 并集只有 `['tools','webServer']`（实测盘点）
 *
 * 设计：每个域保持**原始文件名与导出**（域内 import 路径因此不用改，迁移是纯机械搬运）；
 * 路由前缀也保持不变（`/dsh-wb-chat/*`、`/dsh-wb-gui/*`），所以面板客户端代码一行都不用改。
 *
 * ⚠️ 故障域：四个域现在同属一个插件。域内加载失败会被 try/catch 兜住并记日志，
 * 但"一处坏、全都没"这个性质无法完全消除 —— 这是合并的代价。
 *
 * 配置按域分区：`{ sync: {...}, bridge: {...}, gui: {...}, chat: {...} }`，省略即用各域默认值。
 */

import { apply as applySync } from './domains/sync/index.js';
import { apply as applyBridge } from './domains/bridge/index.js';
import { apply as applyGui } from './domains/gui/index.js';
import { apply as applyChat } from './domains/chat/index.js';

export const name = 'dsh-wb';

/** 四域 inject 的并集（sync/bridge 只需 tools，chat 只需 webServer，gui 两者都要）。 */
export const inject = ['tools', 'webServer'];

/** 域清单与加载顺序（sync → bridge → gui → chat）。 */
export const DOMAINS = ['sync', 'bridge', 'gui', 'chat'];

const HANDLERS = {
  sync: applySync,
  bridge: applyBridge,
  gui: applyGui,
  chat: applyChat,
};

/** 每个域注册了什么（给诊断用；也便于测试断言合并结果）。 */
export const CATALOG = {
  sync: { tools: 10, routes: 0, note: '记忆/技能同步；钩 agent/turn-stopping' },
  bridge: { tools: 6, routes: 0, note: '无界面遥控（headless CLI），4 档权限' },
  gui: { tools: 9, routes: 11, note: 'CDP 驱动 WB 应用本体' },
  chat: { tools: 0, routes: 4, note: '对话面板宿主（配套 client.js）' },
};

export function apply(ctx, rawConfig) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const report = [];
  for (const domain of DOMAINS) {
    const slice = config[domain] && typeof config[domain] === 'object' ? config[domain] : {};
    try {
      HANDLERS[domain](ctx, slice);
      report.push({ domain, ok: true, ...CATALOG[domain] });
    } catch (error) {
      const reason = String((error && error.message) || error);
      report.push({ domain, ok: false, reason });
      // 一个域坏掉不该拖垮其它域
      try {
        if (ctx && ctx.logger && typeof ctx.logger.error === 'function') ctx.logger.error(`[dsh-wb] ${domain} 域加载失败：${reason}`);
      } catch {
        /* 日志失败就算了 */
      }
    }
  }
  return report;
}
