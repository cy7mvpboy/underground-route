// check_demo.js — 시연(web/js/demo.js)의 네 시나리오가 재생할 경로·단계를 앱과 같은 방식으로 계산해 핵심 사실을 확인한다.
// 사용법(프로젝트 폴더에서): node scripts\check_demo.js
// 앱(app.js)이 하는 순서를 그대로 따른다: 지하로 길이 없으면 지상 걷기도 넣어 다시 찾기, 안내 단계(planItems), 체크포인트, 앞이 막힘(planBlock).
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
for (const f of ['graph', 'junctions', 'router', 'exithere', 'steps', 'transfer', 'nearest', 'guide', 'reach', 'demo']) require(path.join(ROOT, 'web/js', f + '.js'));
const UG = globalThis.UG;
const CONF = UG.demo.CONF;
const g = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/data/graph.json'), 'utf8'));
const G = UG.graph.indexGraph(g);
const SPEED = CONF.speedKmh;
let ok = true;
const check = (cond, msg) => { console.log((cond ? 'OK  ' : 'NG  ') + msg); ok = ok && cond; };
const info = (msg) => console.log('    ' + msg);
const km = (m) => (m / 1000).toFixed(1) + 'km';

const blocked = new Set();
function planOf(from, to) {   // app.js update() 와 같은 순서
  const route = UG.router.findRoute(G, from, to, { blocked }) || UG.router.findRoute(G, from, to, { blocked, surface: true });
  if (!route) return null;
  const p = { from, to, route };
  UG.steps.planItems(G, p, SPEED);
  return p;
}
const si = (q) => UG.graph.findStation(G, q);
const st = (q) => { const i = si(q); return { kind: 'station', si: i, text: q, lat: g.stations[i].lat / 1e5, lon: g.stations[i].lon / 1e5 }; };
const rides = (p) => p.items.filter((i) => i.kind === 'step' && i.step.type === 'ride').map((i) => i.step.label + '(' + i.step.from_station + '→' + i.step.to_station + ')').join(' / ');

/* ---------- 1) 공습 → 가장 가까운 지하로 → 갈 수 있는 곳 ---------- */
console.log('\n[1] 시청 앞 공습');
const R = CONF.raid;
const near = UG.nearest.nearestUnderground(G, R.lat, R.lon, { limit: 3 });
check(near.options.length > 0, `가장 가까운 지하로 후보 ${near.options.length}곳: ` + near.options.map((o) => `${o.name}역 ${o.ref || ''}${o.ref ? '번' : ''} ${Math.round(o.len)}m`).join(' / '));
const o1 = near.options[0];
const ep = UG.nearest.endpointsFor(G, R.lat, R.lon, o1, R.label);
const p1 = planOf(ep.from, ep.to);
check(!!p1 && p1.route.endSi === o1.si && Math.abs(p1.view.exposed_m - o1.len) < 1, `경로: ${o1.name}역 ${o1.ref}번 출구까지 지상 ${Math.round(p1.view.exposed_m)}m, 총 ${Math.round(p1.view.total_m)}m`);
const enter = p1.items.find((i) => i.kind === 'enter');
check(!!enter && enter.conn.kind === 'entrance', `걷는 구간(출발 → 출구) ${Math.round(enter.m)}m + 출구 통로 → 지하 승강장`);
const cps1 = UG.guide.buildCheckpoints(G, p1);
check(cps1.length >= 1 && cps1[cps1.length - 1].kind === 'end' && cps1[cps1.length - 1].si === o1.si, '체크포인트: ' + cps1.map((c) => `${c.label}(${Math.round(c.at)}m)`).join(' → '));
const reach1 = UG.reach.reachFrom(G, o1.si, { speedKmh: SPEED });
check(reach1.counts.every((n, i) => n > 0 && (i === 0 || n >= reach1.counts[i - 1])), `갈 수 있는 곳(30분·1시간·2시간·4시간): ${reach1.counts.join(' · ')}곳`);
const segs1 = UG.reach.segments(G, reach1);
check(segs1.length === 4 && segs1.every((s) => s.length > 0), `시간대별 선 조각: ${segs1.map((s) => s.length).join(' · ')}개 (띠마다 칠할 선 있음)`);

