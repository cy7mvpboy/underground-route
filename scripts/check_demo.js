// check_demo.js — 시연(web/js/demo.js)의 세 시나리오가 재생할 경로·단계를 앱과 같은 방식으로 계산해 핵심 사실을 확인한다.
// 사용법(프로젝트 폴더에서): node scripts\check_demo.js
// 앱(app.js)이 하는 순서를 그대로 따른다: 지하로 길이 없으면 지상 걷기도 넣어 다시 찾기, 안내 단계(planItems), 체크포인트, 앞이 막힘(planBlock).
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
for (const f of ['graph', 'junctions', 'router', 'exithere', 'steps', 'transfer', 'nearest', 'guide', 'reach', 'saved', 'demo']) require(path.join(ROOT, 'web/js', f + '.js'));
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
const name = (i) => g.stations[i].name;
const st = (q) => { const i = si(q); return { kind: 'station', si: i, text: q, lat: g.stations[i].lat / 1e5, lon: g.stations[i].lon / 1e5 }; };
const rides = (p) => p.items.filter((i) => i.kind === 'step' && i.step.type === 'ride').map((i) => i.step.label + '(' + i.step.from_station + '→' + i.step.to_station + ')').join(' / ');
const han = new Map(g.presets.han_crossings.map((x) => [x.e, x]));

/* ---------- 1) 한 사람의 이야기: 공습경보 → 가장 가까운 지하로 → 가족 약속 장소(수서역)까지 지하로 → 하저터널 막힘 → 다른 하저터널로 다시 찾기 → 그 하저터널 건너기 → 도착 ---------- */
const Y = CONF.story;
console.log(`\n[1] 이야기: ${Y.label} → ${Y.meet.replace(/@.*/, '')}`);

// 1-0. 평소에 저장하는 가족 약속 장소: 시연은 메모리에만 저장한다(브라우저 저장소를 쓰지 않음)
const SV = UG.saved, meetSi = si(Y.meet);
SV.useMemory(true);
const saved = SV.savePlace(SV.FAMILY, { kind: 'station', si: meetSi, title: name(meetSi) + '역', lat: g.stations[meetSi].lat / 1e5, lon: g.stations[meetSi].lon / 1e5 });
const fam = SV.placeByName(SV.FAMILY);
check(saved && !!fam && fam.si === meetSi, `가족 약속 장소 저장(메모리): ${fam ? fam.title : '없음'}`);
SV.useMemory(false);
check(!SV.placeByName(SV.FAMILY), '시연을 끝내면 메모리 목록은 사라짐(보는 사람의 저장소는 그대로)');

// 1-1. 공습경보: 가장 가까운 지하로
const near = UG.nearest.nearestUnderground(G, Y.lat, Y.lon, { limit: 3 });
const o1 = near.options[0];
check(!!o1 && name(o1.si) === '공덕' && o1.kind === 'entrance', `가장 가까운 지하로 후보: ` + near.options.map((o) => `${o.name}역 ${o.ref || ''}${o.ref ? '번' : ''} ${Math.round(o.len)}m`).join(' / '));
const hubLine = (h) => { const s = g.stations[o1.si], j = s.hubs.indexOf(h); return j >= 0 && s.hub_ls ? (g.tables.line_sets[s.hub_ls[j]] || []).map((l) => g.tables.lines[l]).join(',') : ''; };
check(hubLine(o1.hub) === '5호선', `${o1.ref}번 출구는 ${hubLine(o1.hub)} 승강장으로 이어짐(가족 약속 장소까지 타는 노선과 같음)`);
const ep = UG.nearest.endpointsFor(G, Y.lat, Y.lon, o1, Y.label);
const p1 = planOf(ep.from, ep.to);
check(!!p1 && p1.route.endSi === o1.si && Math.abs(p1.view.exposed_m - o1.len) < 1, `경로: ${o1.name}역 ${o1.ref}번 출구까지 지상 ${Math.round(p1.view.exposed_m)}m, 승강장까지 총 ${Math.round(p1.view.total_m)}m`);
const enter = p1.items.find((i) => i.kind === 'enter');
check(!!enter && enter.conn.kind === 'entrance', `걷는 구간(출발 → 출구) ${Math.round(enter.m)}m + 출구 통로 → 지하 승강장`);
const cps1 = UG.guide.buildCheckpoints(G, p1);
check(cps1.length === 1 && cps1[0].kind === 'end' && cps1[0].si === o1.si, '체크포인트: ' + cps1.map((c) => `${c.label}(${Math.round(c.at)}m)`).join(' → '));

