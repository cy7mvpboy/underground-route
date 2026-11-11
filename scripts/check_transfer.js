// check_transfer.js — 환승 카드에 쓰는 내용(web/js/transfer.js)을 시험한다.
// 사용법(프로젝트 폴더에서): node scripts\check_transfer.js
//   - 서울역→강남: 공덕(공항철도→5호선), 여의도(5→9호선), 신논현(9호선→신분당선)
//   - 부평→구로: 신도림(2→1호선, 지상 통로), 까치산(같은 깊이)   - 종각→안국: 종로3가(1→3호선, 깊이 차이)
//   확인: 승강장 깊이·깊이 차이, 갈아탈 방향, 거리 출처 글, 시간(서울교통공사 = 거리 ÷ 1.2m/s), 행동 안내 세 줄, 환승 횟수.
//   덧붙는 자료(extra.json)는 손으로 만든 작은 예시로 시험한다(파일로 저장하지 않는다).
//   길 안내의 '경로에서 벗어남' 거리 계산(guide.distanceToTrack)도 함께 본다.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
for (const f of ['graph', 'router', 'steps', 'transfer', 'guide']) require(path.join(ROOT, 'web/js', f + '.js'));
const UG = globalThis.UG;
const g = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/data/graph.json'), 'utf8'));
const G = UG.graph.indexGraph(g);
const TR = UG.transfer;
let ok = true;
const check = (cond, msg) => { console.log((cond ? 'OK  ' : 'NG  ') + msg); ok = ok && cond; };

const SPEED = 3.5;
function plan(a, b) {
  const s = UG.graph.findStation(G, a), t = UG.graph.findStation(G, b);
  const from = { kind: 'station', si: s }, to = { kind: 'station', si: t };
  const route = UG.router.findRoute(G, from, to);
  const p = UG.steps.planItems(G, { from, to, route }, SPEED);
  TR.annotate(G, p, SPEED);
  return p;
}
const xfers = (p) => p.items.filter((it) => it.xfer).map((it) => it.xfer);
const show = (x) => `${x.station}: ${x.from.line}(${TR.levelText(x.from)}) → ${x.to.line}(${TR.levelText(x.to)})` +
  `${x.move ? ' ' + x.move : ''} | ${x.dir ? x.dir.line + ' ' + x.dir.head : '-'} | ${x.distance_m}m 약 ${TR.fmtMin(x.minutes)} ${x.source_label} | ${x.underground ? '지하' : '지상'}`;
const seoulMin = (m) => m / 1.2 / 60;

/* ---------- 1) 서울역 → 강남 ---------- */
TR.setExtra(null);
const p1 = plan('서울역', '강남');
const x1 = xfers(p1);
x1.forEach((x) => console.log('    ' + show(x)));
check(x1.map((x) => x.station).join(',') === '공덕,여의도,신논현' && p1.view.transfers === 3, `서울역→강남 환승 ${p1.view.transfers}회: ${x1.map((x) => x.station).join(', ')}`);
const [gd, yd, sn] = x1;
check(gd.from.line === '공항철도' && gd.to.line === '5호선' && gd.from.depth_m === null && gd.to.floor === 'B3' && gd.to.depth_m === 20.29 && gd.delta_m === null && gd.hasDepth,
  '공덕: 공항철도(깊이 자료 없음) → 5호선 B3 20.29m, 깊이 차이는 한쪽만 있어 없음');
check(gd.source_label === '서울교통공사 실측 거리' && Math.abs(gd.minutes - seoulMin(275)) < 1e-9 && TR.fmtMin(gd.minutes) === '4분', `공덕: 275m ÷ 1.2m/s = ${TR.fmtMin(gd.minutes)}, 출처 '${gd.source_label}'`);
check(gd.dir && gd.dir.line === '5호선' && gd.dir.head === '방화 방면' && gd.dir.next === '마포' && gd.dir.terminal, `공덕: 갈아탈 방향 ${gd.dir && gd.dir.head}(다음 역 ${gd.dir && gd.dir.next})`);
check(gd.micro.length === 3 && gd.micro[0] === '공항철도 선로에서 공덕역 승강장으로 올라가기' &&
  gd.micro[1] === '환승 통로를 따라 5호선 승강장으로 (275m, 약 4분)' && gd.micro[2] === '방화 방면 선로로 내려가 걷기', '공덕: 행동 안내 세 줄');
