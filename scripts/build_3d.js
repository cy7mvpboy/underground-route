// build_3d.js — 3D 지하 이동 화면(web/3d/)이 쓰는 자료 web/3d/ride.json 을 만든다.
// 사용법(프로젝트 폴더에서): node scripts\build_3d.js
//   시연 1번 이야기(web/js/demo.js CONF.story, scripts/check_demo.js 와 같은 순서)를 앱 코드로 다시 계산한다:
//   공덕역 2번 출구로 들어감 → 5호선 마포–여의나루 하저터널에서 막힘 → 마포역으로 되돌아감
//   → 다른 하저터널(광나루–천호)로 다시 찾은 길 → 가족 약속 장소(수서) 도착. 끝으로 수서 → 동탄(남쪽으로 이어지는 지하)도 계산한다.
// 내보내는 것
//   - exag: 세로 과장 배율. 계단 수평 길이를 이 배율로 정해서 화면도 이 값을 그대로 쓴다
//   - legs: 이동 구간별 선. 점 = [위도, 경도, 구간 m(앱 거리), 그릴 깊이 m, 한강 아래 정도 0~1, 한강 단면 정도 0~1]
//   - stations: 역 이름표(노선별 승강장 깊이. 자료가 없으면 null)
//   - structs: 역 구조(개략). 승강장 상자(깊이 = 자료 값), 대합실 판(깊이 추정)
//   - river, net, facts
// 그릴 깊이(뚝 끊기거나 꺾이지 않게)
//   - 승강장: 역 앞뒤 80m 를 그 역 승강장 깊이(서울교통공사 역사심도정보: 1~8호선, 9호선 2·3단계)로 평평하게 둔다.
//   - 역 사이 터널: 앞 승강장 끝 → 다음 승강장 시작을 smoothstep(3t² - 2t³)으로 잇는다(추정). 양 끝 기울기가 0 이라 꺾이지 않는다.
//   - 환승: 승강장 A → 계단 → 대합실(깊이 추정) → 계단 → 승강장 B 를 개략 모양으로 새로 그린다. 공덕 입구도 같은 방법.
//     계단 수평 길이 = 높이 차 × 배율 × 1.5 / tan60° (smoothstep 의 가장 가파른 곳이 화면에서 60°를 넘지 않게).
//   - 앱 거리(m)는 그대로 둔다: 개략 모양 위의 점에는 그 구간의 앱 거리를 수평 길이 비율로 나눠 준다.
//   - 강바닥 깊이 자료는 없어서 한강 아래 정도(riv)만 내보내고 화면이 그림으로만 더 내린다(숫자를 만들지 않는다).
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
for (const f of ['graph', 'junctions', 'router', 'exithere', 'steps', 'transfer', 'nearest', 'guide', 'reach', 'saved', 'demo']) require(path.join(ROOT, 'web/js', f + '.js'));
const UG = globalThis.UG, GR = UG.graph;
// 시연 설정: demo.js 의 CONF 를 쓴다(없으면 같은 값). 한강 횡단 찾기(hanCrossing)도 demo.js 것을 쓴다
const CONF = (UG.demo && UG.demo.CONF) || { speedKmh: 3.5, story: { lat: 37.5447, lon: 126.9497, label: '공덕오거리 부근', meet: '수서@서울', blockAfter: '마포@서울', blockFrac: 0.45 } };
const Y = CONF.story;
const SOUTH = '동탄';   // 끝 장면: 수서에서 남쪽으로 이어지는 지하
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
const stEp = (i) => ({ kind: 'station', si: i, text: S[i].name, lat: S[i].lat / 1e5, lon: S[i].lon / 1e5 });
const meetSi = si(Y.meet);
const near = UG.nearest.nearestUnderground(G, Y.lat, Y.lon, { limit: 3 });
const o1 = near.options[0];                                        // 가장 가까운 지하로(공덕역 2번 출구)
const ep = UG.nearest.endpointsFor(G, Y.lat, Y.lon, o1, Y.label);
const p1 = planOf(ep.from, ep.to);                                 // 거리 → 출구 → 승강장
const from2 = { kind: 'station', si: o1.si, hubs: UG.reach.underHubs(G, o1.si), text: S[o1.si].name + '역 지하 승강장', lat: S[o1.si].lat / 1e5, lon: S[o1.si].lon / 1e5 };
const p2 = planOf(from2, stEp(meetSi));
const cps2 = UG.guide.buildCheckpoints(G, p2);
const at = cps2.findIndex((c) => c.si === si(Y.blockAfter));       // 마포역 체크포인트
const walked = (cps2[at + 1].at - cps2[at].at) * Y.blockFrac;      // 마포에서 터널로 걸어 들어간 거리
const crossA = UG.demo.hanCrossing(G, p2.route.path);
const b = UG.guide.planBlock(G, { plan: p2, cps: cps2, cur: at }, walked);
b.edges.forEach((e) => blocked.add(e));
const p3 = planOf(b.from, p2.to);                                  // 마포에서 다시 찾은 길
const crossB = UG.demo.hanCrossing(G, p3.route.path);
// '두 곳뿐' 확인: 5호선 하저터널 두 곳을 다 막으면 가장 나은 길도 지상을 걷는다
const both = new Set(blocked);
g.presets.han_crossings.filter((x) => x.s === 'tunnel' && (x.lines || []).includes('5호선')).forEach((x) => both.add(x.e));
const pNone = UG.router.findRoute(G, b.from, p2.to, { blocked: both }) || UG.router.findRoute(G, b.from, p2.to, { blocked: both, surface: true });
blocked.clear();
const p4 = planOf(stEp(meetSi), stEp(si(SOUTH)));                  // 수서 → 동탄(막은 곳 없이)

