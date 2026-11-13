// 预设抽取规则的回归测试 —— 用合成语料跑**真的** extract-entities.mjs，逐条断言。
//
// 为什么需要：抽取规则是这套流程里最常改、最容易静默出错的一环。
// 规则改坏时不会报错，只会在报告里变成错的名字：
//   · `Ryzen 3 3200G` 被捕获成 `3 3200G`（阶级数字被吞进捕获组）
//   · `锐龙55600X` 被捕获成 `55600X`（现实中不存在的型号）
//   · `7800XT`（显卡）被当成 CPU 出现在 CPU 榜里
// 三个都是 2026-10-16 实测踩到的。规则读一遍看不出来，跑 fixture 才看得出来。
//
// 设计要点：**不重实现抽取逻辑**。写合成 answers-full.json，调真脚本，读它的产物。
// 复刻一份正则来测等于测副本，副本永远是对的。
//
// fixtures 写在预设里（`presets/*.json` 的 `fixtures` 字段），知识和规则放一起：
//   { why, text, expect: [名字], reject: [正则], counts: { 名字: 回答数 }, exact }
// 一条 fixture = 一条合成回答。断言分两层：
//   · 这条回答**自己**抽出来的名字集合 === expect（exact，默认开）
//   · 其中没有任何名字命中 reject
// 用「回答 ID 归属」而不是全局存在性来断言 —— 失败信息才能指到具体哪条 fixture。
//
// 用法:
//   node test-preset-rules.mjs            # 跑所有声明了 fixtures 的预设
//   node test-preset-rules.mjs cpu        # 只跑一个
// 退出码: 0 = 全过；1 = 有 FAIL

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESET_DIR = path.join(HERE, 'presets');
const only = process.argv.slice(2).find((a) => !a.startsWith('-'));
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));

const names = fs.readdirSync(PRESET_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .map((f) => f.replace(/\.json$/, ''))
  .filter((n) => !only || n === only);

if (!names.length) { console.error(`找不到预设: ${only || '(任意)'}`); process.exit(1); }

let fails = 0, cases = 0, ran = 0;
const fail = (m) => { console.log('    FAIL  ' + m); fails++; };

for (const preset of names) {
  const P = readJson(path.join(PRESET_DIR, preset + '.json'));
  const FX = P.fixtures || [];
  if (!FX.length) {
    console.log(`\n=== ${preset} ===\n  （预设未声明 fixtures，跳过）`);
    continue;
  }
  ran++;
  console.log(`\n=== ${preset} · ${FX.length} 条 fixture ===`);

  // 合成语料：一条 fixture = 一条回答。id 用序号，断言时靠 answerId 归属。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `preset-fx-${preset}-`));
  const answersFile = path.join(dir, `fx-${preset}-answers-full.json`);
  const outFile = path.join(dir, 'out.json');
  const answers = FX.map((c, i) => ({
    id: String(i + 1),
    votes: (i + 1) * 10,
    content: c.text,
    author: 'fixture',
    url: `https://www.zhihu.com/question/1/answer/${i + 1}`,
    question_id: '1',
    question_title: 'fixture',
    created_at: '2026-01-01T00:00:00.000Z',
  }));
  fs.writeFileSync(answersFile, JSON.stringify(answers), 'utf8');

  let stdout = '';
  try {
    stdout = execFileSync('node', [path.join(HERE, 'extract-entities.mjs'), answersFile, '--preset', preset, '--out', outFile],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    fail(`extract-entities.mjs 跑失败（退出码 ${e.status}）：\n${(e.stdout || '') + (e.stderr || '')}`);
    continue;
  }
  const R = readJson(outFile);
  const ents = R.entities || [];
  const byName = new Map(ents.map((e) => [e.name, e]));

  FX.forEach((c, i) => {
    cases++;
    const aid = String(i + 1);
    const own = ents.filter((e) => (e.samples || []).some((s) => String(s.answerId) === aid));
    const ownNames = own.map((e) => e.name);
    const expect = c.expect || [];
    const title = `#${i + 1} ${JSON.stringify(c.text.slice(0, 34))}${c.text.length > 34 ? '…' : ''}`;

    // 1) 期望抽到的必须抽到（且是**这条回答**抽到的）
    const missing = expect.filter((n) => !ownNames.includes(n));
    // 2) 不期望的名字一个都不许有（own 全部来自这条回答）
    const rejected = own.filter((e) => (c.reject || []).some((r) => new RegExp(r).test(e.name)));
    // 3) exact：这条回答抽出来的东西必须**恰好**是 expect，多一个都不行
    const extra = (c.exact === false) ? [] : ownNames.filter((n) => !expect.includes(n));

    if (missing.length || rejected.length || extra.length) {
      console.log(`  ✗ ${title}`);
      console.log(`      为什么写这条: ${c.why || '-'}`);
      if (missing.length) fail(`该抽到却没抽到: ${missing.join(' / ')}`);
      if (rejected.length) fail(`不该抽到却抽到了: ${rejected.map((e) => e.name).join(' / ')}`);
      if (extra.length) fail(`多抽到了 ${extra.length} 个: ${extra.join(' / ')}`);
      console.log(`      这条回答实际抽出: ${ownNames.length ? ownNames.join(' / ') : '(空)'}`);
    } else {
      console.log(`  ✓ ${title}`);
    }

    // 4) counts：跨全部 fixture 的计数（用来看「同一回答只计一次」）
    for (const [n, want] of Object.entries(c.counts || {})) {
      const e = byName.get(n);
      if (!e) fail(`counts 里的 ${n} 不存在`);
      else if (e.count !== want) fail(`${n} 的提及回答数 ${e.count} ≠ 期望 ${want}（同一回答内写了多种写法时只该计一次）`);
    }
  });

  // 产物级不变量（与 verify-output.mjs 的实体闸门同源，这里更早发现）
  const frag = ents.map((e) => e.name).filter((n) => /^\d+\s/.test(n));
  if (frag.length) fail(`产物里有「数字+空白」开头的碎片名: ${frag.join(' / ')}`);
  const dup = [...new Set(ents.map((e) => e.name).filter((n, i, a) => a.indexOf(n) !== i))];
  if (dup.length) fail(`产物里有重名实体: ${dup.join(' / ')}`);
  if (R.normalized) {
    const G = R.normalized.groupsDetail || [];
    const absorbed = G.reduce((s, g) => s + (g.members || 0) - 1, 0);
    const removed = R.normalized.before - R.normalized.after;
    if (removed !== absorbed) fail(`归一账目不闭合: before-after=${removed}，Σ(members-1)=${absorbed}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  const hit = stdout.split('\n').find((l) => /命中:/.test(l));
  if (hit) console.log(`  ${hit.trim()}`);
}

console.log(`\n${fails ? '✗' : '✓'} ${ran} 个预设 / ${cases} 条 fixture：${fails} 项 FAIL`);
process.exit(fails ? 1 : 0);
