/* ride.js — 지하로 3D: 시연 1번 이야기(출발역 → 가족 약속 장소)를 지하 단면 그림으로 따라간다. 역 이름은 모두 자료(facts)에서 온다
   자료: ride.json (scripts/build_3d.js 가 앱의 길 찾기 코드로 계산해 만든다.
         점 = [위도, 경도, 구간 m, 그릴 깊이 m, 한강 아래 정도, 한강 단면 정도, 실제 깊이 m].
         선로의 평면 모양·높이는 실제 값이다: 역 레일 높이는 서울교통공사 자료, 역 사이는 35‰ 이하 기울기와 반지름 3,000m 종곡선,
         평면 곡선은 OSM 선에서 10m 안에서 편 것. 그릴 깊이 = 기준 지반(보정한 SRTM 을 길 따라 부드럽게, 역에서는 공식 지반고) − 바닥 높이.
         실제 깊이(글자) = 같은 기준 지반 − 바닥 높이, 한강 위는 수면 − 바닥 높이)
   두 가지로 연다
     - /3d/          혼자 재생: 이 파일의 장면 목록(BEATS)과 시계로 움직이고 자막을 보여 준다.
     - /3d/?follow   발표 무대(web/stage/) 안: 자기 시계를 쓰지 않고, 앱 시연(demo.js)이 보내는 메시지로 움직인다(5절).
       받는 것(무대가 넘겨 줌): { src: 'jiharo-demo', ver: 1, type: 'scene'|'leg'|'pos'|'state'|'end', ... } — 형식은 web/js/demo.js 6절.
       보내는 것(window.parent): { src: 'jiharo-3d', type: 'hello' }(처음 한 번, 지금 상태를 다시 받음) · { type: 'key', key }(Space·→ 를 무대로)
     - ?lq           가볍게: 고리 수 절반, 벽 등 없음, 화소 비율 1. 1초 평균 25fps 아래가 3초 이어지면 저절로 가볍게 바꾼다.
   좌표 바꾸기
     - 위도·경도 → 지역 m: 기준점(LAT0, LON0)에서 동쪽 x = (경도 - LON0) × 111320 × cos(LAT0),
       북쪽 = (위도 - LAT0) × 110540. three.js 는 y 가 위쪽이라 북쪽을 -z 로 둔다.
       수십 km 범위라 평면으로 펴도 오차가 1% 미만이다.
     - 깊이: y = -(깊이 m × EXAG). 지면은 y = 0. 세로만 EXAG(자료의 exag, 10)배 늘려서 깊이 차이가 보이게 한다.
     - 한강 아래: 그릴 깊이는 둑 높이(양쪽 둑 지반을 이은 값)에서 잰 깊이라 터널이 강 아래로 내려가 보인다. 깊이 숫자는 역(승강장 자료)에만 쓰고 역 사이·한강 아래는 쓰지 않는다.
       강바닥 자료는 없어서 그리지 않는다(단면의 물·흙 경계는 그림).
   행정 경계: 서울 자치구·경기 시·군(OSM) 선을 지면 위 옅은 점선으로, 경로가 지나는 시·군·구 이름을 옅게.
   터널: 반투명 껍데기 + 고리 + 바닥·레일 + 벽 등. 걷는 점 가까운 고리는 밝게(점이 터널 안을 비추는 것처럼).
   역: 승강장 상자(깊이 = 자료 값, 노선 색 테두리) · 환승역과 입구는 대합실 판(깊이 추정). 모양은 개략.
   공습경보: 거리의 빨간 고리 · 먼 곳 섬광 몇 번 · 먼 연기 기둥 두세 개. 몇 초 뒤 사라진다(폭발·사람 피해는 그리지 않는다).
   막힘: 터널 안으로 들어가 지켜본다. 잠깐 흔들린 뒤 앞쪽 천장에서 덩어리가 떨어져 터널 단면을 막고 먼지가 찬다(약 1.5초).
     잠시 본 뒤 밖으로 나와 막힌 구간(빨강)을 보고, 그다음 다시 출발할 역으로 되돌아간다. 터널 모양·깊이는 바꾸지 않는다.
   갈림길(처음 길에서 지나는 첫 갈림길, 자료 facts.junction · legs.fork): 다른 갈래는 옅은 회색 터널 400m.
     걷는 점이 다가가면 터널 안(갈림길 35m 앞)으로 들어가 두 갈래를 보여 준다. 고른 갈래(청록)에 앱 안내 문장, 다른 갈래에 그 선로 이름.
     잠시 멈췄다가 점이 고른 갈래로 들어가면 밖으로 나온다. 움직임 줄이기에서는 밖에서 이름표만.
   카메라 따라가기
     - 보는 점(controls.target)을 매 프레임 볼 곳 쪽으로 1 - e^(-k·dt) 만큼 당긴다: 프레임 수와 상관없이 부드럽다.
     - 카메라는 보는 점이 움직인 만큼 같이 옮긴다: 사용자가 돌리거나 당긴 각도·거리는 그대로 남는다.
     - 정한 거리로 천천히 맞추고, 진행 방향의 옆으로 돌아가며, 좌우로 조금 흔든다.
       사용자가 화면을 만지면 이 셋은 멈추고 따라가기(옮기기)만 한다. 카메라는 늘 지면 위에 둔다.
     - 터널 안 시점은 세 번: 갈림길, 첫 하저터널의 무너짐(막힌 곳 32m 뒤에서), 두 번째 하저터널 가운데(짧게, 무사히 지나감).
       바깥 카메라와 안 카메라를 0~1 비율로 섞는다.
     - prefers-reduced-motion 이면 흔들지 않고, 터널 안으로 들어가지 않고, 첫 장면을 천천히 시작한다. */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* ---------- 0. 설정 ---------- */
const Q = new URLSearchParams(location.search);
const FOLLOW = Q.has('follow');                 // 발표 무대 안(앱 시연을 따라감)
let LQ = Q.has('lq');                           // 가볍게
const R = 12;        // 터널 반지름(장면 단위, 그림용)
const COL = { bg: 0x0B1214, ground: 0x18262A, net: 0x3A5257, safe: 0x3FE6D5, expo: 0xFF5A36, river: 0x2F7FE0, est: 0x9FB3B0, white: 0xE8F1EF, earth: 0x6B5236, lamp: 0xFFD9A0 };
// 노선 색(web/js/lines.js 와 같은 값). 승강장 테두리에 쓴다
const LINE_COL = { '1호선': 0x0052A4, '2호선': 0x00A84D, '3호선': 0xEF7C1C, '4호선': 0x00A5DE, '5호선': 0x996CAC, '6호선': 0xCD7C2F, '7호선': 0x747F00, '8호선': 0xE6186C, '9호선': 0xBDB092, '수인분당선': 0xF5A200 };
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (id) => document.getElementById(id);
if (FOLLOW) document.body.classList.add('follow');
// 제목: 자료의 출발·도착 역(이야기가 바뀌어도 build_3d.js 만 다시 돌리면 된다)
const setTitle = (a, b) => { document.title = `지하로 3D · ${a} → ${b}`; $('title').textContent = document.title; };
const fail = (msg) => { document.body.insertAdjacentHTML('beforeend', '<div class="fail"><p>' + msg + '<br><a href="../" style="color:#3FE6D5">지하로 앱 열기</a></p></div>'); };

let D, renderer;
try { D = await (await fetch('ride.json')).json(); } catch (e) { fail('자료(ride.json)를 불러오지 못했습니다.'); throw e; }
try { renderer = new THREE.WebGLRenderer({ canvas: $('c'), antialias: !LQ }); } catch (e) { fail('이 기기에서는 3D 그림(WebGL)을 쓸 수 없습니다.'); throw e; }
renderer.setPixelRatio(LQ ? 1 : Math.min(devicePixelRatio, 2));
renderer.setClearColor(COL.bg);
const EXAG = D.exag;
$('exag').textContent = EXAG;

/* ---------- 1. 좌표 ---------- */
const allPts = Object.values(D.legs).flatMap((l) => l.pts);
const ext = (i) => [Math.min(...allPts.map((p) => p[i])), Math.max(...allPts.map((p) => p[i]))];
const [la0, la1] = ext(0), [lo0, lo1] = ext(1);
const LAT0 = (la0 + la1) / 2, LON0 = (lo0 + lo1) / 2;
const KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110540;
const toXZ = (lat, lon) => [(lon - LON0) * KX, -(lat - LAT0) * KY];
const toV = (p) => { const [x, z] = toXZ(p[0], p[1]); return new THREE.Vector3(x, -p[3] * EXAG, z); };

// 구간: enter 출구로 들어감 · ride1 처음 길 · blocked 막힌 터널 · rest 처음 길 나머지 · ride2 다시 찾은 길 · south 수서 → 동탄
const LEG = {};
for (const [k, l] of Object.entries(D.legs)) LEG[k] = { v: l.pts.map(toV), m: l.pts.map((p) => p[2]), len: l.pts[l.pts.length - 1][2], pts: l.pts };
// 구간 k 위 m 지점: 점 사이를 직선으로(pos = 장면 좌표, depth = 그릴 깊이 m)
function at(k, m) {
  const L = LEG[k], ms = L.m;
  m = Math.max(0, Math.min(L.len, m));
  let lo = 0, hi = ms.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ms[mid] <= m) lo = mid; else hi = mid; }
  return { lo, hi, t: ms[hi] > ms[lo] ? (m - ms[lo]) / (ms[hi] - ms[lo]) : 0 };
}
function posAt(k, m, out = new THREE.Vector3()) { const a = at(k, m), v = LEG[k].v; return out.copy(v[a.lo]).lerp(v[a.hi], a.t); }
// 실제 깊이(글자용, 한강 위는 수면 아래)와 한강 아래 정도
function depthAt(k, m) { const a = at(k, m), p = LEG[k].pts; return p[a.lo][6] + (p[a.hi][6] - p[a.lo][6]) * a.t; }
function rivAt(k, m) { const a = at(k, m), p = LEG[k].pts; return p[a.lo][4] + (p[a.hi][4] - p[a.lo][4]) * a.t; }

