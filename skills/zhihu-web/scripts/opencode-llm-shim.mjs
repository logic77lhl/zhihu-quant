// OpenCode 免费模型 shim（zhihu-web 流水线 Plan B 后端）
//
// 背景：opencode.ai/inference 的免费模型只允许「OpenCode 内」调用 ——
//   外部直连 403 FreeTierError，本机 /api/experimental/generate 503。
//   唯一可用通路是发起一个真实 OpenCode 会话：opencode-cli run --model opencode/<free>。
// 本 shim 把它包装成本地 OpenAI 兼容端点，流水线脚本只需把 WB2API_BASE 指过来：
//   $env:WB2API_BASE = 'http://127.0.0.1:7871/v1'
//   $env:WB2API_KEY  = 'shim'
//   $env:ZHIHU_LLM_MODELS = 'opencode:deepseek-v4.1-flash-free,opencode:glm-5.3-flash-free'
//
// 用法：
//   node opencode-llm-shim.mjs [--port 7871]
//
// 环境变量：
//   SHIM_PORT      监听端口（默认 7871）
//   SHIM_CONC      最大并发会话数（默认 4）
//   SHIM_TIMEOUT   单次运行超时毫秒（默认 300000）
//   SHIM_MODEL     强制使用的模型（默认按请求名映射到 deepseek/glm 免费版）
//   SHIM_STANDALONE=1  每个会话用私有服务（共享服务没跑时的兜底，启动稍慢）
//   SHIM_KEEP_SESSIONS=1  成功也不删会话（调试用）
//   OPENCODE_CLI   覆盖 opencode-cli.exe 路径
//
// 边界：
//   - 实现流水线用到的 POST /v1/chat/completions、GET /v1/models、GET /health。
//   - max_tokens / temperature / reasoning_effort 不透传（会话通路不暴露这些参数）。
//   - 失败（超时/退出码非 0/空文本）返回 503，交给脚本既有的重试/拆分逻辑。
//   - 成功的会话自动删除；失败会话保留便于排查（sessionID 打在日志里）。
//     手工清会话：opencode-cli session delete <ses_...>
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// ---- 配置 ----
const argPort = (() => { const i = process.argv.indexOf('--port'); return i >= 0 ? process.argv[i + 1] : null; })();
const PORT = Number(argPort || process.env.SHIM_PORT || 7871);
const CONC = Math.max(1, Number(process.env.SHIM_CONC || 4));
const TIMEOUT = Math.max(10000, Number(process.env.SHIM_TIMEOUT || 300000));
const KEEP_SESSIONS = process.env.SHIM_KEEP_SESSIONS === '1';
const STANDALONE = process.env.SHIM_STANDALONE === '1';
const TMP_DIR = path.join(os.tmpdir(), 'opencode-shim-cwd');

