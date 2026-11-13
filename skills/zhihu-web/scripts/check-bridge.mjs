// Panerelay 桥接与 Cookie 注入健康检查
// 用法: node check-bridge.mjs
// 退出码: 0=OK  2=BRIDGE_DOWN  3=EDGE_NOT_STARTED
import { panerelay } from './panerelay-run.mjs';
import { bridgeAdvice } from './bridge-advice.mjs';

const HOT = 'https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=2';
const API = 'https://www.zhihu.com/api/v4/me';

const pr = (args, timeout = 60000) => panerelay(args, { timeout });
const out = (r) => (r.text ?? '');

const say = (ok, label, detail) =>
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label.padEnd(22)}${detail ?? ''}`);

// 1. 桥接连通
const who = pr(['zhihu', 'whoami', '--json']);
const whoText = out(who);
if (/Bridge is unavailable/i.test(whoText) || who.status !== 0) {
  console.log('BRIDGE_DOWN');
  console.log('');
  bridgeAdvice().forEach((l) => console.log(l));
  process.exit(2);
}

let account = null;
try { const j = JSON.parse(whoText); account = Array.isArray(j) ? j[0] : j; } catch {}
say(!!account?.logged_in, '登录态',
  account?.logged_in ? `${account.name} (${account.url_token} / uid ${account.uid})` : '未登录');

// 2. Cookie 是否真的注入（这才是关键，whoami 只证明桥接连通）
const f = pr(['fetch', HOT, '--response', 'json']);
const ft = out(f);
let n = null, st = null;
try {
  const j = JSON.parse(ft);
  n = j.attachedCookieCount ?? j.body?.attachedCookieCount ?? null;
  st = j.status ?? j.body?.status ?? null;
} catch {}

if (n === null) {
  say(false, 'Cookie 注入', `解析失败: ${ft.slice(0, 140)}`);
  process.exit(2);
}
say(n > 0, 'Cookie 注入', `attachedCookieCount=${n}  HTTP ${st}`);

if (n === 0) {
  console.log('');
  console.log('  桥接是通的，但一个 Cookie 都没带上 —— 扩展缺少 host 授权。');
  console.log('  检查 C:\\Users\\user\\.panerelay\\extension\\manifest.json 是否含：');
  console.log('    "host_permissions": ["*://*.zhihu.com/*", "*://zhihu.com/*"]');
  console.log('  改完重启 Edge 生效。详见 SKILL.md「两个已知的、会误导人的坑」①');
  process.exit(3);
}

// 3. 真实账号接口（能通说明 z_c0 有效）
const me = pr(['fetch', API, '--response', 'json']);
const mt = out(me);
let meOk = false, meName = '';
try {
  const j = JSON.parse(mt);
  meOk = j.status === 200 && !!(j.body?.id || j.body?.url_token);
  meName = j.body?.name || j.body?.url_token || '';
} catch {}
say(meOk, '账号接口', meOk ? `${meName}` : `HTTP ${(() => { try { return JSON.parse(mt).status } catch { return '?' } })()}`);

console.log('');
console.log(n > 0 && meOk ? '状态：可用' : '状态：部分可用');
process.exit(n > 0 ? 0 : 3);