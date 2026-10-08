# dsh-wb-gui

**通过 CDP 驱动 WorkBuddy 应用本体。** 读/开会话、读消息、**在真实界面里发消息** —— 对话发生在 WB 里（它自己的账号额度、技能、记忆），不再是另起一个 headless 进程。

```
手机 → 远程 dsh → wb_gui_* 工具 → CDP(127.0.0.1:9223) → WorkBuddy 界面
```

与 `dsh-wb/domains/bridge`（headless CLI）的区别：bridge 起新进程，**WB 界面里看不到**；本插件驱动**已开着的那个 WB**，界面里能看到全过程。

## 前提：WB 必须带调试端口启动

默认没有 CDP，`/json/list` 连不上，本插件会明确报错。启动方式（**先完全退出 WB**，托盘也要退）：

```powershell
Start-Process "C:\Users\<you>\AppData\Local\Programs\WorkBuddy\WorkBuddy.exe" -ArgumentList "--remote-debugging-port=9223"
```

⚠️ **点桌面/开始菜单图标不管用**（不带参数）。⚠️ 必须先退干净，否则单实例锁会让新参数不生效。

若启动命令是从 dsh 的 `pwsh` 工具里发的，进程会属于该命令的进程树、命令结束就被杀 —— 用**计划任务**拉起可以避开（本次实测就是这么做的）：

```powershell
schtasks /create /tn "dsh-wb-debug" /tr "\"<WorkBuddy.exe>\" --remote-debugging-port=9223" /sc once /st 23:59 /f
schtasks /run /tn "dsh-wb-debug"
```

## 渲染：为什么用 WB 自己的 HTML 而不是复用 dsh 的会话渲染器（2026-10-08）

**结论**：dsh **没有**把会话渲染器暴露给插件，所以不能直接复用；改用 **WB 自己的 HTML + 白名单清洗 + dsh 主题 token**，观感一致且不依赖私有 API。

**实测依据**：
- 客户端 Builtin 目录只有 `ctx / React / host / styles / console`（`cordis_inspect_query` client/Builtin）；
- 客户端 Service 目录只有 `layout / locale / sessions / slots / theme / timer / uiWorkspace / workspaces` —— 没有任何 markdown/message 渲染服务；
- 会话渲染器属内部视图包，需要会话上下文，且升级即废。

**做法**：
- WB 的 `.cr-markdown` **本身就是真 HTML**（实测含 `<p>/<strong>/<ul>/<li>/<pre>/<table>`）——之前抓 `innerText` 把它拉平了，现在抓 `innerHTML`；
- `sanitizeHtml()` 白名单清洗（内容来自模型，按不可信输入处理）：连内容删 `script/style/iframe/object/embed/svg/math/template/noscript/form/...`；标签白名单；`<a>` 只留 `http(s)` 且加 `rel="noreferrer noopener"`；剥事件属性与 `javascript:`；
- **丢掉 `<span>` 但保留文字** —— WB 会把中文**逐字**拆成 span，不去掉的话选中/复制会很别扭；
- 样式用同一套 dsh 主题 token（`--dsw-alias-*`），所以看起来像 dsh 自己的消息；
- **时机**：流式阶段仍是纯文本（增量拼接可靠），`done` 之后换富文本；打开历史会话后也会补一次。

接口：`GET /dsh-wb/domains/gui/rich`、`readRichViaGui()`、`sanitizeHtml()`。验收见 `_scratch/rich-test.mjs`（18/18）。

## 流式回传必须"锚定本次发送"（2026-10-08 修 bug）

**症状（用户报）**：WB 还没回答完，面板就弹出**上一个历史对话**的 WB 回复。

**根因**：`/send` 的轮询只取"界面上最后一条助手消息"，**不检查那是不是本次对话的**。WB 从旧会话切到新会话的空窗期（或新会话的消息还没渲染出来）时，轮询读到的就是上一段的回复，于是当成本次内容推给面板。

**修法**：`scriptReadAnchored(userText)` —— 从后往前找**我发出去的那条用户消息**在列表里的下标（锚点），只认锚点**之后**的助手消息；锚点还没出现就什么都不推（等待），超过阈值则明确报错。

**验收**（`_scratch/anchor-test.mjs`，6/6）：先打开「示例会话A」并**从它当前渲染出来的最后一条助手消息里取一段文字当探针**，再发一条新任务，断言流里绝不出现该探针。修好后事件序列是干净的：

```
start → newTask → sent → anchor → delta("正常") → done
```

**顺带发现的另一个坑**：WB 不只侧栏会话列表是虚拟滚动，**消息列表也是** —— 打开一段会话时只渲染底部若干条（实测同一段会话一次读到 7 条、一次读到 6 条）。所以：
- 断言用的特征词**不能硬编码**，必须从"当前实际渲染出来的内容"里取，否则会随渲染窗口漂移而误报；
- `wb_gui_read` 目前只返回**已渲染**的消息，长会话的历史正文可能看不全（要全量得滚动分段收集，尚未实现）。

