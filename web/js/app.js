/* app.js — 화면을 묶는 곳: 시작, 출발·도착 고르기, 경로 찾기, 안내 표시, 가장 가까운 지하로, 길 안내 모드, 패널·레이어 버튼
   모듈: graph.js(데이터) · router.js(탐색) · steps.js(안내 단계) · nearest.js(가까운 지하역) · guide.js(길 안내 모드)
         places.js(오프라인 장소) · search.js(검색) · layers.js(지도) · panel.js(패널 HTML)
   다른 코드가 쓸 수 있는 연결점은 맨 아래 UG.app 에 모았다. */
(function (root) {
  'use strict';
  const UG = root.UG;
  const GR = UG.graph, RT = UG.router, ST = UG.steps, LY = UG.layers, PN = UG.panel, SR = UG.search;

  /* =========================================================
     0. 설정
     ========================================================= */
  const CFG = {
    dataUrl: 'data/graph.json',
    basemapUrl: 'data/basemap.json',
    placesUrl: 'data/places.json',
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    koreaBounds: [[33.9, 125.0], [38.7, 129.9]],
    stationMinZoom: 11,
    exitMinZoom: 15,
    wideQuery: '(min-width: 760px)',
    prefsKey: 'ugmap.layers.v1',
    speedKey: 'ugmap.speed.v1',
    speeds: [3.0, 3.5, 4.0]
  };
  const GEO_DENIED = '이 미리보기에서는 위치를 쓸 수 없어요. 지도를 눌러 출발점을 고르세요.';

  const ERROR_TEXT = {
    http: function (d) { return ['철도망 데이터를 불러오지 못했습니다 (HTTP ' + d + ').', 'data/graph.json 파일이 이 페이지와 같은 위치에 있어야 합니다.']; },
    network: function () { return ['철도망 데이터를 받지 못했습니다.', '인터넷 연결을 확인한 뒤 다시 시도하세요.']; },
    format: function () { return ['철도망 데이터 형식이 맞지 않습니다.', 'graph.json을 다시 만들어 올려 주세요.']; },
    leaflet: function () { return ['지도 프로그램(Leaflet)을 불러오지 못했습니다.', '인터넷 연결을 확인한 뒤 페이지를 새로 고치세요.']; }
  };

  /* =========================================================
     1. 설정 저장 (이 브라우저에만, 못 쓰면 기본값)
     ========================================================= */
  function loadPref(key, def) {
    try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v == null ? def : v; } catch (e) { return def; }
  }
  function savePref(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* 무시 */ } }

  function loadVis() {
    const def = { tunnel: true, bridge: true, ground: true, service: true };
    const s = loadPref(CFG.prefsKey, null);
    if (s && typeof s === 'object') Object.keys(def).forEach(function (k) { if (typeof s[k] === 'boolean') def[k] = s[k]; });
    return def;
  }

  /* =========================================================
     2. 시작
     ========================================================= */
  function getUi() {
    const $ = function (id) { return document.getElementById(id); };
    return {
      app: $('app'), mapEl: $('map'), side: $('side'), search: $('search'), panel: $('panel'),
      fromInput: $('from-input'), toInput: $('to-input'), fromList: $('from-list'), toList: $('to-list'),
      locate: $('locate'), swap: $('swap'), clear: $('clear'),
      sheetToggle: $('sheet-toggle'), peekText: $('peek-text'), peekAct: $('peek-act'), scroll: $('panel-scroll'),
      tabs: [$('tab-btn-route'), $('tab-btn-stats')], tabRoute: $('tab-route'), tabStats: $('tab-stats'), routeView: $('route-view'),
      peekTotal: $('peek-total'), peekTunnel: $('peek-tunnel'), peekBar: $('peek-bar'),
      nationRows: $('nation-rows'), nationFoot: $('nation-foot'), stationCount: $('station-count'), regionRows: $('region-rows'), srcNote: $('src-note'),
      lyrPop: $('lyr-pop'), onlyUnder: $('only-under'), stationHint: $('station-hint'),
      toggles: Array.prototype.slice.call(document.querySelectorAll('.chip-input')),
      toast: $('toast'), status: $('status'), statusTitle: $('status-title'), statusDetail: $('status-detail'),
      statusProgress: $('status-progress'), retry: $('retry'), goUnder: $('go-under')
    };
  }

  const state = {
    ui: null, wide: null, reduceMotion: false, vis: null, speed: 3.5,
    map: null, pal: null, G: null, g: null, bounds: null,
    net: null, st: null, exits: null, route: null, basemap: null, tiles: 'unknown', badge: null,
    from: null, to: null, plan: null, blocked: new Set(), blockCount: 0, activeItem: -1,
    places: null, nearest: null, openSheetOnPlan: false, guide: null,
    loading: false, lastPopupClose: 0, fitToken: 0, listeners: []
  };

  function boot() {
    const ui = state.ui = getUi();
    state.wide = matchMedia(CFG.wideQuery);
    state.reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    state.vis = loadVis();
    const sp = +loadPref(CFG.speedKey, 3.5);
    state.speed = CFG.speeds.indexOf(sp) >= 0 ? sp : 3.5;

    state.R = PN.mountRoute(ui.routeView, state.speed);
    state.R.speed.addEventListener('change', function () { setSpeed(+state.R.speed.value); });
    ui.routeView.addEventListener('click', onRouteViewClick);
    renderIdle();

    setupSheet();
    setupTabs();
    setupSearch();
    ui.retry.addEventListener('click', start);

    if (window.L) {
      try {
        state.map = LY.createMap(ui.mapEl, state.reduceMotion);
        state.map.setView([36.3, 127.8], 7);          // 먼저 기본 보기를 정하고
        fitSafe(L.latLngBounds(CFG.koreaBounds));     // 크기가 있으면 한국 전체에 맞춘다
        LY.addBaseTiles(state.map, CFG.tileUrl, setTiles);
        setupLayerControl();
        setupMapPicking();
      } catch (e) { state.map = null; }
    }
    start();
  }

  async function start() {
    const ui = state.ui;
    if (state.loading) return;
    state.loading = true;
    ui.retry.hidden = true;
    setStatus('busy', '철도망 데이터를 불러오는 중입니다', '약 3 MB');
    let g;
    try {
      g = await GR.loadGraph(CFG.dataUrl, function (bytes) { ui.statusDetail.textContent = (bytes / 1048576).toFixed(1) + ' MB 받음'; });
    } catch (e) {
      state.loading = false;
      const t = (ERROR_TEXT[e.kind] || ERROR_TEXT.network)(e.detail);
      setStatus('error', t[0], t[1]);
      ui.retry.hidden = false;
      return;
    }
    state.g = g;
    state.G = GR.indexGraph(g);                 // 인접 목록 등은 한 번만 만든다
    state.bounds = LY.computeBounds(g);
    PN.renderStats(ui, PN.computeStats(g), g, zoomToRegion);
    // 검색 제공자: 역 -> 오프라인 장소(places.json, 나중에 받음) -> 온라인 장소(Photon)
    SR.register(SR.stationProvider());
    SR.register(SR.placesProvider(function () { return state.places; }));
    SR.register(SR.photonProvider());
    ui.fromInput.disabled = ui.toInput.disabled = false;

    if (!state.map) {
      const t = ERROR_TEXT.leaflet();
      setStatus('error', t[0], t[1]);
      return;
    }
    setStatus('busy', '선로를 그리는 중입니다', '');
    await nextFrame();
    drawLayers();
    const b = state.bounds.all;
    if (b[0] < b[2] && !state.plan) fitSafe(L.latLngBounds([[b[0], b[1]], [b[2], b[3]]]));
    setStatus('hidden');
    loadBasemap().then(loadPlaces);   // 둘 다 첫 화면을 막지 않는다
    emit();
  }

  // 오프라인 장소 색인: 없거나 아직 안 만들어졌으면 역 검색만 쓴다
  async function loadPlaces() {
    if (!UG.places) return;
    let data;
    try { data = await GR.fetchJson(CFG.placesUrl); } catch (e) { return; }
    if (data && data.format === 'places-1' && Array.isArray(data.p)) state.places = data;
  }

  // 상태 문구가 먼저 그려지게 한 프레임 쉰다. 숨은 탭에서는 rAF 가 멈추므로 타이머로도 넘어간다.
  function nextFrame() {
    return new Promise(function (r) {
      let done = false;
      const go = function () { if (!done) { done = true; setTimeout(r, 0); } };
      requestAnimationFrame(go);
      setTimeout(go, 120);
    });
  }

  function drawLayers() {
    const map = state.map, g = state.g, G = state.G;
    state.pal = LY.readPalette();
    state.net = LY.NetworkLayer(map, g);
    state.net.setPalette(state.pal);
    state.net.setVisible(state.vis);
    state.st = LY.StationLayer(map, g, {
      minZoom: CFG.stationMinZoom,
      popupHtml: function (st) { return PN.stationPopupHtml(st, g.tables); },
      popupPad: popupPadding
    });
    state.st.setPalette(state.pal);
    state.exits = LY.ExitLayer(map, G, {
      minZoom: CFG.exitMinZoom,
      popupHtml: function (i) { return PN.exitPopupHtml(g.stations[g.entrances.station[i]].name, g.entrances.ref[i], i); }
    });
    state.route = LY.RouteLayer(map);
    state.route.setPalette(state.pal);
    syncStationHint();
    map.on('zoomend', function () { state.net.onZoom(); syncStationHint(); });
    LY.watchTheme(function () {
      state.pal = LY.readPalette();
      state.net.setPalette(state.pal); state.st.setPalette(state.pal); state.route.setPalette(state.pal);
      if (state.basemap) state.basemap.setPalette(state.pal);
    });
    refreshPins();
  }

  function syncStationHint() {
    const show = state.st.sync(false);
    state.ui.stationHint.textContent = show ? '역을 누르면 정보가 나옵니다' : '역은 더 확대하면 보입니다';
  }

  // 간이 배경 지도: 없으면 조용히 넘어간다(철도망만으로 동작)
  async function loadBasemap() {
    let data;
    try { data = await GR.fetchJson(CFG.basemapUrl); } catch (e) { return; }
    if (!data || data.format !== 'basemap-1' || !Array.isArray(data.lines)) return;
    try {
      state.basemap = LY.BasemapLayer(state.map, data);
      state.basemap.setPalette(state.pal);
      state.basemap.setLabels(state.tiles !== 'ok');
    } catch (e) { state.basemap = null; }
    syncBadge();
  }

  function setTiles(s) {
    state.tiles = s;
    state.ui.app.classList.toggle('no-tiles', s === 'none');
    if (state.basemap) state.basemap.setLabels(s !== 'ok');   // 타일이 있으면 타일의 지명을 쓴다
    syncBadge();
  }
  function syncBadge() {
    if (!state.badge) return;
    const el = state.badge.getContainer().firstChild;
    el.hidden = state.tiles !== 'none';
    el.textContent = state.basemap ? '온라인 지도 없음 · 간이 배경 지도' : '배경 지도 없음 · 철도망만 표시';
  }

  function setStatus(mode, title, detail) {
    const ui = state.ui;
    ui.status.hidden = mode === 'hidden';
    ui.status.classList.toggle('is-error', mode === 'error');
    ui.statusProgress.hidden = mode !== 'busy';
    ui.statusTitle.textContent = title || '';
    ui.statusDetail.textContent = detail || '';
    ui.statusDetail.hidden = !detail;
  }

  let toastTimer = 0;
  function toast(text, ms) {
    const el = state.ui.toast;
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, ms || 6000);
  }

  /* =========================================================
     3. 출발·도착 (끝점)
        역:  {kind:'station', si, text}
        점:  {kind:'point', lat, lon, conn(가까운 출구 후보), label(안내 문장용), text(입력칸)}
     ========================================================= */
  function stationEndpoint(si) {
    const s = state.g.stations[si];
    return { kind: 'station', si: si, lat: s.lat / 1e5, lon: s.lon / 1e5, text: PN.yeok(s.name) };
  }

  // 지도 위 점. label: '내 위치' | '고른 지점' | '서울역 3번 출구' 등
  function pointEndpoint(lat, lon, label, exact) {
    const conn = RT.connectPoint(state.G, lat, lon);
    if (!conn.length) return null;
    const near = nearText(conn[0]);
    const text = exact ? label : (label === '고른 지점' ? near + ' 부근' : label + ' (' + near + ' 부근)');
    return { kind: 'point', lat: lat, lon: lon, conn: conn, label: label, text: text };
  }

  function nearText(c) {
    const name = state.g.stations[c.si].name;
    return c.kind === 'entrance' ? PN.exitName(name, c.ref) : PN.yeok(name);
  }

  function setEndpoint(which, ep) {
    state[which] = ep;
    state.nearest = null;                 // 직접 고르면 '가장 가까운 지하로' 후보는 지운다
    const input = which === 'from' ? state.ui.fromInput : state.ui.toInput;
    input.value = ep ? ep.text : '';
    update();
  }

  function swapEndpoints() {
    const f = state.from;
    state.from = state.to; state.to = f;
    state.nearest = null;
    state.ui.fromInput.value = state.from ? state.from.text : '';
    state.ui.toInput.value = state.to ? state.to.text : '';
    update();
  }

  function clearAll() {
    state.from = state.to = null;
    state.nearest = null;
    state.ui.fromInput.value = state.ui.toInput.value = '';
    update();
    if (state.map && state.bounds) {
      const b = state.bounds.all;
      fitSafe(L.latLngBounds([[b[0], b[1]], [b[2], b[3]]]));
    }
  }

  /* =========================================================
     4. 경로 찾기 -> 안내 목록
     ========================================================= */
  function update() {
    state.plan = null;
    state.activeItem = -1;
    const f = state.from, t = state.to;
    if (!state.G || !f || !t) { renderIdle(); refreshPins(); emit(); return; }
    if (f.kind === 'station' && t.kind === 'station' && f.si === t.si) {
      renderIdle('출발과 도착이 같은 역입니다.'); refreshPins(); emit(); return;
    }
    // 지하로 갈 길이 없으면(막은 구간, 끊긴 노선) 역 사이를 지상으로 걷는 길도 넣어 다시 찾는다
    const route = RT.findRoute(state.G, f, t, { blocked: state.blocked }) || RT.findRoute(state.G, f, t, { blocked: state.blocked, surface: true });
    if (!route) {
      renderIdle('경로를 찾지 못했습니다. 두 곳을 잇는 선로가 그래프에 없습니다.', true); refreshPins(); emit(); return;
    }
    state.plan = { from: f, to: t, route: route, nearest: state.nearest };
    // 폰: 시트를 접어 둔 채(요약 한 줄) 경로 전체를 지도에 보여 준다. 단계는 시트를 펼쳐 본다.
    // '가장 가까운 지하로'는 후보 목록이 결과라서 시트를 펼친다.
    if (!state.wide.matches) setSheetOpen(state.openSheetOnPlan);
    state.openSheetOnPlan = false;
    describePlan();
    drawPlan(true);
    emit();
  }

  // 속도가 바뀌면 단계만 다시 만든다(경로는 그대로)
  function describePlan() {
    const p = state.plan;
    ST.planItems(state.G, p, state.speed);      // p.desc, p.items, p.view (steps.js)
    p.view.nearest = p.nearest;
    p.view.blocked = state.blockCount;
    PN.renderRoute(state.R, p.view);
    if (p.nearest) {
      const o = p.nearest.options[p.nearest.chosen];
      setPeek('가장 가까운 지하: ' + PN.esc(o.kind === 'entrance' ? PN.exitName(o.name, o.ref) : PN.yeok(o.name)) + ' · 지상 <span class="bad">' + PN.fmtDist(o.len) + '</span>');
    } else setPeek(PN.peekText(p.view));
  }

  function setSpeed(v) {
    if (CFG.speeds.indexOf(v) < 0) return;
    state.speed = v;
    savePref(CFG.speedKey, v);
    if (state.plan) { describePlan(); emit(); }
  }

  function renderIdle(message, error) {
    const f = state.from, t = state.to;
    const desc = function (ep) {
      if (!ep) return '';
      if (ep.kind !== 'point') return ep.text;
      const c = ep.conn[0];
      return ep.text + ' · 가장 가까운 ' + (c.kind === 'entrance' ? '출구' : '역') + ' ' + PN.fmtDist(c.dist);
    };
    PN.renderIdle(state.R, { message: message, error: error, fromText: desc(f), toText: desc(t), blocked: state.blockCount });
    setSheetOpen(!state.ui.panel.classList.contains('is-collapsed'));   // '단계 보기' 문구를 되돌린다
    setPeek(message ? PN.esc(message) : f && !t ? '도착 역을 검색하거나 지도를 누르세요' : t && !f ? '출발 역을 검색하거나 지도를 누르세요' : '역을 검색하거나 지도를 눌러 고르세요');
  }

  /* =========================================================
     5. 지도에 경로 그리기, 단계 누르면 확대
     ========================================================= */
  function endpointLatLng(ep) { return ep ? { lat: ep.lat, lon: ep.lon } : null; }

  function refreshPins() {
    if (!state.route) return;
    state.route.pins(endpointLatLng(state.from), endpointLatLng(state.to));
    state.net.setDim(false);
    state.exits.setUsed([]);
    drawBlocked();
  }

  // 막은 구간(앞이 막힘)을 지도에 회색 점선으로
  function drawBlocked() {
    const g = state.g;
    state.route.setBlocked(Array.from(state.blocked).map(function (e) { return GR.edgeShape(g, e); }));
  }

  function drawPlan(fit) {
    if (!state.route) return;
    const p = state.plan, r = p.route, G = state.G, g = state.g;
    const segs = [];
    const push = function (pts, exposed, walk) {
      const last = segs[segs.length - 1];
      if (last && !walk && !last.walk && last.exposed === exposed) last.pts = last.pts.concat(pts.slice(1));
      else segs.push({ pts: pts, exposed: exposed, walk: walk });
    };
    if (r.walk) push([[p.from.lat, p.from.lon], [p.to.lat, p.to.lon]], true, true);
    if (r.startConn) push([[p.from.lat, p.from.lon], [r.startConn.lat, r.startConn.lon]], true, true);
    r.path.forEach(function (e) {   // 역 사이 지상 걷기 간선은 걷는 선으로
      const walk = g.edges.k[e.e] === G.codes.surface;
      push(GR.edgeShape(g, e.e, e.u), ST.isExposed(G, e.e), walk);
    });
    if (r.endConn) push([[r.endConn.lat, r.endConn.lon], [p.to.lat, p.to.lon]], true, true);
    const exits = [];
    [r.startConn, r.endConn].forEach(function (c) {
      if (c && c.kind === 'entrance') exits.push({ lat: c.lat, lon: c.lon, ref: c.ref, title: PN.exitName(g.stations[c.si].name, c.ref) });
    });
    const warnings = p.desc.steps.filter(function (s) { return s.type === 'warning'; });
    state.route.show({ segs: segs, from: endpointLatLng(p.from), to: endpointLatLng(p.to), exits: exits, warnings: warnings });
    state.exits.setUsed([r.startConn, r.endConn].filter(function (c) { return c && c.kind === 'entrance'; }).map(function (c) { return c.ent; }));
    state.net.setDim(true);
    drawBlocked();
    if (fit) {
      const all = [];
      segs.forEach(function (s) { s.pts.forEach(function (q) { all.push(q); }); });
      all.push([p.from.lat, p.from.lon], [p.to.lat, p.to.lon]);
      fitTo(all, 16);
    }
  }

  // 단계 하나가 덮는 선(지도 강조·확대용)
  function itemLines(it) {
    const p = state.plan, g = state.g;
    if (it.kind === 'step') {
      return (it.step._idx || []).map(function (i) { const e = p.route.path[i]; return GR.edgeShape(g, e.e, e.u); });
    }
    if (it.kind === 'arrive') return [it.latlngs.concat(it.others.map(function (x) { return GR.nodeLatLng(g, g.entrances.node[x.ent]); }))];
    return [it.latlngs];
  }

  function focusItem(i) {
    const p = state.plan;
    if (!p || !p.items[i] || !state.map) return;
    state.activeItem = i;
    const lines = itemLines(p.items[i]);
    state.route.highlight(p.items[i].kind === 'arrive' ? null : lines);
    Array.prototype.forEach.call(state.ui.routeView.querySelectorAll('[data-item]'), function (b) {
      b.classList.toggle('is-active', +b.dataset.item === i);
    });
    if (!state.wide.matches) {   // 폰: 시트를 접어 지도를 보이게 하고, 접힌 줄에 단계 이름을 보여 준다
      setSheetOpen(false);
      setPeek('단계 ' + (i + 1) + '/' + p.items.length + ' · ' + itemTitle(p.items[i]));
    }
    const pts = [];
    lines.forEach(function (l) { l.forEach(function (q) { pts.push(q); }); });
    fitTo(pts, 17);
  }

  function itemTitle(it) {
    if (it.kind === 'enter' || it.kind === 'exit') return PN.esc(PN.exitName(it.stName, it.conn.ref));
    if (it.kind === 'arrive') return PN.esc(PN.yeok(it.stName)) + ' 도착';
    if (it.kind === 'walk') return '지상으로 바로 걷기';
    const s = it.step;
    if (s.type === 'warning') return '<span class="bad">지상 노출 ' + PN.fmtDist(s.exposure_m) + '</span>';
    if (s.type === 'transfer') return '환승 · ' + PN.esc(s.station);
    if (s.type === 'surface') return '지상 걷기 → ' + PN.esc(PN.exitName(s.to_station, s.to_ref));
    return PN.esc(s.label) + ' → ' + PN.esc(s.to_station);
  }

  function fitTo(pts, maxZoom) {
    if (!pts.length || !state.map) return;
    fitSafe(L.latLngBounds(pts), { maxZoom: maxZoom, animate: !state.reduceMotion });
  }

  // 지도 크기가 0 이면(숨은 탭·미리보기 썸네일) 맞추면 최대 확대가 되므로, 크기가 생길 때까지 미룬다.
  // 미룬 것보다 새 요청이 있으면 미룬 것은 버린다(번호표 fitToken).
  function fitSafe(bounds, opts) {
    const map = state.map, token = ++state.fitToken;
    const go = function () { if (token === state.fitToken) map.fitBounds(bounds, Object.assign(viewPadding(), opts || {})); };
    const s = map.getSize();
    if (s.x > 50 && s.y > 50) { go(); return; }
    map.once('resize', go);
  }

  function onRouteViewClick(ev) {
    const act = ev.target.closest('[data-action]');
    if (act) {
      if (act.dataset.action === 'guide') startGuide();
      if (act.dataset.action === 'unblock') { state.blocked.clear(); state.blockCount = 0; update(); }
      return;
    }
    const nb = ev.target.closest('[data-near]');
    if (nb) { chooseNearest(+nb.dataset.near); return; }
    const b = ev.target.closest('[data-item]');
    if (b) { focusItem(+b.dataset.item); return; }
    const x = ev.target.closest('[data-exit]');
    if (x && state.map) {
      const v = state.g.entrances.node[+x.dataset.exit];
      if (!state.wide.matches) setSheetOpen(false);
      state.fitToken++;
      state.map.setView(GR.nodeLatLng(state.g, v), Math.max(state.map.getZoom(), 17), { animate: !state.reduceMotion });
    }
  }

  /* =========================================================
     6. 지도에서 고르기 (누르기·길게 누르기), 내 위치
     ========================================================= */
  function setupMapPicking() {
    const map = state.map;
    map.on('popupclose', function () { state.lastPopupClose = Date.now(); });
    map.on('dragstart', function () { state.fitToken++; });   // 사용자가 지도를 움직이면 미뤄 둔 맞추기는 버린다
    // 팝업이 열려 있을 때 누른 것은 팝업을 닫는 동작으로만 본다
    map.on('click', function (ev) { if (Date.now() - state.lastPopupClose > 350) openPickPopup(ev.latlng); });
    map.on('contextmenu', function (ev) { openPickPopup(ev.latlng); });
    // 팝업 안 버튼: Leaflet 이 팝업의 click 전파를 막으므로 캡처 단계에서 받는다
    state.ui.mapEl.addEventListener('click', onPickButton, true);
  }

  function openPickPopup(latlng) {
    if (!state.G) return;
    const conn = RT.connectPoint(state.G, latlng.lat, latlng.lng);
    const near = conn.length ? '가까운 ' + (conn[0].kind === 'entrance' ? '출구' : '역') + ': ' + nearText(conn[0]) + ' · ' + PN.fmtDist(conn[0].dist)
      : '20km 안에 역이 없습니다.';
    const pad = popupPadding();
    L.popup({ maxWidth: 280, autoPanPaddingTopLeft: pad.topLeft, autoPanPaddingBottomRight: pad.bottomRight })
      .setLatLng(latlng).setContent(PN.pointPopupHtml(latlng.lat, latlng.lng, near)).openOn(state.map);
  }

  function onPickButton(ev) {
    const b = ev.target.closest('.pick-btn');
    if (!b || !state.G) return;
    ev.stopPropagation();
    ev.preventDefault();
    const which = b.dataset.pick === 'to' ? 'to' : 'from';
    let ep = null;
    if (b.dataset.station != null) ep = stationEndpoint(+b.dataset.station);
    else if (b.dataset.exit != null) {
      const i = +b.dataset.exit, g = state.g, v = g.entrances.node[i];
      ep = pointEndpoint(g.nodes.lat[v] / 1e5, g.nodes.lon[v] / 1e5, PN.exitName(g.stations[g.entrances.station[i]].name, g.entrances.ref[i]), true);
    } else ep = pointEndpoint(+b.dataset.lat, +b.dataset.lon, '고른 지점');
    state.map.closePopup();
    if (!ep) { toast('20km 안에 역이 없어 이 지점은 고를 수 없습니다.'); return; }
    setEndpoint(which, ep);
  }

  function locate() {
    if (!navigator.geolocation) { toast(GEO_DENIED); return; }
    toast('내 위치를 찾는 중입니다…', 10000);
    try {
      navigator.geolocation.getCurrentPosition(function (pos) {
        state.ui.toast.hidden = true;
        const lat = pos.coords.latitude, lon = pos.coords.longitude;
        if (!state.G) { toast('철도망 데이터를 불러온 뒤 다시 눌러 주세요.'); return; }
        const ep = pointEndpoint(lat, lon, '내 위치');
        if (!ep) { toast('내 위치에서 20km 안에 역이 없습니다. 지도를 눌러 출발점을 고르세요.'); return; }
        setEndpoint('from', ep);
        if (!state.to && state.map) { state.fitToken++; state.map.setView([lat, lon], 15, { animate: !state.reduceMotion }); }
      }, function (err) {
        toast(err && err.code === 1 ? GEO_DENIED : '위치를 찾지 못했어요. 지도를 눌러 출발점을 고르세요.');
      }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    } catch (e) { toast(GEO_DENIED); }
  }

  /* =========================================================
     7. 검색 막대
     ========================================================= */
  function setupSearch() {
    const ui = state.ui;
    ['from', 'to'].forEach(function (which) {
      const input = which === 'from' ? ui.fromInput : ui.toInput;
      const list = which === 'from' ? ui.fromList : ui.toList;
      SR.attach(input, list, {
        getCtx: function () { return { G: state.G, near: state.map ? state.map.getCenter() : null }; },
        isSet: function () { return !!state[which] && input.value === state[which].text; },
        onPick: function (r) {
          const ep = r.kind === 'station' ? stationEndpoint(r.si) : pointEndpoint(r.lat, r.lon, r.title, true);
          if (!ep) { input.value = ''; toast('"' + r.title + '"에서 20km 안에 역이 없어 고를 수 없습니다.'); return; }
          setEndpoint(which, ep);
          if (ep && !(state.from && state.to) && state.map) { state.fitToken++; state.map.setView([ep.lat, ep.lon], 14, { animate: !state.reduceMotion }); }
          // 출발을 고르면 도착 칸으로 넘어간다
          if (which === 'from' && !state.to) ui.toInput.focus();
        },
        onClear: function () { setEndpoint(which, null); }
      });
    });
    ui.search.addEventListener('submit', function (ev) { ev.preventDefault(); });
    ui.locate.addEventListener('click', locate);
    ui.swap.addEventListener('click', swapEndpoints);
    ui.clear.addEventListener('click', clearAll);
    ui.goUnder.addEventListener('click', goNearestUnderground);
  }

  /* =========================================================
     7-1. 가장 가까운 지하로 (한 번 누르기)
        내 위치(안 되면 지도 중심)에서 가장 가까운 지하역 출구 3곳을 보여 주고, 가장 가까운 곳으로 바로 안내한다.
     ========================================================= */
  function goNearestUnderground() {
    if (!state.G) { toast('철도망 데이터를 불러오는 중입니다. 잠시 뒤 다시 누르세요.'); return; }
    let settled = false;
    const fromCenter = function () {
      if (settled) return;
      settled = true;
      const c = state.map ? state.map.getCenter() : { lat: 37.5663, lng: 126.9779 };
      runNearest(c.lat, c.lng, '지도 중심', true);
    };
    if (!navigator.geolocation) { fromCenter(); return; }
    toast('내 위치를 찾는 중입니다…', 9000);
    try {
      navigator.geolocation.getCurrentPosition(function (pos) {
        if (settled) return;
        settled = true;
        state.ui.toast.hidden = true;
        runNearest(pos.coords.latitude, pos.coords.longitude, '내 위치', false);
      }, function () { state.ui.toast.hidden = true; fromCenter(); }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
    } catch (e) { fromCenter(); }
  }

  function runNearest(lat, lon, label, isCenter) {
    const res = UG.nearest.nearestUnderground(state.G, lat, lon, { limit: 3 });
    if (!res.options.length) {
      const far = isFinite(res.nearest_m) ? ' 가장 가까운 지하역은 ' + PN.yeok(res.nearest_name) + '(직선 ' + PN.fmtDist(res.nearest_m) + ')입니다.' : '';
      const msg = (isCenter ? '지도 중심' : '내 위치') + '에서 20km 안에 지하역이 없습니다.' + far +
        (isCenter ? ' 지도를 옮긴 뒤 다시 누르세요.' : '');
      state.from = state.to = null; state.nearest = null;
      state.ui.fromInput.value = state.ui.toInput.value = '';
      update();
      renderIdle(msg, true);
      if (!state.wide.matches) setSheetOpen(true);
      toast(msg, 8000);
      return;
    }
    state.nearest = { lat: lat, lon: lon, label: label, isCenter: isCenter, options: res.options, chosen: 0 };
    chooseNearest(0);
  }

  function chooseNearest(i) {
    const nb = state.nearest;
    if (!nb || !nb.options[i]) return;
    nb.chosen = i;
    const ep = UG.nearest.endpointsFor(state.G, nb.lat, nb.lon, nb.options[i], nb.label);
    state.from = ep.from; state.to = ep.to;
    state.ui.fromInput.value = nb.isCenter ? '지도 중심' : '내 위치';
    state.ui.toInput.value = ep.to.text + ' (지하 승강장)';
    state.openSheetOnPlan = true;
    update();
  }

  /* =========================================================
     7-2. 길 안내 모드 (guide.js 의 GuideView)
     ========================================================= */
  function setupGuide() {
    state.guide = UG.guide.GuideView({
      root: document.getElementById('guide'), panel: PN, steps: ST, reduceMotion: state.reduceMotion,
      getSpeed: function () { return state.speed; },
      onArrive: function () { state.guide.arrive(); },
      onBlock: guideBlock,
      onEnd: function () { state.guide.close(); }
    });
  }

  function startLabel(ep) {
    if (!ep) return '출발';
    if (ep.kind === 'station') return PN.yeok(state.g.stations[ep.si].name) + ' 출발';
    return (ep.label || ep.text || '출발 지점') + ' 출발';
  }

  function startGuide() {
    if (!state.plan) return;
    if (!state.guide) setupGuide();
    state.guide.open(state.plan, UG.guide.buildCheckpoints(state.G, state.plan), startLabel(state.plan.from), '', 0);
  }

  // 앞이 막힘: 마지막 확인 지점 ~ 다음 체크포인트 사이를 막고, 마지막 확인 지점에서 다시 찾는다
  function guideBlock() {
    const gs = state.guide.state();
    if (!gs) return;
    const r = UG.guide.planBlock(state.G, gs, state.guide.walkedM());
    if (r.error) { toast(r.error, 8000); return; }
    const added = Array.from(r.edges).filter(function (e) { return !state.blocked.has(e); });
    added.forEach(function (e) { state.blocked.add(e); });
    const from = r.from || gs.plan.from;
    const route = RT.findRoute(state.G, from, gs.plan.to, { blocked: state.blocked }) ||
      RT.findRoute(state.G, from, gs.plan.to, { blocked: state.blocked, surface: true });
    if (!route) {
      added.forEach(function (e) { state.blocked.delete(e); });
      toast('그 구간을 막으면 갈 수 있는 길이 없어 막지 않았습니다.', 8000);
      return;
    }
    state.blockCount++;
    state.from = from; state.nearest = null;
    state.ui.fromInput.value = from.text || '';
    update();
    const p = state.plan;
    const back = r.restartLabel || startLabel(gs.plan.from).replace(/ 출발$/, '');
    const diff = r.backtrack + p.view.total_m - r.oldLeft;
    // 새 경로의 첫 움직임(역 안 이동은 건너뛴다)
    const first = p.items.find(function (it) {
      return it.kind === 'step' && (it.step.type === 'transfer' || it.step.type === 'surface' || (it.step.type === 'ride' && it.step._tracks_m > 0));
    });
    let how = '새 경로로 갑니다.';
    if (first && first.step.type === 'ride') how = first.step.label + ' ' + PN.ro(first.step.terminal_direction || first.step.direction || '다음 역') + ' 갑니다.';
    else if (first && first.step.type === 'transfer') how = first.step.from_line + '에서 ' + PN.ro(first.step.to_line) + ' 갈아탑니다.';
    else if (first && first.step.type === 'surface') how = '지상으로 ' + PN.exitName(first.step.to_station, first.step.to_ref) + '까지 걷습니다.';
    const note = '<b>막은 구간</b> ' + PN.esc(r.fromLabel || startLabel(gs.plan.from).replace(/ 출발$/, '')) + ' → ' + PN.esc(r.toLabel) + '<br>' +
      (r.backtrack >= 10 ? PN.esc(PN.ro(back)) + ' 약 ' + PN.fmtDist(r.backtrack) + ' 되돌아간 뒤 ' : PN.esc(back) + '에서 ') +
      PN.esc(how) + '<br>' +
      '새 경로 ' + PN.fmtDist(p.view.total_m) + ' · 지상 ' + PN.fmtDist(p.view.exposed_m) +
      ' (남은 거리 ' + (diff >= 0 ? '+' : '−') + PN.fmtDist(Math.abs(diff)) + ')';
    state.guide.open(p, UG.guide.buildCheckpoints(state.G, p), back + (r.from ? ' (확인한 곳)' : ''), note, r.backtrack);
  }

  /* =========================================================
     8. 패널 (폰: 아래 시트 접기·펼치기), 탭
     ========================================================= */
  function setupSheet() {
    const ui = state.ui;
    ui.sheetToggle.addEventListener('click', function () { setSheetOpen(ui.panel.classList.contains('is-collapsed')); });
    const sync = function () {
      const wide = state.wide.matches;
      if (wide) ui.panel.classList.remove('is-collapsed');
      // 지도 컨트롤이 패널에 가리지 않게: 폰은 아래 여백, 넓은 화면은 왼쪽 여백
      ui.app.style.setProperty('--sheet-offset', wide ? '0px' : ui.panel.offsetHeight + 'px');
      ui.app.style.setProperty('--map-left', wide ? Math.round(ui.side.getBoundingClientRect().right + 12) + 'px' : '');
    };
    if (window.ResizeObserver) new ResizeObserver(sync).observe(ui.panel);
    window.addEventListener('resize', sync);
    const onWide = function () { setSheetOpen(state.wide.matches); sync(); };
    if (state.wide.addEventListener) state.wide.addEventListener('change', onWide); else if (state.wide.addListener) state.wide.addListener(onWide);
    setSheetOpen(state.wide.matches);
    state.syncSheet = sync;
    sync();
  }

  function setSheetOpen(open) {
    const ui = state.ui;
    if (state.wide.matches) open = true;
    ui.panel.classList.toggle('is-collapsed', !open);
    ui.app.classList.toggle('sheet-open', open && !state.wide.matches);   // 폰에서 시트를 펼치면 떠 있는 버튼을 숨긴다
    ui.sheetToggle.setAttribute('aria-expanded', String(open));
    ui.peekAct.textContent = open ? '접기' : state.plan ? '단계 보기' : '펼치기';
    if (state.syncSheet) state.syncSheet();
  }

  function setPeek(html) { state.ui.peekText.innerHTML = html; }

  function setupTabs() {
    const tabs = state.ui.tabs;
    const select = function (i, focus) {
      tabs.forEach(function (t, j) {
        t.setAttribute('aria-selected', String(i === j));
        t.tabIndex = i === j ? 0 : -1;
        document.getElementById(t.getAttribute('aria-controls')).hidden = i !== j;
      });
      if (focus) tabs[i].focus();
      state.ui.scroll.scrollTop = 0;
    };
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { select(i, false); });
      t.addEventListener('keydown', function (ev) {
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
          ev.preventDefault();
          select((i + (ev.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length, true);
        }
      });
    });
    state.selectTab = select;
  }

  /* =========================================================
     9. 레이어 버튼 (선로 구조 토글, 범례) · 배경 지도 표시
     ========================================================= */
  function setupLayerControl() {
    const ui = state.ui, map = state.map;
    const Ctl = L.Control.extend({
      onAdd: function () {
        const box = L.DomUtil.create('div', 'lyr-ctl');
        box.innerHTML = '<button type="button" class="lyr-btn" id="lyr-btn" aria-expanded="false" aria-controls="lyr-pop" aria-label="선로 표시와 범례" title="선로 표시와 범례">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg></button>';
        box.appendChild(ui.lyrPop);
        L.DomEvent.disableClickPropagation(box);
        L.DomEvent.disableScrollPropagation(box);
        return box;
      }
    });
    new Ctl({ position: 'bottomright' }).addTo(map);
    const btn = document.getElementById('lyr-btn');
    const setOpen = function (open) { ui.lyrPop.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
    btn.addEventListener('click', function () { setOpen(ui.lyrPop.hidden); });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && !ui.lyrPop.hidden) { setOpen(false); btn.focus(); } });
    map.on('click movestart', function () { setOpen(false); });

    ui.toggles.forEach(function (el) {
      el.checked = state.vis[el.dataset.layer];
      el.addEventListener('change', function () { state.vis[el.dataset.layer] = el.checked; onVisChange(); });
    });
    ui.onlyUnder.addEventListener('click', function () {
      const only = isOnlyUnder(state.vis);
      state.vis.tunnel = true; state.vis.bridge = only; state.vis.ground = only;
      ui.toggles.forEach(function (el) { el.checked = state.vis[el.dataset.layer]; });
      onVisChange();
    });
    syncOnlyUnder();

    const Badge = L.Control.extend({
      onAdd: function () { const d = L.DomUtil.create('div'); d.innerHTML = '<p class="badge" hidden></p>'; return d; }
    });
    state.badge = new Badge({ position: 'bottomleft' }).addTo(map);
    syncBadge();
  }

  function isOnlyUnder(v) { return v.tunnel && !v.bridge && !v.ground; }
  function syncOnlyUnder() { state.ui.onlyUnder.setAttribute('aria-pressed', String(isOnlyUnder(state.vis))); }
  function onVisChange() { savePref(CFG.prefsKey, state.vis); syncOnlyUnder(); if (state.net) state.net.setVisible(state.vis); }

  /* =========================================================
     10. 여백 (카드에 가리지 않게)
     ========================================================= */
  function viewPadding() {
    const ui = state.ui, W = window.innerWidth, H = window.innerHeight;
    const clampX = function (v) { return Math.max(8, Math.min(v, W * 0.6)); };
    const clampY = function (v) { return Math.max(8, Math.min(v, H * 0.6)); };
    if (state.wide && state.wide.matches) {
      return { paddingTopLeft: [clampX(ui.side.getBoundingClientRect().right + 16), 24], paddingBottomRight: [64, 24] };
    }
    const top = ui.search.getBoundingClientRect().bottom + 12;
    const bottom = H - ui.panel.getBoundingClientRect().top + 12;
    return { paddingTopLeft: [16, clampY(top)], paddingBottomRight: [56, clampY(bottom)] };
  }

  function popupPadding() {
    const p = viewPadding();
    return { topLeft: L.point(p.paddingTopLeft[0], p.paddingTopLeft[1]), bottomRight: L.point(p.paddingBottomRight[0], p.paddingBottomRight[1]) };
  }

  function zoomToRegion(i) {
    if (!state.map || !state.bounds) return;
    const b = state.bounds.regions[i];
    if (!b) return;
    if (!state.wide.matches) setSheetOpen(false);
    state.map.fitBounds([[b[0], b[1]], [b[2], b[3]]], Object.assign(viewPadding(), { maxZoom: 12 }));
  }

  /* =========================================================
     11. 연결점 (다음 작업용)
       - 길 안내 전체 화면: UG.app.onPlan(cb) 로 경로가 바뀔 때 알림을 받고, plan().items 로 단계를 그린다.
       - 가장 가까운 지하로: UG.app.pointEndpoint(lat, lon, '내 위치') 로 출발점을 만들어 탐색한다.
       - 앞이 막힘: UG.app.blocked 에 간선 번호를 넣고 UG.app.reroute().
       - 장소 검색: UG.search.register({id, minLength, search(q, ctx)}) — 결과 kind 'point' 는 가까운 출구로 잇는다.
     ========================================================= */
  function emit() { state.listeners.forEach(function (cb) { try { cb(state.plan); } catch (e) { /* 무시 */ } }); }

  UG.app = {
    state: function () { return state; },
    graph: function () { return state.G; },
    map: function () { return state.map; },
    plan: function () { return state.plan; },
    onPlan: function (cb) { state.listeners.push(cb); },
    stationEndpoint: stationEndpoint, pointEndpoint: pointEndpoint, setEndpoint: setEndpoint,
    blocked: state.blocked, reroute: update, focusItem: focusItem, setSpeed: setSpeed, toast: toast,
    goNearestUnderground: goNearestUnderground, runNearest: runNearest, startGuide: startGuide,
    guide: function () { return state.guide; }
  };

  /* 예전 미리보기 화면과 점검 스크립트가 쓰던 도우미 */
  globalThis.UGMap = {
    loadGraph: GR.loadGraph, validateGraph: GR.validateGraph, decodePolyline: GR.decodePolyline, nodeLatLng: GR.nodeLatLng,
    buildTrackGroups: LY.buildTrackGroups, buildStations: LY.buildStations, computeBounds: LY.computeBounds, computeStats: PN.computeStats
  };

  if (typeof document !== 'undefined' && document.getElementById('map')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
