/* ride.js — 지하로 3D: 시연 1번 이야기(공덕 → 한성백제)를 지하 단면 그림으로 따라간다
   자료: ride.json (scripts/build_3d.js 가 앱의 길 찾기 코드로 계산해 만든다. 점 = [위도, 경도, 구간 m, 깊이 m, 한강 아래 정도])
   좌표 바꾸기
     - 위도·경도 → 지역 m: 기준점(LAT0, LON0)에서 동쪽 x = (경도 - LON0) × 111320 × cos(LAT0),
       북쪽 = (위도 - LAT0) × 110540. three.js 는 y 가 위쪽이라 북쪽을 -z 로 둔다.
       수십 km 범위라 평면으로 펴도 오차가 1% 미만이다.
     - 깊이: y = -(깊이 m × EXAG). 지면은 y = 0. 세로만 EXAG(20)배 늘려서 깊이 차이가 보이게 한다.
     - 한강 아래: 강바닥 깊이 자료가 없어서 '한강 아래 정도(0~1) × DIP' 만큼 그림으로만 더 내린다('깊이 추정' 표시).
   카메라 따라가기
     - 보는 점(controls.target)을 매 프레임 사람 점(조금 위) 쪽으로 1 - e^(-k·dt) 만큼 당긴다: 프레임 수와 상관없이 부드럽다.
     - 카메라는 보는 점이 움직인 만큼 같이 옮긴다: 사용자가 돌리거나 당긴 각도·거리는 그대로 남는다.
     - 움직임마다 정한 거리로 천천히 맞추고, 진행 방향의 옆으로 돌아가며, 좌우로 조금 흔든다.
       사용자가 화면을 만지면 이 셋은 멈추고 따라가기(옮기기)만 한다. 카메라는 늘 지면 위에 둔다.
     - prefers-reduced-motion 이면 흔들지 않고 첫 장면을 천천히 시작한다. */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* ---------- 0. 설정 ---------- */
const EXAG = 20;     // 세로(깊이) 과장 배율
const DIP = 160;     // 한강 아래 그림용 추가 내림(장면 단위, 실제 깊이 아님)
const COL = { bg: 0x0B1214, ground: 0x18262A, net: 0x3A5257, safe: 0x3FE6D5, expo: 0xFF5A36, river: 0x2F7FE0, est: 0x9FB3B0, white: 0xE8F1EF };
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (id) => document.getElementById(id);
// 제목: 자료의 출발·도착 역(이야기가 바뀌어도 build_3d.js 만 다시 돌리면 된다)
const setTitle = (a, b) => { document.title = `지하로 3D · ${a} → ${b}`; $('title').textContent = document.title; };
const fail = (msg) => { document.body.insertAdjacentHTML('beforeend', '<div class="fail"><p>' + msg + '<br><a href="../" style="color:#3FE6D5">지하로 앱 열기</a></p></div>'); };

let D, renderer;
try { D = await (await fetch('ride.json')).json(); } catch (e) { fail('자료(ride.json)를 불러오지 못했습니다.'); throw e; }
try { renderer = new THREE.WebGLRenderer({ canvas: $('c'), antialias: true }); } catch (e) { fail('이 기기에서는 3D 그림(WebGL)을 쓸 수 없습니다.'); throw e; }
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(COL.bg);

/* ---------- 1. 좌표 ---------- */
const allPts = Object.values(D.legs).flatMap((l) => l.pts);
const ext = (i) => [Math.min(...allPts.map((p) => p[i])), Math.max(...allPts.map((p) => p[i]))];
const [la0, la1] = ext(0), [lo0, lo1] = ext(1);
const LAT0 = (la0 + la1) / 2, LON0 = (lo0 + lo1) / 2;
const KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110540;
const toXZ = (lat, lon) => [(lon - LON0) * KX, -(lat - LAT0) * KY];
const toV = (p) => { const [x, z] = toXZ(p[0], p[1]); return new THREE.Vector3(x, -(p[3] * EXAG + p[4] * DIP), z); };

