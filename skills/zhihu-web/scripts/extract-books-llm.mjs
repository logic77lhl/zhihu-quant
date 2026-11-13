// 书籍推荐抽取器（LLM 版）
//   正则抽取只认《》/引号/词典，会系统性漏掉裸书名（如「以利为利」「转型中的地方政府」）。
//   本脚本用本地网关逐批读全文，抽出「被推荐 / 被劝退」的书，并区分极性。
//
// 用法:
//   node extract-books-llm.mjs <answers-full.json> [--out f.json] [--model M|auto] [--concurrency N] [--budget N]
//   node extract-books-llm.mjs <answers-full.json> --skip-fetch   # 复用已有结果只重新聚合
import fs from 'node:fs';
import path from 'node:path';
import { acquireLock } from './lock.mjs';
import { resolveModel, modelSegmentCompatible } from './llm-model.mjs';

const argv = process.argv.slice(2);
const IN = argv.find((a) => a.endsWith('.json'));
if (!IN) { console.error('用法: node extract-books-llm.mjs <answers-full.json> [--out f.json] [--model M] [--concurrency N] [--budget N]'); process.exit(1); }
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = opt('--out', IN.replace(/-answers-full\.json$/, '') + '-books-llm.json');

// 加锁：并发会话跑同一份数据会白烧 API 调用。
// key 用全局键（系统临时目录），与产物路径无关 —— 换 ZHIHU_QUANT_OUT 也挡得住。
const lock = acquireLock(OUT, {
  label: '书单抽取',
  key: `books-${path.basename(IN, ".json")}`,
  onBusy: () => {
    const st = OUT + '.state.json';
    if (fs.existsSync(st)) {
      try {
        const j = JSON.parse(fs.readFileSync(st, 'utf8'));
        const n = Object.keys(j.perAnswer || {}).length;
        console.error(`\\n    已有断点续跑状态: ${path.basename(st)}（已完成 ${n} 条）—— 重跑会从这里继续。`);
      } catch {}
    }
  },
});
const MODEL = opt('--model', 'auto');   // auto = 探测模型链挑可用的（见 llm-model.mjs）
const EFFORT = opt('--effort', 'none');    // reasoning 档；传 'off' 则完全不带该参数
const CONC = Number(opt('--concurrency', 5));
const BUDGET = Number(opt('--budget', 16000));   // 每批正文总字符预算
const KEY = process.env.WB2API_KEY;
if (!KEY) { console.error('缺少环境变量 WB2API_KEY'); process.exit(1); }
const BASE = process.env.WB2API_BASE || 'http://127.0.0.1:7863/v1';
const { model: MODEL_ID, auto: MODEL_AUTO } = await resolveModel(MODEL, { key: KEY, base: BASE });

const answers = JSON.parse(fs.readFileSync(IN, 'utf8'));
const stateFile = OUT + '.state.json';
let state = { perAnswer: {}, modelTag: null };
const tagModel = MODEL_AUTO ? 'auto' : MODEL_ID;
const modelTag = tagModel + '|' + EFFORT;
if (fs.existsSync(stateFile)) { try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch {} }
// 兼容判断：auto 模式下换了上游不算「模型变了」，沿用已有抽取结果
const suffix = `|${EFFORT}`;
const oldTag = state.modelTag;
const sameShape = typeof oldTag === 'string' && oldTag.endsWith(suffix);
const modelOk = modelSegmentCompatible(oldTag ? String(oldTag).split('|')[0] : '', { requested: MODEL, resolved: MODEL_ID });
if (oldTag && !(sameShape && modelOk)) {
  console.log(`模型/档位已变（${oldTag} -> ${modelTag}），清空旧缓存重跑`);
  state = { perAnswer: {}, modelTag };
} else if (oldTag && oldTag !== modelTag) {
  console.log(`上游模型切换（${String(oldTag).split('|')[0]} -> ${tagModel}），口径未变，沿用已有结果`);
}
state.modelTag = modelTag;
if (MODEL_AUTO) console.log(`模型 ${modelTag}（auto 解析为 ${MODEL_ID}）`);
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chatOnce(messages, max_tokens, temperature, withEffort) {
  const body = { model: MODEL_ID, messages, max_tokens, temperature };
  if (withEffort && EFFORT !== 'off') body.reasoning_effort = EFFORT;
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'api error');
  const m = j.choices?.[0]?.message || {};
  const txt = (m.content || m.reasoning_content || '').trim();
  if (!txt && withEffort) throw new Error('EMPTY_WITH_EFFORT');   // 关 reasoning 时部分模型返回空，需回退
  return txt;
}
async function chat(messages, { max_tokens = 3000, temperature = 0.2, retries = 3 } = {}) {
  let last;
  for (let a = 0; a <= retries; a++) {
    try {
      return await chatOnce(messages, max_tokens, temperature, true);
    } catch (e) {
      if (e.message === 'EMPTY_WITH_EFFORT') {
        console.log(`  [!] ${MODEL_ID} 在 reasoning_effort=${EFFORT} 下返回空，改用不带该参数重试`);
        try { return await chatOnce(messages, max_tokens, temperature, false); }
        catch (e2) { last = e2; await sleep(1500 * (a + 1)); continue; }
      }
      last = e; await sleep(1500 * (a + 1));
    }
  }
  throw last;
}
const stripFence = (s) => s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
function parseJsonLoose(s) {
  const t = stripFence(s);
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('['), b = t.lastIndexOf(']');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}

