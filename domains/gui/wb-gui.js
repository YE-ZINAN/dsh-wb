/**
 * wb-gui.js —— 通过 CDP（Chrome DevTools Protocol）驱动 WorkBuddy 应用本体
 *
 * 前提：WorkBuddy 以 `--remote-debugging-port=<port>` 启动（否则没有可连的 target）。
 * 实测（2026-10-08，WorkBuddy 5.7.6 / Chrome 138 / Electron 37）：
 *   - target 名 `WorkBuddy`，url `file:///.../app.asar/renderer/index.html?...`
 *   - 输入框 `[contenteditable="true"]._editable_*`（**不是 textarea**）
 *   - 发送按钮 `button.cr-send-button[aria-label="发送"]`，空输入时 disabled
 *   - 消息列表 `.cr-message-list`；用户消息 `.cr-self-message`；助手正文 `.cr-markdown`
 *   - 会话卡片 `div.cb-agent-card`，标题在 `._title_*`
 *
 * 为什么走 CDP 而不是 UIA：本机 WB 的 Chromium 无障碍树**没有被激活**（UIA 只能看到一层
 * D3D 面板），也没有 CDP-less 的其它接口。CDP 是唯一能真读真写界面的通道。
 *
 * ⚠️ 风险：CDP 端口开着时，**本机任何程序**都能完全控制 WB。它只绑 127.0.0.1（局域网不可达），
 * 但本机进程可达。用完请关掉（或下次不带参数启动）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

/* --------------------------- CDP 连接 --------------------------- */

/** 拿一个可用的 WebSocket 实现：Node 22+ 有内置 WebSocket；缺了再退回 `ws` 包。 */
async function getWebSocketImpl() {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket;
  try {
    const mod = await import('ws');
    return mod.WebSocket || mod.default;
  } catch (error) {
    throw new Error(`no WebSocket implementation available (globalThis.WebSocket missing and 'ws' not importable): ${String((error && error.message) || error)}`);
  }
}

export async function listTargets(port, timeoutMs) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(Math.max(500, Number(timeoutMs) || 4000)) });
  if (!res.ok) throw new Error(`CDP http ${res.status}`);
  return res.json();
}

export async function cdpVersion(port, timeoutMs) {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(Math.max(500, Number(timeoutMs) || 4000)) });
  if (!res.ok) throw new Error(`CDP http ${res.status}`);
  return res.json();
}

/** 连到一个 target，返回 send(method, params) 与 close()。 */
export async function connectCdp(wsUrl, timeoutMs) {
  const WebSocketImpl = await getWebSocketImpl();
  const budget = Math.max(1000, Number(timeoutMs) || 15000);
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocketImpl(wsUrl);
    } catch (error) {
      reject(new Error(`websocket construct failed: ${String((error && error.message) || error)}`));
      return;
    }
    const pending = new Map();
    let id = 0;
    const handle = { wsUrl, dead: false, send: null, close: null };
    const failAll = (reason) => {
      handle.dead = true;
      for (const { rej } of pending.values()) rej(new Error(reason));
      pending.clear();
    };
    const timer = setTimeout(() => {
      handle.dead = true;
      reject(new Error('CDP connect timeout'));
    }, budget);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      // 别让这个套接字拖住事件循环（否则宿主/测试会因为"还有活句柄"而不退出）
      try {
        ws.unref?.();
      } catch {
        /* 某些实现没有 unref，由空闲关闭定时器兜底 */
      }
      handle.send = (method, params, callTimeoutMs) => {
        if (handle.dead) return Promise.reject(new Error('CDP connection is dead'));
        const msgId = ++id;
        try {
          ws.send(JSON.stringify({ id: msgId, method, params: params || {} }));
        } catch (error) {
          return Promise.reject(new Error(`CDP send failed: ${String((error && error.message) || error)}`));
        }
        return new Promise((res, rej) => {
          pending.set(msgId, { res, rej });
          setTimeout(() => {
            if (pending.has(msgId)) {
              pending.delete(msgId);
              rej(new Error(`CDP timeout: ${method}`));
            }
          }, Math.max(2000, Number(callTimeoutMs) || 30000));
        });
      };
      handle.close = () => {
        handle.dead = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      };
      resolve(handle);
    });
    ws.addEventListener('close', () => failAll('CDP websocket closed'));
    ws.addEventListener('error', (e) => {
      clearTimeout(timer);
      handle.dead = true;
      reject(new Error(`CDP ws error: ${(e && e.message) || 'unknown'}`));
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
        else res(msg.result);
      }
    });
    ws.addEventListener('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`CDP ws error: ${(e && e.message) || 'unknown'}`));
    });
  });
}

/* ------------- 连接复用与目标缓存（性能关键：别每次操作都重新握手 + 拉目标列表） ------------- */

const targetCache = new Map(); // port -> { ts, targets, version }
const connCache = new Map(); // port -> { wsUrl, handle, ts }

const TARGET_TTL_MS = 10000;
/**
 * 连接复用窗口。取 12 秒：一个对话回合里的轮询（900ms 一次）全程复用同一条连接，
 * 跨回合重握手只有约 8ms，代价可忽略；而留太久会让"还有活句柄"拖住短命脚本退出
 * （内置 WebSocket 没有 unref）。
 */
const CONN_TTL_MS = 12000;

/** 取 CDP 版本与目标列表（带 TTL 缓存）；force=true 强制刷新。 */
export async function getTargets(port, timeoutMs, force) {
  const now = Date.now();
  const hit = targetCache.get(port);
  if (!force && hit && now - hit.ts < TARGET_TTL_MS) return hit;
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(Math.max(500, Number(timeoutMs) || 4000)) });
  if (!res.ok) throw new Error(`CDP http ${res.status}`);
  const targets = await res.json();
  let version = hit && hit.version;
  if (!version) {
    version = await cdpVersion(port, timeoutMs);
  }
  const entry = { ts: now, targets, version, fromCache: false };
  targetCache.set(port, entry);
  return entry;
}

/**
 * 取（可复用的）页面连接。
 * 复用条件：同一个 wsUrl、连接没死、45 秒内用过。失败时丢弃缓存并重建一次。
 */
