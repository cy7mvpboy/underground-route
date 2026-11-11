// build_3d.js — 3D 지하 이동 화면(web/3d/)이 쓰는 자료 web/3d/ride.json 을 만든다.
// 사용법(프로젝트 폴더에서): node scripts\build_3d.js
//   시연 1번 이야기(web/js/demo.js CONF.story, scripts/check_demo.js 와 같은 순서)를 앱 코드로 다시 계산한다:
//   공덕역 2번 출구로 들어감 → 5호선 마포–여의나루 하저터널에서 막힘 → 마포역으로 되돌아감
//   → 다른 하저터널(광나루–천호)로 다시 찾은 길 → 강동 지나 갈림길(오른쪽 갈래) → 한성백제 도착.
// 내보내는 것
//   - legs: 이동 구간별 선 모양. 점 = [위도, 경도, 구간 시작부터 m, 깊이 m, 한강 아래 정도 0~1]
//   - stations: 지나는 역(노선별 승강장 깊이). 깊이는 서울교통공사 역사심도정보(graph.json stations[].depth)만 '실제'
//   - river: 한강 중심선(OSM way 378066781, data/raw/han_river.json)과 그림용 반폭
//   - net: 바탕에 옅게 그릴 주변 철도 선로(graph.json, OSM)
//   - facts: 자막에 넣을 숫자(앱 계산 결과)
// 깊이 규칙: 깊이 자료가 있는 역(승강장)만 실제 값이다. 역 사이 터널은 두 역 사이를 거리 비율로 잇고(추정),
//   자료가 없는 곳(9호선 등)은 가장 가까운 자료 값을 그대로 쓴다(추정). 강바닥 깊이 자료는 없어서
//   한강 아래 정도(riv)만 내보내고, 화면이 그림으로만 터널을 더 내려 그린다(숫자를 만들지 않는다).
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
for (const f of ['graph', 'junctions', 'router', 'exithere', 'steps', 'transfer', 'nearest', 'guide', 'reach', 'saved', 'demo']) require(path.join(ROOT, 'web/js', f + '.js'));
const UG = globalThis.UG, GR = UG.graph;
// 시연 설정: demo.js 의 CONF 를 쓴다(없으면 같은 값). 한강 횡단 찾기(hanCrossing)도 demo.js 것을 쓴다
const CONF = (UG.demo && UG.demo.CONF) || { speedKmh: 3.5, story: { lat: 37.5447, lon: 126.9497, label: '공덕오거리 부근', meet: '한성백제@서울', blockAfter: '마포@서울', blockFrac: 0.45 } };
const Y = CONF.story;
const g = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/data/graph.json'), 'utf8'));
const G = GR.indexGraph(g);
const E = g.edges, T = g.tables, S = g.stations;

/* ---------- 1. 경로 계산 (check_demo.js 와 같은 순서) ---------- */
const blocked = new Set();
function planOf(from, to) {
  const route = UG.router.findRoute(G, from, to, { blocked }) || UG.router.findRoute(G, from, to, { blocked, surface: true });
  if (!route) throw new Error('경로 없음');
  const p = { from, to, route };
  UG.steps.planItems(G, p, CONF.speedKmh);
  return p;
}
const si = (q) => GR.findStation(G, q);
const meetSi = si(Y.meet);
const near = UG.nearest.nearestUnderground(G, Y.lat, Y.lon, { limit: 3 });
const o1 = near.options[0];                                        // 가장 가까운 지하로(공덕역 2번 출구)
const ep = UG.nearest.endpointsFor(G, Y.lat, Y.lon, o1, Y.label);
const p1 = planOf(ep.from, ep.to);                                 // 거리 → 출구 → 승강장
const from2 = { kind: 'station', si: o1.si, hubs: UG.reach.underHubs(G, o1.si), text: S[o1.si].name + '역 지하 승강장', lat: S[o1.si].lat / 1e5, lon: S[o1.si].lon / 1e5 };
const p2 = planOf(from2, { kind: 'station', si: meetSi, text: Y.meet, lat: S[meetSi].lat / 1e5, lon: S[meetSi].lon / 1e5 });
const cps2 = UG.guide.buildCheckpoints(G, p2);
const at = cps2.findIndex((c) => c.si === si(Y.blockAfter));       // 마포역 체크포인트
const walked = (cps2[at + 1].at - cps2[at].at) * Y.blockFrac;      // 마포에서 터널로 걸어 들어간 거리
const crossA = UG.demo.hanCrossing(G, p2.route.path);
const b = UG.guide.planBlock(G, { plan: p2, cps: cps2, cur: at }, walked);
b.edges.forEach((e) => blocked.add(e));
const p3 = planOf(b.from, p2.to);                                  // 마포에서 다시 찾은 길
const crossB = UG.demo.hanCrossing(G, p3.route.path);
const cps3 = UG.guide.buildCheckpoints(G, p3);
const jk = cps3.findIndex((c) => c.kind === 'junction' && c.jn != null);
const jn = p3.junctions[cps3[jk].jn];
// '두 곳뿐' 확인: 5호선 하저터널 두 곳을 다 막으면 가장 나은 길도 지상을 걷는다
const both = new Set(blocked);
g.presets.han_crossings.filter((x) => x.s === 'tunnel' && (x.lines || []).includes('5호선')).forEach((x) => both.add(x.e));
const pNone = UG.router.findRoute(G, b.from, p2.to, { blocked: both }) || UG.router.findRoute(G, b.from, p2.to, { blocked: both, surface: true });

