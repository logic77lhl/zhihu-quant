// 汇总索引生成器：扫描目录里的知乎报告产物，生成一个 index.html
//
// 设计要点：
//   - 只收文件名以 `q<数字>` 或 `<数字>-` 开头的文件（自动排除同目录里其它项目的产物）
//   - 按问题 ID 归组：一个问题下的多份报告（汇总页/实体报告/旧版/Markdown）收成一张卡
//   - 统计与摘要直接从旁边的 JSON 旁挂文件读，不解析 HTML（快，且不脆弱）
//
// 用法:
//   node build-index.mjs [--dir .] [--out index.html] [--no-md]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DIR = path.resolve(opt('--dir', process.cwd()));
const OUT = path.join(DIR, opt('--out', 'index.html'));
const INCLUDE_MD = !argv.includes('--no-md');   // 默认连 Markdown 报告一起收录，要排除就 --no-md
const D = DIR + path.sep;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtKB = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
const fmtNum = (n) => (n || 0).toLocaleString('en-US');
const fmtDate = (ts) => { const d = new Date(ts); return isNaN(d) ? '' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ---- 1. 扫描：只认 `q<数字>-*` / `<数字>-*` ----
const groups = new Map();
const files = fs.readdirSync(DIR);
for (const name of files) {
  const m = name.match(/^q?(\d{6,})[-_.]/);
  if (!m) continue;
  const isHtml = name.endsWith('.html');
  const isMd = name.endsWith('.md');
  if (!isHtml && !isMd) continue;
  if (isMd && !INCLUDE_MD) continue;
  if (name === 'index.html') continue;
  const qid = m[1];
  if (!groups.has(qid)) groups.set(qid, { qid, files: [] });
  const st = fs.statSync(D + name);
  groups.get(qid).files.push({ name, size: st.size, mtime: st.mtimeMs, isHtml, isMd });
}

const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(D + p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };

// 缺标题时问一次知乎 API，结果缓存到 index-titles.json，重跑不会重复请求。
// 离线 / 桥接不可用时静默降级为 question/<id>，不影响索引生成。
const titleCacheFile = 'index-titles.json';
const titleCache = readJSON(titleCacheFile) || {};
let cacheDirty = false;
function fetchQuestionTitle(qid) {
  if (titleCache[qid]) return titleCache[qid];
  const grab = (body) => {
    const b = body?.body || body;
    if (typeof b?.title === 'string' && b.title) return b.title;                       // /questions/<id>
    const q = b?.data?.[0]?.question;                                                    // 回答列表里带着 question.title
    if (q && typeof q.title === 'string' && q.title) return q.title;
    return '';
  };
  // 依次尝试：① 问题详情端点（常被 403）② 回答列表端点（带 question.title，实测可用）
  const tries = [
    ['fetch', `https://www.zhihu.com/api/v4/questions/${qid}`, '--query', 'include:title', '--response', 'json'],
    ['fetch', `https://www.zhihu.com/api/v4/questions/${qid}/answers`, '--query', 'limit:1', '--query', 'offset:0',
      '--query', 'include:data[*].question.title', '--response', 'json'],
  ];
  for (const args of tries) {
    try {
      const r = spawnSync('cmd.exe', ['/c', 'panerelay', ...args], { encoding: 'utf8', timeout: 40000, maxBuffer: 1 << 24 });
      const t = grab(JSON.parse(r.stdout || ''));
      if (t) { titleCache[qid] = t; cacheDirty = true; return t; }
    } catch { }
  }
  return '';
}

// ---- 2. 给每组补元数据 ----
const items = [];
for (const g of groups.values()) {
  const q = g.qid;
  const answers = readJSON(`q${q}-answers-full.json`);
  const summaries = readJSON(`q${q}-summaries.json`);
  const themes = readJSON(`q${q}-themes.json`);
  const books = readJSON(`q${q}-books-llm.json`);
  const ents = readJSON(`q${q}-entities.json`);

  const arr = Array.isArray(answers) ? answers : null;
  const dates = arr ? arr.map((a) => a.created_at).filter(Boolean).sort() : [];
  let title = (arr && arr[0]?.question_title) || summaries?.question || themes?.question || books?.question || ents?.title || '';
  // 没有 JSON 元数据时，退而求其次从 Markdown 首行标题里捞一个
  if (!title) {
    for (const f of g.files) {
      if (!f.name.endsWith('.md')) continue;
      const head = fs.readFileSync(D + f.name, 'utf8').slice(0, 400).match(/^#\s+(.+)$/m);
      if (head) { title = head[1].trim().slice(0, 80); break; }
    }
  }
  title = title || fetchQuestionTitle(q) || `question/${q}`;
  const themeList = themes?.themes || [];
  const bookCount = books?.books?.length || ents?.entities?.length || null;
  // 没有实体/书单但有标签的，多半是「故事征集」这类题，把「观点」改称「母题」
  const storyMode = !bookCount && themeList.length > 0;
  const it = {
    qid: q,
    url: `https://www.zhihu.com/question/${q}`,
    title,
    answers: arr?.length ?? null,
    votes: arr ? arr.reduce((s, a) => s + (a.votes || 0), 0) : null,
    chars: arr ? arr.reduce((s, a) => s + (a.content || '').length, 0) : null,
    from: dates[0]?.slice(0, 10) || '',
    to: dates[dates.length - 1]?.slice(0, 10) || '',
    summaryCount: summaries ? Object.keys(summaries.perAnswer || {}).length : null,
    overview: summaries?.digest?.overview || '',
    themes: themeList.length || null,
    themeTop: themeList.slice(0, 4).map((t) => t.name),
    themeLabel: storyMode ? '故事母题' : '观点',
    books: bookCount,
    bookTop: (books?.books || []).slice(0, 3).map((b) => b.title),
    isSummaryPage: g.files.some((f) => f.name.includes('汇总')),
    files: g.files.sort((a, b) => b.mtimeMs - a.mtimeMs),
    mtime: Math.max(...g.files.map((f) => f.mtime)),
  };
  items.push(it);
}
items.sort((a, b) => b.mtime - a.mtime);

const totals = {
  questions: items.length,
  files: items.reduce((s, i) => s + i.files.length, 0),
  answers: items.reduce((s, i) => s + (i.answers || 0), 0),
  size: items.reduce((s, i) => s + i.files.reduce((x, f) => x + f.size, 0), 0),
};

const kindOf = (f) => {
  if (f.name.includes('汇总')) return '汇总页';
  if (f.name.includes('entities') || f.name.includes('books') || f.name.includes('libs')) return '实体报告';
  if (f.name.endsWith('.html')) return '旧版报告';
  return 'Markdown';
};

const card = (it) => `<div class="card" data-q="${esc(it.qid)}" data-t="${esc((it.title + ' ' + it.qid).toLowerCase())}">
  <div class="hd">
    <div class="ti"><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a></div>
    <div class="meta">
      <a class="qid" href="${esc(it.url)}" target="_blank" rel="noopener">question/${esc(it.qid)}</a>
      ${it.from ? `<span class="dot">·</span>${esc(it.from)} ~ ${esc(it.to)}` : '<span class="dot">·</span><i>无全文数据，仅报告文件</i>'}
    </div>
  </div>
  <div class="stats">
    ${it.answers != null ? `<div><b>${fmtNum(it.answers)}</b><span>回答</span></div>` : ''}
    ${it.votes != null ? `<div><b>${fmtNum(it.votes)}</b><span>赞合计</span></div>` : ''}
    ${it.chars != null ? `<div><b>${fmtNum(it.chars)}</b><span>正文字数</span></div>` : ''}
    ${it.summaryCount ? `<div><b>${fmtNum(it.summaryCount)}</b><span>AI 摘要</span></div>` : ''}
    ${it.themes ? `<div><b>${it.themes}</b><span>${esc(it.themeLabel)}标签</span></div>` : ''}
    ${it.books ? `<div><b>${fmtNum(it.books)}</b><span>实体/书名</span></div>` : ''}
  </div>
  ${it.overview ? `<div class="ov">${esc(it.overview.slice(0, 190))}${it.overview.length > 190 ? '…' : ''}</div>` : ''}
  ${it.themeTop.length ? `<div class="chips"><span class="lb">${esc(it.themeLabel)}</span>${it.themeTop.map((t) => `<span class="ch">${esc(t)}</span>`).join('')}</div>` : ''}
  ${it.bookTop.length ? `<div class="chips"><span class="lb">书名</span>${it.bookTop.map((t) => `<span class="ch b">${esc(t)}</span>`).join('')}</div>` : ''}
  <div class="files">${it.files.map((f) => `<a class="f ${f.isHtml ? 'h' : 'm'}" href="./${encodeURI(f.name)}" title="${esc(fmtDate(f.mtime) + ' · ' + fmtKB(f.size))}">
      <span class="k">${kindOf(f)}</span><span class="n">${esc(f.name.replace(/^q?\d+[-_.]/, ''))}</span><span class="z">${fmtKB(f.size)}</span></a>`).join('')}</div>
</div>`;

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>知乎回答汇总 · 索引</title>
<style>
:root{
  --bg:#fbfbfd; --panel:#fff; --fg:#16181d; --dim:#6b7280; --faint:#9aa1ab;
  --line:#e6e8ec; --line2:#f0f2f5; --chip:#f4f5f7; --hover:#f7f8fa;
  --accent:#4f46e5; --accent-soft:#c9cef8; --pos:#0d9488; --warn:#b45309;
  --radius:12px; --shadow:0 1px 2px rgba(16,24,40,.04),0 1px 3px rgba(16,24,40,.06);
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0f1115; --panel:#161920; --fg:#e8eaed; --dim:#9aa1ab; --faint:#6b7280;
  --line:#242832; --line2:#1e222a; --chip:#1c2029; --hover:#1b1f27;
  --accent:#8b8cf7; --accent-soft:#33356b; --pos:#2dd4bf; --warn:#fbbf24;
  --shadow:0 1px 2px rgba(0,0,0,.3);
}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);
  font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:1120px;margin:0 auto;padding:44px 22px 100px}
