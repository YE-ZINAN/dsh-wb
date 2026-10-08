/**
 * wb-assets.js —— WorkBuddy 资产适配层（M1 只读 View + M2 写回）
 *
 * 职责：把 WB 在磁盘上的记忆/身份/技能/plan 资产，按**白名单根目录**暴露成
 * 可枚举、可读、可检索的结构；M2 增加"只追加、可回滚、可审计"的写回原语。
 * 所有路径都必须先通过 `assertAllowed()`。
 *
 * 安全边界（对应开发计划 §8）：
 *   1. 只允许 WB 资产根之下的路径；越界一律拒绝。
 *   2. 目录名/文件名黑名单：会话库、缓存、凭证、应用配置、二进制、uuid 目录。
 *   3. 只读文本类扩展名。
 *   4. 读取时对疑似密钥行做脱敏，并在结果里回报脱敏条数。
 *   5. 密钥/凭证**永不进索引**，也永不被枚举。
 *   6. 写入（M2）只允许追加到 WB 每日日志；写前落 `.bak-dshsync`；命中密钥**拒绝写入**（fail closed）；每次写入进本地台账。
 *
 * 分级纪律（开发计划 §5，用户硬规矩）：身份/画像类资产一律 normal，禁标 critical。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 资产类别。 */
export const CATEGORIES = ['memory', 'identity', 'skills', 'plans', 'daily'];

/** 只读文本类扩展名。 */
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml']);

/**
 * 每个类别的"什么算资产"过滤器。
 * skills 只收 `SKILL.md` —— 那是技能本体与触发词所在，附属脚本/素材不是"技能清单"。
 */
const ACCEPT_BY_CATEGORY = {
  skills: (name) => /^SKILL\.md$/i.test(name),
};

/** 检索时的类别优先级：先读体量小、信息密度高的，别让 skills 把配额吃光。 */
const SEARCH_ORDER = ['memory', 'identity', 'daily', 'plans', 'skills'];

/** 路径段黑名单：命中即整支子树不可见。 */
const DENY_SEGMENTS = new Set([
  'node_modules',
  '.git',
  'sessions',              // 会话原始转录 / vscdb
  'logs',
  'tmp',
  'cache',
  'blobs',
  'local_storage',
  'clipboard-images',
  'media-index',
  'artifact-index',
  'changes-index',
  'changes-detail',
  'file-history',
  'file-tree-manifests',
  'shell-snapshots',
  'traces',
  'binaries',
  'vendor',
  'extensions',
  'plugin-marketplace-state',
  'plugin-marketplace-state-new',
  'skills-marketplace',
  'security',
  'keyblob',
  'pending-telemetry',
  '_skilltmp',
  'mcp-servers',           // 第三方 server 源码，不是"记忆资产"
]);

/** 文件名黑名单：应用配置与凭证载体。 */
const DENY_FILES = new Set([
  'mcp.json',
  'mcp-approvals.json',
  'mcp-tool-list.json',
  'settings.json',
  'argv.json',
  'user-state.json',
  'keyblob',
  'device-id',
  'workbuddy.db',
  'workbuddy.db-shm',
  'workbuddy.db-wal',
  'system-ca-bundle.pem',
  'failover.json',
  'models.json',
  'usage-log.json',
  'last-launch.json',
  'session_fragment_repair_done520',
  '_wb_test.tmp',
]);

/** 文件名关键词黑名单（凭证/密钥类）。 */
const DENY_NAME_RE = /(secret|credential|token|api[_-]?key|apikey|password|passwd)/i;

