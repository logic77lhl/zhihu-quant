// 观点/主张抽取器（LLM）
//   适用「为什么…」「如何看待…」这类观点讨论题：正则抽不出观点，书单也不适用。
//
// 两步：
//   A. 归纳分类体系：取高赞回答的要点，让模型归纳出 10-16 个互斥的核心观点标签
//   B. 逐条打标：每条回答从这套标签里选 1-3 个
//   最后按「被多少条回答主张 + 赞数加权」排序，供页面做「观点 ↔ 回答」双向联动。
//
// 用法:
//   node extract-themes-llm.mjs <answers-full.json> [--summaries s.json] [--out o.json]
//                                [--model M] [--concurrency N] [--taxonomy-sample N] [--rebuild-taxonomy]
//                                [--profile default|stories]
//
// --profile stories：用于「有哪些……故事」类征集题。
//   标签归纳的提示词从「核心观点/主张」换成「关系原型 + 结局形态」，
//   否则模型会给读书题那套「原因解释 vs 解决方案」的口径，标签没法用。
import fs from 'node:fs';
import path from 'node:path';
import { acquireLock } from './lock.mjs';
import { resolveModel, modelSegmentCompatible } from './llm-model.mjs';

const argv = process.argv.slice(2);
const IN = argv.find((a) => a.endsWith('.json'));
if (!IN) { console.error('用法: node extract-themes-llm.mjs <answers-full.json> [--summaries s.json] [--out o.json]'); process.exit(1); }
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const numOpt = (f, d) => Number(opt(f, d));
const base = IN.replace(/-answers-full\.json$/, '');
const SUM = opt('--summaries', base + '-summaries.json');
const OUT = opt('--out', base + '-themes.json');

