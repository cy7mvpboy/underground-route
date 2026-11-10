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

/* ---------- 2) 공덕 → 한성백제: 한강 하저터널 막힘 → 다른 하저터널로 재탐색 → 갈림길 통과 → 도착 ---------- */
console.log('\n[2] 공덕 → 한성백제, 하저터널 막힘 + 재탐색 + 갈림길');
const M = CONF.move;
const p2 = planOf(st(M.from), st(M.to));
check(!!p2 && p2.view.exposed_m === 0, `처음 경로 ${km(p2.view.total_m)}, 지상 ${p2.view.exposed_m}m: ${rides(p2)}`);
const cps2 = UG.guide.buildCheckpoints(G, p2);
const at = cps2.findIndex((c) => c.si === si(M.blockAfter));
check(at >= 0 && at + 1 < cps2.length, `막기 전 마지막 확인 지점 = ${at >= 0 ? cps2[at].label : '없음'}, 다음 = ${at >= 0 && cps2[at + 1] ? cps2[at + 1].label : '없음'}`);
const legM = cps2[at + 1].at - cps2[at].at, walked = legM * M.blockFrac;
const han = new Map(g.presets.han_crossings.map((x) => [x.e, x]));
const crossed = UG.demo.hanCrossing(G, p2.route.path);
const crossAt = crossed ? p2.route.path.findIndex((x) => x.e === crossed.e) : -1;
check(!!crossed && crossed.line === '5호선' && crossed.a === '마포' && crossed.b === '여의나루' && cps2[at].pos < crossAt && cps2[at + 1].pos >= crossAt,
  `처음 경로가 지나는 한강 하저터널: ${crossed ? crossed.line + ' ' + crossed.a + '–' + crossed.b + ' (간선 ' + crossed.e + ')' : '없음'} = ${cps2[at].label}과 ${cps2[at + 1].label} 사이`);
// 갈림길은 막힌 뒤 다시 찾은 길에서 보인다(설계): 막기 전 구간에는 갈림길 체크포인트가 없다
check(cps2.slice(0, at + 2).every((c) => c.kind !== 'junction'), `막기 전(출발 ~ ${cps2[at + 1].label})에는 갈림길 없음`);
const pre = cps2[at].at + walked;
info(`막히기 전 걷는 거리 ${km(pre)} (확인 지점 ${at + 1}곳)`);
const b = UG.guide.planBlock(G, { plan: p2, cps: cps2, cur: at }, walked);
const blockedHan = [...b.edges].filter((e) => han.has(e));
check(!b.error && crossed && b.edges.has(crossed.e), `앞이 막힘(터널 ${Math.round(walked)}m 지점): 간선 ${b.edges.size}개 막음, 그중 한강 하저터널 ${blockedHan.join(', ')} · 다시 출발 ${b.from && b.from.label} · 되돌아감 ${Math.round(b.backtrack)}m`);
const extra = [...b.edges].filter((e) => !han.has(e));
check(!extra.length, `한강 하저터널 말고는 막지 않음(이웃 공덕–마포·여의나루–여의도 터널은 그대로)${extra.length ? ': 더 막힌 간선 ' + extra.join(', ') : ''}`);
check(b.from && b.from.si === si(M.blockAfter), `다시 출발 = ${M.blockAfter.replace(/@.*/, '')}역(마지막 확인 지점)`);
b.edges.forEach((e) => blocked.add(e));
const p3 = planOf(b.from, p2.to);
check(!!p3, p3 ? `다시 찾음 ${km(p3.view.total_m)}, 지상 ${Math.round(p3.view.exposed_m)}m: ${rides(p3)}` : '다시 찾기 실패');
check(p3 && p3.route.path.every((x) => !blocked.has(x.e)), '다시 찾은 경로는 막은 간선을 쓰지 않음');
check(p3 && p3.route.endSi === si(M.to), `다시 찾은 경로의 도착 = ${p3 ? g.stations[p3.route.endSi].name : '-'}`);
check(p3 && p3.view.exposed_m === 0, `다시 찾은 경로의 지상 노출 ${p3 ? Math.round(p3.view.exposed_m) : '-'}m (전 구간 지하)`);
const cross2 = p3 && UG.demo.hanCrossing(G, p3.route.path);
const cross2At = cross2 ? p3.route.path.findIndex((x) => x.e === cross2.e) : -1;
check(!!cross2 && !blocked.has(cross2.e) && han.get(cross2.e).s === 'tunnel', `다른 한강 하저터널로 건넘: ${cross2 ? cross2.line + ' ' + cross2.a + '–' + cross2.b + ' (간선 ' + cross2.e + ')' : '없음'}`);
const alt3 = p3 && UG.router.alternative(G, b.from, p2.to, p3.route, { blocked, speedKmh: SPEED });
info(`길 안내 카드의 대안 경로 한 줄: ${alt3 ? '지상 ' + Math.round(alt3.extra_m) + 'm 더, ' + km(alt3.saved_m) + ' 짧음, ' + Math.round(alt3.saved_min) + '분 단축(시연은 잠깐 짚고 지하 우선으로 계속)' : '없음(시연은 대안 한 줄 없이 지나감)'}`);
const cps3 = p3 ? UG.guide.buildCheckpoints(G, p3) : [];
check(cps3.length > 0 && cps3[cps3.length - 1].kind === 'end', `다시 찾은 경로 체크포인트 ${cps3.length}개(빨리 감기 동안 '도착'을 이만큼 누름)`);
// 갈림길: 다시 찾은 길에서 하저터널을 건넌 뒤 처음 만나는 갈림길 = 강동 지나 5호선 본선(길동)과 마천지선(둔촌동)이 갈라지는 곳
const jk = cps3.findIndex((c) => c.kind === 'junction' && c.jn != null);
const jn = jk >= 0 ? p3.junctions[cps3[jk].jn] : null;
check(!!jn && jn.pos > cross2At && jk < cps3.length - 1, jn ? `갈림길 체크포인트(다시 찾은 길 ${km(cps3[jk].at)} 지점, 하저터널 뒤): ${UG.junctions.junctionText(jn)}` : '다시 찾은 길에 갈림길 없음');
check(!!jn && jn.chosen.kind === 'line' && jn.alternatives.length === 1 && jn.alternatives[0].kind === 'line' && /마천지선/.test(jn.chosen.name + ' ' + jn.alternatives[0].name),
  jn ? `갈래 두 개 모두 노선 선로: 갈 쪽 ${jn.chosen.side} ${jn.chosen.name}(${jn.chosen.toward}), 다른 쪽 ${jn.alternatives.map((a) => a.side + ' ' + a.name + '(' + a.toward + ')').join(', ')}` : '갈래 없음');
