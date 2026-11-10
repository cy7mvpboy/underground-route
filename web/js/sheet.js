/* sheet.js — 결과 패널: 폰에서는 아래 시트, 넓은 화면에서는 왼쪽 패널
   - 폰: 높이 세 단계. peek(요약만) / half(화면 절반) / full(검색 막대 아래까지).
     손잡이를 위아래로 끌거나, 누르면 다음 단계로 바뀐다(키보드: Enter·위아래 화살표).
   - 넓은 화면: 단계 없이 왼쪽 패널(CSS 가 크기를 정한다).
   - 높이가 바뀌면 onChange(state, 높이px) 로 알린다(지도 여백, 경로 다시 맞추기에 씀). */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};

  const ORDER = ['peek', 'half', 'full'];
  const NAMES = { peek: '요약', half: '절반', full: '전체' };

  // opts: { el, grip, body, wide(MediaQueryList), peekEl() -> 요약 부분의 끝 요소, topLimit() -> 시트 위쪽 한계(px), onChange, reduceMotion }
  function Sheet(opts) {
    const el = opts.el, grip = opts.grip;
    let state = 'hidden', h = 0, drag = null, raf = 0;

    function H() { return window.innerHeight; }
    function heights() {
      const full = Math.max(200, H() - opts.topLimit());
      let peek = 120;
      const pe = opts.peekEl();
      if (pe && pe.offsetParent) peek = Math.ceil(pe.getBoundingClientRect().bottom - el.getBoundingClientRect().top + 12);
      const half = Math.min(full, Math.max(Math.round(H() * 0.52), peek + 40));
      return { peek: Math.min(peek, half), half: half, full: full };
    }
    function wide() { return opts.wide.matches; }

    function apply(px, animate) {
      h = px;
      el.classList.toggle('is-anim', !!animate && !opts.reduceMotion);
      el.style.height = wide() ? '' : px + 'px';
      notify();
    }
    function notify() {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(function () { opts.onChange(state, visibleHeight()); });
    }
    function visibleHeight() { return state === 'hidden' ? 0 : wide() ? 0 : h; }

    function set(s, animate) {
      if (s === 'hidden') { state = 'hidden'; el.hidden = true; el.dataset.state = 'hidden'; notify(); return; }
      el.hidden = false;
      state = s;
      el.dataset.state = s;
      grip.setAttribute('aria-label', '패널 크기: ' + NAMES[s] + '. 누르면 바꿉니다');
      grip.setAttribute('aria-expanded', String(s !== 'peek'));
      if (wide()) { apply(0, false); return; }
      apply(heights()[s], animate !== false);
    }
    function cycle() { set(ORDER[(ORDER.indexOf(state) + 1) % ORDER.length]); }

    // 끌기: 손가락을 따라 높이를 바꾸고, 놓으면 가까운 단계로 맞춘다
    function down(ev) {
      if (wide() || state === 'hidden' || (ev.button != null && ev.button !== 0)) return;
      drag = { y: ev.clientY, h: h, moved: false, id: ev.pointerId };
      try { grip.setPointerCapture(ev.pointerId); } catch (e) { /* 무시 */ }
    }
    function move(ev) {
      if (!drag) return;
      const dy = drag.y - ev.clientY;
      if (Math.abs(dy) > 6) drag.moved = true;
      if (!drag.moved) return;
      const hs = heights();
      apply(Math.max(hs.peek - 30, Math.min(hs.full, drag.h + dy)), false);
    }
    function up() {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      if (!moved) { cycle(); return; }
      const hs = heights();
      let best = 'peek';
      ORDER.forEach(function (s) { if (Math.abs(hs[s] - h) < Math.abs(hs[best] - h)) best = s; });
      set(best);
    }
    grip.addEventListener('pointerdown', down);
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
    grip.addEventListener('click', function (ev) { if (ev.detail === 0) cycle(); });   // 키보드(Enter·Space)
    grip.addEventListener('keydown', function (ev) {
      const i = ORDER.indexOf(state);
      if (ev.key === 'ArrowUp' && i < 2) { ev.preventDefault(); set(ORDER[i + 1]); }
      if (ev.key === 'ArrowDown' && i > 0) { ev.preventDefault(); set(ORDER[i - 1]); }
    });
    window.addEventListener('resize', function () { if (state !== 'hidden') set(state, false); });
    const onWide = function () { if (state !== 'hidden') set(state, false); };
    if (opts.wide.addEventListener) opts.wide.addEventListener('change', onWide); else if (opts.wide.addListener) opts.wide.addListener(onWide);

    return {
      set: set, cycle: cycle,
      state: function () { return state; },
      height: visibleHeight,
      // 내용이 바뀌어 요약 높이가 달라졌을 때 지금 단계를 다시 맞춘다
      refit: function () { if (state !== 'hidden') set(state, false); }
    };
  }

  UG.sheet = { Sheet: Sheet };
})(typeof globalThis !== 'undefined' ? globalThis : this);
