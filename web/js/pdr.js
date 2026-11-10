/* pdr.js — 걸음 수로 걸은 거리 재기 (보행자 추측 항법, PDR)
   터널 안에서는 경로를 따라 한 줄로만 움직이므로 '경로 위 거리'만 알면 된다: 거리 = 걸음 수 × 보폭.
   나침반(자기장)은 쓰지 않는다. 선로·철골이 자기장을 흐트러뜨린다.
   - StepDetector(DOM 없음): 가속도(중력 포함) 세 축 → 크기(폰 방향과 무관) → 띠 거르개(약 0.5~3Hz)
     → 문턱이 따라 변하는 봉우리 찾기 → 고르게 이어질 때만 걸음으로 센다.
   - StrideEstimator(DOM 없음): 보폭. 체크포인트를 확인하면 '실제 거리 ÷ 센 걸음'으로 보폭을 고친다.
   - create(): 위 둘 + 센서 연결(devicemotion, iOS 권한, 화면이 숨으면 멈춤)
     + 센서가 못 본 시간(화면 꺼짐 등)과 '흔들리는데 걸음이 안 잡히는 시간'은 예전처럼 시간 × 속도로 채운다.
   - keepScreenOn(): 화면 꺼짐 막기(Wake Lock). 웹 앱은 화면이 켜져 있어야 센서 값이 온다.
   브라우저 UG.pdr, Node require(). guide.js 연결 방법은 docs/graph-format.md '걸음 기반 위치 (pdr.js)'. */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};

  const DEFAULTS = {
    lowHz: 3,            // 이보다 빠른 떨림(차량 진동·손 떨림)은 거른다
    highHz: 0.5,         // 이보다 느린 변화(중력·자세 바뀜)는 뺀다
    minPeak: 0.3,        // 걸음 봉우리 최소 높이(m/s², 거른 신호 기준. 서 있을 때 잡음은 약 0.05)
    peakFrac: 0.25,      // 문턱 = 최근 봉우리 높이 평균 × 이 값(minPeak 보다 작아지지 않음)
    minGapMs: 250,       // 걸음 사이 최소 간격(초당 4걸음)
    maxGapMs: 2000,      // 이보다 오래 걸음이 없으면 멈춘 것으로 본다
    startSteps: 5,       // 고르게 이어진 봉우리가 이만큼 모여야 걷기로 보고 센다(모은 것도 함께 센다)
    regularity: 1.5,     // 걷기 시작 판정: 가장 긴 간격 ÷ 가장 짧은 간격이 이 값 이하
    irregular: 2,        // 걷는 중 최근 4간격이 이 배수보다 들쭉날쭉하면 걷기가 아닌 것으로 보고 다시 모은다
    stride: 0.70,        // 기본 보폭(m)
    strideMin: 0.45, strideMax: 1.0,
    calibMinSteps: 50,   // 이보다 적게 센 구간으로는 보폭을 고치지 않는다
    calibK: 300,         // 고치는 비율 = 걸음 / (걸음 + calibK), 최대 calibMaxRate
    calibMaxRate: 0.8,
    rejectLow: 0.35, rejectHigh: 1.3,   // 잰 보폭이 이 밖이면 잘못 누른 것으로 보고 버린다
    activeRms: 0.6,      // 걸음은 없는데 흔들림(거른 신호의 2초 RMS)이 이보다 크면 '움직이는데 걸음을 못 셈'
    moveMs: 3000,        // 그런 상태가 이만큼 이어지면 그때부터 시간 × 속도로 채운다(걷기 시작 판정 시간보다 길게)
    blindMs: 1000,       // 센서 값이 이보다 오래 안 오면 그 시간은 '못 본 시간'
    noDataMs: 3000,      // 시작 뒤 이 시간 안에 값이 하나도 없으면 'unsupported'(PC·미리보기 iframe)
    updateMs: 1000       // onupdate 최소 간격(상태가 바뀔 때는 바로)
  };

  function median(a) {
    const s = a.slice().sort(function (p, q) { return p - q; }), h = s.length >> 1;
    return !s.length ? 0 : s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* ---------- 걸음 찾기 (DOM 없음) ----------
     push(t ms, x, y, z) -> 이번에 새로 센 걸음 수(보통 0 또는 1, 걷기 시작을 알아챈 순간에는 startSteps). */
  function StepDetector(opts) {
    const c = Object.assign({}, DEFAULTS, opts);
    const rcLow = 1 / (2 * Math.PI * c.lowHz), rcHigh = 1 / (2 * Math.PI * c.highHz), rcAct = 2;   // 1차 거르개 시간 상수(초)
    let lastT = null, lp1 = 0, lp2 = 0, base = 0, act = 0, f = 0;
    let armed = false, peakV = 0, peakT = 0;      // 봉우리를 넘는 중인지, 그동안 가장 높은 값과 그 시각
    let amp = 0;                                   // 최근 봉우리 높이 평균(문턱을 정한다)
    let walking = false, pending = [], gaps = [], lastCand = -Infinity, lastStep = null;
    let steps = 0;

    function reset() {
      lastT = null; armed = false; amp = 0; walking = false; pending = []; gaps = []; lastCand = -Infinity; act = 0; f = 0;
    }

    // 봉우리 하나(걸음 후보)를 받아 걸음으로 셀지 정한다
    function candidate(tp, v) {
      const gap = tp - lastCand;
      const minGap = walking && gaps.length ? Math.max(c.minGapMs, 0.35 * median(gaps)) : c.minGapMs;   // 천천히 걸을 때만 길어진다
      if (gap < minGap) return 0;                  // 너무 빠름: 같은 걸음 안의 두 번째 봉우리
      amp = amp ? amp + 0.25 * (v - amp) : v;
      lastCand = tp;
      if (gap > c.maxGapMs) { walking = false; pending = [tp]; gaps = []; return 0; }   // 쉬었다 다시: 처음부터 모은다
      if (walking) {                               // 걷는 중: 바로 센다
        gaps.push(gap); if (gaps.length > 8) gaps.shift();
        const last = gaps.slice(-4);
        if (last.length === 4 && Math.max.apply(null, last) > c.irregular * Math.min.apply(null, last)) {   // 간격이 들쭉날쭉: 걷기가 아님
          walking = false; pending = [tp]; gaps = [];
          return 0;
        }
        lastStep = tp;
        return 1;
      }
      pending.push(tp);
      if (pending.length > c.startSteps) pending.shift();
      if (pending.length < c.startSteps) return 0;
      const g = [];
      for (let i = 1; i < pending.length; i++) g.push(pending[i] - pending[i - 1]);
      if (Math.max.apply(null, g) > c.regularity * Math.min.apply(null, g)) return 0;   // 고르지 않음: 흔들기·덜컹임
      walking = true; gaps = g; lastStep = tp;     // 걷기 시작: 모아 둔 봉우리도 걸음으로 센다
      const n = pending.length;
      pending = [];
      return n;
    }

    function push(t, x, y, z) {
      const m = Math.sqrt(x * x + y * y + z * z);  // 크기만 쓰므로 폰이 어느 방향이든(손·주머니) 같다
      if (!isFinite(m) || (lastT != null && t < lastT)) return 0;
      if (lastT == null || t - lastT > c.maxGapMs) {   // 처음이거나 오래 끊겼으면 거르개를 지금 값에 맞춘다
        lp1 = lp2 = base = m; act = 0; f = 0; armed = false; lastT = t;
        return 0;
      }
      const dt = clamp((t - lastT) / 1000, 0.001, 0.1);
      lastT = t;
      const aL = dt / (rcLow + dt), aH = dt / (rcHigh + dt), aA = dt / (rcAct + dt);
      lp1 += aL * (m - lp1); lp2 += aL * (lp1 - lp2);   // 3Hz 저역 통과를 두 번(빠른 떨림 제거)
      base += aH * (m - base);                           // 0.5Hz 느린 평균 = 중력 + 자세
      f = lp2 - base;                                    // 띠 거른 신호: 걸음마다 위아래로 한 번 출렁인다
      act += aA * (f * f - act);                         // 2초 평균 세기(흔들림 정도)
      if (t - lastCand > c.maxGapMs) { amp = 0; walking = false; }   // 멈춤: 문턱도 처음으로
      const thr = Math.max(c.minPeak, c.peakFrac * amp);
      let n = 0;
      if (!armed) { if (f > thr) { armed = true; peakV = f; peakT = t; } }
      else if (f > peakV) { peakV = f; peakT = t; }
      else if (f < 0) { armed = false; n = candidate(peakT, peakV); }   // 문턱을 넘었다가 기준선 아래로 = 봉우리 하나
      steps += n;
      return n;
    }

    return {
      push: push, reset: reset,
      get steps() { return steps; },
      get walking() { return walking; },
      get lastStepT() { return lastStep; },
      get lastCandT() { return lastCand; },
      get signal() { return f; },
      get rms() { return Math.sqrt(act); },
      // 걸음 빠르기(분당 걸음): 최근 간격의 중앙값으로, 걷지 않으면 0
      get cadence() { return walking && gaps.length ? Math.round(60000 / median(gaps)) : 0; }
    };
  }

  /* ---------- 보폭 (DOM 없음) ----------
     calibrate(실제 거리 m, 센 걸음, 시간으로 채운 거리 m) -> { used, reason?, measured?, stride, rate? } */
  function StrideEstimator(opts) {
    const c = Object.assign({}, DEFAULTS, opts);
    let stride = clamp(c.stride, c.strideMin, c.strideMax), used = 0;
    return {
      get stride() { return stride; },
      set stride(v) { if (v > 0) stride = clamp(v, c.strideMin, c.strideMax); },
      get calibrations() { return used; },
      calibrate: function (knownM, steps, filledM) {
        const out = { used: false, stride: stride, steps: steps };
        if (!(knownM > 0)) { out.reason = 'no-distance'; return out; }
        if (!(steps >= c.calibMinSteps)) { out.reason = 'few-steps'; return out; }
        if (filledM > 0.1 * knownM) { out.reason = 'blind'; return out; }   // 센서가 못 본 시간이 길었다
        out.measured = (knownM - (filledM || 0)) / steps;
        if (out.measured < c.rejectLow || out.measured > c.rejectHigh) { out.reason = 'outlier'; return out; }   // 다른 곳에서 눌렀거나 걸음을 크게 놓침
        out.rate = Math.min(c.calibMaxRate, steps / (steps + c.calibK));   // 많이 걸은 구간일수록 많이 믿는다
        stride = clamp(stride + out.rate * (clamp(out.measured, c.strideMin, c.strideMax) - stride), c.strideMin, c.strideMax);
        used++;
        out.used = true; out.stride = stride;
        return out;
      }
    };
  }

  /* ---------- 센서 권한 ----------
     iOS 13+ 는 DeviceMotionEvent.requestPermission() 을 '누르기' 처리 안에서 바로 불러야 한다.
     결과: 'granted' | 'denied' | 'prompt'(누르기 밖에서 불러 거절됨: 다음 누르기 때 다시) | 'unsupported' | 'insecure' */
  let grantedBy = null;   // 허락을 받은 DeviceMotionEvent(한 번 받으면 다시 묻지 않는다)
  function winOf(w) { return w !== undefined ? w : (typeof window !== 'undefined' ? window : null); }
  function requestPermissionFromGesture(win) {
    const w = winOf(win);
    if (!w || typeof w.DeviceMotionEvent === 'undefined') return Promise.resolve('unsupported');
    if (w.isSecureContext === false) return Promise.resolve('insecure');   // 센서는 HTTPS 에서만 온다
    const D = w.DeviceMotionEvent;
    if (typeof D.requestPermission !== 'function' || grantedBy === D) return Promise.resolve('granted');   // 안드로이드 등은 묻지 않는다
    let p;
    try { p = D.requestPermission(); } catch (e) { return Promise.resolve('prompt'); }
    return Promise.resolve(p).then(function (r) {
      if (r === 'granted') grantedBy = D;
      return r === 'granted' ? 'granted' : 'denied';
    }, function () { return 'prompt'; });
  }

  // 센서 이벤트 시각(ms, Date.now() 기준). 기준이 다르거나 이상하면 받은 시각을 쓴다.
  function eventTime(e, w) {
    const now = Date.now(), ts = e && e.timeStamp, p = w && w.performance;
    let t = ts > 1e12 ? ts : (ts > 0 && p && p.timeOrigin ? p.timeOrigin + ts : now);
    return Math.abs(t - now) > 2000 ? now : t;
  }

  /* ---------- 걸음 추적기 (길 안내가 쓰는 것) ----------
     opts: DEFAULTS 의 값 + { stride, fillSpeed() -> m/s(센서가 못 본 시간을 채울 속도, 0 이면 안 채움),
                              now() -> ms, window(시험용 가짜 window) } */
  function create(opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const det = StepDetector(o), est = StrideEstimator(o);
    const now = o.now || function () { return Date.now(); };
    const speed = function () { const v = o.fillSpeed ? +o.fillSpeed() : 0; return v > 0 ? v : 0; };
    const w = winOf(o.window), doc = w && w.document;
    let status = 'idle', reason = '';
    let segSteps = 0, totalSteps = 0, filledM = 0, lastSeen = null, lastStepAt = null, lastEmit = -Infinity, shakeFrom = null;
    let attached = false, running = false, noDataTimer = 0, firstWaiters = [];

    const tr = {
      onupdate: null,
      get status() { return status; },
      get reason() { return reason; },
      get stride() { return est.stride; },
      set stride(v) { est.stride = v; },
      get cadence() { return det.cadence; },
      get lastStepAt() { return lastStepAt; },
      get steps() { return totalSteps; },
      get stepsSinceCheckpoint() { return segSteps; },
      get filledM() { return filledM; },
      get calibrations() { return est.calibrations; }
    };

    function emit(force) {
      if (!tr.onupdate) return;
      const t = now();
      if (!force && t - lastEmit < o.updateMs) return;
      lastEmit = t;
      try { tr.onupdate(tr); } catch (e) { if (typeof console !== 'undefined') console.error(e); }
    }
    function setStatus(s, why) {
      if (s === status && (why || '') === reason) return s;
      status = s; reason = why || '';
      if (s === 'active' || s === 'unsupported') { const ws = firstWaiters; firstWaiters = []; ws.forEach(function (f) { f(s); }); }
      emit(true);
      return s;
    }

    // 흔들림이 큰데 걸음을 못 센 지 moveMs 넘음(가방 속 등)
    function shakingNoSteps(t) {
      return shakeFrom != null && t - shakeFrom > o.moveMs && (lastStepAt == null || t - lastStepAt > o.moveMs);
    }
    // 가속도 하나 넣기(센서 처리와 시험이 같이 쓴다). t = ms(now() 와 같은 기준)
    tr.feed = function (t, x, y, z) {
      if (lastSeen != null && t > lastSeen) {
        const gap = t - lastSeen;
        // 못 본 시간(화면 꺼짐·센서 멈춤), 또는 흔들리는데 걸음이 안 잡히는 시간: 예전처럼 시간 × 속도
        if (gap > o.blindMs || shakingNoSteps(t)) filledM += gap / 1000 * speed();
      }
      if (lastSeen == null || t > lastSeen) lastSeen = t;
      const n = det.push(t, x, y, z);
      if (n) { segSteps += n; totalSteps += n; lastStepAt = t; }
      if (det.rms > o.activeRms) { if (shakeFrom == null) shakeFrom = t; } else shakeFrom = null;
      if (running && status !== 'active') setStatus('active');
      if (n) emit(false);
      return n;
    };

    /* 마지막 확인 지점부터 걸은 거리(m) = 센 걸음 × 보폭 + 시간으로 채운 거리.
       센서 값이 끊긴 지금 이 순간(화면이 꺼졌다 켜짐 등)도 시간 × 속도로 더한다. 서 있으면 늘지 않는다. */
    tr.distanceSinceCheckpoint = function (at) {
      const t = at != null ? at : now();
      let m = segSteps * est.stride + filledM;
      if (lastSeen != null && t - lastSeen > o.blindMs) m += (t - lastSeen) / 1000 * speed();
      return m;
    };

    /* 체크포인트를 확인했을 때('도착'·'통과'·'환승 완료'). knownM = 지난 확인 지점부터 실제 경로 거리.
       knownM 이 없거나 { calibrate: false } 면 보폭은 그대로 두고 구간만 새로 센다. */
    tr.onCheckpoint = function (knownM, opt) {
      const r = opt && opt.calibrate === false ? { used: false, reason: 'skip', stride: est.stride, steps: segSteps }
        : est.calibrate(knownM, segSteps, filledM);
      segSteps = 0; filledM = 0;
      if (lastSeen != null) lastSeen = Math.max(lastSeen, now());
      emit(true);
      return r;
    };
    tr.resetSegment = function () { return tr.onCheckpoint(null, { calibrate: false }); };

    // 길 안내가 이 값을 써도 되나: 센서 값이 오고 있다(잠깐 숨은 것 포함)
    tr.usable = function () { return status === 'active' || status === 'paused'; };

    // 지금 움직임: 'walking' | 'still'(서 있음) | 'moving'(흔들리는데 걸음을 못 셈) | 'blind'(센서 값 없음)
    tr.motion = function (at) {
      const t = at != null ? at : now();
      if (lastSeen == null || t - lastSeen > o.blindMs) return 'blind';
      if (lastStepAt != null && t - lastStepAt <= o.maxGapMs) return 'walking';
      return shakingNoSteps(t) ? 'moving' : 'still';
    };

    /* ---------- 센서 연결 (DOM) ---------- */
    function onMotion(e) {
      const a = e && e.accelerationIncludingGravity;
      if (!a || a.x == null || a.y == null || a.z == null) return;   // 센서 없는 PC 는 null 을 보내기도 한다
      tr.feed(eventTime(e, w), +a.x, +a.y, +a.z);
    }
    function attach() { if (!attached) { w.addEventListener('devicemotion', onMotion); attached = true; } }
    function detach() { if (attached) { w.removeEventListener('devicemotion', onMotion); attached = false; } }
    function onVisibility() {
      if (!running) return;
      if (doc.visibilityState === 'hidden') { detach(); setStatus('paused'); }   // 숨으면 멈춘다(어차피 값이 안 온다)
      else { attach(); }                                                        // 다시 보이면 값이 오는 대로 'active'
    }

    // 시작: 권한을 묻고(iOS) 센서를 붙인 뒤 첫 값을 기다린다. 결과는 status 값(Promise).
    // iOS 에서는 누르기 처리 안에서 바로 불러야 한다(requestPermission 을 이 함수 안에서 곧바로 부른다).
    tr.start = function () {
      if (running) return Promise.resolve(status);
      if (!w || typeof w.addEventListener !== 'function' || typeof w.DeviceMotionEvent === 'undefined') return Promise.resolve(setStatus('unsupported', 'no-api'));
      if (w.isSecureContext === false) return Promise.resolve(setStatus('insecure'));
      return requestPermissionFromGesture(w).then(function (p) {
        if (p !== 'granted') return setStatus(p === 'prompt' ? 'prompt' : p, p === 'prompt' ? 'needs-tap' : '');
        running = true;
        if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVisibility);
        if (doc && doc.visibilityState === 'hidden') { setStatus('paused'); return status; }
        attach();
        setStatus('starting');
        return new Promise(function (resolve) {
          firstWaiters.push(resolve);
          clearTimeout(noDataTimer);
          // 값이 하나도 안 오면 센서가 없거나 막힌 것(PC, claude.ai 미리보기 iframe). 붙여 둔 채로 두어 늦게 오면 'active'.
          noDataTimer = setTimeout(function () { if (status === 'starting') setStatus('unsupported', 'no-data'); }, o.noDataMs);
        });
      });
    };
    tr.stop = function () {
      running = false;
      detach();
      clearTimeout(noDataTimer);
      if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVisibility);
      setStatus('idle');
      const ws = firstWaiters; firstWaiters = []; ws.forEach(function (f) { f('idle'); });
    };
    tr.requestPermissionFromGesture = function () { return requestPermissionFromGesture(w); };
    tr.detector = det;
    return tr;
  }

  /* ---------- 화면 꺼짐 막기 (Wake Lock) ----------
     keepScreenOn(true): 화면을 켜 둔다. 화면이 숨으면 브라우저가 풀므로 다시 보일 때 다시 잡는다.
     거절(배터리 절약 모드, 미리보기 iframe 의 권한 정책, 지원 안 함)은 조용히 false. */
  const wake = { want: false, sentinel: null, win: null };
  function acquire(w) {
    if (wake.sentinel && !wake.sentinel.released) return Promise.resolve(true);
    if (w.document && w.document.visibilityState === 'hidden') return Promise.resolve(false);   // 보일 때 다시
    let p;
    try { p = w.navigator.wakeLock.request('screen'); } catch (e) { return Promise.resolve(false); }
    return Promise.resolve(p).then(function (s) {
      if (!wake.want) { s.release(); return false; }   // 그사이 껐다
      wake.sentinel = s;
      if (s.addEventListener) s.addEventListener('release', function () { if (wake.sentinel === s) wake.sentinel = null; });
      return true;
    }, function () { return false; });
  }
  function onWakeVisibility() {
    const w = wake.win;
    if (wake.want && w && w.document.visibilityState === 'visible') acquire(w);
  }
  function keepScreenOn(on, win) {
    const w = winOf(win);
    wake.want = !!on;
    if (!w || !w.navigator || !w.navigator.wakeLock || typeof w.navigator.wakeLock.request !== 'function') return Promise.resolve(false);
    if (wake.win !== w) {
      if (wake.win && wake.win.document) wake.win.document.removeEventListener('visibilitychange', onWakeVisibility);
      wake.win = w;
      if (w.document && w.document.addEventListener) w.document.addEventListener('visibilitychange', onWakeVisibility);
    }
    if (on) return acquire(w);
    const s = wake.sentinel;
    wake.sentinel = null;
    return s ? Promise.resolve(s.release()).then(function () { return false; }, function () { return false; }) : Promise.resolve(false);
  }
  function screenKeptOn() { return !!(wake.sentinel && !wake.sentinel.released); }

  UG.pdr = {
    DEFAULTS: DEFAULTS, StepDetector: StepDetector, StrideEstimator: StrideEstimator, create: create,
    requestPermissionFromGesture: requestPermissionFromGesture, keepScreenOn: keepScreenOn, screenKeptOn: screenKeptOn
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = UG.pdr;
})(typeof globalThis !== 'undefined' ? globalThis : this);
