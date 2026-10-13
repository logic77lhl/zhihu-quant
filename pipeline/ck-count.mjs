import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const src = process.argv[2];
const work = path.join(process.env.TEMP, `chk-${process.pid}.db`);
fs.copyFileSync(src, work);
const db = new DatabaseSync(work);
console.log('cookies 总行数:', db.prepare('SELECT COUNT(*) c FROM cookies').get().c);
const byHost = db.prepare('SELECT host_key, COUNT(*) c FROM cookies GROUP BY host_key ORDER BY c DESC LIMIT 15').all();
console.log('按域名:', byHost.map(r => `${r.host_key}=${r.c}`).join(', '));
const zh = db.prepare("SELECT name FROM cookies WHERE host_key LIKE '%zhihu%'").all();
console.log('zhihu cookie:', zh.map(r => r.name).join(', ') || '(无)');
console.log('freelist 页数:', db.prepare('PRAGMA freelist_count').get().freelist_count);
console.log('page_count:', db.prepare('PRAGMA page_count').get().page_count);
db.close(); fs.unlinkSync(work);