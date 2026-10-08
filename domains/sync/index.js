/**
 * dsh-wb-sync —— WorkBuddy ↔ DSH 记忆/技能同步插件（Host 半区）
 *
 * M1：**只读 View** —— dsh 能列举、读取、检索 WB 的记忆/身份/技能/plan，并生成 CONTEXT 索引。
 * M2：**写回** —— dsh 的结论可追加进 WB 每日日志（只追加 / 写前 `.bak` / 命中密钥拒绝 / 幂等 / 台账）。
 *
 * 设计约束（来自《WB ↔ dsh 记忆同步插件 · 开发计划》与本机既有插件惯例）：
 *   - 零依赖、零构建：只用 node: 内置模块，`install_bundle` 直接装。
 *   - 一切注册都走 `ctx.effect(...)` 并返回 disposer，插件卸载即回收。
 *   - dsh 侧记忆**不读也不写文件**：真源是 Mnemon（`~/.mnemon`），M3 才接。
 *   - 密钥/凭证/会话转录永不进工具输出（见 wb-assets.js 黑名单与脱敏）。
 *   - 身份类资产分级固定 `normal`，禁标 `critical`（用户硬规矩）。
 *
 * 开发计划 §3 原定「中枢式 MCP server + WB/dsh 双端接入」；本机实测后改为
 * **Cordis 插件形态**（DSH 无 MCP client 挂载、WB 侧 5 个 MCP server 全部 disabled），
 * 同步逻辑跑在 dsh 宿主进程内，WB 侧资产按文件层读写。偏差记录见 README。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  CATEGORIES,
  appendDailyMemory,
  buildIndexMarkdown,
  listAssets,
  readAsset,
  readWriteLedger,
  resolveRoots,
  searchAssets,
} from './wb-assets.js';

import {
  applyPlan,
  buildPlan,
  buildSkillsMirror,
  listDshAssets,
  listWbItems,
  loadState,
} from './sync-core.js';

export const name = 'dsh-wb-sync';

/** 必须有 tools 才能注册工具；缺了就让插件保持不激活，而不是抛错。 */
export const inject = ['tools'];

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  /** WB 用户级目录。 */
  wbHome: path.join(os.homedir(), '.workbuddy'),
  /** WB 个人目录；留空则自动发现 `user-*-personal`。 */
  personalDir: '',
  /** WB 项目级每日日志/项目记忆目录。 */
  projectMemoryDirs: [path.join(os.homedir(), 'WorkBuddy', 'Claw', '.workbuddy', 'memory')],
  /** 索引输出路径；留空则写到插件目录下 out/。 */
  indexOutputPath: '',
  /** 单次读取上限（字节）。 */
  maxReadBytes: 200000,
  /** 读取硬上限，配置无法突破。 */
  maxReadBytesHard: 1000000,
  /** 检索时最多扫描的文件数。 */
  maxSearchFiles: 400,
  /** 单次检索最多返回的命中行数。 */
  maxSearchHits: 60,
  /** 枚举/索引的文件数上限。 */
  maxIndexFiles: 2000,
  /** M2 写回总开关。 */
  writeEnabled: true,
  /** 单条写回正文上限（字节）。 */
  maxWriteBytes: 20000,
  /** 单轮同步最多推送多少条 dsh 独有条目进 WB 日志（防止首轮刷屏）。 */
  maxPushPerRun: 5,
  /** 跨侧条目匹配的 bigram 相似度阈值（越高越严）。 */
  similarityThreshold: 0.62,
  /** 写回台账路径；留空则写到插件目录下 out/。 */
  writeLogPath: '',
  /** Mnemon 主目录（dsh 侧记忆，**只读**）。 */
  mnemonHome: path.join(os.homedir(), '.mnemon'),
  /** Mnemon 热记忆投影目录（`memories.json` / `MEMORY.md` / `USER.md`）。 */
  mnemonRuntimeDir: '',
  /** M3 同步状态与计划落盘位置；留空则写到插件目录下 out/。 */
  syncStatePath: '',
  syncPlanPath: '',
  inboxDir: '',
  /** M4 技能镜像落盘位置；留空则写到插件目录下 out/。 */
  skillsMirrorPath: '',
  skillsMirrorMarkdownPath: '',
  /** M4 自动触发（挂 `agent/turn-stopping`）。注意：这是整对象覆盖，改动请写全。 */
  autoTrigger: {
    enabled: true,
    minIntervalMs: 300000,
    refreshSkillsMirror: true,
  },
};

