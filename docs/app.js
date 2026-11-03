// 오감 중요도 수업 클라이언트 (학생/교사 공용). body[data-role] 로 역할 구분
// 1 사전투표+이유 → 2 이유 모아보기 → 3 순위 정하기(1~5위) → 4 우리 반 감각 중요도 순위 발표
(() => {
  const ROLE = document.body.dataset.role;
  const IS_HOST = ROLE === 'host';
  const store = IS_HOST ? localStorage : sessionStorage; // 학생은 탭마다 따로(테스트 편의)
  const KEY = 'osam-' + ROLE;
  const $ = s => document.querySelector(s);
  const PHASES = ['prevote', 'reasons', 'rank', 'result'];
  const STEP_NAMES = ['사전 투표·이유', '이유 모아보기', '순위 정하기', '순위 발표'];
  const NEXT_LABEL = { prevote: '이유 모아보기 ▶', reasons: '순위 정하기 ▶', rank: '📣 순위 발표 ▶' };

  let session = null; // { code, id }
  let S = null;       // 서버에서 받은 최신 상태
  let version = -1;          // 마지막으로 받은 상태 버전(바뀐 게 없으면 서버가 가볍게 응답)
  let clockOffset = 0;       // 서버 시각 - 내 시각 (타이머 보정)
  let pollTimer = null;
  let pollFails = 0;
  let online = 0;            // 교사 화면용: 최근 접속 중인 학생 수
  const API = window.OSAM_API;
  let lastPhase = null;
  let draft = null;          // 내 순위 초안(제출 전)
  let reasonLoaded = false;  // 이유 입력창에 저장된 내용을 한 번만 채움
  let lastRevealed = 0;
  let confettiDone = false;

  try { session = JSON.parse(store.getItem(KEY)); } catch {}

  /* ---------- 공통 유틸 ---------- */
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove('show'), 2400);
  }

  // Apps Script 웹앱 호출. Content-Type을 지정하지 않아(text/plain) CORS 사전 요청 없이 GitHub Pages에서 호출돼요.
  async function call(method, params) {
    let r;
    try {
      r = method === 'POST'
        ? await fetch(API, { method: 'POST', body: JSON.stringify(params) })
        : await fetch(API + '?' + new URLSearchParams(params));
    } catch { throw new Error('서버에 연결할 수 없어요. 인터넷을 확인해 주세요'); }
    const j = await r.json().catch(() => { throw new Error('서버 응답을 읽을 수 없어요. 배포 설정(접근 권한: 모든 사용자)을 확인해 주세요'); });
    if (j.error) throw new Error(j.error);
    return j;
  }

  /* ---------- 로딩 표시 ----------
   * 서버(Apps Script) 응답을 기다리는 동안: 상단 진행 막대 + 누른 버튼에 스피너(중복 클릭 차단)
   * + 1.2초 넘게 걸리면 안내 문구. 교사 화면은 처리 중에 다른 조작 버튼도 잠시 잠가요. */
  let inflight = 0;
  let lastTarget = null, lastTargetAt = 0;
  let hintTimer = null;

  document.addEventListener('click', e => {
    if (e.target.closest('.is-loading')) { e.preventDefault(); e.stopPropagation(); return; } // 처리 중인 버튼은 다시 눌리지 않게
    const b = e.target.closest('button, .pick, .opt, [role="button"]');
    if (b) { lastTarget = b; lastTargetAt = Date.now(); }
  }, true);

  const recentTarget = () => (Date.now() - lastTargetAt < 1500 && document.contains(lastTarget) ? lastTarget : null);

  function netHint(on) {
    const el = $('#netHint');
    clearTimeout(hintTimer);
    el.classList.toggle('show', on);
    if (!on) return;
    el.textContent = '⏳ 서버 응답을 기다리는 중…';
    hintTimer = setTimeout(() => { el.textContent = '⏳ 서버가 느려요. 조금만 더 기다려 주세요 (처음엔 몇 초 걸릴 수 있어요)'; }, 4000);
  }

  async function tracked(fn, el) {
    if (++inflight === 1) {
      document.body.classList.add('busy');
      clearTimeout(tracked.t);
      tracked.t = setTimeout(() => inflight && netHint(true), 1200);
    }
    if (el) { el.classList.add('is-loading'); el.setAttribute('aria-busy', 'true'); }
    try { return await fn(); }
    finally {
      if (--inflight === 0) { document.body.classList.remove('busy'); clearTimeout(tracked.t); netHint(false); }
      if (el) { el.classList.remove('is-loading'); el.removeAttribute('aria-busy'); }
    }
  }

  // 일반 요청(입장·방 만들기·다운로드 등): 누른 버튼에 로딩 표시
  const post = (body, el = recentTarget()) => tracked(() => call('POST', body), el);

  function applyState(st) {
    if (!st || st.v < version) return; // 늦게 도착한 옛 상태는 무시
    version = st.v;
    clockOffset = st.now - Date.now();
    S = st;
    hideLoading();
    render();
  }

  // 수업 중 동작(선택·공감·단계 이동 등): 응답 상태를 화면에 반영한 뒤에 로딩 표시를 걷어요
  function act(type, data = {}) {
    const el = recentTarget();
    return tracked(() => call('POST', { a: 'act', code: session.code, [IS_HOST ? 'token' : 'pid']: session.id, type, ...data })
      .then(j => { applyState(j.state); return j; }), el)
      .catch(e => { toast(e.message); throw e; });
  }

  // 처음 접속/새로고침 때 첫 상태를 받을 때까지 전체 화면 로딩
  let loadTimer = null;
  function showLoading(msg) {
    const o = $('#loading');
    o.hidden = false;
    $('#loadMsg').textContent = msg;
    $('#loadSub').textContent = '';
    $('#loadReset').hidden = true;
    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => {
      $('#loadSub').textContent = '서버를 깨우는 중이에요. 처음엔 몇 초 걸릴 수 있어요 ⏳';
      loadTimer = setTimeout(() => { $('#loadReset').hidden = false; }, 6000);
    }, 3000);
  }
  function hideLoading() {
    clearTimeout(loadTimer);
    $('#loading').hidden = true;
  }
  $('#loadReset').onclick = () => { store.removeItem(KEY); session = null; S = null; version = -1; clearTimeout(pollTimer); hideLoading(); setSync('ok'); };

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const sOf = id => S.senses.find(s => s.id === id);
  const tint = (el, id) => { el.style.setProperty('--c', sOf(id).color); return el; };
  const mmss = ms => {
    const s = Math.ceil(Math.max(0, ms) / 1000);
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  };

  /* ---------- 뼈대 ---------- */
  const hostBar = IS_HOST ? `
    <section class="card host-bar">
      <div class="join-info">학생 접속 주소 <b id="joinUrl">...</b> · 방 코드 <b class="big-code" id="bigCode"></b></div>
      <div class="btn-row" id="navBtns"></div>
      <div class="btn-row tools">
        <span class="pill" id="prog"></span>
        <button class="btn sm" id="btnAnon"></button>
        <span class="tgroup">⏱
          <button class="btn sm" data-sec="60">1분</button><button class="btn sm" data-sec="180">3분</button>
          <button class="btn sm" data-sec="300">5분</button><button class="btn sm" data-sec="0">끄기</button>
        </span>
        <button class="btn sm" id="btnCsv">📥 결과 CSV</button>
        <button class="btn sm" id="btnSheet">📊 구글시트에 저장</button>
      </div>
    </section>` : '';

  function buildApp() {
    $('#app').innerHTML = `
      <header class="top">
        <div class="brand">🧠 오감 중요도 수업</div>
        <div class="meta">${IS_HOST ? '' : '<span id="who"></span> · '}방 <b id="roomCode"></b> · <span id="online"></span> <span id="conn" class="sync ok" title="서버와 연결됨"><i></i></span></div>
      </header>
      <ol class="steps" id="steps">${STEP_NAMES.map((n, i) => `<li><i>${i + 1}</i><span>${n}</span></li>`).join('')}</ol>
      ${hostBar}
      <div id="timerBar" class="timer-bar" hidden>⏱ 남은 시간 <b id="timerText"></b></div>

      <section id="v-prevote" hidden>
        <div class="card">
          <h2>① 내가 살리고 싶은 감각은?</h2>
          <p class="sub">오감 중 딱 하나만 지킬 수 있다면, 어떤 감각을 고르겠어요?</p>
          <div class="picks" id="picks"></div>
        </div>
        ${IS_HOST ? '' : `<form class="card" id="rForm" hidden>
          <h2 id="rTitle"></h2>
          <textarea id="rText" maxlength="150" rows="3" placeholder="예) 위험한 상황을 눈으로 보고 피할 수 있어야 하기 때문이에요."></textarea>
          <div class="r-foot"><small id="rCount">0 / 150</small><button class="btn primary" id="rBtn">이유 등록</button></div>
          <p class="ok-note" id="rNote"></p>
        </form>`}
        ${IS_HOST ? '<div class="card"><h3>실시간 이유 <small id="liveCount"></small></h3><ul class="reason-list" id="liveReasons"></ul></div>' : ''}
      </section>

      <section id="v-reasons" hidden>
        <div class="spot" id="spot" hidden></div>
        <div class="card intro"><h2>② 친구들은 왜 그 감각을 골랐을까?</h2>
          <p class="sub">감각별로 모인 이유를 읽어 보세요. ${IS_HOST ? '' : '마음에 드는 이유엔 👍 공감을 눌러요.'}</p></div>
        <div id="groups"></div>
      </section>

      <section id="v-rank" hidden>
        <div class="card">
          <h2>③ 내가 생각하는 감각 중요도 순위</h2>
          <p class="sub">가장 중요한 감각이 <b>1위</b>! ${IS_HOST ? '' : '▲▼ 버튼으로 순서를 바꾸고 제출하세요.'}<br><small>n위 감각에 n점을 주고, 총점이 낮을수록 중요한 감각이에요.</small></p>
          ${IS_HOST ? '<div id="waiting"></div>' : '<ol class="rank-edit" id="rankEdit"></ol><button class="btn primary big" id="rankBtn">순위 제출</button><p class="ok-note" id="rankNote"></p>'}
        </div>
      </section>

      <section id="v-result" hidden>
        <div class="card result">
          <h2>📣 우리 반 감각 중요도 순위</h2>
          <p class="sub" id="resSub"></p>
          <ol class="res-list" id="resList"></ol>
          <div id="resHost" class="btn-row center"></div>
          <div id="resExtra" hidden></div>
        </div>
      </section>`;
    bindApp();
  }

  function bindApp() {
    if (IS_HOST) {
      $('#joinUrl').textContent = new URL('./', location.href).href.replace(/^https?:\/\//, '');
      $('#btnAnon').onclick = () => act('toggleAnon');
      document.querySelectorAll('[data-sec]').forEach(b => b.onclick = () => act('timer', { sec: +b.dataset.sec }));
      $('#btnCsv').onclick = async () => {
        try {
          const { csv } = await post({ a: 'csv', code: session.code, token: session.id });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
          a.download = '오감중요도_결과.csv';
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        } catch (e) { toast(e.message); }
      };
      $('#btnSheet').onclick = async () => {
        try {
          toast('구글시트에 저장하는 중…');
          const { url } = await post({ a: 'sheet', code: session.code, token: session.id });
          toast('저장했어요 ✅ 새 탭에서 시트를 열어요');
          window.open(url, '_blank', 'noopener');
        } catch (e) { toast(e.message); }
      };
    } else {
      const ta = $('#rText');
      ta.oninput = () => { $('#rCount').textContent = `${ta.value.length} / 150`; updateReasonBtn(); };
      $('#rForm').onsubmit = e => {
        e.preventDefault();
        act('reason', { text: ta.value }).then(() => toast('이유를 등록했어요 ✅'));
      };
      $('#rankBtn').onclick = () => act('rank', { order: draft }).then(() => toast('순위를 제출했어요 ✅'));
    }
  }

  /* ---------- 렌더링 ---------- */
  function render() {
    if (!S) return;
    if (!$('#steps')) buildApp();
    $('#join').hidden = true;
    $('#app').hidden = false;
    $('#roomCode').textContent = S.code;
    $('#online').textContent = IS_HOST ? `접속 ${online} / 참여 ${S.joined}명` : `참여 ${S.joined}명`;
    if (!IS_HOST) $('#who').textContent = '🙋 ' + S.me.name;

    const idx = PHASES.indexOf(S.phase);
    document.querySelectorAll('#steps li').forEach((li, i) => { li.className = i < idx ? 'done' : i === idx ? 'on' : ''; });
    for (const ph of PHASES) $('#v-' + ph).hidden = S.phase !== ph;

    if (S.phase !== lastPhase) {
      if (S.phase === 'rank' && !IS_HOST) draft = (S.me.rank || S.senses.map(s => s.id)).slice();
      if (S.phase !== 'result') { lastRevealed = 0; confettiDone = false; }
      window.scrollTo({ top: 0 });
    }
    if (IS_HOST) renderHost();
    ({ prevote: renderPrevote, reasons: renderReasons, rank: renderRank, result: renderResult })[S.phase]();
    lastPhase = S.phase;
    tick();
  }

  function renderHost() {
    $('#bigCode').textContent = S.code;
    const idx = PHASES.indexOf(S.phase);
    const nav = [];
    if (idx > 0) { const b = h('button', 'btn', '◀ 이전 단계'); b.onclick = () => act('setPhase', { phase: PHASES[idx - 1] }); nav.push(b); }
    if (NEXT_LABEL[S.phase]) { const b = h('button', 'btn primary', NEXT_LABEL[S.phase]); b.onclick = () => act('setPhase', { phase: PHASES[idx + 1] }); nav.push(b); }
    $('#navBtns').replaceChildren(...nav);
    const p = S.progress;
    $('#prog').textContent = S.phase === 'prevote' ? `이유 제출 ${p.reasoned} / ${S.joined}명`
      : S.phase === 'rank' ? `순위 제출 ${p.ranked} / ${S.joined}명` : `참여 ${S.joined}명`;
    $('#btnAnon').textContent = S.anon ? '🙈 익명 공개 중' : '🙂 이름 공개 중';
    $('#btnAnon').title = '학생 화면에서 이유 작성자 닉네임을 숨기거나 보여줘요';
  }

  const pickCard = (s, count, members) => {
    const b = h(IS_HOST ? 'div' : 'button', 'pick');
    tint(b, s.id);
    b.append(h('span', 'pe', s.emoji), h('span', 'pn', s.name));
    if (count != null) b.append(h('span', 'pc', `${count}명`));
    if (members) { const m = h('span', 'members'); m.append(...members.map(n => h('em', null, n))); b.append(m); }
    return b;
  };

  function renderPrevote() {
    const mine = IS_HOST ? null : S.me.pick;
    const byPick = {};
    if (IS_HOST) for (const p of S.people) if (p.pick) (byPick[p.pick] ||= []).push(p.name);
    $('#picks').replaceChildren(...S.senses.map(s => {
      const b = pickCard(s, IS_HOST ? (byPick[s.id] || []).length : null, IS_HOST ? byPick[s.id] || [] : null);
      if (!IS_HOST) {
        b.type = 'button';
        b.classList.toggle('on', mine === s.id);
        b.onclick = () => act('pick', { caseId: s.id });
      }
      return b;
    }));
    if (IS_HOST) {
      $('#liveCount').textContent = `(${S.reasons.length})`;
      $('#liveReasons').replaceChildren(...(S.reasons.length ? S.reasons.map(reasonItem) : [h('li', 'empty', '아직 제출된 이유가 없어요')]));
      return;
    }
    $('#rForm').hidden = !mine;
    if (mine) {
      const s = sOf(mine);
      tint($('#rForm'), mine);
      $('#rTitle').textContent = `② 왜 ${s.emoji} ${s.name}을(를) 지키고 싶나요?`;
      if (!reasonLoaded && S.me.reason) { $('#rText').value = S.me.reason; $('#rCount').textContent = `${S.me.reason.length} / 150`; }
      reasonLoaded = true;
      updateReasonBtn();
    }
  }

  function updateReasonBtn() {
    if (!S || IS_HOST) return;
    const v = $('#rText').value.trim(), saved = S.me.reason;
    $('#rBtn').textContent = saved ? '이유 수정' : '이유 등록';
    $('#rBtn').disabled = !v || v === saved;
    $('#rNote').textContent = saved && v === saved ? '✅ 등록 완료! 선생님이 다음 단계로 넘어갈 때까지 고쳐 쓸 수 있어요.' : '';
  }

  function reasonItem(r) {
    const li = tint(h('li', 'reason' + (r.hidden ? ' is-hidden' : '') + (r.mine ? ' mine' : '')), r.sense);
    const head = h('div', 'r-head');
    head.append(h('span', 'r-tag', `${sOf(r.sense).emoji} ${sOf(r.sense).name}`), h('b', null, r.name + (r.mine ? ' (나)' : '')));
    li.append(head, h('p', null, r.text));
    const foot = h('div', 'r-foot2');
    if (IS_HOST) {
      foot.append(h('span', 'likes', `👍 ${r.likes}`));
      if (S.phase === 'reasons') {
        const sp = h('button', 'link', S.spotlight?.rid === r.rid ? '📌 발표 해제' : '📌 크게 보기');
        sp.onclick = () => act('spotlight', { rid: S.spotlight?.rid === r.rid ? null : r.rid });
        foot.append(sp);
      }
      const hd = h('button', 'link', r.hidden ? '다시 보이기' : '숨기기');
      hd.onclick = () => act('hideReason', { rid: r.rid, hidden: !r.hidden });
      foot.append(hd);
    } else {
      const b = h('button', 'like' + (r.liked ? ' on' : ''), `👍 공감 ${r.likes}`);
      b.disabled = r.mine || S.phase !== 'reasons';
      b.onclick = () => act('like', { rid: r.rid });
      foot.append(b);
    }
    li.append(foot);
    return li;
  }

  function renderReasons() {
    const sp = $('#spot');
    sp.hidden = !S.spotlight;
    if (S.spotlight) {
      tint(sp, S.spotlight.sense);
      sp.replaceChildren(h('div', 'spot-tag', `📌 ${sOf(S.spotlight.sense).emoji} ${sOf(S.spotlight.sense).name}팀 · ${S.spotlight.name}`), h('p', null, S.spotlight.text));
    }
    $('#groups').replaceChildren(...S.senses.map(s => {
      const list = S.reasons.filter(r => r.sense === s.id);
      const g = tint(h('section', 'card group'), s.id);
      const head = h('div', 'g-head');
      head.append(h('span', 'ge', s.emoji), h('h3', null, s.name), h('span', 'gc', `${S.counts?.[s.id] ?? list.length}명이 선택`));
      const ul = h('ul', 'reason-list');
      ul.append(...(list.length ? list.map(reasonItem) : [h('li', 'empty', '이 감각을 고른 친구가 없어요')]));
      g.append(head, ul);
      return g;
    }));
  }

  function renderRank() {
    if (IS_HOST) {
      const missing = S.people.filter(p => !p.ranked).map(p => p.name);
      $('#waiting').replaceChildren(
        h('div', 'big-progress', `${S.progress.ranked} / ${S.joined}명 제출`),
        ...(missing.length ? [h('p', 'sub', '아직 제출하지 않은 친구:'), (() => { const m = h('div', 'members wide'); m.append(...missing.map(n => h('em', null, n))); return m; })()] : [h('p', 'ok-note', '모두 제출했어요! 순위 발표로 넘어가세요 🎉')]));
      return;
    }
    const sameAsSaved = S.me.rank && S.me.rank.join() === draft.join();
    $('#rankEdit').replaceChildren(...draft.map((id, i) => {
      const s = sOf(id);
      const li = tint(h('li', 'rk'), id);
      const up = h('button', 'mv', '▲'); up.disabled = i === 0; up.setAttribute('aria-label', '위로');
      const dn = h('button', 'mv', '▼'); dn.disabled = i === draft.length - 1; dn.setAttribute('aria-label', '아래로');
      up.onclick = () => move(i, -1); dn.onclick = () => move(i, 1);
      li.append(h('span', 'rn', `${i + 1}위`), h('span', 'pe', s.emoji), h('b', null, s.name), h('span', 'sp'), up, dn);
      return li;
    }));
    $('#rankBtn').disabled = sameAsSaved;
    $('#rankBtn').textContent = S.me.rank ? '순위 수정 제출' : '순위 제출';
    $('#rankNote').textContent = sameAsSaved ? '✅ 제출 완료! 선생님이 발표하기 전까지 바꿀 수 있어요.' : '';
  }

  function move(i, d) {
    [draft[i], draft[i + d]] = [draft[i + d], draft[i]];
    renderRank();
  }

  function renderResult() {
    const R = S.result;
    const N = S.senses.length;
    $('#resSub').textContent = R.revealed === 0
      ? `두구두구… ${R.voters}명의 순위를 합산했어요. 5위부터 발표합니다!`
      : `${R.voters}명 참여 · n위 → n점, 총점이 낮을수록 중요한 감각`;
    const rows = [];
    for (let i = 0; i < N; i++) {
      const it = i >= N - R.revealed ? R.items[i - (N - R.revealed)] : null;
      if (!it) { rows.push(h('li', 'res-row hidden-row', '❓')); continue; }
      const s = sOf(it.id);
      const tied = R.items.some(o => o !== it && o.rank === it.rank);
      const li = tint(h('li', 'res-row' + (it.rank === 1 ? ' first' : '') + (i === N - R.revealed && R.revealed > lastRevealed ? ' pop' : '')), it.id);
      li.innerHTML = '<span class="rr"></span><span class="pe"></span><div class="rb"><div class="rt"><b></b><span></span></div><div class="bar"><i></i></div></div>';
      li.querySelector('.rr').textContent = `${tied ? '공동 ' : ''}${it.rank}위`;
      li.querySelector('.pe').textContent = s.emoji;
      li.querySelector('b').textContent = s.name;
      li.querySelector('.rt span').textContent = `총 ${it.score}점 · 평균 ${it.avg}위 · 1위 ${it.firsts}표`;
      li.querySelector('i').style.width = Math.max(6, ((N - it.avg) / (N - 1)) * 100) + '%';
      rows.push(li);
    }
    $('#resList').replaceChildren(...rows);
    lastRevealed = R.revealed;

    if (IS_HOST) {
      const b1 = h('button', 'btn primary big', R.revealed < N ? `▶ ${N - R.revealed}위 공개` : '발표 완료 🎉');
      b1.disabled = R.revealed >= N; b1.onclick = () => act('reveal', { delta: 1 });
      const b2 = h('button', 'btn', '전체 공개'); b2.disabled = R.revealed >= N; b2.onclick = () => act('reveal', { all: true });
      const b3 = h('button', 'btn', '↺ 되돌리기'); b3.disabled = R.revealed === 0; b3.onclick = () => act('reveal', { delta: -1 });
      $('#resHost').replaceChildren(b1, b2, b3);
    } else $('#resHost').replaceChildren();

    const ex = $('#resExtra');
    ex.hidden = R.revealed < N;
    if (R.revealed === N) {
      const win = R.items.filter(i => i.rank === 1).map(i => sOf(i.id));
      const wrap = h('div', 'extra');
      wrap.append(h('div', 'champ', `🏆 우리 반이 가장 중요하게 뽑은 감각: ${win.map(s => s.emoji + ' ' + s.name).join(' · ')}`));
      wrap.append(h('p', 'shift', `처음에 고른 감각과 다른 감각을 1위로 정한 친구: ${R.shift}명 (${R.voters ? Math.round((R.shift / R.voters) * 100) : 0}%)`));
      const pre = h('div', 'chips');
      pre.append(...S.senses.map(s => tint(h('span', 'chip', `${s.emoji} 사전 ${R.picks[s.id]}명`), s.id)));
      wrap.append(h('h3', null, '처음 고른 감각 (사전 투표)'), pre, h('h3', null, '👍 가장 공감받은 이유'));
      const ul = h('ul', 'reason-list');
      ul.append(...S.senses.filter(s => R.best[s.id]).map(s => reasonItem({ ...R.best[s.id], mine: false, liked: false })));
      if (!ul.children.length) ul.append(h('li', 'empty', '공감을 받은 이유가 없어요'));
      for (const b of ul.querySelectorAll('.like')) b.disabled = true;
      wrap.append(ul);
      ex.replaceChildren(wrap);
      if (!confettiDone) { confettiDone = true; confetti(win[0].emoji); }
    }
  }

  function confetti(e) {
    const box = h('div', 'confetti');
    for (let i = 0; i < 28; i++) {
      const s = h('span', null, i % 3 ? '🎉' : e);
      s.style.left = Math.random() * 100 + '%';
      s.style.animationDelay = Math.random() * 0.8 + 's';
      s.style.fontSize = 18 + Math.random() * 22 + 'px';
      box.append(s);
    }
    document.body.append(box);
    setTimeout(() => box.remove(), 4500);
  }

  function tick() {
    if (!S) return;
    const rem = S.timerEnd ? S.timerEnd - (Date.now() + clockOffset) : 0;
    const bar = $('#timerBar');
    bar.hidden = !(S.timerEnd && rem > -3000);
    if (!bar.hidden) {
      $('#timerText').textContent = rem > 0 ? mmss(rem) : '시간 끝! ⏰';
      bar.classList.toggle('warn', rem <= 10000);
    }
  }
  setInterval(tick, 500);

  /* ---------- 폴링 (Apps Script는 실시간 푸시가 없어 2초마다 확인) ---------- */
  const BASE_MS = IS_HOST ? 1500 : 2000;

  function schedulePoll(ms) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, ms);
  }

  async function poll() {
    if (!session) return;
    const slowTimer = setTimeout(() => pollFails < 2 && setSync('slow'), 2500); // 확인 요청이 2.5초 넘게 걸리면 '응답 느림' 표시
    try {
      const j = await call('GET', { a: 'state', code: session.code, [IS_HOST ? 'token' : 'pid']: session.id, v: version });
      clearTimeout(slowTimer);
      if (!session) return;
      pollFails = 0;
      setSync('ok');
      if (j.gone) return gone();
      if (j.online != null && j.online !== online) {
        online = j.online;
        if (S) $('#online').textContent = `접속 ${online} / 참여 ${S.joined}명`;
      }
      if (j.state) applyState(j.state);
    } catch {
      clearTimeout(slowTimer);
      pollFails++;
      if (pollFails >= 2) setSync('bad');
    }
    // 화면이 가려져 있거나 오류가 나면 간격을 늘려 서버 부담을 줄임
    schedulePoll(Math.min(10000, BASE_MS * (document.hidden ? 3 : 1) * (1 + pollFails)));
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && session) schedulePoll(0); });

  function gone() {
    clearTimeout(pollTimer);
    store.removeItem(KEY);
    session = null; S = null; version = -1;
    hideLoading();
    $('#app').hidden = true; $('#join').hidden = false;
    toast('방을 찾을 수 없어요. 다시 입장해 주세요.');
  }

  // 연결 상태 표시등: ok(초록) / slow(주황, 응답 느림) / bad(빨강, 재연결 중)
  const SYNC_TEXT = { ok: '', slow: '응답 느림…', bad: '재연결 중…' };
  let syncState = 'ok';
  function setSync(st) {
    syncState = st;
    const c = $('#conn');
    if (!c || c.dataset.s === st) return;
    c.dataset.s = st;
    c.className = 'sync ' + st;
    c.title = { ok: '서버와 연결됨', slow: '서버 응답이 느려요', bad: '서버에 연결할 수 없어요. 자동으로 다시 시도해요' }[st];
    c.replaceChildren(h('i'), ...(SYNC_TEXT[st] ? [document.createTextNode(SYNC_TEXT[st])] : []));
  }

  function start(s) {
    session = s;
    store.setItem(KEY, JSON.stringify(s));
    version = -1;
    showLoading('수업에 접속하는 중…');
    schedulePoll(0);
  }

  /* ---------- 입장/생성 ---------- */
  if (!API || /YOUR_/.test(API)) {
    const warn = h('p', 'warn-box', '⚠ docs/config.js 의 OSAM_API 에 Apps Script 웹앱 주소(/exec)를 넣어 주세요. (README 참고)');
    $('#join').prepend(warn);
  }
  if (IS_HOST) {
    $('#createBtn').onclick = () => post({ a: 'create', password: $('#pwInput').value })
      .then(r => start({ code: r.code, id: r.id })).catch(e => toast(e.message));
  } else {
    const code = new URLSearchParams(location.search).get('code');
    if (code) $('#codeInput').value = code;
    $('#joinForm').onsubmit = e => {
      e.preventDefault();
      const code = $('#codeInput').value.trim();
      post({ a: 'join', code, name: $('#nameInput').value })
        .then(r => { start({ code, id: r.id }); applyState(r.state); })
        .catch(err => toast(err.message));
    };
  }
  if (session) { showLoading('수업을 불러오는 중…'); schedulePoll(0); }
})();
