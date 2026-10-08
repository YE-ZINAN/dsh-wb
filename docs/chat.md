# dsh-wb-chat

**在 dsh 里直接和本机 WorkBuddy 引擎对话。** 侧栏多一个 `WB 对话` 图标，点开是整屏对话面板；你的问题直接进引擎，回复**逐字流式**显示 —— **不经过 dsh 的 agent 转述**。

因为 dsh 本身已可被手机远程访问（dsh-lan-gate + Tailscale），手机上打开远程 dsh 就能看到同一个面板。

```
你在面板里输入  →  POST /dsh-wb/domains/chat/send（宿主半区）  →  codebuddy.exe -p --output-format stream-json
                ←  text/event-stream 逐字回传          ←  stream_event / delta.text
```

## 它加了两样东西（且必须成对）

| 位置 | 槽 | 说明 |
|---|---|---|
| 侧栏图标 | `sidebar.panellist` | `{ id: 'dsh-wb-chat:wb', order: 40, label: 'WB 对话' }` |
| 整屏面板 | `main`（keyed） | `{ key: 'dsh-wb-chat:wb' }` —— **key 必须与图标 id 相同** |

⚠️ `sidebar.panellist` 是**主面板注册表**：只注册图标、不注册对应的 `main` 面板会坏布局（本机 qq2005 与 lan-gate 两个插件的注释都留过这条教训）。本插件按 `dsh-mnemon` 的写法用 `inject('main', () => inject('sidebar.panellist', () => { … }))` 成对注册，并在图标注册失败时回滚面板注册。

## 两种传输方式（面板顶部切换）

面板顶部的「传输方式」下拉框决定这套面板到底怎么干活：

| 传输 | 怎么干活 | 对话在哪 | 额度 | 前提 |
|---|---|---|---|---|
| **WB 界面**（默认） | 通过 CDP 驱动**已开着的 WorkBuddy 应用本体** | **就在 WB 里**（界面能看到全过程，也留在 WB 的历史里） | WB 账号积分 | WB 必须带 `--remote-debugging-port=9223` 启动 |
| 无界面 | 起独立进程跑 `codebuddy -p` | 只在 dsh 面板里 | 同左（可用宿主 hostd 模型走积分） | 无 |

**「WB 界面」模式的行为**：选一段会话 → **在 WB 界面里真的切过去**（不是复制副本再 `--resume`）→ 之后每条都进那段对话；
发送走 CDP 受信任输入（真实鼠标点击聚焦 + `Input.insertText` + 真实鼠标点击发送），回复按 ~900 ms 轮询界面推回面板，看起来是流式。

**积分模型下拉框**（仅 WB 界面模式）列出 WB 模型菜单里的全部模型**并带积分倍率**
（`Hy3 0x` 限时免费、`GLM-5.3-Flash 0.06x`、`Deepseek-V4.1-Flash 0.11x`、`Kimi-K3 1.62x` …），
选中即点 WB 的模型菜单切过去，面板与 WB 保持同一模型。

**为什么不 import `dsh-wb/domains/gui`**：插件之间**不能跨包 import**（本机实测），所以面板的浏览器半区直接
`fetch` 同源路由 —— 流式发送走 `dsh-wb/domains/gui` 的 `/dsh-wb/domains/gui/send`（SSE），CDP 逻辑全机只留一份。

⚠️ 客户端改动需要**刷新页面**才生效（客户端插件只有在 `pnpm run dev:web` 同时运行时才自动热更）。

## 通信方式

客户端服务目录里**没有通用宿主 RPC**（只有 layout/locale/sessions/slots/theme/timer/uiWorkspace/workspaces），
所以走宿主 `webServer` 路由 + 同源 `fetch` —— 与 dsh-lan-gate 已经验证过的通道一致。
`webServer.register` 的 handler 拿的是**原生 Node req/res**，因此可以 `res.write()` 分块流式。

| 路由 | 用途 |
|---|---|
| `GET /dsh-wb/domains/chat/info` | 引擎路径/版本、可用权限档、默认档、默认 cwd、最近会话 |
| `POST /dsh-wb/domains/chat/send` | 流式执行（`text/event-stream`） |

