// zj-lib 的自测：口径算错不会报错，只会让报告更自信地错。
// 所以这里断言的是数字本身（合计/中位/占比/缺失/覆盖），不是"跑通不报错"。
//
// 用法: node test-zj.mjs
// 退出码: 0 全过 / 1 有失败
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as L from './zj-lib.mjs';

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fails.push(name); console.log(`  FAIL  ${name}${detail ? '  → ' + detail : ''}`); }
}
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zj-test-'));
const qid = '1234567890123456789';
const mk = (id, votes, comments, thanks, created, content, extra = {}) => ({
  id: String(id), author: `作者${id}`, votes, comments, thanks,
  created_at: created, updated_at: created,
  question_id: qid, question_title: '测试问题：这个口径算得对吗？',
  url: `https://www.zhihu.com/question/${qid}/answer/${id}`,
  content, answer_type: 'normal', author_type: 'people', is_advertiser: false,
  ...extra,
});
const rows = [
  mk(1, 119, 35, 3, '2026-10-29T00:54:24.000Z', '第一条回答，带 <b>HTML</b> 与实体 &#34;引号&#34;。'),
  mk(2, 116, 55, 0, '2026-10-28T08:27:08.000Z', '第二条回答，内容略长一些，用来测试中位数与截断行为是否正确。'),
  mk(3, 75, 46, 3, '2026-10-28T16:31:04.000Z', '第三条是付费内容。', { answer_type: 'paid', author_type: 'organization' }),
];
fs.writeFileSync(L.answersFile(dir, qid), JSON.stringify(rows, null, 1), 'utf8');
fs.writeFileSync(L.stateFile(dir, qid), JSON.stringify({
  done: { 'default:0': true }, items: {}, totals: { default: 3, created: 3 }, failed: [], version: 2,
  coverCheck: { at: '2026-10-29T03:55:23.316Z', sample: 3, missing: 0, skipped: true },
}), 'utf8');

console.log('zj-lib 自测\n');

// 1. 入口解析
eq('parseQid 从 URL 取 ID', L.parseQid('https://www.zhihu.com/question/2098800126764508086'), '2098800126764508086');
eq('parseQid 拒绝非 ID', L.parseQid('https://www.zhihu.com/topic/123'), null);

// 2. HTML 归一
eq('stripHtml 去标签', L.stripHtml('<p>a</p><p>b</p>'), 'a\nb');
eq('stripHtml 解实体', L.stripHtml('&#34;x&#34; &amp; y'), '"x" & y');

// 3. 统计口径
const s = L.computeStats(rows);
eq('赞数合计', s.votes.sum, 310);
eq('赞数中位', s.votes.median, 116);
eq('赞数最高', s.votes.max, 119);
eq('前 3 占比（3 条全在前 3）', s.votes.top3SharePct, 100);
eq('0 赞条数', s.votes.zero, 0);
eq('正文总字数 > 0', s.chars.sum > 0, true);
eq('时间跨度（小时，四舍五入 1 位）', s.time.spanHours, 16.5);

// 4. 字段缺失：0 是有效值，不能算缺失
const f = L.computeFields(rows);
eq('thanks 全部存在（含 0）', f.thanks.missing, 0);
eq('author 无缺失', f.author.missing, 0);
const rowsNoThanks = rows.map(({ thanks, ...r }) => r);
eq('缺 thanks 会被计入', L.computeFields(rowsNoThanks).thanks.missing, 3);

// 5. 覆盖：有 state 才算已知
const cov = L.computeCoverage(JSON.parse(fs.readFileSync(L.stateFile(dir, qid), 'utf8')), 3);
eq('覆盖已知', cov.known, true);
eq('平台 totals', cov.totals, 3);
eq('缺口为 0', cov.missing, 0);
eq('覆盖检查状态', cov.coverCheck, 'pass');
eq('只有 default 真正翻过页', cov.fetchedSorts, ['default']);
eq('created 只做了覆盖检查', cov.onlyCoverChecked, ['created']);
ok('排序标签不把 created 写成全量', L.sortsLabel(cov).includes('created 仅覆盖检查') && !L.sortsLabel(cov).includes('created 全量'), L.sortsLabel(cov));
const covUnknown = L.computeCoverage(null, 3);
eq('无 state 时不得声称完整', covUnknown.known, false);
eq('无 state 时 missing 必须是 null（不是 0）', covUnknown.missing, null);

// 6. 模式阈值
eq('3 条走 brief', L.pickMode(3), 'brief');
eq('40 条仍走 brief', L.pickMode(40), 'brief');
eq('41 条走 compact', L.pickMode(41), 'compact');
eq('201 条走 full', L.pickMode(201), 'full');

// 7. 告警：付费内容 / 机构号 / 无 state
const loaded = L.loadAnswers(dir, qid);
const m = L.buildManifest(qid, loaded.raw, { state: JSON.parse(fs.readFileSync(L.stateFile(dir, qid), 'utf8')), mtime: fs.statSync(L.stateFile(dir, qid)).mtime }, loaded);
ok('manifest 告警含付费内容', m.warnings.some((w) => w.includes('严选')), m.warnings.join(' | '));
ok('manifest 告警含机构号', m.warnings.some((w) => w.includes('机构号')), m.warnings.join(' | '));
ok('manifest sha 为 16 位', /^[0-9a-f]{16}$/.test(m.source.sha256_16));
eq('manifest 输出模式', m.outputMode, 'brief');
const mUnknown = L.buildManifest(qid, loaded.raw, { state: null, mtime: null }, loaded);
ok('无 state 的 manifest 必须告警', mUnknown.warnings.some((w) => w.includes('完整性未知')), mUnknown.warnings.join(' | '));

// 8. 截断与筛选
eq('excerpt 截断加省略号', L.excerpt('一二三四五', 3), '一二三…');
eq('短文本不截断', L.excerpt('一二三', 3), '一二三');
eq('paid 过滤', L.selectRows(rows, { type: 'paid' }).map((r) => r.id), ['3']);
eq('normal 过滤', L.selectRows(rows, { type: 'normal' }).map((r) => r.id), ['1', '2']);
eq('min-votes 过滤', L.selectRows(rows, { minVotes: 100 }).map((r) => r.id), ['1', '2']);
eq('created 排序（新→旧）', L.selectRows(rows, { sort: 'created' }).map((r) => r.id), ['1', '3', '2']);

// 9. 简报必须留人和机器的边界
const brief = L.renderBrief(m, rows);
ok('简报含待填占位', brief.includes('<!-- 待填'));
ok('简报含口径表', brief.includes('## 口径') && brief.includes('sha256:'));
ok('简报样本数与 manifest 一致', brief.includes(`样本 **3 / 3**`), brief.split('\n')[2]);
ok('简报不再声称未知覆盖', !brief.includes('无 state.json'));

// 10. 缺产物时明确失败，不返回空数组
const missing = L.loadAnswers(path.join(dir, 'nope'), qid);
eq('缺产物返回 NOT_FOUND', missing.reason, 'NOT_FOUND');

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} 通过，${fails.length} 失败`);
if (fails.length) { fails.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
