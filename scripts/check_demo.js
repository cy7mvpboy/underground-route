// check_demo.js — 시연(web/js/demo.js, 발표 무대에서만 재생)의 이야기가 재생할 경로·단계를 앱과 같은 방식으로 계산해 핵심 사실을 확인한다.
// 부산 시나리오 두 개(부산역 → 해운대, 서울역 → 부산역)는 시연에서 뺐다(2026-11-12). 위급재난문자 흉내의 문구(진짜 경보로 오해하지 않게)도 확인한다.
// 막힌 뒤: 지하로만 다시 찾은 길을 보인 뒤 길 안내 카드의 대안(지상을 조금 걷는 짧은 길)을 눌러 그 길로 간다(2026-11-13, CONF.story.takeAlt).
// 사용법(프로젝트 폴더에서): node scripts\check_demo.js
// 앱(app.js)이 하는 순서를 그대로 따른다: 지하로 길이 없으면 지상 걷기도 넣어 다시 찾기, 안내 단계(planItems), 체크포인트, 앞이 막힘(planBlock).
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
for (const f of ['graph', 'junctions', 'router', 'exithere', 'steps', 'transfer', 'nearest', 'guide', 'reach', 'saved', 'lines', 'panel', 'demo']) require(path.join(ROOT, 'web/js', f + '.js'));
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

/* ---------- 이야기: 공습경보 → 가장 가까운 지하로 → 가족 약속 장소(수서역)까지 지하로 → 선로 갈림길 통과 → 첫 하저터널 막힘
               → 다시 찾기(지하로만 → 대안을 눌러 짧은 길) → 지상 노출 구간 지나기 → 다른 하저터널 건너기 → 도착 → 남쪽으로 이어지는 길 ---------- */
const Y = CONF.story;
console.log(`\n[이야기] ${Y.label} → ${Y.meet.replace(/@.*/, '')}`);

// 0. 평소에 저장하는 가족 약속 장소: 시연은 메모리에만 저장한다(브라우저 저장소를 쓰지 않음)
const SV = UG.saved, meetSi = si(Y.meet);
SV.useMemory(true);
const saved = SV.savePlace(SV.FAMILY, { kind: 'station', si: meetSi, title: name(meetSi) + '역', lat: g.stations[meetSi].lat / 1e5, lon: g.stations[meetSi].lon / 1e5 });
const fam = SV.placeByName(SV.FAMILY);
check(saved && !!fam && fam.si === meetSi, `가족 약속 장소 저장(메모리): ${fam ? fam.title : '없음'}`);
SV.useMemory(false);
check(!SV.placeByName(SV.FAMILY), '시연을 끝내면 메모리 목록은 사라짐(보는 사람의 저장소는 그대로)');

// 0b. 공습 장면 처음의 위급재난문자 흉내: 공개 페이지라 진짜 경보로 오해하지 않게
//     제목에 '시연', 본문은 [시연]으로 시작, 실제 기관 이름·발신 번호 없음. 보여 주는 시간은 실제 시간 2.5~3초
const AL = CONF.alert || {};
const REAL = /행정안전부|행안부|국민재난안전포털|안전디지털플랫폼|재난안전대책본부|소방청|경찰청|기상청|국방부|민방위|시청|구청|군청|도청|\d{2,4}-\d{3,4}|#\d{3,}/;
check(/시연/.test(AL.title || '') && /^\[시연\]/.test(AL.body || '') && !REAL.test((AL.title || '') + ' ' + (AL.body || '')),
  `위급재난문자 흉내: "${AL.title}" / "${AL.body}" (제목·본문에 '시연', 실제 기관 이름·번호 없음)`);
check(AL.ms >= 2500 && AL.ms <= 3000, `위급재난문자 흉내를 보여 주는 시간 ${AL.ms}ms(실제 시간) 뒤 '확인'`);

