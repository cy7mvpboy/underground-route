// check_walk.js — 지상 도보 구간을 실제 길로 바꾸는 계산(web/js/walk.js)과 길 안내 위치 추정(guide.js routeTrack)을 시험한다.
// 인터넷에 묻지 않는다: fetch 를 가짜(mock)로 바꿔 OSRM 응답을 흉내 낸다.
// 사용법(프로젝트 폴더에서): node scripts\check_walk.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
for (const f of ['graph', 'router', 'steps', 'nearest', 'guide', 'walk']) require(path.join(ROOT, 'web/js', f + '.js'));
const UG = globalThis.UG;
const W = UG.walk, GR = UG.graph;
const g = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/data/graph.json'), 'utf8'));
const G = GR.indexGraph(g);
let ok = true;
const check = (cond, msg) => { console.log((cond ? 'OK  ' : 'NG  ') + msg); ok = ok && cond; };
const near = (a, b, tol) => Math.abs(a - b) <= (tol || 1);

/* ---------- 가짜 OSRM: 두 점 사이를 옆으로 꺾어 가는 길(직선보다 길다) ---------- */
let calls = 0, mode = 'ok';
function fakeRoute(a, b, bend) {
  // 가운데에서 직각 방향으로 bend(도) 만큼 비켜 간다. 끝점은 길 위로 붙은 것처럼 약간 어긋나게.
  const mid = [(a[0] + b[0]) / 2 + bend, (a[1] + b[1]) / 2 - bend];
  const pts = [[a[0] + 0.00005, a[1]], mid, [b[0], b[1] + 0.00005]];
  const cum = GR.cumulative(pts);
  return { code: 'Ok', routes: [{ distance: cum[cum.length - 1], duration: 1, geometry: W.encode(pts) }] };
}
const bendFor = {};   // 열쇠별로 꺾는 정도를 바꿔 순위가 바뀌는 상황을 만든다
const times = [];     // 요청을 보낸 시각(간격 시험용)
W.config({ gapMs: 0 });   // 요청 간격은 8)에서만 시험한다
W.setFetch(function (url, init) {
  calls++;
  times.push(Date.now());
  if (mode === 'fail') return Promise.reject(new TypeError('Failed to fetch'));
  if (mode === 'hang') {
    return new Promise((res, rej) => { if (init && init.signal) init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
  }
  const m = /foot\/([-\d.]+),([-\d.]+);([-\d.]+),([-\d.]+)\?/.exec(url);
  const a = [+m[2], +m[1]], b = [+m[4], +m[3]];
  const k = W.key(a, b);
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(fakeRoute(a, b, bendFor[k] != null ? bendFor[k] : 0.001)) });
});

function plan(from, to, blocked) {
  const route = UG.router.findRoute(G, from, to, { blocked }) || UG.router.findRoute(G, from, to, { blocked, surface: true });
  return UG.steps.planItems(G, { from, to, route }, 3.5);
}
const pt = (lat, lon, label) => ({ kind: 'point', lat, lon, conn: UG.router.connectPoint(G, lat, lon), label, text: label });
const st = (n) => ({ kind: 'station', si: GR.findStation(G, n), text: n });