export async function getSession(config, opts) {
  const port = Number(config && config.cdpPort) || 9223;
  const timeout = config && config.httpTimeoutMs;
  const wantTitle = opts && opts.targetTitle;
  const pick = (entry, label) => {
    const pages = entry.targets.filter((t) => t.type === 'page');
    if (!pages.length) throw new Error(`no CDP page target ${label}(is WorkBuddy running with --remote-debugging-port?)`);
    return (wantTitle && pages.find((t) => String(t.title).includes(wantTitle))) || pages[0];
  };
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let entry;
    try {
      entry = await getTargets(port, timeout, attempt > 0);
    } catch (error) {
      lastError = error;
      if (attempt === 1) throw error;
      continue;
    }
    const page = pick(entry, attempt > 0 ? '(after refresh) ' : '');
    const cached = connCache.get(port);
    if (cached && !cached.handle.dead && cached.wsUrl === page.webSocketDebuggerUrl && Date.now() - cached.ts < CONN_TTL_MS) {
      cached.ts = Date.now();
      return { handle: cached.handle, page, version: entry.version, reused: true };
    }
    if (cached) {
      try {
        cached.handle.close();
      } catch {
        /* ignore */
      }
      connCache.delete(port);
    }
    try {
      const handle = await connectCdp(page.webSocketDebuggerUrl, config && config.connectTimeoutMs);
      connCache.set(port, { wsUrl: page.webSocketDebuggerUrl, handle, ts: Date.now() });
      // 空闲一段时间后自动关闭缓存连接（unref 的定时器，不阻止进程退出）
      const idle = setTimeout(() => {
        const cur = connCache.get(port);
        if (cur && cur.handle === handle && Date.now() - cur.ts >= CONN_TTL_MS) dropSession(port);
      }, CONN_TTL_MS + 1000);
      idle.unref?.();
      return { handle, page, version: entry.version, reused: false };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('CDP session unavailable');
}

/** 主动丢弃缓存连接（出错、或需要重建时用）。 */
export function dropSession(port) {
  targetCache.delete(port);
  const cached = connCache.get(port);
  if (cached) {
    try {
      cached.handle.close();
    } catch {
      /* ignore */
    }
  }
  connCache.delete(port);
}

/** 在页面里跑一段 JS 并把结果按值取回（复用连接）。 */
export async function evaluateOnPage(config, expression, opts) {
  const port = Number(config && config.cdpPort) || 9223;
  const session = await getSession(config, opts);
  try {
    const result = await session.handle.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      config && config.evalTimeoutMs,
    );
    if (result && result.exceptionDetails) {
      const ex = result.exceptionDetails;
      throw new Error(`page exception: ${(ex.exception && ex.exception.description) || ex.text}`);
    }
    return { value: result && result.result ? result.result.value : undefined, target: { title: session.page.title, url: session.page.url }, reused: session.reused };
  } catch (error) {
    dropSession(port);
    throw error;
  }
}

/* --------------------------- 页面内脚本 --------------------------- */

const CLEAN = 'const clean=(s)=>String(s||"").replace(/\\s+/g," ").trim();';

export const SCRIPT_STATUS = `(() => {
  ${CLEAN}
  const ed = document.querySelector('._editable_1198c_1, [contenteditable="true"]');
  const send = document.querySelector('button.cr-send-button');
  const modelBtn = document.querySelector('button.cr-model-selector__trigger');
  const list = document.querySelector('.cr-message-list');
  return {
    title: document.title,
    url: location.href.slice(0, 120),
    composerFound: Boolean(ed),
    composerEditable: ed ? ed.getAttribute('contenteditable') : null,
    composerEmpty: ed ? Boolean(ed.querySelector('[data-slate-placeholder]')) : null,
    composerHint: ed ? clean(ed.innerText).slice(0, 60) : null,
    sendButtonFound: Boolean(send),
    sendDisabled: send ? send.disabled : null,
    model: modelBtn ? (modelBtn.getAttribute('aria-label') || clean(modelBtn.innerText)).slice(0, 60) : null,
    messageListFound: Boolean(list),
    visibleMessages: list ? list.querySelectorAll('.cr-self-message, .cr-markdown').length : 0,
    bodyHead: clean(document.body.innerText).slice(0, 160),
  };
})()`;

export const SCRIPT_SESSIONS = `(() => {
  ${CLEAN}
  const cards = [...document.querySelectorAll('div.cb-agent-card')].filter((e) => e.offsetParent);
  const items = cards.map((c, i) => {
    const t = c.querySelector('[class*="_title_"]');
    const h = c.querySelector('[class*="_header_"]');
    return {
      index: i,
      title: clean(t ? t.innerText : c.innerText).slice(0, 80),
      meta: clean(h ? h.innerText : '').slice(0, 60),
      selected: /_selected_/.test(String(c.className)),
      status: /has-status/.test(String(c.className)) ? 'running/done' : '',
    };
  });
  return { ok: true, count: items.length, items };
})()`;

/**
 * 点开某个会话卡片。**只负责点**，等待逻辑交给 Node 侧轮询（见 openViaGui）——
 * 之前的页面内轮询会在"旧会话内容还没被换掉"时就提前退出（实测 1311ms 就 break，
 * 但那时 .cr-message-list 里还是上一段会话的消息），导致随后读消息读到 0 条。
 */
export function scriptOpen(cardExpression) {
  return `(async () => {
    ${CLEAN}
    const card = ${cardExpression};
    if (!card) return { ok: false, reason: 'session card not found' };
    const t = card.querySelector('[class*="_title_"]');
    const title = clean(t ? t.innerText : card.innerText);
    card.click();
    return { ok: true, clickedTitle: title, clickedAt: Date.now() };
  })()`;
}

/**
 * 读「当前选中的会话标题 + 消息数」。
 * 用它做等待判据：既要选中的卡片变成目标会话，又要有消息，还要连续两次读数稳定
 * （渲染是分步的：先切卡片、再填消息）。
 */
export const SCRIPT_SELECTED_STATE = `(() => {
  ${CLEAN}
  const cards = [...document.querySelectorAll('div.cb-agent-card')].filter((e) => e.offsetParent);
  const sel = cards.find((c) => /_selected_/.test(String(c.className)));
  const titleEl = sel ? sel.querySelector('[class*="_title_"]') : null;
  const list = document.querySelector('.cr-message-list');
  const nodes = list ? [...list.querySelectorAll('.cr-self-message, .cr-markdown')] : [];
  // ⚠️ 必须按**有文字的**节点计数：虚拟滚动下消息节点会先出现、文字后绘制，
  // 只数节点会让"等待判据"提前成立，随后读消息读到 0 条（实测示例会话A 是 7 节点 0 文字）。
  const withText = nodes.filter((n) => clean(n.innerText));
  return {
    selectedTitle: sel ? clean(titleEl ? titleEl.innerText : sel.innerText).slice(0, 80) : null,
    count: withText.length,
    nodeCount: nodes.length,
    userCount: list ? [...list.querySelectorAll('.cr-self-message')].filter((n) => clean(n.innerText)).length : 0,
    hidden: document.hidden,
    empty: withText.length === 0,
  };
})()`;

/** 按标题（精确或包含）或序号找卡片。 */
export function cardFindExpression(by) {
  const finder = `[...document.querySelectorAll('div.cb-agent-card')].filter((e) => e.offsetParent)`;
  if (typeof by.index === 'number') return `${finder}[${by.index}]`;
  const needle = JSON.stringify(String(by.title || ''));
  return `(${finder}.find((c) => { const t = c.querySelector('[class*="_title_"]'); const s = String((t ? t.innerText : c.innerText) || '').trim(); return s === ${needle} || s.includes(${needle}); }) || null)`;
}

/**
 * 会话列表的滚动控制（**在 Node 侧一步步驱动**）。
 * ⚠️ 只认**侧栏**容器：不能按 scrollHeight 排序 —— 实测那样会选中 `cr-message-list`
 * （消息列表，30605px），结果把用户正在看的对话滚走了，而侧栏纹丝不动。
 * 也不在页面里跑长 async：那会报 `CDP error -32000: Promise was collected`。
 */
