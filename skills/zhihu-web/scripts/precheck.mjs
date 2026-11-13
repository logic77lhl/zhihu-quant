// 开工前置检查：产物 / 输出目录 / 桥接
//
// 为什么需要（实测事故 2026-10-15）：
//   要"梳理"一个知乎问题，结果 q<ID>-answers-full.json 早在两小时前就躺在
//   zhihu-quant/ 里了。会话没查就重抓了一遍 —— 换了另一条通路、正文被截断到 200 字、
//   还落错了目录。约 400 次请求白花，拿型号提及榜当结论报了出去，是错的。
//   根因不是"忘了看文件"，是**没有任何东西强制你先看**。
//
// 定位：**闸门，不是仪式步骤。**
//   写成人人要记得先跑一遍的检查，等于没写 —— SKILL.md 里的散文规则今天已经被违反过一次
//   （403 返回快被当成"成功"，得出"并发提速 3.9 倍"的假结论）。
//   散文靠不住，exit 才靠得住。所以 fetch-answers-api.mjs 直接 import 本模块并在其前面 exit(3)。
//
// 用法:
//   node precheck.mjs <questionId> [--force] [--json] [--no-bridge]
//   node precheck.mjs --dirs            只看输出目录解析与候选目录，不查具体问题
//
// 退出码:
//   0  READY             可以开工
//   3  ARTIFACT_EXISTS   产物已存在且看起来完整 —— 复用，不要重抓（--force 可绕过）
//   4  BRIDGE_DOWN       桥接不通 —— 报告已验证内容，等用户操作，不要自己改浏览器
//   5  OUTDIR_MISMATCH   产物散落在非解析出的目录里 —— 先决定用哪个目录，不要两边各抓一份
//   6  PUBLISH_BLOCKED   发布版产物存在，但轻检不通过（过期/占位符/缺台账）—— --publish 专用
//
// 深诊断不在这里：桥接/签名/端点逐项复核走 check.mjs，precheck 只做快速闸门。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { panerelay } from './panerelay-run.mjs';
import { bridgeAdvice } from './bridge-advice.mjs';
import { contactLooksUsable } from './publish-rules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PAGE = 20;                      // 分页接口上限，见 fetch-answers-api.mjs

/** 输出目录解析：$ZHIHU_QUANT_OUT → skill 的 config.json → ~/Documents/zhihu-quant
 *  与 fetch-answers-api.mjs 保持同一套优先级，两边算出同一个目录才算数。 */
export function resolveOutDir() {
  if (process.env.ZHIHU_QUANT_OUT) return process.env.ZHIHU_QUANT_OUT;
  for (const p of [path.join(HERE, '..', 'config.json'), path.join(HERE, '..', '..', 'config.json')]) {
    try { const c = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); if (c.outDir) return c.outDir; } catch {}
  }
  return path.join(process.env.USERPROFILE || process.env.HOME, 'Documents', 'zhihu-quant');
}

/** 所有可能被历史污染的目录。产物散落在多个目录是实测过的（Default Project/ 与 zhihu-quant/），
 *  所以只查解析出的那一个会漏。 */
export function candidateDirs() {
  const home = process.env.USERPROFILE || process.env.HOME;
  const dirs = [resolveOutDir()];
  if (process.env.ZHIHU_QUANT_OUT) dirs.push(process.env.ZHIHU_QUANT_OUT);
  try {
    const c = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (c.outDir) dirs.push(c.outDir);
  } catch {}
  dirs.push(path.join(home, 'Documents', 'zhihu-quant'));
  dirs.push(path.join(home, 'Documents', 'Default Project'));
  dirs.push(os.tmpdir());
  return [...new Set(dirs.map((d) => path.resolve(d)).filter((d) => fs.existsSync(d)))];
}

/** 抓取产物是否"完整"：state 里每个排序的每一页都标了 done，且没记录失败页。
 *  判不出来就返回 null（= 未知），绝不把未知当完整。 */
