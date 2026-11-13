// 产物校验 / 回归基线 —— 流水线跑完后用它判定「这次产物是否可用」
//
// 为什么需要：LLM 抽取阶段的失败是**静默**的 ——
//   · 模型会返回数据集里不存在的 ID（实测出现过 2144820996），统计口径就对不上了
//   · 失败批写 {kind:''} 空值，而空对象是 truthy，续跑逻辑会当成「已完成」永久跳过
//   · 枚举值会被 token 截断（offtopic → ofstof），不归一就静默失真
//   · **抓取阶段字段名对不上**：votes 缺失时赞数合计为 0，而所有「按赞排序」的口径
//     会退化成随机排序 —— 报告照样生成，数字全错（2026-10-15 差点照报）
//   · **实体抽取的捕获组吞了裸前缀**：`Ryzen 3 3200G` 被抽成 `3 3200G`，
//     榜单排序看着正常，但列出来的是没人这么写的碎片（2026-10-16 实证）
// 这些都不会报错，只会在报告里变成错的数字。所以每次跑完都要过一遍本脚本。
//
// 设计原则：**能判定的就不要只打印**。基线指标曾经只 console.log 出来给人对比，
// 于是「赞数合计 = 0」这种东西就不会有人发现。凡是能写断言的，一律写断言。
//
// 用法:
//   node verify-output.mjs <answers-full.json> [--entities e.json] [--kind k.json] [--themes t.json] [--summaries s.json]
//   node verify-output.mjs <answers-full.json> --baseline   # 只输出基线指标（用于前后对比）
//
// 退出码: 0 = 全部通过；1 = 有 FAIL（CI / 自动化里可直接用）
import fs from 'node:fs';

const argv = process.argv.slice(2);
const IN = argv.find((a) => a.endsWith('.json'));
if (!IN) { console.error('用法: node verify-output.mjs <answers-full.json> [--entities e.json] [--kind k.json] [--themes t.json] [--summaries s.json] [--html out.html]'); process.exit(1); }
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const BASE = IN.replace(/-answers-full\.json$/, '');
const HTML = opt('--html', '');
const load = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };

const answers = load(IN);
if (!Array.isArray(answers)) { console.error('读不到回答数据: ' + IN); process.exit(1); }
const KIND = load(opt('--kind', BASE + '-content-kind.json'));
const THEMES = load(opt('--themes', BASE + '-themes.json'));
const SUM = load(opt('--summaries', BASE + '-summaries.json'));
const KIND_FILE = opt('--kind', BASE + '-content-kind.json');
const THEMES_FILE = opt('--themes', BASE + '-themes.json');
const SUM_FILE = opt('--summaries', BASE + '-summaries.json');

const ids = new Set(answers.map((x) => String(x.id)));
let fails = 0, warns = 0;
const fail = (m) => { console.log('  FAIL  ' + m); fails++; };
const warn = (m) => { console.log('  WARN  ' + m); warns++; };
const ok = (m) => console.log('  OK    ' + m);

// ---------- 0. 基线指标（前后对比用）----------
console.log('=== 基线指标 ===');
const totalVotes = answers.reduce((s, a) => s + (a.votes || 0), 0);
const totalChars = answers.reduce((s, a) => s + (a.content || '').length, 0);
console.log(`  回答数        ${answers.length}`);
console.log(`  赞数合计      ${totalVotes.toLocaleString('en-US')}`);
console.log(`  正文总字数    ${totalChars.toLocaleString('en-US')}`);
console.log(`  唯一 ID 数    ${ids.size}`);
const paid = answers.filter((a) => a.answer_type && a.answer_type !== 'normal').length;
const withFlags = answers.filter((a) => a.answer_type !== undefined).length;
console.log(`  带 answer_type 字段  ${withFlags} / ${answers.length}${withFlags < answers.length ? '  ← 未抓全，需要 enrich-flags' : ''}`);
console.log(`  其中严选 paid        ${paid}`);
console.log(`  带感谢数字段         ${answers.filter((a) => a.thanks != null).length}`);

