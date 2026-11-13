// 桥接修复：探测 → （--fix 时）重启 Edge → 复验。
//
// 为什么需要：
//   桥接断了是这套 skill 的**常态**，不是异常 —— 因为扩展过去只在
//   `--load-extension` 启动时加载，而日常启动的 Edge（含后台模式的
//   `--no-startup-window`）都没有扩展。于是每次都要人工"关干净 Edge +
//   用 start-edge.cmd 重启"，而这个动作对 agent 是禁区、对用户是反复摩擦。
//   本脚本把这件事变成一条命令，并且**带安全闸**：
//     · 只在 Edge 是「纯后台模式」时才直接杀 —— 后台进程没有窗口，杀掉不可见
//     · 检测到用户开着 Edge 窗口时**拒绝执行**（除非显式 --force），并说明会关掉什么
//     · 启动方式自动选择：扩展若已**持久注册**（edge://extensions 里加载过的未打包扩展），
//       就普通启动；否则退回 --load-extension（start-edge.cmd 的等价行为）
//
// 用法:
//   node ensure-bridge.mjs                 # 只探测，不改任何东西
//   node ensure-bridge.mjs --fix           # 断则修（后台模式自动杀；有窗口则拒绝）
//   node ensure-bridge.mjs --fix --force   # 允许连用户窗口一起关（需用户明确同意）
//   node ensure-bridge.mjs --fix --mode=load    # 强制带 --load-extension 启动
//   node ensure-bridge.mjs --fix --mode=normal  # 强制普通启动（扩展已持久注册时用）
//
// 退出码: 0 桥接可用 / 4 仍不可用
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { probeBridge } from './precheck.mjs';

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const EXT = path.join(HOME, '.panerelay', 'extension');
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const EXT_ID = 'panplnkjlkoceaonlmpdekjphgmbggmi';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function edgeExe() {
  return EDGE_CANDIDATES.find((p) => fs.existsSync(p)) || null;
}

function edgeProcesses() {
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
  ], { encoding: 'utf8', timeout: 30000 });
  if (ps.status !== 0) return null; // 查不到 ≠ 没有 —— 让调用方按"未知"处理
  try {
    const j = JSON.parse(ps.stdout || '[]');
    const arr = Array.isArray(j) ? j : [j];
    return arr.filter((x) => x && x.CommandLine);
  } catch {
    return null; // 空输出（没有进程）会解析失败，视作 0 个
  }
}

/** 扩展是否已持久注册（而非 --load-extension 临时加载）。
 *  这是 2026-10-16 起推荐的部署方式：之后普通启动 Edge 也会加载扩展。
 *
 *  2026-10-16 实测修正：新版 Edge 把扩展配置放在 **`Secure Preferences`**，
 *  `Preferences` 里只有零星残留 —— 只读前者会永远判成"未注册"（踩过）。
 *  两份文件、所有 profile 都查；判定条件放宽为「有条目 + 未被禁用 + 是未打包/路径匹配」。 */
export function isExtensionPersisted() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data');
  let profiles = [];
  try {
    profiles = fs.readdirSync(base).filter((n) => n === 'Default' || /^Profile \d+$/.test(n));
  } catch {
    return false;
  }
  for (const prof of profiles) {
    for (const file of ['Secure Preferences', 'Preferences']) {
      try {
        const raw = fs.readFileSync(path.join(base, prof, file), 'utf8');
        const j = JSON.parse(raw);
        const s = j?.extensions?.settings?.[EXT_ID];
        if (!s) continue;
        if (s.state === 0) continue;                    // 0 = 被禁用
        const unpacked = s.location === 4;               // 4 = LOAD_UNPACKED
        const pathMatch = typeof s.path === 'string' && s.path.toLowerCase() === EXT.toLowerCase();
        if (unpacked || pathMatch) return { profile: prof, file, location: s.location, path: s.path };
      } catch { /* 尝试下一个文件/profile */ }
    }
  }
  return false;
}

function winAdvice() {
  return [
    '',
    '  一次性的治本做法（推荐，之后不用再折腾）:',
    '    1. Edge 地址栏打开  edge://extensions',
    '    2. 左下角打开「开发人员模式」',
    '    3. 点「加载解压缩的扩展」，选这个目录:',
    `       ${EXT}`,
    '    4. 之后普通启动 Edge 也会加载扩展 —— start-edge.cmd 只留作兜底。',
  ];
}

function killEdge() {
  const r = spawnSync('taskkill', ['/F', '/IM', 'msedge.exe', '/T'], { encoding: 'utf8', timeout: 60000 });
  if (r.status === 0) return true;
  // 「没找到进程」不算失败 —— 本来就没在跑。
  // 2026-10-16 踩坑：只匹配了"没有运行"，中文 taskkill 实际输出"没有找到进程"，
  // 导致空进程时误报失败并 exit 4。
  return /not found|没有找到|没有运行|找不到/i.test((r.stdout || '') + (r.stderr || ''));
}

