/* app.js — 화면을 묶는 곳
   - 시작(데이터 받기, 처음 지도 보기), 출발·도착 고르기, 경로 찾기·그리기, 가장 가까운 지하로,
     길 안내(지도가 보이는 안내), 역 시트(도착 뒤 할 일), 아래 시트·검색 화면·레이어·분석 연결.
   - 모듈: graph(데이터) · router(탐색) · steps(안내 단계) · nearest(가까운 지하역) · guide(길 안내) · places(오프라인 장소)
           reach(지하로 닿는 범위) · walk(지상 도보 길) · lines(노선 색) · saved(저장) · search(검색) · layers(지도)
           panel(결과 카드) · station(역 시트) · sheet(아래 시트) · searchui(검색 화면)
   - 다른 코드가 쓸 수 있는 연결점은 맨 아래 UG.app 에 모았다. */
(function (root) {
  'use strict';
  const UG = root.UG;
  const GR = UG.graph, RT = UG.router, ST = UG.steps, LY = UG.layers, PN = UG.panel, SR = UG.search, SV = UG.saved, LN = UG.lines;

  /* =========================================================
     0. 설정
     ========================================================= */
  const APP_NAME = '지하길';   // 임시 이름(최종 이름은 사용자가 정한다). 화면의 앱 이름은 모두 여기서 온다.

  const CFG = {
    dataUrl: 'data/graph.json',
    basemapUrl: 'data/basemap.json',
    placesUrl: 'data/places.json',
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    home: [37.5665, 126.9780], homeZoom: 12,      // 처음 보기: 서울 도심(전국을 한꺼번에 보여 주지 않는다)
    stationMinZoom: 11,
    exitMinZoom: 15,
    wideQuery: '(min-width: 760px)',
    keys: { layers: 'ugmap.layers.v1', speed: 'ugmap.speed.v1', view: 'ugmap.view.v1', theme: 'ugmap.theme.v1', notice: 'ugmap.notice.v1' },
    speeds: [3.0, 3.5, 4.0]
  };
  const GEO_DENIED = '위치를 쓸 수 없어요. 지도를 눌러 지점을 고르거나 검색하세요.';

  const ERROR_TEXT = {
    http: function (d) { return ['철도망 데이터를 불러오지 못했습니다 (HTTP ' + d + ').', 'data/graph.json 파일이 이 페이지와 같은 위치에 있어야 합니다.']; },
    network: function () { return ['철도망 데이터를 받지 못했습니다.', '인터넷 연결을 확인한 뒤 다시 시도하세요.']; },
    format: function () { return ['철도망 데이터 형식이 맞지 않습니다.', 'graph.json을 다시 만들어 올려 주세요.']; },
    leaflet: function () { return ['지도 프로그램(Leaflet)을 불러오지 못했습니다.', '인터넷 연결을 확인한 뒤 페이지를 새로 고치세요.']; }
  };

  function loadVis() {
    const def = { tunnel: true, bridge: true, ground: true, service: true };
    const s = SV.get(CFG.keys.layers, null);
    if (s && typeof s === 'object') Object.keys(def).forEach(function (k) { if (typeof s[k] === 'boolean') def[k] = s[k]; });
    return def;
  }

  /* =========================================================
     1. 시작
     ========================================================= */
  function getUi() {
    const $ = function (id) { return document.getElementById(id); };
    return {
      app: $('app'), mapEl: $('map'), topbar: $('topbar'), searchOpen: $('search-open'), pillText: $('search-pill-text'), brandName: $('brand-name'),
      sosBar: $('sos-bar'), goUnder: $('go-under'), goUnderMini: $('go-under-mini'), fabCol: $('fab-col'),
      btnLocate: $('btn-locate'), btnLayers: $('btn-layers'), btnInfo: $('btn-info'),
      lyrPop: $('lyr-pop'), onlyUnder: $('only-under'), unblockAll: $('unblock-all'), stationHint: $('station-hint'),
      toggles: Array.prototype.slice.call(document.querySelectorAll('.chip-input')),
      sheet: $('sheet'), sheetGrip: $('sheet-grip'), sheetClose: $('sheet-close'), sheetBody: $('sheet-body'),
      viewRoute: $('view-route'), routeView: $('route-view'), viewStation: $('view-station'), viewInfo: $('view-info'), viewMsg: $('view-msg'),
      peekTotal: $('peek-total'), peekTunnel: $('peek-tunnel'), peekBar: $('peek-bar'),
      nationRows: $('nation-rows'), nationFoot: $('nation-foot'), stationCount: $('station-count'), regionRows: $('region-rows'), srcNote: $('src-note'),
      themeBtns: Array.prototype.slice.call(document.querySelectorAll('[data-theme-set]')),
      searchSheet: $('search-sheet'), fromInput: $('from-input'), toInput: $('to-input'), fromList: $('from-list'), toList: $('to-list'),
      ssHome: $('ss-home'), ssBack: $('ss-back'), swap: $('swap'), ssHere: $('ss-here'),
      saveDlg: $('save-dlg'), saveWhat: $('save-what'), saveBtns: $('save-btns'), saveForm: $('save-form'), saveName: $('save-name'), saveCancel: $('save-cancel'),
      notice: $('notice'), noticeOk: $('notice-ok'),
      toast: $('toast'), status: $('status'), statusTitle: $('status-title'), statusDetail: $('status-detail'),
      statusProgress: $('status-progress'), retry: $('retry'),
      guide: $('guide'), guideCard: $('guide-card'), guideBar: $('guide-bar')
    };
  }

  const state = {
    ui: null, wide: null, reduceMotion: false, vis: null, speed: 3.5,
    map: null, pal: null, G: null, g: null, bounds: null,
    net: null, st: null, exits: null, route: null, reach: null, guideLayer: null, me: null, basemap: null, tiles: 'unknown', badge: null,
    from: null, to: null, plan: null, blocked: new Set(), blockCount: 0, activeItem: -1,
    places: null, nearest: null, openSheetOnPlan: false,
    guide: null, guideTrack: null, guideFollow: true, gps: null, watchId: null, myLoc: null,
    sheet: null, search: null, saveDlg: null, view: null, station: null,
    fit: null, fitTimer: 0, loading: false, lastPopupClose: 0, fitToken: 0, listeners: [], walkAttr: false
  };

  function boot() {
    const ui = state.ui = getUi();
    applyTheme(SV.get(CFG.keys.theme, 'auto'), false);
    ui.brandName.textContent = APP_NAME;
    document.title = APP_NAME + ' · 지하로 가는 비상 길찾기';
    state.wide = matchMedia(CFG.wideQuery);
    state.reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    state.vis = loadVis();
    const sp = +SV.get(CFG.keys.speed, 3.5);
    state.speed = CFG.speeds.indexOf(sp) >= 0 ? sp : 3.5;

    state.R = PN.mountRoute(ui.routeView, state.speed);
    state.R.speed.addEventListener('change', function () { setSpeed(+state.R.speed.value); });
    ui.routeView.addEventListener('click', onRouteViewClick);
    ui.viewStation.addEventListener('click', onStationClick);
    ui.viewStation.addEventListener('keydown', onStationKey);

    setupSheet();
    setupSearch();
    setupButtons();
    setupNotice();
    ui.retry.addEventListener('click', start);

    if (window.L) {
      try {
        state.map = LY.createMap(ui.mapEl, state.reduceMotion);
        initialView();
        LY.addBaseTiles(state.map, CFG.tileUrl, setTiles);
        setupBadge();
        setupMapPicking();
        let t = 0;
        state.map.on('moveend', function () {   // 마지막 지도 보기를 기억한다(다음에 열 때 그 자리에서)
          clearTimeout(t);
          t = setTimeout(function () { const c = state.map.getCenter(); SV.set(CFG.keys.view, { lat: +c.lat.toFixed(5), lon: +c.lng.toFixed(5), z: state.map.getZoom() }); }, 600);
        });
      } catch (e) { state.map = null; }
    }
    syncChrome();
    start();
  }

  // 처음 지도 보기: 마지막으로 본 곳 > (위치 권한을 이미 받았으면) 내 위치 > 서울 도심
  function initialView() {
    const v = SV.get(CFG.keys.view, null);
    if (v && isFinite(v.lat) && isFinite(v.lon) && isFinite(v.z) && v.z >= 6) { state.map.setView([v.lat, v.lon], v.z); return; }
    state.map.setView(CFG.home, CFG.homeZoom);
    try {
      if (navigator.permissions && navigator.geolocation) {
        navigator.permissions.query({ name: 'geolocation' }).then(function (p) { if (p.state === 'granted') locateMe(true); }).catch(function () { /* 무시 */ });
      }
    } catch (e) { /* 무시 */ }
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

    if (!state.map) {
      const t = ERROR_TEXT.leaflet();
      setStatus('error', t[0], t[1]);
      return;
    }
    setStatus('busy', '선로를 그리는 중입니다', '');
    await nextFrame();
    drawLayers();
    setStatus('hidden');
    loadBasemap().then(loadPlaces);   // 둘 다 첫 화면을 막지 않는다
    emit();
  }

  // 오프라인 장소 색인: 없거나 아직 안 만들어졌으면 역 검색만 쓴다
  async function loadPlaces() {
    if (!UG.places) return;
    let data;
    try { data = await GR.fetchJson(CFG.placesUrl); } catch (e) { return; }
    if (data && data.format === 'places-1' && Array.isArray(data.p)) {
      state.places = data;
      setTimeout(function () { try { UG.places.prepare(data); } catch (e) { /* 무시 */ } }, 300);   // 첫 검색이 빠르게
    }
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
    state.reach = LY.ReachLayer(map);
    state.route = LY.RouteLayer(map);
    state.guideLayer = LY.GuideLayer(map);
    state.me = LY.MeLayer(map);
    state.st = LY.StationLayer(map, g, { minZoom: CFG.stationMinZoom, onClick: function (si) { openStation(si, { tab: 'info' }); } });
    state.exits = LY.ExitLayer(map, G, {
      minZoom: CFG.exitMinZoom,
      popupHtml: function (i) { return PN.exitPopupHtml(g.stations[g.entrances.station[i]].name, g.entrances.ref[i], i); }
    });
    const paint = function () {
      state.pal = LY.readPalette();
      [state.net, state.st, state.route, state.reach, state.guideLayer].forEach(function (l) { l.setPalette(state.pal); });
      if (state.basemap) state.basemap.setPalette(state.pal);
    };
    paint();
    syncStationHint();
    map.on('zoomend', function () { state.net.onZoom(); syncStationHint(); });
    LY.watchTheme(paint);
    if (state.myLoc) state.me.set(state.myLoc.lat, state.myLoc.lon);
    refreshPins();
  }

  function syncStationHint() {
    const show = state.map.getZoom() >= CFG.stationMinZoom;
    state.st.sync();
    state.ui.stationHint.textContent = show ? '역을 누르면 역 정보가 나옵니다' : '역은 더 확대하면 보입니다';
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
  function setupBadge() {
    const Badge = L.Control.extend({ onAdd: function () { const d = L.DomUtil.create('div'); d.innerHTML = '<p class="badge" hidden></p>'; return d; } });
    state.badge = new Badge({ position: 'bottomleft' }).addTo(state.map);
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
  function hideToast() { state.ui.toast.hidden = true; }

  /* =========================================================
     2. 출발·도착 (끝점)
        역:  {kind:'station', si, hubs?(지하 승강장만), text}
        점:  {kind:'point', lat, lon, conn(가까운 출구 후보), label(안내 문장용), text(입력칸)}
     ========================================================= */
  function stationEndpoint(si, underOnly) {
    const s = state.g.stations[si];
    const ep = { kind: 'station', si: si, lat: s.lat / 1e5, lon: s.lon / 1e5, text: PN.yeok(s.name) };
    if (underOnly) {   // 도착한 역에서 이어 갈 때: 지상으로 나가지 않고 지하 승강장에서 출발
      const hubs = UG.reach.underHubs(state.G, si);
      if (hubs.length) { ep.hubs = hubs; ep.text = PN.yeok(s.name) + ' 지하 승강장'; }
    }
    return ep;
  }

  // 지도 위 점. label: '내 위치' | '지도 중심' | '고른 지점' | 장소 이름
  function pointEndpoint(lat, lon, label, exact) {
    const conn = RT.connectPoint(state.G, lat, lon);
    if (!conn.length) return null;
    const near = nearText(conn[0]);
    const text = exact ? label : (label === '고른 지점' ? near + ' 부근' : label);
    return { kind: 'point', lat: lat, lon: lon, conn: conn, label: label, text: text };
  }

  function nearText(c) {
    const name = state.g.stations[c.si].name;
    return c.kind === 'entrance' ? PN.exitName(name, c.ref) : PN.yeok(name);
  }

  // 검색 결과·저장한 장소 -> 끝점
  function resultEndpoint(r) {
    if (r.kind === 'station' && r.si != null && state.g.stations[r.si]) return stationEndpoint(r.si);
    return pointEndpoint(r.lat, r.lon, r.title, true);
  }

  function inputOf(which) { return which === 'from' ? state.ui.fromInput : state.ui.toInput; }
  function setEndpoint(which, ep, noRoute) {
    state[which] = ep;
    state.nearest = null;                 // 직접 고르면 '가장 가까운 지하로' 후보는 지운다
    inputOf(which).value = ep ? ep.text : '';
    syncPill();
    if (!noRoute) update();
  }
  function syncPill() {
    const ui = state.ui;
    ui.pillText.textContent = state.to ? state.to.text : '어디로 갈까요?';
    ui.searchOpen.classList.toggle('has-dest', !!state.to);
    ui.ssHere.hidden = !state.from;
  }

  function swapEndpoints() {
    const f = state.from;
    state.from = state.to; state.to = f;
    state.nearest = null;
    state.ui.fromInput.value = state.from ? state.from.text : '';
    state.ui.toInput.value = state.to ? state.to.text : '';
    syncPill();
    if (state.from && state.to) { state.search.close(); update(); }
  }

  // 출발을 정하지 않았으면 내 위치(안 되면 지도 중심)에서 출발
  function routeWhenReady() {
    if (!state.to) return;
    if (state.from) { update(); return; }
    resolveHere(function (ep) { state.from = ep; state.ui.fromInput.value = ''; syncPill(); update(); });
  }

  // 지금 있는 곳: 최근 2분 안의 위치 > 위치 찾기 > 지도 중심
  function resolveHere(cb) {
    let settled = false;
    const fallback = function (msg) {
      if (settled) return;
      settled = true;
      const c = state.map ? state.map.getCenter() : { lat: CFG.home[0], lng: CFG.home[1] };
      const ep = pointEndpoint(c.lat, c.lng, '지도 중심');
      if (!ep) { toast('지도 중심 20km 안에 역이 없습니다. 출발지를 검색하세요.'); return; }
      if (msg) toast(msg);
      cb(ep);
    };
    if (state.myLoc && Date.now() - state.myLoc.t < 120000) {
      const ep = pointEndpoint(state.myLoc.lat, state.myLoc.lon, '내 위치');
      if (ep) { cb(ep); return; }
    }
    if (!navigator.geolocation) { fallback('위치를 쓸 수 없어 지도 중심에서 출발합니다.'); return; }
    toast('내 위치를 찾는 중입니다…', 9000);
    try {
      navigator.geolocation.getCurrentPosition(function (pos) {
        if (settled) return;
        settled = true;
        hideToast();
        setMyLoc(pos);
        const ep = pointEndpoint(pos.coords.latitude, pos.coords.longitude, '내 위치');
        if (!ep) { toast('내 위치에서 20km 안에 역이 없습니다. 출발지를 검색하세요.'); return; }
        cb(ep);
      }, function () { hideToast(); fallback('위치를 쓸 수 없어 지도 중심에서 출발합니다.'); }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
    } catch (e) { fallback('위치를 쓸 수 없어 지도 중심에서 출발합니다.'); }
    setTimeout(function () { hideToast(); fallback('위치를 찾지 못해 지도 중심에서 출발합니다.'); }, 9500);
  }

  function setMyLoc(pos) {
    state.myLoc = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy, t: Date.now() };
    if (state.me) state.me.set(state.myLoc.lat, state.myLoc.lon);
  }

  // 내 위치 버튼: 지도를 내 위치로(quiet = 실패해도 알리지 않음)
  function locateMe(quiet) {
    if (!navigator.geolocation) { if (!quiet) toast(GEO_DENIED); return; }
    if (!quiet) toast('내 위치를 찾는 중입니다…', 9000);
    try {
      navigator.geolocation.getCurrentPosition(function (pos) {
        hideToast();
        setMyLoc(pos);
        if (state.map) { state.fit = null; state.fitToken++; state.map.setView([state.myLoc.lat, state.myLoc.lon], Math.max(state.map.getZoom(), 15), { animate: !state.reduceMotion }); }
      }, function (err) {
        if (!quiet) toast(err && err.code === 1 ? GEO_DENIED : '위치를 찾지 못했어요. 지도를 눌러 지점을 고르세요.');
      }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    } catch (e) { if (!quiet) toast(GEO_DENIED); }
  }

  /* =========================================================
     3. 경로 찾기 -> 결과 카드, 지도
     ========================================================= */
  function update() {
    state.plan = null;
    state.activeItem = -1;
    clearReach();
    const f = state.from, t = state.to;
    if (!state.G || !f || !t) { refreshPins(); emit(); return; }
    if (f.kind === 'station' && t.kind === 'station' && f.si === t.si) {
      showMessage('출발과 도착이 같은 역입니다.'); refreshPins(); emit(); return;
    }
    // 지하로 갈 길이 없으면(막은 구간, 끊긴 노선) 역 사이를 지상으로 걷는 길도 넣어 다시 찾는다
    const route = RT.findRoute(state.G, f, t, { blocked: state.blocked }) || RT.findRoute(state.G, f, t, { blocked: state.blocked, surface: true });
    if (!route) {
      showMessage('경로를 찾지 못했습니다. 두 곳을 잇는 선로가 그래프에 없습니다.', true); refreshPins(); emit(); return;
    }
    state.plan = { from: f, to: t, route: route, nearest: state.nearest, legs: {} };
    describePlan();
    showView('route', state.openSheetOnPlan ? 'half' : 'peek');
    state.openSheetOnPlan = false;
    drawPlan(true);
    requestLegs(state.plan);
    emit();
  }

  function epLabel(ep) { return ep.kind === 'point' ? (ep.label === '고른 지점' ? ep.text : ep.label || ep.text) : ep.text; }

  // 속도가 바뀌거나 실제 도보 길을 받으면 단계만 다시 만든다(경로는 그대로)
  function describePlan() {
    const p = state.plan;
    ST.planItems(state.G, p, state.speed);      // p.desc, p.items, p.view (steps.js)
    if (UG.walk) UG.walk.applyLegs(state.G, p, state.speed);
    const v = p.view;
    v.nearest = p.nearest;
    v.blocked = state.blockCount;
    v.fromText = epLabel(p.from);
    v.toText = epLabel(p.to);
    v.endSi = p.route.walk ? -1 : p.route.endSi;
    v.endStation = v.endSi >= 0 ? state.g.stations[v.endSi].name : '';
    PN.renderRoute(state.R, v);
    if (state.view === 'route') state.sheet.refit();
  }

  // 지상 도보 구간을 실제 길로(walk.js). 먼저 직선으로 그려 두고, 받으면 바꿔 그린다.
  function requestLegs(p) {
    if (!UG.walk) return;
    UG.walk.fetchLegs(state.G, p).then(function (legs) {
      if (state.plan !== p || !Object.keys(legs).length) return;
      p.legs = legs;
      describePlan();
      drawPlan(false);
      if (!state.walkAttr && state.map) { state.walkAttr = true; state.map.attributionControl.addAttribution(UG.walk.ATTRIBUTION); }
      refitSoon();
      const gs = state.guide && state.guide.state();
      if (gs && gs.plan === p) { state.guideTrack = UG.guide.routeTrack(state.G, p); state.guide.refresh(p, UG.guide.buildCheckpoints(state.G, p)); }
    });
  }

  function setSpeed(v) {
    if (CFG.speeds.indexOf(v) < 0) return;
    state.speed = v;
    SV.set(CFG.keys.speed, v);
    if (state.plan) { describePlan(); emit(); }
    if (state.station && state.station.tab === 'reach') showReach();
  }

  function showMessage(message, error) {
    state.ui.viewMsg.innerHTML = PN.messageHtml(message, error);
    showView('msg', 'peek');
  }

  /* =========================================================
     4. 지도에 경로 그리기, 단계 누르면 확대
     ========================================================= */
  function endpointLatLng(ep) { return ep ? { lat: ep.lat, lon: ep.lon } : null; }

  function refreshPins() {
    if (!state.route) return;
    state.route.pins(endpointLatLng(state.from), endpointLatLng(state.to));
    state.net.setDim(false);
    state.st.setOnly(null);
    state.exits.setUsed([]);
    state.exits.setOnlyStations(null);
    drawBlocked();
  }

  // 막은 구간(앞이 막힘)을 지도에 점선으로
  function drawBlocked() {
    const g = state.g;
    state.route.setBlocked(Array.from(state.blocked).map(function (e) { return GR.edgeShape(g, e); }));
  }

  function edgeKind(e) {
    if (!ST.isExposed(state.G, e)) return 'under';
    return state.g.tables.structs[state.g.edges.s[e]] === 'bridge' ? 'bridge' : 'ground';
  }

  // 지상 도보 구간 하나(출발 지점 -> 출구, 출구 -> 도착 지점, 바로 걷기, 역 사이 지상 걷기)를 지도 조각으로.
  // coords 는 walk.js 가 받은 실제 길(있으면) 또는 직선. 다른 길 찾기로 바꿀 때는 여기와 walk.js 만 바꾸면 된다.
  function drawWalkLeg(coords, kind) { return { pts: coords, kind: 'walk', leg: kind }; }

  // 경로가 지나는 역(지도에는 이 역들만 남긴다)
  function routeStations(p) {
    const set = new Set(), r = p.route, ns = state.G.nodeStation;
    r.path.forEach(function (x) { [x.u, x.v].forEach(function (v) { if (ns[v] >= 0) set.add(ns[v]); }); });
    if (r.endSi >= 0) set.add(r.endSi);
    if (r.startSi >= 0) set.add(r.startSi);
    return set;
  }

  function drawPlan(fit) {
    if (!state.route) return;
    const p = state.plan, r = p.route, g = state.g;
    const segs = [];
    const push = function (pts, kind) {
      const last = segs[segs.length - 1];
      if (last && kind !== 'walk' && last.kind === kind) last.pts = last.pts.concat(pts.slice(1));
      else segs.push({ pts: pts, kind: kind });
    };
    p.items.forEach(function (it) {
      if (it.kind === 'walk' || it.kind === 'enter' || it.kind === 'exit') { segs.push(drawWalkLeg(it.latlngs, it.kind)); return; }
      if (it.kind !== 'step' || it.step.type === 'warning') return;
      const s = it.step;
      if (s.type === 'surface') {
        const x = r.path[s._idx[0]];
        segs.push(drawWalkLeg(s._pts || GR.edgeShape(g, x.e, x.u), 'surface'));
        return;
      }
      s._idx.forEach(function (i) { const x = r.path[i]; push(GR.edgeShape(g, x.e, x.u), edgeKind(x.e)); });
    });
    const exits = [];
    [r.startConn, r.endConn].forEach(function (c) {
      if (c && c.kind === 'entrance') exits.push({ lat: c.lat, lon: c.lon, ref: c.ref, title: PN.exitName(g.stations[c.si].name, c.ref) });
    });
    const warnings = p.desc.steps.filter(function (s) { return s.type === 'warning'; });
    state.route.show({ segs: segs, from: endpointLatLng(p.from), to: endpointLatLng(p.to), exits: exits, warnings: warnings });
    state.exits.setUsed([r.startConn, r.endConn].filter(function (c) { return c && c.kind === 'entrance'; }).map(function (c) { return c.ent; }));
    // 경로만 또렷하게: 철도망은 흐리게, 역은 경로가 지나는 역만, 출구 번호는 출발·도착 역 것만
    state.net.setDim(true);
    state.st.setOnly(routeStations(p));
    state.exits.setOnlyStations(new Set([r.startSi, r.endSi].filter(function (x) { return x >= 0; })));
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
      if (it.step.type === 'surface' && it.step._pts) return [it.step._pts];
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
    if (!state.wide.matches && state.sheet.state() !== 'peek') state.sheet.set('peek');   // 폰: 시트를 줄여 지도를 보이게
    const pts = [];
    lines.forEach(function (l) { l.forEach(function (q) { pts.push(q); }); });
    fitTo(pts, 17);
  }

  /* ---------- 지도 맞추기: 위 검색 막대와 아래 시트(지금 높이)에 가리지 않게 ----------
     자동으로 맞춘 뒤 시트 높이가 바뀌면 다시 맞춘다. 사용자가 지도를 끌면 다시 맞추지 않는다. */
  function fitTo(pts, maxZoom) {
    if (!pts.length || !state.map) return;
    state.fit = { pts: pts, maxZoom: maxZoom };
    doFit(true);
  }
  function doFit(animate) {
    const f = state.fit;
    if (!f) return;
    fitSafe(L.latLngBounds(f.pts), { maxZoom: f.maxZoom, animate: animate && !state.reduceMotion });
  }
  function refitSoon() {
    clearTimeout(state.fitTimer);
    if (state.fit) state.fitTimer = setTimeout(function () { doFit(true); }, 220);
  }

  // 지도 크기가 0 이면(숨은 탭·미리보기 썸네일) 맞추면 최대 확대가 되므로, 크기가 생길 때까지 미룬다.
  function fitSafe(bounds, opts) {
    const map = state.map, token = ++state.fitToken;
    const go = function () { if (token === state.fitToken) map.fitBounds(bounds, Object.assign(viewPadding(), opts || {})); };
    const s = map.getSize();
    if (s.x > 50 && s.y > 50) { go(); return; }
    map.once('resize', go);
  }

  // 지도에서 가리지 않는 부분(위·아래·왼쪽 카드를 뺀 곳)
  function viewPadding() {
    const ui = state.ui, W = window.innerWidth, H = window.innerHeight;
    let top, bottom, left = 16, right = 16;
    if (state.guide && state.guide.isOpen()) {
      const c = ui.guideCard.getBoundingClientRect(), b = ui.guideBar.getBoundingClientRect();
      if (state.wide.matches) { left = c.right + 24; top = 24; bottom = 24; right = 24; }
      else { top = c.bottom + 16; bottom = H - b.top + 16; }
    } else if (state.wide.matches) {
      const sheetOn = state.sheet.state() !== 'hidden';
      left = (sheetOn ? ui.sheet.getBoundingClientRect().right : ui.topbar.getBoundingClientRect().right) + 24;
      top = 24; bottom = 24; right = 72;
    } else {
      top = ui.topbar.getBoundingClientRect().bottom + 16;
      bottom = (state.sheet.state() !== 'hidden' ? state.sheet.height() : H - ui.sosBar.getBoundingClientRect().top) + 16;
      right = 64;
    }
    // 남는 지도가 너무 작으면 여백을 줄인다
    const room = H - top - bottom;
    if (room < 140) { const k = Math.max(0, (H - 140) / (top + bottom)); top *= k; bottom *= k; }
    left = Math.min(left, W * 0.7);
    return { paddingTopLeft: [left, top], paddingBottomRight: [right, bottom] };
  }

  function popupPadding() {
    const p = viewPadding();
    return { topLeft: L.point(p.paddingTopLeft[0], p.paddingTopLeft[1]), bottomRight: L.point(p.paddingBottomRight[0], p.paddingBottomRight[1]) };
  }

  function zoomToRegion(i) {
    if (!state.map || !state.bounds) return;
    const b = state.bounds.regions[i];
    if (!b) return;
    if (!state.wide.matches) state.sheet.set('peek');
    fitTo([[b[0], b[1]], [b[2], b[3]]], 12);
  }

  function onRouteViewClick(ev) {
    const act = ev.target.closest('[data-action]');
    if (act) {
      if (act.dataset.action === 'guide') startGuide();
      if (act.dataset.action === 'unblock') unblockAll();
      if (act.dataset.action === 'station') openStation(+act.dataset.si, { tab: 'reach' });
      return;
    }
    const nb = ev.target.closest('[data-near]');
    if (nb) { chooseNearest(+nb.dataset.near, true); return; }
    const b = ev.target.closest('[data-item]');
    if (b) { focusItem(+b.dataset.item); return; }
    const x = ev.target.closest('[data-exit]');
    if (x) zoomToExit(+x.dataset.exit);
  }

  function zoomToExit(ent) {
    if (!state.map) return;
    const v = state.g.entrances.node[ent];
    if (!state.wide.matches) state.sheet.set('peek');
    fitTo([GR.nodeLatLng(state.g, v)], 18);
  }

  /* =========================================================
     5. 지도에서 고르기 (누르기·길게 누르기)
     ========================================================= */
  function setupMapPicking() {
    const map = state.map;
    map.on('popupclose', function () { state.lastPopupClose = Date.now(); });
    map.on('dragstart', function () {   // 사용자가 지도를 움직이면 자동 맞추기를 멈춘다
      state.fitToken++; state.fit = null;
      if (state.guide && state.guide.isOpen()) { state.guideFollow = false; state.guide.setFollow(false); }
    });
    map.on('click', function (ev) {
      if (Date.now() - state.lastPopupClose < 350) return;   // 팝업이 열려 있을 때 누른 것은 팝업 닫기로만 본다
      if (state.guide && state.guide.isOpen()) return;
      // 폰: 시트가 크게 열려 있으면 먼저 줄인다(지도 앱처럼)
      if (!state.wide.matches && (state.sheet.state() === 'half' || state.sheet.state() === 'full')) { state.sheet.set('peek'); return; }
      openPickPopup(ev.latlng);
    });
    map.on('contextmenu', function (ev) { if (!(state.guide && state.guide.isOpen())) openPickPopup(ev.latlng); });   // 길게 누르기
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
    const g = state.g;
    let ep = null, title = '';
    if (b.dataset.exit != null) {
      const i = +b.dataset.exit, v = g.entrances.node[i];
      title = PN.exitName(g.stations[g.entrances.station[i]].name, g.entrances.ref[i]);
      ep = pointEndpoint(g.nodes.lat[v] / 1e5, g.nodes.lon[v] / 1e5, title, true);
    } else {
      ep = pointEndpoint(+b.dataset.lat, +b.dataset.lon, '고른 지점');
      title = ep ? ep.text : '고른 지점';
    }
    state.map.closePopup();
    if (b.dataset.pick === 'save') {
      state.saveDlg.open({ kind: 'point', title: title, sub: '지도에서 고른 지점', lat: +b.dataset.lat, lon: +b.dataset.lon });
      return;
    }
    if (!ep) { toast('20km 안에 역이 없어 이 지점은 고를 수 없습니다.'); return; }
    if (b.dataset.pick === 'to') { setEndpoint('to', ep, true); routeWhenReady(); return; }
    setEndpoint('from', ep, true);
    if (state.to) update(); else openSearch('to');
  }

  /* =========================================================
     6. 검색 화면 · 장소 저장
     ========================================================= */
  function setupSearch() {
    const ui = state.ui;
    state.search = UG.searchui.SearchUI({
      root: ui.searchSheet, from: { input: ui.fromInput, list: ui.fromList }, to: { input: ui.toInput, list: ui.toList },
      home: ui.ssHome, back: ui.ssBack, swap: ui.swap, here: ui.ssHere,
      getCtx: function () { return { G: state.G, near: state.map ? state.map.getCenter() : null }; },
      getGraph: function () { return state.G; },
      isSet: function (which) { return !!state[which] && inputOf(which).value === state[which].text; },
      onPick: onSearchPick,
      onClearFrom: function () { state.from = null; state.nearest = null; syncPill(); },
      onSwap: swapEndpoints,
      onQuick: function (place) {
        const ep = resultEndpoint(UG.searchui.toResult(place, state.G));
        if (!ep) { toast('그 장소에서 20km 안에 역이 없습니다.'); return; }
        setEndpoint('to', ep, true);
        state.search.close();
        routeWhenReady();
      },
      onSaveRequest: function (r) { state.saveDlg.open(r); }
    });
    state.saveDlg = UG.searchui.SaveDialog({
      root: ui.saveDlg, what: ui.saveWhat, buttons: ui.saveBtns, form: ui.saveForm, name: ui.saveName, cancel: ui.saveCancel,
      onSaved: function (name, r, ok) {
        toast(ok ? '"' + name + '"(으)로 저장했습니다: ' + r.title : '이 브라우저에서는 저장할 수 없습니다(저장소 꺼짐).');
        if (state.search.isOpen()) state.search.renderHome();
        if (state.station) renderStation();
      }
    });
    ui.searchOpen.addEventListener('click', function () { openSearch('to'); });
  }

  function openSearch(focus) {
    if (!state.G) { toast('철도망 데이터를 불러오는 중입니다. 잠시 뒤 다시 누르세요.'); return; }
    state.ui.fromInput.value = state.from ? state.from.text : '';
    state.ui.toInput.value = state.to ? state.to.text : '';
    syncPill();
    state.search.open({ focus: focus });
  }

  function onSearchPick(which, r) {
    const ep = resultEndpoint(r);
    if (!ep) { inputOf(which).value = ''; toast('"' + r.title + '"에서 20km 안에 역이 없어 고를 수 없습니다.'); return; }
    setEndpoint(which, ep, true);
    if (which === 'from' && !state.to) { state.ui.toInput.focus(); return; }
    state.search.close();
    routeWhenReady();
  }

  /* =========================================================
     7. 가장 가까운 지하로 (한 번 누르기)
        내 위치(안 되면 지도 중심)에서 가장 가까운 지하역 출구 3곳을 보여 주고, 가장 가까운 곳으로 바로 안내한다.
        인터넷이 되면 앞 3곳을 실제 걷는 거리로 다시 줄 세운다(walk.js).
     ========================================================= */
  function goNearestUnderground() {
    if (!state.G) { toast('철도망 데이터를 불러오는 중입니다. 잠시 뒤 다시 누르세요.'); return; }
    state.search.close();
    let settled = false;
    const fromCenter = function () {
      if (settled) return;
      settled = true;
      const c = state.map ? state.map.getCenter() : { lat: CFG.home[0], lng: CFG.home[1] };
      runNearest(c.lat, c.lng, '지도 중심', true);
    };
    if (state.myLoc && Date.now() - state.myLoc.t < 60000) { runNearest(state.myLoc.lat, state.myLoc.lon, '내 위치', false); return; }
    if (!navigator.geolocation) { fromCenter(); return; }
    toast('내 위치를 찾는 중입니다…', 9000);
    try {
      navigator.geolocation.getCurrentPosition(function (pos) {
        if (settled) return;
        settled = true;
        hideToast();
        setMyLoc(pos);
        runNearest(pos.coords.latitude, pos.coords.longitude, '내 위치', false);
      }, function () { hideToast(); fromCenter(); }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
    } catch (e) { fromCenter(); }
    setTimeout(function () { if (!settled) { hideToast(); fromCenter(); } }, 9000);
  }

  function runNearest(lat, lon, label, isCenter) {
    const res = UG.nearest.nearestUnderground(state.G, lat, lon, { limit: 3 });
    if (!res.options.length) {
      const far = isFinite(res.nearest_m) ? ' 가장 가까운 지하역은 ' + PN.yeok(res.nearest_name) + '(직선 ' + PN.fmtDist(res.nearest_m) + ')입니다.' : '';
      const msg = (isCenter ? '지도 중심' : '내 위치') + '에서 20km 안에 지하역이 없습니다.' + far + (isCenter ? ' 지도를 옮긴 뒤 다시 누르세요.' : '');
      state.from = state.to = null; state.nearest = null;
      state.ui.fromInput.value = state.ui.toInput.value = '';
      syncPill();
      update();
      showMessage(msg, true);
      toast(msg, 8000);
      return;
    }
    const nb = state.nearest = { lat: lat, lon: lon, label: label, isCenter: isCenter, options: res.options, chosen: 0, userPicked: false };
    chooseNearest(0, false);
    if (!UG.walk) return;
    UG.walk.refineNearest(lat, lon, res.options.slice()).then(function (rf) {
      if (state.nearest !== nb || !rf.street) return;
      const cur = nb.options[nb.chosen];
      nb.options = rf.options;
      chooseNearest(nb.userPicked ? Math.max(0, nb.options.indexOf(cur)) : 0, false);   // 사용자가 고른 것은 그대로 둔다
      if (rf.changed && !nb.userPicked) toast('실제 걷는 거리로 다시 골랐습니다: ' + PN.exitName(nb.options[0].name, nb.options[0].ref));
    });
  }

  function chooseNearest(i, byUser) {
    const nb = state.nearest;
    if (!nb || !nb.options[i]) return;
    nb.chosen = i;
    if (byUser) nb.userPicked = true;
    const ep = UG.nearest.endpointsFor(state.G, nb.lat, nb.lon, nb.options[i], nb.label);
    state.from = ep.from; state.to = ep.to;
    state.ui.fromInput.value = '';
    state.ui.toInput.value = ep.to.text + ' 지하 승강장';
    syncPill();
    state.openSheetOnPlan = true;
    update();
  }

  /* =========================================================
     8. 길 안내 (지도가 보이는 안내: 위 카드 · 가운데 지도 · 아래 버튼)
     ========================================================= */
  function setupGuide() {
    state.guide = UG.guide.GuideView({
      root: state.ui.guide, panel: PN, steps: ST, lines: LN, reduceMotion: state.reduceMotion,
      getSpeed: function () { return state.speed; },
      onArrive: function () { state.guide.arrive(); },
      onBlock: guideBlock,
      onEnd: endGuide,
      onRender: renderGuideMap,
      onFinish: guideFinished,
      onRecenter: function () { state.guideFollow = true; state.guide.setFollow(true); fitGuideStep(); }
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
    openGuide(state.plan, startLabel(state.plan.from), '', 0);
  }

  function openGuide(p, label, note, backtrack) {
    state.search.close();
    if (state.map) state.map.closePopup();
    state.guideTrack = UG.guide.routeTrack(state.G, p);
    state.guideFollow = true;
    state.guide.setFollow(true);
    state.route.highlight(null);
    state.guide.open(p, UG.guide.buildCheckpoints(state.G, p), label, note, backtrack);
    syncChrome();
    startGps();
  }

  function closeGuideView() {
    if (!state.guide || !state.guide.isOpen()) return;
    state.guide.close();
    stopGps();
    state.guideLayer.clear();
    syncChrome();
  }
  function endGuide() {
    closeGuideView();
    if (state.plan) { drawPlan(true); showView('route', 'peek'); }
  }

  // 지도 위: 지금 단계(마지막 확인 지점 -> 다음 확인 지점)를 강조하고, 다음 확인 지점과 지금 위치를 표시
  function renderGuideMap(info) {
    const st = info.st, p = info.p, track = state.guideTrack;
    if (!track) return;
    const doneAt = st.cur >= 0 ? st.cps[st.cur].at : 0;
    const nextAt = p.next ? p.next.at : doneAt;
    state.guideLayer.setSegment(p.next ? UG.guide.sliceTrack(track, doneAt, nextAt) : null);
    state.guideLayer.setNext(p.next ? UG.guide.pointAt(track, nextAt) : null, p.next ? p.next.label : '');
    let pos, mode, label;
    const gps = state.gps;
    if (gps && Date.now() - gps.t < 20000 && gps.acc <= 80) { pos = [gps.lat, gps.lon]; mode = 'gps'; label = 'GPS'; }
    else {
      const walked = Math.min(state.guide.walkedM(), p.toNext_m);
      pos = UG.guide.pointAt(track, Math.min(doneAt + walked, track.total));
      mode = 'est';
      label = st.cur >= 0 && walked < 30 ? '확인한 곳' : '추정 위치';   // 추정 = 마지막 확인 뒤 걸은 시간 × 속도
    }
    state.guideLayer.setPosition(pos, mode);
    state.guide.setPosMode(label);
    state.guidePos = pos;
    if (info.stepChanged && state.guideFollow) fitGuideStep();
  }

  function fitGuideStep() {
    const gs = state.guide && state.guide.state(), track = state.guideTrack;
    if (!gs || !track) return;
    const p = UG.guide.progress(gs.cps, gs.cur, gs.plan.view.total_m);
    const doneAt = gs.cur >= 0 ? gs.cps[gs.cur].at : 0;
    const pts = [];
    UG.guide.sliceTrack(track, doneAt, p.next ? p.next.at : doneAt).forEach(function (l) { l.forEach(function (q) { pts.push(q); }); });
    if (state.guidePos) pts.push(state.guidePos);
    if (pts.length) fitTo(pts, 17);
  }

  // 마지막 확인 지점에 도착: 안내를 닫고 역 시트(여기서 지하로 갈 수 있는 곳)를 연다
  function guideFinished(st) {
    const p = st.plan, si = p.route.walk ? -1 : p.route.endSi;
    if (si < 0) return false;   // 지상으로 바로 걷는 경로: 안내 화면에 '도착했습니다'
    closeGuideView();
    openStation(si, { tab: 'reach', arrived: p.to.kind === 'point' ? '목적지에 도착했습니다 · 가까운 역' : '도착했습니다' });
    return true;
  }

  function startGps() {
    if (!navigator.geolocation || state.watchId != null) return;
    try {
      state.watchId = navigator.geolocation.watchPosition(function (pos) {
        setMyLoc(pos);
        state.gps = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy, t: Date.now() };
      }, function () { /* 지하에서는 GPS 가 안 잡힌다: 추정 위치를 쓴다 */ }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
    } catch (e) { state.watchId = null; }
  }
  function stopGps() {
    if (state.watchId == null) return;
    try { navigator.geolocation.clearWatch(state.watchId); } catch (e) { /* 무시 */ }
    state.watchId = null;
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
    openGuide(p, back + (r.from ? ' (확인한 곳)' : ''), note, r.backtrack);
  }

  /* =========================================================
     9. 역 시트: 여기서 지하로 갈 수 있는 곳 · 지하로 계속 이동 · 이 역 정보
     ========================================================= */
  function openStation(si, opts) {
    opts = opts || {};
    if (!state.G || (state.guide && state.guide.isOpen())) return;
    if (state.map) state.map.closePopup();
    state.station = { si: si, tab: opts.tab || 'info', arrived: opts.arrived || '', reach: null };
    renderStation();
    showView('station', 'half');
    if (state.station.tab === 'reach') showReach();
    else { clearReach(); focusStation(); }
    const h = state.ui.viewStation.querySelector('#st-name');
    if (h) h.focus({ preventScroll: true });
  }

  function isSavedStation(si) {
    const name = PN.yeok(state.g.stations[si].name);
    return SV.places().some(function (p) { return p.kind === 'station' && p.title === name; });
  }

  function renderStation() {
    const s = state.station;
    if (!s) return;
    s.f = UG.station.stationFacts(state.G, s.si);
    state.ui.viewStation.innerHTML = UG.station.sheetHtml({
      f: s.f, tab: s.tab, arrived: s.arrived, reach: s.reach, saved: SV.places(), isSaved: isSavedStation(s.si),
      stations: state.g.stations, linesOf: function (si) { return GR.stationLines(state.G, si).slice(0, 3); }
    });
    if (state.view === 'station') state.sheet.refit();
  }

  function focusStation() {
    const f = state.station && state.station.f;
    if (!f || !state.map) return;
    if (state.plan) drawPlan(false); else refreshPins();
    const pts = [[f.lat, f.lon]];
    f.exits.forEach(function (x) { pts.push(GR.nodeLatLng(state.g, state.g.entrances.node[x.ent])); });
    fitTo(pts, 17);
  }

  function showReach() {
    const s = state.station;
    s.reach = UG.reach.reachFrom(state.G, s.si, { speedKmh: state.speed, blocked: state.blocked });
    renderStation();
    if (!s.reach.sources.length || !state.reach) { clearReach(); focusStation(); return; }
    state.route.clear();
    state.exits.setUsed([]);
    state.reach.show(UG.reach.segments(state.G, s.reach), [s.f.lat, s.f.lon]);
    state.net.setDim(true);
    state.st.setOnly(new Set([s.si].concat(s.reach.stations.map(function (x) { return x.si; }))), 'reach');
    state.exits.setOnlyStations(new Set([s.si]));
    const b = UG.reach.bounds(state.G, s.reach);
    fitTo([[b[0], b[1]], [b[2], b[3]]], 15);
  }

  // 도달 범위를 지우고 지도를 원래대로(경로가 있으면 경로를 다시 그린다)
  function clearReach() {
    if (!state.reach || !state.reach.active()) return;
    state.reach.clear();
    if (state.plan) drawPlan(false); else refreshPins();
  }

  function setStationTab(tab, focus) {
    const s = state.station;
    if (!s || s.tab === tab) return;
    s.tab = tab;
    renderStation();
    if (tab === 'reach') showReach(); else { clearReach(); if (tab === 'info') focusStation(); }
    state.ui.sheetBody.scrollTop = 0;
    if (focus) { const b = state.ui.viewStation.querySelector('#st-tab-' + tab); if (b) b.focus(); }
  }

  function onStationKey(ev) {
    const t = ev.target.closest('[role="tab"]');
    if (!t || (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft')) return;
    ev.preventDefault();
    const ids = UG.station.TABS.map(function (x) { return x.id; });
    const i = ids.indexOf(t.dataset.tab);
    setStationTab(ids[(i + (ev.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length], true);
  }

  function onStationClick(ev) {
    const s = state.station;
    if (!s) return;
    const tab = ev.target.closest('[data-tab]');
    if (tab) { setStationTab(tab.dataset.tab, false); return; }
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    const st = state.g.stations[s.si];
    switch (b.dataset.act) {
      case 'save-station':
        state.saveDlg.open({ kind: 'station', si: s.si, title: PN.yeok(st.name), sub: s.f.region, lat: st.lat / 1e5, lon: st.lon / 1e5 });
        break;
      case 'go-station': continueTo(stationEndpoint(+b.dataset.si)); break;
      case 'go-saved': {
        const p = SV.places().find(function (x) { return x.id === b.dataset.id; });
        const ep = p && resultEndpoint(UG.searchui.toResult(p, state.G));
        if (ep) continueTo(ep); else toast('그 장소에서 20km 안에 역이 없습니다.');
        break;
      }
      case 'go-search':
        state.from = stationEndpoint(s.si, true); state.to = null; state.nearest = null;
        openSearch('to');
        break;
      case 'route-to': state.from = null; setEndpoint('to', stationEndpoint(s.si), true); routeWhenReady(); break;
      case 'route-from': state.to = null; setEndpoint('from', stationEndpoint(s.si), true); openSearch('to'); break;
      case 'exit': zoomToExit(+b.dataset.exit); break;
    }
  }

  // 이 역(지하 승강장)에서 이어서 찾기
  function continueTo(ep) {
    const s = state.station;
    state.from = stationEndpoint(s.si, true);
    state.to = ep;
    state.nearest = null;
    state.ui.fromInput.value = state.from.text;
    state.ui.toInput.value = ep.text;
    syncPill();
    state.station = null;
    state.openSheetOnPlan = true;
    update();
  }

  /* =========================================================
     10. 아래 시트(폰) / 왼쪽 패널(넓은 화면)
     ========================================================= */
  const VIEWS = ['route', 'station', 'info', 'msg'];
  function setupSheet() {
    const ui = state.ui;
    state.sheet = UG.sheet.Sheet({
      el: ui.sheet, grip: ui.sheetGrip, wide: state.wide, reduceMotion: state.reduceMotion,
      peekEl: function () { const v = state.view && ui['view' + cap(state.view)]; return v ? v.querySelector('.sv-head') : null; },
      topLimit: function () { return ui.topbar.getBoundingClientRect().bottom + 8; },
      onChange: function () { syncChrome(); refitSoon(); }
    });
    ui.sheetClose.addEventListener('click', closeSheet);
    ui.sheet.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && !ev.defaultPrevented) { ev.preventDefault(); closeSheet(); } });
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function showView(name, size) {
    const ui = state.ui;
    state.view = name;
    VIEWS.forEach(function (v) { ui['view' + cap(v)].hidden = v !== name; });
    ui.sheetClose.setAttribute('aria-label', name === 'route' ? '경로 지우기' : '닫기');
    ui.sheet.setAttribute('aria-label', { route: '경로 결과', station: '역', info: '분석과 정보', msg: '알림' }[name]);
    state.sheet.set(size || 'half');
    ui.sheetBody.scrollTop = 0;
    syncChrome();
  }

  function hideSheet() { state.view = null; state.sheet.set('hidden'); syncChrome(); }

  // ×: 역 시트 -> (경로가 있으면) 경로로 돌아감, 경로 -> 경로 지우기, 분석·알림 -> 닫기
  function closeSheet() {
    if (state.view === 'station') {
      state.station = null;
      clearReach();
      if (state.plan) { drawPlan(true); showView('route', 'peek'); } else { refreshPins(); hideSheet(); }
      return;
    }
    if (state.view === 'route' || (state.view === 'msg' && !state.plan)) {
      state.from = state.to = null; state.nearest = null;
      state.ui.fromInput.value = state.ui.toInput.value = '';
      syncPill();
      update();
      hideSheet();
      return;
    }
    if (state.plan) showView('route', 'peek'); else hideSheet();
  }

  // 시트·안내 상태에 맞춰 떠 있는 버튼을 정리하고, 지도 컨트롤이 가리지 않게 아래 여백(--ui-bottom)을 정한다
  function syncChrome() {
    const ui = state.ui, sheetState = state.sheet ? state.sheet.state() : 'hidden';
    const guideOn = !!(state.guide && state.guide.isOpen());
    ui.app.dataset.sheet = sheetState;
    ui.app.classList.toggle('has-sheet', sheetState !== 'hidden');
    const H = window.innerHeight, wide = state.wide.matches;
    let bottom = 0;
    if (guideOn) bottom = state.wide.matches ? 0 : H - ui.guideBar.getBoundingClientRect().top;
    else if (!wide) bottom = sheetState !== 'hidden' ? state.sheet.height() : H - ui.sosBar.getBoundingClientRect().top;
    ui.app.style.setProperty('--ui-bottom', Math.max(0, Math.round(bottom)) + 'px');
  }

  /* =========================================================
     11. 떠 있는 버튼 · 레이어 · 분석 · 첫 안내 · 테마
     ========================================================= */
  function setupButtons() {
    const ui = state.ui;
    ui.goUnder.addEventListener('click', goNearestUnderground);
    ui.goUnderMini.addEventListener('click', goNearestUnderground);
    ui.btnLocate.addEventListener('click', function () { locateMe(false); });
    ui.btnInfo.addEventListener('click', function () { if (state.view === 'info') closeSheet(); else showView('info', 'half'); });
    // 레이어 펼침
    const setOpen = function (open) {
      ui.lyrPop.hidden = !open;
      ui.btnLayers.setAttribute('aria-expanded', String(open));
      ui.unblockAll.hidden = !state.blocked.size;   // 앞이 막힘으로 막은 구간이 있으면 풀 수 있게
    };
    ui.unblockAll.addEventListener('click', function () { unblockAll(); setOpen(false); });
    ui.btnLayers.addEventListener('click', function () { setOpen(ui.lyrPop.hidden); });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && !ui.lyrPop.hidden) { setOpen(false); ui.btnLayers.focus(); } });
    document.addEventListener('pointerdown', function (ev) {
      if (!ui.lyrPop.hidden && !ui.lyrPop.contains(ev.target) && !ui.btnLayers.contains(ev.target)) setOpen(false);
    });
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
    ui.themeBtns.forEach(function (b) { b.addEventListener('click', function () { applyTheme(b.dataset.themeSet, true); }); });
    window.addEventListener('resize', syncChrome);
  }

  function unblockAll() {
    state.blocked.clear(); state.blockCount = 0;
    if (state.plan) update(); else refreshPins();
    toast('막은 구간을 모두 풀었습니다.');
  }

  function isOnlyUnder(v) { return v.tunnel && !v.bridge && !v.ground; }
  function syncOnlyUnder() { state.ui.onlyUnder.setAttribute('aria-pressed', String(isOnlyUnder(state.vis))); }
  function onVisChange() { SV.set(CFG.keys.layers, state.vis); syncOnlyUnder(); if (state.net) state.net.setVisible(state.vis); }

  // 화면 테마: auto(기기 설정) | dark | light
  function applyTheme(v, save) {
    if (['auto', 'dark', 'light'].indexOf(v) < 0) v = 'auto';
    if (v === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', v);
    if (save) SV.set(CFG.keys.theme, v);
    if (state.ui) state.ui.themeBtns.forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.themeSet === v)); });
  }

  // 처음 한 번: 안전 안내(평시에는 철도 터널에 들어가면 안 됨). 확인하면 다시 띄우지 않는다(분석 탭에도 있음).
  function setupNotice() {
    const ui = state.ui;
    if (SV.get(CFG.keys.notice, 0)) return;
    ui.notice.hidden = false;
    setTimeout(function () { ui.noticeOk.focus(); }, 0);
    const done = function () { ui.notice.hidden = true; SV.set(CFG.keys.notice, 1); ui.searchOpen.focus(); };
    ui.noticeOk.addEventListener('click', done);
    ui.notice.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' || ev.key === 'Tab') { ev.preventDefault(); if (ev.key === 'Escape') done(); } });
  }

  /* =========================================================
     12. 연결점 (다음 작업용)
       - UG.app.onPlan(cb): 경로가 바뀔 때 알림. plan().items 로 단계.
       - UG.app.blocked 에 간선 번호를 넣고 UG.app.reroute() 로 다시 찾기.
       - UG.search.register({id, minLength, search(q, ctx)}) 로 검색 제공자 더하기.
       - UG.app.openStation(역 번호, {tab: 'reach'|'go'|'info'}) 로 역 시트 열기.
     ========================================================= */
  function emit() { state.listeners.forEach(function (cb) { try { cb(state.plan); } catch (e) { /* 무시 */ } }); }

  UG.app = {
    APP_NAME: APP_NAME,
    state: function () { return state; },
    graph: function () { return state.G; },
    map: function () { return state.map; },
    plan: function () { return state.plan; },
    onPlan: function (cb) { state.listeners.push(cb); },
    stationEndpoint: stationEndpoint, pointEndpoint: pointEndpoint, setEndpoint: setEndpoint,
    blocked: state.blocked, reroute: update, focusItem: focusItem, setSpeed: setSpeed, toast: toast,
    goNearestUnderground: goNearestUnderground, runNearest: runNearest, startGuide: startGuide,
    openStation: openStation, openSearch: openSearch, drawWalkLeg: drawWalkLeg, applyTheme: applyTheme,
    guide: function () { return state.guide; }
  };

  /* 예전 미리보기 화면과 점검 스크립트가 쓰던 도우미 */
  globalThis.UGMap = {
    loadGraph: GR.loadGraph, validateGraph: GR.validateGraph, decodePolyline: GR.decodePolyline, nodeLatLng: GR.nodeLatLng,
    buildTrackGroups: LY.buildTrackGroups, buildStations: LY.buildStations, computeBounds: LY.computeBounds, computeStats: PN.computeStats
  };

  if (typeof document !== 'undefined' && document.getElementById('map')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
