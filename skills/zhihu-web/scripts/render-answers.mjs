// 知乎问题「回答汇总」渲染器
//   回答全文 JSON + 实体 JSON + 摘要 JSON  ->  单文件 HTML
//
// 用法:
//   node render-answers.mjs <answers-full.json> [--entities e.json] [--summaries s.json] [--out o.html]
//                            [--exclude-paid] [--exclude-org] [--exclude-kind fiction,adapted]
//
// 内容性质（回答征集类问题必用，详见 references/pipeline-v2.md 第 9 节）：
//   知乎「严选/盐选」= 商业状态，小说 = 文体，**两者互不包含**，不能合并成一个标签：
//     · 严选内容 100% 是虚构，但虚构内容里只有约 3% 是严选（多数小说作者免费发）
//     · 严选会被推荐位加权 —— 实测某题全题 0.56% 的严选内容占了 Top100 赞数的 45%
//   所以剔除要用 `--exclude-paid` 真的从数据里剔（母题聚合会按剩余重算），
//   而不是只加个标签 —— 只加标签的话按赞数排的榜单仍然被严选内容主导。
//   小说/虚构没有 API 标志，只能靠 classify-content-llm.mjs 判定；它会输出
//   粗筛+随机抽样，本页据此外推整体比例，并在口径段写明「未判定 ≠ 真实经历」。
//
// 页面结构:
//   ① 概览统计  ② AI 全局综述  ③ 观点/母题排行（可展开溯源）  ④ 书单排行  ⑤ 全部回答
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const IN = argv.find((a) => a.endsWith('.json'));
if (!IN) { console.error('用法: node render-answers.mjs <answers-full.json> [--entities e.json] [--summaries s.json] [--out o.html]'); process.exit(1); }
const opt = (flag, def) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const base = IN.replace(/-answers-full\.json$/, '');
const ENT = opt('--entities', base + '-entities.json');
const BOOKS = opt('--books', base + '-books-llm.json');
const THEMES = opt('--themes', base + '-themes.json');
const SUM = opt('--summaries', base + '-summaries.json');
const KIND = opt('--kind', base + '-content-kind.json');
const OUT = opt('--out', base + '-汇总.html');

