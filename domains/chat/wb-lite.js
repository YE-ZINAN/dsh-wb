/**
 * wb-lite.js —— dsh-wb-chat 自带的最小引擎层
 *
 * ⚠️ **为什么这里是"复制"而不是 import `../dsh-wb-bridge/wb-runner.js`：**
 * 2026-10-08 实测（最小探针插件，唯一行为就是一次跨包相对 import）——
 * **DSH 插件加载器不允许跨包相对 import，会直接 `failed to import` 且只给这一句诊断**。
 * 所以每个插件包都必须自包含。
 *
 * ⚠️ **因此产生了一份必须人工同步的复制**：本文件的 `DEFAULT_PERMISSION_PROFILES`
 * 与 `dsh-wb-bridge/wb-runner.js` 的同名常量**必须逐字一致**（授权参数写错就等于放宽权限）。
 * 防漂移检查在 `_scratch/wb-chat-host-test.mjs` 里（deep-equal 两个模块的该常量）；
 * 改任一处都要跑它。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* --------------------------- 密钥遮蔽 --------------------------- */

const SECRET_RES = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /((?:api[_-]?key|apikey|token|password|passwd|secret)\s*[:=]\s*)["']?[^\s"',}]{6,}/gi,
  /((?:DEEPSEEK|OPENAI|ANTHROPIC|CODEBUDDY|TUSHARE)[A-Z_]*\s*[:=]\s*)["']?[^\s"',}]{6,}/gi,
];

export function maskSecrets(text) {
  let out = String(text);
  let redactions = 0;
  for (const re of SECRET_RES) {
    out = out.replace(re, (match, prefix) => {
      redactions += 1;
      return prefix ? `${prefix}[REDACTED]` : '[REDACTED]';
    });
  }
  return { text: out, redactions };
}

/* --------------------------- 引擎 --------------------------- */

export function resolveEngine(config) {
  const configured = config.codebuddyPath || 'codebuddy';
  if (path.isAbsolute(configured)) {
    return { command: configured, found: fs.existsSync(configured), source: 'config' };
  }
  try {
    const probe = spawnSync('where.exe', [configured], { encoding: 'utf8', windowsHide: true });
    const first = String(probe.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)[0];
    if (probe.status === 0 && first) return { command: first, found: true, source: 'PATH' };
  } catch {
    /* 落到未找到 */
  }
  return { command: configured, found: false, source: 'PATH' };
}

export function engineVersion(command) {
  try {
    const probe = spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    return String(probe.stdout || probe.stderr || '').trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

/* --------------------------- 路径白名单 --------------------------- */

function isWithin(root, target) {
  const r = path.resolve(root).toLowerCase();
  const t = path.resolve(target).toLowerCase();
  if (t === r) return true;
  return t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** `~` / `~/x` 展开成用户目录。请求方与白名单两侧都要展开。 */
export function expandHome(value) {
  return String(value).replace(/^~(?=$|[\\/])/, os.homedir());
}

export function resolveCwd(requested, config) {
  const hasRequest = requested && String(requested).trim();
  const raw = hasRequest ? expandHome(String(requested).trim()) : expandHome(config.defaultCwd);
  const resolved = path.resolve(raw);
  const roots = (config.allowedCwds || []).map((r) => path.resolve(expandHome(r)));
  const ok = roots.some((root) => isWithin(root, resolved));
  if (!ok) return { ok: false, reason: `cwd is outside allowedCwds: ${resolved}` };
  if (!fs.existsSync(resolved)) return { ok: false, reason: `cwd does not exist: ${resolved}` };
  return { ok: true, cwd: resolved };
}

/* --------------------------- 权限档 --------------------------- */

/**
 * 命名权限档（**与 dsh-wb-bridge/wb-runner.js 逐字同步**）。
 * 调用方只能选档名，不能自带 argv —— 授权能力只能在这里预先定义。
 *
 * 实测依据（2026-10-08，`_scratch/wb-perm-experiment.mjs`）：
 *   default（无 settings）→ 读放行；Write/Bash/PowerShell 被拒；快速失败不挂起。
 *   只 allow Write/Edit/Read → Write 成功、Bash 被精确拒绝。
 *   allow 含 Bash → 命令真被执行。
 *   `-y` → 未实测（受 allowSkipPermissions 闸门保护）。
 */
export const DEFAULT_PERMISSION_PROFILES = {
  readonly: {
    description: '只读：读文件/搜索放行；写文件与执行命令被引擎硬拒（实测：11 轮快速失败、不挂起）',
    tools: 'default',
    args: [],
  },
  edits: {
    description: '可写文件、不可执行命令（实测：Write 成功、Bash 被精确拒绝）',
    tools: 'default',
    args: ['--permission-mode', 'default', '--settings', '{"permissions":{"allow":["Write","Edit","Read"]}}'],
  },
  shell: {
    description: '可写文件、可执行命令（实测：echo 真的跑起来并回传输出）',
    tools: 'default',
    args: ['--permission-mode', 'default', '--settings', '{"permissions":{"allow":["Write","Edit","Read","Bash","PowerShell"]}}'],
  },
  full: {
    description: '全盘跳过权限检查（-y）。未实测；需 allowSkipPermissions: true 才可用',
    tools: 'default',
    args: ['-y'],
    requiresAllowSkip: true,
  },
};

/**
 * 档位 tools 取值约定：
 *   undefined → 'default'；null / '' → 不生成 --tools 开关；字符串 → 原样透传。
 */
function profileTools(profile) {
  return profile.tools === undefined ? 'default' : profile.tools;
}

export function listProfiles(config) {
  const profiles = config.permissionProfiles || {};
  const def = config.defaultProfile || 'readonly';
  return Object.entries(profiles).map(([name, profile]) => ({
    name,
    description: profile.description || '',
    tools: profileTools(profile) === null ? '(engine default)' : profileTools(profile),
    args: Array.isArray(profile.args) ? profile.args : [],
    requiresAllowSkip: Boolean(profile.requiresAllowSkip),
    isDefault: name === def,
  }));
}

export function resolveProfile(input, config) {
  const profiles = config.permissionProfiles || {};
  const explicit = input && input.profile ? String(input.profile) : null;
  const requested = explicit || config.defaultProfile || 'readonly';
  const available = Object.keys(profiles).join(', ') || '(none configured)';
  const profile = profiles[requested];

  if (!profile) {
    if (explicit) return { ok: false, reason: `unknown permission profile "${requested}"; available: ${available}` };
    if (Object.keys(profiles).length === 0) {
      return {
        ok: true,
        name: 'readonly(builtin)',
        description: 'no permission profiles configured; built-in read-only behavior',
        tools: 'default',
        args: [],
      };
    }
    return { ok: false, reason: `default profile "${requested}" is not defined; available: ${available}` };
  }

  if (profile.requiresAllowSkip && config.allowSkipPermissions !== true) {
    return { ok: false, reason: `permission profile "${requested}" is disabled by plugin config (allowSkipPermissions: false)` };
  }
  return {
    ok: true,
    name: requested,
    description: profile.description || '',
    tools: profileTools(profile),
    args: Array.isArray(profile.args) ? profile.args : [],
  };
}

/* --------------------------- 引擎会话目录 --------------------------- */

/**
 * 引擎用 cwd 生成项目目录名：把 `: \ /` 折叠成 `-`、去掉首尾 `-`、**首字母小写**。
 * **空白原样保留**（不要折成 `-`）。
 *
 * 实测样本（`~/.workbuddy/projects/` 与 `~/.codebuddy/projects/`，2026-10-08）：
 *   C:\Users\alice                 → c-Users-alice
 *   C:\Users\alice\wb-hello        → c-Users-alice-wb-hello
 *   C:\Users\alice\WorkBuddy\Claw  → c-Users-alice-WorkBuddy-Claw
 *   <drive>:\<onedrive>\Desktop\<project>\<project>\<project>
 *                                   → d-onedrive-<onedrive>-Desktop-ETF-<project>-<project>
 *
 * ⚠️ 两个都踩过的坑：① `'c-' + path.replace(...)` 会产出 `c-C-Users-…`（双 C、盘符没小写）；
 * ② 把 `\s` 也折成 `-` 会让带空格的路径对不上（上例第 4 条）。
 * 两种错法的共同后果都是「找不到会话目录」—— **而且不报错**。判据：算出的目录必须真实存在。
 */
export function sessionSlug(cwd) {
  const folded = String(cwd)
    .replace(/[:\\/]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!folded) return '';
  return folded.charAt(0).toLowerCase() + folded.slice(1);
}

/** 引擎会话目录 + 最近的会话文件（给面板的「继续上次」用）。 */
export function recentEngineSessions(config, cwd) {
  const dir = path.join(os.homedir(), '.codebuddy', 'projects', sessionSlug(cwd));
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { dir, exists: false, items: [] };
  }
  const items = entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => {
      const full = path.join(dir, e.name);
      const stat = fs.statSync(full);
      return { sessionId: e.name.replace(/\.jsonl$/, ''), mtime: new Date(stat.mtimeMs).toISOString(), bytes: stat.size };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime))
    .slice(0, Math.max(1, Number(config.historyLimit) || 20));
  return { dir, exists: true, items };
}

/* --------------------------- WB 历史会话（读 + 接续） --------------------------- */

/**
 * 发现 WorkBuddy 应用的历史会话。
 *
 * 事实依据（2026-10-08 实测）：
 *   - 会话正文在 `~/.workbuddy/projects/<cwd-slug>/<sessionId>.jsonl`（139 个文件 / 30 个项目）。
 *   - **每条事件都带 `cwd`**，另有 `type:'ai-title'` 事件带 `aiTitle` ⇒ 不需要读 SQLite 就能拿到
 *     cwd 与标题（插件宿主是 Electron 的 Node，不保证有 `node:sqlite`，所以刻意不依赖它）。
 *   - 事件词汇与 CLI 同源（message / reasoning / function_call / function_call_result），
 *     所以把文件搬到 CLI 的会话目录后 `--resume` 认得（实测：26 轮历史全部读入）。
 *   - 会话文件可达 68 MB，所以**只读头部**取 cwd/标题，不整文件读。
 */
export function discoverWbSessions(config, limit) {
  const roots = config.wbProjectsDir
    ? [config.wbProjectsDir]
    : [path.join(os.homedir(), '.workbuddy', 'projects')];
  const max = Math.max(1, Number(limit) || Number(config.historyLimit) || 20);
  const headBytes = Math.max(4096, Number(config.sessionHeadBytes) || 262144);
  const found = [];

  for (const root of roots) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const dirPath = path.join(root, dir.name);
      let files = [];
      try {
        files = fs.readdirSync(dirPath, { withFileTypes: true }).filter((f) => f.isFile() && f.name.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const file of files) {
        const full = path.join(dirPath, file.name);
        let stat;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        const meta = readSessionHead(full, stat.size, headBytes);
        found.push({
          sessionId: file.name.replace(/\.jsonl$/, ''),
          path: full,
          project: dir.name,
          cwd: meta.cwd,
          title: meta.title,
          firstUserText: meta.firstUserText,
          bytes: stat.size,
          mtime: new Date(stat.mtimeMs).toISOString(),
          // 没有 cwd 就**无法接续**：`--resume` 是按 cwd 对应的 project 目录找会话的。
          // 实测确实存在这种会话（头部 256 KB 里没有 cwd 字段），所以必须标出来而不是让用户点了才失败。
          resumable: Boolean(meta.cwd),
        });
      }
    }
  }

  found.sort((a, b) => b.mtime.localeCompare(a.mtime));
  const resumable = found.filter((s) => s.resumable);
  return {
    root: roots[0],
    total: found.length,
    resumableTotal: resumable.length,
    skippedNoCwd: found.length - resumable.length,
    sessions: resumable.slice(0, max),
  };
}

/** 只读文件头部若干字节，取 cwd / aiTitle / 首条用户消息。 */
function readSessionHead(file, size, headBytes) {
  const readBytes = Math.min(size, headBytes);
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(readBytes);
    const n = fs.readSync(fd, buf, 0, readBytes, 0);
    fs.closeSync(fd);
    text = buf.toString('utf8', 0, n);
  } catch {
    return { cwd: null, title: null, firstUserText: null };
  }
  let cwd = null;
  let title = null;
  let firstUserText = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // 最后一行可能被截断
    }
    if (!cwd && typeof event.cwd === 'string') cwd = event.cwd;
    if (!title && event.type === 'ai-title' && typeof event.aiTitle === 'string') title = event.aiTitle;
    if (!firstUserText && event.type === 'message' && event.role === 'user' && Array.isArray(event.content)) {
      const joined = event.content.filter((c) => c && typeof c.text === 'string').map((c) => c.text).join('\n');
      const m = joined.match(/<user_query>([\s\S]*?)<\/user_query>/);
      const candidate = (m ? m[1] : joined).trim();
      if (candidate) firstUserText = candidate.replace(/\s+/g, ' ').slice(0, 160);
    }
    if (cwd && title && firstUserText) break;
  }

  // 长会话会被多次改名，`ai-title` 在文件里出现多条 —— 头部那条是**旧的**。
  // 再读一小段尾巴取最新标题（实测：头部写「阅读交接文档并解释后续工作」，尾部已是「总结知识库进度」）。
  if (size > readBytes + 1024) {
    const tailBytes = Math.min(size - readBytes, 65536);
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(tailBytes);
      const n = fs.readSync(fd, buf, 0, tailBytes, size - tailBytes);
      fs.closeSync(fd);
      for (const line of buf.toString('utf8', 0, n).split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'ai-title' && typeof event.aiTitle === 'string') title = event.aiTitle;
        } catch {
          /* 尾部首行可能被截断 */
        }
      }
    } catch {
      /* 尾巴读不到就用头部标题 */
    }
  }

  return { cwd, title, firstUserText };
}