check(yd.from.line === '5호선' && yd.from.floor === 'B4' && yd.to.line === '9호선' && yd.to.depth_m === null && yd.dir.head === '중앙보훈병원 방면' && TR.fmtMin(yd.minutes) === '1분',
  '여의도: 5호선 B4 → 9호선(깊이 없음), 중앙보훈병원 방면, 68m 약 1분');
check(sn.source === 'estimated' && sn.source_label === '추정 거리' && Math.abs(sn.minutes - 195 / (SPEED * 1000 / 60)) < 1e-9 && !sn.hasDepth && sn.to.line === '신분당선' && sn.dir.head === '광교 방면',
  `신논현: 추정 거리, 걷는 속도 시속 ${SPEED}km로 ${TR.fmtMin(sn.minutes)}, 깊이 자료 없음(카드에서 숨김)`);
check(x1.every((x) => x.underground), '서울역→강남: 환승 통로 모두 지하');

/* ---------- 2) 부평 → 구로: 신도림 지상 환승, 까치산 같은 깊이 ---------- */
const p2 = plan('부평', '구로');
const x2 = xfers(p2);
x2.forEach((x) => console.log('    ' + show(x)));
const sd = x2.find((x) => x.station === '신도림'), kc = x2.find((x) => x.station === '까치산');
check(!!sd && sd.from.line === '2호선' && sd.to.line === '1호선' && !sd.underground && !sd.to.ug && TR.levelText(sd.to) === '지상' && /지상 노출/.test(sd.micro[1]),
  '신도림: 2호선 → 1호선, 지상 통로(1호선 승강장 지상), 행동 안내에 지상 노출');
check(!!sd && sd.source_label === '서울교통공사 실측 거리' && TR.fmtMin(sd.minutes) === '1분' && sd.dir && sd.dir.head === '인천·신창(순천향대) 방면' && sd.dir.next === '구로',
  `신도림: 81m 약 ${sd && TR.fmtMin(sd.minutes)}, ${sd && sd.dir && sd.dir.head}(다음 역 구로)`);   // 1호선은 구로 뒤에서 갈라져 가장 긴 두 종착역을 적는다
check(!!kc && kc.delta_m === 0 && kc.move === '같은 깊이', `까치산: 5호선 B5 → 2호선 B5, '${kc && kc.move}'`);

/* ---------- 3) 종각 → 안국: 종로3가 깊이 차이 ---------- */
const x3 = xfers(plan('종각', '안국'));
x3.forEach((x) => console.log('    ' + show(x)));
const jr = x3[0];
check(!!jr && jr.station === '종로3가' && jr.from.floor === 'B2' && jr.to.floor === 'B4' && Math.abs(jr.delta_m - (20.25 - 11.24)) < 1e-9 && jr.move === '약 9m 아래로',
  `종로3가: 1호선 B2 → 3호선 B4, ${jr && jr.move}`);

/* ---------- 4) steps.js 출력은 그대로(새 내용은 item.xfer 에만) ---------- */
const keys = p1.desc.steps.filter((s) => s.type === 'transfer').map((s) => Object.keys(s).filter((k) => !k.startsWith('_')).sort().join(','));
check(keys.every((k) => k === 'distance_m,est_minutes,from_line,no,source,station,to_line,type,underground'), 'transfer 단계의 키는 바뀌지 않음(route.py 와 같음)');

/* ---------- 5) 덧붙는 자료(extra.json 'extra-1') 예시 ---------- */
const si = (n) => UG.graph.findStation(G, n);
const fixture = {
  format: 'extra-1',
  fast: [
    // 공덕 공항철도 -> 5호선: 열차가 서울역에서 오는 방향(prev = 서울역)이면 앞쪽
    { s: si('공덕'), line: '공항철도', to_line: '5호선', prev: si('서울역'), toward: si('홍대입구'), next: si('마포'), next_name: '마포', car: 4, door: 2, cars: 6, pos: 'front' },
    { s: si('공덕'), line: '공항철도', to_line: '5호선', prev: si('서울역'), toward: si('홍대입구'), next: si('애오개'), next_name: '애오개', car: 6, door: 4, cars: 6, pos: 'back' },
    // 여의도 5 -> 9: 자료는 반대 방향 열차 기준(신길에서 와서 여의나루 쪽으로) -> 여의나루에서 걸어온 사람에게는 앞뒤가 바뀐다
    { s: si('여의도'), line: '5호선', to_line: '9호선', prev: si('신길'), toward: si('여의나루'), next: null, next_name: '', car: 2, door: 1, cars: 8, pos: 'front' }
  ],
  exits: { [String(si('강남'))]: { '11': ['역삼동', '강남역사거리', '테헤란로'] } }
};
TR.setExtra(fixture);
const x5 = xfers(plan('서울역', '강남'));
check(x5[0].fast && x5[0].fast.side === '앞쪽' && x5[0].fast.door === '4-2' && TR.fastText(x5[0].fast) === '승강장 앞쪽(진행 방향) 환승 계단' && x5[0].credits[0] === '국토교통부 빠른 환승 정보',
  `빠른 환승(공덕): 다음 역 마포와 맞는 기록 → ${x5[0].fast && TR.fastText(x5[0].fast)} · ${x5[0].fast && x5[0].fast.door}번 문`);
