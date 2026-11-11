// build_3d.js — 3D 지하 이동 화면(web/3d/)이 쓰는 자료 web/3d/ride.json 을 만든다.
// 사용법(프로젝트 폴더에서): node scripts\build_3d.js
//   시연 1번 이야기(web/js/demo.js CONF.story, scripts/check_demo.js 와 같은 순서)를 앱 코드로 다시 계산한다:
//   공덕역 2번 출구로 들어감 → 5호선 마포–여의나루 하저터널에서 막힘 → 마포역으로 되돌아감
//   → 다른 하저터널(광나루–천호)로 다시 찾은 길 → 가족 약속 장소(수서) 도착. 끝으로 수서 → 동탄(남쪽으로 이어지는 지하)도 계산한다.
// 필요한 자료(저장소에 넣지 않는 것)
//   - data/raw/terrain/12_{3491..3494}_{1585..1591}.png : 지형 타일(Terrarium 형식, SRTM 기반, 키 없이 받음)
//     https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/{x}/{y}.png 를 같은 이름 규칙으로 저장한다.
//     높이 = R×256 + G + B/256 − 32768 (m, 해발). PNG 는 Node 기본 zlib 로 직접 푼다(패키지 없음).
//   - data/raw/seoul/station_depth_20241104.csv, data/raw/seoul9/station_depth9_20260131.csv : 서울교통공사 역사심도정보(EUC-KR)
//     지반고·레일면고 = 해발 + 100.3m (docs/depth-sources.md). 해발 = 값 − 100.3.
// 높이(모두 해발 m, 과장 없이 내보낸다. 화면이 exag 배로 늘린다)
//   - 역 레일 높이: 공식 CSV 값 → 없으면 위키 깊이 → 없으면 층수 평균 깊이(지반 − 깊이) → 그래도 없으면 앞뒤 역 사이 보간(추정).
//   - 역 사이 선로: 승강장은 평평하게, 그 사이는 한 가지 기울기 + 양 끝 종곡선(반지름 3,000m)으로 잇는다.
//     기울기가 35‰ 를 넘으면 승강장 평평한 구간을 줄여 본다(표에 적는다). 35‰ 를 넘으면 오류로 멈춘다.
//   - 지반: SRTM 을 공식 역 지반고에 맞춰 보정(역마다 차이를 거리 가중으로 섞음). 한강 수면 = 강 중심선 위 SRTM 의 중앙값.
//     강바닥 자료는 없어서 만들지 않는다(수면과 터널 사이는 화면에서 '자료 없음'으로 둔다).
//   - 수평 선형: OSM 선로를 10m 간격으로 나눠 OSM 에서 10m 넘게 벗어나지 않는 범위에서 부드럽게 편다(꺾인 점 없애기).
//   - 환승·입구: 승강장 → 에스컬레이터(30°) → 대합실(지하 1층, 지반 − 6m, 추정) → 에스컬레이터 → 승강장.
//     환승 계단 자리는 빠른 환승 자료(web/data/extra.json fast)의 칸 번호가 있으면 그 칸 앞에 둔다.
// 내보내는 것(web/3d/ride.json, 형식 jiharo-3d-4). 화면(web/3d/ride.js)은 3판 그림 그대로이고 선로 모양·높이만 위의 실제 값이다(11-1절)
//   - legs: 구간별 점 [위도, 경도, 구간 m(앱 거리), 그릴 깊이 m, 한강 아래 정도 0~1, 한강 단면 정도 0~1, 실제 깊이 m]
//   - stations(승강장 깊이: 공식 자료가 있는 역만), structs(승강장 상자 · 대합실 판, 개략), river(중심선·그림용 반폭), net, facts, tables(종단·평면 표)
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
for (const f of ['graph', 'junctions', 'router', 'exithere', 'steps', 'transfer', 'nearest', 'guide', 'reach', 'saved', 'demo']) require(path.join(ROOT, 'web/js', f + '.js'));
const UG = globalThis.UG, GR = UG.graph;
// 시연 설정: demo.js 의 CONF 를 쓴다(없으면 같은 값). 한강 횡단 찾기(hanCrossing)도 demo.js 것을 쓴다
const CONF = (UG.demo && UG.demo.CONF) || { speedKmh: 3.5, story: { lat: 37.5447, lon: 126.9497, label: '공덕오거리 부근', meet: '수서@서울', blockAfter: '마포@서울', blockFrac: 0.45 } };
const Y = CONF.story;
const SOUTH = '동탄';   // 끝 장면: 수서에서 남쪽으로 이어지는 지하
const g = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/data/graph.json'), 'utf8'));
const G = GR.indexGraph(g);
const E = g.edges, T = g.tables, S = g.stations;
const EXAG = 10;   // 화면 세로 과장 배율(3판과 같은 값). 역 안 경사 길이를 이 배율로 정한다(11-1절)

/* ---------- 1. 경로 계산 (check_demo.js 와 같은 순서) ---------- */
const blocked = new Set();
function planOf(from, to) {
  const route = UG.router.findRoute(G, from, to, { blocked }) || UG.router.findRoute(G, from, to, { blocked, surface: true });
  if (!route) throw new Error('경로 없음');
  const p = { from, to, route };
  UG.steps.planItems(G, p, CONF.speedKmh);
  return p;
}
const si = (q) => GR.findStation(G, q);
const stEp = (i) => ({ kind: 'station', si: i, text: S[i].name, lat: S[i].lat / 1e5, lon: S[i].lon / 1e5 });
const meetSi = si(Y.meet);
const near = UG.nearest.nearestUnderground(G, Y.lat, Y.lon, { limit: 3 });
const o1 = near.options[0];                                        // 가장 가까운 지하로(공덕역 2번 출구)
const ep = UG.nearest.endpointsFor(G, Y.lat, Y.lon, o1, Y.label);
const p1 = planOf(ep.from, ep.to);                                 // 거리 → 출구 → 승강장
const from2 = { kind: 'station', si: o1.si, hubs: UG.reach.underHubs(G, o1.si), text: S[o1.si].name + '역 지하 승강장', lat: S[o1.si].lat / 1e5, lon: S[o1.si].lon / 1e5 };
const p2 = planOf(from2, stEp(meetSi));
const cps2 = UG.guide.buildCheckpoints(G, p2);
const at = cps2.findIndex((c) => c.si === si(Y.blockAfter));       // 마포역 체크포인트
const walked = (cps2[at + 1].at - cps2[at].at) * Y.blockFrac;      // 마포에서 터널로 걸어 들어간 거리
const crossA = UG.demo.hanCrossing(G, p2.route.path);
const b = UG.guide.planBlock(G, { plan: p2, cps: cps2, cur: at }, walked);
b.edges.forEach((e) => blocked.add(e));
const p3 = planOf(b.from, p2.to);                                  // 마포에서 다시 찾은 길
const crossB = UG.demo.hanCrossing(G, p3.route.path);
// '두 곳뿐' 확인: 5호선 하저터널 두 곳을 다 막으면 가장 나은 길도 지상을 걷는다
const both = new Set(blocked);
g.presets.han_crossings.filter((x) => x.s === 'tunnel' && (x.lines || []).includes('5호선')).forEach((x) => both.add(x.e));
const pNone = UG.router.findRoute(G, b.from, p2.to, { blocked: both }) || UG.router.findRoute(G, b.from, p2.to, { blocked: both, surface: true });
blocked.clear();
const p4 = planOf(stEp(meetSi), stEp(si(SOUTH)));                  // 수서 → 동탄(막은 곳 없이)

/* ---------- 2. 조각: 안내(guide.routeTrack)와 같은 순서·거리 ----------
   조각 = { pts, len, from, e(간선, 걷기 = -1), k(간선 종류), u, v }. 거리는 앱의 간선 길이(len)를 쓴다 */
function pieces(plan) {
  const path = plan.route.path, out = [];
  plan.items.forEach((it) => {
    if (['walk', 'enter', 'exit', 'approach', 'egress'].includes(it.kind)) { if (it.latlngs && it.m > 0) out.push({ pts: it.latlngs, len: it.m, e: -1, walk: true }); return; }
    if (it.kind !== 'step' || it.step.type === 'warning') return;
    it.step._idx.forEach((i) => {
      const x = path[i];
      if (it.step.type === 'surface' && it.step._pts) out.push({ pts: it.step._pts, len: it.step._m, e: -1, walk: true });
      else out.push({ pts: GR.edgeShape(g, x.e, x.u), len: E.len[x.e], e: x.e, k: T.kinds[E.k[x.e]], u: x.u, v: x.v });
    });
  });
  let m = 0;
  out.forEach((p) => { p.from = m; m += p.len; });
  const want = UG.guide.routeTrack(G, plan).total;
  if (Math.abs(m - want) > 0.5) throw new Error(`거리 불일치 ${m} != ${want}`);
  return out;
}

/* ---------- 3. 역 찾기 ---------- */
const nodeSt = new Map();   // 노드 → 역(승강장 허브·선로 위 부착점)
S.forEach((s, i) => {
  s.hubs.forEach((v, j) => nodeSt.set(v, { si: i, ls: s.hub_ls[j] }));
  (s.plat || []).forEach((v) => { if (!nodeSt.has(v)) nodeSt.set(v, { si: i, ls: -1 }); });
});
// 노드 v(간선 e 위)의 노선 묶음: 허브면 허브 노선, 선로 위 부착점이면 간선 노선(승강장 간선은 노선이 비어 있어 반대쪽 허브 노선)
function lineSetOf(v, e) {
  const x = nodeSt.get(v);
  if (x.ls >= 0) return T.line_sets[x.ls] || [];
  if ((T.line_sets[E.ls[e]] || []).length) return T.line_sets[E.ls[e]];
  const o = nodeSt.get(E.a[e] === v ? E.b[e] : E.a[e]);
  return o && o.ls >= 0 ? T.line_sets[o.ls] || [] : [];
}
// 노드 v(간선 e 위)의 노선 번호: 깊이 기록이 있으면 그 노선, 없으면 간선 노선의 첫 번째
function lineOf(v, e) {
  const x = nodeSt.get(v), set = lineSetOf(v, e);
  const r = x && S[x.si].depth ? S[x.si].depth.find((d) => set.includes(d.line)) : null;
  return r ? r.line : set[0];
}

