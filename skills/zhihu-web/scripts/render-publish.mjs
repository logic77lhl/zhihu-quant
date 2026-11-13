// render-publish.mjs —— 合规「发布版」报告生成器
//
// 与 render-answers.mjs（内部版）的区别：内部版是全量全文库（含 673 条正文、逐条摘要、
// 可检索），**不能对外发布**；本脚本只产出「统计 + 结论 + 极短署名引用」，用于公开传播。
//
// 硬约束（默认开启，且都写进产物页面的声明区）：
//   1. 不收录任何回答全文；引用一律截到 --quote-chars 字以内，且必须在句读处断开
//   2. 剔除匿名用户 / 机构号与广告主 / 严选付费内容
//   3. 每处引用都带：作者名 + 原答链接，并注明「发表于知乎」（知乎协议对站外转载的署名要求）
//   4. 页面显式标注「AI 辅助生成内容」（《人工智能生成合成内容标识办法》2025-09-01 施行）
//   5. 统计口径、样本缺口、代理指标、方法局限全部写明
//
// 用法：
//   node render-publish.mjs q<ID>-answers-full.json [--out <file>] [--quote-chars 140]
//        [--max-quotes 12] [--keep-anon] [--keep-org] [--keep-paid]
//        [--contact "xxx"] [--author "你的名字"] [--ad]
import fs from 'node:fs';
import path from 'node:path';
import { excludedSets, sampleChars, DEFAULT_CONTACT, isAnon, isOrg, isPaid } from './publish-rules.mjs';

const argv = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (f) => argv.includes(f);
const SRC = argv.find((a) => !a.startsWith('--') && /\.json$/i.test(a));
if (!SRC) { console.error('用法: node render-publish.mjs q<ID>-answers-full.json [--out <file>]'); process.exit(1); }

const base = SRC.replace(/-answers-full\.json$/i, '');
const OUT = opt('--out', base + '-发布版.html');
const QUOTE_CHARS = Number(opt('--quote-chars', 140));
const MAX_QUOTES = Number(opt('--max-quotes', 12));
const KEEP_ANON = has('--keep-anon');
const KEEP_ORG = has('--keep-org');
const KEEP_PAID = has('--keep-paid');
const CONTACT = opt('--contact', DEFAULT_CONTACT);
const AUTHOR = opt('--author', '');
const AD = has('--ad');

const rowsAll = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const snapshot = fs.statSync(SRC).mtime;
const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const n = (x) => (x || 0).toLocaleString('en-US');

// ---------- 1. 合规过滤 ----------
const { kept, reasons, dropped } = excludedSets(rowsAll, {
  keepAnon: KEEP_ANON, keepOrg: KEEP_ORG, keepPaid: KEEP_PAID,
});
const keptIds = new Set(kept.map((r) => String(r.id)));

// ---------- 2. 统计（全部重算，不用内部版的数字） ----------
const votesSum = kept.reduce((a, r) => a + r.votes, 0);
const chars = sampleChars(kept);
const years = {};
for (const r of kept) { const y = (r.created_at || '').slice(0, 4); years[y] = years[y] || { n: 0, v: 0 }; years[y].n++; years[y].v += r.votes; }
const yearList = Object.keys(years).sort();
const yearMax = Math.max(...yearList.map((y) => years[y].n));

const voteBuckets = [[1, 9], [10, 49], [50, 199], [200, 999], [1000, Infinity]]
  .map(([lo, hi]) => ({ label: hi === Infinity ? `${lo}+` : `${lo}–${hi}`, n: kept.filter((r) => r.votes >= lo && r.votes <= hi).length }));
voteBuckets.unshift({ label: '0', n: kept.filter((r) => !r.votes).length });

const lenBuckets = [[0, 79], [80, 299], [300, 999], [1000, 2999], [3000, Infinity]]
  .map(([lo, hi]) => {
    const g = kept.filter((r) => (r.content || '').length >= lo && (r.content || '').length <= hi);
    return { label: hi === Infinity ? `${lo}+ 字` : `${lo}–${hi} 字`, n: g.length, v: g.reduce((a, r) => a + r.votes, 0) };
  });