check(x5[1].fast && x5[1].fast.pos === 'back' && x5[1].fast.side === '뒤쪽', `빠른 환승(여의도): 걸어온 방향이 자료와 반대라 앞쪽 → ${x5[1].fast && x5[1].fast.side}`);
check(!x5[2].fast && x5[2].credits.length === 0, '빠른 환승(신논현): 자료 없음 → 표시 안 함');
check(TR.exitAreas(si('강남'), '11').join(',') === '역삼동,강남역사거리,테헤란로' && TR.exitAreas(si('강남'), '99').length === 0, '출구 주변(강남 11번): 역삼동 · 강남역사거리 · 테헤란로, 없는 출구는 빈 목록');
// prev_alt: 걸어온 역이 prev 는 아니지만 prev_alt 에 있으면 같은 방향(뒤집지 않음)
TR.setExtra({ format: 'extra-1', exits: {}, fast: [
  { s: si('공덕'), line: '공항철도', to_line: '5호선', prev: si('홍대입구'), prev_alt: [si('서울역')], toward: '', next: null, next_name: '', car: 1, door: 1, cars: 6, pos: 'back' }] });
const alt = xfers(plan('서울역', '강남'))[0].fast;
check(alt && alt.side === '뒤쪽', `prev_alt 에 걸어온 역(서울역)이 있으면 뒤집지 않음 → ${alt && alt.side}`);
TR.setExtra({ format: 'other' });
check(!TR.hasExtra() && !xfers(plan('서울역', '강남'))[0].fast, '형식이 다른 extra.json 은 쓰지 않음');

/* ---------- 5-1) 실제 extra.json(있으면): 형식이 맞고, 공덕에는 계단 위치가 있고, 신논현(자료 없음)에는 없다 ---------- */
const EXTRA = path.join(ROOT, 'web/data/extra.json');
if (fs.existsSync(EXTRA)) {
  TR.setExtra(JSON.parse(fs.readFileSync(EXTRA, 'utf8')));
  const xr = xfers(plan('서울역', '강남'));
  xr.forEach((x) => console.log(`    ${x.station}: ${x.fast ? TR.fastText(x.fast) + (x.fast.door ? ' · ' + x.fast.door + '번 문' : '') : '빠른 환승 자료 없음'}`));
  check(TR.hasExtra() && xr[0].fast && ['앞쪽', '가운데', '뒤쪽'].indexOf(xr[0].fast.side) >= 0 && !xr[2].fast,
    'extra.json: 공덕은 계단 위치 있음, 신논현은 없음');
  const ex = TR.exitAreas(si('서울역'), '1');
  console.log(`    서울역 1번 출구 주변: ${ex.join(', ') || '(없음)'}`);
  TR.setExtra(null);
} else console.log('    (web/data/extra.json 없음: 예시 자료로만 시험)');

/* ---------- 6) 경로에서 벗어남(길 안내 GPS) ---------- */
const track = UG.guide.routeTrack(G, p1);
const mid = UG.guide.pointAt(track, track.total / 2);
const onRoute = UG.guide.distanceToTrack(track, mid[0], mid[1]);
const away = UG.guide.distanceToTrack(track, mid[0] + 0.0027, mid[1]);   // 북쪽으로 약 300m
check(onRoute < 1 && away > 150, `경로 위 점 ${onRoute.toFixed(1)}m, 북쪽 300m 점 ${Math.round(away)}m(150m 넘으면 '경로에서 벗어남')`);

process.exitCode = ok ? 0 : 1;
console.log(ok ? '모두 통과' : '실패 있음');