// 基线自洽断言：以下四项此前**只打印不判定**，而它们每一个出问题都是静默的。
// 抓取层字段名一旦错位（例如把 votes 写成 voteup_count），赞数合计会变成 0，
// 于是所有「按赞数排序/加权」的口径全部退化成随机排序 —— 报告照样出，数字全错。
const noVotes = answers.filter((a) => a.votes == null).length;
console.log(`  缺 votes 字段        ${noVotes}`);
if (answers.length && totalVotes === 0) {
  fail('赞数合计为 0 —— votes 字段名错位（接口原始字段是 voteup_count），按赞排序的口径已退化成随机');
} else if (answers.length && noVotes > answers.length * 0.5) {
  fail(`${noVotes}/${answers.length} 条没有 votes 字段 —— 抓取时字段名对不上`);
} else if (answers.length && totalVotes < answers.length * 0.5) {
  warn(`赞数合计 ${totalVotes} 低于回答数的 0.5 倍（${(answers.length * 0.5).toFixed(0)}）—— 疑似大面积漏抓赞数`);
}
if (answers.length && totalChars === 0) {
  fail('正文总字数为 0 —— content 字段缺失，摘要与内容性质判定都没有输入');
}
if (ids.size !== answers.length) {
  fail(`唯一 ID ${ids.size} ≠ 回答数 ${answers.length} —— 有 ${answers.length - ids.size} 条重复（或 id 缺失），去重逻辑失效`);
}
if (ids.has('undefined') || ids.has('null')) {
  fail('有回答缺 id 字段 —— 溯源链接与打标回填都会错位');
}

// ---------- 1. answer_type 覆盖率 ----------
console.log('\n=== 1. 抓取字段完整性 ===');
if (withFlags === 0) {
  warn('全部没有 answer_type —— 抓取时 include 漏了该字段（故事征集题必补，见 content-kind.md）');
} else if (withFlags < answers.length) {
  const miss = answers.length - withFlags;
  fail(`有 ${miss} 条缺 answer_type —— 可能是旧 state 缓存导致分页被跳过，需要重抓或 enrich`);
} else {
  ok('answer_type 覆盖全部回答');
}

// ---------- 2. 内容性质判定 ----------
if (!KIND) {
  console.log('\n=== 2. 内容性质 ===\n  （无 content-kind.json，跳过）');
} else {
  console.log('\n=== 2. 内容性质判定 ===');
  const P = KIND.perAnswer || {};
  const keys = Object.keys(P);
  const orphans = keys.filter((k) => !ids.has(k));
  const empty = keys.filter((k) => !(P[k] && P[k].kind));
  const VALID = new Set(['real', 'fiction', 'adapted', 'offtopic']);
  const badEnum = keys.filter((k) => P[k] && P[k].kind && !VALID.has(P[k].kind));
  const missing = [...ids].filter((k) => !P[k] || !P[k].kind);

  console.log(`  mode=${KIND.mode || '(未标注)'}  判定 ${keys.length} 条`);
  if (orphans.length) fail(`模型臆造了 ${orphans.length} 个不存在的 ID（例：${orphans.slice(0, 3).join(', ')}）—— 统计前必须剔除`);
  else ok('无孤儿 ID');
  if (badEnum.length) fail(`有 ${badEnum.length} 条枚举值非法（例：${badEnum.slice(0, 3).map((k) => P[k].kind).join(', ')}）—— 前缀归一失效`);
  else ok('枚举值全部合法');
  if (empty.length) warn(`${empty.length} 条空 kind —— 续跑时会被当成「已完成」跳过，需先清除再重跑`);
  if (missing.length) {
    const pct = (missing.length / answers.length * 100).toFixed(1);
    if (KIND.mode === 'all') fail(`全量模式仍有 ${missing.length} 条未判定（${pct}%）`);
    else console.log(`  提示  ${missing.length} 条未判定（${pct}%）—— 抽样模式属正常，但报告里必须写「未判定 ≠ 真实经历」`);
  } else ok('全部回答已判定');
  const cnt = {};
  for (const a of answers) { const k = (P[String(a.id)] || {}).kind || '未判定'; cnt[k] = (cnt[k] || 0) + 1; }
  console.log('  分布: ' + JSON.stringify(cnt));
}