/** uuid 目录（WB 内部数据目录，非资产）。 */
const UUID_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 读取时脱敏的行内密钥。 */
const SECRET_INLINE_RES = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /((?:api[_-]?key|apikey|token|password|passwd|secret)\s*[:=]\s*)["']?[^\s"',}]{6,}/gi,
  /((?:DEEPSEEK|OPENAI|ANTHROPIC|TUSHARE)[A-Z_]*\s*[:=]\s*)["']?[^\s"',}]{6,}/gi,
];

/** 分级：身份/画像类一律 normal，禁止 critical（用户硬规矩，无例外）。 */
export function classify(category) {
  // 这里刻意不做"更高分级"的可能：任何类别都返回 normal。
  // 若将来要引入 important，也必须先排除 identity / memory。
  if (category === 'identity' || category === 'memory') return 'normal';
  return 'normal';
}

function isDeniedSegment(name) {
  if (DENY_SEGMENTS.has(name)) return true;
  if (UUID_DIR_RE.test(name)) return true;
  return false;
}

function isDeniedFile(name) {
  const lower = name.toLowerCase();
  if (DENY_FILES.has(lower)) return true;
  // 备份文件（MEMORY.md.bak_xxx）属于历史痕迹，允许读，但不当成主资产。
  if (DENY_NAME_RE.test(name) && !/\.bak/i.test(name)) return true;
  return false;
}

function isTextFile(name) {
  return TEXT_EXT.has(path.extname(name).toLowerCase());
}

/** 解析配置里的各类资产根。 */
export function resolveRoots(config) {
  const wbHome = config.wbHome;
  const personal = config.personalDir || discoverPersonalDir(wbHome);
  const roots = {
    memory: [
      path.join(wbHome, 'MEMORY.md'),
      path.join(wbHome, 'USER.md'),
      path.join(wbHome, 'SOUL.md'),
      path.join(wbHome, 'IDENTITY.md'),
    ].filter((p) => existsFile(p)),
    identity: personal ? [personal] : [],
    skills: [path.join(wbHome, 'skills')].filter((p) => existsDir(p)),
    plans: [path.join(wbHome, 'plans')].filter((p) => existsDir(p)),
    daily: (config.projectMemoryDirs || []).filter((p) => existsDir(p)),
  };
  return roots;
}

/** WB 的个人目录形如 `~/.workbuddy/user-<uuid>-personal`。 */
function discoverPersonalDir(wbHome) {
  let entries;
  try {
    entries = fs.readdirSync(wbHome, { withFileTypes: true });
  } catch {
    return '';
  }
  const hit = entries.find((e) => e.isDirectory() && /^user-.*-personal$/i.test(e.name));
  return hit ? path.join(wbHome, hit.name) : '';
}

function existsFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function existsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 归一化并做包含性检查。 */
export function isWithin(root, target) {
  const r = path.resolve(root).toLowerCase();
  const t = path.resolve(target).toLowerCase();
  if (t === r) return true;
  return t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/**
 * 判定一个绝对路径是否可暴露。返回 { ok: true, category } 或 { ok: false, reason }。
 * 相对路径按「某类别根之下」的语义由调用方先行拼接。
 */
export function assertAllowed(absPath, roots) {
  const resolved = path.resolve(absPath);

  // 1) 必须落在某个允许根之下
  let category = null;
  for (const [cat, list] of Object.entries(roots)) {
    for (const root of list) {
      if (isWithin(root, resolved)) {
        category = cat;
        break;
      }
    }
    if (category) break;
  }
  if (!category) return { ok: false, reason: 'path is outside every allowed WorkBuddy asset root' };

  // 2) 路径段与文件名黑名单（跳过盘符/根）
  const parts = resolved.split(/[\\/]+/).filter(Boolean);
  for (const part of parts.slice(1)) {
    if (isDeniedSegment(part)) return { ok: false, reason: `denied path segment: ${part}` };
  }
  const base = path.basename(resolved);
  if (isDeniedFile(base)) return { ok: false, reason: `denied file name: ${base}` };
  if (!isTextFile(base)) return { ok: false, reason: `not a readable text asset: ${base}` };

  return { ok: true, category };
}

/** 目标是否落在任一允许边界（用来判断 junction 能不能跟）。 */
function isWithinAny(target, boundaries) {
  for (const boundary of boundaries || []) {
    if (boundary && isWithin(boundary, target)) return true;
  }
  return false;
}

/**
 * 递归枚举一个根（文件或目录），受深度/数量上限约束。
 *
 * 注意 junction/symlink：WB 的 `~/.workbuddy/skills/` 里有 8 个 junction 指向
 * `~/.workbuddy/vendor/ASu-skills/skills/*`，而 Node 的 `Dirent.isDirectory()`
 * 对链接返回 **false** —— 不显式跟进就会整支漏掉（2026-10-08 实测：60 个技能只枚举到 52 个）。
 * 跟进的前提是链接的 realpath 仍在允许边界内，避免链接逃逸。
 */
function walkRoot(root, category, opts, out) {
  if (out.length >= opts.maxFiles) return;
  const accept = ACCEPT_BY_CATEGORY[category];
  const stat = safeStat(root);
  if (!stat) return;

  if (stat.isFile()) {
    const base = path.basename(root);
    if (!isDeniedFile(base) && isTextFile(base) && (!accept || accept(base))) {
      out.push(describe(root, category, stat));
    }
    return;
  }

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (out.length >= opts.maxFiles) return;
    const full = path.join(root, entry.name);
    const hidden = entry.name.startsWith('.');

    if (entry.isDirectory()) {
      if (hidden || isDeniedSegment(entry.name)) continue;
      walkRoot(full, category, opts, out);
      continue;
    }

    if (entry.isSymbolicLink()) {
      if (hidden || isDeniedSegment(entry.name)) continue;
      let real;
      try {
        real = fs.realpathSync(full);
      } catch {
        continue;
      }
      if (!isWithinAny(real, opts.boundaries)) continue;
      const linkStat = safeStat(full);
      if (!linkStat) continue;
      if (linkStat.isDirectory()) {
        walkRoot(full, category, opts, out);
      } else if (linkStat.isFile() && !isDeniedFile(entry.name) && isTextFile(entry.name) && (!accept || accept(entry.name))) {
        out.push(describe(full, category, linkStat));
      }
      continue;
    }

    if (!entry.isFile()) continue;
    if (hidden) continue;
    if (isDeniedFile(entry.name) || !isTextFile(entry.name)) continue;
    if (accept && !accept(entry.name)) continue;
    const s = safeStat(full);
    if (s) out.push(describe(full, category, s));
  }
}

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function describe(fullPath, category, stat) {
  return {
    category,
    path: fullPath,
    name: path.basename(fullPath),
    dir: path.dirname(fullPath),
    bytes: stat.size,
    mtime: new Date(stat.mtimeMs).toISOString(),
    tier: classify(category),
  };
}

/** 枚举资产。category 省略或 'all' 时返回全部类别。 */
export function listAssets(config, roots, category) {
  const wanted = !category || category === 'all' ? CATEGORIES : [category];
  const opts = {
    maxFiles: config.maxIndexFiles,
    // junction 只有指回这些边界之内才允许跟进
    boundaries: [config.wbHome, ...(config.projectMemoryDirs || [])],
  };
  const groups = [];

  for (const cat of wanted) {
    const list = roots[cat] || [];
    const files = [];
    for (const root of list) walkRoot(root, cat, opts, files);
    // 同一文件可能因多个根被重复计入，去重
    const seen = new Set();
    const unique = files.filter((f) => (seen.has(f.path) ? false : (seen.add(f.path), true)));
    groups.push({
      category: cat,
      roots: list,
      count: unique.length,
      files: unique.sort((a, b) => b.mtime.localeCompare(a.mtime)),
    });
  }

  return {
    wbHome: config.wbHome,
    tierRule: 'identity/memory are always normal; critical is never assigned',
    total: groups.reduce((sum, g) => sum + g.count, 0),
    groups,
  };
}

/** 按绝对路径或「某类别根之下的相对路径」解析。 */
export function resolveAssetPath(config, roots, input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, reason: 'path is required' };

  const candidates = [];
  if (path.isAbsolute(raw)) {
    candidates.push(raw);
  } else {
    const [head, ...rest] = raw.split(/[\\/]+/);
    const cat = CATEGORIES.includes(head) ? head : null;
    const tail = cat ? rest.join(path.sep) : null;
    if (cat && tail !== null) {
      for (const root of roots[cat] || []) {
        // 根的父目录 + 相对路径（根的 basename 一般不重复出现在相对路径里）
        candidates.push(path.join(path.dirname(root), tail));
        candidates.push(path.join(root, tail));
      }
    }
    // 兜底：相对 wbHome
    candidates.push(path.join(config.wbHome, raw));
  }

  for (const candidate of candidates) {
    const verdict = assertAllowed(candidate, roots);
    if (verdict.ok && safeStat(candidate)?.isFile()) {
      return { ok: true, category: verdict.category, path: path.resolve(candidate) };
    }
  }
  return {
    ok: false,
    reason: `cannot resolve a readable WorkBuddy asset for "${raw}"`,
    tried: candidates.slice(0, 6),
  };
}