h1{font-size:26px;margin:0 0 6px;letter-spacing:-.4px;font-weight:680}
.lede{color:var(--dim);font-size:13.5px;margin:0}
.tot{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1px;background:var(--line);
  border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;margin:22px 0}
.tot>div{background:var(--panel);padding:13px 16px}
.tot b{display:block;font-size:21px;font-weight:660;letter-spacing:-.5px;font-variant-numeric:tabular-nums}
.tot span{display:block;font-size:12px;color:var(--dim);margin-top:2px}
.bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 22px}
.bar input{flex:1;min-width:200px;background:var(--panel);border:1px solid var(--line);border-radius:8px;
  padding:8px 12px;font-size:14px;color:var(--fg);outline:none}
.bar input:focus{border-color:var(--accent-soft)}
.bar select{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:13.5px;color:var(--fg)}
.bar .cnt{font-size:12.5px;color:var(--dim);font-variant-numeric:tabular-nums}
.grid{display:flex;flex-direction:column;gap:18px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:20px 22px}
.hd .ti{font-size:16.5px;font-weight:640;line-height:1.5}
.hd .ti a{color:inherit;text-decoration:none}
.hd .ti a:hover{color:var(--accent)}
.meta{font-size:12.5px;color:var(--dim);margin-top:3px;font-variant-numeric:tabular-nums}
.meta i{font-style:normal;color:var(--faint)}
.meta .qid{color:var(--accent);text-decoration:none}
.meta .dot{margin:0 6px;color:var(--faint)}
.stats{display:flex;flex-wrap:wrap;gap:22px;margin:14px 0 4px;padding:12px 0;border-top:1px solid var(--line2);border-bottom:1px solid var(--line2)}
.stats div{min-width:0}
.stats b{display:block;font-size:16px;font-weight:640;font-variant-numeric:tabular-nums;line-height:1.3}
.stats span{font-size:11.5px;color:var(--dim)}
.ov{font-size:13px;color:var(--dim);line-height:1.75;margin:12px 0 2px;padding-left:11px;border-left:3px solid var(--accent-soft)}
.chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:9px 0}
.lb{font-size:11px;color:var(--faint);margin-right:2px}
.ch{font-size:12px;background:var(--chip);border:1px solid var(--line);border-radius:99px;padding:2px 10px;color:var(--fg)}
.ch.b{color:var(--pos);border-color:color-mix(in oklab,var(--pos) 35%,var(--line))}
.files{display:flex;flex-wrap:wrap;gap:7px;margin-top:14px}
.f{display:inline-flex;align-items:center;gap:7px;font-size:12px;text-decoration:none;color:var(--fg);
  background:var(--chip);border:1px solid var(--line);border-radius:7px;padding:5px 10px;max-width:100%}