// 2026-10-16 踩坑：这里原先用 spawnSync 启动 Edge，脚本直接挂死。
// spawnSync **会等子进程退出**，而 Edge 是常驻进程 —— detached 也拦不住它等。
// 必须用异步 spawn + unref：发起后立即返回，不等 Edge。
function startEdge(mode) {
  const exe = edgeExe();
  if (!exe) return { ok: false, why: '找不到 msedge.exe（两个常见路径都没有）' };
  const args = mode === 'normal'
    ? []
    : ['--disable-features=DisableLoadExtensionCommandLineSwitch', `--load-extension=${EXT}`];
  try {
    const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (e) {
    return { ok: false, why: `启动失败: ${e.message}` };
  }
  return { ok: true, mode, args: args.join(' ') || '(默认参数)' };
}

// ---------------- 主流程 ----------------
const argv = process.argv.slice(2);
const fix = argv.includes('--fix');
const force = argv.includes('--force');
const modeArg = (argv.find((a) => a.startsWith('--mode=')) || '').split('=')[1];

console.log('桥接探测…（约 1-3 秒）');
let bridge = probeBridge();
if (bridge.ok) {
  console.log(`OK   桥接可用：${bridge.account} (${bridge.token})  cookie=${bridge.cookies}`);
  const persisted = isExtensionPersisted();
  console.log(persisted
    ? `     扩展已持久注册（profile=${persisted.profile}）—— 普通启动 Edge 也能连上。`
    : '     注意：扩展是临时加载的（--load-extension）。普通启动 Edge 会连不上 —— 见下方治本做法。');
  if (!persisted) winAdvice().forEach((l) => console.log(l));
  process.exit(0);
}

console.log(`FAIL ${bridge.why}: ${bridge.detail}`);
if (bridge.why !== 'BRIDGE_DOWN') {
  // 桥接本身没断，是别的问题（未登录 / Cookie 没注入 / 命令失败）—— 重启 Edge 解决不了
  console.log('');
  console.log('这不是「Edge 没带扩展」的问题，重启 Edge 没用。先跑深诊断：');
  console.log('  node check.mjs');
  process.exit(4);
}

if (!fix) {
  console.log('');
  console.log('修复（一条命令；agent 执行前必须先征得用户同意）:');
  console.log('  node ensure-bridge.mjs --fix');
  console.log('  说明：只有「纯后台模式」的 Edge 会被直接结束；检测到窗口会拒绝执行。');
  process.exit(4);
}

const procs = edgeProcesses();
const known = Array.isArray(procs);
const none = known && procs.length === 0;
const hasExt = known ? procs.some((x) => x.CommandLine.includes('--load-extension')) : false;
const windowed = known ? procs.some((x) => !x.CommandLine.includes('--type=')
  && !x.CommandLine.includes('--no-startup-window')
  && !x.CommandLine.includes('--load-extension')) : false;

// 启动并打印结果；mode=auto 时按扩展是否持久注册自动选 normal/load
function launch() {
  const persisted = isExtensionPersisted();
  const mode = modeArg || (persisted ? 'normal' : 'load');
  const st = startEdge(mode);
  if (!st.ok) {
    console.log(`[x] ${st.why}`);
    process.exit(4);
  }
  console.log(`    已启动 Edge（mode=${mode}，${st.args}）。`);
  if (mode === 'load' && !persisted) winAdvice().forEach((l) => console.log(l));
}

if (none) {
  console.log('');
  console.log('当前没有 Edge 进程 —— 直接启动。');
  launch();
} else if (!known) {
  // 查不到进程列表 ≠ 没有进程，所以按最保守的路径走：不杀，只提示
  console.log('');
  console.log('[x] 无法枚举 Edge 进程（PowerShell 调用失败）—— 不冒险杀进程。');
  console.log('    请手动关闭 Edge（确认托盘/后台也退了）后再跑 --fix。');
  process.exit(4);
} else if (hasExt) {
  console.log('');
  console.log('Edge 已带扩展启动，但桥接还没连上 —— 扩展 service worker 是懒加载的，等一会儿。');
} else if (windowed && !force) {
  console.log('');
  console.log('[x] 检测到你开着 Edge 窗口（不是后台进程）。重启会关掉它们，所以默认拒绝。');
  console.log('    确认可以关（请先保存网页里的东西）后，加 --force 再跑一次：');
  console.log('      node ensure-bridge.mjs --fix --force');
  process.exit(4);
} else {
  console.log('');
  console.log(windowed
    ? '按 --force 执行：结束 Edge（含你的窗口）→ 重启。'
    : 'Edge 只有后台进程（无窗口），直接结束并带扩展重启。');
  if (!killEdge()) {
    console.log('[x] taskkill 失败 —— 请手动关闭 Edge 后再跑 --fix。');
    process.exit(4);
  }
  await sleep(2500);
  launch();
}

// 轮询等待桥接（扩展 service worker 懒加载，实测 5~20 秒）
const t0 = Date.now();
for (let i = 1; i <= 10; i++) {
  await sleep(i === 1 ? 6000 : 5000);
  bridge = probeBridge();
  if (bridge.ok) {
    console.log('');
    console.log(`OK   桥接已恢复：${bridge.account} (${bridge.token})  cookie=${bridge.cookies}  （${Math.round((Date.now() - t0) / 1000)} 秒）`);
    process.exit(0);
  }
  console.log(`  …第 ${i} 次复验未通（${bridge.detail}）`);
}
console.log('');
console.log('[x] 等待超时，桥接仍未连上。跑深诊断：node check.mjs');
process.exit(4);