/* ---------- 2. 장면 ---------- */
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(COL.bg, 2000, 9000);
const camera = new THREE.PerspectiveCamera(45, 1, 10, 150000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;   // 지면 아래로는 내려가지 않는다(위에서 비스듬히 보는 단면)
controls.minDistance = 200; controls.maxDistance = 60000;

const basic = (o) => new THREE.MeshBasicMaterial({ transparent: true, ...o });
const geo = (pos, idx, col) => {
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (col) g.setAttribute('color', new THREE.Float32BufferAttribute(col, col.length / (pos.length / 3)));
  if (idx) g.setIndex(idx);
  return g;
};
// 지면: 반투명한 어두운 판(아래 터널이 비친다). 모든 구간 + 3km
{
  const [x0, z0] = toXZ(la1 + 0.03, lo0 - 0.04), [x1, z1] = toXZ(la0 - 0.03, lo1 + 0.04);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), basic({ color: COL.ground, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide }));
  ground.rotation.x = -Math.PI / 2; ground.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
  scene.add(ground);
}
// 바탕 선로(OSM): 지면 위에 옅은 선
function lines(polys, y, color, opacity) {
  const a = [];
  polys.forEach((l) => { for (let i = 1; i < l.length; i++) { const p = toXZ(l[i - 1][0], l[i - 1][1]), q = toXZ(l[i][0], l[i][1]); a.push(p[0], y, p[1], q[0], y, q[1]); } });
  const o = new THREE.LineSegments(geo(a), new THREE.LineBasicMaterial({ color, transparent: true, opacity })); scene.add(o); return o;
}
// 행정 경계(OSM): 서울 자치구·경기 시·군은 옅은 점선, 서울 경계는 조금 진한 긴 점선. 지면 바로 위
{
  for (const [lv, op, dash] of [[6, 0.45, 90], [4, 0.7, 220]]) {
    const a = [];
    (D.bounds || []).filter((b) => b.lv === lv).forEach((b) => { for (let i = 1; i < b.p.length; i++) { const p = toXZ(b.p[i - 1][0], b.p[i - 1][1]), q = toXZ(b.p[i][0], b.p[i][1]); a.push(p[0], 1.5, p[1], q[0], 1.5, q[1]); } });
    if (!a.length) continue;
    const o = new THREE.LineSegments(geo(a), new THREE.LineDashedMaterial({ color: COL.est, transparent: true, opacity: op, dashSize: dash, gapSize: dash * 0.7, depthWrite: false }));
    o.computeLineDistances(); scene.add(o);
  }
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
  scene.add(new THREE.Mesh(geo(pos, idx), basic({ color: COL.river, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide })));
}

// 단면: 터널 아래에서 지면까지 세로로 자른 땅. 한강 가까이(cut)에서 진하게, 한강 아래(riv)는 위쪽이 물(아래로 옅어짐)
function slice(leg) {
  const P = LEG[leg].pts, V = LEG[leg].v, pos = [], col = [], idx = [];
  const earth = new THREE.Color(COL.earth), water = new THREE.Color(COL.river);
  V.forEach((v, i) => {
    const riv = P[i][4], cut = P[i][5], a = 0.05 + 0.4 * cut, top = earth.clone().lerp(water, riv);
    pos.push(v.x, 0, v.z, v.x, Math.max(v.y + R, -60), v.z, v.x, v.y - R - 30, v.z);   // 지면 · 물 아래 끝(그림용) · 터널 아래
    col.push(top.r, top.g, top.b, a * (1 + riv), earth.r, earth.g, earth.b, a * 0.8, earth.r * 0.6, earth.g * 0.6, earth.b * 0.6, a);
    if (i) for (const k of [0, 1]) { const p = 3 * (i - 1) + k, q = 3 * i + k; idx.push(p, p + 1, q, p + 1, q + 1, q); }
  });
  const mesh = new THREE.Mesh(geo(pos, idx, col), basic({ vertexColors: true, depthWrite: false, side: THREE.DoubleSide }));
  scene.add(mesh);
  return mesh;
}

// 터널: 껍데기(반투명) + 고리(InstancedMesh 로 한 번에 그림, 가늘고 어둡게) + 바닥·레일 + 벽 등 + 단면
const RING_GAP = LQ ? 80 : 40;
const RING = new THREE.TorusGeometry(R, 0.6, 3, 14), Z = new THREE.Vector3(0, 0, 1), ONE = new THREE.Vector3(1, 1, 1), UP = new THREE.Vector3(0, 1, 0);
const tunnels = [];
const lampTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c);
})();
function tunnel(leg, color, from = 0) {
  const vs = LEG[leg].v.slice(from).filter((v, i, a) => i === 0 || v.distanceTo(a[i - 1]) > 0.5);
  const curve = new THREE.CatmullRomCurve3(vs, false, 'centripetal');
  curve.arcLengthDivisions = vs.length * 4;
  const len = curve.getLength(), n = Math.max(16, Math.min(4000, Math.round(len / (LQ ? 20 : 12))));
  const shell = new THREE.Mesh(new THREE.TubeGeometry(curve, n, R, LQ ? 8 : 10), basic({ color, opacity: 0.13, depthWrite: false, side: THREE.DoubleSide }));
  // 일정 간격 점과 방향 → 고리 · 바닥 · 레일 · 등
  const k = Math.max(2, Math.round(len / 10)), P = curve.getSpacedPoints(k), side = new THREE.Vector3(), tan = new THREE.Vector3();
  const ringN = Math.floor(len / RING_GAP), rings = new THREE.InstancedMesh(RING, basic({ color: 0xffffff, opacity: 0.5 }), ringN);
  const floor = [], fIdx = [], rails = [], lamps = [], ringPos = new Float32Array(ringN * 3), mtx = new THREE.Matrix4(), q = new THREE.Quaternion();
  P.forEach((p, i) => {
    tan.subVectors(P[Math.min(k, i + 1)], P[Math.max(0, i - 1)]).normalize();
    side.set(-tan.z, 0, tan.x).normalize();                                  // 수평 옆 방향
    const y = p.y - R * 0.7;
    floor.push(p.x + side.x * 8, y, p.z + side.z * 8, p.x - side.x * 8, y, p.z - side.z * 8);
    if (i) { fIdx.push(2 * i - 2, 2 * i - 1, 2 * i, 2 * i - 1, 2 * i + 1, 2 * i); for (const s of [3.5, -3.5]) rails.push(P[i - 1].x + side.x * s, P[i - 1].y - R * 0.66, P[i - 1].z + side.z * s, p.x + side.x * s, p.y - R * 0.66, p.z + side.z * s); }
    if (i % 3 === 0) lamps.push(p.x + side.x * R * 0.8, p.y + R * 0.3, p.z + side.z * R * 0.8);   // 30m 마다 한쪽 벽에 등
  });
  const base = new THREE.Color(color).multiplyScalar(0.45);
  for (let i = 0; i < ringN; i++) {
    const u = (i + 0.5) / ringN, p = curve.getPointAt(u);
    q.setFromUnitVectors(Z, curve.getTangentAt(u, tan));
    rings.setMatrixAt(i, mtx.compose(p, q, ONE)); rings.setColorAt(i, base);
    ringPos.set([p.x, p.y, p.z], i * 3);
  }
  const fl = new THREE.Mesh(geo(floor, fIdx), basic({ color: 0x0E1517, opacity: 0.85, side: THREE.DoubleSide }));
  const rl = new THREE.LineSegments(geo(rails), new THREE.LineBasicMaterial({ color: 0x8FA3A0, transparent: true }));
  const lp = new THREE.Points(geo(lamps), new THREE.PointsMaterial({ color: COL.lamp, size: 6, map: lampTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  const sl = leg === 'enter' || leg === 'fork' ? null : slice(leg);   // 입구·갈림길 다른 갈래는 단면 없이
  lp.visible = !LQ;
  scene.add(shell, rings, fl, rl, lp);
  const T = { leg, shell, slice: sl, lamps: lp, rings, ringPos, ringN, lit: new Float32Array(ringN).fill(-1), color: new THREE.Color(color), a: 1,
    set(c, a) {   // 색(막힘이면 빨강)과 불투명도(다시 찾은 길이 나타날 때)
      if (!this.color.equals(new THREE.Color(c))) { this.color.set(c); shell.material.color.set(c); this.lit.fill(-1); }
      if (a === this.a) return;
      this.a = a;
      rings.material.opacity = 0.5 * a; fl.material.opacity = 0.85 * a; rl.material.opacity = a; lp.material.opacity = a;
      [shell, rings, fl, rl, sl].forEach((o) => { if (o) o.visible = a > 0.01; });
      lp.visible = a > 0.01 && !LQ;
    } };
  tunnels.push(T);
  return T;
}
// 걷는 점 가까운 고리를 밝게: 점에서 100 안이면 등 색 쪽으로 조금 섞는다(점이 터널 안을 비추는 것처럼)
const warm = new THREE.Color(COL.lamp), ringCol = new THREE.Color();
function lightRings(p) {
  for (const T of tunnels) {
    let changed = false;
    for (let i = 0; i < T.ringN; i++) {
      if (T.dead && T.dead.has(i)) continue;                              // 무너진 곳 고리는 어두운 채로
      const dx = T.ringPos[i * 3] - p.x, dy = T.ringPos[i * 3 + 1] - p.y, dz = T.ringPos[i * 3 + 2] - p.z;
      const d2 = dx * dx + dy * dy + dz * dz, s = d2 < 10000 ? Math.round((1 - Math.sqrt(d2) / 100) * 10) / 10 : 0;
      if (s === T.lit[i]) continue;
      T.lit[i] = s; changed = true;
      T.rings.setColorAt(i, ringCol.copy(T.color).multiplyScalar(0.45).lerp(warm, s * 0.55));
    }
    if (changed) T.rings.instanceColor.needsUpdate = true;
  }
}

// 길거리(지상 노출)는 지면 위 주황 관
function streetTube(vs) {
  const curve = new THREE.CatmullRomCurve3(vs, false, 'centripetal');
  scene.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 32, 7, 6), basic({ color: COL.expo, opacity: 1 })),
    new THREE.Mesh(new THREE.TubeGeometry(curve, 32, 22, 8), basic({ color: COL.expo, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending })));
}
const E = D.legs.enter, cut = E.pts.findIndex((p) => p[2] >= E.expo_m - 0.5);
streetTube(LEG.enter.v.slice(0, cut + 1).map((v) => v.clone().setY(4)));
LEG.enter.v = LEG.enter.v.map((v, i) => (i <= cut ? v.clone().setY(4) : v));   // 걷는 점도 지면 위로
const TN = { enter: tunnel('enter', COL.safe, cut), ride1: tunnel('ride1', COL.safe), blocked: tunnel('blocked', COL.safe), ride2: tunnel('ride2', COL.safe) };
// 다른 갈래는 실제로 수백 m 를 처음 길과 거의 나란히(10m 안) 가서 그림 터널(지름 24)이 겹친다 → 그 갈래 쪽 옆으로 벌려 그린다(개략: 120m 에서 2.6R)
if (LEG.fork && D.facts.junction) {
  const Jm = D.facts.junction.m, a0 = posAt('ride1', Jm + 150), side = posAt('fork', 150).sub(a0).setY(0).normalize();
  LEG.fork.v = LEG.fork.v.map((v, i) => {
    const s = LEG.fork.m[i], base = posAt('ride1', Jm + s), want = Math.min(2.6 * R, 0.3 * s);
    return v.clone().sub(base).setY(0).dot(side) >= want ? v : base.addScaledVector(side, want).setY(v.y);
  });
}
if (LEG.fork) { TN.fork = tunnel('fork', COL.est); TN.fork.set(COL.est, 0.6); }   // 갈림길의 다른 갈래(가지 않는 쪽): 옅은 회색

