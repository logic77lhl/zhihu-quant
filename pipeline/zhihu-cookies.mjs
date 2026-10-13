import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const root = process.argv[2];
const src = path.join(root, 'Network', 'Cookies');
const work = path.join(os.tmpdir(), `zhihu-${process.pid}.db`);
fs.copyFileSync(src, work);
const db = new DatabaseSync(work);

const rows = db.prepare(`
  SELECT host_key, name, length(value) as plain_len, length(encrypted_value) as enc_len,
         is_persistent, CAST(expires_utc AS TEXT) as expires_utc, is_secure, is_httponly
  FROM cookies WHERE host_key LIKE '%zhihu%' ORDER BY host_key, name
`).all();

console.log(`zhihu cookie 总数: ${rows.length}`);
const byHost = {};
for (const r of rows) byHost[r.host_key] = (byHost[r.host_key] || 0) + 1;
console.log('按域名:', JSON.stringify(byHost));

const names = rows.map(r => r.name);
console.log('\n=== 关键登录 cookie ===');
for (const n of ['z_c0', 'z_c1', 'd_c0', 'q_c1', '__zse_ck', 'BEC', 'OSLAST', 's_locale']) {
  const r = rows.find(x => x.name === n);
  console.log(`  ${n.padEnd(12)} ${r ? `存在 enc=${r.enc_len}B plain=${r.plain_len}B persistent=${r.is_persistent} secure=${r.is_secure}` : '不存在'}`);
}

console.log('\n=== 全部 cookie 名 ===');
console.log([...new Set(names)].sort().join(', '));

const auth = rows.filter(r => ['z_c0', 'd_c0'].includes(r.name));
console.log('\n=== 明文可读性检查（z_c0 应为加密存储） ===');
for (const r of auth) {
  const row = db.prepare('SELECT value FROM cookies WHERE host_key=? AND name=?').get(r.host_key, r.name);
  console.log(`  ${r.host_key} ${r.name}: value 长度=${row.value.length} (空=已加密)`);
}
db.close();
fs.unlinkSync(work);