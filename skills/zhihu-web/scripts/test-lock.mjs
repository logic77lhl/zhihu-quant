// lock.mjs 的行为测试 —— 固化入库，改锁逻辑后跑它
//
// 用法: node test-lock.mjs
// 退出码 0 = 全部通过
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireLock } from './lock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(os.tmpdir(), 'zhihu-web-lock-test-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
const TARGET = path.join(TMP, 'fake-answers-full.json');
const LOCK = TARGET + '.lock';

const results = [];
const check = (name, ok) => { results.push([name, ok]); console.log((ok ? '  OK   ' : '  FAIL ') + name); };
const rm = (f) => { try { fs.unlinkSync(f); } catch {} };

// 在子进程里跑 acquireLock，返回 {code, out}
function tryAcquire(args = '{}') {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', `
      import(${JSON.stringify('file:///' + path.join(HERE, 'lock.mjs').replace(/\\/g, '/'))}).then(({acquireLock}) => {
        const l = acquireLock(${JSON.stringify(TARGET)}, Object.assign({ label: '测试目标' }, ${args}));
        console.log('ACQUIRED:' + l.info.pid);
        l.release();
        console.log('RELEASED');
      });
    `]);
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

// ---- 场景 1：活着的进程持有锁 → 应拒绝 ----
console.log('=== 1. 锁被「活着的进程」持有 ===');
const holder = spawn(process.execPath, ['-e', 'setTimeout(()=>{},15000)'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
fs.writeFileSync(LOCK, JSON.stringify({ pid: holder.pid, host: 'TEST', at: Date.now(), label: '测试持有者' }), 'utf8');
let r = await tryAcquire();
check('被拒绝且退出码为 3', r.code === 3);
check('提示含持有者 pid', r.out.includes(String(holder.pid)));
check('提示含锁文件路径', r.out.includes('.lock'));
check('未真正拿到锁', !r.out.includes('ACQUIRED'));
holder.kill();
await new Promise((r2) => setTimeout(r2, 700));
rm(LOCK);

// ---- 场景 2：陈旧锁（持有者已死）→ 应接管 ----
console.log('\n=== 2. 持有者进程已死（陈旧锁）===');
fs.writeFileSync(LOCK, JSON.stringify({ pid: 999999, host: 'TEST', at: Date.now(), label: '已死进程' }), 'utf8');
r = await tryAcquire();
check('接管成功（退出码 0）', r.code === 0);
check('提示了「陈旧锁」', /陈旧锁|接管/.test(r.out));
check('拿到锁并释放', r.out.includes('ACQUIRED') && r.out.includes('RELEASED'));
check('释放后锁文件已删除', !fs.existsSync(LOCK));

// ---- 场景 3：锁超期（进程活着但超过 staleMs）→ 应接管 ----
console.log('\n=== 3. 锁存在超过 staleMs ===');
fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, host: 'TEST', at: Date.now() - 7 * 3600 * 1000, label: '超期' }), 'utf8');
r = await tryAcquire('{ staleMs: 3600000 }');
check('超期锁被接管', r.code === 0 && r.out.includes('ACQUIRED'));
rm(LOCK);

// ---- 场景 4：无锁 → 正常获取 ----
console.log('\n=== 4. 无锁时正常获取 ===');
rm(LOCK);
r = await tryAcquire();
check('正常获取（退出码 0）', r.code === 0);
check('获取后已释放', !fs.existsSync(LOCK));

// ---- 场景 5：锁文件损坏 → 不应崩，按无锁处理 ----
console.log('\n=== 5. 锁文件内容损坏 ===');
fs.writeFileSync(LOCK, 'not-json{{{', 'utf8');
r = await tryAcquire();
check('损坏锁不导致崩溃', r.code === 0 && r.out.includes('ACQUIRED'));
rm(LOCK);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
const fails = results.filter(([, v]) => !v).length;
console.log(`\n${fails ? '✗' : '✓'} ${results.length - fails}/${results.length} 通过`);
process.exit(fails ? 1 : 0);
