/* ride.js — 지하로 3D: 시연 1번 이야기(공덕 → 수서)를 지하 단면 그림으로 따라간다
   자료: ride.json (scripts/build_3d.js 가 앱의 길 찾기 코드로 계산해 만든다.
         점 = [위도, 경도, 구간 m, 그릴 깊이 m, 한강 아래 정도, 한강 단면 정도]. 그릴 깊이는 이미 부드럽게 이어 둔 값이다)
   좌표 바꾸기
     - 위도·경도 → 지역 m: 기준점(LAT0, LON0)에서 동쪽 x = (경도 - LON0) × 111320 × cos(LAT0),
       북쪽 = (위도 - LAT0) × 110540. three.js 는 y 가 위쪽이라 북쪽을 -z 로 둔다.
       수십 km 범위라 평면으로 펴도 오차가 1% 미만이다.
     - 깊이: y = -(깊이 m × EXAG). 지면은 y = 0. 세로만 EXAG(자료의 exag, 10)배 늘려서 깊이 차이가 보이게 한다.
     - 한강 아래: 강바닥 깊이 자료가 없어서 '한강 아래 정도(0~1) × DIP' 만큼 그림으로만 더 내린다('깊이 추정' 표시).
   터널: 반투명 껍데기 + 40m 마다 고리 + 바닥·레일 + 벽 등. 걷는 점 가까운 고리는 밝게(점이 터널 안을 비추는 것처럼).
   역: 승강장 상자(깊이 = 자료 값, 노선 색 테두리) · 환승역과 입구는 대합실 판(깊이 추정). 모양은 개략.
   카메라 따라가기
     - 보는 점(controls.target)을 매 프레임 사람 점(조금 위) 쪽으로 1 - e^(-k·dt) 만큼 당긴다: 프레임 수와 상관없이 부드럽다.
     - 카메라는 보는 점이 움직인 만큼 같이 옮긴다: 사용자가 돌리거나 당긴 각도·거리는 그대로 남는다.
     - 움직임마다 정한 거리로 천천히 맞추고, 진행 방향의 옆으로 돌아가며, 좌우로 조금 흔든다.
       사용자가 화면을 만지면 이 셋은 멈추고 따라가기(옮기기)만 한다. 카메라는 늘 지면 위에 둔다.
     - 하저터널에서는 몇 초 동안 터널 안(점 뒤)으로 들어갔다 나온다: 바깥 카메라와 안 카메라를 0~1 비율로 섞는다.
     - prefers-reduced-motion 이면 흔들지 않고, 터널 안으로 들어가지 않고, 첫 장면을 천천히 시작한다. */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* ---------- 0. 설정 ---------- */
const DIP = 80;      // 한강 아래 그림용 추가 내림(장면 단위, 실제 깊이 아님)
const R = 12;        // 터널 반지름(장면 단위, 그림용)
const COL = { bg: 0x0B1214, ground: 0x18262A, net: 0x3A5257, safe: 0x3FE6D5, expo: 0xFF5A36, river: 0x2F7FE0, est: 0x9FB3B0, white: 0xE8F1EF, earth: 0x6B5236, lamp: 0xFFD9A0 };
// 노선 색(web/js/lines.js 와 같은 값). 승강장 테두리에 쓴다
const LINE_COL = { '2호선': 0x00A84D, '3호선': 0xEF7C1C, '5호선': 0x996CAC, '8호선': 0xE6186C, '9호선': 0xBDB092, '수인분당선': 0xF5A200 };
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
const EXAG = D.exag;
$('exag').textContent = EXAG;

/* ---------- 1. 좌표 ---------- */
const allPts = Object.values(D.legs).flatMap((l) => l.pts);
const ext = (i) => [Math.min(...allPts.map((p) => p[i])), Math.max(...allPts.map((p) => p[i]))];
const [la0, la1] = ext(0), [lo0, lo1] = ext(1);
const LAT0 = (la0 + la1) / 2, LON0 = (lo0 + lo1) / 2;
const KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110540;
const toXZ = (lat, lon) => [(lon - LON0) * KX, -(lat - LAT0) * KY];
const toV = (p) => { const [x, z] = toXZ(p[0], p[1]); return new THREE.Vector3(x, -(p[3] * EXAG + p[4] * DIP), z); };

