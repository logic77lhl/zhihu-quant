// 给链接时的**唯一入口**：识别链接 → 报告状态 → 打印下一跳命令。
//
// 为什么需要（实测事故 2026-10-16）：
//   新会话里用户直接贴了一个知乎问题链接。agent 依次试了
//   `panerelay zhihu question`（桥接断）→ webfetch → 开 harness 浏览器（未登录 403）
//   → 用户手动登录后才抓到数据，中途还要求用户打断它"该加载本地 skill"。
//   根因：skill 里没有「你手上是一个 URL 时该干什么」的第一跳，
//   于是每个新会话都要从零摸索一遍，而桥接常态是断的，第一跳必然撞墙。
//
// 用法:
//   node link.mjs <URL|ID>            # 报告 + 下一跳命令
//   node link.mjs <URL|ID> --json     # 机器可读
//
// 退出码:
//   0  READY           桥接可用，按打印的命令继续
//   3  ARTIFACT_EXISTS 问题产物已存在 —— 复用，别重抓（下一跳已换成摘要/渲染）
//   4  BRIDGE_DOWN     桥接不可用 —— 两条路：ensure-bridge.mjs --fix 或 harness 浏览器通道
//   1  参数/链接无法识别
//
// 约定：**不要 webfetch 知乎页面**。知乎对未签名/未登录的抓取一律给登录墙或 403，
// 拿到的内容既不全也无法判断真伪；本脚本打出来的路才是能走通的路。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assess, probeBridge } from './precheck.mjs';
import { bridgeAdvice } from './bridge-advice.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const S = (f) => path.join(HERE, f);