.f:hover{border-color:var(--accent-soft);background:var(--hover)}
.f .k{font-size:10.5px;color:var(--accent);background:color-mix(in oklab,var(--accent) 10%,transparent);border-radius:4px;padding:1px 6px;flex:none}
.f.m .k{color:var(--warn);background:color-mix(in oklab,var(--warn) 12%,transparent)}
.f .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.f .z{color:var(--faint);font-variant-numeric:tabular-nums;flex:none}
.empty{color:var(--dim);text-align:center;padding:60px 0}
footer{margin-top:46px;padding-top:18px;border-top:1px solid var(--line);color:var(--faint);font-size:12px}
footer code{background:var(--chip);padding:1px 5px;border-radius:4px}
@media(max-width:620px){.wrap{padding:28px 12px 70px}.card{padding:16px 14px}.stats{gap:16px}}
</style></head>
<body><div class="wrap">
<h1>知乎回答汇总 · 索引</h1>
<p class="lede">本目录下所有知乎问题报告的入口。每张卡按问题归组，列出该问题下的全部产物。</p>

<div class="tot">
  <div><b>${totals.questions}</b><span>问题</span></div>
  <div><b>${totals.files}</b><span>报告文件</span></div>
  <div><b>${fmtNum(totals.answers)}</b><span>回答总数</span></div>
  <div><b>${fmtKB(totals.size)}</b><span>合计体积</span></div>