/* ---------- 2. 조각: 안내(guide.routeTrack)와 같은 순서·거리 ----------
   조각 = { pts, len, from, e(간선, 걷기 = -1), k(간선 종류), u, v }. 거리는 앱의 간선 길이(len)를 쓴다 */
function pieces(plan) {
  const path = plan.route.path, out = [];
  plan.items.forEach((it) => {
    if (['walk', 'enter', 'exit', 'approach', 'egress'].includes(it.kind)) { if (it.latlngs && it.m > 0) out.push({ pts: it.latlngs, len: it.m, e: -1, walk: true }); return; }
    if (it.kind !== 'step' || it.step.type === 'warning') return;
    it.step._idx.forEach((i) => {
      const x = path[i];
      if (it.step.type === 'surface' && it.step._pts) out.push({ pts: it.step._pts, len: it.step._m, e: -1, walk: true });
      else out.push({ pts: GR.edgeShape(g, x.e, x.u), len: E.len[x.e], e: x.e, k: T.kinds[E.k[x.e]], u: x.u, v: x.v });
    });
  });
  let m = 0;
  out.forEach((p) => { p.from = m; m += p.len; });
  const want = UG.guide.routeTrack(G, plan).total;
  if (Math.abs(m - want) > 0.5) throw new Error(`거리 불일치 ${m} != ${want}`);
  return out;
}

/* ---------- 3. 역 깊이 자료 찾기 ---------- */
const nodeSt = new Map();   // 노드 → 역(승강장 허브·선로 위 부착점)
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
  return S[x.si].depth.find((r) => set.includes(r.line)) || null;
}

/* ---------- 4. 평면 좌표(m)와 한강 ---------- */
const LAT0 = 37.53, LON0 = 127.0, KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110540;   // 이 범위에서 오차 1% 미만
const toXY = (p) => [(p[1] - LON0) * KX, (p[0] - LAT0) * KY];   // 동쪽 x, 북쪽 y
const toLL = (q) => [q[1] / KY + LAT0, q[0] / KX + LON0];
const nodeXY = (v) => toXY([g.nodes.lat[v] / 1e5, g.nodes.lon[v] / 1e5]);
const add = (a, c) => [a[0] + c[0], a[1] + c[1]], sub = (a, c) => [a[0] - c[0], a[1] - c[1]], mul = (a, k) => [a[0] * k, a[1] * k];
const len = (a) => Math.hypot(a[0], a[1]), unit = (a) => mul(a, 1 / (len(a) || 1)), dot = (a, c) => a[0] * c[0] + a[1] * c[1];