/**
 * 把一个 WB 会话导入 CLI 的会话目录，使其可用 `--resume <sessionId>` 接续。
 *
 * ⚠️ `--resume` 只在**当前 cwd 对应的 project 目录**里找会话，所以：
 *   ① 必须用会话原本的 cwd 运行；② 文件要落到 `~/.codebuddy/projects/<slug(原cwd)>/`。
 * 不改动原文件（复制，不动 WB 的账）。
 */
export function importWbSession(config, input) {
  const sessionId = String(input && input.sessionId ? input.sessionId : '').trim();
  const srcPath = String(input && input.path ? input.path : '').trim();
  const cwd = String(input && input.cwd ? input.cwd : '').trim();
  if (!sessionId || !srcPath || !cwd) return { ok: false, reason: 'sessionId, path and cwd are all required' };
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(sessionId)) return { ok: false, reason: 'invalid sessionId' };
  if (!fs.existsSync(srcPath)) return { ok: false, reason: `session file not found: ${srcPath}` };
  if (!fs.existsSync(cwd)) return { ok: false, reason: `session cwd does not exist: ${cwd}` };

  const cliRoot = config.cliProjectsDir || path.join(os.homedir(), '.codebuddy', 'projects');
  const targetDir = path.join(cliRoot, sessionSlug(cwd));
  const target = path.join(targetDir, `${sessionId}.jsonl`);
  if (fs.existsSync(target) && fs.statSync(target).size === fs.statSync(srcPath).size) {
    return { ok: true, alreadyImported: true, target, cwd, sessionId };
  }
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(srcPath, target);
  } catch (error) {
    return { ok: false, reason: `import failed: ${String((error && error.message) || error)}` };
  }
  return {
    ok: true,
    alreadyImported: false,
    target,
    cwd,
    sessionId,
    bytes: fs.statSync(target).size,
    note: 'copied into the CLI session store; the WorkBuddy original is untouched',
  };
}