// 점선: 처음 길의 나머지(여의나루 → 도착) · 수서 → 동탄. 선은 멀리서도 1px 이라 전체 보기에서도 보인다
function dashed(leg, color, opacity) {
  const o = new THREE.Line(new THREE.BufferGeometry().setFromPoints(LEG[leg].v), new THREE.LineDashedMaterial({ color, dashSize: 260, gapSize: 180, transparent: true, opacity }));
  o.computeLineDistances(); scene.add(o); return o;
}
const restLine = dashed('rest', COL.safe, 0.7), southLine = dashed('south', COL.safe, 0);
// 남쪽(수서 → 동탄): 끝 장면에서 수서부터 화살표처럼 이어진다. 갈매기표(›)가 앞으로 차례로 찍히고 맨 앞에 빛나는 화살촉,
// 동탄에 닿으면 화살촉이 사라지고 갈매기표가 천천히 남쪽으로 흐른다. 진행은 남쪽 장면 시작 뒤 시각만으로 정한다(되감아도 같은 그림)
const SOUTH = (() => {
  const L = LEG.south.len, GAP = 900, N = Math.floor(L / GAP) + 1, GROW = RM ? 0 : 2.6, FLOW = 260;   // m · 초 · 흐르는 속도(m/초)
  // 바닥 점선: 100m 마다 점을 두고, 화살촉이 지나간 곳까지만 그린다
  const P = []; for (let m = 0; m < L; m += 100) P.push(posAt('south', m)); P.push(posAt('south', L));
  southLine.geometry.dispose(); southLine.geometry = new THREE.BufferGeometry().setFromPoints(P); southLine.computeLineDistances();
  // 갈매기표: 꼭짓점이 앞(+x), 두 팔이 뒤로(폭 ±280m, 길이 320m, 굵기 110m). 지면 아래 선 위에 있지만 지면 판에 가리지 않게 맨 위에 그린다
  const W = 280, Lc = 320, T = 110, pos = [];
  for (const k of [1, -1]) pos.push(0, 0, 0, -Lc, 0, k * W, -Lc - T, 0, k * W, 0, 0, 0, -Lc - T, 0, k * W, -T, 0, 0);
  const chev = new THREE.BufferGeometry(); chev.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const mat = (op) => new THREE.MeshBasicMaterial({ color: COL.safe, transparent: true, opacity: op, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  const marks = new THREE.InstancedMesh(chev, mat(0.85), N), head = new THREE.Mesh(chev, mat(1));
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: lampTex, color: COL.safe, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
  marks.renderOrder = head.renderOrder = glow.renderOrder = 5; marks.frustumCulled = false;
  marks.visible = head.visible = glow.visible = false;
  scene.add(marks, head, glow);
  const p = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), mtx = new THREE.Matrix4();
  const place = (m, size, out) => {   // m 자리에서 진행 방향을 보는 행렬
    posAt('south', m, p); posAt('south', Math.min(L, m + 60), a); posAt('south', Math.max(0, m - 60), b);
    q.setFromAxisAngle(UP, Math.atan2(-(a.z - b.z), a.x - b.x));
    return out.compose(p, q, sc.setScalar(Math.max(size, 1e-4)));
  };
  // 남쪽 장면 시작 뒤 tau 초의 화살촉 자리(m): 거의 같은 빠르기로 가다가 끝에서 조금 느려진다
  const frontAt = (tau) => { if (tau < 0) return 0; const u = GROW ? Math.min(1, tau / GROW) : 1; return L * (0.4 * u + 0.6 * (1 - (1 - u) * (1 - u))); };
  const box = new THREE.Box3();
  return {
    GROW,
    box(c) { return box.copy(BOX.all).expandByPoint(posAt('south', Math.min(L, frontAt(c - EV.south) + 6000), a)); },   // 전체 보기: 화살촉 6km 앞까지(카메라가 늦게 따라가도 화살촉이 보이게)
    update(c) {
      const tau = c - EV.south, on = tau >= 0;
      marks.visible = on; southLine.material.opacity = on ? 0.5 : 0;
      if (!on) { head.visible = glow.visible = false; return; }
      const front = frontAt(tau), done = tau >= GROW;
      southLine.geometry.setDrawRange(0, Math.min(P.length, Math.floor(front / 100) + 2));
      const flow = done && !RM ? ((tau - GROW) * FLOW) % GAP : 0;
      for (let i = 0; i < N; i++) {
        const m = Math.min(L, i * GAP + flow), size = ss((front - m) / 350) * ss((m + 1) / 350) * ss((L - m) / 350);   // 찍힐 때 커지고 양 끝에서 작게
        marks.setMatrixAt(i, place(m, size, mtx));
      }
      marks.instanceMatrix.needsUpdate = true;
      const hv = 1 - ss((tau - GROW) / 0.5);   // 동탄에 닿으면 화살촉은 0.5초 동안 사라진다
      head.visible = glow.visible = hv > 0.01 && !RM;
      if (head.visible) {
        place(front, 1.9 * hv, head.matrix); head.matrix.decompose(head.position, head.quaternion, head.scale);
        glow.position.copy(head.position); glow.scale.setScalar(2600 * hv); glow.material.opacity = hv;
      }
    }
  };
})();

// 역 구조(개략): 승강장 상자(노선 색 테두리) · 대합실 판(회색). 처음부터 보이는 것과 다시 찾은 길(ride2)의 것을 따로 묶는다
function structures(list) {
  const box = new THREE.BoxGeometry(1, 1, 1), mesh = new THREE.InstancedMesh(box, basic({ color: 0xffffff, opacity: 0.1, depthWrite: false }), list.length);
  const edges = [], ecol = [], mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
  // 상자 모서리 12개(단위 상자 꼭짓점 번호)
  const E12 = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  list.forEach((s, i) => {
    const [x, z] = toXZ(s.c[0], s.c[1]), plat = s.k === 'platform', H = plat ? 2 * R + 6 : 10;
    const pos = new THREE.Vector3(x, -s.d * EXAG, z), scl = new THREE.Vector3(s.L, H, s.W);
    q.setFromAxisAngle(UP, s.a);
    mtx.compose(pos, q, scl);
    c.set(plat ? (s.est ? COL.est : LINE_COL[s.l] || COL.est) : COL.est);
    mesh.setMatrixAt(i, mtx); mesh.setColorAt(i, c);
    const corner = (j) => new THREE.Vector3(j & 4 ? 0.5 : -0.5, j & 2 ? 0.5 : -0.5, j & 1 ? 0.5 : -0.5).applyMatrix4(mtx);
    E12.forEach(([a, b]) => { const p = corner(a), r = corner(b); edges.push(p.x, p.y, p.z, r.x, r.y, r.z); for (let k = 0; k < 2; k++) ecol.push(c.r, c.g, c.b); });
  });
  const ed = new THREE.LineSegments(geo(edges, null, ecol), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }));
  const grp = new THREE.Group(); grp.add(mesh, ed); scene.add(grp);
  return grp;
}
const structEarly = structures(D.structs.filter((s) => s.leg !== 'ride2')), structLater = structures(D.structs.filter((s) => s.leg === 'ride2'));

// 사람 점: 흰 공 + 작은 빛 번짐(스프라이트). 터널 안 시점에서는 공을 숨기고 작은 등 하나만 앞에 보인다
const person = new THREE.Group(), dot = new THREE.Mesh(new THREE.SphereGeometry(7, 12, 8), new THREE.MeshBasicMaterial({ color: COL.white }));
const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: lampTex, color: COL.safe, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
halo.scale.set(70, 70, 1); person.add(dot, halo);
scene.add(person);

// 막힘 표시: 빨간 원 안의 X (항상 카메라를 본다)
const blockMark = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d'); x.strokeStyle = '#FF5A36'; x.lineWidth = 10; x.lineCap = 'round';
  x.beginPath(); x.arc(64, 64, 52, 0, Math.PI * 2); x.stroke();
  x.beginPath(); x.moveTo(40, 40); x.lineTo(88, 88); x.moveTo(88, 40); x.lineTo(40, 88); x.stroke();
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  posAt('ride1', LEG.ride1.len, s.position).y += R + 55; s.scale.set(130, 130, 1); scene.add(s); return s;   // 터널 위(잔해 더미가 가려지지 않게)
})();

