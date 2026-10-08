/**
 * dsh-wb-bridge —— dsh → WorkBuddy 功能级遥控桥（Host 半区）
 *
 * 一句话：把一条任务交给本机 `codebuddy` headless 引擎跑，把结果读回来。
 * 因为 dsh 本身已经能远程访问（dsh-lan-gate + Tailscale），装上这个插件之后
 * 「手机 → 远程 dsh → 本地 WB 干活」这条链就自然成立，不需要新的网络工作量。
 *
 * 边界（对应开发计划 §12.1）：
 *   - 这是**功能级**遥控：把任务交给 WB 的引擎执行、读回结果、读历史会话。
 *   - 不是界面级遥控：不点 WB 窗口、不碰 GUI。WB 是封闭 Electron 应用，无公开 GUI API。
 *
 * 安全默认：
 *   - `-y/--dangerously-skip-permissions` 默认禁用（`allowSkipPermissions: false`）。
 *   - cwd 必须落在 `allowedCwds` 之内。
 *   - 输出与台账全部过密钥遮蔽。
 *   - 超时/卸载按进程树杀。
 *   - 每次执行进 `out/wb-bridge-log.jsonl`（审计 + 事后算额度）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PERMISSION_PROFILES,
  buildSkillContext,
  createRegistry,
  engineVersion,
  listProfiles,
  maskSecrets,
  resolveEngine,
  resolveProfile,
} from './wb-runner.js';

export const name = 'dsh-wb-bridge';

/** 必须有 tools 才能注册工具。 */
export const inject = ['tools'];

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  /** 总开关。 */
  enabled: true,
  /** 引擎。默认取 PATH 上的 codebuddy。 */
  codebuddyPath: 'codebuddy',
  /** 不传 cwd 时用它。留空则取 ~/WorkBuddy/Claw（存在时）否则 ~。 */
  defaultCwd: '',
  /** cwd 白名单（`~` 会被展开）。 */
  allowedCwds: ['~'],
  /**
   * 默认模型。**给托管模型 id 就走 CodeBuddy 账号积分**；留空则用引擎默认
   * （即 `~/.codebuddy/models.json` 里那份**用户自己的 key**）。
   * 实测（2026-10-08）：`glm-5.3` 能跑通且它不在用户的 models.json 里 ⇒ 走账号通道。
   * 用户明确要求用积分而非自有 API，故默认设为托管模型。
   */
  defaultModel: 'deepseek-v4.1-flash',
  /** 默认最大 agentic 轮数。 */
  defaultMaxTurns: 15,
  /** 默认权限模式（不动引擎设置）。 */
  defaultPermissionMode: 'default',
  /**
   * 命名权限档。**调用方只能选档名，不能自带授权参数** —— 授权只能在这里预先定义。
   * 定义在 `wb-runner.js` 的 `DEFAULT_PERMISSION_PROFILES`（dsh-wb-bridge 与 dsh-wb-chat 共用同一真源）。
   * 这是整对象覆盖，改动请写全。
   */
  permissionProfiles: DEFAULT_PERMISSION_PROFILES,
  /** 默认档位。默认最保守的 readonly。 */
  defaultProfile: 'readonly',
  /** 是否允许调用方请求跳过权限确认。默认 false。 */
  allowSkipPermissions: false,
  /** 单次执行默认/最大超时（毫秒）。 */
  defaultTimeoutMs: 600000,
  maxTimeoutMs: 3600000,
  /** 工具侧默认等待时长：超过就返回 jobId 让调用方轮询。 */
  defaultWaitMs: 45000,
  /** 单次输出保留上限（字节）。 */
  maxOutputBytes: 200000,
  /** 审计台账路径；留空写到插件目录 out/。 */
  bridgeLogPath: '',
  /**
   * 认知对齐：把 WB 的技能清单追加进引擎的 system prompt。
   * 不注入的话，headless 引擎看不到 WB 应用本体的 60 个技能，遥控就只是"遥控一个通用 agent"。
   * 这是整对象覆盖，改动请写全。
   */
  skillContext: {
    enabled: true,
    /** 技能镜像；留空则用同级 dsh-wb-sync 的产物。 */
    mirrorPath: '',
    /** 没有镜像时自己扫这些目录。 */
    skillDirs: ['~/.workbuddy/skills'],
    maxChars: 8000,
  },
  /** 额外环境变量（可选，从 config 注入，不接受工具参数注入）。 */
  extraEnv: {},
};