SSE 事件：`start`（档位/cwd/注入技能数/argv 回显）、`session`（会话 id）、`delta`（增量文本）、`thinking`（思考字数）、`stderr`、`done`（result/usage/耗时/脱敏数）、`exit`（退出码）。15 秒一次 `: ping` 心跳防代理超时。

**客户端断开即按进程树杀**（切面板、关页面、手机锁屏都算），不留孤儿进程。

## 权限

**授权参数与 `dsh-wb/domains/bridge` 共用同一份定义**（`wb-runner.js` 的 `DEFAULT_PERMISSION_PROFILES`），面板上只能**选档名**，请求体无法自带授权参数。四档的实测依据见 `dsh-wb/domains/bridge/README.md`。

| 档 | 能力 |
|---|---|
| `readonly` | 只读；写/执行被引擎硬拒 |
| **`edits`（面板默认）** | 能写文件；**Bash 被精确拒绝** |
| `shell` | 能写文件、能执行命令 |
| `full` | `-y`，需 config 放行（默认关） |

面板默认给 `edits` 的理由：这里是**人**在直接打字（不是 agent 自行决定要不要加权限），且档位在下拉框里始终可见、每次回执都回报用了哪档。要更保守就把 `defaultProfile` 改成 `readonly`。

## 认知对齐

面板同样会往引擎 system prompt 注入 WB 的技能清单（复用 `dsh-wb/domains/sync` 的技能镜像），所以在这里问"用 adam-valuing 给某公司估值"，引擎知道该读哪份 SKILL.md。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `codebuddyPath` | `'codebuddy'` | 引擎 |
| `defaultCwd` | `~/WorkBuddy/Claw`（不存在则 `~`） | 不传 cwd 时用它 |
| `allowedCwds` | `['~']` | cwd 白名单 |
| `permissionProfiles` | 与 bridge 共用 | **整对象覆盖，改请写全** |
| `defaultProfile` | `'edits'` | 面板默认档 |
| `allowSkipPermissions` | `false` | 是否允许 `full` 档 |
| `maxTurns` | `20` | 单次最大 agentic 轮数 |
| `maxMessageChars` | `8000` | 单条消息字符上限 |
| `requestTimeoutMs` | `900000` | 单次执行硬超时 |
| `historyLimit` | `20` | `/info` 列出的最近会话数 |
| `skillContext` | `{enabled, mirrorPath, skillDirs, maxChars, descriptionChars}` | 技能清单注入（整对象覆盖） |

## 装 / 卸

```powershell
# plugin_manager: action=install_bundle, target=<本目录绝对路径>
# plugin_manager: action=remove_bundle, target=dsh-wb-chat
```

⚠️ **客户端半区的改动需要完全重启 dsh 桌面端**才会生效（本机已多次实测：新增 bundle 可走 HMR，但已加载的客户端模块代不会热替换）。重启后侧栏出现 `WB 对话` 图标。

## 依赖：自包含（有一条实测坑）

**本插件不 import 别的插件包。** 宿主半区自带 `wb-lite.js`（引擎解析、cwd 白名单、密钥遮蔽、技能清单、权限档），客户端半区只用浏览器模块表里的 `react`。

⚠️ **为什么不能 import `../dsh-wb/domains/bridge/wb-runner.js`（实测，2026-10-08）**：
一开始为了"权限档单一真源"用了跨包相对 import，结果 `install_bundle` 报
`dsh-wb-chat (dsh-wb-chat): failed to import`，而且宿主日志里**只有这一句**没有细节。
用一个最小探针插件（唯一行为就是一次跨包相对 import）复现了同样失败 ⇒ **DSH 插件加载器不支持跨包相对 import**（纯 Node 下同一路径导入正常，所以不是 ESM 解析问题）。

