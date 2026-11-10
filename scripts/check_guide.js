// check_guide.js — '가장 가까운 지하로'와 길 안내 모드(체크포인트·앞이 막힘)의 계산 부분을 시험한다.
// 사용법(프로젝트 폴더에서): node scripts\check_guide.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
for (const f of ['graph', 'router', 'steps', 'nearest', 'guide']) require(path.join(ROOT, 'web/js', f + '.js'));
const UG = globalThis.UG;
const g = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/data/graph.json'), 'utf8'));
const G = UG.graph.indexGraph(g);
let ok = true;
const check = (cond, msg) => { console.log((cond ? 'OK  ' : 'NG  ') + msg); ok = ok && cond; };

/* ---------- 1) 가장 가까운 지하로 ---------- */
const PTS = [
  ['시청 앞', 37.5663, 126.9779],
  ['해운대 해변', 35.1587, 129.1604],
  ['지리산 천왕봉(역 없음)', 35.3370, 127.7307]
];
for (const [name, lat, lon] of PTS) {
  const t0 = performance.now();
  const r = UG.nearest.nearestUnderground(G, lat, lon, { limit: 3 });
  const ms = performance.now() - t0;
  if (!r.options.length) {
    console.log(`${name}: 20km 안 지하역 없음 (가장 가까운 지하역 ${r.nearest_name}, 직선 ${(r.nearest_m / 1000).toFixed(1)}km) ${ms.toFixed(1)}ms`);
    check(r.nearest_m > 20000, `${name}: 후보 없음 + 가장 가까운 거리 알려 줌`);
    continue;
  }
  console.log(`${name}: ` + r.options.map((o) => `${o.name}역 ${o.ref || '(출구 자료 없음)'}${o.ref ? '번' : ''} 지상 ${Math.round(o.len)}m`).join(' / ') + ` (${ms.toFixed(1)}ms)`);
  // 후보마다 실제 경로: 그 출구 -> 그 역 지하 허브, 노출은 걷는 구간뿐
  const o = r.options[0];
  const ep = UG.nearest.endpointsFor(G, lat, lon, o, '시험');
  const route = UG.router.findRoute(G, ep.from, ep.to);
  const hubUg = g.stations[o.si].ug[g.stations[o.si].hubs.indexOf(o.hub)] === 1;
  check(route && Math.abs(route.exposed_m - o.len) < 1 && hubUg, `${name}: 1순위 경로 노출 ${route ? Math.round(route.exposed_m) : '-'}m = 걷는 거리, 도착 허브가 지하`);
  check(new Set(r.options.map((x) => x.si)).size === r.options.length, `${name}: 후보 역이 서로 다름`);
}

/* ---------- 2) 길 안내: 대화 -> 백석, 도착 두 번, 앞이 막힘 ---------- */
function plan(from, to) {   // app.js 와 같이: 지하로 길이 없으면 역 사이 지상 걷기도 넣어 다시 찾는다
  const route = UG.router.findRoute(G, from, to, { blocked }) || UG.router.findRoute(G, from, to, { blocked, surface: true });
  if (!route) return null;
  return UG.steps.planItems(G, { from, to, route }, 3.5);
}
const blocked = new Set();
const st = (n) => ({ kind: 'station', si: UG.graph.findStation(G, n), text: n });
const p1 = plan(st('대화'), st('백석'));
const cps = UG.guide.buildCheckpoints(G, p1);
console.log('체크포인트: ' + cps.map((c) => `${c.label}(${(c.at / 1000).toFixed(1)})`).join(' → '));
check(cps.length === 4 && cps[cps.length - 1].kind === 'end' && Math.abs(cps[cps.length - 1].at - p1.view.total_m) < 1, '대화→백석 체크포인트 4개, 마지막 = 도착, 거리 = 총거리');
const gs = { plan: p1, cps, cur: 1 };   // 주엽, 정발산까지 '도착'
const pr = UG.guide.progress(cps, 1, p1.view.total_m);
check(pr.next.label === '마두역' && Math.abs(pr.toNext_m - (cps[2].at - cps[1].at)) < 1, `도착 두 번 뒤 다음 = ${pr.next.label}, 남은 ${Math.round(pr.left_m)}m`);
const b = UG.guide.planBlock(G, gs, 300);   // 정발산에서 300m 걸은 뒤 막힘
check(b.edges.size >= 2 && b.from && b.from.label === '정발산역', `앞이 막힘: 간선 ${b.edges.size}개 막음(상·하행 포함), 다시 출발 = ${b.from && b.from.label}, 되돌아감 ${Math.round(b.backtrack)}m`);
b.edges.forEach((e) => blocked.add(e));
const p2 = plan(b.from, p1.to);
check(!!p2, p2 ? `다시 찾음: ${(p2.view.total_m / 1000).toFixed(1)}km, 지상 ${Math.round(p2.view.exposed_m)}m, ` +
  p2.items.filter((i) => i.kind === 'step' && i.step.type === 'ride').map((i) => i.step.label + '(' + i.step.from_station + '→' + i.step.to_station + ')').join(' / ') : '다시 찾기 실패');
check(p2 && p2.route.path.every((x) => !blocked.has(x.e)), '새 경로는 막은 간선을 지나지 않음');

/* ---------- 3) 지점 -> 지점: 출구가 막힘 ---------- */
blocked.clear();
const pt = (lat, lon) => ({ kind: 'point', lat, lon, conn: UG.router.connectPoint(G, lat, lon), label: '지점', text: '지점' });
const p3 = plan(pt(37.5585, 126.9790), pt(37.4979, 127.0276));
const c3 = UG.guide.buildCheckpoints(G, p3);
const b3 = UG.guide.planBlock(G, { plan: p3, cps: c3, cur: -1 }, 0);   // 들어갈 출구가 막힘
b3.edges.forEach((e) => blocked.add(e));
const p4 = plan(p3.from, p3.to);
check(c3[0].kind === 'enter' && b3.from === null && p4 && p4.route.startConn.ent !== p3.route.startConn.ent,
  `들어갈 출구 ${p3.route.startConn.ref}번이 막힘 → 다른 출구 ${p4 && p4.route.startConn.ref}번으로 다시 찾음`);

process.exitCode = ok ? 0 : 1;
console.log(ok ? '모두 통과' : '실패 있음');
