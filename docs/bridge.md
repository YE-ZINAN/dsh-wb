# dsh-wb-bridge

**dsh → WorkBuddy 功能级遥控桥。** 把任务交给本机 `codebuddy` headless 引擎执行，结果读回 dsh。

因为 dsh 本身已经能被手机远程访问（dsh-lan-gate + Tailscale），装上本插件后这条链直接成立：

```
手机（远程 dsh）→ dsh 会话 → wb_run_agent 工具 → codebuddy.exe -p（本机）
                                                    ↓
                                            结果/用量/sessionId 回传 dsh → 手机上看到
```

**不需要任何新的网络配置** —— 复用已有的远程 dsh 通道。

## 为什么是路径 A（headless 引擎）

| 路径 | 做法 | 实测结论 |
|---|---|---|
| **A（本插件）** | 调 `codebuddy.exe -p`，非交互跑完拿结果 | ✅ 已打通。引擎 `C:\Users\<you>\AppData\Local\codebuddy\bin\codebuddy.exe`，v2.156.0，已在 PATH 上 |
| B（wbipc） | 驱动 WB 应用本体的命名管道 | ❌ 未做。协议未公开（`\\.\pipe\wbipc-<hash>` + ticket），WB 一更新即废；有了 A 之后必要性下降 |

额度口径：`~/.codebuddy/models.json` 配的是**用户自己的 DeepSeek key**（`deepseek-flash` / `deepseek-v4-pro`，指向 `api.deepseek.com`）⇒ **走 headless 烧的是 DeepSeek 额度，不是 WB 积分**。本插件**不读也不转传任何 key**，引擎自己从它自己的配置取。

## 工具面（6 个）

| 工具 | 作用 |
|---|---|
| `wb_run_agent(task, …)` | 跑一个任务。`waitMs` 内跑完直接返回结果，否则给 `jobId` 轮询 |
| `wb_job_output(jobId, waitMs?)` | 轮询任务：状态、退出码、结构化结果、已捕获的（已遮密钥的）输出 |
| `wb_job_list()` | 列出本进程跟踪的任务（含已结束） |
| `wb_job_kill(jobId)` | 杀掉任务（**按进程树**，Windows 走 `taskkill /T /F`） |
| `wb_bridge_status()` | 引擎路径/版本、默认 cwd、白名单、权限策略、超时/输出上限、任务数、台账路径 |
| `wb_skill_context(previewChars?)` | 看 `wb_run_agent` 往引擎 system prompt 里注入的技能清单（名称 + 用途 + 技能根目录） |

`wb_run_agent` 的主要参数：`task` / `cwd` / `model` / `maxTurns` / `permissionMode` / `tools` / `allowedTools` / `disallowedTools` / `addDirs` / `appendSystemPrompt` / `sessionId` / `continueSession` / `outputFormat` / `timeoutMs` / `waitMs` / `dryRun`。

**多轮**：首次调用回执里带 `result.sessionId`，下次传 `sessionId`（或 `continueSession: true`）即可续同一会话。

## 实测验收（2026-10-08，共 6 次真实调用）

```
① 连通性  task: 只回复两个字：正常    tools: ""（禁用全部工具）  maxTurns: 1
→ exitCode 0，6.7 s，模型 deepseek-v4-pro，回复「正常」
→ usage: input 25269 / output 2 tokens，credit 6.5

② 干活    task: 读 adam-valuing/SKILL.md 并三行总结   tools: default  profile: readonly
→ exitCode 0，9.7 s，正确总结；引擎自己调 Read 读了技能正文，零权限拒绝
→ usage: input 53532（缓存命中 50432）/ output 267，credit 0.29 + 1.15

③–⑥ 权限档实验（readonly 写被拒 / acceptEdits / edits / shell / edits-vs-bash）
→ 读数见上「权限档」一节；其中 editable 档验证到 Write ✅ + Bash ❌
```

冒烟测试 `_scratch/wb-bridge-smoke.mjs` **59/59 通过**，且**不消耗模型额度**：真引擎只跑 `--version`，执行管道用假引擎（`node.exe`）验证 —— 覆盖 argv 构造、权限档解析与闸门、cwd 白名单、`~` 展开、密钥遮蔽、dryRun、退出码捕获、超时按树杀（实测 2 s 目标 2.4 s 内落地且进程消失）、幂等 kill、引擎缺失/总开关关闭的拒绝路径、结果提取、技能上下文。

