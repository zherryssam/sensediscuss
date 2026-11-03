/**
 * 오감 중요도 수업 - Google Apps Script 백엔드
 *
 * - 수업 상태는 CacheService(빠름)에 보관하고, 30초마다/단계가 바뀔 때 'snapshots' 시트에 백업합니다.
 *   (캐시가 비워져도 시트에서 복구됩니다.)
 * - 결과는 'result-방코드' 시트에 사람이 읽기 쉬운 표로도 저장됩니다.
 * - 프런트(GitHub Pages)는 이 웹앱 주소(/exec)를 2초 간격으로 폴링합니다.
 */

// 교사 비밀번호: 비워 두면 누구나 방을 만들 수 있어요. 꼭 바꿔서 쓰세요!
const TEACHER_PASSWORD = '';

const MAX_PARTICIPANTS = 100;
const CACHE_TTL = 21600; // 6시간(캐시 최대치)

const SENSES = [
  { id: 'sight', emoji: '👁️', name: '시각', color: '#2563eb' },
  { id: 'hearing', emoji: '👂', name: '청각', color: '#7c3aed' },
  { id: 'smell', emoji: '👃', name: '후각', color: '#16a34a' },
  { id: 'taste', emoji: '👅', name: '미각', color: '#db2777' },
  { id: 'touch', emoji: '✋', name: '촉각', color: '#ea580c' },
];
const IDS = SENSES.map(function (s) { return s.id; });
const PHASES = ['prevote', 'reasons', 'rank', 'result']; // 사전투표+이유 → 이유 모아보기 → 순위 정하기 → 발표

/* ============ 진입점 ============ */
function doGet(e) {
  return handle_((e && e.parameter) || {}, false);
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse((e.postData && e.postData.contents) || '{}'); } catch (err) {}
  return handle_(body, true);
}

function handle_(p, isPost) {
  try {
    switch (p.a) {
      case 'ping': return out_({ ok: true, needPassword: !!TEACHER_PASSWORD });
      case 'state': return out_(pollState_(p));
    }
    if (!isPost) return out_({ error: '잘못된 요청이에요' });
    switch (p.a) {
      case 'create': return out_(create_(p));
      case 'join': return out_(join_(p));
      case 'act': return out_(act_(p));
      case 'csv': return out_({ csv: resultCsv_(hostRoom_(p)) });
      case 'sheet': return out_({ url: writeResultSheet_(hostRoom_(p)) });
    }
    return out_({ error: '알 수 없는 요청이에요' });
  } catch (err) {
    return out_({ error: (err && err.message) || String(err) });
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ============ 저장소 (캐시 + 시트 백업) ============ */
function cache_() { return CacheService.getScriptCache(); }

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function loadRoom_(code) {
  code = String(code || '');
  var raw = cache_().get('room:' + code);
  if (raw) return JSON.parse(raw);
  var room = restore_(code);
  if (room) cache_().put('room:' + code, JSON.stringify(room), CACHE_TTL);
  return room;
}

function saveRoom_(room, force) {
  room.v++;
  if (force || Date.now() - room.snapAt > 30000) {
    room.snapAt = Date.now();
    try { snapshot_(room); } catch (err) { /* 시트 오류가 수업을 막지 않도록 */ }
  }
  var json = JSON.stringify(room);
  if (json.length > 95000) throw new Error('데이터가 너무 커서 저장할 수 없어요');
  cache_().put('room:' + room.code, json, CACHE_TTL);
}

function ss_() {
  var s = SpreadsheetApp.getActiveSpreadsheet();
  if (s) return s;
  return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
}

function sheet_(name, header) {
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (header) sh.appendRow(header);
  }
  return sh;
}

function snapshot_(room) {
  var sh = sheet_('snapshots', ['방 코드', '갱신 시각', '데이터(JSON)']);
  var rows = sh.getDataRange().getValues();
  var json = JSON.stringify(room);
  if (json.length > 49000) return; // 셀 한도
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === room.code) {
      sh.getRange(i + 1, 1, 1, 3).setValues([[room.code, new Date(), json]]);
      return;
    }
  }
  sh.appendRow([room.code, new Date(), json]);
}

function restore_(code) {
  var sh = ss_().getSheetByName('snapshots');
  if (!sh) return null;
  var rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === code) {
      try { return JSON.parse(rows[i][2]); } catch (err) { return null; }
    }
  }
  return null;
}