export const SCRIPT_SCROLL_LIST = `((arg) => {
  const isMessageList = (e) => e.closest('.cr-message-list') !== null;
  const containers = [...document.querySelectorAll('*')].filter((e) =>
    e.offsetParent && !isMessageList(e) && e.clientHeight > 100 && e.scrollHeight > e.clientHeight + 20 &&
    /conversation-list|conversation-list-content|collapsible|sidebar/i.test(String(e.className)));
  containers.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
  const sc = containers[0];
  if (!sc) return { ok: false, reason: 'sidebar list scroller not found' };
  if (arg && arg.reset) sc.scrollTop = 0;
  else sc.scrollTop = Math.min(sc.scrollTop + (arg && arg.step ? arg.step : Math.max(80, Math.floor(sc.clientHeight * 0.85))), sc.scrollHeight);
  return {
    ok: true,
    cls: String(sc.className).slice(0, 60),
    scrollTop: sc.scrollTop,
    scrollHeight: sc.scrollHeight,
    clientHeight: sc.clientHeight,
    atEnd: sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2,
  };
})`;

/** 把消息列表滚回底部（误滚之后恢复现场用）。 */
export const SCRIPT_MESSAGE_LIST_TO_BOTTOM = `(() => {
  const list = document.querySelector('.cr-message-list');
  if (!list) return { ok: false };
  list.scrollTop = list.scrollHeight;
  return { ok: true, scrollTop: list.scrollTop, scrollHeight: list.scrollHeight };
})`;

/**
 * 侧栏的「查看更多 (n)」控件（会话分组默认收起，实测"任务(15)"只渲染 8 条，其余 7 条在"查看更多 (7)"后面）。
 * ⚠️ 匹配式必须吃下 "查看更多 (7)" 这种带计数的写法；并且要**排除标签栏**的
 * `conversation-list-tab-button`（那里也有个叫"更多"的标签，会把点击引到别的页面）。
 */
export const SCRIPT_EXPAND_BUTTONS = `(() => {
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const wanted = /^(展开|更多|显示更多|查看更多|查看全部|全部|展开全部)(\\s*\\(\\s*\\d+\\s*\\))?$/;
  const hits = [...document.querySelectorAll('button,div,span,a')]
    .filter((e) => e.offsetParent && !e.closest('.conversation-list-tab-button') && e.children.length <= 2 && wanted.test(clean(e.innerText)))
    .map((e) => { const r = e.getBoundingClientRect(); return { text: clean(e.innerText), tag: e.tagName, cls: String(e.className).slice(0, 50), rect: { x: r.x, y: r.y, w: r.width, h: r.height } }; })
    .filter((h) => h.rect.w > 10 && h.rect.h > 8);
  return { count: hits.length, hits: hits.slice(0, 6) };
})()`;

/** 同步查卡片在不在 DOM 里（配合滚动用）。 */
export function cardProbeExpression(by) {
  const finder = `[...document.querySelectorAll('div.cb-agent-card')].filter((e) => e.offsetParent)`;
  if (typeof by.index === 'number') {
    return `(() => { const c = ${finder}[${by.index}]; if (!c) return { found: false }; const t = c.querySelector('[class*="_title_"]'); return { found: true, title: String((t || c).innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80), rect: (() => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })() }; })()`;
  }
  const needle = JSON.stringify(String(by.title || ''));
  return `(() => {
    const c = (${finder}.find((el) => { const t = el.querySelector('[class*="_title_"]'); const s = String((t ? t.innerText : el.innerText) || '').trim(); return s === ${needle} || s.includes(${needle}); }) || null);
    if (!c) return { found: false };
    const t = c.querySelector('[class*="_title_"]');
    const r = c.getBoundingClientRect();
    return { found: true, title: String((t || c).innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80), rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
  })()`;
}

export const SCRIPT_READ = `(() => {
  ${CLEAN}
  const list = document.querySelector('.cr-message-list');
  if (!list) return { ok: false, reason: '.cr-message-list not found (is a conversation open?)' };
  const nodes = [...list.querySelectorAll('.cr-self-message, .cr-markdown')];
  const messages = [];
  for (const n of nodes) {
    const isUser = n.classList.contains('cr-self-message');
    // 用户气泡里可能也嵌了 markdown 容器，避免重复计入
    if (!isUser && n.closest('.cr-self-message')) continue;
    const text = clean(n.innerText);
    if (!text) continue;
    messages.push({ role: isUser ? 'user' : 'assistant', text: text.slice(0, 4000) });
  }
  // 兜底：有些会话（产出过 artifact / 文档的）不是普通气泡渲染，而是
  // cr-frame__content + cr-document__virtual-item —— 实测「投资」那段就是这样，
  // 用普通选择器会读到 0 条，界面明明有 3994 个字。
  if (messages.length === 0) {
    const frames = [...list.querySelectorAll('.cr-frame__content, .cr-document__virtual-item')].filter((e) => clean(e.innerText));
    for (const f of frames) messages.push({ role: 'assistant', text: clean(f.innerText).slice(0, 4000), kind: 'frame' });
  }
  if (messages.length === 0 && clean(list.innerText)) {
    messages.push({ role: 'assistant', text: clean(list.innerText).slice(0, 4000), kind: 'raw-list' });
  }
  // 页脚（"共消耗 3.07 GLM-5.3-Flash 昨天 17:38"）不是消息，会被当成最后一条误导人。
  // 用不锚定的正则 + 长度上限：锚定开头会漏（前面夹了别的字符，实测漏过一条）。
  const isUsageFooter = (t) => t.length <= 90 && /共消耗\\s*[\\d.]+\\s*\\S+/.test(t);
  const cleaned = messages.filter((m) => !isUsageFooter(String(m.text)));
  const tips = [...list.querySelectorAll('[class*="_message_time_tip_"]')].map((e) => clean(e.innerText)).slice(-5);
  return {
    ok: true,
    total: cleaned.length,
    timeTips: tips,
    messages: cleaned,
    droppedFooters: messages.length - cleaned.length,
    renderer: cleaned.length && cleaned[0].kind ? cleaned[0].kind : 'bubbles',
  };
})()`;

/* --------------------------- 复合操作（需要一次连接里连发多条 CDP 命令） --------------------------- */

/**
 * 用一个（复用的）页面连接执行一段复合操作。
 * handle.evaluate(expr) / handle.click(x,y) / handle.insertText(s) / handle.key() / handle.pressEscape()
 * ⚠️ 不再每次操作都重新握手、也不在结束时关闭连接 —— 连接按 CONN_TTL_MS 复用（这是"连接很慢"的主因之一）。
 */
