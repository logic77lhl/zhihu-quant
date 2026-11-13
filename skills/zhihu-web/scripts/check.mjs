// Panerelay 桥接与 Cookie 注入健康检查
// 用法: node check.mjs
// 退出码: 0=OK  2=BRIDGE_DOWN  3=EDGE_NOT_STARTED  4=COOKIE_NOT_INJECTED
//
// 调用一律经 panerelay-run.mjs（绕开 cmd.exe），不要直接 spawnSync('cmd.exe', ...)：
// cmd.exe 会把 URL 里的 & 当命令分隔符，导致「看起来像服务端报错」的假故障。
import { panerelay, cliPath } from './panerelay-run.mjs';
import { bridgeAdvice } from './bridge-advice.mjs';

const HOT = 'https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=2';
const API = 'https://www.zhihu.com/api/v4/me';

const pr = (args) => panerelay(args, { timeout: 60000 });

const say = (ok, label, detail) =>
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label.padEnd(22)}${detail ?? ''}`);

console.log(`panerelay 入口: ${cliPath() || '(未找到 node 入口，将退回 cmd 垫片)'}\n`);

// 1. 桥接连通
const who = pr(['zhihu', 'whoami', '--json']);
if (/Bridge is unavailable/i.test(who.text)) {
  console.log('BRIDGE_DOWN');
  console.log('');
  bridgeAdvice().forEach((l) => console.log(l));
  process.exit(2);
}

// ⚠️ 不要把「命令失败」当成「桥接断开」—— 2026-10 踩过：
// whoami 因为别的原因失败（请求超时、端点被拒），这里却一律打印 BRIDGE_DOWN，
// 把人导向「重装 Edge / 检查启动方式」，而真正的问题完全在别处。
if (!who.ok) {
  console.log('COMMAND_FAILED');
  console.log('');
  console.log('  桥接是通的，但命令本身失败了。原因：');
  console.log(`    ${(who.text || '(无输出)').trim().slice(0, 400)}`);
  console.log('');
  console.log('  这不是启动方式问题，不要去动 Edge 的启动配置。');
  process.exit(5);
}

let account = null;
try { const j = JSON.parse(who.text); account = Array.isArray(j) ? j[0] : j; } catch {}
say(!!account?.logged_in, '登录态',
  account?.logged_in ? `${account.name} (${account.url_token} / uid ${account.uid})` : '未登录');

// 2. Cookie 是否真的注入（这才是关键，whoami 只证明桥接连通）
const f = pr(['fetch', HOT, '--response', 'json']);
let n = null, st = null;
try {
  const j = JSON.parse(f.text);
  n = j.attachedCookieCount ?? j.body?.attachedCookieCount ?? null;
  st = j.status ?? j.body?.status ?? null;
} catch {}

if (n === null) {
  say(false, 'Cookie 注入', `解析失败: ${f.text.slice(0, 140)}`);
  process.exit(2);
}
say(n > 0, 'Cookie 注入', `attachedCookieCount=${n}  HTTP ${st}`);

if (n === 0) {
  console.log('');
  console.log('  桥接是通的，但一个 Cookie 都没带上 —— 扩展缺少 host 授权。');
  console.log('  检查 %USERPROFILE%\\.panerelay\\extension\\manifest.json 是否含：');
  console.log('    "host_permissions": ["*://*.zhihu.com/*", "*://zhihu.com/*"]');
  console.log('  改完重启 Edge 生效。详见 SKILL.md「两个已知的、会误导人的坑」①');
  process.exit(4);
}

// 3. 真实账号接口（能通说明 z_c0 有效）
const me = pr(['fetch', API, '--response', 'json']);
let meOk = false, meName = '', meStatus = '?';
try {
  const j = JSON.parse(me.text);
  meStatus = j.status;
  meOk = j.status === 200 && !!(j.body?.id || j.body?.url_token);
  meName = j.body?.name || j.body?.url_token || '';
} catch {}
say(meOk, '账号接口', meOk ? `${meName}` : `HTTP ${meStatus}`);

// 4. 探「管线真正依赖的端点」（2026-10-15 重写）
//
//    踩坑记录：上一版这里探的是 `/api/v4/questions/{id}`（**详情**端点），
//    而那个端点确实要求签名、恒定 403。于是旧版据此断言
//    「知乎对 /api/v4/questions|answers|members 要求客户端签名」——
//    **把一个端点的现象外推到了整个前缀家族**。
//
//    实际上管线主力 `/api/v4/questions/{id}/answers` 一直不需要签名。
//    因为这条错误推断，上一个 AI 去加 `inPageContext` 修补，反而把能用的通路挖断了。
//
//    所以：**探那个你真正要用的端点，不要探兄弟端点然后外推。**
const ENDPOINTS = (qid) => [
  ['管线主力', `https://www.zhihu.com/api/v4/questions/${qid}/answers?limit=5&offset=0&sort_by=default`, true],
  ['单条回答', `https://www.zhihu.com/api/v4/answers/2222029603`, false],
  ['问题 feed', `https://www.zhihu.com/api/v4/questions/${qid}/feeds?limit=5`, false],
  ['账号接口', API, false],
  ['热榜(v3)', HOT, false],
  ['问题详情', `https://www.zhihu.com/api/v4/questions/${qid}`, false],
];