function completeness(artFile, stateFile) {
  let st = null;
  try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, '')); } catch {}
  if (!st || !st.done) return { complete: null, reason: '没有可读的 state（可能不是分页抓取产物）', count: countOf(artFile) };
  const done = st.done, totals = st.totals || {}, failed = st.failed || [];
  const miss = [];
  for (const [sort, tot] of Object.entries(totals)) {
    if (!tot) continue;
    for (let off = 0; off < tot; off += PAGE) if (!done[`${sort}:${off}`]) miss.push(`${sort}:${off}`);
  }
  const count = countOf(artFile);
  return {
    complete: miss.length === 0 && failed.length === 0,
    missingPages: miss.slice(0, 8), missingN: miss.length,
    failedN: Array.isArray(failed) ? failed.length : 0,
    totals, count, version: st.version,
  };
}

function countOf(f) {
  try { const a = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(a) ? a.length : null; }
  catch { return null; }
}

const kb = (p) => { try { return (fs.statSync(p).size / 1024).toFixed(0) + ' KB'; } catch { return '?'; } };
const ago = (p) => {
  try {
    const m = Math.round((Date.now() - fs.statSync(p).mtimeMs) / 60000);
    return m < 60 ? `${m} 分钟前` : `${Math.round(m / 60)} 小时前`;
  } catch { return '?'; }
};

/** 轻量桥接检查：桥接连通 + Cookie 真的注入了。
 *  whoami 只证明桥接连通，不证明 Cookie 带上 —— attachedCookieCount > 0 才是关键。
 *  刻意不在这里做端点签名复核：那会诱发"探兄弟端点再外推"的错误推断（见 check.mjs 注释）。 */
export function probeBridge() {
  const who = panerelay(['zhihu', 'whoami', '--json'], { timeout: 45000 });
  if (/Bridge is unavailable/i.test(who.text || '')) return { ok: false, why: 'BRIDGE_DOWN', detail: '桥接未连接' };
  if (!who.ok) return { ok: false, why: 'COMMAND_FAILED', detail: (who.text || '').trim().slice(0, 200) };
  let acct = null;
  try { const j = JSON.parse(who.text); acct = Array.isArray(j) ? j[0] : j; } catch {}
  if (!acct?.logged_in) return { ok: false, why: 'NOT_LOGGED_IN', detail: '桥接通但未登录' };
  const f = panerelay(['fetch', 'https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=2', '--response', 'json'], { timeout: 45000 });
  let n = null;
  try { const j = JSON.parse(f.text); n = j.attachedCookieCount ?? j.body?.attachedCookieCount ?? null; } catch {}
  if (n === null) return { ok: false, why: 'COOKIE_UNKNOWN', detail: '解析 attachedCookieCount 失败' };
  if (n === 0) return { ok: false, why: 'COOKIE_NOT_INJECTED', detail: '桥接通但 Cookie 一个没带上 —— 扩展缺 host_permissions' };
  return { ok: true, account: acct.name, token: acct.url_token, uid: acct.uid, cookies: n };
}

/** 发布版产物的轻检：只回答「有没有 / 过没过期 / 联系方式能不能用 / 占比超没超」。
 *  完整核对（引用是否原文、页面是否搬运、数字是否自洽）走 verify-publish.mjs —— 这里故意不做重活。 */
