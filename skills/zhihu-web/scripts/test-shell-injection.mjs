// 回归测试：URL 里的 shell 元字符必须原样传到底
//
// 这个测试存在的理由：
//   曾经通过 cmd.exe 调用 panerelay（spawnSync('cmd.exe', ['/c','panerelay', ...]），
//   URL 中的 & 被 cmd 当作命令分隔符，命令从中间被劈开：前半段「碰巧执行成功」，
//   后半段变成一条独立命令报错。退出码非 0，而且现象看起来像是服务端返回了错误，
//   极具误导性 —— 实际是本地命令行被拆了。
//
// 判据：panerelay 的响应里有 url 字段，会回显它「实际请求的 URL」。
//   把它和发出去的 URL 对比，就能确定参数有没有被 shell 吃掉。
//   这比看退出码可靠：退出码非 0 也可能只是业务失败。
//
// 用法: node test-shell-injection.mjs

import { panerelay, cliPath } from './panerelay-run.mjs';

const pass = [], fail = [];
const ok = (name, cond, extra = '') => (cond ? pass : fail).push(`${name}${extra ? '   [' + extra + ']' : ''}`);

if (!cliPath()) {
  console.log('未找到 panerelay CLI，先跑 npx --yes @panerelay/setup');
  process.exit(2);
}
console.log('CLI: ' + cliPath());
console.log('');

// 探测用的 URL 必须包含 shell 元字符；断言「回显 URL === 发出的 URL」
const CASES = [
  ['无元字符（基线）', 'https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=2'],
  ['& 连接两个参数', 'https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=2&offset=0'],
  ['& + 三个参数', 'https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=2&offset=0&reverse_order=0'],
  ['& + 中文编码值', 'https://www.zhihu.com/api/v4/search_v3?t=general&q=%E7%9F%A5%E4%B9%8E&correction=1'],
  ['& + 反斜杠', 'https://www.zhihu.com/api/v4/search_v3?t=general&q=a&path=C%3A%5Ctemp%5C'],
  ['& + 百分号', 'https://www.zhihu.com/api/v4/search_v3?t=general&q=100%25&x=1'],
  ['& + 管道符', 'https://www.zhihu.com/api/v4/search_v3?t=general&q=a%7Cb&x=1'],
  ['& + 重定向符', 'https://www.zhihu.com/api/v4/search_v3?t=general&q=a%3Eb&x=1'],
  ['& + & &（多分隔符）', 'https://www.zhihu.com/api/v4/search_v3?t=general&q=a&x=1&y=2'],
];

for (const [name, url] of CASES) {
  const r = panerelay(['fetch', url, '--response', 'json'], { timeout: 60000 });
  let echoed = null;
  try { const j = JSON.parse(r.text); echoed = j.url ?? j.body?.url ?? null; } catch { /* 非 JSON */ }

  const same = echoed === url;
  ok(name, same, same ? '' : `发出=${url}  回显=${echoed}`);
  ok(name + '：输出不含 shell 报错噪音', !/不是内部或外部命令|is not recognized|command not found/i.test(r.text));
}

// 额外验证：attachCookieCount 必须仍然是正数（证明 cookie 注入没被这次改动破坏）
{
  const url = 'https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=2&offset=0';
  const r = panerelay(['fetch', url, '--response', 'json'], { timeout: 60000 });
  try {
    const j = JSON.parse(r.text);
    const n = j.attachedCookieCount;
    if (j.status === 502 || /Bridge is unavailable/i.test(r.text)) {
      pass.push('Cookie 注入：Edge 未运行，跳过（不影响本组用例）');
    } else {
      ok('Cookie 注入仍正常（attachedCookieCount > 0）', typeof n === 'number' && n > 0, `实际 ${n}`);
    }
  } catch { fail.push('Cookie 注入：响应不是 JSON  ' + r.text.slice(0, 80)); }
}

console.log('\n通过 ' + pass.length + ' 项：');
pass.forEach((p) => console.log('  OK  ' + p));
if (fail.length) {
  console.log('\n失败 ' + fail.length + ' 项：');
  fail.forEach((f) => console.log('  XX  ' + f));
  console.log('\n诊断：调用链是否退回到 cmd 垫片？检查 panerelay-run.mjs 的 resolveCli()。');
  process.exit(1);
}
console.log('\n全部通过。URL 中的 shell 元字符完整送达。');