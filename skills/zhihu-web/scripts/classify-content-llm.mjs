// 内容性质分类：区分「亲身经历 / 虚构小说 / 改编自他人 / 机构投稿」
//
// 为什么不用纯正则：实测 chapters>=6 的假阳性率高 ——
// 「用 1.2.3. 分条列举真实经历」和「小说分章」在文本上几乎一样，
// 唯一可靠的区别是长度（真实经历列举通常 <4000 字，小说普遍 >5000 字）。
// 但这个阈值仍然会把长篇真实记录误判，所以最后一步交给模型读全文判定。
//
// 用法:
//   node classify-content-llm.mjs <answers-full.json> [--sample N] [--out f.json]
//     --sample N   除命中候选外，额外随机抽 N 条「未被标记」的做查漏（估漏报率）
import fs from 'node:fs';
import path from 'node:path';
import { acquireLock } from './lock.mjs';
import { resolveModel, modelSegmentCompatible } from './llm-model.mjs';

const argv = process.argv.slice(2);
const IN = argv.find((a) => a.endsWith('.json'));
if (!IN) { console.error('用法: node classify-content-llm.mjs <answers-full.json> [--sample N]'); process.exit(1); }
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const num = (f, d) => Number(opt(f, d));
const SAMPLE = num('--sample', 150);
const CONC = num('--concurrency', 5);
const MODEL = opt('--model', 'auto');   // auto = 探测模型链挑可用的（见 llm-model.mjs）
const KEY = process.env.WB2API_KEY;
if (!KEY) { console.error('缺少环境变量 WB2API_KEY'); process.exit(1); }
const BASE = process.env.WB2API_BASE || 'http://127.0.0.1:7863/v1';
const { model: MODEL_ID, auto: MODEL_AUTO } = await resolveModel(MODEL, { key: KEY, base: BASE });

const OUT = opt('--out', IN.replace(/-answers-full\.json$/, '') + '-content-kind.json');

// 加锁：并发会话跑同一份数据会白烧 API 调用。
// key 用全局键（系统临时目录），与产物路径无关 —— 换 ZHIHU_QUANT_OUT 也挡得住。
const lock = acquireLock(OUT, {
  label: '内容性质判定',
  key: `classify-${path.basename(IN, ".json")}`,
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
const answers = JSON.parse(fs.readFileSync(IN, 'utf8'));

// ---- 粗筛：只把「可能有问题」的送进模型，省钱 ----
const RE_SERIAL = /【[^】]{0,6}(完结|未完结|已完结|完结慎入|未完结慎入)[^】]{0,6}】|(?:^|\n)\s*(?:番外|楔子|序章|尾声)\s*[:：]?|未完待续|以下是正文/;
const RE_COPYRIGHT = /未经(?:作者|本人)?(?:允许|授权)不得转载|本文(?:为)?原创|首发于|盐选/;
const chapters = (s) => (s.match(/(?:^|\n)\s*(?:\d{1,3}|[一二三四五六七八九十]{1,3})[.、）)]\s*\S/g) || []).length;

const prelim = (x) => {
  const s = x.content || '';
  const ch = chapters(s);
  return {
    serial: RE_SERIAL.test(s),
    copyright: RE_COPYRIGHT.test(s),
    chapters: ch,
    // 长度参与判定：真实经历的分条列举通常短
    fictionish: RE_SERIAL.test(s) || RE_COPYRIGHT.test(s) || (ch >= 6 && s.length >= 5000),
  };
};

const meta = new Map(answers.map((x) => [String(x.id), x]));
for (const x of answers) meta.set(String(x.id), { ...x, ...prelim(x) });

const flagged = answers.filter((x) => meta.get(String(x.id)).fictionish
  || (x.answer_type && x.answer_type !== 'normal') || x.is_advertiser || x.author_type === 'organization');

// 查漏样本：从「未被标记」的里随机抽
const pool = answers.filter((x) => !meta.get(String(x.id)).fictionish && (!x.answer_type || x.answer_type === 'normal')
  && !x.is_advertiser && x.author_type !== 'people' || false);
const notFlagged = answers.filter((x) => !flagged.includes(x));
let seed = 20261014;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const shuffled = [...notFlagged].sort(() => rnd() - 0.5);
const auditSample = new Set(shuffled.slice(0, SAMPLE).map((x) => String(x.id)));

// --all：判定全部回答，不只是「粗筛命中 + 抽样」。
// 抽样能估出整体比例，但**保证不了头部正确** —— 实测某题排第 1 的 42036 赞回答
// 因分章写法是「一我换同桌了」（无点号）而没被粗筛抓到，页面上显示「无标记」，
// 读者会把小说当真实故事读。要让徽章真正可用，必须全判。
const ALL = argv.includes('--all');
const targets = ALL ? answers : answers.filter((x) => flagged.includes(x) || auditSample.has(String(x.id)));
console.log(`总 ${answers.length} 条`)
if (ALL) {
  console.log(`  全量判定模式：${targets.length} 条全部送模型`);
} else {
  console.log(`  粗筛命中 ${flagged.length} 条（严选/机构/连载标记/长文分章）`);
  console.log(`  额外随机抽样 ${auditSample.size} 条（查漏报）`);
  console.log(`  送模型判定 ${targets.length} 条`);
}
console.log('');

const stateFile = OUT + '.state.json';
const promptTag = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chat(msgs, max_tokens) {
  for (let a = 0; a <= 3; a++) {
    try {
      const r = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: MODEL_ID, messages: msgs, max_tokens, temperature: 0.2, reasoning_effort: 'none' }),
      });
      if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const txt = (j.choices?.[0]?.message?.content || '').trim();
      if (!txt) throw new Error('EMPTY');
      return txt;
    } catch (e) { if (a === 3) throw e; await sleep(1200 * (a + 1)); }
  }
}
const loose = (s) => {
  const t = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const i = t.indexOf('['), k = t.lastIndexOf(']');
  if (i >= 0 && k > i) { try { return JSON.parse(t.slice(i, k + 1)); } catch {} }
  return null;
};

