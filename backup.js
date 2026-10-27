'use strict';
// 사용법: npm run backup [저장할 파일 경로]   (서버를 끄지 않고 실행할 수 있습니다)
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');
const src = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'attendance.db');
const stamp = new Date().toISOString().slice(0, 10);
const dest = process.argv[2] || path.join(path.dirname(src), 'backup-' + stamp + '.db');
const db = new DatabaseSync(src, { readOnly: true });
backup(db, dest).then(() => { console.log('백업 완료: ' + dest); db.close(); }).catch((e) => { console.error('백업 실패:', e.message); process.exit(1); });
