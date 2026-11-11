// check_gps.js — 길 안내 중 GPS 를 믿을지(guide.js 의 GpsGate·notNewer)와 지하 구간 판단(routeTrack 의 ug, underNow)을 시험한다.
// 사용법(프로젝트 폴더에서): node scripts\check_gps.js
// 실제 경로(회현역 2번 출구 → 강남역 8번 출구) 위에서 위치가 오는 순서를 가짜 시계로 흉내 낸다. 실제 폰·실제 지하에서 잰 것은 아니다.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
for (const f of ['graph', 'junctions', 'router', 'steps', 'guide']) require(path.join(ROOT, 'web/js', f + '.js'));
const UG = globalThis.UG, GD = UG.guide, RULES = GD.GPS_RULES;
const g = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/data/graph.json'), 'utf8'));
const G = UG.graph.indexGraph(g);
let ok = true;
const check = (cond, msg) => { console.log((cond ? 'OK  ' : 'NG  ') + msg); ok = ok && cond; };
const info = (msg) => console.log('    ' + msg);

function plan(from, to) {   // app.js 와 같이: 지하로 길이 없으면 역 사이 지상 걷기도 넣어 다시 찾는다
  const route = UG.router.findRoute(G, from, to) || UG.router.findRoute(G, from, to, { surface: true });
  const p = { from, to, route };
  UG.steps.planItems(G, p, 3.5);
  return p;
}
const st = (n) => ({ kind: 'station', si: UG.graph.findStation(G, n), text: n });
const pt = (lat, lon) => ({ kind: 'point', lat, lon, conn: UG.router.connectPoint(G, lat, lon), label: '지점', text: '지점' });

/* ---------- 1) 지하 구간 판단 ---------- */
console.log('\n[1] 경로 위 지하 구간');
const P = plan(pt(37.5585, 126.9790), pt(37.4979, 127.0276));   // 회현역 2번 출구로 들어가 강남역 8번 출구로 나옴
const T = GD.routeTrack(G, P), C = GD.buildCheckpoints(G, P);
const ugLen = T.pieces.reduce((a, q) => a + (q.ug ? q.len : 0), 0);
check(Math.abs(ugLen - (P.view.total_m - P.view.exposed_m)) < 1,
  `지하 조각 길이 ${Math.round(ugLen)}m = 총거리 ${Math.round(P.view.total_m)}m − 지상 노출 ${Math.round(P.view.exposed_m)}m (경로 탐색과 같은 기준)`);
const kEnter = C.findIndex((c) => c.kind === 'enter'), kExit = C.findIndex((c) => c.kind === 'exit'), last = C.length - 1;
check(kEnter === 0 && kExit > 0 && C[last].kind === 'end', `확인 지점: ${C[kEnter].label} … ${C[kExit].label} … ${C[last].label}`);
const un = (cur, walked) => GD.underNow(T, C, cur, walked);
check(!un(-1, 0) && !un(-1, 60), '출구까지 걷는 중(지상 걷기)은 지상');
check(!un(-1, 500), '추정이 출구에 닿았어도 아직 "도착"을 누르지 않았으면 지상(그 앞 구간)');
check(un(0, 0) && un(0, 50), '출구에서 "도착"을 누른 뒤(출구 통로·승강장)는 지하');
check(un(kExit - 1, 5000), '나갈 출구에 닿았어도 아직 "도착"을 누르지 않았으면 지하(출구 통로)');
check(!un(kExit, 0) && !un(kExit, 30), '나갈 출구에서 "도착"을 누른 뒤(도착 지점까지 걷기)는 지상');
check(!un(last, 0), '다 왔으면 지상');
const Y = plan(st('여의도'), st('광화문')), YT = GD.routeTrack(G, Y), YC = GD.buildCheckpoints(G, Y);
check(Y.view.exposed_m === 0 && YT.pieces.every((q) => q.ug) && GD.underNow(YT, YC, -1, 0), '여의도 → 광화문(전 구간 지하): 모든 조각이 지하, 출발(지하 승강장)부터 지하');
const D = plan(st('도봉산'), st('장암')), DT = GD.routeTrack(G, D), DC = GD.buildCheckpoints(G, D);
check(D.view.exposed_m > 0 && DT.pieces.every((q) => !q.ug) && !GD.underNow(DT, DC, -1, 300), '도봉산 → 장암(7호선 지상): 모든 조각이 지상');

