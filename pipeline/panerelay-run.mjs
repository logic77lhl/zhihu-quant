// Panerelay 调用层 —— 唯一允许执行 panerelay 的地方
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

/**
 * 执行 panerelay 命令。
 * @param {string[]} args  例如 ['fetch', url, '--response', 'json']
 * @param {{timeout?: number, maxBuffer?: number}} opts
 * @returns {{status:number, stdout:string, stderr:string, ok:boolean, via:string}}
 */
export function panerelay(args, opts = {}) {
  const { timeout = 90000, maxBuffer = 1 << 26 } = opts;
  const safe = args.map((a) => String(a));

  if (CLI) {
    const r = spawnSync(process.execPath, [CLI, ...safe], {
      encoding: 'utf8', timeout, maxBuffer,
      windowsHide: true,
    });
    const out = (r.stdout || '') + (r.stderr || '');
    return { status: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '', text: out.trim(), ok: r.status === 0, via: 'node' };
  }

  // 最后兜底：走 .cmd 垫片。必须手动加引号，否则参数里的 & | < > 会被 shell 拆开。
  const quoted = safe.map((a) => (/[\s&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a));
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `panerelay ${quoted.join(' ')}`], {
    encoding: 'utf8', timeout, maxBuffer, windowsHide: true,
  });
  const out = (r.stdout || '') + (r.stderr || '');
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