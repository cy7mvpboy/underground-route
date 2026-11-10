/* guide.js — 길 안내 모드 (GPS 없이 체크포인트 단위로 안내)
   - 체크포인트: 출구, 지나는 역, 환승 완료, 나갈 출구, 도착 지점. 사용자가 '도착'을 눌러 하나씩 확인한다.
   - 역 사이에서는 마지막 확인 뒤 지난 시간 × 걷는 속도로 걸은 거리를 추정한다.
   - '앞이 막힘': 마지막 확인 지점과 다음 체크포인트 사이 선로(같은 터널의 반대 방향 선로 포함)를 막고,
     마지막 확인 지점에서 다시 찾는다. 되돌아가는 거리(추정)를 알려 준다.
   - 앞부분(buildCheckpoints, blockSpan, progress)은 DOM 을 쓰지 않아 Node 에서도 시험한다. 화면은 GuideView. */
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
        cum += E.len[path[i].e];
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

  /* ---------- 화면 ---------- */
  // opts: { root(섹션), panel(PN), steps(ST), onArrive, onBlock, onEnd, getSpeed(), reduceMotion }
  function GuideView(opts) {
    const PN = opts.panel, ST = opts.steps;
    const $ = function (id) { return document.getElementById(id); };
    const el = {
      root: opts.root, count: $('guide-count'), warn: $('guide-warn'), line: $('guide-line'), title: $('guide-title'),
      next: $('guide-next'), dist: $('guide-dist'), stepLeft: $('guide-step-left'), walked: $('guide-walked'),
      note: $('guide-note'), cps: $('guide-cps'), arrive: $('guide-arrive'), block: $('guide-block'), end: $('guide-end')
    };
    let st = null, timer = 0, lastFocus = null;

    el.arrive.addEventListener('click', function () { if (st) opts.onArrive(); });
    el.block.addEventListener('click', function () { if (st) opts.onBlock(); });
    el.end.addEventListener('click', function () { opts.onEnd(); });
    el.root.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') opts.onEnd(); });

    function minutes(m) { return PN.fmtTime(m / (opts.getSpeed() * 1000 / 60)); }

    function render() {
      if (!st) return;
      const p = progress(st.cps, st.cur, st.plan.view.total_m);
      const item = p.next ? st.plan.items[p.next.item] : null;
      const nSteps = st.cps.length;
      el.count.textContent = (p.finished ? '도착' : '체크포인트 ' + (st.cur + 2) + '/' + nSteps) +
        ' · 남은 거리 ' + PN.fmtDist(p.left_m + (st.cur < 0 ? st.backtrack : 0)) + ' · 약 ' + minutes(p.left_m);
      // 현재 단계
      let line = '', title = '', warn = '';
      if (p.finished) {
        title = '도착했습니다';
      } else if (item.kind === 'enter') {
        line = '지상 걷기'; title = PN.ro(p.next.label) + ' 들어가기';
      } else if (item.kind === 'exit') {
        line = '지상 걷기'; title = p.next.kind === 'end' ? '목적지까지 걷기' : p.next.label;
      } else if (item.kind === 'walk') {
        line = '지상 걷기'; title = '목적지까지 걷기';
      } else if (item.kind === 'arrive') {
        line = ''; title = p.next.label;
      } else if (item.step.type === 'surface') {
        const s = item.step;
        line = '지상 걷기'; title = PN.ro(PN.exitName(s.to_station, s.to_ref)) + ' 걷기';
        warn = '지하로 이어진 길이 없어 지상으로 ' + PN.fmtDist(s.distance_m) + ' 걷습니다.';
      } else if (item.step.type === 'transfer') {
        const s = item.step;
        line = '환승 · ' + PN.yeok(s.station); title = s.from_line + ' → ' + s.to_line + (s.underground ? ' (지하 통로)' : ' (지상)');
        if (!s.underground) warn = '환승 통로가 지상입니다.';
      } else {
        const s = item.step;
        line = s.line ? '<span class="lb">' + PN.esc(s.line) + '</span> ' + PN.esc(s.label === s.line ? '' : s.label.replace(s.line + ' · ', '')) : PN.esc(s.label);
        const head = s.terminal_direction || s.direction;
        title = head ? PN.ro(head) + ' 걷기' : '선로를 따라 걷기';
        if (s.exposure_m) warn = '이 단계에 지상 노출 ' + PN.fmtDist(s.exposure_m) + '이 있습니다.';
      }
      // 이 단계 앞에 지상 노출 경고가 있으면 함께 보여 준다
      if (item && item.kind === 'step') {
        const w = st.plan.items.find(function (x) { return x.kind === 'step' && x.step.type === 'warning' && x.step.in_step === item.step.no; });
        if (w) warn = '지상 노출 ' + PN.fmtDist(w.step.exposure_m) + ' — ' + w.step.at + (w.step.after_m ? ' 지나 ' + ST.fmtKm(w.step.after_m) : '') + '에서 ' +
          (w.step.portal ? '터널을 나옵니다' : '지상 구간이 시작됩니다') + '.';
      }
      if (item && (item.kind === 'enter' || item.kind === 'exit' || item.kind === 'walk')) warn = warn || '이 구간은 지상입니다. 몸을 낮추고 빠르게 이동하세요.';
      el.line.innerHTML = line;
      el.line.hidden = !line;
      el.title.textContent = title;
      el.warn.textContent = warn ? '※ ' + warn : '';
      el.warn.hidden = !warn;
      if (p.finished) {
        el.next.textContent = '';
        el.dist.innerHTML = '';
        el.stepLeft.textContent = st.plan.view.exposed_m > 0 ? '지상 노출이 있었던 경로입니다. 주변을 살피세요.' : '';
      } else {
        el.next.innerHTML = '다음 확인 지점 <b>' + PN.esc(p.next.label) + '</b>';
        el.dist.innerHTML = '<b class="num">' + PN.fmtDist(p.toNext_m) + '</b> · 약 ' + minutes(p.toNext_m);
        el.stepLeft.textContent = p.stepLeft_m > p.toNext_m + 1 ? '이 단계 남은 거리 ' + PN.fmtDist(p.stepLeft_m) + ' · 약 ' + minutes(p.stepLeft_m) : '';
      }
      el.stepLeft.hidden = !el.stepLeft.textContent;
      el.note.innerHTML = st.note || '';
      el.note.hidden = !st.note;
      renderWalked(p);
      // 체크포인트 목록
      const startLabel = st.startLabel;
      el.cps.innerHTML = '<li class="done"><span class="g-mark" aria-hidden="true"></span><span>' + PN.esc(startLabel) + '</span><span class="num">0</span></li>' +
        st.cps.map(function (c, i) {
          const cls = i <= st.cur ? 'done' : i === st.cur + 1 ? 'now' : '';
          const state = i <= st.cur ? '지남' : i === st.cur + 1 ? '다음' : '';
          return '<li class="' + cls + '"' + (cls === 'now' ? ' aria-current="step"' : '') + '><span class="g-mark" aria-hidden="true"></span>' +
            '<span>' + PN.esc(c.label) + (state ? '<span class="sr-only"> (' + state + ')</span>' : '') + '</span>' +
            '<span class="num">' + ST.fixed1(c.at / 1000) + '</span></li>';
        }).join('');
      const now = el.cps.querySelector('.now');
      if (now) now.scrollIntoView({ block: 'nearest', behavior: opts.reduceMotion ? 'auto' : 'smooth' });
      el.arrive.disabled = p.finished;
      el.block.disabled = p.finished;
      el.arrive.innerHTML = p.finished ? '도착 완료' : '도착<small>' + PN.esc(p.next.label) + '</small>';
    }

    // 마지막 확인 뒤 걸은 거리(추정) = 지난 시간 × 걷는 속도
    function walkedM() { return st ? (Date.now() - st.since) / 1000 * opts.getSpeed() / 3.6 : 0; }
    function renderWalked(p) {
      if (!st || p.finished) { el.walked.hidden = true; return; }
      const min = (Date.now() - st.since) / 60000;
      const from = st.cur >= 0 ? st.cps[st.cur].label : st.startLabel;
      const m = Math.min(walkedM(), p.toNext_m);
      el.walked.hidden = min < 1;
      el.walked.textContent = from + ' 확인 뒤 ' + Math.floor(min) + '분 · 약 ' + PN.fmtDist(m) + ' 걸음(추정)';
    }

    return {
      open: function (plan, cps, startLabel, note, backtrack) {
        const wasOpen = !el.root.hidden;
        st = { plan: plan, cps: cps, cur: -1, since: Date.now(), startLabel: startLabel, note: note || '', backtrack: backtrack || 0 };
        if (!wasOpen) lastFocus = document.activeElement;
        el.root.hidden = false;
        document.documentElement.classList.add('guide-open');
        render();
        clearInterval(timer);
        timer = setInterval(function () { if (st) renderWalked(progress(st.cps, st.cur, st.plan.view.total_m)); }, 15000);
        el.title.focus();
      },
      close: function () {
        st = null;
        clearInterval(timer);
        el.root.hidden = true;
        document.documentElement.classList.remove('guide-open');
        if (lastFocus && lastFocus.focus) lastFocus.focus();
      },
      arrive: function () {
        if (!st || st.cur + 1 >= st.cps.length) return;
        st.cur++; st.since = Date.now(); st.note = ''; st.backtrack = 0;
        render();
      },
      state: function () { return st; },
      walkedM: walkedM,
      isOpen: function () { return !el.root.hidden; }
    };
  }

  UG.guide = { buildCheckpoints: buildCheckpoints, progress: progress, blockSpan: blockSpan, planBlock: planBlock, GuideView: GuideView };
  if (typeof module !== 'undefined' && module.exports) module.exports = UG.guide;
})(typeof globalThis !== 'undefined' ? globalThis : this);
