// check_exit_here.js — '여기서 나가기'(web/js/exithere.js)와 그 경로, 갈림길 체크포인트를 시험한다.
// 사용법(프로젝트 폴더에서): node scripts\check_exit_here.js
//   1) 공덕~마포 터널 한가운데(추정 위치)에서 나갈 곳 후보: egress.json 이 있을 때 / 없을 때(역 출구만)
//   2) 터널 출입구 가까이: 그 출입구가 1순위
//   3) 긴 터널 한가운데 수직구(같은 간선 위): egress.json 의 수직구가 있으면 그것, 없으면 가장 긴 일반철도 터널에 만든 예시
//   4) 고른 후보로 다시 찾은 경로: 거리 = 후보 거리, 지상 노출 0, 체크포인트 마지막 = 나갈 곳
//   5) 가던 쪽이 막힘(아직 아무 곳도 확인 전): 반대쪽으로 다시 찾기
//   6) 갈림길 체크포인트(강동→둔촌동)와 갈림길 뒤 '앞이 막힘'
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
for (const f of ['graph', 'router', 'steps', 'junctions', 'guide', 'exithere']) require(path.join(ROOT, 'web/js', f + '.js'));
const UG = globalThis.UG;
const g = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/data/graph.json'), 'utf8'));
const G = UG.graph.indexGraph(g);
const EGRESS_FILE = path.join(ROOT, 'web/data/egress.json');
const realEgress = fs.existsSync(EGRESS_FILE) ? JSON.parse(fs.readFileSync(EGRESS_FILE, 'utf8')) : null;
const X = UG.exithere, E = g.edges, N = g.nodes;
let ok = true;
const check = (cond, msg) => { console.log((cond ? 'OK  ' : 'NG  ') + msg); ok = ok && cond; };
const km = (m) => (m / 1000).toFixed(2) + 'km';
const st = (n) => ({ kind: 'station', si: UG.graph.findStation(G, n), text: n });
const show = (res) => res.list.slice(0, 6).map((c, i) => `${i + 1}. [${c.kindLabel}] ${c.title} ${Math.round(c.under_m)}m` + (c.extra_m ? ` +기지 ${Math.round(c.extra_m)}m` : '')).join(' / ');
console.log('egress.json: ' + (realEgress ? `있음 (${realEgress.items.length}개)` : '없음 — 예시만 씀'));

// 경로를 안내 목록까지 만든다(app.js 와 같이: 지하로 길이 없으면 지상 걷기 간선도)
function plan(from, to, blocked) {
  const route = UG.router.findRoute(G, from, to, { blocked }) || UG.router.findRoute(G, from, to, { blocked, surface: true });
  if (!route) return null;
  return UG.steps.planItems(G, { from, to, route }, 3.5);
}
// 후보로 다시 찾기 + 경로가 후보 거리와 맞는지
function goTo(name, start, cand, blocked) {
  const from = Object.assign({ label: '지금 위치', text: '지금 위치' }, start);
  const p = plan(from, { kind: 'egress', cand, lat: cand.lat, lon: cand.lon, text: cand.title, label: cand.title }, blocked);
  if (!p) { check(false, `${name}: ${cand.title}까지 경로 없음`); return null; }
  const cps = UG.guide.buildCheckpoints(G, p);
  const last = cps[cps.length - 1];
  const want = cand.under_m + cand.extra_m;
  check(Math.abs(p.view.total_m - want) < 1.5 && Math.round(p.route.exposed_m - cand.extra_m) === 0 && Math.abs(last.at - p.view.total_m) < 1.5,
    `${name}: ${cand.title}까지 다시 찾음 ${km(p.view.total_m)} (후보 ${km(want)}), 지상 ${Math.round(p.route.exposed_m)}m, 체크포인트 ${cps.length}개 마지막 '${last.label}'`);
  return { p, cps };
}