// 1. 공습경보: 출발 자리는 명동 거리(지도 자료의 'Myeongdong Shopping Street' 지점 바로 그 자리라 자막 '명동 거리'가 맞다)
const PL = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/data/places.json'), 'utf8'));
const mdSt = PL.p.find((x) => x[0] === 'Myeongdong Shopping Street');
const mdD = mdSt ? UG.graph.haversine(Y.lat, Y.lon, mdSt[2] / 1e5, mdSt[3] / 1e5) : Infinity;
check(Y.label === '명동 거리' && mdD < 50, `출발: ${Y.label} (${Y.lat}, ${Y.lon}) — 지도 자료의 명동 거리 지점에서 ${Math.round(mdD)}m`);
// 가장 가까운 지하로 = 명동역 출구, 그 출구는 4호선 승강장으로 이어진다
const near = UG.nearest.nearestUnderground(G, Y.lat, Y.lon, { limit: 3 });
const o1 = near.options[0];
check(!!o1 && name(o1.si) === '명동' && o1.kind === 'entrance', `가장 가까운 지하로 후보: ` + near.options.map((o) => `${o.name}역 ${o.ref || ''}${o.ref ? '번' : ''} ${Math.round(o.len)}m`).join(' / '));
const hubLine = (h) => { const s = g.stations[o1.si], j = s.hubs.indexOf(h); return j >= 0 && s.hub_ls ? (g.tables.line_sets[s.hub_ls[j]] || []).map((l) => g.tables.lines[l]).join(',') : ''; };
check(hubLine(o1.hub) === '4호선', `${o1.ref}번 출구는 ${hubLine(o1.hub)} 승강장으로 이어짐(가족 약속 장소까지 처음 타는 노선과 같음)`);
const ep = UG.nearest.endpointsFor(G, Y.lat, Y.lon, o1, Y.label);
const p1 = planOf(ep.from, ep.to);
check(!!p1 && p1.route.endSi === o1.si && Math.abs(p1.view.exposed_m - o1.len) < 1, `경로: ${o1.name}역 ${o1.ref}번 출구까지 지상 ${Math.round(p1.view.exposed_m)}m, 승강장까지 총 ${Math.round(p1.view.total_m)}m`);
const enter = p1.items.find((i) => i.kind === 'enter');
check(!!enter && enter.conn.kind === 'entrance', `걷는 구간(출발 → 출구) ${Math.round(enter.m)}m + 출구 통로 → 지하 승강장`);
const cps1 = UG.guide.buildCheckpoints(G, p1);
check(cps1.length === 1 && cps1[0].kind === 'end' && cps1[0].si === o1.si, '체크포인트: ' + cps1.map((c) => `${c.label}(${Math.round(c.at)}m)`).join(' → '));

// 2. 승강장에서 '가족 약속 장소까지 지하로'(app.js continueTo: 이 역 지하 승강장에서 출발)
const from2 = { kind: 'station', si: o1.si, hubs: UG.reach.underHubs(G, o1.si), text: name(o1.si) + '역 지하 승강장', lat: g.stations[o1.si].lat / 1e5, lon: g.stations[o1.si].lon / 1e5 };
const p2 = planOf(from2, st(Y.meet));
const xfers = (p) => p.items.filter((i) => i.kind === 'step' && i.step.type === 'transfer').length;
check(!!p2 && p2.view.exposed_m === 0 && p2.route.endSi === meetSi && name(meetSi) === '수서', `가족 약속 장소(${name(meetSi)}역)까지 ${km(p2.view.total_m)}, 지상 ${p2.view.exposed_m}m, 환승 ${xfers(p2)}번: ${rides(p2)}`);
check(!!p2 && p2.route.path[0].u === o1.hub, `들어온 승강장(${hubLine(o1.hub)})에서 바로 출발(환승 없이)`);
const cps2 = UG.guide.buildCheckpoints(G, p2);
const crossed = UG.demo.hanCrossing(G, p2.route.path);
const crossAt = crossed ? p2.route.path.findIndex((x) => x.e === crossed.e) : -1;

