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
// 排序策略（2026-10-16 改）：
//   默认只抓 default 排序，抓完再取 created 首屏做**覆盖检查**：
//     · created 首屏全部已在集合内 → 跳过 created 全量（省一半请求）
//     · 有缺失 → 自动退回旧行为，补抓 created 全量
//   依据：实测 created 是 default 的真子集（q650705759：703 vs 659，仅 created 多出 0 条；
//   小问题 38=38 完全一致；两排序 totals 相同）。旧的「双排序全抓」是把请求数翻倍的纯浪费。
//   要强制双排序全抓：--sorts both（等价于旧写法 --sorts default,created）。
//
// 用法:
//   node fetch-answers-api.mjs <questionId> [--out f.json] [--sorts default|created|both] [--concurrency N] [--max-pages N]
//                                [--force] [--no-cover-check]
//   --force            产物已完整时仍强制重抓（默认会被 precheck.mjs 拦下并 exit 3）
//   --no-cover-check   单排序时不发那次 created 覆盖检查（省 1 次请求，最快）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { panerelay } from './panerelay-run.mjs';
import { acquireLock } from './lock.mjs';
import { assess } from './precheck.mjs';

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
const SORTS_RAW = opt('--sorts', 'default');
// `both` 是旧写法 `default,created` 的别名（双排序全抓，请求翻倍，一般用不到）
const SORTS = (SORTS_RAW === 'both' ? 'default,created' : SORTS_RAW).split(',').map((s) => s.trim()).filter(Boolean);
const CONC = Number(opt('--concurrency', 3));
const MAX_PAGES = Number(opt('--max-pages', 0));   // 0 = 不限制
const PAGE = 20;                                   // 接口上限就是 20，试过 50/100 会返回空
const D = resolveOutDir().replace(/\\/g, '/') + '/';
fs.mkdirSync(D, { recursive: true });
const OUT = opt('--out', `${D}q${qid}-answers-full.json`);
const STATE = OUT + '.state.json';
const INC = 'data[*].content,voteup_count,comment_count,created_time,updated_time,thanks_count,'
  + 'author.name,author.is_advertiser,author.user_type,question.title,answer_type';
// 说明：answer_type（是否盐选/严选付费）、author.is_advertiser / user_type（机构号、广告主）
// **默认不返回**，必须显式写进 include。漏了就得事后跑 enrich-flags.mjs 再打一次接口（约 4 分钟）。
// 故事征集题尤其需要这几个字段 —— 严选内容被推荐位加权，实测占 Top100 赞数的 45%。
// 见 references/content-kind.md。

// ---- 闸门：产物已经完整就别再抓 ----
// 2026-10-15 实测事故：产物早在两小时前就在盘上，会话没查就重抓了一遍，
// 换了通路、正文被截断到 200 字、还落错目录，约 400 次请求白花，结论还是错的。
// lock.mjs 只能拦「同时在抓」，拦不住「已经抓完了还要再抓」—— 这是另一道闸。
//
// 只在本地判断，不发网络请求。--force 绕过。
const FORCE = argv.includes('--force');
if (!FORCE) {
  const pre = assess(qid, { probe: false });
  const blocker = pre.blockers.find((b) => b.kind === 'ARTIFACT_EXISTS');
  if (blocker) {
    console.error('\n[!] 产物已完整，已退出以免重复抓取。');
    console.error(`    ${blocker.msg}`);
    blocker.detail.forEach((d) => console.error(d));
    console.error('\n    直接复用即可，从下游继续：');
    console.error(`      node summarize-answers.mjs  ${path.basename(OUT)}`);
    console.error(`      node extract-themes-llm.mjs ${path.basename(OUT)}`);
    console.error('\n    确实要重抓（例如产物字段有误、或要补齐 STATE_VERSION）：');
    console.error(`      node fetch-answers-api.mjs ${qid} --force`);
    process.exit(3);
  }
  for (const b of pre.blockers) {
    console.warn(`[i] precheck ${b.kind}: ${b.msg}`);
    (b.detail || []).forEach((d) => console.warn(d));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 加锁：同一问题 ID 不允许两个会话同时抓。
// 这是全流程最贵的一步（3898 条约 6 分钟、396 次请求），重复跑纯浪费。
const lock = acquireLock(OUT, {
  label: `问题 ${qid} 的全量抓取`,
  key: `fetch-q${qid}`,          // 全局键：不同 ZHIHU_QUANT_OUT 也挡得住
  onBusy: () => {
    if (fs.existsSync(OUT)) {
      const n = JSON.parse(fs.readFileSync(OUT, 'utf8')).length;
      console.error(`\n    已有产物: ${OUT}（${n} 条）—— 直接复用即可，不必重抓。`);
    }
    if (fs.existsSync(STATE)) console.error(`    断点续跑状态: ${STATE}`);
  },
});

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
  thanks: it.thanks_count ?? null,   // 感谢：需显式 include；收藏：接口不暴露
  created_at: it.created_time ? new Date(it.created_time * 1000).toISOString() : null,
  updated_at: it.updated_time ? new Date(it.updated_time * 1000).toISOString() : null,
  question_id: String(qid),
  question_title: it.question?.title || '',
  url: `https://www.zhihu.com/question/${qid}/answer/${it.id}`,
  content: stripHtml(it.content),
  // 内容性质标志（故事征集题必用，见 references/content-kind.md）
  answer_type: it.answer_type || 'normal',
  author_type: it.author?.user_type || 'people',
  is_advertiser: !!it.author?.is_advertiser,
});