// 구간(enter 출구로 들어감 · ride1 처음 길 · blocked 막힌 터널 · ride2 다시 찾은 길 · alt 갈림길 다른 갈래)
const LEG = {};
for (const [k, l] of Object.entries(D.legs)) LEG[k] = { v: l.pts.map(toV), m: l.pts.map((p) => p[2]), len: l.pts[l.pts.length - 1][2] };
// 구간 k 위 m 지점의 장면 좌표(점 사이 직선)
function posAt(k, m, out = new THREE.Vector3()) {
  const L = LEG[k], ms = L.m;
  m = Math.max(0, Math.min(L.len, m));
  let lo = 0, hi = ms.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ms[mid] <= m) lo = mid; else hi = mid; }
  const t = ms[hi] > ms[lo] ? (m - ms[lo]) / (ms[hi] - ms[lo]) : 0;
  return out.copy(L.v[lo]).lerp(L.v[hi], t);
}

/* ---------- 2. 장면 ---------- */
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(COL.bg, 2000, 9000);
const camera = new THREE.PerspectiveCamera(45, 1, 10, 120000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;   // 지면 아래로는 내려가지 않는다(위에서 비스듬히 보는 단면)
controls.minDistance = 200; controls.maxDistance = 40000;

const basic = (o) => new THREE.MeshBasicMaterial({ transparent: true, ...o });
// 지면: 반투명한 어두운 판(아래 터널이 비친다)
const net = D.net.flat();
const [nx0, nz0] = toXZ(Math.max(...net.map((p) => p[0])), Math.min(...net.map((p) => p[1])));
const [nx1, nz1] = toXZ(Math.min(...net.map((p) => p[0])), Math.max(...net.map((p) => p[1])));
const ground = new THREE.Mesh(new THREE.PlaneGeometry(nx1 - nx0, nz1 - nz0), basic({ color: COL.ground, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide }));
ground.rotation.x = -Math.PI / 2; ground.position.set((nx0 + nx1) / 2, 0, (nz0 + nz1) / 2);
scene.add(ground);

// 바탕 선로(OSM): 지면 위에 옅은 선
function lines(polys, y, color, opacity) {
  const a = [];
  polys.forEach((l) => { for (let i = 1; i < l.length; i++) { const p = toXZ(l[i - 1][0], l[i - 1][1]), q = toXZ(l[i][0], l[i][1]); a.push(p[0], y, p[1], q[0], y, q[1]); } });
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(a, 3));
  const o = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity })); scene.add(o); return o;
}
lines(D.net, 1, COL.net, 0.55);

// 한강: 중심선 양쪽으로 half_w 만큼 편 띠(지면 높이, 그림용 폭)
{
  const P = D.river.line.map((p) => toXZ(p[0], p[1])), W = D.river.half_w, pos = [], idx = [];
  P.forEach((p, i) => {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nx = -(b[1] - a[1]) / L, nz = (b[0] - a[0]) / L;
    pos.push(p[0] + nx * W, 2, p[1] + nz * W, p[0] - nx * W, 2, p[1] - nz * W);
    if (i) idx.push(2 * i - 2, 2 * i - 1, 2 * i, 2 * i - 1, 2 * i + 1, 2 * i);
  });
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  scene.add(new THREE.Mesh(g, basic({ color: COL.river, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide })));
}