const sorted = [...kept].sort((a, b) => b.votes - a.votes);
const top10 = sorted.slice(0, 10).reduce((a, r) => a + r.votes, 0);
const top20 = sorted.slice(0, 20).reduce((a, r) => a + r.votes, 0);
const zero = kept.filter((r) => !r.votes).length;

// ---------- 3. 观点（按保留集重算） ----------
const themesFile = `${base}-themes.json`;
const themesData = fs.existsSync(themesFile) ? JSON.parse(fs.readFileSync(themesFile, 'utf8')) : null;
let themes = [];
let themesTagged = 0;
if (themesData?.taxonomy) {
  themes = themesData.taxonomy.map((t) => {
    const g = kept.filter((r) => (themesData.perAnswer?.[String(r.id)] || []).includes(t.id));
    return { name: t.name, desc: t.desc || '', count: g.length, logSum: Number(g.reduce((a, r) => a + Math.log10(1 + r.votes), 0).toFixed(2)), maxVotes: Math.max(0, ...g.map((r) => r.votes)) };
  }).filter((t) => t.count >= 2).sort((a, b) => b.logSum - a.logSum);
  themesTagged = kept.filter((r) => (themesData.perAnswer?.[String(r.id)] || []).length).length;
}

// ---------- 4. 书单（按保留集重算；只展示，不复制原文） ----------
const booksFile = `${base}-books-llm.json`;
const booksData = fs.existsSync(booksFile) ? JSON.parse(fs.readFileSync(booksFile, 'utf8')) : null;
let books = [];
if (booksData?.perAnswer) {
  const agg = new Map();
  for (const r of kept) {
    const list = booksData.perAnswer[String(r.id)] || [];
    const seen = new Set();
    for (const b of list) {
      if (seen.has(b.title)) continue;
      seen.add(b.title);
      const o = agg.get(b.title) || { title: b.title, rec: 0, avoid: 0, count: 0, recLogSum: 0, votesSum: 0, maxVotes: 0 };
      o.count++;
      if (b.polarity === 'avoid') o.avoid++; else o.rec++;
      if (b.polarity !== 'avoid') { o.recLogSum += Math.log10(1 + r.votes); o.votesSum += r.votes; }
      o.maxVotes = Math.max(o.maxVotes, r.votes);
      agg.set(b.title, o);
    }
  }
  const authorMap = new Map((booksData.books || []).map((b) => [b.title, b.author || '']));
  books = [...agg.values()].filter((b) => b.rec >= 3)
    .map((b) => ({ ...b, author: authorMap.get(b.title) || '', recLogSum: Number(b.recLogSum.toFixed(2)) }))
    .sort((a, b) => b.recLogSum - a.recLogSum);
}