export async function withPage(config, fn) {
  const port = Number(config && config.cdpPort) || 9223;
  const session = await getSession(config);
  const conn = session.handle;
  const handle = {
    target: { title: session.page.title, url: session.page.url },
    reused: session.reused,
    async evaluate(expression) {
      const r = await conn.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, config && config.evalTimeoutMs);
      if (r && r.exceptionDetails) {
        const ex = r.exceptionDetails;
        throw new Error(`page exception: ${(ex.exception && ex.exception.description) || ex.text}`);
      }
      return r && r.result ? r.result.value : undefined;
    },
    async click(x, y) {
      // 合并成一次 moved+pressed+released：少发两条命令，界面上看起来一样
      await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    },
    async insertText(value) {
      await conn.send('Input.insertText', { text: String(value) });
    },
    async key(key, code, vk) {
      await conn.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: vk, key, code });
      await conn.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: vk, key, code });
    },
    async pressEscape() {
      await conn.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
      await conn.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
    },
  };
  try {
    return await fn(handle);
  } catch (error) {
    // 连接层面的失败就丢弃缓存连接，下次重建
    if (/CDP (timeout|websocket closed|connection is dead)|send failed/.test(String((error && error.message) || ''))) dropSession(port);
    throw error;
  }
}

/** 轮询直到 predicate(value) 为真，或超时；返回最后一次的值。 */
export async function pollUntil(handle, expression, predicate, opts) {
  const interval = Math.max(60, Number((opts && opts.intervalMs) || 150));
  const deadline = Date.now() + Math.max(300, Number((opts && opts.maxWaitMs) || 4000));
  let last = null;
  for (;;) {
    last = await handle.evaluate(expression);
    if (predicate(last)) return { value: last, waitedMs: Date.now() - (deadline - Math.max(300, Number((opts && opts.maxWaitMs) || 4000))), timedOut: false };
    if (Date.now() >= deadline) return { value: last, waitedMs: Date.now() - (deadline - Math.max(300, Number((opts && opts.maxWaitMs) || 4000))), timedOut: true };
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * 编辑器状态。**页面上可能存在多个同类名节点**（隐藏的 hero 编辑器 + 当前会话的编辑器），
 * 所以这里枚举所有候选，优先取「可见 + contenteditable=true + 面积最大」的那个。
 * Slate 的空态判据：内部只有一个 data-slate-placeholder 子节点。
 */
export const SCRIPT_COMPOSER = `(() => {
  ${CLEAN}
  const nodes = [...document.querySelectorAll('._editable_1198c_1, [contenteditable]')];
  const cands = nodes
    .map((e) => {
      const r = e.getBoundingClientRect();
      return { e, ce: e.getAttribute('contenteditable'), vis: Boolean(e.offsetParent), w: r.width, h: r.height, r };
    })
    .filter((c) => c.w > 40 && c.h > 10);
  cands.sort((a, b) => {
    const score = (c) => (c.ce === 'true' ? 2 : 0) + (c.vis ? 1 : 0) + Math.min(c.w * c.h / 100000, 0.5);
    return score(b) - score(a);
  });
  const ed = cands.length ? cands[0].e : null;
  const btn = [...document.querySelectorAll('button.cr-send-button')].filter((b) => b.offsetParent)[0] || null;
  const r = ed ? ed.getBoundingClientRect() : null;
  const br = btn ? btn.getBoundingClientRect() : null;
  const empty = ed ? Boolean(ed.querySelector('[data-slate-placeholder]')) : null;
  return {
    found: Boolean(ed),
    candidates: cands.length,
    candidateAttrs: cands.map((c) => ({ ce: c.ce, vis: c.vis, w: Math.round(c.w), h: Math.round(c.h) })).slice(0, 5),
    contentEditable: ed ? ed.getAttribute('contenteditable') : null,
    empty,
    text: ed ? clean(ed.innerText).slice(0, 200) : null,
    rect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
    sendFound: Boolean(btn),
    sendDisabled: btn ? btn.disabled : null,
    sendRect: br ? { x: br.x, y: br.y, w: br.width, h: br.height } : null,
    hidden: document.hidden,
    visibility: document.visibilityState,
  };
})()`;

/**
 * 在 WB 的真实界面里发一条消息。
 *
 * ⚠️ 教训（2026-10-08 实测）：编辑器是 **Slate.js**，
 *   `document.execCommand('insertText')` 会让 innerText 看起来有字，但 **Slate 的模型不更新**，
 *   发送按钮始终 disabled —— 必须用 **CDP 受信任输入事件**：
 *   ① 真实鼠标点击编辑器聚焦 ② `Input.insertText` ③ 真实鼠标点击发送按钮。
 *   另外**不要**用 Ctrl+A/Delete 清空输入框：那些按键会被应用快捷键吃掉，可能把编辑器切走。
 */
export async function sendViaComposer(config, value, options) {
  const submit = !(options && options.submit === false);
  // 最小化时渲染被节流，先确保窗口可见（否则界面既不画也点不准）
  const visibility = await ensureVisible(config, { skip: options && options.skipEnsureVisible });
  return withPage(config, async (h) => {
    const st = await h.evaluate(SCRIPT_COMPOSER);
    if (!st || !st.found) {
      return {
        ok: false,
        reason: 'composer not found (the app may have switched views)',
        hint: '点一下「新建任务」或某个会话，让编辑器回来；也可用 wb_gui_open / wb_gui_sessions',
      };
    }

    // 先点一下编辑器：WB 在某些画面（如「新建任务」首屏）里编辑器是 readonly，
    // **点了才变成可编辑** —— 所以顺序必须是"先点击、再检查"，反过来会误报不可编辑。
    if (st.rect) await h.click(st.rect.x + st.rect.w / 2, st.rect.y + st.rect.h / 2);

    // 轮询到可编辑为止（窗口被节流时 300ms 远远不够，但通常 150ms 内就好）
    const focusedRes = await pollUntil(h, SCRIPT_COMPOSER, (v) => v && v.contentEditable === 'true', { intervalMs: 120, maxWaitMs: 2500 });
    const focused = focusedRes.value;
    if (!focused || focused.contentEditable !== 'true') {
      return {
        ok: false,
        reason: `editor still not editable after clicking (contenteditable=${focused && focused.contentEditable})`,
        state: { found: focused && focused.found, contentEditable: focused && focused.contentEditable, text: focused && focused.text, sendFound: focused && focused.sendFound },
        hint: '确认 WB 界面没有在流式输出中、也不是某个只读视图',
      };
    }

    await h.insertText(value);

    // 轮询到发送按钮点亮（Slate 模型更新后才 enable）
    const typedRes = await pollUntil(h, SCRIPT_COMPOSER, (v) => v && v.sendDisabled === false, { intervalMs: 120, maxWaitMs: 3000 });
    const typed = typedRes.value;
    const receipt = {
      typedText: typed && typed.text,
      empty: typed && typed.empty,
      sendFound: typed && typed.sendFound,
      sendDisabled: typed && typed.sendDisabled,
      typeWaitMs: typedRes.waitedMs,
    };

    if (!typed || typed.sendDisabled !== false) {
      return { ok: false, reason: 'send button still disabled after typing (Slate did not register the input)', ...receipt };
    }
    if (!submit) return { ok: true, submitted: false, ...receipt, note: 'text sits in the composer, not sent' };

    await h.click(typed.sendRect.x + typed.sendRect.w / 2, typed.sendRect.y + typed.sendRect.h / 2);
    // 轮询到编辑器清空（= 消息已提交出去），最多等 settle 上限
    const settled = await pollUntil(
      h,
      `(() => {
        const ed = document.querySelector('._editable_1198c_1, [contenteditable="true"]');
        const list = document.querySelector('.cr-message-list');
        return {
          composerAfter: ed ? String(ed.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80) : null,
          composerEmpty: ed ? Boolean(ed.querySelector('[data-slate-placeholder]')) : null,
          userMessages: list ? list.querySelectorAll('.cr-self-message').length : null,
          hidden: document.hidden,
        };
      })()`,
      (v) => v && (v.composerEmpty === true || v.userMessages > (receipt.typedText ? 0 : 0)),
      { intervalMs: 150, maxWaitMs: Math.max(400, Number((options && options.settleMs) || config.sendSettleMs) || 1200) },
    );

    return { ok: true, submitted: true, ...receipt, ...(settled.value || {}), settleWaitMs: settled.waitedMs, visibility };
  });
}

/** 点「新建任务」拿一个干净的编辑器（轮询到编辑器可用，而不是死等）。 */
export async function newTaskViaGui(config) {
  return withPage(config, async (h) => {
    const clicked = await h.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].filter((x) => x.offsetParent && /新建任务/.test(x.innerText || ''))[0];
      if (!b) return { ok: false, reason: 'new-task button not found' };
      b.click();
      return { ok: true, label: String(b.innerText || '').replace(/\\s+/g, ' ').trim() };
    })()`);
    const st = await pollUntil(h, SCRIPT_COMPOSER, (v) => v && v.found === true, { intervalMs: 120, maxWaitMs: 3000 });
    const c = st.value || {};
    return { ...clicked, waitedMs: st.waitedMs, hidden: c.hidden, composer: { found: c.found, empty: c.empty, sendDisabled: c.sendDisabled } };
  });
}

/* --------------------------- 模型（积分倍率） --------------------------- */

export const SCRIPT_MODEL_TRIGGER = `(() => {
  const b = document.querySelector('button.cr-model-selector__trigger');
  if (!b || !b.offsetParent) return { found: false };
  const r = b.getBoundingClientRect();
  return {
    found: true,
    label: String(b.getAttribute('aria-label') || b.innerText || '').replace(/\\s+/g, ' ').trim(),
    rect: { x: r.x, y: r.y, w: r.width, h: r.height },
  };
})()`;

/**
 * 读模型菜单。结构（实测）：菜单 `.cr-model-selector__menu`，
 * 模型行是 `.cr-model-selector__list` 下的**无 class div**，文本形如
 * `Deepseek-V4.1-Flash 夜间折扣 0.11x`（名称 + 标签 + **积分倍率**）。
 * 前两项是 `Max 模式`（开关）与「配置自定义模型」，不是模型。
 */
export const SCRIPT_MODEL_ROWS = `(() => {
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const list = document.querySelector('.cr-model-selector__list');
  if (!list) return { open: false, rows: [] };
  const badgeWords = ['夜间免费', '限时免费', '夜间折扣', '订阅优先', '免费'];
  const rows = [...list.children].map((el, i) => {
    const label = clean(el.innerText);
    const m = label.match(/([\\d.]+)\\s*x\\s*$/i);
    const multiplier = m ? Number(m[1]) : null;
    let name = m ? label.slice(0, m.index).trim() : label;
    for (const w of badgeWords) name = name.replace(w, ' ').trim();
    const r = el.getBoundingClientRect();
    return {
      index: i,
      label,
      name,
      multiplier,
      badge: label.replace(name, '').replace(m ? m[0] : '', '').trim(),
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    };
  }).filter((x) => x.label);
  return { open: true, count: rows.length, rows };
})()`;

/** 打开模型菜单读一遍，然后 Esc 关掉（不改动任何设置）。带 TTL 缓存，避免面板每次挂载都开一遍菜单。 */
let modelCache = { ts: 0, value: null };
export const MODEL_CACHE_TTL_MS = 60000;

export async function listModelsViaGui(config, opts) {
  const force = !!(opts && opts.force);
  if (!force && modelCache.value && Date.now() - modelCache.ts < MODEL_CACHE_TTL_MS) {
    return { ...modelCache.value, cached: true, ageMs: Date.now() - modelCache.ts };
  }
  const result = await withPage(config, async (h) => {
    const tr = await h.evaluate(SCRIPT_MODEL_TRIGGER);
    if (!tr.found) return { ok: false, reason: 'model selector trigger not found (open a composer first)' };
    await h.click(tr.rect.x + tr.rect.w / 2, tr.rect.y + tr.rect.h / 2);
    // 轮询到菜单行出现，而不是死等固定时间
    const rowsRes = await pollUntil(h, SCRIPT_MODEL_ROWS, (v) => v && v.open === true && v.count > 0, { intervalMs: 120, maxWaitMs: 4000 });
    const menu = rowsRes.value || { open: false, rows: [] };
    const current = await h.evaluate(SCRIPT_MODEL_TRIGGER);
    await h.pressEscape();
    return {
      ok: menu.open === true,
      current: current.label || null,
      count: menu.count || 0,
      models: menu.rows || [],
      openWaitMs: rowsRes.waitedMs,
    };
  });
  if (result && result.ok) modelCache = { ts: Date.now(), value: result };
  return result;
}

/** 在模型菜单里选一个模型（按名称包含匹配，忽略大小写）。 */
export async function setModelViaGui(config, wanted) {
  const needle = String(wanted || '').trim();
  if (!needle) return { ok: false, reason: 'model name is required' };
  const result = await withPage(config, async (h) => {
    const before = await h.evaluate(SCRIPT_MODEL_TRIGGER);
    if (!before.found) return { ok: false, reason: 'model selector trigger not found' };
    await h.click(before.rect.x + before.rect.w / 2, before.rect.y + before.rect.h / 2);
    const rowsRes = await pollUntil(h, SCRIPT_MODEL_ROWS, (v) => v && v.open === true && v.count > 0, { intervalMs: 120, maxWaitMs: 4000 });
    const menu = rowsRes.value || { open: false, rows: [] };
    if (!menu.open) return { ok: false, reason: 'model menu did not open' };
    const lower = needle.toLowerCase();
    const hit = (menu.rows || []).find((r) => String(r.name).toLowerCase() === lower) || (menu.rows || []).find((r) => String(r.name).toLowerCase().includes(lower));
    if (!hit) {
      await h.pressEscape();
      return { ok: false, reason: `model not found: ${needle}`, available: (menu.rows || []).map((r) => r.name) };
    }
    await h.click(hit.rect.x + hit.rect.w / 2, hit.rect.y + hit.rect.h / 2);
    // 标签刷新有延迟：轮询到变化为止
    const afterRes = await pollUntil(h, SCRIPT_MODEL_TRIGGER, (v) => v && v.label !== before.label, { intervalMs: 250, maxWaitMs: 4000 });
    const after = afterRes.value || { label: before.label };
    await h.pressEscape();
    const changed = before.label !== after.label;
    return {
      ok: true,
      requested: needle,
      picked: hit.name,
      multiplier: hit.multiplier,
      before: before.label,
      after: after.label,
      changed,
      switchWaitMs: afterRes.waitedMs,
      note: changed ? undefined : 'trigger label did not change within ~4s (the model may still have switched)',
    };
  });
  if (result && result.ok) modelCache = { ts: 0, value: null }; // 变了，缓存作废
  return result;
}

/**
 * 带**锚点**的读取：额外返回「我发出去的那条用户消息」在列表里的下标。
 *
 * ⚠️ 为什么必须要锚点：`/send` 的轮询若只取"界面上最后一条助手消息"，
 * 在 WB 从旧会话切到新会话的空窗期会读到**上一段历史对话的回复**，
 * 于是面板"还没回答完就弹出上一个历史对话的内容"（用户报的 bug）。
 * 只认锚点之后的助手消息，就与"当前是哪段对话"解耦。
 */
export function scriptReadAnchored(userText) {
  const raw = String(userText || '').replace(/\s+/g, ' ').trim();
  const needle = JSON.stringify(raw.slice(0, 24));
  return `(() => {
    ${CLEAN}
    const list = document.querySelector('.cr-message-list');
    if (!list) return { ok: false, reason: '.cr-message-list not found' };
    const cards = [...document.querySelectorAll('div.cb-agent-card')].filter((e) => e.offsetParent);
    const sel = cards.find((c) => /_selected_/.test(String(c.className)));
    const titleEl = sel ? sel.querySelector('[class*="_title_"]') : null;
    const selectedTitle = sel ? clean(titleEl ? titleEl.innerText : sel.innerText).slice(0, 80) : null;
    const nodes = [...list.querySelectorAll('.cr-self-message, .cr-markdown')];
    const messages = [];
    for (const n of nodes) {
      const isUser = n.classList.contains('cr-self-message');
      if (!isUser && n.closest('.cr-self-message')) continue;
      const text = clean(n.innerText);
      if (!text) continue;
      // WB 会把自动生成的会话标题渲染进消息区，瞬时被当成助手回复（实测流里出现过 "用户"）。
      // 两种丢弃：与会话标题完全相同；或是标题的**短前缀**（标题由用户消息生成，短前缀基本就是它的碎片）。
      // 只作用于助手消息 —— **绝不动用户消息**，否则锚点会丢。
      if (!isUser && selectedTitle) {
        if (text === selectedTitle && text.length <= 60) continue;
        if (text.length < 6 && selectedTitle.startsWith(text) && text !== selectedTitle) continue;
      }
      // 页脚（"共消耗 3.07 GLM-5.3-Flash 昨天 17:38"）不是消息。用不锚定的正则：
      // 前面可能还夹着别的小字符，锚定 ^ 会漏（实测漏过一条）。
      if (!isUser && text.length <= 90 && /共消耗\s*[\d.]+\s*\S+/.test(text)) continue;
      messages.push({ role: isUser ? 'user' : 'assistant', text: text.slice(0, 4000) });
    }
    const needle = ${needle};
    let anchor = -1;
    if (needle) {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].role !== 'user') continue;
        if (clean(messages[i].text).slice(0, needle.length) === needle) { anchor = i; break; }
      }
    }
    return {
      ok: true,
      selectedTitle,
      anchor,
      total: messages.length,
      userCount: messages.filter((m) => m.role === 'user').length,
      messages,
      hidden: document.hidden,
    };
  })()`;
}

/** 带锚点读取（供 /send 轮询用）。 */
export async function readAnchoredViaGui(config, userText) {
  return withPage(config, async (h) => {
    const r = await h.evaluate(scriptReadAnchored(userText));
    return r || { ok: false, reason: 'no result' };
  });
}

/* --------------------------- 富文本：保留 WB 自己的渲染 --------------------------- */

/**
 * 读当前会话的**富文本**版本：保留每条消息的 innerHTML。
 *
 * 为什么这样而不是复用 dsh 的会话渲染器：dsh 客户端只给插件暴露
 * `ctx / React / host / styles / console`（实测 Builtin 目录），会话渲染器是内部视图包、
 * 需要会话上下文，且属私有 API（升级即废）。而 **WB 自己的 `.cr-markdown` 就是真 HTML**
 * （实测含 `<p>/<strong>/<ul>/<li>`…），直接保留它反而与 WB 界面所见一致。
 *
 * ⚠️ WB 会把中文拆成逐字 `<span>`，所以渲染前**必须丢掉 span 标签**（保留文字），
 * 否则每个字一个节点、选中与复制都会很别扭。这件事在 sanitizeHtml 里做。
 */
export const SCRIPT_READ_RICH = `(() => {
  ${CLEAN}
  const list = document.querySelector('.cr-message-list');
  if (!list) return { ok: false, reason: '.cr-message-list not found' };
  const nodes = [...list.querySelectorAll('.cr-self-message, .cr-markdown')];
  const messages = [];
  for (const n of nodes) {
    const isUser = n.classList.contains('cr-self-message');
    if (!isUser && n.closest('.cr-self-message')) continue;
    const text = clean(n.innerText);
    if (!text) continue;
    messages.push({ role: isUser ? 'user' : 'assistant', text: text.slice(0, 4000), html: String(n.innerHTML || '').slice(0, 20000) });
  }
  if (messages.length === 0) {
    const frames = [...list.querySelectorAll('.cr-frame__content, .cr-document__virtual-item')].filter((e) => clean(e.innerText));
    for (const f of frames) messages.push({ role: 'assistant', text: clean(f.innerText).slice(0, 4000), html: String(f.innerHTML || '').slice(0, 20000), kind: 'frame' });
  }
  const tips = [...list.querySelectorAll('[class*="_message_time_tip_"]')].map((e) => clean(e.innerText)).slice(-5);
  return { ok: true, total: messages.length, timeTips: tips, messages };
})()`;

const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'code', 'pre', 'ul', 'ol', 'li',
  'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'hr', 'a', 'sup', 'sub', 'div',
]);
// 连内容一起删掉的危险容器
const DROP_WITH_CONTENT = ['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'noscript', 'form', 'select', 'textarea', 'link', 'meta'];

/**
 * 白名单清洗 WB 抓来的 HTML。
 * WB 的内容是**模型输出**，必须当不可信输入处理：剥掉脚本/事件属性/危险 URL。
 * 面板用 dangerouslySetInnerHTML 渲染，所以这里必须干净。
 */
export function sanitizeHtml(input) {
  let s = String(input || '');
  for (const tag of DROP_WITH_CONTENT) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
    s = s.replace(new RegExp(`<\\/?${tag}\\b[^>]*\\/?>`, 'gi'), '');
  }
  // 逐标签过滤：白名单外的标签直接去掉（保留其文字）；span 也去掉 —— WB 用它把中文逐字拆开
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g, (match, rawTag, attrs) => {
    const tag = String(rawTag).toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return '';
    if (match.startsWith('</')) return `</${tag}>`;
    if (tag === 'a') {
      const m = /href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs || '');
      const url = m ? m[2] || m[3] || '' : '';
      if (/^https?:\/\//i.test(url)) return `<a href="${url.replace(/"/g, '&quot;')}" target="_blank" rel="noreferrer noopener">`;
      return '<a>';
    }
    return `<${tag}>`;
  });
  // 保险：残留的事件处理器与伪协议
  s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/(javascript|data|vbscript)\s*:/gi, '');
  return s.trim();
}

