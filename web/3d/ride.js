/* ride.js — 지하로 3D: 시연 1번 이야기(공덕 → 수서)를 실제 높이로 따라가는 짧은 영상
   자료: ride.json (scripts/build_3d.js 가 앱의 길 찾기 코드 + 서울교통공사 역 깊이 + SRTM 지형으로 만든다)
     구간 점 = [x 동쪽 m, y 북쪽 m, 구간 m(앱 거리), 걷는 바닥 해발 z, 지반(강 위는 수면) 해발 g, 수면 해발 w(강 아래만)] + 점마다 종류 글자
     (s 지상 · t 터널 · i 섬식 승강장 구간 · p 상대식 승강장 구간 · x 역 안: 에스컬레이터·대합실)
   두 가지로 연다
     - /3d/          혼자 재생: 이 파일의 장면 목록(MOVES)과 시계로 움직이고 자막을 보여 준다.
     - /3d/?follow   발표 무대(web/stage/) 안: 자기 시계를 쓰지 않고, 앱 시연(demo.js)이 보내는 메시지로 움직인다(10절).
       받는 것(무대가 넘겨 줌): { src: 'jiharo-demo', ver: 1, type: 'scene'|'leg'|'pos'|'state'|'end', ... } — 형식은 web/js/demo.js 6절.
       보내는 것(window.parent): { src: 'jiharo-3d', type: 'hello' }(처음 한 번) · { type: 'key', key }(Space·→ 를 무대로)
     - ?lq           가벼운 단계로 시작(후처리 없음, 화소 비율 0.75배, Lambert 재질, 터널 점광원 1개). 1초 평균 30fps 아래가 3초 이어지면 저절로 바꾼다.
       low 에서도 18fps 아래가 이어지면 화소 비율을 0.7배 한 번 더 줄인다. ?hq 는 high 고정(자동으로 낮추지 않음).
   좌표: three.js 의 x = 동쪽 m, z = -북쪽 m, y = 해발 m × uEx.
     uEx(세로 배율)는 장면마다 다르다: 전체·단면 장면은 자료의 exag(지형·깊이 같은 배율), 터널 안·역 안·거리 장면은 1(실제 비율).
     배율은 셰이더(1절 exPatch)가 그릴 때 곱한다. 터널 단면·역 상자·사람은 실제 크기 그대로 두고 기준 높이(레일 등)만 배율을 곱해서,
     배율이 바뀌는 중에도 카메라가 터널 안에 그대로 있다.
   그림의 출처: 레일 높이(역) = 서울교통공사 CSV 또는 위키·층수 추정, 역 사이 = 기울기 + 종곡선(추정), 지형 = SRTM(공식 역 지반고로 보정),
     한강 수면 = SRTM 중앙값, 강바닥 = 자료 없음(만들지 않음), 지층 무늬 = 그림, 역 구조 = 개략(승강장 높이만 자료). */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* ---------- 0. 설정 ---------- */
const Q = new URLSearchParams(location.search);
const FOLLOW = Q.has('follow');                 // 발표 무대 안(앱 시연을 따라감)
let TIER = Q.has('lq') ? 'low' : 'high';        // high: 빛 번짐·계단 없애기·터널 등 빛 / low: 후처리 없음
const HOLD = Q.has('hq');                       // high 단계 고정(자동으로 낮추지 않음)
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (id) => document.getElementById(id);
if (FOLLOW) document.body.classList.add('follow');
const COL = { sky: 0x05080D, fog: 0x070B12, safe: 0x3FE6D5, expo: 0xFF5A36, est: 0x9FB3B0, white: 0xE8F1EF, lamp: 0xFFD9A0 };
// 노선 색(web/js/lines.js 와 같은 값): 승강장 벽 띠
const LINE_COL = { '2호선': 0x00A84D, '3호선': 0xEF7C1C, '5호선': 0x996CAC, '8호선': 0xE6186C, '9호선': 0xBDB092, '수인분당선': 0xF5A200 };
const ss = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x)), lerp = (a, b, t) => a + (b - a) * t;
const fm = (x) => x.toFixed(1) + 'm', km = (m) => (m / 1000).toFixed(1) + 'km';
const fail = (msg) => { document.body.insertAdjacentHTML('beforeend', '<div class="fail"><p>' + msg + '<br><a href="../" style="color:#3FE6D5">지하로 앱 열기</a></p></div>'); };

let D, renderer;
try { D = await (await fetch('ride.json')).json(); } catch (e) { fail('자료(ride.json)를 불러오지 못했습니다.'); throw e; }
try { renderer = new THREE.WebGLRenderer({ canvas: $('c'), antialias: false, powerPreference: 'high-performance' }); } catch (e) { fail('이 기기에서는 3D 그림(WebGL)을 쓸 수 없습니다.'); throw e; }
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.outputColorSpace = THREE.SRGBColorSpace;
// 화소 비율: high = 기기 값(최대 2), low = 그 0.75배. low 에서도 18fps 아래가 이어지면 0.7배를 한 번 더(소프트웨어 렌더링 등)
let lowPR = Math.max(0.5, Math.min(devicePixelRatio, 2) * 0.75);
const PR = () => (TIER === 'low' ? lowPR : Math.min(devicePixelRatio, 2));
renderer.setPixelRatio(PR());
const EX = D.exag, LIFT = 1.1;
// 셰이더가 함께 쓰는 값: 세로 배율 · 시각 · 단면(땅 잘라 내기) 상자
const U = { uEx: { value: EX }, uTime: { value: 0 }, uCutC: { value: new THREE.Vector4(0, 0, 1, 0) }, uCutS: { value: new THREE.Vector4(0, 0, 1, 12) }, uCutOn: { value: 0 } };
const ex = () => U.uEx.value;

/* ---------- 1. 자료 · 좌표 · 배율 ---------- */
const LEG = {};
for (const [k, l] of Object.entries(D.legs)) {
  const col = (i) => Float64Array.from(l.pts, (p) => (p[i] == null ? NaN : p[i]));
  const L = { x: col(0), y: col(1), m: col(2), z: col(3), g: col(4), w: col(5), k: l.k, n: l.pts.length, len: l.pts[l.pts.length - 1][2], expo: l.expo_m };
  L.zr = L.z.map((z, i) => z - (L.k[i] === 'i' ? LIFT : 0));   // 레일 높이(섬식 승강장 구간은 걷는 바닥이 레일 + 1.1m)
  LEG[k] = L;
}
function segOf(L, m) {
  m = clamp(m, 0, L.len);
  let lo = 0, hi = L.n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (L.m[mid] <= m) lo = mid; else hi = mid; }
  return { i: lo, j: hi, t: L.m[hi] > L.m[lo] ? (m - L.m[lo]) / (L.m[hi] - L.m[lo]) : 0 };
}
// 구간 k 의 m 지점(점 사이는 직선)
function smp(k, m) {
  const L = LEG[k], { i, j, t } = segOf(L, m), f = (a) => a[i] + (a[j] - a[i]) * t;
  return { x: f(L.x), y: f(L.y), z: f(L.z), zr: f(L.zr), g: f(L.g), w: isNaN(L.w[i]) || isNaN(L.w[j]) ? null : f(L.w), kind: t < 0.5 ? L.k[i] : L.k[j] };
}
const wp = (k, m, out = new THREE.Vector3(), up = 0) => { const s = smp(k, m); return out.set(s.x, s.z * ex() + up, -s.y); };
function hdir(k, m, out = new THREE.Vector3()) {
  const a = smp(k, m - 5), b = smp(k, m + 5);
  out.set(b.x - a.x, 0, -(b.y - a.y));
  return out.lengthSq() > 1e-6 ? out.normalize() : out.set(1, 0, 0);
}
// 지형 높이(해발 m): 격자 두 개(본 그림 180m · 남쪽 400m)에서 겹선형으로
function th(x, y) {
  for (const t of D.terrain) {
    const fx = (x - t.x0) / t.dx, fy = (y - t.y0) / t.dx;
    if (fx < 0 || fy < 0 || fx > t.nx - 1 || fy > t.ny - 1) continue;
    const i = Math.min(t.nx - 2, Math.floor(fx)), j = Math.min(t.ny - 2, Math.floor(fy)), u = fx - i, v = fy - j, h = (a, b) => t.h[(j + b) * t.nx + i + a] / 10;
    return (h(0, 0) * (1 - u) + h(1, 0) * u) * (1 - v) + (h(0, 1) * (1 - u) + h(1, 1) * u) * v;
  }
  return 0;
}
// 배율 붙이기: 그릴 때 세로(y)에 uEx 를 곱한다
//   world: 해발 그대로인 것(지형·물·단면·바탕 선): y × uEx
//   attr : 실제 크기 단면을 가진 것(터널·레일): 기준 높이(aCy)만 배율, 단면은 그대로
//   inst : 같은 모양 여럿(터널 등): 인스턴스 자리 높이만 배율
//   glow : 길 빛줄(굵기 uR 배, 기준 aCtr)
// cut  : 단면 장면에서 카메라 쪽 땅·물을 잘라 낸다(uCut 상자 안이면 버림)
function exPatch(mat, mode, { cut = false, contour = false, extra } = {}) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U, extra || {});
    const head = 'uniform float uEx;\nvarying vec2 vCutP;\nvarying float vElev;\n' + (mode === 'attr' ? 'attribute float aCy;\n' : '') + (mode === 'glow' ? 'attribute vec3 aCtr;\nuniform float uR;\n' : '');
    sh.vertexShader = head + sh.vertexShader.replace('#include <project_vertex>', `
      vec3 tp = transformed;
      ${mode === 'glow' ? 'tp = aCtr + (tp - aCtr) * uR;' : ''}
      vec4 mvPosition = vec4( tp, 1.0 );
      #ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
      #endif
      mvPosition = modelMatrix * mvPosition;
      vCutP = mvPosition.xz; vElev = mvPosition.y;
      ${mode === 'world' ? 'mvPosition.y *= uEx;' : mode === 'attr' ? 'mvPosition.y += aCy * (uEx - 1.0);' : mode === 'glow' ? 'mvPosition.y += aCtr.y * (uEx - 1.0);' : '#ifdef USE_INSTANCING\n mvPosition.y += instanceMatrix[3][1] * (uEx - 1.0);\n #endif'}
      mvPosition = viewMatrix * mvPosition;
      gl_Position = projectionMatrix * mvPosition;`);
    let fs = 'uniform float uEx;\nuniform vec4 uCutC;\nuniform vec4 uCutS;\nuniform float uCutOn;\nvarying vec2 vCutP;\nvarying float vElev;\n' + sh.fragmentShader;
    if (cut) fs = fs.replace('void main() {', `void main() {
      if (uCutOn > 0.001) {
        vec2 d = vCutP - uCutC.xy; float al = dot(d, uCutC.zw); float la = dot(d, vec2(-uCutC.w, uCutC.z)) * uCutS.z;
        if (abs(al) < uCutS.x && la > -uCutS.w && la < uCutS.y * uCutOn) discard;
      }`);
    if (contour) fs = fs.replace('#include <color_fragment>', `#include <color_fragment>
      { float e = vElev / 10.0; float l = 1.0 - min(abs(fract(e - 0.5) - 0.5) / max(fwidth(e), 1e-4), 1.0);
        float e5 = vElev / 50.0; float l5 = 1.0 - min(abs(fract(e5 - 0.5) - 0.5) / max(fwidth(e5), 1e-4), 1.0);
        diffuseColor.rgb += vec3(0.05, 0.11, 0.13) * l * 0.5 + vec3(0.08, 0.17, 0.2) * l5 * 0.6; }`);
    sh.fragmentShader = fs;
    if (mat.userData.more) mat.userData.more(sh);
  };
  mat.customProgramCacheKey = () => 'ex-' + mode + (cut ? 'c' : '') + (contour ? 'k' : '') + (mat.userData.key || '');
  return mat;
}