/* --------------------------- 读历史正文（给面板看） --------------------------- */

/** 只允许读 WB 会话目录之内的文件（防任意文件读取）。 */
export function isInsideWbStore(config, target) {
  const roots = config.wbProjectsDir ? [config.wbProjectsDir] : [path.join(os.homedir(), '.workbuddy', 'projects')];
  const resolved = path.resolve(target);
  return roots.some((root) => {
    const r = path.resolve(root);
    return resolved === r || resolved.toLowerCase().startsWith(r.toLowerCase() + path.sep);
  });
}

/** 用户消息里真正的问题是 `<user_query>` 内的内容；外层还裹着巨大的 system-reminder。 */
function extractUserText(content) {
  const joined = (content || [])
    .filter((c) => c && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
  const m = joined.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (m) return m[1].trim();
  return joined.replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '').trim();
}

function extractAssistantText(content) {
  return (content || [])
    .filter((c) => c && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim();
}

/**
 * 读一段 WB 会话的正文，归一化成面板能直接渲染的消息列表。
 *
 * 会话文件可达 68 MB，所以**只读尾部** `tailBytes`（默认 4 MB）—— 面板默认展示最近若干条。
 * 归一化规则：
 *   - `message`/user → 取 `<user_query>` 内的文本（去掉 system-reminder 噪声）
 *   - `message`/assistant → 取 content[].text
 *   - `function_call` → 压成一行 `[工具] <name> <参数摘要≤120字>`
 *   - 其余事件（reasoning / file-history-snapshot / …）一律跳过
 */
export function readWbTranscript(config, input) {
  const target = String((input && input.path) || '').trim();
  const limit = Math.max(1, Math.min(Number((input && input.limit) || config.transcriptLimit || 40), 200));
  // 默认**不含**工具行：真实会话尾部常常连续几十条 `[工具] Bash …`，
  // 带上它们会把真正的对话淹掉（实测 18.6 MB 会话尾部 12 条里 11 条是工具）。
  const includeTools = input && input.includeTools === true;
  if (!target) return { ok: false, reason: 'path is required' };
  if (!isInsideWbStore(config, target)) return { ok: false, reason: 'path is outside the WorkBuddy session store' };
  if (!fs.existsSync(target)) return { ok: false, reason: `session file not found: ${target}` };

  const size = fs.statSync(target).size;
  const tailBytes = Math.max(65536, Number(config.transcriptTailBytes) || 4 * 1024 * 1024);
  const readBytes = Math.min(size, tailBytes);
  const offset = size - readBytes;
  let text = '';
  try {
    const fd = fs.openSync(target, 'r');
    const buf = Buffer.alloc(readBytes);
    const n = fs.readSync(fd, buf, 0, readBytes, offset);
    fs.closeSync(fd);
    text = buf.toString('utf8', 0, n);
  } catch (error) {
    return { ok: false, reason: `read failed: ${String((error && error.message) || error)}` };
  }

  const lines = text.split(/\r?\n/);
  const partialHead = offset > 0;
  if (partialHead) lines.shift(); // 丢掉被截断的首行
  let skippedLines = partialHead ? 1 : 0;

  const messages = [];
  let title = null;
  let cwd = null;
  let totalEvents = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      skippedLines += 1;
      continue;
    }
    totalEvents += 1;
    if (!cwd && typeof event.cwd === 'string') cwd = event.cwd;
    if (event.type === 'ai-title' && typeof event.aiTitle === 'string') title = event.aiTitle;

    if (event.type === 'message' && (event.role === 'user' || event.role === 'assistant')) {
      const body = event.role === 'user' ? extractUserText(event.content) : extractAssistantText(event.content);
      if (!body) continue;
      messages.push({ role: event.role, text: body, at: event.timestamp || null, kind: 'message' });
      continue;
    }
    if (event.type === 'function_call') {
      if (!includeTools) continue;
      let args = '';
      try {
        args = typeof event.arguments === 'string' ? event.arguments : JSON.stringify(event.arguments || {});
      } catch {
        args = '';
      }
      messages.push({
        role: 'tool',
        text: `[工具] ${event.name || '?'} ${args.replace(/\s+/g, ' ').slice(0, 120)}`,
        at: event.timestamp || null,
        kind: 'tool',
      });
    }
  }

  const shown = messages.slice(-limit);
  return {
    ok: true,
    path: target,
    bytes: size,
    title,
    cwd,
    readBytes,
    tailOnly: offset > 0,
    totalEvents,
    skippedLines,
    total: messages.length,
    returned: shown.length,
    messages: shown,
  };
}