// 1-2. 승강장에서 '가족 약속 장소까지 지하로'(app.js continueTo: 이 역 지하 승강장에서 출발)
const from2 = { kind: 'station', si: o1.si, hubs: UG.reach.underHubs(G, o1.si), text: name(o1.si) + '역 지하 승강장', lat: g.stations[o1.si].lat / 1e5, lon: g.stations[o1.si].lon / 1e5 };
const p2 = planOf(from2, st(Y.meet));
check(!!p2 && p2.view.exposed_m === 0 && p2.route.endSi === meetSi && name(meetSi) === '수서', `가족 약속 장소(${name(meetSi)}역)까지 ${km(p2.view.total_m)}, 지상 ${p2.view.exposed_m}m: ${rides(p2)}`);
check(!!p2 && p2.route.path[0].u === o1.hub, `들어온 승강장(${hubLine(o1.hub)})에서 바로 출발(환승 없이)`);
const cps2 = UG.guide.buildCheckpoints(G, p2);
const at = cps2.findIndex((c) => c.si === si(Y.blockAfter));
check(at >= 0 && at + 1 < cps2.length, `막기 전 마지막 확인 지점 = ${at >= 0 ? cps2[at].label : '없음'}, 다음 = ${at >= 0 && cps2[at + 1] ? cps2[at + 1].label : '없음'}`);
const legM = cps2[at + 1].at - cps2[at].at, walked = legM * Y.blockFrac;
const crossed = UG.demo.hanCrossing(G, p2.route.path);
const crossAt = crossed ? p2.route.path.findIndex((x) => x.e === crossed.e) : -1;
check(!!crossed && crossed.line === '5호선' && crossed.a === '마포' && crossed.b === '여의나루' && cps2[at].pos < crossAt && cps2[at + 1].pos >= crossAt,
  `한강을 건너는 곳(터널 A): ${crossed ? crossed.line + ' ' + crossed.a + '–' + crossed.b + ' 하저터널 (간선 ' + crossed.e + ')' : '없음'} = ${cps2[at].label}과 ${cps2[at + 1].label} 사이`);
info(`막히기 전 걷는 거리 ${km(cps2[at].at + walked)} (확인 지점 ${at + 1}곳)`);

