// verify-publish.mjs —— 发布版报告的发布前闸门
//
// 为什么需要：
//   render-publish.mjs 已经把「不收录全文 / 短引用 / 剔除三类内容 / 署名回链 / AI 标识」
//   写进了模板，但模板只能保证「按当时的输入生成」，保证不了：
//     · 生成之后源数据又变过（数字悄悄过期）
//     · HTML 被手工改过（引用被拉长、联系方式还是占位符）
//     · 引用其实是模型改写过的（不是原文，署名就变成张冠李戴）
//   发布前必须有一个东西去**复核产物本身**，而不是相信生成它的脚本。
//
// 用法：
//   node verify-publish.mjs q<ID>-发布版.html [--source q<ID>-answers-full.json]
//        [--max-quote-ratio 1] [--leak-warn 20] [--leak-fail 40] [--strict] [--json]
//
// 退出码：0 = 0 FAIL（WARN 供人工确认）；1 = 有 FAIL，不能发
//
// 检查项：
//   1. 产物与来源：台账存在、源数据可读、报告不早于源数据、页面不是内部汇总页
//   2. 数据口径：保留数 / 剔除三类计数 / 样本字数 / 引用占比 —— 全部按同一套规则重算
//   3. 引用台账：每条引用是原文的逐字子串、长度合规、URL 与 ID 对应、无重复作者
//   4. 页面结构：引用块数量与台账一致、每块都有署名/赞数/日期/回链/「发表于知乎」；
//      引用块之外的页面文字与任何回答正文不得有 ≥ leak-fail 字的连续重合
//   5. 合规声明：AI 显式与隐式标识、撤稿通道（联系方式可用）、免责、非全文转载声明
//   6. 数字自洽：页面上写的引用数/字数/占比/样本数/剔除数，必须与重算结果一致
//   7. 软提示：攻击性/营销语气引用、快照过旧、非知乎外链
import fs from 'node:fs';
import path from 'node:path';
import {
  excludedSets, sampleChars, contactLooksUsable, PLACEHOLDER_CONTACT,
  isAnon, isOrg, isPaid,
} from './publish-rules.mjs';

const argv = process.argv.slice(2);
const HTML = argv.find((a) => !a.startsWith('--') && /\.html$/i.test(a));
if (!HTML) {
  console.error('用法: node verify-publish.mjs q<ID>-发布版.html [--source q<ID>-answers-full.json] [--json] [--strict]');
  process.exit(1);
}
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const JSONOUT = argv.includes('--json');
const STRICT = argv.includes('--strict');
const MAX_RATIO = Number(arg('--max-quote-ratio', 1));
const LEAK_WARN = Number(arg('--leak-warn', 20));
const LEAK_FAIL = Number(arg('--leak-fail', 40));

const checks = [];
let sectionName = '';
const section = (name) => { sectionName = name; if (!JSONOUT) console.log(`\n=== ${name} ===`); };
const record = (level, msg) => {
  checks.push({ level, section: sectionName, msg });
  if (!JSONOUT) console.log(`  ${level.padEnd(4)}  ${msg}`);
};
const FAIL = (m) => record('FAIL', m);
const WARN = (m) => record('WARN', m);
const OK = (m) => record('OK', m);

const decode = (s) => String(s ?? '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');
const norm = (s) => String(s ?? '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, '');
const visible = (s) => decode(String(s ?? '')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]+>/g, ' '))
  .replace(/[\u200b-\u200d\ufeff]/g, '')
  .replace(/\s+/g, ' ').trim();
const num = (s) => Number(String(s).replace(/,/g, ''));

const html = fs.readFileSync(HTML, 'utf8').replace(/^\uFEFF/, '');
const CIT = HTML.replace(/\.html$/i, '-citations.json');
let cit = null;
try { cit = JSON.parse(fs.readFileSync(CIT, 'utf8').replace(/^\uFEFF/, '')); } catch {}
const size = fs.statSync(HTML).size;

if (!JSONOUT) {
  console.log(`发布版自检：${HTML}`);
  console.log(`引用台账：${path.basename(CIT)}${cit ? '' : '（缺失）'}`);
}

// ---------- 1. 产物与来源 ----------
section('1. 产物与来源');
if (size > 1.5 * 1024 * 1024) FAIL(`页面 ${(size / 1024).toFixed(0)} KB，体积像内部汇总页（镜像页不能发布）`);
else if (size > 300 * 1024) WARN(`页面 ${(size / 1024).toFixed(0)} KB 偏大，确认没有把全文带出去`);
else OK(`页面 ${(size / 1024).toFixed(0)} KB`);