// 2-1. 선로 갈림길(시연의 갈림길 장면): 첫 하저터널보다 앞에 있는, 안내가 붙은(jn) 갈림길 체크포인트
const ji = cps2.findIndex((c) => c.kind === 'junction' && c.jn != null);
const jcp = cps2[ji], J = jcp && p2.junctions[jcp.jn];
const toward = (b) => b.toward ? b.toward + ' 방면' : b.name;
check(!!J && ji > 0 && crossAt >= 0 && jcp.pos < crossAt && cps2[ji - 1].kind !== 'junction',
  J ? `갈림길: '${jcp.label}' 출발부터 ${Math.round(jcp.at)}m(${cps2[ji - 1].label} 지나 ${Math.round(jcp.at - cps2[ji - 1].at)}m), 갈 갈래 ${J.chosen.side} = ${toward(J.chosen)} · 다른 갈래 ` +
    J.alternatives.map((a) => `${a.side} = ${a.name}${a.toward ? ' (' + a.toward + ' 방면)' : ''}`).join(', ') + ` · 위치 ${J.lat.toFixed(5)}, ${J.lon.toFixed(5)}` : '첫 하저터널 앞에 안내가 붙은 갈림길 없음');
info(`갈림길 앞 확인 지점: ${cps2.slice(0, ji).map((c) => `${c.label}(${Math.round(c.at)}m)`).join(' → ')}`);

// 2-2. 첫 하저터널 = 광나루–천호. 막기 전 마지막 확인 지점 = blockAfter(광나루), 갈림길 뒤
const at = cps2.findIndex((c) => c.si === si(Y.blockAfter));
check(at > ji && at + 1 < cps2.length, `막기 전 마지막 확인 지점 = ${at >= 0 ? cps2[at].label : '없음'}(갈림길 뒤), 다음 = ${at >= 0 && cps2[at + 1] ? cps2[at + 1].label : '없음'}`);
check(!!crossed && crossed.line === '5호선' && crossed.a === '광나루' && crossed.b === '천호' && cps2[at].pos < crossAt && cps2[at + 1].pos >= crossAt,
  `한강을 처음 건너는 곳(터널 A): ${crossed ? crossed.line + ' ' + crossed.a + '–' + crossed.b + ' 하저터널 (간선 ' + crossed.e + ')' : '없음'} = ${cps2[at].label}과 ${cps2[at + 1].label} 사이`);
const legM = cps2[at + 1].at - cps2[at].at, walked = legM * Y.blockFrac;
info(`막히기 전 걷는 거리 ${km(cps2[at].at + walked)} (확인 지점 ${at + 1}곳), 갈림길에서 ${km(cps2[at].at - jcp.at)} 더 가서 ${cps2[at].label}`);
// 막히는 곳은 강 아래: 한강 중심선(data/raw/han_river.json, 저장소 밖 원자료라 있을 때만)에서 가깝다
const blockPt = UG.guide.pointAt(UG.guide.routeTrack(G, p2), cps2[at].at + walked);
const HAN_RAW = path.join(ROOT, 'data/raw/han_river.json');
// 점 p 에서 꺾은선 line 까지 가장 가까운 거리(m, 짧은 거리라 평면으로 잰다)
function distToLine(p, line) {
  const R = 6371000, r = Math.PI / 180, xy = (q) => [(q[1] - p[1]) * r * Math.cos(p[0] * r) * R, (q[0] - p[0]) * r * R];
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = xy(line[i - 1]), c = xy(line[i]), d = [c[0] - a[0], c[1] - a[1]], L = d[0] * d[0] + d[1] * d[1];
    const t = L > 0 ? Math.max(0, Math.min(1, -(a[0] * d[0] + a[1] * d[1]) / L)) : 0;
    best = Math.min(best, Math.hypot(a[0] + d[0] * t, a[1] + d[1] * t));
  }
  return best;
}
if (fs.existsSync(HAN_RAW)) {
  const line = JSON.parse(fs.readFileSync(HAN_RAW, 'utf8')).elements[0].geometry.map((q) => [q.lat, q.lon]);
  const dC = distToLine(blockPt, line);
  check(dC < 150, `막히는 곳 ${blockPt.map((x) => x.toFixed(5)).join(', ')}: 한강 중심선에서 ${Math.round(dC)}m (강 아래)`);
} else info(`막히는 곳 ${blockPt.map((x) => x.toFixed(5)).join(', ')} (data/raw/han_river.json 이 없어 강 아래인지는 재지 않음)`);