// 1-3. 앞이 막힘 → 마지막 확인 지점(마포)에서 다시 찾기
const b = UG.guide.planBlock(G, { plan: p2, cps: cps2, cur: at }, walked);
const blockedHan = [...b.edges].filter((e) => han.has(e));
check(!b.error && crossed && b.edges.has(crossed.e), `앞이 막힘(터널 ${Math.round(walked)}m 지점): 간선 ${b.edges.size}개 막음, 그중 한강 하저터널 ${blockedHan.join(', ')} · 다시 출발 ${b.from && b.from.label} · 되돌아감 ${Math.round(b.backtrack)}m`);
const extra = [...b.edges].filter((e) => !han.has(e));
check(!extra.length, `한강 하저터널 말고는 막지 않음(이웃 공덕–마포·여의나루–여의도 터널은 그대로)${extra.length ? ': 더 막힌 간선 ' + extra.join(', ') : ''}`);
check(b.from && b.from.si === si(Y.blockAfter), `다시 출발 = ${Y.blockAfter.replace(/@.*/, '')}역(마지막 확인 지점)`);
b.edges.forEach((e) => blocked.add(e));
const p3 = planOf(b.from, p2.to);
check(!!p3, p3 ? `다시 찾음 ${km(p3.view.total_m)}, 지상 ${Math.round(p3.view.exposed_m)}m: ${rides(p3)}` : '다시 찾기 실패');
// 막힘이 눈에 띄게: 마포에서 가는 길이 처음 경로의 나머지보다 꽤 길어진다(한성백제 때는 0.7km 차이라 바꿈, 사용자 결정 2026-11-11)
const restM = p2.view.total_m - cps2[at].at;
check(!!p3 && p3.view.total_m - restM > 3000, `마포에서 수서까지: 처음 경로 나머지 ${km(restM)} → 다시 찾은 길 ${km(p3 ? p3.view.total_m : 0)} (${km(p3 ? p3.view.total_m - restM : 0)} 더, 되돌아가기 ${Math.round(b.backtrack)}m 따로)`);
check(p3 && p3.route.path.every((x) => !blocked.has(x.e)), '다시 찾은 경로는 막은 간선을 쓰지 않음');
check(p3 && p3.route.endSi === meetSi, `다시 찾은 경로의 도착 = ${p3 ? name(p3.route.endSi) : '-'}`);
check(p3 && p3.view.exposed_m === 0, `다시 찾은 경로의 지상 노출 ${p3 ? Math.round(p3.view.exposed_m) : '-'}m (전 구간 지하)`);
const cross2 = p3 && UG.demo.hanCrossing(G, p3.route.path);
const cross2At = cross2 ? p3.route.path.findIndex((x) => x.e === cross2.e) : -1;
check(!!cross2 && !blocked.has(cross2.e) && han.get(cross2.e).s === 'tunnel' && cross2.line === '5호선' && cross2.a === '광나루' && cross2.b === '천호',
  `한강 아래 다른 하나(터널 B): ${cross2 ? cross2.line + ' ' + cross2.a + '–' + cross2.b + ' 하저터널 (간선 ' + cross2.e + ')' : '없음'}`);
// '두 곳뿐': 5호선 하저터널 두 곳을 다 막으면 마포에서 가족 약속 장소까지 지상을 걷지 않고는 갈 수 없다
const both = new Set(blocked);
[...han.values()].filter((x) => x.s === 'tunnel' && (x.lines || []).includes('5호선')).forEach((x) => both.add(x.e));
const pNone = UG.router.findRoute(G, b.from, p2.to, { blocked: both }) || UG.router.findRoute(G, b.from, p2.to, { blocked: both, surface: true });
check(!!pNone && pNone.exposed_m > 0, `5호선 하저터널 두 곳을 다 막으면: 가장 나은 길도 지상 노출 ${pNone ? Math.round(pNone.exposed_m) + 'm' : '-'} (이 길에서 한강을 지하로만 건너는 곳은 이 두 곳뿐)`);
const alt3 = p3 && UG.router.alternative(G, b.from, p2.to, p3.route, { blocked, speedKmh: SPEED });
info(`길 안내 카드의 대안 경로 한 줄: ${alt3 ? '지상 ' + Math.round(alt3.extra_m) + 'm 더, ' + km(alt3.saved_m) + ' 짧음, ' + Math.round(alt3.saved_min) + '분 단축(시연은 잠깐 짚고 지하 우선으로 계속)' : '없음(시연은 대안 한 줄 없이 지나감)'}`);
const cps3 = p3 ? UG.guide.buildCheckpoints(G, p3) : [];
check(cps3.length > 0 && cps3[cps3.length - 1].kind === 'end' && cps3[cps3.length - 1].si === meetSi, `다시 찾은 경로 체크포인트 ${cps3.length}개, 마지막 = ${cps3.length ? cps3[cps3.length - 1].label : '-'}`);

