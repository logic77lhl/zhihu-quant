// 分页抓取回答全文（绕过 `question --limit 1000` 的上限）
//
// 背景：
//   `panerelay zhihu question <id> --limit 1000` 单次最多 1000 条，且该命令无分页参数。
//   回答数 >1000 的问题（例：3707 条）会被截断，两种排序合并也只能拿到一部分。
//
// 做法：
//   直接打 /api/v4/questions/<qid>/answers 分页接口（limit 上限 20），
//   该接口在 `include=data[*].content` 时返回**全文 HTML**（不是截断到 200 字的摘要）。
//   本地去标签后与 `answer-detail --max-content 0` 的纯文本逐字一致（已实测 6/6）。
//   因此 186 次分页请求即可拿到全部 3707 条全文，无需逐条 answer-detail（3707 次 / 约 47 分钟）。
//
// 用法:
//   node fetch-answers-api.mjs <questionId> [--out f.json] [--sorts default,created] [--concurrency N] [--max-pages N]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { panerelay } from './panerelay-run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
function resolveOutDir() {
  if (process.env.ZHIHU_QUANT_OUT) return process.env.ZHIHU_QUANT_OUT;
  for (const p of [path.join(HERE, '..', 'config.json'), path.join(HERE, '..', '..', 'config.json')]) {
    try { const c = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); if (c.outDir) return c.outDir; } catch {}
  }
  return path.join(process.env.USERPROFILE || process.env.HOME, 'Documents', 'zhihu-quant');
}

const argv = process.argv.slice(2);
const qid = argv.find((a) => /^\d+$/.test(a));
if (!qid) { console.error('用法: node fetch-answers-api.mjs <questionId> [--out f.json] [--sorts default,created] [--concurrency N]'); process.exit(1); }
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SORTS = opt('--sorts', 'default,created').split(',').map((s) => s.trim()).filter(Boolean);
const CONC = Number(opt('--concurrency', 3));
const MAX_PAGES = Number(opt('--max-pages', 0));   // 0 = 不限制
const PAGE = 20;                                   // 接口上限就是 20，试过 50/100 会返回空
const D = resolveOutDir().replace(/\\/g, '/') + '/';
fs.mkdirSync(D, { recursive: true });
const OUT = opt('--out', `${D}q${qid}-answers-full.json`);
const STATE = OUT + '.state.json';
const INC = 'data[*].content,voteup_count,comment_count,created_time,updated_time,author.name,question.title';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 统一调用层：绕开 cmd.exe，URL 里的 & | < > ^ 不会被当命令分隔符。
// 回归测试见 test-shell-injection.mjs。
// 注意：这里用 --query key:value 传参而不是拼裸 URL，本身就已规避该问题；
// 但底层换成不经过 shell 的调用，才能保证任何写法都安全。
function run(args) {
  const r = panerelay(args, { timeout: 120000, maxBuffer: 1 << 26 });
  return { out: r.text, status: r.status };
}

// 列表接口返回 HTML；这里去标签，输出与 answer-detail 一致的纯文本
function stripHtml(h) {
  return String(h || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<figure[\s\S]*?<\/figure>/gi, '\n')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function fetchPage(sort, offset) {
  const { out } = run(['fetch', `https://www.zhihu.com/api/v4/questions/${qid}/answers`,
    '--query', `limit:${PAGE}`, '--query', `offset:${offset}`, '--query', `sort_by:${sort}`,
    '--query', `include:${INC}`, '--response', 'json']);
  let j;
  try { j = JSON.parse(out); } catch { return { error: '非 JSON: ' + out.slice(0, 160) }; }
  if (j.status && j.status !== 200) return { error: 'HTTP ' + j.status };
  const b = j.body || j;
  if (!b || !Array.isArray(b.data)) return { error: '无 data: ' + JSON.stringify(b).slice(0, 160) };
  return { data: b.data, paging: b.paging || {} };
}

const mapItem = (it) => ({
  id: String(it.id),
  author: it.author?.name || '',
  votes: it.voteup_count ?? 0,
  comments: it.comment_count ?? 0,
  created_at: it.created_time ? new Date(it.created_time * 1000).toISOString() : null,
  updated_at: it.updated_time ? new Date(it.updated_time * 1000).toISOString() : null,
  question_id: String(qid),
  question_title: it.question?.title || '',
  url: `https://www.zhihu.com/question/${qid}/answer/${it.id}`,
  content: stripHtml(it.content),
});

let state = { done: {}, items: {}, totals: {}, failed: [] };
if (fs.existsSync(STATE)) { try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE, 'utf8')) }; } catch {} }
const save = () => fs.writeFileSync(STATE, JSON.stringify(state), 'utf8');