const han = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/raw/han_river.json'), 'utf8')).elements[0].geometry.map((p) => toXY([p.lat, p.lon]));
function distToLine(q, line) {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], d = sub(line[i], a), L = dot(d, d);
    const t = L > 0 ? Math.max(0, Math.min(1, dot(sub(q, a), d) / L)) : 0;
    best = Math.min(best, len(sub(q, add(a, mul(d, t)))));
  }
  return best;
}
// 그림용 반폭: 하저터널 양 끝 역 중 강에 가장 가까운 역보다 안쪽(역이 강 띠에 덮이지 않게). 실제 수면 폭이 아니다
const bankSt = [crossA.a, crossA.b, crossB.a, crossB.b].map((n) => S[si(n + '@서울')]);
const HALF_W = Math.round(Math.min(450, ...bankSt.map((s) => distToLine(toXY([s.lat / 1e5, s.lon / 1e5]), han) - 60)));
const FADE = 300, CUT_FADE = 900;   // 한강 아래 정도가 0 이 되는 거리 · 단면(흙·물)을 그리는 거리(띠 밖으로)
const fall = (d, w) => (d <= HALF_W ? 1 : d >= HALF_W + w ? 0 : 0.5 * (1 + Math.cos(Math.PI * (d - HALF_W) / w)));   // 코사인: 양 끝 기울기 0

/* ---------- 5. 그리는 길: 선 모양 + 앱 거리 + 그릴 깊이 ---------- */
const EXAG = 10, PLAT = 160, STEP = 25, STEP_ST = 4, MAX_SLOPE = Math.tan(Math.PI / 3);
const rampRun = (dd) => Math.max(100, 1.5 * Math.abs(dd) * EXAG / MAX_SLOPE);   // 계단 수평 길이(m)
const ss = (t) => t * t * (3 - 2 * t);

// 꺾인 점을 반지름 r 만큼 2차 베지어로 둥글게(계단·대합실 모서리)
function round(poly, r) {
  const out = [poly[0]];
  for (let i = 1; i < poly.length - 1; i++) {
    const a = poly[i - 1], p = poly[i], c = poly[i + 1];
    const k = Math.min(r, len(sub(p, a)) / 2, len(sub(c, p)) / 2);
    const p0 = add(p, mul(unit(sub(a, p)), k)), p2 = add(p, mul(unit(sub(c, p)), k));
    for (let j = 0; j <= 6; j++) { const t = j / 6; out.push(add(add(mul(p0, (1 - t) * (1 - t)), mul(p, 2 * t * (1 - t))), mul(p2, t * t))); }
  }
  out.push(poly[poly.length - 1]);
  return out;
}
// 선 끝 쪽 진행 방향(30m 이상 떨어진 점 기준). back = 끝에서 들어오는 방향, 아니면 처음에서 나가는 방향
function dirOf(poly, back) {
  const q = back ? poly.slice().reverse() : poly, a = q[0];
  const c = q.find((p) => len(sub(p, a)) >= 30) || q[q.length - 1];
  return unit(back ? sub(a, c) : sub(c, a));
}
const xyOf = (pts) => pts.map(toXY);