// 단면 막: 관에서 지면까지 내린 옅은 막(땅을 세로로 자른 단면). 한강 아래 구간은 위쪽을 파랗게 칠한다
function curtain(vs, riv) {
  const pos = [], col = [], idx = [], c = new THREE.Color(COL.safe), w = new THREE.Color(COL.river);
  vs.forEach((v, i) => {
    const r = riv[i], top = c.clone().lerp(w, r);
    pos.push(v.x, 0, v.z, v.x, v.y, v.z);
    col.push(top.r, top.g, top.b, 0.02 + 0.16 * r, c.r, c.g, c.b, 0.07);   // 색 + 불투명도(위 · 아래)
    if (i) idx.push(2 * i - 2, 2 * i - 1, 2 * i, 2 * i - 1, 2 * i + 1, 2 * i);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4)); g.setIndex(idx);
  const mesh = new THREE.Mesh(g, basic({ vertexColors: true, opacity: 1, depthWrite: false, side: THREE.DoubleSide }));
  scene.add(mesh);
  return mesh;
}
// 빛나는 관: 가는 불투명 관 + 굵은 반투명 관(더하기 섞기). riv 를 주면 단면 막도 단다
function tube(vs, color, r = 9, riv = null) {
  const curve = new THREE.CatmullRomCurve3(vs, false, 'centripetal');
  curve.arcLengthDivisions = vs.length * 6;
  const n = Math.max(16, vs.length * 3);
  const core = new THREE.Mesh(new THREE.TubeGeometry(curve, n, r, 6), basic({ color, opacity: 1 }));
  const glow = new THREE.Mesh(new THREE.TubeGeometry(curve, n, r * 3.4, 8), basic({ color, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending }));
  const wall = riv ? curtain(vs, riv) : null;
  scene.add(core, glow);
  return { set(color, a) {
    core.material.color.set(color); glow.material.color.set(color); core.material.opacity = a; glow.material.opacity = 0.16 * a;
    core.visible = glow.visible = a > 0.01;
    if (wall) { wall.material.opacity = a; wall.visible = a > 0.01; }
  } };
}
const E = D.legs.enter, cut = E.pts.findIndex((p) => p[2] >= E.expo_m - 0.5);
const riv = (k) => D.legs[k].pts.map((p) => p[4]);
const T = {
  street: tube(LEG.enter.v.slice(0, cut + 1).map((v) => v.clone().setY(4)), COL.expo, 7),   // 지상 걷기(출구까지)
  shaft: tube(LEG.enter.v.slice(cut), COL.safe, 9, riv('enter').slice(cut)),                // 출구 통로 → 승강장
  ride1: tube(LEG.ride1.v, COL.safe, 9, riv('ride1')),
  blocked: tube(LEG.blocked.v, COL.safe, 9, riv('blocked')),
  ride2: tube(LEG.ride2.v, COL.safe, 9, riv('ride2'))
};

// 처음 길의 나머지(여의나루 → 도착): 점선. 선은 멀리서도 1px 이라 전체 보기에서도 보인다
const restLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(LEG.rest.v), new THREE.LineDashedMaterial({ color: COL.safe, dashSize: 260, gapSize: 180, transparent: true, opacity: 0.7 }));
restLine.computeLineDistances(); scene.add(restLine);

// 사람 점: 흰 공 + 빛 번짐(스프라이트)
const glowTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c);
})();
const person = new THREE.Group();
person.add(new THREE.Mesh(new THREE.SphereGeometry(14, 12, 8), new THREE.MeshBasicMaterial({ color: COL.white })));
const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: COL.safe, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
halo.scale.set(150, 150, 1); person.add(halo);
scene.add(person);

// 막힘 표시: 빨간 원 안의 X (항상 카메라를 본다)
const blockMark = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d'); x.strokeStyle = '#FF5A36'; x.lineWidth = 10; x.lineCap = 'round';
  x.beginPath(); x.arc(64, 64, 52, 0, Math.PI * 2); x.stroke();
  x.beginPath(); x.moveTo(40, 40); x.lineTo(88, 88); x.moveTo(88, 40); x.lineTo(40, 88); x.stroke();
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  posAt('ride1', LEG.ride1.len, s.position); s.scale.set(170, 170, 1); scene.add(s); return s;
})();