// 覆盖检查（默认开）：只抓单排序时，抓完 default 再取 created 首屏验证其是否已被覆盖。
// 不适用于 --max-pages 冒烟测试（页面不全，判断无意义）。
const COVER_CHECK = !argv.includes('--no-cover-check') && !MAX_PAGES && SORTS.length === 1 && SORTS[0] === 'default';

let state = { done: {}, items: {}, totals: {}, failed: [] };
if (fs.existsSync(STATE)) { try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE, 'utf8')) }; } catch {} }
const save = () => fs.writeFileSync(STATE, JSON.stringify(state), 'utf8');

// 旧 state 兼容：加字段之前抓的缓存里，每个分页都标了 done，但 item 上没有新字段。
// 如果直接沿用，分页会被跳过 → 新字段永远补不上（表现是「跑完了但 answer_type 全是 undefined」）。
// 所以检测到旧缓存就作废重抓。旧缓存另存一份，便于回滚。
const STATE_VERSION = 2;                       // 1 = 无 answer_type / 机构号字段
if (state.version !== STATE_VERSION && Object.keys(state.items || {}).length) {
  const missing = Object.values(state.items).filter((x) => x.answer_type === undefined).length;
  if (missing) {
    const bak = STATE.replace(/\.state\.json$/, `.state.v${state.version || 1}.bak.json`);
    fs.copyFileSync(STATE, bak);
    console.log(`[!] 检测到旧版缓存（${missing} 条缺 answer_type），作废重抓`);
    console.log(`    旧缓存已备份到 ${path.basename(bak)}`);
    state = { done: {}, items: {}, totals: {}, failed: [] };
  }
}
state.version = STATE_VERSION;
save();

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
// 抽成函数：覆盖检查不通过时要再跑一轮 created 全量。
const T0 = Date.now();
async function runTodo(todo) {
  let ok = 0, fail = 0, cursor = 0;
  const t0 = Date.now();
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
  return { ok, fail };
}
await runTodo(todo);

// ---- 2.5 覆盖检查：created 是否已被 default 覆盖 ----
async function fetchCreatedFully(firstPage) {
  const totals = (firstPage && !firstPage.error && firstPage.paging?.totals) || state.totals.created || 0;
  state.totals.created = totals;
  const pages = totals ? Math.ceil(totals / PAGE) : 0;
  const add = [];
  for (let i = 0; i < pages; i++) {
    add.push({ sort: 'created', offset: i * PAGE, first: i === 0 && firstPage && !firstPage.error ? firstPage : null });
  }
  const todo2 = add.filter((t) => !state.done[`${t.sort}:${t.offset}`]);
  if (!todo2.length) { console.log('  created 全量此前已抓过，无需重复'); return; }
  console.log(`  created 全量：共 ${add.length} 页，待抓 ${todo2.length} 页`);
  await runTodo(todo2);
}

if (COVER_CHECK) {
  process.stdout.write('\n覆盖检查：取 created 排序首屏，验证 default 是否已覆盖它…\n');
  const chk = await fetchPage('created', 0);
  if (chk.error) {
    console.log(`  [!] 覆盖检查未完成（${chk.error}）—— 稳妥起见按旧行为补抓 created`);
    state.coverCheck = { at: new Date().toISOString(), error: chk.error, skipped: false };
    save();
    await fetchCreatedFully(null);
  } else {
    const ids = chk.data.map((it) => String(it.id));
    const missing = ids.filter((id) => !state.items[id]);
    if (!missing.length) {
      console.log(`  通过：created 首屏 ${ids.length} 条全部已在集合内（现有 ${Object.keys(state.items).length} 条，created totals=${chk.paging.totals}）`);
      console.log('  → 跳过 created 全量抓取（省一半请求）。要强制双排序：--sorts both；不要这次检查：--no-cover-check');
      state.coverCheck = { at: new Date().toISOString(), sample: ids.length, missing: 0, skipped: true };
      state.totals.created = chk.paging.totals || state.totals.created;
      save();
    } else {
      console.log(`  [!] created 首屏有 ${missing.length} 条不在 default 集合内（样本 ${missing.slice(0, 3).join(', ')}）`);
      console.log('  → 退回旧行为：补抓 created 全量');
      state.coverCheck = { at: new Date().toISOString(), sample: ids.length, missing: missing.length, skipped: false, sampleIds: missing.slice(0, 5) };
      save();
      await fetchCreatedFully(chk);
    }
  }
}

// ---- 3. 输出 ----
const all = Object.values(state.items).sort((a, b) => (b.votes || 0) - (a.votes || 0));
const el = (Date.now() - T0) / 1000;
const totals = Object.values(state.totals).sort((a, b) => b - a)[0] || 0;
console.log(`\n完成：收 ${all.length} 条（平台 totals=${totals}），失败页 ${state.failed.length}，用时 ${el.toFixed(0)}s`);
if (state.coverCheck?.skipped) console.log('  排序：default 全量 + created 覆盖检查通过（created 未全量抓取）');
if (state.coverCheck && !state.coverCheck.skipped) console.log('  排序：default + created 全量（覆盖检查未通过，已退回旧行为）');
if (all.length < totals) console.log(`  [!] 比 totals 少 ${totals - all.length} 条，可能被平台隐藏/删除，或分页漏页（见 state.failed）`);
const tv = all.reduce((s, d) => s + (d.votes || 0), 0);
const cl = all.reduce((s, d) => s + (d.content || '').length, 0);
console.log(`  赞数合计 ${tv}   正文总字数 ${cl}`);
fs.writeFileSync(OUT, JSON.stringify(all, null, 1), 'utf8');
console.log(`  已写入 ${OUT}`);
if (state.failed.length) console.log('  失败页：' + state.failed.join(' | '));