/** 读富文本（给面板"流完再上样式"用）。 */
export async function readRichViaGui(config) {
  return withPage(config, async (h) => {
    const r = await h.evaluate(SCRIPT_READ_RICH);
    if (!r || !r.ok) return r || { ok: false, reason: 'no result' };
    return {
      ...r,
      messages: (r.messages || []).map((m) => ({
        role: m.role,
        text: m.text,
        html: m.role === 'assistant' ? sanitizeHtml(m.html) : null,
        kind: m.kind,
      })),
    };
  });
}

/** 结构化读消息（给面板轮询用）。 */
export async function readViaGui(config) {
  return withPage(config, async (h) => {
    let r = await h.evaluate(SCRIPT_READ);
    // 虚拟滚动下会出现"消息节点已在、文字还没绘制" → 读到 0 条。
    // 短暂重试，别把渲染抖动当成"这段对话是空的"。
    // 只在"列表找到了但没有消息"时重试；新任务首屏（列表都没有）不重试，免得白等。
    const emptyButOpen = (v) => v && v.ok === true && (v.messages || []).length === 0;
    for (let i = 0; i < 8 && emptyButOpen(r); i += 1) {
      await new Promise((res) => setTimeout(res, 180));
      r = await h.evaluate(SCRIPT_READ);
    }
    return r || { ok: false, reason: 'no result' };
  });
}

