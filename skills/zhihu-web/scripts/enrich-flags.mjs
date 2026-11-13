// 轻量补抓：只取 answer_type / is_advertiser / user_type，按 id 回填进已有 answers-full.json
// 不重取正文，所以比全量抓取快得多（原 INC 带 content，单页就要传几百 KB）。
//
// 为什么需要：知乎 API 的 answer_type 能区分「严选/盐选付费内容」，
// 但第一次抓取时 include 里没有这个字段，数据集里就没有 —— 后补只能再打一次接口。
import fs from 'node:fs';
import { panerelay } from './panerelay-run.mjs';

const FILE = process.argv[2];
if (!FILE) { console.error('用法: node enrich-flags.mjs <answers-full.json> [questionId]'); process.exit(1); }
const qid = process.argv[3] || JSON.parse(fs.readFileSync(FILE, 'utf8'))[0].question_id;
const PAGE = 20;
const LIGHT = 'voteup_count,answer_type,author.is_advertiser,author.user_type,author.badge_v2,is_collapsed,content_need_truncated';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fetchPage = async (sort, offset) => {
  const r = panerelay(['fetch', `https://www.zhihu.com/api/v4/questions/${qid}/answers`,
    '--query', `limit:${PAGE}`, '--query', `offset:${offset}`, '--query', `sort_by:${sort}`,
    '--query', `include:${LIGHT}`, '--response', 'json'], { timeout: 120000, maxBuffer: 1 << 24 });
  const j = JSON.parse(r.text);
  const b = j.body || j;
  if (!b || !Array.isArray(b.data)) throw new Error('无 data: ' + JSON.stringify(b).slice(0, 120));
  return { data: b.data, paging: b.paging || {} };
};

const answers = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const byId = new Map(answers.map((a) => [String(a.id), a]));
console.log(`已有 ${answers.length} 条，开始补抓 answer_type ...\n`);

const seen = new Set();
const pages = [];
for (const sort of ['default', 'created']) {
  const first = await fetchPage(sort, 0);
  const total = first.paging.totals || 0;
  const n = Math.ceil(total / PAGE);
  console.log(`  ${sort}: totals=${total} -> ${n} 页`);
  pages.push(...Array.from({ length: n }, (_, i) => ({ sort, offset: i * PAGE })));
}

const t0 = Date.now();
let ok = 0, fail = 0, cursor = 0, newFlag = 0;
async function worker() {
  while (cursor < pages.length) {
    const p = pages[cursor++];
    try {
      const { data } = await fetchPage(p.sort, p.offset);
      for (const it of data) {
        const rec = byId.get(String(it.id));
        if (!rec) continue;
        rec.answer_type = it.answer_type || 'normal';
        rec.author_type = it.author?.user_type || 'people';
        rec.is_advertiser = !!it.author?.is_advertiser;
        const bad = it.author?.badge_v2?.detail_badges || [];
        rec.badges = bad.map((b) => b.description).filter(Boolean);
        newFlag++;
      }
      seen.add(p.sort + ':' + p.offset);
      ok++;
    } catch (e) { fail++; if (fail < 4) console.log(`  [!] ${p.sort}:${p.offset} ${e.message}`); }
    if ((ok + fail) % 40 === 0) {
      fs.writeFileSync(FILE, JSON.stringify(answers, null, 1), 'utf8');
      process.stdout.write(`  ${ok + fail}/${pages.length} 页  已回填 ${newFlag}  ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
    }
    await sleep(100);
  }
}
await Promise.all(Array.from({ length: 3 }, () => worker()));
fs.writeFileSync(FILE, JSON.stringify(answers, null, 1), 'utf8');

const paid = answers.filter((a) => a.answer_type && a.answer_type !== 'normal');
const adv = answers.filter((a) => a.is_advertiser);
console.log(`\n完成：${pages.length} 页 ok=${ok} fail=${fail}，回填 ${newFlag} 条，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
const byType = answers.reduce((m, x) => (m[x.answer_type] = (m[x.answer_type] || 0) + 1, m), {});
  console.log(`  answer_type 分布 : ${JSON.stringify(byType)}`);
  console.log(`  非 normal（付费）: ${paid.length} 条`);
console.log(`  is_advertiser    : ${adv.length} 条`);
console.log(`  仍未回填的       : ${answers.filter((a) => !a.answer_type).length} 条`);