/* ---------- 4. 평면 좌표(m) ---------- */
const LAT0 = 37.53, LON0 = 127.0, KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110540;   // 이 범위에서 오차 1% 미만
const toXY = (p) => [(p[1] - LON0) * KX, (p[0] - LAT0) * KY];   // 동쪽 x, 북쪽 y
const toLL = (q) => [q[1] / KY + LAT0, q[0] / KX + LON0];
const nodeXY = (v) => toXY([g.nodes.lat[v] / 1e5, g.nodes.lon[v] / 1e5]);
const add = (a, c) => [a[0] + c[0], a[1] + c[1]], sub = (a, c) => [a[0] - c[0], a[1] - c[1]], mul = (a, k) => [a[0] * k, a[1] * k];
const len = (a) => Math.hypot(a[0], a[1]), unit = (a) => mul(a, 1 / (len(a) || 1)), dot = (a, c) => a[0] * c[0] + a[1] * c[1];
const lerp2 = (a, c, t) => [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t];
const xyOf = (pts) => pts.map(toXY);
function distToLine(q, line) {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], d = sub(line[i], a), L = dot(d, d);
    const t = L > 0 ? Math.max(0, Math.min(1, dot(sub(q, a), d) / L)) : 0;
    best = Math.min(best, len(sub(q, add(a, mul(d, t)))));
  }
  return best;
}
const median = (a) => { const s = a.slice().sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };
const r1 = (x) => Math.round(x * 10) / 10, r2 = (x) => Math.round(x * 100) / 100;

/* ---------- 5. 지형: Terrarium 타일(SRTM) → 공식 역 지반고로 보정 ---------- */
function decodePNG(buf) {   // 8비트 RGB/RGBA, 비월 없음만(타일 형식)
  let p = 8, w, h, ct;
  const idat = [];
  while (p < buf.length) {
    const n = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + n);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; if (data[8] !== 8 || data[12] !== 0) throw new Error('지원하지 않는 PNG'); }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + n;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0;
  if (!bpp) throw new Error('지원하지 않는 PNG 색 형식 ' + ct);
  const raw = zlib.inflateSync(Buffer.concat(idat)), out = Buffer.alloc(w * h * bpp), stride = w * bpp;
  for (let y = 0; y < h; y++) {   // 줄마다 필터(0 없음 1 왼쪽 2 위 3 평균 4 Paeth)를 되돌린다
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), o = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[o + i - bpp] : 0, c = y ? out[o - stride + i] : 0, d = i >= bpp && y ? out[o - stride + i - bpp] : 0;
      let v = src[i];
      if (f === 1) v += a; else if (f === 2) v += c; else if (f === 3) v += (a + c) >> 1;
      else if (f === 4) { const pp = a + c - d, pa = Math.abs(pp - a), pb = Math.abs(pp - c), pc = Math.abs(pp - d); v += pa <= pb && pa <= pc ? a : pb <= pc ? c : d; }
      out[o + i] = v & 255;
    }
  }
  return { w, h, bpp, data: out };
}
const TZ = 12, tiles = new Map();
function tile(x, y) {
  const key = x + '_' + y;
  if (!tiles.has(key)) {
    const f = path.join(ROOT, 'data/raw/terrain', `${TZ}_${key}.png`);
    if (!fs.existsSync(f)) { tiles.set(key, null); return null; }   // 받아 둔 범위 밖(가장자리)
    const t = decodePNG(fs.readFileSync(f)), h = new Float32Array(t.w * t.h);
    for (let i = 0; i < h.length; i++) h[i] = t.data[i * t.bpp] * 256 + t.data[i * t.bpp + 1] + t.data[i * t.bpp + 2] / 256 - 32768;
    tiles.set(key, h);
  }
  return tiles.get(key);
}
// 위도·경도 → 타일 화소(웹 메르카토르, 확대 12). 화소 가운데 값을 겹선형으로 섞는다(화소 하나 약 30m)
function srtmLL(lat, lon) {
  const n = 2 ** TZ * 256, r = lat * Math.PI / 180;
  const X = (lon + 180) / 360 * n - 0.5, Yp = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n - 0.5;
  const x0 = Math.floor(X), y0 = Math.floor(Yp), fx = X - x0, fy = Yp - y0;
  const px = (x, y) => { const t = tile(Math.floor(x / 256), Math.floor(y / 256)); return t ? t[(y & 255) * 256 + (x & 255)] : NaN; };
  return (px(x0, y0) * (1 - fx) + px(x0 + 1, y0) * fx) * (1 - fy) + (px(x0, y0 + 1) * (1 - fx) + px(x0 + 1, y0 + 1) * fx) * fy;
}
const srtm = (q) => srtmLL(...toLL(q));
// SRTM 은 건물·나무가 섞인 겉면 높이다(서울 아파트 단지에서 30~60m 높게 나옴). 지반으로 쓰려고 둘레 ±140m(35m 간격 9×9)의 낮은 값(하위 15%)을 쓴다
function dtm(q) {
  const v = [];
  for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) v.push(srtm([q[0] + i * 35, q[1] + j * 35]));
  const w = v.filter((x) => isFinite(x)).sort((a, c) => a - c);
  return w[Math.floor(w.length * 0.15)];
}
// 받아 둔 타일 범위(x 3491~3494, y 1585~1591): 위도·경도 경계 → 평면 m
const TX0 = 3491, TX1 = 3495, TY0 = 1585, TY1 = 1592;
const tileLat = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** TZ))) * 180 / Math.PI, tileLon = (x) => x / 2 ** TZ * 360 - 180;
for (let x = 3491; x <= 3494; x++) for (let y = 1585; y <= 1591; y++) if (!fs.existsSync(path.join(ROOT, 'data/raw/terrain', `${TZ}_${x}_${y}.png`))) throw new Error(`지형 타일 없음: data/raw/terrain/${TZ}_${x}_${y}.png (이 파일 첫머리의 받는 법 참고)`);
const COVER = [...toXY([tileLat(TY1), tileLon(TX0)]), ...toXY([tileLat(TY0), tileLon(TX1)])].map((v, i) => v + (i < 2 ? 100 : -100));   // [x0, y0, x1, y1], 가장자리 100m 안쪽
const covered = (q) => q[0] > COVER[0] && q[0] < COVER[2] && q[1] > COVER[1] && q[1] < COVER[3];

// 서울교통공사 역사심도정보(CSV): 역 이름 + 호선 → 지반·레일 해발, 층수, 형식, 깊이
const ALIAS = { 을지3가: '을지로3가', 을지4가: '을지로4가', 구로디지털: '구로디지털단지', 당고개: '불암산', 미아삼거리: '미아사거리', 애오게: '애오개', 동대문운동장: '동대문역사문화공원', 둔촌: '둔촌동', DMC: '디지털미디어시티', 뚝섬유원지: '자양', 숭실대: '숭실대입구', 신대방: '신대방삼거리', 광명: '광명사거리' };   // scripts/build_graph.py DEPTH_ALIASES 와 같은 값
const CSV = new Map(), csvRows = [];
for (const f of ['data/raw/seoul/station_depth_20241104.csv', 'data/raw/seoul9/station_depth9_20260131.csv']) {
  const text = new TextDecoder('euc-kr').decode(fs.readFileSync(path.join(ROOT, f)));
  text.split(/\r?\n/).slice(1).filter((l) => l.trim()).forEach((l) => {
    const c = l.split(','), name = ALIAS[c[2].trim()] || c[2].trim();   // 비고 칸에만 쉼표가 있어 앞 9칸은 그대로 나뉜다
    const row = { name, num: c[1].trim(), floor: c[3].trim(), form: c[4].trim(), g: +c[5] - 100.3, z: +c[6] - 100.3, track_m: +c[7], plat_m: +c[8] };
    CSV.set(name + '|' + row.num, row); csvRows.push(row);
  });
}
// 보정: 공식 역 지반고 − SRTM(역 좌표). 같은 역의 여러 호선 값은 평균. 가까운 역 차이를 가우스 가중(σ 700m)으로 섞고, 먼 곳은 중앙값 쪽으로
const byName = new Map();
S.forEach((s, i) => { if (!byName.has(s.name)) byName.set(s.name, i); });
const ctrl = [];
{
  const acc = new Map();
  csvRows.forEach((r) => { const i = byName.get(r.name); if (i == null) return; const a = acc.get(i) || []; a.push(r.g); acc.set(i, a); });
  acc.forEach((gs, i) => { const q = toXY([S[i].lat / 1e5, S[i].lon / 1e5]); const ok = gs.filter((x) => isFinite(x)); if (covered(q) && ok.length) ctrl.push({ q, d: ok.reduce((a, c) => a + c, 0) / ok.length - dtm(q), n: S[i].name }); });
}
const OFF_MED = median(ctrl.map((c) => c.d)), SIG = 700;
const ctrlAll = ctrl.length, dropped = ctrl.filter((c) => Math.abs(c.d - OFF_MED) > 12).map((c) => c.n + ' ' + c.d.toFixed(0) + 'm');   // 12m 넘게 어긋나는 역은 빼다(DTM 추정이 틀린 곳)
ctrl.splice(0, ctrl.length, ...ctrl.filter((c) => Math.abs(c.d - OFF_MED) <= 12));
function offAt(q) {
  let sw = 0.15, sd = 0.15 * OFF_MED;
  for (const c of ctrl) { const dx = c.q[0] - q[0], dy = c.q[1] - q[1], r2_ = dx * dx + dy * dy; if (r2_ > 9 * SIG * SIG) continue; const w = Math.exp(-r2_ / (SIG * SIG)); sw += w; sd += w * c.d; }
  return sd / sw;
}
const groundRaw = (q) => dtm(q) + offAt(q);

/* ---------- 5-1. 한강 수면 띠 ----------
   중심선(data/raw/han_river.json)을 100m 간격으로 나눈다. 수면 높이 = 중심선 위 SRTM 의 ±1km 중앙값(다리·배 때문에 중앙값).
   폭 = 중심선에서 양옆으로 SRTM 이 수면 + 3m 를 넘는 곳까지(30~800m, 다리 때문에 ±500m 중앙값). 강바닥은 만들지 않는다. */