// ---------- 3. 母题 / 观点 ----------
if (!THEMES) {
  console.log('\n=== 3. 母题/观点 ===\n  （无 themes.json，跳过）');
} else {
  console.log('\n=== 3. 母题/观点 ===');
  const P = THEMES.perAnswer || {};
  const taxIds = new Set((THEMES.taxonomy || []).map((t) => String(t.id)));
  const orphans = Object.keys(P).filter((k) => !ids.has(k));
  const badTag = Object.entries(P).filter(([, v]) => (v || []).some((t) => !taxIds.has(String(t))));
  const tagged = Object.values(P).filter((v) => (v || []).length).length;
  console.log(`  标签体系 ${taxIds.size} 类，打标覆盖 ${tagged} / ${answers.length}`);
  if (orphans.length) fail(`打标结果里有 ${orphans.length} 个不存在的 ID`);
  else ok('无孤儿 ID');
  if (badTag.length) fail(`有 ${badTag.length} 条的标签不在体系内（模型自造标签）`);
  else ok('标签全部来自体系');
  // 溯源链接
  const badUrl = (THEMES.themes || []).flatMap((t) => t.samples || []).filter((s) => !/^https:\/\/www\.zhihu\.com\/question\/\d+\/answer\/\d+$/.test(s.url || ''));
  if (badUrl.length) fail(`${badUrl.length} 个溯源链接格式非法`);
  else ok('溯源链接格式正确');
}

// ---------- 4. 摘要 ----------
if (!SUM) {
  console.log('\n=== 4. 摘要 ===\n  （无 summaries.json，跳过）');
} else {
  console.log('\n=== 4. 摘要 ===');
  const P = SUM.perAnswer || {};
  const orphans = Object.keys(P).filter((k) => !ids.has(k));
  const target = answers.filter((a) => (a.content || '').trim().length >= 80);
  const covered = target.filter((a) => P[String(a.id)]).length;
  console.log(`  摘要覆盖 ${covered} / ${target.length}（正文≥80字）`);
  if (orphans.length) fail(`摘要里有 ${orphans.length} 个不存在的 ID`);
  else ok('无孤儿 ID');
  if (covered < target.length * 0.98) fail(`摘要覆盖率 ${(covered / target.length * 100).toFixed(1)}% < 98%，可能有批次静默失败`);
  else ok('摘要覆盖率达标');
  if (!SUM.digest) warn('综述缺失（digest 为空）');
}

// ---------- 5. 口径自洽 ----------
console.log('\n=== 5. 口径自洽 ===');
if (KIND && THEMES) {
  // 被剔除的内容不应出现在母题溯源里
  const kept = new Set(answers.filter((a) => (!a.answer_type || a.answer_type === 'normal')).map((a) => String(a.id)));
  const leaked = (THEMES.themes || []).flatMap((t) => t.samples || []).filter((s) => !kept.has(String(s.answerId)));
  if (leaked.length) warn(`${leaked.length} 条严选内容出现在母题溯源里（渲染时若用 --exclude-paid 应已重算）`);
  else ok('母题溯源不含已剔除内容');
}