// 模型偶尔把 offtopic 截断成 ofptopic / ofstof / of 这类残串（token 边界问题），
// 直接落库会让统计口径失真，所以按前缀归一到四个标准值。
const KIND_ALIAS = [
  [/^(re|rea|real|真实)/i, 'real'],
  [/^(fi|fic|fict|虚构|小说)/i, 'fiction'],
  [/^(ad|ada|adap|adapt|改编)/i, 'adapted'],
  [/^(o|of|off|offt|offtop|offtopi|无关)/i, 'offtopic'],
];
const normKind = (v) => {
  const s = String(v || '').trim();
  for (const [re, k] of KIND_ALIAS) if (re.test(s)) return k;
  return s ? 'unknown' : '';
};

const SYS = `你在判断知乎回答的内容性质。用户给你若干条回答的开头（长文已截断），请判断每条属于哪一类：

- "real"：作者本人的亲身经历（自述真实事件，可能写得小说化，但叙述者是真人在讲自己）
- "fiction"：虚构的小说创作（人物是编的，有章节推进、有情节设计，即使写得像真事）
- "adapted"：改编自他人经历／他人作品／影视剧，或明显虚构但基于真实原型
- "offtopic"：与问题无关，或只是抖机灵、推销、引流

判断要点：
1. **「用 1.2.3. 分条列举」不等于小说** —— 真人也常这样写。关键是人物名是否具体到像代号、有无情节反转设计、有无章节标题（番外/楔子）。
2. 有【完结】【未完结慎入】【原文完】等连载标记的，基本都是 fiction。
3. 出现「盐选」「未经允许不得转载」「首发于」的，若内容是完整故事线，多为 fiction/adapted。
4. 讲述自己（我）的高中/大学/同事/家人经历并带具体时间地点细节的，多为 real。
5. 只看开头 600 字判断；信息不足就给最可能的一类。

只输出 JSON 数组，不要解释： [{"id":"...","kind":"real|fiction|adapted|offtopic","why":"不超过20字"}]`;

// 缓存必须绑定「模型 + 提示词 + 输入集」。只绑模型的话，
// 改了提示词或换了输入数据仍会复用旧判定，静默产出错的结果。
const tagModel = MODEL_AUTO ? 'auto' : MODEL_ID;
const runTag = `${tagModel}|${promptTag(SYS)}|${promptTag(answers.map((a) => a.id).join(','))}`;
let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { perAnswer: {} };
if (state.runTag !== runTag) {
  // 一次性迁移：runTag 是后加的，早于它的 state 没有这个字段。
  // 那种 state 是同一套模型+提示词产出的，直接补上 tag 即可，不必重跑 20 分钟。
  // 只在「没有 tag 且已有结果」时走这条路；有 tag 但不同 = 真的变了，必须重跑。
  const legacy = !state.runTag && Object.keys(state.perAnswer || {}).length > 0;
  // auto 模式下「首段模型名不同、但提示词与输入集完全相同」不算变化（上游切换不作废已判结果）
  const restOf = (t) => String(t).split('|').slice(1).join('|');
  const swapped = !legacy && MODEL_AUTO && state.runTag
    && restOf(state.runTag) === restOf(runTag)
    && modelSegmentCompatible(String(state.runTag).split('|')[0], { requested: MODEL, resolved: MODEL_ID });
  if (legacy) {
    console.log(`  检测到旧版 state（无版本标记），沿用其 ${Object.keys(state.perAnswer).length} 条判定并补写标记`);
  } else if (swapped) {
    console.log(`  上游模型切换（${String(state.runTag).split('|')[0]} → ${tagModel}），提示词与输入未变，沿用已判结果`);
  } else if (state.runTag) {
    console.log(`  模型/提示词/输入已变（${state.runTag} → ${runTag}），作废旧缓存重跑\n`);
    state = { perAnswer: {} };
  }
}
state.runTag = runTag;
// 只保留仍然存在的回答 —— 上一轮模型臆造的 ID 必须在这里清掉，
// 否则会一路带进统计，出现「已判定 3899 / 回答 3898」这种对不上的数字。
for (const k of Object.keys(state.perAnswer)) if (!answers.some((a) => String(a.id) === k)) delete state.perAnswer[k];
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state), 'utf8');

