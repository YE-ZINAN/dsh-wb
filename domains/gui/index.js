/**
 * dsh-wb-gui —— 通过 CDP 驱动 WorkBuddy 应用本体的工具面
 *
 * 与 dsh-wb-bridge（headless CLI）的区别：
 *   - bridge：起一个新进程跑 codebuddy -p，**WB 界面里看不到**
 *   - 本插件：驱动**已经开着的 WB 应用**，对话就发生在它的界面里（用它的账号额度、它的技能与记忆）
 *
 * 前提：WorkBuddy 必须以 `--remote-debugging-port=<port>` 启动。实测：
 *   Start-Process "<...>\WorkBuddy.exe" -ArgumentList "--remote-debugging-port=9223"
 *   没带参数启动时 `/json/list` 连不上，本插件会明确报错并给出该命令。
 */

import { execFile } from 'node:child_process';

import {
  SCRIPT_READ,
  SCRIPT_SESSIONS,
  SCRIPT_STATUS,
  cardFindExpression,
  cdpVersion,
  cleanupRelaunchTask,
  dropSession,
  ensureVisible,
  evaluateOnPage,
  getTargets,
  listModelsViaGui,
  listTargets,
  newTaskViaGui,
  openViaGui,
  readViaGui,
  readAnchoredViaGui,
  readRichViaGui,
  relaunchWorkbuddy,
  restoreWorkbuddyWindow,
  sendViaComposer,
  setModelViaGui,
  scriptOpen,
  uiVisibility,
  waitForCdp,
} from './wb-gui.js';

export const name = 'dsh-wb-gui';

/** tools 注册工具；webServer 暴露 HTTP 路由给 dsh-wb-chat 面板的浏览器半区直接调用。 */
export const inject = ['tools', 'webServer'];

const DEFAULTS = {
  enabled: true,
  /** CDP 端口（与启动 WB 时用的 --remote-debugging-port 一致）。 */
  cdpPort: 9223,
  /** 连 target 的超时。 */
  connectTimeoutMs: 15000,
  /** 页面内脚本执行超时。 */
  evalTimeoutMs: 60000,
  /** HTTP 探测超时。 */
  httpTimeoutMs: 4000,
  /** 读消息时最多返回几条。 */
  readLimit: 40,
  /** 发消息后等待界面反应的毫秒数。 */
  sendSettleMs: 400,
  /** HTTP 路由接收的消息体上限（面板走这条路）。 */
  maxMessageChars: 20000,
  /**
   * 发消息前若发现 WB 窗口最小化/隐藏，就把它恢复并前置。
   * 必要性：Chromium 对最小化/被遮挡窗口**停止重绘并节流** —— 内容在 DOM 里但窗口不画，
   * 看起来就是"WB 对话没有界面渲染"，而且所有点界面的操作都会变慢。
   */
  restoreWindowOnSend: true,
  /** 重启 WB 时用的可执行文件（留空则从正在运行的进程里取，再退回默认安装路径）。 */
  workbuddyExe: '',
  /** 重启 WB 时附加的参数（留空则用默认：调试端口 + 防窗口节流）。 */
  workbuddyFlags: '',
  /** 重启后等端口就绪的上限。 */
  relaunchWaitMs: 40000,
  /** 宿主加载后是否预热一次 CDP 连接（让面板首次操作就是热的）。 */
  warmupOnLoad: true,
};

const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
const OBJECT_OUTPUT = { type: 'object', additionalProperties: true };

const LAUNCH_HINT = 'WorkBuddy is not reachable over CDP. Start it with: Start-Process "<WorkBuddy.exe>" -ArgumentList "--remote-debugging-port=9223"';

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': body.length });
  res.end(body);
}

