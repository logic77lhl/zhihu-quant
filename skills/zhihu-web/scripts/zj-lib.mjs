// 数据层：读产物 / 算口径 / 出 manifest / 渲染简报
//
// 为什么单独成文件（而不是塞进 zj.mjs）：
//   参数解析和打印属于 CLI，统计与口径必须能被 test-zj.mjs 直接 import 断言。
//   这个 skill 的历史事故几乎都发生在"没人校验的中间层"，所以口径计算要可测。
//
// 口径原则（与 SKILL.md 一致）：
//   - 未知一律标 unknown / null，绝不用 0 冒充
//   - 缺失要写出来（missing），不静默
//   - 平台 totals 与实抓数的差值必须显式呈现，并给出可能原因
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SCHEMA = 'zhihu-quant.manifest/1';
export const PAGE = 20;
// 阈值写死在代码里，不靠人临场判断：30 条的题出整页 HTML 是浪费，800 条的题出简报是骗人。
export const THRESHOLDS = { brief: 40, compact: 200 };
export const FIELD_LIST = [
  'id', 'author', 'votes', 'comments', 'thanks',
  'created_at', 'updated_at', 'url', 'content',
  'answer_type', 'author_type', 'question_title',
];

export const answersFile = (dir, qid) => path.join(dir, `q${qid}-answers-full.json`);
export const stateFile = (dir, qid) => answersFile(dir, qid) + '.state.json';
export const manifestFile = (dir, qid) => path.join(dir, `q${qid}-manifest.json`);

/** 从 URL 或裸 ID 里取数字 ID。question 命令只收数字，这里统一入口。 */
export function parseQid(input) {
  const s = String(input || '').trim();
  const m = s.match(/question\/(\d+)/) || s.match(/^(\d{6,})$/);
  return m ? m[1] : null;
}