const SYS = `你在从知乎回答里抽取「书籍推荐」信息。规则：
1. 只抽取**书**（图书/专著/教材）。不要抽章节名、论文、期刊、影视剧、报告、口号或概念词。
2. 同一本书的不同写法要统一成最常见的中文书名（去掉书名号、去掉「作者」等前后缀）。例如「周雪光的中国国家治理的制度逻辑」→「中国国家治理的制度逻辑」。
3. polarity 取值：rec=明确推荐或正面评价；avoid=明确劝退、批评或指出问题；mention=只是顺带提到、无法判断态度。
4. 不要臆造。正文没有出现的书一律不要输出。
5. 只输出 JSON，不要 Markdown 代码块、不要解释。格式：
[{"id":"回答ID","books":[{"title":"书名","author":"作者或空字符串","polarity":"rec"}]}]`;

// ---- 打包 ----
// 极短回答（如正文只有「大国大城」四个字）本身就是一张书名选票，必须一起送进去抽
const targets = answers.filter((a) => (a.content || '').trim().length >= 2)
  .sort((x, y) => (y.votes || 0) - (x.votes || 0));
const batches = [];
let cur = [], curChars = 0;
for (const a of targets) {
  const len = a.content.length;
  if (cur.length && (curChars + len > BUDGET || cur.length >= 20)) { batches.push(cur); cur = []; curChars = 0; }
  cur.push(a); curChars += len;
}
if (cur.length) batches.push(cur);

console.log(`模型 ${modelTag}`);
console.log(`回答 ${answers.length} 条，待抽取 ${targets.length} 条，打包 ${batches.length} 批，并发 ${CONC}\n`);