export function publishState(qid) {
  const dir = path.resolve(resolveOutDir());
  const html = path.join(dir, `q${qid}-发布版.html`);
  const citFile = path.join(dir, `q${qid}-发布版-citations.json`);
  const srcFile = path.join(dir, `q${qid}-answers-full.json`);
  const info = { exists: fs.existsSync(html), dir, html, citFile, srcFile, problems: [], cit: null, ratio: null, quotes: null, sizeKB: null, at: null };
  if (!info.exists) return info;
  info.sizeKB = Number((fs.statSync(html).size / 1024).toFixed(1));
  info.at = ago(html);
  try { info.cit = JSON.parse(fs.readFileSync(citFile, 'utf8').replace(/^\uFEFF/, '')); } catch {}
  if (!info.cit) info.problems.push('缺引用台账（或无法解析）—— 重出报告');
  else {
    info.quotes = Array.isArray(info.cit.quotes) ? info.cit.quotes.length : null;
    const gen = Date.parse(info.cit.generatedAt || '');
    if (fs.existsSync(srcFile) && Number.isFinite(gen) && fs.statSync(srcFile).mtimeMs > gen + 120_000) {
      info.problems.push('源数据比报告新 —— 数字已过期，重出');
    }
    const f = info.cit.filters || {};
    if (f.keepAnon || f.keepOrg || f.keepPaid) info.problems.push('生成时关闭了剔除（keepAnon/keepOrg/keepPaid）');
  }
  let text = '';
  try { text = fs.readFileSync(html, 'utf8'); } catch {}
  const m = /请联系\s*([^，。；<]+)/.exec(text);
  if (!m) info.problems.push('找不到撤稿/授权联系方式');
  else if (!contactLooksUsable(m[1])) info.problems.push(`联系方式不可用：${m[1].trim().slice(0, 40)}`);
  const r = /占样本正文\s*([\d.]+)%/.exec(text);
  if (r) info.ratio = Number(r[1]);
  if (info.ratio != null && info.ratio > 1) info.problems.push(`引用占比 ${info.ratio}% > 1%`);
  if (!/AI\s*辅助生成/.test(text)) info.problems.push('缺显式 AI 标识');
  return info;
}

/** 核心：只做本地判断，不发网络请求（除非 probeBridge）。可安全地被下游 import。 */
export function assess(qid, { probe = false, force = false } = {}) {
  const outDir = path.resolve(resolveOutDir());
  const dirs = candidateDirs();
  const found = [];
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!new RegExp(`^q${qid}-`).test(n)) continue;
      found.push({ dir: d, name: n, path: path.join(d, n), kb: kb(path.join(d, n)), at: ago(path.join(d, n)) });
    }
  }

  const inResolved = found.filter((f) => path.resolve(f.dir) === outDir);
  const elsewhere = found.filter((f) => path.resolve(f.dir) !== outDir);

  let answers = null;
  for (const f of inResolved) {
    if (/-answers-full\.json$/.test(f.name)) answers = { ...f, ...completeness(f.path, f.path + '.state.json') };
  }

  const blockers = [];
  let code = 0;

  if (elsewhere.length) {
    code = Math.max(code, 5);
    blockers.push({
      kind: 'OUTDIR_MISMATCH',
      msg: `产物散落在 ${elsewhere.length} 个非解析目录里 —— 先决定用哪个，别两边各抓一份`,
      detail: elsewhere.map((f) => `      ${f.path}  (${f.at})`),
    });
  }

  if (answers && answers.complete === true && !force) {
    code = Math.max(code, 3);
    blockers.push({
      kind: 'ARTIFACT_EXISTS',
      msg: `产物已完整：${answers.count} 条（--force 可强制重抓）`,
      detail: [`      ${answers.path}`, `      ${answers.kb}  ${answers.at}  state.version=${answers.version}`],
    });
  } else if (answers && answers.complete === false && !force) {
    blockers.push({
      kind: 'ARTIFACT_PARTIAL',
      msg: `产物不完整（缺 ${answers.missingN} 页，失败 ${answers.failedN} 页）—— 可以续跑，会跳过已完成的页`,
      detail: [`      ${answers.path}`, `      已存 ${answers.count} 条`],
    });
  }

  let bridge = null;
  if (probe) {
    bridge = probeBridge();
    if (!bridge.ok) {
      code = Math.max(code, 4);
      blockers.push({
        kind: bridge.why,
        msg: '桥接/登录态不可用 —— 报告已验证的内容并等用户操作，不要自行改浏览器配置',
        detail: [`      ${bridge.detail}`],
      });
    }
  }

  return { qid: String(qid), code, ready: code === 0, blockers, outDir, dirs, found, inResolved, elsewhere, answers, bridge };
}

