/**
 * wb-runner.js —— dsh → WorkBuddy 引擎执行层
 *
 * 职责：把一条自然语言任务交给本机 `codebuddy` headless 引擎跑完，把结果读回来。
 *
 * 事实依据（2026-10-08 本机实测，`codebuddy --help` v2.156.0）：
 *   - 引擎：`%LOCALAPPDATA%\codebuddy\bin\codebuddy.exe`（通常已在 PATH 上）。
 *   - 非交互入口：`-p/--print`；输出格式 `--output-format text|json|stream-json`。
 *   - 会话：`--session-id <uuid>` / `-c/--continue` / `-r/--resume <id>`。
 *   - 约束：`--max-turns` / `--tools` / `--allowedTools` / `--disallowedTools` / `--permission-mode`。
 *   - `~/.codebuddy/models.json` 配的是**用户自己的 DeepSeek key**（deepseek-flash / deepseek-v4-pro）
 *     ⇒ 走 headless 烧的是 DeepSeek 额度，不是 WB 积分。本模块**不读也不传任何密钥**，
 *     引擎自己从 `~/.codebuddy/models.json` 取。
 *
 * 安全边界：
 *   1. cwd 必须落在 `allowedCwds` 之内。
 *   2. `-y/--dangerously-skip-permissions` 默认禁用，且只有 config 显式放行时才可用。
 *   3. 输出与台账一律过密钥遮蔽（引擎万一读到了 key，不让它二次落进会话记录）。
 *   4. 超时/插件卸载时按**进程树**杀（Windows 上 `taskkill /T /F`），不留孤儿。
 *   5. 每次执行进审计台账 `out/wb-bridge-log.jsonl`。
 */

import { spawn, spawnSync } from 'node:child_process';
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

/* --------------------------- 引擎解析 --------------------------- */

/** 找 headless 引擎。优先 config.codebuddyPath，其次 PATH（`where`）。 */
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