function drawPath(ps, opt = {}) {
  const pts = [], stops = new Map(), ctl = [], structs = [];
  const push = (q, m) => { const l = pts[pts.length - 1]; if (l && len(sub(l, q)) < 0.5) l.m = m; else pts.push(Object.assign(q.slice(), { m })); };
  // poly 를 step(기본 25m, 역 안 계단·대합실은 4m)마다 나눠 넣는다. m 은 수평 길이 비율로 m0 → m1
  function line(poly, m0, m1, step = STEP) {
    const cum = [0];
    for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + len(sub(poly[i], poly[i - 1])));
    const L = cum[cum.length - 1] || 1;
    push(poly[0], m0);
    for (let i = 1; i < poly.length; i++) {
      const n = Math.max(1, Math.ceil((cum[i] - cum[i - 1]) / step));
      for (let j = 1; j <= n; j++) {
        const t = j / n, q = add(poly[i - 1], mul(sub(poly[i], poly[i - 1]), t));
        push(q, m0 + (m1 - m0) * (cum[i - 1] + (cum[i] - cum[i - 1]) * t) / L);
      }
    }
  }
  // 선로 위 역(부착점): 승강장 하나. lo·hi = 평평한 승강장 구간(역 m 기준)
  function stopAt(v, e, m, dir) {
    const x = nodeSt.get(v);
    if (!x || x.ls >= 0 || stops.has(v) || [...stops.values()].some((s) => s.si === x.si && Math.abs(s.m - m) < 300)) return;   // 같은 역은 한 번
    const r = depthRec(v, e), set = lineSetOf(v, e);
    stops.set(v, { si: x.si, m, dir, q: nodeXY(v), line: r ? T.line_short[r.line] : T.line_short[set[0]] || '', d: r ? r.platform_m : null, f: r ? r.floor : null, lo: -PLAT / 2, hi: PLAT / 2 });
  }
  // 대합실 판: 점들을 덮는 사각형(축 방향, 여유 20m, 폭 40m 이상)
  function concourse(points, axis, d, n, m) {
    const u = unit(axis), w = [-u[1], u[0]];
    const A = points.map((p) => dot(p, u)), B = points.map((p) => dot(p, w));
    const a0 = Math.min(...A), a1 = Math.max(...A), b0 = Math.min(...B), b1 = Math.max(...B);
    const c = add(mul(u, (a0 + a1) / 2), mul(w, (b0 + b1) / 2));
    structs.push({ k: 'concourse', n, c, a: Math.atan2(u[1], u[0]), L: a1 - a0 + 40, W: Math.max(40, b1 - b0 + 40), d, est: true, m });
  }
  // 환승: 승강장 A(sa) → 계단 → 대합실 → 계단 → 승강장 B(sb). 계단은 각 승강장의 선로 방향으로 놓는다
  function transfer(run, mS, mE, next) {
    const A = run[0].u, Bn = run[run.length - 1].v, sa = nodeXY(A), sb = nodeXY(Bn);
    const dirA = dirOf(pts, true), dirB = next ? dirOf(xyOf(next.pts), false) : dirA;
    const ra = depthRec(A, run[0].e), rb = depthRec(Bn, run[run.length - 1].e);
    const stA = stops.get(A);
    if (stA) stA.hi = 0;                                     // 승강장 A 는 도착 전 반쪽만 평평(그 뒤는 계단)
    const setB = lineSetOf(Bn, run[run.length - 1].e);
    stops.set(Bn, { si: nodeSt.get(Bn).si, m: mE, dir: dirB, q: sb, line: rb ? T.line_short[rb.line] : T.line_short[setB[0]] || '', d: rb ? rb.platform_m : null, f: rb ? rb.floor : null, lo: 0, hi: PLAT / 2 });
    if (!ra && !rb) { line([sa, sb], mS, mE); return; }
    const da = (ra || rb).platform_m, db = (rb || ra).platform_m;
    const c = Math.min(8, Math.max(5, Math.min(da, db) - 6));          // 대합실 깊이(추정): 얕은 승강장보다 6m 위, 5~8m
    const rA = rampRun(da - c), rB = rampRun(db - c);
    const qa = add(sa, mul(dirA, rA)), qb = sub(sb, mul(dirB, rB)), mid = len(sub(qb, qa));
    const L = rA + mid + rB, mA = mS + (mE - mS) * rA / L, mB = mS + (mE - mS) * (rA + mid) / L;
    line(round([sa, qa, qb, sb], 40), mS, mE, STEP_ST);
    ctl.push({ m0: mS, m1: mA, d0: da, d1: c }, { m0: mA, m1: mB, d0: c, d1: c }, { m0: mB, m1: mE, d0: c, d1: db });
    concourse([sa, sb, qa, qb], mid > 30 ? sub(qb, qa) : dirA, c, S[nodeSt.get(A).si].name, mS);
  }
  // 입구: 출구(지상) → 계단 → 대합실(깊이 추정 6m) → 계단 → 승강장(opt.entryTo)
  function entry(mS, mE) {
    const pe = pts[pts.length - 1].slice(0, 2), { q: s, dir, d } = opt.entryTo, c = 6;
    const r2 = rampRun(d - c), q2 = sub(s, mul(dir, r2)), toQ2 = sub(q2, pe);
    const r1 = Math.min(rampRun(c), len(toQ2) * 0.6), q1 = add(pe, mul(unit(toQ2), r1)), mid = len(sub(q2, q1));
    const L = r1 + mid + r2, m1 = mS + (mE - mS) * r1 / L, m2 = mS + (mE - mS) * (r1 + mid) / L;
    line(round([pe, q1, q2, s], 30), mS, mE, STEP_ST);
    ctl.push({ m0: mS, m1: m1, d0: 0, d1: c }, { m0: m1, m1: m2, d0: c, d1: c }, { m0: m2, m1: mE, d0: c, d1: d });
    concourse([q1, q2, s], sub(q2, q1), c, opt.entryName, mS);
  }

  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (p.walk) { line(xyOf(p.pts), p.from, p.from + p.len); ctl.push({ m0: p.from, m1: p.from + p.len, d0: 0, d1: 0 }); continue; }
    if (p.k === 'track') {
      const poly = xyOf(p.pts);
      stopAt(p.u, p.e, p.from, dirOf(poly, false));
      line(poly, p.from, p.from + p.len);
      stopAt(p.v, p.e, p.from + p.len, dirOf(poly, true));
      continue;
    }
    // 선로가 아닌 조각 묶음(승강장·환승·출입구 간선)
    let j = i;
    while (j + 1 < ps.length && !ps[j + 1].walk && ps[j + 1].k !== 'track') j++;
    const run = ps.slice(i, j + 1), mS = p.from, mE = ps[j].from + ps[j].len, next = ps[j + 1];
    if (run.some((q) => q.k === 'transfer')) transfer(run, mS, mE, next);
    else if (run.some((q) => q.k === 'entrance')) entry(mS, mE);
    else push(nodeXY(i === 0 ? run[run.length - 1].v : run[0].u), mE);   // 승강장에 들렀다 나옴(경로 처음·끝 포함): 선로 위 점에 머문다
    i = j;
  }

  // 깊이 조절: 승강장 구간을 더하고 m 순서로. 겹치면 뒤엣것의 앞을 자른다
  for (const s of stops.values()) if (s.d != null) ctl.push({ m0: s.m + s.lo, m1: s.m + s.hi, d0: s.d, d1: s.d });
  ctl.sort((a, c) => a.m0 - c.m0);
  const C = [];
  for (const c of ctl) {
    const l = C[C.length - 1];
    if (l && c.m0 < l.m1) { if (c.m1 <= l.m1) continue; c.m0 = l.m1; }
    C.push(c);
  }
  // m 의 그릴 깊이: 조절 구간 안이면 그 값(계단은 smoothstep), 구간 사이는 앞 끝 → 다음 시작을 smoothstep
  function depthAt(m) {
    if (!C.length) return opt.nominal || 0;
    if (m <= C[0].m0) return C[0].d0;
    for (let i = 0; i < C.length; i++) {
      const c = C[i], n = C[i + 1];
      if (m <= c.m1) return c.m1 > c.m0 ? c.d0 + (c.d1 - c.d0) * ss((m - c.m0) / (c.m1 - c.m0)) : c.d1;
      if (n && m < n.m0) return c.d1 + (n.d0 - c.d1) * ss((m - c.m1) / (n.m0 - c.m1));
    }
    return C[C.length - 1].d1;
  }
  pts.forEach((p) => { p.d = depthAt(p.m); });
  for (const s of stops.values()) structs.push({ k: 'platform', n: S[s.si].name, l: s.line, c: s.q, a: Math.atan2(s.dir[1], s.dir[0]), L: PLAT, W: 34, d: s.d != null ? s.d : depthAt(s.m), est: s.d == null, m: s.m });
  return { pts, stops: [...stops.values()], structs, depthAt };
}

