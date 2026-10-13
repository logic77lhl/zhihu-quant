// 统一报告渲染器：实体 JSON -> HTML + Markdown
//
// 输入是「规范化实体数据」，任何实体类型（库 / 书 / 公司 / 概念…）都能套用。
// 由 build-*.mjs 负责把领域数据规范化成本文件的结构。
//
// 用法: node render-report.mjs <entities.json>
//   规范化结构见 tools/ENTITY-SCHEMA.md

import fs from 'node:fs';
import path from 'node:path';

const IN = process.argv[2];
if (!IN) { console.error('用法: node render-report.mjs <entities.json>'); process.exit(1); }

const data = JSON.parse(fs.readFileSync(IN, 'utf8'));
const E = data.entities || [];
if (!E.length) { console.error('entities 为空'); process.exit(1); }

// ---- 配置（可被输入文件覆盖）----
const CFG = Object.assign({
  entityLabel: '条目',
  entityUnit: '条',
  tagLabel: '来源',
  countLabel: '提及次数',
  countShort: '提及',
  sortLabel: '按提及次数',
}, data.render || {});

// ---- 回答级统计（用于时间分布与赞数总计）----
function findAnswers(explicit) {
  const dir = path.dirname(IN);
  const base = path.basename(IN).replace(/-(entities|books|libs)\.json$/, '');
  const cands = [explicit].filter(Boolean);
  cands.push(path.join(dir, `${base}-answers-full.json`));
  if (/^q?(\d{6,})/.test(base)) cands.push(path.join(dir, `q${/^q?(\d{6,})/.exec(base)[1]}-answers-full.json`));
  cands.push(path.join(dir, `${base}.json`));
  for (const c of cands) if (c && fs.existsSync(c)) return JSON.parse(fs.readFileSync(c, 'utf8'));
  console.log(`  [!] 未找到回答全文，时间分布与赞数总计将为空（试过 ${cands.length} 个候选）`);
  return [];
}
const ai = process.argv.indexOf('--answers');
const answers = findAnswers(ai >= 0 ? process.argv[ai + 1] : data.answersFile);

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (s) => (s && !isNaN(Date.parse(s)) ? String(s).slice(0, 10) : '');
const fmtNum = (n) => (n == null ? '' : n.toLocaleString('en-US'));
const slug = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);

// ---- 派生指标 ----
for (const e of E) {
  const ds = (e.samples || []).map((s) => s.created_at).filter(Boolean).sort();
  e.firstMentioned = e.firstMentioned || ds[0] || '';
  e.maxVotes = e.maxVotes ?? Math.max(0, ...(e.samples || []).map((s) => s.votes || 0));
  e.avgVotes = e.avgVotes ?? (e.samples?.length ? Math.round((e.samples || []).reduce((s, x) => s + (x.votes || 0), 0) / e.samples.length) : 0);
}
const dates = answers.map((a) => a.created_at).filter(Boolean).sort();
const totalVotes = answers.reduce((s, a) => s + (a.votes || 0), 0);
const withVotes = answers.filter((a) => a.votes > 0).length;
const byYear = {};
for (const d of dates) { const y = String(d).slice(0, 4); byYear[y] = (byYear[y] || 0) + 1; }
const years = Object.keys(byYear).sort();
const maxYear = Math.max(1, ...Object.values(byYear));

const tags = [...new Set(E.map((e) => e.tag || ''))];
const useTags = tags.length > 1;
const maxC = Math.max(1, ...E.map((e) => e.count || 0));
const maxV = Math.max(1, ...E.map((e) => e.maxVotes || 0));
const tagIdx = new Map(tags.map((t, i) => [t, i]));

const TOPN = 15;
const topBars = E.slice(0, TOPN).map((e) =>
  `<div class="tb"><span class="tn" title="${esc(e.name)}">${esc(e.name)}</span>` +
  `<div class="tt"><i style="width:${(((e.count || 0) / maxC) * 100).toFixed(1)}%"></i></div>` +
  `<span class="tv">${fmtNum(e.count || 0)}</span></div>`).join('');

const yearBars = years.map((y) =>
  `<div class="yb"><span class="yv">${byYear[y]}</span>` +
  `<div class="yt"><i style="height:${((byYear[y] / maxYear) * 100).toFixed(1)}%"></i></div>` +
  `<span class="yl">${y.slice(2)}</span></div>`).join('');

