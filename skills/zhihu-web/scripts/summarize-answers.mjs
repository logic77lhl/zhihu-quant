// 回答摘要器：批量调用本地 OpenAI 兼容网关，为每条回答生成要点摘要，并产出全局综述
//
// 用法:
//   node summarize-answers.mjs <answers-full.json> [--out f.json] [--model M|auto] [--concurrency N]
//                               [--min-chars N] [--digest-top N] [--only-digest] [--only-per-answer]
//
// 设计要点:
//   - 网关是本地 workbuddy2api (127.0.0.1:7863)，密钥走环境变量 WB2API_KEY
//   - --model 默认 auto：探测模型链挑可用的（global: 限额时自动走 cn:），见 llm-model.mjs
//   - 短回答（正文 < --min-chars）不值得摘要，直接跳过
//   - 按字符预算打包，一次请求塞多条回答，模型返回 JSON 数组，按 id 回填
//   - 断点续跑：state 落在 <out>.state.json
//   - --profile 决定提示词口径：
//       default（默认）面向读书/推荐类问题，综述按「派别 / 共识 / 入门阅读顺序」组织
//       stories  面向「有哪些……故事」类征集题，综述按「母题 / 结局分岔 / 值得先读的故事」组织
import fs from 'node:fs';
import path from 'node:path';
import { acquireLock } from './lock.mjs';
import { resolveModel, modelSegmentCompatible } from './llm-model.mjs';

const argv = process.argv.slice(2);
const IN = argv.find((a) => a.endsWith('.json'));
if (!IN) {
  console.error('用法: node summarize-answers.mjs <answers-full.json> [--out f.json] [--model M] [--concurrency N] [--min-chars N] [--digest-top N] [--profile default|stories]');
  process.exit(1);
}
const opt = (flag, def) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const numOpt = (flag, def) => Number(opt(flag, def));
const OUT = opt('--out', IN.replace(/-answers-full\.json$/, '') + '-summaries.json');

