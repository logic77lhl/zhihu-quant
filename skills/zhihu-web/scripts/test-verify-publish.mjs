// test-verify-publish.mjs —— verify-publish 的回归测试（合成数据，不碰真实产物）
//
// 为什么需要：
//   发布闸门最怕「改着改着就不拦了」。合成一份小型 answers-full.json，
//   跑一遍 render-publish → verify-publish（应通过），再逐项篡改产物（应被拒），
//   这样闸门的每类断言都有可复现的证据。
//
// 用法: node test-verify-publish.mjs
// 退出码: 0 = 全部通过；1 = 有断言失败
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-publish-test-'));
const BASE = path.join(TMP, 'q999999-发布版');
const SRC = path.join(TMP, 'q999999-answers-full.json');

const P1 = '经济学教材的选择取决于你的目标。如果只是想建立直觉，先读科普比啃教材更有效，因为故事和案例能让人记住概念。等到需要系统训练时，再回到教材做习题，把图形和推导补齐。把读书笔记写成问题清单，比抄目录更有用。遇到不懂的图，先自己画一遍再对照答案，这样印象会深得多。';
const P2 = '我建议先看曼昆的入门教材，再把微观和宏观分开读。读的时候不要只划重点，要自己画一遍供需曲线，否则考试时还是不会用。每章后面的习题至少做一半，做错的题要回头找对应的章节。宏观部分重点看政策传导，别急着背模型。把每一章的假设写下来，再想它什么时候不成立。';
const P3 = '统计年鉴的数据比二手转述可靠。引用之前先看口径，确认是常住人口还是户籍人口，是当年价还是不变价。口径不对，后面的结论再漂亮也没有意义。如果找不到原始年鉴，就退回复述并注明来源。不要把二手图表当成一手数据，也不要把估算值写成实测值。把数据来源和口径写进脚注，比在正文里夸一句可靠更有说服力。';

const rows = [
  { id: 1, author: '甲', votes: 500, created_at: '2020-01-01T00:00:00Z', content: P1, url: 'https://www.zhihu.com/question/999999/answer/1', question_id: 999999, question_title: '测试问题', answer_type: 'normal' },
  { id: 2, author: '乙', votes: 120, created_at: '2021-02-02T00:00:00Z', content: P2, url: 'https://www.zhihu.com/question/999999/answer/2', question_id: 999999, question_title: '测试问题' },
  { id: 3, author: '丙', votes: 30, created_at: '2022-03-03T00:00:00Z', content: P3, url: 'https://www.zhihu.com/question/999999/answer/3', question_id: 999999, question_title: '测试问题' },
  { id: 4, author: '匿名用户', votes: 900, created_at: '2020-01-01T00:00:00Z', content: P1, url: 'https://www.zhihu.com/question/999999/answer/4', question_id: 999999, question_title: '测试问题' },
  { id: 5, author: '某机构', votes: 800, created_at: '2020-01-01T00:00:00Z', content: P2, url: 'https://www.zhihu.com/question/999999/answer/5', question_id: 999999, question_title: '测试问题', author_type: 'organization' },
  { id: 6, author: '付费作者', votes: 700, created_at: '2020-01-01T00:00:00Z', content: P3, url: 'https://www.zhihu.com/question/999999/answer/6', question_id: 999999, question_title: '测试问题', answer_type: 'paid' },
];
fs.writeFileSync(SRC, JSON.stringify(rows));

const run = (script, args) => spawnSync(process.execPath, [path.join(HERE, script), ...args], { encoding: 'utf8' });

let pass = 0, total = 0;
const check = (name, cond, detail = '') => {
  total++;
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else console.log(`  FAIL  ${name}${detail ? ' —— ' + detail : ''}`);
};
const verify = (html, extra = []) => {
  // 合成数据集很小（3 条），按真实阈值算引用占比必然超限；除占比用例外统一放宽到 100%
  const r = run('verify-publish.mjs', [html, '--source', SRC, '--max-quote-ratio', '100', '--json', ...extra]);
  let j = null;
  try { j = JSON.parse(r.stdout); } catch {}
  return { status: r.status, j, fails: j ? j.checks.filter((c) => c.level === 'FAIL').map((c) => c.msg) : [] };
};

console.log('=== 基线：render-publish → verify-publish ===');
const r0 = run('render-publish.mjs', [SRC, '--out', BASE + '.html', '--contact', 'qa@zhihu-report.cn']);
check('render-publish 成功', r0.status === 0, (r0.stderr || '').slice(0, 120));
const cit = JSON.parse(fs.readFileSync(BASE + '-citations.json', 'utf8'));
check('剔除 3 类各 1 条', cit.excluded.anon === 1 && cit.excluded.org === 1 && cit.excluded.paid === 1, JSON.stringify(cit.excluded));
check('保留 3 条 · 引用 3 处', cit.keptCount === 3 && cit.quotes.length === 3, `kept=${cit.keptCount} quotes=${cit.quotes.length}`);
const v0 = verify(BASE + '.html');
check('基线 0 FAIL', v0.status === 0 && v0.j && v0.j.fails === 0, v0.fails.join(' | '));
const html0 = fs.readFileSync(BASE + '.html', 'utf8');

console.log('\n=== 篡改：每一类都必须被拦住 ===');
const cases = [
  ['联系方式占位符', html0.replace(/请联系\s*[^，。；<]+/, '请联系 〔你的邮箱〕'), '联系方式'],
  ['引用被改写', html0.replace(/<div class="q"><p>「([^」]{4})/, '<div class="q"><p>「这是改写的'), '不在台账'],
  ['页脚处数不符', html0.replace(/引用\s*3\s*处/, '引用 2 处'), '页脚统计'],
  ['正文被搬运', html0.replace('</ol>', `<li>${P1.slice(0, 120)}</li></ol>`), '连续重合'],
  ['删掉 AI 标识', html0.replace(/AI 辅助生成/g, '自动整理'), 'AI 辅助生成'],
];
for (const [name, html, needle] of cases) {
  const f = path.join(TMP, `mut-${total}.html`);
  fs.writeFileSync(f, html);
  fs.copyFileSync(BASE + '-citations.json', f.replace(/\.html$/, '-citations.json'));
  const v = verify(f);
  check(name, v.status === 1 && v.fails.some((m) => m.includes(needle)), v.fails.slice(0, 2).join(' | '));
}
// 占比超限：把 --max-quote-ratio 调到 0.0001 触发默认阈值断言
{
  const r = run('verify-publish.mjs', [BASE + '.html', '--source', SRC, '--max-quote-ratio', '0.0001', '--json']);
  let j = null;
  try { j = JSON.parse(r.stdout); } catch {}
  const fails = j ? j.checks.filter((c) => c.level === 'FAIL').map((c) => c.msg) : [];
  check('引用占比超限', r.status === 1 && fails.some((m) => m.includes('引用总量占样本正文')), fails.slice(0, 1).join(''));
}

console.log(`\n${pass === total ? '✓' : '✗'} test-verify-publish：${pass}/${total} 通过`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(pass === total ? 0 : 1);
