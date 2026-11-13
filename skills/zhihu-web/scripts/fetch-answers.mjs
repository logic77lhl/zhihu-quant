// ⚠️ 已废弃 —— 请用 fetch-answers-api.mjs
//
// 保留原因：仅作历史参考，以及极小问题（<20 条）时的兜底。
//
// 为什么废弃（两条都是实测的）：
//   1. 慢：走 `answer-detail` 逐条抓，约 1.2 秒/条；
//      fetch-answers-api.mjs 走分页接口，每页 20 条，约 1.5 页/秒。
//   2. **能力缺失**：`answer-detail` 不返回 `answer_type` / 机构号字段，
//      所以走这条路拿到的产物**做不了内容性质判定**（盐选/小说识别）。
//      这不是加几行 include 能解决的 —— 该接口本身没有这些字段。
//
// 迁移：把 `node fetch-answers.mjs <ID>` 换成 `node fetch-answers-api.mjs <ID>`，
// 输出格式完全一致（且多三个性质字段）。
//
// 通用回答抓取器：全量回答 + 赞数 + 发布时间 + 评论数 + 全文
//
// 用法:
//   node fetch-answers.mjs <questionId> [--concurrency N] [--sleep MS] [--limit N] [--out file.json]
//
// 例:
//   node fetch-answers.mjs 28193957 --concurrency 3 --sleep 80
//
// 设计要点（都是踩过坑的）:
//   - 必须走 panerelay-run.mjs：绕开 cmd.exe，URL 里的 & | < > 不会被当命令分隔符
//   - --max-content 0 才是全文；question 命令的 content 被截断到 200 字符
//   - 断点续跑：state 落在 <out>.state.json，中断后重跑会跳过已完成的
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { panerelay } from './panerelay-run.mjs';

const argv = process.argv.slice(2);
const qid = argv.find((a) => /^\d+$/.test(a));
if (!qid) {
  console.error('用法: node fetch-answers.mjs <questionId> [--concurrency N] [--sleep MS] [--limit N] [--out f.json]');
  process.exit(1);
}
const num = (flag, def) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : def;
};
const CONC = num('--concurrency', 2);
const SLEEP = num('--sleep', 80);
const LIMIT = num('--limit', 0);          // 0 = 全部
const OUT = (() => { const i = argv.indexOf('--out'); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; })();

// 输出目录与 pipeline.mjs 保持一致
function resolveOutDir() {
  if (process.env.ZHIHU_QUANT_OUT) return process.env.ZHIHU_QUANT_OUT;
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.join(HERE, '..', 'config.json'), path.join(HERE, '..', '..', 'config.json')]) {
    try { const c = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); if (c.outDir) return c.outDir; } catch {}
  }
  return path.join(process.env.USERPROFILE || process.env.HOME, 'Documents', 'zhihu-quant');
}
const D = resolveOutDir().replace(/\\/g, '/') + '/';
fs.mkdirSync(D, { recursive: true });
const outFile = OUT || `${D}q${qid}-answers-full.json`;
const stateFile = outFile + '.state.json';

// 统一调用层：绕开 cmd.exe，URL 里的 & | < > ^ 不会被当命令分隔符
// 详见 panerelay-run.mjs 顶部注释。回归测试见 test-shell-injection.mjs。
const run = (args, timeout = 90000) => panerelay(args, { timeout }).text;
const parse = (t) => { try { const j = JSON.parse(t); return Array.isArray(j) ? j[0] : j; } catch { return null; } };
const parseAll = (t) => { try { const j = JSON.parse(t); return Array.isArray(j) ? j : (j?.items || j?.data || []); } catch { return []; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. 拿回答清单（两种排序都跑，按 id 合并） ----
let ids = [];
if (fs.existsSync(outFile) && fs.existsSync(stateFile)) {
  try {
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    ids = st.ids || [];
    console.log(`续跑：已有清单 ${ids.length} 条，已完成 ${Object.keys(st.done || {}).length} 条`);
  } catch {}
}
if (!ids.length) {
  console.log(`抓取 question/${qid} 回答清单 ...`);
  const a = parseAll(run(['zhihu', 'question', qid, '--limit', '1000', '--json']));
  const b = parseAll(run(['zhihu', 'question', qid, '--limit', '1000', '--sort', 'created', '--json']));
  console.log(`  default=${a.length}  created=${b.length}`);
  const m = new Map();
  for (const x of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) if (x.id && !m.has(x.id)) m.set(x.id, x);
  ids = [...m.keys()];
  if (LIMIT) ids = ids.slice(0, LIMIT);
  console.log(`  合并去重后 ${ids.length} 条`);
}

let state = { ids, done: {} };
if (fs.existsSync(stateFile)) { try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch {} }
const todo = ids.filter((i) => !state.done[i]);
console.log(`待抓 ${todo.length} 条  并发=${CONC} 间隔=${SLEEP}ms\n`);

const save = () => fs.writeFileSync(stateFile, JSON.stringify(state), 'utf8');
const t0 = Date.now();
let ok = 0, fail = 0;

// ---- 2. worker 池 ----
async function worker(wid) {
  for (let i = wid; i < todo.length; i += CONC) {
    const id = todo[i];
    const a = parse(run(['zhihu', 'answer-detail', id, '--max-content', '0', '--json']));
    if (a && a.id) {
      state.done[id] = {
        id: String(a.id), author: a.author, votes: a.votes, comments: a.comments,
        created_at: a.created_at, updated_at: a.updated_at,
        question_id: a.question_id, question_title: a.question_title,
        url: a.url, content: a.content || '',
      };
      ok++;
    } else { fail++; state.done[id] = { id, error: true }; }
    if ((ok + fail) % 20 === 0) {
      save();
      const el = (Date.now() - t0) / 1000;
      const rate = (ok + fail) / el;
      const eta = (todo.length - ok - fail) / rate;
      process.stdout.write(`  ${ok + fail}/${todo.length}  ok=${ok} fail=${fail}  ${el.toFixed(0)}s  ETA ${eta.toFixed(0)}s\n`);
    }
    if (SLEEP) await sleep(SLEEP);
  }
}

await Promise.all(Array.from({ length: CONC }, (_, k) => worker(k)));
save();

const all = Object.values(state.done).filter((d) => !d.error);
const failed = Object.values(state.done).filter((d) => d.error);
const el = (Date.now() - t0) / 1000;
console.log(`\n完成 ok=${all.length} fail=${failed.length}  用时 ${el.toFixed(0)}s  (${(all.length / el).toFixed(1)} 条/秒)`);

if (all.length) {
  const tv = all.reduce((s, d) => s + (d.votes || 0), 0);
  const cl = all.reduce((s, d) => (d.content || '').length, 0);
  const dates = all.map((d) => d.created_at).filter(Boolean).sort();
  console.log(`  赞数合计 ${tv}   正文总字数 ${cl}   时间 ${dates[0]?.slice(0, 10)} ~ ${dates[dates.length - 1]?.slice(0, 10)}`);
  fs.writeFileSync(outFile, JSON.stringify(all, null, 1), 'utf8');
  console.log(`  已写入 ${outFile}`);
}
if (failed.length) {
  console.log(`  失败 ID: ${failed.map((f) => f.id).join(',')}`);
  console.log(`  重跑同一条命令即可续跑`);
}