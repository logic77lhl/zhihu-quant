// 发布到 GitHub —— 把**整个 skill 目录**同步到仓库，提交，然后走 REST API 推送
//
// 仓库布局（自包含，只有 skill 一个目录）：
//   README.md  SETUP.md  .gitignore
//   skills/zhihu-web/{SKILL.md, references/, scripts/}
//
// 为什么不用 git push：
//   本机 git 连不上 github.com:443（21s 超时），但 api.github.com 可达，
//   所以改成 blob → tree → commit → PATCH ref，全程走 REST API。
//   另：空仓库不允许经 git database API 建 blob（HTTP 409），
//   首次发布要先用 Contents API 落一个初始 commit。
//
// 用法:
//   node publish.mjs [--repo <暂存目录>] [--message "提交说明"] [--dry]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);

// ---- 参数守卫 ----
// 这个脚本会**写外部状态**（向 GitHub 推送）。实测踩过：跑 `--help` 想看用法，
// 结果脚本不认识这个参数、照常执行，直接开始推送。
// 所以：任何未知参数一律拒绝，而不是忽略。
const KNOWN = new Set(['--dry', '--repo', '--message', '--help', '-h']);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`用法: node publish.mjs [--dry] [--repo <暂存目录>] [--message "提交说明"]

  --dry      只做本地同步与密钥扫描，不推送（推荐先跑这个）
  --repo     暂存目录，默认系统临时目录
  --message  提交说明

⚠️ 不带 --dry 会真实推送到 GitHub。`);
  process.exit(0);
}
const unknown = argv.filter((a) => a.startsWith('-') && !KNOWN.has(a));
if (unknown.length) {
  console.error(`[!] 未知参数: ${unknown.join(', ')}`);
  console.error(`    本脚本会写外部状态（推送 GitHub），因此拒绝执行。`);
  console.error(`    用 --help 查看支持的参数；只想预览用 --dry。`);
  process.exit(1);
}

const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DRY = argv.includes('--dry');

// ⚠️ 必须用 fileURLToPath：import.meta.url 的 pathname 带 URL 编码（Default%20Project），
// 直接当路径用会 ENOENT。这是本仓库踩过的坑之一。
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.dirname(SCRIPTS_DIR);            // skills/zhihu-web
const TEMPLATE = path.join(SCRIPTS_DIR, 'repo-template');

const REPO = opt('--repo', path.join(os.tmpdir(), 'zhihu-web-skill'));
const OWNER = 'logic77lhl';
const NAME = 'zhihu-web-skill';
const API = `repos/${OWNER}/${NAME}`;
const TMP = path.join(REPO, '..', '.publish-tmp');

function gh(args, inputFile) {
  const a = ['/c', 'gh', 'api', ...args];
  if (inputFile) a.push('--input', inputFile);
  const r = spawnSync('cmd.exe', a, { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 120000 });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || '').trim().slice(0, 300));
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}
const safe = (fn) => { try { return fn(); } catch (e) { return { err: e.message }; } };

// ---------- 1. 同步 ----------
console.log('skill 源: ' + SKILL_DIR);
console.log('暂存仓库: ' + REPO);
fs.mkdirSync(path.join(REPO, 'skills'), { recursive: true });
fs.rmSync(path.join(REPO, 'skills', 'zhihu-web'), { recursive: true, force: true });
fs.cpSync(SKILL_DIR, path.join(REPO, 'skills', 'zhihu-web'), { recursive: true, force: true });

// 仓库根的 SETUP.md / README.md / .gitignore 取自 skill 内的模板，保证自包含
fs.copyFileSync(path.join(SKILL_DIR, 'references', 'setup.md'), path.join(REPO, 'SETUP.md'));
for (const f of ['README.md', '.gitignore']) {
  const src = path.join(TEMPLATE, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(REPO, f));
  else console.error('  [!] 缺模板 ' + f);
}
// 旧的 tools/ 目录不再发布
fs.rmSync(path.join(REPO, 'tools'), { recursive: true, force: true });

const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === '.git' || e.name === '.publish-tmp') continue; const q = path.join(d, e.name); e.isDirectory() ? walk(q, out) : out.push(q); } return out; };
const files = walk(REPO).map((p) => ({ rel: path.relative(REPO, p).replace(/\\/g, '/'), abs: p }));
console.log('  待发布 ' + files.length + ' 个文件');