## 连接控制：端口没了怎么办（2026-10-08 补）

**根因**：CDP 端口只在 **带 `--remote-debugging-port` 启动**时存在。WB 一旦被正常方式重启（点图标），端口就消失，面板完全无能为力 —— 这就是"我控制不了 CDP 连接"。

**两道保险**：

1. **让 WB 以后每次启动都自带端口**（已在本机执行）：改开始菜单快捷方式的启动参数。
   ```powershell
   $lnk = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\WorkBuddy.lnk"
   $ws = New-Object -ComObject WScript.Shell
   $sc = $ws.CreateShortcut($lnk)
   $sc.Arguments = "--remote-debugging-port=9223 --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling --disable-features=CalculateNativeWinOcclusion"
   $sc.Save()
   ```
   改前已备份为 `WorkBuddy.lnk.bak-dshsync`；还原：`Copy-Item "$lnk.bak-dshsync" "$lnk" -Force`。
   ⚠️ 代价：只要 WB 在跑，本机就有一个 CDP 端口开着（仅绑 127.0.0.1，局域网不可达，但本机进程可完全控制 WB）。

2. **面板/工具里一键重启**：`wb_gui_relaunch` 工具（需 `confirm:true`）或 `POST /dsh-wb/domains/gui/relaunch`；面板在「CDP 未连」时会显示「启动/重连 WB」按钮。
   它会：优雅关闭 → 无效则强制结束 → **用计划任务**带参数拉起（避免被 dsh 命令进程树带走）→ 等端口就绪（实测 **1232ms**）→ 删掉临时计划任务。

**连接速度**（宿主侧实测）：

| 场景 | 修复前 | 现在 |
|---|---|---|
| 冷连接（握手 + 拉 target + 首次求值） | 273 ms | **75 ms** |
| 复用连接 | — | **1–3 ms** |
| 开模型菜单读 21 个模型 | 6436 ms | **14–262 ms** |

宿主加载后还会**预热一次连接**（`warmupOnLoad`），面板第一次点就是热的。

## 性能与"WB 不渲染"的根因（2026-10-08 实测修复）

用户报三件事：CDP 连接慢、历史显示慢、**WB 的对话没有界面渲染**。实测查出三个独立根因。

### 根因一：WB 窗口最小化 → Chromium 停止重绘并节流（这就是"没渲染"）

实测 `document.hidden === true`、`visibilityState: "hidden"`、`outerWidth=237 outerHeight=39 screenX/Y=-32000` —— **窗口是最小化的**。
内容确实在 DOM 里（能读回消息），但窗口不画，看起来就是"没渲染"；同时一切点界面的操作都被拖慢。

- **CDP 恢复不了窗口**：Electron 不暴露 Browser 域（`Browser.getWindowForTarget` 报 `-32601`），`Page.bringToFront` 对最小化窗口无效（实测 `document.hidden` 仍为 true）。
- **解法**：Win32 `ShowWindowAsync(hwnd, 9)` + `SetForegroundWindow`（`restoreWorkbuddyWindow()`），并在 `sendViaComposer` / `openViaGui` 前自动调用（`ensureVisible()`）。面板会在窗口隐藏时提示并给「把 WB 窗口调出来」按钮。
- 想彻底不被节流，可用这些参数启动 WB：`--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling --disable-features=CalculateNativeWinOcclusion`。

### 根因二：每次操作都重新握手、每次轮询都新建连接

原来 `evaluateOnPage` / `withPage` 每次都 `GET /json/version` + `GET /json/list` + 新建 WebSocket；`/send` 轮询每 900 ms 又来一次全套。
**改为连接复用（12 秒窗口）+ 目标列表 TTL 缓存（10 秒）**，并把固定 `sleep` 换成**轮询到条件成立就返回**（`pollUntil`）。

| 操作 | 修复前 | 修复后 |
|---|---|---|
| 状态查询（含发现 target） | 85 ms | **23 ms** |
| 打开模型菜单读 21 个模型 | 6436 ms | **262 ms** |
| 打开一段历史并读到消息 | 4000 ms+（且常读到 0 条） | **327 ms（7 条）** |

### 根因三：会话列表虚拟滚动 + 分组收起 + 两种消息渲染器

