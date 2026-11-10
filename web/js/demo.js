/* demo.js — 발표 시연(재생) 모드
   여는 법: 정보 탭의 '발표용 재생 시작' · 주소 끝 #demo (1번부터) · #demo2 ~ #demo4 (그 시나리오부터) · UG.demo.open(번호).
   시나리오 (장면마다 자막 한 줄):
     1. 공습 → 가장 가까운 지하로: 서울 시청 앞 → 가까운 출구 → 지하 승강장 → 여기서 지하로 4시간 안에 갈 수 있는 곳(한 번에, 시간대별 색)
     2. 하저터널 막힘 + 갈림길: 공덕 → 한성백제 길 안내, 한강 아래 5호선 마포–여의나루 터널에서 '앞이 막힘' → 마포역으로 되돌아가
        다른 하저터널(5호선 광나루–천호)로 다시 찾기 → 강동 지나 갈림길(오른쪽 갈래 = 마천지선, '통과') → 도착
     3. 지방 도시: 부산역 → 해운대 18.5km, 전 구간 지하(지상 노출 0m), 연산·수영에서 환승 2번(빨리 감기)
     4. 장거리 피난의 한계: 서울역 → 부산역, 지상 노출 구간을 빨갛게 칠하며 빠르게 따라가기
   조작: 아래 칸(시나리오 · 재생/멈춤 · 다음 장면 · 처음부터 · 속도 · 끝내기), 키보드 Space · → · 1~4 · Esc.
   동작 원리
     - 앱의 공개 객체(UG.app, UG.guide, UG.reach, UG.layers, UG.panel)만 쓴다.
       지도 따라가기는 앱 길 안내와 같은 함수(UG.app.keepCentered: 지금 위치를 보이는 곳 가운데 20% 안에)를 쓴다.
     - 길 안내의 추정 위치 = 마지막 확인 지점 + (지금 - since) × 걷는 속도. 시연은 since 를 당겨 놓아
       빨리 걸은 것처럼 만들고, 다음 확인 지점에 닿으면 큰 단추('도착'·'환승 완료'·'통과')를 실제로 누른다.
     - GPS 와 인터넷을 쓰지 않는다: 시연 동안 위치 기능을 숨기고, 지상 도보 길 찾기(walk.js)를 꺼서 직선을 쓴다.
     - 시간은 시연 시계(멈춤·건너뛰기)로 흐른다. 속도 ×30/×60/×120 = 실제 걷는 시간보다 몇 배 빠른지.
       장면마다 배속(boost)을 곱한다(예: 도착까지 빨리 감기 ×40).
   Node 에서는 계산 부분(CONF, hanCrossing, flightRuns)만 쓴다: node scripts\check_demo.js */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};

  /* =========================================================
     0. 시나리오 설정 (check_demo.js 도 이 값을 쓴다)
     ========================================================= */
  const CONF = {
    raid: { lat: 37.5663, lon: 126.9779, label: '시청 앞' },                                    // 1. 서울 시청 앞 길
    // 2. 마포 지나 하저터널 45% 지점에서 막힘. 다시 찾은 길은 광나루–천호 하저터널 → 강동 지나 갈림길(마천지선) → 도착. 빨리 감기는 줌 ffZoom 으로 따라감
    move: { from: '공덕@서울', to: '한성백제@서울', blockAfter: '마포@서울', blockFrac: 0.45, ffZoom: 12 },
    busan: { from: '부산역@부산', to: '해운대@부산', label: '부산역 → 해운대', zoom: 14, xferHold: 1600 },  // 3. 지도는 줌 14로 따라감, 환승에서 잠깐 멈춤
    far: { from: '서울역@서울', to: '부산역@부산', flySec: 24 },                                 // 4. ×60 일 때 24초 동안 따라가기
    // 장면별 배속(고른 속도 × 이 값). 2번: move = 터널까지 걷기, ff = 갈림길까지 빨리 감기, fork = 갈림길 앞, arrive = 도착까지. 부산은 ×60 이면 걷기 약 20초
    boost: { raid: 0.5, move: 3, ff: 40, fork: 1.5, arrive: 12, busan: 16 },
    speedKmh: 3.5                                                                               // 시연 중 걷는 속도(앱 기본값)
  };
  const SPEEDS = [30, 60, 120];

  // 경로가 지나는 첫 한강 하저터널(presets.han_crossings 의 터널): { e, line, a, b(지나는 순서의 역 이름) } 또는 null
  function hanCrossing(G, path) {
    const tun = new Map();
    ((G.g.presets && G.g.presets.han_crossings) || []).forEach(function (x) { if (x.s === 'tunnel') tun.set(x.e, x); });
    const name = function (v) { const s = G.nodeStation[v]; return s >= 0 ? G.g.stations[s].name : ''; };
    for (let i = 0; i < path.length; i++) {
      const x = tun.get(path[i].e);
      if (x) return { e: x.e, line: (x.lines || [])[0] || '', a: name(path[i].u), b: name(path[i].v) };
    }
    return null;
  }

  // 장거리 따라가기: 경로를 지하 / 지상 노출(교량·지상) 묶음으로 나눈다. [{ exposed, from(m), len(m), pts, cum }]
  function flightRuns(G, path) {
    const GR = UG.graph, E = G.g.edges, under = G.g.weights.under, runs = [];
    let at = 0;
    path.forEach(function (x) {
      const exposed = G.weight[x.e] !== under, len = E.len[x.e], sh = GR.edgeShape(G.g, x.e, x.u);
      const last = runs[runs.length - 1];
      if (last && last.exposed === exposed) { last.pts = last.pts.concat(sh.slice(1)); last.len += len; }
      else runs.push({ exposed: exposed, from: at, len: len, pts: sh });
      at += len;
    });
    runs.forEach(function (r) { r.cum = GR.cumulative(r.pts); });
    return runs;
  }

  // Node(check_demo.js): 계산 부분만 내보내고 끝
  if (typeof document === 'undefined') {
    UG.demo = { CONF: CONF, hanCrossing: hanCrossing, flightRuns: flightRuns };
    if (typeof module !== 'undefined' && module.exports) module.exports = UG.demo;
    return;
  }

  const PN = function () { return UG.panel; };
  function S() { return UG.app.state(); }
  function reduce() { return matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function isWide() { return matchMedia('(min-width: 760px)').matches; }
  function km(m) { return m >= 100000 ? Math.round(m / 1000) + 'km' : PN().fmtDist(m); }   // 100km 넘으면 반올림한 km
  function walkMps() { return (S().speed || CONF.speedKmh) / 3.6; }
  function stationIndex(q) { return UG.graph.findStation(S().G, q); }
  function stName(si) { return S().g.stations[si].name; }

  /* =========================================================
     1. 시연 시계
        장면은 async 함수이고, 기다림은 모두 '할 일(task)'로 만든다. 할 일은 화면 한 프레임마다 dt(ms)만큼 나아간다.
        - 멈춤: dt = 0  - 다음 장면: skip 이면 남은 할 일을 바로 끝 상태로  - 다른 시나리오: 할 일을 모두 버린다(ABORT)
     ========================================================= */
  const ABORT = new Error('demo-abort');
  const eng = { open: false, ready: false, playing: true, done: false, base: 60, boost: 1, skip: false, run: 0, tasks: [], raf: 0, last: 0 };

  function task(step) {
    return new Promise(function (resolve, reject) {
      eng.tasks.push({ step: step, resolve: resolve, reject: reject });
      kick();
    });
  }
  function kick() { if (!eng.raf && eng.open) eng.raf = requestAnimationFrame(frame); }
  function frame(now) {
    eng.raf = 0;
    if (!eng.open) return;
    const dt = eng.playing ? Math.max(0, Math.min(100, now - (eng.last || now))) : 0;
    eng.last = now;
    if (eng.ready) { hideGps(); repin(); }
    eng.tasks.slice().forEach(function (t) {
      let done = false;
      try { done = t.step(eng.skip ? Infinity : dt); } catch (e) { drop(t); t.reject(e); return; }
      if (done) { drop(t); t.resolve(); }
    });
    kick();
  }
  function drop(t) { const i = eng.tasks.indexOf(t); if (i >= 0) eng.tasks.splice(i, 1); }
  function abortAll() {
    eng.run++;
    const ts = eng.tasks;
    eng.tasks = [];
    ts.forEach(function (t) { t.reject(ABORT); });
  }

  function hold(ms) { let left = ms; return task(function (dt) { left -= dt; return left <= 0; }); }
  function until(cond) { return task(function () { return cond(); }); }
  // 걷기: total m 를 '고른 속도 × boost' 배 빠르게. onM(걸은 m)을 프레임마다 부른다(멈춤 중에도 같은 값으로).
  function walk(total, boost, onM) {
    let m = 0;
    eng.boost = boost;
    syncUi();
    onM(0);
    return task(function (dt) {
      m = Math.min(total, m + walkMps() * eng.base * boost * dt / 1000);
      onM(m);
      return m >= total;
    });
  }

  /* =========================================================
     2. 앱 다루기 (공개 객체만)
     ========================================================= */
  // 위치 기능 숨기기: 시연 중 위치 권한을 묻지 않게(GPS 없이 동작), 이미 받은 위치는 쓰지 않는다
  const saved = {};
  function muteGeo() {
    try { Object.defineProperty(navigator, 'geolocation', { value: undefined, configurable: true }); saved.geoMuted = true; } catch (e) { saved.geoMuted = false; }
  }
  function unmuteGeo() {
    if (saved.geoMuted) { try { delete navigator.geolocation; } catch (e) { /* 무시 */ } }
    saved.geoMuted = false;
  }
  function hideGps() { const s = S(); if (s.myLoc) { saved.myLoc = s.myLoc; s.myLoc = null; } }
  // 걷기 사이(멈춤·자막 기다림)에도 추정 위치가 실제 시간으로 흘러가지 않게, 마지막으로 알린 걸은 거리에 고정한다
  function repin() {
    const g = guideView(), gs = g && g.state();
    if (pin && gs === pin.gs && gs.cur === pin.cur) gs.since = Date.now() - pin.m / walkMps() * 1000;
  }

  // 시연 전 상태를 저장하고 시연용으로 맞춘다(끝낼 때 restore 로 되돌림)
  function begin() {
    const s = S();
    saved.walk = UG.walk; saved.speed = s.speed; saved.blocked = Array.from(s.blocked); saved.blockCount = s.blockCount;
    saved.view = s.map ? { c: s.map.getCenter(), z: s.map.getZoom() } : null;
    saved.notice = s.ui.notice ? s.ui.notice.hidden : true;
    saved.myLoc = null;
    UG.walk = null;                                       // 지상 도보 길 찾기(인터넷) 끄기: 직선으로, 늘 같은 결과
    muteGeo();
    if (s.speed !== CONF.speedKmh) UG.app.setSpeed(CONF.speedKmh);
    if (s.ui.notice) s.ui.notice.hidden = true;           // 처음 여는 사람의 안전 안내는 시연 동안만 숨긴다
  }
  function restore() {
    const s = S();
    UG.walk = saved.walk;
    unmuteGeo();
    saved.blocked.forEach(function (e) { s.blocked.add(e); });
    s.blockCount = saved.blockCount;
    if (saved.speed !== s.speed) UG.app.setSpeed(saved.speed);
    if (saved.myLoc) { s.myLoc = saved.myLoc; s.me.set(saved.myLoc); } else s.me.clear();
    s.me.setLook({ hidden: false, tag: '' });
    UG.app.reroute();                                     // 끝점 없음 -> 지도 정리(되살린 막은 구간 표시)
    if (saved.view) s.map.setView(saved.view.c, saved.view.z, { animate: false });
    if (s.ui.notice) s.ui.notice.hidden = saved.notice;
  }

  // 앱을 처음 화면으로: 길 안내·역 시트·경로·막은 구간·시연 표시를 모두 지운다
  function resetApp() {
    const s = S();
    const g = UG.app.guide();
    if (g && g.isOpen()) document.getElementById('guide-end').click();   // 앱의 '안내 종료'(지도 표시도 정리)
    if (s.search && s.search.isOpen()) s.search.close();
    if (s.map) s.map.closePopup();
    s.exitHere = null;
    if (s.guideLayer) s.guideLayer.clear();
    s.station = null;
    if (s.reach) s.reach.clear();
    s.blocked.clear(); s.blockCount = 0;
    UG.app.setEndpoint('from', null, true);
    UG.app.setEndpoint('to', null);                       // 경로 지우기(막은 구간 표시도)
    s.view = null;
    s.sheet.set('hidden');
    s.me.clear();
    s.ui.toast.hidden = true;
    Array.prototype.forEach.call(document.querySelectorAll('.demo-press'), function (b) { b.classList.remove('demo-press'); });
    clearMarks();
    bigText('');
    pin = null; still = false;
  }

  // 지도에서 가리지 않는 곳: 위(검색 막대·안내 카드), 왼쪽(넓은 화면의 패널), 아래(시연 칸)
  function viewPad() {
    const H = window.innerHeight, wide = isWide();
    const box = function (id) { const el = document.getElementById(id); return el && el.getClientRects().length ? el.getBoundingClientRect() : null; };
    let top = 16;
    if (!wide) ['topbar', 'guide-card'].forEach(function (id) { const r = box(id); if (r && r.bottom < H / 2) top = Math.max(top, r.bottom + 12); });
    const ov = ui && ui.root.getBoundingClientRect();
    const bottom = ov ? H - ov.top + 12 : 16;
    const left = wide ? 448 : 16;
    return { paddingTopLeft: [left, top], paddingBottomRight: [16, bottom] };
  }

  // 지도 맞추기(앱이 미뤄 둔 맞추기는 버린다). 확대 움직임 중이면 끝난 뒤에.
  async function fitView(pts, maxZoom) {
    const s = S(), map = s.map;
    if (!map || !pts || !pts.length) return;
    s.fitToken++; s.fit = null;
    await until(function () { return !map._animatingZoom; });
    map.fitBounds(L.latLngBounds(pts), Object.assign(viewPad(), { maxZoom: maxZoom || 17, animate: !reduce() }));
  }

  // 걷는 동안 추정 위치를 따라감: 앱 길 안내와 같은 규칙(보이는 곳 가운데 20% 칸을 벗어나면 가운데로 부드럽게)
  function follow(ll) { if (ll) UG.app.keepCentered(ll, viewPad()); }

  function planPoints(p) {
    const pts = [[p.from.lat, p.from.lon], [p.to.lat, p.to.lon]];
    UG.guide.routeTrack(S().G, p).pieces.forEach(function (pc) { pc.pts.forEach(function (q) { pts.push(q); }); });
    return pts;
  }

  // 폰에서 결과·역 시트를 요약 높이로(지도가 보이게). 지도가 주인공인 장면(도달 범위 넓히기·장거리 따라가기)은 시트를 내린다.
  // 시트 높이가 바뀌면 시연 칸도 따라 움직인다: 칸 자리가 멈춘 뒤에 지도를 맞춘다(settle)
  async function phonePeek() { const s = S(); if (isWide()) return; if (s.sheet.state() !== 'hidden' && s.sheet.state() !== 'peek') s.sheet.set('peek'); await settle(); }
  async function phoneMapOnly() { const s = S(); if (isWide()) return; if (s.sheet.state() !== 'hidden') s.sheet.set('hidden'); await settle(); }
  // 시연 칸 자리가 0.15초 동안 그대로일 때까지 기다린다(0.25~1초, 시연 시계)
  function settle() {
    let last = null, still = 0, t = 0;
    return task(function (dt) {
      const top = ui ? Math.round(ui.root.getBoundingClientRect().top) : 0;
      still = top === last ? still + dt : 0;
      last = top; t += dt;
      return (t >= 250 && still >= 150) || t >= 1000;
    });
  }

  // 단추를 눌러 보인 뒤(잠깐 노란 테두리) 실제로 누른다
  async function press(id, ms) {
    const b = document.getElementById(id);
    if (!b) return;
    b.classList.add('demo-press');
    try { if (ms) await hold(ms); } finally { b.classList.remove('demo-press'); }
    if (!b.disabled && b.getClientRects().length) b.click();
  }
  async function flash(el, ms) {
    if (!el) return;
    el.classList.add('demo-press');
    try { await hold(ms); } finally { el.classList.remove('demo-press'); }
  }

  function routeBetween(a, b) {
    const ia = stationIndex(a), ib = stationIndex(b);
    if (ia < 0 || ib < 0) throw new Error('역을 찾지 못함: ' + a + ' / ' + b);
    UG.app.setEndpoint('from', UG.app.stationEndpoint(ia), true);
    UG.app.setEndpoint('to', UG.app.stationEndpoint(ib));
    if (!S().plan) throw new Error('경로 없음: ' + a + ' → ' + b);
    return S().plan;
  }

  /* ---------- 길 안내 따라 걷기 ---------- */
  function guideView() { const g = UG.app.guide(); return g && g.isOpen() ? g : null; }

  // 걸은 거리 m 를 길 안내에 알린다: since 를 당겨 놓고, 화면은 0.1초마다(움직임 줄이기면 1초마다) 다시 그린다
  // still = 지도를 멈춰 둔다(갈림길을 크게 본 채 걷기: 따라가기 없이 위치만 움직임)
  let lastPing = 0, pin = null, still = false;
  function setWalked(m, force) {
    const g = guideView(), gs = g && g.state();
    if (!gs) return;
    pin = { gs: gs, cur: gs.cur, m: m };
    gs.since = Date.now() - m / walkMps() * 1000;
    const now = performance.now();
    if (!force && now - lastPing < (reduce() ? 1000 : 90)) return;
    lastPing = now;
    g.ping();                    // 앱이 추정 위치·남은 거리를 다시 그린다
    if (!still) follow(S().guidePos);
  }

  // 마지막 확인 지점 ~ 다음 확인 지점의 선(지도 맞추기용)
  function legPoints(gs, p) {
    const track = S().guideTrack, doneAt = gs.cur >= 0 ? gs.cps[gs.cur].at : 0, pts = [];
    if (track) UG.guide.sliceTrack(track, doneAt, p.next ? p.next.at : doneAt).forEach(function (l) { l.forEach(function (q) { pts.push(q); }); });
    return pts;
  }

  /* 다음 확인 지점까지 걷고 큰 단추를 누르기를 되풀이한다. 마지막 '도착'을 누르면 앱이 역 시트를 연다.
     지도는 걷는 동안 늘 지금 위치를 가운데 가까이 따라간다(follow). 구간을 시작할 때는
     opt = { boost, camera: 'leg'(구간마다: 지금 위치를 가운데에 두고 다음 확인 지점까지 보이게) | 'follow'(처음 한 번 줌 opt.zoom) | 'none',
             fast(단추 누름을 짧게), xferHold(환승 완료를 누르기 전 기다림 ms), onLeg(next, gs)(구간마다, 자막 바꾸기),
             until(next, gs) -> true 면 그 앞에서 멈춤 } */
  async function walkGuide(opt) {
    let first = true;
    for (;;) {
      const g = guideView(), gs = g && g.state();
      if (!gs) return;
      const p = UG.guide.progress(gs.cps, gs.cur, gs.plan.view.total_m);
      if (p.finished || (opt.until && opt.until(p.next, gs))) return;
      S().guideFollow = false;                                 // 지도는 시연이 맞춘다(시연 칸에 가리지 않게)
      if (opt.onLeg) opt.onLeg(p.next, gs);
      const pos = S().guidePos;
      if (opt.camera === 'leg') await fitView(pos ? UG.app.aroundCenter(legPoints(gs, p), pos) : legPoints(gs, p), 17);
      else if (opt.camera === 'follow' && first && pos) await fitView([pos], opt.zoom || 14);
      first = false;
      await walk(p.toNext_m, opt.boost, setWalked);
      setWalked(p.toNext_m, true);
      const cur = gs.cur, item = gs.plan.items[p.next.item];
      const xfer = item && item.kind === 'step' && item.step.type === 'transfer';
      await press('guide-arrive', xfer && opt.xferHold ? opt.xferHold : opt.fast ? 0 : 450);
      if (guideView() && g.state() === gs && gs.cur === cur) return;   // 눌러도 넘어가지 않으면 멈춘다(무한 반복 방지)
    }
  }
  // 따라가기 자막: 타는 구간 '부산 1호선 · 부산역 → 연산역', 환승 '연산역 환승 · 부산 1호선 → 부산 3호선'
  function legText(next, gs) {
    const it = gs.plan.items[next.item], st = it && it.kind === 'step' ? it.step : null;
    if (!st) return '';
    if (st.type === 'transfer') return PN().yeok(st.station) + ' 환승 · ' + st.from_line + ' → ' + st.to_line;
    if (st.type === 'ride') return st.line + ' · ' + PN().yeok(st.from_station) + ' → ' + PN().yeok(st.to_station);
    return '';
  }
  function legCaption(next, gs) { const t = legText(next, gs); if (t) caption(t); }
  // 자막 한 줄은 그대로 두고 아래 작은 줄만 지금 구간으로(빨리 감기)
  function legSub(next, gs) { const t = legText(next, gs); if (t && ui) caption(ui.cap.textContent, t); }

  // 갈림길에서 갈 쪽 말: '오른쪽 갈래로' · '오른쪽 선로로' · '직진 선로로' (guide.js 와 같은 말)
  function forkGo(side) { return side === '직진' ? '직진 선로로' : side + (/갈래$/.test(side) ? '로' : ' 선로로'); }
  // 갈림길 그림(앱이 그리는 Y자: 들어오는 선 약 120m, 갈래마다 약 160m, 끝에 이름표)이 다 보이게 맞출 점들
  function forkPoints(gs, cp) {
    const s = S(), GR = UG.graph, J = UG.junctions, j = gs.plan.junctions[cp.jn], c = [j.lat, j.lon], pts = [c], ends = [];
    const add = function (l) { l.forEach(function (q) { pts.push(q); }); };
    UG.guide.sliceTrack(s.guideTrack, Math.max(0, cp.at - 120), cp.at).forEach(add);
    const ahead = UG.guide.sliceTrack(s.guideTrack, cp.at, cp.at + 160);
    ahead.forEach(add);
    if (ahead.length) { const l = ahead[ahead.length - 1]; ends.push(l[l.length - 1]); }
    j.alternatives.forEach(function (a) {   // 다른 갈래: 앱처럼 선로를 따라간 처음 160m
      let line = [];
      J.followBranch(s.G, j.node, a.edge, null, Object.assign({}, J.DEFAULTS, { walkM: 400 })).steps.forEach(function (x) {
        const sh = GR.edgeShape(s.g, x[0], x[1]);
        line = line.length ? line.concat(sh.slice(1)) : sh;
      });
      if (line.length < 2) return;
      const cum = GR.cumulative(line), l = GR.sliceAlong(line, cum, 0, Math.min(160, cum[cum.length - 1]));
      add(l); ends.push(l[l.length - 1]);
    });
    return pts;
  }
  // 지도에 그린 갈래 이름표(글자 상자)·갈림길 점·지금 위치가 보이는 곳 가운데에 오게 옮긴다.
  // 지도 맞추기는 글자 상자 크기를 모르므로 그린 뒤 화면에서 재고, 안 들어가면 한 단계 줄여 다시 잰다(폰은 보이는 곳이 좁다).
  async function centerFork() {
    const map = S().map;
    for (let k = 0; k < 3; k++) {
      await until(function () { return !map._animatingZoom; });
      await hold(reduce() ? 50 : 400);                     // 옮기는 움직임이 끝나게
      const els = Array.prototype.filter.call(document.querySelectorAll('.fork-tag, .jn-dot.is-cur, .pos-est'), function (el) { return el.getClientRects().length; });
      if (!els.length) return;
      let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
      els.forEach(function (el) { const q = el.getBoundingClientRect(); l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom); });
      const pad = viewPad(), m = map.getContainer().getBoundingClientRect();
      const box = { l: m.left + pad.paddingTopLeft[0], t: m.top + pad.paddingTopLeft[1], r: m.right - pad.paddingBottomRight[0], b: m.bottom - pad.paddingBottomRight[1] };
      if (k < 2 && (r - l > box.r - box.l || b - t > box.b - box.t)) { map.setZoom(map.getZoom() - 1, { animate: !reduce() }); continue; }
      const dx = (l + r - box.l - box.r) / 2, dy = (t + b - box.t - box.b) / 2;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) map.panBy([dx, dy], { animate: !reduce() });
      return;
    }
  }

  /* ---------- 시연 표시(공습 고리, 막힘 표시, 장거리 따라가기 선) ---------- */
  let marks = null;
  function markLayer() {
    const map = S().map;
    if (!map.getPane('demo')) map.createPane('demo').style.zIndex = 470;   // 경로(455) 위, 표시(600) 아래
    if (!marks) marks = L.layerGroup().addTo(map);
    return marks;
  }
  function clearMarks() { if (marks) marks.clearLayers(); }
  function htmlMark(ll, html, z) {
    return L.marker(ll, { icon: L.divIcon({ className: '', iconSize: [0, 0], html: html }), keyboard: false, interactive: false, zIndexOffset: z || 1900 }).addTo(markLayer());
  }

  // 지금 보이는 역 시트의 '여기서 지하로 갈 수 있는 곳'(4시간까지)을 한 번에 보여 준다. 띠마다 시간대별 색(30분~4시간) 그대로.
  async function revealReach() {
    const s = S(), st = s.station;
    if (!st || !st.reach || !st.reach.sources.length) return null;
    const res = st.reach, o = s.g.stations[st.si];
    await phoneMapOnly();
    s.reach.show(UG.reach.segments(s.G, res), [o.lat / 1e5, o.lon / 1e5]);
    s.st.setOnly(new Set([st.si].concat(res.stations.filter(function (x) { return x.band >= 0; }).map(function (x) { return x.si; }))), 'reach');
    const bb = UG.reach.bounds(s.G, res);
    await fitView([[bb[0], bb[1]], [bb[2], bb[3]]], 15);
    return res;
  }

  // 도착 뒤 앱이 연 역 시트: 폰에서는 요약 높이로, 지도는 그 역의 도달 범위에 맞춘다
  async function fitArrival() {
    const s = S(), st = s.station;
    await phonePeek();
    if (!st) return;
    if (st.reach && st.reach.sources.length) { const bb = UG.reach.bounds(s.G, st.reach); await fitView([[bb[0], bb[1]], [bb[2], bb[3]]], 15); }
    else { const o = s.g.stations[st.si]; await fitView([[o.lat / 1e5, o.lon / 1e5]], 16); }
  }

  /* 장거리 따라가기: 걷는 점이 경로를 따라 빠르게 간다. 지난 길은 지하 = 청록, 지상 노출 = 굵은 주황빨강(빛나는 띠).
     ×60 일 때 CONF.far.flySec 초. 큰 숫자 = 지금까지 지상 노출 / 전체 지상 노출. */
  async function fly(ctx) {
    const s = S(), map = s.map, runs = flightRuns(s.G, ctx.p.route.path), pal = UG.layers.readPalette();
    const total = runs.reduce(function (a, r) { return a + r.len; }, 0);
    const expoAll = runs.reduce(function (a, r) { return a + (r.exposed ? r.len : 0); }, 0);
    const lay = markLayer(), renderer = L.svg({ pane: 'demo', padding: 0.5 });
    const line = function (pts, exposed) {
      const g = L.layerGroup();
      if (exposed) {
        L.polyline(pts, { renderer: renderer, interactive: false, color: pal.expo, weight: 20, opacity: 0.3, lineCap: 'round', lineJoin: 'round' }).addTo(g);
        L.polyline(pts, { renderer: renderer, interactive: false, color: pal.casing, weight: 10, opacity: 1, lineCap: 'round', lineJoin: 'round' }).addTo(g);
        L.polyline(pts, { renderer: renderer, interactive: false, color: pal.expo, weight: 7, opacity: 1, lineCap: 'round', lineJoin: 'round' }).addTo(g);
      } else {
        L.polyline(pts, { renderer: renderer, interactive: false, color: pal.route, weight: 6, opacity: 1, lineCap: 'round', lineJoin: 'round' }).addTo(g);
      }
      return g.addTo(lay);
    };
    const at = function (r, into) { return UG.graph.pointAlong(r.pts, r.cum, into / r.len * r.cum[r.cum.length - 1]); };
    const walker = htmlMark(runs[0].pts[0], '<span class="pos-est" aria-hidden="true"><span class="pos-ring"></span></span>', 2000);
    let ri = 0, expoDone = 0, cur = null, lastDraw = 0;
    await phoneMapOnly();
    await fitView([runs[0].pts[0]], isWide() ? 10 : 9);
    const boost = total / (walkMps() * 60 * CONF.far.flySec);    // ×60 일 때 flySec 초가 되는 배속
    await walk(total, boost, function (m) {
      while (ri < runs.length - 1 && m >= runs[ri].from + runs[ri].len) {   // 다 지난 묶음은 그대로 남긴다
        line(runs[ri].pts, runs[ri].exposed);
        if (runs[ri].exposed) expoDone += runs[ri].len;
        ri++;
        if (cur) { lay.removeLayer(cur); cur = null; }
      }
      const r = runs[ri], into = Math.max(0, Math.min(r.len, m - r.from)), ll = at(r, into);
      walker.setLatLng(ll);
      bigText('지상 노출 ' + km(expoDone + (r.exposed ? into : 0)) + ' / ' + km(expoAll));
      const now = performance.now();
      if (m >= total || now - lastDraw > (reduce() ? 400 : 100)) {          // 지금 묶음의 지난 부분(조금씩 다시 그림)
        lastDraw = now;
        if (cur) lay.removeLayer(cur);
        cur = into > 0 ? line(UG.graph.sliceAlong(r.pts, r.cum, 0, into / r.len * r.cum[r.cum.length - 1]), r.exposed) : null;
        follow(ll);
      }
    });
  }

  /* =========================================================
     3. 시나리오
        장면 = { cap(자막 한 줄), run(ctx) }. run 안에서 caption() 으로 숫자가 든 자막으로 바꿀 수 있다.
     ========================================================= */
  const SCENARIOS = [
    { name: '공습 → 가장 가까운 지하로', short: '공습', scenes: [
      { cap: '공습 경보 — 서울 시청 앞 거리', run: async function () {
        const r = CONF.raid, s = S();
        htmlMark([r.lat, r.lon], '<span class="demo-raid" aria-hidden="true"><span class="demo-raid-t">공습 경보</span></span>', 1700);
        s.me.set({ lat: r.lat, lon: r.lon, acc: 15, t: Date.now(), heading: null });   // '내 위치' 점(GPS 대신 정한 자리)
        s.me.setLook({ hidden: false, stale: false, tag: '' });
        await fitView([[r.lat, r.lon]], 17);
        await hold(2600);
      } },
      { cap: '버튼 한 번 — 가장 가까운 지하로', run: async function () {
        const r = CONF.raid;
        await flash(document.getElementById('go-under'), 800);
        UG.app.runNearest(r.lat, r.lon, r.label, false);        // 앱의 '가장 가까운 지하로'(지점을 정해서)
        const p = S().plan;
        if (!p) throw new Error('가장 가까운 지하로를 찾지 못함');
        const c = p.route.startConn;
        if (c) caption(PN().exitName(stName(c.si), c.ref) + ' · 지상 ' + PN().fmtDist(c.len));
        await phonePeek();
        await fitView(planPoints(p), 18);
        await hold(3000);
      } },
      { cap: '출구로 들어가 지하 승강장까지', run: async function () {
        UG.app.startGuide();
        await walkGuide({ boost: CONF.boost.raid, camera: 'leg' });
      } },
      { cap: '도착 — 여기서 지하로 갈 수 있는 곳', run: async function () {
        S().me.clear();                                         // 길에 있던 '내 위치' 점과 공습 표시는 지운다(이제 역 안)
        clearMarks();
        const res = await revealReach();
        if (res) caption('걸어서 4시간 — 지하로만 역 ' + res.counts[res.counts.length - 1] + '곳');
        await hold(5200);
      } }
    ] },

    { name: '하저터널 막힘 + 갈림길', short: '막힘', scenes: [
      { cap: '공덕 → 한성백제', run: async function (ctx) {
        const p = ctx.p = routeBetween(CONF.move.from, CONF.move.to), h = hanCrossing(S().G, p.route.path);
        caption('공덕 → 한성백제 · 지하로 ' + km(p.view.total_m), h ? '한강 아래: ' + h.line + ' ' + h.a + '–' + h.b + ' 하저터널' : '');
        await phonePeek();
        await fitView(planPoints(p), 15);
        await hold(2800);
      } },
      { cap: '안내 시작 — GPS 없이 위치 추정', run: async function () {
        UG.app.startGuide();
        const stop = stationIndex(CONF.move.blockAfter);
        await walkGuide({ boost: CONF.boost.move, camera: 'leg', until: function (next, gs) { return gs.cur >= 0 && gs.cps[gs.cur].si === stop; } });
      } },
      { cap: '한강 아래 하저터널', run: async function (ctx) {
        const g = guideView(), gs = g && g.state();
        if (!gs) return;
        const h = hanCrossing(S().G, ctx.p.route.path);
        if (h) caption('한강 아래 하저터널: ' + h.a + ' → ' + h.b);
        const p = UG.guide.progress(gs.cps, gs.cur, gs.plan.view.total_m), m = p.toNext_m * CONF.move.blockFrac;
        S().guideFollow = false;
        await fitView(legPoints(gs, p), 16);
        await walk(m, CONF.boost.move, setWalked);
        setWalked(m, true);
      } },
      { cap: '한강 하저터널 막힘', run: async function (ctx) {
        const pos = ctx.blockPos = S().guidePos;
        if (pos) htmlMark(pos, '<span class="demo-x" aria-hidden="true">막힘</span>', 1950);
        await press('guide-block', 900);                    // 앱의 '앞이 막힘': 그 구간을 막고 마지막 확인 지점에서 다시 찾는다
        S().guideFollow = false;
        setWalked(0, true);                                  // 새 안내는 아직 0m(기다리는 동안 추정 위치가 흐르지 않게)
        const p = S().plan, g = guideView(), gs = g && g.state(), here = S().guidePos || (p && [p.from.lat, p.from.lon]);
        if (p && gs && gs.backtrack >= 10) caption('한강 하저터널 막힘', (p.from.label || '확인한 곳') + '까지 ' + PN().fmtDist(gs.backtrack) + ' 되돌아가 다시 찾기');
        if (pos && here) await fitView(UG.app.aroundCenter([pos], here), 16);   // 다시 출발할 곳(마지막 확인 지점)을 가운데에, 막힌 곳도 보이게
        await hold(2600);
      } },
      { cap: '되돌아가 다른 하저터널로', run: async function (ctx) {
        const p = ctx.p2 = S().plan;
        if (!p) return;
        const h = hanCrossing(S().G, p.route.path);
        caption(h ? '되돌아가 다른 하저터널로' : '되돌아가 다른 길로', (h ? h.line + ' ' + h.a + '–' + h.b + ' · ' : '') + km(p.view.total_m) + ' · 지상 노출 ' + PN().fmtDist(p.view.exposed_m));
        // 다시 찾은 길 전체와 막힌 곳. 가장자리 표시(막힘·출발·도착)가 잘리지 않게 둘레를 6% 넓힌다
        const bb = L.latLngBounds(planPoints(p).concat(ctx.blockPos ? [ctx.blockPos] : [])).pad(0.06);
        await fitView([bb.getSouthWest(), bb.getNorthEast()], 15);
        await hold(3400);
        // 대안 한 줄(지상을 조금 걸으면 짧은 길)이 카드에 보이면 잠깐 짚고, 누르지 않고 지하 우선 경로로 간다
        const alt = document.querySelector('#guide-alt-slot:not([hidden]) [data-action="alt"]');
        if (alt) { caption('대안: ' + alt.textContent, '누르지 않고 지하 우선 경로로 계속'); await flash(alt, 2200); }
      } },
      { cap: '빨리 감기 — 갈림길까지', run: async function () {
        await walkGuide({ boost: CONF.boost.ff, camera: 'follow', zoom: CONF.move.ffZoom, fast: true, onLeg: legSub,
          until: function (next) { return next.kind === 'junction' && next.jn != null; } });
      } },
      { cap: '갈림길 — 갈 갈래로', run: async function () {
        const g = guideView(), gs = g && g.state();
        if (!gs) return;
        const p = UG.guide.progress(gs.cps, gs.cur, gs.plan.view.total_m), cp = p.next;
        if (!cp || cp.kind !== 'junction' || cp.jn == null) return;
        const j = gs.plan.junctions[cp.jn], a = j.alternatives[0], toward = function (b) { return b.toward ? b.toward + ' 방면' : b.name; };
        caption('갈림길 — ' + forkGo(j.chosen.side), toward(j.chosen) + (a ? ' · ' + a.side + (/갈래$/.test(a.side) ? '는 ' : '은 ') + toward(a) : ''));
        S().guideFollow = false;
        // 1) 지금 위치와 갈림길이 보이게 맞추고 따라가며 걷다가, 2) 갈림길 약 60m 앞에서 Y자 갈래(이름표 포함)를 크게 보고 지도를 멈춘 채 마저 걷는다
        const pos = S().guidePos, near = Math.max(0, p.toNext_m - 60);
        await fitView((pos ? [pos] : []).concat([[j.lat, j.lon]]), 17);
        await walk(near, CONF.boost.fork, setWalked);
        setWalked(near, true);
        still = true;
        try {
          await fitView(forkPoints(gs, cp), 18);
          await centerFork();
          await walk(p.toNext_m - near, CONF.boost.fork, function (m) { setWalked(near + m); });
          setWalked(p.toNext_m, true);
          await hold(900);                                   // 안내 카드의 큰 Y자와 지도의 갈래 이름표
          await press('guide-arrive', 1400);                 // 큰 단추 '통과'
        } finally { still = false; }
      } },
      { cap: '도착까지 빨리 감기', run: async function () {
        await walkGuide({ boost: CONF.boost.arrive, camera: 'leg', fast: true, onLeg: legSub });
      } },
      { cap: '도착 — 막힌 터널을 돌아 지하로', run: async function (ctx) {
        const st = S().station;
        caption((st ? PN().yeok(stName(st.si)) + ' ' : '') + '도착 — 막힌 터널을 돌아 지하로', ctx.p2 ? '다시 찾은 길 ' + km(ctx.p2.view.total_m) + ' · 지상 노출 ' + PN().fmtDist(ctx.p2.view.exposed_m) : '');
        await fitArrival();
        await hold(3200);
      } }
    ] },

    { name: '지방 도시', short: '부산', scenes: [
      { cap: CONF.busan.label, run: async function (ctx) {
        const p = ctx.p = routeBetween(CONF.busan.from, CONF.busan.to);
        caption(CONF.busan.label + ' · 지하로 ' + km(p.view.total_m), p.view.transfers ? '환승 ' + p.view.transfers + '번' : '');
        await phonePeek();
        await fitView(planPoints(p), 15);
        await hold(2600);
      } },
      { cap: '전 구간 지하 — 지상 노출 0m', run: async function (ctx) {
        caption('전 구간 지하 — 지상 노출 ' + PN().fmtDist(ctx.p.view.exposed_m));
        await flash(document.querySelector('#route-view .xbadge'), 2400);
      } },
      { cap: '선로를 따라 빠르게', run: async function () {
        UG.app.startGuide();
        await walkGuide({ boost: CONF.boost.busan, camera: 'follow', zoom: CONF.busan.zoom, fast: true, xferHold: CONF.busan.xferHold, onLeg: legCaption });
      } },
      { cap: '도착', run: async function (ctx) {
        const st = S().station;
        caption((st ? PN().yeok(stName(st.si)) : '목적지') + ' 도착 · 걸어서 ' + PN().fmtTime(ctx.p.view.minutes));
        await fitArrival();
        await hold(3200);
      } }
    ] },

    { name: '장거리 피난의 한계', short: '장거리', scenes: [
      { cap: '서울역 → 부산역 — 도시를 벗어나면?', run: async function (ctx) {
        ctx.p = routeBetween(CONF.far.from, CONF.far.to);
        await phonePeek();
        await fitView(planPoints(ctx.p), 12);
        await hold(2600);
      } },
      { cap: '지상 노출', run: async function (ctx) {
        const v = ctx.p.view;
        caption(km(v.total_m) + ' 중 ' + km(v.exposed_m) + '가 지상');
        await flash(document.querySelector('#route-view .xbadge'), 2800);
      } },
      { cap: '선로를 따라 빠르게 — 빨강 = 지상 노출', run: fly },
      { cap: '도시 안은 지하로, 도시 사이는 지상 노출 최소로', run: async function (ctx) {
        await fitView(planPoints(ctx.p), 12);
        await hold(4000);
      } }
    ] }
  ];

  /* =========================================================
     4. 재생
     ========================================================= */
  let cur = 1, sceneIdx = 0;
  async function play(n) {
    abortAll();
    const run = eng.run, sc = SCENARIOS[n - 1], ctx = {};
    cur = n; sceneIdx = 0; eng.done = false; eng.playing = true; eng.skip = false; eng.boost = 1;
    try { resetApp(); } catch (e) { console.error('[demo]', e); }
    for (let i = 0; i < sc.scenes.length; i++) {
      if (run !== eng.run) return;
      sceneIdx = i; eng.skip = false; eng.boost = 1;
      caption(sc.scenes[i].cap);
      bigText('');
      syncUi();
      try { await sc.scenes[i].run(ctx); } catch (e) {
        if (e === ABORT || run !== eng.run) return;
        console.error('[demo]', e);
        caption('이 장면을 재생하지 못했습니다');
        break;
      }
    }
    if (run !== eng.run) return;
    eng.done = true; eng.skip = false;
    syncUi();
  }
  // 다음 장면(지금 장면을 끝 상태로 건너뛴다). 시나리오가 끝났으면 다음 시나리오
  function next() {
    if (!eng.ready) return;
    if (eng.done) { play(cur % SCENARIOS.length + 1); return; }
    eng.skip = true;
    kick();
  }
  function togglePlay() { if (!eng.ready) return; eng.playing = !eng.playing; syncUi(); }
  function cycleSpeed() { eng.base = SPEEDS[(SPEEDS.indexOf(eng.base) + 1) % SPEEDS.length]; syncUi(); }

  /* =========================================================
     5. 시연 칸(자막·조작)과 열기·닫기
     ========================================================= */
  const ICON = {
    play: '<path d="M8 5v14l11-7z" fill="currentColor"/>',
    pause: '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/>',
    next: '<path d="M6 5l9 7-9 7z" fill="currentColor"/><path d="M17 5h2v14h-2z" fill="currentColor"/>',
    restart: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4.5H9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
    exit: '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>'
  };
  const svg = function (k) { return '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">' + ICON[k] + '</svg>'; };

  const CSS = [
    '.demo { position: absolute; z-index: 55; left: var(--gutter-l, 16px); right: var(--gutter-r, 16px); bottom: calc(var(--ui-bottom, 0px) + 28px); display: grid; gap: 6px; padding: 10px 10px 10px 14px; background: var(--surface); color: var(--text); border: 1px solid var(--line-strong); border-radius: var(--r-l, 18px); box-shadow: var(--shadow); }',
    '.demo-meta { margin: 0; font-size: var(--fs-xs, .75rem); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
    '.demo-cap { margin: 0; font-size: clamp(1.125rem, 5vw, 1.5rem); line-height: 1.25; font-weight: 700; letter-spacing: -.01em; }',
    '.demo-sub { margin: 0; font-size: var(--fs-md, 1rem); font-weight: 700; color: var(--muted); }',
    '.demo-big { margin: 0; font-size: clamp(1.75rem, 8vw, 2.75rem); line-height: 1.1; font-weight: 700; color: var(--expo-text); letter-spacing: -.02em; }',
    '.demo-bar { display: flex; align-items: center; gap: 4px; }',
    '.demo-pick { flex: 1 1 auto; min-width: 0; min-height: 44px; padding: 0 8px; border: 1px solid var(--line-strong); border-radius: var(--r-s, 10px); background: var(--surface-2); color: var(--text); font-size: .9375rem; font-weight: 700; }',
    '.demo-btn { flex: none; display: grid; place-items: center; width: 44px; height: 44px; padding: 0; border: 1px solid var(--line-strong); border-radius: var(--r-s, 10px); background: var(--surface-2); color: var(--text); }',
    '.demo-btn[data-demo="speed"] { width: auto; min-width: 52px; padding: 0 8px; font-weight: 700; font-variant-numeric: tabular-nums; }',
    '.demo-btn[data-demo="play"] { background: var(--sos); color: var(--on-sos); border-color: var(--sos-edge, transparent); }',
    '.demo-btn:active { background: var(--surface-3); }',
    // 좁은 휴대폰: 시나리오 선택은 한 줄 전체, 버튼 5개는 아래 줄에 고르게 나눈다(넘침 방지).
    '@media (max-width: 480px) {',
    '  .demo-bar { flex-wrap: wrap; gap: 6px; }',
    '  .demo-pick { flex: 1 0 100%; }',
    '  .demo-bar .demo-btn { flex: 1 1 0; width: auto; min-width: 0; padding: 0; }',
    '}',
    '@media (min-width: 760px) {',
    '  .demo { left: 448px; right: 16px; bottom: 40px; max-width: 900px; margin: 0 auto; gap: 8px; padding: 14px 14px 14px 20px; }',
    '  .demo-meta { font-size: var(--fs-sm, .875rem); }',
    '  .demo-cap { font-size: clamp(1.5rem, 2.4vw, 2rem); }',
    '  .demo-sub { font-size: var(--fs-lg, 1.125rem); }',
    '  .demo-big { font-size: clamp(2.25rem, 4vw, 3.5rem); }',
    '  .demo-bar { gap: 8px; }',
    '  .demo-pick { flex: 0 1 240px; }',
    '}',
    'html.demo-on .fab-col { display: none !important; }',
    '.demo-press { box-shadow: 0 0 0 4px var(--focus), 0 0 0 10px rgb(255 224 102 / .35) !important; transform: scale(.97); transition: transform .15s; }',
    '.demo-raid { position: absolute; left: 0; top: 0; width: 0; height: 0; }',
    '.demo-raid::before, .demo-raid::after { content: ""; position: absolute; left: 0; top: 0; width: 150px; height: 150px; border-radius: 50%; border: 4px solid var(--expo); transform: translate(-50%, -50%) scale(.25); opacity: .95; animation: demo-raid 1.8s ease-out infinite; }',
    '.demo-raid::after { animation-delay: .9s; }',
    '@keyframes demo-raid { to { transform: translate(-50%, -50%) scale(1); opacity: 0; } }',
    '.demo-raid-t { position: absolute; left: 0; top: -58px; transform: translateX(-50%); padding: 3px 10px; border-radius: 6px; background: var(--expo); color: var(--on-expo); font-size: 15px; font-weight: 700; white-space: nowrap; box-shadow: var(--shadow); }',
    '.demo-x { position: absolute; left: 0; top: 0; transform: translate(-50%, -50%); padding: 4px 10px; border: 3px solid var(--casing); border-radius: 8px; background: var(--expo); color: var(--on-expo); font-size: 16px; font-weight: 700; white-space: nowrap; box-shadow: var(--shadow); }',
    '@media (prefers-reduced-motion: reduce) {',
    '  .demo-raid::before { animation: none; transform: translate(-50%, -50%) scale(.6); }',
    '  .demo-raid::after { display: none; }',
    '  .demo-press { transform: none; }',
    '}'
  ].join('\n');

  let ui = null;
  function mountUi() {
    if (ui) return;
    if (!document.getElementById('demo-style')) {
      const st = document.createElement('style');
      st.id = 'demo-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    const root = document.createElement('section');
    root.className = 'demo';
    root.id = 'demo';
    root.setAttribute('aria-label', '시연');
    root.innerHTML =
      '<p class="demo-meta" id="demo-meta"></p>' +
      '<p class="demo-cap" id="demo-cap" aria-live="polite"></p>' +
      '<p class="demo-sub num" id="demo-sub" hidden></p>' +
      '<p class="demo-big num" id="demo-big" aria-hidden="true" hidden></p>' +
      '<div class="demo-bar">' +
        '<select class="demo-pick" id="demo-pick" aria-label="시나리오">' +
          SCENARIOS.map(function (s, i) { return '<option value="' + (i + 1) + '">' + (i + 1) + ' ' + s.short + '</option>'; }).join('') +
        '</select>' +
        '<button type="button" class="demo-btn" data-demo="play"></button>' +
        '<button type="button" class="demo-btn" data-demo="next" aria-label="다음 장면" title="다음 장면 (→)">' + svg('next') + '</button>' +
        '<button type="button" class="demo-btn" data-demo="restart" aria-label="처음부터" title="처음부터">' + svg('restart') + '</button>' +
        '<button type="button" class="demo-btn" data-demo="speed" title="재생 속도(실제 걷는 시간의 몇 배)"></button>' +
        '<button type="button" class="demo-btn" data-demo="exit" aria-label="시연 끝내기" title="시연 끝내기 (Esc)">' + svg('exit') + '</button>' +
      '</div>';
    (document.getElementById('app') || document.body).appendChild(root);
    ui = {
      root: root, meta: root.querySelector('#demo-meta'), cap: root.querySelector('#demo-cap'), sub: root.querySelector('#demo-sub'), big: root.querySelector('#demo-big'),
      pick: root.querySelector('#demo-pick'), play: root.querySelector('[data-demo="play"]'), speed: root.querySelector('[data-demo="speed"]')
    };
    ui.pick.addEventListener('change', function () { if (eng.ready) play(+ui.pick.value); });
    root.addEventListener('click', function (ev) {
      const b = ev.target.closest('[data-demo]');
      if (!b) return;
      const k = b.dataset.demo;
      if (k === 'play') togglePlay();
      else if (k === 'next') next();
      else if (k === 'restart') { if (eng.ready) play(cur); }
      else if (k === 'speed') cycleSpeed();
      else if (k === 'exit') close();
    });
    document.documentElement.classList.add('demo-on');
    syncUi();
  }
  function unmountUi() {
    if (ui) ui.root.remove();
    ui = null;
    document.documentElement.classList.remove('demo-on');
  }

  // 자막 한 줄(+ 필요하면 작은 숫자 줄)
  function caption(t, sub) { if (!ui) return; ui.cap.textContent = t; ui.sub.textContent = sub || ''; ui.sub.hidden = !sub; }
  function bigText(t) { if (!ui) return; ui.big.textContent = t; ui.big.hidden = !t; }
  function syncUi() {
    if (!ui) return;
    const sc = SCENARIOS[cur - 1], rate = Math.round(eng.base * eng.boost);
    ui.pick.value = String(cur);
    ui.meta.textContent = !eng.ready ? '시연' : (cur + '. ' + sc.name + ' · ' + (eng.done ? '끝 — → 다음 시나리오' : '장면 ' + (sceneIdx + 1) + '/' + sc.scenes.length) +
      ' · ×' + rate + (eng.boost >= 10 ? ' 빨리 감기' : ''));
    ui.play.innerHTML = svg(eng.playing ? 'pause' : 'play');
    ui.play.setAttribute('aria-label', eng.playing ? '멈춤' : '재생');
    ui.play.title = (eng.playing ? '멈춤' : '재생') + ' (Space)';
    ui.speed.textContent = '×' + eng.base;
    ui.speed.setAttribute('aria-label', '재생 속도 ×' + eng.base + ', 누르면 바꿈');
  }

  // 키보드: Space 재생/멈춤 · → 다음 장면 · 1~4 시나리오 · Esc 끝내기 (입력칸·시연 칸 단추·선택 상자에서는 그 단추가 먼저)
  function onKey(ev) {
    if (!eng.open || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const inDemo = ui && ui.root.contains(t);
    let done = true;
    if (ev.key === ' ' && !(inDemo && (tag === 'BUTTON' || tag === 'SELECT'))) togglePlay();
    else if (ev.key === 'ArrowRight' && tag !== 'SELECT') next();
    else if (/^[1-4]$/.test(ev.key) && eng.ready) play(+ev.key);
    else if (ev.key === 'Escape') close();
    else done = false;
    if (done) { ev.preventDefault(); ev.stopPropagation(); }
  }

  let pollTimer = 0;
  function appReady() { const a = UG.app; return !!(a && a.graph() && a.state().map && a.state().route && a.state().net); }
  // 시연 열기: 앱이 철도망을 다 불러올 때까지 기다린 뒤 n 번 시나리오를 재생한다
  function open(n) {
    n = Math.max(1, Math.min(SCENARIOS.length, +n || 1));
    cur = n;
    if (!eng.open) {
      eng.open = true; eng.playing = true; eng.last = 0;
      mountUi();
      window.addEventListener('keydown', onKey, true);
    }
    if (eng.ready) { play(n); return; }
    caption('철도망을 불러오는 중…');
    clearInterval(pollTimer);
    const go = function () { eng.ready = true; begin(); play(cur); };
    if (appReady()) { go(); return; }
    pollTimer = setInterval(function () {
      if (!eng.open) { clearInterval(pollTimer); return; }
      if (appReady()) { clearInterval(pollTimer); go(); }
    }, 200);
  }
  // 시연 끝내기: 재생을 멈추고 앱을 시연 전 상태로(경로는 지운다)
  function close(fromHash) {
    if (!eng.open) return;
    clearInterval(pollTimer);
    abortAll();
    if (eng.ready) {
      try { resetApp(); restore(); } catch (e) { console.error('[demo]', e); }
    }
    eng.open = false; eng.ready = false;
    if (eng.raf) cancelAnimationFrame(eng.raf);
    eng.raf = 0;
    window.removeEventListener('keydown', onKey, true);
    unmountUi();
    if (!fromHash && /^#demo/.test(location.hash)) {
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* 미리보기 등: 그대로 둔다 */ }
    }
  }

  function hashScenario() { const m = /^#demo([1-4])?$/.exec(location.hash); return m ? +(m[1] || 1) : 0; }
  window.addEventListener('hashchange', function () {
    const n = hashScenario();
    if (n) open(n); else if (eng.open) close(true);
  });

  UG.demo = {
    CONF: CONF, hanCrossing: hanCrossing, flightRuns: flightRuns,
    open: open, close: close, next: next,
    play: function () { if (eng.ready) { eng.playing = true; syncUi(); } },
    pause: function () { if (eng.ready) { eng.playing = false; syncUi(); } },
    setSpeed: function (k) { if (SPEEDS.indexOf(k) >= 0) { eng.base = k; syncUi(); } },
    // 점검용: 지금 상태
    status: function () {
      return { open: eng.open, ready: eng.ready, scenario: cur, scene: sceneIdx, scenes: SCENARIOS[cur - 1].scenes.length,
        caption: ui ? ui.cap.textContent : '', playing: eng.playing, done: eng.done, speed: eng.base, rate: Math.round(eng.base * eng.boost) };
    }
  };

  // 정보 탭의 '발표용 재생 시작' 단추(index.html #demo-open)
  const openBtn = document.getElementById('demo-open');
  if (openBtn) openBtn.addEventListener('click', function () { open(1); });

  if (hashScenario()) open(hashScenario());
})(typeof globalThis !== 'undefined' ? globalThis : this);