</div>

<div class="bar">
  <input type="search" id="q" placeholder="搜索问题标题 / 回答 / 标签…">
  <select id="sort">
    <option value="mtime">按最近更新</option>
    <option value="answers">按回答数</option>
    <option value="votes">按赞合计</option>
    <option value="size">按文件体积</option>
  </select>
  <span class="cnt" id="cnt"></span>
</div>

<div class="grid" id="grid"></div>
<div class="empty" id="empty" hidden>没有匹配的问题。</div>

<footer>
  由 <code>tools/build-index.mjs</code> 扫描本目录生成 · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC<br>
  只收录文件名形如 <code>q&lt;数字&gt;-*</code> / <code>&lt;数字&gt;-*</code> 的产物；同目录其他项目的文件自动排除。统计数字直接读旁边的 JSON，不解析 HTML。
</footer>
</div>
<script id="data" type="application/json">${JSON.stringify(items).replace(/</g, '\\u003c')}</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmtKB = (b) => (b >= 1048576 ? (b/1048576).toFixed(1)+' MB' : Math.max(1, Math.round(b/1024))+' KB');
const fmtNum = (n) => (n || 0).toLocaleString('en-US');
const pad = (n) => String(n).padStart(2,'0');
const fmtDate = (ts) => { const d = new Date(ts); return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); };
const kindOf = (f) => f.includes('汇总') ? '汇总页' : (f.includes('entities')||f.includes('books')||f.includes('libs')) ? '实体报告' : (f.endsWith('.html') ? '旧版报告' : 'Markdown');
const sizeOf = (it) => it.files.reduce((s,f)=>s+f.size,0);

const grid = document.getElementById('grid'), empty = document.getElementById('empty'), cnt = document.getElementById('cnt');
const qEl = document.getElementById('q'), sortEl = document.getElementById('sort');

