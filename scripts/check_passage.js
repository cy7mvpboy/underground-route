// check_passage.js — web/data/passage.json(역 안 지하도 선 모양)을 graph.json 과 맞춰 본다.
// 사용법(프로젝트 폴더에서): node scripts\check_passage.js
//   1) 형식·출처, 키가 graph.json 의 출입구 번호·환승 간선 번호인지
//   2) 모든 폴리라인을 풀어(graph.json 과 같은 소수 5자리) 점이 2개 이상인지
//   3) 출구: 첫 점이 출입구 노드에서, 끝 점이 그 출입구 간선의 허브에서 41m 안인지(기준 40m + 반올림)
//      환승: 첫 점이 간선 a 허브에서, 끝 점이 b 허브에서 41m 안인지
//   4) web/js/graph.js 의 decodePolyline 을 불러올 수 있으면 같은 결과인지
//   5) 예시 5개: 양재 6번 출구, 종로3가 1↔3, 고속터미널 3↔7, 왕십리, 김포공항 5↔9
//   6) 웹 그리기 고르기(web/js/passage.js): 모양이 있으면 지하도 선, 없으면 예전 그림(출구 직선·환승 옅은 점선), 방향, 거리 그대로
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const g = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/data/graph.json'), 'utf8'));
const P = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/data/passage.json'), 'utf8'));
const NEAR_M = 41; // 만들 때 기준 40m + 소수 5자리 반올림(점 하나당 1m 안)
let ok = true;
const check = (cond, msg) => { console.log((cond ? 'OK  ' : 'NG  ') + msg); ok = ok && cond; };

// graph-format.md 5절과 같은 풀기(소수 5자리)
function decodePolyline(s) {
  const pts = []; let i = 0, lat = 0, lon = 0;
  while (i < s.length) {
    for (const k of [0, 1]) {
      let r = 0, sh = 0, b;
      do { b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
      const d = (r & 1) ? ~(r >> 1) : (r >> 1);
      if (k === 0) lat += d; else lon += d;
    }
    pts.push([lat / 1e5, lon / 1e5]);
  }
  return pts;
}
const C = Math.cos(37.55 * Math.PI / 180);
const dist = (a, b) => Math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 111320 * C);
const lengthOf = (pts) => pts.reduce((s, p, i) => (i ? s + dist(pts[i - 1], p) : 0), 0);
const nodePt = (i) => [g.nodes.lat[i] / 1e5, g.nodes.lon[i] / 1e5];
const quant = (v) => { v = v.slice().sort((x, y) => x - y); return [0.1, 0.5, 0.9].map((f) => Math.round(v[Math.min(v.length - 1, Math.floor(v.length * f))])); };

const E = g.edges, T = g.tables, ENT = g.entrances;
const kTr = T.kinds.indexOf('transfer'), kEn = T.kinds.indexOf('entrance');
const seoul = T.regions.findIndex((r) => r.name === '서울특별시');
const hubLine = new Map(), hubSt = new Map();
g.stations.forEach((s, si) => s.hubs.forEach((h, k) => {
  hubLine.set(h, T.line_sets[s.hub_ls[k]].map((x) => T.lines[x]).join('/') || '(노선 없음)');
  hubSt.set(h, si);
}));
const entIndex = new Map(ENT.node.map((n, i) => [n, i]));
const entEdge = new Map(); // 출입구 번호 → [간선, 허브]
for (let j = 0; j < E.a.length; j++) {
  if (E.k[j] !== kEn) continue;
  const a = E.a[j], b = E.b[j];
  if (g.nodes.f[a] & 4 && entIndex.has(a)) entEdge.set(entIndex.get(a), [j, b]);
  else if (g.nodes.f[b] & 4 && entIndex.has(b)) entEdge.set(entIndex.get(b), [j, a]);
}

// 1) 형식
check(P.format === 'passage-1', `format = ${P.format}`);
check(P.source && /15098161/.test(P.source.url) && !!P.source.license && !!P.source.as_of,
  `출처: ${P.source && P.source.name} (${P.source && P.source.as_of}, ${P.source && P.source.license})`);
const exitKeys = Object.keys(P.exits), xferKeys = Object.keys(P.transfers);
console.log(`출구 ${exitKeys.length}개, 환승 ${xferKeys.length}개`);

