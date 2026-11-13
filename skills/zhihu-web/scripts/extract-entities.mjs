// 通用实体抽取器：回答全文 -> 规范化实体 JSON
//
// 实体类型由「预设」定义（规则 + 词典 + 噪音词），换实体类型不用改代码，
// 新建一个 presets/*.json 即可。
//
// 用法:
//   node extract-entities.mjs <answers.json> --preset books [--out f.json] [--dict extra.txt]
//   node extract-entities.mjs <answers.json> --preset mylib --config ./my.json
//
// 预设字段说明见 presets/_README.md

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock } from './lock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const IN = argv.find((a) => /\.(json)$/i.test(a) && !a.startsWith('--'));
if (!IN) { console.error('用法: node extract-entities.mjs <answers.json> --preset <name> [--out f.json]'); process.exit(1); }

const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const presetName = flag('--preset', 'books');
const configPath = flag('--config', null);
const dictPath = flag('--dict', null);
const outArg = argv.indexOf('--out');
const OUT = outArg >= 0 && argv[outArg + 1] ? argv[outArg + 1] : IN.replace(/\.json$/, '-entities.json');

// 加锁：并发会话跑同一份数据会互相覆盖产物。key 用全局键，与产物路径无关。
const lock = acquireLock(OUT, {
  label: '实体抽取（预设 ' + presetName + '）',
  key: 'entities-' + path.basename(IN, '.json') + '-' + presetName,
});

// ---- 载入预设 ----
const presetFile = configPath || path.join(HERE, 'presets', `${presetName}.json`);
if (!fs.existsSync(presetFile)) {
  console.error(`找不到预设: ${presetFile}`);
  console.error(`现有预设: ${fs.readdirSync(path.join(HERE, 'presets')).filter((f) => f.endsWith('.json')).join(', ')}`);
  process.exit(1);
}
// PowerShell 的 Set-Content -Encoding UTF8 会写 BOM，必须剥掉
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));

const P = readJson(presetFile);
console.log(`预设: ${presetName}  (${presetFile})`);