/* ---------- 2. 선 모양: 안내(guide.routeTrack)와 같은 순서·거리 ----------
   조각 = { pts, len, e(간선, 걷기 = -1), u, v, idx(경로 위치) }. 거리는 앱의 간선 길이(len)를 쓴다 */
function pieces(plan) {
  const path = plan.route.path, out = [];
  plan.items.forEach((it) => {
    if (['walk', 'enter', 'exit', 'approach', 'egress'].includes(it.kind)) { if (it.latlngs && it.m > 0) out.push({ pts: it.latlngs, len: it.m, e: -1, walk: true }); return; }
    if (it.kind !== 'step' || it.step.type === 'warning') return;
    it.step._idx.forEach((i) => {
      const x = path[i];
      if (it.step.type === 'surface' && it.step._pts) out.push({ pts: it.step._pts, len: it.step._m, e: -1, walk: true, idx: i });
      else out.push({ pts: GR.edgeShape(g, x.e, x.u), len: E.len[x.e], e: x.e, u: x.u, v: x.v, idx: i });
    });
  });
  let m = 0;
  out.forEach((p) => { p.from = m; m += p.len; });
  const want = UG.guide.routeTrack(G, plan).total;
  if (Math.abs(m - want) > 0.5) throw new Error(`거리 불일치 ${m} != ${want}`);
  return out;
}

// 노드 → 역(승강장 허브·선로 위 부착점)
const nodeSt = new Map();
S.forEach((s, i) => {
  s.hubs.forEach((v, j) => nodeSt.set(v, { si: i, ls: s.hub_ls[j] }));
  (s.plat || []).forEach((v) => { if (!nodeSt.has(v)) nodeSt.set(v, { si: i, ls: -1 }); });
});
// 노드 v(간선 e 위)의 노선 묶음: 허브면 허브 노선, 선로 위 부착점이면 간선 노선(승강장 간선은 노선이 비어 있어 반대쪽 허브 노선)
function lineSetOf(v, e) {
  const x = nodeSt.get(v);
  if (x.ls >= 0) return T.line_sets[x.ls] || [];
  if ((T.line_sets[E.ls[e]] || []).length) return T.line_sets[E.ls[e]];
  const o = nodeSt.get(E.a[e] === v ? E.b[e] : E.a[e]);
  return o && o.ls >= 0 ? T.line_sets[o.ls] || [] : [];
}
// 노드 v(간선 e 위)의 승강장 깊이 기록: 그 노선의 기록을 고른다
function depthRec(v, e) {
  const x = nodeSt.get(v);
  if (!x || !S[x.si].depth) return null;
  const set = lineSetOf(v, e);
  const d = S[x.si].depth.find((r) => set.includes(r.line));
  return d ? { si: x.si, rec: d } : null;
}

