// check_connect.js — 지도 위 점(장소·내 위치·고른 지점)을 그래프에 잇는 곳 후보(router.connectPoint)를 확인한다.
// 사용법(프로젝트 폴더에서): node scripts\check_connect.js
// 역 출구·역에 더해 egress.json 의 터널 출입구(portal)·차량기지(depot)도 들어가고 나오는 곳 후보다(사용자 결정 2026-11-11).
// - 9호선 개화 부근 터널 출입구 옆(역 출구는 1.2km 밖): 예전에는 개화역 출구까지 지상으로 걸었고, 이제 터널 출입구로 들어가 노출이 준다
// - 반대로 그곳이 도착이면 '… 터널 출입구로 나가기'
// - 방화차량사업소 나가는 곳 옆: 기지로 들어가기(기지 안 길이 지상 노출에 들어감)
// - 역 출구 옆(시청 앞)은 egress.json 을 줘도 그 역 출구로 들어간다
// - egress.json 을 주지 않으면 예전과 같다(check_router.js 의 route.py 비교는 그대로)
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
for (const f of ['graph', 'junctions', 'router', 'steps', 'nearest', 'guide', 'walk', 'lines', 'panel']) require(path.join(ROOT, 'web/js', f + '.js'));
const UG = globalThis.UG, RT = UG.router;
const g = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/data/graph.json'), 'utf8'));
const G = UG.graph.indexGraph(g);
const eg = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/data/egress.json'), 'utf8'));
const SPEED = 3.5;
let ok = true;
const check = (cond, msg) => { console.log((cond ? 'OK  ' : 'NG  ') + msg); ok = ok && cond; };
const info = (msg) => console.log('    ' + msg);
const st = (q) => { const i = UG.graph.findStation(G, q); return { kind: 'station', si: i, text: q, lat: g.stations[i].lat / 1e5, lon: g.stations[i].lon / 1e5 }; };
const point = (lat, lon, withEgress) => ({ kind: 'point', lat, lon, label: '고른 지점', text: '고른 지점', conn: RT.connectPoint(G, lat, lon, withEgress ? eg : null) });
const connName = (c) => c.kind === 'portal' || c.kind === 'depot' ? c.name : g.stations[c.si].name + (c.ref ? ' ' + c.ref + '번 출구' : '');
function plan(from, to) {
  const route = RT.findRoute(G, from, to) || RT.findRoute(G, from, to, { surface: true });
  const p = { from, to, route };
  UG.steps.planItems(G, p, SPEED);
  return p;
}
const item = (p, kind) => p.items.find((i) => i.kind === kind);

check(eg.format === 'egress-1', 'egress.json 형식 egress-1, 항목 ' + eg.items.length + '개');

/* ---------- 1) 터널 출입구 옆에서 출발 ---------- */
const P = eg.items.find((x) => x.k === 'portal' && x.name === '9호선 개화 부근 터널 출입구');
check(!!P, '터널 출입구 항목: ' + (P ? P.name + ' (' + P.note + ')' : '없음'));
const lat = P.lat + 0.0005, lon = P.lon;   // 출입구에서 북쪽으로 약 55m
const dest = st('여의도@서울');
console.log('\n[1] ' + P.name + ' 옆(북쪽 약 55m) → 여의도');
const before = plan(point(lat, lon, false), dest), after = plan(point(lat, lon, true), dest);
info(`egress.json 없이: ${connName(before.route.startConn)}까지 지상 ${Math.round(before.route.startConn.len)}m, 경로 ${(before.view.total_m / 1000).toFixed(1)}km · 지상 노출 ${Math.round(before.view.exposed_m)}m`);
check(after.route.startConn.kind === 'portal' && after.route.startConn.eg === eg.items.indexOf(P), `egress.json 있음: ${connName(after.route.startConn)}로 들어감(지상 ${Math.round(after.route.startConn.len)}m)`);
check(after.view.exposed_m < before.view.exposed_m - 500, `지상 노출 ${Math.round(before.view.exposed_m)}m → ${Math.round(after.view.exposed_m)}m`);
const enter = item(after, 'enter');
const enterTitle = UG.panel.ro(UG.steps.connLabel(enter.conn, enter.stName, true)) + ' 들어가기';
check(enterTitle === '9호선 개화 부근 터널 입구로 들어가기', '단계 글: ' + enterTitle);
const cps = UG.guide.buildCheckpoints(G, after);
check(cps[0].kind === 'enter' && cps[0].label === '9호선 개화 부근 터널 입구' && cps[0].node === after.route.startConn.node, '길 안내 첫 확인 지점: ' + cps[0].label + ' (' + Math.round(cps[0].at) + 'm)');
check(Math.abs(after.route.exposed_m - after.route.startConn.len - after.route.path_exposed_m) < 1, '지상 노출 = 출입구까지 걷기(직선 × 1.3) + 경로의 지상 간선');