const hanAll = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/raw/han_river.json'), 'utf8')).elements[0].geometry.map((p) => toXY([p.lat, p.lon]));
function resample(poly, step) {
  const out = [poly[0]];
  let carry = 0;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], d = sub(poly[i], a), L = len(d);
    let s = step - carry;
    while (s <= L) { out.push(add(a, mul(d, s / L))); s += step; }
    carry = L - (s - step);
  }
  return out;
}
// 경로 둘레 상자(본 그림 범위): 처음 길·다시 찾은 길 + 3km
const routeLL = [p1, p2, p3].flatMap((p) => pieces(p).flatMap((x) => x.pts));
const BOX = routeLL.reduce((bb, p) => { const q = toXY(p); return [Math.min(bb[0], q[0]), Math.min(bb[1], q[1]), Math.max(bb[2], q[0]), Math.max(bb[3], q[1])]; }, [1e9, 1e9, -1e9, -1e9]);
const PAD = 6000;   // 그림 범위: 경로 둘레 6km(넓게 보는 장면에서 지형 끝이 덜 보이게)
const MAIN = [Math.max(COVER[0] + 200, BOX[0] - PAD), Math.max(COVER[1] + 200, BOX[1] - PAD), Math.min(COVER[2] - 200, BOX[2] + PAD), Math.min(COVER[3] - 200, BOX[3] + PAD)];   // 받아 둔 타일 안으로
const inMain = (q, pad = 0) => q[0] > MAIN[0] - pad && q[0] < MAIN[2] + pad && q[1] > MAIN[1] - pad && q[1] < MAIN[3] + pad;
const han = resample(hanAll, 100).filter((q) => inMain(q, 1500));
const hanS = han.map((q, i) => i * 100);
const hanRaw = han.map(srtm);
const river = han.map((q, i) => {
  const W = median(hanRaw.filter((_, j) => Math.abs(j - i) <= 10));
  const a = han[Math.max(0, i - 1)], c = han[Math.min(han.length - 1, i + 1)], t = unit(sub(c, a)), n = [-t[1], t[0]];   // n = 진행 방향 왼쪽
  const side = (s) => { for (let d = 30; d <= 800; d += 10) if (srtm(add(q, mul(n, d * s))) > W + 3) return d; return 800; };
  return { q, n, W, wl: side(1), wr: side(-1) };
});
river.forEach((r, i) => {   // 다리 때문에 폭이 줄어든 곳을 ±500m 중앙값으로 메운다
  const win = river.slice(Math.max(0, i - 5), i + 6);
  r.WL = Math.max(120, median(win.map((x) => x.wl))); r.WR = Math.max(120, median(win.map((x) => x.wr)));
});
// q 가 수면 띠 안이면 그 자리 수면 높이, 아니면 null
function waterAt(q) {
  let best = null, bd = Infinity;
  for (let i = 1; i < river.length; i++) {
    const a = river[i - 1].q, d = sub(river[i].q, a), L = dot(d, d), t = Math.max(0, Math.min(1, dot(sub(q, a), d) / L));
    const pr = add(a, mul(d, t)), dd = len(sub(q, pr));
    if (dd < bd) { bd = dd; best = { i, t, off: dot(sub(q, pr), lerp2(river[i - 1].n, river[i].n, t)), end: (i === 1 && t === 0) || (i === river.length - 1 && t === 1) }; }
  }
  if (!best || best.end) return null;
  const r0 = river[best.i - 1], r1_ = river[best.i], k = best.t;
  const WL = r0.WL + (r1_.WL - r0.WL) * k, WR = r0.WR + (r1_.WR - r0.WR) * k;
  return best.off <= WL && best.off >= -WR ? r0.W + (r1_.W - r0.W) * k : null;
}
const ground = (q) => { const w = waterAt(q); return w != null ? w : groundRaw(q); };

/* ---------- 6. 역 높이 ---------- */
// 공식 CSV 가 없는 역: 위키 깊이(m) 또는 층수. 깊이는 승강장 기준. docs/depth-sources.md 2절 표
const FLOOR_PD = { B2: 13.5, B3: 19.0, B4: 25.2, B5: 30.6, B6: 39.1 };   // 공식 CSV 층수별 승강장 깊이 평균(depth-sources.md 6절, 추정)
const SRC = {
  '여의도|9호선': { pd: 14.9, floor: 'B2', note: '위키: 역 구조 깊이(승강장 기준인지 확인 못 함)' },
  '샛강|9호선': { floor: 'B3' }, '노량진|9호선': { floor: 'B2' }, '노들|9호선': { floor: 'B2' }, '흑석|9호선': { floor: 'B2' },
  '동작|9호선': { floor: 'B3' }, '구반포|9호선': { floor: 'B3' }, '신반포|9호선': { floor: 'B2' }, '고속터미널|9호선': { floor: 'B5' },
  '사평|9호선': { floor: 'B3' }, '신논현|9호선': { floor: 'B4' },
  '선정릉|수인분당선': { pd: 40, floor: 'B5', note: '위키 40m(구룡과 같은 값, 거친 값)' }, '한티|수인분당선': { floor: 'B4' }, '도곡|수인분당선': { floor: 'B6' },
  '구룡|수인분당선': { pd: 40, floor: 'B6', note: '위키 약 40m' }, '개포동|수인분당선': { floor: 'B5' }, '대모산입구|수인분당선': { floor: 'B5' }, '수서|수인분당선': { floor: 'B4' },
  '수서|GTX-A': { floor: 'B4' }, '수서|수서평택고속선': { floor: 'B4' },
  '동탄|GTX-A': { pd: 42.73, floor: 'B6', note: '위키 42.73m(같은 문서에 45m 표현도 있음)' }, '동탄|수서평택고속선': { pd: 42.73, floor: 'B6', note: '위키 42.73m' }, '동탄|*': { pd: 42.73, floor: 'B6', note: '위키 42.73m(GTX-A·SRT)' }
};
const LIFT = 1.1;    // 승강장 바닥 − 레일(공식 CSV 의 선로 기준 깊이 − 승강장 기준 깊이가 모두 1.1m)
const CARS = { '2호선': 10, '3호선': 10, '5호선': 8, '8호선': 6, '9호선': 6, '수인분당선': 6, 'GTX-A': 8, '수서평택고속선': 10 };
const CAR = 20;      // 차량 한 칸 길이(개략)
function stInfo(sIdx, li, q) {
  const name = S[sIdx].name, ls = T.line_short[li] || '', num = (ls.match(/^(\d)호선$/) || [])[1];
  const r = num && CSV.get(name + '|' + num), gq = groundRaw(q);
  const Lp = (CARS[ls] || 8) * CAR;
  if (r) return { src: '공식', z: r.z, g: r.g, floor: r.floor, form: r.form, track_m: r.track_m, plat_m: r.plat_m, Lp };
  const w = SRC[name + '|' + ls] || SRC[name + '|*'];
  if (w) {
    const pd = w.pd != null ? w.pd : FLOOR_PD[w.floor];
    return { src: w.pd != null ? '위키' : '층수', z: gq - pd - LIFT, g: gq, floor: w.floor, form: '', track_m: r2(pd + LIFT), plat_m: pd, note: w.note || `층수 ${w.floor}(위키) → 공식 자료 ${w.floor} 역들의 평균 깊이`, Lp };
  }
  return { src: '추정', z: null, g: gq, floor: '', form: '', track_m: null, plat_m: null, Lp };
}

/* ---------- 7. 수평 선형 펴기 ---------- */
const STEP = 10, MAXDEV = 10, RK = 4;   // 점 간격 · OSM 에서 벗어나도 되는 거리 · 반지름 잴 때 앞뒤 점 수(±40m)
function circum(a, b, c) {   // 세 점을 지나는 원의 반지름(일직선이면 무한)
  const A = len(sub(b, c)), B = len(sub(a, c)), C = len(sub(a, b)), cr = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  return cr < 1e-9 ? Infinity : (A * B * C) / (2 * cr);
}
const radii = (P) => P.map((p, i) => (i < RK || i >= P.length - RK ? Infinity : circum(P[i - RK], p, P[i + RK])));
// 라플라스 평활(이웃 평균 쪽으로 반씩) 400번. 매번 OSM 선(원래 점 이은 선)에서 10m 넘게 벗어난 점은 10m 로 되돌린다. 양 끝은 고정
function smooth(O) {
  const P = O.map((p) => p.slice()), n = P.length;
  const proj = (q, i) => {   // 원래 선(앞뒤 30점)에서 가장 가까운 점
    let best = null, bd = Infinity;
    for (let j = Math.max(1, i - 30); j < Math.min(n, i + 31); j++) {
      const a = O[j - 1], d = sub(O[j], a), L = dot(d, d), t = L > 0 ? Math.max(0, Math.min(1, dot(sub(q, a), d) / L)) : 0, pr = add(a, mul(d, t)), dd = len(sub(q, pr));
      if (dd < bd) { bd = dd; best = pr; }
    }
    return { pr: best, d: bd };
  };
  for (let it = 0; it < 400; it++) {
    for (let i = 1; i < n - 1; i++) {
      const avg = mul(add(P[i - 1], P[i + 1]), 0.5), q = lerp2(P[i], avg, 0.5), { pr, d } = proj(q, i);
      P[i] = d > MAXDEV ? add(pr, mul(sub(q, pr), MAXDEV / d)) : q;
    }
  }
  let dev = 0;
  for (let i = 0; i < n; i++) dev = Math.max(dev, proj(P[i], i).d);
  return { P, dev };
}

/* ---------- 8. 세로 선형(종단) ---------- */
const RV = 3000, GMAX = 0.035, HMIN = 20;   // 종곡선 반지름 · 최대 기울기(도시철도건설규칙 15조) · 승강장 평평한 구간을 줄여도 남길 반쪽 길이
// 평평한 끝 a 에서 b 까지 거리 D, 높이 차 dh: 기울기 g 와 양 끝 종곡선(길이 RV·|g|)으로 잇는다. dh = g·D − RV·g·|g|
function solveGrade(D, dh) {
  if (Math.abs(dh) < 1e-6) return 0;
  const disc = D * D - 4 * RV * Math.abs(dh);
  return disc < 0 ? null : Math.sign(dh) * (D - Math.sqrt(disc)) / (2 * RV);
}
function vz(s, m) {   // 종단 조각 s = { m0, m1, z0, g } 위 m 의 높이(포물선 종곡선 + 직선 기울기 + 포물선)
  const x = m - s.m0, D = s.m1 - s.m0, gg = s.g, Lc = RV * Math.abs(gg);
  if (x <= 0) return s.z0;
  if (x >= D) return s.z0 + gg * (D - Lc);
  if (x < Lc) return s.z0 + gg * x * x / (2 * Lc);
  if (x <= D - Lc) return s.z0 + gg * Lc / 2 + gg * (x - Lc);
  const y = D - x;
  return s.z0 + gg * (D - Lc) - gg * y * y / (2 * Lc);
}