// 剔除盐选/严选付费内容。它们的赞数被推荐位加权，
// 留在按赞数排的榜单里会盖过真实故事，必须单独剔而不是只加个标签。
//
// ⚠️ answer_type 实测有**三个**取值（2026-10-15，question/665321619）：
//     normal / paid / paid_column_content
//   只判断 === 'paid' 会漏掉 paid_column_content（实测 3 条）。
//   规则：**任何非 normal 都算付费内容。**
const EXCLUDE_PAID = argv.includes('--exclude-paid');
const EXCLUDE_ORG = argv.includes('--exclude-org');   // 机构号/广告主（批量投稿号）
const EXCLUDE_KIND = (opt('--exclude-kind', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

const allAnswers = JSON.parse(fs.readFileSync(IN, 'utf8'));
// 平台计数（paging.totals）：抓取脚本写在 <answers-full.json>.state.json 里。
// 与实收的差值就是已删除/已折叠的回答，页面要写出来，否则「少了 N 条」会被当成漏抓。
let platformTotal = 0;
try {
  const st = JSON.parse(fs.readFileSync(IN + '.state.json', 'utf8'));
  platformTotal = Math.max(0, ...Object.values(st.totals || {}).map(Number).filter((x) => Number.isFinite(x)));
} catch {}
const kindData = fs.existsSync(KIND) ? JSON.parse(fs.readFileSync(KIND, 'utf8')) : null;
const kindOf = (id) => (kindData?.perAnswer?.[String(id)] || {}).kind || '';

const isPaid = (a) => !!a.answer_type && a.answer_type !== 'normal';
const isOrg = (a) => a.is_advertiser || a.author_type === 'organization';
const dropped = { paid: [], org: [], kind: [] };
const answers = allAnswers.filter((a) => {
  if (EXCLUDE_PAID && isPaid(a)) { dropped.paid.push(a); return false; }
  if (EXCLUDE_ORG && isOrg(a)) { dropped.org.push(a); return false; }
  if (EXCLUDE_KIND.length && EXCLUDE_KIND.includes(kindOf(a.id))) { dropped.kind.push(a); return false; }
  return true;
});
const nDrop = dropped.paid.length + dropped.org.length + dropped.kind.length;

const entities = fs.existsSync(ENT) ? JSON.parse(fs.readFileSync(ENT, 'utf8')) : null;
const booksData = fs.existsSync(BOOKS) ? JSON.parse(fs.readFileSync(BOOKS, 'utf8')) : null;
const themesData = fs.existsSync(THEMES) ? JSON.parse(fs.readFileSync(THEMES, 'utf8')) : null;
const summaries = fs.existsSync(SUM) ? JSON.parse(fs.readFileSync(SUM, 'utf8')) : null;
const perAnswer = summaries?.perAnswer || {};

// 综述按「剔除口径」选：summaries.json 里可同时存多份（digests 映射），
// 本页用哪份取决于 --exclude-paid / --exclude-kind。
// 选错就会出现「榜单已剔盐选、综述还在推荐被剔掉的付费小说」—— 实测原版综述的
// 「值得先读的故事」第 4 条就是一条 2519 赞的严选小说。
const excludeTag = (EXCLUDE_PAID ? 'nopaid' : 'all') + '|' + (EXCLUDE_KIND.join(',') || 'nokind');
const digests = summaries?.digests || {};
const digest = digests[excludeTag]
  || (summaries?.digestTag === excludeTag ? summaries.digest : null)
  || summaries?.digest || null;
const digestExact = !!(digests[excludeTag] || summaries?.digestTag === excludeTag);
if (summaries?.digest && !digestExact && nDrop) {
  console.error(`[!] 口径不一致：本页剔除了 ${nDrop} 条，但没有「${excludeTag}」口径的综述，回落到了全量综述。`);
  console.error(`    修正：node summarize-answers.mjs <answers-full.json> --profile stories \\`);
  console.error(`            ${EXCLUDE_PAID ? '--exclude-paid ' : ''}--only-digest --rebuild-digest`);
  console.error(`          （逐条摘要会沿用缓存，只重建综述，约 10 秒）\n`);
}

const q = allAnswers[0] || {};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (s) => (s && !isNaN(Date.parse(s)) ? String(s).slice(0, 10) : '');

// ---- 内容性质统计（区分「盐选」与「小说」—— 两者互不包含，不能合并成一个标签）----
const KIND_LABEL = { real: '真实经历', fiction: '小说创作', adapted: '改编/虚构', offtopic: '与问题无关' };
const kindStats = {};
for (const a of answers) { const k = kindOf(a.id) || 'unknown'; kindStats[k] = (kindStats[k] || 0) + 1; }
const nFicLike = (kindStats.fiction || 0) + (kindStats.adapted || 0);
// 注意：Object.values() 的 filter 第二参是「下标」不是「键」，
// 用 filter((v,k)=>k!=='unknown') 会因 k 永远是数字而一个都不过滤，把未判定也算成已判定。
const nJudged = Object.entries(kindStats).filter(([k]) => k !== 'unknown').reduce((s, [, v]) => s + v, 0);
const nUnjudged = kindStats.unknown || 0;
// 全量判定（classify-content-llm.mjs --all）：无需外推，也不必再写「未判定 ≠ 真实经历」的免责。
// 抽样模式：比例靠外推，且必须提醒读者未判定 ≠ 真实。
const FULL_JUDGED = nUnjudged <= Math.max(1, answers.length * 0.005);
// 正确外推：粗筛命中区（fiction 占比高）+ 抽样未命中区（按抽样命中率线性外推）。
// 直接拿 nFicLike/nJudged 当全题比例是错的 —— 判定集是被粗筛富集过的，命中率被高估。
const ficEstimate = (() => {
  const audit = kindData?.auditSample || [];
  if (!audit.length) return null;
  const isFicId = (id) => ['fiction', 'adapted'].includes((kindData?.perAnswer?.[String(id)] || {}).kind);
  const auditJudged = audit.filter((id) => (kindData?.perAnswer?.[String(id)] || {}).kind);
  const auditFic = auditJudged.filter(isFicId).length;
  if (!auditJudged.length) return null;
  const rate = auditFic / auditJudged.length;
  const kept = new Set(answers.map((a) => String(a.id)));
  const unflagged = answers.filter((a) => !audit.includes(String(a.id)));
  const unflaggedPop = unflagged.filter((a) => !kept.has(String(a.id)) ? false : true).length;
  // 未判定且不在抽样里的部分才需要外推
  const needEst = unflagged.filter((a) => !kindOf(a.id)).length;
  const knownFic = answers.filter((a) => isFicId(a.id)).length;
  return knownFic + Math.round(rate * needEst);
})();
const nPaidInView = answers.filter(isPaid).length;
const nOrgInView = answers.filter(isOrg).length;

// ---- 统计 ----
const totalVotes = answers.reduce((s, a) => s + (a.votes || 0), 0);
const totalChars = answers.reduce((s, a) => s + (a.content || '').length, 0);
const dates = answers.map((a) => a.created_at).filter(Boolean).sort();
const withSummary = answers.filter((a) => perAnswer[a.id]).length;
const longCount = answers.filter((a) => (a.content || '').length >= 500).length;
const lowCount = answers.filter((a) => (a.content || '').trim().length < 80).length;
const richCount = answers.length - lowCount;
// 短评的赞数中位数（实测值，不写死）
const lowVotes = answers.filter((a) => (a.content || '').trim().length < 80).map((a) => a.votes || 0).sort((x, y) => x - y);
const medVotes = lowVotes.length ? lowVotes[Math.floor(lowVotes.length / 2)] : 0;

// ---- 书单：以 LLM 全文抽取为准（正则抽取会漏裸书名）----
const anchorName = (String(q.question_title || '').match(/《([^》]+)》/) || [])[1] || '';
const allBooks = booksData?.books || [];
const shapeBook = (b) => ({
  title: b.title, author: b.author || '', rec: b.rec, avoid: b.avoid, mention: b.mention,
  count: b.count, logSum: b.logSum, recLogSum: b.recLogSum ?? b.logSum,
  votesSum: b.votesSum, recVotesSum: b.recVotesSum ?? b.votesSum, maxVotes: b.maxVotes,
  samples: (b.samples || []).slice(0, 12).map((s) => ({
    answerId: String(s.answerId), votes: s.votes, comments: s.comments, date: s.date || fmtDate(s.created_at),
    author: s.author, url: s.url, polarity: s.polarity,
  })),
});
// 问题本体（如《置身事内》）不计入排行：它被大量低赞回答顺口提及，排第一是口径错误
const rankedAll = allBooks.filter((b) => b.title !== anchorName && b.rec >= 2)
  .sort((a, b) => (b.recLogSum ?? b.logSum) - (a.recLogSum ?? a.logSum));
const rankedTotal = rankedAll.length;
const ranked = rankedAll.slice(0, 80).map(shapeBook);
const avoided = allBooks.filter((b) => b.title !== anchorName && b.avoid >= 2)
  .sort((a, b) => b.avoid - a.avoid || b.logSum - a.logSum).slice(0, 12).map(shapeBook);
const anchorBook = allBooks.find((b) => b.title === anchorName);
const anchorAvoid = anchorBook ? anchorBook.samples.filter((s) => s.polarity === 'avoid').slice(0, 12).map((s) => ({
  answerId: String(s.answerId), votes: s.votes, comments: s.comments,
  date: s.date || fmtDate(s.created_at), author: s.author, url: s.url,
})) : [];
const singles = allBooks.filter((b) => b.title !== anchorName && b.rec === 1).length;

// ---- 观点：以 LLM 从全量回答归纳的标签为准 ----
const themeName = new Map((themesData?.taxonomy || []).map((t) => [t.id, t.name]));
const answerThemes = (id) => (themesData?.perAnswer?.[String(id)] || []).map((tid) => themeName.get(tid)).filter(Boolean);

// 母题聚合量必须按「保留下来的回答」重算。
// themes.json 里的 count/votesSum/logSum 是在全量上算的；
// 剔除盐选后若直接复用，排行仍会把被剔除内容的赞数算进来 —— 那等于没剔。
const keptIds = new Set(answers.map((a) => String(a.id)));
const themes = (themesData?.taxonomy || []).map((t) => ({ id: t.id, name: t.name, desc: t.desc }))
  .map((t) => {
    const samples = [];
    let count = 0, votesSum = 0, logSum = 0, maxVotes = 0;
    for (const a of answers) {
      if (!(themesData?.perAnswer?.[String(a.id)] || []).includes(t.id)) continue;
      count++; votesSum += a.votes || 0; logSum += Math.log10(1 + (a.votes || 0));
      if ((a.votes || 0) > maxVotes) maxVotes = a.votes || 0;
      samples.push({
        answerId: String(a.id), votes: a.votes || 0, comments: a.comments || 0,
        date: fmtDate(a.created_at), author: a.author || '', url: a.url || '',
        summary: perAnswer[a.id] || '', kind: kindOf(a.id) || '',
      });
    }
    return {
      id: t.id, name: t.name, desc: t.desc,
      count, votesSum, logSum: Number(logSum.toFixed(2)), maxVotes,
      samples: samples.sort((x, y) => y.votes - x.votes).slice(0, 12),
    };
  })
  .filter((t) => t.count > 0)
  .sort((a, b) => b.logSum - a.logSum);
const untagged = answers.filter((a) => !answerThemes(a.id).length).length;

// 故事征集题（无书单区块）把「观点/主张」改称「故事母题/故事」，避免用读书题口径描述
// --opinion：观点讨论题也满足「无书单 + 有标签」，会被上面的自动判断误判成故事题
//（实测 q420024656「为什么量化都用Python」被渲染成「故事母题排行」），显式关掉即可。
const STORY_MODE = !argv.includes('--opinion') && !ranked.length && themes.length > 0;
// --reviewed：综述与标签经人工复核时用，页面上如实标注（默认仍写「模型生成」）
const REVIEWED = argv.includes('--reviewed');

// ---- 页面数据（供前端渲染）----
const payload = {
  question: q.question_title || '',
  url: `https://www.zhihu.com/question/${q.question_id || ''}`,
  answers: answers.map((a) => ({
    id: String(a.id),
    author: a.author || '',
    votes: a.votes || 0,
    comments: a.comments || 0,
    date: fmtDate(a.created_at),
    url: a.url,
    len: (a.content || '').length,
    content: a.content || '',
    summary: perAnswer[a.id] || '',
    books: (booksData?.perAnswer?.[String(a.id)] || []),
    themes: answerThemes(a.id),
    kind: kindOf(a.id) || '',
    paid: isPaid(a),
    org: !!a.is_advertiser || a.author_type === 'organization',
    lowInfo: (a.content || '').trim().length < 80,
  })),
  themes,
  books: ranked,
  avoided,
  anchor: anchorBook ? shapeBook(anchorBook) : null,
  anchorAvoid,
  bookStats: booksData?.stats || null,
  bookTotal: allBooks.length,
  rankedTotal,
  singles,
  digest,
  // 综合分归一化用的边界值（在服务端算好，客户端只做归一）
  scoreBounds: (() => {
    const maxLog = (f) => Math.max(1, ...answers.map((a) => Math.log10(1 + (f(a) || 0))));
    const ds = answers.map((a) => Date.parse(a.created_at || '')).filter((x) => !isNaN(x));
    const minDate = ds.length ? Math.min(...ds) : 0;
    const maxDate = ds.length ? Math.max(...ds) : 0;
    return {
      logVotes: maxLog((a) => a.votes), logComments: maxLog((a) => a.comments), logLen: maxLog((a) => a.content.length),
      minDate, daySpan: Math.max(1, (maxDate - minDate) / 86400000),
    };
  })(),
  // 故事征集题把「主张」改称「故事」，前端文案随之切换
  storyMode: STORY_MODE,
  themeUnit: STORY_MODE ? '故事' : '主张',
  themeCountLabel: STORY_MODE ? '故事数' : '主张人数',
  // 综述小标题：优先用 digest 自带的 labels，没有就按题型兜底。
  // 实测踩过：模型偶尔返回只含 overview 的残缺综述，没有 labels，
  // 于是故事题页面的小标题回落成读书题的「共识要点」。
  digestLabels: Object.keys(digest?.labels || {}).length
    ? digest.labels
    : (STORY_MODE
      ? { consensus: '反复出现的母题', disputes: '结局的几种形态', readingPath: '值得先读的故事' }
      : { consensus: '共识要点', disputes: '分歧 / 注意', readingPath: '入门阅读顺序建议' }),
  // 内容性质：盐选与「小说」是两个独立维度，不能合并成一个标签
  kindLabel: KIND_LABEL,
  kindStats,
  nFicLike,
  nJudged,
  ficEstimate,
  nPaidInView,
  nOrgInView,
  hasKind: !!kindData,
};

const jsonForScript = (o) => JSON.stringify(o).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '');

const T_LABEL = STORY_MODE ? '故事母题' : '观点';

// 章节编号按实际存在的区块动态排
const secs = [{ id: 'digest', label: '全局综述' }];
if (payload.themes.length) secs.push({ id: 'themes', label: STORY_MODE ? '故事母题排行' : '观点排行' });
if (payload.books.length) secs.push({ id: 'books', label: '书单排行' });
secs.push({ id: 'all', label: '全部回答' });
const NUM = ['①', '②', '③', '④', '⑤', '⑥'];
const secNum = new Map(secs.map((s, i) => [s.id, NUM[i]]));

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(q.question_title || '知乎回答汇总')} — 汇总</title>
<style>
:root{
  --bg:#fbfbfd; --panel:#fff; --fg:#16181d; --dim:#6b7280; --faint:#9aa1ab;
  --line:#e6e8ec; --line2:#f0f2f5; --chip:#f4f5f7; --hover:#f7f8fa;
  --accent:#4f46e5; --accent-soft:#c9cef8; --pos:#0d9488; --warn:#b45309;
  --mark:#fde68a; --radius:10px;
  --shadow:0 1px 2px rgba(16,24,40,.04),0 1px 3px rgba(16,24,40,.06);
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0f1115; --panel:#161920; --fg:#e8eaed; --dim:#9aa1ab; --faint:#6b7280;
  --line:#242832; --line2:#1e222a; --chip:#1c2029; --hover:#1b1f27;
  --accent:#8b8cf7; --accent-soft:#33356b; --pos:#2dd4bf; --warn:#fbbf24;
  --mark:#5c4b12; --shadow:0 1px 2px rgba(0,0,0,.3);
}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);
  font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:1180px;margin:0 auto;padding:40px 22px 120px;overflow-x:clip}