/* ---------- 1) 공덕~마포 터널 한가운데 ---------- */
const pGM = plan(st('공덕'), st('마포'));
const cGM = UG.guide.buildCheckpoints(G, pGM);
const midM = cGM[cGM.length - 1].at / 2;
const here = UG.guide.locateOnPath(G, pGM, midM);
check(here && here.kind === 'edgept' && E.k[here.e] === G.codes.track, `공덕→마포 ${km(midM)} 지점 = 선로 간선 ${here.e} t=${here.t.toFixed(3)} (${here.lat.toFixed(5)}, ${here.lon.toFixed(5)})`);
for (const [label, eg] of [['egress.json 있음', realEgress], ['egress.json 없음', null]]) {
  const t0 = Date.now();
  const res = X.findExits(G, here, { egress: eg, limit: 10 });
  console.log(`  ${label} (${Date.now() - t0}ms): ${show(res)}`);
  const names = res.list.map((c) => c.title);
  const sorted = res.list.every((c, i) => i === 0 || res.list[i - 1].under_m <= c.under_m);
  check(res.list.length >= 2 && sorted && res.list.every((c) => c.under_m <= X.MAX_M),
    `${label}: 후보 ${res.list.length}개, 지하 거리 순, 모두 5km 안`);
  check(names.some((n) => n.indexOf('공덕역') === 0) && names.some((n) => n.indexOf('마포역') === 0), `${label}: 공덕역·마포역 출구가 둘 다 있음`);
  const perSt = {};
  res.list.filter((c) => c.k === 'exit').forEach((c) => { perSt[c.si] = (perSt[c.si] || 0) + 1; });
  check(Object.values(perSt).every((n) => n <= 2), `${label}: 한 역의 출구는 2개까지`);
  if (!eg) check(res.list.every((c) => c.k === 'exit'), '없음: 역 출구만');
}
// 가장 가까운 출구로 다시 찾기
const resGM = X.findExits(G, here, { egress: realEgress });
const goGM = goTo('공덕~마포 한가운데', here, resGM.list[0]);
check(goGM && goGM.p.items[0].kind === 'approach' && goGM.p.items[goGM.p.items.length - 1].kind === 'egress' && goGM.cps[goGM.cps.length - 1].kind === 'exit',
  '안내 목록: 처음 = 선로 따라 첫 노드까지(approach), 끝 = 나갈 곳(egress), 마지막 확인 = 출구로 나감');
// 경로 위 거리 -> 위치 -> 다시 경로 위 거리
const track = UG.guide.routeTrack(G, pGM);
const back = UG.guide.projectOnTrack(track, here.lat, here.lon);
check(Math.abs(back.m - midM) < 2 && back.off < 1, `경로 위 거리 ${Math.round(midM)}m -> 위치 -> ${Math.round(back.m)}m (벗어남 ${back.off.toFixed(1)}m)`);

/* ---------- 2) 터널 출입구 가까이 ---------- */
// egress.json 이 없으면 그래프의 터널 출입구 노드(f & 1)로 예시를 만든다
function portalFixture() {
  for (let e = 0; e < E.a.length; e++) {
    if (E.k[e] !== G.codes.track || E.s[e] !== g.tables.structs.indexOf('tunnel') || E.len[e] < 600 || E.svc[e] !== 0) continue;
    const v = (N.f[E.b[e]] & 1) ? E.b[e] : (N.f[E.a[e]] & 1) ? E.a[e] : -1;
    if (v < 0 || UG.graph.haversine(N.lat[v] / 1e5, N.lon[v] / 1e5, 37.55, 126.98) > 30000) continue;
    return { k: 'portal', name: '예시 터널 출입구', lat: N.lat[v] / 1e5, lon: N.lon[v] / 1e5, node: v, edge: e, t: v === E.a[e] ? 0 : 1, lines: [], note: '바깥: 지상' };
  }
  return null;
}
const portal = realEgress ? realEgress.items.find((it) => it.k === 'portal' && it.edge != null && E.len[it.edge] > 600 &&
  UG.graph.haversine(it.lat, it.lon, 37.55, 126.98) < 30000) : portalFixture();
for (const [label, eg] of [['egress.json', realEgress || { items: [portal] }], ['예시', { format: 'egress-1', items: [portalFixture()] }]]) {
  const it = eg.items.find((x) => x.k === 'portal' && x.edge != null && E.len[x.edge] > 600 && UG.graph.haversine(x.lat, x.lon, 37.55, 126.98) < 30000);
  const near = { kind: 'edgept', e: it.edge, t: it.t === 0 ? 0.08 : 0.92, si: -1 };   // 출입구에서 간선의 8% 안쪽
  const res = X.findExits(G, near, { egress: eg });
  console.log(`  ${label} ${it.name} 가까이: ${show(res)}`);
  check(res.list[0] && res.list[0].k === 'portal' && res.list[0].item === it && Math.abs(res.list[0].under_m - 0.08 * E.len[it.edge]) < 1,
    `${label}: 1순위 = 그 터널 출입구 ${res.list[0] ? Math.round(res.list[0].under_m) : '-'}m (기대 ${Math.round(0.08 * E.len[it.edge])}m), 메모 '${res.list[0] && res.list[0].note}'`);
  if (res.list[0]) goTo(label + ' 터널 출입구', near, res.list[0]);
}