- **滚错容器**：按 `scrollHeight` 排序会选中 `cr-message-list`（30605px！）而不是侧栏 `conversation-list-content`（630px）—— 结果把用户正在看的对话滚走了。**必须按类名限定侧栏，并排除 `.cr-message-list` 内的元素。**
- **分组默认收起**：侧栏「任务 (15)」只渲染 8 条，其余藏在 **`查看更多 (7)`** 后面。匹配式要能吃下带计数的写法，并排除标签栏里那个也叫"更多"的标签（`conversation-list-tab-button`）。
- **两种消息渲染器**：普通会话是 `.cr-self-message` / `.cr-markdown`；**产出过 artifact/文档的会话**（实测「投资」）用 `cr-frame__content` / `cr-document__virtual-item`，普通选择器读到 **0 条**（界面明明有 3994 字）。已加兜底。
- 末尾「共消耗 3.07 GLM-5.3-Flash …」是页脚不是消息，会被误当最后一条 → 已过滤。

### 另外两个坑

- **不要在页面里跑长 async**：2.6 秒的滚动循环会报 `CDP error -32000: Promise was collected`。改在 Node 侧一步步 evaluate。
- **连接复用会让进程不退出**：Node 内置 WebSocket **没有 `unref()`**，缓存连接会拖住事件循环（测试脚本因此"打印完不结束"）。靠空闲定时器关连接（12 秒）兜底，脚本里显式 `process.exit()`。

## 工具面（8 个）

| 工具 | 作用 |
|---|---|
| `wb_gui_status` | CDP 是否可达、页面 target、编辑器/发送按钮/当前模型/消息数（只读，不调模型） |
| `wb_gui_sessions` | 侧栏会话卡片（标题、时间、是否选中、索引） |
| `wb_gui_open` | 按标题或索引**点开**某个会话（界面里真的切过去） |
| `wb_gui_read` | 读当前会话的消息（user / assistant） |
| `wb_gui_send` | 在编辑器里打字并**点发送**（`dryRun` 只打字不发送） |
| `wb_gui_new_task` | 点「新建任务」拿一个干净编辑器 |
| `wb_gui_models` | 打开模型菜单，列出**每个模型的积分倍率**（只读，读完自动 Esc） |
| `wb_gui_set_model` | 按名称在模型菜单里选一个模型（面板与 WB 保持同一模型） |

## HTTP 路由（给面板的浏览器半区直接调用）

架构取舍：**插件之间不能跨包 import**（本机已实测），所以 `dsh-wb/domains/chat` 面板不能直接 import 本插件的代码。
解法是让本插件**自己暴露 HTTP 路由**，面板的浏览器半区用同源 `fetch` 调 —— 这样 CDP 逻辑全机只有一份，不必复制。

| 路由 | 作用 |
|---|---|
| `GET /dsh-wb/domains/gui/state` | CDP 状态 + 界面状态 |
| `GET /dsh-wb/domains/gui/sessions` | 会话卡片列表 |
| `GET /dsh-wb/domains/gui/read` | 读当前会话消息 |
| `GET /dsh-wb/domains/gui/models` | 模型清单（含积分倍率） |
| `POST /dsh-wb/domains/gui/model` | `{name}` 切换模型 |
| `POST /dsh-wb/domains/gui/new-task` | 点「新建任务」 |
| `POST /dsh-wb/domains/gui/open` | `{title}` 或 `{index}` 在界面里打开会话 |
| `POST /dsh-wb/domains/gui/send` | **SSE 流式发送**：`{text, model?, openTitle?, newTask?, pollMs?, idlePolls?, maxMs?}` |

`/send` 的事件：`start` →（`model` / `newTask` / `opened` 视参数）→ `sent` → `delta`+ / `replace` → `done`，异常走 `error`。

**为什么是"伪流式"**：驱动的是**别人的界面**，拿不到 token 级事件；只能按 `pollMs` 轮询消息列表，
把助手最后一条的增量当 `delta` 推出去（文本不再是前缀增长时改发 `replace` 整段替换），
连续 `idlePolls` 次无增长即判定结束。

## 积分模型（实测清单，2026-10-08）

WB 的模型菜单里每个模型都带**积分倍率**，倍率越低越省，`0x` 就是免费：

```
Hy3                    0.00x   ← 限时免费
GLM-5.3-Flash          0.06x
Space-Bunny            0.08x
Deepseek-V4.1-Flash    0.11x   ← 夜间折扣（当时 WB 默认用的就是它）
GLM-5.3-FlashX         0.14x
快速 / 均衡 / 极致      0.21x / 0.65x / 1.20x   ← Max 模式的档位
MiniMax-M3             0.25x
Hy4 preview            0.29x
Step-5-Preview         0.43x
Deepseek-V4-Pro        0.51x
Kimi-K2.6 / K2.7-Code / K2.8-Preview  0.52x / 0.57x / 0.77x
GLM-5.2 / GLM-5.1 / GLM-5.3           0.79x
GLM-5v-Turbo           0.71x
Kimi-K3                1.62x
```