/* ---------- 2-1. 공습경보 표시: 거리의 빨간 고리 · 먼 곳 섬광 · 먼 연기 기둥(4.5초, 그 뒤 1.5초에 걸쳐 사라짐) ---------- */
const ss = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
const raid = (() => {
  const g = new THREE.Group(), s = LEG.enter.v[0], DUR = 4.5;   // s = 공습경보가 울린 거리(출발 거리)
  const ring = () => { const m = new THREE.Mesh(new THREE.RingGeometry(0.88, 1, 48), basic({ color: COL.expo, opacity: 0, depthWrite: false, side: THREE.DoubleSide })); m.rotation.x = -Math.PI / 2; m.position.set(s.x, 6, s.z); g.add(m); return m; };
  const rings = [ring(), ring(), ring()];
  // 먼 곳 섬광: [카메라가 보는 방향에서 벗어난 각(도), 거리 m, 시작 초]. 땅 위에서 짧게 번쩍인다
  const flashes = [[-50, 1100, 0.3], [20, 900, 0.9], [55, 1300, 1.5], [-20, 1400, 2.2], [35, 1000, 2.9]].map(([deg, d, t0]) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: lampTex, color: 0xFFB070, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));
    sp.scale.set(700, 700, 1); g.add(sp);
    return { sp, t0, deg, d };
  });
  // 먼 연기 기둥 세 개: 천천히 올라간다
  const smoke = [[-35, 1200], [10, 1450], [45, 1000]].map(([deg, d]) => {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(170, 60, 1, 10, 1, true), basic({ color: 0x59605F, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
    g.add(c); return { c, deg, d };
  });
  // 공습경보가 시작될 때 한 번: 카메라가 보는 쪽(지면에 눕힌 방향) 너머에 놓는다(화면에 들어오게)
  let placed = false;
  function place() {
    const f = new THREE.Vector3().subVectors(controls.target, camera.position).setY(0).normalize(), base = Math.atan2(f.x, -f.z);
    const put = (o, deg, d, y) => { const a = base + deg * Math.PI / 180; o.position.set(s.x + Math.sin(a) * d, y, s.z - Math.cos(a) * d); };
    flashes.forEach((k) => put(k.sp, k.deg, k.d, 30)); smoke.forEach((k) => put(k.c, k.deg, k.d, 0));
    placed = true;
  }
  g.visible = false; scene.add(g);
  return {
    update(tr) {   // tr = 공습경보가 시작되고 지난 초(아직이면 음수)
      g.visible = tr >= 0 && tr < DUR + 1.5;
      if (!g.visible) { if (tr < 0) placed = false; return; }
      if (!placed) place();
      const env = ss(tr / 0.6) * ss((DUR + 1.5 - tr) / 1.5);
      rings.forEach((m, i) => { const ph = (((tr - i * 0.45) % 1.35) + 1.35) % 1.35 / 1.35; m.scale.setScalar(30 + 330 * ph); m.material.opacity = (1 - ph) * 0.85 * env * (tr < DUR ? 1 : 0); });
      flashes.forEach(({ sp, t0 }) => { const u = (tr - t0) / 0.7; sp.material.opacity = u > 0 && u < 1 ? Math.sin(u * Math.PI) * 0.9 : 0; });
      smoke.forEach(({ c }, i) => { const h = 200 + 1100 * ss((tr - i * 0.5) / DUR); c.scale.y = h; c.position.y = h / 2; c.material.opacity = 0.3 * env; });
    }
  };
})();

/* ---------- 2-2. 무너짐(막힘): 터널 천장에서 덩어리가 떨어지고 먼지가 일다가(약 2초), 들쭉날쭉한 잔해 더미가 남는다 ----------
   덩어리는 InstancedMesh 하나, 먼지는 Points 하나. 무너진 곳(막힌 지점 앞뒤 35m) 고리는 기울고 어두워진다. 터널 모양은 바꾸지 않는다 */
const collapse = (() => {
  const rnd = ((s) => () => (s = (s * 16807) % 2147483647) / 2147483647)(7);   // 늘 같은 모양(씨앗 고정)
  const N = 96, rock = new THREE.IcosahedronGeometry(1, 0), nrm = rock.attributes.normal, L0 = new THREE.Vector3(0.35, 0.9, 0.25).normalize(), shade = [];
  for (let i = 0; i < nrm.count; i++) { const k = 0.45 + 0.55 * Math.max(0, nrm.getX(i) * L0.x + nrm.getY(i) * L0.y + nrm.getZ(i) * L0.z); shade.push(k, k, k); }
  rock.setAttribute('color', new THREE.Float32BufferAttribute(shade, 3));
  const chunks = new THREE.InstancedMesh(rock, new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true }), N);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), e = new THREE.Euler(), s3 = new THREE.Vector3(), mtx = new THREE.Matrix4(), c = new THREE.Color();
  // 덩어리 i: 막힌 곳 앞(막힌 터널 2~34m) 천장에서 떨어져 쌓인다. 12m 둘레가 가장 높아(천장 가까이) 터널 단면을 막는 벽이 된다
  const ax = posAt('blocked', 30).sub(posAt('blocked', 0)).setY(0).normalize(), sd = new THREE.Vector3(-ax.z, 0, ax.x);   // 터널 방향 · 옆
  const parts = Array.from({ length: N }, (_, i) => {
    const along = 2 + 32 * rnd(), v = posAt('blocked', along), big = i < 22;
    const side = (rnd() - 0.5) * 2 * R * 0.8, size = big ? 3.5 + rnd() * 3 : 1.4 + rnd() * 2.2;
    const wall = Math.max(0, 1 - Math.abs(along - 12) / 22) * Math.sqrt(Math.max(0, 1 - (side / R) ** 2));   // 단면 안 쌓일 수 있는 높이 비율
    const pile = wall * R * 1.55 * Math.pow(rnd(), 0.6);
    c.setHSL(0.07, 0.16, 0.12 + rnd() * 0.14); chunks.setColorAt(i, c);
    return { x: v.x + sd.x * side, z: v.z + sd.z * side, top: v.y + R * 0.9, rest: Math.min(v.y + R * 0.85, v.y - R * 0.7 + size * 0.5 + pile), delay: Math.pow(rnd(), 1.5) * 0.8, size, rx: rnd() * 6, ry: rnd() * 6 };
  });
  // 먼지: 막힌 곳에서 터널을 따라 앞뒤로 퍼진다(옆·위아래는 터널 안까지만)
  const dustN = 140, dustDir = [], dustPos = new Float32Array(dustN * 3), c0 = posAt('blocked', 10);
  for (let i = 0; i < dustN; i++) dustDir.push([(rnd() - 0.55) * 2, (rnd() - 0.5) * 1.6, (rnd() - 0.4) * 1.4, 0.4 + rnd() * 0.6]);
  const dust = new THREE.Points(geo(Array.from(dustPos)), new THREE.PointsMaterial({ color: 0x8A8172, size: 14, map: lampTex, transparent: true, depthWrite: false, opacity: 0 }));
  chunks.visible = dust.visible = false;
  scene.add(chunks, dust);
  // 무너진 곳 고리: 막힌 지점 앞뒤 35m(처음 길 끝 · 막힌 터널 처음)
  const hit = [TN.ride1, TN.blocked].map((T) => {
    const idx = [];
    for (let i = 0; i < T.ringN; i++) if (Math.hypot(T.ringPos[i * 3] - blockMark.position.x, T.ringPos[i * 3 + 2] - blockMark.position.z) < 35) idx.push(i);
    return { T, idx, orig: idx.map((i) => { const m4 = new THREE.Matrix4(); T.rings.getMatrixAt(i, m4); return m4; }) };
  });
  let broken = false;
  function breakRings(on) {   // 고리를 기울이고 어둡게(on) · 되돌리기
    if (on === broken) return;
    broken = on;
    hit.forEach(({ T, idx, orig }) => {
      T.dead = on ? new Set(idx) : null;
      idx.forEach((i, j) => {
        mtx.copy(orig[j]);
        if (on) mtx.multiply(new THREE.Matrix4().makeRotationFromEuler(e.set(0.35 * (j % 2 ? 1 : -1), 0.2, 0))).multiply(new THREE.Matrix4().makeScale(1, 0.8, 1));
        T.rings.setMatrixAt(i, mtx); T.rings.setColorAt(i, c.set(on ? 0x2A2522 : T.color).multiplyScalar(on ? 1 : 0.45));
      });
      T.lit.fill(-1); T.rings.instanceMatrix.needsUpdate = true; T.rings.instanceColor.needsUpdate = true;
    });
  }
  return {
    update(tc) {   // tc = 막힘이 시작되고 지난 초(아직이면 음수)
      const on = tc >= 0;
      chunks.visible = on; breakRings(on && tc > 0.3);
      if (!on) { dust.visible = false; return; }
      if (tc < 3.2) {   // 떨어지는 동안만 덩어리 자리를 다시 계산(그 뒤로는 쌓인 채로 멈춤)
        parts.forEach((k, i) => {
          const u = Math.max(0, tc - k.delay), y = Math.max(k.rest, k.top - 0.5 * 120 * u * u);
          const grow = tc < k.delay ? 0 : ss(u / 0.12);
          p.set(k.x, y, k.z); q.setFromEuler(e.set(k.rx + u * 3, k.ry + u * 2, 0)); s3.setScalar(k.size * grow);
          chunks.setMatrixAt(i, mtx.compose(p, q, s3));
        });
        chunks.instanceMatrix.needsUpdate = true;
      }
      dust.visible = tc < 5;
      if (dust.visible) {   // 먼지: 막힌 곳에서 터널을 따라 퍼지고(약 1.5초) 천천히 옅어진다
        const r = ss(tc / 1.5), arr = dust.geometry.attributes.position.array;
        dustDir.forEach((d, i) => {
          const a = d[0] * 34 * r * d[3], w = d[1] * R * 0.85 * Math.min(1, 0.3 + r), h = d[2] * R * 0.75 * Math.min(1, 0.3 + r);
          arr[i * 3] = c0.x + ax.x * a + sd.x * w; arr[i * 3 + 1] = c0.y + h; arr[i * 3 + 2] = c0.z + ax.z * a + sd.z * w;
        });
        dust.geometry.attributes.position.needsUpdate = true;
        dust.material.opacity = 0.75 * ss((tc - 0.15) / 0.4) * (1 - ss((tc - 2.2) / 2.6));
      }
    }
  };
})();