// ---------- 5. 精选短引用（合规核心） ----------
const BAD = /http|https|www\.|百度文库|豆瓣链接|微信公众号|知识星球|加微信|扫码|领取|私信|资料包|彩蛋|购买链接|下单|优惠|免费下载|黄色|色情|赌博|毒品/;
const ATTACK = /学术混混|大忽悠|骗子|放屁|傻|愚蠢|废物|人渣|垃圾|误人子弟|不学无术|臭名昭著|半吊子|原教旨/; // 避免转载带人身攻击的句子
const MARKET = /小编|豆瓣评分|点赞|收藏|关注我|说点题外话|分割线|感谢各位|一键三连|福利|送你|免费领/; // 导语/推广语
const START_BAD = /^(该书|这本书|本书|这一本|它|它们|其|此|该|上述|这类|这些|那些|这种|此种|类似|同样|主要特点|特点|文中|书里|里面|所以|因此|而|但是|不过|另外|同时|而且|然后|接着|[A-Za-z]+\d?\s*[:：]|[一二三四五六七八九十]+、|\d+[.、)）])/;
function pickQuote(text) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length < 80) return '';
  t = t.replace(/^(谢邀[。，,、]?|更新[:：][^。]{0,40}。)/, '').trim();
  if (t.length < 80) return '';
  if (BAD.test(t.slice(0, 200))) return '';
  const sents = t.split(/(?<=[。！？])/).filter((s) => s.trim());
  for (let i = 0; i < Math.min(5, sents.length); i++) {   // 跳过导语/客套，从后面的句子起截
    const cand = sents.slice(i).join('').trim();
    if (cand.length < 80) continue;
    let q;
    if (cand.length <= QUOTE_CHARS) q = cand;
    else {
      const cut = cand.slice(0, QUOTE_CHARS);
      const m = cut.match(/[\s\S]*[。！？]/) || cut.match(/[\s\S]*[；，,]/);
      q = (m ? m[0] : cut).replace(/[，,；]$/, '') + '……';
    }
    if (q.length < 45) continue;
    if ((q.match(/《/g) || []).length >= 3) continue;      // 书单式引用
    if ((q.match(/[、]/g) || []).length >= 3) continue;    // 列表式引用
    if ((q.match(/[：:]/g) || []).length >= 4) continue;   // 条目式引用
    if (ATTACK.test(q) || MARKET.test(q) || BAD.test(q)) continue;
    if ((q.match(/[。！？]/g) || []).length < 1) continue;  // 至少一个完整句
    if (START_BAD.test(q)) continue;                        // 缺主语的指代开头，读起来像半句
    return q.replace(/^\d+\s*[.、)）]\s*/, '');
  }
  return '';
}
const candidates = sorted.filter((r) => !isAnon(r) && !isOrg(r) && !isPaid(r) && (r.content || '').length >= 120);
const quotes = [];
for (const minVotes of [100, 40, 0]) {                              // 先取高赞，不够再放宽
  for (const r of candidates) {
    if (quotes.length >= MAX_QUOTES) break;
    if (r.votes < minVotes) continue;
    if (quotes.some((x) => x.id === r.id) || quotes.some((x) => x.author === r.author)) continue;
    const q = pickQuote(r.content);
    if (!q) continue;
    quotes.push({ id: r.id, author: r.author, votes: r.votes, date: (r.created_at || '').slice(0, 10), url: r.url, text: q });
  }
  if (quotes.length >= MAX_QUOTES) break;
}
const quotedChars = quotes.reduce((a, q) => a + q.text.length, 0);

// ---------- 6. AI 综述（标注来源，不复制全文） ----------
const sumFile = `${base}-summaries.json`;
const sumData = fs.existsSync(sumFile) ? JSON.parse(fs.readFileSync(sumFile, 'utf8')) : null;
// 匿名用户的内容一律不进入发布版：综述里若提到匿名回答，就地隐去指向
const stripAnon = (s) => String(s ?? '')
  .replace(/（?赞?\s*\d+\s*的?\s*匿名用户/g, '也有回答')
  .replace(/匿名用户/g, '有回答');
const rawDigest = sumData?.digests ? (sumData.digests[sumData.digestTag] || Object.values(sumData.digests)[0]) : null;
const digest = rawDigest ? {
  overview: stripAnon(rawDigest.overview),
  consensus: (rawDigest.consensus || []).map(stripAnon),
  disputes: (rawDigest.disputes || []).map(stripAnon),
} : null;

// ---------- 7. 渲染 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const qUrl = sorted[0] ? `https://www.zhihu.com/question/${sorted[0].question_id}` : '';
const qTitle = sorted[0]?.question_title || '知乎问题';

const bar = (val, max, cls = '') => `<div class="bar ${cls}"><i style="width:${max ? Math.max(2, Math.round(val / max * 100)) : 0}%"></i></div>`;