// 2·3) 출구
const bad = [];
const exitStat = { start: [], end: [], len: [], ratio: [] };
for (const key of exitKeys) {
  const i = Number(key);
  if (!(i >= 0 && i < ENT.node.length) || !entEdge.has(i)) { bad.push(`출구 ${key}: 출입구·간선 없음`); continue; }
  const [j, hub] = entEdge.get(i);
  const pts = decodePolyline(P.exits[key]);
  if (pts.length < 2) { bad.push(`출구 ${key}: 점 ${pts.length}개`); continue; }
  const d0 = dist(pts[0], nodePt(ENT.node[i])), d1 = dist(pts[pts.length - 1], nodePt(hub));
  exitStat.start.push(d0); exitStat.end.push(d1);
  const len = lengthOf(pts); exitStat.len.push(len);
  if (E.len[j] > 0) exitStat.ratio.push(len / E.len[j]);
  if (g.stations[ENT.station[i]].rg !== seoul) bad.push(`출구 ${key}: 서울 역 아님`);
  if (d0 > NEAR_M || d1 > NEAR_M) bad.push(`출구 ${key}: 첫 점 ${d0.toFixed(1)}m, 끝 점 ${d1.toFixed(1)}m`);
}
check(bad.filter((s) => s.startsWith('출구')).length === 0, `출구 ${exitKeys.length}개 모두 첫 점이 출입구, 끝 점이 허브에서 ${NEAR_M}m 안`);
console.log(`    첫 점↔출입구 최대 ${Math.max(...exitStat.start).toFixed(1)}m, 끝 점↔허브 10·50·90% ${quant(exitStat.end).join('·')}m, 최대 ${Math.max(...exitStat.end).toFixed(1)}m`);
console.log(`    그린 길이 10·50·90% ${quant(exitStat.len).join('·')}m, 직선 출입구 간선 대비 ${quant(exitStat.ratio.map((x) => x * 100)).map((x) => (x / 100).toFixed(2)).join('·')}배`);

// 2·3) 환승
const xStat = { a: [], b: [], len: [] };
for (const key of xferKeys) {
  const j = Number(key);
  if (!(j >= 0 && j < E.a.length) || E.k[j] !== kTr) { bad.push(`환승 ${key}: 환승 간선 아님`); continue; }
  const pts = decodePolyline(P.transfers[key]);
  if (pts.length < 2) { bad.push(`환승 ${key}: 점 ${pts.length}개`); continue; }
  const da = dist(pts[0], nodePt(E.a[j])), db = dist(pts[pts.length - 1], nodePt(E.b[j]));
  xStat.a.push(da); xStat.b.push(db); xStat.len.push(lengthOf(pts));
  if (da > NEAR_M || db > NEAR_M) bad.push(`환승 ${key}: a 쪽 ${da.toFixed(1)}m, b 쪽 ${db.toFixed(1)}m`);
}
check(bad.filter((s) => s.startsWith('환승')).length === 0, `환승 ${xferKeys.length}개 모두 첫 점이 a 허브, 끝 점이 b 허브에서 ${NEAR_M}m 안`);
console.log(`    a 쪽 최대 ${Math.max(...xStat.a).toFixed(1)}m, b 쪽 최대 ${Math.max(...xStat.b).toFixed(1)}m, 그린 길이 10·50·90% ${quant(xStat.len).join('·')}m`);
bad.slice(0, 10).forEach((s) => console.log('    ' + s));

// 4) 웹 풀기 함수와 같은지(다른 작업 중이라 불러오지 못하면 건너뜀)
try {
  require(path.join(ROOT, 'web/js/graph.js'));
  const dec = globalThis.UG && globalThis.UG.graph && globalThis.UG.graph.decodePolyline;
  if (!dec) throw new Error('UG.graph.decodePolyline 없음');
  const all = [...Object.values(P.exits), ...Object.values(P.transfers)];
  const same = all.every((s) => JSON.stringify(dec(s)) === JSON.stringify(decodePolyline(s)));
  check(same, `web/js/graph.js decodePolyline 으로 ${all.length}개 모두 같게 풀림`);
} catch (e) {
  console.log('--  web/js/graph.js 를 불러오지 못해 건너뜀: ' + e.message);
}