// ---------------- CLI ----------------
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const flag = (f) => argv.includes(f);
  const qidArg = argv.find((a) => /^\d+$/.test(a));

  if (!qidArg && flag('--dirs')) {
    console.log(`解析输出目录: ${path.resolve(resolveOutDir())}`);
    console.log(`  来源: ${process.env.ZHIHU_QUANT_OUT ? '$ZHIHU_QUANT_OUT' : 'config.json / 默认值'}`);
    console.log('\n候选目录（历史上产物散落过）：');
    for (const d of candidateDirs()) {
      let n = 0;
      try { n = fs.readdirSync(d).filter((x) => /^q\d+-/.test(x)).length; } catch {}
      console.log(`  ${String(n).padStart(4)} 个 q<ID>-*  ${d}`);
    }
    process.exit(0);
  }

  if (!qidArg) {
    console.error('用法: node precheck.mjs <questionId> [--force] [--json] [--no-bridge]');
    console.error('      node precheck.mjs <questionId> --publish');
    console.error('      node precheck.mjs --dirs');
    process.exit(1);
  }

  if (flag('--publish')) {
    const p = publishState(qidArg);
    if (flag('--json')) {
      console.log(JSON.stringify(p, null, 2));
      process.exit(!p.exists ? 0 : (p.problems.length ? 6 : 0));
    }
    console.log(`问题 ${qidArg} · 发布版`);
    if (!p.exists) {
      console.log(`\n还没有 ${path.basename(p.html)}`);
      console.log('下一步：node scripts\\render-publish.mjs q<ID>-answers-full.json --contact "你的邮箱或知乎私信"');
      process.exit(0);
    }
    console.log(`产物：${p.html}`);
    console.log(`      ${p.sizeKB} KB · ${p.at} · 引用 ${p.quotes ?? '?'} 处 · 引用占比 ${p.ratio == null ? '?' : p.ratio + '%'}`);
    if (!p.problems.length) {
      console.log('\n轻检通过（未核原文，只查了存在性/时效/联系方式/占比/AI 标识）。');
      console.log('发布前跑完整闸门：');
      console.log(`  node scripts\\verify-publish.mjs "${p.html}"`);
      process.exit(0);
    }
    for (const x of p.problems) console.log(`[!] ${x}`);
    console.log('\n先修完这些，再跑 verify-publish（它会逐条核对引用是否原文）。');
    process.exit(6);
  }

  const force = flag('--force');
  const res = assess(qidArg, { probe: !flag('--no-bridge'), force });

  if (flag('--json')) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(`问题 ${res.qid}`);
    console.log(`输出目录: ${res.outDir}`);
    console.log(`候选目录: ${res.dirs.length} 个\n`);
    if (res.found.length) {
      console.log(`找到 ${res.found.length} 个相关产物：`);
      for (const f of res.found) {
        const mark = path.resolve(f.dir) === res.outDir ? '→' : ' ';
        console.log(` ${mark} ${f.kb.padStart(8)}  ${f.at.padStart(10)}  ${f.path}`);
      }
      console.log('');
    }
    if (res.bridge) {
      console.log(res.bridge.ok
        ? `OK   桥接与登录态  ${res.bridge.account} (${res.bridge.token}) cookie=${res.bridge.cookies}`
        : `FAIL 桥接与登录态  ${res.bridge.detail}`);
      console.log('');
    }
    for (const b of res.blockers) {
      console.log(`[!] ${b.kind}  ${b.msg}`);
      if (b.detail) b.detail.forEach((d) => console.log(d));
    }
    if (res.ready) console.log('\nREADY —— 可以开工。');
    else if (res.code === 3) console.log('\n建议：直接复用上面那份产物，从 summarize / extract 继续，别重抓。');
    else if (res.code === 4) { console.log(''); bridgeAdvice().forEach((l) => console.log(l)); console.log('\n深诊断：node scripts/check.mjs'); }
    else if (res.code === 5) console.log('\n建议：先把散落的产物合并/选定目录，再决定要不要重抓。');
  }
  process.exit(res.code);
}