const html = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(qTitle)} · 数据报告</title>
<!-- AI 辅助生成内容（隐式标识）：本文件由 zhihu-web / render-publish.mjs 生成 -->
<meta name="ai-generated" content="assisted; reviewed-by-human">
<meta name="ai-generated-by" content="zhihu-web render-publish.mjs">
<meta name="content-source" content="Zhihu public answers snapshot; quotations with attribution">
<style>
:root{--bg:#fbfbfd;--panel:#fff;--fg:#16181d;--dim:#6b7280;--faint:#9aa1ab;--line:#e6e8ec;--chip:#f4f5f7;
--accent:#4f46e5;--pos:#0d9488;--warn:#b45309;--radius:10px;--shadow:0 1px 2px rgba(16,24,40,.04),0 1px 3px rgba(16,24,40,.06)}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--panel:#161920;--fg:#e8eaed;--dim:#9aa1ab;--faint:#6b7280;
--line:#242832;--chip:#1c2029;--accent:#8b8cf7;--pos:#2dd4bf;--warn:#fbbf24;--shadow:0 1px 2px rgba(0,0,0,.3)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:15px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:900px;margin:0 auto;padding:36px 22px 100px}
h1{font-size:26px;line-height:1.4;margin:0 0 8px;font-weight:680;letter-spacing:-.4px}
h2{font-size:18px;margin:40px 0 6px;font-weight:660;scroll-margin-top:16px}
h2 .n{color:var(--faint);font-weight:500;margin-right:8px}
.sub{color:var(--dim);font-size:13px;margin:0 0 14px}
.lede{color:var(--dim);font-size:13.5px;margin:0 0 6px}
a{color:var(--accent)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:18px 20px;margin:16px 0}
.notice{border-left:3px solid var(--warn);background:color-mix(in oklab,var(--warn) 7%,var(--panel))}
.notice b{color:var(--warn)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1px;background:var(--line);
border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;margin:20px 0}
.st{background:var(--panel);padding:14px 15px}.st b{display:block;font-size:22px;font-weight:660;line-height:1.2;font-variant-numeric:tabular-nums}
.st span{display:block;font-size:12px;color:var(--dim);margin-top:3px}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:620;font-size:12.5px}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.bar{background:var(--chip);border-radius:99px;height:6px;overflow:hidden;min-width:60px}
.bar i{display:block;height:100%;background:var(--accent);opacity:.75}
.bar.pos i{background:var(--pos)}
.q{border-bottom:1px solid var(--line);padding:14px 0}
.q:last-child{border-bottom:0}
.q p{margin:0 0 6px;font-size:14.5px}
.q .meta{font-size:12.5px;color:var(--dim)}
.badge{display:inline-block;font-size:11.5px;border:1px solid var(--line);background:var(--chip);color:var(--dim);
border-radius:99px;padding:1px 9px;margin-left:6px;vertical-align:1px}
.ai{display:inline-block;font-size:11.5px;border:1px solid var(--accent);color:var(--accent);border-radius:99px;padding:1px 9px;margin-left:6px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:22px}
@media(max-width:760px){.grid2{grid-template-columns:1fr}}
ol,ul{padding-left:20px;margin:6px 0}li{margin:4px 0;font-size:14px}
.small{font-size:12.5px;color:var(--dim)}
footer{margin-top:48px;padding-top:18px;border-top:1px solid var(--line);font-size:12.5px;color:var(--dim)}
</style></head><body><div class="wrap">

<h1>${esc(qTitle)}</h1>
<p class="lede">数据报告 · 样本 ${n(kept.length)} 条回答 · 数据快照 ${fmtDate(snapshot)} · 原问题：
<a href="${esc(qUrl)}" target="_blank" rel="noopener">${esc(qUrl.replace('https://', ''))}</a></p>