h1{font-size:27px;line-height:1.35;margin:0 0 10px;letter-spacing:-.4px;font-weight:680}
h1 a{color:inherit;text-decoration:none}
h1 a:hover{color:var(--accent)}
.lede{color:var(--dim);font-size:13.5px;margin:0 0 4px}
.lede a{color:var(--accent);text-decoration:none}
.toc{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0 0}
.toc a{font-size:12.5px;color:var(--dim);text-decoration:none;background:var(--chip);border:1px solid var(--line);
  padding:4px 11px;border-radius:99px}
.toc a:hover{color:var(--accent);border-color:var(--accent-soft)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:1px;background:var(--line);
  border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;margin:24px 0 8px}
.st{background:var(--panel);padding:15px 17px}
.st b{display:block;font-size:23px;font-weight:660;letter-spacing:-.6px;line-height:1.2;font-variant-numeric:tabular-nums}
.st span{display:block;font-size:12px;color:var(--dim);margin-top:3px}
h2{font-size:19px;margin:44px 0 4px;font-weight:660;letter-spacing:-.2px;scroll-margin-top:16px}
h2 .n{color:var(--faint);font-weight:500;margin-right:8px;font-variant-numeric:tabular-nums}
.sub{color:var(--dim);font-size:13px;margin:0 0 16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}
.pad{padding:20px 22px}
.digest .overview{font-size:15px;line-height:1.8;margin:0 0 20px}
.dcols{display:grid;grid-template-columns:1fr 1fr;gap:22px}
@media(max-width:780px){.dcols{grid-template-columns:1fr}}
.dbox h4{margin:0 0 8px;font-size:13px;color:var(--dim);font-weight:620;letter-spacing:.02em}
.dbox ol,.dbox ul{margin:0;padding-left:20px}
.dbox li{margin:5px 0;font-size:14px}
.dbox.cons li::marker{color:var(--pos)}
.dbox.warn li::marker{color:var(--warn)}
/* 书单 */
.anchor-note{background:color-mix(in oklab,var(--warn) 8%,var(--panel));border:1px solid var(--line);
  border-left:3px solid var(--warn);border-radius:0 8px 8px 0;padding:11px 15px;font-size:13px;line-height:1.7;
  color:var(--dim);margin:0 0 14px}
.anchor-note b{color:var(--fg)}
.ano{margin-top:9px}
.ano summary{cursor:pointer;color:var(--accent);font-size:12.5px}
.ano table{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:8px}
.ano td,.ano th{padding:5px 8px;border-bottom:1px solid var(--line2);text-align:left;vertical-align:top}
.ano th{color:var(--faint);font-weight:600;font-size:11.5px}
.ano td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.ano td.a{white-space:nowrap;color:var(--dim)}
.ano a{color:var(--accent);text-decoration:none}
.ano a:hover{text-decoration:underline}
.btools{display:flex;gap:8px;align-items:center;margin:0 0 12px;flex-wrap:wrap}
.btools>span{font-size:13px;color:var(--dim);margin-right:2px}
.h3sub{font-size:15px;font-weight:640;margin:26px 0 10px}
.pol{font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid var(--line);white-space:nowrap;font-variant-numeric:tabular-nums}
.pol.rec{color:var(--pos);border-color:color-mix(in oklab,var(--pos) 45%,var(--line))}
.pol.avoid{color:var(--warn);border-color:color-mix(in oklab,var(--warn) 45%,var(--line))}
.pol.mention{color:var(--faint)}
.bookrow{display:grid;grid-template-columns:32px minmax(0,1fr) auto 138px;gap:12px;align-items:center;
  padding:9px 22px;border-top:1px solid var(--line2)}