// 5) 예시
const stationIdx = (name) => g.stations.findIndex((s) => s.name === name && s.rg === seoul);
function xferBetween(name, la, lb) {
  const si = stationIdx(name);
  for (let j = 0; j < E.a.length; j++) {
    if (E.k[j] !== kTr || hubSt.get(E.a[j]) !== si) continue;
    const A = hubLine.get(E.a[j]), B = hubLine.get(E.b[j]);
    if ((A === la && B === lb) || (A === lb && B === la)) return j;
  }
  return -1;
}
function showXfer(name, la, lb) {
  const j = xferBetween(name, la, lb);
  if (j < 0) { check(false, `예시 ${name} ${la}↔${lb}: 환승 간선 없음`); return; }
  const s = P.transfers[j];
  const head = `예시 ${name} ${hubLine.get(E.a[j])}→${hubLine.get(E.b[j])} (간선 ${j}, 환승 거리 ${E.len[j]}m ${T.sources[E.src[j]]})`;
  if (!s) { console.log(head + ': passage.json 에 없음(뺀 쌍, data/derived/passage_report.json 참고)'); return; }
  const pts = decodePolyline(s);
  console.log(`${head}: 점 ${pts.length}개, 그린 길이 ${Math.round(lengthOf(pts))}m, 허브↔끝 ${dist(pts[0], nodePt(E.a[j])).toFixed(1)}m·${dist(pts[pts.length - 1], nodePt(E.b[j])).toFixed(1)}m`);
}
{
  const si = stationIdx('양재');
  const i = ENT.node.findIndex((n, k) => ENT.station[k] === si && ENT.ref[k] === '6');
  const s = i >= 0 && P.exits[i];
  if (!s) check(false, '예시 양재 6번 출구: passage.json 에 없음');
  else {
    const [j, hub] = entEdge.get(i);
    const pts = decodePolyline(s);
    console.log(`예시 양재 6번 출구 (출입구 ${i}, ${hubLine.get(hub)} 허브): 점 ${pts.length}개, 그린 길이 ${Math.round(lengthOf(pts))}m (지금 직선 ${E.len[j]}m), 끝↔허브 ${dist(pts[pts.length - 1], nodePt(hub)).toFixed(1)}m`);
  }
}
showXfer('종로3가', '1호선', '3호선');
showXfer('고속터미널', '3호선', '7호선');
const wsi = stationIdx('왕십리');
const wang = xferKeys.filter((k) => hubSt.get(E.a[Number(k)]) === wsi).length;
const wangAll = E.a.filter((a, j) => E.k[j] === kTr && hubSt.get(a) === wsi).length;
console.log(`왕십리 환승 ${wangAll}쌍 중 ${wang}쌍 있음`);
showXfer('왕십리', '5호선', '2호선');
showXfer('왕십리', '2호선', '경의중앙선');
showXfer('김포공항', '5호선', '9호선');

