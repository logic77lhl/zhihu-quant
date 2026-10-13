// 一键管线：知乎问题 -> 结构化实体报告
//
// 用法:
//   node pipeline.mjs <问题ID> --preset books [选项]
//
//   node pipeline.mjs 28193957 --preset books
//   node pipeline.mjs 24590883 --preset pythonlibs --concurrency 3 --sleep 60
//   node pipeline.mjs 28193957 --preset books --skip-fetch     # 复用已有 answers-full.json
//
// 产物（都在输出目录，默认 ~/Documents/zhihu-quant）:
//   q<id>-answers-full.json       全部回答：全文 + 赞数 + 时间 + 评论
//   q<id>-entities.json           规范化实体
//   q<id>-<问题标题>.html/.md     报告
//
// 输出目录由 resolveOutDir() 决定，默认 ~/Documents/zhihu-quant
// 前置条件: Edge 必须用安装脚本创建的「Edge (Panerelay)」快捷方式启动。
// 自检: node pipeline/check-bridge.mjs

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 输出目录：环境变量 ZHIHU_QUANT_OUT > 仓库 config.json > ~/Documents/zhihu-quant
function resolveOutDir() {
  if (process.env.ZHIHU_QUANT_OUT) return process.env.ZHIHU_QUANT_OUT;
  for (const p of [path.join(HERE, '..', 'config.json'), path.join(HERE, '..', '..', 'config.json')]) {
    try { const c = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); if (c.outDir) return c.outDir; } catch {}
  }
  return path.join(process.env.USERPROFILE || process.env.HOME, 'Documents', 'zhihu-quant');
}
const OUTDIR = resolveOutDir();
fs.mkdirSync(OUTDIR, { recursive: true });

const argv = process.argv.slice(2);
const QID = argv.find((a) => /^\d{5,}$/.test(a));
if (!QID) { console.error('用法: node pipeline.mjs <问题ID> --preset <name>'); process.exit(1); }

const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);

const preset = flag('--preset', 'books');
const conc = flag('--concurrency', '3');
const slp = flag('--sleep', '60');
const limitArg = has('--limit') ? flag('--limit', '0') : null;
const answersFile = `${OUTDIR}/q${QID}-answers-full.json`;
const entitiesFile = `${OUTDIR}/q${QID}-entities.json`;

const sh = (cmd, args, label) => {
  process.stdout.write(`\n\x1b[36m▸ ${label}\x1b[0m\n`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: HERE, shell: false });
  if (r.status !== 0) {
    console.error(`\n✗ ${label} 失败（退出码 ${r.status}）`);
    if (label.includes('抓取')) console.error('  常见原因: Edge 不是用「Edge (Panerelay)」快捷方式启动的。先跑 node check-bridge.mjs');
    process.exit(r.status || 1);
  }
};

// 0. 桥接自检（跳过抓取时也做，只提示不中断）
const bridge = spawnSync('node', [path.join(HERE, 'check-bridge.mjs')], { encoding: 'utf8', cwd: HERE });
const bTxt = ((bridge.stdout || '') + (bridge.stderr || '')).trim();
console.log(bTxt.split('\n').map((l) => (l.startsWith('OK') || l.startsWith('FAIL') ? l : '  ' + l)).join('\n'));
if (bridge.status !== 0 && !has('--skip-fetch')) {
  console.error('\n✗ 桥接不通，已中止。先用桌面「Edge (Panerelay)」启动 Edge。');
  process.exit(2);
}

// 1. 抓取
if (has('--skip-fetch') && fs.existsSync(answersFile)) {
  console.log(`\n\x1b[36m▸ 抓取\x1b[0m  跳过，复用 ${path.basename(answersFile)}`);
} else {
  const args = [path.join(HERE, 'fetch-answers.mjs'), QID, '--concurrency', conc, '--sleep', slp];
  if (limitArg) args.push('--limit', limitArg);
  sh('node', args, `抓取 question/${QID} 全部回答`);
}

// 2. 抽取
const presetFile = path.join(HERE, 'presets', `${preset}.json`);
if (!fs.existsSync(presetFile)) {
  console.error(`\n✗ 找不到预设 presets/${preset}.json`);
  console.error(`  可用: ${fs.readdirSync(path.join(HERE, 'presets')).filter((f) => f.endsWith('.json')).join(', ')}`);
  process.exit(1);
}
const exArgs = [path.join(HERE, 'extract-entities.mjs'), answersFile, '--preset', preset, '--out', entitiesFile];
const dictArg = flag('--dict', null);
if (dictArg) exArgs.push('--dict', dictArg);
sh('node', exArgs, `抽取实体（预设 ${preset}）`);

// 3. 渲染
sh('node', [path.join(HERE, 'render-report.mjs'), entitiesFile, '--answers', answersFile], '生成报告');

console.log('\n\x1b[32m✓ 完成\x1b[0m');
console.log(`  原始数据: ${path.basename(answersFile)}`);
console.log(`  实体数据: ${path.basename(entitiesFile)}`);