// ---------------- 链接识别 ----------------
// 认得的形状（全部来自实测过的真实 URL）：
//   /question/<qid>                    问题
//   /question/<qid>/answer/<aid>       问题下的某条回答
//   /answer/<aid>                      回答
//   zhuanlan.zhihu.com/p/<pid>         专栏文章（含自己的草稿/文章）
//   /people/<token>                    用户
//   /collection/<cid>                  收藏夹
//   /search?q=...                      搜索
//   /hot                               热榜
// 不认得的形状要**明确说不认得**，不要硬猜一个 ID 出来。
export function parseTarget(input) {
  const raw = String(input || '').trim();
  if (!raw) return { kind: 'empty' };

  if (/^\d+$/.test(raw)) {
    // 纯数字：19 位是回答 ID，其余按问题 ID 处理（这是约定，不是事实推断，所以要打出来）
    if (raw.length >= 15) return { kind: 'answer', answerId: raw, note: '按位数判断为回答 ID' };
    return { kind: 'question', questionId: raw, note: '纯数字按问题 ID 处理（回答 ID 更长）' };
  }

  const typed = raw.match(/^answer:(\d+):(\d+)$/);
  if (typed) return { kind: 'answer', questionId: typed[1], answerId: typed[2] };

  let url;
  try {
    url = new URL(/^https?:/.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { kind: 'unknown', raw };
  }
  const host = url.hostname.replace(/^www\./, '');
  const p = url.pathname;

  if (host === 'zhuanlan.zhihu.com') {
    const m = p.match(/^\/p\/(\d+)/);
    if (m) return { kind: 'article', articleId: m[1], url: url.href };
    const m2 = p.match(/^\/[a-z0-9-]+\/(\d+)/); // 老的专栏地址形态
    if (m2) return { kind: 'article', articleId: m2[1], url: url.href, note: '按老形态专栏地址解析' };
    return { kind: 'unknown', raw };
  }
  if (host !== 'zhihu.com') return { kind: 'unknown', raw };

  const qa = p.match(/^\/question\/(\d+)\/answer\/(\d+)/);
  if (qa) return { kind: 'answer', questionId: qa[1], answerId: qa[2] };
  const q = p.match(/^\/question\/(\d+)/);
  if (q) return { kind: 'question', questionId: q[1] };
  const a = p.match(/^\/answer\/(\d+)/);
  if (a) return { kind: 'answer', answerId: a[1] };
  const u = p.match(/^\/people\/([^/]+)/);
  if (u) return { kind: 'user', token: decodeURIComponent(u[1]) };
  const c = p.match(/^\/collection\/(\d+)/);
  if (c) return { kind: 'collection', collectionId: c[1] };
  const pin = p.match(/^\/pin\/(\d+)/);
  if (pin) return { kind: 'pin', pinId: pin[1] };
  const t = p.match(/^\/topic\/(\d+)/);
  if (t) return { kind: 'topic', topicId: t[1] };
  if (p === '/search' || p.startsWith('/search')) {
    return { kind: 'search', query: url.searchParams.get('q') || '' };
  }
  if (p === '/hot' || p === '/hot/') return { kind: 'hot' };
  return { kind: 'unknown', raw };
}

// ---------------- 路由 ----------------
// 每一类返回 { lines: [], exit: n }
function route(target, bridge, artifacts) {
  const L = [];
  const P = (s) => L.push(s);
  const s = (f) => `"${S(f)}"`;

  if (target.kind === 'question') {
    const qid = target.questionId;
    if (artifacts?.hasAnswersFull) {
      P(`产物已存在：${artifacts.file}`);
      P('');
      P('下一跳（照抄，别重抓）：');
      P(`  node ${s('summarize-answers.mjs')} q${qid}-answers-full.json          # ② 摘要+综述`);
      P(`  node ${s('extract-themes-llm.mjs')} q${qid}-answers-full.json         # ③ 观点聚类（故事题加 --profile stories）`);
      P(`  node ${s('render-answers.mjs')} q${qid}-answers-full.json             # ④ 出页面`);
      return { lines: L, exit: 3 };
    }
    P(`问题 ID：${qid}`);
    P('');
    P('下一跳（照抄一条）：');
    P(`  node ${s('fetch-answers-api.mjs')} ${qid}      # 全量全文+赞数（推荐，>1000 条也拿得全）`);
    P(`  node ${s('precheck.mjs')} ${qid}               # 或先跑开工闸门（会告诉你产物是否已在）`);
    P('');
    P('只要前 1000 条、不进流水线时：');
    P(`  panerelay zhihu question ${qid} --limit 1000 --json`);
    return { lines: L, exit: 0 };
  }

  if (target.kind === 'answer') {
    const slug = target.questionId ? `answer:${target.questionId}:${target.answerId}` : target.answerId;
    P(`回答 ID：${target.answerId}${target.questionId ? `（问题 ${target.questionId}）` : ''}`);
    P('');
    P('下一跳（照抄）：');
    P(`  panerelay zhihu answer-detail ${slug} --json     # 含赞数/评论数/发布时间/全文`);
    if (target.questionId) {
      P(`  node ${s('fetch-answers-api.mjs')} ${target.questionId}   # 要同题全量对比时`);
    }
    return { lines: L, exit: 0 };
  }

  if (target.kind === 'article') {
    P(`专栏文章：${target.url || `p/${target.articleId}`}`);
    P('');
    P('下一跳（照抄）：');
    P(`  panerelay zhihu download --url "${target.url}" --json   # 导出 Markdown（含图片链接）`);
    return { lines: L, exit: 0 };
  }

  if (target.kind === 'user') {
    P(`用户：${target.token}`);
    P('');
    P('下一跳（按需要选）：');
    P(`  panerelay zhihu user ${target.token} --json              # 主页数据`);
    P(`  panerelay zhihu user-answers ${target.token} --json      # 他的回答`);
    P(`  panerelay zhihu user-articles ${target.token} --json     # 他的文章`);
    return { lines: L, exit: 0 };
  }

  if (target.kind === 'collection') {
    P(`收藏夹：${target.collectionId}`);
    P('');
    P('下一跳（照抄）：');
    P(`  panerelay zhihu collection ${target.collectionId} --limit 50 --json`);
    return { lines: L, exit: 0 };
  }

  if (target.kind === 'search') {
    P(`搜索：${target.query || '(无关键词)'}`);
    P('');
    P('下一跳（照抄）：');
    P(`  panerelay zhihu search "${target.query}" --type all --limit 20 --json`);
    return { lines: L, exit: 0 };
  }

  if (target.kind === 'hot') {
    P('热榜');
    P('');
    P('下一跳（照抄）：');
    P('  panerelay zhihu hot --limit 20 --json');
    return { lines: L, exit: 0 };
  }

  if (target.kind === 'pin' || target.kind === 'topic') {
    P(`这个形状（${target.kind}）没有专用命令。`);
    P('');
    P('下一跳：用搜索定位内容，或 panerelay fetch 直取页面：');
    P(`  panerelay zhihu search "<标题关键词>" --limit 10 --json`);
    return { lines: L, exit: 0 };
  }

  P('认不出这个链接的形状 —— 不要硬猜 ID。');
  P('');
  P('支持的形状：/question/<id>、/question/<id>/answer/<id>、/answer/<id>、');
  P('zhuanlan.zhihu.com/p/<id>、/people/<token>、/collection/<id>、/search?q=、/hot');
  P('特殊情况贴标题来，先走搜索：panerelay zhihu search "<标题>" --limit 10 --json');
  return { lines: L, exit: 1 };
}

// ---------------- CLI ----------------
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const input = argv.find((a) => !a.startsWith('--'));

  if (!input) {
    console.error('用法: node link.mjs <URL|ID> [--json]');
    console.error('  例: node link.mjs https://www.zhihu.com/question/665321619');
    console.error('      node link.mjs https://www.zhihu.com/question/665321619/answer/2058946409039241337');
    console.error('      node link.mjs https://zhuanlan.zhihu.com/p/123456789');
    process.exit(1);
  }

  const target = parseTarget(input);

  // 桥接探测：只在认得形状时才探（认不出就别花请求）
  let bridge = null;
  if (target.kind !== 'unknown' && target.kind !== 'empty') {
    bridge = probeBridge();
  }

  // 产物检查：只有问题类才查
  let artifacts = null;
  if (target.kind === 'question') {
    const a = assess(target.questionId, { probe: false });
    const full = a.inResolved.find((f) => /-answers-full\.json$/.test(f.name));
    artifacts = full
      ? { hasAnswersFull: true, file: full.path, kb: full.kb, at: full.at }
      : { hasAnswersFull: false };
  }

  const r = route(target, bridge, artifacts);

  if (asJson) {
    console.log(JSON.stringify({ target, bridge, artifacts, next: r.lines, exit: r.exit }, null, 2));
    process.exit(r.exit);
  }

  console.log(`链接 → ${target.kind}${target.note ? `（${target.note}）` : ''}`);
  console.log('');
  if (bridge) {
    console.log(bridge.ok
      ? `桥接 OK   ${bridge.account} (${bridge.token})  cookie=${bridge.cookies}`
      : `桥接 FAIL ${bridge.detail}`);
    console.log('');
  }

  if (bridge && !bridge.ok) {
    console.log('两条路（选一条，别 webfetch 知乎）：');
    console.log('');
    console.log('  路 1：修复桥接 —— 会重启 Edge，agent 执行前必须先问用户（命令见下）。');
    console.log('  路 2：harness 浏览器通道（不依赖 Edge；需先在 Review 面板里登录过知乎）');
    console.log('        browser.tabs.open 打开目标页 → browser.evaluate 在页面上下文 fetch 接口；');
    console.log('        完整步骤与坑见 references/usage.md「harness 浏览器通道」一节。');
    console.log('');
    bridgeAdvice().forEach((l) => console.log(l));
    process.exit(4);
  }

  r.lines.forEach((l) => console.log(l));
  process.exit(r.exit);
}
