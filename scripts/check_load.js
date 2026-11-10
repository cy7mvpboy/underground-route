// check_load.js — 첫 로딩을 빠르게 하려고 나눠서 하는 일이 한 번에 한 것과 같은지 시험한다(docs\graph-format.md 14.1절).
// 사용법(프로젝트 폴더에서): node scripts\check_load.js
//   1) 철도망 나눠 그리기(layers.js): 첫 화면 선로(edgesInBox) + 나머지 = 그릴 선로(trackEdges) 전부, 겹침 없음,
//      그릴 선로의 묶음별 개수가 예전 묶음(buildTrackGroups)과 같음.
//   2) 장소 검색 열쇠(places.js prepare): 조금씩 나눠 만든 것 = 한 번에 만든 것. 다 만들기 전에 검색해도 결과가 같음.
//   3) index.html: graph.json 미리 받기(crossorigin), 글꼴 CSS 를 첫 화면을 막지 않게 받기, 스크립트 순서.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
for (const f of ['graph', 'places', 'layers']) require(path.join(ROOT, 'web/js', f + '.js'));
const UG = globalThis.UG;
const g = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/data/graph.json'), 'utf8'));
let ok = true;
const check = (cond, msg) => { console.log((cond ? 'OK  ' : 'NG  ') + msg); ok = ok && cond; };

/* ---------- 1) 철도망 나눠 그리기 ---------- */
const LY = UG.layers;
const edges = LY.trackEdges(g);
const groups = LY.buildTrackGroups(g);
let total = 0;
LY.STRUCTS.forEach((k) => { total += groups[k].main.length + groups[k].service.length; });
check(edges.length === total, `그릴 선로 간선 ${edges.length}개 = 예전 묶음 선 조각 ${total}개`);
const main = g.tables.services.indexOf('');
const sameGroups = LY.STRUCTS.every((k) => ['main', 'service'].every((tier) => {
  const n = edges.filter((e) => g.tables.structs[g.edges.s[e]] === k && (g.edges.svc[e] === main) === (tier === 'main')).length;
  return n === groups[k][tier].length;
}));
check(sameGroups, '구조(지하·교량·지상) × 본선/측선 묶음별 개수가 예전과 같음');
// 서울 도심 줌 12 폰 화면(약 0.1도 × 0.25도)을 2배로 넓힌 곳
const box = [37.4415, 126.9030, 37.6915, 127.0530];
const near = LY.edgesInBox(g, edges, box);
const nearSet = new Set(near);
const rest = edges.filter((e) => !nearSet.has(e));
check(near.length > 0 && near.length < edges.length, `첫 화면 선로 ${near.length}개(전체의 ${(100 * near.length / edges.length).toFixed(1)}%), 나머지 ${rest.length}개`);
check(near.length + rest.length === edges.length && near.every((e, i) => i === 0 || e > near[i - 1]), '첫 화면 + 나머지 = 전부, 겹침 없음, 간선 번호 순');
const inBox = (la, lo) => la >= box[0] && la <= box[2] && lo >= box[1] && lo <= box[3];
const missed = edges.filter((e) => !nearSet.has(e) && (inBox(g.nodes.lat[g.edges.a[e]] / 1e5, g.nodes.lon[g.edges.a[e]] / 1e5) || inBox(g.nodes.lat[g.edges.b[e]] / 1e5, g.nodes.lon[g.edges.b[e]] / 1e5)));
check(missed.length === 0, '끝점이 화면 안에 있는 선로는 모두 첫 화면에 들어감');

/* ---------- 2) 장소 검색 열쇠를 나눠 만들기 ---------- */
const PLACES = path.join(ROOT, 'web/data/places.json');
if (!fs.existsSync(PLACES)) console.log('places.json 없음: 2) 건너뜀');
else {
  const text = fs.readFileSync(PLACES, 'utf8');
  const P = UG.places;
  const one = JSON.parse(text), t0 = performance.now();
  const a = P.prepare(one);
  const msOne = performance.now() - t0;
  const many = JSON.parse(text);
  let rounds = 0, b = null;
  while (!(b = P.prepare(many, 0.5))) rounds++;
  check(rounds > 3, `나눠 만들기: ${rounds + 1}번에 나눠 끝남(한 번에 ${msOne.toFixed(0)}ms)`);
  const same = a.keys.length === b.keys.length && a.keys.every((k, i) => k === b.keys[i]) &&
    a.keyEntry.every((x, i) => x === b.keyEntry[i]) && a.keyAlias.every((x, i) => x === b.keyAlias[i]) &&
    a.boost.every((x, i) => x === b.boost[i]);
  check(same, `열쇠 ${a.keys.length}개와 순서·장소 번호·별칭 표시·가산점이 한 번에 만든 것과 같음`);
  check(!Object.prototype.hasOwnProperty.call(many, '_work'), '다 만든 뒤 작업 자료(_work)를 지움');
  // 다 만들기 전에 검색: searchPlaces 가 남은 부분을 마저 만들고 같은 결과를 낸다
  const half = JSON.parse(text);
  P.prepare(half, 0.5);
  const qs = ['서울대병원', '강남구청', '역삼동', 'ㄱㄴㄱㅊ', '은마아파트'];
  const res = (idx) => JSON.stringify(qs.map((q) => P.searchPlaces(idx, q, { near: [37.5665, 126.978], limit: 5 })));
  check(res(half) === res(one), '중간까지만 만든 뒤 검색해도 결과가 같음(' + qs.join(', ') + ')');
}

/* ---------- 3) index.html 의 첫 로딩 설정(14.1절) ----------
   글자만 본다: 고치다 실수로 빠지면 graph.json 을 두 번 받거나(crossorigin 없음) 글꼴 CSS 가 첫 화면을 막는다. */
const html = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'web/js/app.js'), 'utf8');
const pre = html.match(/<link rel="preload" href="([^"]+)" as="fetch"( crossorigin)?>/);
check(!!pre && !!pre[2] && appJs.indexOf("dataUrl: '" + pre[1] + "'") >= 0, 'graph.json 미리 받기: crossorigin 이 있고 app.js 가 같은 주소를 받음');
check(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^"]*" media="print">/.test(html) && /fontCss\.media = 'all'/.test(appJs),
  '글꼴 CSS: media="print" 로 받아 두고 app.js 가 graph.json 을 받은 뒤 켬');
const order = ['graph', 'passage', 'pdr', 'guide', 'app', 'demo'].map((f) => html.indexOf('src="js/' + f + '.js"'));
check(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), 'passage.js 는 graph.js 다음, pdr.js(걸음 세기)는 guide.js 앞, 모두 app.js 앞에서 불러오고, demo.js(시연)는 app.js 다음');

process.exitCode = ok ? 0 : 1;
console.log(ok ? '\n모두 통과' : '\n실패 있음');