/* ---------- 3. 역 표시와 이름표 ---------- */
const F = D.facts;
setTitle(F.start, F.end);
const st = (n, l) => D.stations.find((s) => s.n === n && (!l || s.l === l));
const fm = (x) => x.toFixed(1) + 'm', km = (m) => (m / 1000).toFixed(1) + 'km';
const labelsEl = $('labels'), labels = [];
// 이름표: 3D 위치를 화면 좌표로 바꿔 HTML 글자를 옮긴다(글꼴이 선명하다). vis(t) 가 거짓이면 숨긴다
function label(text, v, cls = '', vis = null, pri = 0) {
  const el = document.createElement('div'); el.className = 'lb ' + cls; el.textContent = text; el.style.display = 'none';
  labelsEl.appendChild(el); labels.push({ el, v, vis, pri, on: false, w: 0 });
}
const drops = [], seen = new Set();
const lineCount = (n) => new Set(D.stations.filter((s) => s.n === n).map((s) => s.l)).size;
// 다시 찾은 길이 나타나는 시각(아래 4절에서 정함) 전에는 그 길의 역을 숨긴다
let REVEAL_T = 0, BLOCK_T = 0;
D.stations.forEach((s) => {
  const key = s.n + '|' + s.l;
  if (seen.has(key)) return; seen.add(key);
  const v = posAt(s.leg, s.m);
  drops.push([[v.x, 0, v.z], [v.x, v.y, v.z]]);
  const mk = new THREE.Mesh(new THREE.OctahedronGeometry(16), new THREE.MeshBasicMaterial({ color: s.d == null ? COL.est : COL.white }));
  mk.position.copy(v); scene.add(mk);
  const later = s.leg === 'ride2' && !D.stations.some((o) => o.n === s.n && o.leg !== 'ride2');
  if (later) { mk.visible = false; s.mk = mk; }
  const text = s.n + (lineCount(s.n) > 1 ? ' ' + s.l : '') + ' ' + (s.d == null ? '깊이 추정' : fm(s.d));
  label(text, v.clone().add(new THREE.Vector3(0, 30, 0)), s.d == null ? 'est' : '', later ? (t) => t >= REVEAL_T : null);
});
{ // 역의 세로선(지면 → 승강장): 깊이를 읽기 쉽게
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(drops.flat(2), 3));
  scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: COL.est, transparent: true, opacity: 0.35 })));
}
// 그 밖의 이름표
const mid = (a) => (a[0] + a[1]) / 2;
label(`${F.start}역 ${F.exit_ref}번 출구`, posAt('enter', E.expo_m).add(new THREE.Vector3(0, 40, 0)), '');
label('한강 아래 · 깊이 추정', posAt('ride1', F.block_m - 300).add(new THREE.Vector3(0, -160, 0)), 'est');   // 막힘 표시·점과 겹치지 않게 앞쪽 아래
label('한강 아래 · 깊이 추정', posAt('ride2', F.crossB.m[0] + 0.72 * (F.crossB.m[1] - F.crossB.m[0])).add(new THREE.Vector3(0, -160, 0)), 'est', (t) => t >= REVEAL_T);   // 점이 오래 머물지 않는 곳
// '한강' 글자: 중심선에서 경도 126.94(마포 부근)에 가장 가까운 점
label('한강', (() => { const [x, z] = toXZ(...D.river.line.reduce((b, p) => (Math.abs(p[1] - 126.94) < Math.abs(b[1] - 126.94) ? p : b))); return new THREE.Vector3(x, 0, z); })(), 'river', null, 1);
label('막힘', blockMark.position.clone().add(new THREE.Vector3(0, 120, 0)), 'red', (t) => t >= BLOCK_T, 2);
label(`처음 길 ${km(F.first_m)}`, posAt('rest', LEG.rest.len * 0.5).add(new THREE.Vector3(0, 30, 0)), 'dim', null, 1);

/* ---------- 4. 장면(자막 한 줄)과 움직임 ----------
   움직임 = [구간, 시작 m, 끝 m, 초, 카메라 거리('all' = 전체 보기), 볼 곳(구간 m, 없으면 사람을 따라감)].
   긴 직선 구간은 짧은 시간에 빨리 감는다. 하저터널은 터널 가운데를 고정해 보고 점만 지나가게 한다(시연과 같은 모습). */