/* ---------- 9. 그리는 길: 선로(펴기 + 종단) · 지상 · 역 안(환승·입구) ---------- */
const fastRows = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/data/extra.json'), 'utf8')).fast;
const ESC = Math.tan(Math.PI / 6), CONC = 6;   // 에스컬레이터 30° · 대합실 바닥 = 지반 − 6m(지하 1층, 층당 약 6m, 추정)
const PROFILE = [], RADIUS = [];             // 표(콘솔·ride.json)
function polyAt(poly, cum, s) {
  let i = 1;
  while (i < poly.length - 1 && cum[i] < s) i++;
  const t = cum[i] > cum[i - 1] ? (s - cum[i - 1]) / (cum[i] - cum[i - 1]) : 0;
  return lerp2(poly[i - 1], poly[i], Math.max(0, Math.min(1, t)));
}
const cumOf = (poly) => { const c = [0]; for (let i = 1; i < poly.length; i++) c.push(c[i - 1] + len(sub(poly[i], poly[i - 1]))); return c; };

function drawPath(ps, name, opt = {}) {
  // 1) 묶음: 지상(walk) · 선로(track) · 역 안(stn: 승강장·환승·출입구 간선)
  const runs = [];
  ps.forEach((p) => {
    const t = p.walk ? 'walk' : p.k === 'track' ? 'track' : 'stn', l = runs[runs.length - 1];
    if (l && l.t === t) l.ps.push(p); else runs.push({ t, ps: [p] });
  });
  runs.forEach((r) => { r.m0 = r.ps[0].from; const z = r.ps[r.ps.length - 1]; r.m1 = z.from + z.len; });
  const pts = [], stops = [], structs = [];
  const push = (q, m, z, k) => pts.push({ q, m, z, k });

  // 2) 선로 묶음: 간선마다 10m 로 나눈 점(간선 경계 = 점) → 펴기. 역(선로 위 부착점)은 같은 역·같은 노선이면 한 번
  for (const r of runs.filter((x) => x.t === 'track')) {
    const O = [], M = [];
    r.stops = [];
    const stop = (v, e, idx, m) => {
      const x = nodeSt.get(v);
      if (!x || x.ls >= 0) return;
      const li = lineOf(v, e);
      if (stops.some((s) => s.si === x.si && s.li === li && Math.abs(s.m - m) < 300)) return;
      const s = { si: x.si, li, line: T.line_short[li] || '', m, idx, run: r };
      stops.push(s); r.stops.push(s);
    };
    r.ps.forEach((p) => {
      const poly = xyOf(p.pts), cum = cumOf(poly), Lg = cum[cum.length - 1], n = Math.max(1, Math.ceil(Lg / STEP));
      if (Lg > 0 && Math.abs(Lg - p.len) / Lg > 0.02) console.warn(`간선 ${p.e} 길이 차이: 모양 ${Lg.toFixed(1)}m, 앱 ${p.len}m`);
      if (!O.length) { O.push(poly[0]); M.push(p.from); }
      stop(p.u, p.e, O.length - 1, p.from);
      for (let j = 1; j <= n; j++) { O.push(polyAt(poly, cum, Lg * j / n)); M.push(p.from + p.len * j / n); }
      stop(p.v, p.e, O.length - 1, p.from + p.len);
    });
    const { P, dev } = O.length > 2 ? smooth(O) : { P: O, dev: 0 };
    Object.assign(r, { O, P, M, dev, R0: radii(O), R1: radii(P) });
  }
  // 역 자리·방향(편 선 위), 높이 자료
  stops.forEach((s) => {
    const P = s.run.P, i = s.idx;
    s.q = P[i];
    s.dir = unit(sub(P[Math.min(P.length - 1, i + 3)], P[Math.max(0, i - 3)]));
    Object.assign(s, stInfo(s.si, s.li, s.q));
    s.name = S[s.si].name;
  });
  // 자료가 없는 역: 앞뒤 역(같은 길)의 레일 높이를 거리(m)로 보간(추정)
  stops.sort((a, c) => a.m - c.m);
  stops.forEach((s, i) => {
    if (s.z != null) return;
    const a = stops.slice(0, i).reverse().find((x) => x.src !== '추정'), c = stops.slice(i + 1).find((x) => x.src !== '추정');
    s.z = a && c ? a.z + (c.z - a.z) * (s.m - a.m) / (c.m - a.m) : (a || c || { z: s.g - 20 }).z;
    s.track_m = r2(s.g - s.z); s.note = '앞뒤 역 레일 높이를 거리로 보간';
  });
  // 선로 묶음 끝이 역 부착점이 아닌 경우(같은 역 안에서 승강장 간선으로 다른 선로 노드로 이어짐, 예: 9호선 샛강):
  // 옆 묶음(역 안)의 노드가 속한 역, 또는 60m 안의 같은 길 역을 빌려 끝에 둔다(표·구조에는 안 넣음)
  for (const r of runs.filter((x) => x.t === 'track')) {
    for (const [m, idx] of [[r.m0, 0], [r.m1, r.P.length - 1]]) {
      if (r.stops.some((s) => Math.abs(s.m - m) <= 1)) continue;
      const adj = runs[runs.indexOf(r) + (idx === 0 ? -1 : 1)];
      const sis = new Set(adj ? adj.ps.flatMap((p) => [p.u, p.v]).map((v) => nodeSt.get(v)).filter(Boolean).map((x) => x.si) : []);
      const o = stops.filter((s) => !s.clone && (sis.has(s.si) || Math.abs(s.m - m) <= 60)).reduce((bst, s) => (Math.abs(s.m - m) < Math.abs(bst.m - m) ? s : bst), { m: Infinity });
      if (o.m === Infinity) throw new Error(`${name}: 선로 묶음 끝(${m.toFixed(0)}m) 가까이에 역이 없음`);
      const P = r.P;
      r.stops.push(Object.assign({}, o, { m, idx, run: r, clone: true, orig: o, q: P[idx], dir: unit(sub(P[Math.min(P.length - 1, idx + 3)], P[Math.max(0, idx - 3)])) }));
    }
  }
  // 공식 자료가 아닌 역(위키·층수·보간)의 높이가 이웃 역과 기울기 한도(35‰, 양 끝 종곡선, 승강장 평평)를 넘으면 한도까지만 둔다(추정).
  // 공식 역은 움직이지 않는다. 앞 → 뒤, 뒤 → 앞으로 몇 번 훑는다
  const base = (s) => s.orig || s;
  const pairs = runs.filter((x) => x.t === 'track').flatMap((r) => { const st = r.stops.slice().sort((a, c) => a.m - c.m); return st.slice(1).map((c, i) => [st[i], c]); });
  for (let pass = 0; pass < 6; pass++) {
    for (const [a, c] of pass % 2 ? pairs.slice().reverse() : pairs) {
      const A = base(a), C = base(c);
      if (A === C) continue;
      const D = Math.max(1, c.m - a.m - A.Lp / 2 - C.Lp / 2), lim = Math.max(0, GMAX * D - RV * GMAX * GMAX) * 0.97, dh = C.z - A.z;
      if (Math.abs(dh) <= lim) continue;
      const moveC = C.src !== '공식' && (A.src === '공식' || pass % 2 === 0);
      if (moveC) { C.z = A.z + Math.sign(dh) * lim; C.fit = true; } else if (A.src !== '공식') { A.z = C.z - Math.sign(dh) * lim; A.fit = true; }
    }
  }
  stops.forEach((s) => { if (s.fit) { s.track_m = r2(s.g - s.z); s.note = (s.note ? s.note + ' · ' : '') + '이웃 역과 기울기 35‰ 안이 되게 높이를 맞춤(추정)'; } });
  runs.forEach((r) => (r.stops || []).forEach((s) => { if (s.orig) s.z = s.orig.z; }));

  // 3) 종단: 선로 묶음 안의 역 사이마다 기울기 + 종곡선. 승강장 반쪽(앞 hf · 뒤 hb)은 평평
  for (const r of runs.filter((x) => x.t === 'track')) {
    const st = r.stops.slice().sort((a, c) => a.m - c.m);
    if (!st.length || Math.abs(st[0].m - r.m0) > 1 || Math.abs(st[st.length - 1].m - r.m1) > 1) throw new Error(`${name}: 선로 묶음 양 끝이 역이 아님`);
    st.forEach((s) => { s.hb = s.hf = s.Lp / 2; });
    r.segs = [];
    for (let i = 1; i < st.length; i++) {
      const a = st[i - 1], c = st[i], dist = c.m - a.m;
      let gg = null, note = '';
      a.hf = Math.min(a.hf, dist / 2 - 5); c.hb = Math.min(c.hb, dist / 2 - 5);
      for (;;) {
        gg = solveGrade(c.m - c.hb - (a.m + a.hf), c.z - a.z);
        if (gg != null && Math.abs(gg) <= GMAX) break;
        if (a.hf <= HMIN && c.hb <= HMIN) break;
        a.hf = Math.max(HMIN, a.hf - 5); c.hb = Math.max(HMIN, c.hb - 5); note = '승강장 평평한 구간을 줄임';
      }
      if (gg == null || Math.abs(gg) > GMAX) throw new Error(`${name}: ${a.name} → ${c.name} 기울기 ${gg == null ? '풀 수 없음' : (gg * 1000).toFixed(1) + '‰'} (35‰ 넘음)`);
      const seg = { a, c, m0: a.m + a.hf, m1: c.m - c.hb, z0: a.z, g: gg, note };
      r.segs.push(seg);
    }
    // 선로 점 높이: 역 평평한 구간이면 역 높이, 아니면 종단 조각
    r.zAt = (m) => {
      for (const s of st) if (m >= s.m - s.hb - 1e-6 && m <= s.m + s.hf + 1e-6) return s.z;
      const seg = r.segs.find((x) => m >= x.m0 && m <= x.m1) || r.segs[r.segs.length - 1];
      return vz(seg, m);
    };
    r.st = st;
  }

  // 4) 점 모으기
  const kindOf = (r, m) => { for (const s of r.st) if (Math.abs(m - s.m) <= s.Lp / 2) return s.form === '섬식' ? 'i' : 'p'; return 't'; };
  const walkZ = (s) => s.z + (s.form === '섬식' ? LIFT : 0);   // 역 선로 위 점의 걷는 바닥(섬식이면 승강장 위)
  let prevStop = null;
  runs.forEach((r, ri) => {
    if (r.t === 'walk') {   // 지상: 지반 높이(보정한 SRTM)
      r.ps.forEach((p) => {
        const poly = xyOf(p.pts), cum = cumOf(poly), Lg = cum[cum.length - 1] || 1, n = Math.max(1, Math.ceil(Lg / STEP));
        for (let j = 0; j <= n; j++) { const q = polyAt(poly, cum, Lg * j / n); push(q, p.from + p.len * j / n, groundRaw(q), 's'); }
      });
      return;
    }
    if (r.t === 'track') {
      r.P.forEach((q, i) => { const m = r.M[i], k = kindOf(r, m); push(q, m, r.zAt(m) + (k === 'i' ? LIFT : 0), k); });
      prevStop = r.st[r.st.length - 1];
      return;
    }
    // 역 안
    const next = runs[ri + 1], nextStop = next && next.t === 'track' ? next.st[0] : null;
    if (r.ps.some((p) => p.k === 'transfer') && prevStop && nextStop) structs.push(...transfer(prevStop, nextStop, r.m0, r.m1, push));
    else if (r.ps.some((p) => p.k === 'entrance') && opt.entryTo) structs.push(...entry(pts[pts.length - 1], opt.entryTo, r.m0, r.m1, push));
    else {   // 승강장에 들렀다 나옴(경로 처음·끝): 역 자리에 머문다
      const s = nextStop && r.m0 === 0 ? nextStop : prevStop || nextStop;
      if (s) push(s.q, r.m1, walkZ(s), s.form === '섬식' ? 'i' : 'p');
    }
  });
  pts.sort((a, c) => a.m - c.m);
  // 표: 역 사이마다 종단·평면
  for (const r of runs.filter((x) => x.t === 'track')) {
    r.segs.forEach((s) => {
      const i0 = r.M.findIndex((m) => m >= s.a.m), i1 = r.M.findIndex((m) => m >= s.c.m - 1e-6);
      const minR = (R) => Math.min(...R.slice(i0, i1 + 1));
      PROFILE.push({ path: name, a: s.a.name, b: s.c.name, line: s.a.line, dist: r1(s.c.m - s.a.m), za: r2(s.a.z), zb: r2(s.c.z), srcA: s.a.src, srcB: s.c.src, g: r2(s.g * 1000), flat: [Math.round(s.a.hf), Math.round(s.c.hb)], Lc: r1(RV * Math.abs(s.g)), note: s.note, m0: s.a.m, m1: s.c.m });
      const lim = s.a.line === '2호선' ? 180 : 250;
      RADIUS.push({ path: name, a: s.a.name, b: s.c.name, line: s.a.line, before: Math.round(minR(r.R0)), after: Math.round(minR(r.R1)), lim, dev: r1(r.dev) });
    });
  }
  // 승강장 구조(선로 위 역마다)
  stops.forEach((s) => structs.push({ k: 'plat', n: s.name, l: s.line, c: s.q, a: Math.atan2(s.dir[1], s.dir[0]), L: s.Lp, z: s.z, form: s.form || '상대식', src: s.src, m: s.m }));
  return { pts, stops, structs, runs };
}

