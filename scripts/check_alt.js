// check_alt.js — 대안 경로(router.js alternative, 결과 카드·길 안내의 한 줄)를 확인한다.
// 사용법(프로젝트 폴더에서): node scripts\check_alt.js
// - 기본 탐색(지하 우선, 지상 1000)은 그대로인지(가중치 배열이 같은 것, exposedW 를 1000 으로 줘도 같은 경로)
// - 대안이 나오는 경우(옥수 → 압구정: 동호대교를 건너면 크게 짧아짐)와 기준(시간 20% 또는 30분, 지상 2km 이하, 다른 경로)
// - 대안이 없는 경우(부산역 → 서면: 이미 짧고 지하, 노량진 → 용산: 다른 길이지만 줄어드는 것이 작음)
// - 시연 2번처럼 5호선 하저터널이 막혀 다시 찾은 경로(참고로 출력. 그래프가 바뀌면 달라질 수 있다)
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
for (const f of ['graph', 'junctions', 'router', 'exithere', 'steps', 'transfer', 'nearest', 'guide', 'lines', 'panel', 'demo']) require(path.join(ROOT, 'web/js', f + '.js'));
const UG = globalThis.UG, RT = UG.router, ALT = RT.ALT;
const g = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/data/graph.json'), 'utf8'));
const G = UG.graph.indexGraph(g);
const SPEED = 3.5, MPM = SPEED * 1000 / 60;
let ok = true;
const check = (cond, msg) => { console.log((cond ? 'OK  ' : 'NG  ') + msg); ok = ok && cond; };
const info = (msg) => console.log('    ' + msg);
const km = (m) => (m / 1000).toFixed(1) + 'km';
const st = (q) => { const i = UG.graph.findStation(G, q); if (i < 0) throw new Error('역 없음: ' + q); return { kind: 'station', si: i, text: q, lat: g.stations[i].lat / 1e5, lon: g.stations[i].lon / 1e5 }; };
const mainOf = (f, t, blocked) => RT.findRoute(G, f, t, { blocked }) || RT.findRoute(G, f, t, { blocked, surface: true });
const sameEdges = (a, b) => a.path.length === b.path.length && a.path.every((x, i) => x.e === b.path[i].e);

/* ---------- 기본 탐색은 그대로 ---------- */
console.log('\n[기본 탐색]');
check(RT.weightsFor(G).weight === G.weight && RT.weightsFor(G, g.weights.exposed).weight === G.weight, '기본 가중치(지하 ' + g.weights.under + ', 지상 ' + g.weights.exposed + ')는 그래프 배열 그대로');
check(ALT.exposedW === 15 && RT.weightsFor(G, ALT.exposedW).weight !== G.weight, '대안 탐색 지상 가중치 = ' + ALT.exposedW + '(따로 만든 배열)');
for (const [a, b] of [['서울역@서울', '강남@서울'], ['여의도@서울', '광화문@서울'], ['옥수@서울', '압구정@서울']]) {
  const r0 = RT.findRoute(G, st(a), st(b)), r1 = RT.findRoute(G, st(a), st(b), { exposedW: g.weights.exposed });
  check(sameEdges(r0, r1) && r0.total_m === r1.total_m, `${a} → ${b}: exposedW 를 ${g.weights.exposed}로 줘도 같은 경로(${km(r0.total_m)}, 지상 ${Math.round(r0.exposed_m)}m)`);
}

