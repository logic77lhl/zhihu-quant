// 抽取质量量化评估 —— 把「靠人肉看 TOP20」变成可复算的精确率/召回率。
//
// 背景：playbook 第 9 节自己承认「抽取质量没有量化评估」。
// 没有这个，改提示词、换模型、调阈值都只能靠感觉，无法判断是变好还是变坏。
//
// 两步用法：
//   ① 生成待标注样本（分层抽样，避免全抽到同一类）
//      node eval-extraction.mjs <answers-full.json> --make-sample 60 --out sample.json
//   ② 人工把 sample.json 里每条的 "expected" 填上正确值，然后评估
//      node eval-extraction.mjs <answers-full.json> --check sample.json
//
// 标注格式：{"items":[{"id":"...","text":"...","predicted":"fiction","expected":"fiction"}]}
// expected 取 real / fiction / adapted / offtopic；不确定就写 "unsure"（不计入指标）
import fs from 'node:fs';

const argv = process.argv.slice(2);
const IN = argv.find((a) => a.endsWith('.json') && !a.startsWith('--'));
if (!IN) {
  console.error('用法:');
  console.error('  node eval-extraction.mjs <answers-full.json> --make-sample 60 [--out sample.json]');
  console.error('  node eval-extraction.mjs <answers-full.json> --check sample.json');
  process.exit(1);
}
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const BASE = IN.replace(/-answers-full\.json$/, '');
const KINDF = opt('--kind', BASE + '-content-kind.json');
const MAK = Number(opt('--make-sample', 0));
const CHECK = opt('--check', '');
const OUT = opt('--out', BASE + '-eval-sample.json');

const answers = JSON.parse(fs.readFileSync(IN, 'utf8'));
const kindData = fs.existsSync(KINDF) ? JSON.parse(fs.readFileSync(KINDF, 'utf8')) : null;
const predicted = (id) => (kindData?.perAnswer?.[String(id)] || {}).kind || '';
const byId = new Map(answers.map((a) => [String(a.id), a]));

// 确定性伪随机（不用 Math.random，保证同一份数据每次抽到的样本一样，评估可复现）
let seed = 20261015;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

// ---------- ① 生成分层样本 ----------
if (MAK) {
  const classes = ['real', 'fiction', 'adapted', 'offtopic'];
  const per = Math.max(1, Math.floor(MAK / classes.length));
  const picked = [];
  for (const c of classes) {
    const pool = answers.filter((a) => predicted(a.id) === c);
    // 层内按赞数分层：一半取高赞、一半随机 —— 只看高赞会漏掉长尾的错误模式
    const sorted = [...pool].sort((x, y) => (y.votes || 0) - (x.votes || 0));
    const top = sorted.slice(0, Math.ceil(per / 2));
    const rest = sorted.slice(Math.ceil(per / 2)).sort(() => rnd() - 0.5).slice(0, per - top.length);
    picked.push(...top, ...rest);
  }
  const items = picked.map((a) => ({
    id: String(a.id),
    votes: a.votes || 0,
    len: (a.content || '').length,
    predicted: predicted(a.id),
    expected: '',                        // ← 人工填这里
    // 给标注者看的正文：太长就截断，判定性质看开头通常够
    text: (a.content || '').replace(/\s+/g, ' ').slice(0, 1200),
  }));
  fs.writeFileSync(OUT, JSON.stringify({ question: answers[0]?.question_title || '', items }, null, 1), 'utf8');
  const dist = items.reduce((m, x) => (m[x.predicted] = (m[x.predicted] || 0) + 1, m), {});
  console.log(`已生成 ${items.length} 条待标注样本 → ${OUT}`);
  console.log('分布: ' + JSON.stringify(dist));
  console.log('\n请人工把每条的 "expected" 填上 real / fiction / adapted / offtopic（不确定写 unsure），');
  console.log('然后跑：node eval-extraction.mjs ' + IN + ' --check ' + OUT);
  process.exit(0);
}

// ---------- ② 评估 ----------
if (CHECK) {
  const s = JSON.parse(fs.readFileSync(CHECK, 'utf8'));
  const items = (s.items || []).filter((x) => x.expected && x.expected !== 'unsure' && x.predicted);
  const skipped = (s.items || []).length - items.length;
  const CLASSES = ['real', 'fiction', 'adapted', 'offtopic'];

  // 混淆矩阵
  const M = {};
  for (const c of CLASSES) M[c] = {};
  for (const it of items) M[it.predicted][it.expected] = (M[it.predicted][it.expected] || 0) + 1;

  console.log(`样本 ${s.items.length} 条，有效（已标注且已预测）${items.length} 条，跳过 ${skipped} 条\n`);
  const correct = items.filter((x) => x.predicted === x.expected).length;
  console.log(`总体准确率: ${(correct / items.length * 100).toFixed(1)}%  (${correct}/${items.length})\n`);

  console.log('逐类指标:');
  console.log('  类别        精确率   召回率   F1     支持数');
  for (const c of CLASSES) {
    const tp = items.filter((x) => x.predicted === c && x.expected === c).length;
    const fp = items.filter((x) => x.predicted === c && x.expected !== c).length;
    const fn = items.filter((x) => x.predicted !== c && x.expected === c).length;
    const sup = items.filter((x) => x.expected === c).length;
    if (!sup && !fp) continue;
    const p = tp + fp ? tp / (tp + fp) : 0;
    const r = tp + fn ? tp / (tp + fn) : 0;
    const f1 = p + r ? 2 * p * r / (p + r) : 0;
    console.log(`  ${c.padEnd(10)} ${(p * 100).toFixed(1).padStart(6)}% ${(r * 100).toFixed(1).padStart(7)}% ${(f1 * 100).toFixed(1).padStart(6)}%  ${String(sup).padStart(5)}`);
  }

  console.log('\n混淆矩阵（行=预测，列=实际）:');
  const w = 10;
  console.log('  ' + ''.padEnd(w) + CLASSES.map((c) => c.padStart(w)).join(''));
  for (const p of CLASSES) {
    const row = CLASSES.map((t) => String(M[p][t] || 0).padStart(w)).join('');
    console.log('  ' + p.padEnd(w) + row);
  }

  // 错例明细 —— 这是改进提示词最有用的部分
  const wrong = items.filter((x) => x.predicted !== x.expected);
  if (wrong.length) {
    console.log(`\n错例 ${wrong.length} 条（前 12 条）:`);
    for (const x of wrong.slice(0, 12)) {
      const a = byId.get(x.id) || {};
      console.log(`  [预测 ${x.predicted} → 实际 ${x.expected}] ${a.votes || 0}赞 ${(a.content || '').length}字 | ${a.author || ''}`);
      console.log(`     ${(a.content || '').replace(/\s+/g, ' ').slice(0, 90)}`);
    }
    console.log('\n  ↑ 这些错例是改提示词的依据，比总体准确率更有用。');
  } else {
    console.log('\n无错例。');
  }
  process.exit(0);
}

console.error('需要 --make-sample <N> 或 --check <file>');
process.exit(1);
