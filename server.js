'use strict';
/**
 * 팀 출퇴근 기록 서버
 * - Node.js 22.13+ 내장 모듈만 사용 (외부 패키지 없음), 데이터베이스는 SQLite 파일 1개
 * - 모든 출근·퇴근 시각은 이 서버의 시계로 기록합니다 (브라우저 시계는 사용하지 않음)
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'attendance.db');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const TEAM_SIZE = Number(process.env.TEAM_SIZE) || 9;
const MAX_USERS = Number(process.env.MAX_USERS) || 30;
const ALLOWED_IPS = (process.env.ALLOWED_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);
const SESSION_MS = 14 * 24 * 3600e3;
const OPEN_LIMIT_MS = 20 * 3600e3; // 출근 후 20시간이 지나면 '퇴근 누락'으로 봅니다
const TZ = 'Asia/Seoul';

if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  pw         TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  work_start TEXT,
  work_end   TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS attendance (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  work_date  TEXT NOT NULL,
  check_in   INTEGER NOT NULL,
  check_out  INTEGER,
  in_ip      TEXT,
  out_ip     TEXT,
  UNIQUE (user_id, work_date)
);
CREATE INDEX IF NOT EXISTS attendance_date ON attendance (work_date);
CREATE TABLE IF NOT EXISTS adjustments (
  id            INTEGER PRIMARY KEY,
  attendance_id INTEGER NOT NULL REFERENCES attendance(id),
  by_user       INTEGER NOT NULL REFERENCES users(id),
  reason        TEXT NOT NULL,
  old_in        INTEGER,
  old_out       INTEGER,
  new_in        INTEGER,
  new_out       INTEGER,
  at            INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  work_date  TEXT NOT NULL,
  req_in     TEXT,
  req_out    TEXT,
  reason     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at INTEGER NOT NULL,
  decided_by INTEGER REFERENCES users(id),
  decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

/* ---------- 설정 ---------- */
const getSetting = (k) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? r.value : null; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
if (!getSetting('work_start')) setSetting('work_start', '09:00');
if (!getSetting('work_end')) setSetting('work_end', '18:00');
let SIGNUP_CODE = process.env.SIGNUP_CODE || getSetting('signup_code');
if (!SIGNUP_CODE) {
  SIGNUP_CODE = crypto.randomBytes(5).toString('hex');
  setSetting('signup_code', SIGNUP_CODE);
  console.log('[최초 실행] 가입 코드를 만들었습니다: ' + SIGNUP_CODE + ' (관리자 화면에서도 다시 볼 수 있습니다)');
}

/* ---------- 시간 (한국 시간) ---------- */
const kstFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const kstDate = (ms) => kstFmt.format(ms);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const isHm = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const toMs = (date, hm) => Date.parse(date + 'T' + hm + ':00+09:00');
const isMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

/* ---------- 비밀번호 · 세션 ---------- */
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));
async function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return 's1$' + salt.toString('base64') + '$' + (await scrypt(pw, salt)).toString('base64');
}
const DUMMY_HASH = 's1$' + Buffer.alloc(16).toString('base64') + '$' + Buffer.alloc(64).toString('base64');
async function checkPw(pw, stored) {
  const [v, s, h] = String(stored).split('$');
  if (v !== 's1') return false;
  const k = await scrypt(pw, Buffer.from(s, 'base64'));
  const b = Buffer.from(h, 'base64');
  return b.length === k.length && crypto.timingSafeEqual(b, k);
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const safeEq = (a, b) => crypto.timingSafeEqual(Buffer.from(sha(String(a)), 'hex'), Buffer.from(sha(String(b)), 'hex'));

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(sha(token), userId, now + SESSION_MS, now);
  return token;
}
const cookieHeader = (token, maxAgeSec) =>
  'sid=' + token + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + maxAgeSec + (COOKIE_SECURE ? '; Secure' : '');