const text = (value) => [
  { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
];

const OBJECT_OUTPUT = { type: 'object', additionalProperties: true };

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) };
  const outDir = path.join(PLUGIN_DIR, 'out');
  if (!config.mnemonRuntimeDir) config.mnemonRuntimeDir = path.join(config.mnemonHome, 'runtime');
  if (!config.indexOutputPath) config.indexOutputPath = path.join(outDir, 'wb-assets-index.md');
  if (!config.writeLogPath) config.writeLogPath = path.join(outDir, 'wb-write-log.jsonl');
  if (!config.syncStatePath) config.syncStatePath = path.join(outDir, 'sync-state.json');
  if (!config.syncPlanPath) config.syncPlanPath = path.join(outDir, 'sync-plan.json');
  if (!config.inboxDir) config.inboxDir = path.join(outDir, 'inbox');
  if (!config.skillsMirrorPath) config.skillsMirrorPath = path.join(outDir, 'wb-skills-mirror.json');
  if (!config.skillsMirrorMarkdownPath) config.skillsMirrorMarkdownPath = path.join(outDir, 'wb-skills-mirror.md');

  const roots = resolveRoots(config);

  /** 每次调用重算出根（用户可能在会话中途新增了计划目录）。 */
  const currentRoots = () => resolveRoots(config);

  const register = (definition) => ctx.effect(() => ctx.tools.register(definition));

  register({
    name: 'wb_list_assets',
    description:
      'List WorkBuddy assets (memory / identity / skills / plans / daily logs) visible to dsh. Read-only; secrets, session transcripts, and binaries are always excluded.',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['all', ...CATEGORIES],
          description: "Asset category; 'all' (default) returns every category.",
        },
      },
      additionalProperties: false,
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => text(value) },
    execute: async (args) => listAssets(config, currentRoots(), args && args.category),
    presentCall: (args) => ({
      card: 'search',
      title: `List WorkBuddy assets (${(args && args.category) || 'all'})`,
      shape: 'paths',
      paths: [],
      truncated: false,
      total: 0,
    }),
  });

  register({
    name: 'wb_read_asset',
    description:
      "Read one WorkBuddy asset by absolute path or by '<category>/<relative path>' (for example 'memory/MEMORY.md'). Secret-looking lines are redacted before returning.",
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path, or <category>/<relative path>.' },
        maxBytes: { type: 'number', description: 'Optional per-call byte cap.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => text(value) },
    execute: async (args) =>
      readAsset(config, currentRoots(), args && args.path, args && args.maxBytes),
  });

  register({
    name: 'wb_search',
    description:
      'Keyword search across WorkBuddy memory, identity, skills, plans, and daily logs. All whitespace-separated terms must match on the same line (case-insensitive).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'One or more keywords; all must match.' },
        scope: {
          type: 'string',
          enum: ['all', ...CATEGORIES],
          description: "Limit the search to one category; 'all' (default) searches everything.",
        },
        limit: { type: 'number', description: 'Maximum matching lines to return.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => text(value) },
    execute: async (args) =>
      searchAssets(config, currentRoots(), args && args.query, args && args.scope, args && args.limit),
  });

  register({
    name: 'wb_sync_status',
    description:
      'Report the WorkBuddy ↔ dsh sync surface: resolved asset roots, per-category counts, exclusion rules, and index state. Read-only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => text(value) },
    execute: async () => {
      const live = currentRoots();
      const listing = listAssets(config, live, 'all');
      let indexPath = config.indexOutputPath;
      let indexStat = null;
      try {
        indexStat = fs.statSync(indexPath);
      } catch {
        indexStat = null;
      }
      return {
        plugin: 'dsh-wb', domain: 'sync',
        stage: 'M1 read-only view + M2 write-back + M3 two-way merge + M4 skill mirror',
        wbHome: config.wbHome,
        roots: live,
        counts: Object.fromEntries(listing.groups.map((g) => [g.category, g.count])),
        total: listing.total,
        tierRule: 'identity and memory assets are always normal; critical is never assigned',
        exclusions: {
          segments: 'sessions / logs / tmp / cache / blobs / local_storage / node_modules / binaries / vendor / uuid dirs',
          files: 'mcp.json / settings.json / user-state.json / keyblob / workbuddy.db / credentials',
          extensions: 'only .md .markdown .txt .json .yaml .yml',
        },
        index: {
          path: indexPath,
          exists: Boolean(indexStat),
          bytes: indexStat ? indexStat.size : 0,
          mtime: indexStat ? new Date(indexStat.mtimeMs).toISOString() : null,
        },
        write: {
          enabled: config.writeEnabled !== false,
          target: 'WB daily log only (<dailyRoot>/<YYYY-MM-DD>.md); append-only',
          dailyRoot: (live.daily || [])[0] || null,
          backup: '`<file>.bak-dshsync` before every modification',
          secretPolicy: 'reject (fail closed)',
          maxWriteBytes: config.maxWriteBytes,
          ledger: (() => {
            const log = readWriteLedger(config, 1);
            return { path: config.writeLogPath, exists: Boolean(log.exists), total: log.total || 0 };
          })(),
        },
        sync: (() => {
          const state = loadState(config);
          const dsh = listDshAssets(config);
          const wb = listWbItems(config, live);
          return {
            statePath: config.syncStatePath,
            planPath: config.syncPlanPath,
            lastRun: state.runs.length > 0 ? state.runs[state.runs.length - 1] : null,
            runs: state.runs.length,
            pushedKeys: Object.keys(state.pushed).length,
            stagedKeys: Object.keys(state.staged).length,
            dshMemory: { source: dsh.source, items: dsh.itemCount, identityItems: dsh.identityClassCount, documents: dsh.documents.length },
            wbMemory: { files: Object.keys(wb.files).length, items: wb.items.length, identityItems: wb.identityClassCount },
            inboxDir: config.inboxDir,
            discipline: 'dsh side is read-only here; identity-class items are never auto-applied',
          };
        })(),
        mirror: (() => {
          let stat = null;
          try {
            stat = fs.statSync(config.skillsMirrorPath);
          } catch {
            stat = null;
          }
          return {
            path: config.skillsMirrorPath,
            markdownPath: config.skillsMirrorMarkdownPath,
            exists: Boolean(stat),
            bytes: stat ? stat.size : 0,
            mtime: stat ? new Date(stat.mtimeMs).toISOString() : null,
          };
        })(),
        autoTrigger: {
          enabled: config.autoTrigger ? config.autoTrigger.enabled !== false : false,
          hook: 'agent/turn-stopping',
          refreshSkillsMirror: config.autoTrigger ? config.autoTrigger.refreshSkillsMirror !== false : false,
          minIntervalMs: config.autoTrigger ? config.autoTrigger.minIntervalMs : null,
          writesMemory: false,
        },
      };
    },
  });

  register({
    name: 'wb_build_index',
    description:
      'Generate a human-readable Markdown index of every WorkBuddy asset dsh can see, written to the plugin out/ directory by default. This is the M1 deliverable index.',
    parameters: {
      type: 'object',
      properties: {
        outPath: { type: 'string', description: 'Optional absolute output path.' },
      },
      additionalProperties: false,
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => text(value) },
    execute: async (args) => {
      const live = currentRoots();
      const target = (args && args.outPath) || config.indexOutputPath;
      const built = buildIndexMarkdown(config, live);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, built.markdown, 'utf8');
      return {
        outPath: target,
        bytes: Buffer.byteLength(built.markdown, 'utf8'),
        total: built.total,
        generatedAt: new Date().toISOString(),
      };
    },
  });

  register({
    name: 'wb_append_memory',
    description:
      "Write back a dsh conclusion into the WorkBuddy daily log (<dailyRoot>/<YYYY-MM-DD>.md). Append-only: existing content is never rewritten. A '.bak-dshsync' copy is made before every modification, the write is refused if the content looks like it contains secrets, and repeating the same entry is skipped as a duplicate. Pass dryRun to preview.",
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short heading for the entry (max 200 chars).' },
        body: { type: 'string', description: 'Markdown body of the note.' },
        date: { type: 'string', description: 'Target daily log date as YYYY-MM-DD; defaults to today (local).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional labels shown in the entry header.' },
        dedupeKey: { type: 'string', description: 'Optional identity for idempotency; defaults to title + body.' },
        dryRun: { type: 'boolean', description: 'Preview the exact block and paths without touching the file.' },
      },
      required: ['title', 'body'],
      additionalProperties: false,
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => text(value) },
    execute: async (args) => appendDailyMemory(config, currentRoots(), args),
    presentCall: (args) => ({
      card: 'generic',
      title: `Write back to WB daily log: ${(args && args.title) || ''}`.slice(0, 120),
      kind: 'edit',
      rawInput: { date: (args && args.date) || 'today', dryRun: Boolean(args && args.dryRun) },
    }),
  });

  register({
    name: 'wb_write_log',
    description:
      'Read the local append-only ledger of everything dsh-wb-sync has written into WorkBuddy memory (timestamp, target file, marker, backup path, and the exact appended text). Use it to audit or hand-roll a rollback.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'How many recent entries to return (default 20, max 200).' } },
      additionalProperties: false,
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => text(value) },
    execute: async (args) => readWriteLedger(config, args && args.limit),
  });

  register({
    name: 'wb_sync_plan',
    description:
      'M3 two-way diff between WorkBuddy user-level memory/identity and dsh hot memory (Mnemon runtime projection). Item-level matching after normalization; reports what is new on each side, what is already in sync, what needs a human (identity-class is never auto-applied), and any file-level window conflict with its resolution rule. Writes nothing but the plan file.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => text(value) },
    execute: async () => {
      const plan = buildPlan(config, currentRoots());
      return {
        planId: plan.planId,
        at: plan.at,
        wb: plan.wb,
        dsh: plan.dsh,
        matched: plan.matched,
        onlyInDsh: plan.onlyInDsh,
        onlyInWb: plan.onlyInWb,
        pushPending: plan.pushPending,
        stagePending: plan.stagePending,
        needsHuman: plan.needsHuman.length,
        needsHumanDetail: plan.needsHuman.slice(0, 10),
        conflicts: plan.conflicts,
        pushPreview: plan.push.slice(0, 8),
        stagePreview: plan.stage.slice(0, 8),
        planPath: config.syncPlanPath,
        notes: plan.notes,
      };
    },
  });

  register({
    name: 'wb_sync_apply',
    description:
      'M3 apply: push dsh-only memory items into the WorkBuddy daily log (via the M2 append path, idempotent) and stage WB-only items into a dsh inbox file for the agent to feed into Mnemon. Identity-class items are never applied. It never writes dsh memory itself. Pass dryRun to preview.',
    parameters: {
      type: 'object',
      properties: {
        includePush: { type: 'boolean', description: 'Push dsh-only items into the WB daily log (default true).' },
        includeStage: { type: 'boolean', description: 'Write the WB->dsh inbox file (default true).' },
        dryRun: { type: 'boolean', description: 'Compute and report without writing anything.' },
      },
      additionalProperties: false,
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => text(value) },
    execute: async (args) =>
      applyPlan(config, currentRoots(), {
        includePush: !(args && args.includePush === false),
        includeStage: !(args && args.includeStage === false),
        dryRun: Boolean(args && args.dryRun),
        appendDailyMemory,
      }),
    presentCall: (args) => ({
      card: 'generic',
      title: args && args.dryRun ? 'Preview WB <-> dsh sync' : 'Apply WB <-> dsh sync',
      kind: 'other',
      rawInput: args || {},
    }),
  });

  register({
    name: 'wb_mirror_skills',
    description:
      'M4 read-only skill mirror: collect name, description, size, mtime, and hash for every WorkBuddy SKILL.md and write the mirror to the plugin out/ directory. Metadata only: skill bodies are not copied and WB skills are never executed by dsh.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => text(value) },
    execute: async () => {
      const mirror = buildSkillsMirror(config, currentRoots());
      return {
        count: mirror.count,
        generatedAt: mirror.generatedAt,
        mirrorPath: config.skillsMirrorPath,
        markdownPath: config.skillsMirrorMarkdownPath,
        sample: mirror.skills.slice(0, 10).map((s) => ({ id: s.id, name: s.name, hash: s.hash })),
        note: mirror.note,
      };
    },
  });

  /* ------------------- M4：自动化触发（turn 即将关闭时刷新镜像） -------------------
   * `agent/turn-stopping` 是 serial 模式、调用方会 await，所以这里只做「到点才动手」的
   * 判断，真正的刷新走 setImmediate 异步跑，绝不阻塞收尾。
   * 只刷新技能镜像（只读派生物），**不**推进同步状态 —— 否则会把「还没同步的变更」
   * 误记成已看过，下一次 plan 就报告不出差异了。
   */
  let lastMirrorAt = 0;
  ctx.effect(() =>
    ctx.on('agent/turn-stopping', () => {
      const auto = config.autoTrigger;
      if (!auto || auto.enabled === false || auto.refreshSkillsMirror === false) return;
      const now = Date.now();
      if (now - lastMirrorAt < (Number(auto.minIntervalMs) || 300000)) return;
      lastMirrorAt = now;
      setImmediate(() => {
        try {
          const mirror = buildSkillsMirror(config, currentRoots());
          const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-wb-sync') : null;
          if (logger && typeof logger.info === 'function') logger.info(`skills mirror refreshed (${mirror.count})`);
        } catch {
          /* 自动化路径绝不能影响会话收尾 */
        }
      });
    }),
  );
}