/** 列表接口返回 HTML；旧产物可能没剥标签，这里再剥一次（幂等）。 */
export function stripHtml(h) {
  return String(h || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<figure[\s\S]*?<\/figure>/gi, '\n')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

/** ISO → 北京时间字符串。知乎用户在国内，报告里统一用 +08:00，别让人自己换算。 */
export function fmtCN(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + 8 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** 载入产物。返回 raw 原样数组，绝不改写文件。 */
export function loadAnswers(dir, qid) {
  const file = answersFile(dir, qid);
  if (!fs.existsSync(file)) return { ok: false, file, reason: 'NOT_FOUND' };
  const raw = readJson(file);
  if (!Array.isArray(raw)) return { ok: false, file, reason: 'NOT_ARRAY' };
  const buf = fs.readFileSync(file);
  return {
    ok: true,
    file,
    raw,
    bytes: buf.length,
    mtime: fs.statSync(file).mtime,
    sha16: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16),
  };
}

export function loadState(dir, qid) {
  const file = stateFile(dir, qid);
  if (!fs.existsSync(file)) return { ok: false, file, state: null };
  const state = readJson(file);
  return { ok: !!state, file, state, mtime: state ? fs.statSync(file).mtime : null };
}

function median(sorted) {
  const n = sorted.length;
  if (!n) return null;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function p90(sorted) {
  const n = sorted.length;
  if (!n) return null;
  return sorted[Math.min(n - 1, Math.max(0, Math.ceil(0.9 * n) - 1))];
}

export function computeStats(rows) {
  const n = rows.length;
  const votes = rows.map((r) => num(r.votes)).sort((a, b) => a - b);
  const chars = rows.map((r) => stripHtml(r.content).length).sort((a, b) => a - b);
  const times = rows.map((r) => Date.parse(r.created_at)).filter(Number.isFinite).sort((a, b) => a - b);
  const sum = votes.reduce((s, v) => s + v, 0);
  const top3 = votes.slice(Math.max(0, n - 3)).reduce((s, v) => s + v, 0);
  const perDay = {};
  for (const r of rows) {
    const cn = fmtCN(r.created_at);
    if (!cn) continue;
    const day = cn.slice(0, 10);
    perDay[day] = (perDay[day] || 0) + 1;
  }
  return {
    n,
    votes: {
      sum,
      median: median(votes),
      p90: p90(votes),
      max: n ? votes[n - 1] : null,
      zero: votes.filter((v) => v === 0).length,
      top3,
      top3SharePct: pct(top3, sum),
    },
    chars: {
      sum: chars.reduce((s, c) => s + c, 0),
      median: median(chars),
      max: n ? chars[n - 1] : null,
      under80: chars.filter((c) => c < 80).length,
    },
    time: {
      first: times.length ? new Date(times[0]).toISOString() : null,
      last: times.length ? new Date(times[times.length - 1]).toISOString() : null,
      spanHours: times.length ? Math.round(((times[times.length - 1] - times[0]) / 3600e3) * 10) / 10 : null,
      perDay,
    },
  };
}

export function computeFields(rows) {
  const out = {};
  for (const f of FIELD_LIST) {
    let present = 0;
    for (const r of rows) {
      const v = r[f];
      if (v !== undefined && v !== null && v !== '') present++;
    }
    out[f] = { present, missing: rows.length - present };
  }
  return out;
}

export function computeDistributions(rows) {
  const tally = (key) => {
    const out = {};
    for (const r of rows) {
      const v = r[key] === undefined || r[key] === null || r[key] === '' ? '(缺)' : String(r[key]);
      out[v] = (out[v] || 0) + 1;
    }
    return out;
  };
  return { answerType: tally('answer_type'), authorType: tally('author_type') };
}

/** 覆盖情况：只信 state.json。没有 state 就是未知 —— 不能因为"文件在"就当成完整。 */
export function computeCoverage(state, count) {
  if (!state) {
    return {
      known: false,
      reason: '没有 state.json（可能不是分页抓取产物），完整性未知',
      totals: null,
      missing: null,
      pages: null,
      coverCheck: 'unknown',
      coverCheckAt: null,
    };
  }
  const totalsArr = Object.values(state.totals || {}).map(Number).filter(Number.isFinite);
  const totals = totalsArr.length ? Math.max(...totalsArr) : null;
  const doneKeys = Object.keys(state.done || {});
  const done = doneKeys.length;
  const failed = Array.isArray(state.failed) ? state.failed.length : 0;
  const cc = state.coverCheck ? (state.coverCheck.skipped ? 'pass' : 'fallback') : 'none';
  // 只有真的翻过页的排序才算"全量"。created 常常只做了首屏覆盖检查（done 里没有 created:*），
  // 把它写成"default + created"会让人误以为两个排序都抓全了 —— 这是口径错误，不只是措辞问题。
  const fetchedSorts = [...new Set(doneKeys.map((k) => String(k).split(':')[0]))].sort();
  const declaredSorts = Object.keys(state.totals || {});
  return {
    known: true,
    totals,
    missing: totals === null ? null : Math.max(0, totals - count),
    pages: { done, failed },
    coverCheck: cc,
    coverCheckAt: state.coverCheck?.at || null,
    sorts: Object.keys(state.totals || {}),
    fetchedSorts,
    onlyCoverChecked: declaredSorts.filter((s) => !fetchedSorts.includes(s)),
  };
}

export function pickMode(n) {
  if (n <= THRESHOLDS.brief) return 'brief';
  if (n <= THRESHOLDS.compact) return 'compact';
  return 'full';
}

/** 自动告警：只写"能从数据里证出来的"问题，不做推测。 */
export function computeWarnings(manifest) {
  const w = [];
  const { coverage, stats, fields, distributions, count } = manifest;
  if (!coverage.known) w.push('完整性未知：没有 state.json，不能把这份产物当作全量');
  if (coverage.known && coverage.missing > 0) {
    w.push(`平台 totals 比实抓多 ${coverage.missing} 条 —— 可能已被删除/隐藏，或分页漏页（见 state.failed）`);
  }
  if (coverage.known && coverage.pages.failed > 0) w.push(`有 ${coverage.pages.failed} 个分页失败 —— 产物不完整`);
  if (coverage.coverCheck === 'fallback') w.push('created 首屏覆盖检查未通过，已退回双排序全量抓取');
  if (stats.chars.median !== null && stats.chars.median < 120 && count > 5) {
    w.push(`正文长度中位数仅 ${stats.chars.median} 字 —— 疑似 question 命令的截断产物（200 字符），不是 answers-full`);
  }
  if (fields.thanks.missing === count && count > 0) {
    w.push('感谢数全缺 —— 可能是补字段之前抓的旧产物，需要重抓或 enrich');
  }
  const paid = (distributions.answerType.paid || 0) + (distributions.answerType.paid_column_content || 0);
  if (paid > 0) w.push(`含 ${paid} 条严选/付费内容（answer_type !== normal），出报告前要判定是否剔除`);
  const orgs = distributions.authorType.organization || 0;
  if (orgs > 0) w.push(`含 ${orgs} 条机构号回答 —— 对外发布版按规则要剔除`);
  return w;
}

export function buildManifest(qid, rows, stateRes, fileRes) {
  const count = rows.length;
  const coverage = computeCoverage(stateRes?.state || null, count);
  const stats = computeStats(rows);
  const fields = computeFields(rows);
  const distributions = computeDistributions(rows);
  const first = rows.find((r) => r.question_title) || {};
  const manifest = {
    schema: SCHEMA,
    qid,
    title: first.question_title || null,
    questionUrl: `https://www.zhihu.com/question/${qid}`,
    generatedAt: new Date().toISOString(),
    fetchedAt: stateRes?.mtime ? stateRes.mtime.toISOString() : fileRes.mtime.toISOString(),
    source: {
      file: path.basename(fileRes.file),
      bytes: fileRes.bytes,
      sha256_16: fileRes.sha16,
      mtime: fileRes.mtime.toISOString(),
    },
    count,
    platform: { totals: coverage.totals, missing: coverage.missing },
    coverage,
    fields,
    distributions,
    stats,
    outputMode: pickMode(count),
    warnings: [],
  };
  manifest.warnings = computeWarnings(manifest);
  return manifest;
}

/** 截断到 n 个字符（按 code point，避免把 emoji 劈开），并压成单行。 */
export function excerpt(text, n) {
  const t = stripHtml(text).replace(/\s+/g, ' ').trim();
  const cp = Array.from(t);
  return cp.length <= n ? t : cp.slice(0, n).join('') + '…';
}

export function selectRows(rows, { sort = 'votes', minVotes = 0, type = 'all', top = null } = {}) {
  let out = rows.slice();
  if (type === 'normal') out = out.filter((r) => (r.answer_type || 'normal') === 'normal');
  if (type === 'paid') out = out.filter((r) => (r.answer_type || 'normal') !== 'normal');
  if (minVotes > 0) out = out.filter((r) => num(r.votes) >= minVotes);
  const key = sort === 'created' ? 'created_at' : sort === 'comments' ? 'comments' : 'votes';
  out.sort((a, b) => (key === 'created_at'
    ? (Date.parse(b[key]) || 0) - (Date.parse(a[key]) || 0)
    : num(b[key]) - num(a[key])));
  return top ? out.slice(0, top) : out;
}

const pad = (s, n) => {
  const v = String(s ?? '');
  // 中文按 2 列估算，纯粹为了终端对齐，不影响数据
  const w = Array.from(v).reduce((acc, ch) => acc + (/[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1), 0);
  return v + ' '.repeat(Math.max(0, n - w));
};

/** 终端表格：给人和 agent 都能读。 */
export function renderTable(rows, { excerptLen = 60, links = false } = {}) {
  if (!rows.length) return '（没有符合条件的回答）';
  const head = [pad('#', 4), pad('赞', 5), pad('评', 5), pad('谢', 4), pad('时间(+08)', 17), pad('作者', 14), '摘录'].join(' ');
  const lines = [head, '-'.repeat(Math.min(160, head.length + 40))];
  rows.forEach((r, i) => {
    lines.push([
      pad(i + 1, 4),
      pad(num(r.votes), 5),
      pad(num(r.comments), 5),
      pad(num(r.thanks), 4),
      pad(fmtCN(r.created_at) || '?', 17),
      pad(r.author || '(匿名)', 14),
      excerpt(r.content, excerptLen),
    ].join(' '));
    if (links && r.url) lines.push(' '.repeat(6) + r.url);
  });
  return lines.join('\n');
}

export function sortsLabel(coverage) {
  if (!coverage.known) return '未知';
  const full = (coverage.fetchedSorts || []).join(' + ') || '无';
  const only = (coverage.onlyCoverChecked || []).join('、');
  return `${full}${only ? `（${only} 仅覆盖检查，未全量）` : ''}`;
}

function coverageLine(coverage) {
  if (!coverage.known) return '未知（无 state.json，不能当作全量）';
  const cc = coverage.coverCheck === 'pass' ? 'created 首屏覆盖检查通过'
    : coverage.coverCheck === 'fallback' ? '覆盖检查未通过，已退回双排序全量'
      : coverage.coverCheck === 'none' ? '未做覆盖检查' : '覆盖检查未知';
  const miss = coverage.missing === null ? '未知' : `${coverage.missing} 条`;
  return `${sortsLabel(coverage)} · ${cc} · 平台多出 ${miss}`;
}

/** 简报：机器只写它算得出来的，观点位置留显式占位符，避免"机器编结论"。 */
export function renderBrief(manifest, rows, { top = null, excerptLen = null } = {}) {
  const mode = manifest.outputMode;
  const n = manifest.count;
  const limit = top ?? (mode === 'brief' ? 8 : 15);
  const ex = excerptLen ?? (mode === 'brief' ? 80 : 120);
  const s = manifest.stats;
  const c = manifest.coverage;
  const paid = (manifest.distributions.answerType.paid || 0) + (manifest.distributions.answerType.paid_column_content || 0);

  const L = [];
  L.push(`# ${manifest.title || `问题 ${manifest.qid}`}`);
  L.push('');
  L.push(`[原问题](${manifest.questionUrl}) · 抓取于 ${fmtCN(manifest.fetchedAt)} (+08) · 样本 **${n} / ${c.totals ?? '?'}** · 赞数合计 **${s.votes.sum}**`);
  L.push('');
  L.push('<!-- 待填：一句话结论（≤60 字，必须能被下方数据支持） -->');
  L.push('');
  L.push('## 机器读数');
  L.push('');
  L.push(`- 赞数：中位 ${s.votes.median ?? '—'}，P90 ${s.votes.p90 ?? '—'}，最高 ${s.votes.max ?? '—'}；前 3 条占全部赞数 **${s.votes.top3SharePct ?? '—'}%**；0 赞 ${s.votes.zero} 条`);
  L.push(`- 正文：合计 ${s.chars.sum} 字，中位 ${s.chars.median ?? '—'} 字，最长 ${s.chars.max ?? '—'} 字；不足 80 字的短答 ${s.chars.under80} 条`);
  L.push(`- 时间：${fmtCN(s.time.first) || '?'} → ${fmtCN(s.time.last) || '?'}（跨 ${s.time.spanHours ?? '?'} 小时）`);
  L.push(`- 类型：normal ${manifest.distributions.answerType.normal || 0}${paid ? ` / 严选付费 ${paid}` : ''}；机构号 ${manifest.distributions.authorType.organization || 0} 条`);
  const missingFields = Object.entries(manifest.fields).filter(([, v]) => v.missing > 0).map(([k, v]) => `${k} 缺 ${v.missing}`);
  L.push(`- 字段缺失：${missingFields.length ? missingFields.join('；') : '无'}`);
  L.push(`- 排序覆盖：${coverageLine(c)}`);
  if (manifest.warnings.length) {
    L.push('');
    L.push('> ⚠️ 数据告警');
    for (const w of manifest.warnings) L.push(`> - ${w}`);
  }
  L.push('');
  L.push(`## 头条（按赞数，前 ${limit}）`);
  L.push('');
  selectRows(rows, { sort: 'votes', top: limit }).forEach((r, i) => {
    const meta = [`**${num(r.votes)} 赞**`, `${num(r.comments)} 评论`, `${num(r.thanks)} 感谢`, r.author || '(匿名)', fmtCN(r.created_at) || '?']
      .filter(Boolean).join(' · ');
    L.push(`${i + 1}. ${meta}`);
    L.push(`   > ${excerpt(r.content, ex)}`);
    if (r.url) L.push(`   [原文](${r.url})`);
    L.push('');
  });
  L.push('## 待填（人不写，报告不算完成）');
  L.push('');
  L.push('- <!-- 待填：争议焦点 3 条，每条附 1 个支持链接 -->');
  L.push('- <!-- 待填：正反双方最强论点（steelman，各 1 条，必须给链接） -->');
  L.push('- <!-- 待填：数字冲突（同一指标跨度 ≥3 倍时列出，并注明谁提供） -->');
  L.push('- <!-- 待填：这条结论的边界（在什么前提下不成立） -->');
  L.push('');
  L.push('## 口径');
  L.push('');
  L.push('| 项 | 值 |');
  L.push('| --- | --- |');
  L.push(`| 样本 | ${n} / ${c.totals ?? '未知'}${c.missing ? `（缺 ${c.missing}）` : ''} |`);
  L.push(`| 分页 | ${c.pages ? `${c.pages.done} 页完成 / ${c.pages.failed} 页失败` : '未知'} |`);
  L.push(`| 排序 | ${sortsLabel(c)} |`);
  L.push(`| 抓取时间 | ${fmtCN(manifest.fetchedAt)} (+08) |`);
  L.push(`| 产物 | \`${manifest.source.file}\` · sha256:${manifest.source.sha256_16} |`);
  L.push(`| 生成 | zj.mjs · ${manifest.schema} · ${new Date().toISOString().slice(0, 10)} |`);
  L.push('');
  L.push('<!-- 机器生成部分到此为止；上方"待填"必须全部替换后才能对外 -->');
  return L.join('\n');
}
