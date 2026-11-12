/* demo.js — 발표 시연(재생) 모드
   발표 무대(web/stage/)의 앱 칸에서만 연다: 무대가 이 앱을 ../?stage=1#demo 로 iframe 에 띄운다(6절).
   앱을 #demo 로 열거나(옛 주소 #demo2 · #demo3 도) 정보 탭의 '발표 무대 열기'를 누르면 무대(stage/)로 옮긴다.
     처음 열 때는 index.html 머리의 짧은 스크립트가(앱 자료를 받기 전에), 연 뒤 주소가 바뀌면 이 파일의 hashchange 가 옮긴다.
   시나리오: 한 사람의 이야기(공습 → 가족 약속 장소, 사용자 결정 2026-11-11, 시작을 명동으로 2026-11-12). 장면마다 자막 한 줄.
     평소에 수서역을 '가족 약속 장소'로 저장 → 명동 거리에서 공습경보(폰에 위급재난문자 흉내, '시연' 표시)
     → '가장 가까운 지하로'(명동역 출구) → 4호선 승강장에 도착해 '가족 약속 장소까지 지하로'
     → 충무로 지나 선로 갈림길(3호선–4호선 연결선이 갈라지는 곳)을 크게 보고 '통과'
     → 빨리 감기로 광나루까지 → 한강 아래 5호선 광나루–천호 하저터널에서 '앞이 막힘'
     → 광나루역으로 되돌아가 한강 아래 다른 하나(5호선 마포–여의나루)로 다시 찾기 → 빨리 감기로 마포까지 → 마포–여의나루 하저터널을 걸어서 건넘
     → 도착까지 빨리 감기 → 수서역 도착(목적지는 사용자 결정 2026-11-11: 한성백제에서 수서로)
     → 끝 장면: 수서에서 남쪽(동탄)으로도 지하 길이 이어진다는 것만 화살표로 보여 준다(점선이 수서에서 동탄 쪽으로 찍히며 자람, 안내·위치 이동 없음)
     거리·출구 번호·역 이름은 자막에 박아 두지 않고 앱의 경로 탐색 결과에서 읽는다(숫자는 check_demo.js 가 출력).
   부산역 → 해운대, 서울역 → 부산역 시나리오는 뺐다(사용자 결정 2026-11-12: 시연은 무대 하나, 이야기 하나).
   조작: 아래 칸(재생/멈춤 · 다음 장면 · 처음부터 · 속도 · 끝내기), 키보드 Space · → · Esc. 무대 화면에서 누른 Space · → 도 받는다.
   동작 원리
     - 앱의 공개 객체(UG.app, UG.guide, UG.reach, UG.layers, UG.panel, UG.saved, UG.router)만 쓴다.
       지도는 장면마다 한 번 부드럽게 옮긴다(fitView).
     - 길 안내의 추정 위치 = 마지막 확인 지점 + (지금 - since) × 걷는 속도. 시연은 since 를 당겨 놓아
       빨리 걸은 것처럼 만들고, 다음 확인 지점에 닿으면 큰 단추('도착'·'환승 완료'·'통과')를 실제로 누른다.
     - GPS 와 인터넷을 쓰지 않는다: 시연 동안 위치 기능을 숨기고, 지상 도보 길 찾기(walk.js)를 꺼서 직선을 쓴다.
     - 저장한 장소는 시연 동안 메모리에만 둔다(saved.js useMemory): 보는 사람이 저장해 둔 장소는 건드리지 않는다.
     - 시간은 시연 시계(멈춤·건너뛰기)로 흐른다. 속도 ×30/×60/×120 = 실제 걷는 시간보다 몇 배 빠른지.
       장면마다 배속(boost)을 곱한다(예: 도착까지 빨리 감기 ×60).
     - 발표 무대: 장면 시작·걸은 거리·멈춤을 부모 창에 알리고 무대의 Space·→ 를 받는다(6절).
   Node 에서는 계산 부분(CONF, hanCrossing, flightRuns)만 쓴다: node scripts\check_demo.js */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};

  /* =========================================================
     0. 시나리오 설정 (check_demo.js 도 이 값을 쓴다)
     ========================================================= */
  const CONF = {
    // 이야기(시작은 사용자 결정 2026-11-12: 걷는 길이 실제 선로 갈림길을 지나게 명동에서):
    //    공습경보가 울린 곳 = 명동 거리(OpenStreetMap 의 'Myeongdong Shopping Street' 지점. 가장 가까운 출구가 4호선 승강장으로 이어지는 명동역 출구),
    //    가족 약속 장소(meet), 처음 길은 충무로 지나 선로 갈림길(3호선–4호선 연결선이 갈라지는 곳)을 지나고,
    //    광나루 지나 한강 하저터널의 blockFrac 지점(강 한가운데 아래, check_demo.js 가 확인)에서 막힘. 빨리 감기는 멈출 곳까지 한 화면에 담고 점만 움직인다
    story: { lat: 37.5627, lon: 126.9847, label: '명동 거리', meet: '수서@서울', south: '동탄@경기', blockAfter: '광나루@서울', blockFrac: 0.45 },
    // 장면별 배속(고른 속도 × 이 값). enter = 출구로 들어가 승강장까지, move = 갈림길 앞까지·첫 하저터널 걷기,
    // fork = 갈림길 마지막 60m(Y자를 크게 본 채 천천히), ffA = 갈림길 지나 첫 하저터널 앞 역까지 빨리 감기,
    // ff = 다시 찾은 길에서 다른 하저터널 앞 역까지 빨리 감기, cross = 다른 하저터널 걷기, arrive = 도착까지 빨리 감기
    boost: { enter: 1.5, move: 2.3, fork: 0.6, ffA: 45, ff: 55, cross: 6, arrive: 60 },
    // 공습 장면 처음에 폰에 뜨는 위급재난문자 흉내. ms = 실제 시간으로 보여 주는 동안(그 뒤 '확인'을 누른다).
    // 공개 페이지라 진짜 경보로 오해하지 않게 제목과 본문에 '시연'을 넣고, 실제 기관 이름·발신 번호는 쓰지 않는다(check_demo.js 가 확인)
    alert: { title: '위급재난문자 · 시연', body: '[시연] 공습경보 발령. 가까운 지하 대피시설로 즉시 대피하십시오.', ms: 2700 },
    southGrowMs: 2600,                                                                          // 끝 장면 화살표가 수서에서 동탄까지 자라는 시간(시연 시계)
    speedKmh: 3.5                                                                               // 시연 중 걷는 속도(앱 기본값)
  };
  const SPEEDS = [30, 60, 120];

  // 경로가 지나는 첫 한강 하저터널(presets.han_crossings 의 터널): { e, line, a, b(지나는 순서의 역 이름), sa, sb(그 역 번호) } 또는 null
  function hanCrossing(G, path) {
    const tun = new Map();
    ((G.g.presets && G.g.presets.han_crossings) || []).forEach(function (x) { if (x.s === 'tunnel') tun.set(x.e, x); });
    const name = function (si) { return si >= 0 ? G.g.stations[si].name : ''; };
    for (let i = 0; i < path.length; i++) {
      const x = tun.get(path[i].e);
      if (!x) continue;
      const sa = G.nodeStation[path[i].u], sb = G.nodeStation[path[i].v];
      return { e: x.e, line: (x.lines || [])[0] || '', a: name(sa), b: name(sb), sa: sa, sb: sb };
    }
    return null;
  }

  // 경로를 지하 / 지상 노출(교량·지상) 묶음으로 나눈다(끝 장면 화살표가 묶음마다 색을 바꾼다). [{ exposed, from(m), len(m), pts, cum }]
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
  function km(m) { return PN().fmtDist(m); }
  function walkMps() { return (S().speed || CONF.speedKmh) / 3.6; }
  function stationIndex(q) { return UG.graph.findStation(S().G, q); }
  function stName(si) { return S().g.stations[si].name; }

  /* =========================================================
     1. 시연 시계
        장면은 async 함수이고, 기다림은 모두 '할 일(task)'로 만든다. 할 일은 화면 한 프레임마다 dt(ms)만큼 나아간다.
        - 멈춤: dt = 0  - 다음 장면: skip 이면 남은 할 일을 바로 끝 상태로  - 처음부터·끝내기: 할 일을 모두 버린다(ABORT)
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
    stage.to = total;
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
    s.cameraHold = true;                                  // 지도는 시연만 움직인다(앱의 자동 맞추기와 겹쳐 두 번 움직이지 않게)
    UG.saved.useMemory(true);                             // 저장한 장소는 메모리에만(보는 사람의 장소는 그대로)
    muteGeo();
    if (s.speed !== CONF.speedKmh) UG.app.setSpeed(CONF.speedKmh);
    if (s.ui.notice) s.ui.notice.hidden = true;           // 처음 여는 사람의 안전 안내는 시연 동안만 숨긴다
  }
  function restore() {
    const s = S();
    UG.walk = saved.walk;
    s.cameraHold = false;
    UG.saved.useMemory(false);                            // 보는 사람이 저장해 둔 장소로 돌아간다
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
    if (s.saveDlg && s.saveDlg.isOpen()) s.saveDlg.close();
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
    if (eng.ready) UG.saved.useMemory(true);              // 처음부터 다시 할 때마다 빈 메모리 목록에서 시작(가족 약속 장소를 다시 저장)
    Array.prototype.forEach.call(document.querySelectorAll('.demo-press'), function (b) { b.classList.remove('demo-press'); });
    const al = document.getElementById('demo-alert');     // 위급재난문자 흉내가 떠 있던 중이면 닫는다
    if (al) al.remove();
    clearMarks();
    bigText('');
    pin = null;
  }

  // 지도에서 가리지 않는 곳: 위(검색 막대·안내 카드), 아래(시연 칸). 무대의 앱 칸은 늘 폰 크기(390×844)라 왼쪽 패널이 없다
  function viewPad() {
    const H = window.innerHeight;
    const box = function (id) { const el = document.getElementById(id); return el && el.getClientRects().length ? el.getBoundingClientRect() : null; };
    let top = 16;
    ['topbar', 'guide-card'].forEach(function (id) { const r = box(id); if (r && r.bottom < H / 2) top = Math.max(top, r.bottom + 12); });
    const ov = ui && ui.root.getBoundingClientRect();
    const bottom = ov ? H - ov.top + 12 : 16;
    return { paddingTopLeft: [16, top], paddingBottomRight: [16, bottom] };
  }

  /* 지도 맞추기: 장면마다 한 번, 부드럽게 날아가서(flyTo) 내려앉을 때까지 기다린다.
     - 시연 동안 앱의 자동 맞추기는 쉰다(app.js cameraHold): 지도를 움직이는 것은 이 함수뿐이라 두 움직임이 겹치지 않는다.
     - 시트·시연 칸 높이가 먼저 자리 잡은 뒤(settle) 부른다: 여백(viewPad)은 그때 잰 값.
     - 위 여백을 PIN_H 만큼 더 둔다: 출발·도착 핀은 그 자리 위로 그려지므로 위 카드에 가리지 않게.
     - 걸리는 시간은 옮기는 거리·확대 차이에 따라 0.6~1.5초. 움직임 줄이기면 바로 옮긴다. */
  const PIN_H = 36;
  async function fitView(pts, maxZoom) {
    const map = S().map;
    if (!map || !pts || !pts.length) return;
    await until(function () { return !map._animatingZoom; });
    const pad = viewPad(), tl = L.point(pad.paddingTopLeft[0], pad.paddingTopLeft[1] + PIN_H), br = L.point(pad.paddingBottomRight);
    // 목표 자리(Leaflet fitBounds 와 같은 계산): 여백을 뺀 곳에 다 들어가는 가장 큰 줌과 그때의 가운데
    const b = L.latLngBounds(pts), z = Math.min(maxZoom || 17, map.getBoundsZoom(b, false, tl.add(br)));
    const c = map.unproject(map.project(b.getSouthWest(), z).add(map.project(b.getNorthEast(), z)).divideBy(2).add(br.subtract(tl).divideBy(2)), z);
    await flyTo(c, z);
  }
  function flyTo(c, z) {
    const map = S().map, z0 = map.getZoom(), size = map.getSize();
    const far = map.project(c, z0).distanceTo(map.project(map.getCenter(), z0)) / Math.hypot(size.x, size.y);   // 화면 대각선 몇 개만큼 옮기나
    if (far < 0.004 && Math.abs(z - z0) < 0.05) return Promise.resolve();
    if (reduce()) { map.setView(c, z, { animate: false }); return Promise.resolve(); }
    const sec = Math.min(1.5, Math.max(0.6, 0.6 + 0.15 * Math.abs(z - z0) + 0.3 * Math.min(far, 3)));
    let landed = false;
    map.once('moveend', function () { landed = true; });
    map.flyTo(c, z, { duration: sec });
    // 다음 장면으로 건너뛰면 날아가기를 멈추고 목표 자리에 바로 둔다(반쯤 옮긴 채로 두지 않게)
    return task(function (dt) {
      if (!landed && dt === Infinity) { map.setView(c, z, { animate: false }); landed = true; }
      return landed;
    });
  }
  // 지도를 맞추면서 자막을 ms 동안 보여 준다(날아가는 시간도 읽는 시간에 넣는다)
  function show(pts, maxZoom, ms) { return Promise.all([fitView(pts, maxZoom), hold(ms)]); }

  function planPoints(p) {
    const pts = [[p.from.lat, p.from.lon], [p.to.lat, p.to.lon]];
    UG.guide.routeTrack(S().G, p).pieces.forEach(function (pc) { pc.pts.forEach(function (q) { pts.push(q); }); });
    return pts;
  }

  // 결과·역 시트를 요약 높이로(지도가 보이게). 지도가 주인공인 장면(도착 뒤 지나온 길)은 시트를 내린다.
  // 시트 높이가 바뀌면 시연 칸도 따라 움직인다: 칸 자리가 멈춘 뒤에 지도를 맞춘다(settle)
  async function phonePeek() { const s = S(); if (s.sheet.state() !== 'hidden' && s.sheet.state() !== 'peek') s.sheet.set('peek'); await settle(); }
  async function phoneMapOnly() { const s = S(); if (s.sheet.state() !== 'hidden') s.sheet.set('hidden'); await settle(); }
  // 시연 칸과 시트의 자리가 0.15초 동안 그대로일 때까지 기다린다(0.25~1초, 시연 시계)
  function settle() {
    let last = null, still = 0, t = 0;
    return task(function (dt) {
      const sh = S().ui.sheet;
      const top = (ui ? Math.round(ui.root.getBoundingClientRect().top) : 0) + ',' + (sh.getClientRects().length ? Math.round(sh.getBoundingClientRect().top) : -1);
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
  // id 가 없는 단추(역 시트·대화상자 안): 보인 뒤 누른다
  async function tap(el, ms) {
    if (!el) return;
    await flash(el, ms);
    if (!el.disabled && el.getClientRects().length) el.click();
  }

  // 경로 결과의 '안내 시작'을 보인 뒤 길 안내를 연다(시연은 걸음 세기 없이: UG.app.startGuide).
  // 안내 카드·아래 단추가 나타나고 시연 칸이 자리 잡을 때까지 기다린다(그 뒤에 지도를 옮긴다)
  async function startGuide() {
    await flash(document.querySelector('#route-view [data-action="guide"]'), 800);
    UG.app.startGuide();
    await settle();
  }

  /* ---------- 길 안내 따라 걷기 ---------- */
  function guideView() { const g = UG.app.guide(); return g && g.isOpen() ? g : null; }

  // 걸은 거리 m 를 길 안내에 알린다: since 를 당겨 놓고, 안내 카드·지도 표시는 0.1초마다(움직임 줄이기면 1초마다) 다시 그린다.
  // 그 사이 프레임에는 추정 위치 표시만 옮겨(glide) 점이 끊기지 않고 미끄러지듯 움직인다.
  // 지도는 따라가지 않는다: 장면마다 한 화면에 담고 점만 움직인다.
  let lastPing = 0, pin = null;
  function setWalked(m, force) {
    const g = guideView(), gs = g && g.state();
    if (!gs) return;
    pin = { gs: gs, cur: gs.cur, m: m };
    gs.since = Date.now() - m / walkMps() * 1000;
    stagePos(gs, m, force);
    const now = performance.now();
    if (force || now - lastPing >= (reduce() ? 1000 : 90)) {
      lastPing = now;
      g.ping();                  // 앱이 추정 위치·남은 거리·안내 카드를 다시 그린다
    } else if (!reduce()) glide(gs, m);
  }
  // 추정 위치 표시만 걸은 거리 자리로(앱의 계산과 같다: 마지막 확인 지점 + 걸은 거리)
  function glide(gs, m) {
    const s = S(), track = s.guideTrack;
    if (!track || !s.guideLayer) return;
    const doneAt = gs.cur >= 0 ? gs.cps[gs.cur].at : 0;
    s.guideLayer.moveEstimate(UG.guide.pointAt(track, Math.min(doneAt + m, track.total)));
  }

  // 마지막 확인 지점 ~ 다음 확인 지점의 선(지도 맞추기용)
  function legPoints(gs, p) { return trackPoints(gs, p.next ? p.next.at : null); }
  // 마지막 확인 지점부터 경로 위 거리 endAt(m)까지의 선 점들
  function trackPoints(gs, endAt) {
    const track = S().guideTrack, doneAt = gs.cur >= 0 ? gs.cps[gs.cur].at : 0, pts = [];
    if (track) UG.guide.sliceTrack(track, doneAt, endAt == null ? doneAt : endAt).forEach(function (l) { l.forEach(function (q) { pts.push(q); }); });
    return pts;
  }
  // 빨리 감기를 한 화면에: 지금부터 멈출 확인 지점(until 이 참인 곳, 없으면 끝)까지
  function aheadPoints(gs, until) {
    let end = gs.cps[gs.cps.length - 1];
    for (let i = gs.cur + 1; i < gs.cps.length; i++) if (until && until(gs.cps[i], gs)) { end = gs.cps[i]; break; }
    return trackPoints(gs, end.at);
  }

  /* 다음 확인 지점까지 걷고 큰 단추를 누르기를 되풀이한다. 마지막 '도착'을 누르면 앱이 역 시트를 연다.
     opt = { boost, camera: 'leg'(구간마다 한 번: 지금 위치를 가운데에 두고 다음 확인 지점까지 보이게, 걷는 동안 지도는 그대로)
                          | 'fixed'(처음 한 번: 멈출 곳까지 전부 한 화면에, 빨리 감기용) | 'none',
             fast(단추 누름을 짧게), onLeg(next, gs)(구간마다, 자막 바꾸기),
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
      else if (opt.camera === 'fixed' && first) await fitView(aheadPoints(gs, opt.until), opt.zoom || 15);
      first = false;
      await walk(p.toNext_m, opt.boost, setWalked);
      setWalked(p.toNext_m, true);
      const cur = gs.cur;
      await press('guide-arrive', opt.fast ? 0 : 450);
      if (guideView() && g.state() === gs && gs.cur === cur) return;   // 눌러도 넘어가지 않으면 멈춘다(무한 반복 방지)
    }
  }
  // 빨리 감기 아래 줄: 타는 구간 '노선 · 탄 역 → 내릴 역', 환승 '역 환승 · 타던 노선 → 갈아탈 노선'
  function legText(next, gs) {
    const it = gs.plan.items[next.item], st = it && it.kind === 'step' ? it.step : null;
    if (!st) return '';
    if (st.type === 'transfer') return PN().yeok(st.station) + ' 환승 · ' + st.from_line + ' → ' + st.to_line;
    if (st.type === 'ride') return st.line + ' · ' + PN().yeok(st.from_station) + ' → ' + PN().yeok(st.to_station);
    return '';
  }
  // 자막 한 줄은 그대로 두고 아래 작은 줄만 지금 구간으로(빨리 감기)
  function legSub(next, gs) { const t = legText(next, gs); if (t && ui) caption(ui.cap.textContent, t); }

  /* ---------- 갈림길 (이야기의 갈림길 장면, 2026-11-11 판의 갈림길 장면을 다시 씀) ---------- */
  // 갈림길에서 갈 쪽 말: '왼쪽 갈래로' · '오른쪽 선로로' · '직진 선로로' (guide.js 와 같은 말)
  function forkGo(side) { return side === '직진' ? '직진 선로로' : side + (/갈래$/.test(side) ? '로' : ' 선로로'); }
  // 갈래 이름: 방면이 있으면 '○○ 방면', 없으면 선 이름
  function forkToward(b) { return b.toward ? b.toward + ' 방면' : b.name; }
  // 갈림길 그림(앱이 그리는 Y자: 들어오는 선 약 120m, 갈래마다 약 160m, 끝에 이름표)이 다 보이게 맞출 점들
  function forkPoints(gs, cp) {
    const s = S(), GR = UG.graph, J = UG.junctions, j = gs.plan.junctions[cp.jn], pts = [[j.lat, j.lon]];
    const add = function (l) { l.forEach(function (q) { pts.push(q); }); };
    UG.guide.sliceTrack(s.guideTrack, Math.max(0, cp.at - 120), cp.at).forEach(add);
    UG.guide.sliceTrack(s.guideTrack, cp.at, cp.at + 160).forEach(add);
    j.alternatives.forEach(function (a) {   // 다른 갈래: 앱처럼 선로를 따라간 처음 160m
      let line = [];
      J.followBranch(s.G, j.node, a.edge, null, Object.assign({}, J.DEFAULTS, { walkM: 400 })).steps.forEach(function (x) {
        const sh = GR.edgeShape(s.g, x[0], x[1]);
        line = line.length ? line.concat(sh.slice(1)) : sh;
      });
      if (line.length < 2) return;
      const cum = GR.cumulative(line);
      add(GR.sliceAlong(line, cum, 0, Math.min(160, cum[cum.length - 1])));
    });
    return pts;
  }
  // 지도에 그린 갈래 이름표(글자 상자)·갈림길 점·지금 위치가 보이는 곳 가운데에 오게 옮긴다.
  // 지도 맞추기는 글자 상자 크기를 모르므로 그린 뒤 화면에서 재고, 안 들어가면 한 단계 줄여 다시 잰다(폰은 보이는 곳이 좁다).
  // 이름표 둘이 양옆으로 펼쳐져 폰 너비를 넘으면(갈래가 거의 나란한 갈림길: 줄여도 글자 상자는 그대로) 갈 쪽 이름표·갈림길 점·지금 위치만 맞춘다
  async function centerFork() {
    const map = S().map;
    const boxOf = function (sel) {
      const els = Array.prototype.filter.call(document.querySelectorAll(sel), function (el) { return el.getClientRects().length; });
      if (!els.length) return null;
      let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
      els.forEach(function (el) { const q = el.getBoundingClientRect(); l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom); });
      return { l: l, t: t, r: r, b: b };
    };
    for (let k = 0; k < 3; k++) {
      await until(function () { return !map._animatingZoom; });
      await hold(reduce() ? 50 : 400);                     // 옮기는 움직임이 끝나게
      const pad = viewPad(), m = map.getContainer().getBoundingClientRect();
      const box = { l: m.left + pad.paddingTopLeft[0], t: m.top + pad.paddingTopLeft[1], r: m.right - pad.paddingBottomRight[0], b: m.bottom - pad.paddingBottomRight[1] };
      const fits = function (q) { return q.r - q.l <= box.r - box.l && q.b - q.t <= box.b - box.t; };
      const all = boxOf('.fork-tag, .jn-dot.is-cur, .pos-est'), go = boxOf('.fork-tag.is-go, .jn-dot.is-cur, .pos-est');
      if (!all) return;
      const q = fits(all) ? all : go && (fits(go) || k === 2) ? go : null;
      if (!q) { map.setZoom(map.getZoom() - 1, { animate: !reduce() }); continue; }
      const dx = (q.l + q.r - box.l - box.r) / 2, dy = (q.t + q.b - box.t - box.b) / 2;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) map.panBy([dx, dy], { animate: !reduce() });
      return;
    }
  }

  /* ---------- 시연 표시(위급재난문자 흉내, 공습 고리, 막힘 표시, 남쪽 길 화살표) ---------- */
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

  /* 위급재난문자 흉내(공습 장면 처음): 휴대폰 시스템 알림처럼 어두운 카드(경고 아이콘 · 제목 · 본문 · 확인)를 앱 위에 띄운다.
     실제 시간 CONF.alert.ms 동안 보인 뒤 '확인'을 누르는 모습을 보이고(press) 닫는다. 보는 사람이 먼저 '확인'을 누르면 바로 닫고 넘어간다.
     문구는 CONF.alert: 제목·본문에 '시연'이 들어가고 실제 기관 이름·발신 번호가 없다(공개 페이지라 진짜 경보로 오해하지 않게).
     카드 층은 시연 칸(자막·조작) 바로 아래라서 자막은 그대로 보이고 조작도 된다. 다음 장면·처음부터에도 남지 않는다(finally, resetApp). */
  const ALERT_ICON = '<path class="a" d="M12 2.6 22.4 20.6H1.6z"/><path class="b" d="M12 9.2v5.6"/><circle class="c" cx="12" cy="17.5" r="1.25"/>';
  async function emergencyAlert() {
    const A = CONF.alert, esc = PN().esc;
    S().ui.toast.hidden = true;                          // 앞 장면의 알림('저장했습니다')이 카드 위에 남지 않게
    const el = document.createElement('div');
    el.className = 'demo-alert';
    el.id = 'demo-alert';
    el.innerHTML =
      '<div class="demo-alert-card" role="alertdialog" aria-labelledby="demo-alert-t" aria-describedby="demo-alert-b">' +
        '<p class="demo-alert-head"><svg class="demo-alert-ic" viewBox="0 0 24 24" aria-hidden="true">' + ALERT_ICON + '</svg>' +
          '<span id="demo-alert-t">' + esc(A.title) + '</span></p>' +
        '<p class="demo-alert-body" id="demo-alert-b">' + esc(A.body) + '</p>' +
        '<button type="button" class="demo-alert-ok" id="demo-alert-ok">확인</button>' +
      '</div>';
    let ok = false;
    el.querySelector('#demo-alert-ok').addEventListener('click', function () { ok = true; });
    // 카드는 시연 칸 위의 빈 곳 가운데에(시트가 열려 있으면 시연 칸이 위로 올라와 있다)
    if (ui) el.style.paddingBottom = Math.max(24, window.innerHeight - ui.root.getBoundingClientRect().top + 16) + 'px';
    (document.getElementById('app') || document.body).appendChild(el);
    try {
      let left = A.ms;
      await task(function (dt) { left -= dt; return ok || left <= 0; });
      if (!ok) await press('demo-alert-ok', 700);
      if (!reduce()) { el.classList.add('demo-out'); await hold(180); }
    } finally { el.remove(); }
  }

  /* 남쪽 길 화살표(끝 장면): 출발역에서 끝 역 쪽으로 점선이 한 칸씩 찍히며 자란다(두두두). 맨 앞에는 화살촉.
     - 점선 한 칸 = DASH(선 12px + 빈칸 8px). 그린 길이를 한 칸씩 늘려서 칸이 하나씩 찍혀 보인다(한 칸이 몇 m 인지는 지금 줌에서 잰다).
     - 묶음(flightRuns)마다 색: 지하 = 경로 청록, 지상 노출 = 주황빨강(남쪽 길은 지상 0m라 청록 하나).
     - 자라는 시간은 시연 시계: 멈추면 멈추고, 다음 장면이면 바로 끝까지. 다 그린 뒤에는 점선이 앞으로 천천히 흐른다.
     - 움직임 줄이기면 한 번에 다 그리고 흐르지 않는다.
     돌려주는 것: { pts(지도 맞추기용 점들), grow(ms) } */
  const DASH = [12, 8];
  function southArrow(path) {
    const map = S().map, lay = markLayer(), pal = UG.layers.readPalette(), renderer = L.svg({ pane: 'demo', padding: 0.5 });
    const runs = flightRuns(S().G, path), pts = [];
    let total = 0;
    runs.forEach(function (r) {
      r.at = total; r.geo = r.cum[r.cum.length - 1]; total += r.geo;   // 선 모양 길이(그리기는 이 길이로 잰다)
      r.line = L.polyline([], { renderer: renderer, interactive: false, color: r.exposed ? pal.expo : pal.route, weight: 6, opacity: 1,
        dashArray: DASH.join(' '), lineCap: 'butt', lineJoin: 'round' }).addTo(lay);
      r.pts.forEach(function (q) { pts.push(q); });
    });
    // 길 위 d(m): 몇 번째 묶음의 몇 m 인가
    const where = function (d) {
      let i = 0;
      while (i < runs.length - 1 && d > runs[i].at + runs[i].geo) i++;
      return { i: i, into: Math.max(0, Math.min(runs[i].geo, d - runs[i].at)) };
    };
    const point = function (d) { const w = where(d), r = runs[w.i]; return UG.graph.pointAlong(r.pts, r.cum, w.into); };
    // 지금 줌에서 점선 한 칸(DASH 합)이 몇 m 인가(지도 가운데에서 가로 100px 를 잰다)
    const period = function () {
      const c = map.getSize().divideBy(2);
      return map.distance(map.containerPointToLatLng(c), map.containerPointToLatLng(c.add([100, 0]))) / 100 * (DASH[0] + DASH[1]);
    };
    let head = null, shown = -1, step = 0;
    // 출발부터 d(m)까지 그리고 화살촉을 그 끝에 둔다(방향 = 조금 뒤 → 끝, 처음에는 끝 → 조금 앞)
    function draw(d) {
      d = Math.max(0, Math.min(total, d));
      if (d === shown) return;
      shown = d;
      const w = where(d);
      runs.forEach(function (r, i) { r.line.setLatLngs(i < w.i ? r.pts : i > w.i ? [] : UG.graph.sliceAlong(r.pts, r.cum, 0, w.into)); });
      const k = (step || period()) * 1.5, ll = point(d);
      const a = map.latLngToLayerPoint(point(Math.max(0, d - k))), b = map.latLngToLayerPoint(point(Math.max(d, Math.min(total, k))));
      if (!head) head = htmlMark(ll, '<span class="demo-arrow" aria-hidden="true"><svg viewBox="0 0 22 22"><path class="h" d="M4 3.5 19 11 4 18.5 7.5 11z"/></svg></span>', 1850);
      else head.setLatLng(ll);
      const svg = head.getElement() && head.getElement().querySelector('svg');
      if (svg && a.distanceTo(b) > 0.5) svg.style.setProperty('--a', (Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI).toFixed(1) + 'deg');
    }
    function flow() { if (!reduce()) runs.forEach(function (r) { const el = r.line.getElement(); if (el) el.classList.add('demo-flow'); }); }
    function grow(ms) {
      step = period();
      if (reduce() || !(ms > 0)) { draw(total); flow(); return Promise.resolve(); }
      const dash = step * DASH[0] / (DASH[0] + DASH[1]);
      let t = 0;
      return task(function (dt) {
        t = Math.min(ms, t + dt);
        // 한 칸 단위로: 지금까지 찍힌 칸 수 × 한 칸 + 선 부분(끝이 늘 선으로 끝나고 화살촉이 그 바로 앞)
        draw(t >= ms ? total : Math.floor(total * t / ms / step) * step + dash);
        if (t < ms) return false;
        flow();
        return true;
      });
    }
    return { pts: pts, grow: grow };
  }

  // 역 시트의 탭 바꾸기(앱의 탭 단추를 누른다): 'reach' | 'go' | 'info'. 도달 범위 탭이 아니면 앱이 경로를 다시 그린다
  function stationTab(id) {
    const b = document.getElementById('st-tab-' + id);
    if (b && b.getAttribute('aria-selected') !== 'true') b.click();
  }
  // 다시 찾은 길 전체와 막힌 곳이 보이게. 가장자리 표시(막힘·출발·도착)가 잘리지 않게 둘레를 10% 넓힌다
  function fitReroute(ctx, p, ms) {
    const bb = L.latLngBounds(planPoints(p).concat(ctx.blockPos ? [ctx.blockPos] : [])).pad(0.1);
    return show([bb.getSouthWest(), bb.getNorthEast()], 15, ms || 0);
  }
  // 시트(와 알림)를 짧게 흐리게 한 뒤 닫는다: 앱의 ×(역 시트 닫기·경로 지우기)
  async function closeSheet() {
    const s = S(), els = [s.ui.sheet, s.ui.toast];
    if (!reduce()) { els.forEach(function (el) { el.classList.add('demo-out'); }); await hold(180); }
    els.forEach(function (el) { el.classList.remove('demo-out'); });
    s.ui.sheetClose.click();
    s.ui.toast.hidden = true;
  }

  // 도착 뒤 앱이 연 역 시트: 요약 높이로, 지도는 그 역의 도달 범위에 맞춘다
  async function fitArrival() {
    const s = S(), st = s.station;
    await phonePeek();
    if (!st) return;
    if (st.reach && st.reach.sources.length) { const bb = UG.reach.bounds(s.G, st.reach); await fitView([[bb[0], bb[1]], [bb[2], bb[3]]], 15); }
    else { const o = s.g.stations[st.si]; await fitView([[o.lat / 1e5, o.lon / 1e5]], 16); }
  }

  /* =========================================================
     3. 이야기
        장면 = { id(무대에 알리는 이름), cap(자막 한 줄), run(ctx) }. run 안에서 caption() 으로 숫자가 든 자막으로 바꿀 수 있다.
        평소 저장 → 공습경보 → 가장 가까운 지하로 → 가족 약속 장소까지 지하로 → 하저터널 막힘 → 다른 하저터널로 다시 찾기 → 그 하저터널 건너기 → 도착 → 남쪽.
        ctx: p(가족 약속 장소까지 처음 경로), blockPos(막힌 곳), p2(다시 찾은 경로)
     ========================================================= */
  const STORY = { name: '공습 → 가족 약속 장소', scenes: [
    { id: 'save', cap: '평소: 가족 약속 장소 저장', run: async function () {
      const mi = stationIndex(CONF.story.meet), o = S().g.stations[mi];
      UG.app.openStation(mi, { tab: 'info' });            // 역 시트 → ☆ → '가족 약속 장소'(앱의 저장 대화상자)
      caption('평소: 가족 약속 장소 저장', PN().yeok(o.name));
      await phonePeek();                                   // 시트 높이가 자리 잡은 뒤에 지도를 옮긴다
      await fitView([[o.lat / 1e5, o.lon / 1e5]], 16);
      await tap(document.querySelector('#view-station .st-save'), 900);
      await tap(document.querySelector('#save-dlg [data-name="' + UG.saved.FAMILY + '"]'), 1400);
      await hold(1500);                                    // 알림 '"가족 약속 장소"(으)로 저장했습니다'
    } },
    { id: 'raid', cap: '공습경보 · ' + CONF.story.label, run: async function () {
      const r = CONF.story, s = S();
      await emergencyAlert();                              // 폰에 위급재난문자(흉내, '시연' 표시)가 뜨고 잠시 뒤 '확인'. 무대 3D 는 이 장면 시작부터 공습 고리
      await closeSheet();                                  // 역 시트 닫기(앱의 ×)
      await settle();
      htmlMark([r.lat, r.lon], '<span class="demo-raid" aria-hidden="true"><span class="demo-raid-t">공습경보</span></span>', 1700);
      s.me.set({ lat: r.lat, lon: r.lon, acc: 15, t: Date.now(), heading: null });   // '내 위치' 점(GPS 대신 정한 자리)
      s.me.setLook({ hidden: false, stale: false, tag: '' });
      await show([[r.lat, r.lon]], 17, 3300);
    } },
    { id: 'nearest', cap: '가장 가까운 지하로', run: async function () {
      const r = CONF.story;
      await flash(document.getElementById('go-under'), 900);
      UG.app.runNearest(r.lat, r.lon, r.label, false);        // 앱의 '가장 가까운 지하로'(지점을 정해서)
      const p = S().plan;
      if (!p) throw new Error('가장 가까운 지하로를 찾지 못함');
      const c = p.route.startConn;
      if (c) caption(PN().exitName(stName(c.si), c.ref) + ' · 지상 ' + PN().fmtDist(c.len));
      await phonePeek();
      await show(planPoints(p), 18, 3500);
    } },
    { id: 'enter', cap: '출구로 들어가 지하 승강장까지', run: async function () {
      await startGuide();
      stageLeg('entry');
      await walkGuide({ boost: CONF.boost.enter, camera: 'leg' });   // 마지막 '도착'을 누르면 앱이 역 시트를 연다
    } },
    { id: 'platform', cap: '지하 승강장 도착 · 가족 약속 장소로', run: async function () {
      const s = S(), st = s.station;
      s.me.clear();                                        // 길에 있던 '내 위치' 점과 공습 표시는 지운다(이제 역 안)
      clearMarks();
      if (!st) return;
      stationTab('go');                                    // '지하로 계속 이동' 탭: 저장한 가족 약속 장소가 맨 위
      const o = s.g.stations[st.si];
      await settle();                                      // 역 시트가 다 올라온 뒤
      await show(s.plan ? planPoints(s.plan) : [[o.lat / 1e5, o.lon / 1e5]], 17, 1800);   // 걸어 들어온 길(출구 → 승강장)
      await tap(document.querySelector('#view-station [data-act="go-saved"]'), 1800);   // 앱이 이 역 지하 승강장에서 다시 찾는다
    } },
    { id: 'plan', cap: '가족 약속 장소까지 지하로', run: async function (ctx) {
      const p = ctx.p = S().plan;
      if (!p) throw new Error('가족 약속 장소까지 경로 없음');
      const h = hanCrossing(S().G, p.route.path);
      caption(PN().yeok(stName(p.route.endSi)) + '까지 지하로 ' + km(p.view.total_m),
        '지상 노출 ' + PN().fmtDist(p.view.exposed_m) + (h ? ' · 한강 아래 ' + h.a + '–' + h.b : ''));
      await phonePeek();
      await show(planPoints(p), 15, 3900);
    } },
    { id: 'guide', cap: '안내 시작 · GPS 없이 위치 추정', run: async function () {
      // 갈림길 앞 확인 지점(역)까지 걷는다. 다음 확인 지점이 안내가 붙은 갈림길이면 멈춘다(갈림길 장면이 이어 간다)
      await startGuide();
      stageLeg('first');
      await walkGuide({ boost: CONF.boost.move, camera: 'leg', until: function (next) { return next.kind === 'junction' && next.jn != null; } });
    } },
    { id: 'junction', cap: '갈림길', run: async function () {
      const g = guideView(), gs = g && g.state();
      if (!gs) return;
      const p = UG.guide.progress(gs.cps, gs.cur, gs.plan.view.total_m), cp = p.next;
      if (!cp || cp.kind !== 'junction' || cp.jn == null) return;
      // 자막: 갈 쪽과 방면, 아래 줄에 다른 갈래(예: '갈림길 · 왼쪽 갈래로' / '동대문역사문화공원 방면 · 오른쪽 갈래는 3호선 - 4호선 연결선로')
      const j = gs.plan.junctions[cp.jn], a = j.alternatives[0];
      caption('갈림길 · ' + forkGo(j.chosen.side), forkToward(j.chosen) + (a ? ' · ' + a.side + (/갈래$/.test(a.side) ? '는 ' : '은 ') + a.name : ''));
      S().guideFollow = false;
      // 1) 지금 위치와 갈림길이 보이게 맞추고 걷다가, 2) 갈림길 약 60m 앞에서 Y자 갈래(이름표 포함)를 크게(줌 18) 보고
      //    지도를 멈춘 채 마저 걷는다. 3) 안내 카드의 큰 Y자를 잠깐 보인 뒤 큰 단추 '통과'
      const pos = S().guidePos, near = Math.max(0, p.toNext_m - 60);
      await fitView((pos ? [pos] : []).concat([[j.lat, j.lon]]), 17);
      await walk(near, CONF.boost.move, setWalked);
      setWalked(near, true);
      await fitView(forkPoints(gs, cp), 18);
      await centerFork();
      await walk(p.toNext_m - near, CONF.boost.fork, function (m) { setWalked(near + m); });
      setWalked(p.toNext_m, true);
      await hold(1200);                                    // 안내 카드의 큰 Y자와 지도의 갈래 이름표
      await press('guide-arrive', 1400);                   // 큰 단추 '통과': 다음 확인 지점으로 넘기고 걸은 거리를 거기서 다시 센다
    } },
    { id: 'crossA', cap: '한강 아래 하저터널', run: async function (ctx) {
      // 갈림길을 지나 첫 하저터널 앞 역(blockAfter, 광나루)까지 빨리 감은 뒤, 그 하저터널로 blockFrac 만큼 걸어 들어간다(강 한가운데 아래)
      const h = hanCrossing(S().G, ctx.p.route.path), stop = stationIndex(CONF.story.blockAfter);
      caption('빨리 감기 · ' + PN().yeok(h ? h.a : stName(stop)) + '까지');
      await walkGuide({ boost: CONF.boost.ffA, camera: 'fixed', fast: true, onLeg: legSub,
        until: function (next, gs) { return h ? next.si === h.sb : gs.cur >= 0 && gs.cps[gs.cur].si === stop; } });
      const g = guideView(), gs = g && g.state();
      if (!gs) return;
      if (h) caption('한강 아래 하저터널: ' + h.a + ' → ' + h.b);
      const p = UG.guide.progress(gs.cps, gs.cur, gs.plan.view.total_m), m = p.toNext_m * CONF.story.blockFrac;
      S().guideFollow = false;
      await fitView(legPoints(gs, p), 16);
      await walk(m, CONF.boost.move, setWalked);
      setWalked(m, true);
    } },
    { id: 'block', cap: '하저터널 막힘', run: async function (ctx) {
      const pos = ctx.blockPos = S().guidePos;
      if (pos) htmlMark(pos, '<span class="demo-x" aria-hidden="true">막힘</span>', 1950);
      await press('guide-block', 900);                    // 앱의 '앞이 막힘': 그 구간을 막고 마지막 확인 지점에서 다시 찾는다
      stageLeg('backtrack', guideView() ? guideView().state().backtrack : 0);   // 무대: 되돌아가기는 3D 가 그린다(앱 점은 바로 다시 출발할 곳)
      S().guideFollow = false;
      setWalked(0, true);                                  // 새 안내는 아직 0m(기다리는 동안 추정 위치가 흐르지 않게)
      const p = S().plan, g = guideView(), gs = g && g.state(), here = S().guidePos || (p && [p.from.lat, p.from.lon]);
      if (p && gs && gs.backtrack >= 10) caption('하저터널 막힘', (p.from.label || '확인한 곳') + '까지 ' + PN().fmtDist(gs.backtrack) + ' 되돌아가 다시 찾기');
      await settle();                                      // 안내 카드에 '막은 구간 제외' 줄이 붙고 시연 칸 자막이 두 줄이 된 뒤
      if (pos && here) await show(UG.app.aroundCenter([pos], here), 16, 3500);   // 다시 출발할 곳(마지막 확인 지점)을 가운데에, 막힌 곳도 보이게
      else await hold(3500);
    } },
    { id: 'reroute', cap: '되돌아가 다른 하저터널로', run: async function (ctx) {
      const p = ctx.p2 = S().plan;
      if (!p) return;
      stageLeg('reroute', p.view.total_m);
      setWalked(0, true);                                  // 무대: 3D 에 다시 찾은 길 출발점(0m)을 알린다
      const h = hanCrossing(S().G, p.route.path);
      // 서울에서 한강을 지하로만 건너는 곳은 5호선 하저터널 두 곳(계획서 분석): 하나가 막히면 남은 하나로.
      // check_demo.js 가 이 길에서 확인한다(두 곳을 다 막으면 가장 나은 길도 지상을 걸어야 한다)
      caption(h ? '한강 아래 다른 하나, ' + h.a + '–' + h.b + '로' : '되돌아가 다른 길로',
        (h ? h.line + ' · ' : '') + km(p.view.total_m) + ' · 지상 노출 ' + PN().fmtDist(p.view.exposed_m));
      await fitReroute(ctx, p, 4600);
      // 대안 한 줄(지상을 조금 걸으면 짧은 길)이 카드에 보이면 잠깐 짚고, 누르지 않고 지하 우선 경로로 간다
      const alt = document.querySelector('#guide-alt-slot:not([hidden]) [data-action="alt"]');
      if (alt) { caption('대안: ' + alt.textContent, '누르지 않고 지하 우선 경로로 계속'); await flash(alt, 2200); }
    } },
    { id: 'ff', cap: '빨리 감기', run: async function (ctx) {
      // 다른 하저터널 앞 역(광나루)까지. 화면은 그 터널 건너편 역(천호)까지 한 번에 담는다
      const h = ctx.p2 && hanCrossing(S().G, ctx.p2.route.path);
      if (h) caption('빨리 감기 · ' + PN().yeok(h.a) + '까지');
      await walkGuide({ boost: CONF.boost.ff, camera: 'fixed', fast: true, onLeg: legSub,
        until: function (next) { return !!h && next.si === h.sb; } });
    } },
    { id: 'crossB', cap: '한강 아래 하저터널', run: async function (ctx) {
      // 다른 하저터널을 걸어서 건넌다(첫 하저터널 장면과 같은 모습: 그 구간을 한 화면에 담고 점만 움직임)
      const g = guideView(), gs = g && g.state();
      if (!gs) return;
      const h = ctx.p2 && hanCrossing(S().G, ctx.p2.route.path);
      if (h) caption('한강 아래 하저터널: ' + h.a + ' → ' + h.b);
      const p = UG.guide.progress(gs.cps, gs.cur, gs.plan.view.total_m);
      await fitView(legPoints(gs, p), 16);
      await walk(p.toNext_m, CONF.boost.cross, setWalked);
      setWalked(p.toNext_m, true);
      await press('guide-arrive', 450);
    } },
    { id: 'arriveFf', cap: '도착까지 빨리 감기', run: async function () {
      await walkGuide({ boost: CONF.boost.arrive, camera: 'fixed', fast: true, onLeg: legSub });
    } },
    { id: 'arrive', cap: '도착', run: async function (ctx) {
      const st = S().station;
      // 지하에 들어간 뒤 지상 노출 = 가족 약속 장소까지 처음 경로(막히기 전까지 걸은 곳) + 다시 찾은 경로. 둘 다 0m(check_demo.js)
      const expo = (ctx.p ? ctx.p.view.exposed_m : 0) + (ctx.p2 ? ctx.p2.view.exposed_m : 0);
      caption((st ? PN().yeok(stName(st.si)) + ' ' : '') + '도착', '지하에 들어간 뒤 지상 노출 ' + PN().fmtDist(expo));
      stationTab('info');                                  // 도달 범위 대신 이 역 정보: 앱이 다시 찾은 경로를 다시 그린다
      // 앱이 연 역 시트를 화면에 그리기 전에 내린다(열렸다 닫히는 깜빡임 없이 지도만, 지나온 길이 크게)
      await phoneMapOnly();
      if (ctx.p2) await fitReroute(ctx, ctx.p2, 5000);     // 막힌 곳부터 도착까지 지나온 길 전체
      else { await fitArrival(); await hold(5000); }
    } },
    { id: 'south', cap: '남쪽으로도 지하로 이어진다', run: async function (ctx) {
      // 길이 있다는 것만 보여 준다(사용자 결정 2026-11-11): 도착한 역 지하 승강장에서 남쪽 역까지 앱의 경로 탐색 결과를 화살표로만.
      // 길 안내를 시작하지 않고 사람(추정 위치)도 움직이지 않는다. 지도는 두 역이 다 보이게 한 번 물러난 뒤, 화살표가 수서에서 동탄 쪽으로 자란다
      const s = S(), si = stationIndex(CONF.story.meet), ti = stationIndex(CONF.story.south);
      const from = UG.app.stationEndpoint(si, true), to = UG.app.stationEndpoint(ti);
      const r = UG.router.findRoute(s.G, from, to, { blocked: s.blocked }) || UG.router.findRoute(s.G, from, to, { blocked: s.blocked, surface: true });
      if (!r) return;
      stageLeg('south', r.total_m);
      caption('남쪽으로도 지하로 이어진다', stName(si) + ' → ' + stName(ti) + ' ' + km(r.total_m) + ' · 지상 ' + PN().fmtDist(r.exposed_m));
      const arrow = southArrow(r.path), pts = arrow.pts, end = pts[pts.length - 1];
      // 지나온 길(막힌 곳 포함)과 남쪽 길이 한 화면에(가장자리에 반쯤 걸친 표시가 없게 둘레를 6% 넓힌다)
      const bb = L.latLngBounds(pts.concat(ctx.p2 ? planPoints(ctx.p2) : []).concat(ctx.blockPos ? [ctx.blockPos] : [])).pad(0.06);
      await fitView([bb.getSouthWest(), bb.getNorthEast()], 13);   // 지도를 먼저 옮긴다(날아가는 동안 선을 그리지 않게)
      await arrow.grow(CONF.southGrowMs);                  // 수서에서 동탄 쪽으로 점선이 한 칸씩 찍히며 자란다(움직임 줄이기면 한 번에)
      htmlMark(end, '<span class="demo-end demo-new" aria-hidden="true">' + PN().esc(PN().yeok(stName(ti))) + '</span>', 1800);
      await hold(2400);
    } }
  ] };

  /* =========================================================
     4. 재생
     ========================================================= */
  let sceneIdx = 0;
  async function play() {
    abortAll();
    const run = eng.run, sc = STORY, ctx = {};
    sceneIdx = 0; eng.done = false; eng.playing = true; eng.skip = false; eng.boost = 1;
    try { resetApp(); } catch (e) { console.error('[demo]', e); }
    for (let i = 0; i < sc.scenes.length; i++) {
      if (run !== eng.run) return;
      sceneIdx = i; eng.skip = false; eng.boost = 1;
      caption(sc.scenes[i].cap);
      bigText('');
      syncUi();
      stageScene(i + 1, sc.scenes[i].id);
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
    post({ type: 'end' });
  }
  // 다음 장면(지금 장면을 끝 상태로 건너뛴다). 이야기가 끝났으면 처음부터
  function next() {
    if (!eng.ready) return;
    if (eng.done) { play(); return; }
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

  // 무대의 앱 칸은 늘 폰 크기(390×844)라 한 가지 배치만 둔다: 자막 아래에 단추 5개를 고르게 나눈다
  const CSS = [
    '.demo { position: absolute; z-index: 55; left: var(--gutter-l, 16px); right: var(--gutter-r, 16px); bottom: calc(var(--ui-bottom, 0px) + 28px); display: grid; gap: 6px; padding: 10px 10px 10px 14px; background: var(--surface); color: var(--text); border: 1px solid var(--line-strong); border-radius: var(--r-l, 18px); box-shadow: var(--shadow); transition: bottom .22s cubic-bezier(.2, .8, .2, 1); }',
    '.demo-meta { margin: 0; font-size: var(--fs-xs, .75rem); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
    '.demo-cap { margin: 0; font-size: clamp(1.125rem, 5vw, 1.5rem); line-height: 1.25; font-weight: 700; letter-spacing: -.01em; }',
    '.demo-sub { margin: 0; font-size: var(--fs-md, 1rem); font-weight: 700; color: var(--muted); }',
    '.demo-big { margin: 0; font-size: clamp(1.75rem, 8vw, 2.75rem); line-height: 1.1; font-weight: 700; color: var(--expo-text); letter-spacing: -.02em; }',
    '.demo-bar { display: flex; align-items: center; gap: 6px; }',
    '.demo-btn { flex: 1 1 0; display: grid; place-items: center; min-width: 0; height: 44px; padding: 0; border: 1px solid var(--line-strong); border-radius: var(--r-s, 10px); background: var(--surface-2); color: var(--text); }',
    '.demo-btn[data-demo="speed"] { font-weight: 700; font-variant-numeric: tabular-nums; }',
    '.demo-btn[data-demo="play"] { background: var(--sos); color: var(--on-sos); border-color: var(--sos-edge, transparent); }',
    '.demo-btn:active { background: var(--surface-3); }',
    'html.demo-on .fab-col { display: none !important; }',
    // 화면 바뀜을 부드럽게(시연 동안만): 시트·안내 카드·아래 단추는 0.22초 동안 떠오르고, 대화상자·알림·자막은 흐렸다가 나타난다. 닫을 때는 흐려진 뒤 닫는다(closeSheet)
    'html.demo-on .sheet:not([hidden]), html.demo-on .guide:not([hidden]) .g-bar { animation: demo-rise .22s cubic-bezier(.2, .8, .2, 1); }',
    'html.demo-on .guide:not([hidden]) .g-card { animation: demo-drop .22s cubic-bezier(.2, .8, .2, 1); }',
    'html.demo-on .dlg-wrap:not([hidden]), html.demo-on .toast:not([hidden]), .demo-new { animation: demo-fade .2s ease-out; }',
    'html.demo-on .demo-out { opacity: 0; transition: opacity .18s ease-in; }',
    '@keyframes demo-rise { from { opacity: 0; transform: translateY(16px); } }',
    '@keyframes demo-drop { from { opacity: 0; transform: translateY(-12px); } }',
    '@keyframes demo-fade { from { opacity: 0; } }',
    '.demo-press { box-shadow: 0 0 0 4px var(--focus), 0 0 0 10px rgb(255 224 102 / .35) !important; transform: scale(.97); transition: transform .15s; }',
    // 위급재난문자 흉내: 휴대폰 시스템 알림처럼 앱 위를 어둡게 덮고 가운데에 카드. 글꼴은 앱 글꼴 대신 기기 글꼴(시스템 화면처럼). 시연 칸(z-index 55) 바로 아래
    '.demo-alert { position: absolute; z-index: 54; inset: 0; display: grid; place-items: center; padding: 24px 20px; background: rgb(0 0 0 / .58); animation: demo-fade .2s ease-out; }',
    '.demo-alert-card { width: min(330px, 100%); padding: 22px 22px 4px; border: 1px solid var(--line-strong); border-radius: 26px; background: var(--surface-2); color: var(--text); box-shadow: 0 16px 48px rgb(0 0 0 / .55); font-family: system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; animation: demo-pop .26s cubic-bezier(.2, .8, .2, 1); }',
    '.demo-alert-head { display: flex; align-items: center; gap: 9px; margin: 0 0 12px; font-size: 1.0625rem; font-weight: 700; line-height: 1.3; color: var(--expo-text); }',
    '.demo-alert-ic { flex: none; width: 26px; height: 26px; }',
    '.demo-alert-ic .a { fill: var(--expo); }',
    '.demo-alert-ic .b { fill: none; stroke: var(--on-expo); stroke-width: 2.4; stroke-linecap: round; }',
    '.demo-alert-ic .c { fill: var(--on-expo); }',
    '.demo-alert-body { margin: 0; font-size: 1rem; line-height: 1.55; }',
    '.demo-alert-ok { display: block; width: calc(100% + 44px); min-height: 52px; margin: 18px -22px 0; padding: 0; border: 0; border-top: 1px solid var(--line); border-radius: 0 0 25px 25px; background: none; color: var(--text); font: inherit; font-size: 1.0625rem; font-weight: 700; }',
    '@keyframes demo-pop { from { opacity: 0; transform: scale(.94); } }',
    '.demo-raid { position: absolute; left: 0; top: 0; width: 0; height: 0; }',
    '.demo-raid::before, .demo-raid::after { content: ""; position: absolute; left: 0; top: 0; width: 150px; height: 150px; border-radius: 50%; border: 4px solid var(--expo); transform: translate(-50%, -50%) scale(.25); opacity: .95; animation: demo-raid 1.8s ease-out infinite; }',
    '.demo-raid::after { animation-delay: .9s; }',
    '@keyframes demo-raid { to { transform: translate(-50%, -50%) scale(1); opacity: 0; } }',
    '.demo-raid-t { position: absolute; left: 0; top: -58px; transform: translateX(-50%); padding: 3px 10px; border-radius: 6px; background: var(--expo); color: var(--on-expo); font-size: 15px; font-weight: 700; white-space: nowrap; box-shadow: var(--shadow); }',
    '.demo-end { position: absolute; left: 0; top: 0; transform: translate(-50%, -140%); padding: 2px 9px; border: 2px solid var(--route-safe); border-radius: 6px; background: var(--surface); color: var(--text); font-size: 14px; font-weight: 700; white-space: nowrap; box-shadow: var(--shadow); }',
    // 남쪽 길 화살표: 화살촉은 선 끝에서 진행 방향(--a)으로 돌린다. 다 그린 뒤 점선이 앞으로 흐른다(한 칸 20px = DASH 합)
    '.demo-arrow { position: absolute; left: 0; top: 0; width: 0; height: 0; }',
    '.demo-arrow svg { position: absolute; left: -11px; top: -11px; width: 22px; height: 22px; overflow: visible; transform: rotate(var(--a, 0deg)); }',
    '.demo-arrow .h { fill: var(--route-safe); stroke: var(--casing); stroke-width: 1.6; stroke-linejoin: round; }',
    '.demo-flow { animation: demo-flow 1.2s linear infinite; }',
    '@keyframes demo-flow { to { stroke-dashoffset: -20; } }',
    '.demo-x { position: absolute; left: 0; top: 0; transform: translate(-50%, -50%); padding: 4px 10px; border: 3px solid var(--casing); border-radius: 8px; background: var(--expo); color: var(--on-expo); font-size: 16px; font-weight: 700; white-space: nowrap; box-shadow: var(--shadow); }',
    '@media (prefers-reduced-motion: reduce) {',
    '  .demo { transition: none; }',
    '  html.demo-on .sheet, html.demo-on .guide .g-bar, html.demo-on .guide .g-card, html.demo-on .dlg-wrap, html.demo-on .toast, .demo-new, .demo-alert, .demo-alert-card, .demo-flow { animation: none !important; }',
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
        '<button type="button" class="demo-btn" data-demo="play"></button>' +
        '<button type="button" class="demo-btn" data-demo="next" aria-label="다음 장면" title="다음 장면 (→)">' + svg('next') + '</button>' +
        '<button type="button" class="demo-btn" data-demo="restart" aria-label="처음부터" title="처음부터">' + svg('restart') + '</button>' +
        '<button type="button" class="demo-btn" data-demo="speed" title="재생 속도(실제 걷는 시간의 몇 배)"></button>' +
        '<button type="button" class="demo-btn" data-demo="exit" aria-label="시연 끝내기" title="시연 끝내기 (Esc)">' + svg('exit') + '</button>' +
      '</div>';
    (document.getElementById('app') || document.body).appendChild(root);
    ui = {
      root: root, meta: root.querySelector('#demo-meta'), cap: root.querySelector('#demo-cap'), sub: root.querySelector('#demo-sub'), big: root.querySelector('#demo-big'),
      play: root.querySelector('[data-demo="play"]'), speed: root.querySelector('[data-demo="speed"]')
    };
    root.addEventListener('click', function (ev) {
      const b = ev.target.closest('[data-demo]');
      if (!b) return;
      const k = b.dataset.demo;
      if (k === 'play') togglePlay();
      else if (k === 'next') next();
      else if (k === 'restart') { if (eng.ready) play(); }
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
  // 바뀐 줄만 짧게(0.2초) 흐렸다가 나타나게 한다
  function caption(t, sub) {
    if (!ui) return;
    sub = sub || '';
    if (ui.cap.textContent !== t) { ui.cap.textContent = t; fadeIn(ui.cap); }
    if (ui.sub.textContent !== sub) { ui.sub.textContent = sub; if (sub) fadeIn(ui.sub); }
    ui.sub.hidden = !sub;
  }
  function fadeIn(el) { el.classList.remove('demo-new'); void el.offsetWidth; el.classList.add('demo-new'); }
  function bigText(t) { if (!ui) return; ui.big.textContent = t; ui.big.hidden = !t; }
  function syncUi() {
    stageState();
    if (!ui) return;
    const rate = Math.round(eng.base * eng.boost);
    ui.meta.textContent = !eng.ready ? '시연' : (STORY.name + ' · ' + (eng.done ? '끝 — → 처음부터' : '장면 ' + (sceneIdx + 1) + '/' + STORY.scenes.length) +
      ' · ×' + rate + (eng.boost >= 10 ? ' 빨리 감기' : ''));
    ui.play.innerHTML = svg(eng.playing ? 'pause' : 'play');
    ui.play.setAttribute('aria-label', eng.playing ? '멈춤' : '재생');
    ui.play.title = (eng.playing ? '멈춤' : '재생') + ' (Space)';
    ui.speed.textContent = '×' + eng.base;
    ui.speed.setAttribute('aria-label', '재생 속도 ×' + eng.base + ', 누르면 바꿈');
  }

  // 키보드: Space 재생/멈춤 · → 다음 장면 · Esc 끝내기 (입력칸·시연 칸 단추에서는 그 단추가 먼저)
  function onKey(ev) {
    if (!eng.open || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const inDemo = ui && ui.root.contains(t);
    let done = true;
    if (ev.key === ' ' && !(inDemo && tag === 'BUTTON')) togglePlay();
    else if (ev.key === 'ArrowRight') next();
    else if (ev.key === 'Escape') close();
    else done = false;
    if (done) { ev.preventDefault(); ev.stopPropagation(); }
  }

  // 무대로 옮기기: 앱 주소 옆의 stage/. 뒤로 가기로 #demo 주소에 돌아와 다시 옮겨지지 않게 replace
  function toStage() { location.replace('stage/'); }

  let pollTimer = 0;
  function appReady() { const a = UG.app; return !!(a && a.graph() && a.state().map && a.state().route && a.state().net); }
  // 시연 열기(무대의 앱 칸에서만): 앱이 철도망을 다 불러올 때까지 기다린 뒤 이야기를 처음부터 재생한다. 무대 밖이면 무대로 옮긴다
  function open() {
    if (!STAGE) { toStage(); return; }
    if (!eng.open) {
      eng.open = true; eng.playing = true; eng.last = 0;
      mountUi();
      window.addEventListener('keydown', onKey, true);
    }
    if (eng.ready) { play(); return; }
    caption('철도망을 불러오는 중…');
    clearInterval(pollTimer);
    const go = function () { eng.ready = true; begin(); play(); };
    if (appReady()) { go(); return; }
    pollTimer = setInterval(function () {
      if (!eng.open) { clearInterval(pollTimer); return; }
      if (appReady()) { clearInterval(pollTimer); go(); }
    }, 200);
  }
  // 시연 끝내기: 재생을 멈추고 앱을 시연 전 상태로(경로는 지운다). 무대의 앱 칸은 그대로 앱으로 쓸 수 있고, 3D 는 멈춘다
  function close(fromHash) {
    if (!eng.open) return;
    clearInterval(pollTimer);
    abortAll();
    if (eng.ready) {
      try { resetApp(); restore(); } catch (e) { console.error('[demo]', e); }
    }
    eng.open = false; eng.ready = false;
    eng.playing = false; stageState();                    // 무대: 3D 도 멈춘다
    if (eng.raf) cancelAnimationFrame(eng.raf);
    eng.raf = 0;
    window.removeEventListener('keydown', onKey, true);
    unmountUi();
    if (!fromHash && /^#demo/.test(location.hash)) {
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* 미리보기 등: 그대로 둔다 */ }
    }
  }

  // #demo = 이야기. 옛 주소 #demo2 · #demo3(부산 시나리오)도 받는다: 무대 밖이면 무대로, 무대 안이면 이야기
  function isDemoHash() { return /^#demo[1-9]?$/.test(location.hash); }
  window.addEventListener('hashchange', function () {
    if (isDemoHash()) open(); else if (eng.open) close(true);
  });

  /* =========================================================
     6. 발표 무대(web/stage/) 연결: 주소에 ?stage=1 이 있고 다른 화면(iframe) 안에서 열렸을 때만 동작한다(STAGE).
        시연은 이때만 열린다. 무대는 이 앱과 3D(web/3d/?follow)를 나란히 놓고 메시지를 3D 로 넘긴다.
        보내는 것(window.parent.postMessage, 같은 출처). 모두 { src: 'jiharo-demo', ver: 1(형식 판), type, ... }
          scene  { scenario(늘 1), n(장면 번호, 1부터), id }   장면 시작. id(16개, 이 순서): save · raid · nearest · enter · platform · plan · guide ·
                                              junction(갈림길, 2026-11-12 새로) · crossA(광나루까지 빨리 감기 + 첫 하저터널) · block · reroute · ff ·
                                              crossB(다른 하저터널) · arriveFf · arrive · south
          leg    { leg: 'entry'|'first'|'backtrack'|'reroute'|'south', total_m }          걷는 구간이 바뀜(backtrack 은 되돌아간 거리)
          pos    { leg, m, to, v, lat, lon }   걷는 동안 0.2초마다와 멈출 때. m = 그 구간 출발부터 길 안내 거리(앱 추정 위치와 같은 계산),
                                              to = 이번 걷기가 멈출 거리, v = 실제 1초에 늘어나는 m(멈춤·멈춘 뒤면 0), lat·lon = 앱 추정 위치
          state  { playing, speed }           재생·멈춤·속도(×30/60/120)가 바뀔 때, 시연을 끝낼 때(playing false)
          end    {}                           이야기 끝
        받는 것: { src: 'jiharo-stage', type: 'cmd', cmd: 'toggle'|'next'|'speed'|'hello' }  (hello = 지금 장면·구간·위치를 다시 보냄)
     ========================================================= */
  const STAGE = (function () { try { return /[?&]stage=1(&|$)/.test(location.search) && root.parent !== root; } catch (e) { return false; } })();
  const stage = { leg: '', to: 0, sent: 0, scene: null, pos: null, state: '' };
  function post(msg) {
    if (!STAGE) return;
    msg.src = 'jiharo-demo'; msg.ver = 1;   // v 는 걷는 속도라서 형식 판은 ver
    try { root.parent.postMessage(msg, location.origin); } catch (e) { /* 무대가 없으면 무시 */ }
  }
  // scenario 는 늘 1: 3D(web/3d/ride.js)는 1이 아니면 전체 보기만 한다(시나리오가 셋이던 때의 형식 그대로)
  function stageScene(n, id) { stage.scene = { type: 'scene', scenario: 1, n: n, id: id }; post(Object.assign({}, stage.scene)); }
  function stageLeg(leg, total) { stage.leg = leg; post({ type: 'leg', leg: leg, total_m: total || 0 }); }
  // 걸은 거리 알리기(setWalked 에서 부른다): 걷는 구간(entry·first·reroute)만, 0.2초마다 또는 멈출 때(force)
  function stagePos(gs, m, force) {
    if (!STAGE || !/^(entry|first|reroute)$/.test(stage.leg)) return;
    const now = performance.now();
    if (!force && now - stage.sent < 200) return;
    stage.sent = now;
    const doneAt = gs.cur >= 0 ? gs.cps[gs.cur].at : 0, track = S().guideTrack;
    const ll = track ? UG.guide.pointAt(track, Math.min(doneAt + m, track.total)) : null;
    stage.pos = { type: 'pos', leg: stage.leg, m: doneAt + m, to: doneAt + Math.max(m, stage.to), v: force || !eng.playing ? 0 : walkMps() * eng.base * eng.boost,
      lat: ll ? ll[0] : null, lon: ll ? ll[1] : null };
    post(Object.assign({}, stage.pos));
  }
  function stageState() {
    const k = eng.playing + '|' + eng.base;
    if (k === stage.state) return;
    stage.state = k;
    post({ type: 'state', playing: eng.playing, speed: eng.base });
  }
  if (STAGE) root.addEventListener('message', function (ev) {
    const d = ev.data;
    if (ev.source !== root.parent || !d || d.src !== 'jiharo-stage' || d.type !== 'cmd') return;
    if (d.cmd === 'toggle') togglePlay();
    else if (d.cmd === 'next') next();
    else if (d.cmd === 'speed') cycleSpeed();
    else if (d.cmd === 'hello') {
      stage.state = ''; stageState();
      if (stage.scene) post(Object.assign({}, stage.scene));
      if (stage.leg) post({ type: 'leg', leg: stage.leg, total_m: 0, again: true });
      if (stage.pos) post(Object.assign({}, stage.pos, { v: 0 }));
    }
  });

  UG.demo = {
    CONF: CONF, hanCrossing: hanCrossing, flightRuns: flightRuns,
    open: open, close: close, next: next,
    play: function () { if (eng.ready) { eng.playing = true; syncUi(); } },
    pause: function () { if (eng.ready) { eng.playing = false; syncUi(); } },
    setSpeed: function (k) { if (SPEEDS.indexOf(k) >= 0) { eng.base = k; syncUi(); } },
    // 점검용: 지금 상태
    status: function () {
      return { open: eng.open, ready: eng.ready, scenario: 1, scene: sceneIdx, scenes: STORY.scenes.length,
        caption: ui ? ui.cap.textContent : '', playing: eng.playing, done: eng.done, speed: eng.base, rate: Math.round(eng.base * eng.boost) };
    }
  };

  // 무대의 앱 칸(?stage=1#demo)이면 연다. 무대 밖에서 #demo 로 연 것은 index.html 머리의 스크립트가 이미 무대로 옮겼다
  if (STAGE && isDemoHash()) open();
})(typeof globalThis !== 'undefined' ? globalThis : this);