// ---- 1. 先取第一页，拿到 totals ----
console.log(`问题 ${qid}，排序 ${SORTS.join(' + ')}\n`);
const tasks = [];
for (const sort of SORTS) {
  const first = await fetchPage(sort, 0);
  if (first.error) { console.error(`首屏失败 (${sort}): ${first.error}`); process.exit(1); }
  const totals = first.paging.totals || 0;
  state.totals[sort] = totals;
  const pages = MAX_PAGES ? Math.min(MAX_PAGES, Math.ceil(totals / PAGE)) : Math.ceil(totals / PAGE);
  console.log(`  ${sort}: totals=${totals} -> ${pages} 页`);
  for (let i = 0; i < pages; i++) tasks.push({ sort, offset: i * PAGE, first: i === 0 ? first : null });
}
save();

const todo = tasks.filter((t) => !state.done[`${t.sort}:${t.offset}`]);
console.log(`\n共 ${tasks.length} 页，待抓 ${todo.length} 页，并发 ${CONC}\n`);

// ---- 2. 并发翻页 ----
const t0 = Date.now();
let ok = 0, fail = 0, cursor = 0;
async function worker() {
  while (cursor < todo.length) {
    const t = todo[cursor++];
    const res = t.first || await fetchPage(t.sort, t.offset);
    if (res.error) {
      fail++; state.failed.push(`${t.sort}:${t.offset} ${res.error}`);
      console.log(`  [!] ${t.sort}:${t.offset} 失败: ${res.error}`);
    } else {
      for (const it of res.data) {
        const rec = mapItem(it);
        const prev = state.items[rec.id];
        // 同一回答可能被两种排序各返回一次：保留正文更长的
        if (!prev || (rec.content || '').length > (prev.content || '').length) state.items[rec.id] = rec;
      }
      state.done[`${t.sort}:${t.offset}`] = true;
      ok++;
    }
    if ((ok + fail) % 10 === 0) {
      save();
      const el = (Date.now() - t0) / 1000;
      const rate = (ok + fail) / el;
      process.stdout.write(`  ${ok + fail}/${todo.length} 页  ok=${ok} fail=${fail}  已收 ${Object.keys(state.items).length} 条  ${el.toFixed(0)}s  ETA ${((todo.length - ok - fail) / rate).toFixed(0)}s\n`);
    }
    await sleep(120);
  }
}
await Promise.all(Array.from({ length: CONC }, () => worker()));
save();

// ---- 3. 输出 ----
const all = Object.values(state.items).sort((a, b) => (b.votes || 0) - (a.votes || 0));
const el = (Date.now() - t0) / 1000;
const totals = Object.values(state.totals).sort((a, b) => b - a)[0] || 0;
console.log(`\n完成：收 ${all.length} 条（平台 totals=${totals}），失败页 ${state.failed.length}，用时 ${el.toFixed(0)}s`);
if (all.length < totals) console.log(`  [!] 比 totals 少 ${totals - all.length} 条，可能被平台隐藏/删除，或分页漏页（见 state.failed）`);
const tv = all.reduce((s, d) => s + (d.votes || 0), 0);
const cl = all.reduce((s, d) => s + (d.content || '').length, 0);
console.log(`  赞数合计 ${tv}   正文总字数 ${cl}`);
fs.writeFileSync(OUT, JSON.stringify(all, null, 1), 'utf8');
console.log(`  已写入 ${OUT}`);
if (state.failed.length) console.log('  失败页：' + state.failed.join(' | '));