const g1 = st(F.start, '5호선');
const endM = LEG.ride2.len, A = F.crossA.m, B = F.crossB.m;
const BEATS = [
  { cap: `${F.start}역 ${F.exit_ref}번 출구로 들어가 5호선 승강장으로`, sub: `지상 ${F.expo_m}m를 걸은 뒤 지하 ${g1.f} 승강장(깊이 ${fm(g1.d)})`,
    moves: [['enter', 0, LEG.enter.len, RM ? 10 : 6, 650], ['enter', LEG.enter.len, LEG.enter.len, 0.8, 700]] },
  { cap: `한강 아래 ${F.crossA.line} ${F.crossA.a}–${F.crossA.b} 하저터널`, sub: `${F.end}역까지 지하로 ${km(F.first_m)}, 지상 ${F.first_expo_m}m인 길 · 터널 깊이는 추정`,
    moves: [['ride1', 0, F.mapo_m, 3, 900], ['ride1', F.mapo_m, F.block_m, 5, 2000, (A[0] + F.block_m) / 2 + 150]] },
  { cap: `앞이 막힘 · ${F.crossA.a}역으로 ${F.backtrack_m}m 되돌아감`, sub: `막힌 하저터널을 빼고 ${F.crossA.a}역에서 다시 찾기`,
    moves: [['ride1', F.block_m, F.block_m, 2, 1000], ['ride1', F.block_m, F.mapo_m, 3.5, 1200], ['ride1', F.mapo_m, F.mapo_m, 1.5, 1800]] },
  { cap: `다시 찾은 길 ${km(F.total2_m)}, 지상 ${F.second_expo_m}m`, sub: `${F.crossA.a}에서 남은 ${km(F.left_m)}보다 ${km(F.total2_m - F.left_m)} 더 · 한강은 ${F.crossB.a}–${F.crossB.b} 하저터널로`,
    moves: [['ride2', 0, B[0] - 300, 10, 3200]] },
  { cap: `한강 아래 다른 하저터널: ${F.crossB.a} → ${F.crossB.b}`, sub: '서울에서 한강을 지하로만 건너는 길은 5호선 하저터널 두 곳뿐',
    moves: [['ride2', B[0] - 300, B[1] + 200, 8, 2200, mid(B)]] },
  { cap: `${F.end}역 도착`, sub: `지하에 들어간 뒤 지상 노출 ${F.exposed_after_m}m · 지상은 처음 출구까지 ${F.expo_m}m`,
    moves: [['ride2', B[1] + 200, endM, 6, 1400], ['ride2', endM, endM, 4.5, 'all']] }
];
// 평평한 움직임 목록 + 시각. 조각 경계 속도 = 앞뒤 평균 속도 중 작은 쪽(방향이 다르거나 구간이 바뀌면 0)
const MOVES = [];
let TOTAL = 0;
BEATS.forEach((b, bi) => b.moves.forEach(([leg, m0, m1, sec, dist, look]) => { MOVES.push({ leg, m0, m1, sec, dist, look, bi, t0: TOTAL }); TOTAL += sec; }));
MOVES.forEach((mv, i) => {
  const v = (x) => (x ? (x.m1 - x.m0) / x.sec : 0), a = MOVES[i - 1], b = MOVES[i + 1], me = v(mv);
  const edge = (o) => (o && o.leg === mv.leg && v(o) * me > 0 ? Math.sign(me) * Math.min(Math.abs(v(o)), Math.abs(me)) : 0);
  mv.v0 = edge(a); mv.v1 = edge(b);
});
const beatT = (bi) => MOVES.find((m) => m.bi === bi).t0;
BLOCK_T = beatT(2); REVEAL_T = MOVES.filter((m) => m.bi === 2)[2].t0;