const rows = E.map((e, i) => {
  const cw = maxC ? ((e.count || 0) / maxC) * 100 : 0;
  const vw = e.maxVotes ? Math.max(3, (Math.log10(e.maxVotes + 1) / Math.log10(maxV + 1)) * 100) : 0;
  const smp = (e.samples || []).map((s) => `
        <tr>
          <td class="n">${s.votes != null ? `<b>${fmtNum(s.votes)}</b>` : '<i>—</i>'}</td>
          <td class="n">${s.comments ?? '<i>—</i>'}</td>
          <td class="d">${fmtDate(s.created_at) || '<i>—</i>'}</td>
          <td class="a" title="${esc(s.author || '')}">${esc(s.author || '')}</td>
          <td class="x"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.snippet || '')}</a></td>
        </tr>`).join('');
  return `
  <div class="row" data-tag="${esc(e.tag || '')}" data-c="${e.count || 0}" data-v="${e.maxVotes || 0}" data-n="${esc((e.name || '').toLowerCase())}" data-text="${esc(((e.tag || '') + ' ' + (e.samples || []).map((s) => (s.author || '') + ' ' + (s.snippet || '')).join(' ')).toLowerCase())}">
    <div class="hd">
      <div class="rk">${i + 1}</div>
      <div class="nm"><span class="h" style="--hi:${tagIdx.get(e.tag || '') ?? 0}"></span><span class="t">${esc(e.name)}</span></div>
      ${useTags ? `<div class="tg2">${esc(e.tag || '')}</div>` : '<div class="tg2"></div>'}
      <div class="bar" title="${e.count || 0} ${CFG.entityUnit}提到"><div class="tr"><i style="width:${cw.toFixed(1)}%"></i></div><span>${fmtNum(e.count || 0)}</span></div>
      <div class="bar v" title="最高赞 ${fmtNum(e.maxVotes)}"><div class="tr"><i style="width:${vw.toFixed(1)}%"></i></div><span>${fmtNum(e.maxVotes)}</span></div>
      <div class="dt">${fmtDate(e.firstMentioned) || '<i>—</i>'}</div>
      <button class="tg" aria-expanded="false">溯源 ${(e.samples || []).length}</button>
    </div>
    <div class="pn" hidden>
      <table><thead><tr><th class="n">赞</th><th class="n">评论</th><th class="d">发布</th><th class="a">作者</th><th class="x">上下文</th></tr></thead>
      <tbody>${smp}</tbody></table>
    </div>
  </div>`;
}).join('');

const extraStats = data.extraStats || [];
const notes = (data.notes || []).map((n) => `<li>${n}</li>`).join('\n');

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(data.title || '实体报告')}</title>
<style>
:root{
  --bg:#fbfbfd; --panel:#fff; --fg:#16181d; --dim:#6b7280; --faint:#9aa1ab;
  --line:#e6e8ec; --line2:#f0f2f5; --chip:#f4f5f7; --hover:#f7f8fa;
  --accent:#4f46e5; --accent-soft:#c9cef8; --pos:#0d9488;
  --radius:10px; --shadow:0 1px 2px rgba(16,24,40,.04),0 1px 3px rgba(16,24,40,.06);
}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){
  --bg:#0f1115; --panel:#161920; --fg:#e8eaed; --dim:#9aa1ab; --faint:#6b7280;
  --line:#242832; --line2:#1e222a; --chip:#1c2029; --hover:#1b1f27;
  --accent:#8b8cf7; --accent-soft:#33356b; --pos:#2dd4bf; --shadow:0 1px 2px rgba(0,0,0,.3);
}}
html[data-theme=dark]{--bg:#0f1115;--panel:#161920;--fg:#e8eaed;--dim:#6b7280;--faint:#6b7280;
  --line:#242832;--line2:#1e222a;--chip:#1c2029;--hover:#1b1f27;
  --accent:#8b8cf7;--accent-soft:#33356b;--pos:#2dd4bf;--shadow:0 1px 2px rgba(0,0,0,.3)}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);
  font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:1200px;margin:0 auto;padding:40px 24px 96px;overflow-x:clip}
h1{font-size:26px;line-height:1.3;margin:0 0 8px;letter-spacing:-.4px;font-weight:680}
.lede{color:var(--dim);font-size:14px;margin:0 0 6px}
.lede a{color:var(--accent);text-decoration:none;border-bottom:1px solid transparent}
.lede a:hover{border-bottom-color:currentColor}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;background:var(--line);
  border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;margin:28px 0 32px}
.st{background:var(--panel);padding:16px 18px}
.st b{display:block;font-size:24px;font-weight:660;letter-spacing:-.6px;line-height:1.2}
.st span{display:block;font-size:12px;color:var(--dim);margin-top:3px}
.charts{display:grid;grid-template-columns:1.15fr .85fr;gap:20px;margin-bottom:34px;align-items:stretch}
@media(max-width:860px){.charts{grid-template-columns:1fr}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:20px 22px;
  box-shadow:var(--shadow);display:flex;flex-direction:column}