/* ---------- 대안이 나오는 경우 ---------- */
function showAlt(a, b, blocked) {
  const f = typeof a === 'string' ? st(a) : a, t = typeof b === 'string' ? st(b) : b;
  const main = mainOf(f, t, blocked);
  const alt = RT.alternative(G, f, t, main, { blocked, speedKmh: SPEED });
  return { main, alt };
}
console.log('\n[대안 있음] 옥수 → 압구정');
{
  const { main, alt } = showAlt('옥수@서울', '압구정@서울');
  info(`지하 우선: ${km(main.total_m)}, 지상 ${Math.round(main.exposed_m)}m`);
  check(!!alt, alt ? `대안: ${km(alt.route.total_m)}, 지상 ${Math.round(alt.route.exposed_m)}m` : '대안 없음');
  if (alt) {
    check(!sameEdges(alt.route, main), '대안은 다른 경로');
    check(alt.saved_m / main.total_m >= ALT.minSavedFrac || alt.saved_min >= ALT.minSavedMin, `줄어듦 ${km(alt.saved_m)} (${Math.round(alt.saved_m / main.total_m * 100)}%, ${Math.round(alt.saved_min)}분) — 20% 또는 30분 이상`);
    check(alt.extra_m <= ALT.maxExtraExposedM && Math.abs(alt.extra_m - (alt.route.exposed_m - main.exposed_m)) < 1, `늘어나는 지상 노출 ${Math.round(alt.extra_m)}m — 2km 이하`);
    check(Math.abs(alt.saved_min - alt.saved_m / MPM) < 1e-6, '줄어드는 시간 = 줄어드는 거리 ÷ 걷는 속도(시속 ' + SPEED + 'km)');
    const text = UG.panel.altText({ using: false, extra_m: alt.extra_m, saved_m: alt.saved_m, saved_min: alt.saved_min });
    check(/^지상 [\d.]+k?m 걸으면 [\d.]+k?m 짧아요 · 약 \d+(시간( 30분)?|분) 단축$/.test(text), '카드 한 줄: ' + text);
    check(UG.panel.altText({ using: true }) === '지하 우선 경로로', '대안을 고른 뒤: 지하 우선 경로로');
  }
}

/* ---------- 대안이 없는 경우 ---------- */
console.log('\n[대안 없음]');
for (const [a, b, why] of [['부산역@부산', '서면@부산', '이미 짧고 전 구간 지하'], ['서울역@서울', '강남@서울', '지상 가중치를 낮춰도 같은 경로'], ['노량진@서울', '용산@서울', '다른 길이지만 줄어드는 것이 작음']]) {
  const { main, alt } = showAlt(a, b);
  const raw = RT.findRoute(G, st(a), st(b), { exposedW: ALT.exposedW });
  check(!alt, `${a} → ${b} (${why}): 지하 우선 ${km(main.total_m)}·지상 ${Math.round(main.exposed_m)}m, 지상 ${ALT.exposedW}로 찾으면 ${km(raw.total_m)}·지상 ${Math.round(raw.exposed_m)}m → 대안 없음`);
}

/* ---------- 앞이 막혀 다시 찾은 경로(시연 1번 이야기와 같은 막기: 공덕역 승강장에서 가족 약속 장소로) ---------- */
console.log('\n[앞이 막힘 뒤] 공덕 → 한성백제, 5호선 마포–여의나루 하저터널 막힘 (참고)');
{
  const M = UG.demo.CONF.story, from = '공덕@서울', blocked = new Set();
  const p = { from: st(from), to: st(M.meet), route: RT.findRoute(G, st(from), st(M.meet)) };
  UG.steps.planItems(G, p, SPEED);
  const cps = UG.guide.buildCheckpoints(G, p), at = cps.findIndex((c) => c.si === UG.graph.findStation(G, M.blockAfter));
  const b = UG.guide.planBlock(G, { plan: p, cps, cur: at }, (cps[at + 1].at - cps[at].at) * M.blockFrac);
  b.edges.forEach((e) => blocked.add(e));
  const { main, alt } = showAlt(b.from, p.to, blocked);
  info(`다시 찾은 지하 우선 경로 ${km(main.total_m)}, 지상 ${Math.round(main.exposed_m)}m`);
  info(alt ? `대안 ${km(alt.route.total_m)}, 지상 ${Math.round(alt.route.exposed_m)}m: ` + UG.panel.altText({ using: false, extra_m: alt.extra_m, saved_m: alt.saved_m, saved_min: alt.saved_min }) : '대안 없음');
  check(!alt || alt.route.path.every((x) => !blocked.has(x.e)), '대안도 막은 간선을 쓰지 않음');
}

console.log(ok ? '\n모두 통과' : '\n실패한 항목이 있습니다');
process.exit(ok ? 0 : 1);