if (!cit) FAIL(`缺少 ${path.basename(CIT)} —— 没有引用台账，无法自证引用边界`);
else OK(`引用台账可读（${new Date(cit.generatedAt || 0).toISOString().slice(0, 10)} 生成）`);

const srcName = arg('--source', cit?.source || path.basename(HTML).replace(/-发布版\.html$/i, '-answers-full.json'));
let srcPath = path.resolve(path.dirname(HTML), srcName);
if (!fs.existsSync(srcPath)) srcPath = path.resolve(process.cwd(), srcName);
let rows = null;
try { rows = JSON.parse(fs.readFileSync(srcPath, 'utf8').replace(/^\uFEFF/, '')); } catch {}
if (!Array.isArray(rows)) FAIL(`找不到源数据 ${srcName} —— 无法校验引用是否原文、数字是否过期`);
else OK(`源数据 ${rows.length} 条（${srcName}）`);

if (cit?.generatedAt && Array.isArray(rows)) {
  const gen = Date.parse(cit.generatedAt);
  const mt = fs.statSync(srcPath).mtimeMs;
  if (Number.isFinite(gen) && mt > gen + 120_000) FAIL('源数据在报告生成之后被修改过 —— 页面上的数字已过期，必须重出');
  else OK('报告不早于源数据');
}
try {
  if (cit && fs.statSync(HTML).mtimeMs > fs.statSync(CIT).mtimeMs + 60_000) WARN('页面在台账生成之后被改过 —— 引用与数字可能已不同步');
} catch {}

// ---------- 2. 数据口径（重算） ----------
section('2. 数据口径（按同一套规则重算）');
let kept = [];
let chars = 0;
const quotes = Array.isArray(cit?.quotes) ? cit.quotes : [];
const qchars = quotes.reduce((a, q) => a + String(q.text || '').length, 0);

if (Array.isArray(rows) && cit) {
  const f = cit.filters || {};
  if (f.keepAnon || f.keepOrg || f.keepPaid) {
    FAIL(`报告生成时关闭了剔除（keepAnon=${!!f.keepAnon} keepOrg=${!!f.keepOrg} keepPaid=${!!f.keepPaid}），与页面声明矛盾`);
  }
  const ex = excludedSets(rows, { keepAnon: !!f.keepAnon, keepOrg: !!f.keepOrg, keepPaid: !!f.keepPaid });
  kept = ex.kept;
  chars = sampleChars(kept);

  if (ex.kept.length !== cit.keptCount) FAIL(`重算保留 ${ex.kept.length} 条 ≠ 台账 keptCount ${cit.keptCount}（数据或剔除规则变过）`);
  else OK(`保留 ${ex.kept.length} 条，与台账一致`);

  if (cit.keptCount + cit.excludedCount !== rows.length) FAIL(`台账 ${cit.keptCount} + 剔除 ${cit.excludedCount} ≠ 源数据 ${rows.length} 条`);
  const ce = cit.excluded || {};
  for (const k of ['anon', 'org', 'paid']) {
    if (ce[k] != null && ce[k] !== ex.reasons[k].length) FAIL(`剔除计数 ${k}：台账 ${ce[k]} ≠ 重算 ${ex.reasons[k].length}`);
  }
  if (cit.excludedCount != null && cit.excludedCount !== ex.dropped) FAIL(`剔除合计：台账 ${cit.excludedCount} ≠ 重算 ${ex.dropped}`);
  if (!Object.keys(ce).length) WARN('台账没有分项剔除计数（旧版产物？重出即可补齐）');

  if (cit.sampleChars != null && cit.sampleChars !== chars) FAIL(`样本正文字数：台账 ${cit.sampleChars} ≠ 重算 ${chars}`);
  if (cit.quotedChars != null && cit.quotedChars !== qchars) FAIL(`引用字数：台账 ${cit.quotedChars} ≠ 逐条相加 ${qchars}`);

  const ratio = qchars / Math.max(1, chars) * 100;
  if (ratio > MAX_RATIO) FAIL(`引用总量占样本正文 ${ratio.toFixed(3)}% > 上限 ${MAX_RATIO}%`);
  else OK(`引用 ${qchars} 字 / 样本正文 ${chars} 字 = ${ratio.toFixed(3)}%（上限 ${MAX_RATIO}%）`);
} else if (cit) {
  WARN('缺源数据，跳过保留数/剔除数/引用占比的重算');
}