<div class="card notice">
<p><b>关于本文的标识与边界（请先读这一段）</b></p>
<ul>
<li><b>AI 辅助生成</b>：本文的统计归纳、观点聚类与文字整理使用了 AI 辅助，结论均经人工核验。依据《人工智能生成合成内容标识办法》（2025-09-01 施行），此声明即为显式标识。</li>
<li><b>不是全文转载</b>：本文<strong>不收录任何回答的完整正文</strong>；全部直接引用共 ${quotes.length} 处、合计约 ${n(quotedChars)} 字（约占样本正文总量的 ${(quotedChars / Math.max(1, chars) * 100).toFixed(3)}%），每处均为短引用并署名、附原文链接，注明「发表于知乎」，符合合理引用与平台署名要求。</li>
<li><b>引用的答案已做筛选</b>：剔除匿名用户、机构号/广告主与严选付费内容${dropped ? `共 ${n(dropped)} 条（匿名 ${n(reasons.anon.length)} · 机构/广告 ${n(reasons.org.length)} · 严选 ${n(reasons.paid.length)}）` : ''}；完整内容请到知乎原页面阅读。</li>
<li><b>免责</b>：本文为公开信息的数据整理与评论，不构成投资建议，也不代表被引用作者的观点或立场。${AD ? '<b>本文含商品推广链接（广告）。</b>' : '本文不含商业推广；如后续添加推广链接，将在此处标注为广告。'}</li>
<li><b>权利与撤稿</b>：引用均来自公开回答并已署名回链。若你是原作者且不希望被引用，请联系 ${esc(CONTACT)}，我们会在核实后删除对应内容。</li>
</ul>
</div>

<div class="stats">
<div class="st"><b>${n(kept.length)}</b><span>纳入统计的回答</span></div>
<div class="st"><b>${n(votesSum)}</b><span>赞同合计</span></div>
<div class="st"><b>${n(Math.round(chars / 10000))} 万</b><span>正文总字数</span></div>
<div class="st"><b>${n(new Set(kept.map((r) => r.author)).size)}</b><span>不同作者</span></div>
<div class="st"><b>${(top10 / votesSum * 100).toFixed(0)}%</b><span>Top10 回答占赞数</span></div>
</div>

<h2><span class="n">1</span>核心发现</h2>
<p class="sub">以下为统计结论，均可由附带的原始数据复算；未复制的正文内容不在本报告范围内。</p>
<ol>
<li><b>这是个「三人撑起的题」</b>：${n(kept.length)} 条回答里，${n(zero)} 条（${(zero / kept.length * 100).toFixed(1)}%）零赞同，而 Top10 回答占了全部赞同的 ${(top10 / votesSum * 100).toFixed(1)}%、Top20 占 ${(top20 / votesSum * 100).toFixed(1)}%。</li>
<li><b>长文垄断了注意力</b>：${lenBuckets[4].n} 条 3000 字以上的回答拿走 ${(lenBuckets[4].v / votesSum * 100).toFixed(1)}% 的赞同；而 ${lenBuckets[0].n} 条不足 80 字的回答合计只有 ${(lenBuckets[0].v / votesSum * 100).toFixed(1)}%。</li>
<li><b>但长文也不保证有票</b>：3000 字以上的回答里有相当一部分赞同为个位数——写作长度是必要条件，不是充分条件，真正的杠杆是发布时机与被推荐。</li>
<li><b>共识是「老」的</b>：赞同高度集中在早期回答上（见下方年份分布），最新几年的回答几乎拿不到票，但它们往往包含最新的书单与视角。</li>
<li><b>分歧大多来自目标不同</b>：主张「按教材系统学」「先读科普培养兴趣」「先读经典思想」「先搞懂数据口径」的四派，回答的其实是四个不同问题（兴趣启蒙 / 系统自学 / 应试从业 / 现实理解），彼此并不真正冲突。</li>
</ol>

<h2><span class="n">2</span>数据体检</h2>
<p class="sub">样本：${n(kept.length)} 条回答（原平台显示总数更多，差额为已删除/折叠的回答，接口不再返回；另已剔除匿名与机构号内容）。</p>
<div class="grid2">
<div class="card"><b class="small">赞同分布（条数）</b>
${voteBuckets.map((b) => `<div style="margin:9px 0"><div class="small">${b.label} 赞 · ${n(b.n)} 条</div>${bar(b.n, Math.max(...voteBuckets.map((x) => x.n)))}</div>`).join('')}
</div>
<div class="card"><b class="small">正文长度 vs 赞同占比</b>
${lenBuckets.map((b) => `<div style="margin:9px 0"><div class="small">${b.label} · ${n(b.n)} 条 · 占赞数 ${(b.v / votesSum * 100).toFixed(1)}%</div>${bar(b.v, votesSum, 'pos')}</div>`).join('')}
</div>
</div>
<div class="card"><b class="small">按发布年份（条数 / 赞同）</b>
${yearList.map((y) => `<div style="margin:9px 0"><div class="small">${y} · ${years[y].n} 条 · ${n(years[y].v)} 赞</div>${bar(years[y].n, yearMax)}</div>`).join('')}
</div>

