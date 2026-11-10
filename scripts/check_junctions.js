// check_junctions.js — 갈림길 안내(web/js/junctions.js)를 실제 그래프 경로로 확인한다.
// 사용법(프로젝트 폴더에서): node scripts\check_junctions.js
//   역 쌍마다 웹과 같은 탐색(router.findRoute)으로 경로를 찾고, findJunctions 결과(안내 문장)와
//   안내하지 않은 갈래(건넘선 등)와 그 이유를 출력한다. 기대한 갈림길이 없거나 좌우가 이상하면 NG.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'web/js/graph.js'));
require(path.join(ROOT, 'web/js/router.js'));
require(path.join(ROOT, 'web/js/junctions.js'));
const UG = globalThis.UG;
const J = UG.junctions;

let t0 = Date.now();
const g = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/data/graph.json'), 'utf8'));
UG.graph.validateGraph(g);
const G = UG.graph.indexGraph(g);
console.log(`그래프 읽기·색인 ${Date.now() - t0}ms`);

// 갈래 찾기 도우미: 갈림길 j 안의 갈래 중 조건에 맞는 것
const altWith = (j, f) => j.alternatives.find(f);
const has = (s, t) => String(s || '').indexOf(t) >= 0;

// [출발, 도착, 설명, 확인 함수(js) -> 문제 목록]
const CASES = [
  ['건대입구', '용답', '2호선 성수지선. 지상(고가)인 성수를 피해 7·5·2·6·1호선과 신설동 연결선으로 돈다', (js) => {
    const p = [];
    const spur = js.find((j) => has(j.chosen.name, '성수지선') && j.chosen.toward === '용두');
    if (!spur) p.push('신설동 연결선(→ 성수지선 용두) 갈림길 없음');
    else if (!altWith(spur, (a) => has(a.name, '1호선') && a.toward === '신설동')) p.push('연결선 갈림길에 1호선 신설동 방면 갈래 없음');
    const depot = js.find((j) => j.prev && j.prev.name === '신답');
    if (!depot || !altWith(depot, (a) => a.kind === 'depot' && a.name === '차량기지')) p.push('신답 뒤 차량기지 갈래 없음');
    else if (!(depot.chosen.rank > altWith(depot, (a) => a.kind === 'depot').rank)) p.push('신답 뒤: 차량기지가 왼쪽(동쪽)이어야 함');
    return p;
  }],
  ['성수', '용답', '성수지선은 성수에서 따로 승강장을 쓴다: 선로 갈림길 없음(건넘선만)', (js) =>
    js.length ? ['갈림길이 없어야 함'] : []],
  ['강동', '둔촌동', '5호선 마천지선이 강동 동쪽에서 갈라짐', (js) => {
    const p = [];
    const j = js.find((x) => x.chosen.toward === '둔촌동' && has(x.chosen.name, '마천지선'));
    if (!j) return ['강동 동쪽 갈림길 없음'];
    const main = altWith(j, (a) => a.toward === '길동');
    if (!main) p.push('길동 방면 갈래 없음');
    else if (!(j.chosen.rank > main.rank)) p.push('둔촌동(남쪽)이 오른쪽이어야 함');
    if (Math.abs(j.fromPrev_m - 263) > 30) p.push('강동에서 거리 ' + j.fromPrev_m + 'm (약 263m 기대)');
    return p;
  }],
  ['강동', '길동', '이 경로가 쓰는 강동 승강장 선로(길동행)에는 강동~길동 사이 갈림길이 없다', (js) =>
    js.length ? ['갈림길이 없어야 함'] : []],
  ['천호', '길동', '천호→강동 선로는 강동 서쪽에서 본선·마천지선 승강장으로 갈라진다', (js) => {
    const j = js.find((x) => x.next && x.next.name === '강동');
    if (!j) return ['강동 서쪽 갈림길 없음'];
    return altWith(j, (a) => has(a.name, '마천지선') && has(a.toward, '둔촌동')) ? [] : ['마천지선 둔촌동 방면 갈래 없음'];
  }],
  ['신도림', '도림천', '2호선 신정지선. 신도림 서쪽에서 2호선 본선(문래)으로 건너가는 선이 있다', (js) => {
    const j = js.find((x) => x.prev && x.prev.name === '신도림' && x.chosen.toward === '도림천');
    if (!j) return ['신도림 서쪽 갈림길 없음'];
    const main = altWith(j, (a) => a.toward === '문래');
    if (!main) return ['2호선 문래 방면 갈래 없음'];
    return j.chosen.rank < main.rank ? [] : ['신정지선(서쪽)이 왼쪽, 본선(문래, 북쪽)이 오른쪽이어야 함'];
  }],
  ['서울역', '강남', '공항철도·5·9호선·신분당선 터널: 건넘선·대피선만 있고 진짜 갈림길은 없을 것', (js) =>
    js.length ? ['갈림길 ' + js.length + '개: 진짜인지 확인 필요'] : []],
  ['신답', '용답', '차량기지 갈래(위치로 보아 군자차량기지)', (js) =>
    js.some((j) => j.alternatives.some((a) => a.kind === 'depot' && a.name === '차량기지')) ? [] : ['차량기지 갈래 없음']],
  ['도림천', '까치산', '차량기지 갈래 2곳(양천구청 앞, 신정네거리 뒤. 위치로 보아 신정차량기지)', (js) =>
    js.filter((j) => j.alternatives.some((a) => a.kind === 'depot')).length >= 2 ? [] : ['차량기지 갈래 2곳이 아님']],
  ['원흥', '구파발', '노출을 피해 지축기지선(차량기지) 터널로 간다. 지상역 지축으로 가는 일산선이 다른 갈래', (js) => {
    const j = js.find((x) => x.chosen.kind === 'depot' && altWith(x, (a) => has(a.name, '일산선') && a.toward === '지축'));
    return j ? [] : ['지축기지선 / 일산선(지축) 갈림길 없음'];
  }]
];