const label = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${label()}] [shim]`, ...a);

// ---- opencode-cli 发现（版本目录会随升级变化，取最新版本） ----
function findCli() {
  if (process.env.OPENCODE_CLI) return fs.existsSync(process.env.OPENCODE_CLI) ? process.env.OPENCODE_CLI : null;
  const root = path.join(process.env.APPDATA || '', 'ai.opencode.desktop', 'cli');
  let best = null, bestV = -1;
  try {
    for (const name of fs.readdirSync(root)) {
      const exe = path.join(root, name, 'opencode-cli.exe');
      if (!fs.existsSync(exe)) continue;
      const m = /^(\d+)\.(\d+)\.(\d+)/.exec(name);
      const v = m ? (+m[1] * 1e6 + +m[2] * 1e3 + +m[3]) : 0;
      if (v > bestV) { best = exe; bestV = v; }
    }
  } catch { /* 目录不存在就当找不到 */ }
  return best;
}
const CLI = findCli();
if (!CLI) {
  console.error('[shim] 找不到 opencode-cli.exe：请设置 OPENCODE_CLI，或确认 OpenCode 桌面版已安装');
  process.exit(1);
}
fs.mkdirSync(TMP_DIR, { recursive: true });

// ---- 模型映射 ----
function mapModel(requested) {
  if (process.env.SHIM_MODEL) return process.env.SHIM_MODEL;
  const s = String(requested || '').toLowerCase();
  if (s.includes('glm')) return 'glm-5.3-flash-free';
  return 'deepseek-v4.1-flash-free';
}

// ---- 会话调用 ----
function parseEvents(out) {
  let text = '';
  let sessionID = null;
  for (const line of out.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let j; try { j = JSON.parse(s); } catch { continue; }
    if (!sessionID && (j.sessionID || j.part?.sessionID)) sessionID = j.sessionID || j.part.sessionID;
    if (j.type === 'text' && j.part?.text) text += (text ? '\n' : '') + j.part.text;
  }
  return { text, sessionID };
}

function killTree(child) {
  try { child.kill(); } catch {}
  if (process.platform === 'win32' && child.pid) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  }
}

function deleteSession(id) {
  if (!id || KEEP_SESSIONS) return;
  try { spawn(CLI, ['session', 'delete', id], { windowsHide: true, stdio: 'ignore' }).on('error', () => {}); } catch {}
}

function runSession(modelId, prompt) {
  return new Promise((resolve) => {
    const args = ['run'];
    if (STANDALONE) args.push('--standalone');
    args.push('--format', 'json', '--model', `opencode/${modelId}`);
    const t0 = Date.now();
    let child;
    try {
      child = spawn(CLI, args, { windowsHide: true, cwd: TMP_DIR, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, error: 'spawn 失败: ' + e.message, ms: 0 });
      return;
    }
    let out = '', err = '', finished = false, timedOut = false;
    const finish = (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ...r, ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      setTimeout(() => finish({ ok: false, error: `超时 ${TIMEOUT}ms`, sessionID: parseEvents(out).sessionID }), 8000);
    }, TIMEOUT);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ ok: false, error: 'spawn: ' + e.message }));
    child.on('exit', (code) => {
      const { text, sessionID } = parseEvents(out);
      if (timedOut) { finish({ ok: false, error: `超时 ${TIMEOUT}ms`, sessionID }); return; }
      if (code !== 0) { finish({ ok: false, error: `退出码 ${code}: ${err.trim().slice(-200)}`, sessionID }); return; }
      const t = text.trim();
      if (!t) { finish({ ok: false, error: '空回复', sessionID }); return; }
      finish({ ok: true, text: t, sessionID });
    });
    child.stdin.on('error', () => {});   // EPIPE 之类不致命
    try { child.stdin.write(prompt); } catch {}
    child.stdin.end();
  });
}

// ---- 并发队列 ----
let active = 0;
const queue = [];
function enqueue(task) {
  return new Promise((resolve) => { queue.push({ task, resolve }); pump(); });
}
function pump() {
  while (active < CONC && queue.length) {
    const { task, resolve } = queue.shift();
    active++;
    task().then(resolve).catch((e) => resolve({ ok: false, error: String(e) })).finally(() => { active--; pump(); });
  }
}

// ---- HTTP ----
const send = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};
const msgText = (m) => {
  if (typeof m?.content === 'string') return m.content;
  if (Array.isArray(m?.content)) return m.content.map((x) => (typeof x === 'string' ? x : x?.text || '')).join('');
  return '';
};
function buildPrompt(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  const sys = arr.filter((m) => m.role === 'system').map(msgText).filter(Boolean).join('\n\n');
  const rest = arr.filter((m) => m.role !== 'system').map(msgText).filter(Boolean).join('\n\n');
  return [sys, rest].filter(Boolean).join('\n\n').trim();
}

let stat = { ok: 0, fail: 0 };

async function handle(req, res, body) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, cli: CLI, conc: CONC, active, queued: queue.length, stat });
  }
  if (req.method === 'GET' && url.pathname.endsWith('/models')) {
    return send(res, 200, {
      object: 'list',
      data: ['deepseek-v4.1-flash-free', 'glm-5.3-flash-free'].map((id) => ({ id: `opencode:${id}`, object: 'model', owned_by: 'opencode-shim' })),
    });
  }
  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    let j; try { j = JSON.parse(body); } catch { return send(res, 400, { error: { message: 'bad json' } }); }
    const model = mapModel(j.model);
    const prompt = buildPrompt(j.messages);
    if (!prompt) return send(res, 400, { error: { message: 'empty prompt' } });
    const t0 = Date.now();
    const wait = queue.length;
    const r = await enqueue(() => runSession(model, prompt));
    const ms = Date.now() - t0;
    if (r.ok) {
      stat.ok++;
      log(`${model} OK ${ms}ms prompt=${prompt.length}ch out=${r.text.length}ch wait=${wait} ses=${r.sessionID || '-'}`);
      deleteSession(r.sessionID);
      return send(res, 200, {
        id: 'chatcmpl-shim', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: { role: 'assistant', content: r.text }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: Math.ceil(prompt.length / 1.6),
          completion_tokens: Math.ceil(r.text.length / 1.6),
          total_tokens: Math.ceil((prompt.length + r.text.length) / 1.6),
        },
      });
    }
    stat.fail++;
    log(`${model} FAIL ${ms}ms prompt=${prompt.length}ch ${r.error}${r.sessionID ? ` ses=${r.sessionID}` : ''}`);
    return send(res, 503, { error: { message: `opencode 会话失败: ${r.error}` } });
  }
  send(res, 404, { error: { message: 'not found' } });
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => { handle(req, res, body).catch((e) => send(res, 500, { error: { message: String(e) } })); });
});
server.on('error', (e) => { console.error('[shim] 监听失败:', e.message); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => {
  log(`CLI = ${CLI}`);
  log(`监听 http://127.0.0.1:${PORT}/v1  并发=${CONC} 超时=${TIMEOUT}ms${STANDALONE ? ' standalone' : ''}`);
  log('用法：$env:WB2API_BASE="http://127.0.0.1:' + PORT + '/v1"; $env:WB2API_KEY="shim"');
});
process.on('SIGINT', () => { log(`退出（ok=${stat.ok} fail=${stat.fail}）`); process.exit(0); });