function card(it){
  const stat = (v,l) => v == null ? '' : '<div><b>'+fmtNum(v)+'</b><span>'+l+'</span></div>';
  const chips = (lb, arr, cls) => arr.length ? '<div class="chips"><span class="lb">'+lb+'</span>'+arr.map(t=>'<span class="ch'+(cls?' '+cls:'')+'">'+esc(t)+'</span>').join('')+'</div>' : '';
  const files = it.files.map((f) => '<a class="f '+(f.isHtml?'h':'m')+'" href="./'+encodeURIComponent(f.name)+'" title="'+fmtDate(f.mtime)+' · '+fmtKB(f.size)+'">'
    + '<span class="k">'+kindOf(f.name)+'</span><span class="n">'+esc(f.name.replace(/^q?\\d+[-_.]/,''))+'</span><span class="z">'+fmtKB(f.size)+'</span></a>').join('');
  return '<div class="card">'
    + '<div class="hd"><div class="ti"><a href="'+esc(it.url)+'" target="_blank" rel="noopener">'+esc(it.title)+'</a></div>'
    + '<div class="meta"><a class="qid" href="'+esc(it.url)+'" target="_blank" rel="noopener">question/'+esc(it.qid)+'</a>'
    + (it.from ? '<span class="dot">·</span>'+esc(it.from)+' ~ '+esc(it.to) : '<span class="dot">·</span><i>无全文数据，仅报告文件</i>')+'</div></div>'
    + '<div class="stats">'+stat(it.answers,'回答')+stat(it.votes,'赞合计')+stat(it.chars,'正文字数')
    + stat(it.summaryCount,'AI 摘要')+stat(it.themes,'观点标签')+stat(it.books,'实体/书名')+'</div>'
    + (it.overview ? '<div class="ov">'+esc(it.overview.slice(0,190))+(it.overview.length>190?'…':'')+'</div>' : '')
    + chips('观点', it.themeTop) + chips('书名', it.bookTop, 'b')
    + '<div class="files">'+files+'</div></div>';
}

function render(){
  const term = qEl.value.trim().toLowerCase();
  let rows = D.slice();
  if (term) rows = rows.filter((it) => (it.title+' '+it.qid+' '+it.themeTop.join(' ')+' '+it.bookTop.join(' ')+' '+(it.overview||'')).toLowerCase().includes(term));
  const s = sortEl.value;
  if (s === 'mtime') rows.sort((a,b)=>b.mtime-a.mtime);
  else if (s === 'answers') rows.sort((a,b)=>(b.answers||0)-(a.answers||0));
  else if (s === 'votes') rows.sort((a,b)=>(b.votes||0)-(a.votes||0));
  else if (s === 'size') rows.sort((a,b)=>sizeOf(b)-sizeOf(a));
  cnt.textContent = rows.length + ' / ' + D.length + ' 个问题';
  empty.hidden = rows.length > 0;
  grid.innerHTML = rows.map(card).join('');
}
let t; qEl.addEventListener('input', ()=>{clearTimeout(t);t=setTimeout(render,120)});
sortEl.addEventListener('change', render);
render();
</script>
</body></html>`;

fs.writeFileSync(OUT, html, 'utf8');
if (cacheDirty) fs.writeFileSync(D + titleCacheFile, JSON.stringify(titleCache, null, 1), 'utf8');
console.log(`已写入 ${OUT}`);
console.log(`  收录 ${totals.questions} 个问题 / ${totals.files} 份报告 / 回答合计 ${fmtNum(totals.answers)} / ${fmtKB(totals.size)}`);
for (const it of items) {
  const bits = [];
  if (it.answers != null) bits.push(`${it.answers} 回答`);
  if (it.themes) bits.push(`${it.themes} 观点`);
  if (it.books) bits.push(`${it.books} 书名`);
  console.log(`  [${it.files.length}] question/${it.qid}  ${it.title.slice(0, 34)}${bits.length ? '  — ' + bits.join(' · ') : ''}`);
}