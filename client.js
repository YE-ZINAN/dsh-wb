/**
 * dsh-wb-chat —— 客户端半区
 *
 * 在 dsh 里加一个整屏「WB 对话」主面板（`main` 槽，key = PANEL_ID）+ 侧栏图标（`sidebar.panellist`）。
 * 两者**必须成对注册** —— `sidebar.panellist` 是「主面板注册表」，只注册图标不注册面板会坏布局
 * （qq2005 与 lan-gate 的注释都踩过这条）。
 *
 * 通信：`fetch` 宿主路由（客户端服务目录里没有通用宿主 RPC），
 * `POST /dsh-wb-chat/send` 返回 text/event-stream，这里用 fetch 的 ReadableStream 逐块读。
 *
 * 主题：只用 `--dsw-alias-*` / `--dsw-*` token，不写字面色。
 */

window.__ModuleLoader__.load({
  id: 'dsh-wb',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'dsh-wb-chat:wb';
    const PROFILE_KEY = 'dsh-wb-chat:profile';
    const TRANSPORT_KEY = 'dsh-wb-chat:transport';
    const MODEL_KEY = 'dsh-wb-chat:model';

    const T = {
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      bg: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      accent: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      radius: 'var(--dsw-radius-md, 8px)',
    };

    const FONT = "var(--dsw-font-family, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif)";

    /**
     * 富文本样式（一次性注入）。
     * WB 的回复我保留了它自己的 HTML（`<p>/<strong>/<ul>/<pre>`…），
     * 但 dsh 没有把会话渲染器暴露给插件（客户端 Builtin 只有 ctx/React/host/styles/console），
     * 所以这里用**同一套 dsh 主题 token**把它渲染出来，观感与 dsh 一致。
     */
    (function ensureRichStyles() {
      const id = 'dsh-wb-chat-rich-styles';
      if (typeof document === 'undefined' || document.getElementById(id)) return;
      const el = document.createElement('style');
      el.id = id;
      el.textContent = [
        '.dsh-wb-rich{font-size:13.5px;line-height:1.62;word-break:break-word}',
        '.dsh-wb-rich p{margin:0 0 8px}',
        '.dsh-wb-rich p:last-child{margin-bottom:0}',
        '.dsh-wb-rich ul,.dsh-wb-rich ol{margin:0 0 8px;padding-left:22px}',
        '.dsh-wb-rich li{margin:2px 0}',
        '.dsh-wb-rich code{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;background:var(--dsw-alias-bg-layer-2);padding:1px 4px;border-radius:4px}',
        '.dsh-wb-rich pre{background:var(--dsw-alias-bg-layer-2);padding:9px 11px;border-radius:8px;overflow:auto;border:1px solid var(--dsw-alias-border-l1)}',
        '.dsh-wb-rich pre code{background:transparent;padding:0}',
        '.dsh-wb-rich blockquote{margin:6px 0;padding-left:10px;border-left:3px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
        '.dsh-wb-rich table{border-collapse:collapse;margin:6px 0;font-size:12.5px}',
        '.dsh-wb-rich th,.dsh-wb-rich td{border:1px solid var(--dsw-alias-border-l1);padding:4px 8px}',
        '.dsh-wb-rich h1,.dsh-wb-rich h2,.dsh-wb-rich h3,.dsh-wb-rich h4{margin:10px 0 6px;font-size:14.5px}',
        '.dsh-wb-rich hr{border:0;border-top:1px solid var(--dsw-alias-border-l1);margin:10px 0}',
      ].join('');
      document.head.appendChild(el);
    })();

    /* ----------------------------- 样式 ----------------------------- */

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: T.bg, color: T.text, fontFamily: FONT },
      head: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: `1px solid ${T.border}`, background: T.layer1, flexWrap: 'wrap' },
      title: { fontSize: 14, fontWeight: 600, marginRight: 'auto', display: 'flex', alignItems: 'center', gap: 8 },
      dot: (ok) => ({ width: 8, height: 8, borderRadius: 4, background: ok ? 'var(--dsw-alias-state-success-primary)' : T.error, flex: '0 0 auto' }),
      select: { background: T.layer2, color: T.text, border: `1px solid ${T.borderStrong}`, borderRadius: T.radius, padding: '4px 8px', fontSize: 12, fontFamily: FONT },
      btn: (primary) => ({
        background: primary ? 'var(--dsw-alias-button-primary-fill)' : T.layer2,
        color: primary ? 'var(--dsw-alias-brand-text)' : T.text,
        border: `1px solid ${primary ? 'transparent' : T.borderStrong}`,
        borderRadius: T.radius,
        padding: '5px 12px',
        fontSize: 12,
        cursor: 'pointer',
        fontFamily: FONT,
      }),
      body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 14px 4px' },
      row: (role) => ({
        display: 'flex',
        justifyContent: role === 'user' ? 'flex-end' : 'flex-start',
        marginBottom: 12,
      }),
      bubble: (role) => ({
        maxWidth: '86%',
        padding: '9px 12px',
        borderRadius: 10,
        background: role === 'user' ? 'var(--dsw-alias-interactive-bg-active)' : T.layer1,
        border: `1px solid ${T.border}`,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontSize: 13.5,
        lineHeight: 1.62,
        fontFamily: FONT,
      }),
      meta: { fontSize: 11, color: T.dim, marginTop: 5, fontFamily: FONT },
      foot: { borderTop: `1px solid ${T.border}`, background: T.layer1, padding: 10, display: 'flex', gap: 8, alignItems: 'flex-end' },
      ta: {
        flex: 1,
        resize: 'none',
        minHeight: 42,
        maxHeight: 200,
        background: T.bg,
        color: T.text,
        border: `1px solid ${T.borderStrong}`,
        borderRadius: T.radius,
        padding: '9px 11px',
        fontSize: 13.5,
        lineHeight: 1.55,
        fontFamily: FONT,
        outline: 'none',
      },
      hint: { fontSize: 11, color: T.dim, padding: '0 14px 10px', fontFamily: FONT },
      err: { fontSize: 12, color: T.error, padding: '6px 14px', fontFamily: FONT, whiteSpace: 'pre-wrap' },
    };

    /* --------------------------- SSE 解析 --------------------------- */

    async function streamSend(url, body, onEvent, signal) {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok || !resp.body) {
        let detail = '';
        try {
          detail = await resp.text();
        } catch {
          /* ignore */
        }
        throw new Error(`HTTP ${resp.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          let eventName = 'message';
          const dataLines = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) eventName = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
            else if (line.startsWith('data:')) dataLines.push(line.slice(5));
          }
          if (dataLines.length === 0) continue;
          let payload = null;
          try {
            payload = JSON.parse(dataLines.join('\n'));
          } catch {
            payload = { raw: dataLines.join('\n') };
          }
          onEvent(eventName, payload);
        }
      }
    }

    /* ---------------------------- 面板 ---------------------------- */

    function ChatPanel() {
      const [messages, setMessages] = React.useState([]);
      const [input, setInput] = React.useState('');
      const [profile, setProfile] = React.useState(() => {
        try {
          return window.localStorage.getItem(PROFILE_KEY) || 'edits';
        } catch {
          return 'edits';
        }
      });
      const [info, setInfo] = React.useState(null);
      const [wbSessions, setWbSessions] = React.useState([]);
      const [resume, setResume] = React.useState(null);
      const [transcript, setTranscript] = React.useState(null);
      const [historyLoading, setHistoryLoading] = React.useState(false);
      // 传输方式：gui = 驱动 WB 界面本体（对话长在 WB 里，用 WB 账号额度）；cli = 无界面起进程
      const [transport, setTransport] = React.useState(() => {
        try {
          return window.localStorage.getItem(TRANSPORT_KEY) || 'gui';
        } catch {
          return 'gui';
        }
      });
      const [guiState, setGuiState] = React.useState(null);
      const [guiModels, setGuiModels] = React.useState([]);
      const [guiModel, setGuiModel] = React.useState(() => {
        try {
          return window.localStorage.getItem(MODEL_KEY) || '';
        } catch {
          return '';
        }
      });
      const [guiSessions, setGuiSessions] = React.useState([]);
      const [guiOpen, setGuiOpen] = React.useState(null);
      const [guiVisible, setGuiVisible] = React.useState(null);
      const [guiWindowNote, setGuiWindowNote] = React.useState('');
      const [guiRelaunching, setGuiRelaunching] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const sessionRef = React.useRef(null);
      const abortRef = React.useRef(null);
      const scrollRef = React.useRef(null);
      const taRef = React.useRef(null);

      // GUI 传输：读 WB 界面的状态、模型清单（带积分倍率）与会话列表
      const loadGui = React.useCallback(() => {
        fetch('/dsh-wb-gui/state')
          .then((r) => r.json())
          .then((data) => {
            setGuiState(data);
            if (data && data.visibility) setGuiVisible(data.visibility.hidden === false);
          })
          .catch((e) => setGuiState({ ok: false, reason: String((e && e.message) || e) }));
        fetch('/dsh-wb-gui/models')
          .then((r) => r.json())
          .then((data) => {
            if (data && Array.isArray(data.models)) {
              setGuiModels(data.models);
              const current = String(data.current || '').replace(/^Select model:\s*/, '');
              setGuiModel((prev) => {
                const wanted = prev || current;
                const hit = data.models.find((m) => m.name === wanted);
                return (hit || data.models.find((m) => m.name === current) || {}).name || wanted;
              });
            }
          })
          .catch(() => {
            /* 模型清单读不到不影响发送 */
          });
        fetch('/dsh-wb-gui/sessions')
          .then((r) => r.json())
          .then((data) => {
            if (data && Array.isArray(data.items)) {
              setGuiSessions(data.items);
              const sel = data.items.find((i) => i.selected);
              if (sel) setGuiOpen(sel);
            }
          })
          .catch(() => {
            /* 会话列表读不到不影响发送 */
          });
      }, []);

      React.useEffect(() => {
        if (transport === 'gui') loadGui();
      }, [transport, loadGui]);

      React.useEffect(() => {
        let alive = true;
        fetch('/dsh-wb-chat/info')
          .then((r) => r.json())
          .then((data) => {
            if (alive) setInfo(data);
          })
          .catch((e) => {
            if (alive) setError(`读取桥信息失败：${String(e && e.message)}`);
          });
        fetch('/dsh-wb-chat/wb-sessions?limit=25')
          .then((r) => r.json())
          .then((data) => {
            if (alive && data && Array.isArray(data.sessions)) setWbSessions(data.sessions);
          })
          .catch(() => {
            /* 历史会话读不到不影响新对话 */
          });
        return () => {
          alive = false;
        };
      }, []);

      React.useEffect(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }, [messages]);

      // 选中一段 WB 历史会话 → 把正文读出来渲染（只读，不动它）
      React.useEffect(() => {
        if (!resume) {
          setTranscript(null);
          return undefined;
        }
        let alive = true;
        setHistoryLoading(true);
        setError('');
        fetch(`/dsh-wb-chat/wb-transcript?sessionId=${encodeURIComponent(resume.sessionId)}&limit=60`)
          .then((r) => r.json())
          .then((data) => {
            if (!alive) return;
            if (data && Array.isArray(data.messages)) {
              setMessages(
                data.messages.map((m) => ({
                  role: m.role === 'tool' ? 'tool' : m.role,
                  text: m.text,
                  historical: true,
                })),
              );
              setTranscript({
                returned: data.returned,
                total: data.total,
                tailOnly: data.tailOnly,
                bytes: data.bytes,
                title: data.title,
                cwd: data.cwd,
              });
            } else {
              setError(data && data.error ? `读历史失败：${data.error}` : '读历史失败');
            }
          })
          .catch((e) => {
            if (alive) setError(`读历史失败：${String((e && e.message) || e)}`);
          })
          .finally(() => {
            if (alive) setHistoryLoading(false);
          });
        return () => {
          alive = false;
        };
      }, [resume]);

      const patchLast = (fn) =>
        setMessages((list) => {
          if (list.length === 0) return list;
          const next = list.slice();
          const last = next[next.length - 1];
          next[next.length - 1] = { ...last, ...fn(last) };
          return next;
        });

      const send = async () => {
        const task = input.trim();
        if (!task || busy) return;
        setInput('');
        setError('');
        setBusy(true);
        setMessages((list) => [...list, { role: 'user', text: task }, { role: 'assistant', text: '', streaming: true }]);

        const controller = new AbortController();
        abortRef.current = controller;
        let meta = null;
        try {
          if (transport === 'gui') {
            // 驱动 WB 界面本体：对话长在 WB 里，用 WB 账号额度；回复靠轮询界面伪流式推回
            await streamSend(
              '/dsh-wb-gui/send',
              {
                text: task,
                model: guiModel || undefined,
                openTitle: guiOpen ? guiOpen.title : undefined,
                newTask: !guiOpen,
                pollMs: 900,
                idlePolls: 5,
              },
              (eventName, payload) => {
                if (eventName === 'delta' && payload && payload.text) {
                  patchLast((last) => ({ text: (last.text || '') + payload.text }));
                } else if (eventName === 'replace' && payload) {
                  patchLast(() => ({ text: String(payload.text || '') }));
                } else if (eventName === 'model' && payload && payload.ok && payload.after) {
                  const next = String(payload.after).replace(/^Select model:\s*/, '');
                  setGuiModel(next);
                } else if (eventName === 'window' && payload) {
                  // 宿主在发消息前会把最小化的 WB 窗口调出来（否则界面不重绘，看起来像"没渲染"）
                  setGuiVisible(payload.visibleNow === null ? null : Boolean(payload.visibleNow));
                  setGuiWindowNote(
                    payload.wasHidden === true
                      ? payload.visibleNow === true
                        ? 'WB 窗口原是最小化，已自动调出'
                        : 'WB 窗口仍是最小化：界面不会重绘，请手动恢复'
                      : '',
                  );
                } else if (eventName === 'sent' && payload) {
                  patchLast(() => ({ sent: payload.ok !== false, composerAfter: payload.composerAfter || null }));
                } else if (eventName === 'error' && payload) {
                  setError(String(payload.message || 'GUI 发送失败'));
                } else if (eventName === 'done' && payload) {
                  meta = { transport: 'gui', durationMs: payload.durationMs, stopped: payload.stopped };
                  loadGui();
                  // 结束后换成富文本渲染
                  setTimeout(loadRich, 300);
                }
              },
              controller.signal,
            );
          } else {
            // 接了 WB 历史会话就把 resume 描述传给宿主（它会导入副本并在原 cwd 下 --resume）
            const wbSession = resume ? { sessionId: resume.sessionId, path: resume.path, cwd: resume.cwd, title: resume.title } : null;
            await streamSend(
              '/dsh-wb-chat/send',
              { task, profile, wbSession, sessionId: wbSession ? null : sessionRef.current },
              (eventName, payload) => {
                if (eventName === 'delta' && payload && payload.text) {
                  patchLast((last) => ({ text: (last.text || '') + payload.text }));
                } else if (eventName === 'session' && payload && payload.sessionId) {
                  sessionRef.current = payload.sessionId;
                } else if (eventName === 'thinking' && payload) {
                  patchLast((last) => ({ thinking: (last.thinking || 0) + (payload.chars || 0) }));
                } else if (eventName === 'stderr' && payload && payload.text) {
                  patchLast((last) => ({ stderr: ((last.stderr || '') + payload.text).slice(0, 4000) }));
                } else if (eventName === 'error' && payload) {
                  setError(String(payload.message || 'unknown engine error'));
                } else if (eventName === 'done' && payload) {
                  meta = payload;
                  if (payload.sessionId) sessionRef.current = payload.sessionId;
                }
              },
              controller.signal,
            );
          }
        } catch (e) {
          if (!(e && e.name === 'AbortError')) setError(String((e && e.message) || e));
        } finally {
          abortRef.current = null;
          setBusy(false);
          patchLast(() => ({ streaming: false, meta }));
        }
      };

      const stop = () => {
        if (abortRef.current) abortRef.current.abort();
        setBusy(false);
      };

      const newSession = () => {
        sessionRef.current = null;
        setResume(null);
        setMessages([]);
        setError('');
        if (transport === 'gui') {
          setGuiOpen(null);
          fetch('/dsh-wb-gui/new-task', { method: 'POST' })
            .then(() => loadGui())
            .catch(() => {
              /* 界面没开就算了 */
            });
        }
      };

      /**
       * 流结束后把当前会话拉成**富文本**版本：保留 WB 自己的 HTML（清洗过），
       * 这样代码块/表格/列表/加粗都能正常渲染，而不是一坨纯文本。
       * 流式阶段仍用纯文本（增量拼接简单可靠），只在结束时"上样式"。
       */
      const loadRich = React.useCallback(() => {
        fetch('/dsh-wb-gui/rich')
          .then((r) => r.json())
          .then((data) => {
            if (!data || !Array.isArray(data.messages) || data.messages.length === 0) return;
            setMessages(data.messages.map((m) => ({ role: m.role, text: m.text, html: m.html || null, rich: true })));
          })
          .catch(() => {
            /* 拿不到富文本就保持纯文本，不影响功能 */
          });
      }, []);

      const pickModel = (name) => {        setGuiModel(name);
        try {
          window.localStorage.setItem(MODEL_KEY, name);
        } catch {
          /* ignore */
        }
        fetch('/dsh-wb-gui/model', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })
          .then((r) => r.json())
          .then((data) => {
            if (data && data.ok === false) setError(`切模型失败：${data.reason || '未知原因'}`);
            else if (data && data.after) setGuiModel(String(data.after).replace(/^Select model:\s*/, ''));
          })
          .catch((e) => setError(`切模型失败：${String((e && e.message) || e)}`));
      };

      const openGuiSession = (item) => {
        setGuiOpen(item);
        setMessages([]);
        setError('');
        fetch('/dsh-wb-gui/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ index: item.index, title: item.title }) })
          .then((r) => r.json())
          .then((data) => {
            if (data && Array.isArray(data.messages)) {
              setMessages(data.messages.map((m) => ({ role: m.role, text: m.text, historical: true })));
            }
            if (data && data.ok === false) setError(`打开会话失败：${data.reason || ''}`);
            // 打开完再拉一次富文本：让历史正文也带上代码块/表格/列表格式
            setTimeout(loadRich, 400);
          })
          .catch((e) => setError(`打开会话失败：${String((e && e.message) || e)}`));
      };

      const profiles = (info && info.profiles) || [
        { name: 'readonly' },
        { name: 'edits' },
        { name: 'shell' },
      ];
      const active = profiles.find((p) => p.name === profile);

      return h(
        'div',
        { style: S.wrap },
        h(
          'div',
          { style: S.head },
          h(
            'div',
            { style: S.title },
            h('span', { style: S.dot(transport === 'gui' ? Boolean(guiState && guiState.ok) : Boolean(info && info.engine && info.engine.found)) }),
            'WB 对话',
            transport === 'gui'
              ? h('span', { style: { color: T.dim, fontWeight: 400, fontSize: 12 } }, guiState && guiState.ok ? `CDP ${guiState.port} 已连` : 'CDP 未连')
              : info && info.engine && info.engine.version
                ? h('span', { style: { color: T.dim, fontWeight: 400, fontSize: 12 } }, `codebuddy ${info.engine.version}`)
                : null,
          ),
          h(
            'select',
            {
              style: S.select,
              value: transport,
              title: '传输方式：WB 界面 = 驱动 WorkBuddy 应用本体（对话长在 WB 里、用 WB 账号额度）；无界面 = 另起一个独立进程',
              onChange: (e) => {
                const next = e.target.value;
                setTransport(next);
                try {
                  window.localStorage.setItem(TRANSPORT_KEY, next);
                } catch {
                  /* ignore */
                }
                if (next === 'gui') loadGui();
              },
            },
            [h('option', { key: 'gui', value: 'gui' }, 'WB 界面'), h('option', { key: 'cli', value: 'cli' }, '无界面')],
          ),
          // CDP 端口只在 WB「带调试端口启动」时存在 —— WB 被正常方式重启后就连不上，而用户无从下手。
          // 给一个明确入口：带参数重启 WB（会先关闭它），按钮文案本身就说明代价。
          transport === 'gui' && guiState && guiState.ok === false
            ? h(
                'button',
                {
                  style: { ...S.btn(false), fontSize: 11.5 },
                  disabled: guiRelaunching,
                  title: 'CDP 端口没开。点它会关闭并重启 WorkBuddy，带上调试端口与防节流参数（会话已落盘，不会丢）',
                  onClick: () => {
                    setGuiRelaunching(true);
                    setGuiWindowNote('正在重启 WorkBuddy（带调试端口）…最多等 40 秒');
                    fetch('/dsh-wb-gui/relaunch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
                      .then((r) => r.json())
                      .then((d) => {
                        setGuiWindowNote(
                          d && d.ok
                            ? `WB 已带调试端口重启（${((d.tookMs || 0) / 1000).toFixed(1)}s 就绪）`
                            : `重启失败：${(d && (d.reason || d.error)) || '未知原因'}`,
                        );
                        // 重启后 WB 是新进程，之前选中的会话索引作废
                        setGuiOpen(null);
                        setMessages([]);
                        loadGui();
                      })
                      .catch((e) => setGuiWindowNote(`重启失败：${String((e && e.message) || e)}`))
                      .finally(() => setGuiRelaunching(false));
                  },
                },
                guiRelaunching ? '重启中…' : '启动/重连 WB',
              )
            : null,
          transport === 'gui'
            ? h(
                'select',
                {
                  style: S.select,
                  value: guiModel,
                  title: 'WB 的积分模型（数字是积分倍率，越低越省；0x = 免费）',
                  onChange: (e) => pickModel(e.target.value),
                },
                (guiModels.length ? guiModels : [{ name: guiModel || '（读取中）', multiplier: undefined }]).map((m) =>
                  h(
                    'option',
                    { key: m.name, value: m.name },
                    m.multiplier === undefined || m.multiplier === null ? m.name : `${m.name} ${m.multiplier}x`,
                  ),
                ),
              )
            : h(
                'select',
                {
                  style: S.select,
                  value: profile,
                  title: active ? active.description : '',
                  onChange: (e) => {
                    setProfile(e.target.value);
                    try {
                      window.localStorage.setItem(PROFILE_KEY, e.target.value);
                    } catch {
                      /* ignore */
                    }
                  },
                },
                profiles.map((p) => h('option', { key: p.name, value: p.name }, p.name)),
              ),
          transport === 'gui'
            ? h(
                'select',
                {
                  style: S.select,
                  value: guiOpen ? String(guiOpen.index) : '',
                  title: '要接着哪段会话聊：选中即在 WB 界面里切过去，之后的对话就继续在那段里',
                  onChange: (e) => {
                    const value = e.target.value;
                    if (value === '') {
                      setGuiOpen(null);
                      return;
                    }
                    const item = guiSessions.find((s) => String(s.index) === value);
                    if (item) openGuiSession(item);
                  },
                },
                [h('option', { key: '__new', value: '' }, `WB 新任务${guiSessions.length ? `（${guiSessions.length} 段会话）` : ''}`)].concat(
                  guiSessions.map((s) =>
                    h('option', { key: s.index, value: String(s.index) }, `${String(s.title).slice(0, 26)}${s.selected ? ' ·当前' : ''}`),
                  ),
                ),
              )
            : h(
                'select',
                {
                  style: S.select,
                  value: resume ? resume.sessionId : '',
                  title: '接续一段 WorkBuddy 历史对话（会在原 cwd 下 --resume）',
                  onChange: (e) => {
                    const id = e.target.value;
                    const found = wbSessions.find((s) => s.sessionId === id) || null;
                    setResume(found);
                    sessionRef.current = null;
                  },
                },
                [h('option', { key: '__new', value: '' }, `新对话${wbSessions.length ? `（可选 ${wbSessions.length} 段历史）` : ''}`)].concat(
                  wbSessions.map((s) =>
                    h(
                      'option',
                      { key: s.sessionId, value: s.sessionId },
                      `${String(s.mtime).slice(5, 16).replace('T', ' ')} · ${String(s.title).slice(0, 28)}`,
                    ),
                  ),
                ),
              ),
          busy ? h('button', { style: S.btn(false), onClick: stop }, '停止') : null,
          h('button', { style: S.btn(false), onClick: newSession, disabled: busy }, transport === 'gui' ? '新任务' : '新会话'),
        ),
        h(
          'div',
          { style: S.body, ref: scrollRef },
          messages.length === 0
            ? h(
                'div',
                { style: { color: T.dim, fontSize: 13, lineHeight: 1.8, padding: '10px 2px' } },
                '直接在这里和本机 WorkBuddy 引擎对话。回复逐字流式显示，不经过 dsh 的 agent。',
                h('br'),
                info && info.skillContext
                  ? `已注入 ${info.skillContext.count} 个 WB 技能（${info.skillContext.source || '无来源'}）。`
                  : '技能清单未注入。',
                h('br'),
                info && info.defaultCwd ? `工作目录：${info.defaultCwd}` : '',
              )
            : messages.map((m, i) => {
                const prev = i > 0 ? messages[i - 1] : null;
                // 历史段与本次新增之间插一条分界
                const needDivider = m.historical !== true && prev && prev.historical === true;
                const bubble = m.role === 'tool'
                  ? { ...S.bubble('assistant'), background: 'transparent', border: '1px dashed ' + T.border, color: T.dim, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, whiteSpace: 'pre-wrap' }
                  : S.bubble(m.role);
                return h(
                  React.Fragment,
                  { key: i },
                  needDivider
                    ? h(
                        'div',
                        { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0', color: T.accent, fontSize: 11.5 } },
                        h('span', { style: { flex: 1, height: 1, background: T.borderStrong } }),
                        '以上为 WB 历史 · 以下为本次新增',
                        h('span', { style: { flex: 1, height: 1, background: T.borderStrong } }),
                      )
                    : null,
                  h(
                    'div',
                    { style: { ...S.row(m.role), opacity: m.historical ? 0.72 : 1 } },
                    h(
                      'div',
                      { style: { maxWidth: '88%' } },
                      m.html
                        ? h('div', { className: 'dsh-wb-rich', style: { ...bubble, padding: '9px 12px' }, dangerouslySetInnerHTML: { __html: m.html } })
                        : h('div', { style: bubble }, m.text || (m.streaming ? '…' : '')),
                      m.stderr ? h('div', { style: { ...S.meta, color: T.warn } }, m.stderr.slice(0, 600)) : null,
                    m.meta
                      ? h(
                          'div',
                          { style: S.meta },
                          [
                            m.meta.usage ? `in ${m.meta.usage.input_tokens} / out ${m.meta.usage.output_tokens}` : null,
                            m.meta.durationMs ? `${(m.meta.durationMs / 1000).toFixed(1)}s` : null,
                            m.meta.redactions ? `脱敏 ${m.meta.redactions}` : null,
                            m.meta.sessionId ? `会话 ${String(m.meta.sessionId).slice(0, 8)}` : null,
                          ]
                            .filter(Boolean)
                            .join(' · '),
                        )
                      : m.thinking
                        ? h('div', { style: S.meta }, `思考中 ${m.thinking} 字…`)
                        : m.historical
                          ? h('div', { style: S.meta }, 'WB 历史')
                          : null,
                    ),
                  ),
                );
              }),
        ),
        historyLoading ? h('div', { style: S.hint }, '正在读取 WB 历史正文…') : null,
        transcript
          ? h(
              'div',
              { style: S.hint },
              `已载入 WB 历史 ${transcript.returned}/${transcript.total} 条`,
              transcript.tailOnly ? `（文件 ${(transcript.bytes / 1024 / 1024).toFixed(1)} MB，只读了尾部）` : '（全文）',
              '　·　这些内容只读，不会被改写',
            )
          : null,
        error ? h('div', { style: S.err }, error) : null,
        transport === 'gui' && guiVisible === false
          ? h(
              'div',
              { style: { ...S.err, color: T.warn, display: 'flex', gap: 8, alignItems: 'center' } },
              'WB 窗口最小化：Chromium 会停止重绘，对话内容在但界面不显示。',
              h(
                'button',
                {
                  style: { ...S.btn(false), padding: '2px 8px', fontSize: 11 },
                  onClick: () => {
                    fetch('/dsh-wb-gui/focus', { method: 'POST' })
                      .then((r) => r.json())
                      .then((d) => {
                        setGuiVisible(Boolean(d && d.visible));
                        setGuiWindowNote(d && d.visible ? '已把 WB 窗口调出来' : '调出失败，请手动恢复 WB 窗口');
                      })
                      .catch((e) => setGuiWindowNote(`调出失败：${String((e && e.message) || e)}`));
                  },
                },
                '把 WB 窗口调出来',
              ),
            )
          : null,
        guiWindowNote ? h('div', { style: { ...S.hint, color: T.accent } }, guiWindowNote) : null,
        h(
          'div',
          { style: S.hint },
          transport === 'gui'
            ? `驱动 WB 界面本体${guiState && guiState.ok ? `（CDP ${guiState.port}${guiState.connectMs !== undefined ? `，${guiState.connectMs}ms` : ''}）` : '（CDP 未连：点上面的「启动/重连 WB」）'}`
            : active
              ? `权限档 ${profile}：${active.description || ''}`
              : `权限档 ${profile}`,
          transport === 'gui'
            ? guiModel
              ? `　·　模型 ${guiModel}${(guiModels.find((m) => m.name === guiModel) || {}).multiplier !== undefined ? `（${(guiModels.find((m) => m.name === guiModel) || {}).multiplier}x 积分倍率）` : ''}`
              : ''
            : info && info.defaultModel
              ? `　·　模型 ${info.defaultModel}（账号积分）`
              : '　·　模型：引擎默认（你自己的 key）',
          transport === 'gui'
            ? guiOpen
              ? `　·　接着「${String(guiOpen.title).slice(0, 24)}」聊（就在 WB 界面里）`
              : '　·　将在 WB 里新建一个任务'
            : resume
              ? `　·　接续「${String(resume.title).slice(0, 24)}」（${(resume.bytes / 1024).toFixed(0)} KB 历史）`
              : '',
          busy ? '　·　运行中（可点停止）' : '',
        ),
        h(
          'div',
          { style: S.foot },
          h('textarea', {
            ref: taRef,
            style: S.ta,
            value: input,
            placeholder: '问 WB 点什么…（Enter 发送，Shift+Enter 换行）',
            onChange: (e) => setInput(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            },
          }),
          h('button', { style: S.btn(true), onClick: send, disabled: busy || !input.trim() }, busy ? '…' : '发送'),
        ),
      );
    }

    /* --------------------------- 侧栏图标 --------------------------- */

    function SidebarIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': true, style: { display: 'block' } },
        h('rect', { x: 2, y: 5, width: 20, height: 14, rx: 3, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M6 10.5l3 2-3 2', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M12 15h5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      );
    }

    /* ---------------------------- 注册 ---------------------------- */

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() =>
          ctx.slots.inject('main', () =>
            ctx.slots.inject('sidebar.panellist', () => {
              const stopMain = ctx.slots.register({ name: 'main', key: PANEL_ID, inject: () => ({}) }, ChatPanel);
              let stopIcon;
              try {
                stopIcon = ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => 'WB 对话' }, SidebarIcon);
              } catch (error) {
                stopMain();
                throw error;
              }
              return () => {
                if (stopIcon) stopIcon();
                stopMain();
              };
            }),
          ),
        );
      },
    };
  },
});
