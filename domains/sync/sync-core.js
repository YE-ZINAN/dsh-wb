/**
 * sync-core.js —— M3 双向 merge 与 M4 技能镜像
 *
 * 两侧事实源：
 *   - WB 侧：`~/.workbuddy/{MEMORY,USER,SOUL,IDENTITY}.md` + `user-*-personal/`
 *     （即 wb-assets.js 的 memory / identity 两类；daily 是写回目标，不参与 merge）
 *   - dsh 侧：`~/.mnemon/runtime/memories.json`（**结构化热记忆投影**，每条含
 *     content / created_at / updated_at / target / importance）+ `documents/active/*.md`
 *
 * ⚠️ dsh 侧只读。Mnemon 的真源是 `~/.mnemon/data/<body>/mnemon.db`，`runtime/…` 是投影；
 *    本模块**绝不写 dsh 侧任何文件** —— 需要写 dsh 记忆时只能由 agent 走 mnemon 工具，
 *    所以 WB→dsh 一律落到「inbox 暂存文件」交给 agent，不自动执行。
 *
 * 合并判据（对应开发计划 §6）：
 *   1. 行/条目级内容匹配（归一化后比对），命中即视为已同步。
 *   2. 同一条目两侧都在同一窗口内变化 → 按 updatedAt 新者胜；同秒 WB 优先。
 *   3. **身份类（identity / target=user）任何新增或改动一律 needs-human，永不自动应用。**
 *   4. 每次写 WB 前由 wb-assets.js 落 `.bak-dshsync`；dsh 侧不写。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { listAssets } from './wb-assets.js';

const STATE_VERSION = 1;

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const short = (value) => sha256(value).slice(0, 8);

/**
 * 归一化一行/一条，用来跨侧比对内容是否"同一件事"。
 * 抹平大小写、markdown 装饰、中英文标点与空白差异。
 * 过短的（<8 字符）视为噪声不参与匹配 —— 阈值不能定太高：中文条目信息密度大，
 * 像「用户身份：称呼 D老师」归一化后只有 11 字，定 12 会把它静默丢掉、永远同步不到。
 */