// 시각 t 의 위치: 3차 에르미트(양 끝 속도 v0, v1)로 m 을 정한다 → 조각이 바뀌어도 속도가 끊기지 않는다
function moveAt(t) {
  let mv = MOVES[MOVES.length - 1];
  for (const x of MOVES) if (t < x.t0 + x.sec) { mv = x; break; }
  const s = Math.max(0, Math.min(1, (t - mv.t0) / mv.sec)), s2 = s * s, s3 = s2 * s;
  const m = (s3 - 2 * s2 + s) * mv.sec * mv.v0 + (-2 * s3 + 3 * s2) * (mv.m1 - mv.m0) + (s3 - s2) * mv.sec * mv.v1 + mv.m0;
  return { mv, m };
}

/* ---------- 5. 자막 · 조작 ---------- */
let t = 0, playing = true, touched = false, snap = true, lastBeat = -1, lastWhere = '';
const ICON = { play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg>', pause: '<svg viewBox="0 0 24 24"><path d="M7 4.5h3.5v15H7zM13.5 4.5H17v15h-3.5z" fill="currentColor"/></svg>' };
function setPlaying(p) { playing = p; $('play').innerHTML = p ? ICON.pause : ICON.play; $('play').setAttribute('aria-label', p ? '멈춤' : '재생'); }
function seek(x) { t = Math.max(0, Math.min(TOTAL, x)); snap = true; }
$('play').onclick = () => { if (!playing && t >= TOTAL) seek(0); setPlaying(!playing); };
$('restart').onclick = () => { seek(0); touched = false; resetCamera(); setPlaying(true); };
const bar = $('bar');
bar.onpointerdown = (e) => { const r = bar.getBoundingClientRect(); seek((e.clientX - r.left) / r.width * TOTAL); };
bar.onkeydown = (e) => { if (e.key === 'ArrowRight') seek(t + 5); if (e.key === 'ArrowLeft') seek(t - 5); };
addEventListener('keydown', (e) => { if (e.key === ' ' && e.target === document.body) { e.preventDefault(); $('play').click(); } });
controls.addEventListener('start', () => { touched = true; });
setPlaying(true);

// 지금 어디인지 한 줄(타는 노선 · 되돌아가는 거리 등)
function whereText(mv, m) {
  if (mv.leg === 'enter') return m < E.expo_m ? `지상 걷기 ${Math.round(m)}m / ${F.expo_m}m` : '출구 통로 → 지하 승강장';
  if (mv.leg === 'ride1' && mv.bi === 2 && mv.m0 === F.block_m && mv.m1 === mv.m0) return `${F.crossA.a}역에서 하저터널로 ${F.walked_m}m 들어간 곳`;
  if (mv.leg === 'ride1') return mv.m1 < mv.m0 ? `되돌아가는 중 · ${F.crossA.a}역까지 ${Math.round(m - F.mapo_m)}m` : `5호선 · ${F.start} → ${F.crossA.a} → ${F.crossA.b} 방면`;
  const r = F.rides.find((x) => m < x.m1) || F.rides[F.rides.length - 1];
  const head = r.t === 'transfer' ? '환승 통로' : `${r.label} · ${r.a} → ${r.b}`;
  return `${head} · ${km(m)} / ${km(endM)}`;
}
const fmt = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

/* ---------- 6. 카메라 ----------
   보는 점 = 사람보다 조금 위(사람 깊이의 3/4). 카메라는 진행 방향의 옆(지금 카메라와 가까운 쪽) 위에서 비스듬히 본다:
   옆에서 보면 터널이 오르내리는 모양(단면)이 잘 보인다. 카메라는 늘 지면(MIN_Y) 위에 둔다. */
const tmp = new THREE.Vector3(), off = new THREE.Vector3(), want = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
const sph = new THREE.Spherical(), PHI = 0.78, PHI_ALL = 0.7, MIN_Y = 80;
// 전체 보기: 다시 찾은 길과 처음 길이 다 들어오는 거리
const box = new THREE.Box3().setFromPoints([...LEG.ride1.v, ...LEG.rest.v, ...LEG.ride2.v]), CENTER = box.getCenter(new THREE.Vector3()).setY(-300);
const overview = () => { const s = box.getSize(tmp); const h = 2 * Math.tan(camera.fov * Math.PI / 360); return Math.max(s.x / (h * camera.aspect), s.z / h) * 1.3 + 2000; };
const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));   // 각도 차이를 -π~π 로
function resetCamera() {
  posAt('enter', 0, controls.target); controls.target.y *= 0.75;
  camera.position.copy(controls.target).add(off.setFromSphericalCoords(RM ? 1500 : 1000, PHI, 0.35));
}
let sway = 0, realT = 0;
function follow(dt, mv, m) {
  const all = mv.dist === 'all', k = (r) => (snap && t > 0 ? 1 : 1 - Math.exp(-dt * r));
  const lookM = mv.look != null ? mv.look : m;                         // 하저터널은 터널 가운데를 고정해 본다
  if (all) want.copy(CENTER); else { posAt(mv.leg, lookM, want); want.y *= 0.75; }
  tmp.copy(controls.target);
  controls.target.lerp(want, snap ? 1 : 1 - Math.exp(-dt * (all ? 1.2 : RM ? 2 : 3)));
  camera.position.add(tmp.subVectors(controls.target, tmp));          // 보는 점이 움직인 만큼 카메라도
  if (touched) return;                                                 // 사용자가 돌렸으면 각도·거리는 그대로
  sph.setFromVector3(off.subVectors(camera.position, controls.target));
  const fit = Math.max(1, 1.4 / camera.aspect);                        // 세로로 긴 화면(폰)은 좌우가 좁아서 더 멀리
  sph.radius += ((all ? overview() : mv.dist * fit) - sph.radius) * k(RM ? 0.6 : 1.1);   // 처음에는 멀리서 천천히 다가간다
  sph.phi += ((all ? PHI_ALL : PHI) - sph.phi) * k(1.5);
  if (all) sph.theta += wrap(0 - sph.theta) * k(0.8);                  // 전체 보기는 남쪽에서(북쪽이 위)
  else {   // 진행 방향(앞뒤 200m)의 옆
    posAt(mv.leg, lookM + 200, a); posAt(mv.leg, lookM - 200, b);
    const dx = a.x - b.x, dz = a.z - b.z;
    if (dx * dx + dz * dz > 400) {
      let th = Math.atan2(dz, -dx);
      if (Math.abs(wrap(th - sph.theta)) > Math.PI / 2) th += Math.PI;
      sph.theta += wrap(th - sph.theta) * k(RM ? 0.4 : 0.7);
    }
  }
  if (!RM) { const s = 0.15 * Math.sin(realT * 0.2); sph.theta += s - sway; sway = s; }   // 좌우로 조금 흔들기
  sph.phi = Math.min(sph.phi, Math.acos(Math.min(1, Math.max(-1, (MIN_Y - controls.target.y) / sph.radius))));   // 지면 위에
  camera.position.copy(controls.target).add(off.setFromSpherical(sph));
}

