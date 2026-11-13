// 文档一致性检查 —— 让「多处重复的高频结论发生分叉」变成可检测的
//
// 背景：有些结论在 3~5 个文档里都写了（`--all` 5 处、并发上限 4 处……）。
// 内容一致时靠人工对账，但下次只改一处就会悄悄分叉，而且**没人会发现**。
// 这个脚本把「同一结论在不同文档里说法是否一致」变成可执行的断言。
//
// 用法: node check-docs.mjs        （退出码 0 = 一致）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.dirname(HERE);
const DOCS = ['SKILL.md',
  'references/usage.md',
  'references/pipeline-v2.md', 'references/content-kind.md',
  'references/scripts.md', 'references/playbook.md', 'references/setup.md',
  'references/presets.md'];

const read = (p) => fs.readFileSync(path.join(SKILL, p), 'utf8');
const texts = Object.fromEntries(DOCS.map((d) => [d, read(d)]));
const all = DOCS.map((d) => texts[d]).join('\n');

let fails = 0, warns = 0;
const fail = (m) => { console.log('  FAIL  ' + m); fails++; };
const warn = (m) => { console.log('  WARN  ' + m); warns++; };
const ok = (m) => console.log('  OK    ' + m);

// ---- 1. 高频结论：不同文档里的数字必须一致 ----
console.log('=== 1. 高频结论的数字一致性 ===');
const CLAIMS = [
  {
    name: '抽样把整体虚构率高估的倍数',
    // 必须锚定到「同一组数字」——文档里还有分层表的「高估 1.9 倍」（1000–3000 字那层），
    // 那是**另一个结论**且两处一致。只按「高估 N 倍」匹配会把两者混为一谈。
    find: /(?:39\.6%?\s*(?:vs|→|->)\s*15\.0%?|15\.0%?\s*(?:vs|→|->)\s*39\.6%?)[^\n]{0,40}?(\d+(?:\.\d+)?)\s*倍|高估\s*\*{0,2}(\d+(?:\.\d+)?)\s*倍[^\n]{0,40}?39\.6/g,
    pick: (m) => m[1] || m[2],
    expect: '2.6',
    hint: 'content-kind.md 第 3.4 节是权威出处',
  },
  {
    name: '抽样把分层(1000–3000字)虚构率高估的倍数',
    find: /47\.4%[^\n]{0,30}?(\d+(?:\.\d+)?)\s*倍/g,
    pick: (m) => m[1],
    expect: '1.9',
    hint: 'content-kind.md 第 3.4 节是权威出处',
  },
  {
    name: '端点签名范围（旧表述只允许作为教训引用出现）',
    // 权威出处：SKILL.md「签名要求的实际范围」。只有 questions/{id} 详情要签名。
    // `questions|answers|members 这个短语现在只允许出现在「教训引用」行里
    //  （即同一行同时含「外推/不要/错」等否定词）。出现在断言行 = 有人又把旧结论写回来了。
    check: (doc, text) => {
      const bad = [];
      text.split('\n').forEach((l, i) => {
        if (l.includes('questions|answers|members') && !/外推|不要|错|已更正|不是/.test(l)) {
          bad.push(`${doc}:${i + 1}  ${l.trim().slice(0, 80)}`);
        }
      });
      return bad;
    },
    hint: '只有 /api/v4/questions/{id} 详情要求签名；SKILL.md 是权威出处',
  },
  {
    name: '严选占 Top100 赞数比例',
    find: /Top100\s*赞数[的]?\s*\*{0,2}(\d+(?:\.\d+)?%)/g,
    expect: '45.1%',
    hint: 'content-kind.md 第 2 节是权威出处',
  },
  {
    name: 'Top20 虚构占赞数比例',
    find: /Top\s*20\s*虚构占比[^\n]*?(\d+(?:\.\d+)?%)/g,
    expect: '62.6%',
    hint: 'content-kind.md 第 2 节是权威出处',
  },
  {
    name: '内容性质总体准确率',
    // 文档里既有 `总体准确率: 97.5%` 也有表格 `| **总体** | | | **97.5%**（39/40） |`
    find: /总体准确率[:：]?\s*\*{0,2}(\d+(?:\.\d+)?%)|\*\*总体\*\*[^\n]*?(\d+(?:\.\d+)?%)/g,
    pick: (m) => m[1] || m[2],
    expect: '97.5%',
    hint: 'content-kind.md 第 10 节是权威出处',
  },
];
for (const c of CLAIMS) {
  // check 型断言：逐文档行级检查，返回违规行列表（用于「教训引用 vs 断言」这类上下文敏感的规则）
  if (c.check) {
    const bad = DOCS.flatMap((d) => c.check(d, texts[d]));
    if (bad.length) fail(`${c.name}: ${bad.length} 处断言了旧结论 —— ${bad[0]}`);
    else ok(`${c.name}: 无残留`);
    continue;
  }
  const hits = [];
  for (const d of DOCS) {
    for (const m of texts[d].matchAll(c.find)) hits.push({ doc: d, val: c.pick ? c.pick(m) : m[1] });
  }
  const vals = [...new Set(hits.map((h) => h.val))];
  const good = vals.every((v) => v === c.expect || v === c.expect.replace('%', ''));
  if (!hits.length) warn(`${c.name}: 未在任何文档中找到（${c.hint}）`);
  else if (vals.length === 1 && good) ok(`${c.name}: 全部为 ${vals[0]}（${hits.length} 处）`);
  else if (vals.length === 1) warn(`${c.name}: 全为 ${vals[0]}，但与预期 ${c.expect} 不符`);
  else fail(`${c.name}: 出现多个值 ${vals.join(' / ')} —— 已分叉（${c.hint}）`);
}

