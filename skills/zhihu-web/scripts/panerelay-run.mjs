// Panerelay 调用层 —— 唯一允许执行 panerelay 的地方
//
// 本文件是**正本**（随 skill 一起分发）。所有工具脚本都 `import { panerelay } from './panerelay-run.mjs'`。
//
// 为什么不能直接 spawnSync('cmd.exe', ['/c', 'panerelay', ...])：
//   cmd.exe 会把 & | < > ^ 当作命令分隔符。URL 里的 & 会把命令从中间劈开，
//   前半段「碰巧执行成功」，后半段变成一条独立命令报错 —— 结果是 exit code 非 0，
//   而且**看起来像是服务端返回了错误**，极具误导性。
//   实测：https://.../total?limit=2&offset=0 经 cmd.exe 的退出码是 1，直接 node 是 0。
//
// 做法：绕开 .cmd 垫片，直接用 node 跑 CLI 的真实入口，参数走数组传递，
// 全程不经过任何 shell，因此不存在分隔符解析问题。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 依次尝试：环境变量 → 常见安装位置 → PATH 里的 .cmd（垫片，会退回 shell）
function resolveCli() {
  if (process.env.PANERELAY_CLI && fs.existsSync(process.env.PANERELAY_CLI)) return process.env.PANERELAY_CLI;

  const roots = [];
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  if (process.env.USERPROFILE) roots.push(path.join(process.env.USERPROFILE, 'AppData', 'Roaming', 'npm', 'node_modules'));
  roots.push('/usr/local/lib/node_modules', '/opt/homebrew/lib/node_modules');

  for (const root of roots) {
    const p = path.join(root, '@panerelay', 'cli', 'dist', 'cli.js');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

let CLI = resolveCli();

// ============================================================================
// ⛔ 全局节流 —— 不要绕过，不要删
// ============================================================================
// 事故记录（2026-10-15）：
//   为了「验证并发上限 3 这个结论对不对」，我写基准脚本一次性打了约 147 次请求 ——
//   同一 endpoint、零间隔、并发最高 10、十几分钟内打完。
//   结果知乎返回 HTTP 403，该会话被限流，用户当天无法正常抓取。
//   更糟的是 403 响应返回很快，被计时脚本当成「快速成功」，
//   于是限流状态下的假数据（「异步并发快 3.9 倍」）差点被写进文档。
//
// 教训：**文档里写着规则不代表会遵守** —— 我读过「并发上限 3」还是犯了。
//   所以规则必须落在代码里，让任何人（包括未来的 AI）都绕不过去。
//
// 规则：
//   1. 相邻两次调用之间强制最小间隔（默认 120ms）
//   2. 每分钟调用数硬上限（默认 100 次）
//   3. 超出上限 → 阻塞等待，而不是放行
//
// 正常流水线的实际速率约 64 次/分钟（396 页 / 369 秒），远低于上限，
// 不会受影响。会撞上上限的只有「压测」这种错误用法 —— 这正是设计意图。
//
// 调高上限需要显式设环境变量，且会打印醒目警告。**不要为了跑得快去调它。**
// ============================================================================
const MIN_INTERVAL_MS = Number(process.env.PANERELAY_MIN_INTERVAL_MS || 120);
const MAX_PER_MINUTE = Number(process.env.PANERELAY_MAX_PER_MINUTE || 100);

if (process.env.PANERELAY_MIN_INTERVAL_MS || process.env.PANERELAY_MAX_PER_MINUTE) {
  console.error('\n' + '!'.repeat(70));
  console.error('[!] 检测到节流参数被环境变量覆盖：');
  console.error(`     最小间隔 ${MIN_INTERVAL_MS}ms   每分钟上限 ${MAX_PER_MINUTE}`);
  console.error('    调高这些值会显著提高被知乎限流（HTTP 403）的风险。');
  console.error('    正常流水线不需要调它们 —— 实际速率约 64 次/分钟。');
  console.error('!'.repeat(70) + '\n');
}

// 同步睡眠（spawnSync 场景下不能用 await）
function sleepSync(ms) {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

let lastCallAt = 0;
let minuteStart = Date.now();
let callsThisMinute = 0;
let throttledCount = 0;

function throttle() {
  const now = Date.now();
  // 每分钟计数窗口
  if (now - minuteStart >= 60000) { minuteStart = now; callsThisMinute = 0; }
  if (callsThisMinute >= MAX_PER_MINUTE) {
    const wait = 60000 - (now - minuteStart) + 10;
    throttledCount++;
    console.error(`[节流] 已达 ${MAX_PER_MINUTE} 次/分钟上限，等待 ${Math.ceil(wait / 1000)}s。`
      + `\n       如果你在写性能测试，请停下 —— 见 panerelay-run.mjs 顶部的事故记录。`);
    sleepSync(wait);
    minuteStart = Date.now(); callsThisMinute = 0;
  }
  // 相邻调用最小间隔
  const gap = now - lastCallAt;
  if (gap < MIN_INTERVAL_MS) { sleepSync(MIN_INTERVAL_MS - gap); throttledCount++; }
  lastCallAt = Date.now();
  callsThisMinute++;
}

/** 本次进程累计的节流次数（供脚本收尾时提示） */
export function throttleStats() { return { throttledCount, minIntervalMs: MIN_INTERVAL_MS, maxPerMinute: MAX_PER_MINUTE }; }

// ============================================================================
// 403 检测 —— 必须立刻看见，而且必须说对原因
// ============================================================================
// 为什么必须做：403 响应返回得**很快**。性能脚本如果只看耗时，
// 会把失败的请求当成「快速成功」，得出「并发提速 3.9 倍」这种假结论。
// 实测就是这样被骗过一次，差点把假数据写进文档。
//
// ⚠️ 但**不能把所有 403 都当成限流**（2026-10 踩过，且误导了一整轮诊断）：
// 知乎对**一部分** /api/v4 端点（实测 questions/answers/members）要求客户端签名
// `x-zse-96`，缺失时返回：
//     {"error":{"message":"请求参数异常，请升级客户端后重试。","code":10003}}
// 这**不是**限流、不是登录问题、跟请求频率无关，等多久都不会恢复。
// 同一时刻 /api/v4/me 和 /api/v4/creators/* 仍然 200 —— 作用域是路径前缀，不是会话。
//
// 旧版这里只正则匹配 "403" 就断言「已被限流 · 通常是有人在写性能/压测脚本」，
// 完全忽略响应体里的 code，直接把人导向「等几小时」——而那是死路。
//
// 所以现在的规则：**先读 body 的 error.code，再决定说什么。读不出 code 就说不确定。**
let rateLimitHits = 0;
export function rateLimitStats() { return { hits: rateLimitHits }; }

// 已实测的 code → 含义。新增前先确认，不要凭印象加。
const FORBIDDEN_CODES = {
  10003: {
    title: '知乎拒绝该端点：缺客户端签名',
    why: [
      '知乎对**个别** /api/v4 端点要求 x-zse-96 签名，Panerelay 在 service worker 里发请求，',
      '页面 JS 的签名拦截器不会运行，所以该端点恒定 403。',
      '⚠️ 签名要求是**端点级**的，不是路径前缀级的 —— 子路径与父路径可以完全不同。',
      '实测（2026-10-15）：/questions/{id}/answers、/answers/{id}、/questions/{id}/feeds、',
      '/me、/api/v3/* 都是 200；**只有 /api/v4/questions/{id} 详情**是 403。',
      '与请求频率、并发、登录态全部无关。',
    ],
    do: [
      '不要等待、不要重试。',
      '不要外推：不要因为一个端点 403 就断定「这一类都不能用」。',
      '逐项确认你真正要用的端点：node scripts/check.mjs --endpoints <问题ID>',
      '⚠️ 不要给适配器加 inPageContext 之类的字段 —— 旧扩展会静默丢弃并挂到 35s 超时，反而弄坏能用的通路。',
    ],
  },
};

function extractForbidden(text) {
  // Panerelay 把响应包在 { status, body } 里，body 可能是 string 或对象。
  let body = null;
  const m = text.match(/"body"\s*:\s*("(?:[^"\\]|\\.)*")/);
  if (m) {
    try { body = JSON.parse(m[1]); } catch { body = null; }
  }
  if (body === null) {
    try { body = JSON.parse(text).body; } catch { /* keep null */ }
  }
  const err = body && typeof body === 'object' ? body.error : null;
  const code = err && (err.code ?? err.errno);
  return { code: code == null ? null : String(code), message: err && err.message ? String(err.message) : '' };
}

function assertNotRateLimited(text, args) {
  if (!/"status"\s*:\s*403|HTTP\s*403|status:\s*403/.test(text)) return;
  const ep = String(args[1] || args[0] || '').slice(0, 100);
  const { code, message } = extractForbidden(text);

  // 能认出来：按 code 说话。
  if (code && FORBIDDEN_CODES[code]) {
    const info = FORBIDDEN_CODES[code];
    console.error('\n' + '='.repeat(70));
    console.error(`[!] HTTP 403 (code ${code}) —— ${info.title}`);
    console.error(`    接口: ${ep}`);
    if (message) console.error(`    服务端原文: ${message}`);
    console.error('\n    为什么:');
    for (const l of info.why) console.error(`      - ${l}`);
    console.error('\n    怎么办:');
    for (const l of info.do) console.error(`      - ${l}`);
    console.error('='.repeat(70) + '\n');
    return;
  }

  // 认不出来：可能是限流，也可能是别的 403。**不替服务端下结论。**
  rateLimitHits++;
  console.error('\n' + '='.repeat(70));
  console.error(`[!] HTTP 403 —— 原因未知${code ? `（code ${code}，未收录）` : '（响应体里没解析出 error.code）'}`);
  console.error(`    接口: ${ep}`);
  if (message) console.error(`    服务端原文: ${message}`);
  console.error('');
  console.error('    这**不一定**是限流。知乎对个别 /api/v4 端点还会因为缺客户端签名返回 403。');
  console.error('    判别方法（各发一次，不要重复试）：');
  console.error('      - 逐项确认你真正要用的端点：node scripts/check.mjs --endpoints <问题ID>');
  console.error('      - 打 /api/v4/me?include=url_token；它 200 而要用的端点 403 → 端点级问题，不是频率。');
  console.error('      - 所有端点都 403 → 才可能是频率限流，按 1~2 分钟间隔退避重试。');
  console.error('='.repeat(70) + '\n');
}

/**
 * 执行 panerelay 命令。
 * @param {string[]} args  例如 ['fetch', url, '--response', 'json']
 * @param {{timeout?: number, maxBuffer?: number, allow403?: boolean}} opts
 * @returns {{status:number, stdout:string, stderr:string, ok:boolean, via:string}}
 */
export function panerelay(args, opts = {}) {
  const { timeout = 90000, maxBuffer = 1 << 26, allow403 = false } = opts;
  const safe = args.map((a) => String(a));
  throttle();   // ← 全局节流：所有调用都经过这里，无法绕过

  if (CLI) {
    const r = spawnSync(process.execPath, [CLI, ...safe], {
      encoding: 'utf8', timeout, maxBuffer,
      windowsHide: true,
    });
    const out = (r.stdout || '') + (r.stderr || '');
    if (!allow403) assertNotRateLimited(out, safe);
    return { status: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '', text: out.trim(), ok: r.status === 0, via: 'node' };
  }

  // 最后兜底：走 .cmd 垫片。必须手动加引号，否则参数里的 & | < > 会被 shell 拆开。
  const quoted = safe.map((a) => (/[\s&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a));
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `panerelay ${quoted.join(' ')}`], {
    encoding: 'utf8', timeout, maxBuffer, windowsHide: true,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  if (!allow403) assertNotRateLimited(out, safe);
  return { status: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '', text: out.trim(), ok: r.status === 0, via: 'cmd' };
}

/** 同上，但返回解析后的第一个对象（panerelay 大多数命令返回顶层数组） */
export function panerelayOne(args, opts = {}) {
  const r = panerelay(args, opts);
  if (!r.ok) return null;
  try { const j = JSON.parse(r.text); return Array.isArray(j) ? j[0] : j; } catch { return null; }
}

/** 同上，但返回完整数组 */
export function panerelayAll(args, opts = {}) {
  const r = panerelay(args, opts);
  if (!r.ok) return [];
  try {
    const j = JSON.parse(r.text);
    return Array.isArray(j) ? j : (j?.items || j?.data || []);
  } catch { return []; }
}

export function cliPath() { return CLI; }
export function setCliPath(p) { CLI = p; }
