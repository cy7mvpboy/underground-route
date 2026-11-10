/* router.js — 지상 노출이 가장 적은 도보 경로 찾기 (scripts/route.py 의 dijkstra 를 옮김)
   - 비용 = 길이 × 가중치. 터널·출입구·지하 환승 1, 교량·지상 1000 (지상 1m = 지하 1km).
   - 출발·도착은 역(그 역의 승강장 허브 전부) 또는 지도 위의 점.
     점은 가까운 출입구(1.5km 안 3곳)에 '가상 지상 간선'(직선 거리 × 1.3)으로 잇고, 이 거리는 지상 노출로 센다.
     egress.json 을 주면 1.5km 안의 터널 출입구·차량기지(가까운 3곳)도 같은 방식으로 잇는다(사용자 결정 2026-11-11).
     어디로 들어가고 나올지는 다른 후보와 똑같이 비용으로 고른다.
   - 막힌 간선(간선 번호 Set)은 없는 것으로 본다.
   - '여기서 나가기'(exithere.js): 출발은 선로 위의 점(edgept), 도착은 나갈 곳(egress: 출구·터널 출입구·수직구·차량기지)일 수 있다.
     이때 간선의 일부(startPart·endPart)를 경로 앞뒤에 붙인다.
   - 대안 경로(사용자 결정 2026-11-11): 기본은 지하 우선(지상 1000) 그대로. 지상 가중치를 ALT.exposedW(15)로 낮춰
     한 번 더 찾고, 꽤 짧아질 때만(alternative) 결과 카드에 한 줄로 보여 준다. 기본 탐색 결과는 바뀌지 않는다.
   - DOM·Leaflet 을 쓰지 않는다(Node 검증 시험에서도 돈다). */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};
  const GR = UG.graph || (typeof require === 'function' ? require('./graph.js') : null);

  const DETOUR = 1.3;          // 지상 걷기: 직선 거리 × 1.3 (길이 곧지 않은 것)
  const NEAR_M = 1500;         // 점에서 출입구를 찾는 반경
  const NEAR_COUNT = 3;        // 잇는 출입구(또는 역) 수
  const FALLBACK_M = 20000;    // 출입구가 없을 때 역을 찾는 반경
  // 대안 경로: 지상 1m = 지하 15m 로 보고 찾은 길이 '걸리는 시간 20% 이상 또는 30분 이상 줄고, 지상 노출은 2km 이하로만 늚'일 때만 보여 준다
  const ALT = { exposedW: 15, minSavedFrac: 0.2, minSavedMin: 30, maxExtraExposedM: 2000 };

  /* ---------- 이진 힙: (비용, 노드) 순으로 작은 것을 꺼낸다 ----------
     route.py 의 heapq 는 튜플 (비용, 노드)를 비교하므로, 비용이 같으면 노드 번호가 작은 것이 먼저다.
     같은 순서로 꺼내야 비용이 같은 경로 중 같은 것을 고른다. */
  function Heap() { this.c = []; this.v = []; }
  Heap.prototype.size = function () { return this.c.length; };
  Heap.prototype.less = function (i, j) { return this.c[i] < this.c[j] || (this.c[i] === this.c[j] && this.v[i] < this.v[j]); };
  Heap.prototype.swap = function (i, j) {
    const c = this.c[i]; this.c[i] = this.c[j]; this.c[j] = c;
    const v = this.v[i]; this.v[i] = this.v[j]; this.v[j] = v;
  };
  Heap.prototype.push = function (cost, node) {
    this.c.push(cost); this.v.push(node);
    let i = this.c.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p); i = p;
    }
  };
  Heap.prototype.pop = function () {   // [비용, 노드]
    const top = [this.c[0], this.v[0]];
    const lc = this.c.pop(), lv = this.v.pop();
    if (this.c.length) {
      this.c[0] = lc; this.v[0] = lv;
      let i = 0;
      const n = this.c.length;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < n && this.less(l, m)) m = l;
        if (r < n && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return top;
  };

  /* ---------- 다익스트라 ----------
     sources, targets: [{node, cost}] (cost = 그 노드까지/부터의 시작 비용, 역이면 0)
     direct: 출발점에서 도착점까지 바로 걷는 비용(둘 다 지도 위 점일 때만, 아니면 Infinity)
     surface: true 면 역 사이 '지상 걷기' 간선도 쓴다(지하로 갈 길이 없을 때의 대비책)
     weight: 간선 가중치 배열(없으면 G.weight = 지하 1, 지상 1000). 대안 경로는 weightsFor 로 만든 배열
     도착 비용이 0 인 목표는 route.py 처럼 꺼내는 즉시 끝낸다.
     도착 비용이 있으면 가상 도착 노드 END(= 노드 수)를 두고 END 를 꺼낼 때 끝낸다.
     돌려주는 값: { end: 마지막 실제 노드(-1 = 바로 걷기), cost, prevEdge, prevNode } 또는 null */
  function dijkstra(G, sources, targets, blocked, direct, surface, weight) {
    const n = G.nNodes, END = n;
    const noWalk = surface ? Infinity : G.surfaceFrom;   // 지상 걷기 간선(graph.js)은 surface 일 때만 쓴다
    weight = weight || G.weight;
    const len = G.g.edges.len, adjStart = G.adjStart, adjEdge = G.adjEdge, adjNode = G.adjNode;
    const cost = new Float64Array(n + 1).fill(Infinity);
    const prevEdge = new Int32Array(n + 1).fill(-1);   // 노드 -> 직전 간선(-1 = 출발점)
    const prevNode = new Int32Array(n + 1).fill(-1);
    const done = new Uint8Array(n + 1);
    const tcost = new Map();                           // 목표 노드 -> 도착 비용
    targets.forEach(function (t) { const c = t.cost || 0; if (!tcost.has(t.node) || c < tcost.get(t.node)) tcost.set(t.node, c); });
    const heap = new Heap();
    sources.forEach(function (s) {
      const c = s.cost || 0;
      if (c < cost[s.node]) { cost[s.node] = c; heap.push(c, s.node); }
    });
    if (direct != null && isFinite(direct)) { cost[END] = direct; heap.push(direct, END); }

    while (heap.size()) {
      const top = heap.pop(), c = top[0], v = top[1];
      if (done[v]) continue;
      done[v] = 1;
      if (v === END) return { end: prevNode[END], cost: c, prevEdge: prevEdge, prevNode: prevNode };
      if (tcost.has(v)) {
        const tc = tcost.get(v);
        if (tc === 0) return { end: v, cost: c, prevEdge: prevEdge, prevNode: prevNode };
        if (c + tc < cost[END]) { cost[END] = c + tc; prevNode[END] = v; heap.push(c + tc, END); }
      }
      for (let k = adjStart[v]; k < adjStart[v + 1]; k++) {
        const ei = adjEdge[k];
        if (ei >= noWalk || (blocked && blocked.has(ei))) continue;
        const w = adjNode[k];
        const nc = c + len[ei] * weight[ei];
        if (nc < cost[w]) { cost[w] = nc; prevEdge[w] = ei; prevNode[w] = v; heap.push(nc, w); }
      }
    }
    return null;
  }

  // 직전 간선을 거꾸로 따라가 경로를 [{e, u, v}, …] 로 만든다(u -> v 방향).
  function pathEdges(res) {
    const path = [];
    let v = res.end;
    while (v >= 0 && res.prevEdge[v] >= 0) {
      path.push({ e: res.prevEdge[v], u: res.prevNode[v], v: v });
      v = res.prevNode[v];
    }
    path.reverse();
    return path;
  }

  /* ---------- 지도 위의 점 잇기 ---------- */
  // 점에서 가까운 출입구 3곳(1.5km 안)과, 출입구 자료가 없는 1.5km 안의 역(허브)을 고른다.
  // 둘 다 없으면 20km 안에서 가장 가까운 역 3곳의 허브. egress(egress.json)를 주면 터널 출입구·차량기지도 더한다(egressConns).
  // 돌려주는 값: 연결 후보 목록(가까운 순)
  //   {kind: 'entrance'|'hub'|'portal'|'depot', node, si, ent, ref, lat, lon, dist(직선 m), len(걷는 거리 m = dist × 1.3 (+ 기지 안 inner))}
  //   portal·depot 은 name(egress.json 이름), eg(항목 번호)도. si 는 그 노드에서 가장 가까운 역(안내 문장의 '출발역')
  function connectPoint(G, lat, lon, egress) {
    const g = G.g, EN = g.entrances, N = g.nodes;
    const near = [];
    for (let i = 0; i < EN.node.length; i++) {
      const v = EN.node[i], la = N.lat[v] / 1e5, lo = N.lon[v] / 1e5;
      const d = GR.haversine(lat, lon, la, lo);
      if (d <= NEAR_M) near.push({ kind: 'entrance', node: v, si: EN.station[i], ent: i, ref: EN.ref[i], lat: la, lon: lo, dist: d });
    }
    near.sort(function (a, b) { return a.dist - b.dist; });
    const out = near.slice(0, NEAR_COUNT);

    // 역마다 직선 거리
    const st = g.stations.map(function (s, si) { return { si: si, dist: GR.haversine(lat, lon, s.lat / 1e5, s.lon / 1e5) }; })
      .sort(function (a, b) { return a.dist - b.dist; });
    let pick = st.filter(function (s) { return s.dist <= NEAR_M && G.stationEntrances[s.si].length === 0; }).slice(0, NEAR_COUNT);
    if (!out.length && !pick.length) pick = st.filter(function (s) { return s.dist <= FALLBACK_M; }).slice(0, NEAR_COUNT);
    pick.forEach(function (s) {
      g.stations[s.si].hubs.forEach(function (v) {
        const la = N.lat[v] / 1e5, lo = N.lon[v] / 1e5;
        out.push({ kind: 'hub', node: v, si: s.si, ent: -1, ref: '', lat: la, lon: lo, dist: GR.haversine(lat, lon, la, lo) });
      });
    });
    egressConns(G, lat, lon, egress).forEach(function (c) { out.push(c); });
    out.forEach(function (c) { c.len = c.dist * DETOUR + (c.inner || 0); });
    out.sort(function (a, b) { return a.dist - b.dist; });
    return out;
  }

  /* 터널 출입구(portal)·차량기지(depot) 후보(egress.json 형식 egress-1, graph-format.md 19절): 점에서 1.5km 안의 가까운 3곳.
     - 터널 출입구: 묶은 출입구 노드(nodes) 하나하나(나란한 선로). 걷는 곳 = 그 노드
     - 차량기지: 대표 노드(node). 걷는 곳 = 나가는 곳(lat/lon, 출입문 또는 도로에 가까운 경계)이고,
       거기서 대표 노드까지 기지 안을 더 걷는다(inner = 직선 × 1.3, 지상 노출. inLat/inLon = 대표 노드)
     수직구·비상 출구는 넣지 않는다(오르내릴 수 있는지 모름). '가장 가까운 지하로'(nearest.js)는 이 후보를 쓰지 않는다. */
  function egressConns(G, lat, lon, egress) {
    if (!egress || !Array.isArray(egress.items)) return [];
    const N = G.g.nodes, near = [];
    egress.items.forEach(function (it, i) {
      if ((it.k !== 'portal' && it.k !== 'depot') || it.node == null || !(it.node < G.nNodes)) return;
      const d = GR.haversine(lat, lon, it.lat, it.lon);
      if (d <= NEAR_M) near.push({ it: it, i: i, d: d });
    });
    near.sort(function (a, b) { return a.d - b.d; });
    const out = [];
    near.slice(0, NEAR_COUNT).forEach(function (x) {
      const it = x.it;
      if (it.k === 'portal') {
        (it.nodes && it.nodes.length ? it.nodes : [it.node]).forEach(function (v) {
          if (!(v < G.nNodes)) return;
          const la = N.lat[v] / 1e5, lo = N.lon[v] / 1e5;
          out.push({ kind: 'portal', node: v, si: nearestSi(G, v), ent: -1, ref: '', eg: x.i, name: it.name, lat: la, lon: lo, dist: GR.haversine(lat, lon, la, lo) });
        });
      } else {
        const v = it.node, la = N.lat[v] / 1e5, lo = N.lon[v] / 1e5;
        out.push({ kind: 'depot', node: v, si: nearestSi(G, v), ent: -1, ref: '', eg: x.i, name: it.name, lat: it.lat, lon: it.lon, dist: x.d,
          inner: GR.haversine(it.lat, it.lon, la, lo) * DETOUR, inLat: la, inLon: lo });
      }
    });
    return out;
  }

  // 출발·도착 끝점 -> 다익스트라에 넣을 노드 목록
  //   역:  {kind: 'station', si, hubs?}   -> 허브들(비용 0). hubs 를 주면 그 허브만(예: 지하 허브)
  //   노드: {kind: 'node', node}           -> 그래프 노드 하나(길 안내 중 '마지막으로 확인한 역'에서 다시 찾을 때)
  //   점:  {kind: 'point', lat, lon, conn} -> 연결 후보(비용 = 걷는 거리 × 지상 가중치)
  //   선로 위 점: {kind: 'edgept', e, t, only?} -> 간선 e 의 양 끝(비용 = 그 끝까지 걷는 거리 × 가중치).
  //               t = 간선 a 쪽에서 잰 위치(0~1). only 를 주면 그 끝 노드 쪽으로만 간다('여기서 나가기', 앞이 막혀 되돌아갈 때)
  //   나갈 곳: {kind: 'egress', cand}     -> exithere.js 의 후보 하나. cand.target 이 {node, m} 이면 그 노드
  //               (m = 노드에서 지상 출구까지 더 걷는 지상 거리, 차량기지), {e, t} 이면 선로 위 그 점(수직구)
  // W = { weight: 간선 가중치 배열, exposed: 지상 1m 의 비용 } (weightsFor). 없으면 기본(지하 1, 지상 1000)
  function weightsFor(G, exposedW) {
    if (exposedW == null || exposedW === G.g.weights.exposed) return { weight: G.weight, exposed: G.g.weights.exposed };
    if (!G._altW || G._altW.exposed !== exposedW) {   // 그래프마다 한 번 만들어 둔다
      const under = G.g.weights.under, arr = new Float64Array(G.weight.length);
      for (let e = 0; e < arr.length; e++) arr[e] = G.weight[e] === under ? under : exposedW;
      G._altW = { weight: arr, exposed: exposedW };
    }
    return G._altW;
  }
  function edgeEnds(G, e, t, only, W) {
    const E = G.g.edges, len = E.len[e], w = (W ? W.weight : G.weight)[e];
    return [{ node: E.a[e], cost: t * len * w }, { node: E.b[e], cost: (1 - t) * len * w }]
      .filter(function (x) { return only == null || x.node === only; });
  }
  function endpointNodes(G, ep, W) {
    if (ep.kind === 'station') return (ep.hubs || G.g.stations[ep.si].hubs).map(function (v) { return { node: v, cost: 0 }; });
    if (ep.kind === 'node') return [{ node: ep.node, cost: 0 }];
    if (ep.kind === 'edgept') return edgeEnds(G, ep.e, ep.t, ep.only, W);
    const exposed = W ? W.exposed : G.g.weights.exposed;
    if (ep.kind === 'egress') {
      const tg = ep.cand.target;
      return tg.e != null ? edgeEnds(G, tg.e, tg.t, null, W) : [{ node: tg.node, cost: (tg.m || 0) * exposed }];
    }
    return ep.conn.map(function (c) { return { node: c.node, cost: c.len * exposed }; });
  }

  // 간선 e 의 일부(t0 -> t1, 둘 다 a 쪽에서 잰 0~1): 걷는 방향 그대로의 선 모양과 길이
  function edgePart(G, e, t0, t1) {
    const E = G.g.edges, pts = GR.edgeShape(G.g, e), cum = GR.cumulative(pts), L = cum[cum.length - 1];
    const lo = Math.min(t0, t1), hi = Math.max(t0, t1);
    let part = GR.sliceAlong(pts, cum, lo * L, hi * L);
    if (t0 > t1) part = part.reverse();
    const m = (hi - lo) * E.len[e];
    return { e: e, t0: t0, t1: t1, m: m, pts: part, exposed: G.weight[e] !== G.g.weights.under ? m : 0 };
  }

  function pickConn(ep, node) {
    if (ep.kind !== 'point') return null;
    let best = null;
    ep.conn.forEach(function (c) { if (c.node === node && (!best || c.len < best.len)) best = c; });
    return best;
  }

  /* ---------- 경로 찾기 ----------
     돌려주는 값(없으면 null):
       { path: [{e,u,v}], startSi, endSi, startConn, endConn, walk(바로 걷기), walk_m,
         startPart(선로 위 점에서 첫 노드까지 간선 일부), endPart(마지막 노드에서 수직구까지 간선 일부),
         endWalk(차량기지: 마지막 노드에서 지상 출구까지 {m, pts}), egress(나갈 곳 후보),
         path_m, path_exposed_m(실제 간선만), total_m, exposed_m(가상 지상 간선·간선 일부 포함, 반올림 전 값) }
     opts: { blocked, surface, exposedW(지상 1m 의 비용, 없으면 1000 = route.py 와 같음) } */
  function findRoute(G, from, to, opts) {
    opts = opts || {};
    const g = G.g, E = g.edges, W = weightsFor(G, opts.exposedW);
    const src = endpointNodes(G, from, W), dst = endpointNodes(G, to, W);
    if (!src.length || !dst.length) return null;
    let direct = Infinity, walk = 0, same = false;
    if (from.kind === 'point' && to.kind === 'point') {
      walk = GR.haversine(from.lat, from.lon, to.lat, to.lon) * DETOUR;
      direct = walk * W.exposed;
    }
    // 선로 위 점 -> 같은 간선 위의 수직구: 노드를 거치지 않고 간선을 따라 바로 간다(긴 터널 한가운데)
    const tg = to.kind === 'egress' ? to.cand.target : null;
    if (from.kind === 'edgept' && tg && tg.e === from.e) {
      const ahead = tg.t >= from.t ? E.b[from.e] : E.a[from.e];
      if (from.only == null || from.only === ahead) { direct = Math.abs(tg.t - from.t) * E.len[from.e] * W.weight[from.e]; same = true; }
    }
    const res = dijkstra(G, src, dst, opts.blocked || null, direct, !!opts.surface, W.weight);
    if (!res) return null;
    if (res.end < 0 && same) return finish(G, from, to, [], null, edgePart(G, from.e, from.t, tg.t), null, null);
    if (res.end < 0) {   // 지하로 가는 것보다 지상으로 바로 걷는 쪽이 노출이 적다
      return { path: [], walk: true, walk_m: walk, startSi: -1, endSi: -1, startConn: null, endConn: null,
        path_m: 0, path_exposed_m: 0, total_m: walk, exposed_m: walk };
    }
    const path = pathEdges(res);
    const first = path.length ? path[0].u : res.end;
    // 선로 위 점에서 출발: 첫 노드 쪽으로 간선 일부를 걷는다
    const startPart = from.kind === 'edgept' ? edgePart(G, from.e, from.t, first === E.a[from.e] ? 0 : 1) : null;
    let endPart = null, endWalk = null;
    if (tg && tg.e != null) endPart = edgePart(G, tg.e, res.end === E.a[tg.e] ? 0 : 1, tg.t);
    else if (tg && tg.m > 0) endWalk = { m: tg.m, pts: [GR.nodeLatLng(g, res.end), [to.cand.lat, to.cand.lon]] };
    return finish(G, from, to, path, res.end, startPart, endPart, endWalk);
  }

  // 노드 v 에서 직선으로 가장 가까운 역 번호
  function nearestSi(G, v) {
    const g = G.g, la = g.nodes.lat[v] / 1e5, lo = g.nodes.lon[v] / 1e5;
    let best = -1, bd = Infinity;
    g.stations.forEach(function (s, si) { const d = GR.haversine(la, lo, s.lat / 1e5, s.lon / 1e5); if (d < bd) { bd = d; best = si; } });
    return best;
  }

  // 경로 결과 모으기(거리·노출·출발/도착 역)
  function finish(G, from, to, path, end, startPart, endPart, endWalk) {
    const g = G.g;
    const first = path.length ? path[0].u : end;
    const startConn = pickConn(from, first), endConn = pickConn(to, end);
    let pm = 0, pe = 0;
    path.forEach(function (p) {
      pm += g.edges.len[p.e];
      if (G.weight[p.e] !== g.weights.under) pe += g.edges.len[p.e];
    });
    const extra = (startConn ? startConn.len : 0) + (endConn ? endConn.len : 0) + (endWalk ? endWalk.m : 0);
    const parts = [startPart, endPart].filter(Boolean);
    const partM = parts.reduce(function (s, x) { return s + x.m; }, 0), partX = parts.reduce(function (s, x) { return s + x.exposed; }, 0);
    const siOf = function (ep, conn) {
      // 선로 위 점: 안내 문장의 '출발역'이 필요하므로 정해 주지 않았으면 가장 가까운 역
      if (ep.kind === 'edgept') return ep.si != null && ep.si >= 0 ? ep.si : nearestSi(G, g.edges.a[ep.e]);
      if (ep.kind === 'station' || ep.kind === 'node') return ep.si != null ? ep.si : -1;
      if (ep.kind === 'egress') return ep.cand.si != null ? ep.cand.si : -1;
      return conn.si;
    };
    return {
      path: path, walk: false, walk_m: 0,
      startSi: siOf(from, startConn), endSi: siOf(to, endConn),
      startConn: startConn, endConn: endConn, startPart: startPart, endPart: endPart, endWalk: endWalk,
      egress: to.kind === 'egress' ? to.cand : null,
      path_m: pm, path_exposed_m: pe, total_m: pm + extra + partM, exposed_m: pe + extra + partX
    };
  }

  /* ---------- 대안 경로(지상을 조금 걸어 크게 줄이는 길) ----------
     main = 기본 탐색(지하 우선) 결과. 지상 가중치 ALT.exposedW 로 다시 찾아(지하로 갈 길이 없으면 지상 걷기 간선도),
     아래를 모두 만족할 때만 돌려준다. 아니면 null.
       - 다른 경로(지나는 간선이 다름)  - 걷는 시간이 20% 이상 또는 30분 이상 줆  - 늘어나는 지상 노출 2km 이하
     돌려주는 값: { route, saved_m(줄어드는 거리), saved_min, extra_m(늘어나는 지상 노출) } */
  function sameRoute(a, b) {
    if (a.walk !== b.walk || a.path.length !== b.path.length || Math.abs(a.total_m - b.total_m) > 1) return false;
    for (let i = 0; i < a.path.length; i++) if (a.path[i].e !== b.path[i].e) return false;
    return true;
  }
  function alternative(G, from, to, main, opts) {
    opts = opts || {};
    if (!main) return null;
    const speed = opts.speedKmh || 3.5, mpm = speed * 1000 / 60;
    const o = { blocked: opts.blocked || null, exposedW: ALT.exposedW };
    const r = findRoute(G, from, to, o) || findRoute(G, from, to, Object.assign({ surface: true }, o));
    if (!r || sameRoute(r, main)) return null;
    const saved = main.total_m - r.total_m, extra = r.exposed_m - main.exposed_m;
    if (!(saved > 0) || extra > ALT.maxExtraExposedM) return null;
    if (saved / main.total_m < ALT.minSavedFrac && saved / mpm < ALT.minSavedMin) return null;
    return { route: r, saved_m: saved, saved_min: saved / mpm, extra_m: Math.max(0, extra) };
  }

  // route.py 의 han_edges: 한강 횡단 간선 중 노선 이름에 text 가 든 것
  function hanEdges(G, text) {
    return ((G.g.presets || {}).han_crossings || [])
      .filter(function (h) { return h.lines.some(function (l) { return l.indexOf(text) >= 0; }); })
      .map(function (h) { return h.e; });
  }

  UG.router = {
    DETOUR: DETOUR, NEAR_M: NEAR_M, ALT: ALT, Heap: Heap, dijkstra: dijkstra, pathEdges: pathEdges,
    connectPoint: connectPoint, findRoute: findRoute, hanEdges: hanEdges, edgePart: edgePart,
    weightsFor: weightsFor, alternative: alternative, sameRoute: sameRoute, egressConns: egressConns
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = UG.router;
})(typeof globalThis !== 'undefined' ? globalThis : this);