// ---------- 2. 密钥扫描（比对明文，不是 base64） ----------
const SECRETS = [process.env.WB2API_KEY || ''];
let hits = 0;
for (const f of files) {
  const t = fs.readFileSync(f.abs, 'utf8');
  for (const s of SECRETS) if (s && t.includes(s)) { console.log('  [机密] ' + f.rel); hits++; }
  if (/gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}/.test(t)) { console.log('  [疑似令牌] ' + f.rel); hits++; }
  const abs = f.abs.replace(/\\/g, '/');
  if (/C:\/Users\/[^/]+\//i.test(t) && !/SETUP\.md|setup\.md/.test(f.rel)) {
    // 允许 setup.md 里出现路径示例；其他文件出现本机绝对路径要提醒
    const m = t.match(/C:\/Users\/[^/\s"'`)]+/gi);
    if (m) { console.log('  [本机路径] ' + f.rel + ' -> ' + [...new Set(m)].slice(0, 2).join(', ')); }
  }
}
if (hits) { console.error('\n发现 ' + hits + ' 处疑似密钥，已中止'); process.exit(1); }
console.log('  密钥扫描通过');

if (DRY) { console.log('\n--dry：到此为止'); process.exit(0); }

// ---------- 3. 本地提交（留历史，便于回滚） ----------
const G = (a) => spawnSync('cmd.exe', ['/c', 'git', '-C', REPO.replace(/\//g, '\\'), ...a], { encoding: 'utf8', maxBuffer: 1 << 26 });
G(['add', '-A']);
const msg = opt('--message', 'sync: ' + new Date().toISOString().slice(0, 16).replace('T', ' '));
const c = G(['commit', '-m', msg]);
if (c.status !== 0 && !/nothing to commit/.test((c.stdout || '') + (c.stderr || ''))) {
  console.log('  本地提交跳过: ' + (c.stderr || c.stdout || '').trim().split('\n')[0]);
} else console.log('  已提交: ' + msg);

// ---------- 4. REST API 推送 ----------
fs.mkdirSync(TMP, { recursive: true });
const head = safe(() => gh([API + '/git/ref/heads/main']));
if (head.err) {
  console.log('  仓库为空，先用 Contents API 建初始 commit');
  const seed = path.join(TMP, 'seed.json');
  fs.writeFileSync(seed, JSON.stringify({ message: 'chore: 初始化仓库', content: fs.readFileSync(path.join(REPO, 'README.md')).toString('base64'), branch: 'main' }), 'utf8');
  const s = safe(() => gh(['--method', 'PUT', API + '/contents/README.md'], seed));
  if (s.err) { console.error('  初始化失败: ' + s.err); process.exit(1); }
}

const entries = [];
let i = 0;
for (const f of files) {
  i++;
  const req = path.join(TMP, 'blob.json');
  fs.writeFileSync(req, JSON.stringify({ content: fs.readFileSync(f.abs).toString('base64'), encoding: 'base64' }), 'utf8');
  const res = safe(() => gh(['--method', 'POST', API + '/git/blobs'], req));
  if (res.err) { console.error('  blob 失败 ' + f.rel + ': ' + res.err); process.exit(1); }
  entries.push({ path: f.rel, mode: '100644', type: 'blob', sha: res.sha });
  if (i % 15 === 0 || i === files.length) process.stdout.write('  blob ' + i + '/' + files.length + '\n');
}

const treeReq = path.join(TMP, 'tree.json');
fs.writeFileSync(treeReq, JSON.stringify({ tree: entries }), 'utf8');
const tree = safe(() => gh(['--method', 'POST', API + '/git/trees'], treeReq));
if (tree.err) { console.error('  tree 失败: ' + tree.err); process.exit(1); }

const refNow = safe(() => gh([API + '/git/ref/heads/main']));
const parents = refNow.err ? [] : [refNow.object.sha];
const cReq = path.join(TMP, 'commit.json');
fs.writeFileSync(cReq, JSON.stringify({ message: msg, tree: tree.sha, parents }), 'utf8');
const commit = safe(() => gh(['--method', 'POST', API + '/git/commits'], cReq));
if (commit.err) { console.error('  commit 失败: ' + commit.err); process.exit(1); }

const rReq = path.join(TMP, 'ref.json');
fs.writeFileSync(rReq, JSON.stringify({ sha: commit.sha, force: true }), 'utf8');
const ref = safe(() => gh(['--method', 'PATCH', API + '/git/refs/heads/main'], rReq));
if (ref.err) { console.error('  ref 更新失败: ' + ref.err); process.exit(1); }

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n推送完成: https://github.com/' + OWNER + '/' + NAME);
console.log('  commit ' + commit.sha.slice(0, 8) + '  ' + files.length + ' 个文件');