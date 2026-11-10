/* nearest.js — '가장 가까운 지하로': 한 지점에서 가장 가까운 지하역 출구 찾기
   - 지하역 = 지하 승강장 허브(stations[].ug = 1)가 있는 역. 출구는 그 지하 허브로 이어진 출입구만 센다
     (출입구 간선의 구조가 'entrance' = 지하 허브에 이음, 'ground' = 지상 허브밖에 없음).
   - 거리는 직선 거리 × 1.3(router.js 의 DETOUR)이고 모두 지상 노출이다.
   - 역마다 가장 가까운 출구 하나만 남겨, 가까운 역 순으로 돌려준다. 출구 자료가 없는 지하역은 허브 위치로 잰다.
   - DOM 을 쓰지 않는다(Node 검증 시험에서도 돈다). */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};
  const GR = UG.graph || (typeof require === 'function' ? require('./graph.js') : null);
  const RT = UG.router || (typeof require === 'function' ? require('./router.js') : null);

  const MAX_M = 20000;   // 이보다 멀면(직선 20km) '가까운 지하역 없음'

  // 결과: { options: [{si, name, kind:'entrance'|'hub', ent, ref, node, hub, lat, lon, dist, len}], nearest_m }
  //   options 는 MAX_M 안의 것만(가까운 순, 최대 limit 개). nearest_m = 가장 가까운 지하역까지 직선 거리(멀어도 알려 줌)
  function nearestUnderground(G, lat, lon, opts) {
    opts = opts || {};
    const limit = opts.limit || 3, maxM = opts.maxM || MAX_M;
    const g = G.g, EN = g.entrances, N = g.nodes, E = g.edges;
    const best = new Map();   // 역 번호 -> 가장 가까운 후보
    const offer = function (c) {
      const old = best.get(c.si);
      if (!old || c.dist < old.dist) best.set(c.si, c);
    };
    // 1) 지하 허브로 이어진 출입구
    for (let i = 0; i < EN.node.length; i++) {
      const v = EN.node[i];
      let hub = -1;
      for (let k = G.adjStart[v]; k < G.adjStart[v + 1]; k++) {
        const e = G.adjEdge[k];
        if (E.k[e] === G.codes.entrance && G.weight[e] === g.weights.under) { hub = G.adjNode[k]; break; }
      }
      if (hub < 0) continue;
      const la = N.lat[v] / 1e5, lo = N.lon[v] / 1e5;
      offer({ si: EN.station[i], kind: 'entrance', ent: i, ref: EN.ref[i], node: v, hub: hub, lat: la, lon: lo,
        dist: GR.haversine(lat, lon, la, lo) });
    }
    // 2) 출구 자료가 없는 지하역: 지하 허브 위치
    g.stations.forEach(function (s, si) {
      if (G.stationEntrances[si].length) return;
      s.hubs.forEach(function (h, j) {
        if (s.ug[j] !== 1) return;
        const la = N.lat[h] / 1e5, lo = N.lon[h] / 1e5;
        offer({ si: si, kind: 'hub', ent: -1, ref: '', node: h, hub: h, lat: la, lon: lo, dist: GR.haversine(lat, lon, la, lo) });
      });
    });
    const all = Array.from(best.values()).sort(function (a, b) { return a.dist - b.dist; });
    all.forEach(function (c) { c.name = g.stations[c.si].name; c.len = c.dist * RT.DETOUR; });
    return {
      options: all.filter(function (c) { return c.dist <= maxM; }).slice(0, limit),
      nearest_m: all.length ? all[0].dist : Infinity,
      nearest_name: all.length ? all[0].name : ''
    };
  }

  // 후보 하나로 경로를 찾을 끝점 두 개를 만든다.
  //   출발: 그 점(그 출구에만 잇는다), 도착: 그 역의 지하 허브
  function endpointsFor(G, lat, lon, opt, label) {
    const g = G.g;
    const conn = [{ kind: opt.kind, node: opt.node, si: opt.si, ent: opt.ent, ref: opt.ref, lat: opt.lat, lon: opt.lon, dist: opt.dist, len: opt.len }];
    const s = g.stations[opt.si];
    return {
      from: { kind: 'point', lat: lat, lon: lon, conn: conn, label: label, text: label },
      to: { kind: 'station', si: opt.si, hubs: [opt.hub], lat: N(g, opt.hub)[0], lon: N(g, opt.hub)[1], text: s.name.endsWith('역') ? s.name : s.name + '역' }
    };
  }
  function N(g, v) { return [g.nodes.lat[v] / 1e5, g.nodes.lon[v] / 1e5]; }

  UG.nearest = { MAX_M: MAX_M, nearestUnderground: nearestUnderground, endpointsFor: endpointsFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = UG.nearest;
})(typeof globalThis !== 'undefined' ? globalThis : this);