**代价**：`DEFAULT_PERMISSION_PROFILES` 出现了两份（`dsh-wb/domains/bridge/wb-runner.js` 与 `dsh-wb/domains/chat/wb-lite.js`），**必须逐字一致** —— 授权参数写错等于放宽权限。
**防漂移**：`_scratch/wb-chat-host-test.mjs` 会 deep-equal 两个模块的该常量，并单独断言 `edits.args` 不含 Bash、`shell.args` 含 Bash、`full.requiresAllowSkip === true`。改任一处都要跑它（`--static` 可跳过真实调用、不花额度）。

软依赖：`dsh-wb/domains/sync` 的技能镜像（`out/wb-skills-mirror.json`）；读不到就自己扫 `~/.workbuddy/skills`，**没有硬依赖**。

## 读 WorkBuddy 历史对话，并接着聊（已实测）

面板顶部有「新对话 / 历史会话」下拉框，列出 WB 应用自己的会话（默认最近 25 段，带标题与时间）；**选中后会自动把那段历史正文读出来渲染在面板里**，再发消息就是接着那段对话继续。

读正文的实现（`GET /dsh-wb/domains/chat/wb-transcript`）：

- **只读文件尾部**（默认 4 MB）—— 会话文件最大见过 **164 MB**，绝不整文件读；`tailOnly` 如实回报。
- **默认剔除工具行**：真实会话尾部常常连续几十条 `[工具] Bash …`，带上会把对话淹掉（实测同一段历史：含工具 = 3 条 assistant + 37 条工具；不含工具 = 30 条 assistant + 10 条 user）。要看工具行加 `?tools=1`。
- **剥掉噪声**：用户消息只取 `<user_query>` 内的正文（外层裹着巨大的 `system-reminder` 记忆块）。
- **路径白名单**：只放行 WB 会话目录内的文件。实测 `C:\Windows\win.ini` 与 `~/.workbuddy/MEMORY.md` 都被拒（404）。
- 面板里历史段渲染成半透明，并在「历史」与「本次新增」之间画一条分界线。

### 反向呢：从面板继续的对话，会出现在 WB 界面里吗？

**不会。** 这是当前设计的硬边界：

| 方向 | 是否可见 | 原因 |
|---|---|---|
| WB → 面板 | ✅ | 面板直接读 WB 的会话文件（只读） |
| 面板 → WB 界面 | ❌ | 面板发起的接续写进的是 **CLI 侧副本**（`~/.codebuddy/projects/…`）；WB 应用读它自己的库（`~/.workbuddy/projects/…` + `workbuddy.db`），两本账互不通知 |

要在 WB 界面里看到，只有两条路：

1. **写回**（可做，但属于改 WB 的数据）：把新轮次追加回 WB 的原 jsonl，并更新 `workbuddy.db` 的 `sessions.updated_at` 等元数据。风险：应用若正开着该会话可能冲突；必须**先备份**、且最好在应用未打开该会话时写。**目前默认不做。**
2. **驱动应用本体**：唯一"原生"的路径，但它的会话 HTTP endpoint **按需临时起、空闲即失效**（实测最新心跳也已过期 388 分钟），`wbipc` 命名管道协议又未公开 —— 没有常驻接口可用。



**怎么做到的**（实测事实，2026-10-08）：

| 环节 | 事实 |
|---|---|
| 会话正文 | `~/.workbuddy/projects/<cwd-slug>/<sessionId>.jsonl` —— 139 个文件 / 30 个项目，**与 CLI 同格式同词汇**（`message` / `reasoning` / `function_call` / `function_call_result`） |
| cwd 与标题 | **每条事件都带 `cwd`**；另有 `type:'ai-title'` 事件带 `aiTitle` ⇒ 只读文件头部即可拿到，**不必依赖 SQLite**（插件宿主是 Electron 的 Node，不保证有 `node:sqlite`） |
| 接续做法 | 把该 jsonl **复制**一份到 `~/.codebuddy/projects/<同一个 slug>/`，在**原 cwd** 下 `--resume <sessionId>` |
| 实测结果 | 让它回顾那段 745 KB 历史 → 准确复述主题（抗倭游戏、歙县、1554–1556、城建设计文档、Ch0–Ch3×P0–P3 路线）并正确指出最后关心的问题；**`numTurns: 26`** 证明 26 轮历史真读进去了 |