// 3. 앞이 막힘 → 마지막 확인 지점(광나루)에서 다시 찾기. 막는 것은 광나루–천호 하저터널뿐
const b = UG.guide.planBlock(G, { plan: p2, cps: cps2, cur: at }, walked);
const ends = (e) => [G.nodeStation[g.edges.a[e]], G.nodeStation[g.edges.b[e]]].map((s) => (s >= 0 ? name(s) : '-')).sort().join('–');
check(!b.error && crossed && b.edges.has(crossed.e), `앞이 막힘(터널 ${Math.round(walked)}m 지점): 간선 ${b.edges.size}개 막음(${[...b.edges].map((e) => e + ' ' + ends(e)).join(', ')}) · 다시 출발 ${b.from && b.from.label} · 되돌아감 ${Math.round(b.backtrack)}m`);
const extra = [...b.edges].filter((e) => !han.has(e) || ends(e) !== ends(crossed.e));
check(!extra.length, `광나루–천호 하저터널 말고는 막지 않음(이웃 터널·다른 하저터널은 그대로)${extra.length ? ': 더 막힌 간선 ' + extra.join(', ') : ''}`);
check(b.from && b.from.si === si(Y.blockAfter), `다시 출발 = ${Y.blockAfter.replace(/@.*/, '')}역(마지막 확인 지점)`);
b.edges.forEach((e) => blocked.add(e));
const p3 = planOf(b.from, p2.to);
check(!!p3, p3 ? `다시 찾음 ${km(p3.view.total_m)}, 지상 ${Math.round(p3.view.exposed_m)}m, 환승 ${xfers(p3)}번: ${rides(p3)}` : '다시 찾기 실패');
// 막힘이 눈에 띄게: 다시 찾은 길이 처음 경로의 나머지보다 꽤 길어진다
const restM = p2.view.total_m - cps2[at].at;
check(!!p3 && p3.view.total_m - restM > 3000, `${cps2[at].label.replace(/ 도착$/, '')}에서 수서까지: 처음 경로 나머지 ${km(restM)} → 다시 찾은 길 ${km(p3 ? p3.view.total_m : 0)} (${km(p3 ? p3.view.total_m - restM : 0)} 더, 되돌아가기 ${Math.round(b.backtrack)}m 따로)`);
check(p3 && p3.route.path.every((x) => !blocked.has(x.e)), '다시 찾은 경로는 막은 간선을 쓰지 않음');
check(p3 && p3.route.endSi === meetSi, `다시 찾은 경로의 도착 = ${p3 ? name(p3.route.endSi) : '-'}`);
check(p3 && p3.view.exposed_m === 0, `다시 찾은 경로의 지상 노출 ${p3 ? Math.round(p3.view.exposed_m) : '-'}m (전 구간 지하)`);
const cross2 = p3 && UG.demo.hanCrossing(G, p3.route.path);
check(!!cross2 && !blocked.has(cross2.e) && han.get(cross2.e).s === 'tunnel',
  `지하로만 다시 찾은 길이 한강을 건너는 곳: ${cross2 ? cross2.line + ' ' + cross2.a + '–' + cross2.b + ' 하저터널 (간선 ' + cross2.e + ')' : '없음'} (시연 자막 첫 줄)`);
