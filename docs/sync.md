# dsh-wb-sync

WorkBuddy（WB）↔ dsh 记忆/技能同步插件。**M1–M4 全部落地并已在 live 会话验证。**

让 dsh 直接看到 WB 记了什么、有哪些技能；dsh 的结论能写回 WB 日志；两侧记忆做条目级双向 diff。
配套开发计划：`C:\Users\<you>\WorkBuddy\Claw\<plan>.md`。

## 装/卸

```powershell
# 装（工作区包 → link 进 desktop profile）
#   用 dsh 会话里的 plugin_manager 工具：action=install_bundle, target=<本目录绝对路径>
# 卸
#   plugin_manager: action=remove_bundle, target=dsh-wb-sync
```

零依赖、零构建：只用 `node:` 内置模块，`install_bundle` 直接生效（新增 bundle 走 HMR）。

## 工具面（8 个）

| 工具 | 阶段 | 作用 |
|---|---|---|
| `wb_list_assets(category?)` | M1 | 列举 WB 资产；category ∈ `all/memory/identity/skills/plans/daily` |
| `wb_read_asset(path, maxBytes?)` | M1 | 读单个资产；`path` 支持绝对路径或 `<category>/<相对路径>` |
| `wb_search(query, scope?, limit?)` | M1 | 跨资产关键词检索（同一行需全部命中，大小写不敏感） |
| `wb_build_index(outPath?)` | M1 | 生成人读 Markdown 索引（默认 `out/wb-assets-index.md`） |
| `wb_append_memory(title, body, date?, tags?, dedupeKey?, dryRun?)` | M2 | 把 dsh 结论追加进 WB 每日日志 |
| `wb_write_log(limit?)` | M2 | 读本地写回台账（时间、目标、标记、备份路径、追加原文） |
| `wb_sync_plan()` | M3 | 两侧条目级 diff：已同步 / 各自独有 / 需人工 / 窗口冲突（只写计划文件） |
| `wb_sync_apply(includePush?, includeStage?, dryRun?)` | M3 | 执行：推 dsh 独有 → WB 日志；WB 独有 → dsh inbox 暂存文件 |
| `wb_sync_status()` | M1–M4 | 资产根、计数、排除规则、写回、同步、镜像、自动触发总览 |
| `wb_mirror_skills()` | M4 | 技能只读元数据镜像（名称/描述/体积/哈希） |

## M2 写回纪律

`wb_append_memory` 只往 `<dailyRoot>/<YYYY-MM-DD>.md` 追加，五条硬规矩：

1. **只追加**，永不改写或删除目标文件既有内容。
2. 修改前先把原文件复制成 `<file>.bak-dshsync`（单槽覆盖式）；备份失败则**拒绝写入**。
3. 内容命中密钥一律**拒绝**（fail closed，不做静默脱敏——脱敏会篡改原意）；拒绝信息只回报行号，**不回显密钥本身**。
4. **幂等**：同 `dedupeKey`（缺省 = title + body）重复写入直接跳过，避免同日反复追加。
5. 每次成功写入进本地台账 `out/wb-write-log.jsonl`，含完整追加文本，可人工回滚。

插入的块自带 `<!-- dsh-wb-sync:begin <hash> -->` / `:end` 标记，便于定位与摘除。`dryRun: true` 可先看不落盘的预览。

## M3 双向 merge 纪律

**两侧事实源**：WB 侧 = `memory` + `identity` 两类（散文文件）；dsh 侧 = `~/.mnemon/runtime/memories.json`（Mnemon 热记忆**投影**，每条含 content/updated_at/target/importance）。

匹配与判定：