check(cps3.filter((c) => c.kind === 'junction').length === 1, `다시 찾은 길의 갈림길은 이곳 하나('통과' 한 번)`);
const B = CONF.boost, mps = SPEED / 3.6 * 60;   // ×60 일 때 1배속 1초에 걷는 m
const jAt = jk >= 0 ? cps3[jk].at : 0, before = jk > 0 ? cps3[jk - 1].at : 0;
const walkSec2 = cps2[at].at / (mps * B.move) + walked / (mps * B.move) + before / (mps * B.ff) + (jAt - before) / (mps * B.fork) + (p3 ? p3.view.total_m - jAt : 0) / (mps * B.arrive);
info(`재생 시간(×60): 걷기 약 ${Math.round(walkSec2)}초 (+ 장면마다 멈춤)`);
blocked.clear();

/* ---------- 3) 부산역 → 해운대 (길고, 전 구간 지하, 환승 있음) ---------- */
console.log('\n[3] ' + CONF.busan.label);
const p4 = planOf(st(CONF.busan.from), st(CONF.busan.to));
const xf4 = p4 ? p4.items.filter((i) => i.kind === 'step' && i.step.type === 'transfer').length : 0;
check(!!p4 && p4.view.exposed_m === 0, `${km(p4.view.total_m)}, 지상 노출 ${p4.view.exposed_m}m, 약 ${Math.round(p4.view.minutes)}분: ${rides(p4)}`);
check(!!p4 && p4.view.total_m >= 15000 && xf4 >= 1, `15km 이상(${km(p4.view.total_m)}), 환승 ${xf4}번`);
const cps4 = UG.guide.buildCheckpoints(G, p4);
check(cps4[cps4.length - 1].si === si(CONF.busan.to), `체크포인트 ${cps4.length}개: ` + cps4.map((c) => c.label).join(' → '));
const walkSec4 = p4.view.total_m / (SPEED / 3.6 * 60 * CONF.boost.busan), xfHold4 = cps4.filter((c) => c.kind === 'transfer').length * CONF.busan.xferHold / 1000;
info(`재생 시간(×60): 걷기 약 ${Math.round(walkSec4)}초 + 환승 멈춤 ${xfHold4}초`);

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