// ---- 2. 关键开关的存在性（文档教了，代码要有）----
console.log('\n=== 2. 文档提到的开关，脚本是否真的支持 ===');
const SWITCHES = [
  ['--all', 'scripts/classify-content-llm.mjs'],
  ['--exclude-paid', 'scripts/render-answers.mjs'],
  ['--exclude-kind', 'scripts/render-answers.mjs'],
  ['--profile', 'scripts/summarize-answers.mjs'],
  ['--with-kind', 'scripts/summarize-answers.mjs'],
  ['--html', 'scripts/verify-output.mjs'],
  ['--make-sample', 'scripts/eval-extraction.mjs'],
  ['--check', 'scripts/eval-extraction.mjs'],
];
for (const [flag, script] of SWITCHES) {
  const code = read(script);
  if (code.includes(flag)) ok(`${flag} 存在于 ${path.basename(script)}`);
  else fail(`${flag} 在文档里被提到，但 ${path.basename(script)} 不支持`);
}

// ---- 3. 陈旧路径 ----
// 脚本已从 tools/ 迁进 scripts/，任何还把 tools/ 当现行路径写的都是陈旧引用。
//
// ⚠️ 这里的正则曾经写成 `/tools\/(fetch|pipeline|render|...)/` —— 只认一份手写白名单，
// 于是 `tools/presets/xxx.json`、`tools/test-shell-injection.mjs` 全部漏网，
// 脚本却打印「OK 无陈旧 tools/ 路径」。**闸门报 OK 比没有闸门更糟**：
// 它让人以为没人改过。教训：宁可多报，不要靠白名单缩小匹配面。
console.log('\n=== 3. 陈旧路径 ===');
// 明确标注「这是历史/已迁移」的说明行不算陈旧引用（pipeline-v2.md 第 2 节自己就有一处）
const HISTORICAL = /历史|旧路径|已迁移|迁移前|已全部改为|别处再看到|不再是/;
let stale = 0, exempted = 0;
for (const d of DOCS) {
  texts[d].split('\n').forEach((l, i) => {
    // 同时抓 tools/xxx 与 tools\xxx 两种写法
    const hits = [...l.matchAll(/tools[/\\](?:[A-Za-z0-9_.-]+)?/g)];
    if (!hits.length) return;
    if (HISTORICAL.test(l)) { exempted++; return; }
    console.log(`  ${d}:${i + 1}  ${l.trim().slice(0, 70)}`); stale++;
  });
}
if (stale) fail(`${stale} 处仍指向已迁移的 tools/ 目录`);
else ok(`无陈旧 tools/ 路径${exempted ? `（${exempted} 处标注为历史遗留，已豁免）` : ''}`);

