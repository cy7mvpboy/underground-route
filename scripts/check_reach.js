// check_reach.js — '여기서 지하로 갈 수 있는 곳'(web/js/reach.js)을 시험한다.
// 사용법(프로젝트 폴더에서): node scripts\check_reach.js
//   시청(서울)·대화·강남·지상역 하나에서 띠(30분·1시간·2시간·4시간)별 닿는 역 수를 세고,
//   지하가 아닌 간선을 한 번도 쓰지 않았는지, 거리가 띠와 맞는지, 지도 조각이 띠 안에 있는지 확인한다.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
for (const f of ['graph', 'router', 'reach']) require(path.join(ROOT, 'web/js', f + '.js'));
const UG = globalThis.UG;
const g = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/data/graph.json'), 'utf8'));
const G = UG.graph.indexGraph(g);
let ok = true;
const check = (cond, msg) => { console.log((cond ? 'OK  ' : 'NG  ') + msg); ok = ok && cond; };
const name = (si) => g.stations[si].name;

function run(q, speed) {
  const si = UG.graph.findStation(G, q);
  const t0 = performance.now();
  const r = UG.reach.reachFrom(G, si, { speedKmh: speed || 3.5 });
  const ms = performance.now() - t0;
  const t1 = performance.now();
  const segs = UG.reach.segments(G, r);
  const ms2 = performance.now() - t1;
  console.log(`\n${q} (${name(si)}, 지하 허브 ${r.sources.length}개, 시속 ${r.speed}km): ` +
    r.bands.map((b, i) => `${b.min}분(${(b.m / 1000).toFixed(2)}km) ${r.counts[i]}곳`).join(' / ') + ` [${ms.toFixed(1)}ms, 조각 ${ms2.toFixed(1)}ms]`);
  if (r.farthest.length) console.log('  가장 먼 역: ' + r.farthest.map((x) => `${name(x.si)} ${(x.m / 1000).toFixed(1)}km`).join(', '));
  if (r.stations.length) console.log('  1시간 안 역: ' + r.stations.filter((x) => x.band <= 1).map((x) => name(x.si)).join(' '));
  return { si, r, segs };
}

function verify(label, res) {
  const { r, segs } = res;
  // 1) 닿은 노드의 직전 간선은 모두 지하 간선
  let bad = 0, reached = 0;
  for (let v = 0; v < G.nNodes; v++) {
    if (!isFinite(r.dist[v])) continue;
    reached++;
    if (r.prev[v] >= 0 && !UG.reach.isUnderEdge(G, r.prev[v])) bad++;
  }
  check(bad === 0, `${label}: 닿은 노드 ${reached}개, 지하가 아닌 간선을 거친 노드 ${bad}개`);
  // 2) 거리 <= 4시간 거리, 띠 번호가 거리와 맞음, 누적 수가 늘어남
  const bandOk = r.stations.every((x) => x.m <= r.limit_m + 1e-6 && x.m <= r.bands[x.band].m && (x.band === 0 || x.m > r.bands[x.band - 1].m));
  const mono = r.counts.every((c, i) => i === 0 || c >= r.counts[i - 1]);
  check(bandOk && mono, `${label}: 역 거리·띠 맞음, 누적 수 ${r.counts.join(' <= ')}`);
  // 3) 지도 조각: 각 띠 조각의 길이 합이 0 이상이고, 조각 수가 있으면 닿은 역도 있다
  const kms = segs.map((list) => list.reduce((s, pts) => { const c = UG.graph.cumulative(pts); return s + c[c.length - 1]; }, 0) / 1000);
  console.log(`  지도 조각(띠별 선로 km, 상·하행 따로): ${kms.map((k) => k.toFixed(1)).join(' / ')}`);
  check(kms.every((k) => k >= 0) && (r.stations.length === 0) === (kms.reduce((a, b) => a + b, 0) === 0) , `${label}: 조각이 닿은 범위와 맞음`);
}

const city = run('시청@서울');
verify('시청', city);
check(city.r.counts[1] >= 10, `시청: 1시간 안 지하로 닿는 역이 10곳 이상 (${city.r.counts[1]})`);

const daehwa = run('대화');
verify('대화', daehwa);
check(daehwa.r.counts[3] < city.r.counts[3], `대화: 4시간 안 역(${daehwa.r.counts[3]})이 시청(${city.r.counts[3]})보다 적음(일산선 지상 구간)`);

const gangnam = run('강남');
verify('강남', gangnam);

// 지상역: 지하 허브가 없으면 출발점이 없고 닿는 역도 없다
const ground = UG.graph.findStation(G, '도봉산');
const gr = UG.reach.reachFrom(G, ground, {});
console.log(`\n도봉산(지상역): 지하 허브 ${gr.sources.length}개, 닿는 역 ${gr.stations.length}곳`);
check(gr.sources.length > 0 || gr.stations.length === 0, '지하 허브가 없는 역은 닿는 역 0곳');

// 속도가 빠르면 같은 띠에 더 많이 닿는다
const fast = UG.reach.reachFrom(G, city.si, { speedKmh: 4.0 });
check(fast.counts[1] >= city.r.counts[1], `시속 4km 1시간 안 ${fast.counts[1]}곳 >= 시속 3.5km ${city.r.counts[1]}곳`);

// 막은 간선은 쓰지 않는다: 시청에서 1시간 안 가장 먼 역으로 가는 마지막 간선을 막으면 그 간선을 쓰지 않음
const far1 = city.r.stations.filter((x) => x.band <= 1).pop();
let v = -1, best = Infinity;
for (let n = 0; n < G.nNodes; n++) if (G.nodeStation[n] === far1.si && city.r.dist[n] < best) { best = city.r.dist[n]; v = n; }
const cut = city.r.prev[v];
const blockedRun = UG.reach.reachFrom(G, city.si, { blocked: new Set([cut]) });
let used = false;
for (let n = 0; n < G.nNodes; n++) if (blockedRun.prev[n] === cut) used = true;
check(!used, `막은 간선 ${cut}(${name(far1.si)} 쪽)을 쓰지 않음`);

process.exitCode = ok ? 0 : 1;
console.log(ok ? '\n모두 통과' : '\n실패 있음');