/* ---------- 3. 이름표 ---------- */
const F = D.facts;
const RS = F.restart_m != null ? F.restart_m : F.mapo_m, RSN = F.restart || F.crossA.a;   // 다시 출발할 역(막히기 전 마지막 확인 역) m · 이름
const JN = F.junction && LEG.fork ? F.junction : null;                                    // 갈림길 { m, label, side, toward, name, other }
setTitle(F.start, F.end);
const st = (n, l) => D.stations.find((s) => s.n === n && (!l || s.l === l));
const fm = (x) => x.toFixed(1) + 'm', km = (m) => (m / 1000).toFixed(1) + 'km';
const labelsEl = $('labels'), labels = [];
// 이름표: 3D 위치를 화면 좌표로 바꿔 HTML 글자를 옮긴다(글꼴이 선명하다). vis(시각) 가 거짓이면 숨긴다. maxD: 카메라가 이보다 멀면 숨김
function label(text, v, cls = '', vis = null, pri = 0, maxD = Infinity) {
  const el = document.createElement('div'); el.className = 'lb ' + cls; el.textContent = text; el.style.display = 'none';
  labelsEl.appendChild(el); labels.push({ el, v, vis, pri, maxD, on: false, w: 0, inT: / jn/.test(' ' + cls) });   // jn: 터널 안에서도 보임
}
// 사건 시각(혼자 재생 = 재생 시각, 무대 = 메시지를 받은 실제 시각). 그 전에는 해당 표시를 숨긴다
const EV = { raid: Infinity, block: Infinity, reveal: Infinity, south: Infinity };
const drops = [], seen = new Set();
const lineCount = (n) => new Set(D.stations.filter((s) => s.n === n).map((s) => s.l)).size;
D.stations.forEach((s) => {
  const key = s.n + '|' + s.l;
  if (seen.has(key)) return; seen.add(key);
  const v = posAt(s.leg, s.m);
  drops.push(v.x, 0, v.z, v.x, v.y, v.z);
  const later = s.leg === 'ride2' && !D.stations.some((o) => o.n === s.n && o.leg !== 'ride2');
  const text = s.n + (lineCount(s.n) > 1 ? ' ' + s.l : '') + ' ' + (s.d == null ? '깊이 추정' : fm(s.d));
  label(text, v.clone().add(new THREE.Vector3(0, 2 * R + 6, 0)), s.d == null ? 'est' : '', later ? (c) => c >= EV.reveal : null);
});
// 역의 세로선(지면 → 승강장): 깊이를 읽기 쉽게
scene.add(new THREE.LineSegments(geo(drops), new THREE.LineBasicMaterial({ color: COL.est, transparent: true, opacity: 0.35 })));
// 대합실: 가까이 볼 때만
D.structs.filter((s) => s.k === 'concourse').forEach((s) => {
  const [x, z] = toXZ(s.c[0], s.c[1]);
  label(`${s.n} 대합실 · 높이 개략`, new THREE.Vector3(x, -s.d * EXAG + 12, z), 'est', s.leg === 'ride2' ? (c) => c >= EV.reveal : null, 0, 2600);
});
// 시·군·구 이름: 경로가 지나는 곳만, 지면 위. 다른 이름표보다 뒤(겹치면 숨김)
(D.regions || []).forEach((r) => { const [x, z] = toXZ(r.c[0], r.c[1]); label(r.n, new THREE.Vector3(x, 0, z), 'dim region', null, -1); });
const mid = (a) => (a[0] + a[1]) / 2;
label(`${F.start}역 ${F.exit_ref}번 출구`, posAt('enter', E.expo_m).add(new THREE.Vector3(0, 40, 0)), '');
label('공습경보', LEG.enter.v[0].clone().add(new THREE.Vector3(0, 60, 0)), 'red', (c) => c >= EV.raid && c < EV.raid + 6, 3);
// 깊이 숫자는 역(승강장 자료)에만 쓴다. 역 사이·한강 아래는 추정이라도 숫자를 쓰지 않는다(사용자 결정 2026-11-12)
// '한강' 글자: 막힌 곳에서 가장 가까운 한강 중심선 점
label('한강', (() => { const pb = posAt('ride1', F.block_m); let best = [0, 0], bd = Infinity; D.river.line.forEach((p) => { const [x, z] = toXZ(p[0], p[1]), d = (x - pb.x) ** 2 + (z - pb.z) ** 2; if (d < bd) { bd = d; best = [x, z]; } }); return new THREE.Vector3(best[0], 0, best[1]); })(), 'river', null, 1);
// 갈림길 이름표: 고른 갈래(앱 안내 문장) · 다른 갈래(선로 이름). 터널 안에서 갈림길을 볼 때만
let jnOn = false;
if (JN) {
  label(JN.label, posAt('ride1', JN.m + 110).add(new THREE.Vector3(0, R * 0.9, 0)), 'jn', () => jnOn, 4);
  label(JN.other.name || '다른 선로', posAt('fork', Math.min(110, LEG.fork.len)).add(new THREE.Vector3(0, R * 0.9, 0)), 'est jn', () => jnOn, 4);
}
label('막힘', blockMark.position.clone().add(new THREE.Vector3(0, 50, 0)), 'red', (c) => c >= EV.block, 2);
label(`처음 길 ${km(F.first_m)}`, posAt('rest', LEG.rest.len * 0.5).add(new THREE.Vector3(0, 30, 0)), 'dim', null, 1);
const SF = F.south;
label(`남쪽으로도 지하: ${F.end} → ${SF.to} ${km(SF.total_m)}`, posAt('south', LEG.south.len * 0.55).add(new THREE.Vector3(0, 30, 0)), '', (c) => c >= EV.south + SOUTH.GROW, 3);   // 화살표가 동탄에 닿은 뒤

/* ---------- 4. 혼자 재생: 장면(자막 한 줄)과 움직임 ----------
   움직임 = [구간, 시작 m, 끝 m, 초, 카메라 거리('all' 전체 보기 · 'south' 동탄까지), 볼 곳(구간 m, 없으면 사람), 터널 안(이 움직임 안의 [시작 초, 끝 초])].
   긴 직선 구간은 짧은 시간에 빨리 감는다. 하저터널은 터널 가운데를 고정해 보고 점만 지나가게 한다(시연과 같은 모습). */
const g1 = st(F.start, F.start_line) || st(F.start);   // 출발역 승강장(첫 노선)
const endM = LEG.ride2.len, A = F.crossA.m, B = F.crossB.m;
const XF = F.rides.find((r) => r.t === 'transfer');   // 다시 찾은 길의 첫 환승역: 잠깐 멈춰 역 구조를 보여 준다
const J = JN ? JN.m : 0, JE = JN ? JN.m + 200 : 0;    // 갈림길 · 갈림길 장면이 끝나는 곳(고른 갈래로 200m)
// 막힘 시각(초): 막힘 장면 처음에 1초 동안 터널 안으로 → c 초에 무너짐(0.6초 전부터 흔들림) → c + out 에 1초 동안 밖으로 → c + back 에 되돌아가기
const BL = { c: 1.4, out: 3.0, back: 4.8, dur: 3 };
// 무대: 막힘 장면(앱 약 4.8초) 처음에 안으로 → 1.0초에 무너짐 → 2.6초 뒤 밖으로 → 3.4초 뒤 2.4초 동안 되돌아가기(다음 장면 앞 2초까지 이어짐)
const BLS = { c: 1.0, out: 2.6, back: 3.4, dur: 2.4 };
const BEATS = [
  { id: 'raid', cap: `공습경보 · ${F.story_label}`, sub: `가장 가까운 지하로: ${F.start}역 ${F.exit_ref}번 출구, 지상 ${F.expo_m}m`,
    moves: [['enter', 0, 0, RM ? 4 : 3, 1800]] },
  { id: 'enter', cap: `${F.start}역 ${F.exit_ref}번 출구로 들어가 ${g1.l} 승강장으로`, sub: `지상 ${F.expo_m}m를 걸은 뒤 지하 ${g1.f} 승강장(깊이 ${fm(g1.d)})`,
    moves: [['enter', 0, E.expo_m, RM ? 4 : 3, 650], ['enter', E.expo_m, LEG.enter.len, 3.5, 750], ['enter', LEG.enter.len, LEG.enter.len, 0.6, 800]] },
  // 갈림길: 다가가며 터널 안으로 → 갈림길 25m 앞에서 1.4초 멈춤 → 고른 갈래로 들어가며 밖으로
  ...(JN ? [{ id: 'junction', cap: JN.label, sub: `${JN.name ? JN.name + ' ' : ''}${JN.toward ? JN.toward + ' 방면' : ''} · 다른 갈래는 ${JN.other.name || '다른 선로'}`,
    moves: [['ride1', 0, Math.max(0, J - 120), 2.5, 900], ['ride1', Math.max(0, J - 120), J - 25, 1.6, 650, J, [0, 99, 'junction']],
      ['ride1', J - 25, J - 25, 1.4, 650, J, [-1, 99, 'junction']], ['ride1', J - 25, JE, 2.2, 650, J + 100, [-1, 1.4, 'junction']]] }] : []),
  { id: 'crossA', cap: `한강 아래 ${F.crossA.line} ${F.crossA.a}–${F.crossA.b} 하저터널`, sub: `${F.end}역까지 지하로 ${km(F.first_m)}, 지상 ${F.first_expo_m}m인 길`,
    moves: [['ride1', JE, RS, RS - JE > 3000 ? 5 : 3, RS - JE > 3000 ? 3200 : 900], ['ride1', RS, F.block_m, 6, 2000, (A[0] + F.block_m) / 2 + 150]] },
  { id: 'block', cap: `앞이 막힘 · ${RSN}역으로 ${F.backtrack_m}m 되돌아감`, sub: `막힌 하저터널을 빼고 ${RSN}역에서 다시 찾기`,
    moves: [['ride1', F.block_m, F.block_m, BL.c + BL.back, 420, F.block_m, [0, BL.c + BL.out + 1, 'collapse']], ['ride1', F.block_m, RS, 3.5, 1200], ['ride1', RS, RS, 1.5, 1800]] },
  { id: 'reroute', cap: `다시 찾은 길 ${km(F.total2_m)}, 지상 ${F.second_expo_m}m`, sub: `${F.crossA.a}에서 남은 ${km(F.left_m)}보다 ${km(F.total2_m - F.left_m)} 더 · 한강은 ${F.crossB.a}–${F.crossB.b} 하저터널로`,
    moves: [['ride2', 0, XF.m0 - 150, 2.5, 1600], ['ride2', XF.m0 - 150, XF.m1 + 150, 3.5, 750, (XF.m0 + XF.m1) / 2], ['ride2', XF.m1 + 150, B[0] - 300, 8, 3200]] },
  { id: 'crossB', cap: `한강 아래 다른 하저터널: ${F.crossB.a} → ${F.crossB.b}`, sub: '서울에서 한강을 지하로만 건너는 길은 5호선 하저터널 두 곳뿐',
    moves: [['ride2', B[0] - 300, B[1] + 200, 8, 2200, mid(B), [2.4, 5.0]]] },
  { id: 'arrive', cap: `${F.end}역 도착`, sub: `지하에 들어간 뒤 지상 노출 ${F.exposed_after_m}m · 지상은 처음 출구까지 ${F.expo_m}m`,
    moves: [['ride2', B[1] + 200, endM, 6, 1400], ['ride2', endM, endM, 2.5, 'all'], ['ride2', endM, endM, 5, 'south']] }
];
// 평평한 움직임 목록 + 시각. 조각 경계 속도 = 앞뒤 평균 속도 중 작은 쪽(방향이 다르거나 구간이 바뀌면 0)
const MOVES = [];
let TOTAL = 0;
BEATS.forEach((b, bi) => b.moves.forEach(([leg, m0, m1, sec, dist, look, inside]) => { MOVES.push({ leg, m0, m1, sec, dist, look, inside: RM ? null : inside, bi, id: b.id, t0: TOTAL }); TOTAL += sec; }));
MOVES.forEach((mv, i) => {
  const v = (x) => (x ? (x.m1 - x.m0) / x.sec : 0), a = MOVES[i - 1], b = MOVES[i + 1], me = v(mv);
  const edge = (o) => (o && o.leg === mv.leg && v(o) * me > 0 ? Math.sign(me) * Math.min(Math.abs(v(o)), Math.abs(me)) : 0);
  mv.v0 = edge(a); mv.v1 = edge(b);
});
const beatT = (id) => MOVES.find((m) => m.id === id).t0;
const SOLO_EV = { raid: 0, block: beatT('block') + BL.c, reveal: MOVES.filter((m) => m.id === 'block')[2].t0, south: MOVES.find((m) => m.dist === 'south').t0 };
if (!FOLLOW) Object.assign(EV, SOLO_EV);