// ---------- 3. 引用台账 ----------
section('3. 引用台账（逐条可核验）');
if (!quotes.length) WARN('台账里没有引用（报告只剩统计与结论；确认这是有意的）');
const ids = new Set();
const authors = new Set();
let quoteBad = 0;
for (const q of quotes) {
  const id = String(q.id ?? '');
  const author = String(q.author ?? '');
  const text = String(q.text ?? '');
  const core = norm(text.replace(/……$/, ''));
  const where = `引用 ${id || '(无 ID)'}`;

  if (!/^\d+$/.test(id)) { FAIL(`${where}：ID 不是数字`); quoteBad++; }
  if (!author.trim()) { FAIL(`${where}：缺作者署名`); quoteBad++; }
  if (!Number.isFinite(Number(q.votes))) { FAIL(`${where}：缺赞数`); quoteBad++; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(q.date || ''))) { FAIL(`${where}：日期格式不是 YYYY-MM-DD`); quoteBad++; }

  const m = /^https?:\/\/(?:www\.)?zhihu\.com\/question\/(\d+)\/answer\/(\d+)\/?$/.exec(String(q.url || ''));
  if (!m) { FAIL(`${where}：原答链接不是知乎回答 URL`); quoteBad++; }
  else if (m[2] !== id) { FAIL(`${where}：链接里的回答 ID 是 ${m[2]}，与台账不一致`); quoteBad++; }

  if (cit?.quoteChars != null && text.length > Number(cit.quoteChars) + 2) FAIL(`${where}：${text.length} 字，超过 --quote-chars ${cit.quoteChars}（+2 容忍省略号）`);

  if (ids.has(id)) FAIL(`${where}：ID 重复`);
  ids.add(id);
  if (authors.has(author)) FAIL(`${where}：作者 ${author} 重复（同一作者最多一处）`);
  authors.add(author);

  if (!Array.isArray(rows)) continue;
  const r = rows.find((x) => String(x.id) === id);
  if (!r) { FAIL(`${where}：源数据里没有这条回答`); quoteBad++; continue; }
  if (isAnon(r) || isOrg(r) || isPaid(r)) FAIL(`${where}：属于应剔除的匿名/机构/严选内容（作者「${author}」）`);
  if (!core) { FAIL(`${where}：引用文本为空`); quoteBad++; continue; }
  const body = norm(r.content || '');
  const at = body.indexOf(core);
  if (at < 0) { FAIL(`${where}：不是原文的逐字子串（引用被改写/拼接，署名会变成张冠李戴）`); quoteBad++; }
  else if (at > 0 && !/[。！？；：\n]/.test(body[at - 1])) WARN(`${where}：从句子中间开始（读起来可能像半句）`);
  if (!/[。！？…”』」]$/.test(text.trim())) WARN(`${where}：结尾不是句读（可能截断生硬）`);
}
if (!quoteBad) OK(`${quotes.length} 条引用：ID/作者/赞数/日期/链接/逐字原文全部通过`);

// ---------- 4. 页面结构：只引用、不搬运 ----------
section('4. 页面结构（只引用、不搬运）');
const QRE = /<div class="q"><p>([\s\S]*?)<\/p>\s*<div class="meta">([\s\S]*?)<\/div><\/div>/g;
const blocks = [...html.matchAll(QRE)].map((m) => {
  const meta = decode(m[2]);
  const rawText = decode(m[1]).trim();
  return {
    text: rawText.replace(/^「/, '').replace(/」$/, ''),
    meta,
    author: /<b>([\s\S]*?)<\/b>/.exec(meta)?.[1]?.trim() || '',
    votes: /·\s*([\d,]+)\s*赞\s*·/.exec(meta)?.[1],
    date: /·\s*(\d{4}-\d{2}-\d{2})\s*·/.exec(meta)?.[1],
    href: /href="([^"]+)"/.exec(meta)?.[1] || '',
    signed: /发表于知乎/.test(meta),
  };
});
const pageTexts = new Set(blocks.map((b) => norm(b.text)));
const blockProblems = [];
for (const b of blocks) {
  if (!b.author) blockProblems.push('缺作者');
  if (!b.votes) blockProblems.push('缺赞数');
  if (!b.date) blockProblems.push('缺日期');
  if (!b.href) blockProblems.push('缺原答链接');
  if (!b.signed) blockProblems.push('缺「发表于知乎」');
}
if (blocks.length !== quotes.length) FAIL(`页面引用块 ${blocks.length} 个 ≠ 台账 ${quotes.length} 条`);
else OK(`页面引用块 ${blocks.length} 个，与台账一致`);
const missingInPage = quotes.filter((q) => !pageTexts.has(norm(q.text)));
if (missingInPage.length) FAIL(`${missingInPage.length} 条台账引用没有出现在页面上：${missingInPage.slice(0, 5).map((q) => q.id).join(', ')}`);
const strayBlocks = blocks.filter((b) => !quotes.some((q) => norm(q.text) === norm(b.text)));
if (strayBlocks.length) FAIL(`${strayBlocks.length} 个页面引用块不在台账里（无法溯源）`);
if (blockProblems.length) FAIL(`引用块元信息不全：${[...new Set(blockProblems)].join('、')}`);
else if (blocks.length) OK('每个引用块都有作者/赞数/日期/回链/「发表于知乎」');