(async function main() {
  /* 1) 지점 -> 역: 들어가는 구간 하나를 실제 길로 */
  const p1 = plan(pt(37.5585, 126.9790, '남대문 부근'), st('강남'));
  const legs1 = W.legsOf(G, p1);
  check(legs1.length === 1 && legs1[0].id === 'start', `지점→역: 지상 구간 ${legs1.length}개 (${legs1.map((l) => l.id).join(',')})`);
  const before = { total: p1.view.total_m, exposed: p1.view.exposed_m, enter: p1.items[0].m };
  p1.legs = await W.fetchLegs(G, p1);
  const real = p1.legs.start;
  check(!!real && real.pts.length >= 3 && real.m > GR.haversine(...legs1[0].a, ...legs1[0].b), `실제 길 받음: ${Math.round(real.m)}m (직선 ${Math.round(GR.haversine(...legs1[0].a, ...legs1[0].b))}m, 직선×1.3 ${Math.round(before.enter)}m)`);
  W.applyLegs(G, p1, 3.5);
  const d = real.m - before.enter;
  check(near(p1.view.total_m, before.total + d) && near(p1.view.exposed_m, before.exposed + d) && p1.view.street,
    `요약 바뀜: 총 ${Math.round(before.total)}→${Math.round(p1.view.total_m)}m, 노출 ${Math.round(before.exposed)}→${Math.round(p1.view.exposed_m)}m`);
  check(p1.items[0].latlngs === real.pts && near(p1.items[0].min, real.m / (3500 / 60), 0.01), '들어가는 항목의 선 모양·시간 = 실제 길');
  const cps1 = UG.guide.buildCheckpoints(G, p1);
  const tr1 = UG.guide.routeTrack(G, p1);
  check(near(cps1[cps1.length - 1].at, p1.view.total_m) && near(tr1.total, p1.view.total_m), `체크포인트 끝(${Math.round(cps1[cps1.length - 1].at)}m)·위치 추정 선(${Math.round(tr1.total)}m) = 새 총거리`);
  const p0 = UG.guide.pointAt(tr1, 0), pE = UG.guide.pointAt(tr1, tr1.total);
  check(GR.haversine(p0[0], p0[1], 37.5585, 126.9790) < 1 && GR.haversine(pE[0], pE[1], g.stations[p1.route.endSi].lat / 1e5, g.stations[p1.route.endSi].lon / 1e5) < 600,
    '위치 추정: 0m = 출발 지점, 끝 = 도착역 부근');
  const half = UG.guide.sliceTrack(tr1, cps1[0].at, cps1[1].at);
  check(half.length >= 1 && half[0].length >= 2, `첫 확인 지점 사이 선 조각 ${half.length}개`);

  /* 2) 같은 구간을 다시 물으면 저장한 것을 쓴다 */
  const c0 = calls;
  await W.fetchLegs(G, p1);
  check(calls === c0, `저장한 길 다시 씀(요청 ${calls - c0}번)`);

  /* 3) 속도를 바꿔 목록을 다시 만들어도 같은 값 */
  UG.steps.planItems(G, p1, 4.0);
  W.applyLegs(G, p1, 4.0);
  check(near(p1.view.total_m, before.total + d) && near(p1.view.minutes, p1.view.total_m / (4000 / 60), 0.01), '속도 바꿔 다시 만들어도 실제 거리 유지');

  /* 4) 역 사이 지상 걷기 간선: 대화→백석에서 정발산~마두를 막고 다시 찾기 */
  const blocked = new Set();
  const pa = plan(st('대화'), st('백석'), blocked);
  const cpa = UG.guide.buildCheckpoints(G, pa);
  const b = UG.guide.planBlock(G, { plan: pa, cps: cpa, cur: 1 }, 0);
  b.edges.forEach((e) => blocked.add(e));
  const pb = plan(b.from, pa.to, blocked);
  const sl = W.legsOf(G, pb).filter((l) => l.id[0] === 's');
  const surf = pb.items.find((it) => it.kind === 'step' && it.step.type === 'surface');
  if (!sl.length || !surf) {
    console.log('    (지상 걷기 간선을 쓰지 않는 경로라 4) 건너뜀)');
  } else {
    const oldLen = surf.step.distance_m, warn = pb.items.find((it) => it.kind === 'step' && it.step.type === 'warning' && it.step._idx.indexOf(surf.step._idx[0]) >= 0);
    const oldWarn = warn ? warn.step.exposure_m : null, oldTotal = pb.view.total_m;
    pb.legs = await W.fetchLegs(G, pb);
    W.applyLegs(G, pb, 3.5);
    const l = pb.legs[sl[0].id];
    check(!!l && surf.step.distance_m === Math.round(l.m) && surf.step._pts === l.pts, `지상 걷기 단계 ${oldLen}m → ${surf.step.distance_m}m`);
    check(!warn || near(warn.step.exposure_m, oldWarn + (l.m - g.edges.len[pb.route.path[surf.step._idx[0]].e]), 1), `그 노출 경고도 ${oldWarn}m → ${warn && warn.step.exposure_m}m`);
    const cpb = UG.guide.buildCheckpoints(G, pb), trb = UG.guide.routeTrack(G, pb);
    check(near(cpb[cpb.length - 1].at, pb.view.total_m) && near(trb.total, pb.view.total_m), `총거리 ${Math.round(oldTotal)}→${Math.round(pb.view.total_m)}m, 체크포인트·위치 선과 맞음`);
  }

  /* 5) 가장 가까운 지하로: 직선 순 앞 3곳을 실제 거리로 다시 줄 세움 */
  const here = [37.5663, 126.9779];
  const nr = UG.nearest.nearestUnderground(G, here[0], here[1], { limit: 3 });
  const order0 = nr.options.map((o) => o.name + (o.ref || ''));
  bendFor[W.key(here, [nr.options[0].lat, nr.options[0].lon])] = 0.003;   // 1순위 길이 크게 돌아가게
  const rf = await W.refineNearest(here[0], here[1], nr.options.slice());
  check(rf.street && rf.changed && rf.options[0] !== nr.options[0], `실제 거리로 순위 바뀜: ${order0.join(', ')} → ${rf.options.map((o) => o.name + (o.ref || '') + ' ' + Math.round(o.len) + 'm').join(', ')}`);

  /* 6) 실패: 요청이 막히면 null, 그 뒤에는 한동안 묻지 않는다 */
  W.reset(); mode = 'fail';
  const f1 = await W.leg([37.50, 127.00], [37.51, 127.01]);
  const c1 = calls;
  const f2 = await W.leg([37.52, 127.00], [37.53, 127.01]);
  check(f1 === null && f2 === null && calls === c1 && W.stats().off, '막히면 직선 유지, 2분 동안 다시 묻지 않음');

  /* 7) 시간 초과: 4초(시험은 50ms) 넘으면 null, 그러나 쉬지는 않는다 */
  W.reset(); mode = 'hang'; W.config({ timeoutMs: 50 });
  const t1 = await W.leg([37.50, 127.00], [37.51, 127.01]);
  check(t1 === null && !W.stats().off, '시간 초과면 그 구간만 포기');

  /* 8) 간격: 동시에 물어도 cfg.gapMs 간격으로 보낸다(FOSSGIS 초당 1회 이하, 시험은 60ms) */
  W.reset(); mode = 'ok'; W.config({ timeoutMs: 4000, gapMs: 60 });
  times.length = 0;
  const g3 = await Promise.all([[37.40, 127.00], [37.42, 127.00], [37.44, 127.00]].map((a) => W.leg(a, [a[0] + 0.01, a[1] + 0.01])));
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  check(g3.every((r) => !!r) && times.length === 3 && gaps.every((x) => x >= 50), `동시에 3개 물어도 ${gaps.join(', ')}ms 간격으로 보냄`);

  process.exitCode = ok ? 0 : 1;
  console.log(ok ? '모두 통과' : '실패 있음');
})();
