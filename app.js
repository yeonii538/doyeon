(function () {
  'use strict';
  var TZ = 'Asia/Seoul';
  var WD = ['일', '월', '화', '수', '목', '금', '토'];
  var fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  function kst(ms) {
    var p = {}; fmt.formatToParts(ms).forEach(function (x) { p[x.type] = x.value; });
    return { key: p.year + '-' + p.month + '-' + p.day, hm: p.hour + ':' + p.minute, hms: p.hour + ':' + p.minute + ':' + p.second, min: (+p.hour) * 60 + (+p.minute), y: +p.year, mo: +p.month, d: +p.day };
  }
  function wday(key) { return WD[new Date(key + 'T00:00:00Z').getUTCDay()]; }
  function toMin(hm) { var a = String(hm || '').split(':'); return (+a[0]) * 60 + (+a[1] || 0); }
  function hhmm(m) { m = Math.round(m); return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2); }
  function dur(ms) { var m = Math.round(ms / 60000); var h = Math.floor(m / 60); return h ? h + '시간 ' + (m % 60) + '분' : m + '분'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(id) { return document.getElementById(id); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  var S = { me: null, docs: {}, recent: [], defaults: { start: '09:00', end: '18:00' }, teamSize: 9, offset: 0, open: null, month: kst(Date.now()).key.slice(0, 7), view: 'mine', filter: '', form: null, busy: false, msg: null, loaded: false, failed: false, cmp: null, selDay: null, selUid: null, authMode: 'login' };
  try { var sv = JSON.parse(lsGet('cmp') || 'null'); if (Array.isArray(sv)) S.cmp = sv; } catch (e) {}
  function now() { return Date.now() + S.offset; } // 서버 시계에 맞춘 현재 시각

  /* ---------- 서버 통신 ---------- */
  async function api(method, url, body) {
    var r = await fetch(url, { method: method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: body ? JSON.stringify(body) : undefined });
    var j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) { var err = new Error((j && j.error) || '요청에 실패했습니다.'); err.status = r.status; throw err; }
    return j;
  }
  function buildDocs(r) {
    var docs = {}, hasDay = {};
    r.days.forEach(function (d) { hasDay[d.uid] = 1; });
    r.users.forEach(function (u) {
      if (!u.active && !hasDay[u.id]) return;
      docs[String(u.id)] = { profile: { name: u.name }, role: u.role, active: !!u.active, settings: u.workStart && u.workEnd ? { start: u.workStart, end: u.workEnd } : null, days: {}, reqs: [] };
    });
    r.days.forEach(function (d) { var o = docs[String(d.uid)]; if (o) o.days[d.date] = { in: d.in, out: d.out, adj: [] }; });
    r.adj.forEach(function (a) { var o = docs[String(a.uid)]; if (o && o.days[a.date]) o.days[a.date].adj.push({ at: a.at, reason: a.reason }); });
    var st = { pending: '대기', approved: '승인', rejected: '반려' };
    r.requests.forEach(function (q) { var o = docs[String(q.uid)]; if (o) o.reqs.push({ id: String(q.id), date: q.date, in: q.in, out: q.out, reason: q.reason, status: st[q.status] || q.status, at: q.at }); });
    S.docs = docs;
    S.recent = r.recent.map(function (x) { return { uid: String(x.uid), date: x.date, in: x.in, out: x.out }; });
  }
  async function loadRecords() { var r = await api('GET', '/api/records?month=' + S.month); S.offset = r.serverNow - Date.now(); buildDocs(r); }
  async function refresh() {
    try {
      var me = await api('GET', '/api/me');
      S.me = { id: String(me.user.id), name: me.user.name, email: me.user.email, role: me.user.role };
      S.defaults = me.defaults; S.open = me.open; S.teamSize = me.teamSize; S.offset = me.serverNow - Date.now(); S.ipAllowed = me.ipAllowed;
      await loadRecords(); S.loaded = true; S.failed = false;
    } catch (e) {
      if (e.status === 401) { S.me = null; S.docs = {}; S.loaded = true; } else { S.failed = true; }
    }
    renderAll();
  }
  function isAdmin() { return !!S.me && S.me.role === 'admin'; }

  /* ---------- 기본 계산 ---------- */
  function cfgOf(uid) { var d = S.docs[uid]; return d && d.settings ? d.settings : S.defaults; }
  function nameOf(id) { var d = S.docs[id]; return d && d.profile && d.profile.name || '팀원'; }
  function daysOf(uid) { return (S.docs[uid] && S.docs[uid].days) || {}; }
  function byName(a, b) { return nameOf(a).localeCompare(nameOf(b), 'ko'); }
  function userFlags(days, uid) {
    var cfg = cfgOf(uid), out = {}, ks = Object.keys(days || {}).sort(), today = kst(now()).key;
    ks.forEach(function (k) {
      var d = days[k], f = [];
      if (d.in && kst(d.in).min > toMin(cfg.start)) f.push({ t: '지각', c: 'warn' });
      if (d.out && d.in && kst(d.out).key === k && kst(d.out).min < toMin(cfg.end)) f.push({ t: '조퇴', c: 'warn' });
      if (d.in && !d.out && (k < today || now() - d.in >= 20 * 3600e3)) f.push({ t: '퇴근 누락', c: 'bad' });
      if (d.adj && d.adj.length) f.push({ t: '관리자 보정', c: 'info' });
      out[k] = f;
    });
    return out;
  }
  function pills(f) {
    if (!f.length) return '<span class="pill ok">정상</span>';
    return '<div class="pills">' + f.map(function (x) { return '<span class="pill ' + x.c + '">' + esc(x.t) + '</span>'; }).join('') + '</div>';
  }
  function tone(f) { return f.some(function (x) { return x.c === 'bad'; }) ? 'bad' : f.some(function (x) { return x.c === 'warn'; }) ? 'warn' : 'ok'; }
  function stats(uid) {
    var days = daysOf(uid), fl = userFlags(days, uid), o = { n: 0, ms: 0, inSum: 0, outSum: 0, outN: 0, late: 0, miss: 0, chk: 0 };
    Object.keys(days).forEach(function (k) {
      if (k.indexOf(S.month) !== 0 || !days[k].in) return;
      var d = days[k]; o.n++; o.inSum += kst(d.in).min;
      if (d.out && d.out > d.in) { o.ms += d.out - d.in; o.outSum += kst(d.out).min; o.outN++; }
      (fl[k] || []).forEach(function (x) { if (x.t === '지각') o.late++; else if (x.t === '퇴근 누락') o.miss++; else if (x.c === 'bad') o.chk++; });
    });
    o.avgIn = o.n ? hhmm(o.inSum / o.n) : '–'; o.avgOut = o.outN ? hhmm(o.outSum / o.outN) : '–';
    return o;
  }
  function monthLabel() { return S.month.slice(0, 4) + '년 ' + (+S.month.slice(5, 7)) + '월'; }
  function shiftMonth(delta) { var y = +S.month.slice(0, 4), m = +S.month.slice(5, 7) - 1 + delta; var d = new Date(Date.UTC(y, m, 1)); S.month = d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2); }

  /* ---------- 화면 상태 ---------- */
  function showState() {
    var st = !S.loaded ? 'load' : !S.me ? 'auth' : 'app';
    $('gate-load').hidden = st !== 'load'; $('gate-auth').hidden = st !== 'auth'; $('app').hidden = st !== 'app';
    $('gate-load').firstElementChild.textContent = S.failed && !S.loaded ? '서버에 연결하지 못했습니다. 잠시 뒤에 새로 고쳐 주세요.' : '불러오는 중입니다.';
    $('who').textContent = S.me ? S.me.name + (isAdmin() ? ' · 관리자' : '') : '';
    $('btn-logout').hidden = !S.me;
    return st;
  }
  function renderAll() {
    if (showState() !== 'app') return;
    renderToday(); renderMonth(); renderMineList(); renderCompare(); renderSettings();
    if (S.view === 'team') renderTeam();
  }

  /* ---------- 오늘 출퇴근 ---------- */
  function renderClock() {
    var n = kst(now());
    $('clock').textContent = n.hms;
    $('datetxt').textContent = n.y + '년 ' + n.mo + '월 ' + n.d + '일 ' + wday(n.key) + '요일';
  }
  function renderToday() {
    var t = now(), cfg = cfgOf(S.me.id), key = kst(t).key, rec = daysOf(S.me.id)[key], btn = $('punch'), st = $('statetxt');
    btn.classList.remove('out');
    if (!S.ipAllowed) { st.textContent = '이 네트워크에서는 기록할 수 없습니다. 사내망에 접속하세요.'; btn.textContent = '기록할 수 없습니다'; btn.disabled = true; }
    else if (S.open) { st.textContent = '근무 중 · ' + kst(S.open.in).hm + ' 출근 (' + dur(t - S.open.in) + ' 경과)'; btn.textContent = '퇴근하기'; btn.classList.add('out'); btn.disabled = S.busy; btn.dataset.kind = 'out'; }
    else if (rec && rec.out) { st.textContent = '오늘 근무 완료 · ' + kst(rec.in).hm + ' – ' + kst(rec.out).hm + ' (' + dur(rec.out - rec.in) + ')'; btn.textContent = '오늘 기록 완료'; btn.disabled = true; }
    else { st.textContent = '출근 전입니다.'; btn.textContent = '출근하기'; btn.disabled = S.busy; btn.dataset.kind = 'in'; }
    if (S.busy) btn.textContent = '저장하는 중…';
    $('msg').innerHTML = S.msg ? '<div class="msg ' + S.msg.c + '" role="status">' + esc(S.msg.t) + '</div>' : '';
    var cur = S.open ? { in: S.open.in } : rec;
    var A = 360, B = 1440, pct = function (m) { return Math.max(0, Math.min(100, (m - A) / (B - A) * 100)); };
    var bar = '<div class="track">';
    if (cur && cur.in) {
      var s = pct(kst(cur.in).min), e = cur.out ? pct(kst(cur.out).min) : pct(kst(t).min);
      if (kst(cur.in).key !== key) s = 0;
      bar += '<div class="fill" style="left:' + s + '%;width:' + Math.max(0.8, e - s) + '%"></div>';
    }
    bar += '<div class="mark" title="기준 출근" style="left:' + pct(toMin(cfg.start)) + '%"></div><div class="mark" title="기준 퇴근" style="left:' + pct(toMin(cfg.end)) + '%"></div></div>';
    bar += '<div class="ticks mono">' + [6, 9, 12, 15, 18, 21, 24].map(function (h) { return '<span style="left:' + pct(h * 60) + '%">' + ('0' + h).slice(-2) + '</span>'; }).join('') + '</div>';
    bar += '<div class="barcap">세로선은 내 기준 출근 ' + esc(cfg.start) + ' · 기준 퇴근 ' + esc(cfg.end) + '</div>';
    $('daybar').innerHTML = bar;
  }
  function say(c, t) { S.msg = { c: c, t: t }; }
  async function punch(kind) {
    if (S.busy) return;
    S.busy = true; S.msg = null; renderToday();
    try {
      var r = await api('POST', '/api/punch', { kind: kind });
      say('ok', (kind === 'in' ? '출근' : '퇴근') + ' ' + kst(r.at).hm + '에 기록했습니다.');
      await refresh();
    } catch (e) { say('bad', e.message); }
    finally { S.busy = false; if (S.me) renderToday(); }
  }

  /* ---------- 내 기록: 달력 + 날짜별 표 ---------- */
  function renderMonth() {
    $('m-label').textContent = monthLabel();
    var s = stats(S.me.id);
    $('m-stats').innerHTML = '<span>근무일 <b>' + s.n + '</b></span><span>총 근무 <b>' + (s.ms ? dur(s.ms) : '–') + '</b></span><span>평균 출근 <b>' + s.avgIn + '</b></span><span>평균 퇴근 <b>' + s.avgOut + '</b></span><span>지각 <b>' + s.late + '</b></span><span>퇴근 누락 <b>' + s.miss + '</b></span>';
    var y = +S.month.slice(0, 4), mo = +S.month.slice(5, 7), n = new Date(Date.UTC(y, mo, 0)).getUTCDate(), first = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
    var days = daysOf(S.me.id), fl = userFlags(days, S.me.id), today = kst(now()).key;
    var h = WD.map(function (w) { return '<div class="dh">' + w + '</div>'; }).join('');
    for (var i = 0; i < first; i++) h += '<div></div>';
    for (var d = 1; d <= n; d++) {
      var key = S.month + '-' + ('0' + d).slice(-2), r = days[key], w = (first + d - 1) % 7, cls = 'c' + (w === 0 || w === 6 ? ' we' : '') + (key === today ? ' today' : ''), inner = '<span class="dn">' + d + '</span>';
      if (r && r.in) { cls += ' ' + tone(fl[key] || []); inner += '<span class="num">' + kst(r.in).hm + '</span><span class="num">' + (r.out ? kst(r.out).hm : (key === today ? '근무 중' : '누락')) + '</span>'; }
      h += '<div class="' + cls + '">' + inner + '</div>';
    }
    $('cal').innerHTML = h;
  }
  function renderMineList() {
    var days = daysOf(S.me.id), fl = userFlags(days, S.me.id), ks = Object.keys(days).filter(function (k) { return k.indexOf(S.month) === 0; }).sort().reverse();
    var s = stats(S.me.id);
    $('mine-sum').textContent = monthLabel() + ' · ' + s.n + '일 · 합계 ' + (s.ms ? dur(s.ms) : '0분');
    if (!ks.length) { $('mine-list').innerHTML = '<div class="empty">' + monthLabel() + ' 기록이 없습니다. 왼쪽 버튼으로 출근을 기록하세요.</div>'; return; }
    $('mine-list').innerHTML = '<table><thead><tr><th>날짜</th><th>출근</th><th>퇴근</th><th>근무 시간</th><th>상태</th><th></th></tr></thead><tbody>' + ks.map(function (k) {
      var d = days[k], w = d.in && d.out && d.out > d.in ? dur(d.out - d.in) : '–';
      var adj = d.adj && d.adj.length ? '<div class="sub">보정 사유: ' + esc(d.adj[d.adj.length - 1].reason) + '</div>' : '';
      return '<tr><td class="num">' + k.slice(5) + ' (' + wday(k) + ')</td><td class="num">' + (d.in ? kst(d.in).hm : '–') + '</td><td class="num">' + (d.out ? kst(d.out).hm : '–') + '</td><td>' + w + '</td><td>' + pills(fl[k] || []) + adj + '</td><td><button class="btn small" data-reqdate="' + k + '">수정 요청</button></td></tr>';
    }).join('') + '</tbody></table>';
  }

  /* ---------- 팀원과 비교 (내 기록 화면) ---------- */
  function others() { return Object.keys(S.docs).filter(function (i) { return i !== S.me.id; }).sort(byName); }
  function selected() { var o = others(); if (S.cmp === null) return o.slice(0, 2); return S.cmp.filter(function (i) { return o.indexOf(i) >= 0; }); }
  function renderCompare() {
    var o = others(), sel = selected(), box = $('cmp-chips');
    if (!o.length) { box.innerHTML = ''; $('cmp-note').textContent = ''; $('cmp-sum').innerHTML = '<div class="empty">비교할 팀원이 아직 없습니다. 다른 팀원이 가입하면 여기서 비교할 수 있습니다.</div>'; $('cmp-list').innerHTML = ''; return; }
    box.innerHTML = o.map(function (id) { return '<label class="chip"><input type="checkbox" data-cmp="' + esc(id) + '"' + (sel.indexOf(id) >= 0 ? ' checked' : '') + '>' + esc(nameOf(id)) + '</label>'; }).join('');
    $('cmp-note').textContent = monthLabel() + ' · 나와 비교할 팀원을 선택하세요';
    var ids = [S.me.id].concat(sel), st = {}, fl = {};
    ids.forEach(function (id) { st[id] = stats(id); fl[id] = userFlags(daysOf(id), id); });
    var max = Math.max.apply(null, ids.map(function (id) { return st[id].ms; }).concat([1]));
    $('cmp-sum').innerHTML = '<table><thead><tr><th>이름</th><th class="r">근무일</th><th>총 근무 시간</th><th class="r">평균 출근</th><th class="r">평균 퇴근</th><th class="r">지각</th><th class="r">퇴근 누락</th></tr></thead><tbody>' + ids.map(function (id) {
      var s = st[id];
      return '<tr class="' + (id === S.me.id ? 'me' : '') + '"><td>' + esc(nameOf(id)) + (id === S.me.id ? ' (나)' : '') + '</td><td class="r num">' + s.n + '</td><td><div class="hbar"><i style="width:' + Math.round(s.ms / max * 100) + 'px"></i><span class="num">' + (s.ms ? dur(s.ms) : '–') + '</span></div></td><td class="r num">' + s.avgIn + '</td><td class="r num">' + s.avgOut + '</td><td class="r num">' + s.late + '</td><td class="r num">' + s.miss + '</td></tr>';
    }).join('') + '</tbody></table>';
    var dates = {};
    ids.forEach(function (id) { var d = daysOf(id); Object.keys(d).forEach(function (k) { if (k.indexOf(S.month) === 0 && d[k].in) dates[k] = 1; }); });
    var ks = Object.keys(dates).sort().reverse();
    if (!ks.length) { $('cmp-list').innerHTML = '<div class="empty">' + monthLabel() + ' 비교할 기록이 없습니다.</div>'; return; }
    $('cmp-list').innerHTML = '<table><thead><tr><th>날짜</th>' + ids.map(function (id) { return '<th>' + esc(nameOf(id)) + (id === S.me.id ? ' (나)' : '') + '</th>'; }).join('') + '</tr></thead><tbody>' + ks.map(function (k) {
      return '<tr><td class="num">' + k.slice(5) + ' (' + wday(k) + ')</td>' + ids.map(function (id) {
        var r = daysOf(id)[k]; if (!r || !r.in) return '<td class="num sub">–</td>';
        var late = (fl[id][k] || []).some(function (x) { return x.t === '지각'; });
        return '<td class="num"><span class="' + (late ? 'late' : '') + '">' + kst(r.in).hm + '</span> – ' + (r.out ? kst(r.out).hm : '') + '</td>';
      }).join('') + '</tr>';
    }).join('') + '</tbody></table>';
  }

  /* ---------- 내 설정 / 수정 요청 ---------- */
  function renderSettings() {
    var cfg = cfgOf(S.me.id), f = document.activeElement && document.activeElement.id;
    if (f !== 'p-name') $('p-name').value = S.me.name;
    if (f !== 'p-start') $('p-start').value = cfg.start;
    if (f !== 'p-end') $('p-end').value = cfg.end;
    var reqs = (S.docs[S.me.id] && S.docs[S.me.id].reqs) || [];
    $('my-reqs').innerHTML = reqs.length ? '<div class="formtitle">내 수정 요청</div><div class="tablewrap"><table><thead><tr><th>날짜</th><th>요청 내용</th><th>사유</th><th>상태</th></tr></thead><tbody>' + reqs.map(function (r) {
      return '<tr><td class="num">' + esc(r.date.slice(5)) + '</td><td class="num">' + esc((r.in || '–') + ' / ' + (r.out || '–')) + '</td><td>' + esc(r.reason) + '</td><td><span class="pill ' + (r.status === '승인' ? 'ok' : r.status === '반려' ? 'bad' : 'warn') + '">' + esc(r.status) + '</span></td></tr>';
    }).join('') + '</tbody></table></div>' : '';
  }
  function notice(id, c, t) { $(id).innerHTML = '<div class="msg ' + c + '" role="status">' + esc(t) + '</div>'; }
  async function saveSettings() {
    var name = $('p-name').value.trim(), a = $('p-start').value, b = $('p-end').value;
    if (!name || !a || !b) return notice('p-msg', 'bad', '이름과 기준 시각을 모두 입력하세요.');
    try { await api('PUT', '/api/me', { name: name, workStart: a, workEnd: b }); notice('p-msg', 'ok', '저장했습니다.'); await refresh(); }
    catch (e) { notice('p-msg', 'bad', e.message); }
  }
  async function savePassword() {
    var cur = $('pw-cur').value, n1 = $('pw-new').value, n2 = $('pw-new2').value;
    if (!cur || !n1) return notice('pw-msg', 'bad', '현재 비밀번호와 새 비밀번호를 입력하세요.');
    if (n1.length < 10) return notice('pw-msg', 'bad', '새 비밀번호는 10자 이상이어야 합니다.');
    if (n1 !== n2) return notice('pw-msg', 'bad', '새 비밀번호 확인이 일치하지 않습니다.');
    try { await api('POST', '/api/me/password', { current: cur, next: n1 }); $('pw-cur').value = $('pw-new').value = $('pw-new2').value = ''; notice('pw-msg', 'ok', '비밀번호를 바꿨습니다. 다른 기기는 로그아웃됩니다.'); }
    catch (e) { notice('pw-msg', 'bad', e.message); }
  }
  function openReq(date) {
    var p = $('req-panel'), d = date ? daysOf(S.me.id)[date] : null;
    p.hidden = false;
    p.innerHTML = '<div class="formtitle">수정 요청</div><p class="hint">관리자가 확인하고 승인하면 기록에 반영됩니다. 비워 둔 시각은 바꾸지 않습니다.</p><div class="formrow">' +
      '<label class="field">날짜<input type="date" id="r-date" value="' + esc(date || kst(now()).key) + '"></label>' +
      '<label class="field">출근<input type="time" id="r-in" value="' + (d && d.in ? kst(d.in).hm : '') + '"></label>' +
      '<label class="field">퇴근<input type="time" id="r-out" value="' + (d && d.out ? kst(d.out).hm : '') + '"></label></div>' +
      '<label class="field" style="margin-bottom:12px">사유 (필수)<input type="text" id="r-reason" maxlength="200" placeholder="예: 퇴근 버튼을 누르지 못함"></label>' +
      '<div class="pills"><button class="btn primary" id="r-save">요청 보내기</button><button class="btn" id="r-cancel">닫기</button></div><div id="r-msg"></div>';
    p.scrollIntoView({ block: 'nearest' });
  }
  async function saveReq() {
    var date = $('r-date').value, tin = $('r-in').value, tout = $('r-out').value, reason = $('r-reason').value.trim();
    if (!date) return notice('r-msg', 'bad', '날짜를 선택하세요.');
    if (!tin && !tout) return notice('r-msg', 'bad', '출근 또는 퇴근 시각을 입력하세요.');
    if (!reason) return notice('r-msg', 'bad', '사유를 입력하세요.');
    try { await api('POST', '/api/requests', { date: date, in: tin || null, out: tout || null, reason: reason }); $('req-panel').hidden = true; $('settings').open = true; await refresh(); }
    catch (e) { notice('r-msg', 'bad', e.message); }
  }

  /* ---------- 팀 현황: 오늘 현황 ---------- */
  function renderBoard() {
    var t = now(), today = kst(t).key, ids = Object.keys(S.docs).filter(function (i) { return S.docs[i].active; });
    var items = ids.map(function (id) {
      var rows = S.recent.filter(function (r) { return r.uid === id; }), open = null, d = null;
      rows.forEach(function (r) { if (r.in && !r.out && t - r.in < 20 * 3600e3 && t >= r.in) open = r; if (r.date === today) d = r; });
      var cur = open || d;
      return { id: id, d: cur, st: open ? 0 : (cur && cur.out ? 1 : 2) };
    });
    items.sort(function (a, b) { return a.st - b.st || byName(a.id, b.id); });
    var work = items.filter(function (i) { return i.st === 0; }).length, done = items.filter(function (i) { return i.st === 1; }).length, total = Math.max(S.teamSize, ids.length);
    $('board-sum').textContent = '근무 중 ' + work + ' · 퇴근 ' + done + ' · 출근 전 ' + (total - work - done) + ' (전체 ' + total + '명)';
    $('board').innerHTML = items.length ? items.map(function (i) {
      var p = i.st === 0 ? '<span class="pill ok">근무 중</span>' : i.st === 1 ? '<span class="pill info">퇴근</span>' : '<span class="pill warn">출근 전</span>';
      var tx = i.st === 2 ? '오늘 기록 없음' : kst(i.d.in).hm + ' 출근' + (i.d.out ? ' · ' + kst(i.d.out).hm + ' 퇴근' : '');
      return '<div class="card' + (i.id === S.me.id ? ' me' : '') + '"><span class="nm">' + esc(nameOf(i.id)) + (i.id === S.me.id ? ' (나)' : '') + '</span>' + p + '<span class="tm num">' + tx + '</span></div>';
    }).join('') : '<div class="empty">팀원이 가입하면 여기에 나타납니다.</div>';
    $('board-note').textContent = ids.length < S.teamSize ? '아직 가입하지 않은 팀원은 가입하면 이 목록에 나타납니다.' : '';
  }

  /* ---------- 팀 현황: 캘린더 · 선택일 상세 · 날짜별 비교표 ---------- */
  function teamIds() { return Object.keys(S.docs).sort(byName); }
  function ensureSel() {
    if (S.selDay && S.selDay.indexOf(S.month) === 0) return;
    var today = kst(now()).key, pick = null;
    if (today.indexOf(S.month) === 0) pick = today;
    else { var all = []; teamIds().forEach(function (id) { Object.keys(daysOf(id)).forEach(function (k) { if (k.indexOf(S.month) === 0) all.push(k); }); }); all.sort(); pick = all.length ? all[all.length - 1] : S.month + '-01'; }
    S.selDay = pick; S.selUid = null;
  }
  function renderTeamCal() {
    $('t-label').textContent = monthLabel();
    ensureSel();
    var y = +S.month.slice(0, 4), mo = +S.month.slice(5, 7), n = new Date(Date.UTC(y, mo, 0)).getUTCDate(), first = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
    var ids = teamIds(), today = kst(now()).key, fl = {};
    ids.forEach(function (id) { fl[id] = userFlags(daysOf(id), id); });
    var h = WD.map(function (w) { return '<div class="dh">' + w + '</div>'; }).join('');
    for (var i = 0; i < first; i++) h += '<div></div>';
    for (var d = 1; d <= n; d++) {
      var key = S.month + '-' + ('0' + d).slice(-2), w = (first + d - 1) % 7;
      var list = ids.filter(function (id) { var r = daysOf(id)[key]; return r && r.in; }).sort(function (a, b) { return daysOf(a)[key].in - daysOf(b)[key].in; });
      var chips = list.map(function (id) {
        return '<button type="button" class="nchip ' + tone(fl[id][key] || []) + (id === S.selUid && key === S.selDay ? ' on' : '') + '" data-day="' + key + '" data-uid="' + esc(id) + '" title="' + esc(nameOf(id) + ' ' + kst(daysOf(id)[key].in).hm + (daysOf(id)[key].out ? '–' + kst(daysOf(id)[key].out).hm : ' 출근')) + '">' + esc(nameOf(id)) + '</button>';
      }).join('');
      h += '<div class="tc' + (w === 0 || w === 6 ? ' we' : '') + (key === today ? ' today' : '') + (key === S.selDay ? ' sel' : '') + '" data-day="' + key + '"><span class="dn">' + d + '</span><div class="names">' + chips + '</div></div>';
    }
    $('tcal').innerHTML = h;
  }
  function renderDayDetail() {
    var key = S.selDay, ids = teamIds(), fl = {};
    ids.forEach(function (id) { fl[id] = userFlags(daysOf(id), id); });
    var rows = ids.map(function (id) { return { id: id, d: daysOf(id)[key] }; });
    rows.sort(function (a, b) { var ha = a.d && a.d.in, hb = b.d && b.d.in; if (ha && hb) return a.d.in - b.d.in; if (ha) return -1; if (hb) return 1; return byName(a.id, b.id); });
    var title = (+key.slice(5, 7)) + '월 ' + (+key.slice(8)) + '일 (' + wday(key) + ') 팀원별 출퇴근';
    var callout = '';
    if (S.selUid && S.docs[S.selUid]) {
      var r = daysOf(S.selUid)[key];
      callout = '<div class="callout"><b>' + esc(nameOf(S.selUid)) + '</b> · ' + (r && r.in ? kst(r.in).hm + ' 출근' + (r.out ? ' · ' + kst(r.out).hm + ' 퇴근 (' + dur(r.out - r.in) + ')' : ' · 퇴근 기록 없음') : '이 날 기록이 없습니다') + '</div>';
    }
    var present = rows.filter(function (x) { return x.d && x.d.in; }).length;
    $('day-panel').innerHTML = '<div class="spread"><h2>' + esc(title) + '</h2><div class="sub">기록 ' + present + '명 / 전체 ' + rows.length + '명</div></div>' + callout +
      '<div class="tablewrap"><table><thead><tr><th>이름</th><th>출근</th><th>퇴근</th><th>근무 시간</th><th>상태</th></tr></thead><tbody>' + rows.map(function (x) {
        var d = x.d, on = x.id === S.selUid ? ' sel' : '';
        if (!d || !d.in) return '<tr class="' + on.trim() + '"><td>' + esc(nameOf(x.id)) + '</td><td colspan="4" class="sub">기록 없음</td></tr>';
        return '<tr class="' + (x.id === S.me.id ? 'me' : '') + on + '"><td>' + esc(nameOf(x.id)) + (x.id === S.me.id ? ' (나)' : '') + '</td><td class="num">' + kst(d.in).hm + '</td><td class="num">' + (d.out ? kst(d.out).hm : '–') + '</td><td>' + (d.out ? dur(d.out - d.in) : '–') + '</td><td>' + pills(fl[x.id][key] || []) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function renderDateTable() {
    var ids = teamIds(), fl = {}, dates = {};
    ids.forEach(function (id) { fl[id] = userFlags(daysOf(id), id); Object.keys(daysOf(id)).forEach(function (k) { if (k.indexOf(S.month) === 0 && daysOf(id)[k].in) dates[k] = 1; }); });
    var ks = Object.keys(dates).sort().reverse();
    $('dt-note').textContent = monthLabel() + ' · 날짜를 누르면 위 상세가 바뀝니다';
    if (!ks.length) { $('date-table').innerHTML = '<div class="empty">' + monthLabel() + ' 기록이 없습니다.</div>'; return; }
    var st = {}; ids.forEach(function (id) { st[id] = stats(id); });
    $('date-table').innerHTML = '<table class="dt"><thead><tr><th class="nm">날짜</th>' + ids.map(function (id) { return '<th>' + esc(nameOf(id)) + (id === S.me.id ? ' (나)' : '') + '</th>'; }).join('') + '</tr></thead><tbody>' + ks.map(function (k) {
      return '<tr data-day="' + k + '" class="' + (k === S.selDay ? 'sel' : '') + '"><td class="nm num">' + k.slice(5) + ' (' + wday(k) + ')</td>' + ids.map(function (id) {
        var r = daysOf(id)[k]; if (!r || !r.in) return '<td class="num sub">–</td>';
        var f = fl[id][k] || [], late = f.some(function (x) { return x.t === '지각'; }), miss = f.some(function (x) { return x.t === '퇴근 누락'; });
        return '<td class="num"><span class="' + (late ? 'late' : '') + '">' + kst(r.in).hm + '</span> – ' + (r.out ? kst(r.out).hm : (miss ? '<span style="color:var(--bad)">누락</span>' : '')) + '</td>';
      }).join('') + '</tr>';
    }).join('') + '</tbody><tfoot><tr><td class="nm">근무일 · 평균 출근</td>' + ids.map(function (id) { return '<td class="num">' + st[id].n + '일 · ' + st[id].avgIn + '</td>'; }).join('') + '</tr></tfoot></table>';
  }
  function selectDay(day, uid) { S.selDay = day; S.selUid = uid || null; renderTeamCal(); renderDayDetail(); renderDateTable(); }

  /* ---------- 팀 현황: 요약 · 요청 · 보정 ---------- */
  function monthRows() {
    var rows = [];
    Object.keys(S.docs).forEach(function (uid) {
      if (S.filter && S.filter !== uid) return;
      var days = daysOf(uid), fl = userFlags(days, uid);
      Object.keys(days).forEach(function (k) { if (k.indexOf(S.month) === 0) rows.push({ uid: uid, date: k, d: days[k], f: fl[k] || [] }); });
    });
    rows.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : byName(a.uid, b.uid); });
    return rows;
  }
  function renderReqs() {
    var p = $('reqs-panel'); if (!isAdmin()) { p.hidden = true; return; }
    var list = [];
    Object.keys(S.docs).forEach(function (uid) { S.docs[uid].reqs.forEach(function (r) { if (r.status === '대기') list.push({ uid: uid, r: r }); }); });
    p.hidden = !list.length;
    if (!list.length) return;
    p.innerHTML = '<div class="spread"><h2>수정 요청 (' + list.length + '건 대기)</h2></div><div class="tablewrap"><table><thead><tr><th>팀원</th><th>날짜</th><th>요청 출근 / 퇴근</th><th>사유</th><th></th></tr></thead><tbody>' + list.map(function (x) {
      return '<tr><td>' + esc(nameOf(x.uid)) + '</td><td class="num">' + esc(x.r.date.slice(5)) + '</td><td class="num">' + esc((x.r.in || '–') + ' / ' + (x.r.out || '–')) + '</td><td>' + esc(x.r.reason) + '</td><td><div class="pills"><button class="btn small primary" data-dec="ok" data-r="' + esc(x.r.id) + '">승인</button><button class="btn small" data-dec="no" data-r="' + esc(x.r.id) + '">반려</button></div></td></tr>';
    }).join('') + '</tbody></table></div>';
  }
  async function decide(rid, approve) {
    try { await api('POST', '/api/requests/' + encodeURIComponent(rid) + '/decide', { approve: approve }); await refresh(); }
    catch (e) { var p = $('reqs-panel'); p.insertAdjacentHTML('beforeend', '<div class="msg bad">' + esc(e.message) + '</div>'); }
  }
  function renderTeam() {
    renderBoard(); renderTeamCal(); renderDayDetail(); renderDateTable(); renderReqs();
    var ids = teamIds(), sel = $('m-filter'), cur = S.filter;
    if (document.activeElement !== sel) sel.innerHTML = '<option value="">전체</option>' + ids.map(function (id) { return '<option value="' + esc(id) + '"' + (id === cur ? ' selected' : '') + '>' + esc(nameOf(id)) + '</option>'; }).join('');
    if ($('m-sel').value !== S.month) $('m-sel').value = S.month;
    var adm = isAdmin();
    $('f-start').hidden = $('f-end').hidden = $('btn-defaults').hidden = $('btn-add').hidden = $('btn-code').hidden = !adm;
    if (document.activeElement !== $('s-start')) $('s-start').value = S.defaults.start;
    if (document.activeElement !== $('s-end')) $('s-end').value = S.defaults.end;
    var rows = monthRows(), late = 0, miss = 0, chk = 0;
    rows.forEach(function (r) { r.f.forEach(function (x) { if (x.t === '지각') late++; if (x.t === '퇴근 누락') miss++; }); if (r.f.some(function (x) { return x.c === 'bad' && x.t !== '퇴근 누락'; })) chk++; });
    $('team-stats').innerHTML = '<span>기록 <b>' + rows.length + '</b>건</span><span>지각 <b>' + late + '</b></span><span>퇴근 누락 <b>' + miss + '</b></span><span>확인 필요 <b>' + chk + '</b></span>';
    var by = {};
    rows.forEach(function (r) { var o = by[r.uid] = by[r.uid] || { n: 0, ms: 0, late: 0, miss: 0, chk: 0 }; o.n++; if (r.d.in && r.d.out && r.d.out > r.d.in) o.ms += r.d.out - r.d.in; r.f.forEach(function (x) { if (x.t === '지각') o.late++; else if (x.t === '퇴근 누락') o.miss++; else if (x.c === 'bad') o.chk++; }); });
    var sk = Object.keys(by).sort(byName);
    $('team-sum').innerHTML = sk.length ? '<table><thead><tr><th>이름</th><th class="r">근무일</th><th class="r">총 근무 시간</th><th class="r">지각</th><th class="r">퇴근 누락</th><th class="r">확인 필요</th></tr></thead><tbody>' + sk.map(function (id) { var o = by[id]; return '<tr class="' + (id === S.me.id ? 'me' : '') + '"><td>' + esc(nameOf(id)) + '</td><td class="r num">' + o.n + '</td><td class="r num">' + dur(o.ms) + '</td><td class="r num">' + o.late + '</td><td class="r num">' + o.miss + '</td><td class="r num">' + o.chk + '</td></tr>'; }).join('') + '</tbody></table>' : '<div class="empty">이 달에는 기록이 없습니다.</div>';
    $('team-list').innerHTML = rows.length ? '<table><thead><tr><th>날짜</th><th>이름</th><th>출근</th><th>퇴근</th><th>근무 시간</th><th>상태</th>' + (adm ? '<th></th>' : '') + '</tr></thead><tbody>' + rows.map(function (r, i) {
      var d = r.d, w = d.in && d.out && d.out > d.in ? dur(d.out - d.in) : '–';
      var adj = d.adj && d.adj.length ? '<div class="sub">' + esc(d.adj[d.adj.length - 1].reason) + ' (' + d.adj.length + '회 보정)</div>' : '';
      return '<tr class="' + (r.uid === S.me.id ? 'me' : '') + '"><td class="num">' + r.date.slice(5) + ' (' + wday(r.date) + ')</td><td>' + esc(nameOf(r.uid)) + '</td><td class="num">' + (d.in ? kst(d.in).hm : '–') + '</td><td class="num">' + (d.out ? kst(d.out).hm : '–') + '</td><td>' + w + '</td><td>' + pills(r.f) + adj + '</td>' + (adm ? '<td><button class="btn small" data-fix="' + i + '">보정</button></td>' : '') + '</tr>';
    }).join('') + '</tbody></table>' : '<div class="empty">이 달에는 기록이 없습니다.</div>';
    S._rows = rows;
  }
  function openForm(pre) {
    S.form = pre || { uid: '', date: kst(now()).key, in: '', out: '' };
    var ids = teamIds(), f = S.form, p = $('form-panel');
    p.hidden = false;
    p.innerHTML = '<div class="formtitle">' + (f.uid ? '기록 보정' : '기록 추가') + '</div><p class="hint">보정하면 이전 값과 사유가 기록에 남고, 삭제는 할 수 없습니다.</p><div class="formrow">' +
      '<label class="field">팀원<select id="f-uid">' + ids.map(function (id) { return '<option value="' + esc(id) + '"' + (id === f.uid ? ' selected' : '') + '>' + esc(nameOf(id)) + '</option>'; }).join('') + '</select></label>' +
      '<label class="field">날짜<input type="date" id="f-date" value="' + esc(f.date) + '"></label>' +
      '<label class="field">출근<input type="time" id="f-in" value="' + esc(f.in) + '"></label>' +
      '<label class="field">퇴근<input type="time" id="f-out" value="' + esc(f.out) + '"></label></div>' +
      '<label class="field" style="margin-bottom:12px">사유 (필수)<input type="text" id="f-reason" maxlength="200" placeholder="예: 본인 확인 후 수정"></label>' +
      '<div class="pills"><button class="btn primary" id="f-save">저장</button><button class="btn" id="f-cancel">닫기</button></div><div id="f-msg"></div>';
    p.scrollIntoView({ block: 'nearest' });
  }
  async function saveForm() {
    var uid = $('f-uid').value, date = $('f-date').value, tin = $('f-in').value, tout = $('f-out').value, reason = $('f-reason').value.trim();
    if (!uid || !date) return notice('f-msg', 'bad', '팀원과 날짜를 선택하세요.');
    if (!tin && !tout) return notice('f-msg', 'bad', '출근 또는 퇴근 시각을 입력하세요.');
    if (!reason) return notice('f-msg', 'bad', '사유를 입력하세요.');
    try { await api('POST', '/api/admin/records', { userId: Number(uid), date: date, in: tin || null, out: tout || null, reason: reason }); S.form = null; $('form-panel').hidden = true; await refresh(); }
    catch (e) { notice('f-msg', 'bad', e.message); }
  }
  async function saveDefaults() {
    var a = $('s-start').value, b = $('s-end').value; if (!a || !b) return;
    try { await api('PUT', '/api/admin/defaults', { start: a, end: b }); S.defaults = { start: a, end: b }; await refresh(); } catch (e) {}
  }
  async function showCode() {
    try { var r = await api('GET', '/api/admin/info'); $('code-box').innerHTML = '<p class="hint">팀원에게 알려 줄 가입 코드: <span class="codebox">' + esc(r.signupCode) + '</span> (가입한 인원 ' + r.users + '명)</p>'; }
    catch (e) { notice('code-box', 'bad', e.message); }
  }
  function cell(v) { v = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; }
  function exportCsv() {
    var lines = [['이름', '날짜', '요일', '출근', '퇴근', '근무시간(분)', '상태', '보정 사유'].map(cell).join(',')].concat(monthRows().slice().reverse().map(function (r) {
      var d = r.d, w = d.in && d.out && d.out > d.in ? Math.round((d.out - d.in) / 60000) : '';
      return [nameOf(r.uid), r.date, wday(r.date), d.in ? kst(d.in).hm : '', d.out ? kst(d.out).hm : '', w, r.f.map(function (x) { return x.t; }).join(' / '), (d.adj || []).map(function (a) { return a.reason; }).join(' / ')].map(cell).join(',');
    }));
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = '출퇴근_' + S.month + '.csv'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  /* ---------- 로그인 · 가입 ---------- */
  function setAuthMode(m) {
    S.authMode = m;
    document.querySelectorAll('[data-auth]').forEach(function (t) { t.setAttribute('aria-selected', String(t.dataset.auth === m)); });
    var su = m === 'signup';
    $('a-name-w').hidden = $('a-pw2-w').hidden = $('a-code-w').hidden = !su;
    $('a-pw').autocomplete = su ? 'new-password' : 'current-password';
    $('a-submit').textContent = su ? '가입하기' : '로그인';
    $('a-hint').textContent = su ? '비밀번호는 10자 이상으로 정하세요. 가입 코드는 관리자에게 받습니다. 가장 먼저 가입한 사람이 관리자가 됩니다.' : '';
    $('a-msg').innerHTML = '';
  }
  async function submitAuth(e) {
    e.preventDefault();
    var m = S.authMode, email = $('a-email').value.trim(), pw = $('a-pw').value;
    if (!email || !pw) return notice('a-msg', 'bad', '이메일과 비밀번호를 입력하세요.');
    $('a-submit').disabled = true;
    try {
      if (m === 'signup') {
        var name = $('a-name').value.trim(), pw2 = $('a-pw2').value, code = $('a-code').value.trim();
        if (!name) throw new Error('이름을 입력하세요.');
        if (pw.length < 10) throw new Error('비밀번호는 10자 이상이어야 합니다.');
        if (pw !== pw2) throw new Error('비밀번호 확인이 일치하지 않습니다.');
        if (!code) throw new Error('가입 코드를 입력하세요.');
        await api('POST', '/api/signup', { email: email, name: name, password: pw, code: code });
      } else await api('POST', '/api/login', { email: email, password: pw });
      $('a-pw').value = $('a-pw2').value = $('a-code').value = '';
      await refresh();
    } catch (err) { notice('a-msg', 'bad', err.message); }
    finally { $('a-submit').disabled = false; }
  }
  async function logout() { try { await api('POST', '/api/logout'); } catch (e) {} S.me = null; S.docs = {}; S.open = null; setAuthMode('login'); renderAll(); }

  /* ---------- 이벤트 ---------- */
  function setView(v) {
    S.view = v;
    $('v-mine').hidden = v !== 'mine'; $('v-team').hidden = v !== 'team';
    document.querySelectorAll('.tab[data-v]').forEach(function (t) { t.setAttribute('aria-selected', String(t.dataset.v === v)); });
    try { history.replaceState(null, '', '#' + v); } catch (e) {}
    if (v === 'team') renderTeam();
  }
  async function changeMonth(fn) { fn(); await loadRecords().catch(function () {}); S.selDay = null; renderAll(); }

  document.addEventListener('click', function (e) {
    var day = e.target.closest('[data-day]');
    if (day && !e.target.closest('.btn')) { selectDay(day.dataset.day, e.target.closest('[data-uid]') ? e.target.closest('[data-uid]').dataset.uid : null); return; }
    var t = e.target.closest('button'); if (!t) return;
    if (t.id === 'punch') punch(t.dataset.kind);
    else if (t.dataset.auth) setAuthMode(t.dataset.auth);
    else if (t.classList.contains('tab')) setView(t.dataset.v);
    else if (t.id === 'm-prev' || t.id === 't-prev') changeMonth(function () { shiftMonth(-1); });
    else if (t.id === 'm-next' || t.id === 't-next') changeMonth(function () { shiftMonth(1); });
    else if (t.id === 'btn-req') openReq();
    else if (t.dataset.reqdate) openReq(t.dataset.reqdate);
    else if (t.id === 'r-save') saveReq();
    else if (t.id === 'r-cancel') $('req-panel').hidden = true;
    else if (t.id === 'p-save') saveSettings();
    else if (t.id === 'pw-save') savePassword();
    else if (t.id === 'btn-logout') logout();
    else if (t.id === 'btn-add') openForm();
    else if (t.id === 'btn-csv') exportCsv();
    else if (t.id === 'btn-defaults') saveDefaults();
    else if (t.id === 'btn-code') showCode();
    else if (t.id === 'f-save') saveForm();
    else if (t.id === 'f-cancel') { S.form = null; $('form-panel').hidden = true; }
    else if (t.dataset.fix != null) { var r = S._rows[+t.dataset.fix]; openForm({ uid: r.uid, date: r.date, in: r.d.in ? kst(r.d.in).hm : '', out: r.d.out ? kst(r.d.out).hm : '' }); }
    else if (t.dataset.dec) decide(t.dataset.r, t.dataset.dec === 'ok');
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.dataset && t.dataset.cmp) {
      var cur = selected(), id = t.dataset.cmp, i = cur.indexOf(id);
      if (t.checked && i < 0) cur.push(id); else if (!t.checked && i >= 0) cur.splice(i, 1);
      S.cmp = cur; lsSet('cmp', JSON.stringify(cur)); renderCompare();
    }
  });
  $('auth-form').addEventListener('submit', submitAuth);
  $('m-sel').addEventListener('change', function (e) { if (e.target.value) changeMonth(function () { S.month = e.target.value; }); });
  $('m-filter').addEventListener('change', function (e) { S.filter = e.target.value; renderTeam(); });

  renderClock();
  setInterval(function () { renderClock(); if (S.me && !$('app').hidden && S.open) renderToday(); }, 1000);
  setInterval(function () { if (S.me && !document.hidden && !S.busy) refresh(); }, 20000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && S.me) refresh(); });

  setAuthMode('login');
  var h = (location.hash || '').replace('#', ''); if (h === 'team') S.view = 'team';
  refresh().then(function () { setView(S.view); });
})();