// '두 곳뿐': 5호선 하저터널 두 곳을 다 막으면 광나루에서 가족 약속 장소까지 지상을 걷지 않고는 갈 수 없다(자막에는 숫자를 쓰지 않음)
const both = new Set(blocked);
[...han.values()].filter((x) => x.s === 'tunnel' && (x.lines || []).includes('5호선')).forEach((x) => both.add(x.e));
const pNone = UG.router.findRoute(G, b.from, p2.to, { blocked: both }) || UG.router.findRoute(G, b.from, p2.to, { blocked: both, surface: true });
check(!!pNone && pNone.exposed_m > 0, `5호선 하저터널 두 곳을 다 막으면: 가장 나은 길도 지상 노출 ${pNone ? Math.round(pNone.exposed_m) + 'm' : '-'} (지하로만 가려면 이 두 곳뿐)`);

// 3-1. 대안(길 안내 카드의 한 줄, app.js findAlt 와 같은 입력): 시연은 이 한 줄을 눌러(switchAlt) 그 길로 간다
const alt3 = p3 && UG.router.alternative(G, b.from, p2.to, p3.route, { blocked, speedKmh: SPEED });
check(!!alt3 && Y.takeAlt === true, alt3 ? `대안 한 줄: "${UG.panel.altText({ using: false, extra_m: alt3.extra_m, saved_m: alt3.saved_m, saved_min: alt3.saved_min })}" · 지상 ${alt3.extra_m}m 더, ${km(alt3.saved_m)}(${Math.round(alt3.saved_m)}m) 짧음 · 시연이 누름(takeAlt ${Y.takeAlt})` : '대안 한 줄 없음(시연이 누를 수 없음)');
const pA = alt3 ? { from: b.from, to: p2.to, route: alt3.route } : null;
if (pA) UG.steps.planItems(G, pA, SPEED);   // app.js switchAlt → describePlan 과 같음
check(!!pA && Math.abs(pA.view.total_m - 20650) < 30 && Math.abs(alt3.extra_m - 721.5) < 5 && Math.abs(alt3.saved_m - 18486) < 30 && pA.view.exposed_m === alt3.extra_m + p3.view.exposed_m,
  pA ? `대안 길(걷는 길) ${km(pA.view.total_m)}(${Math.round(pA.view.total_m)}m), 지상 노출 ${pA.view.exposed_m}m, 환승 ${xfers(pA)}번: ${rides(pA)}` : '대안 길 없음');
check(!!pA && pA.route.path.every((x) => !blocked.has(x.e)) && pA.route.endSi === meetSi, '대안 길도 막은 간선을 쓰지 않고 수서에 도착');
const trA = pA ? UG.guide.routeTrack(G, pA) : null, cpsA = pA ? UG.guide.buildCheckpoints(G, pA) : [];
check(!!trA && Math.abs(trA.total - pA.view.total_m) < 0.5, `길 안내 거리(guide.routeTrack) ${trA ? trA.total.toFixed(1) : '-'}m = 대안 길 거리(무대 pos 의 m, 3D ride2 와 같아야 함)`);
check(cpsA.length > 0 && cpsA[cpsA.length - 1].kind === 'end' && cpsA[cpsA.length - 1].si === meetSi, `대안 길 체크포인트 ${cpsA.length}개, 마지막 = ${cpsA.length ? cpsA[cpsA.length - 1].label : '-'}`);

// 4. 지상 노출 구간(시연의 expo 장면): 빨리 감기는 그 앞 확인 지점에서 멈추고, 노출이 끝날 때까지 걷는다
const X = pA ? UG.demo.exposure(G, pA, trA) : null;
check(!!X && Math.abs(X.len - alt3.extra_m) < 1 && X.at === '왕십리' && X.line === '수인분당선',
  X ? `첫 지상 노출: ${X.line} ${X.at} ${X.from.toFixed(1)}m ~ ${X.to.toFixed(1)}m, ${X.len.toFixed(1)}m (자막 '${X.at}역 ${X.line} 지상 구간')` : '지상 노출 없음');