/* ============ 유틸 ============ */
function uid_(prefix) { return prefix + Utilities.getUuid().replace(/-/g, '').slice(0, 10); }
function clean_(s, max) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max); }
function sense_(id) { return SENSES.filter(function (s) { return s.id === id; })[0]; }
function parts_(room) { return Object.keys(room.ps).map(function (pid) { return room.ps[pid]; }); }
function byRid_(room, rid) { return parts_(room).filter(function (p) { return p.rid === rid; })[0]; }

function newRoom_(code) {
  return {
    code: code, token: uid_('t'), v: 0, snapAt: 0, createdAt: Date.now(),
    phase: 'prevote',
    anon: false,      // 이유 공개 시 닉네임 숨김
    spotlight: null,  // 모두에게 크게 보여줄 이유(rid)
    timerEnd: 0,
    revealed: 0,      // 발표된 순위 수(5위부터 공개)
    ps: {},           // pid -> { pid, rid, name, pick, reason, hidden, likes:[pid], rank:[ids]|null }
  };
}

function hostRoom_(p) {
  var room = loadRoom_(p.code);
  if (!room) throw new Error('없는 방이에요. 코드를 확인해 주세요');
  if (!p.token || p.token !== room.token) throw new Error('교사만 사용할 수 있어요');
  return room;
}

/* ============ 방 만들기 / 입장 / 액션 ============ */
function create_(p) {
  if (TEACHER_PASSWORD && String(p.password || '') !== TEACHER_PASSWORD) throw new Error('교사 비밀번호가 맞지 않아요');
  return withLock_(function () {
    var code;
    do { code = String(Math.floor(1000 + Math.random() * 9000)); } while (cache_().get('room:' + code) || restore_(code));
    var room = newRoom_(code);
    saveRoom_(room, true);
    return { code: code, id: room.token };
  });
}

function join_(p) {
  return withLock_(function () {
    var room = loadRoom_(p.code);
    if (!room) throw new Error('없는 방이에요. 코드를 확인해 주세요');
    var name = clean_(p.name, 8);
    if (!name) throw new Error('이름을 입력해 주세요');
    if (Object.keys(room.ps).length >= MAX_PARTICIPANTS) throw new Error('방이 가득 찼어요');
    var pid = uid_('p');
    room.ps[pid] = { pid: pid, rid: uid_('r'), name: name, pick: null, reason: '', hidden: false, likes: [], rank: null };
    saveRoom_(room, false);
    return { id: pid, state: stateFor_(room, { pid: pid }) };
  });
}

function act_(p) {
  return withLock_(function () {
    var room = loadRoom_(p.code);
    if (!room) throw new Error('없는 방이에요. 코드를 확인해 주세요');
    var isHost = !!p.token && p.token === room.token;
    var viewer = isHost ? { host: true } : { pid: p.pid };
    var phaseBefore = room.phase;
    if (isHost) hostAct_(room, p); else studentAct_(room, p);
    saveRoom_(room, room.phase !== phaseBefore);
    if (isHost && room.phase === 'result' && phaseBefore !== 'result') {
      try { writeResultSheet_(room); } catch (err) {}
    }
    return { ok: true, state: stateFor_(room, viewer) };
  });
}

function hostAct_(room, b) {
  switch (b.type) {
    case 'setPhase':
      if (PHASES.indexOf(b.phase) < 0) throw new Error('잘못된 요청이에요');
      room.phase = b.phase;
      room.revealed = 0;
      room.timerEnd = 0;
      if (b.phase !== 'reasons') room.spotlight = null;
      break;
    case 'toggleAnon':
      room.anon = !room.anon;
      break;
    case 'spotlight': {
      var t = b.rid ? byRid_(room, b.rid) : null;
      room.spotlight = t && t.reason ? t.rid : null;
      break;
    }
    case 'hideReason': {
      var h = byRid_(room, b.rid);
      if (h) { h.hidden = !!b.hidden; if (h.hidden && room.spotlight === h.rid) room.spotlight = null; }
      break;
    }
    case 'timer': {
      var sec = Math.max(0, Math.min(1800, Number(b.sec) || 0));
      room.timerEnd = sec ? Date.now() + sec * 1000 : 0;
      break;
    }
    case 'reveal':
      if (room.phase !== 'result') throw new Error('발표 단계에서만 가능해요');
      room.revealed = b.all ? IDS.length : Math.max(0, Math.min(IDS.length, room.revealed + (Number(b.delta) || 0)));
      break;
    default:
      throw new Error('알 수 없는 요청이에요');
  }
}

