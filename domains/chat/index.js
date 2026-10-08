/**
 * dsh-wb-chat —— 宿主半区
 *
 * 给 dsh 的 Web 界面提供两条路由，让「WB 对话」面板直接驱动本机 codebuddy headless 引擎：
 *
 *   GET  /dsh-wb-chat/info   → 引擎信息、可用权限档、默认档、默认 cwd、最近会话
 *   POST /dsh-wb-chat/send   → **流式**（text/event-stream）跑一条任务，回复逐字回传
 *
 * 为什么走 webServer 路由而不是别的通道：客户端服务目录里没有通用宿主 RPC，
 * 而 `webServer.register` 的 handler 拿的是**原生 Node req/res**，可以 `res.write()` 分块流式。
 * 这也是本机 dsh-lan-gate 插件已经验证过的同源通道。
 *
 * 安全：授权参数只能来自 `permissionProfiles`（与 dsh-wb-bridge **共用同一份定义**），
 * 请求体只能选档名；cwd 必须在白名单内；输出过密钥遮蔽；客户端断开即按进程树杀。
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PERMISSION_PROFILES,
  buildSkillContext,
  discoverWbSessions,
  engineVersion,
  importWbSession,
  listProfiles,
  maskSecrets,
  readWbTranscript,
  recentEngineSessions,
  resolveCwd,
  resolveEngine,
  resolveProfile,
} from './wb-lite.js';

export const name = 'dsh-wb-chat';

/** 需要 webServer 才能注册路由。 */
export const inject = ['webServer'];

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  enabled: true,
  codebuddyPath: 'codebuddy',
  defaultCwd: '',
  allowedCwds: ['~'],
  /** 与 dsh-wb-bridge 共用同一真源。 */
  permissionProfiles: DEFAULT_PERMISSION_PROFILES,
  /** 面板默认档：用户在面板上直接选，所以默认给「能写文件、不能执行命令」。 */
  defaultProfile: 'edits',
  /**
   * 默认模型。**给托管模型 id 就走 CodeBuddy 账号积分**；留空则用引擎默认
   * （即 `~/.codebuddy/models.json` 里那份**用户自己的 key**）。
   * 实测（2026-10-08）：`glm-5.3` 能跑通，而它不在用户的 models.json 里 ⇒ 走的是账号通道。
   * WB 应用自己在用的也是托管模型（deepseek-v4.1-flash / hy3 / glm-5.3-flash）。
   */
  defaultModel: 'deepseek-v4.1-flash',
  allowSkipPermissions: false,
  /** WB 应用的历史会话根目录。 */
  wbProjectsDir: '',
  /** CLI 的会话目录（导入的目标）。 */
  cliProjectsDir: '',
  /** 只读会话文件头部这么多字节来取 cwd/标题（会话文件可达 68 MB）。 */
  sessionHeadBytes: 262144,
  maxTurns: 20,
  maxMessageChars: 8000,
  /** 单次请求硬超时。 */
  requestTimeoutMs: 900000,
  /** 列最近会话的条数。 */
  historyLimit: 20,
  /** 认知对齐：往引擎 system prompt 注入 WB 技能清单。 */
  skillContext: {
    enabled: true,
    mirrorPath: '',
    skillDirs: ['~/.workbuddy/skills'],
    maxChars: 9000,
    descriptionChars: 110,
  },
};

/* --------------------------- 小工具 --------------------------- */

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': body.length,
  });
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
      if (tooLarge) return resolve({ ok: false, reason: `request body too large (limit ${limit} bytes)` });
      try {
        resolve({ ok: true, value: raw ? JSON.parse(raw) : {} });
      } catch (error) {
        resolve({ ok: false, reason: `invalid JSON body: ${String((error && error.message) || error)}` });
      }
    });
    req.on('error', () => resolve({ ok: false, reason: 'request stream error' }));
  });
}

function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    try {
      child.kill();
    } catch {
      /* 已经没了 */
    }
  }
}