const text = (value) => [
  { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
];

const OBJECT_OUTPUT = { type: 'object', additionalProperties: true };

/**
 * 输出给模型看的摘要。
 * `--output-format json` 的原始 stdout 是事件数组（实测 17 KB，含整段引擎 system prompt），
 * 所以这里只给结构化的 result；没有 result 时才退回截断原文。
 */
function summarize(job) {
  const { stdout, stderr, parsed, ...rest } = job;
  const events = Array.isArray(parsed) ? parsed.length : null;
  const out = { ...rest };
  // argv 里可能挂着几 KB 的技能上下文，回执里缩掉，只留长度
  if (Array.isArray(out.argv)) {
    out.argv = out.argv.map((token, index, list) => {
      if (index > 0 && list[index - 1] === '--append-system-prompt' && typeof token === 'string' && token.length > 200) {
        return `<system prompt, ${token.length} chars>`;
      }
      return token;
    });
  }
  if (job.result) {
    out.result = job.result;
  } else if (typeof stdout === 'string' && stdout.length > 0) {
    out.stdout = stdout.slice(0, 4000);
    out.stdoutNote = stdout.length > 4000 ? 'stdout truncated; the tail is available via wb_job_output' : undefined;
  }
  if (stderr) out.stderr = String(stderr).slice(0, 2000);
  if (events !== null) out.parsedEventCount = events;
  return out;
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) };
  if (!config.defaultCwd) {
    const candidate = path.join(os.homedir(), 'WorkBuddy', 'Claw');
    config.defaultCwd = fs.existsSync(candidate) ? candidate : os.homedir();
  }
  if (!config.bridgeLogPath) config.bridgeLogPath = path.join(PLUGIN_DIR, 'out', 'wb-bridge-log.jsonl');
  if (config.skillContext && !config.skillContext.mirrorPath) {
    // 同级 dsh-wb-sync 的镜像产物（同工作区并列摆放）
    config.skillContext.mirrorPath = path.join(PLUGIN_DIR, '..', 'dsh-wb-sync', 'out', 'wb-skills-mirror.json');
  }

  const registry = createRegistry(config);
  ctx.effect(() => () => registry.dispose());

  const register = (definition) => ctx.effect(() => ctx.tools.register(definition));

  register({
    name: 'wb_run_agent',
    description:
      "Run a task through the local WorkBuddy/CodeBuddy headless engine (codebuddy -p) and read the result. This is how a remote dsh session drives the local WorkBuddy agent. Returns the finished result when it completes within waitMs, otherwise a jobId to poll with wb_job_output. Each call consumes the user's own model quota, so prefer one well-specified task over several probes.",
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task/prompt for the WorkBuddy agent.' },
        profile: {
          type: 'string',
          description:
            "Named permission profile from the plugin config. readonly (default) = read-only; edits = may write files but cannot run commands; shell = may also run commands; full = skip all permission checks (only if the operator enabled it). You can only pick a name; you cannot supply permission arguments yourself.",
        },
        cwd: { type: 'string', description: 'Working directory; must be inside the plugin allowlist.' },
        model: { type: 'string', description: "Model id understood by the engine (e.g. 'deepseek-flash'). Omit to use the engine default." },
        maxTurns: { type: 'number', description: 'Limit agentic turns.' },
        permissionMode: { type: 'string', description: "Engine permission mode: default, acceptEdits, plan, dontAsk, auto, bypassPermissions." },
        dangerouslySkipPermissions: { type: 'boolean', description: 'Request -y. Refused unless the plugin config explicitly allows it.' },
        tools: { type: 'string', description: 'Restrict built-in tools; "" disables all, "default" allows all, or a comma list.' },
        allowedTools: { type: 'array', items: { type: 'string' }, description: 'Tool names to allow.' },
        disallowedTools: { type: 'array', items: { type: 'string' }, description: 'Tool names to deny.' },
        addDirs: { type: 'array', items: { type: 'string' }, description: 'Extra directories the agent may touch (--add-dir).' },
        appendSystemPrompt: { type: 'string', description: 'Extra system prompt, e.g. to inject the WorkBuddy skill catalog.' },
        sessionId: { type: 'string', description: 'Reuse a specific session id for multi-turn work.' },
        continueSession: { type: 'boolean', description: 'Continue the most recent conversation (-c).' },
        outputFormat: { type: 'string', enum: ['json', 'text', 'stream-json'], description: 'Engine output format (default json).' },
        timeoutMs: { type: 'number', description: 'Hard timeout; the process tree is killed on expiry.' },
        waitMs: { type: 'number', description: 'How long to wait inline before returning a jobId (default 45s).' },
        dryRun: { type: 'boolean', description: 'Build and return the exact command without executing it.' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => text(value) },
    execute: async (args) => {
      const waitMs = args && args.waitMs !== undefined ? args.waitMs : config.defaultWaitMs;
      // 认知对齐：调用方没显式给 system prompt 时，自动注入 WB 技能清单
      const skillContext = buildSkillContext(config);
      const appendSystemPrompt =
        (args && args.appendSystemPrompt) ||
        (skillContext.text ? skillContext.text : undefined);
      const started = registry.start({
        ...args,
        appendSystemPrompt,
        model: (args && args.model) || config.defaultModel || undefined,
        maxTurns: (args && args.maxTurns) || config.defaultMaxTurns,
        permissionMode: (args && args.permissionMode) || config.defaultPermissionMode,
      });
      if (started.dryRun || started.status !== 'running') {
        return { ...summarize(started), skillContext: { injected: Boolean(appendSystemPrompt), count: skillContext.count, source: skillContext.source } };
      }
      const done = await registry.poll(started.jobId, { waitMs });
      const payload = done.ok ? done : started;
      if (payload.status === 'running') {
        return {
          status: 'running',
          jobId: payload.jobId,
          hint: 'still running; call wb_job_output with this jobId',
          cwd: payload.cwd,
          profile: payload.profile,
          argv: payload.argv,
          startedAt: payload.startedAt,
          skillContext: { injected: Boolean(appendSystemPrompt), count: skillContext.count, source: skillContext.source },
        };
      }
      return { ...summarize(payload), skillContext: { injected: Boolean(appendSystemPrompt), count: skillContext.count, source: skillContext.source } };
    },
    presentCall: (args) => ({
      card: 'terminal',
      title: `WB 引擎 · ${String((args && args.task) || '').slice(0, 80)}`,
      description: 'codebuddy headless',
      cwd: (args && args.cwd) || config.defaultCwd,
    }),
    presentResult: (args, value) => ({
      card: 'terminal',
      title: value && value.result && value.result.text ? 'WB 引擎回复' : `WB 引擎结果（${(value && value.status) || 'done'}）`,
      output: value
        ? String((value.result && value.result.text) || value.stdout || '').slice(0, 4000) || undefined
        : undefined,
      exitCode: value && typeof value.exitCode === 'number' ? value.exitCode : undefined,
    }),
  });

  register({
    name: 'wb_job_output',
    description:
      'Poll a WorkBuddy engine job started by wb_run_agent: status, exit code, parsed JSON result, and the (secret-masked) stdout/stderr captured so far. Optionally wait.',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Job id returned by wb_run_agent.' },
        waitMs: { type: 'number', description: 'Block up to this long for completion before reporting.' },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => text(value) },
    execute: async (args) => {
      const result = await registry.poll(args && args.jobId, { waitMs: args && args.waitMs });
      if (!result.ok) return result;
      return summarize(result);
    },
  });

  register({
    name: 'wb_job_list',
    description: 'List WorkBuddy engine jobs tracked by this dsh host process (running and finished), with a masked task preview.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => text(value) },
    execute: async () => registry.list(),
  });

  register({
    name: 'wb_job_kill',
    description: 'Kill a running WorkBuddy engine job. Terminates the whole process tree, not just the top process.',
    parameters: {
      type: 'object',
      properties: { jobId: { type: 'string', description: 'Job id to kill.' } },
      required: ['jobId'],
      additionalProperties: false,
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => text(value) },
    execute: async (args) => registry.kill(args && args.jobId),
  });

  register({
    name: 'wb_skill_context',
    description:
      "Show the WorkBuddy skill catalog that wb_run_agent injects into the engine's system prompt (name, purpose, and the SKILL.md path the engine can read). This is how the remote engine gets WorkBuddy's actual skills instead of behaving as a generic agent. Read-only, no model call.",
    parameters: {
      type: 'object',
      properties: {
        previewChars: { type: 'number', description: 'How many characters of the injected prompt to show (default 2000).' },
      },
      additionalProperties: false,
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => text(value) },
    execute: async (args) => {
      const ctxInfo = buildSkillContext(config);
      const previewChars = Math.max(200, Number((args && args.previewChars) || 2000));
      return {
        injected: Boolean(ctxInfo.text),
        count: ctxInfo.count,
        source: ctxInfo.source,
        chars: ctxInfo.chars || 0,
        truncated: Boolean(ctxInfo.truncated),
        mirrorPath: config.skillContext ? config.skillContext.mirrorPath : null,
        skillDirs: config.skillContext ? config.skillContext.skillDirs : null,
        preview: ctxInfo.text ? ctxInfo.text.slice(0, previewChars) : '',
        note: 'injected unless the caller passes its own appendSystemPrompt',
      };
    },
  });

  register({
    name: 'wb_bridge_status',
    description:
      'Report the dsh -> WorkBuddy bridge: engine path and version, default cwd, allowlists, permission policy, timeout/output caps, job counts, and the audit ledger path. Read-only, no model call.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => text(value) },
    execute: async () => {
      const engine = resolveEngine(config);
      const ledger = (() => {
        try {
          const raw = fs.readFileSync(config.bridgeLogPath, 'utf8');
          const lines = raw.split(/\r?\n/).filter(Boolean);
          return { path: config.bridgeLogPath, exists: true, runs: lines.length };
        } catch {
          return { path: config.bridgeLogPath, exists: false, runs: 0 };
        }
      })();
      const jobs = registry.list();
      return {
        plugin: 'dsh-wb', domain: 'bridge',
        stage: 'C2 (single-direction control) — path A, headless engine',
        enabled: config.enabled !== false,
        engine: {
          configured: config.codebuddyPath,
          resolved: engine.command,
          found: engine.found,
          source: engine.source,
          version: engine.found ? engineVersion(engine.command) : null,
        },
        engineConfigNote:
          'engine models come from ~/.codebuddy/models.json (user-owned DeepSeek keys); this plugin never reads or forwards those keys',
        defaults: {
          cwd: config.defaultCwd,
          model: config.defaultModel || '(engine default)',
          maxTurns: config.defaultMaxTurns,
          permissionMode: config.defaultPermissionMode,
          waitMs: config.defaultWaitMs,
          timeoutMs: config.defaultTimeoutMs,
        },
        policy: {
          allowedCwds: config.allowedCwds,
          defaultProfile: config.defaultProfile || 'readonly',
          profiles: listProfiles(config),
          profileRule: 'the caller can only select a profile by name; permission arguments are defined here, never supplied by the caller',
          allowSkipPermissions: config.allowSkipPermissions === true,
          maxOutputBytes: config.maxOutputBytes,
          secretMasking: 'engine output and audit ledger are always masked',
          killScope: 'process tree (taskkill /T /F on Windows)',
        },
        jobs: { total: jobs.total, running: jobs.running },
        skillContext: (() => {
          const info = buildSkillContext(config);
          return {
            enabled: config.skillContext ? config.skillContext.enabled !== false : false,
            injectedSkills: info.count,
            chars: info.chars || 0,
            source: info.source,
            note: 'injected into the engine system prompt so it knows WorkBuddy skills',
          };
        })(),
        ledger,
      };
    },
  });
}