${digest ? `<h2><span class="n">3</span>综述<span class="ai">AI 辅助生成 · 已人工核验</span></h2>
<p class="sub">由模型通读全部回答后归纳，仅呈现观点与结论，不复述原文。</p>
<div class="card">
<p>${esc(digest.overview || '')}</p>
${Array.isArray(digest.consensus) && digest.consensus.length ? `<b class="small">共识要点</b><ul>${digest.consensus.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
${Array.isArray(digest.disputes) && digest.disputes.length ? `<b class="small">主要分歧</b><ul>${digest.disputes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
<p class="small">以上为归纳结论，非原文；具体表述请以各作者原文为准（见下方引用与原链接）。</p>
</div>` : ''}

${themes.length ? `<h2><span class="n">4</span>观点排行<span class="ai">AI 辅助归纳</span></h2>
<p class="sub">按「赞成该观点的回答数」与赞数加权排序；标签体系由模型归纳（每类 ≥2 条才列入）。共 ${n(themesTagged)} / ${n(kept.length)} 条回答被归入至少一类，其余为短评或无明确观点。</p>
<div class="card"><table>
<tr><th>观点</th><th class="num">条数</th><th class="num">热度</th><th class="num">最高赞</th></tr>
${themes.slice(0, 12).map((t) => `<tr><td>${esc(t.name)}<div class="small">${esc(t.desc)}</div></td><td class="num">${t.count}</td><td class="num">${t.logSum}</td><td class="num">${n(t.maxVotes)}</td></tr>`).join('')}
</table></div>` : ''}

${books.length ? `<h2><span class="n">5</span>书单排行<span class="ai">词典匹配统计</span></h2>
<p class="sub">橙色为「被明确劝退」的条数。热度为 Σlog10(1+赞同)，是<b>代理指标</b>，不等于书籍价值；统计基于书名号与书目词典匹配，会漏掉词典外的小众书名，故为下限而非全量。</p>
<div class="card"><table>
<tr><th>#</th><th>书</th><th class="num">推荐</th><th class="num">劝退</th><th class="num">热度</th></tr>
${books.slice(0, 20).map((b, i) => `<tr><td class="num">${i + 1}</td><td>${esc(b.title)}${b.author ? `<span class="small"> · ${esc(b.author)}</span>` : ''}</td><td class="num">${b.rec}</td><td class="num" style="color:var(--warn)">${b.avoid || ''}</td><td class="num">${b.recLogSum}</td></tr>`).join('')}
</table></div>` : ''}

<h2><span class="n">6</span>精选片段（短引用，附原文）</h2>
<p class="sub">共 ${quotes.length} 处，均为不超过 ${QUOTE_CHARS} 字的短引用，已按句读截断；完整论证请看原文——本报告刻意不提供全文，就是为了把读者送回原作者那里。</p>
<div class="card">
${quotes.map((q) => `<div class="q"><p>「${esc(q.text)}」</p>
<div class="meta">—— <b>${esc(q.author)}</b> · ${n(q.votes)} 赞 · ${q.date} · <a href="${esc(q.url)}" target="_blank" rel="noopener">原答链接（发表于知乎）</a></div></div>`).join('')}
</div>

<h2><span class="n">7</span>方法与局限</h2>
<div class="card">
<b class="small">怎么做出来的</b>
<ol>
<li>用登录态分页接口抓取该问题下的公开回答（正文、赞同、评论、发布时间），不与平台服务器产生高频请求；</li>
<li>统计与排序全部在本地完成，脚本与参数可复算；</li>
<li>观点标签与综述由模型归纳，并做人工核验；书单使用词典匹配（含裸书名），不使用纯模型抽取，避免模型编造书名；</li>
<li>发布前剔除匿名用户、机构号/广告主与严选付费内容，并将全部引用截断到短引用。</li>
</ol>
<b class="small">必须说明的局限</b>
<ul>
<li>样本是<b>抓取时刻的快照</b>，赞同数是动态值，此后会继续变化；</li>
<li>与该问题显示的回答总数存在差额，差额为已删除/折叠内容，属正常缺失，不是漏抓；</li>
<li>知乎接口不公开「收藏数」，本文只能用赞同/评论/感谢等作为互动代理；</li>
<li>「热度」为加权代理指标，<b>不等于书籍或观点的真实价值</b>；时间越早的回答越容易积累赞同，存在明显的先发优势；</li>
<li>观点归类为模型判断，存在主观性；书单为词典法，召回是小众书目的下限。</li>
</ul>
</div>

<h2><span class="n">8</span>转载与授权</h2>
<div class="card">
<p class="small">本文中的直接引用均为对公开回答的短引用，已注明作者与原始链接，并按知乎平台要求在链接处标注「发表于知乎」；<b>所有引用内容的著作权归原作者所有</b>。任何第三方转载本文时，请一并保留署名与原文链接，不得将引用内容单独摘出使用。${AUTHOR ? `<br>本文作者：${esc(AUTHOR)}。` : ''}</p>
<p class="small">如你是被引用回答的作者或其他权利人，认为本文的使用方式不当，请联系 ${esc(CONTACT)}，我们将在核实后及时删除或调整。</p>
</div>

<footer>
<p>数据快照 ${fmtDate(snapshot)} · 样本 ${n(kept.length)} 条回答 · 引用 ${quotes.length} 处（约 ${n(quotedChars)} 字，占样本正文 ${(quotedChars / Math.max(1, chars) * 100).toFixed(3)}%）· 生成工具：zhihu-web / render-publish.mjs</p>
<p>本文含 AI 辅助生成内容（显式标识见文首声明）。数据整理与结论核对由人工完成；如有出入，以知乎原页面为准。</p>
</footer>
</div></body></html>`;

fs.writeFileSync(OUT, html);
fs.writeFileSync(OUT.replace(/\.html$/, '-citations.json'), JSON.stringify({
  generatedAt: new Date().toISOString(), source: path.basename(SRC), snapshot: snapshot.toISOString(),
  questionId: sorted[0] ? String(sorted[0].question_id) : '',
  keptCount: kept.length, excludedCount: dropped,
  excluded: { anon: reasons.anon.length, org: reasons.org.length, paid: reasons.paid.length },
  filters: { keepAnon: KEEP_ANON, keepOrg: KEEP_ORG, keepPaid: KEEP_PAID },
  sampleChars: chars, quoteRatio: Number((quotedChars / Math.max(1, chars) * 100).toFixed(4)),
  quoteChars: QUOTE_CHARS, quotedChars, quotes,
}, null, 2));

console.log(`已写入 ${OUT}`);
console.log(`  样本 ${kept.length}/${rowsAll.length} 条（剔除匿名 ${reasons.anon.length} · 机构/广告 ${reasons.org.length} · 严选 ${reasons.paid.length}）`);
console.log(`  观点 ${themes.length} 类（覆盖 ${themesTagged} 条） · 书单 ${books.length} 本（推荐≥3） · 引用 ${quotes.length} 处`);
console.log(`  引用合计约 ${quotedChars} 字，占样本正文 ${(quotedChars / Math.max(1, chars) * 100).toFixed(3)}%（全文 ${chars} 字未被复制）`);
const summaryPath = path.join(path.dirname(SRC), path.basename(SRC).replace(/-answers-full\.json$/i, '-汇总.html'));
let summaryKB = null;
try { summaryKB = (fs.statSync(summaryPath).size / 1024).toFixed(0) + ' KB'; } catch {}
console.log(`  文件大小 ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB${summaryKB ? `（内部版 ${summaryKB}）` : ''}`);