// 加锁：并发会话跑同一份数据会白烧 API 调用。
// key 用全局键（系统临时目录），与产物路径无关 —— 换 ZHIHU_QUANT_OUT 也挡得住。
const lock = acquireLock(OUT, {
  label: '逐条摘要',
  key: `summarize-${path.basename(IN, ".json")}`,
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
const MIN_CHARS = numOpt('--min-chars', 80);
const DIGEST_TOP = numOpt('--digest-top', 40);
const ONLY_DIGEST = argv.includes('--only-digest');
const ONLY_PER = argv.includes('--only-per-answer');
const REBUILD_DIGEST = argv.includes('--rebuild-digest');
const KEY = process.env.WB2API_KEY;
const BASE = process.env.WB2API_BASE || 'http://127.0.0.1:7863/v1';
if (!KEY) { console.error('缺少环境变量 WB2API_KEY'); process.exit(1); }
// 解析实际要调的模型：显式 --model 原样返回；auto 则探测模型链（结果缓存 10 分钟）
const { model: MODEL_ID, auto: MODEL_AUTO } = await resolveModel(MODEL, { key: KEY, base: BASE });

const answers = JSON.parse(fs.readFileSync(IN, 'utf8'));
const stateFile = OUT + '.state.json';
// 剔除口径在整份脚本里只算一次，避免两处定义漂移。
const EXCLUDE_PAID = argv.includes('--exclude-paid');
const EXCLUDE_KIND = (opt('--exclude-kind', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const excludeTag = (EXCLUDE_PAID ? 'nopaid' : 'all') + '|' + (EXCLUDE_KIND.join(',') || 'nokind');
// 逐条摘要只依赖「模型 + 档位 + profile」，与剔除范围无关 —— 所以 modelTag 不含剔除项，
// 换 --exclude-paid 时不必重跑几百批摘要。
// 综述（digest）才依赖剔除范围，单独用 digestTag 判定，不一致只重建综述。
const tagModel = MODEL_AUTO ? 'auto' : MODEL_ID;
const modelTag = tagModel + '|' + EFFORT + '|' + PROFILE;
const digestTag = modelTag + '|' + excludeTag;
let state = { perAnswer: {}, digest: null, digests: {}, digestTag: null, modelTag: null };
if (fs.existsSync(stateFile)) { try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch {} }
// 兼容判断：auto 模式下换了上游（global → cn）不算「模型变了」，沿用已生成的摘要 ——
// 否则上游一限额，几百批摘要就会全部作废重算。
const suffix = `|${EFFORT}|${PROFILE}`;
const oldTag = state.modelTag;
const sameShape = typeof oldTag === 'string' && oldTag.endsWith(suffix);
const modelOk = modelSegmentCompatible(oldTag ? String(oldTag).split('|')[0] : '', { requested: MODEL, resolved: MODEL_ID });
if (oldTag && !(sameShape && modelOk)) {
  console.log(`模型/档位/题型已变（${oldTag} -> ${modelTag}），清空旧缓存重跑`);
  state = { perAnswer: {}, digest: null, digests: {}, digestTag: null, modelTag };
} else if (oldTag && oldTag !== modelTag) {
  console.log(`上游模型切换（${String(oldTag).split('|')[0]} -> ${tagModel}），提示词口径未变，沿用已生成的摘要`);
}
state.modelTag = modelTag;
// 综述按口径分别缓存，key 只用「剔除口径」本身 —— 不带模型前缀。
// 带前缀的话渲染端无法按口径查找（实测踩过：key 是 `模型|all|nokind`，
// 渲染端算的是 `all|nokind`，匹配失败后静默回落到「最后生成的那份」，
// 于是两个页面显示同一份综述）。模型信息已单独记录在文件顶层。
state.digests = state.digests || {};
const cachedDigest = state.digests[excludeTag] || (state.digestTag === digestTag ? state.digest : null);
if (cachedDigest) {
  state.digest = cachedDigest;
  state.digestTag = digestTag;
} else if (state.digest && state.digestTag !== digestTag) {
  console.log(`综述口径 ${excludeTag} 尚未生成，将重建（逐条摘要沿用缓存）`);
  state.digest = null;
}
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
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  const msg = j.choices?.[0]?.message || {};
  const txt = (msg.content || msg.reasoning_content || '').trim();
  // 部分模型在 reasoning_effort 关闭时会 HTTP 200 但返回空（tokens 0/0），必须回退
  if (!txt && withEffort) throw new Error('EMPTY_WITH_EFFORT');
  return txt;
}

async function chat(messages, { max_tokens = 2000, temperature = 0.3, retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await chatOnce(messages, max_tokens, temperature, true);
    } catch (e) {
      if (e.message === 'EMPTY_WITH_EFFORT') {
        console.log(`  [!] ${MODEL_ID} 在 reasoning_effort=${EFFORT} 下返回空，改用不带该参数重试`);
        try { return await chatOnce(messages, max_tokens, temperature, false); }
        catch (e2) { lastErr = e2; await sleep(1200 * (attempt + 1)); continue; }
      }
      lastErr = e;
      await sleep(1200 * (attempt + 1));
    }
  }
  throw lastErr;
}

const stripFence = (s) => s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
function parseJsonLoose(s) {
  const t = stripFence(s);
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('['), b = t.lastIndexOf(']');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  const c = t.indexOf('{'), d = t.lastIndexOf('}');
  if (c >= 0 && d > c) { try { return JSON.parse(t.slice(c, d + 1)); } catch {} }
  return null;
}

// ---- 1. 打包：按字符预算把回答分组 ----
const targets = answers
  .filter((a) => (a.content || '').trim().length >= MIN_CHARS)
  .sort((x, y) => (y.votes || 0) - (x.votes || 0));

const BUDGET = 7000, MAXN = 20;
const batches = [];
let cur = [], curChars = 0;
for (const a of targets) {
  const len = a.content.length;
  if (cur.length && (curChars + len > BUDGET || cur.length >= MAXN)) { batches.push(cur); cur = []; curChars = 0; }
  cur.push(a); curChars += len;
}
if (cur.length) batches.push(cur);

console.log(`模型 ${modelTag}${MODEL_AUTO ? `（auto 解析为 ${MODEL_ID}）` : ''}`);
console.log(`回答 ${answers.length} 条，其中正文 ≥ ${MIN_CHARS} 字待摘要 ${targets.length} 条`);
console.log(`打包为 ${batches.length} 批，并发 ${CONC}\n`);

const SYS_STORIES = '你是中文内容编辑。用户会给你若干条知乎回答（编号 + 正文），它们大多是亲身讲述的个人故事。'
  + '请为每一条写一句要点摘要，要求：'
  + '①不超过 55 字；②说清「谁与谁、因为什么事、最后怎么样了」，尤其是那个让人心酸的点；'
  + '③保留具体的细节名词（地名、物件、时间跨度、那句关键的话），不要抽象概括；'
  + '④不要写「作者讲述了一个故事」这类空话；⑤只输出 JSON 数组，不要任何解释或 Markdown 代码块。';

const SYS_DEFAULT = '你是中文内容编辑。用户会给你若干条知乎回答（编号 + 正文）。请为每一条写一句要点摘要，'
  + '要求：①不超过 55 字；②说清这条回答「推荐了什么 / 核心主张是什么」，不要写「本文介绍了」这类空话；'
  + '③保留具体书名、作者、概念等关键名词；④只输出 JSON 数组，不要任何解释或 Markdown 代码块。';

const SYS = PROFILE === 'stories' ? SYS_STORIES : SYS_DEFAULT;

// ---- 可选：摘要与内容性质判定合并成一次遍历 ----
// ⚠️ **实测不推荐**。同一份 40 条标注样本上的 A/B：
//     独立判定（classify-content-llm.mjs） 39/40 = 97.5%
//     合并判定（本开关）                   19/28 = 67.9%   ← 差 29.6 个百分点
//   8 条不一致全部是「把小说/改编误判成真实经历」—— 模型的主任务变成写摘要后，
//   会把一切都当成「要总结的故事」，不再做批判性判断。摘要长度没受影响（48 vs 49 字）。
//   所以保留这个开关只为记录该实验的结论，**默认关闭，不要在生产流程里打开**。
//   实测数据见 references/content-kind.md 第 8 节。
const WITH_KIND = argv.includes('--with-kind');
const KIND_RULE = '\n另外，为每一条判断内容性质 kind，取值只能是：'
  + 'real（作者本人亲身经历）/ fiction（虚构小说创作）/ adapted（改编自他人经历·他人作品·影视剧，或基于真实原型）/ '
  + 'offtopic（与问题无关，或只是抖机灵、推销、引流）。'
  + '判断要点：「用 1.2.3. 分条列举」不等于小说，真人也常这样写；'
  + '有【完结】【未完结慎入】等连载标记的基本是 fiction；'
  + '出现「盐选」「未经允许不得转载」「首发于」且故事线完整的多为 fiction/adapted；'
  + '正文自称「由真实事件改编」的算 adapted。';
const SYS_KIND = WITH_KIND
  ? SYS.replace(/⑤只输出 JSON 数组[^。]*。/, '⑤') + KIND_RULE
    + ' 输出 JSON 数组，形如 [{"id":"...","summary":"...","kind":"real"}]，覆盖上面每一条 id。'
  : null;

// 单条正文可能远超 BUDGET（如 12000 字的长故事），单批必然超出 max_tokens 被截断。
// 所以批内先按 SINGLE_CAP 截断喂给模型；这里只保证「不至于把请求撑爆」。
const SINGLE_CAP = 6000;
const clip = (s) => (s.length > SINGLE_CAP ? s.slice(0, SINGLE_CAP) : s);

async function runBatch(batch, bi) {
  const parts = batch.map((a) => `### id=${a.id} 作者=${a.author || ''} 赞=${a.votes || 0}\n${clip(a.content)}`).join('\n\n');
  const ask = WITH_KIND
    ? '\n\n请输出 JSON 数组，形如 [{"id":"...","summary":"...","kind":"real"}]，覆盖上面每一条 id。'
    : '\n\n请输出 JSON 数组，形如 [{"id":"...","summary":"..."}]，覆盖上面每一条 id。';
  const out = await chat([
    { role: 'system', content: WITH_KIND ? SYS_KIND : SYS },
    { role: 'user', content: parts + ask },
  ], { max_tokens: 1500 + batch.length * (WITH_KIND ? 260 : 220) });
  const arr = parseJsonLoose(out);
  if (!Array.isArray(arr)) throw new Error('非 JSON 数组: ' + out.slice(0, 120));
  const got = {};
  const kinds = {};
  for (const it of arr) {
    if (!it || !it.id) continue;
    const id = String(it.id);
    got[id] = String(it.summary || '').trim();
    if (WITH_KIND && it.kind) {
      // 枚举值会被 token 截断（offtopic → ofstof），按前缀归一到四个标准值
      const k = String(it.kind).trim();
      const norm = /^(re|真实)/i.test(k) ? 'real'
        : /^(fi|虚构|小说)/i.test(k) ? 'fiction'
        : /^(ad|改编)/i.test(k) ? 'adapted'
        : /^(o|无关)/i.test(k) ? 'offtopic' : '';
      if (norm) kinds[id] = norm;
    }
  }
  return WITH_KIND ? { summary: got, kind: kinds } : got;
}

// 批次失败多半是模型输出被 max_tokens 截断（JSON 数组没闭合）。
// 对半拆开重试：超长回答会各自落到单条批次，再靠 SINGLE_CAP 截断兜住。
// 只在真的缺摘要时才递归，避免成功的结果被反复重算。
async function runBatchSplit(batch, depth = 0) {
  try {
    return await runBatch(batch, depth);
  } catch (e) {
    if (batch.length <= 1 || depth > 4) throw e;
    const mid = Math.ceil(batch.length / 2);
    const [l, r] = await Promise.all([runBatchSplit(batch.slice(0, mid), depth + 1), runBatchSplit(batch.slice(mid), depth + 1)]);
    if (!WITH_KIND) return { ...l, ...r };
    return { summary: { ...l.summary, ...r.summary }, kind: { ...l.kind, ...r.kind } };
  }
}

// ---- 2. 逐条摘要 ----
if (!ONLY_DIGEST) {
  const todo = batches.map((b, i) => [b, i]).filter(([b]) => b.some((a) => !state.perAnswer[a.id]));
  console.log(`逐条摘要：待处理 ${todo.length}/${batches.length} 批${WITH_KIND ? '（含内容性质判定）' : ''}`);
  let done = 0, fail = 0;
  const t0 = Date.now();
  let cursor = 0;
  // 命中上游 429/5xx 的批次延后重打一次，而不是直接算失败。
  // 依据（2026-10-16 实测）：12 批的题两次跑各坏 1 批（一次 503、一次输出截断），
  // 手动重跑 2 秒就补上——说明多数失败是上游瞬时抖动，延后重试即可，
  // 不必为一条摘要让整轮手工补跑（大题上省一次十几分钟的流程）。
  const RETRY_WAIT_MS = 5000;
  const upstreamErr = (e) => /HTTP (429|5\d\d)/.test(e.message || '');
  const deferred = [];
  async function processBatch(batch) {
    const res = await runBatchSplit(batch);
    const got = WITH_KIND ? res.summary : res;
    for (const a of batch) if (got[a.id]) state.perAnswer[a.id] = got[a.id];
    if (WITH_KIND) {
      state.kinds = state.kinds || {};
      for (const a of batch) if (res.kind[a.id]) state.kinds[a.id] = res.kind[a.id];
    }
  }
  async function worker() {
    while (cursor < todo.length) {
      const [batch, bi] = todo[cursor++];
      try {
        await processBatch(batch);
        done++;
      } catch (e) {
        if (upstreamErr(e)) { deferred.push([batch, bi]); console.log(`  [~] 批 ${bi} 命中上游限额（${e.message}），延后重试`); }
        else { fail++; console.log(`  [!] 批 ${bi} 失败: ${e.message}`); }
      }
      if ((done + fail) % 5 === 0) { save(); process.stdout.write(`  ${done + fail}/${todo.length}  ok=${done} fail=${fail}  ${((Date.now() - t0) / 1000).toFixed(0)}s\n`); }
      await sleep(120);
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));
  if (deferred.length) {
    console.log(`\n收尾重试 ${deferred.length} 个批（上游 429/5xx，等 ${RETRY_WAIT_MS / 1000}s）…`);
    await sleep(RETRY_WAIT_MS);
    let c2 = 0;
    async function retryWorker() {
      while (c2 < deferred.length) {
        const [batch, bi] = deferred[c2++];
        try { await processBatch(batch); done++; }
        catch (e) { fail++; console.log(`  [!] 批 ${bi} 重试仍失败: ${e.message}`); }
        await sleep(120);
      }
    }
    await Promise.all(Array.from({ length: CONC }, () => retryWorker()));
  }
  save();
  console.log(`逐条摘要完成 ok=${done} fail=${fail}，覆盖 ${Object.keys(state.perAnswer).length}/${targets.length} 条\n`);
  if (WITH_KIND) {
    const k = state.kinds || {};
    const dist = Object.values(k).reduce((m, v) => (m[v] = (m[v] || 0) + 1, m), {});
    console.log(`内容性质（同批判定）覆盖 ${Object.keys(k).length}/${targets.length} 条: ${JSON.stringify(dist)}\n`);
  }
}

// ---- 3. 全局综述 ----
// --exclude-paid / --exclude-kind：综述必须基于「剔完之后」的回答来生成。
// 否则会出现「正文榜单已剔除盐选、但综述还在引用那几条被剔除的高赞回答」——
// 实测原版综述的「值得先读的故事」第 4 条就是一条 2519 赞的严选小说，
// 而那 22 条严选吃掉了 Top100 赞数的 45%。
const KIND_FILE = opt('--kind', IN.replace(/-answers-full\.json$/, '') + '-content-kind.json');
const kindMap = EXCLUDE_KIND.length && fs.existsSync(KIND_FILE)
  ? (JSON.parse(fs.readFileSync(KIND_FILE, 'utf8')).perAnswer || {}) : {};
if (EXCLUDE_KIND.length && !fs.existsSync(KIND_FILE)) console.error(`  [!] --exclude-kind 需要 ${KIND_FILE}，未找到，该开关被忽略`);
// answer_type 有三个取值：normal / paid / paid_column_content。任何非 normal 都算付费内容。
const isPaidAnswer = (a) => !!a.answer_type && a.answer_type !== 'normal';
const digestPool = answers.filter((a) => {
  if (EXCLUDE_PAID && isPaidAnswer(a)) return false;
  if (EXCLUDE_KIND.length && EXCLUDE_KIND.includes((kindMap[String(a.id)] || {}).kind)) return false;
  return true;
});
const excluded = answers.length - digestPool.length;
if (excluded) console.log(`综述口径：已剔除 ${excluded} 条（${answers.length} → ${digestPool.length}）\n`);

if (REBUILD_DIGEST) state.digest = null;
if (!ONLY_PER && !state.digest) {
  console.log('生成全局综述 ...');
  const top = [...digestPool].sort((x, y) => (y.votes || 0) - (x.votes || 0)).slice(0, DIGEST_TOP);
  const feed = top.map((a, i) => {
    const c = (a.content || '').slice(0, 1600);
    const s = state.perAnswer[a.id] ? `（要点：${state.perAnswer[a.id]}）` : '';
    return `【${i + 1}】赞${a.votes || 0} 作者${a.author || ''} ${s}\n${c}`;
  }).join('\n\n');
  const sysDigest = PROFILE === 'stories'
    ? '你在分析一个知乎「故事征集」问题下的高赞回答合集（多数是亲身经历的叙事）。'
      + '请输出一份 JSON（不要 Markdown 代码块），字段：'
      + '{"overview":"整体综述，**260~350 个汉字**，必须写足。需包含：'
      + '①这批故事反复出现哪几种关系原型（如青梅竹马、师生、异地、暗恋多年不敢说…），各占什么位置；'
      + '②这些故事的结局集中在哪几种形态（在一起 / 错过 / 多年后重逢 / 无疾而终 / 反转），哪类最多；'
      + '③最让人心酸的共同点是什么。要引用回答里的具体细节（时间跨度、那句关键的话、那个具体场景）来支撑，不要写成空泛的抒情套话",'
      + '"consensus":["反复出现的母题或共同心理，6-8条，每条不超过40字"],'
      + '"disputes":["不同结局取向或需要注意的地方，2-4条，每条不超过40字"],'
      + '"readingPath":["值得优先读的故事，4-6条，每条格式为「作者/赞数 + 一句话看点」，不超过50字。注意：本字段是推荐**故事**不是书，不要出现书名"],'
      + '"labels":{"consensus":"反复出现的母题","disputes":"结局的几种形态","readingPath":"值得先读的故事"}}'
    : '你是中文读书类内容分析师。用户会给你一个知乎问题下的高赞回答合集，请输出一份 JSON（不要 Markdown 代码块），字段：'
      + '{"overview":"整体综述，**260~350 个汉字**，必须写足。需包含：①回答分为哪几派、每派的核心主张；'
      + '②争议最大的是什么；③最终的共识。允许引用回答里的具体数字、书名和比喻来支撑，不要写成空泛的套话",'
      + '"consensus":["共识要点，6-8条，每条不超过40字"],'
      + '"disputes":["分歧或需要注意的争议点，2-4条，每条不超过40字"],'
      + '"readingPath":["给读者的入门阅读顺序建议，4-6条，每条包含书名与一句理由，不超过50字"]}';
  const sys = sysDigest;
  const out = await chat([
    { role: 'system', content: sys },
    { role: 'user', content: `问题：${answers[0]?.question_title || ''}\n\n以下是按赞数排序的高赞回答（共 ${answers.length} 条回答，这里取前 ${top.length} 条）：\n\n${feed}` },
  ], { max_tokens: 3000, temperature: 0.4 });
  const d = parseJsonLoose(out);
  // 必须校验「结构完整」而不只是「有 overview」——
  // 实测模型会返回只含 overview 的残缺对象，若直接采纳，
  // 页面会出现空的共识/分歧章节、标题回落到读书题口径（共识要点），而控制台毫无提示。
  const okDigest = d && d.overview && Array.isArray(d.consensus) && d.consensus.length
    && Array.isArray(d.readingPath) && d.readingPath.length;
  if (okDigest) {
    state.digest = d; state.digestTag = digestTag;
    state.digests[excludeTag] = d;
    save(); console.log('综述完成');
  } else {
    console.log('  [!] 综述结构不完整（缺 consensus / readingPath），未采纳。');
    console.log('      模型实际返回: ' + out.slice(0, 160).replace(/\n/g, ' '));
    console.log('      重跑同一命令即可重试。');
  }
}

fs.writeFileSync(OUT, JSON.stringify({
  model: modelTag,
  resolvedModel: MODEL_ID,          // 实际调用的模型（auto 时会记录解析结果）
  question: answers[0]?.question_title || '',
  generatedAt: new Date().toISOString(),
  perAnswer: state.perAnswer,
  // --with-kind：内容性质与摘要同批判定的结果（可直接被 render 当作 -content-kind.json 用）
  ...(WITH_KIND ? { kind: { mode: 'merged', perAnswer: Object.fromEntries(Object.entries(state.kinds || {}).map(([k, v]) => [k, { kind: v }])) } } : {}),
  // 综述按「剔除口径」分别存放：同一个 summaries.json 可以同时服务
  // 「原版」和「去盐选版」两个页面，不必为每种口径各跑一遍逐条摘要。
  digest: state.digest,
  digests: state.digests || {},
  digestTag: state.digestTag || null,
}, null, 1), 'utf8');
console.log(`\n已写入 ${OUT}`);
if (state.digests) console.log(`  已存综述口径: ${Object.keys(state.digests).join(', ')}`);