// 조각 → 깊이 기준점([m, 깊이]) + 지나는 역
function anchorsOf(ps) {
  const an = [], st = [];
  ps.forEach((p) => {
    if (p.walk) { an.push([p.from, 0], [p.from + p.len, 0]); return; }          // 지상 걷기 = 깊이 0
    if (T.kinds[E.k[p.e]] === 'entrance') an.push([p.from, 0]);                // 출입구 지상 쪽 끝
    [[p.u, p.from], [p.v, p.from + p.len]].forEach(([v, m]) => {
      const x = nodeSt.get(v);
      if (!x) return;
      const d = depthRec(v, p.e);
      if (d) an.push([m, d.rec.platform_m]);
      const lineSet = lineSetOf(v, p.e);
      const line = d ? T.line_short[d.rec.line] : T.line_short[lineSet[0]] || '';
      const key = x.si + '|' + line;
      if (line && !st.some((s) => s.key === key)) st.push({ key, si: x.si, m, line, d: d ? d.rec.platform_m : null, floor: d ? d.rec.floor : null });
    });
  });
  an.sort((a, c) => a[0] - c[0]);
  return { an, st };
}
// 거리 m 의 깊이: 앞뒤 기준점 사이를 거리 비율로 잇는다. 기준점 밖은 가장 가까운 값
function depthAt(an, m) {
  if (!an.length) return 0;
  if (m <= an[0][0]) return an[0][1];
  for (let i = 1; i < an.length; i++) {
    if (m <= an[i][0]) {
      const [m0, d0] = an[i - 1], [m1, d1] = an[i];
      return m1 > m0 ? d0 + (d1 - d0) * (m - m0) / (m1 - m0) : d1;
    }
  }
  return an[an.length - 1][1];
}

/* ---------- 3. 한강: 중심선과 '한강 아래 정도' ---------- */
const han = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/raw/han_river.json'), 'utf8')).elements[0].geometry.map((p) => [p.lat, p.lon]);
const LAT0 = 37.53, KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110540;   // 거리 계산용(이 범위에서 오차 1% 미만)
const xy = (p) => [p[1] * KX, p[0] * KY];
function distToLine(p, line) {
  const [px, py] = xy(p);
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = xy(line[i - 1]), [bx, by] = xy(line[i]);
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
    best = Math.min(best, Math.hypot(px - ax - t * dx, py - ay - t * dy));
  }
  return best;
}
// 그림용 반폭: 하저터널 양 끝 역 중 강에 가장 가까운 역보다 안쪽(역 표시가 강 띠에 덮이지 않게). 실제 수면 폭이 아니다
const bankSt = [crossA.a, crossA.b, crossB.a, crossB.b].map((n) => S[GR.findStation(G, n + '@서울')]);
const HALF_W = Math.round(Math.min(450, ...bankSt.map((s) => distToLine([s.lat / 1e5, s.lon / 1e5], han) - 60)));
const FADE = 250;   // 띠 밖으로 이 거리 동안 서서히 0 이 된다
function riverness(p) {
  const d = distToLine(p, han);
  if (d <= HALF_W) return 1;
  if (d >= HALF_W + FADE) return 0;
  return 0.5 * (1 + Math.cos(Math.PI * (d - HALF_W) / FADE));
}

/* ---------- 4. 구간 만들기: 40m 마다 점을 넣어(깊이·강 아래 정도가 부드럽게 바뀌게) ---------- */
const STEP_M = 40;
function polyOf(ps, m0, m1) {
  const out = [];
  ps.forEach((p) => {
    if (p.from + p.len < m0 - 1e-6 || p.from > m1 + 1e-6) return;
    const cum = GR.cumulative(p.pts), L = cum[cum.length - 1] || 1;
    const k = p.len / L;                                  // 선 모양 길이 → 앱 거리(len) 비율
    for (let i = 0; i < p.pts.length; i++) {
      const m = p.from + cum[i] * k;
      if (i > 0) {                                        // 긴 선분은 STEP_M 마다 나눈다
        const mPrev = p.from + cum[i - 1] * k, n = Math.ceil((m - mPrev) / STEP_M);
        for (let j = 1; j < n; j++) {
          const t = j / n, q = [p.pts[i - 1][0] + (p.pts[i][0] - p.pts[i - 1][0]) * t, p.pts[i - 1][1] + (p.pts[i][1] - p.pts[i - 1][1]) * t];
          const mm = mPrev + (m - mPrev) * t;
          if (mm > m0 && mm < m1) out.push([q[0], q[1], mm]);
        }
      }
      if (m >= m0 - 1e-6 && m <= m1 + 1e-6 && !(out.length && Math.abs(out[out.length - 1][2] - m) < 0.5)) out.push([p.pts[i][0], p.pts[i][1], m]);
    }
  });
  // 양 끝을 m0·m1 에 맞춘다(막힌 지점처럼 간선 중간에서 끊길 때)
  const track = { pieces: ps.map((p) => ({ from: p.from, len: p.len, pts: p.pts, cum: GR.cumulative(p.pts) })), total: 0 };
  const at = (m) => { const q = UG.guide.pointAt(track, m); return [q[0], q[1], m]; };
  if (!out.length || out[0][2] > m0 + 0.5) out.unshift(at(m0));
  if (out[out.length - 1][2] < m1 - 0.5) out.push(at(m1));
  return out;
}
const r1 = (x) => Math.round(x * 10) / 10, r5 = (x) => Math.round(x * 1e5) / 1e5, r2 = (x) => Math.round(x * 100) / 100;
function legOf(ps, an, m0, m1) {
  return polyOf(ps, m0, m1).map(([la, lo, m]) => [r5(la), r5(lo), r1(m - m0), r1(depthAt(an, m)), r2(riverness([la, lo]))]);
}