const kf = X ? cpsA.reduce((k, c, i) => (c.at < X.from - 0.5 ? i : k), -1) : -1;
const walkCps = X ? cpsA.filter((c, i) => i > kf && c.at <= X.to) : [];
check(kf >= 0 && cpsA[kf].kind === 'station' && walkCps.length > 0 && walkCps.every((c) => c.kind === 'transfer' || c.kind === 'junction'),
  kf >= 0 ? `빨리 감기는 ${cpsA[kf].label}(${km(cpsA[kf].at)})에서 멈춤 → 걸으며 누름: ${walkCps.map((c) => `${c.label}(${Math.round(c.at)}m)`).join(' → ')} → 노출 끝 ${Math.round(X.to)}m` : '노출 앞 확인 지점 없음');
const warnSt = pA ? pA.items.find((it) => it.kind === 'step' && it.step.type === 'warning') : null;
const warnItem = warnSt ? pA.items.findIndex((it) => it.kind === 'step' && it.step.no === warnSt.step.in_step) : -1;
check(!!warnSt && walkCps.some((c) => c.item === warnItem),
  warnSt ? `안내 카드의 지상 노출 경고 '지상 ${warnSt.step.exposure_m}m · ${warnSt.step.at}${warnSt.step.after_m ? ' 지나 …' : ''}부터'가 걷는 구간에서 보임` : '지상 노출 경고 단계 없음');

// 5. 다른 하저터널 건너기: 수인분당선 서울숲–압구정로데오(막히지 않은 하저터널). 노출 구간 뒤 그 앞 역까지 빨리 감고 걸어서 건넌다
const crossB = pA && UG.demo.hanCrossing(G, pA.route.path);
const crossBAt = crossB ? pA.route.path.findIndex((x) => x.e === crossB.e) : -1;
check(!!crossB && !blocked.has(crossB.e) && han.get(crossB.e).s === 'tunnel' && crossB.line === '수인분당선' && crossB.a === '서울숲' && crossB.b === '압구정로데오',
  `한강 아래 다른 하저터널(crossB): ${crossB ? crossB.line + ' ' + crossB.a + '–' + crossB.b + ' (간선 ' + crossB.e + ')' : '없음'}`);
const ka = cpsA.findIndex((c) => crossB && c.si === crossB.sa && c.kind === 'station');
const kb = ka >= 0 ? ka + 1 : -1;
check(ka >= 0 && cpsA[kb] && cpsA[kb].si === crossB.sb && cpsA[ka].pos < crossBAt && cpsA[kb].pos >= crossBAt && X && X.to < cpsA[ka].at,
  ka >= 0 ? `건너는 구간: ${cpsA[ka].label}(${km(cpsA[ka].at)}) → ${cpsA[kb].label}(${km(cpsA[kb].at)}), ${Math.round(cpsA[kb].at - cpsA[ka].at)}m (노출 끝에서 ${Math.round(cpsA[ka].at - X.to)}m 빨리 감은 뒤)` : 'crossB 체크포인트 없음');
info(`대안 길의 갈림길 체크포인트 ${cpsA.filter((c) => c.kind === 'junction').length}개(지상 노출 구간을 걸으며 '통과')`);

// 6. 도착: 지하에 들어간 뒤 지상 노출 = 처음 경로(막히기 전까지) + 걷는 다시 찾은 길(대안). 자막에 그대로 쓴다(숨기지 않음)
const expoAfter = p2.view.exposed_m + (pA ? pA.view.exposed_m : NaN);
check(Math.abs(expoAfter - 721.5) < 1, `도착 ${name(meetSi)}역 · 지하에 들어간 뒤 지상 노출 ${Math.round(expoAfter)}m(자막) = 대안의 지상 구간 (공습경보 뒤 지상은 처음 출구까지 ${Math.round(o1.len)}m 따로)`);
// 7. 끝 장면: 수서 지하 승강장에서 남쪽으로 이어지는 지하 길(시연은 화살표로만 보여 준다, 안내 없음)
const southSi = si(Y.south);
const meetFrom = { kind: 'station', si: meetSi, hubs: UG.reach.underHubs(G, meetSi), text: name(meetSi) + '역 지하 승강장', lat: g.stations[meetSi].lat / 1e5, lon: g.stations[meetSi].lon / 1e5 };
const pS = southSi >= 0 ? planOf(meetFrom, st(Y.south)) : null;
check(!!pS && name(southSi) === '동탄' && pS.view.exposed_m === 0 && Math.abs(pS.view.total_m - 32400) < 100,
  pS ? `남쪽: ${name(meetSi)} → ${name(southSi)} ${km(pS.view.total_m)}, 지상 ${pS.view.exposed_m}m: ${rides(pS)}` : '남쪽 역을 찾지 못함');