const REASON_KO = {
  crossover: '건넘선', behind: '뒤쪽에서 합류', stub: '짧은 막다른 선로', 'short-link': '같은 노선 옆 선로로 가는 짧은 연결선',
  'same-next-station': '같은 노선으로 같은 다음 역', 'rejoins-route': '경로로 다시 합쳐짐(대피선·통과선)'
};

let allOk = true, glyphShown = false;
for (const [a, b, note, check] of CASES) {
  const s = UG.graph.findStation(G, a), t = UG.graph.findStation(G, b);
  const r = UG.router.findRoute(G, { kind: 'station', si: s }, { kind: 'station', si: t });
  if (!r) { console.log(`NG  ${a}→${b}: 경로 없음`); allOk = false; continue; }
  const skipped = [];
  const t1 = performance.now();
  const js = J.findJunctions(G, r.path, { skipped });
  const ms = performance.now() - t1;
  const problems = check(js);
  const ok = problems.length === 0;
  allOk = allOk && ok;
  console.log(`\n${ok ? 'OK ' : 'NG '} ${a}→${b} (${(r.path_m / 1000).toFixed(1)}km, 갈림길 ${js.length}, 거른 갈래 ${skipped.length}, ${ms.toFixed(1)}ms) — ${note}`);
  js.forEach((j) => {
    console.log('    ' + J.junctionText(j));
    const br = [j.chosen].concat(j.alternatives).map((x) => `${x === j.chosen ? '고름' : '다른'} ${x.angle}° ${x.dir} ${x.kind} ${x.structure}`);
    console.log(`      노드 ${j.node} (${j.lat}, ${j.lon}) 다음 역 ${j.next ? j.next.name : '-'}까지 ${j.toNext_m}m | ${br.join(' / ')}`);
  });
  skipped.forEach((k) => {
    console.log(`    - 거름: ${k.prev}에서 ${k.fromPrev_m}m, 간선 ${k.edge}: ${REASON_KO[k.reason] || k.reason}` +
      (k.length_m != null ? ` (${k.length_m}m)` : '') + (k.angle != null ? ` (${k.angle}°)` : '') + (k.leads ? ` → ${k.leads}` : ''));
  });
  problems.forEach((p) => console.log('    ! ' + p));
  if (!glyphShown && js.length && a === '강동') {
    console.log('    그림 자료(junctionGlyph): ' + JSON.stringify(J.junctionGlyph(js[0])));
    glyphShown = true;
  }
}
process.exitCode = allOk ? 0 : 1;
console.log('\n' + (allOk ? '모두 기대대로' : '기대와 다른 곳 있음'));