/* ---------- 2) 위치를 흉내 내는 도구 ---------- */
const T0 = 1.8e12;   // 가짜 시계(ms)
const north = (ll, m) => [ll[0] + m / 111320, ll[1]];
const fixAt = (m, t, acc, alt, offN) => { const ll = north(GD.pointAt(T, m), offN || 0); return { lat: ll[0], lon: ll[1], acc, alt: alt === undefined ? 40 : alt, t, ts: t }; };   // t = 받은 시각, ts = pos.timestamp(기본은 같은 값)
// 예전 규칙(받은 시각, 20초, 80m): 비교용
const oldUsable = (f, now) => !!f && now - f.t < 20000 && f.acc <= 80;
const V = 1.2;   // 걷는 속도 m/s

/* ---------- 3) GPS 가 잡히는 동안은 출구를 지나도 GPS ---------- */
console.log('\n[2] 출구까지 걷고 들어감: GPS 가 잡히는 동안은 GPS');
let gate = GD.GpsGate(), now = T0, all = true;
const enterAt = C[kEnter].at;
// 출구까지 1초마다 정확도 8m. 추정(걸은 시간 × 속도)은 실제보다 20% 앞서 간다
for (let s = 0; s * V <= enterAt; s++) {
  now = T0 + s * 1000;
  gate.add(fixAt(s * V, now, 8));
  all = all && gate.usable(now, un(-1, s * V * 1.2));
}
check(all, `출구(${Math.round(enterAt)}m)까지 지상: 1초마다 온 위치를 모두 GPS 로 씀`);
// '도착'(출구)을 누름 -> 추정 위치는 지하(출구 통로). 계단 위·중간에서 GPS 가 아직 잡힘(정확도 8~20m, 와이파이 같은 40m 도 섞임)
const tIn = now;
let stayed = true;
[10, 14, 20, 40, 18, 12].forEach((acc, i) => {
  now = tIn + (i + 1) * 1000;
  gate.add(fixAt(enterAt + (i + 1) * 0.8, now, acc));
  stayed = stayed && gate.usable(now, un(0, (now - tIn) / 1000 * V));
});
check(un(0, 1) && stayed, '출구에서 "도착"을 누른 뒤(지하 구간)에도 위치가 계속 오면(80m 안) GPS 그대로: 경로 진행만으로 추정으로 바꾸지 않음');

/* ---------- 4) 위치가 끊기면 6초 안에 추정 ---------- */
console.log('\n[3] 계단을 내려가 위치가 끊김');
const tLast = now;
const at = (dt) => gate.usable(tLast + dt, un(0, (tLast + dt - tIn) / 1000 * V));
check(at(1000) && at(5900), '마지막 위치 뒤 5.9초까지는 GPS');
check(!at(RULES.freshMs), `마지막 위치 뒤 ${RULES.freshMs / 1000}초에 추정으로 바뀜(전에는 20초 + 저장된 위치 최대 10초)`);
info(`예전 규칙이면 ${oldUsable({ t: tLast, acc: 12 }, tLast + 19000) ? '19초 뒤에도 GPS' : '?'} · 걷는 속도로 6초 = 약 ${Math.round(6 * V)}m, 20초 = 약 ${Math.round(20 * V)}m`);
// 지상에서 끊겨도 같은 6초
const gs = GD.GpsGate();
gs.add(fixAt(30, T0, 10));
check(gs.usable(T0 + 5900, false) && !gs.usable(T0 + 6000, false), '지상에서도 6초 동안 새 위치가 없으면 추정');