.card h3{margin:0 0 2px;font-size:14px;font-weight:640}
.card p.sub{margin:0 0 18px;font-size:12.5px;color:var(--dim)}
.tb{display:grid;grid-template-columns:132px 1fr 58px;align-items:center;gap:12px;margin-bottom:9px}
.tn{font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tt{height:8px;background:var(--line2);border-radius:99px;overflow:hidden}
.tt i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),color-mix(in oklab,var(--accent) 60%,var(--pos)));border-radius:99px}
.tv{font-size:12px;color:var(--dim);text-align:right;font-variant-numeric:tabular-nums}
.yrow{display:flex;align-items:flex-end;gap:6px;flex:1;min-height:150px;padding-top:22px}
.yb{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;position:relative}
.yt{width:100%;flex:1;display:flex;align-items:flex-end}
.yt i{width:100%;background:var(--accent-soft);border-radius:5px 5px 0 0;min-height:3px;transition:background .15s}
.yb:hover .yt i{background:var(--accent)}
.yv{position:absolute;top:0;font-size:10.5px;opacity:0;transition:opacity .15s}
.yb:hover .yv{opacity:1;color:var(--fg)}
.yl{font-size:10.5px;color:var(--faint);margin-top:6px;white-space:nowrap}
.tools{position:sticky;top:0;z-index:20;display:flex;gap:8px;align-items:center;flex-wrap:wrap;
  padding:12px 0;margin-bottom:10px;background:var(--bg);border-bottom:1px solid var(--line)}
input[type=search],select{font:inherit;font-size:13.5px;padding:7px 11px;border:1px solid var(--line);
  border-radius:7px;background:var(--panel);color:var(--fg);outline:none}
input[type=search]{flex:1;min-width:180px}
input[type=search]:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.btn{font:inherit;font-size:13px;padding:7px 12px;border:1px solid var(--line);border-radius:7px;
  background:var(--panel);color:var(--dim);cursor:pointer}
.btn:hover{color:var(--fg);border-color:var(--faint)}
.cnt{margin-left:auto;font-size:12.5px;color:var(--dim);font-variant-numeric:tabular-nums}
.list{border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;background:var(--panel);
  box-shadow:var(--shadow);max-width:100%}
.row+.row{border-top:1px solid var(--line2)}
.hd{display:grid;grid-template-columns:30px minmax(130px,1.5fr) 64px minmax(104px,1fr) minmax(112px,1.15fr) 94px 66px;
  align-items:center;gap:14px;padding:11px 18px}
.hd>*{min-width:0}
.hd:hover{background:var(--hover)}
.rk{font-size:12.5px;color:var(--faint);font-variant-numeric:tabular-nums}
.nm{font-weight:600;font-size:14.5px;display:flex;align-items:center;gap:8px;min-width:0}
.nm .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.h{width:7px;height:7px;border-radius:2px;flex:0 0 auto;background:hsl(calc(var(--hi) * 47 + 205) 44% 56%)}
.tg2{font-size:11px;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:9px}
.bar .tr{height:6px;background:var(--line2);border-radius:99px;overflow:hidden}
.bar .tr i{display:block;height:100%;background:var(--faint);border-radius:99px;min-width:3px}
.bar.v .tr i{background:var(--accent)}
.bar span{font-size:12.5px;color:var(--dim);font-variant-numeric:tabular-nums;white-space:nowrap;min-width:30px}
.bar.v span{color:var(--fg);font-weight:560;min-width:44px}
.dt{font-size:12.5px;color:var(--dim);font-variant-numeric:tabular-nums}
button.tg{font:inherit;font-size:12px;padding:4px 10px;border:1px solid var(--line);border-radius:6px;
  background:var(--chip);color:var(--dim);cursor:pointer;white-space:nowrap}
button.tg:hover{color:var(--accent);border-color:var(--accent)}
.pn{border-top:1px solid var(--line2);background:var(--bg);padding:6px 18px 14px}
.pn table{width:100%;border-collapse:collapse;font-size:12.5px}
.pn th{text-align:left;font-weight:560;color:var(--dim);padding:9px 10px 7px;font-size:11.5px;
  text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid var(--line)}