// 그린 길에서 m0 ~ m1 만 잘라 내보낸다(양 끝은 사이 값)
const r1 = (x) => Math.round(x * 10) / 10, r2 = (x) => Math.round(x * 100) / 100, r5 = (x) => Math.round(x * 1e5) / 1e5;
function legOf(dp, m0, m1) {
  const P = dp.pts, at = (m) => {
    let i = P.findIndex((p) => p.m >= m);
    if (i <= 0) i = Math.max(1, i < 0 ? P.length - 1 : 1);
    const a = P[i - 1], c = P[i], t = c.m > a.m ? Math.max(0, Math.min(1, (m - a.m) / (c.m - a.m))) : 1;
    return Object.assign(add(a, mul(sub(c, a), t)), { m, d: dp.depthAt(m) });
  };
  const sel = [at(m0), ...P.filter((p) => p.m > m0 + 0.5 && p.m < m1 - 0.5), at(m1)];
  return sel.map((p) => {
    const dr = distToLine(p, han), ll = toLL(p);
    return [r5(ll[0]), r5(ll[1]), r1(p.m - m0), r2(p.d), r2(fall(dr, FADE)), r2(fall(dr, CUT_FADE))];
  });
}

const ps1 = pieces(p1), ps2 = pieces(p2), ps3 = pieces(p3), ps4 = pieces(p4);
const total1 = ps1.reduce((a, p) => a + p.len, 0), total2 = ps2.reduce((a, p) => a + p.len, 0), total3 = ps3.reduce((a, p) => a + p.len, 0);
const mapoAt = cps2[at].at, blockAt = mapoAt + walked, yeouiAt = cps2[at + 1].at;
const expo1 = ps1.filter((p) => p.walk).reduce((a, p) => a + p.len, 0);   // 공덕역 출구까지 지상
const D2 = drawPath(ps2), D3 = drawPath(ps3);
const s0 = D2.stops[0];   // 공덕 5호선 승강장(처음 길의 첫 역)
const D1 = drawPath(ps1, { entryTo: { q: s0.q, dir: s0.dir, d: s0.d }, entryName: S[o1.si].name });
const D4 = drawPath(ps4, { nominal: D3.depthAt(total3) });   // 수서 → 동탄: 깊이 자료 없음 → 수서 승강장 깊이 그대로(추정)