/* ---------- 3) 긴 터널 한가운데 수직구(같은 간선 위) ---------- */
let longE = -1;
for (let e = 0; e < E.a.length; e++) {
  if (E.k[e] === G.codes.track && E.s[e] === g.tables.structs.indexOf('tunnel') && E.svc[e] === 0 && (longE < 0 || E.len[e] > E.len[longE])) longE = e;
}
const shaftFixture = { k: 'shaft', name: '예시 수직구(가장 긴 터널 간선)', lat: 0, lon: 0, node: null, edge: longE, t: 0.6, lines: [], note: '', also: [] };
{ const pts = UG.graph.edgeShape(g, longE), cum = UG.graph.cumulative(pts), p = UG.graph.pointAlong(pts, cum, 0.6 * cum[cum.length - 1]); shaftFixture.lat = p[0]; shaftFixture.lon = p[1]; }
const realShafts = realEgress ? realEgress.items.filter((it) => it.k === 'shaft' || it.k === 'emergency_exit') : [];
console.log(`  egress.json 수직구·비상 출구 ${realShafts.length}개` + (realShafts.length ? ': ' + realShafts.slice(0, 3).map((s) => `${s.name} (간선 ${s.edge}, ${Math.round(E.len[s.edge])}m)`).join(', ') : ''));
const shaftCases = [['예시', shaftFixture, 0.6 - 2000 / E.len[longE]]];   // 수직구에서 2km 떨어진 곳
if (realShafts.length) { const s = realShafts.slice().sort((a, b) => E.len[b.edge] - E.len[a.edge])[0]; shaftCases.push(['egress.json', s, s.t > 0.5 ? s.t - 0.3 : s.t + 0.3]); }
for (const [label, sh, t] of shaftCases) {
  const pos = { kind: 'edgept', e: sh.edge, t: Math.max(0, Math.min(1, t)), si: -1 };
  const res = X.findExits(G, pos, { egress: { items: [sh] } });
  const c = res.list.find((x) => x.item === sh);
  const want = Math.abs(sh.t - pos.t) * E.len[sh.edge];
  console.log(`  ${label} 간선 ${sh.edge} (${km(E.len[sh.edge])}) t=${pos.t.toFixed(2)}: ${show(res)}`);
  check(c && Math.abs(c.under_m - want) < 1, `${label}: 같은 간선 위 수직구까지 ${c ? Math.round(c.under_m) : '-'}m (기대 ${Math.round(want)}m)`);
  if (c) {
    const r = goTo(label + ' 수직구', pos, c);
    check(r && r.p.route.path.length === 0 && r.p.items.length === 2, `${label}: 노드를 거치지 않고 간선을 따라 바로 감(경로 간선 0개, 안내 2줄)`);
  }
}

/* ---------- 3b) 차량기지(egress.json 에서 지하로 닿는 곳이 있으면) ---------- */
if (realEgress) {
  const depots = realEgress.items.filter((it) => it.k === 'depot' && it.approach === 'tunnel');
  let tried = 0;
  // 기지에서 3km 안의 지하역에서 출발해 지하로 닿는 기지를 하나 찾는다
  for (const d of depots) {
    const near = g.stations.map((s, si) => [si, UG.graph.haversine(d.lat, d.lon, s.lat / 1e5, s.lon / 1e5)])
      .filter((x) => x[1] < 3000 && g.stations[x[0]].ug.some((u) => u === 1)).sort((a, b) => a[1] - b[1]);
    for (const [si] of near) {
      const res = X.findExits(G, { kind: 'station', si }, { egress: { items: [d] } });
      const c = res.list.find((x) => x.item === d);
      if (!c) continue;
      tried++;
      console.log(`  ${g.stations[si].name}역에서 ${d.name}: 지하 ${Math.round(c.under_m)}m + 기지 안 지상 ${Math.round(c.extra_m)}m`);
      goTo('차량기지', { kind: 'station', si }, c);
      break;
    }
    if (tried) break;
  }
  console.log(`  지하로 들어가는 차량기지 ${depots.length}곳 중 시험 ${tried}곳`);
}

/* ---------- 4) 역에서(역 시트): 그 역의 출구는 더 많이 ---------- */
{
  const si = UG.graph.findStation(G, '서울역');
  const res = X.findExits(G, { kind: 'station', si }, { egress: realEgress, ownSi: si, limit: 12 });
  const own = res.list.filter((c) => c.si === si).length;
  console.log(`  서울역에서: ${show(res)}`);
  check(own >= 3 && res.list[0].si === si && res.list[0].under_m < 400, `서울역 시트: 서울역 출구 ${own}개(2개 제한 없음), 1순위 ${res.list[0].title} ${Math.round(res.list[0].under_m)}m`);
}