const ps1 = pieces(p1), ps2 = pieces(p2), ps3 = pieces(p3);
const A1 = anchorsOf(ps1), A2 = anchorsOf(ps2), A3 = anchorsOf(ps3);
const total1 = ps1.reduce((a, p) => a + p.len, 0), total3 = ps3.reduce((a, p) => a + p.len, 0);
const mapoAt = cps2[at].at, blockAt = mapoAt + walked, yeouiAt = cps2[at + 1].at;
const expo1 = ps1.filter((p) => p.walk).reduce((a, p) => a + p.len, 0);   // 공덕역 출구까지 지상

// 갈림길에서 다른 갈래(길동 방면) 앞부분 약 700m: 첫 간선부터 같은 노선 선로를 따라간다
function branchStub(jn, maxM) {
  const alt = jn.alternatives[0];
  let e = alt.edge, v = E.a[e] === jn.node ? E.b[e] : E.a[e], u = jn.node, m = 0;
  const pts = [];
  while (e >= 0 && m < maxM) {
    const shape = GR.edgeShape(g, e, u);
    shape.forEach((q, i) => { if (i > 0 || !pts.length) pts.push(q); });
    m += E.len[e];
    let next = -1;   // 다음 간선: 같은 노선 묶음의 선로 간선 하나뿐일 때만
    const cand = [];
    for (let k = G.adjStart[v]; k < G.adjStart[v + 1]; k++) {
      const f = G.adjEdge[k];
      if (f !== e && T.kinds[E.k[f]] === 'track' && E.svc[f] === 0) cand.push([f, G.adjNode[k]]);
    }
    if (cand.length === 1) { next = cand[0][0]; u = v; v = cand[0][1]; }
    e = next;
  }
  const jm = jn.at_m, d = depthAt(A3.an, jm);
  const out = [];
  let acc = 0;
  pts.forEach((q, i) => {
    if (i > 0) acc += GR.haversine(pts[i - 1][0], pts[i - 1][1], q[0], q[1]);
    if (acc <= maxM) out.push([r5(q[0]), r5(q[1]), r1(acc), r1(d), 0]);
  });
  return out;
}

