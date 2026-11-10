/* search.js — 출발·도착 검색
   - 검색 제공자(provider)를 차례로 불러 결과를 합친다.
       1) 역 이름(graph.json)  2) 오프라인 장소(places.json, places.js)  3) 온라인 장소(Photon, 인터넷 될 때만)
     오프라인 결과를 먼저 바로 보여 주고, 온라인 결과는 400ms 뒤에 받아 아래에 붙인다.
   - 제공자 모양: { id, limit, minLength, online?, search(query, ctx, signal) -> 결과 배열 또는 Promise }
   - 결과 모양:   { kind: 'station' | 'point', title, sub, badges: [], si?, lat, lon, online? }
       'station' = 역(그 역의 승강장 전부에서 출발·도착), 'point' = 지도 위 한 점(가까운 출구로 잇는다)
   - 같은 이름이 300m 안에 또 나오면 앞의 것만 남긴다(역 > 오프라인 장소 > 온라인).
   - attach(): 입력칸 하나를 자동 완성 콤보박스로 만든다(키보드 위·아래·Enter·Esc). */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};

  const MAX_ITEMS = 10;
  const ONLINE_DELAY = 400;     // 온라인 검색은 입력이 멈추고 400ms 뒤에
  const DEDUPE_M = 300;

  const providers = [];
  function register(p) { providers.push(p); }

  /* ---------- 합치기·겹침 빼기 ---------- */
  function nameKey(s) {
    s = String(s || '').replace(/\([^)]*\)/g, '').replace(/[\s·.\-]/g, '').toLowerCase();
    return s.length > 2 && s.endsWith('역') ? s.slice(0, -1) : s;
  }
  function dedupe(list) {
    const out = [];
    list.forEach(function (r) {
      const k = nameKey(r.title);
      const dup = out.some(function (o) {
        return nameKey(o.title) === k && UG.graph.haversine(o.lat, o.lon, r.lat, r.lon) <= DEDUPE_M;
      });
      if (!dup) out.push(r);
    });
    return out;
  }

  async function run(list, q, ctx, signal) {
    let out = [];
    for (const p of list) {
      if (q.trim().length < (p.minLength || 1)) continue;
      try {
        const r = await p.search(q, ctx, signal);
        out = out.concat((r || []).slice(0, p.limit || 8));
      } catch (e) { /* 제공자 하나가 실패해도 나머지는 보여 준다 */ }
    }
    return out;
  }
  // 오프라인 제공자(역·장소). ctx = { G, near: {lat, lng} | null }
  function query(q, ctx) { return run(providers.filter(function (p) { return !p.online; }), q, ctx); }
  // 온라인 제공자. signal 로 중간에 멈출 수 있다.
  function queryOnline(q, ctx, signal) { return run(providers.filter(function (p) { return p.online; }), q, ctx, signal); }

  /* ---------- 1) 역 이름 ---------- */
  function stationProvider() {
    return {
      id: 'station', limit: 6, minLength: 1,
      search: function (q, ctx) {
        const G = ctx.G, g = G.g;
        return UG.graph.searchStations(G, q, 6).map(function (si) {
          const s = g.stations[si];
          const region = g.tables.regions[s.rg] ? g.tables.regions[s.rg].name : '';   // 같은 이름 역(시청 등)을 지역으로 구분
          return {
            kind: 'station', si: si, title: s.name + (s.name.endsWith('역') ? '' : '역'),
            sub: region, badges: UG.graph.stationLines(G, si), lat: s.lat / 1e5, lon: s.lon / 1e5
          };
        });
      }
    };
  }

  /* ---------- 2) 오프라인 장소 (places.json) ---------- */
  const TYPE_KO = {
    sido: '시·도', sigungu: '시·군·구', dong: '동네', university: '대학교', hospital: '병원', gov: '관공서',
    station: '역', landmark: '명소', apartment: '아파트', school: '학교', police: '경찰서', fire: '소방서',
    library: '도서관', village: '마을'
  };
  // getIndex() -> places.json 내용(아직 없으면 null)
  function placesProvider(getIndex) {
    return {
      id: 'places', limit: 6, minLength: 2,
      search: function (q, ctx) {
        const index = getIndex();
        if (!index || !UG.places) return [];
        const near = ctx.near ? [ctx.near.lat, ctx.near.lng] : null;
        return UG.places.searchPlaces(index, q, { near: near, limit: 6 }).map(function (p) {
          return { kind: 'point', title: p.name, sub: [TYPE_KO[p.type] || '', p.area].filter(Boolean).join(' · '), badges: [], lat: p.lat, lon: p.lon };
        });
      }
    };
  }

  /* ---------- 3) 온라인 장소 (Photon, komoot) ----------
     인터넷이 되고(navigator.onLine) 막히지 않았을 때만. 실패하면(예: Artifact 미리보기가 외부 요청을 막음)
     경고를 한 번만 남기고, 다시 'online' 이벤트가 올 때까지 쓰지 않는다. */
  const PHOTON = 'https://photon.komoot.io/api/';
  let photonOff = false, warned = false;
  if (typeof window !== 'undefined') window.addEventListener('online', function () { photonOff = false; });

  function photonProvider() {
    return {
      id: 'photon', limit: 5, minLength: 2, online: true,
      search: async function (q, ctx, signal) {
        if (photonOff || (typeof navigator !== 'undefined' && navigator.onLine === false)) return [];
        let url = PHOTON + '?q=' + encodeURIComponent(q) + '&lang=default&limit=5&bbox=124,33,132,39';
        if (ctx.near) url += '&lat=' + ctx.near.lat.toFixed(4) + '&lon=' + ctx.near.lng.toFixed(4);
        let data;
        try {
          const res = await fetch(url, { signal: signal });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          data = await res.json();
        } catch (e) {
          if (e && e.name === 'AbortError') throw e;
          photonOff = true;
          if (!warned) { warned = true; console.warn('온라인 장소 검색(Photon)을 쓸 수 없어 오프라인 검색만 씁니다:', e && e.message); }
          return [];
        }
        return (data.features || []).map(function (f) {
          const p = f.properties || {}, c = (f.geometry || {}).coordinates || [];
          const title = p.name || [p.street, p.housenumber].filter(Boolean).join(' ');
          const area = [p.district || p.locality, p.city || p.county, p.state].filter(Boolean);
          return {
            kind: 'point', online: true, title: title, lat: c[1], lon: c[0], badges: [],
            sub: ['온라인'].concat(area.filter(function (a, i) { return area.indexOf(a) === i && a !== title; })).join(' · ')
          };
        }).filter(function (r) { return r.title && isFinite(r.lat) && isFinite(r.lon); });
      }
    };
  }

  /* ---------- 자동 완성 콤보박스 ----------
     opts: { getCtx() -> ctx, isSet(), onPick(result), onClear(), onSave(result)?, onToggle(open)? }
     onSave 가 있으면 결과마다 ☆(저장) 버튼을 붙인다. onToggle 은 목록을 열고 닫을 때 알린다. */
  function attach(input, list, opts) {
    let items = [], offline = [], active = -1, seq = 0, timer = 0, onlineTimer = 0, ctrl = null;
    const esc = UG.panel ? UG.panel.esc : function (s) { return String(s); };

    function close() {
      const was = !list.hidden;
      list.hidden = true;
      if (was && opts.onToggle) opts.onToggle(false);
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      active = -1;
    }
    function options() { return list.querySelectorAll('.ac-opt'); }
    function setActive(i) {
      active = i;
      Array.prototype.forEach.call(options(), function (li, j) { li.setAttribute('aria-selected', String(j === i)); });
      const li = options()[i];
      if (li) { input.setAttribute('aria-activedescendant', li.id); li.scrollIntoView({ block: 'nearest' }); }
      else input.removeAttribute('aria-activedescendant');
    }
    function render(q, keep, waiting) {
      if (!items.length) {
        list.innerHTML = '<li class="ac-empty" role="option" aria-disabled="true" id="' + list.id + '-none">' +
          (waiting ? '찾는 중…' : '"' + esc(q) + '"을(를) 찾지 못했습니다') + '</li>';
      } else {
        list.innerHTML = items.map(function (r, i) {
          const badges = r.badges || [];
          const chip = UG.lines ? UG.lines.chip : function (b) { return '<span class="lc lc-none">' + esc(b) + '</span>'; };
          const shown = badges.slice(0, 3).map(function (b) { return chip(b); }).join('') +
            (badges.length > 3 ? '<span class="lc lc-none">+' + (badges.length - 3) + '</span>' : '');
          return '<li class="ac-opt' + (r.online ? ' is-online' : '') + '" role="option" id="' + list.id + '-' + i + '" data-i="' + i + '" aria-selected="false">' +
            '<span class="ac-main"><span class="ac-title">' + esc(r.title) + '</span>' +
            (r.sub ? '<span class="ac-sub">' + esc(r.sub) + '</span>' : '') + '</span>' +
            '<span class="ac-badges">' + shown + '</span>' +
            (opts.onSave ? '<button type="button" class="ac-save" data-save="' + i + '" tabindex="-1" aria-label="' + esc(r.title) + ' 저장" title="저장">☆</button>' : '') + '</li>';
        }).join('') +
          (items.some(function (r) { return r.online; }) ? '<li class="ac-attr" role="presentation">검색: Photon (© OpenStreetMap)</li>' : '');
      }
      const was = list.hidden;
      list.hidden = false;
      if (was && opts.onToggle) opts.onToggle(true);
      input.setAttribute('aria-expanded', 'true');
      setActive(items.length ? (keep && active >= 0 && active < items.length ? active : 0) : -1);
    }
    async function update() {
      const q = input.value.trim();
      const my = ++seq;
      clearTimeout(onlineTimer);
      if (ctrl) { ctrl.abort(); ctrl = null; }
      if (!q) { items = []; close(); return; }
      const ctx = opts.getCtx();
      offline = dedupe(await query(q, ctx)).slice(0, MAX_ITEMS);
      if (my !== seq) return;      // 더 새 입력이 있으면 버린다
      items = offline;
      const wantOnline = providers.some(function (p) { return p.online; }) && q.length >= 2;
      render(q, false, wantOnline && !items.length);
      if (!wantOnline) return;
      onlineTimer = setTimeout(async function () {
        ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        let more = [];
        try { more = await queryOnline(q, ctx, ctrl && ctrl.signal); } catch (e) { return; }
        if (my !== seq) return;
        items = dedupe(offline.concat(more)).slice(0, MAX_ITEMS + 5);
        if (!list.hidden) render(q, true, false);   // 그새 골랐거나 닫았으면 다시 열지 않는다
      }, ONLINE_DELAY);
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
    input.addEventListener('blur', function () { if (!opts.keepOpen) setTimeout(close, 150); });
    input.addEventListener('change', function () { if (!input.value.trim() && opts.onClear) opts.onClear(); });
    // 누르는 동안 입력칸 포커스를 잃지 않게 mousedown 을 막고, click 으로 고른다
    list.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
    list.addEventListener('click', function (ev) {
      const sv = ev.target.closest('[data-save]');
      if (sv) { ev.stopPropagation(); if (items[+sv.dataset.save]) opts.onSave(items[+sv.dataset.save]); return; }
      const li = ev.target.closest('.ac-opt');
      if (li) pick(+li.dataset.i);
    });
    return { close: close, refresh: update, isOpen: function () { return !list.hidden; } };
  }

  UG.search = {
    providers: providers, register: register, query: query, queryOnline: queryOnline, dedupe: dedupe, TYPE_KO: TYPE_KO,
    stationProvider: stationProvider, placesProvider: placesProvider, photonProvider: photonProvider, attach: attach
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