1. **条目级匹配**：先精确（归一化后全等），再按**字符 bigram 相似度**（`max(包含率, Jaccard)` ≥ `similarityThreshold`，默认 0.62）贪心配对。中文用 bigram 比空格分词稳；用「包含率」是因为 WB 侧是短条目、dsh 侧常是长段落，短句被长段覆盖就该判为同一件事。
2. **窗口冲突**：同一轮里 WB 文件与 dsh 热记忆都变了 → 按 `updatedAt` 新者胜；**同秒 WB 优先**；**涉及身份类一律升级为 `needs-human`，永不自动覆盖**。
3. **身份类硬闸门**：`target=user` 的 dsh 条目与 `identity` 目录的 WB 条目，永不自动应用，每轮都出现在 `needsHuman` 报告里（不是"暂存过就不报了"）。
4. **dsh 侧恒只读**：本插件不写 dsh 记忆。dsh 真源是 `~/.mnemon/data/<body>/mnemon.db`，`runtime/…` 是投影，直接改会被下一次投影覆盖。所以 WB→dsh 只落 **inbox 暂存文件**（`out/inbox/dsh-inbox-<date>.md`），写入必须由 agent 走 mnemon 工具。
5. 推送带**安全阀** `maxPushPerRun`（默认 5 条/轮），避免首轮同步把 WB 日志刷屏；inbox 只在**有新增**时追加，不会被空轮覆盖。

## M4 技能镜像 + 自动触发

- **镜像**：只抓 `SKILL.md` 的名称/描述/体积/mtime/哈希，输出 `out/wb-skills-mirror.{json,md}`。**不复制正文、不执行** —— WB 的 `SKILL.md` 与 dsh 插件格式不同，只能镜像与索引（开发计划 §10 已定）。
- **自动触发**：挂 `agent/turn-stopping`（serial，"turn 即将关闭"；**本机 Event 目录里没有 `turn/end`**），按 `minIntervalMs`（默认 5 分钟）节流刷新技能镜像。刷新走 `setImmediate` 异步执行，绝不阻塞收尾；**只刷新只读派生物，不推进同步状态**（否则会把未同步的变化误记成已看过）。

## 资产范围

| 类别 | 根 |
|---|---|
| `memory` | `~/.workbuddy/{MEMORY,USER,SOUL,IDENTITY}.md` |
| `identity` | `~/.workbuddy/user-<uuid>-personal/`（自动发现） |
| `skills` | `~/.workbuddy/skills/**/SKILL.md` |
| `plans` | `~/.workbuddy/plans/` |
| `daily` | WB 项目记忆目录（默认 `~/WorkBuddy/Claw/.workbuddy/memory/`，可用 config 覆盖） |

## 安全纪律（对应开发计划 §8 / §5）

- **路径白名单**：只暴露上述根之下的文件，越界一律拒绝。
- **目录段黑名单**：`sessions`（会话转录 / vscdb）、`logs`、`tmp`、`cache`、`blobs`、`local_storage`、`node_modules`、`binaries`、`vendor`、uuid 目录等整支不可见。
- **文件黑名单**：`mcp.json`、`settings.json`、`user-state.json`、`keyblob`、`workbuddy.db`、含 `credential/token/api key/password/secret` 的文件名。
- **扩展名**：只读 `.md .markdown .txt .json .yaml .yml`；**参与 merge 的只有散文**（`.md/.markdown/.txt`），机器状态 JSON 不当记忆条目。
- **读取脱敏**：命中 `sk-xxx`、`api_key=...`、`token=...` 等模式的行在返回前替换为 `[REDACTED]`，并回报条数。
- **junction 跟随有边界**：WB 的 `skills/` 下有 8 个 junction 指向 `vendor/ASu-skills/`；仅当链接 realpath 仍在允许边界内才跟进（防链接逃逸）。
- **分级**：身份/画像类资产一律 `normal`，**永不 `critical`**（用户硬规矩，`classify()` 无例外分支）。

## 配置（`cordis.patch.yml` 的 `config`）