/** 引擎版本（不触发模型调用）。 */
export function engineVersion(command) {
  try {
    const probe = spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    return String(probe.stdout || probe.stderr || '').trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

/* --------------------------- 权限档 --------------------------- */

/**
 * 命名权限档。**安全设计要点：调用方（模型）只能选档名，不能自带 argv。**
 * 授权能力只能由 config 里的档位预先定义，否则模型可以自己给自己发权限。
 *
 * 四档的实测依据（2026-10-08，`_scratch/wb-perm-experiment.mjs`）：
 *   - default（无 settings）→ 读放行；Write/Bash/PowerShell 全部被拒；11 轮快速失败、不挂起。
 *   - settings 只 allow Write/Edit/Read → Write 成功、**Bash 被精确拒绝**。
 *   - settings allow 含 Bash → 命令真被执行（`echo shell-ok` 输出回传）。
 *   - `-y` → 未实测（受 allowSkipPermissions 闸门保护）。
 *
 * **这是单一真源**：`dsh-wb-bridge` 与 `dsh-wb-chat` 都引用它，避免两处各写一份授权参数。
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
 * 档位的 tools 取值约定（避免"默认值吃掉显式配置"）：
 *   undefined → 'default'（没写就用引擎默认工具面）
 *   null / ''  → 不生成 --tools 开关（由引擎自行决定）
 *   'default' / 'Read,Grep' / '' 等字符串 → 原样透传
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
    // 显式请求的名字不存在 → 报错。绝不能把明确意图静默降级。
    if (explicit) {
      return { ok: false, reason: `unknown permission profile "${requested}"; available: ${available}` };
    }
    // 完全没配置档位属于配置形态意外 → 退回内置最保守行为（等价 readonly），而不是让所有调用都失败。
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
    return {
      ok: false,
      reason: `permission profile "${requested}" is disabled by plugin config (allowSkipPermissions: false)`,
    };
  }
  return {
    ok: true,
    name: requested,
    description: profile.description || '',
    tools: profileTools(profile),
    args: Array.isArray(profile.args) ? profile.args : [],
  };
}

/* --------------------------- argv 构造 --------------------------- */

const TRUTHY = new Set(['text', 'json', 'stream-json']);

/** 把 `['--flag','v','-x']` 折成 Map（后写覆盖前写，用于"显式参数赢档位默认"）。 */
function foldArgs(list, into) {
  for (let i = 0; i < list.length; i += 1) {
    const token = list[i];
    if (typeof token !== 'string' || !token.startsWith('-')) continue;
    const next = list[i + 1];
    if (next !== undefined && !String(next).startsWith('-')) {
      into.set(token, String(next));
      i += 1;
    } else {
      into.set(token, true);
    }
  }
  return into;
}

export function buildArgv(input, config) {
  const task = String((input && input.task) || '').trim();
  if (!task) throw new Error('task is required');

  const profile = resolveProfile(input, config);
  if (!profile.ok) throw new Error(profile.reason);

  // outputFormat:'none' 用来对接不支持 --output-format 的引擎版本（也方便用假引擎做管道自测）
  const wantsNone = input.outputFormat === 'none';
  const outputFormat = TRUTHY.has(input.outputFormat) ? input.outputFormat : 'json';

  // 档位参数先落地，随后显式参数覆盖同名开关（Map 保持首次插入位置、值取最后写入）
  const options = foldArgs(profile.args, new Map());

  if (input.model) options.set('--model', String(input.model));
  if (input.jsonSchema) options.set('--json-schema', JSON.stringify(input.jsonSchema));
  if (input.maxTurns) options.set('--max-turns', String(input.maxTurns));
  if (input.permissionMode) options.set('--permission-mode', String(input.permissionMode));
  const tools = input.tools !== undefined ? input.tools : profile.tools;
  if (tools) options.set('--tools', String(tools));
  if (Array.isArray(input.allowedTools) && input.allowedTools.length) options.set('--allowedTools', input.allowedTools.map(String).join(' '));
  if (Array.isArray(input.disallowedTools) && input.disallowedTools.length) options.set('--disallowedTools', input.disallowedTools.map(String).join(' '));
  if (input.sessionId) options.set('--session-id', String(input.sessionId));
  if (input.continueSession) options.set('-c', true);
  if (input.resumeSession) options.set('-r', String(input.resumeSession));
  if (input.appendSystemPrompt) options.set('--append-system-prompt', String(input.appendSystemPrompt));
  if (input.systemPromptFile) options.set('--system-prompt-file', String(input.systemPromptFile));
  if (input.addDirs && input.addDirs.length) options.set('--add-dir', input.addDirs.map(String).join(' '));
  if (input.effort) options.set('--effort', String(input.effort));

  // 危险开关：调用方单独请求时仍受同一个闸门约束（防止绕过档位）
  if (input.dangerouslySkipPermissions) {
    if (config.allowSkipPermissions !== true) {
      throw new Error('dangerouslySkipPermissions is disabled by plugin config (allowSkipPermissions: false)');
    }
    options.set('-y', true);
  }

  const argv = ['-p', task];
  if (!wantsNone) argv.push('--output-format', outputFormat);
  for (const [flag, value] of options) {
    if (value === true) argv.push(flag);
    else argv.push(flag, value);
  }
  return argv;
}

/* --------------------------- 路径白名单 --------------------------- */

function isWithin(root, target) {
  const r = path.resolve(root).toLowerCase();
  const t = path.resolve(target).toLowerCase();
  if (t === r) return true;
  return t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** `~` / `~/x` 展开成用户目录。请求方与白名单两侧都要展开 —— 曾经只展开了白名单。 */
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

/* --------------------------- 技能上下文（认知对齐） --------------------------- */

/** 从 SKILL.md 抽一段兜底描述（frontmatter 缺省或退化时用）。 */
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

/**
 * 从 SKILL.md 抓 name/description（frontmatter 优先，否则退回首个标题/段落）。
 * 与 dsh-wb-sync 的镜像解析同口径，但这里自带一份，避免跨插件硬依赖。
 *
 * ⚠️ 必须处理 YAML **块标量**（`description: >` / `|`），否则描述会被抓成 `>` / `|` ——
 * 早期两处解析器都犯过这个错，实测 `annual-report-analysis` / `cnki-search` 就是这样退化的。
 */
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

/**
 * 组装要追加给引擎的技能清单（system prompt 片段）。
 *
 * 为什么必须有这一步：headless 引擎有**它自己**的记忆与技能面
 * （实测 `~/.codebuddy/projects/<slug>/memory`，空），看不到 WB 应用本体的
 * `~/.workbuddy/skills/`（60 个）。不注入的话，"遥控 WB" 只是"遥控一个通用 agent"。
 * 引擎的 `trustedDirectories` 覆盖 `C:/Users/<you>/**`，所以清单里给出正文路径是可执行的。
 *
 * 优先用 dsh-wb-sync 已产出的镜像；没有就自己扫 SKILL.md。
 */
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
      const root = String(dir).replace(/^~(?=$|[\\/])/, os.homedir());
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

  // 技能根目录只写一次：每条都带完整路径会吃掉 1/3 预算，导致部分技能对引擎"等于不存在"
  // （实测 60 个技能 × 完整路径 ≈ 12 K 字符，8 K 上限下只列得进约 38 个）。
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

/* --------------------------- 任务注册表 --------------------------- */

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

function appendLedger(config, entry) {
  if (!config.bridgeLogPath) return { written: false };
  try {
    fs.mkdirSync(path.dirname(config.bridgeLogPath), { recursive: true });
    fs.appendFileSync(config.bridgeLogPath, `${JSON.stringify(entry)}\n`, 'utf8');
    return { written: true, path: config.bridgeLogPath };
  } catch (error) {
    return { written: false, reason: String((error && error.message) || error) };
  }
}

export function createRegistry(config) {
  /** jobId -> job */
  const jobs = new Map();
  let counter = 0;
  let disposed = false;

  const maxBytes = Math.max(4096, Number(config.maxOutputBytes) || 200000);

  const snapshot = (job) => ({
    jobId: job.id,
    status: job.status,
    engine: job.command,
    cwd: job.cwd,
    model: job.model || null,
    profile: job.profile || null,
    tools: job.tools || null,
    dryRun: job.dryRun,
    argv: job.argv,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    durationMs: job.endedAt ? Date.parse(job.endedAt) - Date.parse(job.startedAt) : Date.now() - Date.parse(job.startedAt),
    exitCode: job.exitCode,
    signal: job.signal,
    stdoutBytes: job.stdoutBytes,
    stderrBytes: job.stderrBytes,
    truncated: job.truncated,
    redactions: job.redactions,
    stdout: job.stdout,
    stderr: job.stderr,
    parsed: job.parsed,
    result: job.result,
  });

  const finish = (job, patch) => {
    Object.assign(job, patch);
    const payload = {
      at: new Date().toISOString(),
      jobId: job.id,
      cwd: job.cwd,
      model: job.model || null,
      taskPreview: maskSecrets(job.task.slice(0, 200)).text,
      dryRun: job.dryRun,
      exitCode: job.exitCode,
      status: job.status,
      durationMs: job.endedAt ? Date.parse(job.endedAt) - Date.parse(job.startedAt) : null,
      stdoutBytes: job.stdoutBytes,
      truncated: job.truncated,
    };
    payload.ledger = appendLedger(config, payload);
    job.ledger = payload.ledger;
  };

  const start = (input) => {
    if (disposed) throw new Error('bridge registry is disposed');
    if (config.enabled === false) throw new Error('dsh-wb-bridge is disabled by config (enabled: false)');

    const engine = resolveEngine(config);
    if (!engine.found) throw new Error(`codebuddy engine not found (looked for "${config.codebuddyPath || 'codebuddy'}" on PATH)`);

    const cwdCheck = resolveCwd(input && input.cwd, config);
    if (!cwdCheck.ok) throw new Error(cwdCheck.reason);

    const argv = buildArgv(input, config);
    const task = String(input.task).trim();
    const profile = resolveProfile(input, config);

    counter += 1;
    const job = {
      id: `wb-${Date.now().toString(36)}-${counter}`,
      command: engine.command,
      argv,
      cwd: cwdCheck.cwd,
      task,
      model: input.model || null,
      profile: profile.ok ? profile.name : null,
      tools: input.tools !== undefined ? input.tools : profile.ok ? profile.tools : null,
      dryRun: Boolean(input.dryRun),
      status: 'running',
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      stdoutBytes: 0,
      stderrBytes: 0,
      truncated: false,
      redactions: 0,
      parsed: null,
      ledger: null,
    };

    if (job.dryRun) {
      job.status = 'dry-run';
      job.endedAt = new Date().toISOString();
      finish(job, {});
      jobs.set(job.id, job);
      return { dryRun: true, ...snapshot(job) };
    }

    const timeoutMs = Math.min(
      Math.max(1000, Number(input.timeoutMs) || config.defaultTimeoutMs),
      Number(config.maxTimeoutMs) || 3600000,
    );

    const child = spawn(engine.command, argv, {
      cwd: job.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(config.extraEnv || {}) },
    });
    job.child = child;
    job.pid = child.pid;

    const take = (chunk, which) => {
      const raw = String(chunk);
      const masked = maskSecrets(raw);
      job.redactions += masked.redactions;
      const current = which === 'out' ? job.stdoutBytes : job.stderrBytes;
      if (current >= maxBytes) {
        job.truncated = true;
        return;
      }
      const room = maxBytes - current;
      const piece = Buffer.byteLength(masked.text, 'utf8') > room ? masked.text.slice(0, room) : masked.text;
      if (which === 'out') {
        job.stdout += piece;
        job.stdoutBytes += Buffer.byteLength(piece, 'utf8');
      } else {
        job.stderr += piece;
        job.stderrBytes += Buffer.byteLength(piece, 'utf8');
      }
      if (Buffer.byteLength(masked.text, 'utf8') > room) job.truncated = true;
    };

    child.stdout.on('data', (chunk) => take(chunk, 'out'));
    child.stderr.on('data', (chunk) => take(chunk, 'err'));

    job.timer = setTimeout(() => {
      if (job.status !== 'running') return;
      job.status = 'timeout';
      job.timedOut = true;
      killTree(child);
    }, timeoutMs);

    job.exited = new Promise((resolve) => {
      child.on('error', (error) => {
        clearTimeout(job.timer);
        job.status = 'failed';
        job.endedAt = new Date().toISOString();
        job.spawnError = String((error && error.message) || error);
        finish(job, {});
        resolve(job);
      });
      child.on('close', (code, signal) => {
        clearTimeout(job.timer);
        if (job.status === 'running') job.status = code === 0 ? 'done' : 'failed';
        job.endedAt = new Date().toISOString();
        job.exitCode = code;
        job.signal = signal || null;
        const parsed = tryParse(job.stdout);
        job.parsed = parsed;
        job.result = extractResult(parsed);
        finish(job, {});
        resolve(job);
      });
    });

    jobs.set(job.id, job);

    // 内存里的 job 记录留着给轮询；只保留最近 50 条
    if (jobs.size > 50) {
      for (const key of [...jobs.keys()]) {
        const candidate = jobs.get(key);
        if (candidate.status !== 'running' && key !== job.id) {
          jobs.delete(key);
          if (jobs.size <= 50) break;
        }
      }
    }

    return snapshot(job);
  };

  const poll = async (jobId, options) => {
    const job = jobs.get(jobId);
    if (!job) return { ok: false, reason: `unknown jobId: ${jobId}` };
    const waitMs = Math.max(0, Math.min(Number((options && options.waitMs) || 0), 600000));
    if (waitMs > 0 && job.status === 'running') {
      await Promise.race([job.exited, new Promise((resolve) => setTimeout(resolve, waitMs))]);
    }
    return { ok: true, ...snapshot(job) };
  };

  const list = () => ({
    total: jobs.size,
    running: [...jobs.values()].filter((j) => j.status === 'running').length,
    jobs: [...jobs.values()].map((j) => ({
      jobId: j.id,
      status: j.status,
      cwd: j.cwd,
      model: j.model,
      startedAt: j.startedAt,
      endedAt: j.endedAt,
      exitCode: j.exitCode,
      taskPreview: maskSecrets(j.task.slice(0, 120)).text,
    })),
  });

  const kill = (jobId) => {
    const job = jobs.get(jobId);
    if (!job) return { ok: false, reason: `unknown jobId: ${jobId}` };
    if (job.status !== 'running') return { ok: true, jobId, status: job.status, note: 'already finished' };
    job.status = 'killed';
    killTree(job.child);
    return { ok: true, jobId, status: 'killed' };
  };

  const dispose = () => {
    disposed = true;
    for (const job of jobs.values()) if (job.status === 'running') killTree(job.child);
  };

  return { start, poll, list, kill, dispose, jobs };
}

function tryParse(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * 从 `--output-format json` 的事件数组里取出人真正要的东西。
 *
 * 实测（2026-10-08，codebuddy 2.156.0）：json 模式吐的是一个**事件数组**，
 * 依次是 user message / file-history-snapshot / assistant message / result，
 * 最终答案、用量、session id 都在最后那条 `{type:'result'}` 里。
 * 不提取的话模型只会看到 17 KB 噪声（还把整段引擎 system prompt 带回来）。
 */
export function extractResult(parsed) {
  if (!Array.isArray(parsed)) return null;
  const result = [...parsed].reverse().find((entry) => entry && entry.type === 'result');
  if (!result) return null;
  const usage = result.usage || {};
  return {
    text: typeof result.result === 'string' ? result.result : null,
    isError: Boolean(result.is_error),
    subtype: result.subtype || null,
    sessionId: result.session_id || null,
    numTurns: result.num_turns === undefined ? null : result.num_turns,
    durationMs: result.duration_ms === undefined ? null : result.duration_ms,
    totalCostUsd: result.total_cost_usd === undefined ? null : result.total_cost_usd,
    permissionDenials: Array.isArray(result.permission_denials) ? result.permission_denials : [],
    usage: {
      inputTokens: usage.input_tokens === undefined ? null : usage.input_tokens,
      outputTokens: usage.output_tokens === undefined ? null : usage.output_tokens,
      cacheReadInputTokens: usage.cache_read_input_tokens === undefined ? null : usage.cache_read_input_tokens,
      cacheCreationInputTokens: usage.cache_creation_input_tokens === undefined ? null : usage.cache_creation_input_tokens,
    },
  };
}