/* ---------- 5) 잃은 뒤 지하: 와이파이 같은 위치는 쓰지 않음 ---------- */
console.log('\n[4] 잃은 뒤 역 안(지하 구간): 와이파이·기지국 같은 위치');
const ugNow = (t) => un(0, (t - tIn) / 1000 * V);
let tw = tLast + 8000, none = true, oldYes = 0;
for (let i = 0; i < 20; i++, tw += 3000) {   // 3초마다 정확도 40m, 고도 없음, 승강장 근처에서 ±15m 튐
  const f = fixAt(enterAt + 150, tw, 40, null, (i % 3 - 1) * 15);
  gate.add(f);
  if (gate.usable(tw, ugNow(tw))) none = false;
  if (oldUsable(f, tw)) oldYes++;
}
check(none, `정확도 40m 위치 20번(60초): 모두 쓰지 않고 추정 그대로 (예전 규칙은 ${oldYes}번 GPS 로 씀)`);
none = true;
for (let i = 0; i < 10; i++, tw += 1000) {   // 1초마다 20m 지만 고도 없음(안드로이드 와이파이 위치처럼)
  gate.add(fixAt(enterAt + 150, tw, 20, null, i % 2 ? 3 : -3));
  if (gate.usable(tw, ugNow(tw))) none = false;
}
check(none, `정확도 20m·고도 없음 10번(1초마다): 쓰지 않음(고도가 없으면 ${RULES.ugNoAltM}m 안이어야 함)`);
none = true;
for (let i = 0; i < 10; i++, tw += 1000) {   // 20m·고도 있음이지만 두 곳(50m 떨어짐)을 오감
  gate.add(fixAt(enterAt + 150, tw, 20, 35, i % 2 ? 25 : -25));
  if (gate.usable(tw, ugNow(tw))) none = false;
}
check(none, `정확도 20m 이지만 50m 떨어진 두 곳을 오감: 쓰지 않음(서로 ${RULES.ugSpreadM}m 안이어야 함)`);
none = true;
[40, 8, 8, 45, 8, 8].forEach((acc) => { tw += 1000; gate.add(fixAt(enterAt + 150, tw, acc, 35)); if (gate.usable(tw, ugNow(tw))) none = false; });
check(none, '40m 위치 뒤 좋은 위치 2번 → 45m → 좋은 위치 2번: 연달아 3번이 안 되어 쓰지 않음');

/* ---------- 6) 나와서 좋은 위치가 이어지면 다시 GPS ---------- */
console.log('\n[5] 강남역 8번 출구로 나옴: 다시 잡기');
const kGn = kExit - 1, exitAt = C[kExit].at;
const g2 = GD.GpsGate(), tOut = T0 + 600000;
g2.add(fixAt(exitAt - 60, tOut - 120000, 9));   // 2분 전(지하에 들어가기 전) 마지막 위치: 잃은 상태
check(!g2.usable(tOut, true), '오래 끊긴 뒤: 추정');
const seq = [];
for (let i = 0; i < 6; i++) {
  const t = tOut + i * 1000;
  g2.add(fixAt(exitAt, t, 6, 30, i * 1.2));
  seq.push(g2.usable(t, un(kGn, 5000)));
}
check(seq.slice(0, 3).every((x) => !x) && seq[3] && seq[4] && seq[5],
  `정확도 6m 위치가 1초마다: ${seq.map((x, i) => i + 1 + '번째 ' + (x ? 'GPS' : '추정')).join(', ')} (${RULES.ugCount}번 넘게·${RULES.ugSpanMs / 1000}초 넘게 모여야 다시 GPS)`);
const t6 = tOut + 6000;
g2.add(fixAt(exitAt, t6, 40, null, 8));
check(g2.usable(t6, un(kGn, 5000)), '다시 잡은 뒤에는 지금처럼(6초 안·80m 안이면 GPS, 지하 구간이어도)');
// 다른 출구로 나옴: 경로에서 400m 떨어진 곳. 다시 잡기는 같고, 그 뒤는 '경로에서 벗어남'(app.js, 150m)
const g3 = GD.GpsGate(), far = [];
for (let i = 0; i < 5; i++) { const t = tOut + i * 1000; g3.add(fixAt(exitAt - 2000, t, 7, 30, 400)); far.push(g3.usable(t, un(kGn - 3, 500))); }
const off = GD.distanceToTrack(T, ...north(GD.pointAt(T, exitAt - 2000), 400));
check(!far[2] && far[3] && off > 150, `다른 출구(경로에서 ${Math.round(off)}m): 3초 넘게 모이면 GPS → app.js 가 '경로 밖'으로 표시`);
// 고도 없는 GNSS(일부 기기): 정확도가 좋으면 다시 잡음
const g4 = GD.GpsGate(), na = [];
for (let i = 0; i < 5; i++) { const t = tOut + i * 1000; g4.add(fixAt(exitAt, t, 8, null)); na.push(g4.usable(t, true)); }
check(na[3], `고도가 없어도 정확도 ${RULES.ugNoAltM}m 안이면 다시 잡음(고도는 보조 신호): ${na.map((x) => (x ? 'G' : '-')).join('')}`);