export function normalizeItem(text) {
  const normalized = String(text)
    .toLowerCase()
    .replace(/[*_`>#[\]]/g, ' ')
    // 中英文标点一律抹平：全角冒号与半角冒号必须等价，否则"同一句话"会被判成两条
    .replace(/[：:，,。.、；;！!？?（）()【】[\]{}「」“”"']/g, ' ')
    .replace(/[（(][^）)]{0,20}[）)]/g, ' ') // 去掉短括号补充说明，减少同义文本的分歧
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/^[\s\-–—·•\d.、]+/, '')
    .trim();
  return normalized.length >= 8 ? normalized : '';
}

/* ------------------------------ 状态 ------------------------------ */

export function loadState(config) {
  const empty = { version: STATE_VERSION, updatedAt: null, wb: {}, dsh: {}, pushed: {}, staged: {}, runs: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(config.syncStatePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return empty;
    return {
      version: STATE_VERSION,
      updatedAt: parsed.updatedAt || null,
      wb: parsed.wb || {},
      dsh: parsed.dsh || {},
      pushed: parsed.pushed || {},
      staged: parsed.staged || {},
      runs: Array.isArray(parsed.runs) ? parsed.runs.slice(-20) : [],
    };
  } catch {
    return empty;
  }
}

export function saveState(config, state) {
  const next = { ...state, version: STATE_VERSION, updatedAt: new Date().toISOString() };
  next.runs = (next.runs || []).slice(-20);
  fs.mkdirSync(path.dirname(config.syncStatePath), { recursive: true });
  fs.writeFileSync(config.syncStatePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/* --------------------------- dsh 侧（只读） --------------------------- */

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * dsh 侧资产（只读）。
 * 主源 `memories.json`；缺失时退化为解析 `MEMORY.md` / `USER.md` 的 `§` 分隔条目。
 */
export function listDshAssets(config) {
  const runtimeDir = config.mnemonRuntimeDir;
  const memoriesPath = path.join(runtimeDir, 'memories.json');
  const items = [];
  let source = null;
  let sourceMtime = null;

  const parsed = readJsonSafe(memoriesPath);
  if (parsed && Array.isArray(parsed.entries)) {
    source = memoriesPath;
    try {
      sourceMtime = fs.statSync(memoriesPath).mtime.toISOString();
    } catch {
      sourceMtime = null;
    }
    parsed.entries.forEach((entry, index) => {
      const content = String(entry && entry.content ? entry.content : '').trim();
      if (!content) return;
      // key 必须与 WB 侧同源：都用**归一化后**的文本取哈希。
      // （曾因 WB 侧哈希归一化文本、dsh 侧哈希原文而全部匹配失败，2026-10-08 修。）
      const normalized = normalizeItem(content);
      if (!normalized) return;
      items.push({
        key: short(normalized),
        origin: 'hot',
        index,
        text: content,
        target: entry.target === 'user' ? 'user' : 'memory',
        importance: entry.importance || 'normal',
        updatedAt: entry.updated_at || entry.updatedAt || null,
        createdAt: entry.created_at || entry.createdAt || null,
        // 身份类判据：target=user 的记忆就是画像/偏好/身份，一律禁自动覆盖
        identityClass: entry.target === 'user',
      });
    });
  } else {
    for (const file of ['MEMORY.md', 'USER.md']) {
      const full = path.join(runtimeDir, file);
      let raw;
      try {
        raw = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      source = source || full;
      const parts = raw.split(/^\s*§\s*$/m);
      parts.forEach((part, index) => {
        const text = part.trim();
        const normalized = normalizeItem(text);
        if (!normalized) return;
        items.push({
          key: short(normalized),
          origin: 'hot-md',
          index,
          text,
          target: file === 'USER.md' ? 'user' : 'memory',
          importance: 'normal',
          updatedAt: null,
          createdAt: null,
          identityClass: file === 'USER.md',
        });
      });
    }
  }

  const documents = [];
  const docDir = path.join(config.mnemonHome, 'documents', 'active');
  let entries = [];
  try {
    entries = fs.readdirSync(docDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const full = path.join(docDir, entry.name);
    try {
      const stat = fs.statSync(full);
      const head = fs.readFileSync(full, 'utf8').slice(0, 4000);
      documents.push({
        key: short(entry.name),
        name: entry.name,
        path: full,
        bytes: stat.size,
        mtime: new Date(stat.mtimeMs).toISOString(),
        title: (head.match(/^#\s+(.+)$/m) || [])[1] || entry.name,
      });
    } catch {
      /* 单篇读不到就跳过，不影响整体 */
    }
  }

  const hotHash = source && fs.existsSync(source) ? sha256(fs.readFileSync(source)) : null;
  return {
    source,
    sourceMtime,
    hotHash,
    itemCount: items.length,
    items,
    identityClassCount: items.filter((i) => i.identityClass).length,
    documents: documents.sort((a, b) => b.mtime.localeCompare(a.mtime)),
  };
}

/* --------------------------- WB 侧 --------------------------- */

function extractItems(text, source, category) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  // 开头的 YAML frontmatter 是文件元数据（summary / read_when 之类），不是记忆条目。
  let inFrontmatter = false;
  let sawContent = false;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!sawContent && /^---\s*$/.test(trimmed)) {
      inFrontmatter = !inFrontmatter;
      if (!inFrontmatter) sawContent = true;
      return;
    }
    if (inFrontmatter) return;
    if (trimmed) sawContent = true;
    if (!trimmed) return;
    if (trimmed.startsWith('#')) return;              // 标题是结构，不是条目
    if (trimmed.startsWith('<!--')) return;            // 我们自己的标记
    if (/^\|/.test(trimmed)) return;                   // 表格行
    if (!/\p{L}/u.test(trimmed)) return;               // 纯符号/分隔线
    const normalized = normalizeItem(trimmed);
    if (!normalized) return;
    out.push({
      key: short(normalized),
      normalized,
      text: trimmed,
      source,
      category,
      line: index + 1,
      identityClass: category === 'identity' || /(^|[^\p{L}])user\.md($|[^\p{L}])/iu.test(source),
    });
  });
  return out;
}

/** WB 侧参与 merge 的资产：memory + identity（daily 只是写回目标）。 */
export function listWbItems(config, roots) {
  const files = [];
  for (const category of ['memory', 'identity']) {
    const listing = listAssets(config, roots, category);
    for (const group of listing.groups) {
      for (const file of group.files) {
        // merge 只吃散文文件：identity 目录里还躺着 workspace-state.json 之类的应用状态，
        // 那些是机器状态不是记忆条目（2026-10-08 实测发现被误当成条目）。
        if (!/\.(md|markdown|txt)$/i.test(file.name)) continue;
        files.push({ ...file, category });
      }
    }
  }

  const items = [];
  const fileHashes = {};
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file.path, 'utf8');
    } catch {
      continue;
    }
    fileHashes[file.path] = {
      hash: sha256(text),
      mtime: file.mtime,
      bytes: file.bytes,
      category: file.category,
      name: file.name,
    };
    items.push(...extractItems(text, file.path, file.category));
  }

  // 同一条内容在同一侧出现多次只保留一份
  const seen = new Set();
  const unique = items.filter((item) => (seen.has(item.key) ? false : (seen.add(item.key), true)));

  return { files: fileHashes, items: unique, identityClassCount: unique.filter((i) => i.identityClass).length };
}

/* --------------------------- 跨侧匹配 --------------------------- */

/**
 * 字符二元组集合。中文用 bigram 比用空格分词稳得多（中英混排也一样）。
 */
function bigrams(normalized) {
  const cleaned = normalized.replace(/\s+/g, '');
  const set = new Set();
  if (cleaned.length === 1) set.add(cleaned);
  for (let i = 0; i < cleaned.length - 1; i += 1) set.add(cleaned.slice(i, i + 2));
  return set;
}

/**
 * 相似度 = max(bigram 包含率, bigram Jaccard)。
 * 用「包含率」（交集 / 较小集合）是有意的：WB 侧是短条目、dsh 侧常是长段落，
 * 短句被长段覆盖就该判为同一件事，而 Jaccard 会因长度差被压低。
 */
export function similarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const gram of A) if (B.has(gram)) inter += 1;
  const containment = inter / Math.min(A.size, B.size);
  const jaccard = inter / (A.size + B.size - inter);
  return Math.max(containment, jaccard);
}

/**
 * 一对多贪心匹配：先精确命中（零成本），再按相似度降序贪心配对。
 * 每侧每条最多归属一次；低于阈值的不算命中。
 */
export function matchItems(wbItems, dshItems, threshold) {
  const t = Number(threshold) > 0 ? Number(threshold) : 0.62;
  const dshByKey = new Map(dshItems.map((i) => [i.key, i]));
  const pairs = [];
  const usedWb = new Set();
  const usedDsh = new Set();

  for (const wbItem of wbItems) {
    const hit = dshByKey.get(wbItem.key);
    if (hit && !usedDsh.has(hit.key)) {
      usedWb.add(wbItem.key);
      usedDsh.add(hit.key);
      pairs.push({ key: wbItem.key, score: 1, method: 'exact', wb: wbItem, dsh: hit });
    }
  }

  const candidates = [];
  for (const wbItem of wbItems) {
    if (usedWb.has(wbItem.key)) continue;
    for (const dshItem of dshItems) {
      if (usedDsh.has(dshItem.key)) continue;
      const score = similarity(wbItem.normalized, dshItem.normalized || normalizeItem(dshItem.text));
      if (score >= t) candidates.push({ score, wbItem, dshItem });
    }
  }
  candidates.sort((x, y) => y.score - x.score);
  for (const c of candidates) {
    if (usedWb.has(c.wbItem.key) || usedDsh.has(c.dshItem.key)) continue;
    usedWb.add(c.wbItem.key);
    usedDsh.add(c.dshItem.key);
    pairs.push({ key: c.wbItem.key, score: Number(c.score.toFixed(3)), method: 'similarity', wb: c.wbItem, dsh: c.dshItem });
  }

  return {
    pairs,
    matched: pairs.length,
    exact: pairs.filter((p) => p.method === 'exact').length,
    fuzzy: pairs.filter((p) => p.method === 'similarity').length,
    onlyInWb: wbItems.filter((i) => !usedWb.has(i.key)),
    onlyInDsh: dshItems.filter((i) => !usedDsh.has(i.key)),
  };
}

/* --------------------------- 计划（diff） --------------------------- */

export function buildPlan(config, roots) {
  const state = loadState(config);
  const wb = listWbItems(config, roots);
  const dsh = listDshAssets(config);

  const match = matchItems(wb.items, dsh.items, config.similarityThreshold);
  const onlyInDsh = match.onlyInDsh;
  const onlyInWb = match.onlyInWb;
  const matched = match.matched;

  const pushPending = onlyInDsh.filter((i) => !state.pushed[i.key]);
  const stagePending = onlyInWb.filter((i) => !state.staged[i.key]);

  // 身份类：永不自动应用，只报告。
  // 注意这里用 onlyInDsh / onlyInWb 而不是 pushPending / stagePending —— 身份类条目
  // 一旦被暂存就不该从报告里消失：人工确认是「未完成」状态，必须每轮都还看得见。
  const needsHuman = [
    ...onlyInDsh.filter((i) => i.identityClass).map((i) => ({ side: 'dsh', kind: 'identity/unmatched', key: i.key, text: i.text, target: i.target })),
    ...onlyInWb.filter((i) => i.identityClass).map((i) => ({ side: 'wb', kind: 'identity/unmatched', key: i.key, text: i.text, source: i.source })),
  ];

  // 文件级窗口冲突：WB 侧与本侧同窗口都变了 → 按 updatedAt 判；同秒 WB 优先。
  // 若涉及身份类，一律升级为 needs-human（永不自动覆盖）。
  const conflicts = [];
  const wbChangedFiles = Object.entries(wb.files).filter(([p, cur]) => {
    const prev = state.wb[p];
    return prev && prev.hash !== cur.hash;
  });
  const dshChanged = Boolean(state.dsh.hotHash) && state.dsh.hotHash !== dsh.hotHash;
  if (dshChanged && wbChangedFiles.length > 0) {
    const dshTime = dsh.sourceMtime ? Date.parse(dsh.sourceMtime) : 0;
    for (const [file, cur] of wbChangedFiles) {
      const wbTime = Date.parse(cur.mtime);
      const identity = cur.category === 'identity';
      const tie = wbTime === dshTime;
      const winner = tie ? 'wb' : wbTime > dshTime ? 'wb' : 'dsh';
      conflicts.push({
        file,
        category: cur.category,
        wbMtime: cur.mtime,
        dshMtime: dsh.sourceMtime,
        identityClass: identity,
        resolution: identity ? 'needs-human' : winner === 'wb' ? 'keep-wb' : 'keep-dsh',
        rule: identity ? 'identity-class is never auto-overwritten' : tie ? 'same second -> WB priority' : 'newer updatedAt wins',
      });
    }
  }

  const plan = {
    ok: true,
    planId: short(`${Date.now()}:${dsh.hotHash}:${JSON.stringify(Object.keys(wb.files))}`),
    at: new Date().toISOString(),
    wb: { files: Object.keys(wb.files).length, items: wb.items.length, identityItems: wb.identityClassCount },
    dsh: { source: dsh.source, items: dsh.itemCount, identityItems: dsh.identityClassCount, documents: dsh.documents.length },
    matched,
    matchDetail: { exact: match.exact, fuzzy: match.fuzzy, threshold: Number(config.similarityThreshold) || 0.62 },
    onlyInDsh: onlyInDsh.length,
    onlyInWb: onlyInWb.length,
    pushPending: pushPending.length,
    stagePending: stagePending.length,
    alreadyPushed: onlyInDsh.length - pushPending.length,
    alreadyStaged: onlyInWb.length - stagePending.length,
    needsHuman,
    conflicts,
    push: pushPending.map((i) => ({ key: i.key, target: i.target, identityClass: i.identityClass, text: i.text.slice(0, 400) })),
    stage: stagePending.map((i) => ({ key: i.key, category: i.category, identityClass: i.identityClass, source: i.source, line: i.line, text: i.text.slice(0, 400) })),
    notes: [
      'merge 粒度为「归一化后的条目/行」；精确相等优先，其次按字符 bigram 相似度（阈值可配）匹配',
      'dsh 侧恒只读：WB→dsh 只落 inbox 暂存文件，写 dsh 记忆必须由 agent 走 mnemon 工具',
      '身份类（target=user / identity 目录）永不自动应用，一律 needs-human',
    ],
  };

  fs.mkdirSync(path.dirname(config.syncPlanPath), { recursive: true });
  fs.writeFileSync(config.syncPlanPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  return plan;
}

/* --------------------------- 执行（apply） --------------------------- */

export function buildInboxMarkdown(plan, config) {
  const lines = [];
  lines.push(`# dsh inbox —— 来自 WorkBuddy 的待并入条目`);
  lines.push('');
  lines.push(`- 生成时间：${plan.at}`);
  lines.push(`- 计划号：\`${plan.planId}\``);
  lines.push('- **这些内容还没有进入 dsh 记忆。** 本文件只是暂存：写入 dsh 记忆必须由 agent 调用 mnemon 工具完成。');
  lines.push('- 身份/画像类条目（target 建议 user）请先与用户确认，再写入；不得标 `critical`。');
  lines.push('');
  lines.push(renderInboxItems(plan));
  return lines.join('\n');
}

/** 只渲染条目段（不含文件头），用于往已有 inbox 追加新一轮。 */
export function renderInboxItems(plan) {
  const lines = [];
  if (plan.stage.length === 0) {
    lines.push('_（本轮没有需要并入的条目）_');
    lines.push('');
    return lines.join('\n');
  }
  for (const item of plan.stage) {
    lines.push(`## ${item.identityClass ? '[身份类·需确认] ' : ''}${path.basename(item.source)}:${item.line}`);
    lines.push('');
    lines.push('```text');
    lines.push(item.text);
    lines.push('```');
    lines.push('');
    lines.push(`- key：\`${item.key}\`　类别：${item.category}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function applyPlan(config, roots, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const includePush = opts.includePush !== false;
  const includeStage = opts.includeStage !== false;
  const dryRun = opts.dryRun === true;

  const plan = buildPlan(config, roots);
  const state = loadState(config);
  const receipt = {
    ok: true,
    planId: plan.planId,
    dryRun,
    pushed: [],
    skippedIdentity: plan.needsHuman.length,
    inboxPath: null,
    notes: [],
  };

  if (includePush && plan.push.length > 0) {
    const append = opts.appendDailyMemory;
    if (typeof append !== 'function') throw new Error('applyPlan requires the appendDailyMemory function');
    // 安全阀：首轮同步可能积累很多 dsh 独有条目，一次全推进 WB 日志会刷屏。
    const cap = Math.max(1, Number(config.maxPushPerRun) || 5);
    if (plan.push.length > cap) {
      receipt.notes.push(`push capped at ${cap} per run; ${plan.push.length - cap} item(s) deferred to the next run`);
    }
    for (const item of plan.push.slice(0, cap)) {
      if (item.identityClass) continue; // 身份类永不自动推
      if (dryRun) {
        receipt.pushed.push({ key: item.key, dryRun: true });
        continue;
      }
      const result = append(config, roots, {
        title: `dsh 记忆同步 · ${item.text.slice(0, 40)}`,
        body: item.text,
        tags: ['dsh-wb-sync', 'M3', 'auto-push', item.target],
        dedupeKey: `dsh-hot:${item.key}`,
      });
      if (result && result.ok) {
        state.pushed[item.key] = { at: new Date().toISOString(), target: result.path, marker: result.marker || null };
        receipt.pushed.push({ key: result.marker || item.key, path: result.path, skipped: result.skipped || null });
      } else {
        receipt.pushed.push({ key: item.key, error: result && result.reason ? result.reason : 'unknown' });
      }
    }
  }

  if (includeStage) {
    const inboxPath = path.join(config.inboxDir, `dsh-inbox-${plan.at.slice(0, 10)}.md`);
    receipt.inboxPath = inboxPath;
    // 只有真的有新增才动文件：否则第二轮（stage 为空）会把已暂存的内容覆盖成空。
    if (plan.stage.length > 0 && !dryRun) {
      fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
      if (fs.existsSync(inboxPath)) {
        const existing = fs.readFileSync(inboxPath, 'utf8');
        const section = [`<!-- run ${plan.planId} ${plan.at} -->`, '', renderInboxItems(plan)].join('\n');
        fs.writeFileSync(inboxPath, `${existing.trimEnd()}\n\n${section}`, 'utf8');
      } else {
        fs.writeFileSync(inboxPath, buildInboxMarkdown(plan, config), 'utf8');
      }
      for (const item of plan.stage) state.staged[item.key] = { at: new Date().toISOString(), inbox: inboxPath };
    } else if (plan.stage.length === 0) {
      const keep = state.runs.length > 0 ? Object.values(state.staged)[0] : null;
      if (keep && keep.inbox) receipt.inboxPath = keep.inbox;
      if (!fs.existsSync(receipt.inboxPath || '')) receipt.inboxPath = null;
      receipt.notes.push('no new WB-only items this run; the existing inbox file was left untouched');
    }
  }

  if (!dryRun) {
    const wb = listWbItems(config, roots);
    const dsh = listDshAssets(config);
    state.wb = wb.files;
    state.dsh = { hotHash: dsh.hotHash, source: dsh.source, sourceMtime: dsh.sourceMtime, itemCount: dsh.itemCount };
    state.runs.push({
      at: new Date().toISOString(),
      planId: plan.planId,
      pushed: receipt.pushed.length,
      staged: plan.stage.length,
      needsHuman: plan.needsHuman.length,
      conflicts: plan.conflicts.length,
    });
    saveState(config, state);
    receipt.statePath = config.syncStatePath;
  }

  receipt.summary = {
    matched: plan.matched,
    pushed: receipt.pushed.length,
    staged: plan.stage.length,
    needsHuman: plan.needsHuman.length,
    conflicts: plan.conflicts.length,
  };
  receipt.notes.push('dsh 侧未被本操作修改；写入 dsh 记忆请用 mnemon 工具并参考 inbox 文件');
  return receipt;
}

/* --------------------------- M4：技能镜像 --------------------------- */

/** 从 SKILL.md 抽一段兜底描述（frontmatter 缺省或退化时用）。 */
function fallbackParagraph(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  // 跳过 frontmatter 块
  let start = 0;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    start = end === -1 ? 0 : end + 1;
  }
  const paragraph = lines
    .slice(start)
    .find((line) => line && !line.startsWith('#') && !line.startsWith('---') && !line.startsWith('|') && !line.startsWith('-') && line.length > 12);
  return paragraph || '';
}

/**
 * 解析 SKILL.md 的 name / description。
 *
 * ⚠️ 必须处理 YAML **块标量**：很多技能写成 `description: >` 或 `description: |`，
 * 描述正文在后续缩进行里。早期只取同一行的值，结果把描述抓成 `>` / `|`
 * （实测 `annual-report-analysis` / `cnki-search` 等就是这样退化的，2026-10-08 修）。
 */
function parseSkillMeta(text, fallbackName) {
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  let name = fallbackName;
  let description = '';
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
        // 块标量：往后收集缩进行，遇到非缩进行即结束
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
    const heading = text.match(/^#\s+(.+)$/m);
    if (heading && name === fallbackName) name = heading[1].trim();
    description = fallbackParagraph(text);
  }
  return { name, description: description.slice(0, 300) };
}

/**
 * 技能只读镜像：只抓名称/描述/体积/哈希/时间，**不复制正文、不执行**。
 * 开发计划 §10 已定：WB 的 SKILL.md 与 dsh 插件格式不同，只能镜像与索引。
 */
export function buildSkillsMirror(config, roots) {
  const listing = listAssets(config, roots, 'skills');
  const group = listing.groups.find((g) => g.category === 'skills') || { files: [] };
  const skills = [];

  for (const file of group.files) {
    let text;
    try {
      text = fs.readFileSync(file.path, 'utf8');
    } catch {
      continue;
    }
    const fallback = path.basename(path.dirname(file.path));
    const meta = parseSkillMeta(text, fallback);
    skills.push({
      id: fallback,
      name: meta.name,
      description: meta.description,
      path: file.path,
      bytes: file.bytes,
      mtime: file.mtime,
      hash: short(text),
      tier: 'normal',
    });
  }
  skills.sort((a, b) => a.id.localeCompare(b.id));

  const mirror = {
    generatedAt: new Date().toISOString(),
    count: skills.length,
    roots: group.roots,
    note: 'read-only metadata mirror; WB skills are never executed by dsh',
    skills,
  };

  if (config.skillsMirrorPath) {
    fs.mkdirSync(path.dirname(config.skillsMirrorPath), { recursive: true });
    fs.writeFileSync(config.skillsMirrorPath, `${JSON.stringify(mirror, null, 2)}\n`, 'utf8');
  }
  if (config.skillsMirrorMarkdownPath) {
    const lines = ['# WorkBuddy 技能镜像（只读元数据）', '', `- 生成时间：${mirror.generatedAt}`, `- 技能数：${mirror.count}`, '- 只镜像元数据，不复制正文、不执行', '', '| 技能 | 名称 | 描述 | 大小 | 哈希 |', '|---|---|---|---:|---|'];
    for (const s of skills) {
      lines.push(`| \`${s.id}\` | ${s.name.replace(/\|/g, '\\|')} | ${s.description.replace(/\|/g, '\\|')} | ${s.bytes} | \`${s.hash}\` |`);
    }
    lines.push('');
    fs.mkdirSync(path.dirname(config.skillsMirrorMarkdownPath), { recursive: true });
    fs.writeFileSync(config.skillsMirrorMarkdownPath, lines.join('\n'), 'utf8');
  }

  return mirror;
}