async function runBatch(batch) {
  const body = batch.map((a) => `### id=${a.id}\n${a.content}`).join('\n\n');
  const out = await chat([
    { role: 'system', content: SYS },
    { role: 'user', content: body + '\n\n请输出 JSON 数组，覆盖上面每一条 id（没有书的回答 books 给空数组）。' },
  ], { max_tokens: 2000 + batch.length * 400 });
  const arr = parseJsonLoose(out);
  if (!Array.isArray(arr)) throw new Error('非 JSON 数组: ' + out.slice(0, 120));
  const got = {};
  for (const it of arr) {
    if (!it || !it.id) continue;
    got[String(it.id)] = (it.books || []).map((b) => ({
      title: String(b.title || '').replace(/[《》「」"'']/g, '').trim(),
      author: String(b.author || '').trim(),
      polarity: ['rec', 'avoid', 'mention'].includes(b.polarity) ? b.polarity : 'mention',
    })).filter((b) => b.title);
  }
  return got;
}

// 批次失败多半是模型输出被 max_tokens 截断（JSON 数组没闭合）。
// 对半拆开重试 —— 与其他三个 LLM 脚本保持一致（实测：超长回答会让整批 15 条全失败）。
async function runBatchSplit(batch, depth = 0) {
  try {
    return await runBatch(batch, depth);
  } catch (e) {
    if (batch.length <= 1 || depth > 4) throw e;
    const mid = Math.ceil(batch.length / 2);
    const [l, r] = await Promise.all([runBatchSplit(batch.slice(0, mid), depth + 1), runBatchSplit(batch.slice(mid), depth + 1)]);
    return { ...l, ...r };
  }
}

const todo = batches.filter((b) => b.some((a) => !state.perAnswer[a.id]));
console.log(`待抽取 ${todo.length}/${batches.length} 批`);
let done = 0, fail = 0;
const t0 = Date.now();
let cursor = 0;
async function worker() {
  while (cursor < todo.length) {
    const batch = todo[cursor++];
    try {
      const got = await runBatchSplit(batch);
      for (const a of batch) state.perAnswer[a.id] = got[a.id] || [];
      done++;
    } catch (e) { fail++; console.log(`  [!] 批失败: ${e.message}`); }
    if ((done + fail) % 5 === 0) { save(); process.stdout.write(`  ${done + fail}/${todo.length} ok=${done} fail=${fail} ${((Date.now() - t0) / 1000).toFixed(0)}s\n`); }
    await sleep(120);
  }
}
await Promise.all(Array.from({ length: CONC }, () => worker()));
save();
console.log(`抽取完成 ok=${done} fail=${fail}\n`);

// ---- 聚合 ----
const norm = (s) => s.replace(/[\s·:：,，.。!！?？—\-()（）\[\]【】]/g, '').toLowerCase();
const isVote = (a) => (a.content || '').trim().length < 40;   // 一句话书名投票
const byKey = new Map();
for (const a of answers) {
  const list = state.perAnswer[a.id];
  if (!list) continue;
  const seen = new Set();
  for (const b of list) {
    const k = norm(b.title);
    if (!k || seen.has(k)) continue;   // 同一回答内同一本书只计一次
    seen.add(k);
    // 短回答里出现的书，本身就是一次推荐（用户只写了书名，没有别的意思）
    const pol = (b.polarity === 'mention' && isVote(a)) ? 'rec' : b.polarity;
    if (!byKey.has(k)) byKey.set(k, { title: b.title, author: b.author, count: 0, rec: 0, avoid: 0, mention: 0, votesSum: 0, logSum: 0, recVotesSum: 0, recLogSum: 0, maxVotes: 0, samples: [] });
    const r = byKey.get(k);
    r.count++;
    r[pol]++;
    r.votesSum += a.votes || 0;
    r.logSum += Math.log10(1 + (a.votes || 0));
    // 「推荐热度」只累计明确推荐该书的回答 —— 否则「被大量回答顺带提及」的书会挤掉真正被推荐的书
    if (pol === 'rec') {
      r.recVotesSum += a.votes || 0;
      r.recLogSum += Math.log10(1 + (a.votes || 0));
    }
    if ((a.votes || 0) > r.maxVotes) r.maxVotes = a.votes || 0;
    if (!r.author && b.author) r.author = b.author;
    r.samples.push({ answerId: String(a.id), url: a.url, author: a.author, votes: a.votes || 0, comments: a.comments || 0, date: (a.created_at || '').slice(0, 10), polarity: pol });
  }
}

// 合并同书异名：一个规范名是另一个的后缀（且长度≥4）时合并到更长的那个
const aliasByNorm = new Map();   // 规范名(归一化) -> 正式书名，用于把回答里的书名映射到排行里的同一本
const keys = [...byKey.keys()];
for (const short of keys) {
  if (!byKey.has(short) || short.length < 4) continue;
  for (const long of keys) {
    if (short === long || !byKey.has(long)) continue;
    if (long.endsWith(short)) {
      const s = byKey.get(short), l = byKey.get(long);
      l.count += s.count; l.rec += s.rec; l.avoid += s.avoid; l.mention += s.mention;
      l.votesSum += s.votesSum; l.logSum += s.logSum; l.maxVotes = Math.max(l.maxVotes, s.maxVotes);
      l.recVotesSum += s.recVotesSum; l.recLogSum += s.recLogSum;
      l.samples.push(...s.samples);
      aliasByNorm.set(short, l.title);
      byKey.delete(short);
      break;
    }
  }
}
for (const [k, r] of byKey) if (!aliasByNorm.has(k)) aliasByNorm.set(k, r.title);
const canonTitle = (t) => aliasByNorm.get(norm(t)) || t;

// 每条回答推荐了哪些书（规范名 + 态度），供页面做「书 ↔ 回答」双向联动
const perAnswer = {};
for (const a of answers) {
  const list = state.perAnswer[a.id];
  if (!list) continue;
  const m = new Map();
  for (const b of list) {
    const t = canonTitle(b.title);
    const pol = (b.polarity === 'mention' && isVote(a)) ? 'rec' : b.polarity;
    if (!m.has(t) || (m.get(t) === 'mention' && pol !== 'mention')) m.set(t, pol);
  }
  if (m.size) perAnswer[a.id] = [...m].map(([title, polarity]) => ({ title, polarity }));
}

const books = [...byKey.values()]
  .map((r) => ({ ...r, logSum: Number(r.logSum.toFixed(2)), recLogSum: Number(r.recLogSum.toFixed(2)), samples: r.samples.sort((a, b) => b.votes - a.votes) }))
  .sort((a, b) => b.recLogSum - a.recLogSum || b.rec - a.rec);

const withRec = books.filter((b) => b.rec >= 1);
console.log(`抽出书名 ${books.length} 个（其中被明确推荐过的 ${withRec.length} 个）`);
console.log('TOP 15（按推荐热度）:');
books.slice(0, 15).forEach((b, i) => console.log(`  ${String(i + 1).padStart(2)}. ${b.title.padEnd(22)} 推荐${String(b.rec).padStart(2)} 劝退${String(b.avoid).padStart(2)} 提及${String(b.count).padStart(2)} 推荐热度${String(b.recLogSum).padStart(6)}`));

fs.writeFileSync(OUT, JSON.stringify({
  model: modelTag, resolvedModel: MODEL_ID, question: answers[0]?.question_title || '', generatedAt: new Date().toISOString(),
  books,
  perAnswer,
  stats: { answers: answers.length, extracted: targets.length, books: books.length, recommended: withRec.length, failed: fail },
}, null, 1), 'utf8');
console.log(`\n已写入 ${OUT}`);