function readCookie(req, name) {
  const m = String(req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return m ? m.slice(name.length + 1) : null;
}
function sessionUser(req) {
  const t = readCookie(req, 'sid');
  if (!t) return null;
  return db.prepare(`SELECT u.id, u.email, u.name, u.role, u.work_start, u.work_end FROM sessions s JOIN users u ON u.id = s.user_id
                     WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`).get(sha(t), Date.now()) || null;
}

/* ---------- 접속 IP 제한 ---------- */
function clientIp(req) {
  let ip = req.socket.remoteAddress || '';
  if (TRUST_PROXY) { const x = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (x) ip = x; }
  return ip.replace(/^::ffff:/, '');
}
const ipToInt = (ip) => { const p = ip.split('.'); if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || +x > 255)) return null; return ((+p[0] << 24) >>> 0) + (+p[1] << 16) + (+p[2] << 8) + +p[3]; };
function ipAllowed(ip) {
  if (!ALLOWED_IPS.length) return true;
  return ALLOWED_IPS.some((rule) => {
    if (!rule.includes('/')) return rule === ip;
    const [base, bitsS] = rule.split('/'), bits = Number(bitsS), a = ipToInt(ip), b = ipToInt(base);
    if (a === null || b === null || !(bits >= 0 && bits <= 32)) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((a & mask) >>> 0) === ((b & mask) >>> 0);
  });
}

/* ---------- 로그인 시도 제한 ---------- */
const fails = new Map();
const isLimited = (k) => { const e = fails.get(k); return !!e && e.n >= 8 && e.until > Date.now(); };
const addFail = (k) => { const e = fails.get(k) || { n: 0, until: 0 }; if (e.until < Date.now()) e.n = 0; e.n++; e.until = Date.now() + 15 * 60e3; fails.set(k, e); };
setInterval(() => { const n = Date.now(); for (const [k, e] of fails) if (e.until < n) fails.delete(k); }, 600e3).unref();

/* ---------- HTTP 도우미 ---------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
function send(res, status, body, extra) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign({ 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, SEC_HEADERS, extra || {}));
  res.end(data);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 20000) { reject(new HttpError(413, '요청이 너무 큽니다.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); } catch { reject(bad('요청 형식이 올바르지 않습니다.')); }
    });
    req.on('error', reject);
  });
}
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/* ---------- 업무 로직 ---------- */
function userView(u) { return { id: u.id, email: u.email, name: u.name, role: u.role, workStart: u.work_start, workEnd: u.work_end }; }
const defaults = () => ({ start: getSetting('work_start'), end: getSetting('work_end') });

function openRecord(userId, now) {
  return db.prepare('SELECT id, work_date AS date, check_in AS "in" FROM attendance WHERE user_id = ? AND check_out IS NULL AND check_in <= ? AND check_in > ? ORDER BY check_in DESC LIMIT 1')
    .get(userId, now, now - OPEN_LIMIT_MS) || null;
}
let txDepth = 0;
function tx(fn) {
  if (txDepth > 0) return fn(); // 이미 트랜잭션 안이면 그대로 실행
  db.exec('BEGIN IMMEDIATE');
  txDepth++;
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { txDepth--; }
}
function applyAdjustment(userId, date, inHm, outHm, reason, byUser) {
  if (!isDate(date)) throw bad('날짜 형식이 올바르지 않습니다.');
  if (inHm && !isHm(inHm)) throw bad('출근 시각 형식이 올바르지 않습니다.');
  if (outHm && !isHm(outHm)) throw bad('퇴근 시각 형식이 올바르지 않습니다.');
  if (!inHm && !outHm) throw bad('출근 또는 퇴근 시각을 입력하세요.');
  if (!reason) throw bad('사유를 입력하세요.');
  return tx(() => {
    const u = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!u) throw new HttpError(404, '팀원을 찾을 수 없습니다.');
    const cur = db.prepare('SELECT * FROM attendance WHERE user_id = ? AND work_date = ?').get(userId, date);
    const nin = inHm ? toMs(date, inHm) : cur ? cur.check_in : null;
    const nout = outHm ? toMs(date, outHm) : cur ? cur.check_out : null;
    if (!nin) throw bad('새 기록에는 출근 시각이 필요합니다.');
    if (nout && nout < nin) throw bad('퇴근 시각이 출근 시각보다 빠릅니다.');
    if (nin > Date.now() || (nout && nout > Date.now())) throw bad('미래 시각은 입력할 수 없습니다.');
    let attId;
    if (cur) { attId = cur.id; db.prepare('UPDATE attendance SET check_in = ?, check_out = ? WHERE id = ?').run(nin, nout, cur.id); }
    else attId = Number(db.prepare('INSERT INTO attendance (user_id, work_date, check_in, check_out) VALUES (?, ?, ?, ?)').run(userId, date, nin, nout).lastInsertRowid);
    db.prepare('INSERT INTO adjustments (attendance_id, by_user, reason, old_in, old_out, new_in, new_out, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(attId, byUser, reason, cur ? cur.check_in : null, cur ? cur.check_out : null, nin, nout, Date.now());
    return attId;
  });
}