.pn td{padding:9px 10px;border-bottom:1px solid var(--line2);vertical-align:top;color:var(--dim)}
.pn tr:last-child td{border-bottom:0}
.pn td.n{text-align:right;width:64px}
.pn td.n b{color:var(--fg);font-weight:600}
.pn td.d{width:104px;white-space:nowrap}
.pn td.a{width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px}
.pn td.x{line-height:1.55}
.pn td.x a{color:var(--fg);text-decoration:none}
.pn td.x a:hover{color:var(--accent)}
.pn i,.foot i{opacity:.4;font-style:normal}
.foot{margin-top:34px;padding:22px 24px;border:1px solid var(--line);border-radius:var(--radius);
  background:var(--panel);font-size:13px;color:var(--dim);line-height:1.85}
.foot b{color:var(--fg);font-weight:620}
.foot h4{margin:0 0 10px;font-size:13px;color:var(--fg)}
.foot ul{margin:0;padding-left:18px}
.foot li{margin:4px 0}
.foot code{background:var(--chip);padding:1.5px 5px;border-radius:4px;font-size:12px;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.empty{padding:48px;text-align:center;color:var(--faint);display:none}
@media print{.tools{display:none}.pn{display:block!important}body{background:#fff}}
</style></head><body><div class="wrap">

<h1>${esc(data.title || '')}</h1>
<p class="lede">${data.url ? `<a href="${esc(data.url)}" target="_blank" rel="noopener">${esc(data.qLabel || data.url)}</a> · ` : ''}${E.length} 个${esc(CFG.entityLabel)}的提及、赞数与时间溯源</p>

<div class="stats">
  <div class="st"><b>${fmtNum(E.length)}</b><span>去重${esc(CFG.entityLabel)}</span></div>
  <div class="st"><b>${fmtNum(answers.length)}</b><span>扫描回答</span></div>
  <div class="st"><b>${fmtNum(answers.reduce((s, a) => s + (a.content || '').length, 0))}</b><span>正文总字数</span></div>
  <div class="st"><b>${fmtNum(totalVotes)}</b><span>回答赞数总计</span></div>
  <div class="st"><b>${fmtNum(withVotes)}</b><span>零赞以外的回答</span></div>
  <div class="st"><b>${fmtDate(dates[0]) || '—'}</b><span>最早回答</span></div>
  ${extraStats.map((s) => `<div class="st"><b>${fmtNum(s.value)}</b><span>${esc(s.label)}</span></div>`).join('')}
</div>

<div class="charts">
  <div class="card">
    <h3>被最多回答提到的 ${CFG.entityLabel} TOP ${Math.min(TOPN, E.length)}</h3>
    <p class="sub">按「${esc(CFG.countLabel)}」排序</p>
    ${topBars}
  </div>
  <div class="card">
    <h3>回答的时间分布</h3>
    <p class="sub">${years[0] || '—'}–${years[years.length - 1] || '—'} 年，共 ${dates.length} 条回答</p>
    <div class="yrow">${yearBars}</div>
  </div>
</div>

<div class="tools">
  <input type="search" id="q" placeholder="搜索${esc(CFG.entityLabel)}、${esc(CFG.tagLabel)}、作者或上下文…">
  ${useTags ? `<select id="tag"><option value="">全部${esc(CFG.tagLabel)}</option>${tags.filter(Boolean).map((t) => `<option value="${esc(t)}">${esc(t)}（${E.filter((e) => e.tag === t).length}）</option>`).join('')}</select>` : '<div style="width:0"></div>'}
  <select id="sort">
    <option value="c">${esc(CFG.sortLabel)}</option>
    <option value="v">按最高赞</option>
    <option value="d">按首次提及</option>
    <option value="name">按名称</option>
  </select>
  <button class="btn" id="th">主题</button>
  <button class="btn" id="pr">导出 PDF</button>
  <span class="cnt" id="cnt"></span>
</div>

<div class="list" id="list">${rows}</div>
<div class="empty" id="empty">没有匹配的记录</div>

<div class="foot">
  <h4>数据口径</h4>
  <ul>
${notes}
  </ul>
</div>

</div>
<script>
(function(){
  var list=document.getElementById('list'), rows=[].slice.call(list.children), total=rows.length;
  var q=document.getElementById('q'), sort=document.getElementById('sort'), tag=document.getElementById('tag');
  var cnt=document.getElementById('cnt'), empty=document.getElementById('empty');
  function apply(){
    var kw=q.value.trim().toLowerCase(), t=tag?tag.value:'', k=sort.value, out=[];
    rows.forEach(function(r){
      if(t && r.dataset.tag!==t) return;
      if(kw && r.dataset.n.indexOf(kw)<0 && r.dataset.text.indexOf(kw)<0) return;
      out.push(r);
    });
    out.sort(function(a,b){
      if(k==='v')   return (+b.dataset.v)-(+a.dataset.v);
      if(k==='name')return a.dataset.n.localeCompare(b.dataset.n);
      if(k==='d')   return (a.querySelector('.dt').textContent||'￿').localeCompare(b.querySelector('.dt').textContent||'￿');
      return (+b.dataset.c)-(+a.dataset.c);
    });
    rows.forEach(function(r){ list.removeChild(r) });
    out.forEach(function(r,i){ r.querySelector('.rk').textContent=i+1; list.appendChild(r) });
    empty.style.display = out.length ? 'none':'block';
    cnt.textContent = out.length===total ? total+' 条' : out.length+' / '+total+' 条';
  }
  list.addEventListener('click', function(e){
    var b=e.target.closest('button.tg'); if(!b) return;
    var p=b.closest('.row').querySelector('.pn'), open=!p.hidden;
    p.hidden=open;
    var last=b.textContent.trim().split(' ').pop();
    b.textContent=(open?'溯源 ':'收起 ')+last;
    b.setAttribute('aria-expanded',String(!open));
  });
  var root=document.documentElement;
  document.getElementById('th').onclick=function(){
    var cur=root.dataset.theme;
    if(!cur) cur=matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';
    root.dataset.theme = cur==='dark'?'light':'dark';
  };
  document.getElementById('pr').onclick=function(){ window.print() };
  q.addEventListener('input',apply);
  if(tag) tag.addEventListener('change',apply);
  sort.addEventListener('change',apply);
  apply();
})();
</script></body></html>`;

const outBase = IN.replace(/-(entities|books|libs)\.json$/, '');
const titleSlug = slug(data.title || 'report');
const htmlOut = path.join(path.dirname(IN), `${data.question || ''}-${titleSlug}.html`.replace(/^-/, ''));
const mdOut = htmlOut.replace(/\.html$/, '.md');
fs.writeFileSync(htmlOut, html, 'utf8');

const md = [
  `# ${data.title || '实体报告'}`, '',
  data.url ? `> 知乎 [${data.qLabel || data.url}](${data.url}) · ${E.length} 个${CFG.entityLabel} · 扫描 ${answers.length} 条回答 · 正文 ${fmtNum(answers.reduce((s, a) => s + (a.content || '').length, 0))} 字` : '',
  '', `## TOP ${Math.min(TOPN, E.length)} ${CFG.entityLabel}（按${CFG.countLabel}）`, '',
  `| # | ${CFG.entityLabel} | ${CFG.tagLabel} | ${CFG.countLabel} | 最高赞 | 均赞 | 首次提及 |`,
  `|---|------|------|------|--------|------|---------|`,
  ...E.slice(0, TOPN).map((e, i) => `| ${i + 1} | **${e.name}** | ${e.tag || ''} | ${fmtNum(e.count)} | ${fmtNum(e.maxVotes)} | ${fmtNum(e.avgVotes)} | ${fmtDate(e.firstMentioned) || '—'} |`),
  '', `## 全部 ${E.length} 个${CFG.entityLabel}`, '',
  `| # | ${CFG.entityLabel} | ${CFG.tagLabel} | ${CFG.countLabel} | 最高赞 | 均赞 | 首次提及 |`,
  `|---|------|------|------|--------|------|---------|`,
  ...E.map((e, i) => `| ${i + 1} | **${e.name}** | ${e.tag || ''} | ${fmtNum(e.count)} | ${fmtNum(e.maxVotes)} | ${fmtNum(e.avgVotes)} | ${fmtDate(e.firstMentioned) || '—'} |`),
  '', '## 溯源明细', '',
  ...E.flatMap((e) => [
    `### ${e.name} — ${CFG.countLabel} ${e.count}，最高赞 ${fmtNum(e.maxVotes)}`, '',
    '| 赞 | 评论 | 发布 | 作者 | 上下文 |',
    '|----|------|------|------|--------|',
    ...(e.samples || []).map((s) => `| ${s.votes != null ? fmtNum(s.votes) : '—'} | ${s.comments ?? '—'} | ${fmtDate(s.created_at) || '—'} | ${s.author || ''} | [${(s.snippet || '').slice(0, 100)}](${s.url}) |`),
    '',
  ]),
  '---', '', '**口径**', ...(data.notes || []).map((n) => `\n- ${n}`),
].filter(Boolean).join('\n');
fs.writeFileSync(mdOut, md, 'utf8');

console.log(`  → ${htmlOut}`);
console.log(`  → ${mdOut}`);
console.log(`  ${E.length} 个${CFG.entityLabel} · 扫描 ${answers.length} 条回答`);