function probe(url) {
  const r = pr(['fetch', url, '--response', 'json']);
  let status = 0, code = '', msg = '', n = null;
  try {
    const j = JSON.parse(r.text);
    status = j.status;
    let b = j.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { /* keep */ } }
    code = b?.error?.code ?? '';
    msg = b?.error?.message ?? '';
    n = Array.isArray(b?.data) ? b.data.length : (b?.id ? 1 : null);
  } catch { /* 解析失败 */ }
  return { status, code, msg, n };
}

const qid = (() => {
  const i = process.argv.indexOf('--endpoints');
  return i >= 0 && process.argv[i + 1] && /^\d+$/.test(process.argv[i + 1]) ? process.argv[i + 1] : '28193957';
})();

const onlyEndpoints = process.argv.includes('--endpoints');
if (onlyEndpoints) {
  console.log('=== 端点签名要求逐项复核 ===');
  console.log('（知乎的签名要求是**端点级**的，子路径与父路径可以完全不同）\n');
  let criticalOk = false;
  for (const [label, url, critical] of ENDPOINTS(qid)) {
    const p = probe(url);
    const ok = p.status === 200;
    if (critical) criticalOk = ok;
    console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(10)} HTTP ${String(p.status).padEnd(4)}` +
      `${p.code ? ' code=' + p.code : ''}${p.n !== null ? '  条数=' + p.n : ''}` +
      `${critical ? '   ← 管线依赖这个' : ''}`);
    console.log(`     ${url.replace('https://www.zhihu.com', '')}`);
  }
  console.log('');
  console.log(criticalOk ? '管线主力端点可用 ✓' : '管线主力端点不可用 ✗ —— 抓取会失败');
  process.exit(criticalOk ? 0 : 4);
}

const critical = ENDPOINTS(qid).find((e) => e[2]);
const cp = probe(critical[1]);
const cOk = cp.status === 200;
say(cOk, '抓取端点', cOk
  ? `HTTP 200${cp.n !== null ? `  ${cp.n} 条` : ''}`
  : `HTTP ${cp.status}${cp.code ? ` code ${cp.code}` : ''}${cp.msg ? ` ${cp.msg}` : ''}`);

if (!cOk) {
  console.log('');
  if (cp.code === '10003') {
    console.log('  这个端点要求客户端签名（code 10003）。');
    console.log('  ⚠️ 但**不要外推**：签名要求是端点级的，先逐项确认你真正要用的那个。');
    console.log(`     node scripts/check.mjs --endpoints ${qid}`);
    console.log('  ⚠️ 也不要给适配器加 inPageContext —— 旧扩展会静默丢弃该字段并挂到 35s 超时。');
  } else {
    console.log('  抓取端点不可用。先逐项复核，再判断原因（签名 / 限流 / 登录态）：');
    console.log(`     node scripts/check.mjs --endpoints ${qid}`);
  }
}

console.log('');
console.log(n > 0 && meOk && cOk ? '状态：可用' : '状态：部分可用');
process.exit(n > 0 && meOk && cOk ? 0 : 4);