/* ---------- 라우트 ---------- */
const routes = [];
const route = (method, pattern, auth, handler) => routes.push({ method, re: new RegExp('^' + pattern + '$'), auth, handler });

route('GET', '/healthz', null, async () => ({ ok: true }));
route('GET', '/api/config', null, async () => ({ teamSize: TEAM_SIZE }));

route('POST', '/api/signup', null, async ({ req, res, body }) => {
  const ip = clientIp(req), email = str(body.email, 200).toLowerCase(), name = str(body.name, 20), pw = typeof body.password === 'string' ? body.password : '';
  if (isLimited('ip:' + ip)) throw new HttpError(429, '시도 횟수가 많습니다. 15분 뒤에 다시 시도하세요.');
  if (!safeEq(str(body.code, 100), SIGNUP_CODE)) { addFail('ip:' + ip); throw new HttpError(403, '가입 코드가 올바르지 않습니다.'); }
  if (!/^[^\s@]{1,64}@[^\s@]{1,120}\.[^\s@]{2,}$/.test(email)) throw bad('이메일 주소 형식이 올바르지 않습니다.');
  if (!name) throw bad('이름을 입력하세요.');
  if (pw.length < 10 || pw.length > 128) throw bad('비밀번호는 10자 이상 128자 이하로 입력하세요.');
  if (pw.toLowerCase() === email) throw bad('비밀번호를 이메일과 다르게 정하세요.');
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count >= MAX_USERS) throw new HttpError(403, '가입 가능한 인원을 초과했습니다. 관리자에게 문의하세요.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, '이미 가입된 이메일입니다. 로그인하세요.');
  const hash = await hashPw(pw);
  const id = tx(() => {
    const first = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
    return Number(db.prepare('INSERT INTO users (email, name, pw, role, created_at) VALUES (?, ?, ?, ?, ?)').run(email, name, hash, first ? 'admin' : 'member', Date.now()).lastInsertRowid);
  });
  const token = createSession(id);
  return { status: 201, headers: { 'Set-Cookie': cookieHeader(token, SESSION_MS / 1000) }, body: { ok: true } };
});

route('POST', '/api/login', null, async ({ req, body }) => {
  const ip = clientIp(req), email = str(body.email, 200).toLowerCase(), pw = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
  if (isLimited('ip:' + ip) || isLimited('em:' + email)) throw new HttpError(429, '시도 횟수가 많습니다. 15분 뒤에 다시 시도하세요.');
  const u = db.prepare('SELECT id, pw, active FROM users WHERE email = ?').get(email);
  const ok = await checkPw(pw, u ? u.pw : DUMMY_HASH);
  if (!u || !ok || !u.active) { addFail('ip:' + ip); addFail('em:' + email); throw new HttpError(401, '이메일 또는 비밀번호가 올바르지 않습니다.'); }
  fails.delete('em:' + email);
  const token = createSession(u.id);
  return { headers: { 'Set-Cookie': cookieHeader(token, SESSION_MS / 1000) }, body: { ok: true } };
});

route('POST', '/api/logout', null, async ({ req }) => {
  const t = readCookie(req, 'sid');
  if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(t));
  return { headers: { 'Set-Cookie': cookieHeader('', 0) }, body: { ok: true } };
});

route('GET', '/api/me', 'user', async ({ user, req }) => {
  const now = Date.now();
  return { user: userView(user), serverNow: now, today: kstDate(now), open: openRecord(user.id, now), defaults: defaults(), teamSize: TEAM_SIZE, ipAllowed: ipAllowed(clientIp(req)) };
});

route('PUT', '/api/me', 'user', async ({ user, body }) => {
  const name = str(body.name, 20), a = body.workStart, b = body.workEnd;
  if (!name) throw bad('이름을 입력하세요.');
  if (!isHm(a) || !isHm(b)) throw bad('기준 출근·퇴근 시각 형식이 올바르지 않습니다.');
  db.prepare('UPDATE users SET name = ?, work_start = ?, work_end = ? WHERE id = ?').run(name, a, b, user.id);
  return { ok: true };
});