/* --------------------------- 插件 --------------------------- */

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) };
  if (!config.defaultCwd) {
    const candidate = path.join(os.homedir(), 'WorkBuddy', 'Claw');
    config.defaultCwd = fs.existsSync(candidate) ? candidate : os.homedir();
  }
  if (config.skillContext && !config.skillContext.mirrorPath) {
    config.skillContext.mirrorPath = path.join(PLUGIN_DIR, '..', 'dsh-wb-sync', 'out', 'wb-skills-mirror.json');
  }

  /* ---------------- GET /dsh-wb-chat/info ---------------- */
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-wb-chat/info',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET' });
          res.end();
          return;
        }
        const engine = resolveEngine(config);
        const skillContext = buildSkillContext(config);
        sendJson(res, 200, {
          plugin: 'dsh-wb', domain: 'chat',
          enabled: config.enabled !== false,
          engine: {
            configured: config.codebuddyPath,
            resolved: engine.command,
            found: engine.found,
            version: engine.found ? engineVersion(engine.command) : null,
          },
          defaultCwd: config.defaultCwd,
          defaultProfile: config.defaultProfile || 'edits',
          defaultModel: config.defaultModel || '',
          billingNote: config.defaultModel
            ? 'using a CodeBuddy-hosted model → account credits, not your own API key'
            : 'no model pinned → engine default, which reads ~/.codebuddy/models.json (your own API key)',
          profiles: listProfiles(config).map((p) => ({ name: p.name, description: p.description, isDefault: p.isDefault })),
          skillContext: { injected: Boolean(skillContext.text), count: skillContext.count, source: skillContext.source },
          sessionDir: recentEngineSessions(config, config.defaultCwd).dir,
          sessionDirExists: recentEngineSessions(config, config.defaultCwd).exists,
          sessions: recentEngineSessions(config, config.defaultCwd).items,
        });
      },
    }),
  );

  /* ---------------- GET /dsh-wb-chat/wb-transcript（读历史正文） ---------------- */
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-wb-chat/wb-transcript',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET' });
          res.end();
          return;
        }
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const pathParam = url.searchParams.get('path');
        const sessionId = url.searchParams.get('sessionId');
        let target = pathParam;
        // 只给了 sessionId 就自己去找（仍然只允许 WB 会话目录内的文件）
        if (!target && sessionId) {
          const found = discoverWbSessions(config, 1000).sessions.find((s) => s.sessionId === sessionId);
          if (found) target = found.path;
        }
        if (!target) {
          sendJson(res, 400, { error: 'path or sessionId is required' });
          return;
        }
        const result = readWbTranscript(config, {
          path: target,
          limit: Number(url.searchParams.get('limit')) || undefined,
          includeTools: url.searchParams.get('tools') === '1',
        });
        if (!result.ok) {
          sendJson(res, 404, { error: result.reason });
          return;
        }
        sendJson(res, 200, result);
      },
    }),
  );

  /* ---------------- GET /dsh-wb-chat/wb-sessions（WorkBuddy 历史会话） ---------------- */
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-wb-chat/wb-sessions',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET' });
          res.end();
          return;
        }
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const limit = Number(url.searchParams.get('limit')) || config.historyLimit;
        const discovered = discoverWbSessions(config, limit);
        sendJson(res, 200, {
          root: discovered.root,
          total: discovered.total,
          resumableTotal: discovered.resumableTotal,
          skippedNoCwd: discovered.skippedNoCwd,
          sessions: discovered.sessions.map((s) => ({
            sessionId: s.sessionId,
            title: s.title || s.firstUserText || '(无标题)',
            cwd: s.cwd,
            project: s.project,
            bytes: s.bytes,
            mtime: s.mtime,
            path: s.path,
          })),
          note: 'from the WorkBuddy app store; picking one imports a copy into the CLI store and resumes it (sessions without a recorded cwd cannot be resumed and are excluded)',
        });
      },
    }),
  );

  /* ---------------- POST /dsh-wb-chat/send（流式） ---------------- */
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-wb-chat/send',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' });
          res.end();
          return;
        }
        if (config.enabled === false) {
          sendJson(res, 503, { error: 'dsh-wb-chat is disabled by config' });
          return;
        }

        const parsed = await readJson(req, Math.max(4096, config.maxMessageChars * 4));
        if (!parsed.ok) {
          sendJson(res, 400, { error: parsed.reason });
          return;
        }
        const body = parsed.value || {};
        const task = String(body.task || '').trim();
        if (!task) {
          sendJson(res, 400, { error: 'task is required' });
          return;
        }
        if (task.length > config.maxMessageChars) {
          sendJson(res, 400, { error: `task too long (limit ${config.maxMessageChars} chars)` });
          return;
        }

        const profile = resolveProfile({ profile: body.profile }, config);
        if (!profile.ok) {
          sendJson(res, 400, { error: profile.reason });
          return;
        }

        // ---- 接续 WB 历史会话：把它导入 CLI 会话目录，并在**原 cwd** 下 --resume ----
        let wbResume = null;
        let effectiveCwd = body.cwd;
        if (body.wbSession && body.wbSession.sessionId) {
          const imported = importWbSession(config, body.wbSession);
          if (!imported.ok) {
            sendJson(res, 400, { error: `cannot resume WorkBuddy session: ${imported.reason}` });
            return;
          }
          wbResume = imported;
          effectiveCwd = imported.cwd; // --resume 只在原 cwd 的 project 目录里找会话
        }

        const cwdCheck = resolveCwd(effectiveCwd ?? body.cwd, config);
        if (!cwdCheck.ok) {
          sendJson(res, 400, { error: cwdCheck.reason });
          return;
        }
        const engine = resolveEngine(config);
        if (!engine.found) {
          sendJson(res, 503, { error: `codebuddy engine not found (looked for "${config.codebuddyPath}")` });
          return;
        }

        // ---- 组装 argv（授权参数只来自档位定义） ----
        const argv = ['-p', task, '--output-format', 'stream-json', '--include-partial-messages'];
        argv.push('--max-turns', String(config.maxTurns));
        argv.push(...profile.args);
        if (profile.tools) argv.push('--tools', String(profile.tools));
        // 模型：给托管模型 id 就走账号积分，留空则用引擎默认（models.json 里的自有 key）
        const model = body.model || config.defaultModel;
        if (model) argv.push('--model', String(model));
        if (wbResume) {
          argv.push('--resume', wbResume.sessionId);
        } else if (body.sessionId && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(String(body.sessionId))) {
          argv.push('--session-id', String(body.sessionId));
        } else if (body.continueSession) {
          argv.push('-c');
        }
        const skillContext = buildSkillContext(config);
        if (skillContext.text) argv.push('--append-system-prompt', skillContext.text);

        // ---- 流式响应 ----
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

        write('start', {
          profile: profile.name,
          cwd: cwdCheck.cwd,
          model: model || '(engine default)',
          resumedWbSession: wbResume ? { sessionId: wbResume.sessionId, title: (body.wbSession && body.wbSession.title) || null, bytes: wbResume.bytes || null } : null,
          skillsInjected: skillContext.count,
          argvEcho: argv.map((token) => (token.length > 120 ? `<${token.length} chars>` : token)),
        });

        const heartbeat = setInterval(() => {
          if (closed || res.writableEnded) return;
          try {
            res.write(': ping\n\n');
          } catch {
            closed = true;
          }
        }, 15000);
        if (typeof heartbeat.unref === 'function') heartbeat.unref();

        const child = spawn(engine.command, argv, {
          cwd: cwdCheck.cwd,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env },
        });

        const startedAt = Date.now();
        let buffer = '';
        let text = '';
        let reasoningChars = 0;
        let redactions = 0;
        let sessionId = null;
        let settled = false;

        const handleLine = (line) => {
          if (!line.trim()) return;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }
          if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
            sessionId = event.session_id;
            write('session', { sessionId });
            return;
          }
          if (event.type === 'stream_event') {
            const delta = event.event && event.event.delta;
            if (delta && delta.type === 'text_delta' && typeof delta.text === 'string') {
              const masked = maskSecrets(delta.text);
              redactions += masked.redactions;
              text += masked.text;
              write('delta', { text: masked.text });
            } else if (delta && typeof delta.thinking === 'string') {
              reasoningChars += delta.thinking.length;
              write('thinking', { chars: delta.thinking.length });
            }
            return;
          }
          if (event.type === 'result') {
            const finalText = maskSecrets(String(event.result || '')).text;
            redactions += maskSecrets(String(event.result || '')).redactions;
            write('done', {
              sessionId: event.session_id || sessionId,
              isError: Boolean(event.is_error),
              subtype: event.subtype || null,
              result: finalText || text,
              durationMs: event.duration_ms === undefined ? Date.now() - startedAt : event.duration_ms,
              usage: event.usage || null,
              redactions,
              reasoningChars,
            });
          }
        };

        child.stdout.on('data', (chunk) => {
          buffer += String(chunk);
          let index;
          while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            handleLine(line);
          }
        });
        child.stderr.on('data', (chunk) => {
          const masked = maskSecrets(String(chunk));
          redactions += masked.redactions;
          if (masked.text.trim()) write('stderr', { text: masked.text.slice(0, 4000) });
        });

        const finish = (payload) => {
          if (settled) return;
          settled = true;
          clearInterval(heartbeat);
          write('exit', payload);
          if (!closed && !res.writableEnded) res.end();
        };

        const timer = setTimeout(() => {
          write('error', { message: `engine timeout after ${config.requestTimeoutMs} ms` });
          killTree(child);
        }, Math.max(5000, Number(config.requestTimeoutMs) || 900000));

        child.on('error', (error) => {
          clearTimeout(timer);
          write('error', { message: String((error && error.message) || error) });
          finish({ exitCode: null, durationMs: Date.now() - startedAt });
        });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          if (buffer.trim()) handleLine(buffer);
          finish({ exitCode: code, signal: signal || null, durationMs: Date.now() - startedAt, sessionId, redactions });
        });

        // 客户端断开（切面板/关页面/手机锁屏）→ 按进程树杀，不留孤儿
        const onClose = () => {
          closed = true;
          clearInterval(heartbeat);
          clearTimeout(timer);
          killTree(child);
        };
        req.on('close', onClose);
        res.on('close', onClose);
        req.on('aborted', onClose);
      },
    }),
  );
}