// 1-4. 다른 하저터널 건너기: 시연은 광나루역까지 빨리 감고, 광나루 → 천호(하저터널)를 걸어서 건넌 뒤 도착까지 빨리 감는다
const ka = cps3.findIndex((c) => cross2 && c.si === cross2.sa && c.kind === 'station');
const kb = ka >= 0 ? ka + 1 : -1;
check(ka >= 0 && cps3[kb] && cps3[kb].si === cross2.sb && cps3[ka].pos < cross2At && cps3[kb].pos >= cross2At,
  ka >= 0 ? `건너는 구간: ${cps3[ka].label}(${km(cps3[ka].at)}) → ${cps3[kb].label}(${km(cps3[kb].at)}), ${Math.round(cps3[kb].at - cps3[ka].at)}m` : '광나루–천호 체크포인트 없음');
// 다시 찾은 길에는 갈림길 체크포인트가 없다(그래서 시연에 갈림길 장면이 없다)
check(cps3.every((c) => c.kind !== 'junction'), `다시 찾은 길의 갈림길 체크포인트 ${cps3.filter((c) => c.kind === 'junction').length}개(갈림길 장면 없음)`);

// 1-5. 도착: 지하에 들어간 뒤 지상 노출(처음 경로 + 다시 찾은 경로) 0m
check(p2.view.exposed_m + (p3 ? p3.view.exposed_m : 1) === 0, `도착 ${name(meetSi)}역 · 지하에 들어간 뒤 지상 노출 0m (공습경보 뒤 지상은 처음 출구까지 ${Math.round(o1.len)}m)`);
const B = CONF.boost, mps = SPEED / 3.6 * 60;   // ×60 일 때 1배속 1초에 걷는 m
const aAt = ka >= 0 ? cps3[ka].at : 0, bAt = kb >= 0 ? cps3[kb].at : 0;
const walkSec = p1.view.total_m / (mps * B.enter) + (cps2[at].at + walked) / (mps * B.move) + aAt / (mps * B.ff) + (bAt - aAt) / (mps * B.cross) + (p3 ? p3.view.total_m - bAt : 0) / (mps * B.arrive);
info(`재생 시간(×60): 걷기 약 ${Math.round(walkSec)}초 (+ 장면마다 멈춤, 전체는 헤드리스 Chrome 으로 잼)`);
blocked.clear();

/* ---------- 2) 부산역 → 해운대 (길고, 전 구간 지하, 환승 있음) ---------- */
console.log('\n[2] ' + CONF.busan.label);
const p4 = planOf(st(CONF.busan.from), st(CONF.busan.to));
const xf4 = p4 ? p4.items.filter((i) => i.kind === 'step' && i.step.type === 'transfer').length : 0;
check(!!p4 && p4.view.exposed_m === 0, `${km(p4.view.total_m)}, 지상 노출 ${p4.view.exposed_m}m, 약 ${Math.round(p4.view.minutes)}분: ${rides(p4)}`);
check(!!p4 && p4.view.total_m >= 15000 && xf4 >= 1, `15km 이상(${km(p4.view.total_m)}), 환승 ${xf4}번`);
const cps4 = UG.guide.buildCheckpoints(G, p4);
check(cps4[cps4.length - 1].si === si(CONF.busan.to), `체크포인트 ${cps4.length}개: ` + cps4.map((c) => c.label).join(' → '));
const walkSec4 = p4.view.total_m / (SPEED / 3.6 * 60 * CONF.boost.busan), xfHold4 = cps4.filter((c) => c.kind === 'transfer').length * CONF.busan.xferHold / 1000;
info(`재생 시간(×60): 걷기 약 ${Math.round(walkSec4)}초 + 환승 멈춤 ${xfHold4}초`);

/* ---------- 3) 서울역 → 부산역 ---------- */
console.log('\n[3] 서울역 → 부산역');
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