/* ---------- 2. 그리기 바탕: 렌더러 · 빛 번짐 · 안개 · 하늘 ---------- */
const scene = new THREE.Scene();
scene.background = new THREE.Color(COL.sky);
scene.fog = new THREE.FogExp2(COL.fog, 2e-5);
const camera = new THREE.PerspectiveCamera(40, 1, 1, 300000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.enabled = true;
// 밤하늘 반사(금속 레일·물에 비침): 위는 남색, 지평선은 도시 불빛 주황
{
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const x = c.getContext('2d'), gr = x.createLinearGradient(0, 0, 0, 128);
  gr.addColorStop(0, '#060c18'); gr.addColorStop(0.42, '#14203a'); gr.addColorStop(0.5, '#5a3c2a'); gr.addColorStop(0.56, '#1a1512'); gr.addColorStop(1, '#050505');
  x.fillStyle = gr; x.fillRect(0, 0, 256, 128);
  const t = new THREE.CanvasTexture(c); t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.SRGBColorSpace;
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromEquirectangular(t).texture; scene.environmentIntensity = 0.7;
  pm.dispose();
}
scene.add(new THREE.HemisphereLight(0x50688a, 0x1c1610, 0.9));
const moon = new THREE.DirectionalLight(0xb4cdf5, 0.9); moon.position.set(-0.5, 1, 0.35); scene.add(moon);
// 후처리(high): 다중 표본 계단 없애기(4) → 빛 번짐 → 톤 매핑·색 공간(OutputPass)
let composer = null, bloom = null;
function makeComposer() {
  const rt = new THREE.WebGLRenderTarget(16, 16, { type: THREE.HalfFloatType, samples: 4 });
  composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  bloom = new UnrealBloomPass(new THREE.Vector2(16, 16), 0.5, 0.45, 0.85);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
}
if (TIER === 'high') makeComposer();

/* ---------- 3. 그림 재료(이미지 파일 없이 캔버스로) ---------- */
function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const rnd = ((s) => () => (s = (s * 16807) % 2147483647) / 2147483647)(11);   // 늘 같은 무늬(씨앗 고정)
// 터널 벽 콘크리트: 가로 4m(둘레) × 세로 3m(길이). 1.5m 마다 세그먼트 이음, 엇갈린 세로 이음, 볼트 홈, 물 자국
const concreteTex = canvasTex(512, 384, (x, w, h) => {
  x.fillStyle = '#7d7f7c'; x.fillRect(0, 0, w, h);
  for (let i = 0; i < 2600; i++) { const v = 100 + rnd() * 50 | 0; x.fillStyle = `rgba(${v},${v},${v - 4},${0.08 + rnd() * 0.12})`; const r = 2 + rnd() * 10; x.fillRect(rnd() * w, rnd() * h, r, r); }
  for (let i = 0; i < 14; i++) { const sx = rnd() * w, g = x.createLinearGradient(sx, 0, sx, h); g.addColorStop(0, 'rgba(40,38,32,0)'); g.addColorStop(0.5, 'rgba(48,44,36,0.22)'); g.addColorStop(1, 'rgba(40,38,32,0)'); x.fillStyle = g; x.fillRect(sx, rnd() * h * 0.5, 3 + rnd() * 8, h * 0.6); }
  x.fillStyle = 'rgba(30,30,30,0.85)';
  for (const y of [0, h / 2]) { x.fillRect(0, y, w, 3); for (let i = 0; i < 6; i++) x.fillRect((i + 0.5) * w / 6 - 5, y - 9, 10, 18); }
  for (const [y0, off] of [[0, 0], [h / 2, w / 8]]) for (let i = 0; i < 4; i++) x.fillRect((off + i * w / 4) % w, y0, 2, h / 2);
});
// 선로 바닥: 침목(0.6m 간격) + 가운데 배수로
const bedTex = canvasTex(256, 256, (x, w, h) => {
  x.fillStyle = '#2b2d2c'; x.fillRect(0, 0, w, h);
  for (let i = 0; i < 900; i++) { const v = 40 + rnd() * 30 | 0; x.fillStyle = `rgb(${v},${v},${v})`; x.fillRect(rnd() * w, rnd() * h, 2, 2); }
  x.fillStyle = '#5c5a55';
  for (let j = 0; j < 4; j++) for (const cx of [0.285, 0.715]) x.fillRect(cx * w - 34, j * h / 4 + 8, 68, 14);
  x.fillStyle = '#161716'; x.fillRect(w / 2 - 6, 0, 12, h);
}, true);
// 역 벽 타일
const tileTex = canvasTex(256, 256, (x, w, h) => {
  x.fillStyle = '#c9cdc9'; x.fillRect(0, 0, w, h);
  x.strokeStyle = 'rgba(80,86,84,0.55)'; x.lineWidth = 2;
  for (let i = 0; i <= 8; i++) { x.beginPath(); x.moveTo(i * w / 8, 0); x.lineTo(i * w / 8, h); x.stroke(); x.beginPath(); x.moveTo(0, i * h / 8); x.lineTo(w, i * h / 8); x.stroke(); }
});
const dotTex = canvasTex(64, 64, (x) => {
  const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.3, 'rgba(255,255,255,.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
}, false);
const smokeTex = canvasTex(128, 128, (x) => {   // 연기: 부드러운 덩어리 몇 개를 겹친 점
  for (let i = 0; i < 9; i++) {
    const cx = 64 + (rnd() - 0.5) * 40, cy = 64 + (rnd() - 0.5) * 40, r = 28 + rnd() * 26, gr = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    gr.addColorStop(0, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
  }
}, false);
const dashTex = canvasTex(4, 64, (x) => { x.fillStyle = '#fff'; x.fillRect(0, 0, 4, 40); x.fillStyle = '#000'; x.fillRect(0, 40, 4, 24); }, false);

/* ---------- 4. 지형 · 한강 · 바탕 선로 · 도시 불빛 ---------- */
const surface = [];   // 땅 위 것들(카메라가 땅 밑 깊이 있으면 그리지 않는다)
// 지형: 빛 계산 없이(MeshBasic) 언덕 그늘(달빛 방향)을 꼭짓점 색에 미리 굽는다. 등고선(10m·50m)은 셰이더가 긋는다
const terrainMat = exPatch(new THREE.MeshBasicMaterial({ vertexColors: true }), 'world', { cut: true, contour: true });
D.terrain.forEach((t, ti) => {
  const n = t.nx * t.ny, pos = new Float32Array(n * 3), col = new Float32Array(n * 3), idx = [];
  const c = new THREE.Color(), lo = new THREE.Color(0x1a2836), mid = new THREE.Color(0x1d2e2a), hi = new THREE.Color(0x34443a);
  for (let j = 0; j < t.ny; j++) for (let i = 0; i < t.nx; i++) {
    const k = j * t.nx + i, h = t.h[k] / 10 - (ti ? 1 : 0);   // 남쪽 격자는 1m 낮게(겹치는 곳에서 본 격자가 위)
    pos.set([t.x0 + i * t.dx, h, -(t.y0 + j * t.dx)], k * 3);
    c.copy(lo).lerp(mid, ss((h - 20) / 50)).lerp(hi, ss((h - 90) / 150)).multiplyScalar(0.9 + rnd() * 0.15);
    col.set([c.r, c.g, c.b], k * 3);
    if (i && j) { const a = k - t.nx - 1, b = k - t.nx, d = k - 1; idx.push(a, b, d, b, k, d); }   // 위쪽이 앞면
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setIndex(idx);
  // 법선은 배율을 곱한 모양으로(언덕 그늘이 보이게). 그림 위치는 셰이더가 배율을 곱한다
  const tmpG = g.clone(), p2 = tmpG.attributes.position;
  for (let k = 0; k < n; k++) p2.setY(k, p2.getY(k) * EX);
  tmpG.computeVertexNormals();
  const nrm = tmpG.attributes.normal, sun = new THREE.Vector3(-0.5, 0.75, -0.35).normalize(), nv = new THREE.Vector3();
  for (let k = 0; k < n; k++) { nv.fromBufferAttribute(nrm, k); const sh = 0.55 + 0.75 * Math.max(0, nv.dot(sun)); col[k * 3] *= sh; col[k * 3 + 1] *= sh; col[k * 3 + 2] *= sh; }
  g.attributes.color.needsUpdate = true;
  const mesh = new THREE.Mesh(g, terrainMat); mesh.frustumCulled = false; mesh.renderOrder = -2;
  surface.push(mesh);
  scene.add(mesh);
});
// 한강 수면: 중심선 [x, y, 수면 해발, 왼쪽 폭, 오른쪽 폭]. 잔물결(셰이더) · 가운데일수록 짙은 색
const water = (() => {
  const R = D.river.line, pos = [], edge = [], idx = [];
  R.forEach((r, i) => {
    const a = R[Math.max(0, i - 1)], b = R[Math.min(R.length - 1, i + 1)], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L;
    pos.push(r[0] + nx * r[3], r[2], -(r[1] + ny * r[3]), r[0], r[2], -r[1], r[0] - nx * r[4], r[2], -(r[1] - ny * r[4]));
    edge.push(0, 1, 0);
    if (i) for (const k of [0, 1]) { const p = 3 * (i - 1) + k, q = 3 * i + k; idx.push(p, p + 1, q, p + 1, q + 1, q); }   // 위쪽이 앞면
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1)); g.setIndex(idx); g.computeVertexNormals();
  const m = new THREE.MeshStandardMaterial({ color: 0x143352, roughness: 0.16, metalness: 0.0, envMapIntensity: 1.3 });
  m.userData.key = 'water';
  m.userData.more = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('void main() {', 'attribute float aEdge;\nvarying float vEdge;\nvoid main() {\nvEdge = aEdge;');
    sh.fragmentShader = sh.fragmentShader.replace('void main() {', 'uniform float uTime;\nvarying float vEdge;\nvoid main() {')
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( mix(diffuse * 1.6, diffuse * 0.55, smoothstep(0.0, 1.0, vEdge)), opacity );')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        { vec2 p = vCutP * 0.045; float t = uTime;
          vec2 w = vec2(sin(p.x * 1.7 + t * 0.9) + sin(p.x * 0.6 - p.y * 1.3 + t * 0.6) * 0.7 + sin((p.x + p.y) * 3.1 + t * 1.7) * 0.25,
                        cos(p.y * 1.5 - t * 0.8) + cos(p.y * 0.7 + p.x * 1.1 - t * 0.5) * 0.7 + cos((p.x - p.y) * 2.9 - t * 1.5) * 0.25);
          normal = normalize(normal + (viewMatrix * vec4(w.x, 0.0, w.y, 0.0)).xyz * 0.06); }`);
  };
  const mesh = new THREE.Mesh(g, exPatch(m, 'world', { cut: true }));
  mesh.frustumCulled = false; mesh.renderOrder = -1;
  scene.add(mesh);
  return mesh;
})();
// 바탕 선로(OSM 본선): 지형 위 4m 에 옅은 선
const netLines = (() => {
  const a = [];
  D.net.forEach((l) => { for (let i = 1; i < l.length; i++) { const p = l[i - 1], q = l[i]; a.push(p[0], th(p[0], p[1]) + 4, -p[1], q[0], th(q[0], q[1]) + 4, -q[1]); } });
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(a, 3));
  const o = new THREE.LineSegments(g, exPatch(new THREE.LineBasicMaterial({ color: 0x4f6f96, transparent: true, opacity: 0.3, depthWrite: false }), 'world', { cut: true }));
  o.frustumCulled = false; scene.add(o);
  return o;
})();
surface.push(water, netLines);
{
  const p = new THREE.Mesh(new THREE.PlaneGeometry(400000, 400000).rotateX(-Math.PI / 2).translate(0, -2, 0), exPatch(new THREE.MeshBasicMaterial({ color: 0x121b25 }), 'world', { cut: true }));   // 지형 자료 범위 밖: 어두운 땅
  p.renderOrder = -3; p.frustumCulled = false; scene.add(p); surface.push(p);
}
// 밤 도시 불빛: OSM 아파트 자리(지형 위 3m). 층수가 많을수록 조금 밝게
const cityLights = (() => {
  const pos = [], col = [], c = new THREE.Color();
  D.lights.forEach(([x, y, lv]) => {
    pos.push(x, th(x, y) + 3, -y);
    c.setHSL(0.09 + rnd() * 0.05, 0.75, 0.55).multiplyScalar(0.55 + Math.min(1, lv / 25) * 0.9 + rnd() * 0.2);
    col.push(c.r, c.g, c.b);
  });
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const m = exPatch(new THREE.PointsMaterial({ size: 20, map: dotTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), 'world', { cut: true });
  const o = new THREE.Points(g, m); o.frustumCulled = false; scene.add(o);
  surface.push(o);
  return o;
})();

/* ---------- 5. 단면을 쓸어 만든 메시(터널·레일·빛줄) ---------- */
// 구간 k 의 m0 ~ m1 을 step(m) 간격으로(자료 점도 넣는다): { x, y, z(레일), zw(걷는 바닥), m, dx, dy, kind }
function samples(k, m0, m1, step) {
  const L = LEG[k], ms = new Set();
  for (let m = m0; m < m1; m += step) ms.add(+m.toFixed(2));
  ms.add(+m1.toFixed(2));
  for (let i = 0; i < L.n; i++) if (L.m[i] > m0 && L.m[i] < m1) ms.add(L.m[i]);
  return [...ms].sort((a, b) => a - b).map((m) => {
    const s = smp(k, m), a = smp(k, m - 3), b = smp(k, m + 3), dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
    return { x: s.x, y: s.y, z: s.zr, zw: s.z, m, dx: dx / l, dy: dy / l, kind: s.kind, w: s.w, g: s.g };
  });
}
// 단면 prof = [[s(오른쪽 +), t(위 +)], ...] 를 점마다 세워 잇는다. so(점마다 가로 이동), ctr(빛줄: 단면 가운데 자리)
function sweep(S, prof, { uScale = 1, vScale = 1, so = null, base = 'z', ctr = 0 } = {}) {
  const np = prof.length, n = S.length * np, pos = new Float32Array(n * 3), cy = new Float32Array(n), uv = new Float32Array(n * 2), cA = ctr ? new Float32Array(n * 3) : null, idx = [];
  const pl = [0];
  for (let j = 1; j < np; j++) pl.push(pl[j - 1] + Math.hypot(prof[j][0] - prof[j - 1][0], prof[j][1] - prof[j - 1][1]));
  S.forEach((p, i) => {
    const rx = p.dy, ry = -p.dx, off = so ? so(p) : 0, zb = p[base] + ctr;
    for (let j = 0; j < np; j++) {
      const s = prof[j][0] + off, o = i * np + j;
      pos[o * 3] = p.x + rx * s; pos[o * 3 + 1] = zb + prof[j][1]; pos[o * 3 + 2] = -(p.y + ry * s);
      cy[o] = zb; uv[o * 2] = pl[j] / uScale; uv[o * 2 + 1] = p.m / vScale;
      if (cA) { cA[o * 3] = p.x + rx * off; cA[o * 3 + 1] = zb; cA[o * 3 + 2] = -(p.y + ry * off); }
    }
    if (i) for (let j = 1; j < np; j++) { const a = (i - 1) * np + j - 1, b = a + 1, c = i * np + j - 1, d = c + 1; idx.push(a, b, c, b, d, c); }   // 단면을 왼쪽 → 오른쪽으로 놓으면 위쪽이 앞면
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aCy', new THREE.BufferAttribute(cy, 1)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (cA) g.setAttribute('aCtr', new THREE.BufferAttribute(cA, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

/* ---------- 6. 길 빛줄: 전체·단면 장면에서 길을 보여 주는 빛나는 줄 ----------
   굵기 = 카메라 거리에 비례(멀리서도 2화소쯤). 터널 안·역 안에서는 바닥 위 가는 안내선(굵기 0.1m 남짓)이 된다.
   땅 속 길이 지형에 가려지지 않게 같은 줄을 한 번 더(깊이 검사 없이 옅게) 그린다 */
const glowR = { value: 6 };
const OCT = Array.from({ length: 9 }, (_, i) => [Math.cos(i / 8 * Math.PI * 2), Math.sin(i / 8 * Math.PI * 2)]);
const glows = [];
function glowLine(k, m0, m1, color, { dashed = false, step = 8, xray = 0.45 } = {}) {
  const S = samples(k, m0, m1, step);
  if (S.length < 2) return null;
  const g = sweep(S, OCT, { base: 'zw', ctr: 0.12, vScale: 420 });
  const mk = (o) => { const m = new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, alphaMap: dashed ? dashTex : null, ...o }); m.userData.key = dashed ? 'd' : ''; return exPatch(m, 'glow', { extra: { uR: glowR } }); };
  const solid = new THREE.Mesh(g, mk({ opacity: 1 })), xr = new THREE.Mesh(g, mk({ opacity: xray, depthTest: false, blending: THREE.AdditiveBlending }));
  solid.frustumCulled = xr.frustumCulled = false; xr.renderOrder = 5;
  scene.add(solid, xr);
  const o = { k, solid, xr, a: 1, base: xray, set(c, a) { if (c != null) { solid.material.color.copy(c); xr.material.color.copy(c); } if (a != null) this.a = a; } };
  glows.push(o);
  return o;
}
const HDR = (hex, k) => new THREE.Color(hex).multiplyScalar(k);
const C_SAFE = HDR(COL.safe, 1.6), C_EXPO = HDR(COL.expo, 1.7), C_GRAY = HDR(COL.est, 0.7);
const EL = LEG.enter;
const GL = {
  street: glowLine('enter', 0, EL.expo, C_EXPO, { step: 4 }),
  enter: glowLine('enter', EL.expo, EL.len, C_SAFE, { step: 2 }),
  ride1: glowLine('ride1', 0, LEG.ride1.len, C_SAFE),
  blocked: glowLine('blocked', 0, LEG.blocked.len, C_SAFE),
  rest: glowLine('rest', 0, LEG.rest.len, HDR(COL.safe, 0.9), { dashed: true, step: 30, xray: 0.22 }),
  ride2: glowLine('ride2', 0, LEG.ride2.len, C_SAFE),
  south: glowLine('south', 0, LEG.south.len, HDR(COL.safe, 0.9), { dashed: true, step: 40, xray: 0.22 })
};

/* ---------- 7. 터널(실제 크기) ----------
   단면: 복선 말굽형 폭 9.4m · 레일에서 천장까지 7.1m(개략). 선로 둘(가운데에서 ±1.9m), 레일 간격 1.435m.
   역(승강장 구간 ± 45m)에서는 터널 벽 대신 역 상자를 둔다. 섬식 역 앞뒤 40m 는 선로가 승강장 옆(±6.6m)으로 벌어진다.
   400m 씩 나눈 덩어리마다 카메라에서 멀면 숨긴다(멀리서는 한 화소도 안 된다) */
const LINING = [[4.45, -0.3], [4.7, 0.9], ...Array.from({ length: 15 }, (_, i) => { const a = i / 14 * Math.PI; return [4.7 * Math.cos(a), 2.4 + 4.7 * Math.sin(a)]; }), [-4.7, 0.9], [-4.45, -0.3]];
const BED = [[-4.45, -0.2], [4.45, -0.2]];
const RAIL = [[-0.035, -0.17], [0.035, -0.17], [0.035, 0], [-0.035, 0], [-0.035, -0.17]];
const TRAY = [[-0.25, 0], [0.25, 0], [0.25, 0.14], [-0.25, 0.14], [-0.25, 0]].map(([s, t]) => [s, t + 1.3]);
const MAT = {
  lining: exPatch(new THREE.MeshStandardMaterial({ map: concreteTex, color: 0xb9bbb6, roughness: 0.82, side: THREE.DoubleSide, envMapIntensity: 0.12 }), 'attr'),
  bed: exPatch(new THREE.MeshStandardMaterial({ map: bedTex, color: 0x9a9a96, roughness: 0.32, metalness: 0.05, envMapIntensity: 0.35, side: THREE.DoubleSide }), 'attr'),
  rail: exPatch(new THREE.MeshStandardMaterial({ color: 0xa9b1b6, roughness: 0.26, metalness: 1, envMapIntensity: 0.9, side: THREE.DoubleSide }), 'attr'),
  tray: exPatch(new THREE.MeshStandardMaterial({ color: 0x44484a, roughness: 0.55, metalness: 0.6, envMapIntensity: 0.3, side: THREE.DoubleSide }), 'attr'),
  lamp: exPatch(new THREE.MeshBasicMaterial({ color: 0xffffff }), 'inst')
};
// 승강장 구간(종류 글자 i·p 가 이어진 곳) [m0, m1, 섬식?]
function spans(k) {
  const L = LEG[k], out = [];
  for (let i = 0; i < L.n; i++) {
    const c = L.k[i];
    if (c !== 'i' && c !== 'p') continue;
    const l = out[out.length - 1];
    if (l && L.k[i - 1] === c) l[1] = L.m[i]; else out.push([L.m[i], L.m[i], c === 'i']);
  }
  return out;
}
const tunnelChunks = [], lampSets = [];
function tunnel(k) {
  const L = LEG[k], SP = spans(k);
  const trackOff = (m) => { let w = 0; for (const [a, b, isl] of SP) if (isl) w = Math.max(w, m >= a && m <= b ? 1 : ss(1 - (m < a ? a - m : m - b) / 40)); return 1.9 + 4.7 * w; };
  const cavern = (m) => SP.some(([a, b]) => m > a - 45 && m < b + 45);
  const S = samples(k, 0, L.len, 4).filter((p) => p.kind !== 's' && p.kind !== 'x');
  // 레일(승강장 구간도 이어서)
  for (let c = 0; c < S.length - 1; c += 100) {
    const part = S.slice(c, c + 101), grp = new THREE.Group();
    for (const side of [1, -1]) for (const r of [0.7175, -0.7175]) grp.add(new THREE.Mesh(sweep(part, RAIL, { so: (p) => side * trackOff(p.m) + r }), MAT.rail));
    addChunk(grp, part);
  }
  // 벽·바닥·케이블 받침·등(역 상자 밖)
  let run = [];
  const flush = () => {
    if (run.length > 1) for (let c = 0; c < run.length - 1; c += 100) {
      const part = run.slice(c, c + 101), grp = new THREE.Group();
      grp.add(new THREE.Mesh(sweep(part, LINING, { uScale: 4, vScale: 3 }), MAT.lining), new THREE.Mesh(sweep(part, BED, { uScale: 8.9, vScale: 2.4 }), MAT.bed));
      for (const side of [1, -1]) grp.add(new THREE.Mesh(sweep(part, TRAY, { so: () => side * 4.2 }), MAT.tray));
      addChunk(grp, part);
    }
    run = [];
  };
  S.forEach((p) => { if (cavern(p.m)) flush(); else run.push(p); });
  flush();
  // 벽 등: 양쪽 벽 3.6m 높이, 12m 마다 엇갈려
  const lamps = [];
  for (let m = 3; m < L.len; m += 6) {
    const s = smp(k, m);
    if (s.kind !== 't' || cavern(m)) continue;
    const a = smp(k, m - 2), b = smp(k, m + 2), dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1, side = (Math.round(m / 6) % 2) ? 1 : -1;
    lamps.push({ m, x: s.x + dy / l * 4.45 * side, y: s.y - dx / l * 4.45 * side, z: s.zr + 3.6, ang: Math.atan2(dy, dx) });
  }
  const box = new THREE.BoxGeometry(1.1, 0.12, 0.22), im = new THREE.InstancedMesh(box, MAT.lamp, Math.max(1, lamps.length)), mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), Y = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
  const base = new THREE.Color(COL.lamp).multiplyScalar(0.55);
  lamps.forEach((p, i) => { im.setMatrixAt(i, mtx.compose(new THREE.Vector3(p.x, p.z, -p.y), q.setFromAxisAngle(Y, p.ang), one)); im.setColorAt(i, base); });
  im.count = lamps.length; im.frustumCulled = false; scene.add(im);
  const set = { k, im, lamps, lvl: new Float32Array(lamps.length).fill(0.55), dead: null };
  lampSets.push(set);
  return set;
}
function addChunk(grp, part) {
  const a = part[0], b = part[part.length - 1], mid = part[part.length >> 1];
  grp.traverse((o) => { o.frustumCulled = false; });
  scene.add(grp);
  tunnelChunks.push({ grp, x: mid.x, y: mid.y, z: mid.z, r: Math.hypot(b.x - a.x, b.y - a.y) / 2 + 30, k: null });
}
const TUN = { ride1: tunnel('ride1'), blocked: tunnel('blocked'), ride2: tunnel('ride2') };

/* ---------- 8. 역(실제 크기, 개략): 승강장 상자 · 대합실 · 에스컬레이터(30°) · 출구 ----------
   상자 벽은 밖에서 안이 비치게 반투명. 승강장 높이(레일 + 1.1m)만 자료이고 나머지 크기는 개략이다 */
const SM = {
  cavern: new THREE.MeshStandardMaterial({ map: tileTex, color: 0xb8bebb, roughness: 0.5, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false, emissive: 0x2a3138, emissiveIntensity: 0.6, envMapIntensity: 0.15 }),
  slab: new THREE.MeshStandardMaterial({ color: 0x6c716e, roughness: 0.24, emissive: 0x2a2f31, envMapIntensity: 0.45 }),
  line: new THREE.LineBasicMaterial({ color: 0x9fc4c0, transparent: true, opacity: 0.4, depthWrite: false }),
  floor: new THREE.MeshStandardMaterial({ color: 0x3a3c3b, roughness: 0.6, envMapIntensity: 0.2 }),
  glass: new THREE.MeshStandardMaterial({ color: 0xa8dde8, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide }),
  edge: new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.9, 0.35) }),
  ceil: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.15, 1.2, 1.15) }),
  esc: new THREE.MeshStandardMaterial({ color: 0x7b8285, roughness: 0.35, metalness: 0.7, envMapIntensity: 0.6 }),
  rail: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 1.5, 1.4) }),
  exit: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 1.8, 0.7) })
};
const anchored = [];   // 기준 높이(해발 z)에 배율을 곱해 자리를 옮기는 묶음
const boxMesh = (w, h, d, mat, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); return m; };
// 상자 모서리 선(역 상자·대합실을 밖에서 볼 때 모양이 읽히게)
const boxEdges = (w, h, d, x, y, z) => { const l = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)), SM.line); l.position.set(x, y, z); return l; };
const stationGroups = [];
function anchorGroup(grp, x, y, z, ang, leg) {
  grp.rotation.y = ang; grp.userData = { x, y, z, leg };
  grp.position.set(x, z * ex(), -y);
  scene.add(grp); anchored.push(grp);
  return grp;
}
D.structs.forEach((s) => {
  const grp = new THREE.Group();
  if (s.k === 'plat') {
    const isl = s.form === '섬식', L = s.L, Lc = L + 90, hw = isl ? 9.8 : 8.8, H = 7.4, lc = new THREE.Color(LINE_COL[s.l] || COL.est).multiplyScalar(1.6);
    grp.add(boxMesh(Lc, H, hw * 2, SM.cavern, 0, H / 2 - 0.3, 0), boxEdges(Lc, H, hw * 2, 0, H / 2 - 0.3, 0), boxMesh(Lc, 0.1, hw * 2, SM.floor, 0, -0.32, 0));
    const plats = isl ? [[0, 10]] : [[5.6, 4], [-5.6, 4]];
    plats.forEach(([z, w]) => {
      grp.add(boxMesh(L, 1.4, w, SM.slab, 0, 0.4, z));
      for (const e of isl ? [-1, 1] : [z > 0 ? -1 : 1]) {
        const ez = z + e * (w / 2 - 0.15);
        grp.add(boxMesh(L, 0.02, 0.28, SM.edge, 0, 1.115, ez), boxMesh(L, 2.1, 0.05, SM.glass, 0, 2.15, z + e * (w / 2 - 0.02)));
      }
      for (const cz of isl ? [-2.6, 2.6] : [z]) grp.add(boxMesh(L, 0.06, 0.22, SM.ceil, 0, H - 0.75, cz));
    });
    for (const e of [-1, 1]) grp.add(boxMesh(Lc * 0.92, 0.4, 0.06, new THREE.MeshBasicMaterial({ color: lc }), 0, 3.0, e * (hw - 0.08)));
    stationGroups.push({ s, grp, lights: [-L / 3, 0, L / 3].map((t) => [t, H - 1.2]) });
  } else if (s.k === 'conc') {
    // 바닥판은 양 끝 에스컬레이터 꼭대기 사이만(그 밖은 에스컬레이터가 내려가는 구멍), 벽 상자는 12m 씩 더 길게
    grp.add(boxMesh(s.L, 4.2, s.W, SM.cavern, 0, 2.1, 0), boxEdges(s.L, 4.2, s.W, 0, 2.1, 0), boxMesh(Math.max(4, s.L - 24), 0.2, s.W, SM.slab, 0, -0.1, 0));
    for (const cz of [-s.W / 4, s.W / 4]) grp.add(boxMesh(s.L * 0.9, 0.05, 0.22, SM.ceil, 0, 3.95, cz));
    stationGroups.push({ s, grp, lights: [[-s.L / 4, 3.4], [s.L / 4, 3.4]] });
  } else if (s.k === 'exit') {
    grp.add(boxMesh(6, 0.15, 3.2, SM.slab, 0, 2.7, 0), boxMesh(6, 2.6, 0.05, SM.glass, 0, 1.3, 1.6), boxMesh(6, 2.6, 0.05, SM.glass, 0, 1.3, -1.6), boxMesh(0.6, 0.3, 3.0, SM.exit, -3, 2.95, 0));
  } else return;
  anchorGroup(grp, s.c[0], s.c[1], s.z, s.a, s.leg);
});
// 에스컬레이터: 아래 끝 a → 위 끝 b. 두 줄 + 손잡이 빛. 배율이 바뀌면 다시 놓는다(경사가 배율만큼 가팔라 보인다)
const escalators = D.structs.filter((s) => s.k === 'esc').map((s) => {
  const grp = new THREE.Group();
  for (const o of [-0.85, 0.85]) {
    grp.add(boxMesh(1, 0.9, 1.3, SM.esc, 0.5, -0.45, o));
    for (const h of [-0.68, 0.68]) grp.add(boxMesh(1, 0.06, 0.06, SM.rail, 0.5, 0.95, o + h));
  }
  grp.add(boxMesh(1, 3.4, 4.2, SM.glass, 0.5, 1.4, 0));
  scene.add(grp);
  return { s, grp, leg: s.leg };
});
const tv = new THREE.Vector3(), tv2 = new THREE.Vector3();
function placeEscalators() {
  for (const e of escalators) {
    const a = tv.set(e.s.a[0], e.s.a[2] * ex(), -e.s.a[1]), b = tv2.set(e.s.b[0], e.s.b[2] * ex(), -e.s.b[1]);
    const d = b.clone().sub(a), L = d.length();
    e.grp.position.copy(a);
    e.grp.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), d.normalize());
    e.grp.scale.set(L, 1, 1);
  }
}

/* ---------- 9. 한강 단면(땅 잘라 내기) ----------
   하저터널 두 곳: 카메라 쪽 땅·물을 상자 모양으로 잘라 내고, 터널 뒤 12m 에 세로 단면(지층 무늬)을 세운다.
   단면 위 끝 = 지반(강 위는 수면). 강 아래는 수면에서 8m 까지 물빛, 그 아래는 '자료 없음' 빗금(강바닥 깊이 자료가 없어서).
   땅은 깊이에 따라 메움흙 → 충적층 → 풍화암 → 기반암 무늬(그림, 자료 아님). */
const F = D.facts;
F.rides.forEach((r, i) => { if (r.t === 'transfer' && !r.a) r.a = r.b = F.rides[i - 1].b; });   // 환승 칸에는 역 이름이 없어 앞 칸의 도착역
const XF = F.rides.find((r) => r.t === 'transfer');   // 다시 찾은 길의 첫 환승(충정로): 역 구조를 실제 크기로 보여 준다
const crossPath = (parts) => parts.flatMap(([k, m0, m1]) => samples(k, Math.max(0, m0), Math.min(LEG[k].len, m1), 15));
const CROSS = {
  A: { parts: [['ride1', F.crossA.m[0] - 650, F.block_m], ['blocked', 0, LEG.blocked.len], ['rest', 0, F.crossA.m[1] - F.block_m + 650 - LEG.blocked.len]], m: F.crossA.m, leg: 'ride1', w: F.crossA.water, a: F.crossA.a, b: F.crossA.b },
  B: { parts: [['ride2', F.crossB.m[0] - 650, F.crossB.m[1] + 650]], m: F.crossB.m, leg: 'ride2', w: F.crossB.water, a: F.crossB.a, b: F.crossB.b }
};
const strataMat = (() => {
  const m = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  m.userData.key = 'strata';
  m.userData.more = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('void main() {', 'attribute float aTop;\nattribute float aWat;\nattribute float aAlong;\nvarying float vTop;\nvarying float vWat;\nvarying float vAlong;\nvarying float vY;\nvoid main() {\nvTop = aTop; vWat = aWat; vAlong = aAlong;')
      .replace('gl_Position = projectionMatrix * mvPosition;', 'gl_Position = projectionMatrix * mvPosition;\nvY = vElev * uEx;');
    sh.fragmentShader = sh.fragmentShader.replace('void main() {', `varying float vTop; varying float vWat; varying float vAlong; varying float vY;
      float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
      void main() {`).replace('vec4 diffuseColor = vec4( diffuse, opacity );', `
      vec3 c; float dep = vTop - vElev;
      float grain = 0.86 + 0.28 * fract(sin(dot(floor(vec2(vAlong * 0.35, vElev * 1.6)), vec2(12.9898, 78.233))) * 43758.5453);
      if (vWat > -900.0) {
        float wd = vWat - vElev;
        vec3 wc = mix(vec3(0.07, 0.24, 0.42), vec3(0.025, 0.07, 0.13), smoothstep(0.0, 8.0, wd));
        float hatch = step(0.86, fract((vAlong + vY) / 16.0));
        vec3 unk = mix(vec3(0.07, 0.085, 0.10), vec3(0.16, 0.19, 0.22), hatch);
        c = mix(wc, unk, smoothstep(6.0, 9.0, wd));
      } else {
        float n = vn(vec2(vAlong * 0.012, vElev * 0.05)) * 3.0 + vn(vec2(vAlong * 0.05, vElev * 0.2)) * 1.2;   // 지층 경계 흔들기(그림)
        float d = dep + n - 2.0;
        c = d < 3.0 ? vec3(0.30, 0.22, 0.15) : d < 12.0 ? vec3(0.44, 0.36, 0.24) : d < 24.0 ? vec3(0.33, 0.30, 0.27) : vec3(0.24, 0.25, 0.27);
        c *= grain;
        c = mix(c, c * 0.6, smoothstep(0.0, 1.0, (dep - 25.0) / 60.0));
      }
      c = mix(c, vec3(0.55, 0.9, 1.0), (1.0 - smoothstep(0.0, 0.6 / max(uEx, 1.0) * 6.0, abs(dep))) * 0.8);
      vec4 diffuseColor = vec4( c, opacity );`);
  };
  return exPatch(m, 'world');
})();
for (const C of Object.values(CROSS)) {
  const S = crossPath(C.parts);
  C.S = S;
  const a = wp(C.leg, C.m[0]), b = C.leg === 'ride1' ? wp('blocked', C.m[1] - F.block_m) : wp(C.leg, C.m[1]);
  C.c = new THREE.Vector3((a.x + b.x) / 2, 0, (a.z + b.z) / 2);
  C.u = new THREE.Vector3(b.x - a.x, 0, b.z - a.z); C.len = C.u.length(); C.u.normalize();
  C.nrm = new THREE.Vector3(-C.u.z, 0, C.u.x);
  C.zmin = Math.min(...S.map((p) => p.z));
  // 카메라 쪽: 1~3km 밖 지형이 낮은 쪽(산이 가리지 않게)
  const side = (s) => { let h = 0; for (let d = 800; d <= 3200; d += 400) for (let t = -1; t <= 1; t += 0.5) { const x = C.c.x + C.nrm.x * d * s + C.u.x * t * C.len / 2, z = C.c.z + C.nrm.z * d * s + C.u.z * t * C.len / 2; h = Math.max(h, th(x, -z)); } return h; };
  C.side = side(1) <= side(-1) ? 1 : -1;
  // 단면: 하저터널 양 끝을 이은 곧은 면(잘라 낸 상자의 뒷면, 선에서 12m 뒤). 위 끝 = 그 자리 지형(강 안이면 수면).
  // 양쪽 끝에는 카메라 쪽으로 꺾인 마구리(잘린 땅의 옆면). 곧은 면 뒤로 굽은 터널 부분은 빛줄(투시)로 보인다
  const bottom = C.zmin - 45, pos = [], top = [], wat = [], along = [], idx = [], half = C.len / 2 + 650;
  const push = (x, y, z, t, w, al) => { pos.push(x, y, z); top.push(t); wat.push(w); along.push(al); };
  const topAt = (x, y) => { const h = th(x, y); return h <= C.w - 0.5 ? [C.w, C.w] : [h, -999]; };   // 지형 격자는 강 안을 수면 − 1m 로 둔다
  const back = C.nrm.clone().multiplyScalar(-12 * C.side), n0 = Math.ceil(2 * half / 20);
  for (let i = 0; i <= n0; i++) {
    const a = -half + 2 * half * i / n0, x = C.c.x + C.u.x * a + back.x, z = C.c.z + C.u.z * a + back.z, [tp, w] = topAt(x, -z);
    push(x, bottom, z, tp, w, a); push(x, tp, z, tp, w, a);
    if (i) idx.push(2 * i - 2, 2 * i - 1, 2 * i, 2 * i - 1, 2 * i + 1, 2 * i);
  }
  for (const e of [-1, 1]) {
    const base = pos.length / 3;
    for (let d = 0; d <= 40; d++) {
      const dist = -12 + d * 60, x = C.c.x + C.u.x * e * half + C.nrm.x * dist * C.side, z = C.c.z + C.u.z * e * half + C.nrm.z * dist * C.side, [tp, w] = topAt(x, -z);
      push(x, bottom, z, tp, w, d * 60); push(x, tp, z, tp, w, d * 60);
      if (d) { const q = base + 2 * d; idx.push(q - 2, q - 1, q, q - 1, q + 1, q); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aTop', new THREE.Float32BufferAttribute(top, 1)); g.setAttribute('aWat', new THREE.Float32BufferAttribute(wat, 1)); g.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1));
  g.setIndex(idx);
  C.curtain = new THREE.Mesh(g, strataMat); C.curtain.frustumCulled = false; C.curtain.visible = false;
  scene.add(C.curtain);
  C.cut = { half, lat: 6000 };
}

/* ---------- 10. 걷는 사람 ----------
   실제 크기 사람(1.7m) + 발밑 빛 + 작은 빛(벽을 비춘다). 멀리서는 화면 크기가 같은 빛점 */
const person = new THREE.Group();
const bodyMat = new THREE.MeshStandardMaterial({ color: 0xe8f1ef, emissive: new THREE.Color(COL.safe), emissiveIntensity: 0.55, roughness: 0.5 });
const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.21, 1.05, 4, 10), bodyMat); body.position.y = 0.75;
const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10), bodyMat); head.position.y = 1.58;
const foot = new THREE.Mesh(new THREE.CircleGeometry(1.4, 24), new THREE.MeshBasicMaterial({ map: dotTex, color: HDR(COL.safe, 1.2), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
foot.rotation.x = -Math.PI / 2; foot.position.y = 0.03;
const pLight = new THREE.PointLight(0xbff6ff, 6, 14, 1.6); pLight.position.y = 1.3;
const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: HDR(COL.safe, 1.4), blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, sizeAttenuation: false }));
halo.scale.setScalar(0.06); halo.position.y = 1;
person.add(body, head, foot, pLight, halo);
scene.add(person);
// 터널 등 빛: 걷는 사람 앞뒤 등 자리에 점광원 몇 개(high 4개, low 1개)
const lampLights = Array.from({ length: 4 }, (_, i) => { const l = new THREE.PointLight(0xffd9a6, 0, 30, 1.7); l.visible = TIER === 'high' || i === 0; scene.add(l); return l; });

/* ---------- 11. 공습경보 · 무너짐 ----------
   공습경보: 거리의 빨간 고리 · 멀리 몇 번 번쩍임 · 부드러운 연기(점 묶음). 폭발·사람 피해는 그리지 않는다.
   무너짐: 막힌 곳 앞 천장에서 덩어리가 떨어지고(실제 크기 0.2~1.1m) 먼지가 퍼진 뒤 잔해 더미가 남는다. 그 둘레 등은 깜빡이다 꺼진다 */
const softMat = (color, opacity) => new THREE.ShaderMaterial({
  uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uMap: { value: smokeTex }, uCol: { value: new THREE.Color(color) }, uA: { value: opacity }, uScale: { value: 400 } }]),
  vertexShader: `attribute float aSize; attribute float aAlpha; varying float vA; uniform float uScale;
    #include <fog_pars_vertex>
    void main() { vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;
      gl_PointSize = aSize * uScale / max(-mvPosition.z, 0.1); vA = aAlpha;
      #include <fog_vertex>
    }`,
  fragmentShader: `uniform sampler2D uMap; uniform vec3 uCol; uniform float uA; varying float vA;
    #include <fog_pars_fragment>
    void main() { float a = texture2D(uMap, gl_PointCoord).a * vA * uA; if (a < 0.003) discard; gl_FragColor = vec4(uCol, a);
      #include <fog_fragment>
    }`,
  transparent: true, depthWrite: false, fog: true
});
const softMats = [];
function particles(n, mat) {
  softMats.push(mat);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(n), 1)); g.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(n), 1));
  const p = new THREE.Points(g, mat); p.frustumCulled = false; scene.add(p);
  return p;
}
const raid = (() => {
  const g = new THREE.Group(), DUR = 6;
  scene.add(g); g.visible = false;
  const ring = () => { const m = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 64), new THREE.MeshBasicMaterial({ color: HDR(COL.expo, 1.6), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })); m.rotation.x = -Math.PI / 2; g.add(m); return m; };
  const rings = [ring(), ring(), ring()];
  const flashes = [[-50, 2600, 0.6], [25, 3200, 1.6], [60, 2800, 2.9], [-15, 3500, 4.1]].map(([deg, d, t0]) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: new THREE.Color(1.6, 0.9, 0.45), blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));
    sp.scale.set(900, 500, 1); g.add(sp); return { sp, deg, d, t0 };
  });
  // 연기 기둥 세 곳(각 40점): 천천히 오르며 퍼지고 옅어진다
  const plumes = [[-38, 900], [6, 1100], [40, 750]], N = 40, smoke = particles(plumes.length * N, softMat(0x4a4642, 0.55));
  const seeds = Array.from({ length: plumes.length * N }, () => [rnd(), rnd(), rnd(), rnd()]);
  let placed = false, base = new THREE.Vector3(), fwd = 0;
  function place() {   // 공습경보가 시작될 때 한 번: 카메라가 보는 쪽 너머에 놓는다(화면에 들어오게)
    const f = new THREE.Vector3().subVectors(camTgt, camera.position).setY(0).normalize();
    fwd = Math.atan2(f.x, -f.z); wp('enter', 0, base);
    placed = true;
  }
  const at = (deg, d) => { const a = fwd + deg * Math.PI / 180; return [base.x + Math.sin(a) * d, base.z - Math.cos(a) * d]; };
  return {
    update(tr) {   // tr = 공습경보 시작 뒤 초(아직이면 음수)
      const on = tr >= 0 && tr < DUR + 2;
      g.visible = smoke.visible = on;
      if (!on) { if (tr < 0) placed = false; return; }
      if (!placed) place();
      const env = ss(tr / 0.8) * ss((DUR + 2 - tr) / 2), gy = th(base.x, -base.z) * ex();
      rings.forEach((m, i) => { const ph = (((tr - i * 0.5) % 1.5) + 1.5) % 1.5 / 1.5; m.position.set(base.x, gy + 3, base.z); m.scale.setScalar(40 + 420 * ph); m.material.opacity = (1 - ph) * 0.9 * env * (tr < DUR ? 1 : 0); });
      flashes.forEach((k) => { const [x, z] = at(k.deg, k.d); k.sp.position.set(x, th(x, -z) * ex() + 60, z); const u = (tr - k.t0) / 0.9; k.sp.material.opacity = u > 0 && u < 1 ? Math.sin(u * Math.PI) * 0.55 : 0; });
      const P = smoke.geometry.attributes.position.array, Sz = smoke.geometry.attributes.aSize.array, A = smoke.geometry.attributes.aAlpha.array;
      plumes.forEach(([deg, d], pi) => {
        const [x, z] = at(deg, d), y0 = th(x, -z) * ex();
        for (let i = 0; i < N; i++) {
          const k = pi * N + i, s = seeds[k], life = 5 + s[0] * 3, age = ((tr * 0.9 + s[1] * life) % life), u = age / life;
          P[k * 3] = x + (s[2] - 0.5) * 160 + u * 260; P[k * 3 + 1] = y0 + 30 + u * 900; P[k * 3 + 2] = z + (s[3] - 0.5) * 160 - u * 90;
          Sz[k] = 120 + u * 520; A[k] = Math.sin(u * Math.PI) * env * (tr > s[1] * 2 ? 1 : 0);
        }
      });
      smoke.geometry.attributes.position.needsUpdate = smoke.geometry.attributes.aSize.needsUpdate = smoke.geometry.attributes.aAlpha.needsUpdate = true;
    }
  };
})();
const collapse = (() => {
  const N = 70, chunks = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: 0x8c8a84, roughness: 0.9, flatShading: true }), N);
  const grp = new THREE.Group(); grp.add(chunks); scene.add(grp);
  const B = smp('blocked', 0), dB = hdir('blocked', 8), ang = Math.atan2(-dB.z, dB.x);
  grp.rotation.y = ang;
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), e = new THREE.Euler(), s3 = new THREE.Vector3(), mtx = new THREE.Matrix4(), c = new THREE.Color();
  // 덩어리: 막힌 곳 앞 2~18m(그룹 x 축 = 진행 방향), 가운데 높게 쌓인다(최고 약 3m)
  const parts = Array.from({ length: N }, (_, i) => {
    const along = 2 + 16 * rnd(), side = (rnd() - 0.5) * 7.6, size = i < 12 ? 0.6 + rnd() * 0.5 : 0.2 + rnd() * 0.4;
    const mound = 3.0 * Math.exp(-(((along - 9) / 6) ** 2)) * Math.max(0, 1 - Math.abs(side) / 4.6);
    c.setHSL(0.08, 0.06, 0.38 + rnd() * 0.2); chunks.setColorAt(i, c);
    return { x: along, z: side, top: 6.6 - rnd() * 0.6, rest: -0.1 + size * 0.5 + mound * rnd(), delay: rnd() * 0.9, size, sx: 0.6 + rnd() * 0.8, sy: 0.5 + rnd() * 0.6, rx: rnd() * 6, ry: rnd() * 6 };
  });
  const dust = particles(60, softMat(0x9d9282, 0.42)), dd = Array.from({ length: 60 }, () => [rnd() - 0.2, rnd() * 0.8, rnd() - 0.5, rnd()]);
  chunks.visible = dust.visible = false; chunks.frustumCulled = false;
  return {
    B, ang,
    update(tc) {   // tc = 무너짐 시작 뒤 초(아직이면 음수)
      const on = tc >= 0;
      grp.position.set(B.x, B.zr * ex(), -B.y);
      chunks.visible = on;
      if (!on) { dust.visible = false; return; }
      if (tc < 3.2 || !grp.userData.done) {
        parts.forEach((k, i) => {
          const u = Math.max(0, tc - k.delay), y = Math.max(k.rest, k.top - 0.5 * 9.8 * u * u);
          p.set(k.x, y, k.z); q.setFromEuler(e.set(k.rx + Math.min(u, 1.2) * 3, k.ry + Math.min(u, 1.2) * 2, 0)); s3.set(k.size * k.sx, k.size * k.sy, k.size).multiplyScalar(ss(u / 0.1));
          chunks.setMatrixAt(i, mtx.compose(p, q, s3));
        });
        chunks.instanceMatrix.needsUpdate = true;
        grp.userData.done = tc >= 3.2;
      }
      dust.visible = tc < 5;
      if (dust.visible) {
        const P = dust.geometry.attributes.position.array, Sz = dust.geometry.attributes.aSize.array, A = dust.geometry.attributes.aAlpha.array, r = 2 + 22 * ss(tc / 2.5);
        const ca = Math.cos(ang), sa = Math.sin(ang);
        dd.forEach((d, i) => {
          const lx = 9 + d[0] * r * (d[3] > 0.5 ? 1.6 : -1.2), ly = 0.5 + d[1] * Math.min(6.2, 1 + r * 0.4), lz = d[2] * 8.5;
          P[i * 3] = B.x + lx * ca + lz * sa; P[i * 3 + 1] = B.zr * ex() + ly; P[i * 3 + 2] = -B.y - lx * sa + lz * ca;
          Sz[i] = 1.5 + r * 0.16; A[i] = ss(tc / 0.25) * (1 - ss((tc - 0.8) / 3.2));
        });
        dust.geometry.attributes.position.needsUpdate = dust.geometry.attributes.aSize.needsUpdate = dust.geometry.attributes.aAlpha.needsUpdate = true;
      }
    }
  };
})();
// 막힘 표시: 빨간 원 안의 X(전체·단면 장면에서만)
const blockMark = (() => {
  const t = canvasTex(128, 128, (x) => { x.strokeStyle = '#FF5A36'; x.lineWidth = 10; x.lineCap = 'round'; x.beginPath(); x.arc(64, 64, 52, 0, Math.PI * 2); x.stroke(); x.beginPath(); x.moveTo(40, 40); x.lineTo(88, 88); x.moveTo(88, 40); x.lineTo(40, 88); x.stroke(); }, true);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, sizeAttenuation: false, color: new THREE.Color(1.4, 1.4, 1.4) }));
  s.scale.setScalar(0.07); s.renderOrder = 8; scene.add(s); return s;
})();

/* ---------- 12. 이름표(끌어 낸 선 + 겹침 피하기) ---------- */
setTitle(F.start, F.end);
function setTitle(a, b) { document.title = `지하로 3D · ${a} → ${b}`; $('title').textContent = document.title; }
const labelsEl = $('labels'), lead = $('lead'), lctx = lead.getContext('2d'), labels = [];
// anchor: () => Vector3(지금 배율의 장면 좌표). vis(시계) 가 거짓이면 숨김. maxD: 카메라가 이보다 멀면 숨김. minD: 이보다 가까우면 숨김
function label(text, anchor, { cls = '', vis = null, pri = 0, maxD = Infinity, minD = 0 } = {}) {
  const el = document.createElement('div'); el.className = 'lb ' + cls; el.textContent = text; el.style.display = 'none';
  labelsEl.appendChild(el); labels.push({ el, anchor, vis, pri, maxD, minD, on: false, w: 0, h: 0 });
}
const EV = { raid: Infinity, block: Infinity, reveal: Infinity, south: Infinity };
const st = (n, l) => D.stations.find((s) => s.n === n && (!l || s.l === l));
const lineCount = (n) => new Set(D.stations.filter((s) => s.n === n && ['enter', 'ride1', 'blocked', 'ride2'].includes(s.leg)).map((s) => s.l)).size;
const KEY = new Set([F.start, F.crossA.a, F.crossA.b, F.crossB.a, F.crossB.b, F.end, ...F.rides.filter((r) => r.t === 'transfer').map((r) => r.a)]);
{
  const seen = new Set(), seenName = new Set();
  // 멀리서도 보일 역: 출발·도착·하저터널 양 끝(그 노선)
  const ENDS = new Set([F.start + '|', F.end + '|', ...[F.crossA, F.crossB].flatMap((c) => [c.a + '|' + c.line, c.b + '|' + c.line])]);
  D.stations.filter((s) => ['ride1', 'blocked', 'ride2'].includes(s.leg)).forEach((s) => {
    const key = s.n + '|' + s.l;
    if (seen.has(key)) return; seen.add(key);
    const later = s.leg === 'ride2' && !D.stations.some((o) => o.n === s.n && o.leg !== 'ride2' && o.leg !== 'rest' && o.leg !== 'south');
    const depth = s.pd != null ? s.pd : s.d;
    const text = s.n + (lineCount(s.n) > 1 ? ' ' + s.l : '') + (depth == null ? '' : s.src === '공식' ? ` · 승강장 깊이 ${fm(depth)}` : ` · 깊이 약 ${Math.round(depth)}m(추정)`);
    const end = ENDS.has(s.n + '|' + s.l) || (ENDS.has(s.n + '|') && !seenName.has(s.n)), xf = KEY.has(s.n);
    seenName.add(s.n);
    label(text, () => wp(s.leg, s.m, tv, 12), { cls: s.src === '공식' ? '' : 'est', vis: later ? (c) => c >= EV.reveal : null, pri: end ? 2 : xf ? 1.5 : 1, maxD: end ? 40000 : xf ? 9000 : 3500 });
  });
}
D.structs.filter((s) => s.k === 'conc').forEach((s) => label(`${s.n} 대합실 · 지하 1층(추정)`, () => tv.set(s.c[0], s.z * ex() + 5, -s.c[1]), { cls: 'est', vis: s.leg === 'ride2' ? (c) => c >= EV.reveal : null, maxD: 420 }));
label(`${F.start}역 ${F.exit_ref}번 출구`, () => wp('enter', EL.expo, tv, 4), { pri: 2, maxD: 9000 });
label('공습경보', () => wp('enter', 0, tv, 20), { cls: 'red', vis: (c) => c >= EV.raid && c < EV.raid + 7, pri: 3 });
for (const C of Object.values(CROSS)) {
  const mid = C.m[0] + (C.m[1] - C.m[0]) * 0.5, legM = C.leg === 'ride1' && mid > F.block_m ? ['blocked', mid - F.block_m] : [C.leg, mid];
  label(`한강 수면 해발 ${C.w}m(SRTM) · 강바닥 깊이 자료 없음`, () => { const s = smp(...legM); return tv.set(s.x, ((s.w || C.w) - 10) * ex(), -s.y); }, { cls: 'est', vis: () => U.uCutOn.value > 0.5 && cutNow === C, pri: 2 });
  label('지층 무늬는 그림(자료 아님)', () => { const s = smp(C.leg, C.m[0] - 520); return tv.set(s.x, (s.zr - 32) * ex(), -s.y); }, { cls: 'dim', vis: () => U.uCutOn.value > 0.5 && cutNow === C, pri: 0 });
}
label('한강', () => { const r = D.river.line.reduce((b, p) => (Math.abs(p[0] - CROSS.A.c.x - 1500) < Math.abs(b[0] - CROSS.A.c.x - 1500) ? p : b)); return tv.set(r[0], r[2] * ex(), -r[1]); }, { cls: 'river', pri: 1, minD: 1500 });
label('막힘', () => { const s = smp('blocked', 8); return tv.set(s.x, s.zr * ex() + 10, -s.y); }, { cls: 'red', vis: (c) => c >= EV.block + 1.5, pri: 3 });
label(`처음 길 ${km(F.first_m)}`, () => wp('rest', LEG.rest.len * 0.5, tv, 30), { cls: 'dim', pri: 1, minD: 3000 });
const SF = F.south;
label(`남쪽으로도 지하: ${F.end} → ${SF.to} ${km(SF.total_m)}`, () => wp('south', LEG.south.len * 0.55, tv, 30), { vis: (c) => c >= EV.south, pri: 3 });
D.structs.filter((s) => s.k === 'esc' && !/출구/.test(s.n) && (s.n === F.start || s.n === XF.a)).filter((s, i, a) => a.findIndex((o) => o.n === s.n) === i).forEach((s) => label('에스컬레이터 30°(개략)', () => tv.set((s.a[0] + s.b[0]) / 2, (s.a[2] + s.b[2]) / 2 * ex() + 3, -(s.a[1] + s.b[1]) / 2), { cls: 'dim', maxD: 160, minD: 8 }));

/* ---------- 13. 혼자 재생: 움직임과 장면(카메라) 목록 ----------
   움직임 = { b: 자막 묶음, leg, m0, m1, sec, shot }. 사람의 m 은 3차 에르미트(양 끝 속도 이어짐)로 정한다.
   장면(shot)은 14절의 카메라 자리. 장면이 바뀌면 카메라·배율·안개를 부드럽게 섞는다 */
const A = F.crossA.m, B = F.crossB.m, endM = LEG.ride2.len;
const g1 = st(F.start, '5호선');
const W0 = (C) => C.w;
const depthRange = (C) => { const z = C.S.filter((p) => p.w != null).map((p) => p.w - p.z); return z.length ? `${Math.round(Math.min(...z))}~${Math.round(Math.max(...z))}m` : '-'; };
const BEATS = {
  raid: { cap: `공습경보 · ${F.story_label}`, sub: `가장 가까운 지하로: ${F.start}역 ${F.exit_ref}번 출구 · 지상 ${F.expo_m}m` },
  enter: { cap: '출구로 들어가 지하 승강장까지', sub: `대합실(지하 1층, 개략) → 에스컬레이터 → 5호선 승강장 깊이 ${fm(g1.pd)}(서울교통공사)` },
  go: { cap: '지하 승강장 도착 · 가족 약속 장소로', sub: `${F.end}역까지 지하로 ${km(F.first_m)}` },
  crossA: { cap: `한강 아래 하저터널: ${F.crossA.a} → ${F.crossA.b}`, sub: `수면(SRTM ${W0(CROSS.A)}m)에서 레일까지 ${depthRange(CROSS.A)} · 강바닥 깊이 자료 없음` },
  block: { cap: '하저터널 막힘', sub: `${F.crossA.a}역까지 ${F.backtrack_m}m 되돌아가 다시 찾기` },
  reroute: { cap: `한강 아래 다른 하나, ${F.crossB.a}–${F.crossB.b}로`, sub: `${F.crossB.line} · ${km(F.total2_m)} · 지상 노출 ${F.second_expo_m}m` },
  xfer: { cap: `${XF.a} 환승: 승강장 → 대합실 → 승강장`, sub: '승강장 높이는 서울교통공사 자료 · 대합실·에스컬레이터(30°)는 개략' },
  ff: { cap: `빨리 감기 · ${F.crossB.a}역까지`, sub: `${F.crossA.a}에서 남은 ${km(F.left_m)}보다 ${km(F.total2_m - F.left_m)} 더` },
  crossB: { cap: `한강 아래 하저터널: ${F.crossB.a} → ${F.crossB.b}`, sub: `수면(SRTM ${W0(CROSS.B)}m)에서 레일까지 ${depthRange(CROSS.B)} · 서울에서 한강을 지하로만 건너는 곳은 5호선 하저터널 두 곳` },
  arrive: { cap: `${F.end}역 도착`, sub: `지하에 들어간 뒤 지상 노출 ${F.exposed_after_m}m` },
  south: { cap: '남쪽으로도 지하로 이어진다', sub: `${F.end} → ${SF.to} ${km(SF.total_m)} · 지상 ${SF.expo_m}m` }
};
const BLK = F.block_m - 2;   // 혼자 재생에서 사람이 멈추는 곳(무너지는 곳 바로 앞)
const MOVES = [];
let TOTAL = 0;
[
  ['raid', 'enter', 0, 0, RM ? 5 : 6.5, 'open'],
  ['enter', 'enter', 0, EL.expo, 4.5, 'street'],
  ['enter', 'enter', EL.expo, EL.len, 6, 'station'],
  ['enter', 'enter', EL.len, EL.len, 2.2, 'platform'],
  ['go', 'ride1', 0, F.mapo_m - 120, 3.2, 'chase'],
  ['crossA', 'ride1', F.mapo_m - 120, A[0] + 260, 4.5, 'cutA'],
  ['crossA', 'ride1', A[0] + 260, BLK - 230, 4.2, 'chase'],
  ['block', 'ride1', BLK - 230, BLK, 3, 'collapse'],
  ['block', 'ride1', BLK, BLK, 3.4, 'collapse'],
  ['block', 'ride1', BLK, BLK, 1.8, 'cutA'],
  ['block', 'ride1', BLK, F.mapo_m, 4, 'cutA'],
  ['reroute', 'ride2', 0, 0, 3.6, 'overAll'],
  ['reroute', 'ride2', 0, XF.m0 - 140, 3.4, 'follow'],
  ['xfer', 'ride2', XF.m0 - 140, XF.m1 + 90, 6.5, 'xfer'],
  ['ff', 'ride2', XF.m1 + 90, B[0] - 450, 6, 'follow'],
  ['crossB', 'ride2', B[0] - 450, B[0] + 300, 4.5, 'cutB'],
  ['crossB', 'ride2', B[0] + 300, B[1] - 300, 4.2, 'chase'],
  ['crossB', 'ride2', B[1] - 300, B[1] + 220, 3, 'cutB'],
  ['arrive', 'ride2', B[1] + 220, endM, 5, 'follow'],
  ['arrive', 'ride2', endM, endM, 3, 'overAll'],
  ['south', 'ride2', endM, endM, 5.5, 'overSouth']
].forEach(([b, leg, m0, m1, sec, shot]) => { if (RM && shot === 'chase') shot = b === 'go' ? 'follow' : b === 'crossA' ? 'cutA' : 'cutB'; MOVES.push({ b, leg, m0, m1, sec, shot, t0: TOTAL }); TOTAL += sec; });
MOVES.forEach((mv, i) => {
  const v = (x) => (x ? (x.m1 - x.m0) / x.sec : 0), a = MOVES[i - 1], b = MOVES[i + 1], me = v(mv);
  const edge = (o) => (o && o.leg === mv.leg && v(o) * me > 0 ? Math.sign(me) * Math.min(Math.abs(v(o)), Math.abs(me)) : 0);
  mv.v0 = edge(a); mv.v1 = edge(b);
});
const beatT = (id) => MOVES.find((m) => m.b === id).t0;
const SOLO_EV = { raid: 1.2, block: MOVES.find((m) => m.b === 'block').t0 + 2.4, reveal: beatT('reroute'), south: beatT('south') };
if (!FOLLOW) Object.assign(EV, SOLO_EV);
function moveAt(t) {
  let mv = MOVES[MOVES.length - 1];
  for (const x of MOVES) if (t < x.t0 + x.sec) { mv = x; break; }
  const s = clamp((t - mv.t0) / mv.sec, 0, 1), s2 = s * s, s3 = s2 * s;
  return { mv, m: (s3 - 2 * s2 + s) * mv.sec * mv.v0 + (-2 * s3 + 3 * s2) * (mv.m1 - mv.m0) + (s3 - s2) * mv.sec * mv.v1 + mv.m0 };
}

/* ---------- 10'. 무대(?follow): 앱 시연 메시지로 움직인다 ----------
   - 걷는 점: 받은 m 에서 v × 지난 시간만큼 앞으로 예측하되 이번 걷기가 멈출 곳(to)을 넘지 않는다.
     메시지가 올 때 생기는 어긋남(보이던 m - 새 m)은 따로 두고 0.1초 남짓에 걸쳐 줄인다. 0.4초 넘게 메시지가 없으면 더 예측하지 않는다.
   - 앱 구간 → 3D 구간: entry → enter, first → ride1, reroute → ride2. 거리(m)는 build_3d.js 가 앱 길 안내와 같은 거리로 만들어 그대로 쓴다.
   - backtrack(되돌아가기)은 앱이 걷지 않으므로 3D 가 무너짐을 보여 준 뒤 3초 동안 막힌 곳 → 마포로 되돌아간다.
   - 장면 이름(id)과 사람 자리로 카메라 장면을 고른다(followShot). 빨리 넘긴 장면 다음은 짧게 섞는다 */
const LEG_OF = { entry: 'enter', first: 'ride1', reroute: 'ride2' };
const W = { leg: 'enter', m: 0, shown: 0, corr: 0, v: 0, vEff: 0, to: 0, at: 0, back: null, scene: 'save', sceneN: 0, sceneAt: 0, backEnd: 0, xferSeen: false, xferUntil: 0 };
const syncLog = [];
const wall = () => performance.now() / 1000;
function onDemo(d) {
  if (d.type === 'scene') {
    W.scene = d.id || ''; W.sceneN = d.n; W.sceneAt = wall();
    if (d.scenario !== 1) { W.scene = 'arrive'; return; }   // 다른 시나리오(부산 등)는 3D 가 없다: 전체 보기만
    if (d.n <= 2 && !d.again) { Object.assign(EV, { raid: Infinity, block: Infinity, reveal: Infinity, south: Infinity }); Object.assign(W, { leg: 'enter', m: 0, shown: 0, v: 0, back: null, backEnd: 0, xferSeen: false, xferUntil: 0 }); }
    if (d.id === 'raid' && EV.raid === Infinity) EV.raid = wall();
    if (d.id === 'south' && EV.south === Infinity) EV.south = wall();
  } else if (d.type === 'leg') {
    if (d.leg === 'backtrack') {
      if (EV.block === Infinity) EV.block = wall() + 1.2;                // 카메라가 터널 안 막힌 곳 앞에 자리 잡은 뒤 무너진다
      if (!W.back && !d.again) W.back = { t0: wall() + 4.4 };            // 무너짐을 본 뒤 되돌아간다
    } else if (LEG_OF[d.leg] && LEG_OF[d.leg] !== W.leg) {
      W.leg = LEG_OF[d.leg]; W.m = W.shown = 0; W.v = 0;
      if (d.leg === 'reroute' && EV.reveal === Infinity) { EV.reveal = wall(); if (EV.block === Infinity) EV.block = wall(); }
    }
  } else if (d.type === 'pos') {
    const leg = LEG_OF[d.leg];
    if (!leg) return;
    if (d.v > 0 && W.back) { W.back = null; W.backEnd = wall(); }                                        // 앱이 다시 걷기 시작하면 되돌아가기 그림은 끝
    const before = person.position.clone();
    if (leg !== W.leg) { W.leg = leg; W.shown = d.m; }
    const now = wall(), gap = now - W.at;
    W.vEff = leg === W.leg && d.v > 0 && W.v > 0 && gap > 0.05 ? Math.min(d.v, Math.max(0, (d.m - W.m) / gap) * 1.1) : d.v;
    W.corr = Math.abs(W.shown - d.m) > 1500 ? 0 : W.shown - d.m;
    Object.assign(W, { m: d.m, v: d.v, to: d.to, at: now });
    if (d.lat != null) {   // 맞춰 보기: 앱 추정 위치와 3D 의 같은 m 자리 · 지금 보이는 점 자리의 수평 거리(m)
      const LAT0 = D.origin[0], LON0 = D.origin[1], x = (d.lon - LON0) * 111320 * Math.cos(LAT0 * Math.PI / 180), y = (d.lat - LAT0) * 110540, s = smp(leg, d.m);
      syncLog.push({ sc: W.scene, leg: d.leg, m: Math.round(d.m), v: Math.round(d.v), align: Math.round(Math.hypot(s.x - x, s.y - y)), shown: Math.round(Math.hypot(before.x - x, -before.z - y)) });
      if (syncLog.length > 5000) syncLog.shift();
    }
  } else if (d.type === 'state' && !d.playing) W.v = 0;
}
if (FOLLOW) {
  addEventListener('message', (ev) => { const d = ev.data; if (ev.source === parent && d && d.src === 'jiharo-demo') onDemo(d); });
  addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'ArrowRight') { e.preventDefault(); parent.postMessage({ src: 'jiharo-3d', type: 'key', key: e.key }, location.origin); } });
}
function followWalker(dt) {
  if (W.back) {
    const k = ss((wall() - W.back.t0) / 3);
    if (k < 1) return { leg: 'ride1', m: F.block_m + (F.mapo_m - F.block_m) * k, dir: -1 };
    W.back = null; W.backEnd = wall();
  }
  const pred = W.v > 0 ? Math.min(Math.max(W.to, W.m), W.m + W.vEff * Math.min(wall() - W.at, 0.4)) : W.m;
  W.corr *= Math.exp(-dt * 10);
  W.shown = pred + W.corr;
  return { leg: W.leg, m: W.shown, dir: 1 };
}
// 무대 장면 → 카메라 장면
const XFS = F.rides.filter((r) => r.t === 'transfer');
function followShot(leg, m) {
  const sc = W.scene, v = W.v;
  switch (sc) {
    case 'save': case 'raid': return 'open';
    case 'nearest': return 'nearest';
    case 'enter': return leg === 'enter' && m < EL.expo ? 'street' : 'station';
    case 'platform': return 'platform';
    case 'plan': return 'overFirst';
    case 'guide': return leg === 'ride1' && m > 25 ? 'chase' : 'platform';
    case 'crossA': return !RM && leg === 'ride1' && m > A[0] + 220 && m < F.block_m - 120 ? 'chase' : 'cutA';   // 하저터널 가운데쯤에서 터널 안으로 들어갔다 나온다
    case 'block': return W.back && wall() > W.back.t0 - 0.4 ? 'cutA' : wall() < EV.block + 3.4 ? (RM ? 'cutA' : 'collapse') : 'cutA';
    case 'reroute': case 'ff': {
      if (W.back) return 'cutA';                                                       // 되돌아가는 중: 단면
      if (sc === 'reroute' && wall() - Math.max(W.sceneAt, W.backEnd) < 3.2) return 'overAll';   // 다시 찾은 길 전체
      if (wall() < W.xferUntil) return 'xfer';
      // 첫 환승역(충정로)을 지날 때 한 번: 3.6초 동안 역 구조를 보여 준다(빨리 감기라 사람은 금방 지나간다)
      if (leg === 'ride2' && m > XF.m0 - 120 && !W.xferSeen) { W.xferSeen = true; xferNow = XF.a; W.xferUntil = wall() + 3.6; return 'xfer'; }
      return 'follow';
    }
    case 'crossB': { const k = (m - B[0]) / (B[1] - B[0]); return !RM && leg === 'ride2' && k > 0.3 && k < 0.7 ? 'chase' : 'cutB'; }   // 첫 하저터널과 같은 짜임
    case 'arriveFf': return 'follow';
    case 'arrive': return 'overAll';
    case 'south': return 'overSouth';
    default: return 'overAll';
  }
}

/* ---------- 14. 카메라 장면 ----------
   장면 = 배율(ex) · 안개(fog) · 단면(cut) · 자리(pose: 카메라 자리와 보는 곳). 자리는 지금 배율로 계산한다.
   바뀔 때: 바로 전 카메라 자리에서 새 장면 자리로 1.6초(빨리 넘긴 장면 다음은 0.6초) 동안 섞고, 배율·안개도 같이 바꾼다.
   터널 안 장면은 사람이 지나온 길 위(뒤 7m)에 카메라를 둬서 벽을 뚫지 않는다. 땅 위 장면은 늘 지형보다 위에 둔다 */
let xferNow = XF.a, cutNow = null;   // 지금 보여 주는 환승역 · 단면
const camTgt = new THREE.Vector3(), camPos = new THREE.Vector3();
const V = () => new THREE.Vector3();
const sph = (tgt, r, polar, az) => V().setFromSphericalCoords(r, polar, az).add(tgt);
const fitDist = (w, h) => { const vf = camera.fov * Math.PI / 180, hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect); return Math.max(w / 2 / Math.tan(hf / 2), h / 2 / Math.tan(vf / 2)); };
// 상자(구간 점)들의 가운데·크기(지금 배율)
function boxOf(keys) {
  const b = new THREE.Box3();
  keys.forEach((k) => { const L = LEG[k]; for (let i = 0; i < L.n; i += 3) b.expandByPoint(tv.set(L.x[i], L.z[i] * ex(), -L.y[i])); });
  return b;
}
const BOXK = { overFirst: ['enter', 'ride1', 'blocked', 'rest'], overAll: ['enter', 'ride1', 'blocked', 'rest', 'ride2'], overSouth: ['enter', 'ride1', 'blocked', 'rest', 'ride2', 'south'] };
function overview(id) {
  const b = boxOf(BOXK[id]), c = b.getCenter(V()), s = b.getSize(V());
  c.y = 0;
  const r = fitDist(s.x * 1.12, s.z * 0.8) + 1500;
  return { pos: sph(c, r, 0.62, 0), tgt: c };
}
const SHOT = {
  open: { ex: EX, fog: 2.2e-5, pose: (w, tau) => { const t = wp('enter', 0); t.y = th(t.x, -t.z) * ex(); return { tgt: t, pos: sph(t, 3600, 0.98, -0.75 + (RM ? 0 : tau * 0.022)) }; } },
  nearest: { ex: EX, fog: 3e-5, pose: (w, tau) => { const t = wp('enter', EL.expo); return { tgt: t, pos: sph(t, 1300, 0.95, -0.55 + (RM ? 0 : tau * 0.02)) }; } },
  // 거리: 사람 뒤 위에서(배율은 전체 장면과 같게, 땅속으로 들어갈 때 1배로 바뀐다)
  street: { ex: EX, fog: 1.2e-4, pose: (w) => { const d = hdir(w.leg, w.m), t = wp(w.leg, w.m, V(), 1.2); return { tgt: t, pos: t.clone().addScaledVector(d, -170).add(V().set(d.z, 0, -d.x).multiplyScalar(-70)).setY(t.y + 150) }; } },
  // 역 안(입구): 역 옆 땅 밑에서 실제 크기로. 사람(출구 → 대합실 → 에스컬레이터 → 승강장)을 따라 카메라 높이도 내려간다
  station: { ex: 1, fog: 1.5e-3, pose: (w) => {
    const P = D.structs.find((s) => s.leg === 'enter' && s.k === 'plat') || D.structs.find((s) => s.k === 'plat'), d = V().set(Math.cos(P.a), 0, -Math.sin(P.a)), n = V().set(-d.z, 0, d.x);
    const c = V().set(P.c[0], P.z * ex(), -P.c[1]), p = wp(w.leg, w.m), t = p.clone().lerp(c, 0.35);
    const r = 72 * Math.max(1, 0.9 / camera.aspect), ex2 = D.structs.find((s) => s.k === 'exit');
    if (ex2 && n.dot(V().set(ex2.c[0] - P.c[0], 0, -(ex2.c[1] - P.c[1]))) < 0) n.negate();   // 출구 쪽에서 본다
    return { tgt: t, pos: t.clone().addScaledVector(n, r).addScaledVector(d, -r * 0.25).setY(t.y + 2.5) };   // 거의 같은 높이에서: 상자 옆벽 너머로 승강장이 보인다
  } },
  platform: { ex: 1, fog: 3e-3, pose: () => { const s = smp('ride1', 0), d = hdir('ride1', 6), r = V().set(d.z, 0, -d.x), c = V().set(s.x, s.z * ex(), -s.y); return { pos: c.clone().addScaledVector(d, -58).addScaledVector(r, 3.2).setY(c.y + 2.6), tgt: c.clone().addScaledVector(d, 25).setY(c.y + 1.0) }; } },
  chase: { ex: 1, fog: 6e-3, pose: (w) => ({ pos: wp(w.leg, w.m - 7 * w.dir, V(), 1.9), tgt: wp(w.leg, w.m + 30 * w.dir, V(), 1.5) }) },
  // 무너짐: 사람 뒤(막힌 곳 14m 앞까지 따라감)에서 막힌 곳 앞 7m 천장 쪽을 본다
  collapse: { ex: 1, fog: 5e-3, pose: (w) => { const mm = Math.min(w.leg === 'ride1' ? w.m : F.block_m, F.block_m - 4); return { pos: wp('ride1', mm - 10, V(), 2.1), tgt: wp('blocked', 7, V(), 2.4) }; } },
  cutA: { ex: EX, fog: 3.2e-5, cut: 'A', pose: (w, tau) => cutPose(CROSS.A, w, tau) },
  cutB: { ex: EX, fog: 3.2e-5, cut: 'B', pose: (w, tau) => cutPose(CROSS.B, w, tau) },
  xfer: { ex: 1, fog: 1.6e-3, pose: () => xferPose(xferNow) },
  // 따라가기: 진행 방향 옆(지금 카메라가 있는 쪽)에서 비스듬히
  follow: { ex: EX, fog: 3e-5, pose: (w) => { const t = wp(w.leg, w.m), d = hdir(w.leg, w.m), r = V().set(-d.z, 0, d.x); if (V().subVectors(camPos, camTgt).dot(r) < 0) r.negate(); r.multiplyScalar(0.8).add(V().set(0, 0, 0.6)).normalize(); return { tgt: t, pos: sph(t, 2800 * Math.max(1, 1.3 / camera.aspect), 0.9, Math.atan2(r.x, r.z)) }; } },
  overFirst: { ex: EX, fog: 1.2e-5, pose: () => overview('overFirst') },
  overAll: { ex: EX, fog: 1.1e-5, pose: () => overview('overAll') },
  overSouth: { ex: EX, fog: 0.9e-5, pose: () => overview('overSouth') }
};
// 단면 장면: 하저터널 옆(산이 없는 쪽)에서 거의 수평으로. 사람이 건너는 중이면 보는 곳을 사람 쪽으로 조금 당긴다
function cutPose(C, w, tau) {
  const span = C.len + 700, mid = ((C.w + C.zmin) / 2) * ex();
  const d = fitDist(camera.aspect < 1 ? span * 0.55 : span, (C.w - C.zmin + 40) * ex() * 2.6);   // 세로 화면은 가운데만
  const t = C.c.clone().setY(mid);
  if (w && (w.leg === C.leg || (C.leg === 'ride1' && w.leg === 'blocked'))) { const p = wp(w.leg, w.m); t.x = lerp(t.x, p.x, 0.3); t.z = lerp(t.z, p.z, 0.3); }
  const drift = RM ? 0 : Math.sin(tau * 0.12) * 0.06;
  const dir = C.nrm.clone().multiplyScalar(C.side).applyAxisAngle(V().set(0, 1, 0), drift);
  return { tgt: t, pos: t.clone().addScaledVector(dir, d).setY(mid + d * 0.1) };
}
// 환승역 장면: 그 역 구조(승강장 둘·대합실·에스컬레이터)를 땅 밑 옆에서 실제 크기로. 선로 방향에 수직으로 보고, 역 상자 끝까지 다 들어오게
function xferPose(name) {
  const S = D.structs.filter((s) => s.n === name && s.leg === 'ride2' && (s.k === 'plat' || s.k === 'conc'));
  const P = S.filter((s) => s.k === 'plat'), a = P.length ? P[0].a : 0, ax = V().set(Math.cos(a), 0, -Math.sin(a)), n = V().set(-ax.z, 0, ax.x);
  const b = new THREE.Box3();
  let lo = Infinity, hi = -Infinity;
  S.forEach((s) => {
    const half = (s.k === 'plat' ? s.L + 90 : s.L) / 2, d = V().set(Math.cos(s.a), 0, -Math.sin(s.a));
    for (const e of [-1, 1]) { const p = V().set(s.c[0], s.z * ex(), -s.c[1]).addScaledVector(d, e * half); b.expandByPoint(p); const q = p.dot(ax); lo = Math.min(lo, q); hi = Math.max(hi, q); }
  });
  const c = b.getCenter(V()), r = Math.min(420, fitDist((camera.aspect < 1 ? 0.55 : 0.82) * (hi - lo), b.getSize(V()).y * 2.4));   // 세로 화면은 가운데 위주
  if (n.dot(V().subVectors(camPos, c)) < 0) n.negate();
  const pos = c.clone().addScaledVector(n, r).addScaledVector(ax, -r * 0.18), g = Math.min(th(c.x, -c.z), th(pos.x, -pos.z)) * ex();   // 카메라 자리 지형 아래로
  return { tgt: c, pos: pos.setY(Math.min(c.y + r * 0.2, g - 4)) };
}
const rig = { id: null, t0: -1e9, dur: 0, from: null, last: -1e9 };
let snap = true;
function useShot(id, now) {
  if (id === rig.id) return;
  const quick = now - rig.t0 < 1.4;
  rig.from = { pos: camPos.clone(), tgt: camTgt.clone(), ex: ex(), fog: scene.fog.density };
  rig.fromCut = rig.id && SHOT[rig.id] ? SHOT[rig.id].cut : null;
  rig.id = id; rig.t0 = now;
  rig.dur = snap || RM ? 0 : quick ? 0.6 : id === 'chase' || rig.prevInside ? 1.8 : 1.6;
  rig.prevInside = id === 'chase' || id === 'collapse';
}
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

/* ---------- 15. 그리기 ---------- */
let t = 0, playing = !FOLLOW, lastBeat = '', lastWhere = '', userUntil = 0;
const ICON = { play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg>', pause: '<svg viewBox="0 0 24 24"><path d="M7 4.5h3.5v15H7zM13.5 4.5H17v15h-3.5z" fill="currentColor"/></svg>' };
function setPlaying(p) { playing = p; $('play').innerHTML = p ? ICON.pause : ICON.play; $('play').setAttribute('aria-label', p ? '멈춤' : '재생'); }
function seek(x) { t = clamp(x, 0, TOTAL); snap = true; userUntil = 0; rig.id = null; }
$('play').onclick = () => { if (!playing && t >= TOTAL) seek(0); setPlaying(!playing); };
$('restart').onclick = () => { seek(0); setPlaying(true); };
const bar = $('bar');
bar.onpointerdown = (e) => { const r = bar.getBoundingClientRect(); seek((e.clientX - r.left) / r.width * TOTAL); };
bar.onkeydown = (e) => { if (e.key === 'ArrowRight') seek(t + 5); if (e.key === 'ArrowLeft') seek(t - 5); };
if (!FOLLOW) addEventListener('keydown', (e) => { if (e.key === ' ' && e.target === document.body) { e.preventDefault(); $('play').click(); } });
// 사용자가 화면을 돌리면 8초 동안은 손으로 보기(보는 곳은 사람을 따라감), 그 뒤 다시 영상 카메라로
controls.addEventListener('start', () => { userUntil = wall() + 8; });
setPlaying(!FOLLOW);
const fmt = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

function resize() {
  const w = innerWidth, h = innerHeight, pr = PR();
  renderer.setPixelRatio(pr); renderer.setSize(w, h, false); camera.aspect = w / h;
  if (composer) { composer.setPixelRatio(pr); composer.setSize(w, h); }
  softMats.forEach((m) => { m.uniforms.uScale.value = h * pr / 2 / Math.tan(camera.fov * Math.PI / 360); });
  lead.width = w * devicePixelRatio; lead.height = h * devicePixelRatio; lead.style.width = w + 'px'; lead.style.height = h + 'px';
  // 좁은 화면(혼자 재생): 아래 자막 칸에 가리지 않게 그림 가운데를 자막 칸 높이의 절반만큼 위로
  if (w < 900 && !FOLLOW) camera.setViewOffset(w, h, 0, document.querySelector('.panel').offsetHeight * 0.5, w, h); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

function lowMat(m) {
  if (m.userData.lowM) return m.userData.lowM;
  const o = new THREE.MeshLambertMaterial({ color: m.color, map: m.map, side: m.side, transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite, emissive: m.emissive, vertexColors: m.vertexColors });
  if (m.onBeforeCompile && m.customProgramCacheKey) { o.onBeforeCompile = m.onBeforeCompile; o.customProgramCacheKey = () => 'L' + m.customProgramCacheKey(); o.userData = { ...m.userData }; }
  m.userData.lowM = o;
  return o;
}
function setTier(tier) {
  if (tier === 'low') scene.traverse((o) => { if (o.isMesh && o.material && o.material.isMeshStandardMaterial && o !== water) o.material = lowMat(o.material); });
  TIER = tier; window.__ride.tier = tier; window.__ride.lq = tier === 'low';
  lampLights.forEach((l, i) => { l.visible = tier === 'high' || i === 0; });
  if (tier === 'low') { composer = null; bloom = null; } else if (!composer) makeComposer();
  resize();
}
const ui = { cap: $('cap'), sub: $('sub'), where: $('where'), prog: $('prog'), time: $('time'), depth: $('depth'), exag: $('exag') };
const PROF = { render: 0, js: 0, n: 0 };
let frames = 0, fpsT = 0, slow = 0, lastT = performance.now(), shake = 0, lastEx = -1;
const tmp = V(), tmp2 = V();

function frame() {
  const nowMs = performance.now(), realDt = (nowMs - lastT) / 1000, dt = Math.min(0.05, realDt);
  lastT = nowMs;
  U.uTime.value += dt;
  if (playing && !FOLLOW) { t += dt; if (t >= TOTAL) { t = TOTAL; setPlaying(false); } }
  const now = FOLLOW ? wall() : t;      // 사건 시각을 재는 시계(무대 = 실제 시계, 혼자 = 재생 시각)

  // 걷는 사람과 장면
  let leg, m, dir, shotId, mv = null;
  if (FOLLOW) { ({ leg, m, dir } = followWalker(dt)); shotId = followShot(leg, m); }
  else { ({ mv, m } = moveAt(t)); leg = mv.leg; dir = mv.m1 >= mv.m0 ? 1 : -1; shotId = mv.shot; if (shotId === 'xfer') xferNow = XF.a; }
  const shot = SHOT[shotId];
  const tShot = FOLLOW ? wall() : t;
  // 섞기: 무대는 바뀐 순간의 카메라 자리에서(useShot), 혼자 재생은 앞 장면의 지금 자리에서 섞는다(시각만으로 정해져서 되감아도 같다)
  let prev = null, tau, w;
  if (FOLLOW) { useShot(shotId, tShot); tau = tShot - rig.t0; w = rig.dur > 0 ? ease(clamp(tau / rig.dur, 0, 1)) : 1; }
  else {
    const i = MOVES.indexOf(mv); let j = i;
    while (j > 0 && MOVES[j - 1].shot === shotId) j--;
    const p = j > 0 ? MOVES[j - 1].shot : null, dur = RM || !p ? 0 : shotId === 'chase' || p === 'chase' || p === 'collapse' ? 1.8 : 1.6;
    tau = t - MOVES[j].t0; w = dur ? ease(clamp(tau / dur, 0, 1)) : 1;
    if (w < 1) prev = SHOT[p];
    rig.id = shotId; rig.from = null;
  }
  // 배율(장면 사이를 섞음) → 배율이 바뀌면 자리를 다시 놓는 것들
  U.uEx.value = prev ? lerp(prev.ex, shot.ex, w) : rig.from && w < 1 ? lerp(rig.from.ex, shot.ex, w) : shot.ex;
  if (Math.abs(ex() - lastEx) > 1e-4) {
    lastEx = ex();
    for (const g of anchored) g.position.y = g.userData.z * ex();
    placeEscalators();
  }
  const walker = { leg, m, dir };
  const pose = shot.pose(walker, tau);
  const from = prev ? Object.assign(prev.pose(walker, tau + 5), { fog: prev.fog }) : rig.from && w < 1 ? rig.from : null;
  if (from) { camPos.lerpVectors(from.pos, pose.pos, w); camTgt.lerpVectors(from.tgt, pose.tgt, w); }
  else { camPos.copy(pose.pos); camTgt.copy(pose.tgt); }
  scene.fog.density = from ? Math.exp(lerp(Math.log(from.fog), Math.log(shot.fog), w)) : shot.fog;
  // 땅 위 장면: 카메라를 지형보다 위로(단면 상자 안·땅 밑 장면은 빼고)
  if (ex() > 1.5 && !shot.cut) { const gy = th(camPos.x, -camPos.z) * ex() + 60; if (camPos.y < gy) camPos.y = gy; }
  // 단면: 장면이 단면이면 켜고(1초), 아니면 끈다
  // 단면: 이 장면이 단면이거나, 단면 장면에서 섞어 오는 중이면 켠다(1초에 걸쳐). 되감기(snap)는 바로
  const cutId = shot.cut || (w < 1 && (prev ? prev.cut : rig.fromCut)) || null, C = cutId ? CROSS[cutId] : null;
  if (C) cutNow = C;
  U.uCutOn.value = snap ? (C ? 1 : 0) : clamp(U.uCutOn.value + (C ? dt : -dt), 0, 1);
  if (cutNow) {
    U.uCutC.value.set(cutNow.c.x, cutNow.c.z, cutNow.u.x, cutNow.u.z);
    U.uCutS.value.set(cutNow.cut.half, Math.max(cutNow.cut.lat, camPos.distanceTo(camTgt) + 2000), cutNow.side, 20);   // 카메라까지 다 잘라 낸다
    for (const X of Object.values(CROSS)) X.curtain.visible = X === cutNow && U.uCutOn.value > 0.01;
    if (U.uCutOn.value === 0) cutNow = null;
  } else for (const X of Object.values(CROSS)) X.curtain.visible = false;

  // 사람
  const s = smp(leg, m);
  person.position.set(s.x, s.z * ex(), -s.y);
  const hd = hdir(leg, m); person.rotation.y = Math.atan2(-hd.z * dir, hd.x * dir) - Math.PI / 2;
  const moving = FOLLOW ? W.v > 0 || !!W.back : mv.m1 !== mv.m0;
  body.position.y = 0.75 + (moving && !RM ? Math.abs(Math.sin(nowMs / 160)) * 0.04 : 0);
  const street = s.kind === 's';
  halo.material.color.copy(street ? C_EXPO : HDR(COL.safe, 1.4));
  foot.material.color.copy(street ? C_EXPO : HDR(COL.safe, 1.2));
  const camD = camPos.distanceTo(camTgt);
  halo.visible = ex() > 1.6 || camD > 60;
  body.visible = head.visible = camD < 900;

  // 사건: 공습경보 · 무너짐 · 다시 찾은 길 · 남쪽
  raid.update(now - EV.raid);
  collapse.update(now - EV.block);
  const blocked = now >= EV.block + 1.2;
  blockMark.visible = now >= EV.block + 1.8 && ex() > 2;
  if (blockMark.visible) { const b = smp('blocked', 4); blockMark.position.set(b.x, b.zr * ex() + 30 * ex(), -b.y); }
  GL.blocked.set(blocked ? C_EXPO : C_SAFE);
  GL.rest.set(blocked ? C_GRAY : HDR(COL.safe, 0.9));
  GL.ride2.a = ss((now - EV.reveal) / 1.2);
  GL.south.a = ss((now - EV.south) / 1.2);
  // 빛줄 굵기: 카메라 거리 × 0.0011(멀리서 약 2화소), 가까이는 0.08m
  glowR.value = clamp(camD * 0.0019, 0.08, 70);
  const inside = ex() < 2;
  for (const gl of glows) {
    gl.solid.material.opacity = gl.a; gl.solid.visible = gl.a > 0.01;
    gl.xr.material.opacity = gl.base * gl.a * clamp((ex() - 1.5) / 2, 0, 1); gl.xr.visible = gl.xr.material.opacity > 0.005;
  }
  const near2 = (p) => p.distanceTo(camPos) < 2500;   // 역 구조는 실제 크기라 멀면 그리지 않는다
  for (const g of anchored) g.visible = (g.userData.leg !== 'ride2' || now >= EV.reveal) && near2(g.position);
  for (const e of escalators) e.grp.visible = (e.leg !== 'ride2' || now >= EV.reveal) && near2(e.grp.position);

  // 터널 덩어리: 카메라 가까운 것만(실제 크기라 멀면 안 보인다)
  const lod = inside ? 420 : TIER === 'low' ? 900 : 1600;   // 터널 안은 안개로 400m 밖이 안 보인다
  for (const c of tunnelChunks) { const dx = c.x - camPos.x, dz = -c.y - camPos.z, dy = c.z * ex() - camPos.y; c.grp.visible = Math.hypot(dx, dy, dz) < lod + c.r; }
  lightLamps(leg, m, now, inside);
  // 역 점광원: 카메라 가까운 역 천장(터널 등과 함께 4개까지)
  cityLights.material.size = clamp(camD * 0.004, 1.5, 22);   // 불빛 크기(m): 멀리서도 몇 화소, 가까이서는 작게
  // 카메라가 지면보다 8m 넘게 아래(터널·역 안, 땅 밑 단면)면 지형·물·바탕 선·불빛·다른 구간 빛줄을 그리지 않는다(어차피 안 보인다)
  const under = camPos.y < th(camPos.x, -camPos.z) * ex() - 8 && !C;
  for (const o of surface) o.visible = !under;
  for (const gl of glows) if (under && gl.k !== leg) gl.solid.visible = false;

  // 카메라: 사용자가 돌리는 중이면 보는 곳만 사람을 따라간다
  if (wall() < userUntil) {
    const dlt = tmp.copy(person.position).sub(controls.target);
    controls.target.add(dlt); camera.position.add(dlt); controls.update();
    camPos.copy(camera.position); camTgt.copy(controls.target);
  } else {
    // 흔들림(무너짐 직후 짧게)
    shake = !RM && now >= EV.block && now < EV.block + 1.6 && ex() < 2 ? (1 - (now - EV.block) / 1.6) * 0.09 : 0;
    camera.position.copy(camPos);
    if (shake) camera.position.add(tmp.set(Math.sin(nowMs / 23) * shake, Math.sin(nowMs / 31) * shake, Math.cos(nowMs / 27) * shake));
    controls.target.copy(camTgt);
    camera.lookAt(camTgt);
  }
  rig.last = tShot; snap = false;
  const cd = camera.position.distanceTo(camTgt);
  const near = clamp(cd * 0.003, 0.05, 40), far = Math.max(6000, cd * 16);
  if (Math.abs(camera.near - near) / near > 0.05 || camera.far !== far) { camera.near = near; camera.far = far; camera.updateProjectionMatrix(); }

  const r0 = performance.now();
  if (composer) composer.render(); else renderer.render(scene, camera);
  PROF.render += performance.now() - r0; PROF.js += r0 - nowMs; PROF.n++;
  placeLabels(cd, now, inside);
  showDepth(s, leg, m, street, inside);
  const exText = ex() < 1.05 ? '실제 비율(×1)' : `높이 ×${ex() < EX - 0.05 ? ex().toFixed(1) : EX}`;
  if (ui.exag.textContent !== exText) ui.exag.textContent = exText;

  if (!FOLLOW) {
    if (mv.b !== lastBeat) { lastBeat = mv.b; ui.cap.textContent = BEATS[mv.b].cap; ui.sub.textContent = BEATS[mv.b].sub; }
    const fast = Math.abs(mv.m1 - mv.m0) / mv.sec > 400;
    const wt = whereText(mv, m, s) + (fast ? '|ff' : '');
    if (wt !== lastWhere) { lastWhere = wt; ui.where.innerHTML = (fast ? '<span class="ff">빨리 감기</span>' : '') + '<span></span>'; ui.where.lastChild.textContent = wt.replace('|ff', ''); }
    ui.prog.style.width = (t / TOTAL * 100).toFixed(2) + '%';
    bar.setAttribute('aria-valuenow', Math.round(t / TOTAL * 100));
    ui.time.textContent = fmt(t) + ' / ' + fmt(TOTAL);
  }
  // 1초 평균 fps. 30 아래가 3초 이어지면 가벼운 단계로
  frames++; fpsT += realDt;   // fps 는 실제 시간으로(dt 는 느린 프레임에서 0.05초로 자른 값)
  if (fpsT >= 1) {
    const fps = frames / fpsT;
    window.__ride.fps = Math.round(fps); window.__ride.fpsLog.push(Math.round(fps)); if (window.__ride.fpsLog.length > 30) window.__ride.fpsLog.shift();
    slow = fps < (TIER === 'high' ? 30 : 18) ? slow + 1 : 0;
    if (slow >= 3 && TIER === 'high' && !HOLD) { setTier('low'); slow = 0; }
    else if (slow >= 4 && TIER === 'low' && lowPR > 0.6) { lowPR = Math.max(0.5, lowPR * 0.7); window.__ride.pr = lowPR; resize(); slow = 0; }
    frames = 0; fpsT = 0;
  }
}
// 터널 등: 걷는 사람 앞뒤 150m 는 밝게(움직임 감지 등처럼), 그 밖은 어둡게. 무너진 곳 둘레는 깜빡이다 꺼진다
const lampCol = new THREE.Color(), warm = new THREE.Color(COL.lamp);
function lightLamps(leg, m, now, inside) {
  const tc = now - EV.block, cand = [];
  for (const L of lampSets) {
    let changed = false;
    const near = L.k === leg ? m : null;
    for (let i = 0; i < L.lamps.length; i++) {
      const p = L.lamps[i];
      let lv = near == null ? 0.35 : 0.35 + 0.95 * ss(1 - Math.abs(p.m - near) / 150);
      const deadZone = (L.k === 'blocked' && p.m < 45) || (L.k === 'ride1' && p.m > LEG.ride1.len - 20);
      if (deadZone && tc >= 0) lv = tc < 0.9 ? lv * (Math.sin(tc * 40 + i) > 0 ? 1 : 0.1) : 0;
      if (L.k === 'ride2' && now < EV.reveal) lv = 0.35;
      if (Math.abs(lv - L.lvl[i]) < 0.02) continue;
      L.lvl[i] = lv; changed = true;
      L.im.setColorAt(i, lampCol.copy(warm).multiplyScalar(lv * 2.2));
    }
    if (changed) L.im.instanceColor.needsUpdate = true;
    L.im.visible = inside || ex() < 3;
    if (near != null && inside) for (let i = 0; i < L.lamps.length; i++) { const d = Math.abs(L.lamps[i].m - near); if (d < 40 && L.lvl[i] > 0.5) cand.push([d, L.lamps[i]]); }
  }
  // 점광원: 사람 가까운 등 자리(high 4 · low 1). 역 안이면 가까운 역 천장
  if (inside) for (const sg of stationGroups) {
    if (!sg.grp.visible) continue;
    const g = sg.grp, d0 = Math.hypot(g.position.x - person.position.x, g.position.z - person.position.z);
    if (d0 > 160) continue;
    for (const [lx, ly] of sg.lights) { const c = Math.cos(g.rotation.y), sn = Math.sin(g.rotation.y); cand.push([d0 * 0.5, { x: g.position.x + lx * c, zz: g.position.z - lx * sn, y: g.position.y + ly, st: true }]); }
  }
  cand.sort((a, b) => a[0] - b[0]);
  const n = TIER === 'low' ? 1 : 4;
  lampLights.forEach((l, i) => {
    const c = cand[i];
    if (!c || i >= n) { l.intensity = 0; return; }
    const p = c[1];
    if (p.st) { l.position.set(p.x, p.y, p.zz); l.intensity = 26; l.distance = 55; }
    else { l.position.set(p.x, p.z * ex(), -p.y); l.intensity = 22; l.distance = 30; }
  });
}
// 지금 어디인지 한 줄(혼자 재생)
function whereText(mv, m, s) {
  if (mv.b === 'raid') return `${F.story_label} · 거리`;
  if (mv.leg === 'enter') return m < EL.expo ? `지상 걷기 ${Math.round(m)}m / ${F.expo_m}m` : '출구 → 대합실 → 에스컬레이터 → 승강장';
  if (mv.leg === 'ride1') return mv.m1 < mv.m0 ? `되돌아가는 중 · ${F.crossA.a}역까지 ${Math.round(m - F.mapo_m)}m` : `5호선 · ${F.start} → ${F.crossA.a} → ${F.crossA.b} 방면`;
  let i = F.rides.findIndex((x) => m < x.m1);
  if (i < 0) i = F.rides.length - 1;
  const r = F.rides[i];
  const headTxt = r.t === 'transfer' ? `${F.rides[i - 1].b} 환승 · ${F.rides[i - 1].label} → ${F.rides[i + 1].label}` : `${r.label} · ${r.a} → ${r.b}`;
  return `${headTxt} · ${km(m)} / ${km(endM)}`;
}
// 깊이 읽기: 사람 옆에 작게. 승강장이면 그 역 자료 값, 터널이면 지반(강 아래는 수면)에서 레일까지
let lastDepth = '';
function showDepth(s, leg, m, street, inside) {
  let text = '';
  if (/^(open|nearest|over)/.test(rig.id)) text = '';
  else if (street) text = '지상';
  else if (s.kind === 'x') text = `역 안 · 지면 아래 약 ${Math.max(0, Math.round(s.g - s.z))}m(개략)`;
  else if (s.kind === 'i' || s.kind === 'p') {
    const sta = D.stations.filter((x) => x.leg === leg).reduce((b, x) => (Math.abs(x.m - m) < Math.abs(b.m - m) ? x : b), { m: Infinity });
    text = sta.n ? `${sta.n} 승강장 ${sta.src === '공식' ? '깊이 ' + fm(sta.pd) + '(서울교통공사)' : '깊이 약 ' + Math.round(sta.pd || sta.d) + 'm(추정)'}` : '';
  } else if (s.w != null) text = `한강 수면 아래 약 ${Math.round(s.w - s.zr)}m(수면 SRTM) · 강바닥 자료 없음`;
  else text = `지면 아래 약 ${Math.round(s.g - s.zr)}m · 역 사이는 추정`;
  if (text !== lastDepth) { lastDepth = text; ui.depth.textContent = text; ui.depth.hidden = !text; }
  if (!text) return;
  tmp.copy(person.position).setY(person.position.y + (inside ? 1.8 : 0)).project(camera);
  const x = clamp((tmp.x + 1) / 2 * innerWidth + 16, 6, innerWidth - ui.depth.offsetWidth - 6), y = clamp((1 - tmp.y) / 2 * innerHeight - 10, 40, innerHeight - 30);
  ui.depth.style.visibility = tmp.z < 1 ? 'visible' : 'hidden';
  ui.depth.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
}
// 이름표 놓기: 앞쪽·거리 조건에 맞는 것을 우선순위·가까운 순으로. 기준점 위(또는 옆·아래)에 겹치지 않는 자리를 찾고 끌어 낸 선을 긋는다
const placed = [];
let uiRects = [];
function measureUi() { uiRects = ['.top h1', '.top p', '.panel', '.top a'].map((q) => document.querySelector(q)).filter((el) => el && el.offsetParent !== null).map((el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }); }
addEventListener('resize', () => setTimeout(measureUi, 50)); setTimeout(measureUi, 300);
function placeLabels(cd, clockT, inside) {
  const W2 = innerWidth, H = innerHeight, cand = [], dpr = devicePixelRatio;
  for (const L of labels) {
    let ok = (!L.vis || L.vis(clockT));
    if (ok) {
      const v = L.anchor(); tmp2.copy(v).project(camera);
      const far = camera.position.distanceTo(v);
      ok = tmp2.z < 1 && Math.abs(tmp2.x) < 1.05 && Math.abs(tmp2.y) < 1.05 && far < L.maxD && far > L.minD && (!inside || far < 300);
      if (ok) cand.push({ L, x: (tmp2.x + 1) / 2 * W2, y: (1 - tmp2.y) / 2 * H, far });
    }
    if (!ok && L.on) { L.el.style.display = 'none'; L.on = false; }
  }
  cand.sort((a, b) => b.L.pri - a.L.pri || a.far - b.far);
  placed.length = 0;
  placed.push(...uiRects);   // 위 안내 글·아래 자막 칸 자리에는 놓지 않는다
  lctx.setTransform(dpr, 0, 0, dpr, 0, 0); lctx.clearRect(0, 0, W2, H);
  lctx.lineWidth = 1; lctx.strokeStyle = 'rgba(200,230,226,0.55)'; lctx.fillStyle = 'rgba(220,240,236,0.9)';
  for (const c of cand.slice(0, 14)) {
    const L = c.L;
    if (!L.on) { L.el.style.display = ''; L.on = true; L.w = 0; }
    if (!L.w) { L.w = L.el.offsetWidth || 60; L.h = L.el.offsetHeight || 20; }
    let r = null;
    for (const [ox, oy] of [[0, -34], [-0.6, -30], [0.6, -30], [0, 30], [-0.7, 0], [0.7, 0], [0, -62]]) {
      const x0 = clamp(c.x - L.w / 2 + ox * (L.w / 2 + 14), 6, W2 - L.w - 6), y0 = clamp(c.y + oy - (oy <= 0 ? L.h : 0), 6, H - L.h - 6);
      const q = [x0, y0, x0 + L.w, y0 + L.h];
      if (!placed.some((p) => q[0] < p[2] + 4 && q[2] > p[0] - 4 && q[1] < p[3] + 3 && q[3] > p[1] - 3)) { r = q; break; }
    }
    if (!r) { L.el.style.display = 'none'; L.on = false; continue; }
    placed.push(r);
    L.el.style.transform = `translate(${r[0].toFixed(1)}px, ${r[1].toFixed(1)}px)`;
    // 끌어 낸 선: 기준점 → 이름표의 가까운 변 가운데
    const ex2 = clamp(c.x, r[0] + 4, r[2] - 4), ey2 = c.y < r[1] ? r[1] : c.y > r[3] ? r[3] : (r[1] + r[3]) / 2;
    if (Math.hypot(ex2 - c.x, ey2 - c.y) > 6) { lctx.beginPath(); lctx.moveTo(c.x, c.y); lctx.lineTo(ex2, ey2); lctx.stroke(); }
    lctx.beginPath(); lctx.arc(c.x, c.y, 2, 0, Math.PI * 2); lctx.fill();
  }
  for (const L of labels) if (L.on && !cand.slice(0, 14).some((c) => c.L === L)) { L.el.style.display = 'none'; L.on = false; }
}

window.__ride = {
  seek: (x) => { seek(x); setPlaying(false); }, play: () => setPlaying(true), total: TOTAL, fps: 0, lq: TIER === 'low', tier: TIER, follow: FOLLOW,
  beats: Object.keys(BEATS).filter((b) => MOVES.some((m) => m.b === b)).map((b) => ({ id: b, cap: BEATS[b].cap, sub: BEATS[b].sub, t: beatT(b) })),
  moves: MOVES.map((m) => ({ b: m.b, shot: m.shot, t0: m.t0, sec: m.sec })),
  sync: syncLog, setTier, fpsLog: [], pr: PR(),
  walker: () => ({ scene: W.scene, leg: W.leg, m: Math.round(W.shown), rx: Math.round(W.m), v: Math.round(W.v), ve: Math.round(W.vEff), to: Math.round(W.to), corr: Math.round(W.corr), back: !!W.back, shot: rig.id, ex: +ex().toFixed(2) }),
  prof: () => { const o = { js: +(PROF.js / PROF.n).toFixed(1), render: +(PROF.render / PROF.n).toFixed(1), calls: renderer.info.render.calls, tris: renderer.info.render.triangles, pts: renderer.info.render.points }; PROF.js = PROF.render = PROF.n = 0; return o; },
  shown: () => labels.filter((l) => l.on).map((l) => l.el.textContent), ex: () => ex(), shot: () => rig.id
};
if (TIER === 'low') setTier('low');   // ?lq: 처음부터 가벼운 재질
renderer.setAnimationLoop(frame);
if (FOLLOW) parent.postMessage({ src: 'jiharo-3d', type: 'hello' }, location.origin);   // 무대에 '지금 상태를 다시 보내 달라'