/* ---------- 7. 그리기 ---------- */
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h;
  // 좁은 화면: 아래 자막 칸에 가리지 않게 그림 가운데를 자막 칸 높이의 절반만큼 위로 올린다
  if (w < 900) camera.setViewOffset(w, h, 0, document.querySelector('.panel').offsetHeight * 0.5, w, h); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize(); resetCamera();

const clock = new THREE.Clock();
let frames = 0, fpsT = 0;
const ui = { cap: $('cap'), sub: $('sub'), where: $('where'), prog: $('prog'), time: $('time') };
function frame() {
  const dt = Math.min(0.05, clock.getDelta());
  realT += dt;
  if (playing) { t += dt; if (t >= TOTAL) { t = TOTAL; setPlaying(false); } }
  const { mv, m } = moveAt(t);
  posAt(mv.leg, m, person.position);
  const onStreet = mv.leg === 'enter' && m < E.expo_m;
  halo.material.color.set(onStreet ? COL.expo : COL.safe);

  // 막힘 · 다시 찾은 길 나타남 · 처음 길 나머지
  const blocked = t >= BLOCK_T;
  blockMark.visible = blocked;
  if (blocked) blockMark.scale.setScalar(170 * (RM ? 1 : 1 + 0.35 * Math.exp(-(t - BLOCK_T) * 1.5) * Math.abs(Math.sin((t - BLOCK_T) * 6))));
  T.blocked.set(blocked ? COL.expo : COL.safe, blocked ? 0.5 : 0.45);
  const rev = Math.max(0, Math.min(1, (t - REVEAL_T) / 1.2));
  T.ride2.set(COL.safe, rev);
  D.stations.forEach((s) => { if (s.mk) s.mk.visible = rev > 0.5; });
  restLine.material.color.set(blocked ? COL.est : COL.safe);                     // 처음 길의 나머지: 막힌 뒤에는 회색

  follow(dt, mv, m);
  snap = false;
  controls.update();
  const cd = camera.position.distanceTo(controls.target);
  scene.fog.near = cd * 1.6; scene.fog.far = cd * 6;
  renderer.render(scene, camera);
  placeLabels(cd);

  // 글: 장면이 바뀔 때만 바꾼다
  if (mv.bi !== lastBeat) { lastBeat = mv.bi; ui.cap.textContent = BEATS[mv.bi].cap; ui.sub.textContent = BEATS[mv.bi].sub; }
  const fast = Math.abs(mv.m1 - mv.m0) / mv.sec > 500;
  const w = whereText(mv, m) + (fast ? '|ff' : '');
  if (w !== lastWhere) { lastWhere = w; ui.where.innerHTML = (fast ? '<span class="ff">빨리 감기</span>' : '') + '<span></span>'; ui.where.lastChild.textContent = w.replace('|ff', ''); }
  ui.prog.style.width = (t / TOTAL * 100).toFixed(2) + '%';
  bar.setAttribute('aria-valuenow', Math.round(t / TOTAL * 100));
  ui.time.textContent = fmt(t) + ' / ' + fmt(TOTAL);

  frames++; fpsT += dt;
  if (fpsT >= 1) { window.__ride.fps = Math.round(frames / fpsT); frames = 0; fpsT = 0; }
}