// ---------- 6. 实体产物 ----------
// 实体抽取的失败同样是**静默**的：
//   · 抽取规则的捕获组一旦把「裸前缀」吞进型号名，产物里就会出现 `3 3200G` 这种
//     没人这么写的碎片（2026-10-16 实证：`Ryzen 3 3200G` 被吞成 `3 3200G`）。
//     榜单照样出、排序看着正常，但名字不是型号，报告没法用。
//   · 别名归一的账目必须闭合：原始写法数 - 实体数 === Σ(每组 members - 1)。
//     对不上说明合并只做了一半（改了名没合并 / 合并了没记账）。
const ENT_FILE = opt('--entities', BASE + '-entities.json');
const ENT = load(ENT_FILE);
if (!ENT || !Array.isArray(ENT.entities)) {
  console.log('\n=== 6. 实体产物 ===\n  （无 entities.json，跳过）');
} else {
  console.log('\n=== 6. 实体产物 ===');
  const ents = ENT.entities;
  const names = ents.map((e) => e.name);
  console.log(`  实体 ${ents.length}   预设 ${ENT.preset || '(未标注)'}   来源 ${ENT.source ? '已交底' : '未交底'}`);

  if (!ents.length) fail('实体数为 0');

  const frag = names.filter((n) => /^\d+\s/.test(n));
  if (frag.length) fail(`${frag.length} 个实体名以「数字+空白」开头 —— 捕获组吞了裸前缀（如 Ryzen 3 3200G → 3 3200G）：${frag.slice(0, 3).join(' / ')}`);
  else ok('无「数字+空白」开头的碎片实体名');

  const dupN = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (dupN.length) fail(`实体名重复 ${dupN.length} 种（报告会出多个同名区块）：${dupN.slice(0, 3).join(' / ')}`);
  else ok('实体名唯一');

  const N = ENT.normalized;
  if (!N) {
    console.log('  （预设未声明别名归一，跳过账目校验）');
  } else if (!Array.isArray(N.groupsDetail)) {
    fail('normalized 缺 groupsDetail —— 合并口径不可查（改名了但没记账）');
  } else {
    if (N.after !== ents.length) fail(`normalized.after=${N.after} ≠ 实体数 ${ents.length}`);
    if (N.groups !== N.groupsDetail.length) fail(`normalized.groups=${N.groups} ≠ groupsDetail 长度 ${N.groupsDetail.length}`);
    const noMem = N.groupsDetail.filter((g) => typeof g.members !== 'number');
    if (noMem.length) {
      fail(`${noMem.length} 个合并组缺 members 字段 —— 归一账目不可校验`);
    } else {
      const removed = N.before - N.after;
      const absorbed = N.groupsDetail.reduce((s, g) => s + g.members - 1, 0);
      if (removed !== absorbed) fail(`归一账目不闭合：原始写法 ${N.before} - 实体 ${N.after} = ${removed}，各组只吸收了 ${absorbed} —— 合并只做了一半`);
      else ok(`归一账目闭合：${N.before} 个原始写法 → ${N.after} 个实体（${N.groupsDetail.length} 组，吸收 ${absorbed} 个写法）`);
    }
    const selfRef = N.groupsDetail.filter((g) => (g.from || []).includes(g.to));
    if (selfRef.length) fail(`${selfRef.length} 个合并组的 from 里含自己（${selfRef[0].to}）`);
    const fromAll = N.groupsDetail.flatMap((g) => g.from || []);
    const dupFrom = [...new Set(fromAll.filter((n, i) => fromAll.indexOf(n) !== i))];
    if (dupFrom.length) fail(`有写法被记进了多个合并组：${dupFrom.slice(0, 3).join(' / ')}`);
    const ghost = fromAll.filter((n) => names.includes(n));
    if (ghost.length) fail(`${ghost.length} 个被合并的写法仍作为独立实体存在：${ghost.slice(0, 3).join(' / ')}`);
    else ok('被合并的写法均已吸收，无残留独立实体');
  }
}