// 시각 t 의 위치: 3차 에르미트(양 끝 속도 v0, v1)로 m 을 정한다 → 조각이 바뀌어도 속도가 끊기지 않는다
function moveAt(t) {
  let mv = MOVES[MOVES.length - 1];
  for (const x of MOVES) if (t < x.t0 + x.sec) { mv = x; break; }
  const s = Math.max(0, Math.min(1, (t - mv.t0) / mv.sec)), s2 = s * s, s3 = s2 * s;
  const m = (s3 - 2 * s2 + s) * mv.sec * mv.v0 + (-2 * s3 + 3 * s2) * (mv.m1 - mv.m0) + (s3 - s2) * mv.sec * mv.v1 + mv.m0;
  return { mv, m };
}
// 터널 안 비율(0~1): [시작, 끝] 사이에서 1초에 걸쳐 들어가고 1초에 걸쳐 나온다
const insideAt = (mv, t) => (mv.inside ? ss((t - mv.t0 - mv.inside[0]) / 1) * ss((mv.t0 + mv.inside[1] - t) / 1) : 0);

/* ---------- 5. 무대(?follow): 앱 시연 메시지로 움직인다 ----------
   - 걷는 점: 받은 m 에서 v × 지난 시간만큼 앞으로 예측하되 이번 걷기가 멈출 곳(to)을 넘지 않는다.
     메시지가 올 때 생기는 어긋남(보이던 m - 새 m)은 따로 두고 0.1초 남짓에 걸쳐 줄인다: 빨리 감기에서도 늦지 않고 뚝 끊기지 않는다.
     속도는 앱이 알린 값과 실제로 늘어난 m(직전 메시지와 비교) 중 작은 쪽을 쓰고, 0.4초 넘게 메시지가 없으면 더 예측하지 않는다
     (앱 화면이 바빠 느려져도 3D 점이 앞서 나가지 않게).
   - 앱 구간 → 3D 구간: entry → enter, first → ride1, reroute → ride2. 거리(m)는 build_3d.js 가 앱 길 안내와 같은 거리로 만들어 그대로 쓴다.
   - backtrack(되돌아가기)은 앱이 걷지 않으므로 3D 가 무너짐(약 2초)을 보여 준 뒤 3초 동안 막힌 곳 → 다시 출발할 역으로 되돌아간다.
   - 장면 이름(id)마다 카메라가 볼 곳(SHOTS)을 정한다. 하저터널 두 곳은 걷는 동안 터널 안에 들어갔다 나온다. */
const LEG_OF = { entry: 'enter', first: 'ride1', reroute: 'ride2' };
const SHOTS = {
  save: { look: ['enter', 0], dist: 1600 }, raid: { look: ['enter', 0], dist: 1800 }, nearest: { look: ['enter', E.expo_m], dist: 900 },
  enter: { dist: 650 }, platform: { dist: 800 }, plan: { box: 'first' }, guide: { dist: 900 }, junction: { look: ['ride1', J], dist: 650 },
  crossA: { look: ['ride1', (A[0] + F.block_m) / 2 + 150], dist: 2000 },
  block: { look: ['ride1', F.block_m], dist: 420 }, reroute: { look: ['ride2', (XF.m0 + XF.m1) / 2], dist: 750 }, ff: { dist: 3200 },
  crossB: { look: ['ride2', mid(B)], dist: 2200, inside: ['ride2', mid(B) - 500, mid(B) + 500] }, arriveFf: { dist: 2600 }, arrive: { box: 'all' }, south: { box: 'south' }
};
const W = { leg: 'enter', m: 0, shown: 0, corr: 0, v: 0, vEff: 0, to: 0, at: 0, back: null, scene: 'save', sceneN: 0, bs: null };   // bs: 막힘 장면이 온 시각(터널 안으로)
const syncLog = [];
let realT = 0;                                   // 그림 시계(느린 프레임에서는 0.05초씩만 감): 흔들기·고리 등에
const wall = () => performance.now() / 1000;     // 실제 시계: 무대에서 메시지·사건 시각·되돌아가기에
function onDemo(d) {
  if (d.type === 'scene') {
    W.scene = d.id || ''; W.sceneN = d.n;
    if (d.scenario !== 1) { W.scene = 'arrive'; return; }   // 다른 시나리오(부산 등)는 3D 가 없다: 전체 보기만
    if (d.n <= 2 && !d.again) { Object.assign(EV, { raid: Infinity, block: Infinity, reveal: Infinity, south: Infinity }); Object.assign(W, { leg: 'enter', m: 0, shown: 0, v: 0, back: null, bs: null }); }
    if (d.id === 'block' && W.bs == null) W.bs = wall();
    if (d.id === 'raid' && EV.raid === Infinity) EV.raid = wall();
    if (d.id === 'south' && EV.south === Infinity) EV.south = wall() + (RM ? 0 : 1.0);   // 앱 화살표와 같이(지도가 움직인 뒤)
  } else if (d.type === 'leg') {
    if (d.leg === 'backtrack') {
      if (W.bs == null) W.bs = wall();
      if (EV.block === Infinity) EV.block = Math.max(wall() + 0.1, W.bs + BLS.c);   // 터널 안에 들어간 뒤 무너진다
      if (!W.back && !d.again) W.back = { t0: EV.block + (RM ? 2.0 : BLS.back), dur: BLS.dur };   // 무너짐을 안에서 보고 나온 뒤 되돌아간다
    } else if (LEG_OF[d.leg] && LEG_OF[d.leg] !== W.leg) {
      W.leg = LEG_OF[d.leg]; W.m = W.shown = 0; W.v = 0;
      if (d.leg === 'reroute' && EV.reveal === Infinity) { if (EV.block === Infinity) EV.block = wall(); EV.reveal = Math.max(wall(), W.back ? W.back.t0 + W.back.dur : 0); }   // 다시 찾은 길은 되돌아간 뒤 나타난다
    }
  } else if (d.type === 'pos') {
    const leg = LEG_OF[d.leg];
    if (!leg) return;
    if (d.v > 0) W.back = null;                                        // 앱이 다시 걷기 시작하면 되돌아가기 그림은 끝
    // 맞춰 보기용: 받기 직전에 보이던 자리
    const before = person.position.clone();
    if (leg !== W.leg) { W.leg = leg; W.shown = d.m; }
    const now = performance.now() / 1000, gap = now - W.at;            // 예측은 실제 시계로(그림 시계는 느린 프레임에서 0.05초씩만 감)
    W.vEff = leg === W.leg && d.v > 0 && W.v > 0 && gap > 0.05 ? Math.min(d.v, Math.max(0, (d.m - W.m) / gap) * 1.1) : d.v;
    W.corr = Math.abs(W.shown - d.m) > 1500 ? 0 : W.shown - d.m;      // 어긋남은 천천히 줄인다(멀면 바로 맞춤)
    Object.assign(W, { m: d.m, v: d.v, to: d.to, at: now });
    // 맞춰 보기: 앱 추정 위치(위도·경도)와 3D 의 같은 m 자리 · 지금 보이는 점 자리의 수평 거리(m)
    if (d.lat != null) {
      const [x, z] = toXZ(d.lat, d.lon), p = posAt(leg, d.m);
      syncLog.push({ sc: W.scene, leg: d.leg, m: Math.round(d.m), v: Math.round(d.v), align: Math.round(Math.hypot(p.x - x, p.z - z)), shown: Math.round(Math.hypot(before.x - x, before.z - z)) });
      if (syncLog.length > 5000) syncLog.shift();
    }
  } else if (d.type === 'state' && !d.playing) W.v = 0;
}
if (FOLLOW) {
  addEventListener('message', (ev) => { const d = ev.data; if (ev.source === parent && d && d.src === 'jiharo-demo') onDemo(d); });
  // 무대 안에서도 Space·→ 를 누르면 앱 시연으로 넘긴다(무대가 받아서 전달)
  addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'ArrowRight') { e.preventDefault(); parent.postMessage({ src: 'jiharo-3d', type: 'key', key: e.key }, location.origin); } });
}
// 이번 프레임 걷는 점(무대): 되돌아가기 중이면 막힌 곳 → 다시 출발할 역, 아니면 예측 m
function followWalker(dt) {
  if (W.back) {
    const k = ss((wall() - W.back.t0) / W.back.dur);
    if (k < 1) return { leg: 'ride1', m: F.block_m + (RS - F.block_m) * k, dir: -1 };
    W.back = null;
  }
  const pred = W.v > 0 ? Math.min(Math.max(W.to, W.m), W.m + W.vEff * Math.min(performance.now() / 1000 - W.at, 0.4)) : W.m;
  W.corr *= Math.exp(-dt * 10);
  W.shown = pred + W.corr;
  return { leg: W.leg, m: W.shown, dir: 1 };
}

