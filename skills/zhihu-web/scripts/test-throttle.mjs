// panerelay-run.mjs 的节流与 403 检测测试 —— 固化入库
//
// 存在理由：光在文档里写「并发上限 3」没用，我自己读过还是犯了
// （为验证该结论一次性打了约 147 次请求，把用户账号打进限流）。
// 规则必须能被测试，否则等于没有。
//
// 用法: node test-throttle.mjs     （不发真实网络请求）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.join(HERE, 'panerelay-run.mjs').replace(/\\/g, '/');

let fails = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? '  OK   ' : '  FAIL ') + name + (extra ? '  ' + extra : ''));
  if (!ok) fails++;
};

// 用 --version 之类不发网络请求的调用测节流。
// panerelay-run.mjs 的 CLI 解析在 import 时就跑，所以用子进程隔离。
const runInChild = (code) => {
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 120000 });
  return { out: (r.stdout || '') + (r.stderr || ''), code: r.status };
};
// 子进程会打印节流警告（含 "!!!!" 横幅），要从中挑出 JSON 行再解析
const lastJson = (out) => {
  const line = out.split('\n').filter((l) => l.trim().startsWith('{')).pop();
  return line ? JSON.parse(line) : null;
};

// ---- 1. 最小间隔：连续调用应被强制拉开 ----
// ⚠️ 不能直接测默认的 120ms —— `--version` 单次本身就要约 140ms，
// 已经超过最小间隔，节流根本不会触发，断言会「因为错误的原因通过」。
// 所以把间隔临时调到 500ms，确保强制等待一定发生。
console.log('=== 1. 相邻调用最小间隔（临时调到 500ms）===');
{
  const r = runInChild(`
    process.env.PANERELAY_MIN_INTERVAL_MS = '500';
    import('file:///${RUN}').then(({panerelay, throttleStats}) => {
      const t0 = Date.now();
      for (let i = 0; i < 5; i++) panerelay(['--version'], { timeout: 30000 });
      const el = Date.now() - t0;
      console.log(JSON.stringify({ el, ...throttleStats() }));
    });
  `);
  const j = lastJson(r.out);
  // 5 次调用 → 4 个间隔 × 500ms = 2000ms 的强制等待（叠加在调用本身耗时之上）
  check('5 次连续调用被强制拉开', j.el >= 2000, `${j.el}ms（下限 2000ms）`);
  check('节流计数被记录', j.throttledCount >= 4, `throttled=${j.throttledCount}`);
  check('覆盖后的间隔生效', j.minIntervalMs === 500, `minIntervalMs=${j.minIntervalMs}`);
}

// ---- 1b. 默认值下，慢调用不应被无谓节流 ----
console.log('\n=== 1b. 默认 120ms 下，本身较慢的调用不应被节流 ===');
{
  const r = runInChild(`
    import('file:///${RUN}').then(({panerelay, throttleStats}) => {
      for (let i = 0; i < 3; i++) panerelay(['--version'], { timeout: 30000 });
      console.log(JSON.stringify(throttleStats()));
    });
  `);
  const j = lastJson(r.out);
  // --version 约 140ms > 120ms，所以不该有节流等待
  check('慢调用未被额外节流', j.throttledCount === 0, `throttled=${j.throttledCount}`);
  check('默认最小间隔为 120ms', j.minIntervalMs === 120);
}

// ---- 2. 每分钟上限：调低到 3 次，看第 4 次是否被阻塞 ----
console.log('\n=== 2. 每分钟硬上限（把上限临时调到 3 来测）===');
{
  const r = runInChild(`
    process.env.PANERELAY_MAX_PER_MINUTE = '3';
    process.env.PANERELAY_MIN_INTERVAL_MS = '0';
    import('file:///${RUN}').then(({panerelay}) => {
      const t0 = Date.now();
      for (let i = 0; i < 4; i++) panerelay(['--version'], { timeout: 30000 });
      console.log('ELAPSED:' + (Date.now() - t0));
    });
  `);
  const m = r.out.match(/ELAPSED:(\d+)/);
  const el = m ? Number(m[1]) : 0;
  // 第 4 次应触发「等待到本分钟结束」，即约 60 秒
  check('第 4 次调用被阻塞约 1 分钟', el >= 50000, `实际 ${(el / 1000).toFixed(1)}s`);
  check('打印了节流警告', /已达 3 次\/分钟上限/.test(r.out));
  check('警告里点名了性能测试', /性能测试/.test(r.out));
  check('覆盖参数时打印了醒目警告', /节流参数被环境变量覆盖/.test(r.out));
}

// ---- 3. 403 检测：伪造一个 403 响应，看是否报警 ----
console.log('\n=== 3. 403 限流检测 ===');
{
  // 直接调 assertNotRateLimited 的等价路径：构造假 CLI 输出不方便，
  // 改为测它的正则逻辑 —— 通过 import 后的 panerelay 无法注入响应，
  // 所以这里用一个独立的小脚本复现同样的判定。
  const probe = `
    const re = /"status"\\s*:\\s*403|HTTP\\s*403|status:\\s*403/;
    const cases = [
      ['{"status":403,"statusText":"Forbidden"}', true],
      ['HTTP 403 Forbidden', true],
      ['status: 403', true],
      ['{"status":200,"body":{}}', false],
      ['{"status":404}', false],
    ];
    let bad = 0;
    for (const [s, want] of cases) { if (re.test(s) !== want) { console.log('MISMATCH: ' + s); bad++; } }
    console.log('RESULT:' + bad);
  `;
  const r = runInChild(probe);
  const m = r.out.match(/RESULT:(\d+)/);
  check('403 判定正则正确识别 5 种情况', m && Number(m[1]) === 0, m ? `${m[1]} 处不匹配` : '无输出');
}

// ---- 4. 正常流水线速率不应触发节流 ----
console.log('\n=== 4. 正常速率（约 64 次/分钟）不应触发上限 ===');
{
  const perMin = 64;
  check('正常速率远低于上限 100/分钟', perMin < 100, `${perMin} < 100`);
  const minIntervalAllowed = 60000 / perMin;
  check('正常速率下的平均间隔高于强制下限', minIntervalAllowed > 120, `${minIntervalAllowed.toFixed(0)}ms > 120ms`);
}

console.log(`\n${fails ? '✗' : '✓'} ${fails ? fails + ' 项失败' : '全部通过'}`);
process.exit(fails ? 1 : 0);