function studentAct_(room, b) {
  var me = room.ps[b.pid];
  if (!me) throw new Error('입장 정보가 없어요');
  switch (b.type) {
    case 'pick':
      if (room.phase !== 'prevote') throw new Error('사전 투표 시간이 끝났어요');
      if (!sense_(b.caseId)) throw new Error('잘못된 선택이에요');
      me.pick = b.caseId;
      break;
    case 'reason': {
      if (room.phase !== 'prevote') throw new Error('이유 작성 시간이 끝났어요');
      if (!me.pick) throw new Error('먼저 감각을 골라 주세요');
      var text = clean_(b.text, 150);
      if (!text) throw new Error('이유를 입력해 주세요');
      me.reason = text;
      break;
    }
    case 'like': {
      if (room.phase !== 'reasons') throw new Error('지금은 공감할 수 없어요');
      var t = byRid_(room, b.rid);
      if (!t || t === me) break;
      var i = t.likes.indexOf(me.pid);
      if (i >= 0) t.likes.splice(i, 1); else t.likes.push(me.pid);
      break;
    }
    case 'rank': {
      if (room.phase !== 'rank') throw new Error('지금은 순위를 제출할 수 없어요');
      var order = Array.isArray(b.order) ? b.order : [];
      var ok = order.length === IDS.length && IDS.every(function (id) { return order.indexOf(id) >= 0; });
      if (!ok) throw new Error('1위부터 5위까지 모두 정해 주세요');
      me.rank = order;
      break;
    }
    default:
      throw new Error('알 수 없는 요청이에요');
  }
}

/* ============ 집계 ============ */
// n위 감각에 n점. 총점이 낮을수록 중요 → 동점이면 1위로 뽑힌 수가 많은 쪽, 그래도 같으면 공동 순위
function rankings_(room) {
  var items = SENSES.map(function (s) { return { id: s.id, score: 0, firsts: 0 }; });
  var voters = 0;
  parts_(room).forEach(function (p) {
    if (!p.rank) return;
    voters++;
    p.rank.forEach(function (id, i) {
      var it = items.filter(function (x) { return x.id === id; })[0];
      it.score += i + 1;
      if (i === 0) it.firsts++;
    });
  });
  items.sort(function (a, b) { return a.score - b.score || b.firsts - a.firsts || IDS.indexOf(a.id) - IDS.indexOf(b.id); });
  items.forEach(function (it, i) {
    var prev = items[i - 1];
    it.rank = prev && prev.score === it.score && prev.firsts === it.firsts ? prev.rank : i + 1;
    it.avg = voters ? Math.round((it.score / voters) * 100) / 100 : 0;
  });
  return { items: items, voters: voters };
}

function pickCounts_(room) {
  var out = {};
  IDS.forEach(function (id) { out[id] = 0; });
  parts_(room).forEach(function (p) { if (p.pick) out[p.pick]++; });
  return out;
}

function publicReason_(room, p, viewerPid, isHost) {
  return {
    rid: p.rid,
    sense: p.pick,
    name: isHost || !room.anon ? p.name : '익명',
    text: p.reason,
    likes: p.likes.length,
    liked: viewerPid ? p.likes.indexOf(viewerPid) >= 0 : false,
    mine: viewerPid ? viewerPid === p.pid : false,
    hidden: p.hidden,
  };
}

/* ============ 상태 조회 (폴링) ============ */
function pollState_(p) {
  var room = loadRoom_(p.code);
  if (!room) return { gone: true };
  var isHost = !!p.token;
  if (isHost ? p.token !== room.token : !room.ps[p.pid]) return { gone: true };
  var res = {};
  if (isHost) res.online = onlineCount_(room);
  else cache_().put('seen:' + room.code + ':' + p.pid, '1', 20); // 접속 중 표시(교사 화면용)
  if (Number(p.v) === room.v) { res.same = true; res.v = room.v; return res; }
  res.state = stateFor_(room, isHost ? { host: true } : { pid: p.pid });
  return res;
}