.bookrow:first-child{border-top:0}
.bk{display:flex;align-items:baseline;gap:8px;min-width:0}
.bk .nm{font-size:14px;font-weight:560;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bk .au{font-size:11.5px;color:var(--faint);flex:none;white-space:nowrap}
.bk .tg{font-size:11px;color:var(--faint);flex:none}
.pols{display:flex;gap:5px;align-items:center}
.lk{background:none;border:0;color:var(--accent);font-size:12px;cursor:pointer;padding:1px 2px;font-family:inherit}
.lk:hover{text-decoration:underline}
.bchips{display:flex;flex-wrap:wrap;gap:6px;margin:0 22px 10px}
.bchip{background:var(--chip);border:1px solid var(--line);border-radius:99px;padding:2px 10px;font-size:12px;
  color:var(--fg);cursor:pointer;font-family:inherit;line-height:1.7}
.bchip:hover{border-color:var(--accent-soft);color:var(--accent)}
.bchip.avoid{color:var(--warn);border-color:color-mix(in oklab,var(--warn) 35%,var(--line))}
.bchip.theme{color:var(--accent);border-color:color-mix(in oklab,var(--accent) 35%,var(--line))}
.tdesc{font-size:12.5px;color:var(--dim);padding:2px 8px 8px}
.bchip i{font-style:normal;font-size:10px;opacity:.8;margin-left:4px}
.fchip{margin:0 0 12px;font-size:13px;color:var(--dim);background:var(--chip);border:1px solid var(--line);
  border-radius:8px;padding:8px 14px}
.fchip b{color:var(--fg)}
.morewrap{text-align:center;padding:18px 0 4px}
.rk{font-size:13px;color:var(--faint);text-align:right;font-variant-numeric:tabular-nums}
.bar{display:grid;grid-template-columns:minmax(0,1fr) 40px;gap:8px;align-items:center;min-width:0}
.tr{height:8px;background:var(--line2);border-radius:99px;overflow:hidden}
.tr i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),color-mix(in oklab,var(--accent) 55%,var(--pos)));border-radius:99px}
.bar span{font-size:12px;color:var(--dim);text-align:right;font-variant-numeric:tabular-nums}
.vv{font-size:12px;color:var(--dim);text-align:right;font-variant-numeric:tabular-nums}
.bkrow{cursor:pointer}
.bkrow:hover{background:var(--hover)}
.bkrow .caret{color:var(--faint);font-size:11px}
.smp{padding:2px 22px 16px;background:var(--bg)}
.smp table{width:100%;border-collapse:collapse;font-size:12.5px}
.smp td,.smp th{padding:6px 8px;border-bottom:1px solid var(--line2);text-align:left;vertical-align:top}
.smp th{color:var(--faint);font-weight:600;font-size:11.5px}
.smp td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.smp td.a{white-space:nowrap;color:var(--dim)}
.smp a{color:var(--accent);text-decoration:none}
.smp a:hover{text-decoration:underline}
/* 工具栏 */
.toolbar{position:sticky;top:0;z-index:20;display:flex;gap:10px;flex-wrap:wrap;align-items:center;
  background:color-mix(in oklab,var(--bg) 88%,transparent);backdrop-filter:blur(10px);
  padding:12px 0;margin:0 0 14px;border-bottom:1px solid var(--line)}
.toolbar input[type=search]{flex:1;min-width:180px;background:var(--panel);border:1px solid var(--line);border-radius:8px;
  padding:8px 12px;font-size:14px;color:var(--fg);outline:none}