/** 读取资产内容，带体积上限与密钥脱敏。 */
export function readAsset(config, roots, input, maxBytes) {
  const found = resolveAssetPath(config, roots, input);
  if (!found.ok) return found;

  const limit = Math.max(1024, Math.min(Number(maxBytes) || config.maxReadBytes, config.maxReadBytesHard));
  const buf = fs.readFileSync(found.path);
  const truncated = buf.length > limit;
  let text = buf.subarray(0, limit).toString('utf8');

  let redactions = 0;
  for (const re of SECRET_INLINE_RES) {
    text = text.replace(re, (match, prefix) => {
      redactions += 1;
      return prefix ? `${prefix}[REDACTED]` : '[REDACTED]';
    });
  }

  const stat = safeStat(found.path);
  return {
    ok: true,
    category: found.category,
    path: found.path,
    name: path.basename(found.path),
    tier: classify(found.category),
    bytes: stat ? stat.size : buf.length,
    mtime: stat ? new Date(stat.mtimeMs).toISOString() : null,
    truncated,
    redactions,
    text,
  };
}

/** 跨资产关键词检索。多关键词按「全部命中」处理，大小写不敏感。 */
export function searchAssets(config, roots, query, scope, limit) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (terms.length === 0) return { ok: false, reason: 'query is required' };

  const maxHits = Math.max(1, Math.min(Number(limit) || config.maxSearchHits, 200));
  const listing = listAssets(config, roots, scope);
  // 按信息密度排序：memory/identity/daily 先于 skills，避免大目录吃掉扫描配额。
  const groups = [...listing.groups].sort(
    (a, b) => SEARCH_ORDER.indexOf(a.category) - SEARCH_ORDER.indexOf(b.category),
  );
  const matches = [];
  let scanned = 0;
  let stopped = false;

  for (const group of groups) {
    if (stopped) break;
    for (const file of group.files) {
      if (scanned >= config.maxSearchFiles) {
        stopped = true;
        break;
      }
      scanned += 1;
      let text;
      try {
        const buf = fs.readFileSync(file.path);
        if (buf.length > config.maxReadBytesHard) continue;
        text = buf.toString('utf8');
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const lower = lines[i].toLowerCase();
        if (!terms.every((t) => lower.includes(t))) continue;
        matches.push({
          category: file.category,
          path: file.path,
          line: i + 1,
          text: sanitizeLine(lines[i]),
        });
        if (matches.length >= maxHits) {
          stopped = true;
          break;
        }
      }
      if (stopped) break;
    }
  }

  return {
    ok: true,
    query,
    scope: scope || 'all',
    terms,
    scannedFiles: scanned,
    truncated: stopped,
    total: matches.length,
    matches,
  };
}

