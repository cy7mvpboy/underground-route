/* junctions.js — 역 사이 갈림길 안내 (선로가 갈라지는 곳을 체크포인트로)
   - 역 사이를 걷는 사람이 선로가 갈라지는 곳에서 엉뚱한 갈래(다른 노선의 지선, 차량기지)로 들어가지 않게,
     경로 위의 갈림길과 '어느 쪽으로 가야 하는지'(왼쪽·오른쪽·직진)를 알려 준다.
   - 순수 함수만 있다(DOM·Leaflet 없음). 브라우저는 UG.junctions, Node 는 require() 로 쓴다.
   - 규칙 설명: docs/graph-format.md 의 '갈림길 안내 (junctions.js)' 절.

   갈림길로 보는 곳
     경로가 선로 간선(kind = track)으로 들어와 선로 간선으로 나가는 노드에, 그 둘이 아닌 선로 간선이 더 있는 곳.
     승강장·환승·출입구·지상 걷기 간선은 보지 않는다(역은 이미 체크포인트다).
   안내하지 않는 곳 (갈래마다 판정, 순서대로)
     1. 건넘선: service=crossover 인 간선. 단, 건너간 곳이 다른 노선의 본선이고 경로와 다른 다음 역으로 가면 갈림길로 본다
        (예: 신도림 서쪽 신정지선 → 2호선 본선 문래 방면).
     2. 뒤쪽 선로: 걸어온 방향에서 100°보다 크게 꺾이는 갈래(뒤에서 합류하는 선로). 앞으로 걷는 사람에게는 고를 일이 없다.
     3. 짧은 막다른 선로: 50m 안에서 끝나는 선로 토막.
     4. 짧은 연결선: 150m 안에서 같은 노선(같은 선 이름, 이름이 없으면 같은 노선 묶음)의 옆 선로에 다시 붙는 선(건넘선 태그가 빠진 것).
     5. 같은 노선의 나란한 선로: 그 갈래를 따라가도 경로와 같은 다음 역에 닿고, 노선(선 이름)도 같으면 안내하지 않는다
        (역 앞에서 선로가 두 승강장으로 갈라지는 곳 등). 선 이름이 다르면(예: 5호선 본선과 마천지선이
        같은 강동역의 다른 승강장으로 갈라짐) 안내하고, 방면을 '강동 지나 길동'처럼 그다음 역까지 적는다.
     6. 다시 합쳐지는 선: 그 갈래를 따라 2km 안에서 경로의 앞쪽 노드로 돌아오고, 그 사이 지상 노출이 경로보다 많지 않고
        길이도 경로의 1.5배 + 100m 안이면(대피선·통과선, 예: 9호선 사평역 옆 급행 선로). 지상으로 도는 갈래는 안내한다.
   방향
     들어오는 경로 선 모양의 마지막 약 80m 와 갈래 선 모양의 처음 약 80m 로 방위각을 재서 꺾인 각도(오른쪽 +)를 구한다.
     |각도| ≤ 20° 이면 직진. 두 갈래 이상이 같은 쪽(예: 둘 다 직진)이면 각도 순서로 '왼쪽 갈래'·'오른쪽 갈래'라고 한다. */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};
  const GR = UG.graph || (typeof require === 'function' ? require('./graph.js') : null);

  const DEFAULTS = {
    lookM: 80,         // 방향을 잴 선 모양 길이(m): 갈림길에서 앞뒤로
    straightDeg: 20,   // |꺾인 각도| ≤ 이 값이면 직진
    behindDeg: 100,    // |꺾인 각도| > 이 값이면 뒤쪽 선로(뒤에서 합류)
    crossoverM: 150,   // 이보다 짧게 같은 노선 옆 선로에 붙는 선은 건넘선으로 본다
    stubM: 50,         // 이보다 짧은 막다른 선로는 무시
    walkM: 6000,       // 갈래를 따라가며 역을 찾는 최대 거리(m)
    nameM: 2000,       // 갈래 이름(노선·선 이름)을 찾는 최대 거리(m)
    rejoinM: 2000      // 다른 갈래가 이 거리 안에서 경로로 다시 합쳐지면 대피선·통과선으로 본다
  };
  const SIDE_KO = { left: '왼쪽', right: '오른쪽', straight: '직진' };

  /* ---------- 작은 도구 ---------- */
  function isTrack(G, e) { return G.g.edges.k[e] === G.codes.track && e < G.surfaceFrom; }
  function otherEnd(G, e, v) { const E = G.g.edges; return E.a[e] === v ? E.b[e] : E.a[e]; }

  // 노드 v 에 붙은 선로 간선 목록(지상 걷기 간선은 뺀다)
  function trackEdgesAt(G, v) {
    const out = [];
    for (let k = G.adjStart[v]; k < G.adjStart[v + 1]; k++) if (isTrack(G, G.adjEdge[k])) out.push(G.adjEdge[k]);
    return out;
  }

  // 방위각(도, 북 0 · 동 90, 시계 방향). 짧은 거리라 평면으로 근사한다.
  function bearing(p, q) {
    const dx = (q[1] - p[1]) * Math.cos(p[0] * Math.PI / 180), dy = q[0] - p[0];
    return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  }
  // 꺾인 각도: -180 ~ 180 (오른쪽 +)
  function turnAngle(from, to) { let d = to - from; while (d > 180) d -= 360; while (d <= -180) d += 360; return d; }

  // 간선 목록을 이어 붙인 선 모양에서, 시작점에서 d(m) 떨어진 점
  //   steps: [[간선, 출발 노드], …] (출발 노드 쪽에서 시작하는 방향으로 이어 붙인다)
  function pointAlongEdges(G, steps, d) {
    let pts = [];
    for (const s of steps) {
      const shape = GR.edgeShape(G.g, s[0], s[1]);
      pts = pts.length ? pts.concat(shape.slice(1)) : shape;
      const cum = GR.cumulative(pts);
      if (cum[cum.length - 1] >= d) return GR.pointAlong(pts, cum, d);
    }
    return pts.length ? pts[pts.length - 1] : null;
  }

  // 노드 v 에서 간선 목록을 따라 나갈 때의 방위각(처음 d m)
  function headingOut(G, v, steps, d) {
    const p = pointAlongEdges(G, steps, d);
    return p ? bearing(GR.nodeLatLng(G.g, v), p) : 0;
  }

  /* ---------- 노선·선 이름 ---------- */
  // 간선의 이름 열쇠: 선 이름이 있으면 선 이름, 없으면 노선 묶음 번호들. 이름이 없으면 ''.
  function nameKey(G, e) {
    const E = G.g.edges, T = G.g.tables;
    if (E.tn[e]) return 'tn:' + T.track_names[E.tn[e]];
    const ls = T.line_sets[E.ls[e]] || [];
    return ls.length ? 'ls:' + ls.join(',') : '';
  }
  // 두 간선이 같은 노선인가: 선 이름이 둘 다 있으면 선 이름으로, 아니면 노선 묶음이 겹치는지로
  function sameLine(G, e1, e2) {
    if (e1 < 0 || e2 < 0) return false;
    const E = G.g.edges, T = G.g.tables;
    if (E.tn[e1] && E.tn[e2]) return E.tn[e1] === E.tn[e2];
    const a = T.line_sets[E.ls[e1]] || [], b = T.line_sets[E.ls[e2]] || [];
    return a.some(function (l) { return b.indexOf(l) >= 0; });
  }
  // 표시 이름: '<짧은 노선 이름> <선 이름>' (선 이름이 노선 이름과 같으면 노선 이름만). 예: '2호선 성수지선', '3호선 일산선'
  function lineName(G, e) {
    const E = G.g.edges, T = G.g.tables;
    const ls = T.line_sets[E.ls[e]] || [];
    const metro = ls.filter(function (l) { return T.line_metro[l]; });
    const use = metro.length ? metro : ls;
    const shorts = [], fulls = [];
    use.forEach(function (l) { if (shorts.indexOf(T.line_short[l]) < 0) shorts.push(T.line_short[l]); fulls.push(T.lines[l]); });
    const tn = E.tn[e] ? T.track_names[E.tn[e]] : '';
    const parts = shorts.length ? [shorts.join('/')] : [];
    if (tn && shorts.indexOf(tn) < 0 && fulls.indexOf(tn) < 0) parts.push(tn);
    return parts.join(' ');
  }

  /* ---------- 갈래 따라가기 ----------
     노드 v 에서 간선 e0 으로 나가 선로만 따라 걷는다(사람이 그 선로를 계속 따라가는 것처럼).
     route: 경로 간선 목록 [{e,u,v}] 중 e0 다음 것들. 주면 선로인 동안 경로를 그대로 따른다(고른 갈래).
     갈림길에서는 건넘선이 아닌 것 → 같은 선 이름 → 가장 덜 꺾이는 것 순으로 고르고, 100°보다 꺾이는 선(되돌아가기)은 고르지 않는다.
     돌려주는 값: { steps: [[간선, 출발 노드]], nodes: [지난 노드], length, stations: [역 번호] (최대 2개), deadEnd,
                  svcLen: {서비스 종류: m}, nameEdge(이름 있는 첫 간선, nameM 안) } */
  function followBranch(G, v, e0, route, opt) {
    const E = G.g.edges, T = G.g.tables, N = G.g.nodes;
    const out = { steps: [], nodes: [], length: 0, stations: [], deadEnd: false, svcLen: {}, nameEdge: -1 };
    const seen = new Set();
    let cur = v, e = e0, ri = 0;
    while (e >= 0 && !seen.has(e) && out.length < opt.walkM && out.stations.length < 2) {
      seen.add(e);
      const w = otherEnd(G, e, cur);
      out.steps.push([e, cur]);
      const svc = T.services[E.svc[e]];
      out.svcLen[svc] = (out.svcLen[svc] || 0) + E.len[e];
      if (out.nameEdge < 0 && nameKey(G, e) && out.length < opt.nameM) out.nameEdge = e;
      out.length += E.len[e];
      out.nodes.push(w);
      const si = G.nodeStation[w];
      if (si >= 0 && (N.f[w] & 2) && out.stations[out.stations.length - 1] !== si) out.stations.push(si);
      // 다음 간선
      let next = -1;
      if (route && ri < route.length && route[ri].u === w && isTrack(G, route[ri].e)) { next = route[ri].e; ri++; }
      else { route = null; next = continueStraight(G, w, e, opt); }
      if (next < 0 && trackEdgesAt(G, w).length === 1) out.deadEnd = true;
      cur = w; e = next;
    }
    return out;
  }

  // 노드 w 에 간선 e 로 들어왔을 때 이어 갈 선로(없으면 -1)
  function continueStraight(G, w, e, opt) {
    const E = G.g.edges, crossover = G.g.tables.services.indexOf('crossover');
    const cand = trackEdgesAt(G, w).filter(function (x) { return x !== e; });
    if (cand.length <= 1) return cand.length ? cand[0] : -1;
    const shape = GR.edgeShape(G.g, e, otherEnd(G, e, w));   // w 로 들어오는 방향
    const cum = GR.cumulative(shape);
    const back = GR.pointAlong(shape, cum, Math.max(0, cum[cum.length - 1] - 30));
    const inB = bearing(back, GR.nodeLatLng(G.g, w));
    let best = -1, bestScore = Infinity;
    cand.forEach(function (x) {
      const turn = Math.abs(turnAngle(inB, headingOut(G, w, [[x, w]], 30)));
      if (turn > opt.behindDeg) return;   // 되돌아가는 선
      const score = (E.svc[x] === crossover ? 1000 : 0) + (E.tn[e] && E.tn[x] === E.tn[e] ? 0 : 100) + turn;
      if (score < bestScore) { bestScore = score; best = x; }
    });
    return best;
  }

  // 갈래의 처음 '연결 토막'(차수 2 노드를 지나 다음 갈림길·막다른 끝까지) 길이와 끝 노드
  function linkFrom(G, v, e0) {
    let cur = v, e = e0, len = 0;
    for (let n = 0; n < 50; n++) {
      const w = otherEnd(G, e, cur);
      len += G.g.edges.len[e];
      const at = trackEdgesAt(G, w);
      if (at.length !== 2) return { len: len, end: w, last: e };
      cur = w; e = at[0] === e ? at[1] : at[0];
    }
    return { len: len, end: cur, last: e };
  }

  /* ---------- 갈래 이름표 ----------
     kind: 'line'(노선 선로) | 'depot'(차량기지) | 'deadend'(막다른 선로) | 'track'(이름 없는 선로)
     name: '2호선 성수지선', '차량기지' …  via: 처음 지나는 서비스 선로('연결선' 등, 노선 선로로 이어질 때)
     (방면 toward 는 findJunctions 에서 붙인다: 따라가서 처음 닿는 역. 다른 갈래와 같은 역이면 '강동 지나 길동'처럼 그다음 역까지) */
  const SVC_KO = { yard: '차량기지 선로', siding: '측선', spur: '연결선', crossover: '건넘선' };
  function branchLabel(G, walk, firstEdge) {
    const E = G.g.edges, T = G.g.tables;
    const svc = T.services[E.svc[firstEdge]];
    const ne = walk.nameEdge;
    const tn = ne >= 0 && E.tn[ne] ? T.track_names[E.tn[ne]] : '';
    const depotLen = (walk.svcLen.yard || 0) + (walk.svcLen.siding || 0);
    const res = { kind: 'track', name: '', via: '' };
    if (/기지/.test(tn) || ((svc === 'yard' || svc === 'siding') && (ne < 0 || depotLen >= walk.length / 2))) {
      res.kind = 'depot'; res.name = '차량기지';            // 기지선 이름(예: 지축기지선)이나 차량기지·측선 선로
      if (tn) res.name += ' ' + tn;
    } else if (ne >= 0) {
      res.kind = 'line'; res.name = lineName(G, ne) || tn;
      if (svc && svc !== 'crossover' && E.svc[ne] === 0 && ne !== firstEdge) res.via = SVC_KO[svc] || '';
    } else if (walk.deadEnd) {
      res.kind = 'deadend'; res.name = '막다른 선로';
    } else {
      res.name = SVC_KO[svc] || '이름 없는 선로';
    }
    return res;
  }

  /* ---------- 경로 위 역 위치 ---------- */
  // 경로를 따라 역(허브·선로 위 부착점)을 지나는 곳: [{si, at(m)}]. at = 경로 시작부터 그 노드까지 거리
  function stationTouches(G, path) {
    const out = [];
    let at = 0;
    if (path.length && G.nodeStation[path[0].u] >= 0) out.push({ si: G.nodeStation[path[0].u], at: 0 });
    path.forEach(function (p) {
      at += G.g.edges.len[p.e];
      if (G.nodeStation[p.v] >= 0) out.push({ si: G.nodeStation[p.v], at: at });
    });
    return out;
  }

  /* ---------- 갈림길 찾기 ----------
     G: graph.indexGraph 결과, routeEdges: router.findRoute(...).path ([{e,u,v}]) 또는 findRoute 결과 자체
     options: DEFAULTS 의 값을 바꿀 수 있다. options.skipped 에 배열을 주면 안내하지 않은 갈래를 이유와 함께 넣어 준다.
     돌려주는 값: 경로 순서대로 갈림길 목록
       { node, lat, lon, pos(이 경로 간선 위치를 지나면 갈림길), at_m(경로 시작부터 m), structure,
         prev: {si, name}, fromPrev_m, next: {si, name}, toNext_m,
         chosen: 갈래, alternatives: [갈래] }
       갈래 = { edge, angle(꺾인 각도, 오른쪽 +), dir('left'|'right'|'straight'), side(안내 말: '오른쪽', '왼쪽 갈래' …),
               kind, name, via, toward, structure } */
  function findJunctions(G, routeEdges, options) {
    const opt = Object.assign({}, DEFAULTS, options || {});
    const path = Array.isArray(routeEdges) ? routeEdges : (routeEdges && routeEdges.path) || [];
    const E = G.g.edges, T = G.g.tables, S = G.g.stations;
    const crossover = T.services.indexOf('crossover');
    const touches = stationTouches(G, path);
    const out = [];
    let at = 0;
    for (let i = 0; i + 1 < path.length; i++) {
      at += E.len[path[i].e];
      const inE = path[i].e, outE = path[i + 1].e, v = path[i].v;
      if (!isTrack(G, inE) || !isTrack(G, outE)) continue;              // 선로 → 선로 로 지나는 노드만
      const others = trackEdgesAt(G, v).filter(function (x) { return x !== inE && x !== outE; });
      if (!others.length) continue;

      // 들어오는 방향: 경로를 거꾸로 lookM 만큼(선로 간선만)
      const backSteps = [];
      for (let k = i; k >= 0 && isTrack(G, path[k].e); k--) backSteps.push([path[k].e, path[k].v]);
      const backPt = pointAlongEdges(G, backSteps, opt.lookM);
      const inB = bearing(backPt, GR.nodeLatLng(G.g, v));

      // 고른 갈래(경로)
      const chosenWalk = followBranch(G, v, outE, path.slice(i + 2), opt);
      const chosen = { edge: outE, walk: chosenWalk, angle: turnAngle(inB, headingOut(G, v, chosenWalk.steps, opt.lookM)) };
      const prevT = touches.filter(function (t) { return t.at <= at; }).pop() || null;
      const nextT = touches.filter(function (t) { return t.at > at; })[0] || null;
      const nextSi = nextT ? nextT.si : (chosenWalk.stations[0] != null ? chosenWalk.stations[0] : -1);
      const inName = nearestNamed(G, path, i, -1), outName = nearestNamed(G, path, i + 1, +1);
      // 앞으로 지날 경로 노드(rejoinM 안) -> {d: 갈림길부터 거리, x: 그중 지상 노출 거리}
      const ahead = new Map();
      for (let k = i + 1, d = 0, x = 0; k < path.length && d <= opt.rejoinM; k++) {
        d += E.len[path[k].e];
        if (G.weight[path[k].e] !== G.g.weights.under) x += E.len[path[k].e];
        ahead.set(path[k].v, { d: d, x: x });
      }

      // 다른 갈래 판정
      const alts = [];
      others.forEach(function (x) {
        const skip = function (reason, extra) {
          if (opt.skipped) opt.skipped.push(Object.assign({ node: v, edge: x, reason: reason, at_m: Math.round(at),
            prev: prevT ? S[prevT.si].name : '', fromPrev_m: prevT ? Math.round(at - prevT.at) : null }, extra || {}));
        };
        const walk = followBranch(G, v, x, null, opt);
        const leads = function () { const l = branchLabel(G, walk, x); return { leads: l.name + (walk.stations.length ? ' · ' + S[walk.stations[0]].name + ' 방면' : '') }; };
        // 건넘선은 안내하지 않는다. 단, 다른 노선의 본선으로 건너가 다른 다음 역으로 가면 갈림길이다(예: 신정지선 → 2호선 본선)
        if (E.svc[x] === crossover) {
          const ne = walk.nameEdge;
          const elsewhere = ne >= 0 && E.svc[ne] === 0 && !sameLine(G, ne, inName) && !sameLine(G, ne, outName) &&
            walk.stations.length > 0 && walk.stations[0] !== nextSi;
          if (!elsewhere) return skip('crossover', leads());
        }
        const angle = turnAngle(inB, headingOut(G, v, walk.steps, opt.lookM));
        if (Math.abs(angle) > opt.behindDeg) return skip('behind', Object.assign({ angle: Math.round(angle) }, leads()));
        if (walk.deadEnd && walk.length < opt.stubM) return skip('stub', { length_m: Math.round(walk.length) });
        const link = linkFrom(G, v, x);
        if (link.len < opt.crossoverM) {
          const joins = trackEdgesAt(G, link.end).filter(function (y) { return y !== link.last; });
          if (joins.some(function (y) { return sameLine(G, y, inName) || sameLine(G, y, outName); })) {
            return skip('short-link', Object.assign({ length_m: Math.round(link.len) }, leads()));
          }
        }
        const named = walk.nameEdge >= 0 && chosenWalk.nameEdge >= 0;
        if (walk.stations[0] === nextSi && nextSi >= 0 && !(named && !sameLine(G, walk.nameEdge, chosenWalk.nameEdge))) {
          return skip('same-next-station', leads());
        }
        // 6. 금방 경로로 다시 합쳐지는 선(대피선·통과선, 예: 9호선 사평역 옆 급행 선로)
        if (rejoins(G, walk, ahead, opt.rejoinM)) return skip('rejoins-route', leads());
        alts.push({ edge: x, walk: walk, angle: angle });
      });
      if (!alts.length) continue;

      // 이름표·방면
      const all = [chosen].concat(alts);
      all.forEach(function (b) {
        Object.assign(b, branchLabel(G, b.walk, b.edge));
        b.structure = T.structs[E.s[b.edge]];
        b.far = turnAngle(inB, headingOut(G, v, b.walk.steps, opt.lookM * 3));   // 좌우 순서가 애매할 때 쓰는 먼 곳 각도
      });
      // 갈래마다 닿는 역 순서(고른 갈래는 경로의 다음 역부터)
      all.forEach(function (b) {
        b.seq = b === chosen && nextSi >= 0 ? [nextSi].concat(b.walk.stations.filter(function (s) { return s !== nextSi; })) : b.walk.stations;
      });
      all.forEach(function (b) {
        const si = b.seq.length ? b.seq[0] : -1;
        b.toward = si >= 0 ? S[si].name : '';
        // 다른 갈래와 같은 역에 먼저 닿으면 그다음 역까지 적는다(예: 강동 앞에서 갈라지는 5호선 본선·마천지선 → '강동 지나 길동')
        if (si >= 0 && b.seq.length > 1 && all.some(function (o) { return o !== b && o.seq[0] === si; })) b.toward += ' 지나 ' + S[b.seq[1]].name;
      });
      setSides(all, opt);

      const clean = function (b) {
        return { edge: b.edge, angle: Math.round(b.angle), dir: b.dir, side: b.side, rank: b.rank, kind: b.kind, name: b.name,
          via: b.via, toward: b.toward, structure: b.structure };
      };
      const ll = GR.nodeLatLng(G.g, v);
      out.push({
        node: v, lat: ll[0], lon: ll[1], pos: i, at_m: Math.round(at), structure: T.structs[E.s[inE]],
        prev: prevT ? { si: prevT.si, name: S[prevT.si].name } : null, fromPrev_m: prevT ? Math.round(at - prevT.at) : null,
        next: nextT ? { si: nextT.si, name: S[nextT.si].name } : null, toNext_m: nextT ? Math.round(nextT.at - at) : null,
        chosen: clean(chosen), alternatives: alts.map(clean)
      });
    }
    return out;
  }

  // 갈래를 따라 maxM 안에서 경로의 앞쪽 노드(ahead)로 다시 들어오고, 그 사이가 경로보다 더 노출되지 않고
  // 많이 돌아가지도 않는가(대피선·통과선). 지상으로 도는 갈래(예: 삼송 → 지축 지상역 → 구파발)는 고를 일이 있으므로 false.
  function rejoins(G, walk, ahead, maxM) {
    const E = G.g.edges;
    let d = 0, x = 0;
    for (let k = 0; k < walk.nodes.length; k++) {
      const e = walk.steps[k][0];
      d += E.len[e];
      if (G.weight[e] !== G.g.weights.under) x += E.len[e];
      if (d > maxM) return false;
      const r = ahead.get(walk.nodes[k]);
      if (r) return x <= r.x + 1 && d <= r.d * 1.5 + 100;
    }
    return false;
  }

  // 경로 간선 i 에서 step(-1 = 뒤로, +1 = 앞으로) 방향으로 이름 있는 첫 선로 간선(없으면 -1)
  function nearestNamed(G, path, i, step) {
    for (let k = i; k >= 0 && k < path.length && isTrack(G, path[k].e); k += step) if (nameKey(G, path[k].e)) return path[k].e;
    return -1;
  }

  // 왼쪽·오른쪽·직진. 갈래 둘 이상이 같은 쪽이면 각도 순서로 '왼쪽 갈래'·'가운데 갈래'·'오른쪽 갈래'
  //   rank = 왼쪽부터 0, 1, 2 … 두 갈래의 각도 차이가 3°보다 작으면(선 모양 오차 수준) 먼 곳(약 240m) 각도로 순서를 정한다.
  const TIE_DEG = 3;
  function setSides(all, opt) {
    all.forEach(function (b) { b.dir = Math.abs(b.angle) <= opt.straightDeg ? 'straight' : (b.angle < 0 ? 'left' : 'right'); });
    const order = all.slice().sort(function (a, b) { return Math.abs(a.angle - b.angle) >= TIE_DEG ? a.angle - b.angle : a.far - b.far; });
    order.forEach(function (b, k) { b.rank = k; });
    const dirs = all.map(function (b) { return b.dir; });
    const unique = dirs.every(function (d, k) { return dirs.indexOf(d) === k; });
    if (unique) { all.forEach(function (b) { b.side = SIDE_KO[b.dir]; }); return; }
    order.forEach(function (b, k) {
      b.side = k === 0 ? '왼쪽 갈래' : k === order.length - 1 ? '오른쪽 갈래' :
        (order.length === 3 ? '가운데 갈래' : '왼쪽에서 ' + (k + 1) + '번째 갈래');
    });
  }

  /* ---------- 안내 문장 ----------
     예: '갈림길 · 강동에서 약 260m · 오른쪽 갈래로 (5호선 마천지선 · 둔촌동 방면) · 왼쪽 갈래는 5호선 (길동 방면)'
         갈래 방향이 서로 다르면 '오른쪽 선로로 (…) · 왼쪽은 …', 직진이면 '직진 선로로 (…)' */
  function approxM(m) {
    if (m >= 1000) return '약 ' + (m / 1000).toFixed(1) + 'km';
    return '약 ' + Math.max(10, Math.round(m / 10) * 10) + 'm';
  }
  // 고른 갈래: '2호선 성수지선 · 용답 방면', 다른 갈래: '2호선 (뚝섬 방면)'
  function branchText(b, isAlt) {
    const name = (b.via ? b.via + ' → ' : '') + (b.name || '선로');
    if (!b.toward) return name;
    return isAlt ? name + ' (' + b.toward + ' 방면)' : name + ' · ' + b.toward + ' 방면';
  }
  function sideWithTopic(side) {   // 받침 있는 말 + '은', 없는 말 + '는' ('왼쪽은', '왼쪽 갈래는', '직진은')
    const c = side.charCodeAt(side.length - 1) - 0xAC00;
    return side + (c >= 0 && c < 11172 && c % 28 ? '은' : '는');
  }
  function junctionText(j) {
    let where = '';
    if (j.prev) where = j.fromPrev_m < 30 ? j.prev.name + ' 바로 지나서' : j.prev.name + '에서 ' + approxM(j.fromPrev_m);
    const go = j.chosen.side === '직진' ? '직진 선로로' : j.chosen.side + (/갈래$/.test(j.chosen.side) ? '로' : ' 선로로');
    const parts = ['갈림길'];
    if (where) parts.push(where);
    parts.push(go + ' (' + branchText(j.chosen) + ')');
    j.alternatives.forEach(function (a) { parts.push(sideWithTopic(a.side) + ' ' + branchText(a, true)); });
    return parts.join(' · ');
  }

  /* ---------- Y자 그림 자료 ----------
     걸어가는 방향이 위(↑)가 되게 돌린 각도. 0° = 위, 오른쪽 +. 들어오는 선은 아래(180°)에서 가운데로 온다.
     실제 갈림 각도는 5~15° 정도로 작아 그대로 그리면 겹치므로, 그림용 각도(draw)는 갈래 사이를 30° 이상 벌리고 ±75° 안에 둔다.
     좌표는 100 × 100 상자 기준(가운데 50,50, 갈래 길이 38): <line x1=50 y1=50 x2=x y2=y> 로 그리면 된다. */
  function junctionGlyph(j) {
    const MIN_GAP = 30, MAX = 75, R = 38, C = 50;
    const br = [Object.assign({ role: 'chosen' }, pick(j.chosen, false))]
      .concat(j.alternatives.map(function (a) { return Object.assign({ role: 'alt' }, pick(a, true)); }));
    const order = br.slice().sort(function (a, b) { return a.rank - b.rank; });   // 왼쪽 → 오른쪽 (setSides 의 순서)
    order.forEach(function (b, k) {
      b.draw = Math.max(-MAX, Math.min(MAX, b.angle));
      if (k > 0 && b.draw - order[k - 1].draw < MIN_GAP) b.draw = order[k - 1].draw + MIN_GAP;
    });
    // 벌린 뒤 가운데를 원래 각도의 가운데에 맞추고, ±75° 를 넘으면 안쪽으로 민다
    const mean = function (xs) { return xs.reduce(function (s, x) { return s + x; }, 0) / xs.length; };
    let shift = mean(order.map(function (b) { return Math.max(-MAX, Math.min(MAX, b.angle)); })) - mean(order.map(function (b) { return b.draw; }));
    shift = Math.min(shift, MAX - order[order.length - 1].draw);
    shift = Math.max(shift, -MAX - order[0].draw);
    order.forEach(function (b) {
      b.draw = Math.round(b.draw + shift);
      const r = b.draw * Math.PI / 180;
      b.x = Math.round((C + R * Math.sin(r)) * 10) / 10;
      b.y = Math.round((C - R * Math.cos(r)) * 10) / 10;
    });
    return { box: 100, center: [C, C], incoming: { angle: 180, x: C, y: C + R }, branches: br };
    function pick(b, isAlt) { return { angle: b.angle, rank: b.rank, side: b.side, kind: b.kind, label: branchText(b, isAlt) }; }
  }

  UG.junctions = {
    DEFAULTS: DEFAULTS, findJunctions: findJunctions, junctionText: junctionText, junctionGlyph: junctionGlyph,
    branchText: branchText, followBranch: followBranch, turnAngle: turnAngle, bearing: bearing
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = UG.junctions;
})(typeof globalThis !== 'undefined' ? globalThis : this);