// 구간: enter 출구로 들어감 · ride1 처음 길 · blocked 막힌 터널 · rest 처음 길 나머지 · ride2 다시 찾은 길 · south 수서 → 동탄
const LEG = {};
for (const [k, l] of Object.entries(D.legs)) LEG[k] = { v: l.pts.map(toV), m: l.pts.map((p) => p[2]), len: l.pts[l.pts.length - 1][2], pts: l.pts };
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

// 터널: 껍데기(반투명) + 고리(40m 마다, InstancedMesh 한 번에 그림) + 바닥·레일 + 벽 등 + 단면
const RING = new THREE.TorusGeometry(R, 1.3, 3, 14), Z = new THREE.Vector3(0, 0, 1), ONE = new THREE.Vector3(1, 1, 1), UP = new THREE.Vector3(0, 1, 0);
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
  const len = curve.getLength(), n = Math.max(16, Math.min(4000, Math.round(len / 12)));
  const shell = new THREE.Mesh(new THREE.TubeGeometry(curve, n, R, 10), basic({ color, opacity: 0.13, depthWrite: false, side: THREE.DoubleSide }));
  // 일정 간격 점과 방향 → 고리 · 바닥 · 레일 · 등
  const k = Math.max(2, Math.round(len / 10)), P = curve.getSpacedPoints(k), side = new THREE.Vector3(), tan = new THREE.Vector3();
  const ringN = Math.floor(len / 40), rings = new THREE.InstancedMesh(RING, basic({ color: 0xffffff, opacity: 0.6 }), ringN);
  const floor = [], fIdx = [], rails = [], lamps = [], ringPos = new Float32Array(ringN * 3), mtx = new THREE.Matrix4(), q = new THREE.Quaternion();
  P.forEach((p, i) => {
    tan.subVectors(P[Math.min(k, i + 1)], P[Math.max(0, i - 1)]).normalize();
    side.set(-tan.z, 0, tan.x).normalize();                                  // 수평 옆 방향
    const y = p.y - R * 0.7;
    floor.push(p.x + side.x * 8, y, p.z + side.z * 8, p.x - side.x * 8, y, p.z - side.z * 8);
    if (i) { fIdx.push(2 * i - 2, 2 * i - 1, 2 * i, 2 * i - 1, 2 * i + 1, 2 * i); for (const s of [3.5, -3.5]) rails.push(P[i - 1].x + side.x * s, P[i - 1].y - R * 0.66, P[i - 1].z + side.z * s, p.x + side.x * s, p.y - R * 0.66, p.z + side.z * s); }
    if (i % 3 === 0) lamps.push(p.x + side.x * R * 0.8, p.y + R * 0.3, p.z + side.z * R * 0.8);   // 30m 마다 한쪽 벽에 등
  });
  for (let i = 0; i < ringN; i++) {
    const u = (i + 0.5) / ringN, p = curve.getPointAt(u);
    q.setFromUnitVectors(Z, curve.getTangentAt(u, tan));
    rings.setMatrixAt(i, mtx.compose(p, q, ONE)); rings.setColorAt(i, new THREE.Color(color));
    ringPos.set([p.x, p.y, p.z], i * 3);
  }
  const fl = new THREE.Mesh(geo(floor, fIdx), basic({ color: 0x0E1517, opacity: 0.85, side: THREE.DoubleSide }));
  const rl = new THREE.LineSegments(geo(rails), new THREE.LineBasicMaterial({ color: 0x8FA3A0, transparent: true }));
  const lp = new THREE.Points(geo(lamps), new THREE.PointsMaterial({ color: COL.lamp, size: 6, map: lampTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  const sl = leg === 'enter' ? null : slice(leg);   // 입구는 단면 없이
  scene.add(shell, rings, fl, rl, lp);
  const T = { leg, shell, slice: sl, rings, ringPos, ringN, lit: new Float32Array(ringN).fill(-1), color: new THREE.Color(color), a: 1,
    set(c, a) {   // 색(막힘이면 빨강)과 불투명도(다시 찾은 길이 나타날 때)
      if (!this.color.equals(new THREE.Color(c))) { this.color.set(c); shell.material.color.set(c); this.lit.fill(-1); }
      if (a === this.a) return;
      this.a = a;
      shell.material.opacity = 0.13 * a; rings.material.opacity = 0.6 * a; fl.material.opacity = 0.85 * a; rl.material.opacity = a; lp.material.opacity = a;
      if (sl) sl.material.opacity = a;
      [shell, rings, fl, rl, lp, sl].forEach((o) => { if (o) o.visible = a > 0.01; });
    } };
  tunnels.push(T);
  return T;
}
// 걷는 점 가까운 고리를 밝게: 점에서 150 안이면 등 색 쪽으로 섞는다(점이 터널 안을 비추는 것처럼)
const warm = new THREE.Color(COL.lamp), ringCol = new THREE.Color();
function lightRings(p) {
  for (const T of tunnels) {
    let changed = false;
    for (let i = 0; i < T.ringN; i++) {
      const dx = T.ringPos[i * 3] - p.x, dy = T.ringPos[i * 3 + 1] - p.y, dz = T.ringPos[i * 3 + 2] - p.z;
      const d2 = dx * dx + dy * dy + dz * dz, s = d2 < 22500 ? Math.round((1 - Math.sqrt(d2) / 150) * 10) / 10 : 0;
      if (s === T.lit[i]) continue;
      T.lit[i] = s; changed = true;
      T.rings.setColorAt(i, ringCol.copy(T.color).multiplyScalar(0.7).lerp(warm, s));
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

// 점선: 처음 길의 나머지(여의나루 → 도착) · 수서 → 동탄. 선은 멀리서도 1px 이라 전체 보기에서도 보인다
function dashed(leg, color, opacity) {
  const o = new THREE.Line(new THREE.BufferGeometry().setFromPoints(LEG[leg].v), new THREE.LineDashedMaterial({ color, dashSize: 260, gapSize: 180, transparent: true, opacity }));
  o.computeLineDistances(); scene.add(o); return o;
}
const restLine = dashed('rest', COL.safe, 0.7), southLine = dashed('south', COL.safe, 0);

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

// 사람 점: 흰 공 + 빛 번짐(스프라이트)
const person = new THREE.Group();
person.add(new THREE.Mesh(new THREE.SphereGeometry(7, 12, 8), new THREE.MeshBasicMaterial({ color: COL.white })));
const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: lampTex, color: COL.safe, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
halo.scale.set(110, 110, 1); person.add(halo);
scene.add(person);

// 막힘 표시: 빨간 원 안의 X (항상 카메라를 본다)
const blockMark = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d'); x.strokeStyle = '#FF5A36'; x.lineWidth = 10; x.lineCap = 'round';
  x.beginPath(); x.arc(64, 64, 52, 0, Math.PI * 2); x.stroke();
  x.beginPath(); x.moveTo(40, 40); x.lineTo(88, 88); x.moveTo(88, 40); x.lineTo(40, 88); x.stroke();
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  posAt('ride1', LEG.ride1.len, s.position); s.scale.set(130, 130, 1); scene.add(s); return s;
})();

/* ---------- 3. 이름표 ---------- */
const F = D.facts;
setTitle(F.start, F.end);
const st = (n, l) => D.stations.find((s) => s.n === n && (!l || s.l === l));
const fm = (x) => x.toFixed(1) + 'm', km = (m) => (m / 1000).toFixed(1) + 'km';
const labelsEl = $('labels'), labels = [];
// 이름표: 3D 위치를 화면 좌표로 바꿔 HTML 글자를 옮긴다(글꼴이 선명하다). vis(t) 가 거짓이면 숨긴다. maxD: 카메라가 이보다 멀면 숨김
function label(text, v, cls = '', vis = null, pri = 0, maxD = Infinity) {
  const el = document.createElement('div'); el.className = 'lb ' + cls; el.textContent = text; el.style.display = 'none';
  labelsEl.appendChild(el); labels.push({ el, v, vis, pri, maxD, on: false, w: 0 });
}
// 다시 찾은 길이 나타나는 시각 등(아래 4절에서 정함) 전에는 그 길의 이름표를 숨긴다
let REVEAL_T = 0, BLOCK_T = 0, SOUTH_T = 0;
const drops = [], seen = new Set();
const lineCount = (n) => new Set(D.stations.filter((s) => s.n === n).map((s) => s.l)).size;
D.stations.forEach((s) => {
  const key = s.n + '|' + s.l;
  if (seen.has(key)) return; seen.add(key);
  const v = posAt(s.leg, s.m);
  drops.push(v.x, 0, v.z, v.x, v.y, v.z);
  const later = s.leg === 'ride2' && !D.stations.some((o) => o.n === s.n && o.leg !== 'ride2');
  const text = s.n + (lineCount(s.n) > 1 ? ' ' + s.l : '') + ' ' + (s.d == null ? '깊이 추정' : fm(s.d));
  label(text, v.clone().add(new THREE.Vector3(0, 2 * R + 6, 0)), s.d == null ? 'est' : '', later ? (t) => t >= REVEAL_T : null);
});
// 역의 세로선(지면 → 승강장): 깊이를 읽기 쉽게
scene.add(new THREE.LineSegments(geo(drops), new THREE.LineBasicMaterial({ color: COL.est, transparent: true, opacity: 0.35 })));
// 대합실: 가까이 볼 때만
D.structs.filter((s) => s.k === 'concourse').forEach((s) => {
  const [x, z] = toXZ(s.c[0], s.c[1]);
  label(`${s.n} 대합실 · 깊이 추정`, new THREE.Vector3(x, -s.d * EXAG + 12, z), 'est', s.leg === 'ride2' ? (t) => t >= REVEAL_T : null, 0, 2600);
});
const mid = (a) => (a[0] + a[1]) / 2;
label(`${F.start}역 ${F.exit_ref}번 출구`, posAt('enter', E.expo_m).add(new THREE.Vector3(0, 40, 0)), '');
label('한강 아래 · 깊이 추정', posAt('ride1', F.block_m - 300).add(new THREE.Vector3(0, -2.5 * R, 0)), 'est', null, 1);   // 막힘 표시·점과 겹치지 않게 앞쪽 아래
label('한강 아래 · 깊이 추정', posAt('ride2', F.crossB.m[0] + 0.72 * (F.crossB.m[1] - F.crossB.m[0])).add(new THREE.Vector3(0, -2.5 * R, 0)), 'est', (t) => t >= REVEAL_T, 1);
// '한강' 글자: 중심선에서 경도 126.94(마포 부근)에 가장 가까운 점
label('한강', (() => { const [x, z] = toXZ(...D.river.line.reduce((b, p) => (Math.abs(p[1] - 126.94) < Math.abs(b[1] - 126.94) ? p : b))); return new THREE.Vector3(x, 0, z); })(), 'river', null, 1);
label('막힘', blockMark.position.clone().add(new THREE.Vector3(0, 90, 0)), 'red', (t) => t >= BLOCK_T, 2);
label(`처음 길 ${km(F.first_m)}`, posAt('rest', LEG.rest.len * 0.5).add(new THREE.Vector3(0, 30, 0)), 'dim', null, 1);
const SF = F.south;
label(`남쪽으로도 지하: ${F.end} → ${SF.to} ${km(SF.total_m)}`, posAt('south', LEG.south.len * 0.55).add(new THREE.Vector3(0, 30, 0)), '', (t) => t >= SOUTH_T, 3);

/* ---------- 4. 장면(자막 한 줄)과 움직임 ----------
   움직임 = [구간, 시작 m, 끝 m, 초, 카메라 거리('all' 전체 보기 · 'south' 동탄까지), 볼 곳(구간 m, 없으면 사람), 터널 안(이 움직임 안의 [시작 초, 끝 초])].
   긴 직선 구간은 짧은 시간에 빨리 감는다. 하저터널은 터널 가운데를 고정해 보고 점만 지나가게 한다(시연과 같은 모습). */
const g1 = st(F.start, '5호선');
const endM = LEG.ride2.len, A = F.crossA.m, B = F.crossB.m;
const XF = F.rides.find((r) => r.t === 'transfer');   // 다시 찾은 길의 첫 환승역(충정로): 잠깐 멈춰 역 구조를 보여 준다
const BEATS = [
  { cap: `${F.start}역 ${F.exit_ref}번 출구로 들어가 5호선 승강장으로`, sub: `지상 ${F.expo_m}m를 걸은 뒤 지하 ${g1.f} 승강장(깊이 ${fm(g1.d)})`,
    moves: [['enter', 0, E.expo_m, RM ? 5 : 3, 650], ['enter', E.expo_m, LEG.enter.len, 3.5, 750], ['enter', LEG.enter.len, LEG.enter.len, 0.6, 800]] },
  { cap: `한강 아래 ${F.crossA.line} ${F.crossA.a}–${F.crossA.b} 하저터널`, sub: `${F.end}역까지 지하로 ${km(F.first_m)}, 지상 ${F.first_expo_m}m인 길 · 터널 깊이는 추정`,
    moves: [['ride1', 0, F.mapo_m, 3, 900], ['ride1', F.mapo_m, F.block_m, 6, 2000, (A[0] + F.block_m) / 2 + 150, [0.6, 4.8]]] },
  { cap: `앞이 막힘 · ${F.crossA.a}역으로 ${F.backtrack_m}m 되돌아감`, sub: `막힌 하저터널을 빼고 ${F.crossA.a}역에서 다시 찾기`,
    moves: [['ride1', F.block_m, F.block_m, 2, 1000], ['ride1', F.block_m, F.mapo_m, 3.5, 1200], ['ride1', F.mapo_m, F.mapo_m, 1.5, 1800]] },
  { cap: `다시 찾은 길 ${km(F.total2_m)}, 지상 ${F.second_expo_m}m`, sub: `${F.crossA.a}에서 남은 ${km(F.left_m)}보다 ${km(F.total2_m - F.left_m)} 더 · 한강은 ${F.crossB.a}–${F.crossB.b} 하저터널로`,
    moves: [['ride2', 0, XF.m0 - 150, 2.5, 1600], ['ride2', XF.m0 - 150, XF.m1 + 150, 3.5, 750, (XF.m0 + XF.m1) / 2], ['ride2', XF.m1 + 150, B[0] - 300, 8, 3200]] },
  { cap: `한강 아래 다른 하저터널: ${F.crossB.a} → ${F.crossB.b}`, sub: '서울에서 한강을 지하로만 건너는 길은 5호선 하저터널 두 곳뿐',
    moves: [['ride2', B[0] - 300, B[1] + 200, 8, 2200, mid(B), [1.2, 5.6]]] },
  { cap: `${F.end}역 도착`, sub: `지하에 들어간 뒤 지상 노출 ${F.exposed_after_m}m · 지상은 처음 출구까지 ${F.expo_m}m`,
    moves: [['ride2', B[1] + 200, endM, 6, 1400], ['ride2', endM, endM, 3, 'all'], ['ride2', endM, endM, 4, 'south']] }
];
// 평평한 움직임 목록 + 시각. 조각 경계 속도 = 앞뒤 평균 속도 중 작은 쪽(방향이 다르거나 구간이 바뀌면 0)
const MOVES = [];
let TOTAL = 0;
BEATS.forEach((b, bi) => b.moves.forEach(([leg, m0, m1, sec, dist, look, inside]) => { MOVES.push({ leg, m0, m1, sec, dist, look, inside: RM ? null : inside, bi, t0: TOTAL }); TOTAL += sec; }));
MOVES.forEach((mv, i) => {
  const v = (x) => (x ? (x.m1 - x.m0) / x.sec : 0), a = MOVES[i - 1], b = MOVES[i + 1], me = v(mv);
  const edge = (o) => (o && o.leg === mv.leg && v(o) * me > 0 ? Math.sign(me) * Math.min(Math.abs(v(o)), Math.abs(me)) : 0);
  mv.v0 = edge(a); mv.v1 = edge(b);
});
const beatT = (bi) => MOVES.find((m) => m.bi === bi).t0;
BLOCK_T = beatT(2); REVEAL_T = MOVES.filter((m) => m.bi === 2)[2].t0; SOUTH_T = MOVES.find((m) => m.dist === 'south').t0;

// 시각 t 의 위치: 3차 에르미트(양 끝 속도 v0, v1)로 m 을 정한다 → 조각이 바뀌어도 속도가 끊기지 않는다
function moveAt(t) {
  let mv = MOVES[MOVES.length - 1];
  for (const x of MOVES) if (t < x.t0 + x.sec) { mv = x; break; }
  const s = Math.max(0, Math.min(1, (t - mv.t0) / mv.sec)), s2 = s * s, s3 = s2 * s;
  const m = (s3 - 2 * s2 + s) * mv.sec * mv.v0 + (-2 * s3 + 3 * s2) * (mv.m1 - mv.m0) + (s3 - s2) * mv.sec * mv.v1 + mv.m0;
  return { mv, m };
}
const ss = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
// 터널 안 비율(0~1): [시작, 끝] 사이에서 1초에 걸쳐 들어가고 1초에 걸쳐 나온다
const insideAt = (mv, t) => (mv.inside ? ss((t - mv.t0 - mv.inside[0]) / 1) * ss((mv.t0 + mv.inside[1] - t) / 1) : 0);

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

// 지금 어디인지 한 줄(타는 노선 · 환승 · 되돌아가는 거리 등)
function whereText(mv, m) {
  if (mv.leg === 'enter') return m < E.expo_m ? `지상 걷기 ${Math.round(m)}m / ${F.expo_m}m` : '출구 → 대합실 → 지하 승강장';
  if (mv.leg === 'ride1' && mv.bi === 2 && mv.m0 === F.block_m && mv.m1 === mv.m0) return `${F.crossA.a}역에서 하저터널로 ${F.walked_m}m 들어간 곳`;
  if (mv.leg === 'ride1') return mv.m1 < mv.m0 ? `되돌아가는 중 · ${F.crossA.a}역까지 ${Math.round(m - F.mapo_m)}m` : `5호선 · ${F.start} → ${F.crossA.a} → ${F.crossA.b} 방면`;
  let i = F.rides.findIndex((x) => m < x.m1);
  if (i < 0) i = F.rides.length - 1;
  const r = F.rides[i];
  const head = r.t === 'transfer' ? `${F.rides[i - 1].b} 환승 · ${F.rides[i - 1].label} → ${F.rides[i + 1].label}` : `${r.label} · ${r.a} → ${r.b}`;
  return `${head} · ${km(m)} / ${km(endM)}`;
}
const fmt = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

/* ---------- 6. 카메라 ----------
   바깥(단면) 카메라: 보는 점 = 사람보다 조금 위(사람 깊이의 3/4). 진행 방향의 옆(지금 카메라와 가까운 쪽) 위에서 비스듬히 본다.
   옆에서 보면 터널이 오르내리는 모양(단면)이 잘 보인다. 카메라는 늘 지면(MIN_Y) 위에 둔다.
   터널 안 카메라: 점 뒤 80m, 터널 가운데 높이에서 점 앞 200m 를 본다. 두 카메라를 insideAt 비율로 섞는다. */
const tmp = new THREE.Vector3(), off = new THREE.Vector3(), want = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
const rigPos = new THREE.Vector3(), rigTarget = new THREE.Vector3(), inPos = new THREE.Vector3(), inLook = new THREE.Vector3();
const sph = new THREE.Spherical(), PHI = 0.78, PHI_ALL = 0.7, MIN_Y = 80;
// 전체 보기: 처음 길·다시 찾은 길(all), 동탄까지(south)
const boxAll = new THREE.Box3().setFromPoints([...LEG.ride1.v, ...LEG.rest.v, ...LEG.ride2.v]), boxSouth = boxAll.clone().expandByPoint(LEG.south.v[LEG.south.v.length - 1]);
const center = (bx) => bx.getCenter(new THREE.Vector3()).setY(-150);
const overview = (bx) => { const s = bx.getSize(tmp); const h = 2 * Math.tan(camera.fov * Math.PI / 360); return Math.max(s.x / (h * camera.aspect), s.z / h) * 1.3 + 2000; };
const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));   // 각도 차이를 -π~π 로
function resetCamera() {
  posAt('enter', 0, controls.target); controls.target.y *= 0.75;
  camera.position.copy(controls.target).add(off.setFromSphericalCoords(RM ? 1500 : 1000, PHI, 0.35));
  rigPos.copy(camera.position); rigTarget.copy(controls.target);
}
let sway = 0, realT = 0;
function follow(dt, mv, m) {
  const all = mv.dist === 'all' || mv.dist === 'south', bx = mv.dist === 'south' ? boxSouth : boxAll, k = (r) => (snap && t > 0 ? 1 : 1 - Math.exp(-dt * r));
  const lookM = mv.look != null ? mv.look : m;                         // 하저터널·환승역은 한 곳을 고정해 본다
  if (all) want.copy(center(bx)); else { posAt(mv.leg, lookM, want); want.y *= 0.75; }
  tmp.copy(controls.target);
  controls.target.lerp(want, snap ? 1 : 1 - Math.exp(-dt * (all ? 1.2 : RM ? 2 : 3)));   // 높이도 같이 천천히(흔들림 없이)
  camera.position.add(tmp.subVectors(controls.target, tmp));          // 보는 점이 움직인 만큼 카메라도
  if (touched) return;                                                 // 사용자가 돌렸으면 각도·거리는 그대로
  sph.setFromVector3(off.subVectors(camera.position, controls.target));
  const fit = Math.max(1, 1.4 / camera.aspect);                        // 세로로 긴 화면(폰)은 좌우가 좁아서 더 멀리
  sph.radius += ((all ? overview(bx) : mv.dist * fit) - sph.radius) * k(RM ? 0.6 : 1.1);   // 처음에는 멀리서 천천히 다가간다
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
// 터널 안 카메라 자리: 진행 방향 뒤 80m · 앞 200m
function insidePose(mv, m) {
  const dir = mv.m1 >= mv.m0 ? 1 : -1;
  posAt(mv.leg, m - dir * 80, inPos).y += 2;
  posAt(mv.leg, m + dir * 200, inLook);
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
let frames = 0, fpsT = 0, inside = 0;
const ui = { cap: $('cap'), sub: $('sub'), where: $('where'), prog: $('prog'), time: $('time') };
function frame() {
  const dt = Math.min(0.05, clock.getDelta());
  realT += dt;
  if (playing) { t += dt; if (t >= TOTAL) { t = TOTAL; setPlaying(false); } }
  const { mv, m } = moveAt(t);
  posAt(mv.leg, m, person.position);
  const onStreet = mv.leg === 'enter' && m < E.expo_m;
  halo.material.color.set(onStreet ? COL.expo : COL.safe);

  // 막힘 · 다시 찾은 길 나타남 · 처음 길 나머지 · 남쪽(동탄)
  const blocked = t >= BLOCK_T;
  blockMark.visible = blocked;
  if (blocked) blockMark.scale.setScalar(130 * (RM ? 1 : 1 + 0.35 * Math.exp(-(t - BLOCK_T) * 1.5) * Math.abs(Math.sin((t - BLOCK_T) * 6))));
  TN.blocked.set(blocked ? COL.expo : COL.safe, blocked ? 0.8 : 1);
  const rev = ss((t - REVEAL_T) / 1.2);
  TN.ride2.set(COL.safe, rev);
  structLater.visible = rev > 0.5;
  restLine.material.color.set(blocked ? COL.est : COL.safe);                     // 처음 길의 나머지: 막힌 뒤에는 회색
  southLine.material.opacity = 0.75 * ss((t - SOUTH_T) / 1.2);
  lightRings(person.position);

  // 카메라: 바깥 카메라(rig)를 움직이고, 터널 안 비율만큼 안 카메라와 섞는다
  camera.position.copy(rigPos); controls.target.copy(rigTarget);
  follow(dt, mv, m);
  snap = false;
  controls.update();
  rigPos.copy(camera.position); rigTarget.copy(controls.target);
  inside = touched ? 0 : insideAt(mv, t);
  const cd = camera.position.distanceTo(controls.target);
  if (inside > 0) {
    insidePose(mv, m);
    camera.position.lerp(inPos, inside);
    camera.lookAt(tmp.copy(rigTarget).lerp(inLook, inside));
  }
  // 터널 안: 사람 점을 작게, 껍데기는 옅게, 단면(세로 판)은 숨긴다(안에서는 선 하나로 보여서)
  person.scale.setScalar(1 - 0.6 * inside);
  for (const T of tunnels) { T.shell.material.opacity = 0.13 * T.a * (1 - 0.5 * inside); if (T.slice) T.slice.material.opacity = T.a * (1 - inside); }
  const near = inside > 0.5 ? 1 : 10;
  if (camera.near !== near) { camera.near = near; camera.updateProjectionMatrix(); }
  scene.fog.near = THREE.MathUtils.lerp(cd * 1.6, 40, inside); scene.fog.far = THREE.MathUtils.lerp(cd * 6, 900, inside);
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

// 이름표 놓기: 카메라 앞·가까운 것만, 겹치면 우선순위(pri)·가까운 순으로 하나만. 화면 가장자리에서는 안쪽으로 밀어 넣는다
const placed = [];
function placeLabels(cd) {
  const W = innerWidth, H = innerHeight, cand = [];
  for (const L of labels) {
    let ok = inside < 0.3 && (!L.vis || L.vis(t));                    // 터널 안에서는 숨긴다
    if (ok) {
      tmp.copy(L.v).project(camera);
      const far = camera.position.distanceTo(L.v);
      ok = tmp.z < 1 && Math.abs(tmp.x) < 1.02 && Math.abs(tmp.y) < 1.02 && far < Math.min(cd * 2.8, L.maxD);
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
    const x0 = Math.max(6, Math.min(W - L.w - 6, c.x - L.w / 2));
    const r = [x0, c.y - 22, x0 + L.w, c.y];
    if (placed.some((p) => r[0] < p[2] && r[2] > p[0] && r[1] < p[3] && r[3] > p[1])) { L.el.style.display = 'none'; L.on = false; continue; }
    placed.push(r);
    L.el.style.transform = `translate(${r[0].toFixed(1)}px, ${r[1].toFixed(1)}px)`;
  }
}

window.__ride = { seek: (x) => { seek(x); setPlaying(false); }, play: () => setPlaying(true), total: TOTAL, fps: 0,
  beats: BEATS.map((b, i) => ({ cap: b.cap, sub: b.sub, t: beatT(i) })), moves: MOVES.map((x) => ({ t0: x.t0, sec: x.sec, inside: x.inside, look: x.look, dist: x.dist })),
  shown: () => labels.filter((l) => l.on).map((l) => l.el.textContent) };
renderer.setAnimationLoop(frame);
