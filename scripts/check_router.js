// check_router.js — 웹 탐색기(web/js)가 참조 구현(scripts/route.py)과 같은 결과를 내는지 확인한다.
// 사용법(프로젝트 폴더에서): node scripts\check_router.js
//   역 쌍마다 python -I scripts\route.py <a> <b> --json 을 실행하고, 같은 쌍을 JS 로 탐색해 비교한다.
//   비교: 총거리(1m 안), 지상 노출, 단계 수, 단계마다 종류·노선 표시·거리·지나는 역, 글 안내 문장.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'web/js/graph.js'));
require(path.join(ROOT, 'web/js/router.js'));
require(path.join(ROOT, 'web/js/steps.js'));
const UG = globalThis.UG;

const PAIRS = [
  ['서울역', '강남'], ['여의도', '광화문'], ['대화', '백석'], ['인덕원', '사당'],
  ['부평', '구로'], ['김포공항', '서울역'], ['부산역', '서면'], ['반월당', '동대구'],
  ['여의도', '광화문', '5호선']   // 셋째 값: 한강을 건너는 그 노선 간선을 막는다(--block-han)
];

function strip(steps) {   // 화면용 값(_로 시작)을 뺀다
  return JSON.parse(JSON.stringify(steps, function (k, v) { return k.startsWith('_') ? undefined : v; }));
}

let t0 = Date.now();
const g = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/data/graph.json'), 'utf8'));
const G = UG.graph.indexGraph(g);
console.log(`그래프 읽기·색인 ${Date.now() - t0}ms (노드 ${G.nNodes}, 간선 ${G.nEdges})`);

let allOk = true;
const rows = [];
const pyLine = (l) => l && !l.startsWith('  (참고)') && !l.startsWith('막은 간선');   // 안내 줄만 남긴다
for (const [a, b, han] of PAIRS) {
  const extra = han ? ['--block-han', han] : [];
  const py = JSON.parse(execFileSync('python', ['-I', 'scripts/route.py', a, b, '--json'].concat(extra), { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(pyLine).join('\n'));
  const s = UG.graph.findStation(G, a), t = UG.graph.findStation(G, b);
  t0 = performance.now();
  const blocked = han ? new Set(UG.router.hanEdges(G, han)) : null;
  const r = UG.router.findRoute(G, { kind: 'station', si: s }, { kind: 'station', si: t }, { blocked });
  const ms = performance.now() - t0;
  const js = UG.steps.describe(G, r.startSi, r.path, 3.5);
  const jsSteps = strip(js.steps);
  const diffs = [];
  if (Math.abs(js.total_m - py.total_m) > 1) diffs.push(`total ${js.total_m} vs ${py.total_m}`);
  if (js.exposed_m !== py.exposed_m) diffs.push(`exposed ${js.exposed_m} vs ${py.exposed_m}`);
  if (js.est_minutes !== py.est_minutes) diffs.push(`minutes ${js.est_minutes} vs ${py.est_minutes}`);
  if (JSON.stringify(js.edges) !== JSON.stringify(py.edges)) diffs.push('edge list differs');
  if (jsSteps.length !== py.steps.length) diffs.push(`steps ${jsSteps.length} vs ${py.steps.length}`);
  const label = (x) => x.type === 'ride' ? x.label : x.type;
  const jsLabels = jsSteps.map(label).join(' / '), pyLabels = py.steps.map(label).join(' / ');
  if (jsLabels !== pyLabels) diffs.push(`labels: ${jsLabels} | ${pyLabels}`);
  // 단계 내용 전체(키 순서 무시)
  py.steps.forEach((p, i) => {
    const j = jsSteps[i];
    if (!j) return;
    const keys = new Set(Object.keys(p).concat(Object.keys(j)));
    for (const k of keys) {
      if (JSON.stringify(p[k]) !== JSON.stringify(j[k])) diffs.push(`step ${i + 1} ${k}: ${JSON.stringify(j[k])} vs ${JSON.stringify(p[k])}`);
    }
  });
  // 글 안내 문장 (route.py 기본 출력의 단계 줄)
  const pyText = execFileSync('python', ['-I', 'scripts/route.py', a, b].concat(extra), { cwd: ROOT, encoding: 'utf8' })
    .split(/\r?\n/).filter(pyLine).slice(1);
  const jsText = [].concat(...jsSteps.map(UG.steps.stepText));
  if (pyText.join('\n') !== jsText.join('\n')) diffs.push('text differs:\n  ' + jsText.join('\n  ') + '\n  ---\n  ' + pyText.join('\n  '));
  const ok = diffs.length === 0;
  allOk = allOk && ok;
  rows.push(`${ok ? 'OK ' : 'NG '} ${a}→${b}${han ? ' (' + han + ' 한강 횡단 막음)' : ''}: JS ${js.total_m}m / 노출 ${js.exposed_m}m / ${jsSteps.length}단계 | ` +
    `PY ${py.total_m}m / 노출 ${py.exposed_m}m / ${py.steps.length}단계 | 탐색 ${ms.toFixed(1)}ms | ${jsLabels}`);
  if (!ok) rows.push('    ' + diffs.join('\n    '));
}
console.log(rows.join('\n'));

// 지도 위의 점 -> 점 (Python 에는 없는 기능: 동작만 확인)
const pt = (lat, lon) => ({ kind: 'point', lat, lon, conn: UG.router.connectPoint(G, lat, lon) });
t0 = performance.now();
const pr = UG.router.findRoute(G, pt(37.5547, 126.9706), pt(37.4979, 127.0276));
const pms = performance.now() - t0;
if (pr) {
  const d = UG.steps.describe(G, pr.startSi, pr.path, 3.5);
  console.log(`점→점(서울역 부근→강남역 부근): ${pr.walk ? '바로 걷기' : g.stations[pr.startSi].name + ' ' + (pr.startConn.ref || '?') + '번 → ' +
    g.stations[pr.endSi].name + ' ' + (pr.endConn.ref || '?') + '번'}, 총 ${Math.round(pr.total_m)}m, 노출 ${Math.round(pr.exposed_m)}m, ` +
    `${d.steps.length}단계, ${pms.toFixed(1)}ms`);
}
process.exitCode = allOk ? 0 : 1;
console.log(allOk ? '모두 같음' : '다른 곳 있음');
