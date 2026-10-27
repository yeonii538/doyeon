'use strict';
// 서버 통합 시험: 임시 DB로 서버를 띄워 API를 실제로 호출합니다.  실행: npm test
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'att-'));
let passed = 0;
const results = [];
async function t(name, fn) { try { await fn(); passed++; results.push('  통과  ' + name); } catch (e) { results.push('  실패  ' + name + '\n        ' + (e && e.message)); process.exitCode = 1; } }

function start(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, 'server.js')], { env: Object.assign({}, process.env, { PORT: '0', SIGNUP_CODE: 'test-code-123' }, env), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; const m = /localhost:(\d+)/.exec(out); if (m) resolve({ p, base: 'http://127.0.0.1:' + m[1] }); });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => reject(new Error('서버가 종료됨 ' + c + ' ' + out)));
    setTimeout(() => reject(new Error('서버 시작 시간 초과 ' + out)), 8000);
  });
}
function client(base) {
  let cookie = '';
  const call = async function (method, url, body, opts) {
    const headers = { 'Content-Type': 'application/json' };
    if (!(opts && opts.noCsrf)) headers['X-Requested-With'] = 'fetch';
    if (cookie) headers.Cookie = cookie;
    const r = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) { const v = sc.split(';')[0]; cookie = v.endsWith('=') ? '' : v; }
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, json, headers: r.headers };
  };
  call.cookie = () => cookie;
  return call;
}
const pw = 'correct-horse-battery';