**注意事项**：

- `--resume` **只在当前 cwd 对应的 project 目录里找会话** ⇒ 必须用原 cwd 运行、文件必须落在对应 slug 下（面板自动处理）。
- **大会话很贵**：那次 resume 的 input 是 **55.5 万 tokens**（缓存命中 150 万）。下拉框里带体积，接续前看一眼。
- **不改动 WB 原文件**（复制一份），重复导入幂等。
- **没有 `cwd` 的会话无法接续**，已自动剔除并如实计数：本机 49 段里 **35 段可接续、14 段被剔除**（`/wb-sessions` 回 `resumableTotal` / `skippedNoCwd`）。

## 走哪套额度：账号积分 vs 你自己的 API key

| 情况 | 走什么 |
|---|---|
| 指定**托管模型** id（`deepseek-v4.1-flash` / `hy3` / `glm-5.3-flash` / `glm-5.3` …） | **CodeBuddy 账号积分** |
| 不指定模型，或指定 `deepseek-flash` / `deepseek-v4-pro` | `~/.codebuddy/models.json` 里**你自己的 API key** |

**实测依据**：`--model glm-5.3` 直接跑通（exitCode 0、回复正确），而 **glm-5.3 不在 models.json 里** ⇒ 它是 CodeBuddy 自带托管模型、走账号通道。反过来，WB 应用自己在用的也是 `deepseek-v4.1-flash` / `hy3` / `glm-5.3-flash`（全托管），并在 `workbuddy.db` 的 `session_usage.credit_json` 里按会话记积分 —— **应用一直走积分，而 CLI 默认走你的 key**。

面板的 `defaultModel` 因此默认设为 **`deepseek-v4.1-flash`（托管 ⇒ 积分）**；想回自有 key 就清空它：

```yaml
- id: dsh-wb-chat
  config:
    defaultModel: ''     # 空 = 引擎默认（models.json 里的自有 key）
```

`/info` 会回 `billingNote` 明说当前是哪一种。

## 其他实测坑

- **客户端半区改动必须完全重启 dsh 桌面端**（本机已多次实测：新 bundle 可 HMR，但已加载的客户端模块代不热替换）。
- **`dsh.client.inject` 要填对属主包**：`main` 与 `sidebar.panellist` 的属主是 `@deepseek-ai/dsh-client-ui-layout` 与 `@deepseek-ai/dsh-client-ui-sidebar`（照 `dsh-mnemon` 的清单抄的），不是 `ui-conversation`。
- **`StreamEvent` 形状**：`{type:'stream_event', event:{delta:{type:'text_delta', text:'…'}}}`，最后一条是 `{type:'result', result, session_id, usage}`。`--output-format json`（非流式）返回的是**事件数组**，两者别混用。
- **cwd → 目录名（slug）两个坑**：① 不能写成 `'c-' + path.replace(...)`（产出 `c-C-Users-…`）；② **空白要原样保留**，不能折成 `-`（`<drive>:\<onedrive>` 那条会对不上）。两种错法的后果都是「找不到会话目录」**而且不报错**。现用算法已用引擎自己的 51 条会话全量核对（49 条算对、0 条算错）。

## 已知限制

- 面板**不显示工具调用过程**（只显示文本增量 + 思考字数 + stderr）。要完整事件流得看 `wb_run_agent` 的回执或引擎会话 JSONL。
- 会话续接靠引擎的 `--session-id`；面板上的「新会话」只是清掉这个 id，不会删除引擎侧记录。
- 面板是 **dsh 里的一块 UI**，不是 WB 应用窗口。要让对话出现在 WB 自己的界面里，只有驱动应用本体（`wbipc`，协议未公开）那条路 —— 而且它的会话 HTTP endpoint 是**按会话临时起、会话结束即失效**（实测最新心跳也已过期 388 分钟），没有常驻接口可用。
- 走手机（经 lan-gate 网关）时流式是否被中间层缓冲**未实测** —— 局域网/本机已通，远程路径待验。
