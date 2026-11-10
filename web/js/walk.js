/* walk.js — 지상 도보 구간을 실제 길로 바꾸기 (FOSSGIS OSRM 도보 경로, 인터넷이 될 때만)
   - 바꾸는 구간: 출발 지점 -> 들어갈 출구, 나올 출구 -> 도착 지점, 지상으로 바로 걷기,
     역 사이 '지상 걷기' 간선, 가장 가까운 지하로 후보(내 위치 -> 출구).
   - 화면은 먼저 직선(× 1.3)으로 그리고, 실제 길을 받으면 선 모양과 거리·시간·노출을 바꾼다(화면을 막지 않는다).
   - 받기: 경로 하나에 최대 5번, 4초 안에 안 오면 포기. 실패하면(오프라인, claude.ai 미리보기의 외부 요청 차단)
     직선을 그대로 쓰고 2분 동안 다시 묻지 않는다.
   - 간격: FOSSGIS 이용 정책(초당 1회 이하)에 맞춰 요청을 줄 세워 1초 간격으로 보낸다.
   - 저장: 두 점 좌표를 소수 4자리(약 10m)로 반올림한 열쇠로 메모리와 localStorage 에 둔다.
   - fetch 를 바꿔 끼울 수 있어(setFetch) Node 에서 시험한다: node scripts\check_walk.js */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};
  const GR = UG.graph || (typeof require === 'function' ? require('./graph.js') : null);

  const URL = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/';
  const ATTRIBUTION = '도보 경로: FOSSGIS OSRM · © OpenStreetMap';
  const MAX_LEGS = 5;              // 경로 하나에 묻는 횟수
  const STORE_KEY = 'ugmap.walk.v1', STORE_MAX = 300;
  const OFF_MS = 120000;           // 실패한 뒤 쉬는 시간
  const cfg = { timeoutMs: 4000, gapMs: 1000 };   // gapMs: 요청 사이 최소 간격

  let fetchFn = typeof fetch === 'function' ? fetch.bind(root) : null;
  let offUntil = 0, calls = 0;
  let lastAt = 0, gate = Promise.resolve();   // 요청 줄: 앞 요청을 보낸 시각부터 cfg.gapMs 뒤에 다음 요청

  // 다음 요청을 보내도 되는 때에 풀리는 Promise
  function slot() {
    const s = gate.then(function () {
      const wait = lastAt + cfg.gapMs - Date.now();
      return wait > 0 ? new Promise(function (r) { setTimeout(r, wait); }) : null;
    }).then(function () { lastAt = Date.now(); });
    gate = s;
    return s;
  }
  const mem = new Map();           // 열쇠 -> {m, pts}
  const pending = new Map();       // 열쇠 -> Promise (같은 구간을 동시에 두 번 묻지 않는다)

  function setFetch(fn) { fetchFn = fn; offUntil = 0; }
  function config(o) { Object.assign(cfg, o || {}); }
  function stats() { return { calls: calls, cached: mem.size, off: Date.now() < offUntil }; }
  function reset() { mem.clear(); pending.clear(); offUntil = 0; calls = 0; lastAt = 0; }
  if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('online', function () { offUntil = 0; });

  function key(a, b) { return [a[0], a[1], b[0], b[1]].map(function (v) { return (+v).toFixed(4); }).join(','); }

  /* ---------- 기기 저장 ---------- */
  let storeLoaded = false;
  function loadStore() {
    if (storeLoaded) return;
    storeLoaded = true;
    try {
      const s = JSON.parse(root.localStorage.getItem(STORE_KEY) || '{}');
      Object.keys(s).forEach(function (k) { if (s[k] && s[k].m > 0 && s[k].p) mem.set(k, { m: s[k].m, pts: GR.decodePolyline(s[k].p) }); });
    } catch (e) { /* 저장소를 못 쓰면 메모리만 */ }
  }
  function encode(pts) {   // Google 폴리라인 인코딩(소수 5자리)
    let out = '', plat = 0, plon = 0;
    const enc = function (v) { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
    pts.forEach(function (p) { const la = Math.round(p[0] * 1e5), lo = Math.round(p[1] * 1e5); out += enc(la - plat) + enc(lo - plon); plat = la; plon = lo; });
    return out;
  }
  function saveStore() {
    try {
      const obj = {};
      Array.from(mem.keys()).slice(-STORE_MAX).forEach(function (k) { const v = mem.get(k); obj[k] = { m: Math.round(v.m * 10) / 10, p: encode(v.pts) }; });
      root.localStorage.setItem(STORE_KEY, JSON.stringify(obj));
    } catch (e) { /* 무시 */ }
  }

  /* ---------- 구간 하나 받기 ----------
     a, b = [lat, lon]. 돌려주는 값: {m(걷는 거리), pts(a 에서 b 까지의 선)} 또는 null(못 받음) */
  function leg(a, b) {
    loadStore();
    const k = key(a, b);
    if (mem.has(k)) return Promise.resolve(mem.get(k));
    if (pending.has(k)) return pending.get(k);
    if (!fetchFn || Date.now() < offUntil) return Promise.resolve(null);
    const straight = GR.haversine(a[0], a[1], b[0], b[1]);
    if (straight < 15) return Promise.resolve(null);   // 너무 가까우면 직선으로 충분
    const url = URL + (+a[1]).toFixed(6) + ',' + (+a[0]).toFixed(6) + ';' + (+b[1]).toFixed(6) + ',' + (+b[0]).toFixed(6) +
      '?overview=full&geometries=polyline';
    const p = slot().then(function () {
      if (Date.now() < offUntil) return null;   // 줄 서 있는 사이 막힌 것이 확인되면 묻지 않는다
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      let timedOut = false;
      const timer = setTimeout(function () { timedOut = true; if (ctrl) ctrl.abort(); }, cfg.timeoutMs);   // 보낸 때부터 잰다
      calls++;
      return Promise.resolve().then(function () { return fetchFn(url, ctrl ? { signal: ctrl.signal } : undefined); })
        .then(function (res) {
          if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
          return res.json();
        })
        .then(function (data) {
          const r = parse(data, a, b, straight);
          if (r) { mem.set(k, r); saveStore(); }
          return r;
        })
        .catch(function () {
          if (!timedOut) offUntil = Date.now() + OFF_MS;   // 막힌 곳(미리보기·오프라인)에서는 한동안 묻지 않는다
          return null;
        })
        .then(function (r) { clearTimeout(timer); return r; });
    }).then(function (r) { pending.delete(k); return r; });
    pending.set(k, p);
    return p;
  }

  // OSRM 응답 -> {m, pts}. 길 위로 붙인 끝점과 실제 점 사이 직선을 앞뒤에 더한다.
  function parse(data, a, b, straight) {
    const r = data && data.code === 'Ok' && data.routes && data.routes[0];
    if (!r || typeof r.geometry !== 'string' || !(r.distance >= 0)) return null;
    const pts = GR.decodePolyline(r.geometry);
    if (!pts.length) return null;
    const head = GR.haversine(a[0], a[1], pts[0][0], pts[0][1]);
    const tail = GR.haversine(pts[pts.length - 1][0], pts[pts.length - 1][1], b[0], b[1]);
    const m = r.distance + head + tail;
    if (m > straight * 6 + 2000) return null;   // 강 건너편에 붙는 등 이상한 결과는 버린다
    return { m: m, pts: [a.slice()].concat(pts, [b.slice()]) };
  }

  /* ---------- 경로의 지상 구간 목록 (최대 5개) ----------
     id: 'walk' | 'start' | 'end' | 's<경로 안 간선 위치>' */
  function legsOf(G, p) {
    const r = p.route, N = G.g.nodes, out = [];
    const ll = function (v) { return [N.lat[v] / 1e5, N.lon[v] / 1e5]; };
    if (r.walk) out.push({ id: 'walk', a: [p.from.lat, p.from.lon], b: [p.to.lat, p.to.lon] });
    if (r.startConn) out.push({ id: 'start', a: [p.from.lat, p.from.lon], b: [r.startConn.lat, r.startConn.lon] });
    if (r.endConn) out.push({ id: 'end', a: [r.endConn.lat, r.endConn.lon], b: [p.to.lat, p.to.lon] });
    r.path.forEach(function (x, i) { if (G.g.edges.k[x.e] === G.codes.surface) out.push({ id: 's' + i, a: ll(x.u), b: ll(x.v) }); });
    return out.slice(0, MAX_LEGS);
  }

  // 지상 구간을 모두 물어 {id: {m, pts}} 로 모은다(못 받은 것은 빠진다)
  function fetchLegs(G, p) {
    const list = legsOf(G, p);
    return Promise.all(list.map(function (l) { return leg(l.a, l.b).then(function (r) { return [l.id, r]; }); }))
      .then(function (pairs) { const o = {}; pairs.forEach(function (x) { if (x[1]) o[x[0]] = x[1]; }); return o; });
  }

  /* ---------- 받은 길을 안내 목록과 요약에 반영 ----------
     steps.planItems() 뒤에 부른다(속도를 바꿔 목록을 다시 만들어도 다시 부르면 된다).
     p.legs = {id: {m, pts}}. 바꾸는 것: 항목 거리·시간·선 모양, 지상 걷기 단계와 그 노출 경고, 요약(총거리·노출·시간). */
  function applyLegs(G, p, speedKmh) {
    const L = p.legs || {}, mpm = (speedKmh || 3.5) * 1000 / 60, r = p.route, E = G.g.edges;
    const round = UG.steps ? UG.steps.pyRound : Math.round;
    let delta = 0, used = false;
    // 차량기지 연결(router.egressConns)은 나가는 곳 ↔ 기지 안 대표 노드(inner)를 도로 길 뒤·앞에 그대로 붙인다
    const setItem = function (it, l, enter) {
      if (!it || !l) return;
      const c = it.conn, inner = c && c.inner ? c.inner : 0, m = l.m + inner;
      delta += m - it.m;
      it.m = m; it.min = m / mpm; it.street = true; used = true;
      it.latlngs = !inner ? l.pts : enter ? l.pts.concat([[c.inLat, c.inLon]]) : [[c.inLat, c.inLon]].concat(l.pts);
    };
    p.items.forEach(function (it) {
      if (it.kind === 'walk') setItem(it, L.walk);
      else if (it.kind === 'enter') setItem(it, L.start, true);
      else if (it.kind === 'exit') setItem(it, L.end, false);
      else if (it.kind === 'step' && it.step.type === 'surface') {
        const i = it.step._idx[0], l = L['s' + i];
        if (!l) return;
        const d = l.m - E.len[r.path[i].e];
        delta += d; used = true;
        const s = it.step;
        s.distance_m = round(l.m); s.est_minutes = round(l.m / mpm); s.exposure_m = s.distance_m;
        s._m = l.m; s._pts = l.pts; s._street = true;
        // 이 간선이 든 지상 노출 경고도 거리를 고친다
        p.items.forEach(function (w) {
          if (w.kind !== 'step' || w.step.type !== 'warning' || (w.step._idx || []).indexOf(i) < 0) return;
          w.step.exposure_m = round(w.step.exposure_m + d);
          if (w.step.structures.ground != null) w.step.structures.ground = round(w.step.structures.ground + d);
        });
      }
    });
    p.view.total_m = r.total_m + delta;
    p.view.exposed_m = r.exposed_m + delta;
    p.view.minutes = p.view.total_m / mpm;
    p.view.street = used;
    return used;
  }

  /* ---------- 가장 가까운 지하로 후보 다듬기 ----------
     직선 거리로 고른 앞 3곳만 실제 걷는 거리를 물어, 그 거리로 다시 줄 세운다.
     돌려주는 값: { options(새 순서), changed(1순위가 바뀌었나), street(하나라도 받았나) } */
  function refineNearest(lat, lon, options) {
    const top = options.slice(0, 3);
    return Promise.all(top.map(function (o) { return leg([lat, lon], [o.lat, o.lon]); })).then(function (res) {
      let street = false;
      top.forEach(function (o, i) { if (res[i]) { o.len = res[i].m; o.street = res[i].pts; street = true; } });
      const sorted = top.slice().sort(function (x, y) { return x.len - y.len; }).concat(options.slice(3));
      return { options: sorted, changed: sorted[0] !== options[0], street: street };
    });
  }

  UG.walk = {
    ATTRIBUTION: ATTRIBUTION, MAX_LEGS: MAX_LEGS, key: key, leg: leg, parse: parse, legsOf: legsOf, fetchLegs: fetchLegs,
    applyLegs: applyLegs, refineNearest: refineNearest, setFetch: setFetch, config: config, stats: stats, reset: reset, encode: encode
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = UG.walk;
})(typeof globalThis !== 'undefined' ? globalThis : this);
