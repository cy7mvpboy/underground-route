/* graph.js — 철도망 그래프(web/data/graph.json) 불러오기·풀기·색인
   - 브라우저와 Node(검증 시험) 양쪽에서 쓴다. DOM·Leaflet을 쓰지 않는다.
   - 모든 함수는 globalThis.UG.graph 아래에 둔다.
   - 형식 설명: docs/graph-format.md */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};

  /* ---------- 불러오기 ---------- */
  class LoadError extends Error {
    constructor(kind, detail) { super(kind); this.kind = kind; this.detail = detail; }
  }

  // fetch 로 받아 JSON 으로 푼다. onProgress(받은 byte) 로 진행을 알린다.
  async function fetchJson(url, onProgress) {
    let res;
    try { res = await fetch(url); } catch (e) { throw new LoadError('network'); }
    if (!res.ok) throw new LoadError('http', res.status);
    let text;
    try {
      if (onProgress && res.body && res.body.getReader && typeof TextDecoder !== 'undefined') {
        const reader = res.body.getReader();
        const chunks = [];
        let size = 0;
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          chunks.push(r.value);
          size += r.value.length;
          onProgress(size);
        }
        const buf = new Uint8Array(size);
        let off = 0;
        for (const c of chunks) { buf.set(c, off); off += c.length; }
        text = new TextDecoder('utf-8').decode(buf);
      } else {
        text = await res.text();
      }
    } catch (e) { throw new LoadError('network'); }
    try { return JSON.parse(text); } catch (e) { throw new LoadError('format'); }
  }

  async function loadGraph(url, onProgress) {
    const g = await fetchJson(url, onProgress);
    validateGraph(g);
    return g;
  }

  function validateGraph(g) {
    const ok = g && g.format === 'underground-route-graph' && g.version === 1 &&
      g.tables && g.nodes && g.edges && Array.isArray(g.stations) &&
      Array.isArray(g.edges.a) && Array.isArray(g.nodes.lat);
    if (!ok) throw new LoadError('format');
    const n = g.edges.a.length;
    for (const k of ['b', 'len', 's', 'k', 'svc', 'rg', 'g', 'ls']) {
      if (!Array.isArray(g.edges[k]) || g.edges[k].length !== n) throw new LoadError('format');
    }
    return true;
  }

  /* ---------- 풀기 ---------- */
  // Google 인코딩 폴리라인 -> [[lat, lon], ...]. precision 은 소수 자릿수(graph.json 은 5).
  function decodePolyline(s, precision) {
    const f = Math.pow(10, precision == null ? 5 : precision);
    const pts = [];
    let i = 0, lat = 0, lon = 0;
    while (i < s.length) {
      for (let k = 0; k < 2; k++) {
        let r = 0, sh = 0, b;
        do { b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
        const d = (r & 1) ? ~(r >> 1) : (r >> 1);
        if (k === 0) lat += d; else lon += d;
      }
      pts.push([lat / f, lon / f]);
    }
    return pts;
  }

  function nodeLatLng(g, i) { return [g.nodes.lat[i] / 1e5, g.nodes.lon[i] / 1e5]; }

  // 간선 e 의 모양을 from 노드 쪽에서 시작하게 돌려준다(선로가 아니면 두 점 직선).
  function edgeShape(g, e, fromNode) {
    const E = g.edges;
    const pts = E.g[e] ? decodePolyline(E.g[e]) : [nodeLatLng(g, E.a[e]), nodeLatLng(g, E.b[e])];
    if (fromNode != null && fromNode === E.b[e] && E.a[e] !== E.b[e]) pts.reverse();
    return pts;
  }

  // 역 이름 정규화: build_graph.py·route.py 와 같은 규칙(괄호 내용·공백·끝의 '역' 제거)
  function normalizeName(s) {
    s = String(s || '').replace(/\(.*?\)/g, '').split(' ').join('');
    if (s.length > 2 && s.endsWith('역')) s = s.slice(0, -1);
    return s;
  }

  // 두 점 사이 거리(m), 하버사인 공식
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371008.8, rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /* ---------- 선 위의 거리 (길 안내 위치 추정·도달 범위 자르기에 씀) ----------
     cum[i] = 첫 점부터 i 번째 점까지 잰 거리(m). */
  function cumulative(pts) {
    const cum = new Float64Array(pts.length);
    for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    return cum;
  }
  // 선을 따라 d(m) 지점의 좌표
  function pointAlong(pts, cum, d) {
    if (d <= 0) return pts[0].slice();
    const n = pts.length;
    if (d >= cum[n - 1]) return pts[n - 1].slice();
    let i = 1;
    while (i < n - 1 && cum[i] < d) i++;
    const seg = cum[i] - cum[i - 1], t = seg > 0 ? (d - cum[i - 1]) / seg : 0;
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
  }
  // 선의 d0 ~ d1(m) 부분
  function sliceAlong(pts, cum, d0, d1) {
    const n = pts.length, out = [pointAlong(pts, cum, d0)];
    for (let i = 1; i < n - 1; i++) if (cum[i] > d0 && cum[i] < d1) out.push(pts[i].slice());
    out.push(pointAlong(pts, cum, d1));
    return out;
  }

  /* ---------- 지상 걷기 간선 (surface) ----------
     지하로 갈 길이 없을 때(앞이 막힘, 끊긴 노선)만 쓰는 대비책: 1.5km 안의 다른 역끼리
     가장 가까운 출입구(출입구 자료가 없으면 허브) 사이를 직선 × 1.3 길이의 지상 간선으로 잇는다.
     graph.json 간선 뒤에 붙이므로 원래 간선 번호는 그대로고, route.py 와 같은 기본 탐색에서는 건너뛴다.
     돌려주는 값: 첫 지상 걷기 간선 번호 */
  const SURFACE_M = 1500, SURFACE_DETOUR = 1.3;
  function addSurfaceLinks(g) {
    if (g._surfaceFrom != null) return g._surfaceFrom;
    const E = g.edges, T = g.tables, N = g.nodes;
    const first = E.a.length;
    if (T.kinds.indexOf('surface') < 0) T.kinds.push('surface');
    const kind = T.kinds.indexOf('surface'), ground = T.structs.indexOf('ground');
    const EN = g.entrances || { node: [], station: [] };
    // 역마다 지상과 닿는 점: 출입구, 없으면 허브
    const access = g.stations.map(function (s) { return { lat: s.lat / 1e5, lon: s.lon / 1e5, pts: [] }; });
    for (let i = 0; i < EN.node.length; i++) if (access[EN.station[i]]) access[EN.station[i]].pts.push(EN.node[i]);
    g.stations.forEach(function (s, si) { if (!access[si].pts.length) access[si].pts = s.hubs.slice(); });
    // 위도 0.02도(약 2.2km) 칸으로 나눠 가까운 역만 비교한다
    const cell = function (la, lo) { return Math.floor(la / 0.02) + ':' + Math.floor(lo / 0.02); };
    const grid = new Map();
    access.forEach(function (a, si) { const k = cell(a.lat, a.lon); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(si); });
    const push = function (a, b, len, rg) {
      E.a.push(a); E.b.push(b); E.len.push(Math.round(len * 10) / 10); E.s.push(ground); E.k.push(kind);
      E.r.push(-1); E.svc.push(0); E.ls.push(0); E.rg.push(rg); E.src.push(0); E.g.push(''); E.tn.push(0);
    };
    access.forEach(function (A, s1) {
      const ci = Math.floor(A.lat / 0.02), cj = Math.floor(A.lon / 0.02);
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        (grid.get((ci + di) + ':' + (cj + dj)) || []).forEach(function (s2) {
          if (s2 <= s1 || haversine(A.lat, A.lon, access[s2].lat, access[s2].lon) > SURFACE_M + 300) return;
          let best = null;
          A.pts.forEach(function (u) {
            access[s2].pts.forEach(function (v) {
              const d = haversine(N.lat[u] / 1e5, N.lon[u] / 1e5, N.lat[v] / 1e5, N.lon[v] / 1e5);
              if (!best || d < best[2]) best = [u, v, d];
            });
          });
          if (best && best[2] <= SURFACE_M) push(best[0], best[1], best[2] * SURFACE_DETOUR, g.stations[s1].rg);
        });
      }
    });
    Object.defineProperty(g, '_surfaceFrom', { value: first, enumerable: false });
    return first;
  }

  /* ---------- 색인 (한 번만 만든다) ---------- */
  // route.py 의 load_graph() 와 같은 내용을 만든다.
  //   weight[e]      : 간선 가중치(지하 1, 지상·교량 1000)
  //   adjStart/adjEdge/adjNode : 노드마다 (간선, 반대쪽 노드) 목록. CSR 배열로 담는다.
  //                    순서는 route.py 와 같다(간선 번호 순, 간선마다 a 쪽 다음 b 쪽).
  //   nodeStation[v] : 허브·부착점 노드가 속한 역 번호(-1 = 없음)
  //   hubLines/hubShort : 허브 노드 -> 정식/짧은 노선 이름 목록
  function indexGraph(g) {
    const surfaceFrom = addSurfaceLinks(g);   // 웹에서만 쓰는 '지상 걷기' 간선(기본 탐색에서는 쓰지 않는다)
    const E = g.edges, T = g.tables, N = g.nodes;
    const nNodes = N.f.length, nEdges = E.a.length;

    const under = new Set(T.under_structs.map(function (s) { return T.structs.indexOf(s); }));
    const weight = new Float64Array(nEdges);
    for (let e = 0; e < nEdges; e++) weight[e] = under.has(E.s[e]) ? g.weights.under : g.weights.exposed;

    // CSR 인접 목록: 먼저 차수를 세고, 같은 순서로 채운다
    const deg = new Int32Array(nNodes + 1);
    for (let e = 0; e < nEdges; e++) { deg[E.a[e]]++; deg[E.b[e]]++; }
    const adjStart = new Int32Array(nNodes + 1);
    for (let v = 0; v < nNodes; v++) adjStart[v + 1] = adjStart[v] + deg[v];
    const fill = adjStart.slice(0, nNodes);
    const adjEdge = new Int32Array(2 * nEdges), adjNode = new Int32Array(2 * nEdges);
    for (let e = 0; e < nEdges; e++) {
      const a = E.a[e], b = E.b[e];
      adjEdge[fill[a]] = e; adjNode[fill[a]++] = b;
      adjEdge[fill[b]] = e; adjNode[fill[b]++] = a;
    }

    const nodeStation = new Int32Array(nNodes).fill(-1);
    const hubLines = new Map(), hubShort = new Map();
    g.stations.forEach(function (s, si) {
      s.hubs.concat(s.plat).forEach(function (v) { nodeStation[v] = si; });
      s.hubs.forEach(function (v, j) {
        const set = T.line_sets[s.hub_ls[j]] || [];
        hubLines.set(v, set.map(function (i) { return T.lines[i]; }));
        hubShort.set(v, set.map(function (i) { return T.line_short[i]; }));
      });
    });

    // 출입구: 역마다 출입구 목록
    const EN = g.entrances || { node: [], station: [], ref: [] };
    const stationEntrances = g.stations.map(function () { return []; });
    const entranceAt = new Map();   // 출입구 노드 -> 출입구 번호(entrances 배열 위치)
    for (let i = 0; i < EN.node.length; i++) {
      if (stationEntrances[EN.station[i]]) stationEntrances[EN.station[i]].push(i);
      entranceAt.set(EN.node[i], i);
    }

    const codes = {
      track: T.kinds.indexOf('track'), platform: T.kinds.indexOf('platform'),
      transfer: T.kinds.indexOf('transfer'), entrance: T.kinds.indexOf('entrance'), surface: T.kinds.indexOf('surface'),
      main: T.services.indexOf('')
    };

    return {
      g: g, weight: weight, adjStart: adjStart, adjEdge: adjEdge, adjNode: adjNode,
      nodeStation: nodeStation, hubLines: hubLines, hubShort: hubShort,
      stationEntrances: stationEntrances, entranceAt: entranceAt, codes: codes,
      nNodes: nNodes, nEdges: nEdges, surfaceFrom: surfaceFrom
    };
  }

  /* ---------- 역 찾기 ---------- */
  // route.py 의 find_station: '이름' 또는 '이름@지역'. 후보가 여럿이면 첫 번째.
  function findStation(G, query) {
    const g = G.g;
    const at = query.indexOf('@');
    const name = at >= 0 ? query.slice(0, at) : query, region = at >= 0 ? query.slice(at + 1) : '';
    const key = normalizeName(name);
    let hits = [];
    g.stations.forEach(function (s, i) { if (s.names.indexOf(key) >= 0) hits.push(i); });
    if (region) hits = hits.filter(function (i) { return g.tables.regions[g.stations[i].rg].name.indexOf(region) >= 0; });
    return hits.length ? hits[0] : -1;
  }

  // 자동 완성: 정확히 같은 이름 > 앞부분이 같음 > 포함. 같은 순위면 맞은 이름이 짧은 것 먼저.
  // 표시 이름(name)이 맞으면 별칭이 맞은 것보다 앞에 둔다.
  function searchStations(G, query, limit) {
    const key = normalizeName(query);
    if (!key) return [];
    const out = [];
    G.g.stations.forEach(function (s, i) {
      let rank = -1, len = 0;
      const main = normalizeName(s.name);
      for (const n of s.names) {
        let r = n === key ? 0 : n.startsWith(key) ? 2 : n.indexOf(key) >= 0 ? 4 : -1;
        if (r >= 0 && n !== main) r += 1;   // 별칭으로 맞음
        if (r >= 0 && (rank < 0 || r < rank || (r === rank && n.length < len))) { rank = r; len = n.length; }
      }
      if (rank >= 0) out.push({ si: i, rank: rank, len: len });
    });
    out.sort(function (a, b) { return a.rank - b.rank || a.len - b.len || a.si - b.si; });
    return out.slice(0, limit || 8).map(function (o) { return o.si; });
  }

  // 역의 노선 짧은 이름(중복 없이). 도시철도·광역전철 노선을 앞에 둔다.
  function stationLines(G, si) {
    const T = G.g.tables, s = G.g.stations[si];
    const metro = [], other = [];
    s.hub_ls.forEach(function (ls) {
      (T.line_sets[ls] || []).forEach(function (l) {
        const name = T.line_short[l];
        const list = T.line_metro[l] ? metro : other;
        if (name && metro.indexOf(name) < 0 && other.indexOf(name) < 0) list.push(name);
      });
    });
    return metro.concat(other);
  }

  UG.graph = {
    LoadError: LoadError, fetchJson: fetchJson, loadGraph: loadGraph, validateGraph: validateGraph,
    decodePolyline: decodePolyline, nodeLatLng: nodeLatLng, edgeShape: edgeShape,
    normalizeName: normalizeName, haversine: haversine, indexGraph: indexGraph,
    cumulative: cumulative, pointAlong: pointAlong, sliceAlong: sliceAlong,
    findStation: findStation, searchStations: searchStations, stationLines: stationLines
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = UG.graph;
})(typeof globalThis !== 'undefined' ? globalThis : this);
