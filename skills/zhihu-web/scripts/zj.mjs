// zj —— 知乎量化产物的查询 / 口径 / 简报 CLI
//
// 解决什么问题（2026-10-29 实测）：
//   抓取已经只要 1 秒，但接手的人（或 agent）还要用 node -e 猜 JSON 结构，
//   PowerShell 的引号与编码解析连踩两次，然后手工读全文写综述。
//   瓶颈从"抓不到"变成了"抓到了没人写、写完了没人验"。
//
// 设计取舍：
//   - 零依赖、零网络：只读本地产物，不碰桥接，不触发任何请求
//   - 口径计算全部在 zj-lib.mjs，可被 test-zj.mjs 断言
//   - 简报只写机器算得出来的部分，观点位置留 <!-- 待填 -->，防止模型编结论
//   - 找不到产物时**不猜目录**：散落在别处就打印候选并退出 4（与 precheck 同一套原则）
//
// 用法:
//   node zj.mjs q <id|url> [--top 10] [--sort votes|created|comments] [--min-votes N]
//                          [--type all|normal|paid] [--excerpt 60] [--links] [--json] [--fields a,b,c] [--full]
//   node zj.mjs stats <id|url>        # 人类可读的口径摘要
//   node zj.mjs manifest <id|url>     # 写 q<ID>-manifest.json；--print 只打印
//   node zj.mjs brief <id|url> [--top 8] [--excerpt 90] [--out f.md]   # 按样本量自适应
//   公共参数: --dir <输出目录>
//
// 退出码:
//   0  成功
//   1  用法错误
//   2  产物不存在
//   4  产物在别的目录（散落），需显式 --dir 或设 ZHIHU_QUANT_OUT
import fs from 'node:fs';
import path from 'node:path';
import { resolveOutDir, candidateDirs } from './precheck.mjs';
import * as L from './zj-lib.mjs';

const argv = process.argv.slice(2);
const USAGE = `zj —— 知乎量化产物 CLI（零依赖，只读本地）

  node zj.mjs q <id|url>        列表（默认按赞数）
      --top N            只显示前 N 条（默认 20）
      --all              显示全部（回答集可能有几千条，慎用）
      --sort votes|created|comments
      --min-votes N      过滤低赞
      --type all|normal|paid        paid = answer_type !== normal
      --excerpt N        摘录长度（0 = 不显示）
      --fields a,b,c     --json 时输出这些字段
      --links            每条附原文链接
      --json | --full    JSON 输出；--full 附带正文全文

  node zj.mjs stats <id|url>    口径摘要（样本/覆盖/赞数/正文/时间/字段缺失/告警）
  node zj.mjs manifest <id|url> 写 q<ID>-manifest.json（--print 只打印 JSON）
  node zj.mjs brief <id|url>    生成简报（≤40 条 brief / ≤200 compact / 更多建议走全量流水线）
      --top N --excerpt N --out <file.md>

  公共: --dir <目录>（默认 $ZHIHU_QUANT_OUT → config.json → ~/Documents/zhihu-quant）`;

function die(code, msg) {
  if (msg) console.error(msg);
  process.exit(code);
}

function parseArgs(args) {
  const flags = { _: [] };
  const takesValue = new Set(['--dir', '--top', '--sort', '--fields', '--excerpt', '--min-votes', '--type', '--out']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (takesValue.has(a)) {
        const v = args[++i];
        if (v === undefined) die(1, `${a} 需要一个值`);
        flags[key] = v;
      } else flags[key] = true;
    } else flags._.push(a);
  }
  return flags;
}

const flags = parseArgs(argv);
const cmd = flags._[0];

if (!cmd || cmd === 'help' || flags.help) {
  console.log(USAGE);
  process.exit(cmd ? 0 : 1);
}

const qid = L.parseQid(flags._[1]);
if (!qid) die(1, `需要一个知乎问题 ID 或链接，例如 2098800126764508086\n\n${USAGE}`);

const dir = flags.dir ? path.resolve(String(flags.dir)) : path.resolve(resolveOutDir());
let res = L.loadAnswers(dir, qid);
if (!res.ok) {
  if (res.reason === 'NOT_ARRAY') die(2, `产物不是数组: ${res.file}`);
  const elsewhere = candidateDirs()
    .filter((d) => path.resolve(d) !== dir)
    .map((d) => L.answersFile(d, qid))
    .filter((f) => fs.existsSync(f));
  if (elsewhere.length) {
    console.error(`解析出的输出目录里没有 q${qid}-answers-full.json：\n  ${dir}\n`);
    console.error('但在别处找到了（产物散落，先决定用哪个，别两边各抓一份）：');
    elsewhere.forEach((f) => console.error(`  ${f}`));
    console.error(`\n显式指定： node zj.mjs ${cmd} ${qid} --dir "${path.dirname(elsewhere[0])}"`);
    process.exit(4);
  }
  die(2, `没有产物：${res.file}\n先抓： node fetch-answers-api.mjs ${qid}`);
}

const rows = res.raw;
const stateRes = L.loadState(dir, qid);
const build = () => L.buildManifest(qid, rows, stateRes, res);

const intFlag = (name, dflt) => (flags[name] === undefined ? dflt : Number(flags[name]));

