// 环境自检 —— 换机部署后先跑这个
// 用法: node doctor.mjs [--out <产物目录>]
// 退出码: 0=全通过  1=有硬性失败
//
// 每项检查都给出「怎么修」，不只是报 FAIL。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { panerelay, cliPath } from './panerelay-run.mjs';
import { bridgeAdvice } from './bridge-advice.mjs';

const argv = process.argv.slice(2);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };

const HOME = os.homedir();
const results = [];
const rec = (level, name, detail, fix) => results.push({ level, name, detail, fix });
const OK = (n, d) => rec('ok', n, d);
const WARN = (n, d, f) => rec('warn', n, d, f);
const FAIL = (n, d, f) => rec('fail', n, d, f);

// ---------- 1. Node 版本 ----------
{
  const v = process.versions.node;
  const [maj, min] = v.split('.').map(Number);
  // panerelay 官方要求 >=20；ck-count.mjs / zhihu-cookies.mjs 用 node:sqlite 需要 >=22.5
  if (maj > 22 || (maj === 22 && min >= 5)) OK('Node 版本', `v${v}（满足 node:sqlite 要求）`);
  else if (maj >= 20) WARN('Node 版本', `v${v}`, 'Panerelay 可用，但读 Edge Cookie 库的脚本（ck-count.mjs / zhihu-cookies.mjs）需要 Node ≥22.5。升级：https://nodejs.org/');
  else FAIL('Node 版本', `v${v} 过低`, '升级到 Node ≥22.5：https://nodejs.org/');
}

// ---------- 2. Panerelay CLI ----------
const cli = cliPath();
if (cli) OK('Panerelay CLI', cli);
else FAIL('Panerelay CLI', '未找到 node 入口（将退回 cmd 垫片，URL 里的 & 会被 shell 拆开）',
  'npx --yes @panerelay/setup\n    或设环境变量 PANERELAY_CLI 指向 @panerelay/cli/dist/cli.js');

// ---------- 3. ~/.panerelay 目录 ----------
const PR = path.join(HOME, '.panerelay');
if (!fs.existsSync(PR)) {
  FAIL('~/.panerelay', '不存在', 'npx --yes @panerelay/setup');
} else {
  OK('~/.panerelay', PR);
  const nm = path.join(PR, 'native-messaging', 'org.panerelay.bridge.json');
  if (fs.existsSync(nm)) {
    try {
      const j = JSON.parse(fs.readFileSync(nm, 'utf8'));
      const p = j.path;
      if (p && fs.existsSync(p)) OK('Native Host 清单', p);
      else FAIL('Native Host 清单', `path 指向的文件不存在: ${p}`, '重跑 npx --yes @panerelay/setup');
      if (!/^chrome-extension:\/\/[a-p]{32}\/$/.test((j.allowed_origins || [])[0] || '')) {
        WARN('Native Host allowed_origins', JSON.stringify(j.allowed_origins), '格式异常，确认扩展 ID 与已安装的一致');
      }
    } catch (e) { FAIL('Native Host 清单', '解析失败: ' + e.message, '重跑 npx --yes @panerelay/setup'); }
  } else FAIL('Native Host 清单', '缺 native-messaging/org.panerelay.bridge.json', 'npx --yes @panerelay/setup');
}

// ---------- 4. 扩展是否侧载 + 是否打了 host_permissions 补丁 ----------
{
  const ext = path.join(PR, 'extension', 'manifest.json');
  if (!fs.existsSync(ext)) {
    WARN('浏览器扩展', '未发现侧载扩展目录（可能用的是商店版）',
      '商店版无需处理。若用侧载：确认 ~/.panerelay/extension/manifest.json 存在');
  } else {
    let m = null;
    try { m = JSON.parse(fs.readFileSync(ext, 'utf8')); } catch (e) { FAIL('扩展 manifest', '解析失败: ' + e.message, ''); }
    if (m) {
      const hp = m.host_permissions || [];
      const zhihu = hp.filter((h) => /zhihu\.com/.test(h));
      if (zhihu.length) OK('扩展 host_permissions 补丁', zhihu.join(' '));
      else FAIL('扩展 host_permissions 补丁', `当前为 ${JSON.stringify(hp)}`,
        '侧载版必补，否则 chrome.cookies.getAll() 返回空数组、服务端一律 401（报错像「身份未经过验证」）\n'
        + '    在 ~/.panerelay/extension/manifest.json 顶层加：\n'
        + '    "host_permissions": ["*://*.zhihu.com/*", "*://zhihu.com/*"]\n'
        + '    改完重启 Edge');
    }
  }
}