function readJson(req, limit) {
  return new Promise((resolve) => {
    let raw = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      raw += String(chunk);
      if (raw.length > limit) {
        tooLarge = true;
        raw = '';
      }
    });
    req.on('end', () => {
      if (tooLarge) return resolve({ ok: false, reason: `body too large (limit ${limit})` });
      try {
        resolve({ ok: true, value: raw ? JSON.parse(raw) : {} });
      } catch (error) {
        resolve({ ok: false, reason: `invalid JSON: ${String((error && error.message) || error)}` });
      }
    });
    req.on('error', () => resolve({ ok: false, reason: 'request stream error' }));
  });
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) };
  const register = (definition) => ctx.effect(() => ctx.tools.register(definition));

  /**
   * 探测 CDP 是否可用（走 TTL 缓存，不再每次操作都打两次 HTTP）。
   * force=true 时强制重新拉目标列表。
   */
  const probe = async (force) => {
    if (config.enabled === false) return { ok: false, reason: 'dsh-wb-gui is disabled by config' };
    try {
      const entry = await getTargets(config.cdpPort, config.httpTimeoutMs, force);
      const pages = entry.targets.filter((t) => t.type === 'page');
      const version = entry.version || {};
      return {
        ok: true,
        port: config.cdpPort,
        browser: version.Browser,
        userAgent: version['User-Agent'],
        pageCount: pages.length,
        pages: pages.map((t) => ({ title: t.title, url: String(t.url).slice(0, 120) })),
      };
    } catch (error) {
      return { ok: false, reason: String((error && error.message) || error), hint: LAUNCH_HINT, port: config.cdpPort };
    }
  };

  /**
   * 把最小化/隐藏的 WB 窗口恢复并前置（实现在 wb-gui.js，用 Win32 ShowWindowAsync）。
   * CDP 做不到：Electron 不暴露 Browser 域，Page.bringToFront 对最小化窗口无效。
   */
  const restoreWindow = (timeoutMs) => restoreWorkbuddyWindow(timeoutMs);

  /**
   * 预热：宿主加载后先在后台握一次手，让面板第一次操作就是热的（省掉约 270ms 的冷连接）。
   * 失败一律忽略 —— WB 没开是常态。
   */
  if (config.warmupOnLoad !== false) {
    const warm = setTimeout(() => {
      probe()
        .then((r) => (r.ok ? evaluateOnPage(config, 'document.title') : null))
        .catch(() => null);
    }, 1500);
    warm.unref?.();
    ctx.effect(() => () => clearTimeout(warm));
  }

  /* ------------------- HTTP 路由（给 dsh-wb-chat 面板的浏览器半区直接调） ------------------- */  const jsonRoute = (path, handler) =>
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          try {
            const out = await handler(req);
            sendJson(res, out.status || 200, out.body);
          } catch (error) {
            sendJson(res, 500, { error: String((error && error.message) || error) });
          }
        },
      }),
    );

  jsonRoute('/dsh-wb-gui/state', async () => {
    const started = Date.now();
    const base = await probe();
    const connectMs = Date.now() - started;
    if (!base.ok) return { body: { ...base, connectMs, canRelaunch: true } };
    const ui = await evaluateOnPage(config, SCRIPT_STATUS);
    let visibility = null;
    try {
      visibility = await uiVisibility(config);
    } catch {
      /* 可见性读不到不影响主流程 */
    }
    return { body: { ...base, connectMs, ui: ui.value, visibility, canRelaunch: true } };
  });

  /**
   * 带调试端口重启 WB。
   * 端口只在带参数启动时存在 —— WB 被正常方式重启后就连不上，而用户没法自己解决。
   * 这里给一个明确的控制入口：关掉 WB → 用计划任务带参数拉起 → 等端口可用。
   */
  jsonRoute('/dsh-wb-gui/relaunch', async (req) => {
    if (req.method !== 'POST') return { status: 405, body: { error: 'POST only' } };
    const parsed = await readJson(req, 4096);
    const body = (parsed && parsed.value) || {};
    const started = Date.now();
    dropSession(config.cdpPort);
    const relaunch = await relaunchWorkbuddy({
      port: config.cdpPort,
      exe: config.workbuddyExe,
      flags: config.workbuddyFlags,
    });
    if (!relaunch.ok) return { body: { ...relaunch, tookMs: Date.now() - started } };
    const waited = await waitForCdp(config.cdpPort, config.relaunchWaitMs || 40000, config.httpTimeoutMs);
    await cleanupRelaunchTask(relaunch.taskName);
    const after = waited.ok ? await probe(true) : { ok: false };
    return {
      body: {
        ...relaunch,
        ...waited,
        ok: Boolean(waited.ok),
        tookMs: Date.now() - started,
        state: after,
        reason: waited.ok ? undefined : `端口 ${config.cdpPort} 在 ${waited.waitedMs}ms 内未就绪`,
      },
    };
  });

  jsonRoute('/dsh-wb-gui/focus', async (req) => {
    if (req.method !== 'POST') return { status: 405, body: { error: 'POST only' } };
    const base = await probe();
    if (!base.ok) return { body: base };
    const before = await uiVisibility(config).catch(() => null);
    const restored = await restoreWindow();
    await new Promise((r) => setTimeout(r, 500));
    const after = await uiVisibility(config).catch(() => null);
    return { body: { ...base, restored, before, after, visible: after ? after.hidden === false : null } };
  });

  jsonRoute('/dsh-wb-gui/sessions', async () => {
    const base = await probe();
    if (!base.ok) return { body: base };
    const ui = await evaluateOnPage(config, SCRIPT_SESSIONS);
    return { body: { ...base, ...(ui.value || {}) } };
  });

  jsonRoute('/dsh-wb-gui/read', async () => {
    const base = await probe();
    if (!base.ok) return { body: base };
    const r = await readViaGui(config);
    return { body: { ...base, ...(r || {}) } };
  });

  jsonRoute('/dsh-wb-gui/rich', async () => {
    const base = await probe();
    if (!base.ok) return { body: base };
    const r = await readRichViaGui(config);
    return { body: { ...base, ...(r || {}) } };
  });

  jsonRoute('/dsh-wb-gui/models', async () => {
    const base = await probe();
    if (!base.ok) return { body: base };
    const r = await listModelsViaGui(config);
    return { body: { ...base, ...r } };
  });

  jsonRoute('/dsh-wb-gui/model', async (req) => {
    if (req.method !== 'POST') return { status: 405, body: { error: 'POST only' } };
    const parsed = await readJson(req, 8192);
    if (!parsed.ok) return { status: 400, body: { error: parsed.reason } };
    const base = await probe();
    if (!base.ok) return { body: base };
    const r = await setModelViaGui(config, parsed.value && parsed.value.name);
    return { body: { ...base, ...r } };
  });

  jsonRoute('/dsh-wb-gui/new-task', async (req) => {
    if (req.method !== 'POST') return { status: 405, body: { error: 'POST only' } };
    const base = await probe();
    if (!base.ok) return { body: base };
    const r = await newTaskViaGui(config);
    return { body: { ...base, ...r } };
  });

  jsonRoute('/dsh-wb-gui/open', async (req) => {
    if (req.method !== 'POST') return { status: 405, body: { error: 'POST only' } };
    const parsed = await readJson(req, 8192);
    if (!parsed.ok) return { status: 400, body: { error: parsed.reason } };
    const base = await probe();
    if (!base.ok) return { body: base };
    const body = parsed.value || {};
    const by = typeof body.index === 'number' ? { index: body.index } : { title: body.title };
    if (by.title !== undefined && !by.title) return { status: 400, body: { error: 'title or index is required' } };
    const r = await openViaGui(config, by);
    return { body: { ...base, ...(r || {}) } };
  });

  /**
   * 流式发送：POST /dsh-wb-gui/send  → text/event-stream
   * 事件：start / model / opened / sent / delta / replace / done / error
   *
   * 为什么是"轮询式伪流式"：驱动的是**别人的界面**，拿不到 token 级事件；
   * 只能按 pollMs 轮询消息列表，把助手最后一条的增量当 delta 推出去。
   */
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-wb-gui/send',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' });
          res.end();
          return;
        }
        const parsed = await readJson(req, Math.max(4096, config.maxMessageChars || 20000));
        if (!parsed.ok) {
          sendJson(res, 400, { error: parsed.reason });
          return;
        }
        const body = parsed.value || {};
        const text = String(body.text || '').trim();
        if (!text) {
          sendJson(res, 400, { error: 'text is required' });
          return;
        }
        const base = await probe();
        if (!base.ok) {
          sendJson(res, 503, base);
          return;
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        let closed = false;
        const write = (event, data) => {
          if (closed || res.writableEnded) return;
          try {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          } catch {
            closed = true;
          }
        };
        req.on('close', () => {
          closed = true;
        });

        const pollMs = Math.max(300, Number(body.pollMs) || 900);
        const idlePolls = Math.max(1, Number(body.idlePolls) || 5);
        const maxMs = Math.max(5000, Number(body.maxMs) || 600000);

        try {
          write('start', { port: config.cdpPort, transport: 'gui', text: text.slice(0, 120) });

          // 窗口最小化/隐藏 → 界面不重绘、且点界面会被节流。发之前先把它调出来。
          if (config.restoreWindowOnSend !== false && body.restoreWindow !== false) {
            try {
              const vis = await uiVisibility(config);
              if (vis && vis.hidden === true) {
                const restored = await restoreWindow();
                await sleep(500);
                const after = await uiVisibility(config).catch(() => null);
                write('window', { wasHidden: true, minimized: vis.minimized === true, restored, visibleNow: after ? after.hidden === false : null });
              } else {
                write('window', { wasHidden: false, visibleNow: true });
              }
            } catch (error) {
              write('window', { wasHidden: null, error: String((error && error.message) || error) });
            }
          }

          if (body.model) {
            const m = await setModelViaGui(config, body.model);
            write('model', m);
          }
          if (body.newTask) {
            const nt = await newTaskViaGui(config);
            write('newTask', nt);
          } else if (typeof body.index === 'number' || (typeof body.openTitle === 'string' && body.openTitle)) {
            const by = typeof body.index === 'number' ? { index: body.index } : { title: body.openTitle };
            const op = await openViaGui(config, by);
            write('opened', { clickedTitle: op && op.clickedTitle, total: op && op.total, ok: op && op.ok });
          }

          const sent = await sendViaComposer(config, text, { submit: true, settleMs: body.settleMs });
          write('sent', sent);
          if (!sent.ok) {
            write('error', { message: sent.reason, detail: sent });
            write('done', { ok: false, text: '' });
            res.end();
            return;
          }

          // 轮询助手回复。
          // ⚠️ 必须用**锚点**读取：只取"界面最后一条助手消息"会在 WB 切换会话的空窗期
          // 读到上一段历史对话的回复，表现为"没回答完就弹出上一个历史对话的内容"。
          let last = '';
          let idle = 0;
          let anchored = false;
          let sawAnchorPolls = 0;
          const started = Date.now();
          while (!closed && Date.now() - started < maxMs) {
            await sleep(pollMs);
            const r = await readAnchoredViaGui(config, text);
            const msgs = (r && r.messages) || [];
            if (!r || r.ok === false || r.anchor < 0) {
              // 我发的那条还没出现在界面里（正在切会话）——**什么都不推**，等锚点
              sawAnchorPolls += 1;
              idle += 1;
              if (!anchored && sawAnchorPolls >= Math.max(8, idlePolls * 2)) {
                write('error', { message: '发送后界面上一直没出现这条消息，无法定位回复（可能被应用拒收或切走了）' });
                break;
              }
              continue;
            }
            if (!anchored) {
              anchored = true;
              write('anchor', { selectedTitle: r.selectedTitle, anchor: r.anchor, total: r.total });
            }
            // 只认锚点之后的助手消息
            const after = msgs.slice(r.anchor + 1).filter((m) => m.role === 'assistant');
            const now = after.length ? String(after[after.length - 1].text || '') : '';
            if (now.length > last.length && now.startsWith(last)) {
              write('delta', { text: now.slice(last.length) });
              last = now;
              idle = 0;
            } else if (now && now !== last) {
              write('replace', { text: now });
              last = now;
              idle = 0;
            } else {
              idle += 1;
              if (last && idle >= idlePolls) break;
            }
          }
          write('done', { ok: true, text: last, durationMs: Date.now() - started, stopped: closed ? 'client-closed' : 'idle' });
        } catch (error) {
          write('error', { message: String((error && error.message) || error) });
          write('done', { ok: false, text: '' });
        }
        if (!res.writableEnded) res.end();
      },
    }),
  );

  register({
    name: 'wb_gui_status',
    description:
      'Check whether the WorkBuddy app is reachable over CDP and inspect its UI state: page target, composer (contenteditable), send button, current model, and whether a conversation is open. Read-only, no model call.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => text(value) },
    execute: async () => {
      const base = await probe();
      if (!base.ok) return base;
      try {
        const ui = await evaluateOnPage(config, SCRIPT_STATUS);
        return { ...base, ui: ui.value };
      } catch (error) {
        return { ...base, ui: { error: String((error && error.message) || error) } };
      }
    },
  });

  register({
    name: 'wb_gui_sessions',
    description:
      'List the conversation cards shown in the WorkBuddy sidebar (title, time, selected state, and index for wb_gui_open). Read-only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => text(value) },
    execute: async () => {
      const base = await probe();
      if (!base.ok) return base;
      try {
        const ui = await evaluateOnPage(config, SCRIPT_SESSIONS);
        return { ...base, ...(ui.value || {}) };
      } catch (error) {
        return { ...base, ok: false, reason: String((error && error.message) || error) };
      }
    },
  });

  register({
    name: 'wb_gui_open',
    description:
      'Open a WorkBuddy conversation in the app UI by title (exact or substring) or by index from wb_gui_sessions. This clicks the real UI, so the conversation becomes visible in WorkBuddy.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Conversation title (exact match preferred, substring allowed).' },
        index: { type: 'number', description: 'Zero-based index from wb_gui_sessions; used when title is omitted.' },
      },
      additionalProperties: false,
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => text(value) },
    execute: async (args) => {
      const base = await probe();
      if (!base.ok) return base;
      const by = args && typeof args.index === 'number' ? { index: args.index } : { title: (args && args.title) || '' };
      if (by.title !== undefined && !by.title) return { ok: false, reason: 'title or index is required' };
      try {
        const ui = await evaluateOnPage(config, scriptOpen(cardFindExpression(by)));
        return { ...base, requested: by, ...(ui.value || {}) };
      } catch (error) {
        return { ...base, ok: false, reason: String((error && error.message) || error) };
      }
    },
  });

  register({
    name: 'wb_gui_read',
    description:
      'Read the messages of the currently open WorkBuddy conversation straight from the app UI (user bubbles and assistant markdown). Read-only.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'How many of the most recent messages to return (default 40).' } },
      additionalProperties: false,
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => text(value) },
    execute: async (args) => {
      const base = await probe();
      if (!base.ok) return base;
      try {
        const ui = await evaluateOnPage(config, SCRIPT_READ);
        const value = ui.value || {};
        if (!value.ok) return { ...base, ...value };
        const limit = Math.max(1, Math.min(Number((args && args.limit) || config.readLimit), 200));
        return { ...base, total: value.total, timeTips: value.timeTips, returned: Math.min(limit, value.messages.length), messages: value.messages.slice(-limit) };
      } catch (error) {
        return { ...base, ok: false, reason: String((error && error.message) || error) };
      }
    },
  });

  register({
    name: 'wb_gui_send',
    description:
      "Type a message into the WorkBuddy composer and click Send, so the request runs inside the app itself (visible in WorkBuddy, billed to the app's own account). Uses trusted CDP input events (real mouse click to focus + Input.insertText) because the composer is a Slate editor that ignores execCommand. Returns right after clicking Send; poll with wb_gui_read for the reply.",
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message to send.' },
        dryRun: { type: 'boolean', description: 'Type into the composer but do not click Send.' },
        settleMs: { type: 'number', description: 'How long to wait after clicking Send before reporting (default 400ms).' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => text(value) },
    execute: async (args) => {
      const base = await probe();
      if (!base.ok) return base;
      const body = String((args && args.text) || '');
      if (!body.trim()) return { ok: false, reason: 'text is required' };
      try {
        const result = await sendViaComposer(config, body, {
          submit: !(args && args.dryRun),
          settleMs: (args && args.settleMs) || config.sendSettleMs,
        });
        return { ...base, ...result };
      } catch (error) {
        return { ...base, ok: false, reason: String((error && error.message) || error) };
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `在 WB 界面里发送：${String((args && args.text) || '').slice(0, 60)}`,
      kind: 'other',
      rawInput: { dryRun: Boolean(args && args.dryRun) },
    }),
  });

  register({
    name: 'wb_gui_new_task',
    description:
      'Click "新建任务" in the WorkBuddy UI to get a fresh, empty composer (useful when the composer disappeared or you do not want to continue an existing conversation). Returns the resulting composer state.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => text(value) },
    execute: async () => {
      const base = await probe();
      if (!base.ok) return base;
      try {
        const result = await newTaskViaGui(config);
        return { ...base, ...result };
      } catch (error) {
        return { ...base, ok: false, reason: String((error && error.message) || error) };
      }
    },
  });

  register({
    name: 'wb_gui_relaunch',
    description:
      'Restart WorkBuddy with the CDP debug port (and anti-throttling flags) when the port is missing. This CLOSES the running WorkBuddy (sessions are persisted to disk), then relaunches it via a scheduled task so it survives this command, and waits until the port answers. Use when wb_gui_status reports the port is unreachable.',
    parameters: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'Must be true: this closes the running WorkBuddy app.' },
      },
      additionalProperties: false,
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => text(value) },
    execute: async (args) => {
      if (!args || args.confirm !== true) {
        return { ok: false, reason: 'confirm:true is required — this closes the running WorkBuddy app' };
      }
      const already = await probe(true);
      dropSession(config.cdpPort);
      const relaunch = await relaunchWorkbuddy({ port: config.cdpPort, exe: config.workbuddyExe, flags: config.workbuddyFlags });
      if (!relaunch.ok) return { ...relaunch, alreadyReachable: already.ok };
      const waited = await waitForCdp(config.cdpPort, config.relaunchWaitMs, config.httpTimeoutMs);
      await cleanupRelaunchTask(relaunch.taskName);
      const after = waited.ok ? await probe(true) : { ok: false, reason: 'port did not become ready' };
      return { ...relaunch, alreadyReachable: already.ok, ...waited, ok: Boolean(waited.ok), state: after };
    },
  });

  register({
    name: 'wb_gui_models',
    description:
      'Open the WorkBuddy model menu and list every model with its credit multiplier (积分倍率). Read-only: the menu is closed with Escape afterwards and no setting is changed.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => text(value) },
    execute: async () => {
      const base = await probe();
      if (!base.ok) return base;
      try {
        const r = await listModelsViaGui(config);
        return { ...base, ...r };
      } catch (error) {
        return { ...base, ok: false, reason: String((error && error.message) || error) };
      }
    },
  });

  register({
    name: 'wb_gui_set_model',
    description:
      'Pick a model in the WorkBuddy model menu by name (substring match, case-insensitive). This changes the model used by the app UI, so the panel and the app stay on the same model (and the same credit multiplier).',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Model name, e.g. "GLM-5.3-Flash", "Hy3", "Deepseek-V4.1-Flash".' } },
      required: ['name'],
      additionalProperties: false,
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => text(value) },
    execute: async (args) => {
      const base = await probe();
      if (!base.ok) return base;
      try {
        const r = await setModelViaGui(config, args && args.name);
        return { ...base, ...r };
      } catch (error) {
        return { ...base, ok: false, reason: String((error && error.message) || error) };
      }
    },
  });
}