// 6) 웹 그리기 고르기(web/js/passage.js edgePieces, 순수 함수): 모양이 있으면 그 선, 없으면 예전 그림
//    출구: 지하도 선(지하 색) + 선 끝 ↔ 허브 점선, 없으면 null(직선 그대로). 환승: 허브 ↔ 선 ↔ 허브, 없으면 옅은 점선 하나.
//    걷는 방향(b → a)이면 뒤집힌다. 거리는 바뀌지 않는다(routeTrack 총 거리 같음).
try {
  for (const f of ['graph', 'router', 'steps', 'guide', 'passage']) require(path.join(ROOT, 'web/js', f + '.js'));
  const UG = globalThis.UG, PS = UG.passage;
  const G = UG.graph.indexGraph(JSON.parse(fs.readFileSync(path.join(ROOT, 'web/data/graph.json'), 'utf8')));
  const same = (a, b) => a.length === b.length && a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1]);
  const kinds = (pc) => pc.map((p) => p.kind).join('+');
  // 출구: 양재 6번
  const si = stationIdx('양재'), ei = ENT.node.findIndex((n, k) => ENT.station[k] === si && ENT.ref[k] === '6');
  const [je, hub] = entEdge.get(ei), entNode = ENT.node[ei], line = decodePolyline(P.exits[ei]);
  const inn = PS.edgePieces(G, P, je, entNode), out = PS.edgePieces(G, P, je, hub);
  const gapEnd = dist(line[line.length - 1], nodePt(hub)) >= PS.GAP_M;
  const lastPt = PS.joined(inn)[PS.joined(inn).length - 1];   // 점선이 있으면 허브, 없으면 지하도 선 끝
  check(inn[0].kind === 'under' && same(inn[0].pts, line) && kinds(inn) === (gapEnd ? 'under+xfer' : 'under') &&
    same([lastPt], [gapEnd ? nodePt(hub) : line[line.length - 1]]),
    `그리기: 양재 6번 출구로 들어감 = 지하도 선(${line.length}점) ${gapEnd ? '+ 끝 ↔ 허브 점선' : ''}(${kinds(inn)})`);
  check(kinds(out) === kinds(inn).split('+').reverse().join('+') && same(PS.joined(out), PS.joined(inn).slice().reverse()),
    `그리기: 양재 6번 출구로 나감 = 같은 선을 거꾸로(${kinds(out)})`);
  check(PS.edgePieces(G, null, je, entNode) === null, '그리기: passage.json 을 아직 못 받았으면 출구는 예전 직선(null)');
  const noExit = [...entEdge.keys()].find((i) => !P.exits[i]);
  check(PS.edgePieces(G, P, entEdge.get(noExit)[0], ENT.node[noExit]) === null, `그리기: 모양 없는 출구(출입구 ${noExit})는 예전 직선(null)`);
  // 환승: 종로3가 1→3 (모양 있음), 시청 2↔1 (뺀 쌍, 모양 없음)
  const jx = xferBetween('종로3가', '1호선', '3호선'), xl = decodePolyline(P.transfers[jx]);
  const fwd = PS.edgePieces(G, P, jx, E.a[jx]), back = PS.edgePieces(G, P, jx, E.b[jx]);
  const under = fwd.filter((p) => p.kind === 'under');
  check(under.length === 1 && same(under[0].pts, xl) && fwd.every((p) => p.kind === 'under' || p.kind === 'xfer'),
    `그리기: 종로3가 환승(간선 ${jx}) = 지하도 선 실선 1개 + 끝 점선(${kinds(fwd)})`);
  const J = PS.joined(fwd);
  check(dist(J[0], nodePt(E.a[jx])) < PS.GAP_M && dist(J[J.length - 1], nodePt(E.b[jx])) < PS.GAP_M,
    '그리기: 환승 그림이 두 승강장 허브(a → b)에 닿음');
  check(same(PS.joined(back), J.slice().reverse()), `그리기: b → a 로 걸으면 거꾸로(${kinds(back)})`);
  const js = xferBetween('시청', '2호선', '1호선');
  const plain = PS.edgePieces(G, P, js, E.a[js]);
  check(!P.transfers[js] && plain.length === 1 && plain[0].kind === 'xfer' && same(plain[0].pts, UG.graph.edgeShape(g, js, E.a[js])),
    `그리기: 모양 없는 환승(시청 2↔1, 간선 ${js}) = 두 허브 사이 옅은 점선 하나`);
  const pre = PS.edgePieces(G, null, jx, E.a[jx]);
  check(pre.length === 1 && pre[0].kind === 'xfer', '그리기: passage.json 을 아직 못 받았으면 환승은 옅은 점선 하나');
  const track = E.k.findIndex((k) => k === T.kinds.indexOf('track'));
  check(PS.edgePieces(G, P, track, E.a[track]) === null, '그리기: 선로 간선은 바꾸지 않음(null)');
  // 경로 하나(종각 → 안국, 종로3가 1→3 환승): 길 안내 위치 추정 선을 지하도 모양으로 바꿔도 총 거리는 같다
  const R = UG.router.findRoute(G, { kind: 'station', si: stationIdx('종각') }, { kind: 'station', si: stationIdx('안국') });
  const plan = UG.steps.planItems(G, { from: {}, to: {}, route: R }, 3.5);
  const shape = (e, u) => { const pc = PS.edgePieces(G, P, e, u); return pc ? PS.joined(pc) : null; };
  const t0 = UG.guide.routeTrack(G, plan), t1 = UG.guide.routeTrack(G, plan, shape);
  const usesX = R.path.some((x) => x.e === jx);
  check(usesX && t0.total === t1.total && t0.pieces.length === t1.pieces.length &&
    t1.pieces.some((p) => same(p.pts, J) || same(p.pts, J.slice().reverse())),
    `길 안내 선: 종각 → 안국이 종로3가 환승을 지나고, 지하도 모양으로 바꿔도 총 거리 ${Math.round(t1.total)}m 그대로`);
} catch (e) {
  check(false, '그리기 시험 실패: ' + e.stack);
}

const raw = fs.statSync(path.join(ROOT, 'web/data/passage.json')).size;
const gz = require('zlib').gzipSync(fs.readFileSync(path.join(ROOT, 'web/data/passage.json')), { level: 9 }).length;
console.log(`크기 ${raw.toLocaleString()} byte, gzip ${gz.toLocaleString()} byte`);
console.log(ok ? '\n모두 통과' : '\n실패 있음');
process.exit(ok ? 0 : 1);