function sanitizeLine(line) {
  let out = line;
  for (const re of SECRET_INLINE_RES) {
    out = out.replace(re, (m, prefix) => (prefix ? `${prefix}[REDACTED]` : '[REDACTED]'));
  }
  return out.length > 400 ? `${out.slice(0, 400)}…` : out;
}

/** 生成人读索引（M1 交付物：dsh 侧的 CONTEXT 索引）。 */
export function buildIndexMarkdown(config, roots) {
  const listing = listAssets(config, roots, 'all');
  const lines = [];
  lines.push('# WorkBuddy 资产索引（由 dsh-wb-sync 生成，只读镜像）');
  lines.push('');
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push(`- WB 主目录：\`${config.wbHome}\``);
  lines.push(`- 资产总数：${listing.total}`);
  lines.push('- 分级纪律：身份/画像类一律 `normal`，**永不 `critical`**');
  lines.push('- 密钥/凭证/会话转录/二进制按黑名单排除，内容永不进索引');
  lines.push('');

  for (const group of listing.groups) {
    lines.push(`## ${group.category}（${group.count}）`);
    if (group.count === 0) {
      lines.push('');
      lines.push('_（无资产或根目录不存在）_');
      lines.push('');
      continue;
    }
    lines.push('');
    lines.push('| 文件 | 大小 | 修改时间 | 分级 |');
    lines.push('|---|---:|---|---|');
    for (const file of group.files) {
      lines.push(`| \`${file.name}\` | ${file.bytes} | ${file.mtime.slice(0, 19).replace('T', ' ')} | ${file.tier} |`);
    }
    lines.push('');
    lines.push('<details><summary>完整路径</summary>');
    lines.push('');
    for (const file of group.files) lines.push(`- \`${file.path}\``);
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  return { markdown: lines.join('\n'), total: listing.total };
}

/* ------------------------------------------------------------------ *
 * M2：写回（dsh → WB 每日日志）
 * ------------------------------------------------------------------ */

const MARKER_PREFIX = 'dsh-wb-sync';
const BACKUP_SUFFIX = '.bak-dshsync';

/** 日期归一化：只接受 `YYYY-MM-DD`，缺省取本地今天。 */
export function normalizeDate(input) {
  if (input === undefined || input === null || input === '') {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }
  const raw = String(input).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '';
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return '';
  return raw;
}

/**
 * 扫描待写入文本里的密钥。**返回条数与行号，不回显密钥本身**
 * —— 密钥不能因为"报错信息"而再次落到会话记录里。
 */
export function findSecrets(text) {
  const hits = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    for (const re of SECRET_INLINE_RES) {
      re.lastIndex = 0;
      if (re.test(lines[i])) {
        hits.push({ line: i + 1, kind: re.source.slice(0, 24) });
        break;
      }
    }
  }
  return hits;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 台账：追加一行 JSONL。写不进去不阻断主流程，但要如实回报。 */
function appendLedger(config, entry) {
  const target = config.writeLogPath;
  if (!target) return { written: false, reason: 'writeLogPath not configured' };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${JSON.stringify(entry)}\n`, 'utf8');
    return { written: true, path: target };
  } catch (error) {
    return { written: false, reason: String((error && error.message) || error) };
  }
}

/** 读台账（最近 limit 条）。 */
export function readWriteLedger(config, limit) {
  const target = config.writeLogPath;
  const max = Math.max(1, Math.min(Number(limit) || 20, 200));
  if (!target) return { ok: false, reason: 'writeLogPath not configured' };
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch {
    return { ok: true, path: target, exists: false, total: 0, entries: [] };
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const entries = [];
  for (const line of lines.slice(-max)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* 坏行跳过，不让台账阻断审计 */
    }
  }
  return { ok: true, path: target, exists: true, total: lines.length, entries };
}

/**
 * 把一条 dsh 结论追加进 WB 每日日志（`<dailyRoot>/<YYYY-MM-DD>.md`）。
 *
 * 写回纪律：
 *   - **只会追加**，永不改写/删除目标文件既有内容。
 *   - 修改前先把原文件复制成 `<file>.bak-dshsync`（单槽、覆盖式，可回滚）。
 *   - 内容命中密钥一律**拒绝**（fail closed），不静默脱敏（会篡改原意）。
 *   - 幂等：同 `dedupeKey`（缺省 = title + body）重复写入直接跳过。
 *   - 每次成功写入进本地台账 `out/wb-write-log.jsonl`，含完整追加文本，可人工回滚。
 */
export function appendDailyMemory(config, roots, input) {
  const args = input && typeof input === 'object' ? input : {};
  if (config.writeEnabled === false) return { ok: false, reason: 'dsh-wb-sync writes are disabled by config' };

  const date = normalizeDate(args.date);
  if (!date) return { ok: false, reason: 'date must be YYYY-MM-DD' };

  const title = String(args.title || '').trim();
  if (!title) return { ok: false, reason: 'title is required' };
  if (title.length > 200) return { ok: false, reason: 'title too long (max 200 chars)' };

  const body = String(args.body || '').trim();
  if (!body) return { ok: false, reason: 'body is required' };
  const maxWrite = Math.max(256, Number(config.maxWriteBytes) || 20000);
  if (Buffer.byteLength(body, 'utf8') > maxWrite) {
    return { ok: false, reason: `body too large (limit ${maxWrite} bytes)` };
  }

  const combined = `${title}\n\n${body}`;
  const secrets = findSecrets(combined);
  if (secrets.length > 0) {
    return {
      ok: false,
      reason: `refused: content looks like it contains secrets in ${secrets.length} line(s); remove them and retry`,
      secretLines: secrets.map((s) => s.line),
    };
  }

  const dailyRoot = (roots.daily || [])[0];
  if (!dailyRoot) return { ok: false, reason: 'no daily memory root resolved' };

  const target = path.join(dailyRoot, `${date}.md`);
  const verdict = assertAllowed(target, roots);
  if (!verdict.ok) return verdict;

  const dedupeSource = args.dedupeKey ? String(args.dedupeKey) : combined;
  const digest = sha256(dedupeSource).slice(0, 8);
  const begin = `<!-- ${MARKER_PREFIX}:begin ${digest} -->`;
  const end = `<!-- ${MARKER_PREFIX}:end ${digest} -->`;

  let existing = '';
  let existed = false;
  try {
    existing = fs.readFileSync(target, 'utf8');
    existed = true;
  } catch {
    existing = '';
  }

  if (existing.includes(begin)) {
    return { ok: true, skipped: 'duplicate', marker: digest, path: target, date, reason: 'an identical entry is already present' };
  }

  const tags = Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === 'string' && t.trim()).slice(0, 20) : [];
  const block = [
    '',
    begin,
    `## DSH 回写 · ${title}`,
    '',
    `- 时间：${new Date().toISOString()}`,
    `- 来源：dsh（dsh-wb-sync / ${args.stage || 'M2'}）`,
    tags.length ? `- 标签：${tags.join(' / ')}` : null,
    `- 标记：\`${digest}\``,
    '',
    ...body.split(/\r?\n/),
    '',
    end,
    '',
  ].filter((line) => line !== null).join('\n');

  const next = `${existing}${existing.endsWith('\n') || existing === '' ? '' : '\n'}${block}`;

  if (args.dryRun) {
    return {
      ok: true,
      dryRun: true,
      path: target,
      date,
      marker: digest,
      existed,
      backupWouldBe: existed ? `${target}${BACKUP_SUFFIX}` : null,
      bytesToAdd: Buffer.byteLength(block, 'utf8'),
      preview: block,
    };
  }

  let backupPath = null;
  if (existed) {
    backupPath = `${target}${BACKUP_SUFFIX}`;
    try {
      fs.copyFileSync(target, backupPath);
    } catch (error) {
      return { ok: false, reason: `backup failed, refusing to write: ${String((error && error.message) || error)}` };
    }
  }

  const tmp = `${target}.tmp-dshsync`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, next, 'utf8');
    try {
      fs.renameSync(tmp, target);
    } catch {
      // 某些文件系统/占用状态下 rename 会失败，退化为直接写
      fs.writeFileSync(target, next, 'utf8');
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 残留 tmp 不影响正确性 */
      }
    }
  } catch (error) {
    return { ok: false, reason: `write failed: ${String((error && error.message) || error)}` };
  }

  const receipt = {
    ok: true,
    dryRun: false,
    path: target,
    date,
    marker: digest,
    existed,
    backupPath,
    bytesAdded: Buffer.byteLength(block, 'utf8'),
    bytesTotal: Buffer.byteLength(next, 'utf8'),
    appended: block,
    at: new Date().toISOString(),
    tier: classify('daily'),
  };

  receipt.ledger = appendLedger(config, {
    at: receipt.at,
    path: target,
    date,
    marker: digest,
    title,
    tags,
    backupPath,
    bytesAdded: receipt.bytesAdded,
    appended: block,
  });

  return receipt;
}

export { os };