### `--output-format json` 的真实形状（重要）

它吐的是**事件数组**，不是单个对象：

```
[ {type:'message',role:'user',…}, {type:'file-history-snapshot',…},
  {type:'message',role:'assistant',content:[{type:'output_text',text:'正常'}]},
  {type:'result', subtype:'success', result:'正常', session_id:…, usage:{…}, num_turns:2, duration_ms:3737} ]
```

最终答案、用量、session id 都在最后那条 `type:'result'` 里。`extractResult()` 负责提取；不提取的话模型会看到 17 KB 噪声（含整段引擎 system prompt）。

## 安全设计

- **`-y/--dangerously-skip-permissions` 默认禁用**：调用方请求也会被拒，只有 config 显式 `allowSkipPermissions: true` 才放行。
- **cwd 白名单**：`allowedCwds`（默认 `~`），`~` 在请求侧与白名单侧都会展开。
- **密钥遮蔽**：引擎输出与审计台账一律过遮蔽（`sk-*` / `api_key=` / `token=` 等）；万一引擎读到了 key，不让它二次落进会话记录。
- **按进程树杀**：超时与插件卸载都会 `taskkill /T /F`，不留孤儿。插件卸载时 `ctx.effect` 回收全部在跑任务。
- **审计台账**：每次执行进 `out/wb-bridge-log.jsonl`（时间、jobId、cwd、模型、任务预览、退出码、耗时、输出字节），事后可核额度与行为。
- **环境变量只从 config 注入**，不接受工具参数注入（避免模型往子进程塞环境）。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `codebuddyPath` | `'codebuddy'` | 引擎；绝对路径或 PATH 名 |
| `defaultCwd` | `~/WorkBuddy/Claw`（不存在则 `~`） | 不传 cwd 时用它 |
| `allowedCwds` | `['~']` | cwd 白名单 |
| `defaultModel` | `''` | 留空用引擎默认 |
| `defaultMaxTurns` | `15` | |
| `defaultPermissionMode` | `'default'` | 不动引擎设置 |
| `allowSkipPermissions` | `false` | 是否允许调用方请求 `-y` |
| `defaultTimeoutMs` / `maxTimeoutMs` | 600000 / 3600000 | 单次执行超时与上限 |
| `defaultWaitMs` | `45000` | 工具内联等待时长，超时返回 jobId |
| `maxOutputBytes` | `200000` | 单次输出保留上限 |
| `bridgeLogPath` | `<插件目录>/out/wb-bridge-log.jsonl` | 审计台账 |
| `permissionProfiles` | 见上表（`readonly`/`edits`/`shell`/`full`） | 命名权限档（**整对象覆盖，改请写全**） |
| `defaultProfile` | `'readonly'` | 默认档位 |
| `allowSkipPermissions` | `false` | 是否允许 `full` 档 / `-y` |
| `skillContext` | `{enabled: true, mirrorPath: <同级 dsh-wb-sync 镜像>, skillDirs: ['~/.workbuddy/skills'], maxChars: 9000, descriptionChars: 110}` | 认知对齐：注入给引擎的技能清单（**整对象覆盖，改请写全**） |
| `extraEnv` | `{}` | 额外环境变量（只从 config 注入） |

## 权限档：能干什么，由档位决定（全部实测）

**核心安全设计**：调用方（模型）只能用 `profile` **选档名**，**不能自带任何授权参数**。授权能力只能由 `config.permissionProfiles` 预先定义 —— 否则模型等于可以自己给自己发权限。

四档的实测读数（2026-10-08，`_scratch/wb-perm-experiment.mjs`，每档真实调用一次）：

| 档 | 引擎参数 | 实测结论 | 被拒工具 |
|---|---|---|---|
| **`readonly`**（默认） | `--permission-mode default` | 读文件放行；写/执行**被硬拒**；**快速失败不挂起**（11 轮 12.9 s） | `Write` `Bash` `PowerShell` |
| **`edits`** | `--settings {"permissions":{"allow":["Write","Edit","Read"]}}` | **Write 成功、Bash 被精确拒绝** | `Bash` |
| **`shell`** | 同上 + `Bash`/`PowerShell` | **命令真被执行**（`echo shell-ok` 输出回传，零拒绝） | — |
| `full` | `-y` | **未实测**；受 `allowSkipPermissions` 闸门保护 | — |