route('POST', '/api/me/password', 'user', async ({ user, body, req }) => {
  const cur = typeof body.current === 'string' ? body.current : '', next = typeof body.next === 'string' ? body.next : '';
  const k = 'pw:' + user.id;
  if (isLimited(k)) throw new HttpError(429, '시도 횟수가 많습니다. 15분 뒤에 다시 시도하세요.');
  const row = db.prepare('SELECT pw FROM users WHERE id = ?').get(user.id);
  if (!(await checkPw(cur, row.pw))) { addFail(k); throw new HttpError(403, '현재 비밀번호가 올바르지 않습니다.'); }
  if (next.length < 10 || next.length > 128) throw bad('새 비밀번호는 10자 이상 128자 이하로 입력하세요.');
  const hash = await hashPw(next);
  const keep = sha(readCookie(req, 'sid') || '');
  tx(() => { db.prepare('UPDATE users SET pw = ? WHERE id = ?').run(hash, user.id); db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(user.id, keep); });
  return { ok: true };
});

route('POST', '/api/punch', 'user', async ({ user, body, req }) => {
  const ip = clientIp(req);
  if (!ipAllowed(ip)) throw new HttpError(403, '허용된 네트워크(사내망)에서만 출퇴근을 기록할 수 있습니다.');
  const kind = body.kind, now = Date.now(), today = kstDate(now);
  if (kind !== 'in' && kind !== 'out') throw bad('요청 형식이 올바르지 않습니다.');
  return tx(() => {
    const open = openRecord(user.id, now);
    if (kind === 'in') {
      if (open) throw new HttpError(409, '아직 퇴근하지 않은 기록이 있습니다.');
      if (db.prepare('SELECT 1 FROM attendance WHERE user_id = ? AND work_date = ?').get(user.id, today)) throw new HttpError(409, '오늘은 이미 출근을 기록했습니다.');
      db.prepare('INSERT INTO attendance (user_id, work_date, check_in, in_ip) VALUES (?, ?, ?, ?)').run(user.id, today, now, ip);
      return { ok: true, kind, at: now, date: today };
    }
    if (!open) throw new HttpError(409, '퇴근 처리할 출근 기록이 없습니다.');
    db.prepare('UPDATE attendance SET check_out = ?, out_ip = ? WHERE id = ?').run(now, ip, open.id);
    return { ok: true, kind, at: now, date: open.date };
  });
});

route('GET', '/api/records', 'user', async ({ user, url }) => {
  const now = Date.now(), month = url.searchParams.get('month') || kstDate(now).slice(0, 7);
  if (!isMonth(month)) throw bad('월 형식이 올바르지 않습니다.');
  const from = month + '-01', to = month + '-31';
  const users = db.prepare('SELECT id, name, role, work_start AS workStart, work_end AS workEnd, active FROM users ORDER BY name').all();
  const days = db.prepare('SELECT user_id AS uid, work_date AS date, check_in AS "in", check_out AS out, id FROM attendance WHERE work_date BETWEEN ? AND ? ORDER BY work_date').all(from, to);
  const adj = db.prepare(`SELECT a.user_id AS uid, a.work_date AS date, j.reason, j.at, j.by_user AS byUser, j.old_in AS oldIn, j.old_out AS oldOut, j.new_in AS newIn, j.new_out AS newOut
                          FROM adjustments j JOIN attendance a ON a.id = j.attendance_id WHERE a.work_date BETWEEN ? AND ? ORDER BY j.id`).all(from, to);
  const d1 = kstDate(now), d0 = kstDate(now - 86400e3);
  const recent = db.prepare('SELECT user_id AS uid, work_date AS date, check_in AS "in", check_out AS out FROM attendance WHERE work_date IN (?, ?)').all(d1, d0);
  const cols = 'r.id, r.user_id AS uid, r.work_date AS date, r.req_in AS "in", r.req_out AS out, r.reason, r.status, r.created_at AS at';
  const requests = user.role === 'admin'
    ? db.prepare(`SELECT ${cols} FROM requests r WHERE r.status = 'pending' OR r.user_id = ? ORDER BY r.id DESC LIMIT 200`).all(user.id)
    : db.prepare(`SELECT ${cols} FROM requests r WHERE r.user_id = ? ORDER BY r.id DESC LIMIT 100`).all(user.id);
  return { month, serverNow: now, users, days, adj, recent, requests };
});