// 승강장 위 칸 위치(m, 진행 방향 +): 1칸 = 맨 앞. 빠른 환승 자료(도착 노선 → 갈아탈 노선, 이전 역)가 있으면 그 칸, 없으면 가운데
function carOffset(s, toLine, prevSi) {
  const rows = fastRows.filter((x) => x.s === s.si && x.line === s.li && x.to_line === toLine);
  const row = rows.find((x) => x.prev === prevSi) || null;
  if (!row) return { off: 0, src: '' };
  return { off: (0.5 - (row.car - 0.5) / row.cars) * s.Lp, src: `빠른 환승 ${row.car}/${row.cars}칸` };
}
const right = (d) => [d[1], -d[0]];   // 진행 방향 오른쪽
// 상대식 승강장: 선로 가운데에서 오른쪽 5.6m. 섬식: 가운데
const platSide = (s) => (s.form === '섬식' ? 0 : 5.6);
// 길을 모서리 반지름 r 로 둥글게(점 + 높이)
function roundPath(P, r) {
  const out = [P[0]];
  for (let i = 1; i < P.length - 1; i++) {
    const a = P[i - 1], p = P[i], c = P[i + 1], k = Math.min(r, len(sub(p.q, a.q)) / 2, len(sub(c.q, p.q)) / 2);
    if (k < 0.5) { out.push(p); continue; }
    const ua = unit(sub(a.q, p.q)), uc = unit(sub(c.q, p.q));
    const p0 = { q: add(p.q, mul(ua, k)), z: p.z + (a.z - p.z) * k / (len(sub(a.q, p.q)) || 1) }, p2 = { q: add(p.q, mul(uc, k)), z: p.z + (c.z - p.z) * k / (len(sub(c.q, p.q)) || 1) };
    for (let j = 0; j <= 4; j++) { const t = j / 4; out.push({ q: add(add(mul(p0.q, (1 - t) * (1 - t)), mul(p.q, 2 * t * (1 - t))), mul(p2.q, t * t)), z: p0.z * (1 - t) * (1 - t) + p.z * 2 * t * (1 - t) + p2.z * t * t }); }
  }
  out.push(P[P.length - 1]);
  return out;
}
// 꺾은선(점 + 높이)을 앱 거리 mS ~ mE 에 3차원 길이 비율로 나눠 넣는다(2m 간격)
function lay(P, mS, mE, push) {
  const L3 = [0];
  for (let i = 1; i < P.length; i++) L3.push(L3[i - 1] + Math.hypot(len(sub(P[i].q, P[i - 1].q)), P[i].z - P[i - 1].z));
  const tot = L3[L3.length - 1] || 1;
  for (let i = 1; i < P.length; i++) {
    const n = Math.max(1, Math.ceil((L3[i] - L3[i - 1]) / 2));
    for (let j = i === 1 ? 0 : 1; j <= n; j++) {
      const t = j / n, q = lerp2(P[i - 1].q, P[i].q, t), z = P[i - 1].z + (P[i].z - P[i - 1].z) * t;
      push(q, mS + (mE - mS) * (L3[i - 1] + (L3[i] - L3[i - 1]) * t) / tot, z, 'x');
    }
  }
  return tot;
}
// 대합실 판: 점들을 덮는 사각형(축 방향, 여유 12m, 폭 24m 이상)
function concourse(points, axis, z, n) {
  const u = unit(axis), w = [-u[1], u[0]];
  const A = points.map((p) => dot(p, u)), B = points.map((p) => dot(p, w));
  const a0 = Math.min(...A), a1 = Math.max(...A), b0 = Math.min(...B), b1 = Math.max(...B);
  return { k: 'conc', n, c: add(mul(u, (a0 + a1) / 2), mul(w, (b0 + b1) / 2)), a: Math.atan2(u[1], u[0]), L: a1 - a0 + 24, W: Math.max(24, b1 - b0 + 16), z, est: true };
}
// 환승: 승강장 A(도착) → 칸 위치 → 에스컬레이터(위로) → 대합실 → 에스컬레이터(아래로) → 승강장 B → 선로 위 역 자리
function transfer(A, B, mS, mE, push) {
  const fA = A.z + LIFT, fB = B.z + LIFT, gnd = Math.min(A.g, B.g);
  let c = gnd - CONC;
  if (c < Math.max(fA, fB) + 3.5) c = Math.min(gnd - 2.5, Math.max(fA, fB) + 3.5);
  const prevSi = (() => { const P = A.run.st; const i = P.indexOf(A); return i > 0 ? P[i - 1].si : -1; })();
  const ca = carOffset(A, B.li, prevSi);
  const sideA = mul(right(A.dir), platSide(A)), sideB = mul(right(B.dir), platSide(B));
  const toB = Math.sign(dot(sub(B.q, A.q), A.dir)) || 1, toA = Math.sign(dot(sub(A.q, B.q), B.dir)) || -1;
  const a0 = add(add(A.q, mul(A.dir, ca.off)), sideA), a1 = add(a0, mul(A.dir, toB * (c - fA) / ESC));
  const b0 = add(B.q, sideB), b1 = add(b0, mul(B.dir, toA * (c - fB) / ESC));
  const P = [{ q: A.q, z: fA }, { q: add(A.q, sideA), z: fA }, { q: a0, z: fA }, { q: a1, z: c }, { q: b1, z: c }, { q: b0, z: fB }, { q: add(B.q, sideB), z: fB }, { q: B.q, z: B.form === '섬식' ? fB : B.z }];
  lay(roundPath(P.filter((p, i) => i === 0 || len(sub(p.q, P[i - 1].q)) > 0.3 || Math.abs(p.z - P[i - 1].z) > 0.05), 3), mS, mE, push);
  A.xfer = { car: ca.src, c };
  return [concourse([a1, b1], len(sub(b1, a1)) > 20 ? sub(b1, a1) : A.dir, c, A.name),
    { k: 'esc', n: A.name, a: [...a0, fA], b: [...a1, c] }, { k: 'esc', n: B.name, a: [...b0, fB], b: [...b1, c] }];
}
// 입구: 출구(지상) → 계단(30°) → 대합실 → 에스컬레이터 → 승강장 → 선로 위 역 자리
function entry(last, B, mS, mE, push) {
  const e = last.q, ge = last.z, c = Math.min(B.g, ge) - CONC,   // 대합실: 출구 쪽 지반과 역 지반 중 낮은 쪽 − 6m
    fB = B.z + LIFT, sideB = mul(right(B.dir), platSide(B));
  const toE = Math.sign(dot(sub(e, B.q), B.dir)) || 1;
  const b0 = add(B.q, sideB), b1 = add(b0, mul(B.dir, toE * (c - fB) / ESC));
  const dirIn = unit(sub(b1, e)), e1 = add(e, mul(dirIn, Math.min((ge - c) / ESC, len(sub(b1, e)) * 0.5)));
  const P = [{ q: e, z: ge }, { q: e1, z: c }, { q: b1, z: c }, { q: b0, z: fB }, { q: B.q, z: B.form === '섬식' ? fB : B.z }];
  lay(roundPath(P, 3), mS, mE, push);
  return [concourse([e1, b1], sub(b1, e1), c, B.name), { k: 'esc', n: B.name, a: [...b0, fB], b: [...b1, c] }, { k: 'esc', n: B.name + ' 출구', a: [...e1, c], b: [...e, ge] }, { k: 'exit', n: B.name, c: e, z: ge, a: Math.atan2(dirIn[1], dirIn[0]) }];
}

