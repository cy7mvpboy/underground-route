/* exithere.js — 여기서 나가기: 지금 있는 곳에서 지하로 걸어 닿는 '지상으로 나가는 곳' 후보
   - 후보 종류(k): exit(역 출구, graph.json entrances) · portal(터널 출입구: 선로가 지상으로 나오는 곳)
                   · shaft / emergency_exit(터널 중간 환기구·수직구·비상 출구) · depot(차량기지)
     역 출구 말고는 web/data/egress.json(형식 'egress-1', build_egress.py)에서 온다. 파일이 없으면 역 출구만 쓴다.
   - 거리: 지금 위치에서 다익스트라(지하 간선만, 막은 간선 제외, 약 5km 까지)로 잰 지하 걷는 거리.
     지하 간선 = 가중치 1(터널·지하 승강장·지하 환승·출입구). 출입구 간선은 지상 허브에 붙은 것도 지난다(그 역 안에서 출구로 나갈 때).
   - 출발(start): {kind: 'edgept', e, t, only?}(선로 위 점) | {kind: 'node', node} | {kind: 'station', si, hubs?}
   - 후보의 target 은 router.js 의 'egress' 끝점이 그대로 쓴다: {node, m}(노드, m = 그 뒤 지상 걷기) 또는 {e, t}(선로 위 점).
   - DOM 을 쓰지 않는다(Node 검증 시험 scripts/check_exit_here.js 에서도 돈다). */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};
  const GR = UG.graph || (typeof require === 'function' ? require('./graph.js') : null);
  const RT = UG.router || (typeof require === 'function' ? require('./router.js') : null);

  const MAX_M = 5000;        // 이 거리(지하로 걷는 m)까지만 찾는다
  const DETOUR = 1.3;        // 차량기지 안 지상 길: 직선 × 1.3
  const KIND_KO = { exit: '출구', portal: '터널 출입구', shaft: '비상 출구·수직구', emergency_exit: '비상 출구·수직구', depot: '차량기지' };
  const NOTE_KO = { portal: '선로를 따라 지상으로 나감', depot: '차량기지 시설을 지나 나감' };
  // '서울역 1번 출구'(panel.js 의 exitName 과 같은 글. 이 파일은 Node 에서도 돌아 panel.js 없이 만든다)
  function exitName(st, ref) { return (st.endsWith('역') ? st : st + '역') + ' ' + (ref ? ref + '번 출구' : '출구'); }

  /* ---------- 지하 간선만 따라가는 다익스트라 (거리 m) ---------- */
  function sourcesOf(G, start) {
    const E = G.g.edges;
    if (start.kind === 'edgept') {
      const len = E.len[start.e];
      return [{ node: E.a[start.e], m: start.t * len }, { node: E.b[start.e], m: (1 - start.t) * len }]
        .filter(function (s) { return start.only == null || s.node === start.only; });
    }
    if (start.kind === 'node') return [{ node: start.node, m: 0 }];
    return (start.hubs || G.g.stations[start.si].hubs).map(function (v) { return { node: v, m: 0 }; });
  }

  function underDistances(G, sources, blocked, maxM) {
    const n = G.nNodes, E = G.g.edges, under = G.g.weights.under, entrance = G.codes.entrance;
    const dist = new Float64Array(n).fill(Infinity), done = new Uint8Array(n);
    const heap = new RT.Heap();
    sources.forEach(function (s) { if (s.m < dist[s.node]) { dist[s.node] = s.m; heap.push(s.m, s.node); } });
    while (heap.size()) {
      const top = heap.pop(), d = top[0], v = top[1];
      if (done[v]) continue;
      done[v] = 1;
      for (let k = G.adjStart[v]; k < G.adjStart[v + 1]; k++) {
        const e = G.adjEdge[k];
        if (e >= G.surfaceFrom || (blocked && blocked.has(e))) continue;
        if (G.weight[e] !== under && E.k[e] !== entrance) continue;     // 지하 간선만(출입구 간선은 예외)
        const w = G.adjNode[k], nd = d + E.len[e];
        if (nd <= maxM && nd < dist[w]) { dist[w] = nd; heap.push(nd, w); }
      }
    }
    return dist;
  }

  /* ---------- 후보 찾기 ----------
     opts: { egress(egress.json, 없으면 null), blocked(Set), maxM, limit(기본 10), perStation(역마다 출구 수, 기본 2),
             ownSi(이 역의 출구는 perStation 대신 8개까지), areas(si, ref) -> [출구 주변 이름] }
     돌려주는 값: { list: [후보], ms }
       후보 = { k, kindLabel, title, sub, note, lat, lon, under_m(지하 걷는 거리), extra_m(차량기지 안 지상 길), si, ref, target, item } */
  function findExits(G, start, opts) {
    opts = opts || {};
    const t0 = Date.now();
    const g = G.g, E = g.edges, N = g.nodes, EN = g.entrances, S = g.stations;
    const maxM = opts.maxM || MAX_M, limit = opts.limit || 10, per = opts.perStation || 2;
    const dist = underDistances(G, sourcesOf(G, start), opts.blocked || null, maxM);
    // 선로 위 점(간선 e, t)까지 거리: 양 끝 노드에서 + 같은 간선이면 바로
    const toEdgePoint = function (e, t) {
      const len = E.len[e];
      let d = Math.min(dist[E.a[e]] + t * len, dist[E.b[e]] + (1 - t) * len);
      if (start.kind === 'edgept' && start.e === e) {
        const ahead = t >= start.t ? E.b[e] : E.a[e];
        if (start.only == null || start.only === ahead) d = Math.min(d, Math.abs(t - start.t) * len);
      }
      return d;
    };
    const out = [];
    // 1) 역 출구
    for (let i = 0; i < EN.node.length; i++) {
      const v = EN.node[i], d = dist[v];
      if (!(d <= maxM)) continue;
      const si = EN.station[i], ref = EN.ref[i];
      const areas = opts.areas ? opts.areas(si, ref) : [];
      out.push({ k: 'exit', kindLabel: KIND_KO.exit, title: exitName(S[si].name, ref),
        sub: areas.length ? areas.slice(0, 3).join(', ') + ' 방면' : '', note: '', lat: N.lat[v] / 1e5, lon: N.lon[v] / 1e5,
        under_m: d, extra_m: 0, si: si, ref: ref, ent: i, target: { node: v, m: 0 }, item: null });
    }
    // 2) egress.json: 터널 출입구 · 수직구·비상 출구 · 차량기지
    const items = opts.egress && Array.isArray(opts.egress.items) ? opts.egress.items : [];
    items.forEach(function (it) {
      let best = null;
      if (it.k === 'portal') {
        [it.node].concat(it.nodes || []).forEach(function (v) {
          if (v != null && dist[v] <= maxM && (!best || dist[v] < best.d)) best = { d: dist[v], target: { node: v, m: 0 }, lat: N.lat[v] / 1e5, lon: N.lon[v] / 1e5 };
        });
      } else if (it.k === 'shaft' || it.k === 'emergency_exit') {
        [[it.edge, it.t]].concat(it.also || []).forEach(function (x) {
          if (x[0] == null || x[0] >= E.a.length) return;
          const d = toEdgePoint(x[0], x[1]);
          if (d <= maxM && (!best || d < best.d)) best = { d: d, target: { e: x[0], t: x[1] }, lat: it.lat, lon: it.lon };
        });
      } else if (it.k === 'depot') {
        // 기지 안 노드 중 (지하로 닿는 거리 + 기지 안 지상 길)이 가장 짧은 곳
        [it.node].concat(it.nodes || []).forEach(function (v) {
          if (v == null || !(dist[v] <= maxM)) return;
          const walk = GR.haversine(N.lat[v] / 1e5, N.lon[v] / 1e5, it.lat, it.lon) * DETOUR;
          if (!best || dist[v] + walk < best.d + best.target.m) best = { d: dist[v], target: { node: v, m: walk }, lat: it.lat, lon: it.lon };
        });
      }
      if (!best) return;
      out.push({ k: it.k, kindLabel: KIND_KO[it.k] || it.k, title: it.name, sub: '', note: noteOf(it), lat: best.lat, lon: best.lon,
        under_m: best.d, extra_m: best.target.m || 0, si: null, ref: '', target: best.target, item: it });
    });
    // 지하 걷는 거리 순. 같은 역의 출구는 가까운 몇 개만(큰 역은 출구가 10개 넘게 있다)
    out.sort(function (a, b) { return a.under_m - b.under_m || a.extra_m - b.extra_m; });
    const perSt = new Map(), list = [];
    for (const c of out) {
      if (c.k === 'exit') {
        const n = perSt.get(c.si) || 0, cap = c.si === opts.ownSi ? 8 : per;
        if (n >= cap) continue;
        perSt.set(c.si, n + 1);
      }
      list.push(c);
      if (list.length >= limit) break;
    }
    return { list: list, ms: Date.now() - t0 };
  }

  // 후보 아래 작은 글: 터널 출입구는 '선로를 따라 지상으로 나감'(바깥이 교량이면 덧붙임), 차량기지는 '차량기지 시설을 지나 나감'
  function noteOf(it) {
    if (it.k === 'portal') {
      const m = /바깥: ([^·]+)/.exec(it.note || '');
      return NOTE_KO.portal + (m && m[1].indexOf('지상') < 0 && m[1].indexOf('교량') >= 0 ? ' · 바깥은 교량' : '');
    }
    if (it.k === 'depot') return NOTE_KO.depot;
    return '';
  }

  /* ---------- GPS 위치를 선로에 붙이기 ----------
     경로에서 멀리 벗어난 GPS 위치: maxM 안에서 가장 가까운 선로 간선 위 점. 간선 범위 상자는 처음 한 번 만든다. */
  let boxes = null;
  function buildBoxes(G) {
    const g = G.g, E = g.edges, track = G.codes.track;
    boxes = [];
    for (let e = 0; e < E.a.length && e < G.surfaceFrom; e++) {
      if (E.k[e] !== track) continue;
      const pts = GR.edgeShape(g, e);
      let s = 90, w = 180, n = -90, ea = -180;
      pts.forEach(function (p) { s = Math.min(s, p[0]); n = Math.max(n, p[0]); w = Math.min(w, p[1]); ea = Math.max(ea, p[1]); });
      boxes.push([e, s, w, n, ea]);
    }
  }
  function snapToNetwork(G, lat, lon, maxM) {
    if (!boxes || boxes.G !== G) { buildBoxes(G); boxes.G = G; }
    const pad = (maxM || 300) / 111000, padLon = pad / Math.cos(lat * Math.PI / 180);
    const ky = 111320, kx = 111320 * Math.cos(lat * Math.PI / 180);
    let best = null;
    boxes.forEach(function (b) {
      if (lat < b[1] - pad || lat > b[3] + pad || lon < b[2] - padLon || lon > b[4] + padLon) return;
      const e = b[0], pts = GR.edgeShape(G.g, e), cum = GR.cumulative(pts), L = cum[cum.length - 1] || 1;
      for (let i = 0; i + 1 < pts.length; i++) {
        const ax = (pts[i][1] - lon) * kx, ay = (pts[i][0] - lat) * ky, bx = (pts[i + 1][1] - lon) * kx, by = (pts[i + 1][0] - lat) * ky;
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        const f = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
        const cx = ax + f * dx, cy = ay + f * dy, d = Math.sqrt(cx * cx + cy * cy);
        if (d <= (maxM || 300) && (!best || d < best.off)) {
          best = { kind: 'edgept', e: e, t: (cum[i] + f * (cum[i + 1] - cum[i])) / L, off: d,
            lat: pts[i][0] + f * (pts[i + 1][0] - pts[i][0]), lon: pts[i][1] + f * (pts[i + 1][1] - pts[i][1]) };
        }
      }
    });
    return best;
  }

  /* ---------- 경로 위의 수직구·비상 출구 (긴 터널 단계의 '○○m 앞 비상 출구') ----------
     돌려주는 값: [{at(경로 출발부터 m, 체크포인트 at 과 같은 기준), name, k}] at 순서 */
  function onRoute(G, plan, egress) {
    const items = egress && Array.isArray(egress.items) ? egress.items : [];
    const byEdge = new Map();
    items.forEach(function (it) {
      if (it.k !== 'shaft' && it.k !== 'emergency_exit') return;
      [[it.edge, it.t]].concat(it.also || []).forEach(function (x) {
        if (!byEdge.has(x[0])) byEdge.set(x[0], []);
        byEdge.get(x[0]).push({ it: it, t: x[1] });
      });
    });
    if (!byEdge.size) return [];
    const E = G.g.edges, path = plan.route.path, out = [], seen = new Set();
    let at = 0;
    plan.items.forEach(function (item) {
      // 간선 일부(선로 위 지금 위치에서 출발, 수직구로 나감): t0 -> t1 사이에 있는 것
      const part = item.kind === 'approach' ? item.part : item.kind === 'egress' && !item.surface ? plan.route.endPart : null;
      if (part) {
        (byEdge.get(part.e) || []).forEach(function (x) {
          const lo = Math.min(part.t0, part.t1), hi = Math.max(part.t0, part.t1);
          if (seen.has(x.it) || x.t < lo || x.t > hi) return;
          seen.add(x.it);
          out.push({ at: at + Math.abs(x.t - part.t0) * E.len[part.e], name: x.it.name, k: x.it.k });
        });
      }
      if (item.kind !== 'step') { at += item.m || 0; return; }
      if (item.step.type === 'warning') return;
      item.step._idx.forEach(function (i) {
        const p = path[i], len = item.step.type === 'surface' && item.step._m != null ? item.step._m : E.len[p.e];
        (byEdge.get(p.e) || []).forEach(function (x) {
          if (seen.has(x.it)) return;
          seen.add(x.it);
          out.push({ at: at + (p.u === E.a[p.e] ? x.t : 1 - x.t) * len, name: x.it.name, k: x.it.k });
        });
        at += len;
      });
    });
    return out.sort(function (a, b) { return a.at - b.at; });
  }

  UG.exithere = { MAX_M: MAX_M, KIND_KO: KIND_KO, noteOf: noteOf, findExits: findExits, underDistances: underDistances, snapToNetwork: snapToNetwork, onRoute: onRoute };
  if (typeof module !== 'undefined' && module.exports) module.exports = UG.exithere;
})(typeof globalThis !== 'undefined' ? globalThis : this);