// 加锁：并发会话跑同一份数据会白烧 API 调用。
// key 用全局键（系统临时目录），与产物路径无关 —— 换 ZHIHU_QUANT_OUT 也挡得住。
const lock = acquireLock(OUT, {
  label: '观点/母题打标',
  key: `themes-${path.basename(IN, ".json")}`,
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
const PROFILE = opt('--profile', 'default');
const CONC = numOpt('--concurrency', 5);
const TAX_SAMPLE = numOpt('--taxonomy-sample', 400);
const REBUILD = argv.includes('--rebuild-taxonomy');
const KEY = process.env.WB2API_KEY;
if (!KEY) { console.error('缺少环境变量 WB2API_KEY'); process.exit(1); }
const BASE = process.env.WB2API_BASE || 'http://127.0.0.1:7863/v1';
const { model: MODEL_ID, auto: MODEL_AUTO } = await resolveModel(MODEL, { key: KEY, base: BASE });

const answers = JSON.parse(fs.readFileSync(IN, 'utf8'));
const summaries = fs.existsSync(SUM) ? JSON.parse(fs.readFileSync(SUM, 'utf8')) : null;
const sumOf = (id) => summaries?.perAnswer?.[id] || '';
const stateFile = OUT + '.state.json';
const tagModel = MODEL_AUTO ? 'auto' : MODEL_ID;
const modelTag = tagModel + '|' + EFFORT + '|' + PROFILE;
let state = { taxonomy: null, perAnswer: {}, modelTag: null };
if (fs.existsSync(stateFile)) { try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch {} }
// 兼容判断：auto 模式下换了上游（global → cn）不算「模型变了」，沿用已打好的标签
const suffix = `|${EFFORT}|${PROFILE}`;
const oldTag = state.modelTag;
const sameShape = typeof oldTag === 'string' && oldTag.endsWith(suffix);
const modelOk = modelSegmentCompatible(oldTag ? String(oldTag).split('|')[0] : '', { requested: MODEL, resolved: MODEL_ID });
if (oldTag && !(sameShape && modelOk)) {
  console.log(`模型/档位已变（${oldTag} -> ${modelTag}），清空旧缓存重跑`);
  state = { taxonomy: null, perAnswer: {}, modelTag };
} else if (oldTag && oldTag !== modelTag) {
  console.log(`上游模型切换（${String(oldTag).split('|')[0]} -> ${tagModel}），口径未变，沿用已有标签`);
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
async function chat(messages, { max_tokens = 3000, temperature = 0.3, retries = 3 } = {}) {
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
  for (const [open, close] of [['[', ']'], ['{', '}']]) {
    const a = t.indexOf(open), b = t.lastIndexOf(close);
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  }
  return null;
}

// 每条回答喂给模型的文本：优先用已生成的要点，没有就用正文开头
const feedText = (a) => {
  const s = sumOf(a.id);
  if (s) return s;
  return (a.content || '').replace(/\s+/g, ' ').slice(0, 600);
};

// ---- A. 归纳标签体系 ----
if (REBUILD) state.taxonomy = null;
if (!state.taxonomy) {
  const sample = [...answers].sort((x, y) => (y.votes || 0) - (x.votes || 0))
    .filter((a) => feedText(a).length >= 12).slice(0, TAX_SAMPLE);
  console.log(`归纳标签体系（取样 ${sample.length} 条高赞回答）...`);
  const body = sample.map((a, i) => `${i + 1}. [赞${a.votes || 0}] ${feedText(a)}`).join('\n');
  const sysDefault = '你在归纳一个知乎问题下回答者们的核心观点。'
    + '请把下面这些回答的要点，归纳成 12~16 个**互斥且有区分度**的观点/主张标签。要求：\n'
    + '1. name 不超过 14 个字，必须具体、能一眼看懂在说什么，禁止「读书方法」「个人成长」「心态问题」这类笼统词；\n'
    + '2. desc 一句话解释这个标签覆盖哪类回答；\n'
    + '3. 标签要能区分「原因解释」和「解决方案」；\n'
    + '4. 只输出 JSON，不要 Markdown 代码块：{"themes":[{"id":"T1","name":"...","desc":"..."}]}';

  const sysStories = '你在归纳一个知乎「故事征集」问题下（问题：' + (answers[0]?.question_title || '').replace(/[{}"]/g, '') + '）'
    + '这些亲身叙事回答的**母题**。请把下面这些故事要点，归纳成 12~16 个**互斥且有区分度**的故事类型标签。要求：\n'
    + '1. name 不超过 14 个字，描述的是这类故事的**关系形态或结局形态**，'
    + '   例如「多年暗恋不敢说」「重逢已各自成家」「双向错过一步之遥」「对方早已离开」。'
    + '   禁止「青春」「遗憾」「回忆」这类无区分度的笼统词；\n'
    + '2. 同一维度内不要互相包含：一个故事若同时符合两个标签，选更具体、更能刻画转折的那个；\n'
    + '3. 标签要能区分「关系起点」（怎么开始的：同桌、青梅竹马、网友、异地……）'
    + '与「结局形态」（最后怎么了：在一起、错过、重逢、无疾而终……）；\n'
    + '4. desc 一句话说明这个标签覆盖哪类故事，并指出它最心酸的点是什么；\n'
    + '5. 只输出 JSON，不要 Markdown 代码块：{"themes":[{"id":"T1","name":"...","desc":"..."}]}';

  const sys = PROFILE === 'stories' ? sysStories : sysDefault;
  const out = await chat([
    { role: 'system', content: sys },
    { role: 'user', content: `问题：${answers[0]?.question_title || ''}\n\n回答要点：\n${body}` },
  ], { max_tokens: 2600, temperature: 0.4 });
  const d = parseJsonLoose(out);
  const themes = d?.themes || (Array.isArray(d) ? d : null);
  if (!themes || !themes.length) { console.error('标签体系解析失败: ' + out.slice(0, 300)); process.exit(1); }
  state.taxonomy = themes.map((t, i) => ({ id: String(t.id || `T${i + 1}`), name: String(t.name || '').trim(), desc: String(t.desc || '').trim() }))
    .filter((t) => t.name);
  save();
  console.log('  得到 ' + state.taxonomy.length + ' 个标签：');
  state.taxonomy.forEach((t) => console.log(`    ${t.id} ${t.name} — ${t.desc}`));
  console.log('');
}

// ---- B. 逐条打标 ----
const TAX = state.taxonomy.map((t) => `${t.id} ${t.name}：${t.desc}`).join('\n');
const targets = answers.filter((a) => feedText(a).length >= 8);
const BUDGET = 14000, MAXN = 25;
const batches = [];
let cur = [], curChars = 0;
for (const a of targets) {
  const L = feedText(a).length;
  if (cur.length && (curChars + L > BUDGET || cur.length >= MAXN)) { batches.push(cur); cur = []; curChars = 0; }
  cur.push(a); curChars += L;
}
if (cur.length) batches.push(cur);

const SYS = PROFILE === 'stories'
  ? `你在给知乎「故事征集」问题的回答按故事类型打标签。可选标签如下（只能从中选，不能新造）：\n${TAX}\n\n`
    + '对每一条故事，选出 1~3 个**最能刻画这个故事**的标签，优先选转折点和结局形态对应的标签。'
    + '若这条只是简短感慨、抖机灵、推销、或与问题无关，themes 给空数组。'
    + '只输出 JSON 数组，不要 Markdown 代码块：[{"id":"回答ID","themes":["T1","T4"]}]'
  : `你在给知乎回答按观点打标签。可选标签如下（只能从中选，不能新造）：\n${TAX}\n\n`
    + '对每条回答，选出 1~3 个**最主要**的标签。若回答只是简短赞同/调侃/无实质观点，themes 给空数组。'
    + '只输出 JSON 数组，不要 Markdown 代码块：[{"id":"回答ID","themes":["T1","T4"]}]';

const valid = new Set(state.taxonomy.map((t) => t.id));

async function tagBatch(batch, depth = 0) {
  const body = batch.map((a) => `### id=${a.id}\n${feedText(a)}`).join('\n\n');
  try {
    const out = await chat([{ role: 'system', content: SYS }, { role: 'user', content: body }],
      { max_tokens: 800 + batch.length * 70 });
    const arr = parseJsonLoose(out);
    if (!Array.isArray(arr)) throw new Error('非 JSON 数组: ' + out.slice(0, 100));
    for (const it of arr) {
      if (!it || !it.id) continue;
      state.perAnswer[String(it.id)] = (it.themes || []).map(String).filter((x) => valid.has(x));
    }
  } catch (e) {
    // 失败多半是输出被 max_tokens 截断（JSON 数组没闭合）。对半拆开重试，
    // 否则同一批每次重跑都会以同样方式失败，永远补不上。
    if (batch.length <= 1 || depth > 4) throw e;
    const mid = Math.ceil(batch.length / 2);
    await tagBatch(batch.slice(0, mid), depth + 1);
    await tagBatch(batch.slice(mid), depth + 1);
  }
}

const todo = batches.filter((b) => b.some((a) => !state.perAnswer[a.id]));
console.log(`逐条打标：待处理 ${todo.length}/${batches.length} 批，并发 ${CONC}`);
let done = 0, fail = 0;
const t0 = Date.now();
let cursor = 0;
// 命中上游 429/5xx 的批次延后重打一次（多数是瞬时抖动，见 summarize-answers.mjs 同款注释）
const RETRY_WAIT_MS = 5000;
const upstreamErr = (e) => /HTTP (429|5\d\d)/.test(e.message || '');
const deferred = [];
async function processBatch(batch) {
  await tagBatch(batch);
  for (const a of batch) if (!(a.id in state.perAnswer)) state.perAnswer[a.id] = [];
}
async function worker() {
  while (cursor < todo.length) {
    const batch = todo[cursor++];
    try {
      await processBatch(batch);
      done++;
    } catch (e) {
      if (upstreamErr(e)) { deferred.push(batch); console.log(`  [~] 批命中上游限额（${e.message}），延后重试`); }
      else { fail++; console.log(`  [!] 批失败: ${e.message}`); }
    }
    if ((done + fail) % 10 === 0) { save(); process.stdout.write(`  ${done + fail}/${todo.length} ok=${done} fail=${fail} ${((Date.now() - t0) / 1000).toFixed(0)}s\n`); }
    await sleep(100);
  }
}
await Promise.all(Array.from({ length: CONC }, () => worker()));
if (deferred.length) {
  console.log(`\n收尾重试 ${deferred.length} 个批（上游 429/5xx，等 ${RETRY_WAIT_MS / 1000}s）…`);
  await sleep(RETRY_WAIT_MS);
  let c2 = 0;
  async function retryWorker() {
    while (c2 < deferred.length) {
      const batch = deferred[c2++];
      try { await processBatch(batch); done++; }
      catch (e) { fail++; console.log(`  [!] 批重试仍失败: ${e.message}`); }
      await sleep(100);
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => retryWorker()));
}
save();
console.log(`打标完成 ok=${done} fail=${fail}，覆盖 ${Object.keys(state.perAnswer).length} 条\n`);

// ---- C. 聚合 ----
const byId = new Map();
for (const t of state.taxonomy) byId.set(t.id, { ...t, count: 0, votesSum: 0, logSum: 0, maxVotes: 0, samples: [] });
for (const a of answers) {
  for (const tid of state.perAnswer[a.id] || []) {
    const r = byId.get(tid);
    if (!r) continue;
    r.count++;
    r.votesSum += a.votes || 0;
    r.logSum += Math.log10(1 + (a.votes || 0));
    if ((a.votes || 0) > r.maxVotes) r.maxVotes = a.votes || 0;
    r.samples.push({
      answerId: String(a.id), url: a.url, author: a.author, votes: a.votes || 0,
      comments: a.comments || 0, date: (a.created_at || '').slice(0, 10), summary: sumOf(a.id),
    });
  }
}
const themes = [...byId.values()]
  .map((r) => ({ ...r, logSum: Number(r.logSum.toFixed(2)), samples: r.samples.sort((a, b) => b.votes - a.votes) }))
  .filter((t) => t.count > 0)
  .sort((a, b) => b.logSum - a.logSum);

console.log('观点排行（按阻尼热度）:');
themes.forEach((t, i) => console.log(`  ${String(i + 1).padStart(2)}. ${t.name.padEnd(18)} ${String(t.count).padStart(4)} 条  热度 ${String(t.logSum).padStart(6)}  最高赞 ${t.maxVotes}`));

fs.writeFileSync(OUT, JSON.stringify({
  model: modelTag, resolvedModel: MODEL_ID, question: answers[0]?.question_title || '', generatedAt: new Date().toISOString(),
  taxonomy: state.taxonomy, themes, perAnswer: state.perAnswer,
  stats: { answers: answers.length, tagged: targets.length, themes: themes.length, failed: fail },
}, null, 1), 'utf8');
console.log(`\n已写入 ${OUT}`);