菜单结构：`.cr-model-selector__menu`，模型行是 `.cr-model-selector__list` 下的**无 class div**，
文本形如 `Deepseek-V4.1-Flash 夜间折扣 0.11x`；前两项是 `Max 模式`（开关）与「配置自定义模型」，不是模型。
选完**标签刷新有延迟**（实测偶尔 900 ms 还没变），所以 `setModelViaGui` 会轮询最多约 4 s 再判定。

## 实测验收（2026-10-08，17/17）

```
PASS  注册了 6 个工具
PASS  准备: 界面已归位到干净编辑器
PASS  status: CDP 可达 / 找到输入框与发送按钮 / 报告当前模型
PASS  sessions: 列出会话卡片 / 每张卡有标题 / 打开后能标出选中态
PASS  open: 点开了「示例会话A」
PASS  read: 读到消息 / 有 user+assistant / 助手正文有实质内容
PASS  send(dryRun): 文字进了编辑器且发送按钮被点亮
PASS  new_task: 切到干净编辑器
PASS  真发: 消息已点击发送
PASS  真发: 界面里出现了助手回复
```

真发的证据（从 WB 界面读回）：

```
[user]      （CDP 探测文字）只回复两个字：正常。不要调用任何工具。
[assistant] 正常
```

并且 WB 侧栏自动出现了新会话「**确认CDP探测响应正常**」。

## 界面契约（实测选择器）

| 元素 | 选择器 |
|---|---|
| 编辑器 | `._editable_1198c_1` / `[contenteditable]`（**Slate.js**，空态时有 `[data-slate-placeholder]`） |
| 发送按钮 | `button.cr-send-button[aria-label="发送"]`（空输入时 disabled） |
| 模型 | `button.cr-model-selector__trigger`（aria 形如 `Select model: Deepseek-V4.1-Flash`） |
| 消息列表 | `.cr-message-list` |
| 用户消息 | `.cr-self-message` → `.cr-self-bubble` |
| 助手消息 | `.cr-markdown` |
| 会话卡片 | `div.cb-agent-card`，标题 `[class*="_title_"]`，选中 `_selected_` |

## 五个坑（都是实测踩出来的）

1. **UIA 读不到界面** —— 不是难，是**没接口**：WB 的 Chromium 无障碍树未激活，`AutomationElement` 只能看到一层 `Intermediate D3D Window`。也没有 `--remote-debugging-port` 时无 CDP。所以 GUI 自动化只有 CDP 这一条路。
2. **编辑器是 Slate.js，`execCommand('insertText')` 无效**：它会让 `innerText` 看起来有字，但 **Slate 的模型不更新**，发送按钮始终 disabled。必须用 **CDP 受信任输入事件**。
3. **正确输入三步**：① **真实鼠标点击**编辑器（`Input.dispatchMouseEvent`）聚焦 ② `Input.insertText` ③ **真实鼠标点击**发送按钮。`element.click()` 与 `focus()` 都不够。
4. **页面上有多个同类名编辑器节点**（隐藏的 hero 编辑器 + 当前会话的）→ 必须按「可见 + `contenteditable=true` + 面积」挑，否则会点到隐藏那个。
5. **「新建任务」首屏的编辑器是 readonly，点了才可编辑** → 顺序必须是**先点击、再检查** `contenteditable`，反了会误报"不可编辑"。另外**不要用 Ctrl+A/Delete 清空输入框**：那些按键会被应用快捷键吃掉，可能把编辑器整个切走。

## 安全（必须知道）

CDP 端口开着时，**本机任何程序都能完全控制 WB**：读你所有会话、替你发消息、点任何按钮。它只绑 `127.0.0.1`（局域网/手机访问不到），但本机进程无门槛。

- 关掉 WB、或下次**不带参数**启动，端口即消失。
- 别把带参数的启动方式写进快捷方式或开机自启长期开着。
- 用完后建议按正常方式重启一次 WB。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `cdpPort` | `9223` | 与启动 WB 时的 `--remote-debugging-port` 一致 |
| `connectTimeoutMs` / `evalTimeoutMs` / `httpTimeoutMs` | 15000 / 60000 / 4000 | 各类超时 |
| `readLimit` | `40` | `wb_gui_read` 默认返回条数 |
| `sendSettleMs` | `400` | 点发送后等待界面反应的毫秒数 |

## 已知限制

- **界面改版即失效**：所有选择器都是 UI 契约，WB 更新后可能全废（这是"驱动应用本体"的固有代价）。
- **只作用于当前可见的会话**：`read` 读的是界面上打开的那段；要读别的得先 `wb_gui_open`。
- **发送是异步的**：`wb_gui_send` 点完就返回，回复要靠 `wb_gui_read` 轮询。
- **不做删除/改名等破坏性操作**：只做了读、开、发、新建。
- **必须有人登录着桌面会话**：CDP 走的是渲染进程，锁屏/注销后不可用。