/* ---------- 2) 도착이 터널 출입구 옆 ---------- */
console.log('\n[2] 여의도 → ' + P.name + ' 옆');
const back = plan(dest, point(lat, lon, true));
const exit = item(back, 'exit');
check(back.route.endConn.kind === 'portal' && !!exit, '도착: ' + connName(back.route.endConn) + '로 나감');
const exitTitle = UG.panel.ro(UG.steps.connLabel(exit.conn, exit.stName, false)) + ' 나가기';
check(exitTitle === '9호선 개화 부근 터널 출입구로 나가기' && exit.others.length === 0, '단계 글: ' + exitTitle + " ('다른 출구' 목록 없음)");
const cpsB = UG.guide.buildCheckpoints(G, back);
info('끝 확인 지점: ' + cpsB.slice(-2).map((c) => c.label).join(' → '));

/* ---------- 3) 차량기지 옆 ---------- */
const D = eg.items.find((x) => x.k === 'depot' && x.name === '방화차량사업소');
console.log('\n[3] ' + D.name + ' 나가는 곳 옆 → 여의도');
const dl = D.lat + 0.0004, dn = D.lon;
const dBefore = plan(point(dl, dn, false), dest), dAfter = plan(point(dl, dn, true), dest);
const dc = dAfter.route.startConn;
info(`egress.json 없이: ${connName(dBefore.route.startConn)}, 지상 노출 ${Math.round(dBefore.view.exposed_m)}m`);
check(dc.kind === 'depot' && dc.inner > 0 && Math.abs(dc.len - (dc.dist * RT.DETOUR + dc.inner)) < 1e-6, `차량기지로 들어감: 나가는 곳까지 ${Math.round(dc.dist * RT.DETOUR)}m + 기지 안 ${Math.round(dc.inner)}m (지상)`);
check(dAfter.view.exposed_m < dBefore.view.exposed_m, `지상 노출 ${Math.round(dBefore.view.exposed_m)}m → ${Math.round(dAfter.view.exposed_m)}m`);
const dEnter = item(dAfter, 'enter');
check(UG.panel.ro(UG.steps.connLabel(dEnter.conn, dEnter.stName, true)) + ' 들어가기' === '방화차량사업소로 들어가기' && dEnter.latlngs.length === 3, '단계 글: 방화차량사업소로 들어가기 (선: 지점 → 나가는 곳 → 기지 안)');
// 도보 길(walk.js)을 받으면 도로 구간만 바뀌고 기지 안 길은 그대로 붙는다
dAfter.legs = { start: { m: 300, pts: [[dl, dn], [(dl + D.lat) / 2, dn], [D.lat, D.lon]] } };
const m0 = dAfter.route.total_m;
UG.walk.applyLegs(G, dAfter, SPEED);
check(Math.abs(dEnter.m - (300 + dc.inner)) < 1e-6 && dEnter.latlngs.length === 4 && Math.abs(dAfter.view.total_m - (m0 + 300 + dc.inner - dc.len)) < 1e-6, `도보 길 300m를 받으면 들어가기 ${Math.round(dEnter.m)}m(= 300m + 기지 안), 총거리도 같이 바뀜`);

/* ---------- 4) 역 출구 옆은 그대로 역 출구 ---------- */
console.log('\n[4] 시청 앞(역 출구 옆) → 여의도');
const near = plan(point(37.5663, 126.9779, true), dest);
check(near.route.startConn.kind === 'entrance', '들어가는 곳: ' + connName(near.route.startConn) + ` (지상 ${Math.round(near.route.startConn.len)}m)`);
const same = plan(point(37.5663, 126.9779, false), dest);
check(RT.sameRoute(near.route, same.route), 'egress.json 이 있어도 없을 때와 같은 경로');

/* ---------- 5) egress.json 을 주지 않으면 후보는 역 출구·역뿐 ---------- */
const plain = RT.connectPoint(G, lat, lon);
check(plain.every((c) => c.kind === 'entrance' || c.kind === 'hub') && RT.egressConns(G, lat, lon, null).length === 0, 'egress.json 없이: 후보는 역 출구·역만(예전과 같음)');
const withEg = RT.connectPoint(G, lat, lon, eg);
check(withEg.some((c) => c.kind === 'portal') && withEg.filter((c) => c.kind === 'entrance' || c.kind === 'hub').length === plain.length, `egress.json 있음: 역 후보 ${plain.length}개는 그대로 + 터널 출입구·차량기지 ${withEg.length - plain.length}개`);

console.log(ok ? '\n모두 통과' : '\n실패한 항목이 있습니다');
process.exit(ok ? 0 : 1);