/* ---------- 2) 여의도 → 광화문, 한강 하저터널 막힘 → 재탐색 ---------- */
console.log('\n[2] 여의도 → 광화문, 막힘 + 재탐색');
const M = CONF.move;
const p2 = planOf(st(M.from), st(M.to));
check(!!p2 && p2.view.exposed_m === 0, `처음 경로 ${km(p2.view.total_m)}, 지상 ${p2.view.exposed_m}m: ${rides(p2)}`);
const cps2 = UG.guide.buildCheckpoints(G, p2);
const at = cps2.findIndex((c) => c.si === si(M.blockAfter));
check(at >= 0 && at + 1 < cps2.length, `막기 전 마지막 확인 지점 = ${at >= 0 ? cps2[at].label : '없음'}, 다음 = ${at >= 0 && cps2[at + 1] ? cps2[at + 1].label : '없음'}`);
const legM = cps2[at + 1].at - cps2[at].at, walked = legM * M.blockFrac;
const han = new Map(g.presets.han_crossings.map((x) => [x.e, x]));
const crossed = UG.demo.hanCrossing(G, p2.route.path);
check(!!crossed, `처음 경로가 지나는 한강 하저터널: ${crossed ? crossed.line + ' ' + crossed.a + '–' + crossed.b + ' (간선 ' + crossed.e + ')' : '없음'}`);
const b = UG.guide.planBlock(G, { plan: p2, cps: cps2, cur: at }, walked);
const blockedHan = [...b.edges].filter((e) => han.has(e));
check(!b.error && crossed && b.edges.has(crossed.e), `앞이 막힘(터널 ${Math.round(walked)}m 지점): 간선 ${b.edges.size}개 막음, 그중 한강 하저터널 ${blockedHan.join(', ')} · 다시 출발 ${b.from && b.from.label} · 되돌아감 ${Math.round(b.backtrack)}m`);
const extra = [...b.edges].filter((e) => !han.has(e));
check(!extra.length, `한강 하저터널 말고는 막지 않음(이웃 여의도–여의나루 터널은 그대로)${extra.length ? ': 더 막힌 간선 ' + extra.join(', ') : ''}`);
b.edges.forEach((e) => blocked.add(e));
const p3 = planOf(b.from, p2.to);
check(!!p3, p3 ? `다시 찾음 ${km(p3.view.total_m)}, 지상 ${Math.round(p3.view.exposed_m)}m: ${rides(p3)}` : '다시 찾기 실패');
check(p3 && p3.route.path.every((x) => !blocked.has(x.e)), '다시 찾은 경로는 막은 간선을 쓰지 않음');
check(p3 && p3.route.endSi === si(M.to), `다시 찾은 경로의 도착 = ${p3 ? g.stations[p3.route.endSi].name : '-'}`);
const cross2 = p3 && UG.demo.hanCrossing(G, p3.route.path);
check(!!cross2 && !blocked.has(cross2.e), `다른 하저터널로 한강을 건넘: ${cross2 ? cross2.line + ' ' + cross2.a + '–' + cross2.b + ' (간선 ' + cross2.e + ')' : '없음'}`);
check(p3 && p3.view.exposed_m === 0, `다시 찾은 경로도 지상 노출 ${p3 ? Math.round(p3.view.exposed_m) : '-'}m`);
const cps3 = p3 ? UG.guide.buildCheckpoints(G, p3) : [];
check(cps3.length > 0 && cps3[cps3.length - 1].kind === 'end', `다시 찾은 경로 체크포인트 ${cps3.length}개(빨리 감기 동안 '도착'을 이만큼 누름)`);
blocked.clear();

/* ---------- 3) 부산 서면 → 부산역 ---------- */
console.log('\n[3] 부산 서면 → 부산역');
const p4 = planOf(st(CONF.busan.from), st(CONF.busan.to));
check(!!p4 && p4.view.exposed_m === 0, `${km(p4.view.total_m)}, 지상 노출 ${p4.view.exposed_m}m, 약 ${Math.round(p4.view.minutes)}분: ${rides(p4)}`);
const cps4 = UG.guide.buildCheckpoints(G, p4);
check(cps4[cps4.length - 1].si === si(CONF.busan.to), '체크포인트: ' + cps4.map((c) => c.label).join(' → '));

/* ---------- 4) 서울역 → 부산역 ---------- */
console.log('\n[4] 서울역 → 부산역');
const p5 = planOf(st(CONF.far.from), st(CONF.far.to));
check(!!p5 && p5.view.exposed_m > 100000, `${km(p5.view.total_m)} 중 지상 노출 ${km(p5.view.exposed_m)} (${Math.round(p5.view.exposed_m / p5.view.total_m * 100)}%)`);
const runs = UG.demo.flightRuns(G, p5.route.path);
const runExpo = runs.reduce((a, r) => a + (r.exposed ? r.len : 0), 0), runTotal = runs.reduce((a, r) => a + r.len, 0);
check(Math.abs(runExpo - p5.view.exposed_m) < 1 && Math.abs(runTotal - p5.view.total_m) < 1, `따라가기 묶음 ${runs.length}개(지상 ${runs.filter((r) => r.exposed).length}개), 묶음 합 = 경로 합`);
check(runs.every((r, i) => i === 0 || Math.abs(r.from - (runs[i - 1].from + runs[i - 1].len)) < 0.01), '묶음이 빈틈 없이 이어짐');
const longest = runs.filter((r) => r.exposed).sort((a, c) => c.len - a.len)[0];
info(`가장 긴 지상 묶음 ${km(longest.len)}, 따라가기 배속(×60 기준 ${CONF.far.flySec}초) ×${Math.round(p5.view.total_m / (SPEED / 3.6) / CONF.far.flySec)}`);

console.log(ok ? '\n모두 통과' : '\n실패한 항목이 있습니다');
process.exit(ok ? 0 : 1);