/* ---------- 10. 계산 ---------- */
const ps1 = pieces(p1), ps2 = pieces(p2), ps3 = pieces(p3), ps4 = pieces(p4);
const total1 = ps1.reduce((a, p) => a + p.len, 0), total2 = ps2.reduce((a, p) => a + p.len, 0), total3 = ps3.reduce((a, p) => a + p.len, 0), total4 = ps4.reduce((a, p) => a + p.len, 0);
const mapoAt = cps2[at].at, blockAt = mapoAt + walked, yeouiAt = cps2[at + 1].at;
const expo1 = ps1.filter((p) => p.walk).reduce((a, p) => a + p.len, 0);   // 공덕역 출구까지 지상
const D2 = drawPath(ps2, '처음 길'), D3 = drawPath(ps3, '다시 찾은 길'), D4 = drawPath(ps4, '수서 → 동탄');
const s0 = D2.stops[0];   // 공덕 5호선 승강장(처음 길의 첫 역)
const D1 = drawPath(ps1, '입구', { entryTo: s0 });

// 구간 자르기: m0 ~ m1 의 점(양 끝은 사이 값). 점 = [x, y, m, z, g, w], 종류 글자
function legOf(dp, m0, m1, tol = 0.3) {
  const P = dp.pts, atM = (m) => {
    let i = P.findIndex((p) => p.m >= m);
    if (i <= 0) i = i < 0 ? P.length - 1 : 1;
    const a = P[i - 1], c = P[i], t = c.m > a.m ? Math.max(0, Math.min(1, (m - a.m) / (c.m - a.m))) : 1;
    return { q: lerp2(a.q, c.q, t), m, z: a.z + (c.z - a.z) * t, k: t < 0.5 ? a.k : c.k };
  };
  const all = [atM(m0), ...P.filter((p) => p.m > m0 + 0.05 && p.m < m1 - 0.05), atM(m1)];
  // 점 줄이기(더글러스-포이커): 평면 tol m, 높이는 10배로 재서(0.1·tol m). 종류가 바뀌는 점은 남긴다
  const keep = new Uint8Array(all.length); keep[0] = keep[all.length - 1] = 1;
  all.forEach((p, i) => { if (i && p.k !== all[i - 1].k) keep[i] = keep[i - 1] = 1; });
  const d3 = (p, a, c) => { const v = [c.q[0] - a.q[0], c.q[1] - a.q[1], (c.z - a.z) * 10], w = [p.q[0] - a.q[0], p.q[1] - a.q[1], (p.z - a.z) * 10], L = v[0] * v[0] + v[1] * v[1] + v[2] * v[2], t = L ? Math.max(0, Math.min(1, (v[0] * w[0] + v[1] * w[1] + v[2] * w[2]) / L)) : 0; return Math.hypot(w[0] - v[0] * t, w[1] - v[1] * t, w[2] - v[2] * t); };
  const idx = keep.reduce((a, k, i) => (k ? a.concat(i) : a), []);
  for (let s = 1; s < idx.length; s++) {
    const stack = [[idx[s - 1], idx[s]]];
    while (stack.length) {
      const [i, j] = stack.pop();
      let best = -1, bi = -1;
      for (let k = i + 1; k < j; k++) { const d = d3(all[k], all[i], all[j]); if (d > best) { best = d; bi = k; } }
      if (best > tol) { keep[bi] = 1; stack.push([i, bi], [bi, j]); }
    }
  }
  const sel = all.filter((_, i) => keep[i]);
  const pts = sel.map((p) => { const w = waterAt(p.q); return [r1(p.q[0]), r1(p.q[1]), r1(p.m - m0), r2(p.z), r1(w != null ? w : groundRaw(p.q)), w != null ? r1(w) : null]; });
  return { pts, k: sel.map((p) => p.k).join('') };
}