(async () => {
  const A = await start({ DB_PATH: path.join(tmp, 'a.db') });
  const admin = client(A.base), member = client(A.base), anon = client(A.base);

  await t('상태 확인(healthz)', async () => { assert.equal((await anon('GET', '/healthz')).status, 200); });
  await t('보안 헤더가 붙는다', async () => { const r = await anon('GET', '/healthz'); assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.match(r.headers.get('content-security-policy'), /default-src 'self'/); });
  await t('로그인 없이 기록 조회 불가(401)', async () => { assert.equal((await anon('GET', '/api/records')).status, 401); });
  await t('잘못된 가입 코드는 거부(403)', async () => { assert.equal((await anon('POST', '/api/signup', { email: 'x@example.com', name: 'x', password: pw, code: 'nope' })).status, 403); });
  await t('짧은 비밀번호는 거부(400)', async () => { assert.equal((await anon('POST', '/api/signup', { email: 'x@example.com', name: 'x', password: 'short', code: 'test-code-123' })).status, 400); });
  await t('이메일 형식 검사(400)', async () => { assert.equal((await anon('POST', '/api/signup', { email: 'not-an-email', name: 'x', password: pw, code: 'test-code-123' })).status, 400); });
  await t('첫 가입자는 관리자, 쿠키는 HttpOnly', async () => {
    const r = await admin('POST', '/api/signup', { email: 'Admin@Example.com', name: '관리자', password: pw, code: 'test-code-123' });
    assert.equal(r.status, 201); assert.match(r.headers.get('set-cookie'), /HttpOnly/); assert.match(r.headers.get('set-cookie'), /SameSite=Lax/);
    const me = await admin('GET', '/api/me'); assert.equal(me.json.user.role, 'admin'); assert.equal(me.json.user.email, 'admin@example.com');
  });
  await t('두 번째 가입자는 일반 팀원', async () => {
    assert.equal((await member('POST', '/api/signup', { email: 'min@example.com', name: '김민수', password: pw, code: 'test-code-123' })).status, 201);
    assert.equal((await member('GET', '/api/me')).json.user.role, 'member');
  });
  await t('이메일 중복 가입은 거부(409)', async () => { assert.equal((await anon('POST', '/api/signup', { email: 'MIN@example.com', name: 'dup', password: pw, code: 'test-code-123' })).status, 409); });
  await t('저장된 비밀번호는 평문이 아니다', async () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(tmp, 'a.db'), { readOnly: true });
    const row = db.prepare('SELECT pw FROM users WHERE email = ?').get('min@example.com'); db.close();
    assert.ok(row.pw.startsWith('s1$') && !row.pw.includes(pw));
  });
  await t('쿠키 없는 요청은 401, 잘못된 비밀번호는 401', async () => {
    assert.equal((await anon('GET', '/api/me')).status, 401);
    assert.equal((await anon('POST', '/api/login', { email: 'min@example.com', password: 'wrong-password-1' })).status, 401);
  });
  await t('올바른 로그인은 새 세션을 만든다', async () => { const c = client(A.base); assert.equal((await c('POST', '/api/login', { email: 'min@example.com', password: pw })).status, 200); assert.equal((await c('GET', '/api/me')).status, 200); });
  await t('CSRF: 요청 머리글이 없으면 변경 요청 거부(403)', async () => { assert.equal((await member('POST', '/api/punch', { kind: 'in' }, { noCsrf: true })).status, 403); });

  await t('출근 없이 퇴근하면 거부(409)', async () => { assert.equal((await member('POST', '/api/punch', { kind: 'out' })).status, 409); });
  await t('출근은 서버 시각으로 기록된다', async () => {
    const before = Date.now(); const r = await member('POST', '/api/punch', { kind: 'in' }); const after = Date.now();
    assert.equal(r.status, 200); assert.ok(r.json.at >= before && r.json.at <= after);
  });
  await t('같은 날 두 번째 출근은 거부(409)', async () => { assert.equal((await member('POST', '/api/punch', { kind: 'in' })).status, 409); });
  await t('브라우저가 보낸 시각은 무시한다', async () => {
    const r = await member('POST', '/api/punch', { kind: 'out', at: 1, time: '03:00' }); assert.equal(r.status, 200); assert.ok(r.json.at > 1e12);
  });
  await t('퇴근 후 같은 날 재출근도 거부(하루 1회)', async () => { assert.equal((await member('POST', '/api/punch', { kind: 'in' })).status, 409); });
  await t('다른 팀원도 서로의 기록을 볼 수 있다', async () => {
    const r = await admin('GET', '/api/records'); assert.equal(r.status, 200);
    assert.equal(r.json.users.length, 2); assert.equal(r.json.days.length, 1); assert.ok(r.json.days[0].out > r.json.days[0].in);
  });
  await t('월 형식 검증(400)', async () => { assert.equal((await admin('GET', '/api/records?month=2026-13')).status, 400); assert.equal((await admin('GET', "/api/records?month=2026-10' OR 1=1")).status, 400); });

  const today = (await admin('GET', '/api/me')).json.today;
  await t('수정 요청: 팀원이 보낼 수 있고 미래 날짜는 거부', async () => {
    assert.equal((await member('POST', '/api/requests', { date: today, in: '08:30', reason: '출근 버튼이 늦었음' })).status, 201);
    assert.equal((await member('POST', '/api/requests', { date: '2099-01-01', in: '08:30', reason: 'x' })).status, 400);
    assert.equal((await member('POST', '/api/requests', { date: today, reason: '시각 없음' })).status, 400);
  });
  let reqId;
  await t('팀원은 요청을 승인할 수 없다(403), 관리자는 대기 요청을 본다', async () => {
    const list = await admin('GET', '/api/records'); const pending = list.json.requests.filter((r) => r.status === 'pending'); assert.equal(pending.length, 1); reqId = pending[0].id;
    assert.equal((await member('POST', '/api/requests/' + reqId + '/decide', { approve: true })).status, 403);
  });
  await t('관리자가 승인하면 기록이 바뀌고 보정 이력이 남는다', async () => {
    assert.equal((await admin('POST', '/api/requests/' + reqId + '/decide', { approve: true })).status, 200);
    const r = await admin('GET', '/api/records'); const d = r.json.days[0];
    assert.equal(new Date(d.in + 9 * 3600e3).toISOString().slice(11, 16), '08:30');
    assert.equal(r.json.adj.length, 1); assert.match(r.json.adj[0].reason, /요청 승인/);
    assert.equal((await admin('POST', '/api/requests/' + reqId + '/decide', { approve: true })).status, 409);
  });
  await t('관리자 직접 보정: 사유 필수, 퇴근<출근 거부, 팀원은 불가', async () => {
    const uid = (await admin('GET', '/api/records')).json.users.find((u) => u.name === '김민수').id;
    assert.equal((await admin('POST', '/api/admin/records', { userId: uid, date: today, out: '09:00', reason: '' })).status, 400);
    assert.equal((await admin('POST', '/api/admin/records', { userId: uid, date: today, out: '07:00', reason: '시각 오류' })).status, 400);
    assert.equal((await admin('POST', '/api/admin/records', { userId: uid, date: '2020-01-02', in: '09:00', out: '18:00', reason: '누락 입력' })).status, 200);
    assert.equal((await member('POST', '/api/admin/records', { userId: uid, date: today, in: '09:00', reason: 'x' })).status, 403);
    assert.equal((await admin('GET', '/api/records?month=2020-01')).json.days.length, 1);
  });
  await t('관리자 화면 정보는 관리자만(403)', async () => { assert.equal((await member('GET', '/api/admin/info')).status, 403); const r = await admin('GET', '/api/admin/info'); assert.equal(r.status, 200); assert.equal(r.json.signupCode, 'test-code-123'); });
  await t('내 설정 저장·비밀번호 변경', async () => {
    assert.equal((await member('PUT', '/api/me', { name: '김민수', workStart: '08:30', workEnd: '17:30' })).status, 200);
    assert.equal((await member('PUT', '/api/me', { name: '김민수', workStart: '25:00', workEnd: '17:30' })).status, 400);
    assert.equal((await member('POST', '/api/me/password', { current: 'bad-password-xx', next: 'another-long-password' })).status, 403);
    assert.equal((await member('POST', '/api/me/password', { current: pw, next: 'another-long-password' })).status, 200);
    const c = client(A.base); assert.equal((await c('POST', '/api/login', { email: 'min@example.com', password: 'another-long-password' })).status, 200);
  });
  await t('비활성화하면 로그인과 기존 세션이 막힌다', async () => {
    const uid = (await admin('GET', '/api/records')).json.users.find((u) => u.name === '김민수').id;
    assert.equal((await admin('POST', '/api/admin/users/' + uid + '/active', { active: false })).status, 200);
    assert.equal((await member('GET', '/api/me')).status, 401);
    const c = client(A.base); assert.equal((await c('POST', '/api/login', { email: 'min@example.com', password: 'another-long-password' })).status, 401);
  });
  await t('로그아웃하면 세션이 끝난다', async () => { await admin('POST', '/api/logout'); assert.equal((await admin('GET', '/api/me')).status, 401); });
  await t('로그인 8회 실패하면 잠시 차단(429)', async () => {
    const c = client(A.base); let last;
    for (let i = 0; i < 9; i++) last = await c('POST', '/api/login', { email: 'nobody@example.com', password: 'wrong-password-' + i });
    assert.equal(last.status, 429);
  });
  await t('정적 화면과 알 수 없는 경로', async () => { const r = await fetch(A.base + '/'); assert.equal(r.status, 200); assert.equal((await fetch(A.base + '/server.js')).status, 404); assert.equal((await fetch(A.base + '/../etc/passwd')).status, 404); });
  await t('백업 스크립트가 복사본을 만든다', async () => {
    const { execFileSync } = require('node:child_process'); const dest = path.join(tmp, 'copy.db');
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, 'scripts', 'backup.js'), dest], { env: Object.assign({}, process.env, { DB_PATH: path.join(tmp, 'a.db') }) });
    assert.ok(fs.statSync(dest).size > 0);
  });
  A.p.removeAllListeners('exit'); A.p.kill();

  // 접속 IP 제한
  const B = await start({ DB_PATH: path.join(tmp, 'b.db'), ALLOWED_IPS: '10.0.0.0/8,203.0.113.5' });
  const b1 = client(B.base);
  await t('허용 IP 밖에서는 출근 기록이 거부된다(403)', async () => {
    await b1('POST', '/api/signup', { email: 'ip@example.com', name: 'ip', password: pw, code: 'test-code-123' });
    const r = await b1('POST', '/api/punch', { kind: 'in' }); assert.equal(r.status, 403); assert.match(r.json.error, /사내망/);
    assert.equal((await b1('GET', '/api/me')).json.ipAllowed, false);
  });
  await t('IP 제한이 있어도 X-Forwarded-For 는 신뢰하지 않는다(TRUST_PROXY 꺼짐)', async () => {
    const r = await fetch(B.base + '/api/punch', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', 'X-Forwarded-For': '10.1.2.3', Cookie: b1.cookie() }, body: JSON.stringify({ kind: 'in' }) });
    assert.equal(r.status, 403);
  });
  B.p.removeAllListeners('exit'); B.p.kill();

  const C = await start({ DB_PATH: path.join(tmp, 'c.db'), ALLOWED_IPS: '10.0.0.0/8', TRUST_PROXY: '1' });
  const c1 = client(C.base);
  await t('프록시 뒤(TRUST_PROXY)에서는 전달된 IP로 허용 여부를 판단한다', async () => {
    await c1('POST', '/api/signup', { email: 'p@example.com', name: 'p', password: pw, code: 'test-code-123' });
    const cookie = c1.cookie();
    const call = (xff) => fetch(C.base + '/api/punch', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', 'X-Forwarded-For': xff, Cookie: cookie }, body: JSON.stringify({ kind: 'in' }) });
    assert.equal((await call('8.8.8.8')).status, 403);
    assert.equal((await call('10.20.30.40')).status, 200);
  });
  C.p.removeAllListeners('exit'); C.p.kill();

  console.log(results.join('\n'));
  console.log('\n' + passed + '/' + results.length + ' 통과');
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error('시험 실행 오류:', e); process.exit(1); });
