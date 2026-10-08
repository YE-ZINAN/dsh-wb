# dsh-wb —— WorkBuddy 四件套（合并版）

把原来四个插件合并成**一个**：**25 个工具 / 15 条路由 / 1 个对话面板**。

| 域 | 目录 | 原插件 | 工具 | 路由 | 干什么 | 详细文档 |
|---|---|---|---|---|---|---|
| sync | `domains/sync/` | dsh-wb-sync | 10 | 0 | WB ↔ dsh 记忆/技能同步（读、索引、追加写入、双向合并、技能镜像）；钩 `agent/turn-stopping` | [docs/sync.md](docs/sync.md) |
| bridge | `domains/bridge/` | dsh-wb-bridge | 6 | 0 | 无界面遥控：起 headless `codebuddy -p` 跑任务、作业管理、4 档权限 | [docs/bridge.md](docs/bridge.md) |
| gui | `domains/gui/` | dsh-wb-gui | 9 | 11 | CDP 驱动 WB **应用本体**：读/开会话、富文本、真发、积分模型、窗口调出、带端口重启 | [docs/gui.md](docs/gui.md) |
| chat | `domains/chat/` | dsh-wb-chat | 0 | 4 | 对话面板的宿主半区（SSE 流式）；配套 `client.js` 面板 | [docs/chat.md](docs/chat.md) |

## 为什么合并，代价是什么

**收益**
- 一次安装、一条 patch 条目、一份配置（原来四份）、一份 README；
- **能共享代码**：包内相对 `import` 是允许的（实测 chat 本来就 `import './wb-lite.js'`），而**跨包**相对 import 会被加载器拒绝（`failed to import`）—— 合并是共享代码的唯一途径；
- 前车之鉴：密钥脱敏正则曾有 3 份、权限档常量曾有 2 份，改一处要记得改三处。

**代价（说清楚）**
- **故障域合并**：四域同属一个插件，一个域在加载期炸了可能连带整个插件注册失败。`index.js` 给每个域包了 `try/catch` 并记日志，但"一处坏、全都没"无法完全消除。
- 改一处共享逻辑现在要重载整个插件。

**迁移事实**：四域保持**原始文件名与导出**（域内 import 路径不用改），**路由前缀也保持不变**（`/dsh-wb-chat/*`、`/dsh-wb-gui/*`），所以面板客户端代码一行都没改。历史状态产物（`sync-state.json`、两份 `.jsonl` 台账、索引、技能镜像）已从旧目录搬进 `domains/*/out/`。

## 配置（按域分区）

```yaml
- insert:
    - id: dsh-wb
      name: dsh-wb
      config:
        sync:   { writeEnabled: true, maxPushPerRun: 5, similarityThreshold: 0.62, autoTrigger: { enabled: true } }
        bridge: { defaultProfile: readonly, defaultModel: deepseek-v4.1-flash, allowSkipPermissions: false }
        gui:    { cdpPort: 9223, restoreWindowOnSend: true, warmupOnLoad: true, relaunchWaitMs: 40000 }
        chat:   { defaultModel: deepseek-v4.1-flash, defaultProfile: edits, historyLimit: 20 }
```
省略任一域即用该域默认值（各域 DEFAULTS 在 `domains/*/index.js` 顶部）。

## 环境前提（gui 域）

1. WB 需带调试端口启动；本机已把**开始菜单快捷方式**改成自带
   `--remote-debugging-port=9223` + 一串防节流参数（备份 `WorkBuddy.lnk.bak-dshsync`）。
2. 端口没了不用管：面板里点「启动/重连 WB」，或调 `wb_gui_relaunch`（需 `confirm:true`）。

## 回滚（一分钟）

四个旧目录**一个都没删**，也仍在 profile 的 `dependencies` 里。回滚只需：
1. 停用 `dsh-wb`、重新启用 `dsh-wb-sync` / `dsh-wb-bridge` / `dsh-wb-chat` / `dsh-wb-gui` 四个 bundle；
2. 刷新 dsh 页面。

## 测试

| 套件 | 读数 |
|---|---|
| 合并目录级 `_scratch/wb-merged-test.mjs`（25 工具 / 15 路由 / 无重名 / 四域 ok / 配置穿得下去） | 18/18 |
| sync M2 / M3+M4 | 19/19 / 36/36 |
| bridge | 59/59 |
| chat 面板宿主 | 40/40 |
| gui 工具面 / 路由含真发 | 16/16 / 16/16 |
| gui 锚点防串话 / 富文本+清洗 | 6/6 / 18/18 |

## 客户端的坑（沿用）

- `client.js` 的模块 id 已改成包名 `dsh-wb`；**面板 key 仍是 `dsh-wb-chat:wb`**（沿用侧栏选中态）。
- 客户端改动**必须刷新页面**（客户端插件只在 `pnpm run dev:web` 同时运行时才热更）。