| 键 | 默认 | 说明 |
|---|---|---|
| `wbHome` | `~/.workbuddy` | WB 用户级目录 |
| `personalDir` | `''`（自动发现） | WB 个人目录 |
| `projectMemoryDirs` | `[~/WorkBuddy/Claw/.workbuddy/memory]` | 项目级每日日志根 |
| `indexOutputPath` | `<插件目录>/out/wb-assets-index.md` | 索引输出路径 |
| `maxReadBytes` | `200000` | 单次读取上限 |
| `maxSearchFiles` / `maxSearchHits` | `400` / `60` | 检索扫描与命中上限 |
| `maxIndexFiles` | `2000` | 枚举/索引文件上限 |
| `writeEnabled` | `true` | M2 写回总开关 |
| `maxWriteBytes` | `20000` | 单条写回正文上限（字节） |
| `maxPushPerRun` | `5` | 单轮最多推送条数（防刷屏） |
| `writeLogPath` | `<插件目录>/out/wb-write-log.jsonl` | 写回台账路径 |
| `mnemonHome` / `mnemonRuntimeDir` | `~/.mnemon` / `<mnemonHome>/runtime` | dsh 侧记忆（**只读**） |
| `syncStatePath` / `syncPlanPath` / `inboxDir` | `<插件目录>/out/…` | 同步状态、计划、inbox |
| `skillsMirrorPath` / `skillsMirrorMarkdownPath` | `<插件目录>/out/wb-skills-mirror.{json,md}` | 技能镜像 |
| `similarityThreshold` | `0.62` | 跨侧匹配阈值（越高越严） |
| `autoTrigger` | `{enabled, minIntervalMs: 300000, refreshSkillsMirror: true}` | M4 钩子；**整对象覆盖，改请写全** |

## 与开发计划的偏差（2026-10-08）

计划 §3 原定「中枢式 `sync-mcp` server + WB 与 dsh 双端接入」。实测后改为 **Cordis 插件形态**：

1. dsh 侧**没有挂载 MCP client**（`@deepseek-ai/dsh-mcp-client` 只在 `node_modules` 里躺着），WB 侧 5 个 MCP server **全部 `disabled`** —— 双端 MCP 接入目前无落点。
2. DSH **没有可编辑的 source checkout**（`D:\dsh\HARNESS\resources\app.asar` 是打包归档）；本机既有本地插件（`dsh-quiet` / `dsh-skin-qq2005` / `dsh-lan-gate-button`）全部是"工作区写 bundle → link 进 profile"，本插件沿用该路径。
3. 同步逻辑跑在 dsh 宿主进程内，WB 侧资产按**文件层**读写 —— WB 本来就以文件为记忆载体，无需它配合即可同步；代价是 WB 无法主动调用本插件的工具（若要 WB 侧主动触发，再补一层 MCP/HTTP 暴露）。
4. 计划 §2 的「用户级 `MEMORY.md` 双向」**未做直接写回**：WB 的 `MEMORY.md` 是它的热记忆、格式敏感，改由"dsh 独有 → 写 WB 每日日志"这条安全通道承载。要直接合并进 `MEMORY.md` 需单独设计格式与回滚。

## 已知问题

- **改动插件源码后必须重启 dsh 桌面端**：bundle 的新增可走 HMR，但已加载的 JS 模块代不会热替换（`set_bundle` 关再开也无效，2026-10-08 实测）。只看页面刷新无效。
- M3 的匹配是**启发式**：bigram 相似度阈值调低会误配，调高会漏配；`wb_sync_plan` 的输出里带 `matchDetail`（exact / fuzzy 条数）便于判断。
- 两侧措辞差异大于阈值时会双向误报为"各自独有"——这是设计上的保守选择（宁可多报，不猜）。

## 路线（全部完成）

- M0 侦察 dsh 记忆机制 ✅ —— 真源是 Mnemon SQLite，`runtime/…` 是投影
- M1 WB→dsh 只读 View ✅
- M2 dsh→WB 写回每日日志 ✅
- M3 双向 merge + 冲突解决 + 身份类硬闸门 ✅
- M4 技能只读镜像 + `agent/turn-stopping` 自动触发 ✅

**未做**：dsh 记忆的自动写入（按设计只落 inbox，交 agent 走 mnemon 工具）；WB 侧主动调用（需补 MCP/HTTP 层）。
