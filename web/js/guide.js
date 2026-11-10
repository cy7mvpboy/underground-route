/* guide.js — 길 안내 모드 (GPS 없이 체크포인트 단위로 안내)
   - 체크포인트: 출구, 지나는 역, 환승 완료, 나갈 출구, 도착 지점. 사용자가 '도착'을 눌러 하나씩 확인한다.
   - 역 사이에서는 마지막 확인 뒤 지난 시간 × 걷는 속도로 걸은 거리를 추정한다.
   - '앞이 막힘': 마지막 확인 지점과 다음 체크포인트 사이 선로(같은 터널의 반대 방향 선로 포함)를 막고,
     마지막 확인 지점에서 다시 찾는다. 되돌아가는 거리(추정)를 알려 준다.
   - 앞부분(buildCheckpoints, blockSpan, progress, routeTrack)은 DOM 을 쓰지 않아 Node 에서도 시험한다.
   - 화면은 GuideView: 지도를 가리지 않는 안내(위 카드·아래 버튼). 지도 위 표시는 app.js 가 onRender 로 그린다.
   - 환승 단계에서는 카드가 환승 모양이 된다(갈아탈 방향 · 승강장 깊이 · 행동 안내 세 줄, 큰 '환승 완료' 단추).
   - distanceToTrack: GPS 위치가 경로에서 얼마나 떨어졌는지(경로에서 벗어남 경고). */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};
  const GR = UG.graph || (typeof require === 'function' ? require('./graph.js') : null);

  const PARALLEL_M = 40;   // 막은 선로에서 이 거리 안에 나란히 있는 선로(상·하행)도 막는다

  function yeok(n) { return n.endsWith('역') ? n : n + '역'; }
  function exitName(st, ref) { return yeok(st) + ' ' + (ref ? ref + '번 출구' : '출구'); }

  /* ---------- 체크포인트 ----------
     plan.items(app.js 의 안내 목록)와 plan.route.path 로 만든다.
     cp = { label, kind: 'enter'|'station'|'transfer'|'junction'|'exit'|'end', item(안내 목록 위치),
            pos(경로 안 간선 위치: 이 간선을 지나면 도착, -1 = 경로 시작 전, path.length = 경로 끝 뒤),
            at(출발부터 m), node, si } */
  function buildCheckpoints(G, plan) {
    const r = plan.route, path = r.path, E = G.g.edges, S = G.g.stations;
    const cps = [];
    let cum = 0, lastSi = r.startSi;
    const push = function (cp) { cps.push(cp); return cp; };
    plan.items.forEach(function (it, k) {
      if (it.kind === 'walk') {
        cum += it.m;
        push({ label: '도착 지점', kind: 'end', item: k, pos: path.length, at: cum, node: -1, si: -1 });
      } else if (it.kind === 'enter') {
        cum += it.m;
        push({ label: it.conn.kind === 'entrance' ? exitName(it.stName, it.conn.ref) : yeok(it.stName), kind: 'enter',
          item: k, pos: -1, at: cum, node: it.conn.node, si: it.conn.si });
      } else if (it.kind === 'step' && it.step.type === 'ride') {
        const idx = it.step._idx;
        let lastPos = -2;
        idx.forEach(function (i) {
          cum += E.len[path[i].e];
          const si = G.nodeStation[path[i].v];
          if (si >= 0 && si !== lastSi) {
            lastSi = si; lastPos = i;
            push({ label: yeok(S[si].name), kind: 'station', item: k, pos: i, at: cum, node: path[i].v, si: si });
          }
        });
        // 역 없이 다른 선로로 넘어가는 단계(갈림길)도 확인할 곳 하나를 둔다
        const end = idx[idx.length - 1], nxt = plan.items[k + 1];
        const nextIsRide = nxt && nxt.kind === 'step' && nxt.step.type === 'ride';
        if (lastPos !== end && nextIsRide) {
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
        const label = it.conn.kind === 'entrance' ? exitName(it.stName, it.conn.ref) + '로 나감' : yeok(it.stName) + '에서 나감';
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
     같은 터널·교량의 나란한 선로(반대 방향)도 막는다: 막은 선 모양에서 40m 안에 점의 절반 이상이 있는 선로. */
  function blockSpan(G, path, from, to) {
    const E = G.g.edges, track = G.codes.track;
    const span = [];
    for (let i = Math.max(0, from + 1); i <= Math.min(to, path.length - 1); i++) span.push(path[i].e);
    let out = span.filter(function (e) { return E.k[e] === track; });
    if (!out.length) return new Set(span);
    // 막은 선로의 점들(대략 20m 간격으로 채운다)
    const pts = [];
    out.forEach(function (e) {
      const sh = GR.edgeShape(G.g, e);
      for (let j = 0; j < sh.length; j++) {
        pts.push(sh[j]);
        if (j + 1 < sh.length) {
          const d = GR.haversine(sh[j][0], sh[j][1], sh[j + 1][0], sh[j + 1][1]), n = Math.floor(d / 20);
          for (let q = 1; q < n; q++) pts.push([sh[j][0] + (sh[j + 1][0] - sh[j][0]) * q / n, sh[j][1] + (sh[j + 1][1] - sh[j][1]) * q / n]);
        }
      }
    });
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
      const sh = GR.edgeShape(G.g, e);
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
    if (!edges.size) return { error: '이 구간에는 막을 수 있는 선로가 없습니다.' };
    const doneAt = gs.cur >= 0 ? cps[gs.cur].at : 0;
    // 되돌아갈 거리: 마지막 확인 뒤 걸은 거리(다음 체크포인트까지를 넘지 않게) + 다시 출발할 곳까지 지나온 거리
    const backtrack = Math.min(walked || 0, next.at - doneAt) + (doneAt - (rc >= 0 ? cps[rc].at : 0));
    let from = null, restartLabel = '';
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
     조각마다 안내 거리(len)와 선 모양(pts)이 있고, 조각 안에서는 선 길이에 비례해 위치를 찾는다. */
  function routeTrack(G, plan) {
    const path = plan.route.path, E = G.g.edges, pieces = [];
    let at = 0;
    const add = function (pts, len) {
      if (pts && pts.length >= 2 && len > 0) pieces.push({ from: at, len: len, pts: pts, cum: GR.cumulative(pts) });
      at += len > 0 ? len : 0;
    };
    plan.items.forEach(function (it) {
      if (it.kind === 'walk' || it.kind === 'enter' || it.kind === 'exit') { add(it.latlngs, it.m); return; }
      if (it.kind !== 'step' || it.step.type === 'warning') return;
      const s = it.step;
      s._idx.forEach(function (i) {
        if (s.type === 'surface' && s._pts) add(s._pts, s._m);
        else add(GR.edgeShape(G.g, path[i].e, path[i].u), E.len[path[i].e]);
      });
    });
    return { pieces: pieces, total: at };
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
             onRender({st, p, stepChanged}), onFinish(st) -> true 면 화면을 닫음, onRecenter, reduceMotion } */
  function GuideView(opts) {
    const PN = opts.panel, ST = opts.steps, LN = opts.lines;
    const $ = function (id) { return document.getElementById(id); };
    const el = {
      root: opts.root, card: $('guide-card'), count: $('guide-count'), pos: $('guide-pos'), warn: $('guide-warn'), line: $('guide-line'), title: $('guide-title'),
      dist: $('guide-dist'), next: $('guide-next'), xfer: $('guide-xfer'), walked: $('guide-walked'), note: $('guide-note'),
      cps: $('guide-cps'), drawer: $('guide-drawer'), list: $('guide-list'),
      arrive: $('guide-arrive'), block: $('guide-block'), end: $('guide-end'), recenter: $('guide-recenter')
    };
    let st = null, timer = 0, lastFocus = null, lastItem = -2;

    el.arrive.addEventListener('click', function () { if (st) opts.onArrive(); });
    el.block.addEventListener('click', function () { if (st) opts.onBlock(); });
    el.end.addEventListener('click', function () { opts.onEnd(); });
    el.recenter.addEventListener('click', function () { if (opts.onRecenter) opts.onRecenter(); });
    el.list.addEventListener('click', function () { setDrawer(el.drawer.hidden); });
    el.root.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      if (!el.drawer.hidden && el.list.offsetParent) { setDrawer(false); el.list.focus(); } else opts.onEnd();
    });

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
      return '<b class="num">' + t.slice(0, -u.length) + '</b><small>' + u + '</small>';
    }

    // 지금 할 일(카드 윗부분): 노선 줄, 제목, 경고
    function describeItem(item, p) {
      let line = '', title = '', warn = '';
      if (p.finished) title = '도착했습니다';
      else if (item.kind === 'enter') { line = '지상 걷기'; title = PN.ro(p.next.label) + ' 들어가기'; }
      else if (item.kind === 'exit') { line = '지상 걷기'; title = p.next.kind === 'end' ? '목적지까지 걷기' : p.next.label; }
      else if (item.kind === 'walk') { line = '지상 걷기'; title = '목적지까지 걷기'; }
      else if (item.kind === 'arrive') { title = p.next.label; }
      else if (item.step.type === 'surface') {
        const s = item.step;
        line = '지상 걷기'; title = PN.ro(PN.exitName(s.to_station, s.to_ref)) + ' 걷기';
        warn = '지하로 이어진 길이 없어 지상으로 ' + PN.fmtDist(s.distance_m) + ' 걷습니다.';
      } else if (item.step.type === 'transfer') {
        const s = item.step;
        line = LN.chip(s.from_line) + ' <span aria-hidden="true">→</span> ' + LN.chip(s.to_line) + (item.xfer ? ' ' + PN.xferBadge(item.xfer) : '');
        title = PN.yeok(s.station) + ' 환승';
        if (!s.underground) warn = '환승 통로가 지상입니다. 몸을 낮추고 빠르게 이동하세요.';
      } else {
        const s = item.step;
        const rest = s.line ? (s.label === s.line ? '' : s.label.replace(s.line + ' · ', '')) : s.label;
        line = (s.line ? LN.chip(s.line) : '') + (rest ? ' <span class="g-track">' + PN.esc(rest) + '</span>' : '');
        const head = s.terminal_direction || s.direction;
        title = head ? PN.ro(head) + ' 걷기' : '선로를 따라 걷기';
        if (s.exposure_m) warn = '이 단계에 지상 노출 ' + PN.fmtDist(s.exposure_m) + '이 있습니다.';
      }
      if (item && item.kind === 'step') {   // 이 단계 앞의 지상 노출 경고
        const w = st.plan.items.find(function (x) { return x.kind === 'step' && x.step.type === 'warning' && x.step.in_step === item.step.no; });
        if (w) warn = '지상 노출 ' + PN.fmtDist(w.step.exposure_m) + ' — ' + w.step.at + (w.step.after_m ? ' 지나 ' + ST.fmtKm(w.step.after_m) : '') + '에서 ' +
          (w.step.portal ? '터널을 나옵니다' : '지상 구간이 시작됩니다') + '.';
      }
      if (item && (item.kind === 'enter' || item.kind === 'exit' || item.kind === 'walk')) warn = warn || '지상 구간입니다. 몸을 낮추고 빠르게 이동하세요.';
      return { line: line, title: title, warn: warn };
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
      el.warn.textContent = d.warn ? '※ ' + d.warn : '';
      el.warn.hidden = !d.warn;
      // 환승 단계: 카드를 환승 모양으로(갈아탈 방향 · 승강장 높이 · 행동 안내 세 줄, '환승 완료' 단추)
      const x = !p.finished && item && item.kind === 'step' && item.step.type === 'transfer' ? item.xfer : null;
      el.card.classList.toggle('is-xfer', !!x);
      // 지도를 덜 가리게: 할 일(방향·세 줄)을 먼저, 계단 위치·깊이는 작은 한 줄씩
      el.xfer.innerHTML = x ? PN.xferDirHtml(x) + PN.xferMicroHtml(x) + PN.xferFastHtml(x) + PN.xferLevelsLine(x) : '';
      el.xfer.hidden = !x;
      if (p.finished) {
        el.dist.innerHTML = '';
        el.next.textContent = st.plan.view.exposed_m > 0 ? '지상 노출이 있었던 경로입니다. 주변을 살피세요.' : '';
      } else if (x) {
        el.dist.innerHTML = big(x.distance_m) + '<span class="g-dist-t">약 ' + PN.esc(UG.transfer.fmtMin(x.minutes)) + ' · ' + PN.esc(x.source_label) + '</span>';
        el.next.innerHTML = '';
      } else {
        el.dist.innerHTML = big(p.stepLeft_m) + '<span class="g-dist-t">약 ' + minutes(p.stepLeft_m) + '</span>';
        // 나갈 출구: 출구 주변 이름(역세권 현황, 있으면) — '서울역 5번 출구로 나감 · 동자동, 서울역 방면'
        const area = p.next.kind === 'exit' && item && item.conn && item.conn.kind === 'entrance' ? PN.areasText(item.conn.si, item.conn.ref) : '';
        el.next.innerHTML = '다음 확인 <b>' + PN.esc(p.next.label) + '</b>' + (area ? ' · ' + PN.esc(area) : '') +
          (p.stepLeft_m > p.toNext_m + 1 ? ' <span class="num">' + PN.fmtDist(p.toNext_m) + '</span>' : '');
      }
      el.dist.hidden = !el.dist.innerHTML;
      el.next.hidden = !el.next.innerHTML;
      el.note.innerHTML = st.note || '';
      el.note.hidden = !st.note;
      renderWalked(p);
      renderList();
      el.arrive.disabled = p.finished;
      el.block.disabled = p.finished;
      el.arrive.innerHTML = p.finished ? '도착 완료' : x ? '환승 완료<small>' + PN.esc(x.to.line) + ' 승강장</small>' : '도착<small>' + PN.esc(p.next.label) + '</small>';
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

    // 마지막 확인 뒤 걸은 거리(추정) = 지난 시간 × 걷는 속도
    function walkedM() { return st ? (Date.now() - st.since) / 1000 * opts.getSpeed() / 3.6 : 0; }
    function renderWalked(p) {
      if (!st || p.finished) { el.walked.hidden = true; return; }
      const min = (Date.now() - st.since) / 60000;
      const from = st.cur >= 0 ? st.cps[st.cur].label : st.startLabel;
      el.walked.hidden = min < 1;
      el.walked.textContent = from + ' 확인 뒤 ' + Math.floor(min) + '분 · 약 ' + PN.fmtDist(Math.min(walkedM(), p.toNext_m)) + ' 걸음(추정)';
    }
    function tick() {
      if (!st) return;
      const p = progress(st.cps, st.cur, st.plan.view.total_m);
      renderWalked(p);
      if (opts.onRender) opts.onRender({ st: st, p: p, stepChanged: false });
    }

    return {
      open: function (plan, cps, startLabel, note, backtrack) {
        const wasOpen = !el.root.hidden;
        st = { plan: plan, cps: cps, cur: -1, since: Date.now(), startLabel: startLabel, note: note || '', backtrack: backtrack || 0 };
        lastItem = -2;
        if (!wasOpen) lastFocus = document.activeElement;
        el.root.hidden = false;
        document.documentElement.classList.add('guide-open');
        setDrawer(false);
        render();
        clearInterval(timer);
        timer = setInterval(tick, 5000);
        el.title.focus();
      },
      // 실제 도보 길을 받아 거리가 바뀌었을 때: 확인한 곳은 그대로 두고 다시 그린다
      refresh: function (plan, cps) { if (!st || st.plan !== plan) return; st.cps = cps; render(); },
      close: function () {
        st = null;
        clearInterval(timer);
        el.root.hidden = true;
        document.documentElement.classList.remove('guide-open');
        if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus();
      },
      arrive: function () {
        if (!st || st.cur + 1 >= st.cps.length) return;
        st.cur++; st.since = Date.now(); st.note = ''; st.backtrack = 0;
        if (st.cur + 1 >= st.cps.length && opts.onFinish && opts.onFinish(st)) return;   // 마지막 확인: 역 시트로 넘긴다
        render();
      },
      // 위치 표시 글과 색: tone = 'gps'(파란 점) | 'est'(추정, 점선 고리) | 'off'(경로에서 벗어남)
      setPosMode: function (text, tone) { el.pos.textContent = text; el.pos.hidden = !text; el.pos.dataset.tone = tone || ''; },
      setFollow: function (on) { el.recenter.hidden = on; },
      state: function () { return st; },
      walkedM: walkedM,
      ping: tick,   // 새 GPS 위치가 오면 지도 표시만 바로 다시 그린다
      isOpen: function () { return !el.root.hidden; }
    };
  }

  UG.guide = {
    buildCheckpoints: buildCheckpoints, progress: progress, blockSpan: blockSpan, planBlock: planBlock,
    routeTrack: routeTrack, pointAt: pointAt, sliceTrack: sliceTrack, distanceToTrack: distanceToTrack, GuideView: GuideView
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = UG.guide;
})(typeof globalThis !== 'undefined' ? globalThis : this);
