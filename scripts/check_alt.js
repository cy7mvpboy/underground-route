// check_alt.js — 대안 경로(router.js alternative, 결과 카드·길 안내의 한 줄)를 확인한다.
// 사용법(프로젝트 폴더에서): node scripts\check_alt.js
// - 기본 탐색(지하 우선, 지상 1000)은 그대로인지(가중치 배열이 같은 것, exposedW 를 1000 으로 줘도 같은 경로)
// - 대안이 나오는 경우(옥수 → 압구정: 동호대교를 건너면 크게 짧아짐)와 기준(시간 20% 또는 30분, 지상 2km 이하, 다른 경로)
// - 대안이 없는 경우(부산역 → 서면: 이미 짧고 지하, 노량진 → 용산: 다른 길이지만 줄어드는 것이 작음)
// - 시연 이야기처럼 5호선 하저터널이 막혀 다시 찾은 경로: 대안이 나오고 시연이 그 대안을 고른다(CONF.story.takeAlt, 2026-11-13).
//   대안 = 왕십리에서 수인분당선 지상 구간을 약 722m 걷고 서울숲–압구정로데오 하저터널로 한강을 건너는 20.6km 길(그래프가 바뀌면 달라질 수 있다)
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

/* ---------- 앞이 막혀 다시 찾은 경로(시연 이야기와 같은 막기: 출발 자리에서 가장 가까운 역 → 가족 약속 장소, blockAfter 다음 하저터널)
   시연은 이 대안을 누른다: 대안이 있고, 기준을 만족하고, 지상 노출 구간·한강 하저터널이 이야기와 같은지 확인한다 ---------- */
{
  const M = UG.demo.CONF.story, blocked = new Set();
  const from = g.stations[UG.nearest.nearestUnderground(G, M.lat, M.lon, { limit: 1 }).options[0].si].name + '@서울';
  console.log('\n[앞이 막힘 뒤] ' + from.replace(/@.*/, '') + ' → ' + M.meet.replace(/@.*/, '') + ', ' + M.blockAfter.replace(/@.*/, '') + ' 다음 하저터널 막힘 (시연이 대안을 고름)');
  const p = { from: st(from), to: st(M.meet), route: RT.findRoute(G, st(from), st(M.meet)) };
  UG.steps.planItems(G, p, SPEED);
  const cps = UG.guide.buildCheckpoints(G, p), at = cps.findIndex((c) => c.si === UG.graph.findStation(G, M.blockAfter));
  const b = UG.guide.planBlock(G, { plan: p, cps, cur: at }, (cps[at + 1].at - cps[at].at) * M.blockFrac);
  b.edges.forEach((e) => blocked.add(e));
  const { main, alt } = showAlt(b.from, p.to, blocked);
  info(`다시 찾은 지하 우선 경로 ${km(main.total_m)}, 지상 ${Math.round(main.exposed_m)}m`);
  check(!!alt && M.takeAlt === true, alt ? `대안 ${km(alt.route.total_m)}(${Math.round(alt.route.total_m)}m), 지상 ${alt.route.exposed_m}m: ` + UG.panel.altText({ using: false, extra_m: alt.extra_m, saved_m: alt.saved_m, saved_min: alt.saved_min }) + ` · 시연이 고름(takeAlt ${M.takeAlt})` : '대안 없음(시연이 고를 수 없음)');
  if (alt) {
    check(alt.route.path.every((x) => !blocked.has(x.e)), '대안도 막은 간선을 쓰지 않음');
    check(Math.abs(alt.route.total_m - 20650) < 30 && Math.abs(alt.extra_m - 721.5) < 5 && Math.abs(alt.saved_m - 18486) < 30 && alt.extra_m <= ALT.maxExtraExposedM,
      `대안 값: 길 ${Math.round(alt.route.total_m)}m · 늘어나는 지상 ${alt.extra_m}m(2km 이하) · 줄어듦 ${Math.round(alt.saved_m)}m(${Math.round(alt.saved_m / main.total_m * 100)}%), ${Math.round(alt.saved_min)}분`);
    // 지상 노출은 왕십리의 수인분당선 지상 구간 한 곳, 한강은 수인분당선 서울숲–압구정로데오 하저터널(막히지 않은 터널)
    const pa = { from: b.from, to: p.to, route: alt.route };
    UG.steps.planItems(G, pa, SPEED);
    const X = UG.demo.exposure(G, pa, UG.guide.routeTrack(G, pa)), h = UG.demo.hanCrossing(G, alt.route.path);
    check(!!X && X.at === '왕십리' && X.line === '수인분당선' && Math.abs(X.len - alt.extra_m) < 1,
      X ? `지상 노출: ${X.line} ${X.at} ${Math.round(X.from)}~${Math.round(X.to)}m (${X.len}m, 한 곳)` : '지상 노출 없음');
    check(!!h && h.line === '수인분당선' && h.a === '서울숲' && h.b === '압구정로데오' && !blocked.has(h.e),
      h ? `한강: ${h.line} ${h.a}–${h.b} 하저터널(막히지 않음)` : '한강 하저터널 없음');
  }
}

console.log(ok ? '\n모두 통과' : '\n실패한 항목이 있습니다');
process.exit(ok ? 0 : 1);
