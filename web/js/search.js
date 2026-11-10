/* search.js — 출발·도착 검색
   - 검색 제공자(provider)를 차례로 불러 결과를 합친다. 지금은 역 이름 제공자 하나뿐이다.
     나중에 장소 색인(places.json)이나 온라인 장소 검색을 같은 모양으로 register() 하면 된다.
   - 제공자 모양: { id, minLength, search(query, ctx) -> 결과 배열 또는 Promise }
   - 결과 모양:   { kind: 'station' | 'point', id, title, sub, badges: [], si?, lat, lon }
       'station' = 역(그 역의 승강장 전부에서 출발·도착), 'point' = 지도 위 한 점(가까운 출구로 잇는다)
   - attach(): 입력칸 하나를 자동 완성 콤보박스로 만든다(키보드 위·아래·Enter·Esc). */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};

  const providers = [];
  function register(p) { providers.push(p); }

  // 모든 제공자에서 찾아 순서대로 합친다. ctx = { G, near: {lat, lon} | null }
  async function query(q, ctx, limit) {
    const out = [];
    for (const p of providers) {
      if (q.trim().length < (p.minLength || 1)) continue;
      try {
        const r = await p.search(q, ctx);
        (r || []).forEach(function (x) { if (out.length < (limit || 8)) out.push(x); });
      } catch (e) { /* 제공자 하나가 실패해도 나머지는 보여 준다 */ }
    }
    return out;
  }

  /* ---------- 역 이름 제공자 ---------- */
  function stationProvider() {
    return {
      id: 'station', minLength: 1,
      search: function (q, ctx) {
        const G = ctx.G, g = G.g;
        const hits = UG.graph.searchStations(G, q, 8);
        return hits.map(function (si) {
          const s = g.stations[si];
          const region = g.tables.regions[s.rg] ? g.tables.regions[s.rg].name : '';   // 같은 이름 역(시청 등)을 지역으로 구분
          return {
            kind: 'station', id: 'st:' + si, si: si, title: s.name + (s.name.endsWith('역') ? '' : '역'),
            sub: region, badges: UG.graph.stationLines(G, si),
            lat: s.lat / 1e5, lon: s.lon / 1e5
          };
        });
      }
    };
  }

  /* ---------- 자동 완성 콤보박스 ----------
     opts: { getCtx() -> ctx, onPick(result), onClear() } */
  function attach(input, list, opts) {
    let items = [], active = -1, seq = 0, timer = 0;
    const esc = UG.panel ? UG.panel.esc : function (s) { return String(s); };

    function close() {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      active = -1;
    }
    function setActive(i) {
      active = i;
      Array.prototype.forEach.call(list.children, function (li, j) { li.setAttribute('aria-selected', String(j === i)); });
      if (i >= 0 && list.children[i]) {
        input.setAttribute('aria-activedescendant', list.children[i].id);
        list.children[i].scrollIntoView({ block: 'nearest' });
      } else input.removeAttribute('aria-activedescendant');
    }
    function render(q) {
      if (!items.length) {
        list.innerHTML = '<li class="ac-empty" role="option" aria-disabled="true" id="' + list.id + '-none">"' + esc(q) + '" 역을 찾지 못했습니다</li>';
      } else {
        list.innerHTML = items.map(function (r, i) {
          const badges = r.badges || [];
          const shown = badges.slice(0, 3).map(function (b) { return '<span class="lb">' + esc(b) + '</span>'; }).join('') +
            (badges.length > 3 ? '<span class="lb">+' + (badges.length - 3) + '</span>' : '');
          return '<li class="ac-opt" role="option" id="' + list.id + '-' + i + '" data-i="' + i + '" aria-selected="false">' +
            '<span class="ac-main"><span class="ac-title">' + esc(r.title) + '</span>' +
            (r.sub ? '<span class="ac-sub">' + esc(r.sub) + '</span>' : '') + '</span>' +
            '<span class="ac-badges">' + shown + '</span></li>';
        }).join('');
      }
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      setActive(items.length ? 0 : -1);
    }
    async function update() {
      const q = input.value.trim();
      const my = ++seq;
      if (!q) { items = []; close(); return; }
      const r = await query(q, opts.getCtx(), 8);
      if (my !== seq) return;      // 더 새 입력이 있으면 버린다
      items = r;
      render(q);
    }
    function pick(i) {
      const r = items[i];
      if (!r) return;
      close();
      input.value = r.title;
      opts.onPick(r);
    }

    input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(update, 60); });
    input.addEventListener('focus', function () { if (input.value.trim() && !opts.isSet()) update(); else input.select(); });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        if (list.hidden) { update(); return; }
        ev.preventDefault();
        if (!items.length) return;
        const d = ev.key === 'ArrowDown' ? 1 : -1;
        setActive((active + d + items.length) % items.length);
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        if (!list.hidden && items.length) pick(active >= 0 ? active : 0);
      } else if (ev.key === 'Escape') {
        if (!list.hidden) { ev.preventDefault(); close(); }
      }
    });
    input.addEventListener('blur', function () { setTimeout(close, 150); });
    input.addEventListener('change', function () { if (!input.value.trim() && opts.onClear) opts.onClear(); });
    // 누르는 동안 입력칸 포커스를 잃지 않게 mousedown 을 막고, click 으로 고른다
    list.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
    list.addEventListener('click', function (ev) {
      const li = ev.target.closest('.ac-opt');
      if (li) pick(+li.dataset.i);
    });
    return { close: close, refresh: update };
  }

  UG.search = { providers: providers, register: register, query: query, stationProvider: stationProvider, attach: attach };
})(typeof globalThis !== 'undefined' ? globalThis : this);