/* ---------- 5) 가던 쪽이 막힘(아직 아무 곳도 확인 전) ---------- */
{
  const r = goGM;
  const b = UG.guide.planBlock(G, { plan: r.p, cps: r.cps, cur: -1 }, 100);
  const sp = r.p.route.startPart;
  check(!b.error && b.edges.has(sp.e) && b.from && b.from.kind === 'edgept' && b.from.only != null && b.from.only !== (sp.t1 === 0 ? E.a[sp.e] : E.b[sp.e]),
    `가던 쪽 막힘: 첫 간선 ${sp.e} 포함 ${b.edges.size}개 막음, 반대쪽 끝(노드 ${b.from && b.from.only})으로만 다시 찾음, 되돌아감 ${Math.round(b.backtrack)}m`);
  const res = X.findExits(G, b.from, { egress: realEgress, blocked: b.edges });
  const p2 = res.list.length && plan(b.from, { kind: 'egress', cand: res.list[0], lat: res.list[0].lat, lon: res.list[0].lon, text: res.list[0].title }, b.edges);
  check(!!p2 && p2.route.path.every((x) => !b.edges.has(x.e)) && p2.route.startPart.t1 !== sp.t1,
    `반대쪽 1순위 ${res.list[0] && res.list[0].title} ${res.list[0] && Math.round(res.list[0].under_m)}m: 막은 간선을 지나지 않고 반대 방향으로 감`);
}

/* ---------- 6) 갈림길 체크포인트(강동→둔촌동)와 갈림길 뒤 '앞이 막힘' ---------- */
{
  const p = plan(st('강동'), st('둔촌동'));
  const cps = UG.guide.buildCheckpoints(G, p);
  console.log('  체크포인트: ' + cps.map((c) => `${c.label}(${Math.round(c.at)})`).join(' → '));
  const ji = cps.findIndex((c) => c.kind === 'junction' && c.jn != null);
  const j = ji >= 0 ? p.junctions[cps[ji].jn] : null;
  check(j && Math.abs(cps[ji].at - j.at_m) < 1 && cps[ji].label.indexOf('오른쪽 갈래') >= 0 && cps[ji + 1] && cps[ji + 1].label.indexOf('둔촌동역') === 0,
    `갈림길 체크포인트 '${ji >= 0 ? cps[ji].label : '-'}' at ${ji >= 0 ? Math.round(cps[ji].at) : '-'}m, 다음 = ${cps[ji + 1] ? cps[ji + 1].label : '-'}`);
  const gl = j && UG.junctions.junctionGlyph(j);
  check(gl && gl.branches.length === 2 && gl.branches.find((b) => b.role === 'chosen').x > gl.branches.find((b) => b.role === 'alt').x,
    'Y자 그림: 고른 갈래(둔촌동)가 오른쪽');
  // 갈림길을 '통과'한 뒤 앞이 막힘 -> 갈림길에서 다시 찾기
  const b = UG.guide.planBlock(G, { plan: p, cps, cur: ji }, 50);
  const blocked = new Set(b.edges);
  const p2 = b.from && plan(b.from, p.to, blocked);
  check(!b.error && b.from && b.from.node === j.node && b.restartLabel === cps[ji].label,
    `갈림길 뒤 막힘: 간선 ${b.edges.size}개 막음, 다시 출발 = 갈림길 노드 ${b.from && b.from.node}, '${b.restartLabel}'`);
  check(!!p2 && p2.route.path.every((x) => !blocked.has(x.e)),
    p2 ? `갈림길에서 다시 찾음: ${km(p2.view.total_m)}, 지상 ${Math.round(p2.view.exposed_m)}m, ` + p2.items.filter((i) => i.kind === 'step' && i.step.type === 'ride').map((i) => i.step.label + '(' + i.step.from_station + '→' + i.step.to_station + ')').join(' / ') : '갈림길에서 다시 찾기 실패');
}

/* ---------- 7) 긴 터널 단계의 '○○m 앞 비상 출구' ---------- */
{
  const sh = shaftFixture;
  const a = E.a[sh.edge], si = G.nodeStation[a] >= 0 ? G.nodeStation[a] : -1;
  const from = { kind: 'edgept', e: sh.edge, t: 0.05, si: si, label: '시험', text: '시험' };
  const pts = UG.graph.edgeShape(g, sh.edge, E.b[sh.edge]);
  const to = { kind: 'egress', cand: { k: 'portal', title: '끝', si: null, lat: pts[0][0], lon: pts[0][1], target: { node: E.b[sh.edge], m: 0 } }, lat: pts[0][0], lon: pts[0][1], text: '끝' };
  const p = plan(from, to);
  const on = X.onRoute(G, p, { items: [sh] });
  const want = (0.6 - 0.05) * E.len[sh.edge];
  check(on.length === 1 && Math.abs(on[0].at - want) < 1, `경로 위 수직구 위치 ${on[0] ? Math.round(on[0].at) : '-'}m (기대 ${Math.round(want)}m)`);
}

process.exitCode = ok ? 0 : 1;
console.log(ok ? '모두 통과' : '실패 있음');