// 바탕 선로: 경로 둘레 상자 안의 본선 선로(옅게). 30m 오차로 점을 줄인다
const allPts = [...ps1, ...ps2, ...ps3].flatMap((p) => p.pts);
const box = allPts.reduce((bb, p) => [Math.min(bb[0], p[0]), Math.min(bb[1], p[1]), Math.max(bb[2], p[0]), Math.max(bb[3], p[1])], [90, 180, -90, -180]);
const PAD = 0.03;   // 약 3km
const inBox = (p) => p[0] > box[0] - PAD && p[0] < box[2] + PAD && p[1] > box[1] - PAD * 1.25 && p[1] < box[3] + PAD * 1.25;
function simplify(pts, tol) {   // 더글러스-포이커
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let best = -1, bi = -1;
    for (let k = i + 1; k < j; k++) { const d = distToLine(pts[k], [pts[i], pts[j]]); if (d > best) { best = d; bi = k; } }
    if (best > tol) { keep[bi] = 1; stack.push([i, bi], [bi, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}
const net = [];
for (let e = 0; e < E.a.length; e++) {
  if (T.kinds[E.k[e]] !== 'track' || E.svc[e] !== 0) continue;
  const pts = GR.edgeShape(g, e);
  if (!pts.some(inBox)) continue;
  net.push(simplify(pts, 30).map((p) => [r5(p[0]), r5(p[1])]));
}
const river = simplify(han.filter(inBox), 15).map((p) => [r5(p[0]), r5(p[1])]);

/* ---------- 5. 내보내기 ---------- */
const name = (i) => S[i].name;
const stOut = (A, leg, m0, m1, flip) => A.st.filter((s) => s.m >= m0 - 1 && s.m <= m1 + 1).map((s) => ({ leg, n: name(s.si), l: s.line, m: r1(flip ? m1 - s.m : s.m - m0), d: s.d, f: s.floor }));
const rides3 = p3.items.filter((i) => i.kind === 'step' && (i.step.type === 'ride' || i.step.type === 'transfer')).map((i) => {
  const idx = i.step._idx, a = ps3.find((p) => p.idx === idx[0]), z = ps3.find((p) => p.idx === idx[idx.length - 1]);
  return { t: i.step.type, label: i.step.label || '', a: i.step.from_station || '', b: i.step.to_station || '', m0: r1(a.from), m1: r1(z.from + z.len) };
});
const crossM = (ps, c) => { const p = ps.find((x) => x.e === c.e); return [r1(p.from), r1(p.from + p.len)]; };

const out = {
  format: 'jiharo-3d-1',
  built: new Date().toISOString().slice(0, 10),
  attribution: ['© OpenStreetMap contributors (ODbL)', '역 깊이: 서울교통공사 역사심도정보(2024-11-04, 서울 열린데이터광장, 공공누리 제1유형)'],
  river: { line: river, half_w: HALF_W, fade: FADE },
  legs: {
    enter: { pts: legOf(ps1, A1.an, 0, total1), expo_m: r1(expo1) },
    ride1: { pts: legOf(ps2, A2.an, 0, blockAt) },
    blocked: { pts: legOf(ps2, A2.an, blockAt, yeouiAt) },
    ride2: { pts: legOf(ps3, A3.an, 0, total3) },
    alt: { pts: branchStub(jn, 700) }
  },
  net,
  stations: [...stOut(A1, 'enter', 0, total1), ...stOut(A2, 'ride1', 0, blockAt), ...stOut(A2, 'blocked', blockAt, yeouiAt), ...stOut(A3, 'ride2', 0, total3)],
  facts: {
    start: name(o1.si), exit_ref: o1.ref, expo_m: Math.round(expo1),
    crossA: { a: crossA.a, b: crossA.b, line: crossA.line, m: crossM(ps2, crossA) },
    mapo_m: r1(mapoAt), block_m: r1(blockAt), backtrack_m: Math.round(b.backtrack), walked_m: Math.round(walked),
    crossB: { a: crossB.a, b: crossB.b, line: crossB.line, m: crossM(ps3, crossB) },
    junction: { m: r1(jn.at_m), lat: jn.lat, lon: jn.lon, prev: jn.prev && jn.prev.name, fromPrev_m: Math.round(jn.fromPrev_m || 0),
      side: jn.chosen.side, name: jn.chosen.name, toward: jn.chosen.toward,
      alt: jn.alternatives.map((a) => ({ side: a.side, name: a.name, toward: a.toward })) },
    end: name(meetSi), total2_m: Math.round(total3), exposed_after_m: Math.round(p2.view.exposed_m + p3.view.exposed_m),
    both_blocked_expo_m: pNone ? Math.round(pNone.exposed_m) : null,
    rides: rides3
  }
};
// 갈림길 거리: junction at_m 은 경로 시작(마포 승강장)부터 잰 값이라 ride2 거리와 같다
const file = path.join(ROOT, 'web/3d/ride.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out));
const L = out.legs;
console.log(`ride.json ${fs.statSync(file).size} byte · 점 enter ${L.enter.pts.length} ride1 ${L.ride1.pts.length} blocked ${L.blocked.pts.length} ride2 ${L.ride2.pts.length} alt ${L.alt.pts.length} · 바탕 선로 ${net.length}개`);
console.log(`역 ${out.stations.length}개: ` + out.stations.map((s) => `${s.n}(${s.l} ${s.d == null ? '추정' : s.d + 'm'})`).join(' '));
console.log('facts', JSON.stringify(out.facts).slice(0, 900));
console.log('강 반폭', HALF_W, 'm · 강가 역 거리', bankSt.map((s) => s.name + ' ' + Math.round(distToLine([s.lat / 1e5, s.lon / 1e5], han)) + 'm').join(', '));