/* ---------- 6. 자막 · 조작(혼자 재생) ---------- */
let t = 0, playing = !FOLLOW, touched = false, snap = true, lastBeat = -1, lastWhere = '';
const ICON = { play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg>', pause: '<svg viewBox="0 0 24 24"><path d="M7 4.5h3.5v15H7zM13.5 4.5H17v15h-3.5z" fill="currentColor"/></svg>' };
function setPlaying(p) { playing = p; $('play').innerHTML = p ? ICON.pause : ICON.play; $('play').setAttribute('aria-label', p ? '멈춤' : '재생'); }
function seek(x) { t = Math.max(0, Math.min(TOTAL, x)); snap = true; }
$('play').onclick = () => { if (!playing && t >= TOTAL) seek(0); setPlaying(!playing); };
$('restart').onclick = () => { seek(0); touched = false; resetCamera(); setPlaying(true); };
const bar = $('bar');
bar.onpointerdown = (e) => { const r = bar.getBoundingClientRect(); seek((e.clientX - r.left) / r.width * TOTAL); };
bar.onkeydown = (e) => { if (e.key === 'ArrowRight') seek(t + 5); if (e.key === 'ArrowLeft') seek(t - 5); };
if (!FOLLOW) addEventListener('keydown', (e) => { if (e.key === ' ' && e.target === document.body) { e.preventDefault(); $('play').click(); } });
controls.addEventListener('start', () => { touched = true; });
setPlaying(!FOLLOW);

// 지금 어디인지 한 줄(타는 노선 · 환승 · 되돌아가는 거리 등)
function whereText(mv, m) {
  if (mv.id === 'raid') return `${F.story_label} · 거리`;
  if (mv.leg === 'enter') return m < E.expo_m ? `지상 걷기 ${Math.round(m)}m / ${F.expo_m}m` : '출구 → 대합실 → 지하 승강장';
  if (mv.id === 'block' && mv.m0 === F.block_m && mv.m1 === mv.m0) return `${RSN}역에서 하저터널로 ${F.walked_m}m 들어간 곳`;
  if (mv.id === 'junction') return `${JN.label} · ${km(m)} / ${km(F.first_m)}`;
  if (mv.leg === 'ride1') {
    if (mv.m1 < mv.m0) return `되돌아가는 중 · ${RSN}역까지 ${Math.round(m - RS)}m`;
    if (!F.rides1) return `${F.crossA.line} · ${F.start} → ${F.crossA.a} → ${F.crossA.b} 방면`;   // 옛 자료
    return `${rideHead(F.rides1, m)} · ${km(m)} / ${km(F.first_m)}`;
  }
  return `${rideHead(F.rides, m)} · ${km(m)} / ${km(endM)}`;
}
// 탄 노선 목록(R)에서 m 자리: 'N호선 · A → B' 또는 'A 환승 · N호선 → M호선'
function rideHead(R, m) {
  let i = R.findIndex((x) => m < x.m1);
  if (i < 0) i = R.length - 1;
  const r = R[i];
  return r.t === 'transfer' && R[i - 1] && R[i + 1] ? `${R[i - 1].b} 환승 · ${R[i - 1].label} → ${R[i + 1].label}` : `${r.label} · ${r.a} → ${r.b}`;
}
const fmt = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

/* ---------- 7. 카메라 ----------
   바깥(단면) 카메라: 볼 곳 = 사람(또는 정한 곳)보다 조금 위(깊이의 3/4). 진행 방향의 옆(지금 카메라와 가까운 쪽) 위에서 비스듬히 본다.
   옆에서 보면 터널이 오르내리는 모양(단면)이 잘 보인다. 카메라는 늘 지면(MIN_Y) 위에 둔다.
   터널 안 카메라: 점 뒤 80m, 터널 가운데 높이에서 점 앞 200m 를 본다. 두 카메라를 '터널 안 비율'로 섞는다.
   shot = { leg, m(볼 곳), dist } 또는 { box: 'first'|'all'|'south' }(전체 보기) */
const tmp = new THREE.Vector3(), off = new THREE.Vector3(), want = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
const rigPos = new THREE.Vector3(), rigTarget = new THREE.Vector3(), inPos = new THREE.Vector3(), inLook = new THREE.Vector3(), tmp2 = new THREE.Vector3(), jA = new THREE.Vector3(), jB = new THREE.Vector3();
const sph = new THREE.Spherical(), PHI = 0.78, PHI_ALL = 0.7, MIN_Y = 80;
// 전체 보기 상자: 처음 길(first) · 처음 길과 다시 찾은 길(all) · 동탄까지(south)
const BOX = { first: new THREE.Box3().setFromPoints([...LEG.enter.v, ...LEG.ride1.v, ...LEG.blocked.v, ...LEG.rest.v]) };
BOX.all = BOX.first.clone().union(new THREE.Box3().setFromPoints(LEG.ride2.v));
BOX.south = BOX.all.clone().expandByPoint(LEG.south.v[LEG.south.v.length - 1]);
const center = (bx) => bx.getCenter(new THREE.Vector3()).setY(-150);
const overview = (bx) => { const s = bx.getSize(tmp); const h = 2 * Math.tan(camera.fov * Math.PI / 360); return Math.max(s.x / (h * camera.aspect), s.z / h) * 1.3 + 2000; };
const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));   // 각도 차이를 -π~π 로
function resetCamera() {
  posAt('enter', 0, controls.target); controls.target.y *= 0.75;
  camera.position.copy(controls.target).add(off.setFromSphericalCoords(RM ? 1800 : 1500, PHI, 0.35));
  rigPos.copy(camera.position); rigTarget.copy(controls.target);
}
let sway = 0;
function follow(dt, shot, clockT) {
  const bx = shot.box === 'south' ? SOUTH.box(clockT) : shot.box && BOX[shot.box], k = (r) => (snap && clockT > 0 ? 1 : 1 - Math.exp(-dt * r));
  if (bx) want.copy(center(bx)); else { posAt(shot.leg, shot.m, want); want.y *= 0.75; }
  tmp.copy(controls.target);
  controls.target.lerp(want, snap ? 1 : 1 - Math.exp(-dt * (bx ? 1.2 : RM ? 2 : 3)));   // 높이도 같이 천천히(흔들림 없이)
  camera.position.add(tmp.subVectors(controls.target, tmp));          // 보는 점이 움직인 만큼 카메라도
  if (touched) return;                                                 // 사용자가 돌렸으면 각도·거리는 그대로
  sph.setFromVector3(off.subVectors(camera.position, controls.target));
  const fit = Math.max(1, 1.4 / camera.aspect);                        // 세로로 긴 화면(폰)은 좌우가 좁아서 더 멀리
  const goal = bx ? overview(bx) : shot.dist * fit;
  sph.radius += (goal - sph.radius) * k(RM ? 0.6 : goal < sph.radius * 0.6 ? 2 : 1.1);   // 처음에는 멀리서 천천히 다가간다(크게 다가갈 때는 조금 빨리)
  sph.phi += ((bx ? PHI_ALL : PHI) - sph.phi) * k(1.5);
  if (bx) sph.theta += wrap(0 - sph.theta) * k(0.8);                   // 전체 보기는 남쪽에서(북쪽이 위)
  else {   // 진행 방향(앞뒤 200m)의 옆
    posAt(shot.leg, shot.m + 200, a); posAt(shot.leg, shot.m - 200, b);
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
// 터널 안 카메라 자리: 진행 방향 뒤 80m · 앞 200m. 무너짐은 막힌 곳 32m 뒤에서 막힌 곳 앞 16m 를 본다
function insidePose(leg, m, dir, kind) {
  if (kind === 'junction') {   // 갈림길: 점 35m 뒤(갈림길 35m 앞에서 멈춤)에서 두 갈래 110m 앞 가운데를 본다
    posAt('ride1', Math.min(m - 35, J - 35), inPos).y += 3;
    inLook.copy(posAt('ride1', J + 110, jA)).add(posAt('fork', Math.min(110, LEG.fork.len), jB)).multiplyScalar(0.5);
    return;
  }
  if (kind === 'collapse') { posAt('ride1', F.block_m - 32, inPos).y += 3; posAt('blocked', 16, inLook); return; }
  posAt(leg, m - dir * 80, inPos).y += 2;
  posAt(leg, m + dir * 200, inLook);
}

/* ---------- 8. 그리기 ---------- */
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h;
  // 좁은 화면(혼자 재생): 아래 자막 칸에 가리지 않게 그림 가운데를 자막 칸 높이의 절반만큼 위로 올린다
  if (w < 900 && !FOLLOW) camera.setViewOffset(w, h, 0, document.querySelector('.panel').offsetHeight * 0.5, w, h); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize(); resetCamera();

const clock = new THREE.Clock();
let frames = 0, fpsT = 0, slow = 0, inside = 0, insF = 0, lastKind = '';   // insF·lastKind: 무대의 터널 안 비율(시간으로 부드럽게)과 그 종류
const ui = { cap: $('cap'), sub: $('sub'), where: $('where'), prog: $('prog'), time: $('time'), depth: $('depth') };
function frame() {
  const dt = Math.min(0.05, clock.getDelta());
  realT += dt;
  if (playing && !FOLLOW) { t += dt; if (t >= TOTAL) { t = TOTAL; setPlaying(false); } }
  const clockT = FOLLOW ? wall() : t;                                 // 사건 시각을 재는 시계(무대 = 실제 시계)

  // 이번 프레임: 걷는 점(구간·m·방향), 카메라가 볼 것(shot), 터널 안 비율
  let leg, m, dir, shot, ins = 0, mv = null, kind = '';
  if (FOLLOW) {
    ({ leg, m, dir } = followWalker(dt));
    const s = SHOTS[W.scene] || { dist: 1500 }, now = wall();
    shot = s.box ? { box: s.box } : { leg: s.look ? s.look[0] : leg, m: s.look ? s.look[1] : m, dist: s.dist };
    if (s.inside && s.inside[0] === leg && !RM) ins = ss((m - s.inside[1]) / 200) * ss((s.inside[2] - m) / 250);
    if (JN && leg === 'ride1' && !W.back && !RM) { const ij = ss((m - (J - 260)) / 120) * ss((J + 160 - m) / 120); if (ij > ins) { ins = ij; kind = 'junction'; } }   // 갈림길(장면 이름과 상관없이 m 으로)
    if (W.bs != null && EV.block === Infinity && W.scene !== 'block') W.bs = null;   // 막힘 없이 장면이 넘어감(건너뛰기)
    // 막힘: 무너짐을 터널 안에서 보고 나올 때까지는 막힌 곳, 되돌아가는 동안은 걷는 점(다음 장면이 와도 끝까지)
    if (W.scene === 'crossA' && leg === 'ride1' && m < RS - 300) shot = { leg, m, dist: 3200 };   // 갈림길 → 다시 출발할 역까지 빨리 감기
    if (W.bs != null && now < EV.block + BLS.out + 1.6) { shot = { leg: 'ride1', m: F.block_m, dist: 420 }; ins = RM ? 0 : ss((now - W.bs) / 0.8) * ss((EV.block + BLS.out + 1 - now) / 1); kind = 'collapse'; }
    else if (W.back && now < W.back.t0 + W.back.dur) shot = { leg: 'ride1', m, dist: 1200 };
    insF = snap ? ins : insF + (ins - insF) * (1 - Math.exp(-dt * 4));   // 시간으로 부드럽게(약 0.6초)
    if (kind) lastKind = kind; else if (insF > 0.002) kind = lastKind;   // 나오는 동안은 들어갈 때의 자리로
    ins = insF < 0.002 ? 0 : insF > 0.998 ? 1 : insF;
  } else {
    ({ mv, m } = moveAt(t));
    leg = mv.leg; dir = mv.m1 >= mv.m0 ? 1 : -1;
    shot = mv.dist === 'all' || mv.dist === 'south' ? { box: mv.dist } : { leg, m: mv.look != null ? mv.look : m, dist: mv.dist };
    ins = insideAt(mv, t);
    if (mv.inside) kind = mv.inside[2] || '';
  }
  posAt(leg, m, person.position);
  const onStreet = leg === 'enter' && m < E.expo_m;
  halo.material.color.set(onStreet ? COL.expo : COL.safe);

  // 공습경보 · 막힘 · 다시 찾은 길 나타남 · 처음 길 나머지 · 남쪽(동탄)
  raid.update(clockT - EV.raid);
  const blocked = clockT >= EV.block;
  collapse.update(clockT - EV.block);                                          // 무너짐 → 잔해 더미
  blockMark.visible = clockT - EV.block > 1.8;                                 // 빨간 X 는 무너진 뒤(멀리서도 보이게)
  blockMark.scale.setScalar(70);
  TN.blocked.set(blocked ? COL.expo : COL.safe, blocked ? 0.8 : 1);
  const rev = ss((clockT - EV.reveal) / 1.2);
  TN.ride2.set(COL.safe, rev);
  structLater.visible = rev > 0.5;
  restLine.material.color.set(blocked ? COL.est : COL.safe);                     // 처음 길의 나머지: 막힌 뒤에는 회색
  SOUTH.update(clockT);                                                          // 수서 → 동탄 화살표
  lightRings(person.position);

  // 카메라: 바깥 카메라(rig)를 움직이고, 터널 안 비율만큼 안 카메라와 섞는다
  camera.position.copy(rigPos); controls.target.copy(rigTarget);
  follow(dt, shot, clockT);
  snap = false;
  controls.update();
  rigPos.copy(camera.position); rigTarget.copy(controls.target);
  inside = touched ? 0 : ins;
  const cd = camera.position.distanceTo(controls.target);
  if (inside > 0) {
    insidePose(leg, m, dir, kind);
    camera.position.lerp(inPos, inside);
    if (kind === 'collapse' && !RM) {   // 무너지기 0.6초 전부터 흔들림(시각으로 정해서 되감아도 같은 그림)
      const tc = clockT - EV.block, a = 1.3 * inside * ss((tc + 0.6) / 0.25) * (1 - ss((tc - 0.5) / 0.7));
      if (a > 0) camera.position.add(tmp2.set(Math.sin(clockT * 41) * a * 0.6, Math.sin(clockT * 57 + 1) * a, Math.sin(clockT * 33 + 2) * a * 0.6));
    }
    camera.lookAt(tmp.copy(rigTarget).lerp(inLook, inside));
  }
  // 터널 안: 공은 숨기고 작은 등 하나만, 껍데기는 옅게, 단면(세로 판)은 숨긴다(안에서는 선 하나로 보여서)
  dot.visible = inside < 0.6;
  halo.scale.setScalar(70 - (kind === 'collapse' || kind === 'junction' ? 62 : 40) * inside);   // 무너짐·갈림길을 볼 때는 점 빛을 작게(가리지 않게)
  jnOn = !!JN && (kind === 'junction' ? inside > 0.5 : RM && leg === 'ride1' && Math.abs(m - J) < 250);   // 갈림길 이름표
  for (const T of tunnels) { T.shell.material.opacity = 0.13 * T.a * (1 - 0.5 * inside); if (T.slice) T.slice.material.opacity = T.a * (1 - inside); }
  const near = inside > 0.5 ? 1 : 10;
  if (camera.near !== near) { camera.near = near; camera.updateProjectionMatrix(); }
  scene.fog.near = THREE.MathUtils.lerp(cd * 1.6, 40, inside); scene.fog.far = THREE.MathUtils.lerp(cd * 6, 900, inside);
  renderer.render(scene, camera);
  placeLabels(cd, clockT);

  if (FOLLOW) showDepth(leg, m, onStreet);
  else {
    // 글: 장면이 바뀔 때만 바꾼다
    if (mv.bi !== lastBeat) { lastBeat = mv.bi; ui.cap.textContent = BEATS[mv.bi].cap; ui.sub.textContent = BEATS[mv.bi].sub; }
    const fast = Math.abs(mv.m1 - mv.m0) / mv.sec > 500;
    const w = whereText(mv, m) + (fast ? '|ff' : '');
    if (w !== lastWhere) { lastWhere = w; ui.where.innerHTML = (fast ? '<span class="ff">빨리 감기</span>' : '') + '<span></span>'; ui.where.lastChild.textContent = w.replace('|ff', ''); }
    ui.prog.style.width = (t / TOTAL * 100).toFixed(2) + '%';
    bar.setAttribute('aria-valuenow', Math.round(t / TOTAL * 100));
    ui.time.textContent = fmt(t) + ' / ' + fmt(TOTAL);
  }

  // 1초 평균 fps. 25 아래가 3초 이어지면 가볍게(화소 비율 1, 벽 등 끔)
  frames++; fpsT += dt;
  if (fpsT >= 1) {
    const fps = frames / fpsT;
    window.__ride.fps = Math.round(fps);
    slow = fps < 25 ? slow + 1 : 0;
    if (slow >= 3 && !LQ) setLQ();
    frames = 0; fpsT = 0;
  }
}
function setLQ() {
  LQ = true; window.__ride.lq = true;
  renderer.setPixelRatio(1); resize();
  for (const T of tunnels) T.lamps.visible = false;
}

// 깊이 읽기(무대): 걷는 점 옆에 작게. 승강장(자료가 있는 역 앞뒤 80m)에서만 실제 값. 역 사이는 아무것도 쓰지 않는다(추정 숫자 안 씀)
let lastDepth = '';
function showDepth(leg, m, onStreet) {
  let text = '';
  if (inside < 0.3) {
    const sta = D.stations.find((s) => s.leg === leg && s.d != null && Math.abs(s.m - m) < 80);
    text = onStreet ? '지상' : sta ? `${sta.n} 승강장 ${fm(sta.d)}` : '';
  }
  if (text !== lastDepth) { lastDepth = text; ui.depth.textContent = text; ui.depth.hidden = !text; }
  if (!text) return;
  tmp.copy(person.position).project(camera);
  ui.depth.style.transform = `translate(${((tmp.x + 1) / 2 * innerWidth + 16).toFixed(1)}px, ${((1 - tmp.y) / 2 * innerHeight - 10).toFixed(1)}px)`;
}

// 이름표 놓기: 카메라 앞·가까운 것만, 겹치면 우선순위(pri)·가까운 순으로 하나만. 화면 가장자리에서는 안쪽으로 밀어 넣는다
const placed = [];
function placeLabels(cd, clockT) {
  const W2 = innerWidth, H = innerHeight, cand = [];
  for (const L of labels) {
    let ok = (inside < 0.3 || L.inT) && (!L.vis || L.vis(clockT));   // 터널 안에서는 숨긴다(갈림길 이름표만 보임)
    if (ok) {
      tmp.copy(L.v).project(camera);
      const far = camera.position.distanceTo(L.v);
      ok = tmp.z < 1 && Math.abs(tmp.x) < 1.02 && Math.abs(tmp.y) < 1.02 && far < Math.min(cd * 2.8, L.maxD);
      if (ok) cand.push({ L, x: (tmp.x + 1) / 2 * W2, y: (1 - tmp.y) / 2 * H, far });
    }
    if (!ok && L.on) { L.el.style.display = 'none'; L.on = false; }
  }
  cand.sort((a, b) => b.L.pri - a.L.pri || a.far - b.far);
  placed.length = 0;
  for (const c of cand) {
    const L = c.L;
    if (!L.on) { L.el.style.display = ''; L.on = true; }
    if (!L.w) L.w = L.el.offsetWidth || 60;
    const x0 = Math.max(6, Math.min(W2 - L.w - 6, c.x - L.w / 2));
    const r = [x0, c.y - 22, x0 + L.w, c.y];
    if (placed.some((p) => r[0] < p[2] && r[2] > p[0] && r[1] < p[3] && r[3] > p[1])) { L.el.style.display = 'none'; L.on = false; continue; }
    placed.push(r);
    L.el.style.transform = `translate(${r[0].toFixed(1)}px, ${r[1].toFixed(1)}px)`;
  }
}

window.__ride = { seek: (x) => { seek(x); setPlaying(false); }, play: () => setPlaying(true), total: TOTAL, fps: 0, lq: LQ, follow: FOLLOW,
  beats: BEATS.map((b) => ({ id: b.id, cap: b.cap, sub: b.sub, t: beatT(b.id) })), sync: syncLog, walker: () => ({ scene: W.scene, leg: W.leg, m: Math.round(W.shown), rx: Math.round(W.m), v: Math.round(W.v), ve: Math.round(W.vEff), to: Math.round(W.to), corr: Math.round(W.corr), back: !!W.back }),
  shown: () => labels.filter((l) => l.on).map((l) => l.el.textContent) };
renderer.setAnimationLoop(frame);
if (FOLLOW) parent.postMessage({ src: 'jiharo-3d', type: 'hello' }, location.origin);   // 무대에 '지금 상태를 다시 보내 달라'