function onlineCount_(room) {
  var keys = Object.keys(room.ps).map(function (pid) { return 'seen:' + room.code + ':' + pid; });
  if (!keys.length) return 0;
  return Object.keys(cache_().getAll(keys)).length;
}

function stateFor_(room, viewer) {
  var isHost = !!viewer.host;
  var me = isHost ? null : room.ps[viewer.pid];
  var parts = parts_(room);
  var showReasons = isHost || room.phase !== 'prevote';
  var reasons = showReasons
    ? parts.filter(function (p) { return p.pick && p.reason && (isHost || !p.hidden); })
        .map(function (p) { return publicReason_(room, p, viewer.pid, isHost); })
    : [];
  var spot = reasons.filter(function (r) { return r.rid === room.spotlight && !r.hidden; })[0];

  var st = {
    v: room.v,
    now: Date.now(),
    code: room.code,
    phase: room.phase,
    senses: SENSES,
    anon: room.anon,
    joined: parts.length,
    progress: {
      picked: parts.filter(function (p) { return p.pick; }).length,
      reasoned: parts.filter(function (p) { return p.reason; }).length,
      ranked: parts.filter(function (p) { return p.rank; }).length,
    },
    counts: showReasons ? pickCounts_(room) : null,
    reasons: reasons,
    spotlight: spot || null,
    timerEnd: room.timerEnd,
    me: me ? { name: me.name, pick: me.pick, reason: me.reason, rank: me.rank } : null,
    result: null,
  };

  if (room.phase === 'result') {
    var rk = rankings_(room);
    st.result = { revealed: room.revealed, voters: rk.voters, items: rk.items.slice(IDS.length - room.revealed) }; // 5위부터 한 칸씩 공개
    if (room.revealed === IDS.length) {
      st.result.shift = parts.filter(function (p) { return p.pick && p.rank && p.rank[0] !== p.pick; }).length;
      st.result.best = {};
      IDS.forEach(function (id) {
        var top = parts.filter(function (p) { return p.pick === id && p.reason && !p.hidden; })
          .sort(function (a, b) { return b.likes.length - a.likes.length; })[0];
        st.result.best[id] = top && top.likes.length ? publicReason_(room, top, null, false) : null;
      });
      st.result.picks = pickCounts_(room);
    }
  }
  if (isHost) {
    st.people = parts.map(function (p) { return { name: p.name, pick: p.pick, ranked: !!p.rank }; });
  }
  return st;
}

/* ============ 결과 내보내기 ============ */
function csvCell_(v) {
  var s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // 스프레드시트 수식 주입 방지
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function resultTable_(room) {
  var rows = [['닉네임', '사전투표(살리고 싶은 감각)', '이유', '공감수']
    .concat(SENSES.map(function (s) { return s.name + ' 순위'; }))
    .concat(['1위가 사전투표와 다름'])];
  parts_(room).forEach(function (p) {
    var pickName = p.pick ? sense_(p.pick).name : '';
    rows.push([p.name, pickName, p.reason || '', p.likes.length]
      .concat(SENSES.map(function (s) { return p.rank ? p.rank.indexOf(s.id) + 1 : ''; }))
      .concat([p.rank && p.pick ? (p.rank[0] !== p.pick ? 'Y' : '') : '']));
  });
  var rk = rankings_(room);
  rows.push([]);
  rows.push(['우리 반 감각 중요도 순위', '(순위 제출 ' + rk.voters + '명 · 점수가 낮을수록 중요)']);
  rows.push(['순위', '감각', '총점', '평균', '1위 득표']);
  rk.items.forEach(function (it) { rows.push([it.rank, sense_(it.id).name, it.score, it.avg, it.firsts]); });
  return rows;
}

function resultCsv_(room) {
  return '﻿' + resultTable_(room).map(function (r) { return r.map(csvCell_).join(','); }).join('\r\n');
}

// 'result-방코드' 시트에 결과표 저장 → 시트 주소 반환
function writeResultSheet_(room) {
  var rows = resultTable_(room);
  var width = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 1);
  var table = rows.map(function (r) { var c = r.slice(); while (c.length < width) c.push(''); return c; });
  var sh = sheet_('result-' + room.code);
  sh.clear();
  sh.getRange(1, 1, table.length, width).setValues(table);
  sh.setFrozenRows(1);
  return ss_().getUrl() + '#gid=' + sh.getSheetId();
}