// ---- 词典（预设内联 + 可选外部文件）----
let DICT = [...(P.dict || [])];
if (dictPath && fs.existsSync(dictPath)) {
  const extra = fs.readFileSync(dictPath, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  DICT = [...new Set([...DICT, ...extra])];
  console.log(`  外接词典 ${dictPath}: +${extra.length} 词，共 ${DICT.length}`);
}
const NOISE = new Set(P.noise || []);

// ---- 过滤器 ----
const MIN = P.minLength ?? 2;
const MAX = P.maxLength ?? 40;
// 字符类写法有两种：裸字符（会被包成 [...]）或已带方括号（原样使用）。
// 否则 "[A-Za-z0-9]" 会被包成 "[[A-Za-z0-9]]"，语义变成"含 [ 或字母 或数字 后必须跟字面量 ]"，
// 结果是几乎所有实体都被误杀。
const charClass = (s) => new RegExp(
  /^[[].*[\]]$/.test(s) ? s : '[' + s + ']',
);
const REJECT = P.rejectChars ? charClass(P.rejectChars) : null;
const REQUIRE = P.requireChars ? charClass(P.requireChars) : null;
// 上下文守卫：命中位置附近必须出现的特征（如书名号附近应有「著」「作者」）
// JSON 里 re 是字符串，这里预编译成 RegExp
const CTX_GUARD = P.contextGuard
  ? { near: P.contextGuard.near ?? 24, re: new RegExp(P.contextGuard.re) }
  : null;

const clean = (s) => String(s).replace(/\s+/g, ' ').trim()
  .replace(/^[的了和与及或：:，,、。．\.\-—_~·"'"'「」『』]+/, '')
  .replace(/[的了和与及或：:，,、。．\.\-—_~·"'"'「」『』]+$/, '');

const rejected = [];
function accept(raw, tag) {
  const t = clean(raw);
  if (t.length < MIN || t.length > MAX) return null;
  if (NOISE.has(t)) { rejected.push({ raw: t, tag, why: '噪音词表' }); return null; }
  if (REJECT && REJECT.test(t)) { rejected.push({ raw: t, tag, why: '含虚词/语气词' }); return null; }
  if (REQUIRE && !REQUIRE.test(t)) { rejected.push({ raw: t, tag, why: '不含必需字符' }); return null; }
  return t;
}

// ---- 抽取 ----
const answers = JSON.parse(fs.readFileSync(IN, 'utf8'));
const qid = answers.find((a) => a.question_id)?.question_id || '';
const qtitle = answers.find((a) => a.question_title)?.question_title || '';

const byName = new Map();
const layerHits = {};
let contextGuardDropped = 0;
const guardDropped = new Set();   // 被上下文守卫判定为「非书籍引用」的书名号内容

for (const a of answers) {
  const text = a.content || '';
  if (!text.trim()) continue;

  for (const rule of P.rules || []) {
    // rule.re 在 JSON 里是字符串（JSON 存不了字面量 RegExp），也兼容直接传 RegExp
    const src = typeof rule.re === 'string' ? rule.re : rule.re.source;
    const fl = (typeof rule.re === 'string' ? (rule.flags || 'g') : (rule.re.flags || 'g'));
    const re = new RegExp(src, fl.includes('g') ? fl : fl + 'g');
    for (const m of text.matchAll(re)) {
      const raw = rule.group ? (m[rule.group] ?? '') : m[0];
      const title = accept(raw, rule.tag);
      if (!title) continue;
      // 上下文守卫：要求附近出现某个特征（如作者名紧邻书名）
      if (CTX_GUARD) {
        const pos = m.index ?? text.indexOf(raw);
        const near = text.slice(Math.max(0, pos - CTX_GUARD.near), pos + CTX_GUARD.near + title.length);
        if (!CTX_GUARD.re.test(near)) {
          contextGuardDropped++;
          guardDropped.add(title);      // 记录而非丢弃 —— 报告口径里要说明
          continue;
        }
      }
      layerHits[rule.tag] = (layerHits[rule.tag] || 0) + 1;

      const key = (P.caseSensitive ? title : title.toLowerCase());
      if (!byName.has(key)) {
        byName.set(key, { name: title, tag: rule.tag, votesById: new Map(), maxVotes: 0, samples: [] });
      }
      const rec = byName.get(key);
      if (rec.votesById.has(a.id)) continue;   // 同一回答内同一实体只计一次
      // 存 id→votes，而不是把 count/votesSum 就地累加：
      // 别名归一之后要**重算「去重后的赞数和」** —— 同一条回答同时写了
      // `i5-12400F` 和 `12400F` 时只能计一次赞，就地累加会重复计入。
      rec.votesById.set(a.id, a.votes || 0);
      if ((a.votes || 0) > rec.maxVotes) rec.maxVotes = a.votes || 0;
      if (rec.samples.length < (P.maxSamples ?? 8)) {
        const anchor = rule.anchor ? text.indexOf(rule.anchor) : (m.index ?? 0);
        const i = anchor >= 0 ? anchor : 0;
        rec.samples.push({
          answerId: String(a.id), url: a.url, author: a.author,
          votes: a.votes ?? null, comments: a.comments ?? null,
          created_at: a.created_at ?? null,
          snippet: text.slice(Math.max(0, i - (P.ctxBefore ?? 50)), i + title.length + (P.ctxAfter ?? 110)).replace(/\s+/g, ' ').trim(),
        });
      }
    }
  }

  // 词典层
  if (DICT.length) {
    for (const d of new Set(DICT)) {
      if (P.dictNeedBoundary !== false) {
        const esc = d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // 词典项的左右边界。两侧**各自独立**，因为「汉字紧邻」在两侧的含金量完全不同：
        //   · 左侧紧邻汉字是**常态**：`还是不如12600KF`、`觉得numpy和pandas`。
        //     默认把汉字算作边界（cjk-strict）会把这类整片挡掉；机型名这类独特 token
        //     可以放心用 loose（只要求前一个字符不是字母/数字/下划线）。
        //   · 右侧紧邻汉字要**看领域**：`pandas库`、`requests的` 是真命中，
        //     但 `12400元`、`12400够用` 是价格/规格里的数字，必须挡住。
        // 实测证据见 presets/*.json 的 notes 与 references/presets.md。
        const STRICT_L = '(?<![\\w\\u4e00-\\u9fa5])', LOOSE_L = '(?<![\\w])';
        const STRICT_R = '(?![\\w\\u4e00-\\u9fa5])', LOOSE_R = '(?![\\w])';
        const left = P.dictLeftGuard === 'loose' ? LOOSE_L : STRICT_L;
        const right = P.dictRightGuard === 'loose' ? LOOSE_R : STRICT_R;
        if (!new RegExp(`${left}${esc}${right}`).test(text)) continue;
      } else if (!text.includes(d)) continue;
      const title = accept(d, P.dictTag || '词典');
      if (!title) continue;
      layerHits[P.dictTag || '词典'] = (layerHits[P.dictTag || '词典'] || 0) + 1;
      const key = (P.caseSensitive ? title : title.toLowerCase());
      if (!byName.has(key)) byName.set(key, { name: title, tag: P.dictTag || '词典', votesById: new Map(), maxVotes: 0, samples: [] });
      const rec = byName.get(key);
      if (rec.votesById.has(a.id)) continue;
      rec.votesById.set(a.id, a.votes || 0);
      if ((a.votes || 0) > rec.maxVotes) rec.maxVotes = a.votes || 0;
      if (rec.samples.length < (P.maxSamples ?? 8)) {
        const i = text.indexOf(d);
        rec.samples.push({
          answerId: String(a.id), url: a.url, author: a.author,
          votes: a.votes ?? null, comments: a.comments ?? null, created_at: a.created_at ?? null,
          snippet: text.slice(Math.max(0, i - (P.ctxBefore ?? 50)), i + d.length + (P.ctxAfter ?? 110)).replace(/\s+/g, ' ').trim(),
        });
      }
    }
  }
}

// ---- 别名归一（可选，由预设的 normalize 声明）----
// 为什么需要：同一个 CPU 在回答里有多种写法 —— `i5-12400F` / `12400F`、
// `Ryzen 5 7500F` / `7500F`。不归一时赞数会被拆成几份，**榜单头部直接错**。
// 实测 q650705759：203 个原始名里有 28 个是别的名字的别名。
//
// 规则**只做厂牌前缀剥离**，不做型号族合并 —— `12700` 与 `12700K` 是两个 SKU，
// 合并它们会把不同产品算成一个。合并组全量记进 `normalized.groupsDetail`，口径可查。
const stripRules = (P.normalize?.stripPrefixes || []).map((s) => new RegExp(s, 'i'));
const canonOf = (n) => { let x = n; for (const r of stripRules) x = x.replace(r, '').trim(); return x || n; };
const normGroups = [];
const beforeN = byName.size;

let records = [...byName.values()];
if (stripRules.length) {
  const buckets = new Map();
  for (const r of records) {
    const c = canonOf(r.name);
    const k = (P.caseSensitive ? c : c.toLowerCase());
    if (!buckets.has(k)) buckets.set(k, { name: c, recs: [] });
    buckets.get(k).recs.push(r);
  }
  records = [...buckets.values()].map((b) => {
    // 显示名：组内**有多于一个成员**时用规范名（剥完前缀的那个）——
    //   此时「原来怎么写」本身已经有分歧，统一成规范名才不会出现 `5 3600` 这种半成品。
    // 只有一个成员时**保留原样** —— 数据里只有 `i5-14600KF` 时不该把它改名成 `14600KF`，
    //   「改名」和「合并」是两件事，前者不该顺带发生。
    const display = b.recs.length > 1 ? b.name : b.recs[0].name;
    if (b.recs.length > 1) {
      // members = 合并前这组有几种原始写法。有了它，账目才closure：
      //   原始写法数 - 实体数 === Σ(members - 1)
      // 只记 from 是不够的 —— 当组内没有任何成员等于规范名时（如 Xeon E5 + 至强E5 → `E5`），
      // from 会列全部成员，Σfrom 比实际吸收数多，校验就会误报。
      normGroups.push({ to: display, members: b.recs.length, from: b.recs.map((r) => r.name).filter((n) => n !== display) });
    }
    const votesById = new Map();
    let maxVotes = 0;
    const samples = [];
    // 合并顺序：出现回答数从多到少，保证 tag 与样本取的是更有代表性的那一支
    const byCount = b.recs.slice().sort((x, y) => y.votesById.size - x.votesById.size);
    for (const r of byCount) {
      for (const [id, v] of r.votesById) votesById.set(id, Math.max(votesById.get(id) ?? 0, v));
      if (r.maxVotes > maxVotes) maxVotes = r.maxVotes;
      for (const s of r.samples) if (samples.length < (P.maxSamples ?? 8)) samples.push(s);
    }
    return { name: display, tag: byCount[0].tag, votesById, maxVotes, samples };
  });
}

const entities = records
  .map((r) => {
    const vs = [...r.votesById.values()];
    const sum = vs.reduce((s, v) => s + v, 0);
    return {
      name: r.name, tag: r.tag,
      count: r.votesById.size,
      maxVotes: r.maxVotes,
      votesSum: sum,
      logSum: Number(vs.reduce((s, v) => s + Math.log10(1 + v), 0).toFixed(2)),
      avgVotes: r.votesById.size ? Math.round(sum / r.votesById.size) : 0,
      samples: r.samples,
    };
  })
  .sort((x, y) => y.count - x.count || y.maxVotes - x.maxVotes || y.samples.length - x.samples.length);

// 出处声明必须与实际数据一致。
// 早先这里是**硬编码的** 'answer-detail --max-content 0'，但管线实际走的是
// fetch-answers-api.mjs（分页接口）—— 于是产物里的「数据来源」印了一句假话，
// 而报告口径要求交代来源。判不出来就说「未知」：宁可承认不知道，也不要印没验证过的话。
const describeSource = () => {
  let st = null;
  try { st = JSON.parse(fs.readFileSync(IN + '.state.json', 'utf8').replace(/^\uFEFF/, '')); } catch {}
  const paginated = !!(st && st.totals && st.done);
  const hasFlags = answers.some((a) => a.answer_type !== undefined);
  if (paginated) {
    return `知乎 /api/v4/questions/{id}/answers 分页接口（登录态；全文 HTML 去标签后入库）${hasFlags ? '，含 answer_type / 机构号等标志字段' : ''}`;
  }
  if (st) return 'Panerelay 逐条 answer-detail --max-content 0（登录态，全文，非摘要）';
  return '来源未知（同目录没有可读的 .state.json，无法判定是分页接口还是逐条抓取）';
};

const out = {
  question: qid,
  title: qtitle,
  url: qid ? `https://www.zhihu.com/question/${qid}` : '',
  qLabel: `question / ${qid}`,
  source: describeSource(),
  preset: presetName,
  normalized: stripRules.length
    ? { before: beforeN, after: entities.length, groups: normGroups.length, groupsDetail: normGroups }
    : undefined,
  render: {
    entityLabel: P.entityLabel || '实体',
    entityUnit: P.entityUnit || '条回答',
    tagLabel: P.tagLabel || '来源',
    countLabel: P.countLabel || '提及回答数',
    countShort: P.countShort || '提及',
    sortLabel: `按${P.countLabel || '提及回答数'}`,
  },
  extraction: {
    preset: presetName,
    layerHits,
    rejectedCount: rejected.length,
    contextGuardDropped,
    contextGuardDroppedUnique: guardDropped.size,
    contextGuardDroppedSample: [...guardDropped].slice(0, 40),
    rejectedSample: [...new Map(rejected.map((x) => [x.raw + x.why, x])).values()].slice(0, 40),
  },
  extraStats: (P.extraStats || []).map((s) => ({ label: s.label, value: s.value?.(answers) ?? s.value })),
  notes: (P.notes || []).map((n) => typeof n === 'function' ? n({ answers, entities, extraction: { layerHits, rejectedCount: rejected.length } }) : n),
  stats: {
    answersScanned: answers.length,
    answersWithText: answers.filter((a) => (a.content || '').trim()).length,
    totalChars: answers.reduce((s, a) => s + (a.content || '').length, 0),
    entitiesFound: entities.length,
  },
  entities,
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 1), 'utf8');

console.log(`\n问题: ${qtitle || '(无标题)'}`);
console.log(`扫描 ${out.stats.answersScanned} 条（${out.stats.answersWithText} 条有正文，${fmt(out.stats.totalChars)} 字）`);
console.log(`命中: ${Object.entries(layerHits).map(([k, v]) => `${k} ${v}`).join('  ') || '(无)'}`);
console.log(`过滤: ${rejected.length} 条噪音${contextGuardDropped ? ` + ${contextGuardDropped} 条上下文守卫未命中` : ''}`);
console.log(`去重实体: ${entities.length}\n`);
console.log(`TOP ${Math.min(20, entities.length)}:`);
entities.slice(0, 20).forEach((e, i) =>
  console.log(`  ${String(i + 1).padStart(2)}. ${e.name.padEnd(26)} ${String(e.count).padStart(3)}  最高赞${String(e.maxVotes).padStart(5)}  [${e.tag}]`));
console.log(`\n已写入 ${OUT}`);
console.log(`下一步: node render-report.mjs "${OUT}"`);

function fmt(n) { return n.toLocaleString('en-US'); }