// 점 줄이기(바탕 선로·한강 중심선)
function simplify(pts, tol) {   // 더글러스-포이커(평면 m)
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let best = -1, bi = -1;
    for (let k = i + 1; k < j; k++) { const d = distToLine(pts[k], [pts[i], pts[j]]); if (d > best) { best = d; bi = k; } }
    if (best > tol) { keep[bi] = 1; stack.push([i, bi], [bi, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}

/* ---------- 11. 내보내기 ---------- */
const name = (i) => S[i].name;
const legAt = (m) => (m <= blockAt ? ['ride1', m] : ['blocked', m - blockAt]);
const stOut = (stops, legFn) => stops.map((s) => {
  const [leg, m] = legFn(s.m);
  return { leg, n: s.name, l: s.line, m: r1(m), z: r2(s.z), g: r1(s.g), d: s.track_m != null ? r2(s.track_m) : null, pd: s.plat_m != null ? r2(s.plat_m) : null, f: s.floor, form: s.form, src: s.src, note: s.note || '', car: s.xfer ? s.xfer.car : '' };
});
const stations = [...stOut(D1.stops, (m) => ['enter', m]), ...stOut(D2.stops.filter((s) => s.m <= yeouiAt + 1), legAt), ...stOut(D2.stops.filter((s) => s.m > yeouiAt + 1), (m) => ['rest', m - yeouiAt]),
  ...stOut(D3.stops, (m) => ['ride2', m]), ...stOut(D4.stops, (m) => ['south', m])];
// 역 구조: 공덕 입구 · 처음 길(여의나루까지) · 다시 찾은 길. 같은 역·종류·노선은 한 번만
const seen = new Set(), structs = [];
const xyOut = (q) => [Math.round(q[0]), Math.round(q[1])];
const sOut = (x, leg) => {
  const o = { leg, k: x.k, n: x.n };
  if (x.c) o.c = xyOut(x.c);
  if (x.k === 'plat') Object.assign(o, { l: x.l, a: r2(x.a), L: x.L, z: r2(x.z), form: x.form, src: x.src });
  if (x.k === 'conc') Object.assign(o, { a: r2(x.a), L: Math.round(x.L), W: Math.round(x.W), z: r2(x.z), est: true });
  if (x.k === 'esc') Object.assign(o, { a: x.a.map(r2), b: x.b.map(r2) });
  if (x.k === 'exit') Object.assign(o, { z: r2(x.z), a: r2(x.a) });
  return o;
};
[[D1.structs, 'enter', () => true], [D2.structs, 'ride1', (x) => x.m == null || x.m <= yeouiAt + 1], [D3.structs, 'ride2', () => true]].forEach(([list, leg, ok]) => list.forEach((x) => {
  const key = x.k + '|' + x.n + '|' + (x.l || '') + '|' + (x.a && x.a.join ? x.a.join() : '');
  if (!ok(x) || seen.has(key)) return;
  seen.add(key);
  structs.push(sOut(x, leg));
}));
const rides = (p, ps) => p.items.filter((i) => i.kind === 'step' && (i.step.type === 'ride' || i.step.type === 'transfer')).map((i) => {
  const idx = i.step._idx, a = ps.find((q) => q.e === p.route.path[idx[0]].e), z = ps.find((q) => q.e === p.route.path[idx[idx.length - 1]].e);
  return { t: i.step.type, label: i.step.label || '', a: i.step.from_station || '', b: i.step.to_station || '', m0: r1(a.from), m1: r1(z.from + z.len), km: r1((i.step.distance_m || 0) / 1000) };
});
const crossM = (ps, c) => { const p = ps.find((x) => x.e === c.e); return [r1(p.from), r1(p.from + p.len)]; };
const waterOf = (c) => r1(river.reduce((bst, r) => { const d = distToLine(r.q, [nodeXY(E.a[c.e]), nodeXY(E.b[c.e])]); return d < bst.d ? { d, W: r.W } : bst; }, { d: Infinity, W: 0 }).W);
const LG = {
  enter: legOf(D1, 0, total1),
  ride1: legOf(D2, 0, blockAt),
  blocked: legOf(D2, blockAt, yeouiAt),
  rest: legOf(D2, yeouiAt, total2, 5),   // 처음 길의 나머지(여의나루 → 도착): 점선으로만
  ride2: legOf(D3, 0, total3),
  south: legOf(D4, 0, total4, 5)         // 수서 → 동탄: 끝 전체 보기에서 옅게
};

/* ---------- 11-1. 화면(3판 그림)용 자료 ----------
   화면은 3판 그대로: 평평한 지면(y = 0) 아래로 '그릴 깊이' × EXAG. 선로의 평면 모양과 높이만 7~8절에서 계산한 실제 값을 쓴다.
   - 실제 깊이(글자) = 기준 지반(아래) − 걷는 바닥 높이. 한강 위는 수면(SRTM 중앙값) − 걷는 바닥 높이.
   - 그릴 깊이 = 기준 지반 − 걷는 바닥 높이. 기준 지반 = 보정한 SRTM 지반을 길 따라 10m 마다 재고, 한강 위는 양쪽 둑 값을 직선으로 이은 뒤
     σ 150m 로 부드럽게 하고 역 자리에서 공식 지반고와 같게 맞춘 값. 평평한 지면 아래라도 깊이가 뚝 바뀌지 않고, 승강장은 공식 깊이 그대로다.
     한강 아래는 둑 높이에서 잰 깊이라 글자(수면 아래 깊이)보다 둑과 수면의 높이 차만큼 깊게 그려진다.
   - 역 안(환승·입구)은 3판처럼 개략 모양: 승강장 → 경사(화면에서 60° 이하) → 대합실(깊이 추정) → 경사 → 승강장.
   점 = [위도, 경도, 구간 m, 그릴 깊이, 한강 아래 정도 0~1, 한강 단면 정도 0~1, 실제 깊이] */
const LL5 = (q) => { const ll = toLL(q); return [Math.round(ll[0] * 1e5) / 1e5, Math.round(ll[1] * 1e5) / 1e5]; };
const ss3 = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
const MAX_SLOPE = Math.tan(Math.PI / 3), STEP_ST = 4;
const rampRun = (dd) => Math.max(100, 1.5 * Math.abs(dd) * EXAG / MAX_SLOPE);   // 경사 수평 길이(m): 화면 기울기 60° 이하
// 한강: 그림용 반폭(하저터널 양 끝 역 중 강에 가장 가까운 역보다 안쪽) · 한강 아래 정도
const bankSt = [crossA.a, crossA.b, crossB.a, crossB.b].map((n) => S[si(n + '@서울')]);
const HALF_W = Math.round(Math.min(450, ...bankSt.map((s) => distToLine(toXY([s.lat / 1e5, s.lon / 1e5]), hanAll) - 60)));
const fall = (d, w) => (d <= HALF_W ? 1 : d >= HALF_W + w ? 0 : 0.5 * (1 + Math.cos(Math.PI * (d - HALF_W) / w)));
// 꺾인 점을 반지름 r 만큼 2차 베지어로 둥글게(역 안 경사·대합실 모서리)
function round3(poly, r) {
  const out = [poly[0]];
  for (let i = 1; i < poly.length - 1; i++) {
    const a = poly[i - 1], p = poly[i], c = poly[i + 1];
    const k = Math.min(r, len(sub(p, a)) / 2, len(sub(c, p)) / 2);
    const p0 = add(p, mul(unit(sub(a, p)), k)), p2 = add(p, mul(unit(sub(c, p)), k));
    for (let j = 0; j <= 6; j++) { const t = j / 6; out.push(add(add(mul(p0, (1 - t) * (1 - t)), mul(p, 2 * t * (1 - t))), mul(p2, t * t))); }
  }
  out.push(poly[poly.length - 1]);
  return out;
}
const concs = [];   // 대합실 판(개략)
function concourse3(points, axis, d, n, leg) {
  const u = unit(axis), w = [-u[1], u[0]];
  const A = points.map((p) => dot(p, u)), B = points.map((p) => dot(p, w));
  const a0 = Math.min(...A), a1 = Math.max(...A), b0 = Math.min(...B), b1 = Math.max(...B);
  concs.push({ leg, k: 'concourse', n, l: '', c: LL5(add(mul(u, (a0 + a1) / 2), mul(w, (b0 + b1) / 2))), a: r2(Math.atan2(u[1], u[0])), L: Math.round(a1 - a0 + 40), W: Math.round(Math.max(40, b1 - b0 + 40)), d: r2(d), est: true });
}
// 구간 하나: 7~8절의 점([x, y, m, z, g, w] + 종류)을 화면 점으로
// 기준 지반(그린 길 하나 전체에서 잰다. 구간 경계에서 값이 같게): 구간 m → 해발 m
function refOf(lg, sts) {
  const P = lg.pts.map((p) => ({ q: [p[0], p[1]], m: p[2] })), M = P[P.length - 1].m;
  const qAt = (m) => { let i = P.findIndex((p) => p.m >= m); if (i <= 0) return P[Math.max(0, i)].q; const a = P[i - 1], c = P[i]; return lerp2(a.q, c.q, c.m > a.m ? (m - a.m) / (c.m - a.m) : 0); };
  // 기준 지반: 10m 마다(한강 위는 비우고 둑 값을 직선으로 이음) → σ 150m → 역 자리에서 공식 지반고로
  const n = Math.max(2, Math.ceil(M / 10) + 1), G = [];
  for (let i = 0; i < n; i++) { const q = qAt(Math.min(M, i * 10)); G.push(waterAt(q) != null ? NaN : groundRaw(q)); }
  const ok = G.map((v, i) => (Number.isNaN(v) ? -1 : i)).filter((i) => i >= 0);
  for (let i = 0; i < n; i++) if (Number.isNaN(G[i])) {
    const lo = ok.filter((j) => j < i).pop(), hi = ok.find((j) => j > i);
    G[i] = lo == null ? G[hi] : hi == null ? G[lo] : G[lo] + (G[hi] - G[lo]) * (i - lo) / (hi - lo);
  }
  const Gs = G.map((_, i) => { let s = 0, w = 0; for (let j = Math.max(0, i - 45); j <= Math.min(n - 1, i + 45); j++) { const k = Math.exp(-(((j - i) * 10) ** 2) / (2 * 150 * 150)); s += G[j] * k; w += k; } return s / w; });
  const gAt = (m) => { const f = Math.max(0, Math.min(n - 1, m / 10)), i = Math.min(n - 2, Math.floor(f)); return Gs[i] + (Gs[i + 1] - Gs[i]) * (f - i); };
  const fix = sts.map((s) => ({ m: s.m, r: s.g - gAt(s.m) })).sort((a, c) => a.m - c.m);
  const ref = (m) => {
    if (!fix.length) return gAt(m);
    let r = fix[0].r;
    for (let i = 0; i < fix.length; i++) { if (m >= fix[i].m) r = fix[i].r; if (fix[i + 1] && m >= fix[i].m && m < fix[i + 1].m) r = fix[i].r + (fix[i + 1].r - fix[i].r) * (m - fix[i].m) / (fix[i + 1].m - fix[i].m); }
    return gAt(m) + r;
  };
  return ref;
}
function view(key, lg, sts, endDir, ref) {
  const P = lg.pts.map((p, i) => ({ q: [p[0], p[1]], m: p[2], z: p[3], g: p[4], w: p[5], k: lg.k[i] }));
  const rivOf = (q) => { const dr = distToLine(q, hanAll); return [r2(fall(dr, 300)), r2(fall(dr, 900))]; };
  const outP = (q, m, d, dt) => [...LL5(q), r1(m), r2(d), ...rivOf(q), r2(dt)];
  const out = [];
  for (let i = 0; i < P.length; i++) {
    const p = P[i];
    if (p.k !== 'x') { const s = p.k === 's', d = ref(p.m) - p.z; out.push(outP(p.q, p.m, s ? 0 : d, s ? 0 : p.w != null ? p.w - p.z : d)); continue; }
    // 역 안(환승·입구): 앞뒤 점 사이를 3판 모양으로 새로 그린다
    let j = i; while (j + 1 < P.length && P[j + 1].k === 'x') j++;
    const A = P[i - 1], B = P[Math.min(P.length - 1, j + 1)], sa = A.q, sb = B.q, mS = A.m, mE = B.m;
    const da = A.k === 's' ? 0 : ref(A.m) - A.z, db = ref(B.m) - B.z;
    const back = P.slice(0, i).reverse().find((x) => len(sub(sa, x.q)) >= 30), fwd = P.slice(j + 2).find((x) => len(sub(x.q, sb)) >= 30);
    const dirA = back ? unit(sub(sa, back.q)) : unit(sub(sb, sa)), dirB = fwd ? unit(sub(fwd.q, sb)) : endDir || dirA;
    const st = sts.reduce((b, s) => (!b || Math.abs(s.m - mS) < Math.abs(b.m - mS) ? s : b), null);
    let poly, ctl;
    if (A.k === 's') {   // 입구: 출구 → 경사 → 대합실(깊이 6m 추정) → 경사 → 승강장
      const c = 6, r2_ = rampRun(db - c), q2 = sub(sb, mul(dirB, r2_)), toQ2 = sub(q2, sa);
      const rr = Math.min(rampRun(c), len(toQ2) * 0.6), q1 = add(sa, mul(unit(toQ2), rr)), mid = len(sub(q2, q1)), L = rr + mid + r2_;
      const m1 = mS + (mE - mS) * rr / L, m2 = mS + (mE - mS) * (rr + mid) / L;
      poly = round3([sa, q1, q2, sb], 30); ctl = [[mS, m1, 0, c], [m1, m2, c, c], [m2, mE, c, db]];
      concourse3([q1, q2, sb], sub(q2, q1), c, st ? st.n : '', key);
    } else {             // 환승: 승강장 A → 경사 → 대합실(얕은 승강장보다 6m 위, 5~8m 추정) → 경사 → 승강장 B
      const c = Math.min(8, Math.max(5, Math.min(da, db) - 6)), rA = rampRun(da - c), rB = rampRun(db - c);
      const qa = add(sa, mul(dirA, rA)), qb = sub(sb, mul(dirB, rB)), mid = len(sub(qb, qa)), L = rA + mid + rB;
      const mA = mS + (mE - mS) * rA / L, mB = mS + (mE - mS) * (rA + mid) / L;
      poly = round3([sa, qa, qb, sb], 40); ctl = [[mS, mA, da, c], [mA, mB, c, c], [mB, mE, c, db]];
      concourse3([sa, sb, qa, qb], mid > 30 ? sub(qb, qa) : dirA, c, st ? st.n : '', key);
    }
    const dAt = (m) => { for (const [m0, m1, d0, d1] of ctl) if (m <= m1) return m1 > m0 ? d0 + (d1 - d0) * ss3((m - m0) / (m1 - m0)) : d1; return db; };
    const cum = [0]; for (let k = 1; k < poly.length; k++) cum.push(cum[k - 1] + len(sub(poly[k], poly[k - 1])));
    const Lp = cum[cum.length - 1] || 1;
    for (let k = 1; k < poly.length; k++) {   // 마지막 끝점(다음 승강장 점)은 빼고
      const steps = Math.max(1, Math.ceil((cum[k] - cum[k - 1]) / STEP_ST));
      for (let s = 1; s <= steps - (k === poly.length - 1 ? 1 : 0); s++) { const t = s / steps, q = lerp2(poly[k - 1], poly[k], t), m = mS + (mE - mS) * (cum[k - 1] + (cum[k] - cum[k - 1]) * t) / Lp; const d = dAt(m); out.push(outP(q, m, d, d)); }
    }
    if (j + 1 >= P.length) out.push(outP(sb, mE, db, db));   // 구간이 역 안에서 끝남(입구 → 승강장)
    i = j;
  }
  return { pts: out, ref };
}
// 구간별 역(공식 지반고 = 기준 지반을 맞출 자리)
const stIn = (key) => (key === 'enter' ? [{ n: name(o1.si), m: total1, g: s0.g }] : stations.filter((s) => s.leg === key));   // 입구 끝 = 공덕 5호선 승강장(처음 길 첫 역)
const V = {}, r1p = LG.ride1.pts, r1q = r1p.find((p) => Math.hypot(p[0] - r1p[0][0], p[1] - r1p[0][1]) >= 30) || r1p[r1p.length - 1];
const off2 = { ride1: 0, blocked: blockAt, rest: yeouiAt };   // 처음 길(D2)의 세 구간은 기준 지반 하나를 같이 쓴다
const ref2 = refOf(legOf(D2, 0, total2), stations.filter((s) => s.leg in off2).map((s) => ({ m: s.m + off2[s.leg], g: s.g })));
for (const key of Object.keys(LG)) {
  const ref = key in off2 ? (m) => ref2(m + off2[key]) : refOf(LG[key], stIn(key));
  V[key] = view(key, LG[key], stIn(key), key === 'enter' ? unit([r1q[0] - r1p[0][0], r1q[1] - r1p[0][1]]) : null, ref);
}
// 그린 길 위 m 의 그릴 깊이(승강장 상자를 길과 같은 높이에)
const dDraw = (key, m) => { const P = V[key].pts; let i = P.findIndex((p) => p[2] >= m); if (i <= 0) return P[Math.max(0, i)][3]; const a = P[i - 1], c = P[i]; return a[3] + (c[3] - a[3]) * (c[2] > a[2] ? (m - a[2]) / (c[2] - a[2]) : 0); };

// 화면 역 이름표: 입구·처음 길(여의나루까지)·다시 찾은 길. 깊이 = 승강장 깊이(공식 자료가 있는 역만, 없으면 null = '깊이 추정')
const st3 = stations.filter((s) => ['enter', 'ride1', 'blocked', 'ride2'].includes(s.leg)).map((s) => ({ leg: s.leg, n: s.n, l: s.l, m: s.m, d: s.src === '공식' ? s.pd : null, f: s.f }));
// 역 구조: 승강장 상자(3판 크기: 폭 34m, 길이 = 실제 승강장 길이) + 개략 대합실
const plat3 = structs.filter((x) => x.k === 'plat').map((x) => {
  const s = stations.find((o) => o.n === x.n && o.l === x.l && o.leg !== 'south' && o.leg !== 'rest');
  return { leg: x.leg, k: 'platform', n: x.n, l: x.l, c: LL5(x.c), a: x.a, L: Math.round(x.L), W: 34, d: s ? r2(dDraw(s.leg, s.m)) : r2(x.z), est: !s || s.src !== '공식' };
});
const seen3 = new Set(), conc3 = concs.filter((x) => { const k = x.n + '|' + x.leg; if (['rest', 'south'].includes(x.leg) || seen3.has(k)) return false; seen3.add(k); return true; });
// 한강 아래 실제 깊이(수면 아래, 하저터널 구간에서 가장 깊은 곳)
const under = (keys) => Math.round(Math.max(...keys.flatMap((k) => LG[k].pts.filter((p) => p[5] != null).map((p) => p[5] - p[3]))));
// 바탕 선로·한강 중심선: 경로 둘레 약 3.3km 상자(3판과 같은 범위)
const inBox3 = (q) => q[0] > BOX[0] - 3300 && q[0] < BOX[2] + 3300 && q[1] > BOX[1] - 3300 && q[1] < BOX[3] + 3300;
const net = [];
for (let e = 0; e < E.a.length; e++) {
  if (T.kinds[E.k[e]] !== 'track' || E.svc[e] !== 0) continue;
  const pts = xyOf(GR.edgeShape(g, e));
  if (!pts.some(inBox3)) continue;
  net.push(simplify(pts, 30).map(LL5));
}
const riverLine = simplify(hanAll.filter(inBox3), 15).map(LL5);


const out = {
  format: 'jiharo-3d-4',
  built: new Date().toISOString().slice(0, 10),
  exag: EXAG,
  attribution: ['© OpenStreetMap contributors (ODbL)', '역 깊이: 서울교통공사 역사심도정보(1~8호선 2024-11-04, 9호선 2·3단계 2026-01-31), 서울 열린데이터광장, 공공누리 제1유형', 'SRTM data courtesy of the U.S. Geological Survey'],
  river: { line: riverLine, half_w: HALF_W },
  legs: {
    enter: { pts: V.enter.pts, expo_m: r1(expo1) },
    ride1: { pts: V.ride1.pts },
    blocked: { pts: V.blocked.pts },
    rest: { pts: V.rest.pts },
    ride2: { pts: V.ride2.pts },
    south: { pts: V.south.pts }
  },
  net,
  stations: st3,
  structs: [...plat3, ...conc3],
  facts: {
    start: name(o1.si), exit_ref: o1.ref, expo_m: Math.round(expo1), story_label: Y.label,
    crossA: { a: crossA.a, b: crossA.b, line: crossA.line, m: crossM(ps2, crossA), water: waterOf(crossA), under: under(['ride1', 'blocked']) },
    mapo_m: r1(mapoAt), block_m: r1(blockAt), backtrack_m: Math.round(b.backtrack), walked_m: Math.round(walked),
    crossB: { a: crossB.a, b: crossB.b, line: crossB.line, m: crossM(ps3, crossB), water: waterOf(crossB), under: under(['ride2']) },
    // 거리: 처음 길 전체 · 마포에서 남았던 거리 · 다시 찾은 길(앱 view 값 = 안내 화면과 같은 값)
    first_m: Math.round(p2.view.total_m), left_m: Math.round(total2 - mapoAt), total2_m: Math.round(p3.view.total_m),
    first_expo_m: Math.round(p2.view.exposed_m), second_expo_m: Math.round(p3.view.exposed_m),
    end: name(meetSi), exposed_after_m: Math.round(p2.view.exposed_m + p3.view.exposed_m),
    both_blocked_expo_m: pNone ? Math.round(pNone.exposed_m) : null,
    rides: rides(p3, ps3),
    south: { to: name(si(SOUTH)), total_m: Math.round(p4.view.total_m), expo_m: Math.round(p4.view.exposed_m), rides: rides(p4, ps4).filter((r) => r.t === 'ride').map((r) => ({ label: r.label, km: r.km })) }
  },
  tables: { profile: PROFILE.map(({ m0, m1, ...x }) => x), radius: RADIUS }
};

/* ---------- 12. 확인: 기울기 35‰ · 종곡선 반지름 3,000m (선로 점을 다시 재서) ---------- */
let worstG = 0, worstR = Infinity;
for (const D of [D2, D3, D4]) for (const r of D.runs.filter((x) => x.t === 'track')) {
  const inSt = (m) => r.st.some((s) => m >= s.m - s.hb - 1e-6 && m <= s.m + s.hf + 1e-6);
  for (let m = r.m0; m < r.m1 - 5; m += 5) {
    const ga = (r.zAt(m + 5) - r.zAt(m)) / 5;
    if (!inSt(m) || !inSt(m + 5)) worstG = Math.max(worstG, Math.abs(ga));
    if (m + 10 <= r.m1) { const k = Math.abs(r.zAt(m + 10) - 2 * r.zAt(m + 5) + r.zAt(m)) / 25; if (k > 1e-9) worstR = Math.min(worstR, 1 / k); }
  }
}
if (worstG > GMAX + 1e-4) throw new Error(`기울기 ${(worstG * 1000).toFixed(2)}‰ > 35‰`);
if (worstR < RV * 0.98) throw new Error(`종곡선 반지름 ${worstR.toFixed(0)}m < ${RV}m`);

const file = path.join(ROOT, 'web/3d/ride.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out));
const L = out.legs;
const pad = (s, n) => String(s).padEnd(n), lpad = (s, n) => String(s).padStart(n);
console.log(`ride.json ${fs.statSync(file).size} byte · 점 ` + Object.keys(L).map((k) => `${k} ${L[k].pts.length}`).join(' ') + ` · 바탕 선로 ${net.length}개 · 역 구조 ${out.structs.length}개 · 강 반폭 ${HALF_W}m · 한강 수면 아래 ${out.facts.crossA.under}m / ${out.facts.crossB.under}m`);
const offs = ctrl.map((c) => c.d);
console.log(`지반 보정: 공식 역 지반고 − SRTM 하위 15%(±140m), 역 ${ctrl.length}곳(${ctrlAll}곳 중 12m 넘게 어긋난 ${dropped.length}곳 뺌: ${dropped.join(', ')}) 중앙값 ${OFF_MED.toFixed(1)}m, 절댓값 평균 ${(offs.reduce((a, c) => a + Math.abs(c), 0) / offs.length).toFixed(1)}m (보정 뒤 역 자리 차이 절댓값 평균 ${(ctrl.reduce((a, c) => a + Math.abs(c.d - offAt(c.q)), 0) / ctrl.length).toFixed(1)}m)`);
console.log(`한강 수면(SRTM 중앙값): ${F2(out.facts.crossA)} · ${F2(out.facts.crossB)} · 띠 ${river.length}점, 폭 ${Math.round(median(river.map((r) => r.WL + r.WR)))}m(중앙값)`);
function F2(c) { return `${c.a}–${c.b} ${c.water}m`; }
console.log('\n[종단] 역 사이 기울기(‰) · 평평한 승강장 반쪽(m) · 종곡선 길이(m, R=3000) · 레일 해발(m) · 높이 출처');
for (const p of PROFILE) console.log(`${pad(p.path, 8)} ${pad(p.line, 6)} ${pad(p.a + ' → ' + p.b, 18)} ${lpad(p.dist, 7)}m ${lpad(p.za, 7)} → ${lpad(p.zb, 7)}  ${lpad(p.g.toFixed(1), 6)}‰  평평 ${p.flat.join('/')}  종곡선 ${lpad(p.Lc, 5)}m  ${p.srcA}/${p.srcB}${p.note ? ' · ' + p.note : ''}`);
console.log(`최대 기울기(역 밖, 5m 간격으로 다시 잼) ${(worstG * 1000).toFixed(2)}‰ ≤ 35‰ · 최소 종곡선 반지름 ${worstR === Infinity ? '-' : Math.round(worstR) + 'm'} ≥ 3000m`);
console.log('\n[평면] 역 사이 최소 곡선 반지름(m, ±40m 세 점): 원래 OSM → 편 뒤 · 기준(2호선 180, 그 밖 250) · OSM 에서 벗어난 최대 거리');
for (const r of RADIUS) console.log(`${pad(r.path, 8)} ${pad(r.line, 6)} ${pad(r.a + ' → ' + r.b, 18)} ${lpad(r.before === Infinity ? '직선' : r.before, 6)} → ${lpad(r.after === Infinity ? '직선' : r.after, 6)}  (기준 ${r.lim})${r.after < r.lim ? ' ← 기준보다 급함(10m 안에서 더 못 폄)' : ''}`);
console.log('편 선이 OSM 에서 벗어난 최대 거리: ' + [D2, D3, D4].map((D) => Math.max(...D.runs.filter((x) => x.t === 'track').map((r) => r.dev)).toFixed(1) + 'm').join(' · '));
console.log('\n[역 높이] 공식 = 서울교통공사 CSV · 위키 = 위키 깊이 · 층수 = 층수 평균 깊이(추정) · 추정 = 앞뒤 역 보간');
for (const s of stations) console.log(`${pad(s.leg, 8)} ${pad(s.n + ' ' + s.l, 16)} 레일 ${lpad(s.z, 7)}m 지반 ${lpad(s.g, 6)}m 깊이 ${lpad(s.d == null ? '-' : s.d, 6)}m ${pad(s.src, 4)} ${s.form || ''} ${s.car ? '· ' + s.car : ''}${s.src !== '공식' && s.note ? ' · ' + s.note : ''}`);
console.log('\n대합실(추정): ' + structs.filter((x) => x.k === 'conc').map((x) => `${x.n} 해발 ${x.z}m ${x.L}×${x.W}`).join(', '));
console.log('남쪽:', JSON.stringify(out.facts.south));