// 이름표 놓기: 카메라 앞·가까운 것만, 겹치면 우선순위(pri)·가까운 순으로 하나만
const placed = [];
function placeLabels(cd) {
  const W = innerWidth, H = innerHeight;
  const cand = [];
  for (const L of labels) {
    let ok = !L.vis || L.vis(t);
    if (ok) {
      tmp.copy(L.v).project(camera);
      const far = camera.position.distanceTo(L.v);
      ok = tmp.z < 1 && Math.abs(tmp.x) < 1.05 && Math.abs(tmp.y) < 1.05 && far < cd * 2.8;
      if (ok) cand.push({ L, x: (tmp.x + 1) / 2 * W, y: (1 - tmp.y) / 2 * H, far });
    }
    if (!ok && L.on) { L.el.style.display = 'none'; L.on = false; }
  }
  cand.sort((a, b) => b.L.pri - a.L.pri || a.far - b.far);
  placed.length = 0;
  for (const c of cand) {
    const L = c.L;
    if (!L.on) { L.el.style.display = ''; L.on = true; }
    if (!L.w) L.w = L.el.offsetWidth || 60;
    const r = [c.x - L.w / 2, c.y - 22, c.x + L.w / 2, c.y];
    if (placed.some((p) => r[0] < p[2] && r[2] > p[0] && r[1] < p[3] && r[3] > p[1])) { L.el.style.display = 'none'; L.on = false; continue; }
    placed.push(r);
    L.el.style.transform = `translate(${r[0].toFixed(1)}px, ${r[1].toFixed(1)}px)`;
  }
}

window.__ride = { seek: (x) => { seek(x); setPlaying(false); }, play: () => setPlaying(true), total: TOTAL, fps: 0, beats: BEATS.map((b, i) => ({ cap: b.cap, sub: b.sub, t: beatT(i) })) };
renderer.setAnimationLoop(frame);
