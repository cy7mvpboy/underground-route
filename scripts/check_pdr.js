// check_pdr.js — 걸음 세기·보폭 보정·센서 연결(web/js/pdr.js)을 합성 가속도 신호로 확인한다.
// 사용법(프로젝트 폴더에서): node scripts\check_pdr.js
//   실제 녹화 자료는 쓰지 않았다(내려받기 승인 없음). 아래 신호는 모두 이 파일이 만든 합성 신호다:
//   걸음마다 위아래 가속도 봉우리(발 디딤)와 골, 잡음, 폰 방향(손: 화면 위, 주머니: 세로)과 흔들림.
//   기대와 다르면 NG 를 찍고 종료 코드 1.
'use strict';
const path = require('path');
const PDR = require(path.join(__dirname, '..', 'web/js/pdr.js'));

const G = 9.81;
let allOk = true;
const ok = (cond, msg) => { if (!cond) { allOk = false; console.log('  NG ' + msg); } return cond; };

// ---------- 합성 신호 ----------
function rng(seed) {   // mulberry32: 같은 씨앗이면 같은 신호
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
const bell = (x, s) => Math.exp(-x * x / (2 * s * s));

// 폰 방향: 세계(옆, 앞, 위) → 폰(x, y, z) 회전. roll·pitch·yaw(라디안)
function rot(roll, pitch, yaw) {
  const [cr, sr, cp, sp, cy, sy] = [Math.cos(roll), Math.sin(roll), Math.cos(pitch), Math.sin(pitch), Math.cos(yaw), Math.sin(yaw)];
  return [
    [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
    [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
    [-sp, cp * sr, cp * cr]
  ];
}
const ORIENT = {
  hand: [-0.9, 0.1, 0.2],    // 손에 들고 화면을 봄: 중력이 대부분 z·y
  pocket: [0.15, 1.45, 0.3], // 바지 주머니에 세로로: 중력이 대부분 x
  flat: [0, 0, 0],           // 평평하게
  side: [1.5, 0.2, 1.0]      // 옆으로 눕힘: 중력이 대부분 y
};

/* 장면 목록 → 표본 [{t,x,y,z}]와 실제 걸음 수
   장면: { kind: 'walk'|'still'|'car'|'bumps'|'gap', s(초), hz(걸음/초), amp(m/s²), style: 'hand'|'pocket'|'stairs' } */
function synth(scenes, o) {
  const r = rng(o.seed || 1), rate = o.rate || 60, orient = ORIENT[o.orient || 'hand'];
  const out = [], marks = [];
  let t0 = 0, trueSteps = 0;
  for (const sc of scenes) {
    const dur = sc.s;
    // 걸음 시각과 세기(주머니: 폰 쪽 다리 걸음이 더 세다)
    const steps = [];
    if (sc.kind === 'walk') {
      let t = 0.35 + r() * 0.2;
      for (let k = 0; ; k++) {
        if (t > dur - 0.3) break;
        let a = sc.amp * (1 + 0.12 * gauss(r));
        if (sc.style === 'pocket') a *= k % 2 ? (sc.ratio || 0.6) : 1.0;
        if (k < 2) a *= 0.6 + 0.2 * k;              // 처음 두 걸음은 약하게
        steps.push({ t: t, a: a });
        t += (1 / sc.hz) * (1 + (sc.jit || 0.04) * gauss(r));   // 걸음 간격 흔들림(기본 4%)
      }
      if (sc.steps != null) steps.length = Math.min(steps.length, sc.steps);
    }
    trueSteps += steps.length;
    marks.push({ kind: sc.kind, from: t0 * 1000, to: (t0 + dur) * 1000, steps: steps.length });
    const T = sc.hz ? 1 / sc.hz : 0.55;
    const bumps = [];
    if (sc.kind === 'bumps') for (let b = 0.5 + r(); b < dur; b += 0.6 + r() * 2.9) bumps.push({ t: b, a: 1 + r() * 2 });
    if (sc.kind === 'shake') for (let b = 0.2 + r(); b < dur; b += 0.15 + r() * 1.2) bumps.push({ t: b, a: (2 + r() * 4) * (r() < 0.5 ? -1 : 1), hz: 1 + r() * 2 });
    const ph = [r() * 6.28, r() * 6.28, r() * 6.28];
    let k = 0;
    if (sc.kind === 'gap') { t0 += dur; continue; }   // 화면 꺼짐: 표본 없음
    for (let tt = 0; tt < dur; tt += 1 / rate) {
      if (r() < 0.01) continue;                     // 표본 1% 빠짐
      const ts = tt + (r() - 0.5) * 0.2 / rate;     // 시각 흔들림
      let up = 0, fwd = 0, lat = 0, swing = 0;
      if (sc.kind === 'walk') {
        while (k + 1 < steps.length && steps[k + 1].t - 0.2 < ts) k++;
        for (let j = Math.max(0, k - 1); j <= Math.min(steps.length - 1, k + 1); j++) {
          const s = steps[j], x = ts - s.t;
          // 발 디딤 봉우리 + 짧은 충격 - 그 뒤 골(몸이 떠오름)
          up += s.a * (bell(x, 0.07) + 0.4 * bell(x - 0.01, 0.02) - 0.55 * bell(x - 0.45 * T, 0.12));
          fwd += 0.5 * s.a * (bell(x - 0.1, 0.08) - bell(x + 0.1, 0.08));
        }
        const inWalk = steps.length && ts > steps[0].t - 0.3 && ts < steps[steps.length - 1].t + 0.3;
        if (inWalk) {
          const idx = (ts - steps[0].t) / T;
          lat = 0.3 * sc.amp * Math.sin(Math.PI * idx);                       // 좌우 흔들림(두 걸음에 한 번)
          if (sc.style === 'pocket') { up += 0.6 * Math.cos(Math.PI * idx + 0.7); swing = 0.35 * Math.sin(Math.PI * idx); }   // 다리 흔들림
          if (sc.style === 'swing') { up += 2.5 * Math.cos(Math.PI * idx + 0.4); fwd += 2 * Math.sin(Math.PI * idx); swing = 0.8 * Math.sin(Math.PI * idx); }   // 팔과 함께 흔드는 폰
          if (sc.style === 'stairs') up += 0.3 * sc.amp * bell((ts - steps[0].t) % T - 0.05, 0.03);   // 계단: 더 날카로운 충격
        }
      } else if (sc.kind === 'still') {
        up = 0.08 * Math.sin(2 * Math.PI * 9 * ts + ph[0]) + 0.1 * Math.sin(2 * Math.PI * 0.4 * ts + ph[1]);   // 손 떨림 + 느린 흔들림
        swing = 0.2 * Math.sin(2 * Math.PI * 0.05 * ts);                                                      // 폰을 천천히 기울임
      } else if (sc.kind === 'shake') {   // 가방 속에서 불규칙하게 크게 흔들림
        for (const b of bumps) { const x = ts - b.t; if (x > 0 && x < 1.5) up += b.a * Math.exp(-x / 0.3) * Math.sin(2 * Math.PI * b.hz * x); }
        swing = 0.5 * Math.sin(0.7 * ts);
      } else if (sc.kind === 'car' || sc.kind === 'bumps') {
        const m = 1 + 0.3 * Math.sin(2 * Math.PI * 0.2 * ts);
        up = m * (0.5 * Math.sin(2 * Math.PI * 13 * ts + ph[0]) + 0.4 * Math.sin(2 * Math.PI * 21 * ts + ph[1]) + 0.3 * Math.sin(2 * Math.PI * 29 * ts + ph[2]))
          + 0.2 * Math.sin(2 * Math.PI * 1.2 * ts) + 0.15 * Math.sin(2 * Math.PI * 2.5 * ts + ph[2]);
        fwd = 0.3 * Math.sin(2 * Math.PI * 17 * ts + ph[1]);
        for (const b of bumps) { const x = ts - b.t; if (x > 0 && x < 1) up += b.a * Math.exp(-x / 0.2) * Math.sin(2 * Math.PI * 4 * x); }
      }
      const noise = sc.noise != null ? sc.noise : sc.kind === 'still' ? 0.04 : sc.kind === 'walk' ? (sc.style === 'pocket' ? 0.35 : 0.2) : 0.1;
      const w = [lat + noise * gauss(r), fwd + noise * gauss(r), G + up + noise * gauss(r)];
      const R = rot(orient[0] + swing, orient[1], orient[2] + 0.1 * Math.sin(0.03 * (t0 + ts)));
      out.push({
        t: Math.round((t0 + ts) * 1000 * 10) / 10,
        x: R[0][0] * w[0] + R[0][1] * w[1] + R[0][2] * w[2],
        y: R[1][0] * w[0] + R[1][1] * w[1] + R[1][2] * w[2],
        z: R[2][0] * w[0] + R[2][1] * w[1] + R[2][2] * w[2]
      });
    }
    t0 += dur;
  }
  return { samples: out, trueSteps: trueSteps, marks: marks };
}

function countSteps(sig, opts) {
  const d = PDR.StepDetector(opts);
  let n = 0, cad = [];
  sig.samples.forEach((s) => { const k = d.push(s.t, s.x, s.y, s.z); n += k; if (k && d.cadence) cad.push(d.cadence); });
  cad.sort((a, b) => a - b);
  return { n: n, cadence: cad.length ? cad[cad.length >> 1] : 0 };
}
const pct = (a, b) => b ? ((a - b) / b * 100) : (a ? Infinity : 0);
module.exports = { synth: synth, ORIENT: ORIENT };
if (require.main === module) main();
function main() {

// ---------- 1. 걸음 세기 ----------
console.log('1. 걸음 세기 (합성 신호, 60Hz 기본, 표본 1% 빠짐, 시각 흔들림)');
const W = (s, hz, amp, style) => ({ kind: 'walk', s: s, hz: hz, amp: amp, style: style || 'hand' });
const STEP_CASES = [
  // [이름, 장면, 옵션, 기대: 'walk'(±5%) | 'zero'(0~2) | 'info'(출력만)]
  ['손에 들고 1.6Hz', [W(60, 1.6, 2.0)], { orient: 'hand', seed: 11 }, 'walk'],
  ['손에 들고 1.8Hz', [W(60, 1.8, 2.2)], { orient: 'hand', seed: 12 }, 'walk'],
  ['손에 들고 2.0Hz', [W(60, 2.0, 2.5)], { orient: 'hand', seed: 13 }, 'walk'],
  ['주머니 1.7Hz (좌우 세기 다름)', [W(60, 1.7, 3.5, 'pocket')], { orient: 'pocket', seed: 14 }, 'walk'],
  ['주머니 2.0Hz', [W(60, 2.0, 4.0, 'pocket')], { orient: 'pocket', seed: 15 }, 'walk'],
  ['평평하게 1.8Hz, 50Hz 표본', [W(60, 1.8, 2.0)], { orient: 'flat', seed: 16, rate: 50 }, 'walk'],
  ['옆으로 눕힘 1.9Hz, 100Hz 표본', [W(60, 1.9, 2.0)], { orient: 'side', seed: 17, rate: 100 }, 'walk'],
  ['약하게 천천히 1.4Hz (진폭 1.2)', [W(60, 1.4, 1.2)], { orient: 'hand', seed: 18 }, 'walk'],
  ['서 있음 (손 떨림·기울임)', [{ kind: 'still', s: 120 }], { orient: 'hand', seed: 19 }, 'zero'],
  ['멈췄다 걷기 (30s 걷기·10s 서기·20s·5s·15s)',
    [{ kind: 'still', s: 5 }, W(30, 1.8, 2.2), { kind: 'still', s: 10 }, W(20, 1.7, 2.0), { kind: 'still', s: 5 }, W(15, 1.9, 2.3), { kind: 'still', s: 5 }],
    { orient: 'hand', seed: 20 }, 'walk'],
  ['차량 진동 (13~29Hz, 약하게)', [{ kind: 'car', s: 120 }], { orient: 'flat', seed: 21 }, 'zero'],
  ['계단 오르기 1.4Hz 큰 봉우리 → 평지 1.8Hz',
    [W(30, 1.4, 4.5, 'stairs'), W(40, 1.8, 2.0)], { orient: 'pocket', seed: 22 }, 'walk'],
  ['계단 내려가기 1.9Hz 큰 봉우리 → 평지 1.7Hz',
    [W(25, 1.9, 5.5, 'stairs'), W(35, 1.7, 2.0)], { orient: 'hand', seed: 23 }, 'walk'],
  ['버스 덜컹임 (진동 + 0.6~3.5초마다 충격)', [{ kind: 'bumps', s: 180 }], { orient: 'flat', seed: 24 }, 'zero'],
  // 아래는 더 어려운 경우: 기대값 없이 결과만 적는다(실제 폰에서 확인할 것)
  ['(참고) 잡음 큰 손 1.8Hz (잡음 0.6)', [Object.assign(W(60, 1.8, 2.0), { noise: 0.6 })], { orient: 'hand', seed: 25 }, 'info'],
  ['(참고) 주머니 좌우 차이 큼 (약한 쪽 0.4배)', [Object.assign(W(60, 1.8, 3.5, 'pocket'), { ratio: 0.4 })], { orient: 'pocket', seed: 26 }, 'info'],
  ['(참고) 걸음 간격 들쭉날쭉 12% (침목·자갈)', [Object.assign(W(60, 1.7, 2.0), { jit: 0.12 })], { orient: 'hand', seed: 27 }, 'info'],
  ['(참고) 폰을 손에 쥐고 팔과 함께 흔듦', [W(60, 1.8, 1.5, 'swing')], { orient: 'side', seed: 28 }, 'info'],
  ['(참고) 걷지 않고 불규칙하게 크게 흔듦 (가방)', [{ kind: 'shake', s: 120 }], { orient: 'pocket', seed: 29 }, 'info']
];
const rows = [];
for (const [name, scenes, o, expect] of STEP_CASES) {
  const sig = synth(scenes, o);
  const r = countSteps(sig);
  const err = pct(r.n, sig.trueSteps);
  let good = true;
  if (expect === 'walk') good = ok(Math.abs(err) <= 5, `${name}: ${r.n} / ${sig.trueSteps} (${err.toFixed(1)}%)`);
  if (expect === 'zero') good = ok(r.n <= 2, `${name}: ${r.n}걸음 (0이어야 함)`);
  rows.push([expect === 'info' ? '참고' : good ? 'OK' : 'NG', name, sig.trueSteps, r.n, sig.trueSteps ? err.toFixed(1) + '%' : '-', r.cadence || '-', expect]);
}
console.log('  결과 | 경우 | 실제 걸음 | 센 걸음 | 오차 | 분당 걸음(중앙값) | 기대');
rows.forEach((x) => console.log('  ' + x.join(' | ')));

// ---------- 2. 멈춤: 서 있는 동안 거리가 늘지 않음, 못 본 시간 채우기 ----------
console.log('\n2. 서 있을 때·화면 꺼짐(센서 값 없음)');
{
  let clock = 0;
  const speed = 3.5 / 3.6;
  const tr = PDR.create({ now: () => clock, fillSpeed: () => speed });
  const sig = synth([W(30, 1.8, 2.2), { kind: 'still', s: 60 }, W(20, 1.8, 2.2), { kind: 'gap', s: 30 }, W(20, 1.8, 2.2)], { seed: 31 });
  // 표본을 차례로 넣으며 정해진 시각의 거리를 적는다
  const probes = [31500, 89000, 110500, 125000, 140000, 160000];
  const got = {};
  let i = 0;
  for (const s of sig.samples) {
    while (i < probes.length && s.t > probes[i]) { got[probes[i]] = tr.distanceSinceCheckpoint(probes[i]); i++; }
    clock = s.t; tr.feed(s.t, s.x, s.y, s.z);
  }
  const still = got[89000] - got[31500];
  console.log(`  30초 걷고 60초 서 있음: 서 있는 동안 늘어난 거리 ${still.toFixed(2)}m (시간 × 속도였다면 ${(57.5 * speed).toFixed(0)}m)`);
  ok(still < 1, '서 있는 동안 거리가 늘었다');
  const live = got[125000] - got[110500];
  const filled = tr.filledM;
  console.log(`  화면 꺼짐 30초: 꺼진 동안 보이는 추정 +${live.toFixed(1)}m(14.5초분), 채운 거리 ${filled.toFixed(1)}m (기대 약 ${(30 * speed).toFixed(1)}m)`);
  ok(Math.abs(filled - 30 * speed) < 2, '화면 꺼짐 시간을 시간 × 속도로 채우지 않았다');
  ok(Math.abs(live - 14.5 * speed) < 1.5, '꺼진 동안 보이는 추정이 시간 × 속도로 늘지 않았다');
  console.log(`  전체 센 걸음 ${tr.steps} / 실제 ${sig.trueSteps}, 지금 움직임 '${tr.motion(clock)}'`);
  ok(Math.abs(pct(tr.steps, sig.trueSteps)) <= 5, '걸음 수 오차가 5% 넘음');
  // 흔들림은 큰데 걸음을 하나도 못 셀 때(가방 속 등): moveMs(3초) 뒤부터 시간 × 속도로 채운다.
  // 걸음 찾기를 일부러 막고(minPeak 99) 주머니 걷기 신호 60초를 넣어 채우기 규칙만 본다.
  let c2 = 0;
  const tr2 = PDR.create({ now: () => c2, fillSpeed: () => speed, minPeak: 99 });
  const sh = synth([W(60, 1.8, 3.5, 'pocket')], { seed: 32, orient: 'pocket' });
  let maxRms = 0;
  sh.samples.forEach((s) => { c2 = s.t; tr2.feed(s.t, s.x, s.y, s.z); maxRms = Math.max(maxRms, tr2.detector.rms); });
  const want = 60 * speed;
  console.log(`  크게 흔들리는데 걸음을 못 셈 60초: 센 걸음 ${tr2.steps}, 움직임 '${tr2.motion(c2)}', 채운 거리 ${tr2.filledM.toFixed(1)}m (60초 × 속도 = ${want.toFixed(0)}m, 흔들림 RMS 최대 ${maxRms.toFixed(2)})`);
  // 처음 몇 초는 빠진다: 흔들림 2초 평균이 문턱을 넘는 시간 + moveMs 3초
  ok(tr2.filledM > want - 10 * speed && tr2.filledM <= want && tr2.motion(c2) === 'moving', '크게 흔들리는데 걸음이 없을 때 시간 × 속도로 채우지 않음');
  // 걷기 시작 판정 중(처음 5걸음)에는 채우지 않아 두 번 세지 않는다
  let c3 = 0;
  const tr3 = PDR.create({ now: () => c3, fillSpeed: () => speed });
  synth([{ kind: 'still', s: 10 }, W(30, 1.8, 3.5, 'pocket'), { kind: 'still', s: 10 }, W(30, 1.8, 3.5, 'pocket')], { seed: 33, orient: 'pocket' })
    .samples.forEach((s) => { c3 = s.t; tr3.feed(s.t, s.x, s.y, s.z); });
  console.log(`  서기·걷기 반복(주머니): 채운 거리 ${tr3.filledM.toFixed(2)}m (0이어야 함)`);
  ok(tr3.filledM === 0, '정상 걷기에서 시간으로 채움(두 번 셈)');
}

// ---------- 3. 보폭 보정 ----------
console.log('\n3. 보폭 보정 (실제 보폭 0.62m, 기본 0.70m에서 시작)');
{
  let clock = 0;
  const TRUE = 0.62;
  const tr = PDR.create({ now: () => clock, fillSpeed: () => 3.5 / 3.6 });
  let base = 0;
  const walkSeg = (meters, hz, seed, style) => {
    const n = Math.round(meters / TRUE);   // 걸음 수 = 실제로 걸은 거리 ÷ 실제 보폭
    const sig2 = synth([Object.assign(W(n / hz + 3, hz, style === 'pocket' ? 3.5 : 2.1, style), { steps: n }), { kind: 'still', s: 3 }], { seed: seed, orient: style === 'pocket' ? 'pocket' : 'hand' });
    sig2.samples.forEach((s) => { clock = base + s.t; tr.feed(clock, s.x, s.y, s.z); });
    base = clock + 100;
    return sig2.trueSteps;
  };
  const SEG = [[420, 1.75, 41, 'hand'], [780, 1.8, 42, 'pocket'], [1150, 1.7, 43, 'hand']];
  console.log(`  보정 전: 보폭 ${tr.stride.toFixed(3)}m, 오차 ${pct(tr.stride, TRUE).toFixed(1)}%`);
  SEG.forEach(([m, hz, seed, style], i) => {
    const real = walkSeg(m, hz, seed, style);
    const est = tr.distanceSinceCheckpoint(clock);
    const segSteps = tr.stepsSinceCheckpoint;
    const r = tr.onCheckpoint(m);
    console.log(`  구간 ${i + 1} ${m}m (${style}, ${hz}Hz): 실제 ${real}걸음, 센 ${segSteps}걸음, 추정 ${est.toFixed(0)}m → 잰 보폭 ${r.measured.toFixed(3)}, 반영 ${(r.rate * 100).toFixed(0)}% → 보폭 ${r.stride.toFixed(3)}m (오차 ${pct(r.stride, TRUE).toFixed(1)}%)`);
  });
  ok(Math.abs(pct(tr.stride, TRUE)) < 5, `보정 뒤 보폭 오차 ${pct(tr.stride, TRUE).toFixed(1)}% (5% 미만이어야 함)`);
  // 보정한 보폭으로 새 구간 600m
  walkSeg(600, 1.8, 44, 'hand');
  const d = tr.distanceSinceCheckpoint(clock);
  console.log(`  보정 뒤 새 구간 600m: 추정 ${d.toFixed(0)}m (오차 ${pct(d, 600).toFixed(1)}%). 보정 없이 0.70m 였다면 약 ${(600 / TRUE * 0.7).toFixed(0)}m (${pct(0.7, TRUE).toFixed(1)}%)`);
  ok(Math.abs(pct(d, 600)) < 5, '보정 뒤 새 구간 거리 오차가 5% 넘음');
  // 걸러야 하는 확인: 적은 걸음, 엉뚱한 곳에서 누름, 보정하지 않음
  const before = tr.stride;
  let r = tr.onCheckpoint(600, { calibrate: false });
  ok(r.used === false && tr.stride === before && tr.stepsSinceCheckpoint === 0, 'calibrate:false 인데 보폭이 바뀌었거나 구간이 안 비워짐');
  walkSeg(25, 1.8, 45, 'hand');
  r = tr.onCheckpoint(25);
  const few = r.reason;
  ok(r.used === false && r.reason === 'few-steps', `50걸음 미만 구간을 보정에 씀 (${r.reason})`);
  walkSeg(120, 1.8, 46, 'hand');
  r = tr.onCheckpoint(900);
  ok(r.used === false && r.reason === 'outlier', `엉뚱한 거리(잰 보폭 ${r.measured && r.measured.toFixed(2)})를 보정에 씀 (${r.reason})`);
  console.log(`  거름: 25m 구간(약 40걸음) → ${few}, 120m 걷고 900m 확인 → outlier(잰 보폭 ${r.measured.toFixed(2)}m), 보폭 그대로 ${tr.stride.toFixed(3)}m`);
  ok(tr.stride === before, '거른 확인 뒤 보폭이 바뀜');
  // 같은 세 구간인데 '도착'을 15m 늦게·20m 일찍·10m 늦게 누름(실제 걸은 거리 ≠ 경로 거리)
  {
    let c = 0, b0 = 0;
    const t2 = PDR.create({ now: () => c });
    [[420, 15, 1.75, 51], [780, -20, 1.8, 52], [1150, 10, 1.7, 53]].forEach(([m, off, hz, seed]) => {
      const n = Math.round((m + off) / TRUE);
      synth([Object.assign(W(n / hz + 3, hz, 2.1), { steps: n }), { kind: 'still', s: 3 }], { seed: seed })
        .samples.forEach((s) => { c = b0 + s.t; t2.feed(c, s.x, s.y, s.z); });
      b0 = c + 100;
      t2.onCheckpoint(m);
    });
    console.log(`  '도착'을 +15m·-20m·+10m 어긋나게 누름: 보정 뒤 보폭 ${t2.stride.toFixed(3)}m (오차 ${pct(t2.stride, TRUE).toFixed(1)}%)`);
    ok(Math.abs(pct(t2.stride, TRUE)) < 5, '누른 곳이 어긋날 때 보정 뒤 보폭 오차 5% 넘음');
  }
  // 보폭 범위 0.45~1.0
  const e = PDR.StrideEstimator({});
  for (let k = 0; k < 10; k++) e.calibrate(0.40 * 1000, 1000, 0);
  ok(e.stride >= 0.45 && e.stride < 0.451, `보폭이 0.45m 범위를 벗어남 (${e.stride})`);
  for (let k = 0; k < 10; k++) e.calibrate(1.2 * 1000, 1000, 0);
  ok(e.stride <= 1.0 && e.stride > 0.99, `보폭이 1.0m 범위를 벗어남 (${e.stride})`);
  console.log(`  범위: 0.40m 로 10번 → ${PDR.StrideEstimator({}).stride.toFixed(2)}에서 0.45 쪽으로, 1.2m 로 10번 → ${e.stride.toFixed(3)}m (0.45~1.0m 안)`);
}

// ---------- 4. 센서 연결 (가짜 window) ----------
console.log('\n4. 센서 연결 (가짜 window·document)');
function fakeWindow(o) {
  const on = {}, don = {};
  const add = (m) => (type, fn) => { (m[type] = m[type] || []).push(fn); };
  const rem = (m) => (type, fn) => { m[type] = (m[type] || []).filter((f) => f !== fn); };
  const doc = { visibilityState: 'visible', addEventListener: add(don), removeEventListener: rem(don) };
  const w = {
    document: doc, isSecureContext: o.secure !== false, addEventListener: add(on), removeEventListener: rem(on),
    navigator: {}, performance: { timeOrigin: 0 }
  };
  if (o.api !== false) {
    w.DeviceMotionEvent = function () {};
    if (o.ask) w.DeviceMotionEvent.requestPermission = o.ask;
  }
  w.listeners = (type) => (on[type] || []).length;
  w.motion = (x, y, z) => (on.devicemotion || []).forEach((f) => f({ accelerationIncludingGravity: { x: x, y: y, z: z } }));
  w.setVisible = (v) => { doc.visibilityState = v ? 'visible' : 'hidden'; (don.visibilitychange || []).forEach((f) => f()); };
  return w;
}
async function sensorChecks() {
  const res = [];
  const t1 = PDR.create({ window: fakeWindow({ secure: false }) });
  res.push(['HTTP(보안 연결 아님)', await t1.start(), 'insecure']);
  const t2 = PDR.create({ window: fakeWindow({ api: false }) });
  res.push(['DeviceMotionEvent 없음', await t2.start(), 'unsupported']);
  const t3 = PDR.create({ window: fakeWindow({ ask: () => Promise.resolve('denied') }) });
  res.push(['iOS 권한 거절', await t3.start(), 'denied']);
  const t4 = PDR.create({ window: fakeWindow({ ask: () => Promise.reject(new Error('NotAllowedError: requires user gesture')) }) });
  res.push(['iOS 누르기 밖에서 시작', await t4.start(), 'prompt']);
  const t5 = PDR.create({ window: fakeWindow({}), noDataMs: 50 });
  res.push(['값이 안 옴(PC·미리보기 iframe)', await t5.start(), 'unsupported']);
  t5.stop();
  // 정상: iOS 허락 → 값이 오면 active, 숨으면 paused(센서 뗌), 보이면 다시 붙음, stop 이면 뗌
  let asked = 0;
  const w6 = fakeWindow({ ask: () => { asked++; return Promise.resolve('granted'); } });
  const t6 = PDR.create({ window: w6, noDataMs: 500 });
  const updates = [];
  t6.onupdate = (t) => updates.push(t.status);
  const p6 = t6.start();
  ok(asked === 1, 'start() 가 requestPermission 을 곧바로(같은 누르기 안에서) 부르지 않음');
  await Promise.resolve(); await Promise.resolve();
  w6.motion(0, 0, G);
  res.push(['iOS 허락 + 값이 옴', await p6, 'active']);
  w6.setVisible(false);
  res.push(['화면 숨김', t6.status, 'paused']);
  ok(w6.listeners('devicemotion') === 0, '숨었는데 devicemotion 이 붙어 있음');
  w6.setVisible(true);
  ok(w6.listeners('devicemotion') === 1, '다시 보이는데 devicemotion 이 안 붙음');
  w6.motion(0, 0, G);
  res.push(['다시 보임 + 값이 옴', t6.status, 'active']);
  ok(t6.usable(), 'active 인데 usable() 이 false');
  t6.stop();
  res.push(['stop()', t6.status, 'idle']);
  ok(w6.listeners('devicemotion') === 0, 'stop() 뒤에도 devicemotion 이 붙어 있음');
  ok(!t6.usable(), 'stop() 뒤에도 usable() 이 true');
  // 한 번 허락받으면 다시 묻지 않음
  const t7 = PDR.create({ window: w6, noDataMs: 50 });
  const p7 = t7.start();
  ok(asked === 1, '이미 허락받았는데 다시 물음');
  await p7; t7.stop();
  // 안드로이드: requestPermission 없음 → 묻지 않고 시작
  const w8 = fakeWindow({});
  const t8 = PDR.create({ window: w8, noDataMs: 500 });
  const p8 = t8.start();
  await Promise.resolve(); await Promise.resolve();
  w8.motion(0.1, 9.7, 1.2);
  res.push(['안드로이드(권한 묻기 없음)', await p8, 'active']);
  t8.stop();
  // null 값(센서 없는 PC) 은 무시
  const w9 = fakeWindow({});
  const t9 = PDR.create({ window: w9, noDataMs: 60 });
  const p9 = t9.start();
  await Promise.resolve(); await Promise.resolve();
  w9.motion(null, null, null);
  res.push(['null 값만 옴', await p9, 'unsupported']);
  t9.stop();
  const fromGesture = await PDR.requestPermissionFromGesture(fakeWindow({ ask: () => Promise.resolve('granted') }));
  res.push(['requestPermissionFromGesture()', fromGesture, 'granted']);
  res.push(['Node(window 없음)', await PDR.create({ window: null }).start(), 'unsupported']);
  res.forEach(([name, got, want]) => { ok(got === want, `${name}: ${got} (기대 ${want})`); console.log(`  ${got === want ? 'OK' : 'NG'} ${name} → ${got}`); });
  console.log(`  onupdate 로 받은 상태: ${updates.join(' → ')}`);

  // ---------- 5. 화면 켜 두기 (가짜 navigator.wakeLock) ----------
  console.log('\n5. 화면 켜 두기 (Wake Lock)');
  const w = fakeWindow({});
  let reqs = 0, reject = false;
  w.navigator.wakeLock = {
    request: (type) => {
      reqs++;
      if (reject || type !== 'screen') return Promise.reject(new Error('NotAllowedError'));
      const ls = [];
      const s = { released: false, addEventListener: (t, f) => ls.push(f), release: () => { s.released = true; ls.forEach((f) => f()); return Promise.resolve(); } };
      w.lastSentinel = s;
      return Promise.resolve(s);
    }
  };
  const a = await PDR.keepScreenOn(true, w);
  ok(a === true && PDR.screenKeptOn(), '화면 켜 두기를 잡지 못함');
  w.lastSentinel.release();                // 화면이 숨으면 브라우저가 푼다
  w.setVisible(false);
  ok(!PDR.screenKeptOn(), '풀렸는데 잡은 것으로 나옴');
  w.setVisible(true);                      // 다시 보이면 다시 잡는다
  await Promise.resolve(); await Promise.resolve();
  ok(PDR.screenKeptOn() && reqs === 2, `다시 보였는데 다시 잡지 않음(요청 ${reqs}번)`);
  const again = PDR.screenKeptOn();
  const off = await PDR.keepScreenOn(false, w);
  ok(off === false && !PDR.screenKeptOn() && w.lastSentinel.released, '끄기가 풀지 않음');
  w.setVisible(false); w.setVisible(true);
  await Promise.resolve();
  ok(reqs === 2, '끈 뒤에 다시 잡음');
  reject = true;
  const rj = await PDR.keepScreenOn(true, w);
  ok(rj === false, '거절됐는데 true');
  const none = await PDR.keepScreenOn(true, fakeWindow({}));
  ok(none === false, 'wakeLock 이 없는데 true');
  await PDR.keepScreenOn(false, w);
  console.log(`  잡기 ${a} · 숨었다 보이면 다시 잡음 ${again} · 끄기 뒤 ${PDR.screenKeptOn()} · 거절되면 ${rj} · wakeLock 없으면 ${none}`);
}

sensorChecks().then(() => {
  console.log('\n' + (allOk ? '모두 기대대로' : '기대와 다른 곳 있음'));
  process.exitCode = allOk ? 0 : 1;
}, (e) => { console.error(e); process.exitCode = 1; });
}