route('POST', '/api/requests', 'user', async ({ user, body }) => {
  const date = body.date, tin = body.in || null, tout = body.out || null, reason = str(body.reason, 200);
  if (!isDate(date)) throw bad('날짜 형식이 올바르지 않습니다.');
  if (date > kstDate(Date.now())) throw bad('미래 날짜는 요청할 수 없습니다.');
  if ((tin && !isHm(tin)) || (tout && !isHm(tout))) throw bad('시각 형식이 올바르지 않습니다.');
  if (!tin && !tout) throw bad('출근 또는 퇴근 시각을 입력하세요.');
  if (!reason) throw bad('사유를 입력하세요.');
  if (db.prepare("SELECT COUNT(*) AS n FROM requests WHERE user_id = ? AND status = 'pending'").get(user.id).n >= 10) throw bad('대기 중인 요청이 너무 많습니다. 처리된 뒤에 다시 요청하세요.');
  db.prepare('INSERT INTO requests (user_id, work_date, req_in, req_out, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(user.id, date, tin, tout, reason, Date.now());
  return { status: 201, body: { ok: true } };
});

route('POST', '/api/requests/(\\d+)/decide', 'admin', async ({ user, body, params }) => {
  const id = Number(params[0]), approve = body.approve === true;
  tx(() => {
    const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
    if (!r) throw new HttpError(404, '요청을 찾을 수 없습니다.');
    if (r.status !== 'pending') throw new HttpError(409, '이미 처리된 요청입니다.');
    if (approve) applyAdjustment(r.user_id, r.work_date, r.req_in, r.req_out, '요청 승인: ' + r.reason, user.id);
    db.prepare('UPDATE requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?').run(approve ? 'approved' : 'rejected', user.id, Date.now(), id);
  });
  return { ok: true };
});

route('POST', '/api/admin/records', 'admin', async ({ user, body }) => {
  const uid = Number(body.userId);
  if (!Number.isInteger(uid)) throw bad('팀원을 선택하세요.');
  applyAdjustment(uid, body.date, body.in || null, body.out || null, str(body.reason, 200), user.id);
  return { ok: true };
});

route('GET', '/api/admin/info', 'admin', async () => ({ signupCode: SIGNUP_CODE, defaults: defaults(), users: db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').get().n }));

route('PUT', '/api/admin/defaults', 'admin', async ({ body }) => {
  if (!isHm(body.start) || !isHm(body.end)) throw bad('시각 형식이 올바르지 않습니다.');
  setSetting('work_start', body.start); setSetting('work_end', body.end);
  return { ok: true };
});

route('POST', '/api/admin/users/(\\d+)/active', 'admin', async ({ user, body, params }) => {
  const id = Number(params[0]);
  if (id === user.id) throw bad('자기 자신은 비활성화할 수 없습니다.');
  const active = body.active === true ? 1 : 0;
  if (!db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active, id).changes) throw new HttpError(404, '팀원을 찾을 수 없습니다.');
  if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  return { ok: true };
});

/* ---------- 정적 파일 ---------- */
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/app.css': ['app.css', 'text/css; charset=utf-8'] };

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pth = url.pathname;
  if (req.method === 'GET' && STATIC[pth]) {
    const [file, type] = STATIC[pth];
    const data = fs.readFileSync(path.join(__dirname, 'public', file));
    res.writeHead(200, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-cache' }, SEC_HEADERS));
    return res.end(data);
  }
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(pth);
    if (!m) continue;
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'fetch') throw new HttpError(403, '허용되지 않은 요청입니다.');
    const user = r.auth ? sessionUser(req) : null;
    if (r.auth && !user) throw new HttpError(401, '로그인이 필요합니다.');
    if (r.auth === 'admin' && user.role !== 'admin') throw new HttpError(403, '관리자만 할 수 있습니다.');
    const body = req.method === 'GET' ? {} : await readJson(req);
    const out = await r.handler({ req, res, url, user, body, params: m.slice(1) });
    if (out && out.body !== undefined) return send(res, out.status || 200, out.body, out.headers);
    return send(res, 200, out);
  }
  throw new HttpError(404, '찾을 수 없습니다.');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error('[오류]', e && e.stack || e);
    send(res, 500, { error: '서버에서 문제가 생겼습니다. 잠시 뒤에 다시 시도하세요.' });
  });
});
server.listen(PORT, () => console.log('출퇴근 서버 시작: http://localhost:' + server.address().port + '  (DB: ' + DB_PATH + ')'));
const shutdown = () => { server.close(() => { try { db.close(); } catch {} process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