// ---------- 5. 桥接连通 + Cookie 注入（真正决定能不能用） ----------
{
  const who = panerelay(['zhihu', 'whoami', '--json'], { timeout: 60000 });
  if (/Bridge is unavailable/i.test(who.text) || !who.ok) {
    FAIL('桥接连通', 'Panerelay 桥接未连接',
      bridgeAdvice().map((l) => '    ' + l).join('\n'));
  } else {
    let acc = null; try { const j = JSON.parse(who.text); acc = Array.isArray(j) ? j[0] : j; } catch {}
    if (acc?.logged_in) OK('登录态', `${acc.name} (${acc.url_token || acc.uid})`);
    else WARN('登录态', '未登录知乎', '在 Edge 里登录 zhihu.com，然后重跑本检查');

    const f = panerelay(['fetch', 'https://www.zhihu.com/api/v4/me', '--response', 'json'], { timeout: 60000 });
    let n = null, st = null;
    try { const j = JSON.parse(f.text); n = j.attachedCookieCount ?? j.body?.attachedCookieCount; st = j.status ?? j.body?.status; } catch {}
    if (n === null) FAIL('Cookie 注入', '解析失败: ' + f.text.slice(0, 120), '确认桥接正常后重试');
    else if (n === 0) FAIL('Cookie 注入', `attachedCookieCount=0（HTTP ${st}）`,
      '桥接通了但一个 Cookie 都没带上 —— 扩展缺 host 授权。见上面第 4 项。');
    else OK('Cookie 注入', `attachedCookieCount=${n}  HTTP ${st}`);
  }
}

// ---------- 6. 知乎站点适配器 ----------
{
  const r = panerelay(['zhihu', '--help'], { timeout: 60000 });
  if (/answer-detail/.test(r.text)) OK('知乎适配器', '已安装');
  else FAIL('知乎适配器', '未安装或不可用', 'npx --yes @panerelay/setup add zhihu');
}

// ---------- 7. 本地 LLM 网关 ----------
{
  const KEY = process.env.WB2API_KEY;
  if (!KEY) {
    FAIL('LLM 网关密钥', '环境变量 WB2API_KEY 未设置',
      '该值等于网关 dist/config.json 的 api_key 字段（或面板 UI 里查看）。\n'
      + '    设置：$env:WB2API_KEY = "<值>"   （要持久化就写进用户环境变量）');
  } else {
    OK('LLM 网关密钥', `已设置（长度 ${KEY.length}）`);
  }
  const base = process.env.WB2API_BASE || 'http://127.0.0.1:7863/v1';
  if (KEY) {
    try {
      const res = spawnSync(process.execPath, ['-e', `
        fetch('${base}/models', { headers: { Authorization: 'Bearer ' + process.env.WB2API_KEY } })
          .then(r => r.json()).then(j => { console.log(JSON.stringify({ n: (j.data||[]).length })); })
          .catch(e => { console.log(JSON.stringify({ err: String(e.message || e) })); });
      `], { encoding: 'utf8', timeout: 30000, env: process.env });
      const out = (res.stdout || '').trim();
      const j = out ? JSON.parse(out) : {};
      if (j.err) FAIL('LLM 网关', `${base} 不可达: ${j.err}`, '启动网关：cd workbuddy2api-panel; powershell -ExecutionPolicy Bypass -File .\\start.ps1');
      else if (j.n > 0) OK('LLM 网关', `${base} 可用，${j.n} 个模型`);
      else WARN('LLM 网关', `${base} 返回 0 个模型`, '确认网关已登录上游账号');
    } catch (e) { WARN('LLM 网关', '检查失败: ' + e.message, ''); }
  }

  // 真正发一次最小 chat 请求。
  // 只查 /models 是不够的 —— 实测有模型「HTTP 200 但 content 为空、tokens 0/0」
  // （gpt-6-luna 带 reasoning 参数时），/models 照常列出它。
  // 三个 LLM 脚本都依赖能真的返回内容，所以这一项必须实测。
  if (KEY) {
    const model = process.env.WB2API_MODEL || 'global:deepseek-v4.1-flash';
    try {
      const res = spawnSync(process.execPath, ['-e', `
        fetch('${base}/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.WB2API_KEY },
          body: JSON.stringify({ model: ${JSON.stringify(model)}, max_tokens: 16, temperature: 0,
            messages: [{ role: 'user', content: '回复两个字：正常' }], reasoning_effort: 'none' }),
        }).then(async r => {
          const j = await r.json();
          if (j.error) return console.log(JSON.stringify({ err: j.error.message || 'api error' }));
          const c = (j.choices?.[0]?.message?.content || '').trim();
          console.log(JSON.stringify({ len: c.length, sample: c.slice(0, 20) }));
        }).catch(e => console.log(JSON.stringify({ err: String(e.message || e) })));
      `], { encoding: 'utf8', timeout: 60000, env: process.env });
      const out = (res.stdout || '').trim();
      const j = out ? JSON.parse(out) : {};
      if (j.err) FAIL('LLM 实际调用', `${model} 调用失败: ${j.err}`, '确认模型名有效且网关已登录上游');
      else if (j.len > 0) OK('LLM 实际调用', `${model} 返回 ${j.len} 字（"${j.sample}"）`);
      else FAIL('LLM 实际调用', `${model} HTTP 200 但 content 为空`,
        '这就是「静默返回空」的坑（见 references/pipeline-v2.md 第 6 节）。\n'
        + '    换模型，或去掉 reasoning_effort 参数重试。');
    } catch (e) { WARN('LLM 实际调用', '检查失败: ' + e.message, ''); }
  }
}

