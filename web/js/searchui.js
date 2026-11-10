/* searchui.js — 검색 화면(전체 화면 시트)과 '장소 저장' 대화상자
   - 검색 화면: 출발(비워 두면 '내 위치', 안 되면 지도 중심) · 도착 입력칸, 바꾸기 버튼.
     입력칸이 비어 있으면 빠른 길(가족 약속 장소까지 지하로), 저장한 장소, 최근 검색을 보여 주고,
     글자를 넣으면 검색 결과(역 · 오프라인 장소 · 온라인 장소)를 보여 준다.
   - 고른 결과는 opts.onPick(which, 결과) 로 app.js 에 넘긴다. 이 파일은 경로를 찾지 않는다.
   - 장소 저장: 집 / 가족 약속 장소 / 직접 붙인 이름. prompt() 대신 작은 대화상자를 쓴다. */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};

  function esc(s) { return UG.panel.esc(s); }
  function svg(path) { return UG.station.svg(path); }
  const CLOCK = '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>';

  // 저장한 장소·최근 검색 -> 검색 결과 모양. 역 번호가 지금 그래프와 맞지 않으면 지점으로 쓴다.
  function toResult(p, G) {
    const r = { kind: p.kind, title: p.title, sub: p.sub || '', lat: p.lat, lon: p.lon, badges: [] };
    if (p.kind === 'station') {
      const s = G && G.g.stations[p.si];
      if (s && UG.panel.yeok(s.name) === p.title) { r.si = p.si; r.badges = UG.graph.stationLines(G, p.si); }
      else r.kind = 'point';
    }
    return r;
  }

  /* opts: { root, from: {input, list}, to: {input, list}, home, back, swap, here,
             getCtx(), getGraph(), isSet(which), onPick(which, r), onClearFrom(), onSwap(), onQuick(place), onSaveRequest(r), onClose() } */
  function SearchUI(opts) {
    const SV = UG.saved, SR = UG.search;
    let lastFocus = null, active = 'to';
    const combos = {};

    ['from', 'to'].forEach(function (which) {
      const f = opts[which];
      combos[which] = SR.attach(f.input, f.list, {
        keepOpen: true,
        getCtx: opts.getCtx,
        isSet: function () { return opts.isSet(which); },
        onPick: function (r) { SV.addRecent(r); opts.onPick(which, r); },
        onClear: function () { if (which === 'from') opts.onClearFrom(); },
        onSave: function (r) { opts.onSaveRequest(r); },
        onToggle: function () { syncHome(); }
      });
      f.input.addEventListener('focus', function () {
        active = which;
        combos[which === 'from' ? 'to' : 'from'].close();
        syncHome();
        opts.root.dataset.active = which;
      });
      f.input.addEventListener('input', function () { if (!f.input.value.trim()) combos[which].close(); syncHome(); });
    });
    function syncHome() { opts.home.hidden = combos.from.isOpen() || combos.to.isOpen(); }

    function renderHome() {
      const places = SV.places(), recent = SV.recent();
      const fam = places.find(function (p) { return p.name === SV.FAMILY; });
      const I = UG.station.ICONS;
      let html = '<section class="ss-sec">';
      html += fam
        ? '<button type="button" class="qa qa-strong" data-quick="' + esc(fam.id) + '">' + svg(I.family) +
          '<span class="qa-t"><b>가족 약속 장소까지 지하로</b><small>' + esc(fam.title) + '</small></span>' + svg('<path d="M9 6l6 6-6 6"/>') + '</button>'
        : '<p class="qa-empty">' + svg(I.family) + '<span><b>가족 약속 장소</b> 저장: 검색 결과 ☆ · 지도 길게 누르기</span></p>';
      html += '</section>';
      html += '<section class="ss-sec" aria-labelledby="ss-saved-h"><h3 class="sub-h" id="ss-saved-h">저장한 장소</h3>';
      if (places.length) {
        html += '<ul class="ss-list">' + places.map(function (p) {
          const icon = p.name === SV.HOME ? I.home : p.name === SV.FAMILY ? I.family : I.pin;
          return '<li><button type="button" class="ss-item" data-saved="' + esc(p.id) + '">' + svg(icon) +
            '<span class="qa-t"><b>' + esc(p.name) + '</b><small>' + esc(p.title) + '</small></span></button>' +
            '<button type="button" class="icon-btn ss-del" data-del="' + esc(p.id) + '" aria-label="' + esc(p.name) + ' 지우기" title="지우기">' +
            svg('<path d="M6 6l12 12M18 6L6 18"/>') + '</button></li>';
        }).join('') + '</ul>';
      } else {
        html += '<p class="muted ss-tip">없음</p>';
      }
      html += '</section>';
      if (recent.length) {
        html += '<section class="ss-sec" aria-labelledby="ss-recent-h"><h3 class="sub-h" id="ss-recent-h">최근 검색 <button type="button" class="link-btn" data-clear-recent>지우기</button></h3>' +
          '<ul class="ss-list">' + recent.map(function (p, i) {
            return '<li><button type="button" class="ss-item" data-recent="' + i + '">' + svg(CLOCK) +
              '<span class="qa-t"><b>' + esc(p.title) + '</b>' + (p.sub ? '<small>' + esc(p.sub) + '</small>' : '') + '</span></button></li>';
          }).join('') + '</ul></section>';
      }
      opts.home.innerHTML = html;
    }

    opts.home.addEventListener('click', function (ev) {
      const t = ev.target.closest('button');
      if (!t) return;
      const places = SV.places();
      if (t.dataset.quick) { const p = places.find(function (x) { return x.id === t.dataset.quick; }); if (p) opts.onQuick(p); return; }
      if (t.dataset.saved) { const p = places.find(function (x) { return x.id === t.dataset.saved; }); if (p) opts.onPick(active, toResult(p, opts.getGraph())); return; }
      if (t.dataset.recent != null) { const p = SV.recent()[+t.dataset.recent]; if (p) opts.onPick(active, toResult(p, opts.getGraph())); return; }
      if (t.dataset.del) { SV.removePlace(t.dataset.del); renderHome(); return; }
      if (t.hasAttribute('data-clear-recent')) { SV.clearRecent(); renderHome(); }
    });
    opts.back.addEventListener('click', close);
    opts.swap.addEventListener('click', function () { opts.onSwap(); });
    opts.here.addEventListener('click', function () { opts.onClearFrom(); opts.from.input.value = ''; opts.to.input.focus(); });
    opts.root.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && !ev.defaultPrevented) { ev.preventDefault(); close(); } });

    function open(o) {
      o = o || {};
      if (opts.root.hidden) lastFocus = document.activeElement;
      opts.root.hidden = false;
      document.documentElement.classList.add('search-open');
      renderHome();
      syncHome();
      const f = opts[o.focus === 'from' ? 'from' : 'to'];
      f.input.focus();
    }
    function close() {
      if (opts.root.hidden) return;
      combos.from.close(); combos.to.close();
      opts.root.hidden = true;
      document.documentElement.classList.remove('search-open');
      if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus();
      if (opts.onClose) opts.onClose();
    }
    return {
      open: open, close: close, renderHome: renderHome,
      isOpen: function () { return !opts.root.hidden; },
      setText: function (which, text) { opts[which].input.value = text || ''; }
    };
  }

  /* ---------- 장소 저장 대화상자 ----------
     opts: { root(감싸는 div), title, what, buttons(집·가족 버튼 상자), form, name, cancel, onSaved(name, r) } */
  function SaveDialog(opts) {
    const SV = UG.saved;
    let cur = null, lastFocus = null;
    function render() {
      const I = UG.station.ICONS;
      opts.what.textContent = cur.title;
      opts.buttons.innerHTML = [[SV.HOME, I.home], [SV.FAMILY, I.family]].map(function (x) {
        const old = SV.placeByName(x[0]);
        return '<button type="button" class="qa" data-name="' + esc(x[0]) + '">' + svg(x[1]) +
          '<span class="qa-t"><b>' + esc(x[0]) + '</b><small>' + (old ? '지금: ' + esc(old.title) + ' (바꿉니다)' : '아직 없음') + '</small></span></button>';
      }).join('');
      opts.name.value = '';
    }
    function open(r) {
      cur = r;
      lastFocus = document.activeElement;
      render();
      opts.root.hidden = false;
      const first = opts.buttons.querySelector('button');
      if (first) first.focus();
    }
    function close() {
      opts.root.hidden = true;
      cur = null;
      if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus();
    }
    function save(name) {
      if (!cur || !name) return;
      const r = cur, ok = SV.savePlace(name, r);
      close();
      opts.onSaved(name, r, ok);
    }
    opts.buttons.addEventListener('click', function (ev) { const b = ev.target.closest('[data-name]'); if (b) save(b.dataset.name); });
    opts.form.addEventListener('submit', function (ev) { ev.preventDefault(); save(opts.name.value.trim()); });
    opts.cancel.addEventListener('click', close);
    opts.root.addEventListener('click', function (ev) { if (ev.target === opts.root) close(); });   // 바깥(어두운 배경)을 누르면 닫기
    opts.root.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); close(); return; }
      if (ev.key !== 'Tab') return;   // 대화상자 안에서만 Tab 이 돈다
      const f = Array.prototype.filter.call(opts.root.querySelectorAll('button, input'), function (x) { return !x.disabled && x.offsetParent; });
      if (!f.length) return;
      if (ev.shiftKey && document.activeElement === f[0]) { ev.preventDefault(); f[f.length - 1].focus(); }
      else if (!ev.shiftKey && document.activeElement === f[f.length - 1]) { ev.preventDefault(); f[0].focus(); }
    });
    return { open: open, close: close, isOpen: function () { return !opts.root.hidden; } };
  }

  UG.searchui = { SearchUI: SearchUI, SaveDialog: SaveDialog, toResult: toResult };
})(typeof globalThis !== 'undefined' ? globalThis : this);