/* --------------------------- 技能上下文（认知对齐） --------------------------- */

function fallbackParagraph(content) {
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  let start = 0;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    start = end === -1 ? 0 : end + 1;
  }
  return (
    lines
      .slice(start)
      .find((line) => line && !line.startsWith('#') && !line.startsWith('---') && !line.startsWith('|') && !line.startsWith('-') && line.length > 12) || ''
  );
}

/** 解析 SKILL.md 的 name/description，必须处理 YAML 块标量（`description: >` / `|`）。 */
function parseSkillMeta(content, fallbackName) {
  let name = fallbackName;
  let description = '';
  const front = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (front) {
    const block = front[1];
    const nameMatch = block.match(/^\s*name\s*:\s*(.+)$/m);
    const descMatch = block.match(/^\s*description\s*:\s*(.+)$/m);
    if (nameMatch) {
      const rawName = nameMatch[1].trim();
      if (!/^[>|][-+]?$/.test(rawName)) name = rawName.replace(/^["']|["']$/g, '');
    }
    if (descMatch) {
      let value = descMatch[1].trim();
      if (/^[>|][-+]?$/.test(value)) {
        const after = block.slice(block.indexOf(descMatch[0]) + descMatch[0].length);
        const collected = [];
        for (const line of after.split(/\r?\n/)) {
          if (!line.trim()) {
            if (collected.length > 0) break;
            continue;
          }
          if (!/^\s+\S/.test(line)) break;
          collected.push(line.trim());
        }
        value = collected.join(' ');
      }
      value = value.replace(/^["']|["']$/g, '').trim();
      if (value.length > 3 && !/^[>|\-+]+$/.test(value)) description = value;
    }
  }
  if (!description) {
    const heading = content.match(/^#\s+(.+)$/m);
    if (heading && name === fallbackName) name = heading[1].trim();
    description = fallbackParagraph(content);
  }
  return { name, description: description.slice(0, 240) };
}

export function buildSkillContext(config) {
  const settings = config.skillContext || {};
  if (settings.enabled === false) return { text: '', count: 0, source: 'disabled' };

  let skills = [];
  let source = null;

  if (settings.mirrorPath && fs.existsSync(settings.mirrorPath)) {
    try {
      const mirror = JSON.parse(fs.readFileSync(settings.mirrorPath, 'utf8'));
      if (Array.isArray(mirror.skills)) {
        skills = mirror.skills.map((s) => ({ name: s.name || s.id, description: s.description || '', path: s.path }));
        source = settings.mirrorPath;
      }
    } catch {
      /* 坏镜像就退回自己扫 */
    }
  }

  if (skills.length === 0) {
    for (const dir of settings.skillDirs || []) {
      const root = expandHome(dir);
      let entries = [];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const file = path.join(root, entry.name, 'SKILL.md');
        try {
          const content = fs.readFileSync(file, 'utf8');
          const meta = parseSkillMeta(content, entry.name);
          skills.push({ name: meta.name, description: meta.description, path: file });
        } catch {
          /* 没有 SKILL.md 的目录跳过 */
        }
      }
      if (skills.length > 0 && !source) source = root;
    }
  }

  if (skills.length === 0) return { text: '', count: 0, source: 'none' };

  const roots = [...new Set(skills.map((s) => (s.path ? path.dirname(path.dirname(s.path)) : null)).filter(Boolean))];
  const header = [
    '以下是本机 WorkBuddy 的技能清单。技能正文位于：',
    ...roots.map((r) => `  ${r}\\<技能名>\\SKILL.md`),
    '执行任务前先判断是否有匹配的技能；有就读取该 SKILL.md，并严格按其口径与流程执行 ——',
    '**不要凭经验替代技能里的口径**（尤其估值口径、转录流程、删前验收这类）。',
    '',
  ].join('\n');

  const maxChars = Math.max(500, Number(settings.maxChars) || 9000);
  const descChars = Math.max(40, Number(settings.descriptionChars) || 110);
  const lines = [];
  let truncated = false;
  let budget = maxChars - header.length;
  for (const skill of skills) {
    const desc = (skill.description || '（无描述）').replace(/\s+/g, ' ').slice(0, descChars);
    const line = `- ${skill.name} — ${desc}`;
    if (line.length + 1 > budget) {
      truncated = true;
      break;
    }
    budget -= line.length + 1;
    lines.push(line);
  }
  if (truncated) lines.push(`…（受 ${maxChars} 字符预算限制，仅列出 ${lines.length}/${skills.length} 个技能）`);

  const text = `${header}${lines.join('\n')}`;
  return { text, count: skills.length, listed: lines.length, source, roots, chars: text.length, truncated };
}