// 바탕 선로: 경로 둘레 상자 안의 본선 선로(옅게). 30m 오차로 점을 줄인다
const allPts = [...ps1, ...ps2, ...ps3].flatMap((p) => p.pts);
const box = allPts.reduce((bb, p) => [Math.min(bb[0], p[0]), Math.min(bb[1], p[1]), Math.max(bb[2], p[0]), Math.max(bb[3], p[1])], [90, 180, -90, -180]);
const PAD = 0.03;   // 약 3km
const inBox = (p) => p[0] > box[0] - PAD && p[0] < box[2] + PAD && p[1] > box[1] - PAD * 1.25 && p[1] < box[3] + PAD * 1.25;
function simplify(pts, tol) {   // 더글러스-포이커(평면 m)
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
const llOut = (q) => { const ll = toLL(q); return [r5(ll[0]), r5(ll[1])]; };
const net = [];
for (let e = 0; e < E.a.length; e++) {
  if (T.kinds[E.k[e]] !== 'track' || E.svc[e] !== 0) continue;
  const pts = GR.edgeShape(g, e);
  if (!pts.some(inBox)) continue;
  net.push(simplify(xyOf(pts), 30).map(llOut));
}
const river = simplify(han.filter((q) => inBox(toLL(q))), 15).map(llOut);

/* ---------- 6. 내보내기 ---------- */
const name = (i) => S[i].name;
// 역 이름표: 구간(leg)과 그 구간 안 거리
const legAt = (m) => (m <= blockAt ? ['ride1', m] : ['blocked', m - blockAt]);
const stOut = (stops, legFn) => stops.map((s) => { const [leg, m] = legFn(s.m); return { leg, n: name(s.si), l: s.line, m: r1(m), d: s.d, f: s.f }; });
const stations = [...stOut(D1.stops, (m) => ['enter', m]), ...stOut(D2.stops.filter((s) => s.m <= yeouiAt + 1), legAt), ...stOut(D3.stops, (m) => ['ride2', m])];
// 역 구조: 공덕 입구 · 처음 길(여의나루까지) · 다시 찾은 길. 같은 역·노선은 한 번만
const seen = new Set(), structs = [];
[[D1.structs, 'enter', () => true], [D2.structs, 'ride1', (x) => x.m <= yeouiAt + 1], [D3.structs, 'ride2', () => true]].forEach(([list, leg, ok]) => list.forEach((x) => {
  const key = x.k + '|' + x.n + '|' + (x.l || '');
  if (!ok(x) || seen.has(key)) return;
  seen.add(key);
  structs.push({ leg, k: x.k, n: x.n, l: x.l || '', c: llOut(x.c), a: r2(x.a), L: Math.round(x.L), W: Math.round(x.W), d: r2(x.d), est: x.est });
}));
const rides = (p, ps) => p.items.filter((i) => i.kind === 'step' && (i.step.type === 'ride' || i.step.type === 'transfer')).map((i) => {
  const idx = i.step._idx, a = ps.find((q) => q.e === p.route.path[idx[0]].e), z = ps.find((q) => q.e === p.route.path[idx[idx.length - 1]].e);
  return { t: i.step.type, label: i.step.label || '', a: i.step.from_station || '', b: i.step.to_station || '', m0: r1(a.from), m1: r1(z.from + z.len), km: r1((i.step.distance_m || 0) / 1000) };
});
const crossM = (ps, c) => { const p = ps.find((x) => x.e === c.e); return [r1(p.from), r1(p.from + p.len)]; };
const southPts = simplify(D4.pts, 20).map((p) => [...llOut(p), r1(p.m), r2(p.d), 0, 0]);

const out = {
  format: 'jiharo-3d-2',
  built: new Date().toISOString().slice(0, 10),
  exag: EXAG,
  attribution: ['© OpenStreetMap contributors (ODbL)', '역 깊이: 서울교통공사 역사심도정보(1~8호선 2024-11-04, 9호선 2·3단계 2026-01-31), 서울 열린데이터광장, 공공누리 제1유형'],
  river: { line: river, half_w: HALF_W },
  legs: {
    enter: { pts: legOf(D1, 0, total1), expo_m: r1(expo1) },
    ride1: { pts: legOf(D2, 0, blockAt) },
    blocked: { pts: legOf(D2, blockAt, yeouiAt) },
    rest: { pts: legOf(D2, yeouiAt, total2) },   // 처음 길의 나머지(여의나루 → 도착): 점선으로만
    ride2: { pts: legOf(D3, 0, total3) },
    south: { pts: southPts }                      // 수서 → 동탄: 끝 전체 보기에서 옅게
  },
  net,
  stations,
  structs,
  facts: {
    start: name(o1.si), exit_ref: o1.ref, expo_m: Math.round(expo1), story_label: Y.label,
    crossA: { a: crossA.a, b: crossA.b, line: crossA.line, m: crossM(ps2, crossA) },
    mapo_m: r1(mapoAt), block_m: r1(blockAt), backtrack_m: Math.round(b.backtrack), walked_m: Math.round(walked),
    crossB: { a: crossB.a, b: crossB.b, line: crossB.line, m: crossM(ps3, crossB) },
    // 거리: 처음 길 전체 · 마포에서 남았던 거리 · 다시 찾은 길(앱 view 값 = 안내 화면과 같은 값)
    first_m: Math.round(p2.view.total_m), left_m: Math.round(total2 - mapoAt), total2_m: Math.round(p3.view.total_m),
    first_expo_m: Math.round(p2.view.exposed_m), second_expo_m: Math.round(p3.view.exposed_m),
    end: name(meetSi), exposed_after_m: Math.round(p2.view.exposed_m + p3.view.exposed_m),
    both_blocked_expo_m: pNone ? Math.round(pNone.exposed_m) : null,
    rides: rides(p3, ps3),
    south: { to: name(si(SOUTH)), total_m: Math.round(p4.view.total_m), expo_m: Math.round(p4.view.exposed_m), rides: rides(p4, ps4).filter((r) => r.t === 'ride').map((r) => ({ label: r.label, km: r.km })) }
  }
};
const file = path.join(ROOT, 'web/3d/ride.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out));
const L = out.legs;
console.log(`ride.json ${fs.statSync(file).size} byte · 점 ` + Object.keys(L).map((k) => `${k} ${L[k].pts.length}`).join(' ') + ` · 바탕 선로 ${net.length}개 · 역 구조 ${structs.length}개`);
console.log(`역 ${stations.length}개: ` + stations.map((s) => `${s.n}(${s.l} ${s.d == null ? '추정' : s.d + 'm'})`).join(' '));
console.log('대합실(추정): ' + structs.filter((x) => x.k === 'concourse').map((x) => `${x.n} ${x.d}m ${x.L}×${x.W}`).join(', '));
console.log('남쪽:', JSON.stringify(out.facts.south));
console.log('강 반폭', HALF_W, 'm');