// ---- 4. 内部链接（大小写敏感）----
// ⚠️ Windows 的 fs.existsSync 是大小写不敏感的，所以 `](./PLAYBOOK.md)` 在
// playbook.md 实际存在时会**通过检查**，而换到任何区分大小写的系统上就是断链。
// 这里逐段对 readdir 做精确比对，把「大小写写错」也当成断链。
console.log('\n=== 4. 内部链接 ===');
function resolveExact(fromFile, rel) {
  let cur = path.dirname(path.join(SKILL, fromFile));
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { cur = path.dirname(cur); continue; }
    let names = [];
    try { names = fs.readdirSync(cur); } catch { return { ok: false, why: '目录不存在' }; }
    if (!names.includes(seg)) {
      const ci = names.find((n) => n.toLowerCase() === seg.toLowerCase());
      return { ok: false, why: ci ? `大小写不符（实际是 ${ci}）` : '文件不存在' };
    }
    cur = path.join(cur, seg);
  }
  return { ok: true, path: cur };
}
let broken = 0;
for (const d of DOCS) {
  for (const m of texts[d].matchAll(/\]\((\.\.?\/[^)#]+\.md)\)/g)) {
    const r = resolveExact(d, m[1]);
    if (!r.ok) { console.log(`  BROKEN ${d} → ${m[1]}  (${r.why})`); broken++; }
  }
}
if (broken) fail(`${broken} 个断链`); else ok('全部有效（含大小写精确比对）');

// ---- 5. 脚本清单是否与目录一致 ----
console.log('\n=== 5. 脚本清单 ===');
const actual = fs.readdirSync(path.join(SKILL, 'scripts')).filter((f) => f.endsWith('.mjs'));
const undocumented = actual.filter((f) => !texts['references/scripts.md'].includes(f));
if (undocumented.length) warn(`未在 scripts.md 记录: ${undocumented.join(', ')}`);
else ok(`${actual.length} 个脚本全部已记录`);

// ---- 6. 会写产物的脚本是否都加锁 ====
console.log('\n=== 6. 会写产物的脚本是否都加锁 ===');
const writers = actual.filter((f) => {
  const s = read('scripts/' + f);
  return /writeFileSync\(OUT|writeFileSync\(STATE/.test(s)
    && !/^verify|^eval|^check|^doctor|^ck-|^test-|^render-answers|^render-publish|^build-index|^fill-one/.test(f);
});
for (const f of writers) {
  const s = read('scripts/' + f);
  if (s.includes('acquireLock')) ok(`${f} 有锁`);
  else warn(`${f} 无锁`);
}

// ---- 7. 预设清单 vs presets/ 目录 ----
// 2026-10-15 实测分叉：`presets/cpu.json` 上线后，scripts.md 的预设表仍只列
// books / pythonlibs —— 于是「有这个预设」这件事只存在于文件系统里。
console.log('\n=== 7. 预设清单 ===');
const presetDir = path.join(SKILL, 'scripts/presets');
const presets = fs.readdirSync(presetDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
const missingInDoc = presets.filter((n) => !all.includes('`' + n + '`'));
if (missingInDoc.length) fail(`presets/ 里存在但文档从未提及: ${missingInDoc.join(', ')}`);
else ok(`${presets.length} 个预设全部已记录（${presets.join(', ')}）`);

// ---- 8. 脚本清单的重复行与幽灵文件 ----
// 「只朝一个方向比对」是上一版的漏洞：目录 → 文档查了，文档 → 目录没查，
// 于是 `_old-*.mjs` 这种**一批并不存在的文件**在文档里留了很久。
console.log('\n=== 8. 脚本清单的重复与幽灵 ===');
const sm = texts['references/scripts.md'];
const mentioned = [...new Set([...sm.matchAll(/`([A-Za-z0-9_][A-Za-z0-9_.-]*\.mjs)`/g)].map((m) => m[1]))];
const ghosts = mentioned.filter((f) => !actual.includes(f));
const rows = [...sm.matchAll(/^\|\s*\**`([^`]+\.mjs)`/gm)].map((m) => m[1]);
const dup = [...new Set(rows.filter((r, i) => rows.indexOf(r) !== i))];
if (ghosts.length) fail(`scripts.md 提到但 scripts/ 里不存在的脚本: ${ghosts.join(', ')}`);
else ok(`${mentioned.length} 个被提到的脚本全部存在`);
if (dup.length) warn(`脚本清单里有重复行: ${dup.join(', ')}`);
else ok('脚本清单无重复行');

// ---- 9. 产物目录字面量 ----
// 「产物在 Default Project/」这类写死的旧目录会和 resolveOutDir() 打架，
// 而且**同一份文档里可能前后矛盾**（scripts.md 曾同时写着两个目录）。
// 判定看**上下文窗口**而不只是本行：表格行自己不会写「历史」，
// 但它的引言会（例：「实测事故（2026-10-14）」）—— 逐行判定会误报这类历史记录。
console.log('\n=== 9. 产物目录字面量 ===');
let outBad = 0;
for (const d of DOCS) {
  const lines = texts[d].split('\n');
  lines.forEach((l, i) => {
    if (!/Default Project/.test(l)) return;
    const ctx = lines.slice(Math.max(0, i - 8), i + 1).join('\n');
    const dated = /20\d\d-\d\d-\d\d/.test(ctx) && /实测|事故|当时|曾/.test(ctx);
    if (HISTORICAL.test(ctx) || dated) return;
    console.log(`  ${d}:${i + 1}  ${l.trim().slice(0, 70)}`); outBad++;
  });
}
if (outBad) fail(`${outBad} 处把旧产物目录当现行目录写（现行由 resolveOutDir() 解析）`);
else ok('无写死的旧产物目录（历史记录已按上下文窗口豁免）');

// ---- 10. answer_type 的取值 ----
// 实测是**三值**：normal / paid / paid_column_content（q665321619：1960/101/3）。
// 文档写成二值会诱导出 `=== 'paid'` 这种判断，静默漏掉 paid_column_content。
console.log('\n=== 10. answer_type 取值 ===');
let atBad = 0;
for (const d of DOCS) {
  texts[d].split('\n').forEach((l, i) => {
    if (!l.includes('answer_type')) return;
    const hasNormal = /normal/.test(l), hasPaid = /paid/.test(l);
    if (hasNormal && hasPaid && !l.includes('paid_column_content')) {
      console.log(`  ${d}:${i + 1}  ${l.trim().slice(0, 80)}`); atBad++;
    }
  });
}
if (atBad) fail(`${atBad} 处把 answer_type 描述成二值 —— 实测三值，判定须用 !== 'normal'`);
else ok('answer_type 取值描述一致（三值）');


console.log(`\n${fails ? '✗' : '✓'} 结论：${fails} 项 FAIL，${warns} 项 WARN`);
process.exit(fails ? 1 : 0);