.toolbar input[type=search]:focus{border-color:var(--accent-soft)}
.toolbar select{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:13.5px;color:var(--fg)}
.tbtn{background:var(--chip);border:1px solid var(--line);border-radius:8px;padding:7px 12px;font-size:13px;color:var(--fg);cursor:pointer}
.tbtn:hover{border-color:var(--accent-soft);color:var(--accent)}
.tbtn.on{background:var(--accent);border-color:var(--accent);color:#fff}
.count{font-size:12.5px;color:var(--dim);margin-left:auto;font-variant-numeric:tabular-nums}
/* 回答卡 */
.ans{border-top:1px solid var(--line)}
.ans:first-child{border-top:0}
.ahd{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:12px;align-items:center;padding:16px 22px 10px}
.ahd .rk{width:26px;text-align:left;color:var(--faint);font-size:13px}
.ameta{min-width:0}
.ameta .who{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ameta .who a{color:inherit;text-decoration:none}
.ameta .who a:hover{color:var(--accent)}
.ameta .sub2{font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums}
.pill{display:inline-block;background:var(--chip);border:1px solid var(--line);border-radius:6px;
  padding:3px 9px;font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums;white-space:nowrap}
.pill b{color:var(--fg);font-weight:640}
.summary{margin:0 22px 10px;padding:10px 14px;background:color-mix(in oklab,var(--accent) 6%,var(--panel));
  border-left:3px solid var(--accent-soft);border-radius:0 8px 8px 0;font-size:14px;line-height:1.7}
.summary b{font-size:11px;color:var(--accent);font-weight:700;letter-spacing:.06em;margin-right:6px}
/* 内容性质徽章：盐选（商业状态）与小说（文体）是两个独立维度，颜色分开 */
.badge{font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid var(--line);white-space:nowrap;
  color:var(--dim);background:var(--chip);margin-right:5px;font-weight:500}
.badge.paid{color:#b45309;border-color:color-mix(in oklab,#b45309 45%,var(--line));
  background:color-mix(in oklab,#b45309 10%,var(--panel))}
.badge.fic{color:#7c3aed;border-color:color-mix(in oklab,#7c3aed 40%,var(--line));
  background:color-mix(in oklab,#7c3aed 9%,var(--panel))}
.badge.real{color:var(--pos);border-color:color-mix(in oklab,var(--pos) 35%,var(--line))}
.badge.adapted{color:var(--accent);border-color:var(--accent-soft)}
.badge.offtopic{color:var(--faint)}
@media (prefers-color-scheme:dark){
  .badge.paid{color:#fbbf24}.badge.fic{color:#c4b5fd}.badge.real{color:#2dd4bf}}
.body{padding:0 22px 16px;font-size:14.5px;line-height:1.85;white-space:pre-wrap;word-break:break-word;
  color:color-mix(in oklab,var(--fg) 92%,var(--dim))}
.body.clip{max-height:340px;overflow:hidden;position:relative;cursor:pointer}
.body.clip::after{content:"";position:absolute;inset:auto 0 0 0;height:90px;
  background:linear-gradient(transparent,var(--panel))}
.more{padding:0 22px 16px}
.more button{background:none;border:0;color:var(--accent);font-size:13px;cursor:pointer;padding:0}
mark{background:var(--mark);color:inherit;border-radius:2px;padding:0 1px}
.empty{color:var(--dim);text-align:center;padding:48px 0}
footer{margin-top:56px;padding-top:20px;border-top:1px solid var(--line);color:var(--faint);font-size:12px;line-height:1.9}
footer code{background:var(--chip);padding:1px 5px;border-radius:4px}
@media(max-width:640px){
  .bookrow{grid-template-columns:24px minmax(0,1fr) 96px;padding:9px 14px}
  .bookrow .pols{display:none}
  .ahd{padding:14px 14px 8px}.summary{margin:0 14px 10px}.bchips{margin:0 14px 10px}.body{padding:0 14px 14px}.more{padding:0 14px 14px}
  .wrap{padding:26px 12px 90px}
}
</style></head>
<body><div class="wrap">

<h1><a href="${esc(payload.url)}" target="_blank" rel="noopener">${esc(payload.question || '知乎问题')}</a></h1>
<p class="lede">知乎问题 ${esc(q.question_id || '')} 下 <b>${answers.length}</b> 条回答的汇总页 · 正文为全文 · <a href="${esc(payload.url)}" target="_blank" rel="noopener">查看原问题 ↗</a></p>
<nav class="toc">
${secs.map((s) => `  <a href="#${s.id}">${secNum.get(s.id)} ${s.label}</a>`).join('\n')}
</nav>

<div class="stats">
  <div class="st"><b>${answers.length}</b><span>抓到的回答</span></div>
  <div class="st"><b>${totalVotes.toLocaleString('en-US')}</b><span>赞数合计</span></div>
  <div class="st"><b>${totalChars.toLocaleString('en-US')}</b><span>正文总字数</span></div>
  <div class="st"><b>${fmtDate(dates[0])}<br>${fmtDate(dates[dates.length - 1])}</b><span>最早 ~ 最新</span></div>
  <div class="st"><b>${withSummary}</b><span>带 AI 摘要</span></div>
  ${payload.themes.length ? `<div class="st"><b>${payload.themes.length}</b><span>核心${T_LABEL}</span></div>` : ''}
  ${payload.books.length ? `<div class="st"><b>${payload.rankedTotal}</b><span>≥2 人推荐的书</span></div>` : ''}
</div>
<p class="sub" style="font-size:12.5px;color:var(--faint);margin:8px 0 0">
  样本口径：Panerelay 登录态通道按<b>默认排序</b>翻完全部分页，另取时间排序首屏做覆盖检查（全部命中即不再重复抓取），共 <b>${allAnswers.length}</b> 条；${platformTotal ? `平台显示 <b>${platformTotal}</b> 条，差 ${platformTotal - allAnswers.length} 条即已删除 / 已折叠的回答（它们不再出现在列表接口里）。` : '已删除 / 已折叠的回答不在列表接口返回中。'}正文取<b>全文</b>，非摘要。${nDrop ? `本页已剔除 <b>${nDrop}</b> 条（${EXCLUDE_PAID ? `盐选/严选付费 ${dropped.paid.length} 条` : ''}${EXCLUDE_PAID && EXCLUDE_ORG ? ' + ' : ''}${EXCLUDE_ORG ? `机构号/广告主 ${dropped.org.length} 条` : ''}${EXCLUDE_KIND.length ? ` + ${EXCLUDE_KIND.join('/')} ${dropped.kind.length} 条` : ''}），母题排行与全部赞数均按剔除后的 ${answers.length} 条重算。` : ''}
  ${payload.hasKind ? (FULL_JUDGED
    ? `<br>内容性质：<b>全部 ${answers.length} 条已由模型逐条判定</b>（无抽样、无外推）—— 真实经历 ${kindStats.real || 0} 条、小说创作 ${kindStats.fiction || 0} 条、改编/虚构 ${kindStats.adapted || 0} 条、与问题无关 ${kindStats.offtopic || 0} 条。虚构合计 <b>${nFicLike} 条（${(nFicLike / answers.length * 100).toFixed(1)}%）</b>。<b>「真实经历」不等于内容为真</b>——模型只判断叙述者是自述经历还是编的，无法核实事实。`
    : `<br>内容性质：<b>抽样判定 ${nJudged} 条</b>（粗筛命中全判 + 随机抽样查漏），其中小说/改编 ${nFicLike} 条。${payload.ficEstimate ? `据此外推<b>本页 ${payload.ficEstimate}</b> 条为虚构内容（约 ${(payload.ficEstimate / answers.length * 100).toFixed(1)}%）。` : ''}未判定的 ${nUnjudged} 条<b>不代表是真实经历</b>，只是没送模型 —— 建议用 <code>classify-content-llm.mjs --all</code> 全量判定后再引用本页数字。`) : ''}
  ${payload.hasKind ? `<b>盐选是商业状态、小说是文体，两者互不包含</b>：严选内容 100% 是虚构，但虚构内容里只有一小部分是严选。` : ''}
</p>

<h2 id="digest"><span class="n">${secNum.get('digest')}</span>全局综述</h2>
<p class="sub">由本地模型（${esc(summaries?.resolvedModel || summaries?.model || 'glm-5.3-flash')}）基于高赞回答生成${REVIEWED ? '，并经人工校订' : ''}，供快速了解共识，不替代原文。</p>
<div id="digest-box"></div>

${payload.themes.length ? `
<h2 id="themes"><span class="n">${secNum.get('themes')}</span>${STORY_MODE ? '故事母题排行' : '观点排行'}</h2>
<p class="sub">${REVIEWED ? '经人工复核后' : '模型读完 <b>全部回答</b> 后'}归纳出的 ${payload.themes.length} 类${T_LABEL}，按「被多少条回答${STORY_MODE ? '属于此类' : '主张'} + 赞数加权」排序。点任意一行展开${STORY_MODE ? '属于该类的故事' : '持该观点的回答'}，或点「看回答」筛出全部相关回答。</p>
<div class="btools">
  <span>排序</span>
  <button class="tbtn on" data-tsort="logSum">综合热度</button>
  <button class="tbtn" data-tsort="count">${STORY_MODE ? '故事数' : '主张人数'}</button>
  <button class="tbtn" data-tsort="votesSum">赞数和</button>
</div>
<div class="card" id="theme-list"></div>
<p class="sub" style="font-size:12.5px;color:var(--faint);margin-top:12px">
  口径：${REVIEWED
    ? '标签体系与逐条打标均经人工复核（自动打标在本页会被「顺带提到 C++」这类表述带偏），只统计有赞回答，0 赞回答不进入排行。'
    : '先取高赞回答的要点归纳出标签体系，再让模型给每条回答打 1~3 个标。'}共 ${answers.length} 条回答，其中 <b>${untagged}</b> 条被判为「${STORY_MODE ? '简短感慨/抖机灵/与问题无关' : '简短赞同/调侃/无实质观点'}」未打标，不进入排行。
  「综合热度」= Σ log10(1+该回答赞数)；「${STORY_MODE ? '故事数' : '主张人数'}」只数回答条数。同一个${T_LABEL}可能由很多低赞回答重复，也可能由少数高赞回答集中表达，两个口径结果不同，故都提供。
</p>` : ''}

${payload.books.length ? `
<h2 id="books"><span class="n">${secNum.get('books')}</span>书单排行</h2>
<p class="sub">由模型读<b>全部回答全文</b>抽取，只列<b>被 ≥2 条回答明确推荐</b>的书。点任意一行展开原文出处。</p>
${payload.anchor ? `<div class="anchor-note">问题本体 <b>《${esc(payload.anchor.title)}》</b> 不计入排行：它在 ${payload.anchor.count} 条回答里被提到（推荐 ${payload.anchor.rec} · 劝退 ${payload.anchor.avoid}），但大多是顺口一提或与其他书比较，本身不是「推荐结果」。<div id="anchor-avoid"></div></div>` : ''}
<div class="btools">
  <span>排序</span>
  <button class="tbtn on" data-bsort="recLogSum">推荐热度</button>
  <button class="tbtn" data-bsort="rec">推荐人数</button>
  <button class="tbtn" data-bsort="recVotesSum">推荐赞数和</button>
</div>
<div class="card" id="book-list"></div>
${payload.avoided.length ? `<h3 class="h3sub">被劝退 / 指出问题的书</h3><div class="card" id="avoid-list"></div>` : ''}
<p class="sub" style="font-size:12.5px;color:var(--faint);margin-top:12px">
  <b>为什么不用正则抽书名：</b>正则只认《》+ 引号 + 词典，会系统性漏掉裸书名 —— 实测漏掉了最高频的《以利为利》（14 条回答提到）《转型中的地方政府》（15 条），所以那版书单其实是「谁恰好带了书名号」的筛选结果。本页改为模型逐条读全文识别。<br>
  <b>排序口径：</b>「推荐热度」= Σ log10(1+该回答赞数)，**只累计明确推荐该书的回答**（顺带提及不算，否则被大量提及的书会挤掉真正被推荐的书）；「推荐人数」只数回答条数（忽略回答质量）；「推荐赞数和」会被单条超高赞回答拉偏。<br>
  <b>样本：</b>共抽出 ${payload.bookTotal} 个书名，其中 <b>${payload.rankedTotal}</b> 本被 ≥2 条回答明确推荐（此处展示前 ${payload.books.length} 本）；
  只被 1 条回答推荐的有 <b>${payload.singles}</b> 个，不列入排行（一次性提及不构成共识）。极性由模型判断，「推荐 / 劝退」都展示，可自行核对。每本书最多展示 12 条溯源。
</p>` : ''}

<h2 id="all"><span class="n">${secNum.get('all')}</span>全部回答</h2>
<p class="sub">共 ${answers.length} 条，但只有 <b>${richCount}</b> 条有实质内容；另外 <b>${lowCount}</b> 条是「一句话短评」（正文 &lt;80 字，赞数中位数 ${medVotes}），默认折叠。${payload.books.length ? '它们点名的书已经计入上面的书单。点书单里的书，或点回答里的书名标签，都能直接筛出相关回答。' : `点上面${T_LABEL}排行里的任意一类，或点回答里的标签，都能直接筛出相关回答。`}</p>
<div class="toolbar">
  <input type="search" id="q" placeholder="搜索正文 / 作者 / 标签…">
  <select id="sort">
    <option value="score">综合分（推荐）</option>
    <option value="votes">按赞数</option>
    <option value="date">按发布时间（新→旧）</option>
    <option value="date-asc">按发布时间（旧→新）</option>
    <option value="comments">按评论数</option>
    <option value="len">按正文字数</option>
    <option value="rank">按原列表顺序</option>
  </select>
  <button class="tbtn" id="f-sum">只看有摘要</button>
  <button class="tbtn" id="f-long">只看长文 ≥500字</button>
  ${payload.hasKind ? `<button class="tbtn" id="f-real" title="${FULL_JUDGED ? '隐藏模型判定为小说/改编的回答' : '隐藏已判定的虚构内容（未判定仍保留）'}">${payload.nFicLike ? `排除小说/改编 ${payload.nFicLike}` : '只看真实经历'}</button>` : ''}
  ${payload.hasKind && (kindStats.offtopic || 0) > 0 ? `<button class="tbtn" id="f-off" title="隐藏与问题无关的灌水/抖机灵回答">排除无关 ${kindStats.offtopic}</button>` : ''}
  ${payload.nPaidInView ? `<button class="tbtn" id="f-paid" title="只看盐选/严选付费内容">盐选/严选 ${payload.nPaidInView}</button>` : ''}
  <button class="tbtn" id="f-low">显示短评 ${lowCount}</button>
  <button class="tbtn" id="exp-all">展开全部正文</button>
  <span class="count" id="count"></span>
</div>
<details style="margin:0 0 14px;font-size:12.5px;color:var(--dim)">
  <summary style="cursor:pointer">「综合分」怎么算的？</summary>
  <p style="margin:8px 0 0;line-height:1.8">
    量化指标 70% + 内容质量 30%：<b>赞数 45%</b>、正文字数 20%、<b>评论数 15%</b>、新鲜度 10%、有 AI 摘要 10%。<br>
    赞数与评论数用 <code>log10</code> 压缩后再归一 —— 这两个指标是重尾分布
    （赞数中位数 ${medVotes}，最高 ${Math.max(...answers.map((a) => a.votes || 0)).toLocaleString('en-US')}），
    线性归一会让头两条吃满、其余全挤在 0 附近，等于没加权。<br>
    新鲜度按发布时间线性归一。想看纯赞数排名就切「按赞数」。
  </p>
</details>
<div class="fchip" id="filter-chip" hidden></div>
<div class="card" id="ans-list"></div>
<div class="morewrap" id="ans-more" hidden></div>
<div class="empty" id="empty" hidden>没有匹配的回答，换个关键词试试。</div>

<footer>
  数据来源：知乎问题 <a href="${esc(payload.url)}" target="_blank" rel="noopener">${esc(q.question_id || '')}</a> ·
  经本机 Edge 登录态通道（Panerelay）抓取，正文为全文。<br>
  生成流程：<code>fetch-answers-api.mjs</code> 分页抓全量全文 → ${payload.books.length ? '<code>extract-books-llm.mjs</code> 读全文抽书单 → ' : ''}<code>extract-themes-llm.mjs</code> 归纳${T_LABEL}并逐条打标 →
  <code>summarize-answers.mjs</code> 生成摘要与综述 → <code>render-answers.mjs</code> 渲染本页。<br>
  本页为静态快照，抓取时间 ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC。
</footer>
</div>

<script id="data" type="application/json">${jsonForScript(payload)}</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt = (n) => (n || 0).toLocaleString('en-US');
const cmap = new Map(D.answers.map((a) => [a.id, a.content]));
const snipOf = (id, title) => {
  const c = cmap.get(id); if (!c) return '';
  let i = c.indexOf(title);
  if (i < 0) i = c.indexOf('《' + title + '》');
  if (i < 0) return '';
  return (i > 40 ? '…' : '') + c.slice(Math.max(0, i - 40), i + title.length + 80).replace(/\s+/g, ' ') + '…';
};

// ---- 综述 ----
(function(){
  const box = document.getElementById('digest-box');
  const d = D.digest;
  if (!d) { box.innerHTML = '<div class="card pad" style="color:var(--dim)">未生成综述（摘要文件缺失）。</div>'; return; }
  const li = (arr, cls) => (arr || []).map((x) => '<li>' + esc(x) + '</li>').join('');
  // 标题可由摘要脚本按题型覆盖（labels），没给就用默认的读书题口径
  const L = Object.keys(d.labels || {}).length ? d.labels : (D.digestLabels || {});
  box.innerHTML = '<div class="card digest pad">'
    + (d.overview ? '<p class="overview">' + esc(d.overview) + '</p>' : '')
    + '<div class="dcols">'
    + '<div class="dbox cons"><h4>' + esc(L.consensus || '共识要点') + '</h4><ol>' + li(d.consensus) + '</ol></div>'
    + '<div class="dbox warn"><h4>' + esc(L.disputes || '分歧 / 注意') + '</h4><ul>' + li(d.disputes) + '</ul></div>'
    + '</div>'
    + (d.readingPath && d.readingPath.length ? '<div class="dbox" style="margin-top:20px"><h4>' + esc(L.readingPath || '入门阅读顺序建议') + '</h4><ol>' + li(d.readingPath) + '</ol></div>' : '')
    + '</div>';
})();

// ---- 观点排行 ----
(function(){
  const list = document.getElementById('theme-list');
  if (!list || !D.themes.length) return;
  let sortKey = 'logSum';
  const metricText = (t) => sortKey === 'logSum' ? t.logSum.toFixed(1) : fmt(t[sortKey]);
  function renderThemes() {
    const rows = [...D.themes].sort((a, b) => b[sortKey] - a[sortKey]);
    const max = Math.max(1, ...rows.map((t) => t[sortKey]));
    list.innerHTML = rows.map((t, i) => {
      const w = (t[sortKey] / max * 100).toFixed(1);
      const smp = t.samples.map((s) => '<tr>'
        + '<td class="n"><b>' + fmt(s.votes) + '</b></td>'
        + '<td class="n">' + esc(s.date || '—') + '</td>'
        + '<td class="a">' + esc(s.author || '') + '</td>'
        + '<td><a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.summary || '查看原文') + '</a></td>'
        + '</tr>').join('');
      return '<div class="bkrow bookrow">'
        + '<div class="rk">' + (i + 1) + '</div>'
        + '<div class="bk"><span class="nm">' + esc(t.name) + '</span><span class="caret">▸</span></div>'
        + '<div class="pols"><span class="pol rec">' + t.count + ' 条' + D.themeUnit + '</span>'
        + '<button class="lk" data-theme-filter="' + esc(t.name) + '">看回答</button></div>'
        + '<div class="bar" title="' + ({ logSum: '综合热度', count: D.themeCountLabel, votesSum: '赞数和' }[sortKey]) + '"><div class="tr"><i style="width:' + w + '%"></i></div><span>' + metricText(t) + '</span></div>'
        + '</div>'
        + '<div class="smp" hidden><div class="tdesc">' + esc(t.desc) + '</div>'
        + '<table><thead><tr><th>赞</th><th>发布</th><th>作者</th><th>要点</th></tr></thead><tbody>' + smp + '</tbody></table></div>';
    }).join('');
  }
  renderThemes();
  document.querySelectorAll('[data-tsort]').forEach((btn) => btn.addEventListener('click', () => {
    sortKey = btn.dataset.tsort;
    document.querySelectorAll('[data-tsort]').forEach((x) => x.classList.toggle('on', x === btn));
    renderThemes();
  }));
  list.addEventListener('click', (e) => {
    const f = e.target.closest('[data-theme-filter]');
    if (f) { window.__filter('theme', f.dataset.themeFilter); return; }
    const row = e.target.closest('.bkrow'); if (!row) return;
    const smp = row.nextElementSibling;
    smp.hidden = !smp.hidden;
    row.querySelector('.caret').textContent = smp.hidden ? '▸' : '▾';
  });
})();

// ---- 书单 ----
(function(){
  const list = document.getElementById('book-list');
  if (!list || !D.books.length) return;
  const snip = snipOf;
  const POL = { rec: '推荐', avoid: '劝退', mention: '提及' };
  let sortKey = 'recLogSum';
  const FLOAT = new Set(['logSum', 'recLogSum']);
  const metricText = (b) => FLOAT.has(sortKey) ? (b[sortKey] ?? 0).toFixed(1) : fmt(b[sortKey]);
  function rowHTML(b, i, list) {
    const max = Math.max(1, ...list.map((x) => x[sortKey]));
    const w = (b[sortKey] / max * 100).toFixed(1);
    const smp = b.samples.map((s) => '<tr>'
      + '<td class="n">' + (s.votes != null ? '<b>' + fmt(s.votes) + '</b>' : '—') + '</td>'
      + '<td class="n">' + (s.comments ?? '—') + '</td>'
      + '<td class="n">' + esc(s.date || '—') + '</td>'
      + '<td class="a">' + esc(s.author || '') + '</td>'
      + '<td class="n"><span class="pol ' + s.polarity + '">' + (POL[s.polarity] || s.polarity) + '</span></td>'
      + '<td><a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(snip(s.answerId, b.title) || '查看原文') + '</a></td>'
      + '</tr>').join('');
    return '<div class="bkrow bookrow">'
      + '<div class="rk">' + (i + 1) + '</div>'
      + '<div class="bk"><span class="nm">' + esc(b.title) + '</span>'
      + (b.author ? '<span class="au">' + esc(b.author) + '</span>' : '')
      + '<span class="caret">▸</span></div>'
      + '<div class="pols"><span class="pol rec">推荐 ' + b.rec + '</span>'
      + (b.avoid ? '<span class="pol avoid">劝退 ' + b.avoid + '</span>' : '')
      + '<button class="lk" data-book-filter="' + esc(b.title) + '" title="筛出推荐这本书的回答">看回答</button></div>'
      + '<div class="bar" title="' + ({ recLogSum: '推荐热度', rec: '推荐人数', recVotesSum: '推荐赞数和' }[sortKey]) + '"><div class="tr"><i style="width:' + w + '%"></i></div><span>' + metricText(b) + '</span></div>'
      + '</div>'
      + '<div class="smp" hidden><table><thead><tr><th>赞</th><th>评论</th><th>发布</th><th>作者</th><th>态度</th><th>原文上下文</th></tr></thead><tbody>' + smp + '</tbody></table></div>';
  }
  function renderBooks() {
    const rows = [...D.books].sort((a, b) => b[sortKey] - a[sortKey]);
    list.innerHTML = rows.map((b, i) => rowHTML(b, i, rows)).join('');
  }
  renderBooks();
  document.querySelectorAll('[data-bsort]').forEach((btn) => btn.addEventListener('click', () => {
    sortKey = btn.dataset.bsort;
    document.querySelectorAll('[data-bsort]').forEach((x) => x.classList.toggle('on', x === btn));
    renderBooks();
  }));
  list.addEventListener('click', (e) => {
    const f = e.target.closest('[data-book-filter]');
    if (f) { window.__filter('book', f.dataset.bookFilter); return; }
    const row = e.target.closest('.bkrow'); if (!row) return;
    const smp = row.nextElementSibling;
    smp.hidden = !smp.hidden;
    row.querySelector('.caret').textContent = smp.hidden ? '▸' : '▾';
  });

  // 被劝退的书
  const al = document.getElementById('avoid-list');
  if (al && D.avoided.length) {
    const saved = sortKey; sortKey = 'avoid';
    al.innerHTML = D.avoided.map((b, i) => {
      const max = Math.max(1, ...D.avoided.map((x) => x.avoid));
      const w = (b.avoid / max * 100).toFixed(1);
      const smp = b.samples.filter((s) => s.polarity === 'avoid').map((s) => '<tr>'
        + '<td class="n"><b>' + fmt(s.votes) + '</b></td>'
        + '<td class="a">' + esc(s.author || '') + '</td>'
        + '<td><a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(snip(s.answerId, b.title) || '查看原文') + '</a></td>'
        + '</tr>').join('');
      return '<div class="bkrow bookrow">'
        + '<div class="rk">' + (i + 1) + '</div>'
        + '<div class="bk"><span class="nm">' + esc(b.title) + '</span><span class="caret">▸</span></div>'
        + '<div class="pols"><span class="pol avoid">劝退 ' + b.avoid + '</span><span class="pol rec">推荐 ' + b.rec + '</span></div>'
        + '<div class="bar" title="被劝退的回答数"><div class="tr"><i style="width:' + w + '%"></i></div><span>' + b.avoid + '</span></div>'
        + '</div>'
        + '<div class="smp" hidden><table><thead><tr><th>赞</th><th>作者</th><th>原文上下文</th></tr></thead><tbody>' + smp + '</tbody></table></div>';
    }).join('');
    sortKey = saved;
    al.addEventListener('click', (e) => {
      const row = e.target.closest('.bkrow'); if (!row) return;
      const smp = row.nextElementSibling;
      smp.hidden = !smp.hidden;
      row.querySelector('.caret').textContent = smp.hidden ? '▸' : '▾';
    });
  }
})();

// ---- 问题本体的争议原文 ----
(function(){
  const box = document.getElementById('anchor-avoid');
  if (!box || !D.anchorAvoid || !D.anchorAvoid.length) return;
  const rows = D.anchorAvoid.map((s) => '<tr>'
    + '<td class="n"><b>' + fmt(s.votes) + '</b></td>'
    + '<td class="n">' + esc(s.date || '—') + '</td>'
    + '<td class="a">' + esc(s.author || '') + '</td>'
    + '<td><a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(snipOf(s.answerId, D.anchor.title) || '查看原文') + '</a></td>'
    + '</tr>').join('');
  box.innerHTML = '<details class="ano"><summary>展开 ' + D.anchorAvoid.length + ' 条「劝退 / 批评」的原文</summary>'
    + '<table><thead><tr><th>赞</th><th>发布</th><th>作者</th><th>原文上下文</th></tr></thead><tbody>' + rows + '</tbody></table></details>';
})();

// ---- 回答列表 ----
const listEl = document.getElementById('ans-list');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');
const qEl = document.getElementById('q');
const sortEl = document.getElementById('sort');
let expandedAll = false, filterSum = false, filterLong = false, showLow = false, filterReal = false, filterPaid = false, filterOff = false;
let filter = null;   // { type: 'theme' | 'book', value: string }
const BODY_HIDE = 160;
const chipEl = document.getElementById('filter-chip');
const moreEl = document.getElementById('ans-more');
const PAGE = 120;              // 分段渲染：一次只铺这么多条，避免 3000+ 卡片把浏览器拖死
let shown = PAGE;
const expanded = new Set();

function hl(text, term) {
  const t = esc(text);
  if (!term) return t;
  const re = new RegExp('(' + term.replace(/[.*+?^\\\${}()|[\\]\\\\]/g, '\\\\$&') + ')', 'gi');
  return t.replace(re, '<mark>$1</mark>');
}

function cardHTML(a, i, term) {
  const open = expandedAll || expanded.has(a.id);
  const hideBody = !open && a.len > BODY_HIDE;
  const badges = [
    a.paid ? '<span class="badge paid" title="知乎盐选/严选付费内容，赞数被推荐位加权">盐选/严选</span>' : '',
    a.kind === 'fiction' ? '<span class="badge fic" title="模型判定为虚构小说创作">小说</span>' : '',
    a.kind === 'adapted' ? '<span class="badge adapted" title="模型判定为改编或虚构">改编/虚构</span>' : '',
    a.kind === 'real' ? '<span class="badge real" title="模型判定为作者亲身经历">真实经历</span>' : '',
    a.org && !a.paid ? '<span class="badge" title="机构号或广告主账号">机构号</span>' : '',
  ].join('');
  const tchips = (a.themes || []).map((t) =>
    '<button class="bchip theme" data-theme="' + esc(t) + '" title="筛出属于这一类的回答">' + esc(t) + '</button>').join('');
  const chips = (a.books || []).map((b) =>
    '<button class="bchip ' + b.polarity + '" data-book="' + esc(b.title) + '" title="筛出推荐这本书的回答">'
    + esc(b.title) + (b.polarity === 'avoid' ? '<i>劝退</i>' : '') + '</button>').join('');
  return '<div class="ans">'
    + '<div class="ahd">'
    + '<div class="rk">' + (i + 1) + '</div>'
    + '<div class="ameta"><div class="who"><a href="' + esc(a.url) + '" target="_blank" rel="noopener">' + esc(a.author || '匿名用户') + '</a></div>'
    + '<div class="sub2">' + esc(a.date) + ' · ' + fmt(a.len) + ' 字' + (badges ? ' · ' + badges : '') + '</div></div>'
    + '<div><span class="pill">▲ <b>' + fmt(a.votes) + '</b></span> <span class="pill">💬 ' + fmt(a.comments) + '</span></div>'
    + '</div>'
    + (a.summary ? '<div class="summary"><b>AI 摘要</b>' + hl(a.summary, term) + '</div>' : '')
    + (tchips ? '<div class="bchips">' + tchips + '</div>' : '')
    + (chips ? '<div class="bchips">' + chips + '</div>' : '')
    + '<div class="body" data-id="' + a.id + '"' + (hideBody ? ' hidden' : '') + '>' + hl(a.content, term) + '</div>'
    + (a.len > BODY_HIDE ? '<div class="more"><button data-toggle="' + a.id + '">' + (hideBody ? '展开正文（' + fmt(a.len) + ' 字）' : '收起正文') + '</button></div>' : '')
    + '</div>';
}

// ---- 综合分 ----
// 需求：量化指标占 70% 权重，内容质量占 30%。
// 为什么不用线性：赞数和评论数都是重尾分布（中位数 0，最高 49070），
// 线性归一会让头两条吃满、其余全部挤在 0 附近，等于没加权。所以用 log10 压缩。
// 新鲜度用线性（日期分布均匀，压缩反而失真）。
const SCORE_W = {
  votes: 0.45,     // 赞数      —— 最直接的质量信号
  comments: 0.15,  // 评论数    —— 互动深度（赞可以顺手，评论不能）
  fresh: 0.10,     // 新鲜度    —— 避免老回答永久霸榜
  len: 0.20,       // 正文字数  —— 内容量的代理指标
  summary: 0.10,   // 有 AI 摘要 —— 说明有实质内容（短评不会被摘要）
};
function scoreOf(a) {
  const B = D.scoreBounds || {};
  const lv = Math.log10(1 + (a.votes || 0)) / (B.logVotes || 1);
  const lc = Math.log10(1 + (a.comments || 0)) / (B.logComments || 1);
  const ll = Math.log10(1 + (a.len || 0)) / (B.logLen || 1);
  const days = a.date ? (Date.parse(a.date) - B.minDate) / 86400000 : 0;
  const fr = B.daySpan ? Math.max(0, Math.min(1, days / B.daySpan)) : 0;
  const hasSum = a.summary ? 1 : 0;
  return SCORE_W.votes * lv + SCORE_W.comments * lc + SCORE_W.fresh * fr
    + SCORE_W.len * ll + SCORE_W.summary * hasSum;
}

function render(reset) {
  if (reset !== false) shown = PAGE;
  const term = qEl.value.trim();
  const lt = term.toLowerCase();
  let rows = D.answers.map((a, i) => ({ ...a, rank: i + 1 }));
  if (!showLow) rows = rows.filter((a) => !a.lowInfo);
  if (filterSum) rows = rows.filter((a) => a.summary);
  if (filterLong) rows = rows.filter((a) => a.len >= 500);
  // 内容性质筛选：三者独立叠加。「排除小说」不碰未判定条目 —— 未判定不是「真实」。
  if (filterReal) rows = rows.filter((a) => a.kind !== 'fiction' && a.kind !== 'adapted');
  if (filterOff) rows = rows.filter((a) => a.kind !== 'offtopic');
  if (filterPaid) rows = rows.filter((a) => a.paid);
  if (filter?.type === 'book') rows = rows.filter((a) => (a.books || []).some((b) => b.title === filter.value));
  if (filter?.type === 'theme') rows = rows.filter((a) => (a.themes || []).includes(filter.value));
  if (term) rows = rows.filter((a) =>
    a.content.toLowerCase().includes(lt) || a.author.toLowerCase().includes(lt) ||
    (a.summary || '').toLowerCase().includes(lt) ||
    (a.books || []).some((b) => b.title.toLowerCase().includes(lt)) ||
    (a.themes || []).some((t) => t.toLowerCase().includes(lt)) ||
    (D.kindLabel[a.kind] || '').toLowerCase().includes(lt) ||
    ((a.paid ? '盐选 严选 paid' : '') + (a.org ? ' 机构号 organization' : '')).includes(lt));
  const s = sortEl.value;
  if (s === 'score') rows.sort((a, b) => scoreOf(b) - scoreOf(a));
  else if (s === 'votes') rows.sort((a, b) => b.votes - a.votes);
  else if (s === 'date') rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  else if (s === 'date-asc') rows.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  else if (s === 'comments') rows.sort((a, b) => b.comments - a.comments);
  else if (s === 'len') rows.sort((a, b) => b.len - a.len);

  chipEl.hidden = !filter;
  if (filter) chipEl.innerHTML = '正在看：'
    + (filter.type === 'theme' ? (D.storyMode ? '属于 ' : '主张 ') + '<b>「' + esc(filter.value) + '」</b>' : '推荐 <b>《' + esc(filter.value) + '》</b>')
    + ' 的回答 · ' + rows.length + ' 条 <button class="lk" id="chip-clear">清除 ✕</button>';
  countEl.textContent = '显示 ' + Math.min(shown, rows.length) + ' / ' + rows.length + ' 条（总 ' + D.answers.length + '）';
  emptyEl.hidden = rows.length > 0;
  listEl.innerHTML = rows.slice(0, shown).map((a, i) => cardHTML(a, i, term)).join('');
  moreEl.hidden = rows.length <= shown;
  if (!moreEl.hidden) moreEl.innerHTML = '<button class="tbtn" id="more-btn">显示更多（还有 ' + (rows.length - shown) + ' 条）</button>';
}
listEl.addEventListener('click', (e) => {
  const tchip = e.target.closest('[data-theme]');
  if (tchip) { filter = { type: 'theme', value: tchip.dataset.theme }; expanded.clear(); render(); document.getElementById('all').scrollIntoView(); return; }
  const chip = e.target.closest('[data-book]');
  if (chip) { filter = { type: 'book', value: chip.dataset.book }; expanded.clear(); render(); document.getElementById('all').scrollIntoView(); return; }
  const b = e.target.closest('[data-toggle]');
  if (b) { const id = b.dataset.toggle; expanded.has(id) ? expanded.delete(id) : expanded.add(id); render(); return; }
});
chipEl.addEventListener('click', (e) => { if (e.target.closest('#chip-clear')) { filter = null; render(); } });
moreEl.addEventListener('click', (e) => { if (e.target.closest('#more-btn')) { shown += PAGE; render(false); } });
let t;
qEl.addEventListener('input', () => { clearTimeout(t); t = setTimeout(render, 120); });
sortEl.addEventListener('change', render);
const bind = (id, get, set) => { const el = document.getElementById(id); if (!el) return; el.addEventListener('click', () => { set(!get()); el.classList.toggle('on', get()); render(); }); };
bind('f-sum', () => filterSum, (v) => filterSum = v);
bind('f-long', () => filterLong, (v) => filterLong = v);
bind('f-low', () => showLow, (v) => showLow = v);
bind('f-real', () => filterReal, (v) => filterReal = v);
bind('f-off', () => filterOff, (v) => filterOff = v);
bind('f-paid', () => filterPaid, (v) => filterPaid = v);
document.getElementById('exp-all').addEventListener('click', (e) => {
  expandedAll = !expandedAll;
  e.target.classList.toggle('on', expandedAll);
  e.target.textContent = expandedAll ? '收起全部正文' : '展开全部正文';
  render();
});
render();

// 供观点/书单区调用：按观点或按书筛选回答
window.__filter = (type, value) => {
  filter = { type, value }; expanded.clear(); render();
  document.getElementById('all').scrollIntoView();
};
</script>
</body></html>`;

fs.writeFileSync(OUT, html, 'utf8');
console.log(`已写入 ${OUT}`);
console.log(`  回答 ${answers.length} 条 · 摘要 ${withSummary} 条 · 书名 ${payload.bookTotal} 个 · 综述 ${digest ? '有' : '无'}`);
console.log(`  文件大小 ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
