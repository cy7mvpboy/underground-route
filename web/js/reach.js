/* reach.js — '여기서 지하로 갈 수 있는 곳' (도착한 역에서 지하로만 걸어 닿는 범위)
   - 출발: 그 역의 지하 승강장 허브(stations[].ug = 1). 지하 허브가 없으면 계산하지 않는다.
   - 쓰는 간선: 구조가 지하인 것만(tables.under_structs = 터널, 출입구, 지하 승강장·지하 환승).
     교량·지상 선로, 지상 승강장·환승, 웹에서 붙인 '지상 걷기' 간선은 쓰지 않는다. 막은 간선도 쓰지 않는다.
   - 비용은 걷는 거리(m)다. 시간 띠(30분·1시간·2시간·4시간)는 걷는 속도로 거리로 바꿔 나눈다.
   - 역은 그 역의 허브나 선로 위 부착점 중 하나에 닿으면 닿은 것으로 센다(가장 가까운 점의 거리).
   - DOM 을 쓰지 않는다. 시험: node scripts\check_reach.js */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};
  const GR = UG.graph || (typeof require === 'function' ? require('./graph.js') : null);
  const RT = UG.router || (typeof require === 'function' ? require('./router.js') : null);

  const BANDS_MIN = [30, 60, 120, 240];
  const FAR_COUNT = 5;

  // 이 간선을 지하로만 걷는 범위 계산에 쓸 수 있나
  function isUnderEdge(G, e) {
    return e < G.surfaceFrom && G.weight[e] === G.g.weights.under;
  }

  // 역의 지하 허브 목록
  function underHubs(G, si) {
    const s = G.g.stations[si];
    return s.hubs.filter(function (h, j) { return s.ug[j] === 1; });
  }

  /* 다익스트라(거리만). 돌려주는 값:
     { si, sources, speed, bands: [{min, m}], limit_m, dist(노드별 m, 못 닿으면 Infinity), prev(직전 간선),
       stations: [{si, m, band}] (출발역 빼고 가까운 순), counts(띠별 누적 역 수), farthest(먼 순 5곳) } */
  function reachFrom(G, si, opts) {
    opts = opts || {};
    const speed = opts.speedKmh || 3.5, mpm = speed * 1000 / 60;
    const bands = (opts.bandsMin || BANDS_MIN).map(function (min) { return { min: min, m: min * mpm }; });
    const limit = bands[bands.length - 1].m;
    const blocked = opts.blocked || null;
    const n = G.nNodes, len = G.g.edges.len;
    const dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), done = new Uint8Array(n);
    const sources = underHubs(G, si);
    const heap = new RT.Heap();
    sources.forEach(function (v) { dist[v] = 0; heap.push(0, v); });
    while (heap.size()) {
      const top = heap.pop(), d = top[0], v = top[1];
      if (done[v]) continue;
      done[v] = 1;
      for (let k = G.adjStart[v]; k < G.adjStart[v + 1]; k++) {
        const e = G.adjEdge[k];
        if (!isUnderEdge(G, e) || (blocked && blocked.has(e))) continue;
        const w = G.adjNode[k], nd = d + len[e];
        if (nd <= limit && nd < dist[w]) { dist[w] = nd; prev[w] = e; heap.push(nd, w); }
      }
    }
    // 역마다 가장 가까운 점
    const best = new Map();
    for (let v = 0; v < n; v++) {
      const s = G.nodeStation[v];
      if (s < 0 || s === si || !isFinite(dist[v])) continue;
      if (!best.has(s) || dist[v] < best.get(s)) best.set(s, dist[v]);
    }
    const bandOf = function (m) { for (let b = 0; b < bands.length; b++) if (m <= bands[b].m) return b; return -1; };
    const stations = Array.from(best.entries()).map(function (x) { return { si: x[0], m: x[1], band: bandOf(x[1]) }; })
      .sort(function (a, b) { return a.m - b.m || a.si - b.si; });
    const counts = bands.map(function (b) { return stations.filter(function (s) { return s.m <= b.m; }).length; });
    return {
      si: si, sources: sources, speed: speed, bands: bands, limit_m: limit, dist: dist, prev: prev,
      stations: stations, counts: counts, farthest: stations.slice().reverse().slice(0, FAR_COUNT)
    };
  }

  /* 지도에 칠할 선로 조각: 띠마다 선 조각 배열 [[띠0 선들], [띠1 선들], …]
     간선 위 한 점의 거리 = min(가까운 끝 거리 + 그 끝에서 간 거리, 먼 끝 거리 + 반대쪽에서 간 거리).
     띠 경계에서 간선을 잘라, 범위 끝에 걸친 간선도 닿는 부분까지만 칠한다. */
  function segments(G, res) {
    const g = G.g, E = g.edges, track = G.codes.track, dist = res.dist;
    const out = res.bands.map(function () { return []; });
    const cuts = res.bands.map(function (b) { return b.m; });
    for (let e = 0; e < G.surfaceFrom; e++) {
      if (E.k[e] !== track || !isUnderEdge(G, e)) continue;
      const da = dist[E.a[e]], db = dist[E.b[e]];
      if (!isFinite(da) && !isFinite(db)) continue;
      const L = E.len[e];
      if (!(L > 0)) continue;
      const reachAt = function (x) { return Math.min(da + x, db + (L - x)); };   // x = a 끝에서 간 거리(m)
      // 자를 위치: 끝점, 두 쪽 거리가 만나는 곳, 띠 경계
      const xs = [0, L];
      if (isFinite(da) && isFinite(db)) { const mid = (db + L - da) / 2; if (mid > 0 && mid < L) xs.push(mid); }
      cuts.forEach(function (c) {
        if (isFinite(da) && c - da > 0 && c - da < L) xs.push(c - da);
        if (isFinite(db) && L - (c - db) > 0 && L - (c - db) < L) xs.push(L - (c - db));
      });
      xs.sort(function (p, q) { return p - q; });
      const pts = GR.edgeShape(g, e), cum = GR.cumulative(pts), scale = cum[cum.length - 1] / L;
      let runBand = -2, runFrom = 0;
      const flush = function (to) {
        if (runBand >= 0 && to > runFrom) out[runBand].push(GR.sliceAlong(pts, cum, runFrom * scale, to * scale));
      };
      for (let i = 0; i + 1 < xs.length; i++) {
        if (xs[i + 1] - xs[i] < 0.01) continue;
        const r = reachAt((xs[i] + xs[i + 1]) / 2);
        let band = -1;
        for (let b = 0; b < cuts.length; b++) if (r <= cuts[b]) { band = b; break; }
        if (band !== runBand) { flush(xs[i]); runBand = band; runFrom = xs[i]; }
      }
      flush(L);
    }
    return out;
  }

  // 닿은 역들과 출발역을 담는 범위 [남, 서, 북, 동]
  function bounds(G, res, maxBand) {
    const S = G.g.stations, o = S[res.si];
    const b = [o.lat / 1e5, o.lon / 1e5, o.lat / 1e5, o.lon / 1e5];
    res.stations.forEach(function (x) {
      if (maxBand != null && x.band > maxBand) return;
      const la = S[x.si].lat / 1e5, lo = S[x.si].lon / 1e5;
      if (la < b[0]) b[0] = la; if (lo < b[1]) b[1] = lo; if (la > b[2]) b[2] = la; if (lo > b[3]) b[3] = lo;
    });
    return b;
  }

  UG.reach = { BANDS_MIN: BANDS_MIN, isUnderEdge: isUnderEdge, underHubs: underHubs, reachFrom: reachFrom, segments: segments, bounds: bounds };
  if (typeof module !== 'undefined' && module.exports) module.exports = UG.reach;
})(typeof globalThis !== 'undefined' ? globalThis : this);