// ---------- 7. 渲染后的 HTML ----------
// JSON 产物没问题不代表页面没问题：渲染层有自己的 bug 面
// （模板变量没插值、综述口径选错、剔除开关没生效）。
// 流水线有**两种** HTML，结构完全不同，闸门必须先认出是哪一种 ——
//   · 交互汇总页 render-answers.mjs → 内嵌 <script id="data"> 数据块，页面自己渲染
//   · 静态报告页 render-report.mjs → 数据已经渲成 DOM，**没有**数据块
// 以前这里不分青红皂白只找数据块，于是把好好的报告页判成「页面坏了」，
// 看的人只会以为产物是垃圾（2026-10-16 实证）。
if (HTML) {
  console.log('\n=== 7. 渲染后的 HTML ===');
  const html = fs.existsSync(HTML) ? fs.readFileSync(HTML, 'utf8') : null;
  if (!html) {
    fail(`找不到 ${HTML}`);
  } else {
    // 模板插值残留 —— 两种模板通用
    const uniq = [...new Set([...html.matchAll(/\$\{[A-Za-z_][A-Za-z0-9_.]*\}/g)].map((x) => x[0]))];
    if (uniq.length) fail(`页面残留未插值的模板变量 ${uniq.length} 种：${uniq.slice(0, 4).join(' ')}`);
    else ok('无未插值的模板变量');

    const m = html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/);
    const looksReport = /class="charts"/.test(html) && /data-n="/.test(html);

    if (m) {
      console.log('  模板  交互汇总页（render-answers.mjs）');
      const D = JSON.parse(m[1]);
      const pageIds = new Set(D.answers.map((a) => String(a.id)));
      const orphan = [...pageIds].filter((id) => !ids.has(id));
      console.log(`  页面回答数 ${D.answers.length}${D.answers.length !== answers.length ? `（源数据 ${answers.length}，差 ${answers.length - D.answers.length} = 被剔除）` : ''}`);
      if (orphan.length) fail(`页面里有 ${orphan.length} 个源数据中不存在的回答 ID`);
      else ok('页面回答 ID 全部来自源数据');

      // 剔除开关是否真的生效
      const paidInPage = D.answers.filter((a) => a.paid).length;
      const excluded = answers.length - D.answers.length;
      if (excluded > 0 && paidInPage > 0) fail(`已剔除 ${excluded} 条但页面仍有 ${paidInPage} 条 paid`);
      else if (excluded > 0) ok(`剔除生效：${excluded} 条已移除，页面无 paid 残留`);
      else ok(`未剔除（页面 ${D.answers.length} 条，含 paid ${paidInPage}）`);

      // 综述口径是否与剔除范围匹配
      const wantNopaid = excluded > 0;
      const digestTxt = JSON.stringify(D.digest || {});
      // 用「被剔除内容的特征」反查：若剔了 paid，综述不应再引用它们的赞数
      const paidVotes = answers.filter((a) => a.answer_type && a.answer_type !== 'normal').map((a) => a.votes);
      const hitPaid = paidVotes.filter((v) => v > 500 && digestTxt.includes(String(v)));
      if (wantNopaid && hitPaid.length) warn(`综述里出现被剔除严选内容的赞数（${hitPaid.slice(0, 3).join(', ')}），可能选错了综述口径`);
      else ok('综述口径与剔除范围一致');

      if (D.answers.some((a) => !('kind' in a))) fail('页面回答缺 kind 字段（未传 --kind 或数据未回填）');
      else ok('页面回答带 kind 字段');
    } else if (looksReport) {
      console.log('  模板  静态报告页（render-report.mjs）');
      // 报告页把实体渲成 DOM，每行带 data-n="<名字小写>"。产物在手上就逐行对账 ——
      // 「渲染层只渲了 TOP N」「名字被转义坏」这类问题都是静默的。
      if (ENT && Array.isArray(ENT.entities)) {
        const want = ENT.entities.map((e) => String(e.name || '').toLowerCase()).sort();
        const got = [...html.matchAll(/data-n="([^"]*)"/g)].map((x) => x[1]).sort();
        if (got.length !== want.length) {
          fail(`页面实体行 ${got.length} ≠ 产物实体 ${want.length} —— 渲染漏行或多行（例如只渲了 TOP N）`);
        } else if (got.join('\u0000') !== want.join('\u0000')) {
          const bad = got.filter((n, i) => n !== want[i]);
          fail(`页面实体名与产物不一致：${bad.slice(0, 3).join(' / ')}`);
        } else {
          ok(`页面实体行与产物一一对应（${got.length} 行）`);
        }
      } else {
        console.log('  提示  未传 --entities，无法把页面实体行与产物对账');
      }
      // 页头统计卡必须与源数据一致。统计卡找不到时**必须 FAIL** ——
      // 标签一改，这个校验就会静默地什么都不查，那还不如没有。
      const statOf = (label) => {
        const mm = html.match(new RegExp('<b>([\\d,]+)</b><span>' + label + '</span>'));
        return mm ? Number(mm[1].replace(/,/g, '')) : null;
      };
      const shownChars = statOf('正文总字数');
      const shownVotes = statOf('回答赞数总计');
      if (shownChars === null || shownVotes === null) {
        fail('报告页找不到「正文总字数 / 回答赞数总计」统计卡 —— 模板改过了，本闸门需要同步更新（不要让它静默跳过）');
      } else if (shownChars !== totalChars || shownVotes !== totalVotes) {
        fail(`页面统计卡与源数据不一致：正文 ${shownChars.toLocaleString('en-US')} vs ${totalChars.toLocaleString('en-US')}；赞 ${shownVotes.toLocaleString('en-US')} vs ${totalVotes.toLocaleString('en-US')}`);
      } else {
        ok(`页面统计卡与源数据一致（正文 ${shownChars.toLocaleString('en-US')} 字 / 赞 ${shownVotes.toLocaleString('en-US')}）`);
      }
    } else {
      fail('这个 HTML 既不是汇总页（无 <script id="data">）也不是报告页（无 class="charts" + data-n）—— 不是本流水线的产物，或产物被改坏了');
    }
  }
}

console.log(`\n${fails ? '✗' : '✓'} 结论：${fails} 项 FAIL，${warns} 项 WARN`);
process.exit(fails ? 1 : 0);