/** 按标题/索引点开一个会话（在真实界面里切过去），**同一个连接里**把消息也读回来。 */
export async function openViaGui(config, by) {
  // 窗口最小化时渲染被节流，常导致"点开了但读不到消息" —— 先恢复窗口
  const visibility = await ensureVisible(config);
  const budget = Number((config && config.openWaitMs) || 15000);
  return withPage(config, async (h) => {
    const expr = cardFindExpression(by);
    const probeExpr = cardProbeExpression(by);

    // 先直接找；找不到就先点「展开」（分组默认收起），再滚到顶、逐屏下滚
    const scrollExpr = (arg) => `(${SCRIPT_SCROLL_LIST})(${JSON.stringify(arg || {})})`;
    let found = await h.evaluate(probeExpr);
    let scrollSteps = 0;
    let expanded = null;
    if (!found || !found.found) {
      // 分组收起时老了会话根本不在 DOM 里 —— 先尝试点「展开/更多」
      const btns = await h.evaluate(SCRIPT_EXPAND_BUTTONS).catch(() => null);
      if (btns && btns.count > 0) {
        expanded = [];
        for (const b of btns.hits) {
          await h.click(b.rect.x + b.rect.w / 2, b.rect.y + b.rect.h / 2).catch(() => null);
          expanded.push(b.text);
          await new Promise((r) => setTimeout(r, 250));
        }
        found = await h.evaluate(probeExpr);
      }
    }
    if (!found || !found.found) {
      await h.evaluate(scrollExpr({ reset: true }));
      for (let i = 0; i < 20; i += 1) {
        const sc = await h.evaluate(scrollExpr({}));
        scrollSteps += 1;
        await new Promise((r) => setTimeout(r, 140));
        found = await h.evaluate(probeExpr);
        if (found && found.found) break;
        if (!sc || sc.ok === false || sc.atEnd === true) break;
      }
    }
    if (!found || !found.found) {
      return { ok: false, reason: 'session card not found (also after scrolling the list)', scrollSteps, visibility };
    }

    const clicked = await h.evaluate(scriptOpen(expr));
    if (!clicked || !clicked.ok) return { ...(clicked || { ok: false, reason: 'open failed' }), visibility };
    clicked.scrollSteps = scrollSteps;
    clicked.scrolled = scrollSteps > 0;

    // 等待判据：选中的卡片换成目标会话 **且** 有消息 **且** 连续两次读数稳定
    const wantTitle = String(clicked.clickedTitle || '').slice(0, 80);
    const started = Date.now();
    let prev = -1;
    let stable = 0;
    let last = null;
    let timedOut = true;
    while (Date.now() - started < budget) {
      last = await h.evaluate(SCRIPT_SELECTED_STATE);
      const onTarget = !wantTitle || (last && last.selectedTitle && last.selectedTitle.includes(wantTitle.slice(0, 12)));
      if (onTarget && last && last.count > 0) {
        stable = last.count === prev ? stable + 1 : 0;
        prev = last.count;
        if (stable >= 1) {
          timedOut = false;
          break;
        }
      } else {
        stable = 0;
        prev = last ? last.count : -1;
      }
      await new Promise((r) => setTimeout(r, 180));
    }

    const list = await h.evaluate(SCRIPT_READ);
    const messages = (list && list.messages) || [];
    return {
      ...clicked,
      waitMs: Date.now() - started,
      timedOut,
      selectedTitle: last && last.selectedTitle,
      messageCount: last && last.count,
      messages,
      total: messages.length,
      visibility,
      hidden: (list && list.hidden) || (last && last.hidden) || null,
    };
  });
}