const BUDGET = 9000, MAXN = 15;
const batches = [];
let cur = [], curLen = 0;
for (const x of targets) {
  const L = Math.min((x.content || '').length, 700);
  if (cur.length && (curLen + L > BUDGET || cur.length >= MAXN)) { batches.push(cur); cur = []; curLen = 0; }
  cur.push(x); curLen += L;
}
if (cur.length) batches.push(cur);

// 只按「缺判定」判断待处理。空 kind 视为未判定 —— 否则 {kind:''} 这个 truthy 对象
// 会让失败条目被当成「已完成」，重跑永远补不上（实测为此补跑 4 轮）。
const needJudge = (x) => !(state.perAnswer[String(x.id)] || {}).kind;
const todo = batches.filter((b) => b.some(needJudge));
console.log(`打包 ${batches.length} 批，待处理 ${todo.length}`);

// 判定一批。整批返回但有条目没判出来时，抛错让上层拆批 ——
// 模型偶尔会漏掉极短或极怪的回答（实测一条 2 字的「你」反复判不出来），
// 拆到单条后就能给出结果。不拆的话那一批永远失败。
async function judgeBatch(batch) {
  const batchIds = new Set(batch.map((x) => String(x.id)));
  const body = batch.map((x) => `### id=${x.id} 赞=${x.votes || 0} 字数=${(x.content || '').length}\n${(x.content || '').replace(/\s+/g, ' ').slice(0, 700)}`).join('\n\n');
  const arr = loose(await chat([{ role: 'system', content: SYS }, { role: 'user', content: body }], 1200 + batch.length * 120));
  if (!Array.isArray(arr)) throw new Error('非数组');
  let got = 0;
  for (const it of arr) {
    if (!it || !it.id) continue;
    const id = String(it.id);
    // 只收本批内的 ID：模型会编造不存在的回答 ID，落库就污染统计
    if (!batchIds.has(id)) continue;
    const kind = normKind(it.kind);
    if (!kind) continue;                       // 空值不写，留给下次重试
    state.perAnswer[id] = { kind, why: String(it.why || '') };
    got++;
  }
  if (got < batch.length) throw new Error(`本批 ${batch.length} 条只判出 ${got} 条`);
}

async function judgeBatchSplit(batch, depth = 0) {
  try {
    await judgeBatch(batch);
  } catch (e) {
    if (batch.length <= 1 || depth > 4) throw e;
    const mid = Math.ceil(batch.length / 2);
    await judgeBatchSplit(batch.slice(0, mid), depth + 1);
    await judgeBatchSplit(batch.slice(mid), depth + 1);
  }
}

let done = 0, fail = 0, cursor = 0;
async function worker() {
  while (cursor < todo.length) {
    const batch = todo[cursor++];
    try {
      await judgeBatchSplit(batch);
      done++;
    } catch (e) { fail++; if (fail <= 4) console.log('  [!]', e.message); }
    if ((done + fail) % 10 === 0) { save(); process.stdout.write(`  ${done + fail}/${todo.length} ok=${done} fail=${fail}\n`); }
    await sleep(100);
  }
}
await Promise.all(Array.from({ length: CONC }, () => worker()));
save();

fs.writeFileSync(OUT, JSON.stringify({
  question: answers[0]?.question_title || '',
  model: tagModel, resolvedModel: MODEL_ID, generatedAt: new Date().toISOString(),
  mode: ALL ? 'all' : 'sampled',
  method: ALL
    ? '全量判定：所有回答送模型读开头，无抽样、无外推'
    : '粗筛(严选/机构/连载标记/长文分章) + 随机抽样查漏 → 模型读开头判定；未判定的比例靠抽样外推',
  flaggedCount: flagged.length, auditSample: ALL ? [] : [...auditSample],
  perAnswer: state.perAnswer,
}, null, 1), 'utf8');

const cnt = {};
for (const x of targets) { const k = state.perAnswer[String(x.id)]?.kind || '未判定'; cnt[k] = (cnt[k] || 0) + 1; }
console.log('\n判定结果:', JSON.stringify(cnt));
console.log('已写入', OUT);

// 失败批 / 未判定必须在退出码上体现 —— 否则自动化会把半成品当成功。
// 实测踩过：跑完 exit 0，但还有 108 条未判定，靠人工看日志才发现。
const unjudged = targets.filter(needJudge).length;
if (fail > 0 || unjudged > 0) {
  console.error(`\n[!] 未完成：失败批 ${fail}，未判定 ${unjudged} 条。重跑同一命令可补齐（已判定的会跳过）。`);
  process.exit(2);
}
console.log('全部判定完成 ✓');