// ---------- 8. 输出目录 ----------
{
  let dir = opt('--out') || process.env.ZHIHU_QUANT_OUT;
  if (!dir) {
    // 与脚本一致的解析顺序：tools/../config.json -> ~/Documents/zhihu-quant
    for (const p of [path.join(HERE_TOOLS(), '..', 'config.json'), path.join(HERE_TOOLS(), '..', '..', 'config.json')]) {
      try { const c = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); if (c.outDir) { dir = c.outDir; break; } } catch {}
    }
  }
  if (!dir) dir = path.join(HOME, 'Documents', 'zhihu-quant');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.doctor-write-test');
    fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
    OK('输出目录', dir + '（可写）');
  } catch (e) { FAIL('输出目录', dir + ' 不可写: ' + e.message, '设 $env:ZHIHU_QUANT_OUT 指向一个可写目录'); }
}
function HERE_TOOLS() {
  // 本文件可能位于 <skill>/scripts/ 或 <tools>/：向上找含 fetch-answers-api.mjs 的目录。
  // ⚠️ 必须用 fileURLToPath —— import.meta.url 的 pathname 带 URL 编码（Default%20Project）。
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const c of [here, path.join(here, '..')]) {
    try { if (fs.existsSync(path.join(c, 'fetch-answers-api.mjs'))) return c; } catch { }
  }
  return here;
}

// ---------- 9. 浏览器 ----------
{
  const edges = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/microsoft-edge',
  ];
  const found = edges.filter((p) => fs.existsSync(p));
  if (found.length) OK('浏览器', found.join(' | '));
  else WARN('浏览器', '未找到 Edge', 'Panerelay 需要 Chromium 系浏览器（Chrome 或 Edge）');
}

// ---------- 输出 ----------
const ICON = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' };
console.log('\n=== 环境自检 ===\n');
for (const r of results) {
  console.log(`${ICON[r.level]}  ${r.name.padEnd(26)}${r.detail || ''}`);
  if (r.fix && r.level !== 'ok') console.log(`      ↳ ${r.fix}`);
}
const fails = results.filter((r) => r.level === 'fail').length;
const warns = results.filter((r) => r.level === 'warn').length;
console.log(`\n通过 ${results.length - fails - warns} / 警告 ${warns} / 失败 ${fails}`);
console.log(fails ? '\n有硬性失败，先按上面的 ↳ 修完再跑流水线。' : '\n环境就绪。首次验证（抓 1 页到临时文件，不动已有数据）：\n  node fetch-answers-api.mjs 491790104 --max-pages 1 --out "$env:TEMP\\probe.json"');
process.exit(fails ? 1 : 0);