/** 界面可见性（隐藏/最小化时 Chromium 会停止重绘并节流，这是"WB 没渲染"的根因）。 */
export async function uiVisibility(config) {
  return withPage(config, async (h) => {
    const v = await h.evaluate(`(() => ({
      hidden: document.hidden,
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      screenX: window.screenX,
      screenY: window.screenY,
      minimized: window.outerWidth <= 400 && window.outerHeight <= 100 && window.screenX <= -30000,
    }))()`);
    return v || { hidden: null };
  });
}

/* --------------------------- Win32 辅助（走临时 .ps1，避免引号地狱） --------------------------- */

/**
 * 跑一段 PowerShell。
 * ⚠️ **必须写临时 .ps1 再 `-File` 执行**：把长脚本拼成一个 `-Command` 参数时，
 * 里面 `'"' + $exe + '"'` 这类内嵌引号会被解析器搞坏（实测报
 * `The string is missing the terminator`），`-File` 不受影响。
 */
function runPowerShell(script, timeoutMs) {
  const file = path.join(os.tmpdir(), `dsh-wb-gui-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`);
  return new Promise((resolve) => {
    try {
      fs.writeFileSync(file, `$ErrorActionPreference = 'Continue'\n${script}\n`, 'utf8');
    } catch (error) {
      resolve({ ok: false, reason: `cannot write temp script: ${String((error && error.message) || error)}` });
      return;
    }
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { timeout: Math.max(5000, Number(timeoutMs) || 30000) },
      (error, stdout) => {
        try {
          fs.unlinkSync(file);
        } catch {
          /* 留着无害 */
        }
        const text = String(stdout || '').trim();
        const line = text.split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop();
        if (!line) {
          resolve({ ok: false, reason: String((error && error.message) || 'no output'), raw: text.slice(0, 300) });
          return;
        }
        try {
          resolve(JSON.parse(line));
        } catch {
          resolve({ ok: false, reason: 'unparsable powershell output', raw: text.slice(0, 300) });
        }
      },
    );
  });
}

