// 按「资源 ID」加锁，防止多个会话同时抓同一个问题（或跑同一份产物）。
//
// 为什么需要：实测事故（2026-10-14，question/303487786）——
// 两个会话同时跑同一个问题 ID，脚本互不感知，各自完整抓了一遍：
//   会话 A → 3,898 条落在 Default Project/
//   会话 B → 3,895 条落在 zhihu-quant/
// 白花约 400 次请求，且产物分散在两个目录，谁手里都不完整。
//
// 用法:
//   import { acquireLock } from './lock.mjs';
//   const lock = acquireLock(outFile, { label: `问题 ${qid}` });
//   // ... 正常跑 ...
//   lock.release();                    // 正常结束时
//   process.on('exit', () => lock.release());   // 兜底
//
// 行为：
//   · 锁已被「活着的进程」持有 → 打印持有者信息与已有产物路径，exit(3)
//   · 锁是陈旧的（进程已死 / 超过 staleMs）→ 接管并警告
//   · 拿不到锁时不阻塞、不重试 —— 直接退出，让人决定
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STALE_MS = 6 * 60 * 60 * 1000;   // 6 小时：超过就认为上一个进程已经死了

function alive(pid) {
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; }         // 存在且可发信号 = 活着
  catch (e) { return e.code === 'EPERM'; }           // EPERM 也说明存在（只是没权限）
}

/**
 * @param {string} target  被保护的资源路径（通常就是产物文件）
 * @param {{label?: string, staleMs?: number, key?: string, onBusy?: (info) => void}} [opts]
 *   key: 全局锁键（如 `q303487786`）。给了就把锁放在系统临时目录下的共享位置，
 *        **与产物路径无关** —— 这样两个会话用不同 ZHIHU_QUANT_OUT 指向不同目录时，
 *        仍然会被同一个锁挡住（只按产物路径加锁时挡不住，实测踩过）。
 */
export function acquireLock(target, opts = {}) {
  const { label = target, staleMs = STALE_MS, key, onBusy } = opts;
  let lockFile;
  if (key) {
    const dir = path.join(os.tmpdir(), 'zhihu-web-locks');
    fs.mkdirSync(dir, { recursive: true });
    // 锁键要过一遍文件名清洗，避免问题 ID 以外的字符（斜杠等）破坏路径
    lockFile = path.join(dir, String(key).replace(/[^\w.-]/g, '_') + '.lock');
  } else {
    lockFile = target + '.lock';
  }

  const readLock = () => {
    try { return JSON.parse(fs.readFileSync(lockFile, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
  };

  const existing = readLock();
  if (existing) {
    const age = Date.now() - (existing.at || 0);
    const busy = alive(existing.pid) && age < staleMs;
    if (busy) {
      console.error(`\n[!] 另一个会话正在处理同一个目标，已退出以免重复抓取。`);
      console.error(`    目标  : ${label}`);
      console.error(`    持有者: pid ${existing.pid} @ ${existing.host || '?'}，开始于 ${new Date(existing.at).toLocaleString()}`);
      console.error(`    锁文件: ${lockFile}`);
      console.error(`\n    如果确认那个进程已经死了，删掉锁文件重跑：`);
      console.error(`      Remove-Item "${lockFile}"`);
      if (onBusy) onBusy(existing);
      process.exit(3);
    }
    console.error(`[i] 发现陈旧锁（pid ${existing.pid} 已不在，或超过 ${(staleMs / 3600000).toFixed(0)} 小时），接管`);
  }

  const info = { pid: process.pid, host: os.hostname(), at: Date.now(), target, label };
  fs.writeFileSync(lockFile, JSON.stringify(info), 'utf8');

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    // 只删自己写的锁 —— 防止把接管者的锁误删
    const cur = readLock();
    if (cur && cur.pid === process.pid) { try { fs.unlinkSync(lockFile); } catch {} }
  };

  // 异常退出也要释放，否则会留下需要人工清理的陈旧锁
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { release(); process.exit(130); });
  }

  return { release, file: lockFile, info };
}