const hrefIds = [...html.matchAll(/href="(https?:\/\/(?:www\.)?zhihu\.com\/question\/(\d+)\/answer\/(\d+)\/?)"/g)];
const qids = new Set(hrefIds.map((m) => m[2]));
if (qids.size > 1) FAIL(`引用链接指向 ${qids.size} 个不同问题：${[...qids].join(', ')}`);
for (const m of hrefIds) if (!ids.has(m[3])) FAIL(`页面链接到台账外的回答 ${m[3]}`);

// 引用块之外的文字，与任何回答原文不得有长距离逐字重合。
// 取 N 字窗口完全一致 → 用二分找最长连续重合长度。
function pageTextOf(s) {
  let t = s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(QRE, ' ')
    .replace(/<[^>]+>/g, ' ');
  t = decode(t)
    .replace(/https?:\/\/[^\s<>"']+/gi, ' ')
    .replace(/www\.[^\s<>"']+/gi, ' ');
  return norm(t);
}
function leakRuns(pageText, sourceRows, min) {
  if (!Array.isArray(sourceRows) || !pageText) return [];
  const N = Math.max(12, min);
  const grams = new Set();
  for (let i = 0; i + N <= pageText.length; i++) grams.add(pageText.slice(i, i + N));
  const out = [];
  for (const r of sourceRows) {
    const body = norm(r.content || '');
    if (body.length < N) continue;
    let best = 0, bestText = '';
    let i = 0;
    while (i + N <= body.length) {
      if (!grams.has(body.slice(i, i + N))) { i++; continue; }
      let lo = N, hi = Math.min(body.length - i, 400);
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (pageText.includes(body.slice(i, i + mid))) lo = mid; else hi = mid - 1;
      }
      if (lo > best) { best = lo; bestText = body.slice(i, i + lo); }
      i += lo;
    }
    if (best >= min) out.push({ id: r.id, len: best, text: bestText });
  }
  return out.sort((a, b) => b.len - a.len);
}
if (size <= 1.5 * 1024 * 1024 && Array.isArray(rows)) {
  const runs = leakRuns(pageTextOf(html), rows, LEAK_WARN);
  const big = runs.filter((r) => r.len >= LEAK_FAIL);
  if (big.length) {
    FAIL(`${big.length} 条回答在引用块之外有 ≥${LEAK_FAIL} 字连续重合（疑似搬运正文）：${big.slice(0, 5).map((r) => r.id).join(', ')}`);
    if (!JSONOUT) for (const r of big.slice(0, 5)) console.log(`        ${r.id} · ${r.len} 字 · ${r.text.slice(0, 50)}…`);
  } else if (runs.length) {
    WARN(`${runs.length} 条回答在引用块之外有 ${LEAK_WARN}–${LEAK_FAIL - 1} 字重合（多为书名/术语，人工扫一眼）：${runs.slice(0, 5).map((r) => r.id).join(', ')}`);
    if (!JSONOUT) for (const r of runs.slice(0, 5)) console.log(`        ${r.id} · ${r.len} 字 · ${r.text.slice(0, 50)}`);
  } else OK(`引用块之外与任何回答正文无 ≥${LEAK_WARN} 字连续重合`);
}
if (/<script[\s>]/i.test(html)) WARN('页面含 <script>：发布版应是静态页，确认没有嵌入全文或追踪代码');

// ---------- 5. 合规声明 ----------
section('5. 合规声明');
const text = visible(html);
if (/AI\s*辅助生成/.test(text)) OK('文首有显式 AI 标识');
else FAIL('缺少可见的「AI 辅助生成」标识（《标识办法》要求显式标识）');
if (/<meta[^>]+name="ai-generated"/i.test(html)) OK('有隐式标识（meta name="ai-generated"）');
else WARN('缺少隐式标识 meta name="ai-generated"（建议补上）');

if (/撤稿/.test(text)) OK('有撤稿/异议通道说明');
else FAIL('缺少撤稿/异议通道说明');
const contactM = /请联系\s*([^，。；<]+)/.exec(text);
const contact = contactM ? contactM[1].trim() : '';
if (!contact) FAIL('找不到「请联系 …」的联系方式');
else if (PLACEHOLDER_CONTACT.test(contact)) FAIL(`联系方式还是占位符：「${contact}」—— 发布前必须换成真实邮箱/私信`);
else if (!contactLooksUsable(contact)) WARN(`联系方式「${contact}」不像邮箱/链接/知乎私信，确认能收到`);
else OK(`联系方式可用：${contact}`);

if (/免责/.test(text) && /不构成/.test(text)) OK('有免责声明');
else WARN('免责声明不完整（建议写明「不构成…建议/不代表被引用者观点」）');
if (/不收录任何回答的完整正文/.test(text)) OK('明示「不是全文转载」');
else WARN('缺少「不收录全文」的边界声明');

const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => decode(m[1]))
  .filter((u) => /^https?:\/\//i.test(u));
const nonZhihu = [...new Set(links.filter((u) => !/^https?:\/\/(?:www\.)?zhihu\.com\//i.test(u)))];
if (nonZhihu.length) WARN(`有 ${nonZhihu.length} 个非知乎外链（确认不是推广/竞品）：${nonZhihu.slice(0, 3).join(', ')}`);

// ---------- 6. 数字自洽 ----------
section('6. 页面数字与重算结果一致');
if (cit && chars > 0) {
  const expect = {
    quotes: quotes.length,
    chars: qchars,
    ratio: (qchars / Math.max(1, chars) * 100).toFixed(3),
    kept: kept.length || cit.keptCount,
    dropped: rows ? rows.length - (kept.length || cit.keptCount) : cit.excludedCount,
  };
  const notice = /全部直接引用共\s*([\d,]+)\s*处、合计约\s*([\d,]+)\s*字（约占样本正文总量的\s*([\d.]+)%）/.exec(text);
  const foot = /引用\s*([\d,]+)\s*处（约\s*([\d,]+)\s*字，占样本正文\s*([\d.]+)%）/.exec(text);
  if (!notice) WARN('文首声明里没有引用数量/占比（无法自动核对总量）');
  else {
    const bad = [];
    if (num(notice[1]) !== expect.quotes) bad.push(`处数 ${notice[1]} ≠ ${expect.quotes}`);
    if (num(notice[2]) !== expect.chars) bad.push(`字数 ${notice[2]} ≠ ${expect.chars}`);
    if (Number(notice[3]).toFixed(3) !== expect.ratio) bad.push(`占比 ${notice[3]}% ≠ ${expect.ratio}%`);
    if (bad.length) FAIL(`文首声明与重算不一致：${bad.join('；')}`);
    else OK(`文首声明：${expect.quotes} 处 / ${expect.chars} 字 / ${expect.ratio}%`);
  }
  if (!foot) WARN('页脚没有引用统计（无法自动核对）');
  else {
    const bad = [];
    if (num(foot[1]) !== expect.quotes) bad.push(`处数 ${foot[1]} ≠ ${expect.quotes}`);
    if (num(foot[2]) !== expect.chars) bad.push(`字数 ${foot[2]} ≠ ${expect.chars}`);
    if (Number(foot[3]).toFixed(3) !== expect.ratio) bad.push(`占比 ${foot[3]}% ≠ ${expect.ratio}%`);
    if (bad.length) FAIL(`页脚统计与重算不一致：${bad.join('；')}`);
    else OK(`页脚统计：${expect.quotes} 处 / ${expect.chars} 字 / ${expect.ratio}%`);
  }

  const samples = [...text.matchAll(/样本\s*([\d,]+)\s*条回答/g)].map((m) => num(m[1]));
  if (!samples.length) WARN('页面上找不到样本条数');
  else if (samples.some((n2) => n2 !== expect.kept)) FAIL(`页面样本数 ${[...new Set(samples)].join('/')} ≠ 重算 ${expect.kept}`);
  else OK(`样本数 ${expect.kept} 条（${samples.length} 处一致）`);

  const excl = /共\s*([\d,]+)\s*条（匿名\s*([\d,]+)\s*·\s*机构\/广告\s*([\d,]+)\s*·\s*严选\s*([\d,]+)）/.exec(text);
  if (expect.dropped > 0) {
    if (!excl) WARN(`页面上没有分项剔除计数（应为 ${expect.dropped} 条）`);
    else {
      const got = [num(excl[1]), num(excl[2]), num(excl[3]), num(excl[4])];
      const want0 = exCounts(rows, cit);
      const want = [expect.dropped, want0.anon, want0.org, want0.paid];
      if (got.some((v, i) => v !== want[i])) FAIL(`剔除披露 ${got.join('/')} ≠ 重算 ${want.join('/')}（合计/匿名/机构/严选）`);
      else OK(`剔除 ${got[0]} 条（匿名 ${got[1]} · 机构/广告 ${got[2]} · 严选 ${got[3]}），与重算一致`);
    }
  } else if (excl) FAIL('页面披露了剔除条数，但重算没有可剔除内容');
} else if (cit) {
  WARN('缺源数据，跳过页面数字核对（数字是否正确无法证明）');
}

function exCounts(sourceRows, c) {
  if (!Array.isArray(sourceRows) || !c) return { anon: c?.excluded?.anon || 0, org: c?.excluded?.org || 0, paid: c?.excluded?.paid || 0 };
  const f = c.filters || {};
  const r = excludedSets(sourceRows, { keepAnon: !!f.keepAnon, keepOrg: !!f.keepOrg, keepPaid: !!f.keepPaid }).reasons;
  return { anon: r.anon.length, org: r.org.length, paid: r.paid.length };
}

// ---------- 7. 软提示 ----------
section('7. 软提示（人工确认）');
const ATTACK = /学术混混|大忽悠|骗子|放屁|傻|愚蠢|废物|人渣|垃圾|误人子弟|不学无术|臭名昭著|半吊子|原教旨/;
const MARKET = /加微信|微信公众号|知识星球|扫码|领取资料|私信我|优惠|下单/;
const risky = quotes.filter((q) => ATTACK.test(q.text) || MARKET.test(q.text));
if (risky.length) WARN(`${risky.length} 条引用含攻击性/营销用语：${risky.map((q) => q.id).join(', ')}`);
else OK('引用未命中攻击性/营销词表');

if (cit?.snapshot) {
  const days = Math.round((Date.now() - Date.parse(cit.snapshot)) / 86400_000);
  if (Number.isFinite(days) && days > 30) WARN(`数据快照已 ${days} 天（赞数/回答数会变，发布前确认仍可接受）`);
  else OK(`数据快照 ${String(cit.snapshot).slice(0, 10)}（${days} 天前）`);
}

// ---------- 汇总 ----------
const fails = checks.filter((c) => c.level === 'FAIL').length;
const warns = checks.filter((c) => c.level === 'WARN').length;
const okN = checks.filter((c) => c.level === 'OK').length;
const stats = {
  file: path.basename(HTML), source: srcName,
  kept: kept.length || cit?.keptCount || null,
  quotes: quotes.length, quotedChars: qchars,
  ratio: chars ? Number((qchars / chars * 100).toFixed(4)) : null,
  pageKB: Number((size / 1024).toFixed(1)),
};

if (JSONOUT) {
  console.log(JSON.stringify({ ok: fails === 0 && !(STRICT && warns), stats, fails, warns, checks }, null, 2));
} else {
  console.log('');
  const blocked = fails || (STRICT && warns);
  if (blocked) console.log(`❌ verify-publish：${fails} 个 FAIL · ${warns} 个 WARN · ${okN} 个 OK${STRICT && warns && !fails ? '（--strict：WARN 也阻断）' : ''} —— 修完再发`);
  else console.log(`✓ verify-publish 通过（${warns} 个 WARN 供人工确认）`);
}
process.exit(fails || (STRICT && warns) ? 1 : 0);