/**
 * 把最小化/隐藏的 WB 窗口恢复并前置。
 * CDP 做不到：Electron 不暴露 Browser 域（实测 `Browser.getWindowForTarget` 报 -32601），
 * `Page.bringToFront` 对最小化窗口也无效（实测 document.hidden 仍为 true）。只能用 Win32。
 * 必要性：最小化/被遮挡时 Chromium **停止重绘并节流**，内容在 DOM 里但窗口不画，
 * 表现为"WB 对话没有界面渲染"，而且点界面的操作会异常慢。
 */
export function restoreWorkbuddyWindow(timeoutMs) {
  const script = [
    "$sig = '[DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);'",
    '$t = Add-Type -MemberDefinition $sig -Name WbWin -Namespace WbGui -PassThru',
    '$p = Get-Process WorkBuddy -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
    'if (-not $p) { Write-Output \'{"ok":false,"reason":"no WorkBuddy window"}\'; exit }',
    '$h = $p.MainWindowHandle',
    '$r1 = $t::ShowWindowAsync($h, 9)',
    'Start-Sleep -Milliseconds 250',
    '$r2 = $t::SetForegroundWindow($h)',
    // ⚠️ 必须用 ConvertTo-Json：手拼字符串会把 PowerShell 的 True/False 写进去，
    // 而 `True` 不是合法 JSON → 调用方解析失败、白报一次"调出失败"（实测踩过）。
    '$out = [ordered]@{ ok = $true; pid = $p.Id; show = [bool]$r1; foreground = [bool]$r2 }',
    'Write-Output ($out | ConvertTo-Json -Compress)',
  ].join('\n');
  return runPowerShell(script, Math.max(3000, timeoutMs || 8000));
}

/**
 * 带调试端口重启 WorkBuddy。
 *
 * 为什么需要它：CDP 端口只在**带 `--remote-debugging-port` 启动**时存在。
 * WB 一旦被正常方式重启（点图标），端口就没了，面板这边完全无能为力
 * —— 这就是"我控制不了 CDP 连接"的根源。
 *
 * 关键点：
 *   - 关闭：先 CloseMainWindow（优雅），无效再 Stop-Process（WB 常缩到托盘，优雅多半无效）
 *   - 启动：**必须用计划任务**，否则进程挂在 dsh 的命令进程树下，命令一结束就被杀
 *   - 顺带带上防节流参数，最小化时也不停止重绘
 */
export async function relaunchWorkbuddy(opts) {
  const port = Number((opts && opts.port) || 9223);
  const flags =
    (opts && opts.flags) ||
    [
      `--remote-debugging-port=${port}`,
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-features=CalculateNativeWinOcclusion',
    ].join(' ');
  const taskName = (opts && opts.taskName) || 'dsh-wb-relaunch';
  // 从当前用户目录推导默认安装位置，不写死用户名（换机器/公开仓库都能用）
  const defaultExe = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'WorkBuddy', 'WorkBuddy.exe');
  const fallbackExe = (opts && opts.exe) || defaultExe;
  const script = [
    `$flags = '${flags}'`,
    `$fallback = '${fallbackExe}'`,
    "$p = Get-Process WorkBuddy -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1",
    '$exe = $fallback',
    'if ($p -and $p.Path) { $exe = $p.Path }',
    'if (-not (Test-Path $exe)) { Write-Output \'{"ok":false,"reason":"WorkBuddy.exe not found"}\'; exit }',
    '$wasRunning = [bool](Get-Process WorkBuddy -ErrorAction SilentlyContinue)',
    'Get-Process WorkBuddy -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }',
    'Start-Sleep -Milliseconds 1200',
    '$left = Get-Process WorkBuddy -ErrorAction SilentlyContinue',
    '$forced = $false',
    'if ($left) { $forced = $true; $left | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 1200 }',
    `schtasks /delete /tn "${taskName}" /f 2>&1 | Out-Null`,
    `$cmd = '"' + $exe + '" ' + $flags`,
    `schtasks /create /tn "${taskName}" /tr $cmd /sc once /st 23:59 /f 2>&1 | Out-Null`,
    `schtasks /run /tn "${taskName}" 2>&1 | Out-Null`,
    '$out = [ordered]@{ ok = $true; exe = $exe; wasRunning = $wasRunning; forced = $forced }',
    'Write-Output ($out | ConvertTo-Json -Compress)',
  ].join('\n');
  const result = await runPowerShell(script, (opts && opts.timeoutMs) || 40000);
  return { ...result, taskName };
}

/** 删除重启用的临时计划任务（别留垃圾）。 */
export function cleanupRelaunchTask(taskName) {
  return new Promise((resolve) => {
    execFile('schtasks', ['/delete', '/tn', taskName || 'dsh-wb-relaunch', '/f'], { timeout: 8000 }, () => resolve(true));
  });
}

/**
 * 等到 CDP 端口可用（重启后调用）。返回 { ok, waitedMs, browser }。
 */
export async function waitForCdp(port, maxWaitMs, timeoutMs) {
  const started = Date.now();
  const budget = Math.max(2000, Number(maxWaitMs) || 30000);
  for (;;) {
    try {
      const v = await cdpVersion(port, timeoutMs || 2000);
      dropSession(port);
      return { ok: true, waitedMs: Date.now() - started, browser: v && v.Browser };
    } catch {
      if (Date.now() - started >= budget) return { ok: false, waitedMs: Date.now() - started };
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/**
 * 需要点界面之前先确保窗口可见（否则渲染被节流、操作又慢又可能取不到内容）。
 * 返回 { wasHidden, restored, visibleNow, waitedMs }。
 */
export async function ensureVisible(config, opts) {
  const out = { wasHidden: null, restored: null, visibleNow: null, waitedMs: 0 };
  if (opts && opts.skip) return out;
  let vis = null;
  try {
    vis = await uiVisibility(config);
  } catch {
    return out;
  }
  out.wasHidden = vis && vis.hidden === true;
  out.minimized = vis && vis.minimized === true;
  if (!out.wasHidden) {
    out.visibleNow = true;
    return out;
  }
  out.restored = await restoreWorkbuddyWindow();
  const deadline = Date.now() + 2500;
  for (;;) {
    const again = await uiVisibility(config).catch(() => null);
    if (again && again.hidden === false) {
      out.visibleNow = true;
      break;
    }
    if (Date.now() >= deadline) {
      out.visibleNow = false;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  out.waitedMs = 2500 - Math.max(0, deadline - Date.now());
  return out;
}

export function scriptSend() {
  // 保留旧名以免误用：真正的实现是 sendViaComposer（CDP 受信任输入）
  throw new Error('use sendViaComposer(config, text, options) instead of scriptSend');
}