switch (cmd) {
  case 'q': {
    // 默认只给 20 条：几千条的回答集会一次性灌满上下文，想看全的显式 --all。
    const top = flags.all ? null : (flags.top === undefined ? 20 : intFlag('top', 20));
    const sort = flags.sort || 'votes';
    if (!['votes', 'created', 'comments'].includes(sort)) die(1, '--sort 只能是 votes|created|comments');
    const type = flags.type || 'all';
    if (!['all', 'normal', 'paid'].includes(type)) die(1, '--type 只能是 all|normal|paid');
    const picked = L.selectRows(rows, { sort, minVotes: intFlag('min-votes', 0), type, top });

    if (flags.json) {
      const fields = flags.fields ? String(flags.fields).split(',').map((s) => s.trim()).filter(Boolean) : null;
      const out = picked.map((r) => {
        if (fields) {
          const o = {};
          for (const f of fields) o[f] = r[f] ?? null;
          return o;
        }
        const { content, ...rest } = r;
        return { ...rest, excerpt: L.excerpt(content, intFlag('excerpt', 120)), ...(flags.full ? { content } : {}) };
      });
      console.log(JSON.stringify(out, null, 1));
      break;
    }

    const ex = intFlag('excerpt', 60);
    console.log(`问题 ${qid} · ${rows[0]?.question_title || '(无标题)'}`);
    console.log(`样本 ${rows.length} 条 · 合计 ${rows.reduce((s, r) => s + (Number(r.votes) || 0), 0)} 赞 · 显示 ${picked.length} 条（排序 ${sort}${type !== 'all' ? `，类型 ${type}` : ''}${picked.length < rows.length ? '，--all 看全部' : ''}）\n`);
    console.log(L.renderTable(picked, { excerptLen: ex, links: !!flags.links }));
    break;
  }

  case 'stats': {
    const m = build();
    const s = m.stats, c = m.coverage;
    console.log(`问题 ${m.qid}  ${m.title || '(无标题)'}`);
    console.log(`产物 ${m.source.file}  ${m.count} 条  sha256:${m.source.sha256_16}`);
    console.log(`抓取 ${L.fmtCN(m.fetchedAt)} (+08)   输出模式 ${m.outputMode}（阈值 ≤${L.THRESHOLDS.brief} brief / ≤${L.THRESHOLDS.compact} compact）\n`);
    console.log(`样本       ${m.count} / 平台 ${c.totals ?? '未知'}${c.missing ? `（缺 ${c.missing}）` : ''}`);
    console.log(`分页       ${c.pages ? `${c.pages.done} 完成 / ${c.pages.failed} 失败` : '未知'}`);
    console.log(`排序       ${L.sortsLabel(c)}   覆盖检查 ${c.coverCheck}`);
    console.log(`赞数       合计 ${s.votes.sum} · 中位 ${s.votes.median} · P90 ${s.votes.p90} · 最高 ${s.votes.max} · 前 3 占 ${s.votes.top3SharePct}% · 0 赞 ${s.votes.zero} 条`);
    console.log(`正文       合计 ${s.chars.sum} 字 · 中位 ${s.chars.median} · 最长 ${s.chars.max} · 短答 ${s.chars.under80} 条`);
    console.log(`时间       ${L.fmtCN(s.time.first) || '?'} → ${L.fmtCN(s.time.last) || '?'}（跨 ${s.time.spanHours} 小时）`);
    console.log(`按天       ${Object.entries(s.time.perDay).map(([d, n]) => `${d}:${n}`).join('  ')}`);
    console.log(`类型       ${Object.entries(m.distributions.answerType).map(([k, v]) => `${k}:${v}`).join('  ')}`);
    console.log(`作者类型   ${Object.entries(m.distributions.authorType).map(([k, v]) => `${k}:${v}`).join('  ')}`);
    const miss = Object.entries(m.fields).filter(([, v]) => v.missing > 0);
    console.log(`字段缺失   ${miss.length ? miss.map(([k, v]) => `${k}:${v.missing}`).join('  ') : '无'}`);
    if (m.warnings.length) {
      console.log('\n告警');
      m.warnings.forEach((w) => console.log(`  - ${w}`));
    }
    if (flags.json) console.log('\n' + JSON.stringify(m, null, 2));
    break;
  }

  case 'manifest': {
    const m = build();
    if (flags.print) {
      console.log(JSON.stringify(m, null, 2));
      break;
    }
    const out = L.manifestFile(dir, qid);
    fs.writeFileSync(out, JSON.stringify(m, null, 2), 'utf8');
    console.log(`已写入 ${out}`);
    console.log(`  样本 ${m.count}/${m.platform.totals ?? '?'} · 模式 ${m.outputMode} · 告警 ${m.warnings.length} 条`);
    break;
  }

  case 'brief': {
    const m = build();
    if (m.outputMode === 'full') {
      console.error(`[!] ${m.count} 条超出简报阈值（>${L.THRESHOLDS.compact}），简报会严重损失信息。`);
      console.error('    请走全量流水线： summarize-answers.mjs → extract-themes-llm.mjs → render-answers.mjs');
      console.error('    仍要生成可加 --force');
      if (!flags.force) process.exit(3);
    }
    const top = flags.top === undefined ? undefined : Number(flags.top);
    const ex = flags.excerpt === undefined ? undefined : Number(flags.excerpt);
    const md = L.renderBrief(m, rows, { top, excerptLen: ex });
    if (flags.out) {
      const out = path.resolve(String(flags.out));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, md, 'utf8');
      console.log(`已写入 ${out}（${md.length} 字符）`);
    } else {
      console.log(md);
    }
    // 简报与 manifest 必须成对存在：简报里的数字要能回溯
    const mf = L.manifestFile(dir, qid);
    fs.writeFileSync(mf, JSON.stringify(m, null, 2), 'utf8');
    if (flags.out) console.log(`口径已写入 ${mf}`);
    break;
  }

  default:
    die(1, `未知命令: ${cmd}\n\n${USAGE}`);
}