// 끝 장면 화살표는 남쪽 길을 지하/지상 노출 묶음(flightRuns)으로 나눠 묶음마다 그린다: 묶음 합 = 경로 합, 빈틈 없음
const runsS = pS ? UG.demo.flightRuns(G, pS.route.path) : [];
const runLenS = runsS.reduce((a, r) => a + r.len, 0), runExpoS = runsS.reduce((a, r) => a + (r.exposed ? r.len : 0), 0);
check(!!pS && runsS.length > 0 && Math.abs(runLenS - pS.route.total_m) < 1 && Math.abs(runExpoS - pS.route.exposed_m) < 1 &&
  runsS.every((r, i) => r.pts.length >= 2 && (i === 0 || Math.abs(r.from - (runsS[i - 1].from + runsS[i - 1].len)) < 0.01)),
  `남쪽 길 화살표: 묶음 ${runsS.length}개(지상 ${runsS.filter((r) => r.exposed).length}개), 묶음 합 ${km(runLenS)} = 경로 합, 빈틈 없음, 자라는 시간 ${CONF.southGrowMs}ms`);
for (const q2 of ['수원@경기', '평택지제@경기']) {   // 참고: 더 남쪽(자막에는 쓰지 않음)
  const k2 = si(q2), p2s = k2 >= 0 ? planOf(meetFrom, st(q2)) : null;
  info(`참고 ${name(meetSi)} → ${q2.replace(/@.*/, '')}: ${p2s ? km(p2s.view.total_m) + ', 지상 ' + Math.round(p2s.view.exposed_m) + 'm' : '없음'}`);
}
// 장면별 걷는 시간(×60, 버튼 누름·자막 멈춤은 빼고). 갈림길은 마지막 60m 만 fork 배속. 전체 재생 시간은 헤드리스 Chrome 으로 잰다
const B = CONF.boost, mps = SPEED / 3.6 * 60;   // ×60 일 때 1배속 1초에 걷는 m
const fAt = kf >= 0 ? cpsA[kf].at : 0, aAt = ka >= 0 ? cpsA[ka].at : 0, bAt = kb >= 0 ? cpsA[kb].at : 0, preJ = cps2[ji - 1].at;
const secs = {
  enter: p1.view.total_m / (mps * B.enter), guide: preJ / (mps * B.move), junction: (Math.max(0, jcp.at - preJ - 60)) / (mps * B.move) + Math.min(60, jcp.at - preJ) / (mps * B.fork),
  crossA: (cps2[at].at - jcp.at) / (mps * B.ffA) + walked / (mps * B.move), ff: fAt / (mps * B.ff),
  expo: X ? (X.to - fAt) / (mps * B.expo) + (aAt - X.to) / (mps * B.ff) : 0, crossB: (bAt - aAt) / (mps * B.cross),
  arriveFf: (pA ? pA.view.total_m - bAt : 0) / (mps * B.arrive)
};
info('장면별 걷기(×60): ' + Object.keys(secs).map((k) => `${k} ${secs[k].toFixed(1)}초`).join(' · ') + ` · 합 ${Math.round(Object.values(secs).reduce((a, x) => a + x, 0))}초`);
blocked.clear();

console.log(ok ? '\n모두 통과' : '\n실패한 항목이 있습니다');
process.exit(ok ? 0 : 1);
