// 桥接不通时该给什么指引 —— 单一事实来源，供所有脚本 import。
//
// 2026-10-15 修正（第一版）：指引曾指向桌面 .lnk 快捷方式，而那个文件丢了 ——
//   指引指向不存在的文件 = 没有指引。改为指向 start-edge.cmd，并检测其是否存在。
//
// 2026-10-16 修正（本版）：新增 ensure-bridge.mjs --fix 之后，指引必须换主角。
//   实测「桥接断」在本机是**常态**（扩展只在 --load-extension 启动时加载，
//   而日常启动的 Edge、包括后台模式拉起的实例，都没有扩展）。
//   过去给的 start-edge.cmd 要求用户「先关干净 Edge」，还会撞上后台模式的死循环
//   （脚本判成"已在运行"拒绝启动，setup.md 1.6）—— 用户和 agent 都卡在这。
//   现在的顺序是：
//     ① ensure-bridge.mjs --fix —— 一条命令，自带安全闸，agent/用户都能跑
//     ② 治本：把扩展注册为**持久化未打包扩展**（edge://extensions），此后普通启动
//        Edge 也能连上，--load-extension 只剩兜底价值
//     ③ start-edge.cmd —— 手工兜底，仍保留
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @returns {string[]} 可直接逐行打印的指引 */
export function bridgeAdvice() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const cmd = path.join(home, '.panerelay', 'start-edge.cmd');
  const ext = path.join(home, '.panerelay', 'extension');
  const fix = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ensure-bridge.mjs');
  const hasCmd = fs.existsSync(cmd);

  const L = [];
  L.push('  Panerelay 桥接未连接 —— 通常是当前这个 Edge 不是带扩展启动的。');
  L.push('');
  L.push('  修复（一条命令，推荐）:');
  L.push(`    node "${fix}" --fix`);
  L.push('    会先探测；只结束「纯后台模式」的 Edge（无窗口，不可见），检测到你的窗口会拒绝执行；');
  L.push('    然后带扩展重启并复验。全程约 30 秒。');
  L.push('');
  L.push('  治本（一次性，之后普通启动 Edge 也能连上）:');
  L.push('    edge://extensions → 打开「开发人员模式」→「加载解压缩的扩展」→ 选:');
  L.push(`      ${ext}`);
  L.push('');

  if (hasCmd) {
    L.push('  手工兜底（等价于 --fix 的启动动作）:');
    L.push(`    ${cmd}      # 要求 Edge 已完全退出，否则会拒绝启动`);
  } else {
    L.push(`  [!] 兜底启动脚本也不存在: ${cmd}（部署见 references/setup.md 1.5）`);
  }

  L.push('');
  L.push('  注意：Edge 的后台模式会让 start-edge.cmd 判成「已在运行」而拒绝启动（setup.md 1.6）。');
  L.push('  改浏览器配置（注册持久扩展/重装扩展）属于用户可见变更 —— 先问用户再动手。');
  return L;
}

export const bridgeFiles = {
  cmd: (home = process.env.USERPROFILE || process.env.HOME || '') => path.join(home, '.panerelay', 'start-edge.cmd'),
  ext: (home = process.env.USERPROFILE || process.env.HOME || '') => path.join(home, '.panerelay', 'extension'),
  fix: () => path.join(path.dirname(fileURLToPath(import.meta.url)), 'ensure-bridge.mjs'),
};