两点值得单独说：

1. **不需要全盘 `-y`**。`--settings` 接受 JSON 字符串，等于**进程级**附加配置 —— 授权只对这一次调用生效，**完全不动你的全局 `~/.codebuddy/settings.json`**。
2. **默认权限下的失败是"快速失败"而不是挂起**。非交互模式没有权限提示渠道，引擎直接拒绝并如实回答"文件创建失败"。所以哪怕是 `readonly` 档，也不会把手机端卡死。

**日常怎么用**：默认 `readonly`；需要写文件时调用方传 `profile:'edits'`；需要跑命令才传 `profile:'shell'`。每次回执都带 `profile` 字段，你随时能看到这次用的是什么权限。想让手机端默认就能写文件，把 `defaultProfile` 改成 `'edits'` 即可（一行，代价是默认允许写 `~` 下任意文件）。

## 认知对齐：让引擎真的"是 WB"

这一步不做，"遥控 WB" 就只是"遥控一个通用 agent"。

**实测缺口**：headless 引擎有**它自己**的记忆与技能面 —— 它的 memory 目录是 `~/.codebuddy/projects/c-Users-<you>-WorkBuddy-Claw/memory`（**空**），而 WB 的记忆在 `~/.workbuddy/`、技能在 `~/.workbuddy/skills/`（**60 个**）。两套完全独立，引擎不知道 WB 那套技能与口径。

**做法**：`wb_run_agent` 默认往引擎 system prompt 里追加一份技能清单（调用方自己传了 `appendSystemPrompt` 时就尊重调用方）。清单内容是「技能名 — 用途（截 110 字）」，技能根目录只在开头写一次，并明确要求引擎"先判断是否有匹配技能，有就读 SKILL.md 按口径执行，不要凭经验替代"。

**实测读数**：60/60 个技能全部列进 7 212 字符，未截断（早期版本每条带完整路径 ≈ 12 K 字符，8 K 上限下只列得进约 38 个 —— 剩下的对引擎等于不存在，已修）。清单来源优先用 `dsh-wb/domains/sync` 的镜像 `out/wb-skills-mirror.json`，没有就自己扫 `~/.workbuddy/skills/*/SKILL.md`。

引擎 `trustedDirectories` 覆盖 `C:/Users/<you>/**`，所以清单里给出的 SKILL.md 路径**是可读可执行的**，不是装饰。

用 `wb_skill_context` 可以随时看实际注入的内容（只读、不烧额度）。

## 已解决的缺口

1. **无人值守的权限模式 —— 已实测并做成档位**。见上「权限档」：`readonly`/`edits`/`shell` 三档全部真跑过，`edits` 做到「能写文件、拿不到命令执行权」的精确授权。默认档保持最保守的 `readonly`。
2. **认知不对齐 —— 已实现**。技能清单已注入，60/60 全部列进 7 212 字符。见上「认知对齐」。

## 已知缺口（下一步）

1. **引擎自己的记忆仍是空的**：技能已对齐，但引擎那套 `~/.codebuddy/projects/<slug>/memory` 还是空。要不要把 WB 的 `MEMORY.md`/项目日志也喂进去（同走 system prompt 或挂目录），是下一步选项。
2. **`full` 档（`-y`）未实测**，且默认被闸门关着。要开得先想清楚：那等于把本机命令执行权交给一条**手机可达**的通道。
3. **改动插件源码后必须重启 dsh 桌面端**才会加载新模块代（本会话已四次实测）。

## 与开发计划的关系

- 这是计划 §12 的「**dsh 功能级遥控 WB**」路径 A 的实现，**依赖**前面的记忆同步插件先把认知对齐的地基打好（§12.4）——同步插件已产出 60 个技能的只读镜像，正好可以喂给引擎当 system prompt。
- 计划 §12.1 的边界照旧：**功能级，不是界面级**。不点 WB 窗口、不碰 GUI。
