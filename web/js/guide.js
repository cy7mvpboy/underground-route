/* guide.js — 길 안내 모드 (GPS 없이 체크포인트 단위로 안내)
   - 체크포인트: 출구, 지나는 역, 환승 완료, 나갈 출구, 도착 지점. 사용자가 '도착'을 눌러 하나씩 확인한다.
   - 역 사이에서는 마지막 확인 뒤 지난 시간 × 걷는 속도로 걸은 거리를 추정한다.
   - '앞이 막힘': 마지막 확인 지점과 다음 체크포인트 사이 선로(같은 터널의 반대 방향 선로 포함)를 막고,
     마지막 확인 지점에서 다시 찾는다. 되돌아가는 거리(추정)를 알려 준다.
   - 앞부분(buildCheckpoints, blockSpan, progress, routeTrack)은 DOM 을 쓰지 않아 Node 에서도 시험한다.
   - 화면은 GuideView: 지도를 가리지 않는 안내(위 카드·아래 버튼). 지도 위 표시는 app.js 가 onRender 로 그린다.
   - 환승 단계에서는 카드가 환승 모양이 된다(갈아탈 방향 · 승강장 깊이 · 행동 안내 세 줄, 큰 '환승 완료' 단추).
   - distanceToTrack: GPS 위치가 경로에서 얼마나 떨어졌는지(경로에서 벗어남 경고).
   - GpsGate: 길 안내 중 GPS 를 믿을지(6초 끊기면 추정, 잃은 뒤 추정 위치가 지하 구간이면 엄하게 다시 잡기). underNow 가 지하 구간인지 본다. */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};
  const GR = UG.graph || (typeof require === 'function' ? require('./graph.js') : null);

  const PARALLEL_M = 40;   // 막은 선로에서 이 거리 안에 나란히 있는 선로(상·하행)도 막는다

  function yeok(n) { return n.endsWith('역') ? n : n + '역'; }
  function exitName(st, ref) { return yeok(st) + ' ' + (ref ? ref + '번 출구' : '출구'); }

  /* ---------- 갈림길 (junctions.js) ----------
     경로의 갈림길 목록은 경로(간선 목록)로만 정해지므로 plan 에 한 번만 붙여 둔다(plan.junctions).
     junctions.js 를 불러오지 않았으면(일부 Node 시험) 갈림길 없이 동작한다. */
  function planJunctions(G, plan) {
    if (!plan.junctions) {
      const J = UG.junctions;
      plan.junctions = J && plan.route.path.length ? J.findJunctions(G, plan.route.path) : [];
    }
    return plan.junctions;
  }
  // '오른쪽 갈래로' · '오른쪽 선로로' · '직진 선로로' (junctions.js 의 안내 문장과 같은 말)
  function forkGo(side) { return side === '직진' ? '직진 선로로' : side + (/갈래$/.test(side) ? '로' : ' 선로로'); }

  /* ---------- 체크포인트 ----------
     plan.items(app.js 의 안내 목록)와 plan.route.path 로 만든다.
     cp = { label, kind: 'enter'|'station'|'transfer'|'junction'|'exit'|'end', item(안내 목록 위치),
            pos(경로 안 간선 위치: 이 간선을 지나면 도착, -1 = 경로 시작 전, path.length = 경로 끝 뒤),
            at(출발부터 m), node, si, jn(갈림길이면 plan.junctions 번호) } */
  function buildCheckpoints(G, plan) {
    const r = plan.route, path = r.path, E = G.g.edges, S = G.g.stations;
    const cps = [];
    let cum = 0, lastSi = r.startSi;
    const push = function (cp) { cps.push(cp); return cp; };
    const jns = planJunctions(G, plan), jAt = new Map();   // 경로 간선 위치 -> 그 간선 끝의 갈림길 번호들
    jns.forEach(function (j, n) { if (!jAt.has(j.pos)) jAt.set(j.pos, []); jAt.get(j.pos).push(n); });
    plan.items.forEach(function (it, k) {
      if (it.kind === 'walk') {
        cum += it.m;
        push({ label: '도착 지점', kind: 'end', item: k, pos: path.length, at: cum, node: -1, si: -1 });
      } else if (it.kind === 'enter') {
        cum += it.m;
        push({ label: UG.steps.connLabel(it.conn, it.stName, true), kind: 'enter',
          item: k, pos: -1, at: cum, node: it.conn.node, si: it.conn.si });
      } else if (it.kind === 'approach') {
        // 선로 위 지금 위치 -> 첫 노드. 그 노드가 역이면 확인할 곳으로 두고, 아니면 다음에 닿는 역부터 센다
        cum += it.m;
        const v0 = path.length ? path[0].u : -1, si = v0 >= 0 ? G.nodeStation[v0] : -1;
        if (si >= 0) push({ label: yeok(S[si].name), kind: 'station', item: k, pos: -1, at: cum, node: v0, si: si });
        lastSi = si;
      } else if (it.kind === 'egress') {
        // 나갈 곳: 역 출구면 'exit'(앞이 막힘 = 그 출구만 막음), 나머지는 'end'
        cum += it.m;
        const c = it.cand, label = c.k === 'exit' ? c.title + '로 나감' : c.title;
        push({ label: label, kind: c.k === 'exit' && path.length ? 'exit' : 'end', item: k, pos: c.k === 'exit' && path.length ? path.length - 1 : path.length,
          at: cum, node: -1, si: c.si != null ? c.si : -1 });
      } else if (it.kind === 'step' && it.step.type === 'ride') {
        const idx = it.step._idx;
        let lastPos = -2, jnAtEnd = false;
        idx.forEach(function (i) {
          cum += E.len[path[i].e];
          const si = G.nodeStation[path[i].v];
          if (si >= 0 && si !== lastSi) {
            lastSi = si; lastPos = i;
            push({ label: yeok(S[si].name), kind: 'station', item: k, pos: i, at: cum, node: path[i].v, si: si });
          }
          // 갈림길: 역 사이 체크포인트. '통과'를 누르면 다음으로
          (jAt.get(i) || []).forEach(function (n) {
            const j = jns[n];
            push({ label: '갈림길 · ' + forkGo(j.chosen.side), kind: 'junction', item: k, pos: i, at: cum, node: j.node, si: -1, jn: n });
            if (i === idx[idx.length - 1]) jnAtEnd = true;
          });
        });
        // 역 없이 다른 선로로 넘어가는 단계(갈림길)도 확인할 곳 하나를 둔다
        const end = idx[idx.length - 1], nxt = plan.items[k + 1];
        const nextIsRide = nxt && nxt.kind === 'step' && nxt.step.type === 'ride';
        if (lastPos !== end && nextIsRide && !jnAtEnd) {
          push({ label: '선로가 갈라지는 곳 (' + nxt.step.label + ' 쪽)', kind: 'junction', item: k, pos: end, at: cum, node: path[end].v, si: -1 });
        }
      } else if (it.kind === 'step' && it.step.type === 'surface') {
        // 지상 걷기: 나갈 출구(앞 간선이 출입구면)와 걸어서 닿을 출구
        const i = it.step._idx[0], s = it.step;
        const prev = cps[cps.length - 1];
        if (i > 0 && !(prev && prev.pos === i - 1)) {
          push({ label: exitName(s.from_station, s.from_ref) + '로 나감', kind: 'station', item: k, pos: i - 1, at: cum, node: path[i - 1].v, si: G.nodeStation[path[i - 1].u] });
        }
        cum += s._m != null ? s._m : E.len[path[i].e];   // 실제 길을 받았으면 그 거리(walk.js)
        lastSi = s._to_si;
        push({ label: exitName(s.to_station, s.to_ref) + ' (걸어서)', kind: 'station', item: k, pos: i, at: cum, node: path[i].v, si: s._to_si });
      } else if (it.kind === 'step' && it.step.type === 'transfer') {
        const i = it.step._idx[0];
        cum += E.len[path[i].e];
        const si = G.nodeStation[path[i].v];
        if (si >= 0) lastSi = si;
        push({ label: '환승 완료 · ' + it.step.to_line, kind: 'transfer', item: k, pos: i, at: cum, node: path[i].v, si: si });
      } else if (it.kind === 'exit') {
        const last = cps[cps.length - 1];
        const label = it.conn.kind === 'hub' ? yeok(it.stName) + '에서 나감' : UG.steps.connLabel(it.conn, it.stName, false) + '로 나감';
        if (path.length && !(last && last.pos === path.length - 1)) {
          push({ label: label, kind: 'exit', item: k, pos: path.length - 1, at: cum, node: path[path.length - 1].v, si: it.conn.si });
        } else if (last) { last.label = label; last.kind = 'exit'; last.item = k; }
        cum += it.m;
        push({ label: '도착 지점', kind: 'end', item: k, pos: path.length, at: cum, node: -1, si: -1 });
      } else if (it.kind === 'arrive') {
        const last = cps[cps.length - 1];
        if (last && last.si === it.si) { last.kind = 'end'; last.item = k; last.label = yeok(it.stName) + ' 도착'; last.at = cum; }
        else push({ label: yeok(it.stName) + ' 도착', kind: 'end', item: k, pos: Math.max(path.length - 1, -1), at: cum, node: -1, si: it.si });
      }
    });
    return cps;
  }

  // 진행 상황: cur = 마지막으로 확인한 체크포인트(-1 = 아직 없음)
  function progress(cps, cur, total) {
    const doneAt = cur >= 0 ? cps[cur].at : 0;
    const next = cps[cur + 1] || null;
    let stepEnd = doneAt;
    if (next) cps.forEach(function (c) { if (c.item === next.item) stepEnd = Math.max(stepEnd, c.at); });
    return {
      next: next, toNext_m: next ? next.at - doneAt : 0, stepLeft_m: stepEnd - doneAt,
      left_m: Math.max(0, total - doneAt), finished: !next
    };
  }

  /* ---------- 막기 ----------
     경로 위치 from+1 .. to 의 간선 중 선로를 막는다(선로가 없으면 그 구간 간선 전부: 환승 통로·출입구).
     같은 터널·교량의 나란한 선로(반대 방향)도 막는다: 막은 선 모양에서 40m 안에 길이의 절반 이상이 있는 선로.
     두 선 모두 약 20m 간격으로 점을 채워 센다. 선 모양의 꼭짓점만 세면, 점이 둘뿐인 곧은 이웃 구간(예: 여의도–여의나루)이
     막은 구간과 같이 쓰는 끝점 하나만으로 '절반'이 되어 함께 막혔다(2026-11-11 고침). */
  function densify(sh) {
    const out = [];
    for (let j = 0; j < sh.length; j++) {
      out.push(sh[j]);
      if (j + 1 < sh.length) {
        const d = GR.haversine(sh[j][0], sh[j][1], sh[j + 1][0], sh[j + 1][1]), n = Math.floor(d / 20);
        for (let q = 1; q < n; q++) out.push([sh[j][0] + (sh[j + 1][0] - sh[j][0]) * q / n, sh[j][1] + (sh[j + 1][1] - sh[j][1]) * q / n]);
      }
    }
    return out;
  }
  function blockSpan(G, path, from, to) {
    const E = G.g.edges, track = G.codes.track;
    const span = [];
    for (let i = Math.max(0, from + 1); i <= Math.min(to, path.length - 1); i++) span.push(path[i].e);
    let out = span.filter(function (e) { return E.k[e] === track; });
    if (!out.length) return new Set(span);
    // 막은 선로의 점들(대략 20m 간격으로 채운다)
    const pts = [];
    out.forEach(function (e) { densify(GR.edgeShape(G.g, e)).forEach(function (p) { pts.push(p); }); });
    let s = 90, w = 180, n = -90, ea = -180;
    pts.forEach(function (p) { s = Math.min(s, p[0]); n = Math.max(n, p[0]); w = Math.min(w, p[1]); ea = Math.max(ea, p[1]); });
    const pad = 0.0006;   // 약 60m
    s -= pad; n += pad; w -= pad; ea += pad;
    const set = new Set(out);
    const near = function (la, lo) {
      for (let j = 0; j < pts.length; j++) if (GR.haversine(la, lo, pts[j][0], pts[j][1]) <= PARALLEL_M) return true;
      return false;
    };
    const N = G.g.nodes;
    for (let e = 0; e < E.a.length; e++) {
      if (E.k[e] !== track || set.has(e)) continue;
      const la = N.lat[E.a[e]] / 1e5, lo = N.lon[E.a[e]] / 1e5, lb = N.lat[E.b[e]] / 1e5, lob = N.lon[E.b[e]] / 1e5;
      const inA = la >= s && la <= n && lo >= w && lo <= ea, inB = lb >= s && lb <= n && lob >= w && lob <= ea;
      if (!inA && !inB) continue;
      const sh = densify(GR.edgeShape(G.g, e));
      let hit = 0;
      sh.forEach(function (p) { if (near(p[0], p[1])) hit++; });
      if (hit * 2 >= sh.length) set.add(e);
    }
    return set;
  }

  /* ---------- 앞이 막힘: 무엇을 막고 어디서 다시 찾을지 ----------
     gs = { plan, cps, cur }, walked = 마지막 확인 뒤 걸은 거리(추정 m)
     돌려주는 값: { edges(막을 간선 Set), from(다시 찾을 출발 끝점, null = 처음 출발점), restartLabel,
                   fromLabel, toLabel, backtrack(되돌아갈 거리 m), oldLeft(막기 전 남은 거리 m) } 또는 { error } */
  function planBlock(G, gs, walked) {
    const plan = gs.plan, cps = gs.cps, path = plan.route.path, E = G.g.edges, N = G.g.nodes;
    const next = cps[gs.cur + 1];
    if (!next) return { error: '이미 도착했습니다.' };
    if (!path.length) return { error: '지상 길만 남아 막을 선로가 없습니다. 주변을 살펴 다른 길로 가세요.' };
    const entranceAt = function (i) { return i >= 0 && i < path.length && E.k[path[i].e] === G.codes.entrance ? [path[i].e] : []; };
    let rc = gs.cur, edges;
    if (next.kind === 'enter') {                         // 들어갈 출구가 막힘: 그 출구만 막고 처음 출발점에서
      edges = new Set(entranceAt(0)); rc = -1;
    } else if (next.kind === 'exit' || (next.kind === 'end' && gs.cur >= 0 && cps[gs.cur].kind === 'exit')) {
      edges = new Set(entranceAt(path.length - 1));      // 나갈 출구가 막힘: 그 출구만 막고 지하의 마지막 확인 지점에서
      while (rc >= 0 && cps[rc].kind === 'exit') rc--;
    } else {
      edges = blockSpan(G, path, gs.cur >= 0 ? cps[gs.cur].pos : -1, next.pos);
    }
    // 선로 위 지금 위치에서 출발한 경로(여기서 나가기)인데 아직 아무 곳도 확인하지 않았으면:
    // 가던 쪽 선로(첫 간선 일부 포함)를 막고, 같은 자리에서 반대쪽으로만 다시 찾는다
    const sp = plan.route.startPart;
    let turnBack = null;
    if (gs.cur < 0 && sp && next.kind !== 'enter') {
      blockSpan(G, [{ e: sp.e }], -1, 0).forEach(function (e) { edges.add(e); });
      turnBack = Object.assign({}, plan.from, { only: sp.t1 === 0 ? E.b[sp.e] : E.a[sp.e] });
    }
    if (!edges.size) return { error: '이 구간에는 막을 수 있는 선로가 없습니다.' };
    const doneAt = gs.cur >= 0 ? cps[gs.cur].at : 0;
    // 되돌아갈 거리: 마지막 확인 뒤 걸은 거리(다음 체크포인트까지를 넘지 않게) + 다시 출발할 곳까지 지나온 거리
    const backtrack = Math.min(walked || 0, next.at - doneAt) + (doneAt - (rc >= 0 ? cps[rc].at : 0));
    let from = turnBack, restartLabel = turnBack ? (plan.from.label || plan.from.text || '') : '';
    if (rc >= 0) {
      const c = cps[rc], v = c.node;
      let si = c.si >= 0 ? c.si : G.nodeStation[v];
      if (si < 0) si = plan.route.startSi;
      from = { kind: 'node', node: v, si: si, lat: N.lat[v] / 1e5, lon: N.lon[v] / 1e5, label: c.label, text: c.label + ' (확인한 곳)' };
      restartLabel = c.label;
    }
    return {
      edges: edges, from: from, restartLabel: restartLabel,
      fromLabel: gs.cur >= 0 ? cps[gs.cur].label : '', toLabel: next.label,
      backtrack: backtrack, oldLeft: plan.view.total_m - doneAt
    };
  }

  /* ---------- 경로 위 거리 -> 지도 위치 ----------
     체크포인트의 at(출발부터 m)과 같은 순서·같은 거리로 경로 선을 이어 붙인다.
     조각마다 안내 거리(len)와 선 모양(pts)이 있고, 조각 안에서는 선 길이에 비례해 위치를 찾는다.
     shape(e, u) 를 주면 간선 모양을 그것으로 바꾼다(app.js: 출입구·환승 간선을 지도에 그린 지하도 선으로. null 이면 원래 모양).
     모양만 바뀌고 거리(len)는 그대로라 체크포인트·남은 거리는 같다.
     조각마다 ug(지하인지)도 적는다: 간선의 구조가 graph.json 의 under_structs(출입구 통로·터널·지하 승강장·지하 환승 통로)면 지하.
     경로 탐색이 '지하'로 치는 기준과 같다. 지상 걷기(출발 지점 -> 출구, 출구 -> 도착 지점, 바로 걷기, 역 사이 지상 걷기)는 지상.
     GPS 를 잃은 뒤 다시 잡을 때 얼마나 엄하게 볼지(GpsGate)를 이것으로 정한다. */
  function routeTrack(G, plan, shape) {
    const path = plan.route.path, E = G.g.edges, T = G.g.tables, pieces = [];
    const under = new Set(T.under_structs.map(function (s) { return T.structs.indexOf(s); }));
    const ugEdge = function (e) { return under.has(E.s[e]); };
    let at = 0;
    const add = function (pts, len, ug) {
      if (pts && pts.length >= 2 && len > 0) pieces.push({ from: at, len: len, pts: pts, cum: GR.cumulative(pts), ug: !!ug });
      at += len > 0 ? len : 0;
    };
    plan.items.forEach(function (it) {
      if (it.kind === 'walk' || it.kind === 'enter' || it.kind === 'exit') { add(it.latlngs, it.m, false); return; }
      if (it.kind === 'approach') { add(it.latlngs, it.m, ugEdge(it.part.e)); return; }   // 선로 위 지금 위치 -> 첫 노드: 그 선로
      if (it.kind === 'egress') {   // 수직구까지는 그 터널 간선 일부, 차량기지 안 걷기는 지상
        add(it.latlngs, it.m, !it.surface && !!plan.route.endPart && ugEdge(plan.route.endPart.e));
        return;
      }
      if (it.kind !== 'step' || it.step.type === 'warning') return;
      const s = it.step;
      s._idx.forEach(function (i) {
        if (s.type === 'surface' && s._pts) add(s._pts, s._m, false);
        else add((shape && shape(path[i].e, path[i].u)) || GR.edgeShape(G.g, path[i].e, path[i].u), E.len[path[i].e], ugEdge(path[i].e));
      });
    });
    return { pieces: pieces, total: at };
  }

  // 경로 위 거리 m 이 지하 조각인지. 조각 경계에서는 back 이면 앞 조각, 아니면 뒤 조각을 본다
  function underAt(track, m, back) {
    const ps = track.pieces;
    for (let i = 0; i < ps.length; i++) {
      const end = ps[i].from + ps[i].len;
      if (back ? m <= end : m < end) return ps[i].ug;
    }
    return ps.length ? ps[ps.length - 1].ug : false;
  }

  /* 길 안내의 추정 위치(마지막 확인 지점 + 걸은 거리, 다음 확인 지점까지)가 지하 구간인지. GPS 는 보지 않는다.
     - 방금 확인한 곳(걸은 거리 0)이면 그 뒤 구간을 본다: 지하역 출구에서 '도착'을 누르면 그 뒤는 출구 통로(지하).
     - 추정이 다음 확인 지점에 닿았는데 아직 확인하지 않았으면 그 앞 구간을 본다(확인하기 전에는 아직 그 앞에 있을 수 있다).
     - 다 왔으면 지상(도착 지점·나온 곳. 지하역 도착은 app.js 가 안내를 닫고 역 시트를 연다). */
  function underNow(track, cps, cur, walked) {
    const next = cps[cur + 1];
    if (!track || !track.pieces.length || !next) return false;
    const doneAt = cur >= 0 ? cps[cur].at : 0, m = doneAt + Math.max(0, walked || 0);
    if (next.at > doneAt && m >= next.at) return underAt(track, next.at, true);
    return underAt(track, next.at > doneAt ? m : doneAt, false);
  }

  /* ---------- 길 안내 중 GPS 를 믿을지 (app.js 의 '내 위치 (GPS)'가 쓴다) ----------
     GPS 가 잡히는 동안에는 늘 GPS 를 쓴다. 경로 진행(걸은 거리 추정)만 보고 추정 위치로 바꾸지 않는다:
     걸은 시간·걸음으로 잰 추정은 실제보다 앞서거나 뒤처질 수 있다(사용자 결정 2026-11-12).
     - 잃음: 마지막 위치를 받은 때(Date.now())부터 freshMs 동안 새 위치가 없거나, 정확도가 goodM 보다 나쁜 위치가 옴.
             그때부터 추정 위치를 쓴다.
     - 시각: 끊김·간격은 모두 받은 시각(t)으로 잰다. pos.timestamp(ts)는 Date.now() 와 견주지 않는다:
             안드로이드는 GNSS 위성 시각을 줄 때가 있어 기기 시계가 몇 초만 앞서도 모든 위치가 오래된 것으로 보여
             길 안내 내내 GPS 를 못 쓸 수 있다. ts 는 같은 시계끼리인 위치들의 순서(같은 위치를 또 받음·더 오래된 위치)만 가린다(notNewer).
             길 안내 중 브라우저가 저장해 둔 위치는 maximumAge 0(app.js)으로 막는다.
     - 다시 잡음: 쓸 만한 위치(freshMs 안, 정확도 goodM 안) 하나로 바로 GPS 로 돌아간다(전과 같음).
             다만 GPS 를 잃은 뒤 추정 위치가 지하 구간이면 엄하게 본다. 역 안에서는 와이파이·기지국 위치(정확도 20~60m)가
             자주 와서, 그대로 믿으면 파란 점이 추정 위치를 끌고 간다(실제 폰 시험 2026-11-12).
             잃은 뒤에 연달아 온 위치가 ugCount 번 넘게, ugSpanMs 넘게 이어지고, 모두 정확도 ugGoodM 안
             (고도가 없는 위치는 ugNoAltM 안)이며, 서로 ugSpreadM 안에 모여 있어야 다시 잡는다.
             다른 출구로 나와도 이렇게 다시 잡고, 그 뒤는 '경로에서 벗어남'(app.js)이 그대로 판단한다. */
  const GPS_RULES = {
    freshMs: 6000,    // 끊김: GNSS 는 잡혀 있으면 대개 1초마다 위치를 주므로 6초 = 연달아 5번 넘게 빠짐.
                      // 걷는 속도(초속 1~1.4m)로 6~8m, 계단 한 층을 내려가는 동안 알아챈다(전에는 20초 + 저장된 위치 10초 = 수십 m).
                      // 더 짧으면 지상에서 잠깐 빠질 때(고가 밑·높은 건물 사이) 추정으로 깜빡인다.
    goodM: 80,        // 이보다 정확도가 나쁘면 잃은 것으로 본다(전과 같음)
    ugGoodM: 25,      // 지하 구간에서 다시 잡을 때 정확도: 하늘이 보이는 출구 밖 GNSS 는 대개 5~20m, 역 안 와이파이·기지국은 대개 20~60m
    ugNoAltM: 15,     // 고도(altitude)가 없는 위치: 안드로이드에서는 대개 와이파이·기지국 위치다. iOS·PC 는 다를 수 있어
                      // 이것만으로 버리지는 않고 정확도 기준만 더 엄하게 한다
    ugCount: 3,       // 연달아 3번,
    ugSpanMs: 3000,   // 3초 넘게: 와이파이 위치 한두 번이 우연히 정확해 보여도 넘지 못한다. 출구 밖 GNSS 는 3~4초면 된다
    ugSpreadM: 30     // 서로 30m 안: 3초에 걷는 거리(약 4m)보다 넉넉하고, 와이파이 위치가 여러 AP 사이를 튀는 것(수십 m)은 거른다
  };

  // f 가 last 보다 새 위치가 아닌지: 둘 다 pos.timestamp(ts)가 있고 f.ts <= last.ts 면 true.
  // 브라우저가 저장해 둔 같은 위치를 다시 주면 ts 가 똑같다. 둘 다 같은 기기·같은 시계라 서로 견줄 수 있다(Date.now() 와는 견주지 않는다).
  function notNewer(f, last) {
    return !!last && typeof f.ts === 'number' && isFinite(f.ts) && typeof last.ts === 'number' && isFinite(last.ts) && f.ts <= last.ts;
  }

  /* GPS 판단기: add(fix) 는 위치가 올 때, usable(now, under) 는 그릴 때 부른다.
     fix = { lat, lon, acc(정확도 m), alt(고도, 없으면 null), t(받은 시각 Date.now() ms), ts(pos.timestamp, 없으면 null) },
     under = 추정 위치가 지하 구간인지(underNow). rules 로 GPS_RULES 의 값을 바꿀 수 있다(시험용). */
  function GpsGate(rules) {
    const R = Object.assign({}, GPS_RULES, rules || {});
    let last = null;    // 마지막 위치
    let run = [];       // 연달아 온 지하 기준 위치(약한 위치가 오거나 잃으면 비운다 = 늘 잃은 뒤에 온 것만)
    let lost = true;    // GPS 를 잃었나(= 추정 위치를 쓰는 중). 처음에는 위치가 없으니 잃은 것
    const strong = function (f) { return f.acc <= (f.alt == null ? R.ugNoAltM : R.ugGoodM); };
    const lose = function () { lost = true; run = []; };
    // 지하 다시 잡기: 마지막 위치까지 이어진 위치들 중 ugCount 번·ugSpanMs 넘는 꼬리가 서로 ugSpreadM 안에 모였나
    function regained() {
      const end = run[run.length - 1];
      if (!end || end !== last) return false;
      for (let i = run.length - R.ugCount; i >= 0; i--) {
        if (end.t - run[i].t < R.ugSpanMs) continue;
        for (let a = i; a < run.length; a++) {
          for (let b = a + 1; b < run.length; b++) if (GR.haversine(run[a].lat, run[a].lon, run[b].lat, run[b].lon) > R.ugSpreadM) return false;
        }
        return true;
      }
      return false;
    }
    return {
      // 같은 위치를 또 받았거나 더 오래된 위치(ts 로 가림)면 false(쓰지 않음: 끊김 시계도 새로 시작하지 않는다)
      add: function (f) {
        if (notNewer(f, last)) return false;
        if (last && f.t - last.t >= R.freshMs) lose();   // 그사이 끊겼었다(그동안 화면을 그리지 않았어도)
        if (f.acc > R.goodM) lose();
        if (strong(f)) { run.push(f); if (run.length > 20) run.shift(); } else run = [];
        last = f;
        return true;
      },
      usable: function (now, under) {
        if (!last || now - last.t >= R.freshMs || last.acc > R.goodM) { lose(); return false; }
        if (!lost) return true;                       // GPS 가 잡히는 중: 지하 구간이어도 그대로 GPS
        if (under && !regained()) return false;       // 잃은 뒤 추정 위치가 지하: 엄하게
        lost = false;                                 // 다시 잡음
        return true;
      },
      isLost: function () { return lost; }
    };
  }

  function pieceAt(track, m) {
    const ps = track.pieces;
    if (!ps.length) return null;
    for (let i = 0; i < ps.length; i++) if (m < ps[i].from + ps[i].len) return ps[i];
    return ps[ps.length - 1];
  }
  // 출발부터 m 지점의 [lat, lon]
  function pointAt(track, m) {
    const p = pieceAt(track, m);
    if (!p) return null;
    const f = Math.max(0, Math.min(1, (m - p.from) / p.len));
    return GR.pointAlong(p.pts, p.cum, f * p.cum[p.cum.length - 1]);
  }
  // 점에서 경로 선까지 가장 가까운 거리(m). GPS 위치가 경로에서 벗어났는지 볼 때 쓴다.
  // 짧은 거리라 위도·경도를 m 로 바꾼 평면에서 선분까지의 거리를 잰다.
  function distanceToTrack(track, lat, lon) {
    const ky = 111320, kx = 111320 * Math.cos(lat * Math.PI / 180);
    let best = Infinity;
    track.pieces.forEach(function (p) {
      for (let i = 0; i + 1 < p.pts.length; i++) {
        const ax = (p.pts[i][1] - lon) * kx, ay = (p.pts[i][0] - lat) * ky;
        const bx = (p.pts[i + 1][1] - lon) * kx, by = (p.pts[i + 1][0] - lat) * ky;
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        const t = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;   // 선분 위에서 점(원점)과 가장 가까운 곳
        const cx = ax + t * dx, cy = ay + t * dy;
        best = Math.min(best, Math.sqrt(cx * cx + cy * cy));
      }
    });
    return best;
  }

  // 점에서 경로 선에 가장 가까운 곳: { m(출발부터 경로 위 거리, 체크포인트 at 과 같은 기준), off(떨어진 거리 m) }
  // GPS 위치를 경로 위 거리로 바꿀 때 쓴다(갈림길까지 남은 거리, 여기서 나가기).
  function projectOnTrack(track, lat, lon) {
    const ky = 111320, kx = 111320 * Math.cos(lat * Math.PI / 180);
    let best = { m: 0, off: Infinity };
    track.pieces.forEach(function (p) {
      const L = p.cum[p.cum.length - 1] || 1;
      for (let i = 0; i + 1 < p.pts.length; i++) {
        const ax = (p.pts[i][1] - lon) * kx, ay = (p.pts[i][0] - lat) * ky;
        const bx = (p.pts[i + 1][1] - lon) * kx, by = (p.pts[i + 1][0] - lat) * ky;
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        const f = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
        const cx = ax + f * dx, cy = ay + f * dy, d = Math.sqrt(cx * cx + cy * cy);
        if (d < best.off) best = { off: d, m: p.from + (p.cum[i] + f * (p.cum[i + 1] - p.cum[i])) / L * p.len };
      }
    });
    return best;
  }

  /* 경로 위 거리 m(출발부터) -> 그래프 위 자리('여기서 나가기'의 출발점)
     돌려주는 값: {kind: 'edgept', e, t(간선 a 쪽에서 0~1), si(직전에 지난 역), lat, lon} — 선로·승강장·환승·출입구 간선 위
                 {kind: 'surface', lat, lon} — 지상 걷기 구간(출구까지 걷는 중 등) */
  function locateOnPath(G, plan, m) {
    const g = G.g, E = g.edges, r = plan.route, path = r.path;
    let at = 0, lastSi = r.startSi;
    const onEdge = function (e, t) {
      const pts = GR.edgeShape(g, e), cum = GR.cumulative(pts), ll = GR.pointAlong(pts, cum, t * cum[cum.length - 1]);
      return { kind: 'edgept', e: e, t: Math.max(0, Math.min(1, t)), si: lastSi, lat: ll[0], lon: ll[1] };
    };
    const onSurface = function (pts, f) {
      const cum = GR.cumulative(pts), ll = GR.pointAlong(pts, cum, Math.max(0, Math.min(1, f)) * cum[cum.length - 1]);
      return { kind: 'surface', lat: ll[0], lon: ll[1] };
    };
    for (let k = 0; k < plan.items.length; k++) {
      const it = plan.items[k];
      if (it.kind === 'walk' || it.kind === 'enter' || it.kind === 'exit' || (it.kind === 'egress' && it.surface)) {
        if (it.m > 0 && m < at + it.m && it.latlngs.length >= 2) return onSurface(it.latlngs, (m - at) / it.m);
        at += it.m || 0;
        continue;
      }
      if (it.kind === 'approach' || it.kind === 'egress') {   // 간선 일부
        const pt = it.kind === 'approach' ? it.part : r.endPart;
        if (pt && it.m > 0 && m <= at + it.m) return onEdge(pt.e, pt.t0 + (pt.t1 - pt.t0) * (m - at) / it.m);
        at += it.m || 0;
        continue;
      }
      if (it.kind !== 'step' || it.step.type === 'warning') continue;
      const s = it.step;
      for (let q = 0; q < s._idx.length; q++) {
        const p = path[s._idx[q]];
        if (s.type === 'surface') {
          const len = s._m != null ? s._m : E.len[p.e];
          if (m < at + len) return onSurface(s._pts || GR.edgeShape(g, p.e, p.u), (m - at) / len);
          at += len;
        } else {
          const len = E.len[p.e];
          if (m <= at + len) { const f = len > 0 ? (m - at) / len : 0; return onEdge(p.e, p.u === E.a[p.e] ? f : 1 - f); }
          at += len;
        }
        if (G.nodeStation[p.v] >= 0) lastSi = G.nodeStation[p.v];
      }
    }
    // 끝을 지났으면 경로의 마지막 노드
    if (path.length) { const p = path[path.length - 1]; return onEdge(p.e, p.v === E.a[p.e] ? 0 : 1); }
    return null;
  }

  // m0 ~ m1 구간의 선(조각별 배열)
  function sliceTrack(track, m0, m1) {
    const out = [];
    track.pieces.forEach(function (p) {
      const a = Math.max(m0, p.from), b = Math.min(m1, p.from + p.len);
      if (b <= a) return;
      const L = p.cum[p.cum.length - 1];
      out.push(GR.sliceAlong(p.pts, p.cum, (a - p.from) / p.len * L, (b - p.from) / p.len * L));
    });
    return out;
  }

  /* ---------- 화면: 지도가 보이는 길 안내 ----------
     위: 지금 할 일 카드(큰 글씨), 가운데: 지도(app.js 가 onRender 로 그린다), 아래: 도착·앞이 막힘·종료.
     체크포인트 전체 목록은 접히는 서랍(넓은 화면에서는 왼쪽에 늘 보임).
     opts: { root, panel(PN), steps(ST), lines(UG.lines), getSpeed(), onArrive, onBlock, onEnd,
             onRender({st, p, stepChanged}), onFinish(st) -> true 면 화면을 닫음, onRecenter, reduceMotion,
             routePos() -> GPS 로 잰 경로 위 거리(m, 없으면 null), onExitHere(), onExitPick(후보 번호), onExitClose(), onAlt(),
             pdr(pdr.js 걸음 추적기, 없어도 됨) }
     - 걸은 거리(walkedM): 걸음 추적기를 쓸 수 있으면 센 걸음 × 보폭, 아니면 걸은 시간 × 속도. GPS 가 있으면 GPS 가 먼저(hereAt).
     - 대안 경로 한 줄(setAlt): 앞이 막혀 다시 찾은 길보다 꽤 짧은 길이 있으면 첫 확인 지점 전까지 카드에 보인다. 누르면 onAlt.
     - 갈림길 체크포인트: 카드가 갈림길 모양이 된다(큰 Y자, '갈림길 · ○○m 앞', 갈 갈래, 큰 '통과' 단추).
     - 긴 터널(역 사이 1.5km 넘음)에서 앞쪽 경로 위에 수직구·비상 출구가 있으면 '○○m 앞 비상 출구' 한 줄.
     - '여기서 나가기': 아래 단추 줄의 단추. 후보 목록 칸(guide-exits)은 app.js 가 채운다(showExits). */
  function GuideView(opts) {
    const PN = opts.panel, ST = opts.steps, LN = opts.lines;
    const $ = function (id) { return document.getElementById(id); };
    const el = {
      root: opts.root, card: $('guide-card'), count: $('guide-count'), pos: $('guide-pos'), warn: $('guide-warn'), line: $('guide-line'), title: $('guide-title'),
      dist: $('guide-dist'), next: $('guide-next'), xfer: $('guide-xfer'), fork: $('guide-fork'), hint: $('guide-hint'), walked: $('guide-walked'), note: $('guide-note'),
      cps: $('guide-cps'), drawer: $('guide-drawer'), list: $('guide-list'), exits: $('guide-exits'), exitBtn: $('guide-exit'),
      arrive: $('guide-arrive'), block: $('guide-block'), end: $('guide-end'), recenter: $('guide-recenter'), alt: $('guide-alt-slot')
    };
    let st = null, timer = 0, lastFocus = null, lastItem = -2;

    el.arrive.addEventListener('click', function () { if (st) opts.onArrive(); });
    el.block.addEventListener('click', function () { if (st) opts.onBlock(); });
    el.end.addEventListener('click', function () { opts.onEnd(); });
    el.recenter.addEventListener('click', function () { if (opts.onRecenter) opts.onRecenter(); });
    if (el.alt) el.alt.addEventListener('click', function (ev) { if (st && ev.target.closest('[data-action="alt"]') && opts.onAlt) opts.onAlt(); });
    el.list.addEventListener('click', function () { setExits(false); setDrawer(el.drawer.hidden); });
    el.exitBtn.addEventListener('click', function () {
      if (!st) return;
      if (!el.exits.hidden) { setExits(false); return; }
      setDrawer(false);
      opts.onExitHere();
    });
    el.exits.addEventListener('click', function (ev) {
      const b = ev.target.closest('[data-eh]');
      if (b) { opts.onExitPick(+b.dataset.eh); return; }
      if (ev.target.closest('[data-eh-close]')) { setExits(false); el.exitBtn.focus(); }
    });
    el.root.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      if (!el.exits.hidden) { setExits(false); el.exitBtn.focus(); }
      else if (!el.drawer.hidden && el.list.offsetParent) { setDrawer(false); el.list.focus(); } else opts.onEnd();
    });

    // 여기서 나가기 후보 칸: 열면 단계 목록 서랍은 닫는다
    function setExits(open, html) {
      if (open) { el.exits.innerHTML = html; setDrawer(false); }
      const was = !el.exits.hidden;
      el.exits.hidden = !open;
      el.exitBtn.setAttribute('aria-expanded', String(open));
      el.root.classList.toggle('exits-open', open);
      if (open) { const h = el.exits.querySelector('#eh-title'); if (h) h.focus(); }
      if (!open && was && opts.onExitClose) opts.onExitClose();
    }

    function setDrawer(open) {
      el.drawer.hidden = !open;
      el.list.setAttribute('aria-expanded', String(open));
      el.list.textContent = open ? '목록 닫기' : '단계 목록';
      el.root.classList.toggle('drawer-open', open);
      if (open) { const now = el.cps.querySelector('.now'); if (now) now.scrollIntoView({ block: 'nearest' }); }
    }

    function minutes(m) { return PN.fmtTime(m / (opts.getSpeed() * 1000 / 60)); }
    function big(m) {   // '1.2km' -> 큰 숫자 + 작은 단위
      const t = PN.fmtDist(m), u = t.endsWith('km') ? 'km' : 'm';
      return '<span class="g-num"><b class="num">' + t.slice(0, -u.length) + '</b><small>' + u + '</small></span>';
    }

    // 노선 줄: 노선 칩 + 선 이름(다르면)
    function rideLine(s) {
      const rest = s.line ? (s.label === s.line ? '' : s.label.replace(s.line + ' · ', '')) : s.label;
      return (s.line ? LN.chip(s.line) : '') + (rest ? ' <span class="g-track">' + PN.esc(rest) + '</span>' : '');
    }

    /* 카드 글은 '할 일 한 줄(큰 제목) + 큰 거리 + 보조 한 줄'까지만.
       보조 한 줄은 중요한 것 하나: 지상 노출 경고 > 다시 찾은 뒤 알림 > 갈림길 방면·환승 방향·출구 주변 > 앞쪽 비상 출구 */
    function describeItem(item, p) {
      let line = '', title = '', warn = '', sub = '';
      if (p.finished) return { line: '', title: st.plan.route.egress ? '지상으로 나왔습니다' : '도착했습니다', warn: '', sub: '' };
      if (p.next.kind === 'junction' && p.next.jn != null) {   // 갈림길: '갈림길 → 오른쪽 갈래' + Y자 그림과 방면
        const j = st.plan.junctions[p.next.jn];
        return { line: rideLine(item.step), title: '갈림길 → ' + j.chosen.side, warn: '', sub: '' };
      }
      if (item.kind === 'approach') title = item.toward ? PN.ro(/역$|출구|수직구|출입구/.test(item.toward) ? item.toward : item.toward + '역') + ' 걷기' : '선로 따라 걷기';
      else if (item.kind === 'egress') { title = PN.ro(item.cand.title) + ' 나가기'; sub = item.cand.note || ''; }
      else if (item.kind === 'enter') title = PN.ro(p.next.label) + ' 들어가기';
      else if (item.kind === 'exit') {
        title = p.next.kind === 'end' ? '목적지까지 걷기' : p.next.label;
        // 나갈 출구 주변 이름(역세권 현황, 있으면): '동자동, 서울역 방면'
        if (p.next.kind === 'exit' && item.conn && item.conn.kind === 'entrance') sub = PN.areasText(item.conn.si, item.conn.ref);
      }
      else if (item.kind === 'walk') title = '목적지까지 걷기';
      else if (item.kind === 'arrive') {
        const k = st.plan.items.indexOf(item);
        let ride = null;
        for (let q = k - 1; q >= 0 && !ride; q--) { const it = st.plan.items[q]; if (it.kind === 'step' && it.step.type === 'ride' && it.step._tracks_m > 0) ride = it.step; }
        const head = ride && (ride.terminal_direction || ride.direction);
        if (ride) line = rideLine(ride);
        title = head ? PN.ro(head) + ' 걷기' : p.next.label;
      }
      else if (item.step.type === 'surface') title = PN.ro(PN.exitName(item.step.to_station, item.step.to_ref)) + ' 걷기';
      else if (item.step.type === 'transfer') {
        const s = item.step;
        line = LN.chip(s.from_line) + ' <span aria-hidden="true">→</span> ' + LN.chip(s.to_line) + (item.xfer ? ' ' + PN.xferBadge(item.xfer) : '');
        title = PN.yeok(s.station) + ' 환승';
      } else {
        const s = item.step, head = s.terminal_direction || s.direction;
        line = rideLine(s);
        title = head ? PN.ro(head) + ' 걷기' : '선로 따라 걷기';
      }
      if (item.kind === 'step') {   // 이 단계에서 지상 노출이 시작되면: '지상 1.1km · 신도림 지나 0.3km부터'
        const w = st.plan.items.find(function (x) { return x.kind === 'step' && x.step.type === 'warning' && x.step.in_step === item.step.no; });
        if (w) warn = '지상 ' + PN.fmtDist(w.step.exposure_m) + ' · ' + w.step.at + (w.step.after_m ? ' 지나 ' + ST.fmtKm(w.step.after_m) : '') + '부터';
      }
      if (item.kind === 'enter' || item.kind === 'exit' || item.kind === 'walk' || (item.kind === 'step' && item.step.type === 'surface')) warn = warn || '지상 · 몸을 낮추고 빠르게';
      return { line: line, title: title, warn: warn, sub: sub };
    }

    function render() {
      if (!st) return;
      const p = progress(st.cps, st.cur, st.plan.view.total_m);
      const item = p.next ? st.plan.items[p.next.item] : null;
      // 단계 번호: 체크포인트가 속한 안내 항목 순서
      const order = [];
      st.cps.forEach(function (c) { if (order.indexOf(c.item) < 0) order.push(c.item); });
      const stepNo = p.next ? order.indexOf(p.next.item) + 1 : order.length;
      el.count.textContent = (p.finished ? '도착' : '단계 ' + stepNo + '/' + order.length) +
        ' · 남은 ' + PN.fmtDist(p.left_m + (st.cur < 0 ? st.backtrack : 0)) + ' · ' + minutes(p.left_m);
      const d = describeItem(item, p);
      el.line.innerHTML = d.line;
      el.line.hidden = !d.line;
      el.title.textContent = d.title;
      // 환승: 보조 한 줄 = 노선 칩 + '방화 방면 · 앞쪽 계단'. 큰 단추는 '환승 완료'
      const x = !p.finished && item && item.kind === 'step' && item.step.type === 'transfer' ? item.xfer : null;
      el.card.classList.toggle('is-xfer', !!x);
      el.xfer.innerHTML = x ? '<p class="x-dir">' + LN.chip(x.dir ? x.dir.line : x.to.line) + ' <b>' + PN.esc(PN.xferLine(x, true)) + '</b></p>' : '';
      el.xfer.hidden = !x;
      // 갈림길: 큰 Y자 그림 + 갈 쪽 방면 한 줄. 큰 단추는 '통과'
      const jn = !p.finished && p.next.kind === 'junction' && p.next.jn != null ? st.plan.junctions[p.next.jn] : null;
      el.card.classList.toggle('is-fork', !!jn);
      el.fork.innerHTML = jn ? PN.forkSvg(jn, true) + '<p class="fork-go">' + PN.esc(jn.chosen.toward ? jn.chosen.toward + ' 방면' : jn.chosen.name || '') + '</p>' : '';
      el.fork.hidden = !jn;
      // 보조 한 줄: 경고 > 다시 찾은 뒤 알림 > 출구 주변·나갈 곳 설명 (환승·갈림길 카드는 위 한 줄이 그 자리)
      const secondary = d.warn ? 'warn' : st.note ? 'note' : (x || jn) ? 'card' : d.sub ? 'sub' : '';
      el.warn.textContent = secondary === 'warn' ? d.warn : '';
      el.warn.hidden = secondary !== 'warn';
      el.note.innerHTML = secondary === 'note' ? st.note : '';
      el.note.hidden = secondary !== 'note';
      el.next.textContent = secondary === 'sub' ? d.sub : '';
      el.next.hidden = secondary !== 'sub';
      st._secondary = secondary;
      if (el.alt) {   // 대안 경로 한 줄: 다시 찾은 경로의 첫 확인 지점 전까지만(지나면 출발점이 달라진다)
        const showAlt = !!st.alt && st.cur < 0 && !p.finished;
        if (showAlt && el.alt._html !== st.alt) { el.alt.innerHTML = st.alt; el.alt._html = st.alt; }
        el.alt.hidden = !showAlt;
      }
      renderAhead(p);
      renderList();
      el.arrive.disabled = p.finished;
      el.block.disabled = p.finished;
      el.exitBtn.disabled = p.finished;
      // 큰 단추: 역 = '도착', 환승 = '환승 완료', 갈림길 = '통과'(다음 확인 지점으로 넘기고 걸은 거리 추정을 거기서 다시 센다)
      el.arrive.innerHTML = p.finished ? (st.plan.route.egress ? '나옴' : '도착 완료') : x ? '환승 완료<small>' + PN.esc(x.to.line) + ' 승강장</small>' :
        jn ? '통과<small>갈림길 · ' + PN.esc(jn.chosen.side) + '</small>' : '도착<small>' + PN.esc(p.next.label) + '</small>';
      el.arrive.classList.toggle('is-pass', !!jn);
      const changed = (p.next ? p.next.item : -1) !== lastItem || st.cur !== st._lastCur;
      lastItem = p.next ? p.next.item : -1;
      st._lastCur = st.cur;
      if (opts.onRender) opts.onRender({ st: st, p: p, stepChanged: changed });
    }

    function renderList() {
      el.cps.innerHTML = '<li class="done"><span class="g-mark" aria-hidden="true"></span><span>' + PN.esc(st.startLabel) + '</span><span class="num">0</span></li>' +
        st.cps.map(function (c, i) {
          const cls = i <= st.cur ? 'done' : i === st.cur + 1 ? 'now' : '';
          const state = i <= st.cur ? '지남' : i === st.cur + 1 ? '다음' : '';
          return '<li class="' + cls + '"' + (cls === 'now' ? ' aria-current="step"' : '') + '><span class="g-mark" aria-hidden="true"></span>' +
            '<span>' + PN.esc(c.label) + (state ? '<span class="sr-only"> (' + state + ')</span>' : '') + '</span>' +
            '<span class="num">' + ST.fixed1(c.at / 1000) + '</span></li>';
        }).join('');
      if (!el.drawer.hidden) { const now = el.cps.querySelector('.now'); if (now) now.scrollIntoView({ block: 'nearest', behavior: opts.reduceMotion ? 'auto' : 'smooth' }); }
    }

    // 마지막 확인 뒤 걸은 거리(추정) = 걸음 추적기(pdr.js)를 쓸 수 있으면 센 걸음 × 보폭, 아니면 지난 시간 × 걷는 속도
    function walkedM() {
      if (!st) return 0;
      if (opts.pdr && opts.pdr.usable()) return opts.pdr.distanceSinceCheckpoint();
      return (Date.now() - st.since) / 1000 * opts.getSpeed() / 3.6;
    }
    // 지금 위치(경로 위 m): GPS 로 잰 값(app.js 가 경로에 붙인 것)이 있으면 그것, 없으면 마지막 확인 지점 + 걸은 시간 × 속도
    function hereAt(p) {
      const doneAt = st.cur >= 0 ? st.cps[st.cur].at : 0, nextAt = p.next ? p.next.at : doneAt;
      const g = opts.routePos ? opts.routePos() : null;
      if (g != null && isFinite(g)) return { m: Math.max(doneAt, Math.min(g, nextAt)), gps: true };
      return { m: Math.min(doneAt + Math.min(walkedM(), p.toNext_m), nextAt), gps: false };
    }
    /* 시간이 지나면 바뀌는 것(5초마다·GPS 가 올 때): 다음 확인 지점까지 남은 거리(큰 숫자),
       갈림길이면 '260m 앞', 긴 터널(역 사이 1.5km 넘음)이면 앞쪽 비상 출구(보조 줄이 비어 있을 때만) */
    function renderAhead(p) {
      el.walked.hidden = true;
      if (!st || p.finished) { el.dist.innerHTML = ''; el.dist.hidden = true; el.hint.hidden = true; return; }
      const h = hereAt(p), item = st.plan.items[p.next.item];
      const x = item && item.kind === 'step' && item.step.type === 'transfer' ? item.xfer : null;
      const left = Math.max(0, p.next.at - h.m);
      if (x) el.dist.innerHTML = big(x.distance_m) + '<span class="g-dist-t">' + PN.esc(PN.fmtTime(x.minutes)) + '</span>';
      else if (p.next.kind === 'junction' && p.next.jn != null) {
        el.dist.innerHTML = left < 15 ? '<span class="g-num"><b class="num">바로</b><small> 앞</small></span>' : big(Math.round(left / 10) * 10).replace(/<\/small><\/span>$/, ' 앞</small></span>');
      } else el.dist.innerHTML = big(left) + '<span class="g-dist-t">' + minutes(left) + '</span>';
      el.dist.hidden = false;
      let hint = '';
      const eg = st.plan.egressOnRoute;
      if (eg && eg.length && !st._secondary) {
        let a = 0;
        for (let k = st.cur; k >= 0; k--) if (st.cps[k].kind !== 'junction') { a = st.cps[k].at; break; }
        const nx = st.cps.slice(st.cur + 1).find(function (c) { return c.kind !== 'junction'; });
        const e = nx && nx.at - a > 1500 ? eg.find(function (q) { return q.at > h.m + 5 && q.at <= nx.at; }) : null;
        if (e) hint = '<b class="num">' + PN.fmtDist(Math.round((e.at - h.m) / 10) * 10) + ' 앞 비상 출구</b>';
      }
      el.hint.innerHTML = hint;
      el.hint.hidden = !hint;
    }
    function tick() {
      if (!st) return;
      const p = progress(st.cps, st.cur, st.plan.view.total_m);
      renderAhead(p);
      if (opts.onRender) opts.onRender({ st: st, p: p, stepChanged: false });
    }

    return {
      open: function (plan, cps, startLabel, note, backtrack) {
        const wasOpen = !el.root.hidden;
        st = { plan: plan, cps: cps, cur: -1, since: Date.now(), startLabel: startLabel, note: note || '', backtrack: backtrack || 0 };
        lastItem = -2;
        if (opts.pdr) opts.pdr.resetSegment();   // 새 경로·다시 찾은 경로는 걸음을 0부터 센다
        if (!wasOpen) lastFocus = document.activeElement;
        el.root.hidden = false;
        document.documentElement.classList.add('guide-open');
        setDrawer(false);
        setExits(false);
        render();
        clearInterval(timer);
        timer = setInterval(tick, 5000);
        el.title.focus();
      },
      // 실제 도보 길을 받아 거리가 바뀌었을 때: 확인한 곳은 그대로 두고 다시 그린다
      refresh: function (plan, cps) { if (!st || st.plan !== plan) return; st.cps = cps; render(); },
      close: function () {
        setExits(false);
        st = null;
        clearInterval(timer);
        el.root.hidden = true;
        document.documentElement.classList.remove('guide-open');
        if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus();
      },
      arrive: function () {
        if (!st || st.cur + 1 >= st.cps.length) return;
        if (opts.pdr && opts.pdr.status !== 'idle') {
          // 걸음 추적기에 확인한 구간 거리를 알린다. 보폭은 사용자가 이어서 두 번 확인한 체크포인트 사이의 선로 구간으로만 고친다
          // (첫 확인·출입구·환승 통로·지상 걷기는 거리가 어림이라 쓰지 않는다)
          const prev = st.cur >= 0 ? st.cps[st.cur] : null, cp = st.cps[st.cur + 1], it = st.plan.items[cp.item];
          opts.pdr.onCheckpoint(cp.at - (prev ? prev.at : 0), { calibrate: !!prev && it.kind === 'step' && it.step.type === 'ride' });
        }
        st.cur++; st.since = Date.now(); st.note = ''; st.backtrack = 0;
        if (st.cur + 1 >= st.cps.length && opts.onFinish && opts.onFinish(st)) return;   // 마지막 확인: 역 시트로 넘긴다
        render();
      },
      // 위치 표시 글과 색: tone = 'gps'(파란 점) | 'est'(추정, 점선 고리) | 'off'(경로에서 벗어남)
      setPosMode: function (text, tone) { el.pos.textContent = text; el.pos.hidden = !text; el.pos.dataset.tone = tone || ''; },
      setFollow: function (on) { el.recenter.hidden = on; },
      setAlt: function (html) { if (st) { st.alt = html || ''; render(); } },
      state: function () { return st; },
      walkedM: walkedM,
      ping: tick,   // 새 GPS 위치가 오면 지도 표시만 바로 다시 그린다
      // 여기서 나가기 후보 칸(내용은 panel.js 의 exitHereHtml)
      showExits: function (html) { setExits(true, html); },
      hideExits: function () { setExits(false); },
      exitsOpen: function () { return !el.exits.hidden; },
      rerender: function () { if (st) render(); },
      isOpen: function () { return !el.root.hidden; }
    };
  }

  UG.guide = {
    buildCheckpoints: buildCheckpoints, progress: progress, blockSpan: blockSpan, planBlock: planBlock, planJunctions: planJunctions, forkGo: forkGo,
    routeTrack: routeTrack, pointAt: pointAt, sliceTrack: sliceTrack, distanceToTrack: distanceToTrack,
    projectOnTrack: projectOnTrack, locateOnPath: locateOnPath, GuideView: GuideView,
    underAt: underAt, underNow: underNow, GPS_RULES: GPS_RULES, notNewer: notNewer, GpsGate: GpsGate
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = UG.guide;
})(typeof globalThis !== 'undefined' ? globalThis : this);