/* ---------- 7) 측정 시각(pos.timestamp)은 위치끼리 순서만 ---------- */
console.log('\n[6] 받은 시각과 측정 시각');
const tn = T0 + 900000;
const g5 = GD.GpsGate(), first = fixAt(50, tn, 10);
g5.add(first);
const again = Object.assign(fixAt(50, tn + 5000, 10), { ts: first.ts });   // 브라우저가 같은 위치를 5초 뒤 또 줌(ts 같음)
check(g5.add(again) === false && GD.notNewer(again, first) && g5.usable(tn + 5900, false) && !g5.usable(tn + 6000, false),
  '같은 측정 시각을 다시 받음 → 버림(끊김 시계를 새로 시작하지 않아 처음 받은 때부터 6초에 추정)');
const g6 = GD.GpsGate(), newer = fixAt(60, tn, 10);
g6.add(newer);
const older = Object.assign(fixAt(40, tn + 1000, 10), { ts: newer.ts - 3000 });   // 3초 전에 잰 위치가 늦게 옴
check(g6.add(older) === false && GD.notNewer(older, newer) && g6.usable(tn + 1500, false), '새 위치 뒤에 더 오래된 측정 시각의 위치가 옴 → 버림(점이 뒤로 가지 않음)');
const g8 = GD.GpsGate(), skew = [];
for (let i = 0; i < 6; i++) {   // 기기 시계가 위치의 측정 시각(위성 시각)보다 30초 빠름: ts = 받은 시각 - 30초
  const t = tn + i * 1000;
  g8.add(Object.assign(fixAt(70 + i, t, 8), { ts: t - 30000 }));
  skew.push(g8.usable(t, false));
}
const g9 = GD.GpsGate(), skewUg = [];
for (let i = 0; i < 5; i++) { const t = tn + i * 1000; g9.add(Object.assign(fixAt(exitAt, t, 6, 30), { ts: t - 30000 })); skewUg.push(g9.usable(t, true)); }
check(skew.every((x) => x) && skewUg[3], `기기 시계가 측정 시각보다 30초 빠름 → 지상은 바로 GPS(${skew.map((x) => (x ? 'G' : '-')).join('')}), 잃은 뒤 지하도 다시 잡음(${skewUg.map((x) => (x ? 'G' : '-')).join('')})`);
const g10 = GD.GpsGate(), noTs = [];
for (let i = 0; i < 3; i++) { const t = tn + i * 1000; g10.add(Object.assign(fixAt(80, t, 10), { ts: null })); noTs.push(g10.usable(t, false)); }
check(noTs.every((x) => x), '측정 시각이 없는 위치도 받은 시각으로 씀');

/* ---------- 8) 지상 걷기: 끊김 기준만 6초로 바뀜 ---------- */
console.log('\n[7] 지상 걷기(지금과 같음)');
const g7 = GD.GpsGate();
let same = true, tt = T0;
[12, 35, 60, 78, 25, 70].forEach((acc, i) => { tt = T0 + i * 1000; const f = fixAt(10 + i, tt, acc, i % 2 ? null : 30); g7.add(f); same = same && g7.usable(tt, false) === oldUsable(f, tt); });
check(same, '정확도 12~78m(고도 있음·없음): 모두 GPS, 예전 규칙과 같음');
tt += 1000; g7.add(fixAt(20, tt, 95));
const bad = g7.usable(tt, false);
tt += 1000; g7.add(fixAt(21, tt, 50, null));
check(!bad && g7.usable(tt, false), '정확도 95m → 추정, 다음 50m 위치 하나로 바로 GPS(지상은 엄하게 보지 않음)');
const gap = tt + 7000;
check(!g7.usable(gap, false), '7초 끊김 → 추정');
g7.add(fixAt(30, gap, 30, null));
check(g7.usable(gap, false), '끊긴 뒤 지상에서 위치 하나(30m)로 바로 GPS');
// 시연: 위치를 숨기므로(state.myLoc = null) app.js 는 GpsGate 를 묻지 않고 추정만 쓴다(check_demo.js 와 app.js 의 gpsUsable)

console.log(ok ? '\n모두 통과' : '\n실패한 항목이 있습니다');
process.exit(ok ? 0 : 1);
