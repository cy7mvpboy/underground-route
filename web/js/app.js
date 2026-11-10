/* app.js — 화면을 묶는 곳
   - 시작(데이터 받기, 처음 지도 보기), 출발·도착 고르기, 경로 찾기·그리기, 가장 가까운 지하로,
     길 안내(지도가 보이는 안내), 역 시트(도착 뒤 할 일), 아래 시트·검색 화면·레이어·정보 연결.
   - 모듈: graph(데이터) · router(탐색) · steps(안내 단계) · nearest(가까운 지하역) · guide(길 안내) · places(오프라인 장소)
           junctions(역 사이 갈림길) · exithere(여기서 나가기: 지상으로 나가는 곳 후보, egress.json)
           transfer(환승 카드 내용·extra.json) · reach(지하로 닿는 범위) · walk(지상 도보 길) · lines(노선 색) · saved(저장) · search(검색) · layers(지도)
   - 내 위치(GPS)는 '내 위치 (GPS)' 부분: 권한을 받은 뒤 watchPosition 하나로 파란 점을 갱신한다.
           panel(결과 카드) · station(역 시트) · sheet(아래 시트) · searchui(검색 화면)
   - 다른 코드가 쓸 수 있는 연결점은 맨 아래 UG.app 에 모았다. */
(function (root) {
  'use strict';
  const UG = root.UG;
  const GR = UG.graph, RT = UG.router, ST = UG.steps, LY = UG.layers, PN = UG.panel, SR = UG.search, SV = UG.saved, LN = UG.lines;

  /* =========================================================
     0. 설정
     ========================================================= */
  const APP_NAME = '지하로';   // 서비스 이름(사용자 결정 2026-11-10). 화면의 앱 이름(data-app-name)은 모두 여기서 온다.

  const CFG = {
    dataUrl: 'data/graph.json',
    basemapUrl: 'data/basemap.json',
    placesUrl: 'data/places.json',
    extraUrl: 'data/extra.json',     // 덧붙는 공식 자료(빠른 환승·출구 주변). 없어도 된다
    passageUrl: 'data/passage.json', // 역 안 지하도 선 모양(서울, 출구 구간·환승 그림). 없어도 된다
    egressUrl: 'data/egress.json',   // 터널 출입구·수직구·차량기지(여기서 나가기·출구 후보 표시). 없어도 된다(역 출구만)
    egressZoom: 13, depotZoom: 12,   // 출구 후보 표시: 터널 출입구·수직구는 줌 13, 차량기지는 줌 12 이상
    offRouteM: 150,                  // 길 안내 중 GPS 위치가 경로에서 이만큼 떨어지면 '경로에서 벗어남'
    gpsFreshMs: 20000,               // 길 안내: 이보다 오래된 GPS 위치는 쓰지 않고 추정 위치를 쓴다
    gpsGoodM: 80,                    //           정확도가 이보다 나쁘면(m) 추정 위치를 쓴다
    staleMs: 60000,                  // 내 위치 점을 흐리게(오래된 위치)
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    home: [37.5665, 126.9780], homeZoom: 12,      // 처음 보기: 서울 도심(전국을 한꺼번에 보여 주지 않는다)
    stationMinZoom: 11,
    exitMinZoom: 15,
    wideQuery: '(min-width: 760px)',
    keys: { layers: 'ugmap.layers.v1', speed: 'ugmap.speed.v1', view: 'ugmap.view.v1', theme: 'ugmap.theme.v1', notice: 'ugmap.notice.v1' },
    speeds: [3.0, 3.5, 4.0]
  };
  const GEO_DENIED = '위치를 쓸 수 없어요(위치 권한 꺼짐). 지도를 눌러 지점을 고르거나 검색하세요.';

  const ERROR_TEXT = {
    http: function (d) { return ['철도망 데이터를 불러오지 못했습니다 (HTTP ' + d + ').', 'data/graph.json 파일이 이 페이지와 같은 위치에 있어야 합니다.']; },
    network: function () { return ['철도망 데이터를 받지 못했습니다.', '인터넷 연결을 확인한 뒤 다시 시도하세요.']; },
    format: function () { return ['철도망 데이터 형식이 맞지 않습니다.', 'graph.json을 다시 만들어 올려 주세요.']; },
    leaflet: function () { return ['지도 프로그램(Leaflet)을 불러오지 못했습니다.', '인터넷 연결을 확인한 뒤 페이지를 새로 고치세요.']; }
  };

  function loadVis() {
    const def = { tunnel: true, bridge: true, ground: true, service: true, egress: true };   // egress = 출구 후보 표시
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
    guide: null, guideTrack: null, guideFollow: true, guidePos: null, guideOff: 0, myLoc: null,
    egress: undefined, egressLoading: null, egressLayer: null, exitHere: null,   // egress.json(undefined = 아직 안 받음, null = 없음), 여기서 나가기 목록
    passage: undefined, exitFocus: null,   // passage.json(undefined = 아직 안 받음, null = 없음), 지하도 선을 그린 출구 번호
    sheet: null, search: null, saveDlg: null, view: null, station: null,
    fit: null, fitTimer: 0, loading: false, lastPopupClose: 0, fitToken: 0, listeners: []
  };

  // 글꼴 CSS 켜기(index.html 에서 첫 화면을 막지 않게 media="print" 로 받아 둠).
  // graph.json 을 다 받은 뒤에 켠다: 글꼴 파일(약 270KB)이 철도망 자료와 같은 때 받히면 철도망이 늦게 온다.
  function enableFonts() {
    const fontCss = document.querySelector('link[media="print"][href*="fonts.googleapis.com"]');
    if (fontCss) fontCss.media = 'all';
  }

  function boot() {
    const ui = state.ui = getUi();
    applyTheme(SV.get(CFG.keys.theme, 'auto'), false);
    Array.prototype.forEach.call(document.querySelectorAll('[data-app-name]'), function (el) { el.textContent = APP_NAME; });
    document.title = APP_NAME;
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
    setupGeo();
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
  // 위치 권한을 이미 받았으면 내 위치 점은 언제나 켠다(지도는 마지막으로 본 곳이 없을 때만 옮긴다).
  function initialView() {
    const v = SV.get(CFG.keys.view, null);
    const saved = v && isFinite(v.lat) && isFinite(v.lon) && isFinite(v.z) && v.z >= 6;
    if (saved) state.map.setView([v.lat, v.lon], v.z); else state.map.setView(CFG.home, CFG.homeZoom);
    try {
      if (navigator.permissions && navigator.geolocation) {
        navigator.permissions.query({ name: 'geolocation' }).then(function (p) {
          if (p.state !== 'granted') return;
          if (!saved) geo.centerOnce = true;
          startWatch();
        }).catch(function () { /* 무시 */ });
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
      enableFonts();
    } catch (e) {
      enableFonts();
      state.loading = false;
      const t = (ERROR_TEXT[e.kind] || ERROR_TEXT.network)(e.detail);
      setStatus('error', t[0], t[1]);
      ui.retry.hidden = false;
      return;
    }
    state.g = g;
    state.G = GR.indexGraph(g);                 // 인접 목록 등은 한 번만 만든다
    state.bounds = LY.computeBounds(g);
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
    drawLayers();               // 철도망은 지금 보이는 곳만 먼저 그린다(layers.js NetworkLayer)
    setStatus('hidden');
    emit();
    /* 첫 화면 뒤에 받는 것(docs\graph-format.md 14.1절). 모두 첫 화면을 막지 않는다.
       간이 배경 지도, 나머지 선로(화면이 놀 때 조금씩)
         -> 다 그리면 extra.json -> egress.json(출구 후보를 켠 채 줌 12 이상일 때) -> passage.json -> places.json.
       필요하면 그 전에라도 받는다: 경로·역 시트(extra, passage), 검색 화면(places), 길 안내·여기서 나가기·확대(egress).
       인터넷이 끊겨도 쓰도록 결국 받아 둔다. */
    loadBasemap();
    state.net.drawRest(function () {
      loadExtra().then(wantEgress).then(loadPassage).then(loadPlaces);
    });
  }

  // 덧붙는 공식 자료(extra.json: 빠른 환승·출구 주변 이름). 없거나 형식이 다르면 조용히 넘어간다.
  // 받으면 지금 보이는 경로·역 시트를 다시 그려 새 내용을 넣는다. 여러 번 불러도 한 번만 받는다.
  let extraLoading = null;
  function loadExtra() {
    if (!UG.transfer) return Promise.resolve();
    if (!extraLoading) extraLoading = GR.fetchJson(CFG.extraUrl).then(function (data) {
      UG.transfer.setExtra(data);
      if (!UG.transfer.hasExtra()) return;
      if (state.plan) { describePlan(); refreshGuide(); }
      if (state.station) renderStation();
    }, function () { /* 없으면 넘어간다 */ });
    return extraLoading;
  }
  /* 터널 출입구·수직구·차량기지(egress.json, 형식 'egress-1'). 처음 필요할 때 한 번만 받는다:
     출구 후보 표시를 켠 채 줌 12 이상, 길 안내 시작, '여기서 나가기'. 없거나 형식이 다르면 null(역 출구만 쓴다). */
  function loadEgress() {
    if (state.egress !== undefined) return Promise.resolve(state.egress);
    if (state.egressLoading) return state.egressLoading;
    state.egressLoading = GR.fetchJson(CFG.egressUrl).then(function (d) {
      return d && d.format === 'egress-1' && Array.isArray(d.items) ? d : null;
    }, function () { return null; }).then(function (d) {
      state.egress = d;
      state.egressLoading = null;
      if (state.egressLayer) state.egressLayer.setData(d);
      if (d && state.plan) { describePlan(); refreshGuide(); }   // 긴 터널의 '○○m 앞 비상 출구'
      return d;
    });
    return state.egressLoading;
  }

  /* 역 안 지하도 선 모양(passage.json, 서울만, 약 22KB). 출구 구간·환승을 그릴 때 처음 받는다(그림만 바뀐다).
     없거나 형식이 다르면 null: 출구 구간은 직선, 환승은 옅은 점선 그대로. 받으면 보이는 경로·안내·출구 그림을 다시 그린다. */
  let passageLoading = null;
  function loadPassage() {
    if (!UG.passage) return Promise.resolve();
    if (!passageLoading) passageLoading = GR.fetchJson(CFG.passageUrl).then(function (d) { return UG.passage.ok(d) ? d : null; }, function () { return null; })
      .then(function (d) {
        state.passage = d;
        if (!d) return;
        if (state.plan && !(state.reach && state.reach.active())) drawPlan(false);
        const gs = state.guide && state.guide.state();
        if (gs && gs.plan === state.plan && state.guide.isOpen()) { state.guideTrack = guideTrack(state.plan); refreshGuide(); }
        if (state.exitFocus != null) zoomToExit(state.exitFocus, true);
      });
    return passageLoading;
  }
  // 간선 e(노드 u 쪽에서 걸음)를 지도에 그릴 조각들: 지하도 모양이 있으면 그 선, 환승은 없으면 옅은 점선(passage.js). 바꿀 것이 없으면 null
  function passagePieces(e, u) {
    return UG.passage ? UG.passage.edgePieces(state.G, state.passage, e, u) : null;
  }
  // 경로가 출입구·환승 간선을 지나면 passage.json 을 받는다(아직 안 받았을 때만)
  function wantPassage(path) {
    if (state.passage !== undefined || passageLoading) return;
    const E = state.g.edges, c = state.G.codes;
    if (path.some(function (x) { return E.k[x.e] === c.entrance || E.k[x.e] === c.transfer; })) loadPassage();
  }
  // 길 안내 위치 추정 선: 출입구·환승 간선은 그린 모양(지하도 선)을 따라가게 한다. 거리는 간선 길이 그대로다(guide.js routeTrack)
  function guideTrack(p) {
    return UG.guide.routeTrack(state.G, p, function (e, u) {
      const pc = passagePieces(e, u);
      return pc ? UG.passage.joined(pc) : null;
    });
  }

  // 출구 후보 표시를 켠 채 줌 12 이상이면 egress.json 을 받는다
  function wantEgress() {
    if (state.map && state.vis.egress && state.map.getZoom() >= CFG.depotZoom) return loadEgress();
    return Promise.resolve();
  }

  // 길 안내가 열려 있으면 같은 경로로 다시 그린다(확인한 곳은 그대로)
  function refreshGuide() {
    const gs = state.guide && state.guide.state();
    if (gs && gs.plan === state.plan) state.guide.refresh(state.plan, UG.guide.buildCheckpoints(state.G, state.plan));
  }

  // 오프라인 장소 색인: 없거나 아직 안 만들어졌으면 역 검색만 쓴다. 여러 번 불러도 한 번만 받는다.
  let placesLoading = null;
  function loadPlaces() {
    if (!UG.places) return Promise.resolve();
    if (!placesLoading) placesLoading = GR.fetchJson(CFG.placesUrl).then(function (data) {
      if (!data || data.format !== 'places-1' || !Array.isArray(data.p)) return;
      state.places = data;
      // 첫 검색이 빠르게: 검색 열쇠를 화면이 놀 때 조금씩(한 번에 약 8ms) 만들어 둔다.
      // 그 전에 검색하면 searchPlaces 가 남은 부분을 마저 만든다(결과는 같다).
      const step = function () { try { if (!UG.places.prepare(data, 8)) LY.whenIdle(step); } catch (e) { /* 무시 */ } };
      LY.whenIdle(step);
    }, function () { /* 없으면 역 검색만 */ });
    return placesLoading;
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
    // 출구 후보(egress.json): 켜져 있고 줌 12 이상이 되면 그때 받는다.
    // 처음 보기는 start() 가 철도망을 다 그린 뒤 부른다(첫 화면을 막지 않게). 그 전에 확대하면 그때 받는다.
    state.egressLayer = LY.EgressLayer(map, {
      minZoom: CFG.egressZoom, depotZoom: CFG.depotZoom, icon: PN.ehSvg, popupHtml: PN.egressPopupHtml
    });
    state.egressLayer.setVisible(state.vis.egress);
    map.on('zoomend', wantEgress);
    const paint = function () {
      state.pal = LY.readPalette();
      [state.net, state.st, state.route, state.reach, state.guideLayer, state.me].forEach(function (l) { l.setPalette(state.pal); });
      if (state.basemap) state.basemap.setPalette(state.pal);
    };
    paint();
    syncStationHint();
    map.on('zoomend', function () { state.net.onZoom(); syncStationHint(); });
    LY.watchTheme(paint);
    if (state.myLoc) state.me.set(state.myLoc);
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

  /* 지도 위 점. label: '내 위치' | '지도 중심' | '고른 지점' | 장소 이름
     잇는 곳 후보(conn): 역 출구·역, 그리고 egress.json 을 받았으면 터널 출입구·차량기지(router.connectPoint).
     아직 안 받았으면 지금은 역 출구로만 잇고 받기 시작한다. 받으면 잇는 곳을 다시 골라 경로가 바뀌면 다시 찾는다(reconnectPoints).
     eg = egress.json 을 따져서 만든 후보인지 */
  function pointEndpoint(lat, lon, label, exact) {
    const conn = RT.connectPoint(state.G, lat, lon, state.egress || null);
    if (!conn.length) return null;
    if (state.egress === undefined) loadEgress().then(reconnectPoints);
    const near = nearText(nearConn(conn));
    const text = exact ? label : (label === '고른 지점' ? near + ' 부근' : label);
    return { kind: 'point', lat: lat, lon: lon, conn: conn, label: label, text: text, eg: state.egress !== undefined };
  }
  // 이름표('○○역 3번 출구 부근')에 쓸 후보: 가까운 역 출구·역(없으면 터널 출입구·차량기지)
  function nearConn(conn) {
    return conn.find(function (c) { return c.kind === 'entrance' || c.kind === 'hub'; }) || conn[0];
  }
  // egress.json 을 받은 뒤: 그 전에 만든 지도 위 점의 잇는 곳을 다시 고르고, 경로가 달라지면 다시 찾는다(길 안내 중에는 그대로)
  function reconnectPoints() {
    if (!state.egress || !state.G) return;
    let changed = false;
    ['from', 'to'].forEach(function (k) {
      const ep = state[k];
      if (!ep || ep.kind !== 'point' || ep.eg) return;
      ep.conn = RT.connectPoint(state.G, ep.lat, ep.lon, state.egress);
      ep.eg = true; changed = true;
    });
    const p = state.plan;
    if (!changed || !p || p.from !== state.from || p.to !== state.to || state.nearest || (state.guide && state.guide.isOpen())) return;
    const r = RT.findRoute(state.G, p.from, p.to, { blocked: state.blocked }) || RT.findRoute(state.G, p.from, p.to, { blocked: state.blocked, surface: true });
    if (r && !RT.sameRoute(r, p.alt ? p.alt.safe : p.route)) update();
  }

  function nearText(c) {
    if (c.kind === 'portal' || c.kind === 'depot') return c.name;
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
    if (!navigator.geolocation || geo.denied) { fallback('위치를 쓸 수 없어 지도 중심에서 출발합니다.'); return; }
    toast('내 위치를 찾는 중입니다…', 9000);
    try {
      navigator.geolocation.getCurrentPosition(function (pos) {
        if (settled) return;
        settled = true;
        hideToast();
        setMyLoc(pos);
        startWatch();   // 권한을 받았으니 내 위치 점을 계속 갱신한다
        const ep = pointEndpoint(pos.coords.latitude, pos.coords.longitude, '내 위치');
        if (!ep) { toast('내 위치에서 20km 안에 역이 없습니다. 출발지를 검색하세요.'); return; }
        cb(ep);
      }, function (err) { noteGeoError(err); hideToast(); fallback('위치를 쓸 수 없어 지도 중심에서 출발합니다.'); }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
    } catch (e) { fallback('위치를 쓸 수 없어 지도 중심에서 출발합니다.'); }
    setTimeout(function () { hideToast(); fallback('위치를 찾지 못해 지도 중심에서 출발합니다.'); }, 9500);
  }

  /* ---------- 내 위치 (GPS) ----------
     위치 권한을 받은 뒤에는 watchPosition 하나를 계속 돌려 파란 점(layers.js 의 MeLayer)을 갱신한다.
     - 정확도: 길 안내 중에는 높게(enableHighAccuracy), 평소에는 배터리를 아끼려고 낮게. maximumAge 10초.
     - 화면이 숨으면(다른 앱·화면 꺼짐) 멈추고, 다시 보이면 이어서 돈다.
     - 내 위치 단추 상태(data-state): off(꺼짐) · searching(찾는 중) · located(찾음) · following(지도가 나를 따라감) · denied(쓸 수 없음)
       following 은 사용자가 지도를 끌거나 다른 화면 맞추기(경로·역)가 일어나면 located 로 돌아간다.
     - 오류는 알림(toast) 한 번만, 화면은 막지 않는다. 미리보기(claude.ai)처럼 위치가 막힌 곳에서는 그 뒤로 조용하다.
       내 위치 단추를 직접 누른 경우에만 다시 알린다(누른 것에 대한 답). */
  const geo = { watchId: null, high: false, wanted: false, follow: false, denied: false, told: false, waiting: false, centerOnce: false, staleTimer: 0 };

  function setupGeo() {
    state.ui.btnLocate.addEventListener('click', onLocateClick);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopWatch(true);        // 숨으면 멈춘다(다시 보이면 이어서)
      else if (geo.wanted) startWatch();
    });
    syncLocate();
  }

  // 위치 갱신을 켠다(이미 같은 정확도로 돌고 있으면 그대로). 길 안내를 열고 닫을 때도 불러 정확도를 바꾼다.
  function startWatch() {
    if (!navigator.geolocation || geo.denied) return;
    geo.wanted = true;
    if (document.hidden) return;
    const high = !!(state.guide && state.guide.isOpen());
    if (geo.watchId != null && geo.high === high) return;
    stopWatch(true);
    geo.high = high;
    try {
      geo.watchId = navigator.geolocation.watchPosition(onFix, onWatchError, { enableHighAccuracy: high, maximumAge: 10000, timeout: 30000 });
    } catch (e) { geo.watchId = null; noteGeoError({ code: 1 }); }
    syncLocate();
  }
  function stopWatch(keepWanted) {
    if (geo.watchId != null) { try { navigator.geolocation.clearWatch(geo.watchId); } catch (e) { /* 무시 */ } }
    geo.watchId = null;
    if (!keepWanted) geo.wanted = false;
  }

  function onFix(pos) {
    setMyLoc(pos);
    if (geo.waiting) { geo.waiting = false; hideToast(); }
    if (geo.follow || geo.centerOnce) { geo.centerOnce = false; centerOnMe(); }
    syncLocate();
    if (state.guide && state.guide.isOpen()) state.guide.ping();   // 길 안내 지도 표시를 바로 갱신
  }
  function onWatchError(err) {
    noteGeoError(err);
    // 지하에서 GPS 가 안 잡히는 것(시간 초과 등)은 정상이다: 사용자가 기다리고 있을 때만 알린다
    if (geo.waiting && !geo.denied) { geo.waiting = false; tellGeo('위치를 찾지 못했어요. 지도를 눌러 지점을 고르세요.', true); }
    syncLocate();
  }
  // 권한 거부(code 1)면 멈추고 한 번 알린다
  function noteGeoError(err) {
    if (!err || err.code !== 1) return;
    geo.denied = true; geo.follow = false; geo.centerOnce = false;
    stopWatch();
    tellGeo(state.guide && state.guide.isOpen() ? '위치를 쓸 수 없어 걸은 시간으로 위치를 추정합니다.' : GEO_DENIED, geo.waiting);
    geo.waiting = false;
    syncLocate();
  }
  function tellGeo(msg, force) {
    if (geo.told && !force) return;
    geo.told = true;
    toast(msg);
  }

  function setMyLoc(pos) {
    const c = pos.coords;
    state.myLoc = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, t: Date.now(),
      heading: c.heading != null && isFinite(c.heading) && (c.speed == null || c.speed > 0.3) ? c.heading : null };   // 멈춰 있으면 방향이 없다
    if (state.me) { state.me.set(state.myLoc); state.me.setLook({ stale: false }); }
    clearTimeout(geo.staleTimer);
    geo.staleTimer = setTimeout(function () { if (state.me && !(state.guide && state.guide.isOpen())) state.me.setLook({ stale: true }); }, CFG.staleMs);
  }

  // 지도를 내 위치로(따라가기 중에는 확대는 그대로 두고 옮기기만)
  function centerOnMe() {
    if (!state.map || !state.myLoc) return;
    state.fit = null; state.fitToken++;
    const ll = [state.myLoc.lat, state.myLoc.lon];
    if (state.map.getZoom() < 15) state.map.setView(ll, 16, { animate: !state.reduceMotion });
    else state.map.panTo(ll, { animate: !state.reduceMotion });
  }

  // 내 위치 단추: 지도를 내 위치로 옮기고 따라가기를 켠다(권한이 막혔으면 다시 물어보고, 안 되면 알린다)
  function onLocateClick() {
    if (!navigator.geolocation) { toast(GEO_DENIED); return; }
    geo.denied = false;          // 사용자가 브라우저 설정에서 권한을 다시 켰을 수 있다
    geo.follow = true;
    if (state.myLoc && Date.now() - state.myLoc.t < CFG.staleMs) centerOnMe();
    else {
      geo.waiting = true;
      toast('내 위치를 찾는 중입니다…', 9000);
      if (geo.watchId != null) {   // 이미 돌고 있는데 새 위치가 없음: 한 번 더 물어본다
        try { navigator.geolocation.getCurrentPosition(onFix, onWatchError, { enableHighAccuracy: geo.high, maximumAge: 10000, timeout: 15000 }); } catch (e) { /* 무시 */ }
      }
    }
    startWatch();
    syncLocate();
  }

  function stopFollow() { if (geo.follow) { geo.follow = false; syncLocate(); } }

  function syncLocate() {
    const b = state.ui && state.ui.btnLocate;
    if (!b) return;
    const s = geo.denied ? 'denied' : geo.follow && state.myLoc ? 'following' : state.myLoc ? 'located' : geo.watchId != null || geo.waiting ? 'searching' : 'off';
    const label = { off: '내 위치', searching: '내 위치 찾는 중', located: '내 위치로 이동', following: '내 위치를 따라가는 중', denied: '내 위치를 쓸 수 없음' }[s];
    b.dataset.state = s;
    b.setAttribute('aria-pressed', String(s === 'following'));
    b.setAttribute('aria-label', label);
    b.title = label;
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
    state.plan.alt = findAlt(f, t, route);
    describePlan();
    showView('route', state.openSheetOnPlan ? 'half' : 'peek');
    state.openSheetOnPlan = false;
    drawPlan(true);
    requestLegs(state.plan);
    emit();
  }

  /* 대안 경로(router.js alternative, 사용자 결정 2026-11-11): 지하 우선 경로보다 꽤 짧으면 { safe, info, using }.
     가장 가까운 지하로·여기서 나가기·지상으로 바로 걷기에는 두지 않는다. 기본으로 보여 주는 것은 늘 지하 우선 경로다. */
  function findAlt(f, t, route) {
    if (state.nearest || t.kind === 'egress' || route.walk) return null;
    const info = RT.alternative(state.G, f, t, route, { blocked: state.blocked, speedKmh: state.speed });
    return info ? { safe: route, info: info, using: false } : null;
  }
  // 지하 우선 경로 ↔ 대안 경로 바꾸기(결과 카드·길 안내 카드의 한 줄). 길 안내 중이면 바꾼 경로로 안내를 이어 간다.
  function switchAlt() {
    const p = state.plan;
    if (!p || !p.alt) return;
    const gs = state.guide && state.guide.isOpen() ? state.guide.state() : null;
    const a = document.activeElement, refocus = !!(a && a.closest && a.closest('[data-action="alt"]'));
    p.alt.using = !p.alt.using;
    p.route = p.alt.using ? p.alt.info.route : p.alt.safe;
    p.legs = {}; p._forks = null; state.activeItem = -1;
    describePlan();
    drawPlan(!gs);
    requestLegs(p);
    emit();
    if (gs && gs.plan === p) {
      openGuide(p, gs.startLabel, gs.note, gs.backtrack);
      state.guide.setAlt(PN.altHtml(p.view.alt, 'g-alt'));
    }
    if (refocus) { const b = document.querySelector(gs ? '#guide-alt-slot [data-action="alt"]' : '#route-view [data-action="alt"]'); if (b) b.focus(); }
  }

  function epLabel(ep) { return ep.kind === 'point' ? (ep.label === '고른 지점' ? ep.text : ep.label || ep.text) : ep.text; }

  // 속도가 바뀌거나 실제 도보 길을 받으면 단계만 다시 만든다(경로는 그대로)
  function describePlan() {
    const p = state.plan;
    loadExtra();                                // 환승 카드의 계단 위치·출구 주변 이름(아직 안 받았으면 지금 받고, 받으면 다시 그린다)
    ST.planItems(state.G, p, state.speed);      // p.desc, p.items, p.view (steps.js)
    if (UG.walk) UG.walk.applyLegs(state.G, p, state.speed);
    if (UG.transfer) UG.transfer.annotate(state.G, p, state.speed);   // 환승 카드 내용(item.xfer)과 환승 횟수(view.transfers)
    const v = p.view;
    v.nearest = p.nearest;
    v.blocked = state.blockCount;
    v.fromText = epLabel(p.from);
    v.toText = epLabel(p.to);
    v.junctions = UG.guide.planJunctions(state.G, p);          // 역 사이 갈림길(junctions.js, 경로마다 한 번)
    v.lowConf = p.route.path.some(function (x) { const r = state.g.tables.regions[state.g.edges.rg[x.e]]; return r && r.conf !== 'good'; });
    p.egressOnRoute = state.egress && UG.exithere ? UG.exithere.onRoute(state.G, p, state.egress) : null;   // 경로 위 수직구
    v.endSi = p.route.walk || p.route.egress ? -1 : p.route.endSi;
    v.endStation = v.endSi >= 0 ? state.g.stations[v.endSi].name : '';
    const a = p.alt;   // 대안 경로 한 줄: 줄어드는 시간은 지금 걷는 속도로
    v.alt = a ? { using: a.using, extra_m: a.info.extra_m, saved_m: a.info.saved_m, saved_min: a.info.saved_m / (state.speed * 1000 / 60) } : null;
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
      refitSoon();
      const gs = state.guide && state.guide.state();
      if (gs && gs.plan === p) { state.guideTrack = guideTrack(p); state.guide.refresh(p, UG.guide.buildCheckpoints(state.G, p)); }
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
    if (!(state.guide && state.guide.isOpen())) state.guideLayer.setTransfer(null);   // 단계 목록에서 누른 환승 그림
    setExitFocus(null);
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
      // 여기서 나가기: 선로 위 지금 위치 -> 첫 노드, 마지막 노드 -> 수직구(간선 일부), 차량기지 안 지상 길
      if (it.kind === 'approach') { if (it.m > 0) push(it.latlngs, edgeKind(it.part.e)); return; }
      if (it.kind === 'egress') { if (it.m > 0) { if (it.surface) segs.push(drawWalkLeg(it.latlngs, 'egress')); else push(it.latlngs, edgeKind(r.endPart.e)); } return; }
      if (it.kind !== 'step' || it.step.type === 'warning') return;
      const s = it.step;
      if (s.type === 'surface') {
        const x = r.path[s._idx[0]];
        segs.push(drawWalkLeg(s._pts || GR.edgeShape(g, x.e, x.u), 'surface'));
        return;
      }
      // 출입구·환승 간선은 passage.js 가 고른 조각으로: 지하도 모양이 있으면 그 선(지하 색),
      // 환승인데 모양이 없으면 옅은 점선(xfer, 실제 통로처럼 보이는 직선을 그리지 않는다). 나머지는 선로 모양 그대로.
      s._idx.forEach(function (i) {
        const x = r.path[i], pc = passagePieces(x.e, x.u);
        if (pc) pc.forEach(function (q) { push(q.pts, q.kind); });
        else push(GR.edgeShape(g, x.e, x.u), s.type === 'transfer' ? 'xfer' : edgeKind(x.e));   // passage.js 가 없어도 환승은 점선
      });
    });
    wantPassage(r.path);
    const exits = [], used = [r.startConn, r.endConn].filter(function (c) { return c && c.kind === 'entrance'; }).map(function (c) { return c.ent; });
    [r.startConn, r.endConn].forEach(function (c) {
      if (c && c.kind === 'entrance') exits.push({ lat: c.lat, lon: c.lon, ref: c.ref, title: PN.exitName(g.stations[c.si].name, c.ref) });
    });
    if (r.egress && r.egress.k === 'exit') { exits.push({ lat: r.egress.lat, lon: r.egress.lon, ref: r.egress.ref, title: r.egress.title }); used.push(r.egress.ent); }
    const warnings = p.desc.steps.filter(function (s) { return s.type === 'warning'; });
    const other = otherLine(p);
    state.route.show({ segs: segs, from: endpointLatLng(p.from), to: endpointLatLng(p.to), exits: exits, warnings: warnings, junctions: p.junctions || [], other: other });
    if (!(state.guide && state.guide.isOpen())) { state.guideLayer.setFork(null); state.guideLayer.setTransfer(null); }
    if (fit) setExitFocus(null);
    state.exits.setUsed(used);
    // 경로만 또렷하게: 철도망은 흐리게, 역은 경로가 지나는 역만, 출구 번호는 출발·도착 역 것만
    state.net.setDim(true);
    state.st.setOnly(routeStations(p));
    state.exits.setOnlyStations(new Set([r.startSi, r.endSi].filter(function (x) { return x >= 0; })));
    drawBlocked();
    if (fit) {
      const all = [];
      segs.forEach(function (s) { s.pts.forEach(function (q) { all.push(q); }); });
      all.push([p.from.lat, p.from.lon], [p.to.lat, p.to.lon]);
      if (other) other.forEach(function (q) { all.push(q); });   // 비교하는 다른 경로도 보이게
      fitTo(all, 16);
    }
  }

  // 고르지 않은 다른 경로(지하 우선 ↔ 대안)의 선 하나: 출발 지점 → (간선 일부) → 간선들 → 도착 지점. 없으면 null
  function otherLine(p) {
    if (!p.alt) return null;
    const r = p.alt.using ? p.alt.safe : p.alt.info.route, g = state.g, pts = [];
    if (r.walk) return [[p.from.lat, p.from.lon], [p.to.lat, p.to.lon]];
    if (r.startConn) pts.push([p.from.lat, p.from.lon]);
    if (r.startPart) r.startPart.pts.forEach(function (q) { pts.push(q); });
    r.path.forEach(function (x) { GR.edgeShape(g, x.e, x.u).forEach(function (q) { pts.push(q); }); });
    if (r.endConn) pts.push([p.to.lat, p.to.lon]);
    return pts.length > 1 ? pts : null;
  }

  // 단계 하나가 덮는 선(지도 강조·확대용)
  function itemLines(it) {
    const p = state.plan, g = state.g;
    if (it.kind === 'step') {
      if (it.step.type === 'surface' && it.step._pts) return [it.step._pts];
      return (it.step._idx || []).map(function (i) {   // 출입구·환승 간선은 지도에 그린 모양(지하도 선)으로
        const e = p.route.path[i], pc = passagePieces(e.e, e.u);
        return pc ? UG.passage.joined(pc) : GR.edgeShape(g, e.e, e.u);
      });
    }
    if (it.kind === 'arrive') return [it.latlngs.concat(it.others.map(function (x) { return GR.nodeLatLng(g, g.entrances.node[x.ent]); }))];
    return [it.latlngs];
  }

  function focusItem(i) {
    const p = state.plan;
    if (!p || !p.items[i] || !state.map) return;
    state.activeItem = i;
    state.guideLayer.setFork(null);
    setExitFocus(null);
    const it = p.items[i], lines = itemLines(it);
    // 환승: 띠로 강조하지 않고 두 승강장 점과 노선 칩, 그 사이 통로 그림만 보여 준다(길 안내의 환승 그림과 같다)
    const xfer = xferPicture(p, it);
    state.guideLayer.setTransfer(xfer);
    state.route.highlight(it.kind === 'arrive' || xfer ? null : lines);
    Array.prototype.forEach.call(state.ui.routeView.querySelectorAll('[data-item]'), function (b) {
      b.classList.toggle('is-active', +b.dataset.item === i);
    });
    shrinkForMap();
    if (xfer) { fitTo(xferView(xfer), 18); return; }   // 노선 이름표가 잘리지 않게(길 안내의 환승 그림과 같은 범위)
    const pts = [];
    lines.forEach(function (l) { l.forEach(function (q) { pts.push(q); }); });
    fitTo(pts, 17);
  }

  /* ---------- 지도 맞추기: 위 검색 막대와 아래 시트(지금 높이)에 가리지 않게 ----------
     자동으로 맞춘 뒤 시트 높이가 바뀌면 다시 맞춘다. 사용자가 지도를 끌면 다시 맞추지 않는다. */
  function fitTo(pts, maxZoom) {
    if (!pts.length || !state.map) return;
    stopFollow();   // 경로·역으로 지도를 맞추면 내 위치 따라가기는 멈춘다
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
    if (s.x < 50 || s.y < 50) { map.once('resize', go); return; }
    // Leaflet 은 확대 움직임 중에 들어온 새 보기 요청을 버린다: 움직임이 끝나면 맞춘다(마지막 요청만, token)
    if (map._animatingZoom) { map.once('zoomend', go); return; }
    go();
  }

  // 지도에서 가리지 않는 부분(위·아래·왼쪽 카드를 뺀 곳)
  function viewPadding() {
    const ui = state.ui, W = window.innerWidth, H = window.innerHeight;
    let top, bottom, left = 16, right = 16;
    if (state.guide && state.guide.isOpen()) {
      const c = ui.guideCard.getBoundingClientRect(), b = ui.guideBar.getBoundingClientRect();
      if (state.wide.matches) { left = c.right + 24; top = 24; bottom = 24; right = 24; }
      else {
        top = c.bottom + 16; bottom = H - b.top + 16;
        const ex = document.getElementById('guide-exits');   // 여기서 나가기 목록이 열려 있으면 그 위까지만(위 카드는 숨는다)
        if (ex && !ex.hidden) bottom = H - ex.getBoundingClientRect().top + 16;
      }
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

  /* ---------- 따라가기 (길 안내·시연이 같이 쓴다) ----------
     지금 위치 점이 지도에서 보이는 곳(pad = viewPadding() 형식: 위 카드·아래 단추·시트를 뺀 곳)의 가운데 칸
     (가로·세로 CAM.box = 20%) 밖으로 나가면, 점이 다시 가운데에 오도록 지도를 부드럽게 옮긴다(움직임 줄이기면 바로).
     점이 움직이는 중이면 옮기는 동안 갈 만큼 앞을 겨냥해(가운데 칸 크기까지만) 옮긴 뒤에도 가운데에 있게 한다.
     지도 그림(캔버스)은 옮기기가 끝날 때만 다시 그려지므로 프레임마다 옮기지 않는다. */
  const CAM = { box: 0.2, panSec: 0.6 };
  const cam = { busy: false, last: null };
  function keepCentered(ll, pad) {
    const map = state.map;
    if (!ll || !map || cam.busy || map._animatingZoom || (map._panAnim && map._panAnim._inProgress)) return;
    const at = L.latLng(ll), now = performance.now(), z = map.getZoom(), px = map.project(at, z);
    // 움직이는 빠르기(지도 픽셀/초): 바로 전 위치(1.5초 안, 같은 줌)와 비교
    const prev = cam.last;
    const v = prev && prev.z === z && now - prev.t > 0 && now - prev.t < 1500 ? px.subtract(prev.px).divideBy((now - prev.t) / 1000) : null;
    cam.last = { px: px, t: now, z: z };
    const sz = map.getSize(), l = pad.paddingTopLeft[0], t = pad.paddingTopLeft[1];
    const r = sz.x - pad.paddingBottomRight[0], b = sz.y - pad.paddingBottomRight[1];
    if (r - l < 60 || b - t < 60) return;   // 보이는 곳이 너무 작으면 그대로
    const hx = (r - l) * CAM.box / 2, hy = (b - t) * CAM.box / 2, pt = map.latLngToContainerPoint(at);
    let dx = pt.x - (l + r) / 2, dy = pt.y - (t + b) / 2;
    if (Math.abs(dx) <= hx && Math.abs(dy) <= hy) return;   // 가운데 칸 안: 그대로
    if (state.reduceMotion) { map.panBy([dx, dy], { animate: false }); return; }
    if (v) { dx += Math.max(-hx, Math.min(hx, v.x * CAM.panSec)); dy += Math.max(-hy, Math.min(hy, v.y * CAM.panSec)); }
    cam.busy = true;
    map.once('moveend', function () { cam.busy = false; });
    map.panBy([dx, dy], { animate: true, duration: CAM.panSec, easeLinearity: v ? 1 : 0.5 });
  }
  // 지도 맞추기용 점: c 를 가운데에 두고 pts 가 모두 보이게(c 를 중심으로 뒤집은 점을 더한다)
  function aroundCenter(pts, c) {
    const out = pts.concat([c]);
    pts.forEach(function (q) { out.push([2 * c[0] - q[0], 2 * c[1] - q[1]]); });
    return out;
  }

  function popupPadding() {
    const p = viewPadding();
    return { topLeft: L.point(p.paddingTopLeft[0], p.paddingTopLeft[1]), bottomRight: L.point(p.paddingBottomRight[0], p.paddingBottomRight[1]) };
  }

  function onRouteViewClick(ev) {
    const act = ev.target.closest('[data-action]');
    if (act) {
      if (act.dataset.action === 'guide') startGuide(true);   // 누르기 처리 안: 걸음 세기 권한(iOS)을 여기서 묻는다
      if (act.dataset.action === 'unblock') unblockAll();
      if (act.dataset.action === 'station') openStation(+act.dataset.si, { tab: 'reach' });
      if (act.dataset.action === 'alt') switchAlt();
      return;
    }
    const nb = ev.target.closest('[data-near]');
    if (nb) { chooseNearest(+nb.dataset.near, true); return; }
    const jb = ev.target.closest('[data-jn]');
    if (jb) { focusJunction(+jb.dataset.jn); return; }
    const b = ev.target.closest('[data-item]');
    if (b) { focusItem(+b.dataset.item); return; }
    const x = ev.target.closest('[data-exit]');
    if (x) zoomToExit(+x.dataset.exit);
  }

  /* ---------- 갈림길 지도 그림 ----------
     들어오는 선 약 120m, 갈래마다 처음 약 160m(고른 갈래는 경로를 따라, 다른 갈래는 junctions.followBranch 로 따라간 선로).
     이름표: '오른쪽 갈래 · 둔촌동 방면'. 경로마다 한 번 만들어 둔다(p._forks). */
  function forkData(p, n) {
    p._forks = p._forks || {};
    if (p._forks[n]) return p._forks[n];
    const g = state.g, path = p.route.path, J = UG.junctions, j = p.junctions[n];
    const cut = function (steps, maxM) {   // [[간선, 출발 노드]] 를 이어 붙인 선의 처음 maxM
      let pts = [];
      for (let k = 0; k < steps.length; k++) {
        const sh = GR.edgeShape(g, steps[k][0], steps[k][1]);
        pts = pts.length ? pts.concat(sh.slice(1)) : sh;
        const cum = GR.cumulative(pts);
        if (cum[cum.length - 1] >= maxM) return GR.sliceAlong(pts, cum, 0, maxM);
      }
      return pts;
    };
    const back = [], ahead = [];
    for (let k = j.pos; k >= 0 && back.length < 40; k--) back.push([path[k].e, path[k].v]);
    for (let k = j.pos + 1; k < path.length && ahead.length < 40; k++) ahead.push([path[k].e, path[k].u]);
    const label = function (b) { return b.side + ' · ' + (b.toward ? b.toward + ' 방면' : b.name); };
    const branches = [{ pts: cut(ahead, 160), chosen: true, label: label(j.chosen) }];
    j.alternatives.forEach(function (a) {
      const w = J.followBranch(state.G, j.node, a.edge, null, Object.assign({}, J.DEFAULTS, { walkM: 400 }));
      branches.push({ pts: cut(w.steps, 160), chosen: false, label: label(a) });
    });
    return (p._forks[n] = { center: [j.lat, j.lon], incoming: cut(back, 120), branches: branches });
  }
  function forkPoints(f) {
    const pts = f.incoming.slice(), c = f.center;
    f.branches.forEach(function (b) {
      b.pts.forEach(function (q) { pts.push(q); });
      const t = b.pts[b.pts.length - 1];
      pts.push([c[0] + (t[0] - c[0]) * 2.2, c[1] + (t[1] - c[1]) * 2.2]);   // 이름표 자리
    });
    return pts;
  }
  // 단계 목록의 갈림길 줄을 누름: 지도에 그 갈림길(갈래와 이름표)을 크게
  function focusJunction(n) {
    const p = state.plan;
    if (!p || !p.junctions || !p.junctions[n] || !state.map) return;
    const f = forkData(p, n);
    state.route.highlight(null);
    state.guideLayer.setTransfer(null);
    setExitFocus(null);
    state.guideLayer.setFork(f);
    shrinkForMap();
    fitTo(forkPoints(f), 18);
  }

  // 지도에서 보여 줄 때(단계·갈림길·출구를 누름): 폰에서 시트가 '전체'면 '절반'으로 줄인다.
  // 예전에는 '요약'까지 접었는데, 그러면 목록이 잘려 더 내려 볼 수 없었다(사용자 신고: 누른 뒤 스크롤이 안 됨).
  function shrinkForMap() {
    if (!state.wide.matches && state.sheet.state() === 'full') state.sheet.set('half');
  }

  /* 환승 그림 자료(지도): transfer.js 의 환승 내용(두 승강장 위치·노선) + 그릴 조각(passage.js: 지하도 선, 없으면 옅은 점선).
     같은 그림이면 같은 객체를 돌려준다(GuideLayer 가 다시 그리지 않게). passage.json 을 받으면 새로 만든다. */
  function xferPicture(p, it) {
    if (!it || it.kind !== 'step' || it.step.type !== 'transfer' || !it.xfer) return null;
    if (!it._pic || it._pic.data !== state.passage) {
      const x = p.route.path[it.step._idx[0]];
      it._pic = { data: state.passage, x: Object.assign({}, it.xfer, { pieces: passagePieces(x.e, x.u) }) };
    }
    return it._pic.x;
  }

  // 환승 그림을 볼 지도 범위: 두 승강장(과 지하도 선)만 크게. 양 옆의 노선 이름표가 잘리지 않게 동서로 넉넉히(약 60m 이상) 잡는다
  function xferView(x) {
    const pts = [[x.from.lat, x.from.lon], [x.to.lat, x.to.lon]].concat(x.pieces ? UG.passage.joined(x.pieces) : []);
    const la = pts.map(function (q) { return q[0]; }), lo = pts.map(function (q) { return q[1]; });
    const s = Math.min.apply(null, la), n = Math.max.apply(null, la), w = Math.min.apply(null, lo), e = Math.max.apply(null, lo);
    const padLon = Math.max((e - w) * 0.7, 0.0007), padLat = Math.max((n - s) * 0.25, 0.0002);
    return [[s - padLat, w - padLon], [n + padLat, e + padLon]];
  }

  // 출구 하나를 지도에서 크게(역 시트의 출구 줄, 결과의 다른 출구 목록).
  // 지하도 모양(passage.json)이 있으면 그 출구에서 승강장 허브까지의 선도 그리고, 선 전체가 보이게 맞춘다.
  function zoomToExit(ent, redraw) {
    if (!state.map) return;
    const g = state.g, v = g.entrances.node[ent];
    let pts = [GR.nodeLatLng(g, v)];
    const e = exitEdge(ent), pc = e >= 0 ? passagePieces(e, v) : null;
    setExitFocus(ent, pc);
    if (pc) pts = pts.concat(UG.passage.joined(pc));
    else if (e >= 0 && state.passage === undefined) loadPassage();
    if (redraw && !pc) return;
    shrinkForMap();
    fitTo(pts, 18);
  }
  // 출입구 번호 -> 그 출입구 간선 번호(-1 = 없음)
  function exitEdge(ent) {
    const G = state.G, v = state.g.entrances.node[ent];
    for (let k = G.adjStart[v]; k < G.adjStart[v + 1]; k++) if (state.g.edges.k[G.adjEdge[k]] === G.codes.entrance) return G.adjEdge[k];
    return -1;
  }
  // 출구 지하도 그림을 켜고 끈다(ent = null 이면 지운다)
  function setExitFocus(ent, pieces) {
    state.exitFocus = ent;
    if (state.guideLayer) state.guideLayer.setExitPath(ent != null ? pieces || null : null);
  }

  /* =========================================================
     5. 지도에서 고르기 (누르기·길게 누르기)
     ========================================================= */
  function setupMapPicking() {
    const map = state.map;
    map.on('popupclose', function () { state.lastPopupClose = Date.now(); });
    map.on('dragstart', function () {   // 사용자가 지도를 움직이면 자동 맞추기와 내 위치 따라가기를 멈춘다
      state.fitToken++; state.fit = null;
      stopFollow();
      if (state.guide && state.guide.isOpen()) { state.guideFollow = false; state.guide.setFollow(false); }
    });
    state.ui.mapEl.addEventListener('keydown', function (ev) {   // 키보드 화살표로 지도를 옮기면 길 안내 따라가기를 멈춘다
      if (/^Arrow/.test(ev.key) && state.guide && state.guide.isOpen()) { state.guideFollow = false; state.guide.setFollow(false); }
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
    const conn = RT.connectPoint(state.G, latlng.lat, latlng.lng), c0 = conn.length ? nearConn(conn) : null;
    const near = c0 ? '가까운 ' + (c0.kind === 'entrance' ? '출구' : '역') + ': ' + nearText(c0) + ' · ' + PN.fmtDist(c0.dist)
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
    loadPlaces();   // 오프라인 장소 검색(아직 안 받았으면 지금. 받기 전에는 역 이름 검색만)
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
    if (!navigator.geolocation || geo.denied) { fromCenter(); return; }
    toast('내 위치를 찾는 중입니다…', 9000);
    try {
      navigator.geolocation.getCurrentPosition(function (pos) {
        if (settled) return;
        settled = true;
        hideToast();
        setMyLoc(pos);
        startWatch();   // 권한을 받았으니 내 위치 점을 계속 갱신한다
        runNearest(pos.coords.latitude, pos.coords.longitude, '내 위치', false);
      }, function (err) { noteGeoError(err); hideToast(); fromCenter(); }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
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
    // 걸음 세기(pdr.js): 역 사이에서 걸은 거리를 걸음 수 × 보폭으로. 센서를 못 쓰면 지금처럼 걸은 시간 × 속도
    state.pdr = UG.pdr ? UG.pdr.create({ fillSpeed: function () { return state.speed / 3.6; } }) : null;
    if (state.pdr) state.pdr.onupdate = function () { if (state.guide && state.guide.isOpen()) state.guide.ping(); };
    state.guide = UG.guide.GuideView({
      pdr: state.pdr,
      root: state.ui.guide, panel: PN, steps: ST, lines: LN, reduceMotion: state.reduceMotion,
      getSpeed: function () { return state.speed; },
      onArrive: function () { state.guide.arrive(); },
      onBlock: guideBlock,
      onEnd: endGuide,
      onRender: renderGuideMap,
      onFinish: guideFinished,
      onRecenter: function () { state.guideFollow = true; state.guide.setFollow(true); fitGuideStep(); },
      routePos: gpsRoutePos,
      onExitHere: guideExitHere,
      onExitPick: pickExit,
      onExitClose: function () { state.exitHere = null; state.guideLayer.setCandidates(null); if (state.guideFollow) fitGuideStep(); },
      onAlt: switchAlt
    });
  }

  // 쓸 만한 GPS(최근 20초, 정확도 80m 안)
  function gpsUsable() {
    const f = state.myLoc;
    return !!f && Date.now() - f.t < CFG.gpsFreshMs && f.acc <= CFG.gpsGoodM;
  }
  // GPS 위치를 경로 위 거리(m)로. 경로에서 150m 넘게 떨어졌거나 GPS 가 없으면 null(그때는 걸은 시간으로 추정)
  function gpsRoutePos() {
    if (!gpsUsable() || !state.guideTrack) return null;
    const pr = UG.guide.projectOnTrack(state.guideTrack, state.myLoc.lat, state.myLoc.lon);
    return pr.off <= CFG.offRouteM ? pr.m : null;
  }

  function startLabel(ep) {
    if (!ep) return '출발';
    if (ep.kind === 'station') return PN.yeok(state.g.stations[ep.si].name) + ' 출발';
    return (ep.label || ep.text || '출발 지점') + ' 출발';
  }

  /* 길 안내 시작. byTap = 사용자가 '안내 시작'을 누름: 그 누르기 처리 안에서 곧바로 걸음 세기를 켜고(iOS 권한) 화면을 켜 둔다.
     시연(UG.app.startGuide)은 걸은 시간을 당겨 위치를 움직이므로 켜지 않는다. 다시 찾기(openGuide)도 켜지 않는다(이미 켜져 있다).
     iOS 가 거절('denied'·'prompt')하거나 센서가 없으면 알리지 않고 시간으로 추정한다. */
  function startGuide(byTap) {
    if (!state.plan) return;
    if (!state.guide) setupGuide();
    if (byTap === true && state.pdr) { state.pdr.start(); UG.pdr.keepScreenOn(true); }
    openGuide(state.plan, startLabel(state.plan.from), '', 0);
  }

  function openGuide(p, label, note, backtrack) {
    state.search.close();
    loadEgress();   // 긴 터널의 '○○m 앞 비상 출구'·여기서 나가기에 쓴다(없어도 된다)
    if (state.map) state.map.closePopup();
    state.guideTrack = guideTrack(p);
    setExitFocus(null);
    state.guideFollow = true;
    state.guide.setFollow(true);
    state.route.highlight(null);
    state.guide.open(p, UG.guide.buildCheckpoints(state.G, p), label, note, backtrack);
    syncChrome();
    stopFollow();
    startWatch();   // 길 안내 중에는 정확도를 높여 다시 켠다(처음이면 위치 권한을 묻는다)
  }

  function closeGuideView() {
    if (!state.guide || !state.guide.isOpen()) return;
    state.guide.close();
    if (state.pdr) { state.pdr.stop(); UG.pdr.keepScreenOn(false); }   // 걸음 세기·화면 켜 두기 끄기
    state.guideLayer.clear();
    if (state.me) state.me.setLook({ hidden: false, tag: '', stale: !state.myLoc || Date.now() - state.myLoc.t > CFG.staleMs });
    if (geo.wanted) startWatch();   // 평소 정확도로 되돌린다
    syncChrome();
  }
  function endGuide() {
    closeGuideView();
    if (state.plan) { drawPlan(true); showView('route', 'peek'); }
  }

  // 지금 안내 중인 항목이 환승이면 그 환승 그림 자료(xferPicture), 아니면 null
  function guideXfer(gs, p) {
    return p.next ? xferPicture(gs.plan, gs.plan.items[p.next.item]) : null;
  }

  /* 지도 위: 지금 단계(마지막 확인 지점 -> 다음 확인 지점)를 강조하고, 다음 확인 지점과 지금 위치를 표시.
     - 환승 단계: 두 노선 승강장 점과 노선 칩, 그 사이 옅은 점선만 그린다(통로 모양은 모른다).
     - 지금 위치: 쓸 만한 GPS(최근 20초, 정확도 80m 안)가 있으면 파란 점, 경로에서 150m 넘게 떨어지면 '경로에서 벗어남'.
                  없으면 추정 위치(마지막 확인 뒤 걸은 시간 × 속도)를 속이 빈 점선 고리 + '추정'으로. */
  function renderGuideMap(info) {
    const st = info.st, p = info.p, track = state.guideTrack;
    if (!track) return;
    const doneAt = st.cur >= 0 ? st.cps[st.cur].at : 0;
    const nextAt = p.next ? p.next.at : doneAt;
    const x = guideXfer(st, p);
    // 갈림길이 다음 확인 지점이면 갈래 그림(이름표 포함)을 그리고, 노란 '다음 확인' 점은 그리지 않는다
    const jn = p.next && p.next.kind === 'junction' && p.next.jn != null ? p.next.jn : -1;
    state.guideLayer.setTransfer(x);
    state.guideLayer.setFork(jn >= 0 ? forkData(st.plan, jn) : null);
    state.guideLayer.setSegment(p.next && !x ? UG.guide.sliceTrack(track, doneAt, nextAt) : null);
    state.guideLayer.setNext(p.next && !x && jn < 0 ? UG.guide.pointAt(track, nextAt) : null, p.next ? p.next.label : '');
    const fix = state.myLoc;
    const gpsOk = gpsUsable();
    let pos;
    state.guideOff = 0;
    if (gpsOk) {
      pos = [fix.lat, fix.lon];
      const off = UG.guide.distanceToTrack(track, fix.lat, fix.lon);
      if (off > CFG.offRouteM) state.guideOff = off;
      state.guideLayer.setEstimate(null);
      state.me.setLook({ hidden: false, stale: false, tag: state.guideOff ? '경로에서 벗어남' : '' });
      state.guide.setPosMode(state.guideOff ? '경로 밖 ' + PN.fmtDist(off) : 'GPS', state.guideOff ? 'off' : 'gps');
    } else {
      const walked = Math.min(state.guide.walkedM(), p.toNext_m);
      pos = UG.guide.pointAt(track, Math.min(doneAt + walked, track.total));
      const confirmed = st.cur >= 0 && walked < 30;   // 방금 '도착'을 눌렀으면 확인한 곳
      const how = confirmed ? '확인한 곳' : state.pdr && state.pdr.usable() ? '걸음' : '추정';   // 위치 출처: 센 걸음 / 걸은 시간
      state.guideLayer.setEstimate(pos, how);
      state.me.setLook({ hidden: true, tag: '' });     // 오래된 GPS 점은 숨긴다(추정 고리와 헷갈리지 않게)
      state.guide.setPosMode(how, 'est');
    }
    state.guidePos = pos;
    if (!state.guideFollow) return;
    if (info.stepChanged) fitGuideStep();
    else if (!(state.guideOff > 1000) && !state.guide.exitsOpen()) keepCentered(pos, viewPadding());   // 지금 위치를 가운데 가까이
  }

  function fitGuideStep() {
    const gs = state.guide && state.guide.state(), track = state.guideTrack;
    if (!gs || !track) return;
    const p = UG.guide.progress(gs.cps, gs.cur, gs.plan.view.total_m);
    const x = guideXfer(gs, p);
    let pts = [], maxZoom = 17;
    if (x) { pts = xferView(x); maxZoom = 18; }   // 환승: 두 승강장
    else if (p.next && p.next.kind === 'junction' && p.next.jn != null) { pts = forkPoints(forkData(gs.plan, p.next.jn)); maxZoom = 18; }   // 갈림길: 갈래가 보이게 크게
    else {
      const doneAt = gs.cur >= 0 ? gs.cps[gs.cur].at : 0;
      UG.guide.sliceTrack(track, doneAt, p.next ? p.next.at : doneAt).forEach(function (l) { l.forEach(function (q) { pts.push(q); }); });
    }
    // 지금 위치를 가운데에 두고 이 단계(다음 확인 지점까지)가 보이게. 아주 멀리 벗어났으면 지금 단계만
    if (state.guidePos && !(state.guideOff > 1000)) pts = aroundCenter(pts, state.guidePos);
    if (pts.length) fitTo(pts, maxZoom);
  }

  // 마지막 확인 지점에 도착: 안내를 닫고 역 시트(여기서 지하로 갈 수 있는 곳)를 연다
  function guideFinished(st) {
    const p = st.plan, si = p.route.walk || p.route.egress ? -1 : p.route.endSi;
    if (si < 0) return false;   // 지상으로 바로 걷는 경로·여기서 나가기: 안내 화면에 '도착했습니다'·'지상으로 나왔습니다'
    closeGuideView();
    openStation(si, { tab: 'reach', arrived: p.to.kind === 'point' ? '목적지에 도착했습니다 · 가까운 역' : '도착했습니다' });
    return true;
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
    if (gs.plan.route.egress) {
      // 여기서 나가기 중: 같은 곳으로 지하로(노출을 늘리지 않고) 갈 수 없으면 다시 출발할 곳에서 나갈 곳을 다시 고르게 한다
      const again = RT.findRoute(state.G, from, gs.plan.to, { blocked: state.blocked });
      if (!again || again.exposed_m > gs.plan.route.exposed_m + 1) {
        state.blockCount++;
        const start = from.kind === 'station' ? { kind: 'station', si: from.si } : from;
        const label = r.restartLabel || (from.label || from.text || '다시 출발할 곳');
        openExitHere({ start: start, label: label, where: 'guide', note: '막은 구간 제외' + (r.backtrack >= 10 ? ' · ' + label + '까지 ' + PN.fmtDist(r.backtrack) + ' 되돌아가기' : '') });
        return;
      }
    }
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
    // 알림은 한 줄: '막은 구간 제외 · 정발산역까지 300m 되돌아가기' (되돌아갈 일이 없으면 '막은 구간 제외 · 새 경로')
    const note = '막은 구간 제외 · ' + (r.backtrack >= 10 ? PN.esc(back) + '까지 ' + PN.fmtDist(r.backtrack) + ' 되돌아가기' : '새 경로');
    openGuide(p, back + (r.from ? ' (확인한 곳)' : ''), note, r.backtrack);
    if (p.alt) state.guide.setAlt(PN.altHtml(p.view.alt, 'g-alt'));   // 다시 찾은 길보다 꽤 짧은 대안(첫 확인 지점 전까지)
  }

  /* =========================================================
     8-1. 여기서 나가기 (지상으로 나가는 곳 후보 → 고르면 그곳으로 다시 안내)
       - 길 안내 중: 지금 위치 = 쓸 만한 GPS 가 경로 가까이 있으면 그 경로 위 자리, 경로에서 멀리 벗어났으면 가장 가까운 선로,
         GPS 가 없으면 추정 위치(마지막 확인 지점 + 걸은 시간 × 속도).
       - 역 시트: 그 역의 승강장에서.
       - 후보 계산은 exithere.js(지하 간선만, 5km 까지). egress.json 이 아직 없으면 역 출구로 먼저 보여 주고 받으면 다시 그린다.
     ========================================================= */
  function guideHere() {
    const gs = state.guide.state(), track = state.guideTrack;
    const p = UG.guide.progress(gs.cps, gs.cur, gs.plan.view.total_m);
    let m = null, label = '';
    if (gpsUsable()) {
      const pr = UG.guide.projectOnTrack(track, state.myLoc.lat, state.myLoc.lon);
      if (pr.off <= CFG.offRouteM) { m = pr.m; label = 'GPS 위치'; }
      else {
        const s = UG.exithere.snapToNetwork(state.G, state.myLoc.lat, state.myLoc.lon, 400);
        if (s) return { start: Object.assign(s, { si: -1 }), label: 'GPS 위치' };
      }
    }
    if (m == null) {
      const doneAt = gs.cur >= 0 ? gs.cps[gs.cur].at : 0, walked = Math.min(state.guide.walkedM(), p.toNext_m);
      m = doneAt + walked;
      const from = gs.cur >= 0 ? gs.cps[gs.cur].label : gs.startLabel;
      label = walked < 30 ? from : from + ' 지나 약 ' + PN.fmtDist(Math.round(walked / 10) * 10) + '(추정)';
    }
    const loc = UG.guide.locateOnPath(state.G, gs.plan, m);
    if (!loc || loc.kind === 'surface') return { surface: true };
    return { start: loc, label: label };
  }

  function guideExitHere() {
    const h = guideHere();
    if (h.surface) { toast('지금은 지상 구간입니다. 가까운 출구로 들어가거나 건물 안으로 피하세요.', 8000); return; }
    openExitHere({ start: h.start, label: h.label, where: 'guide' });
  }

  // ctx = { start(exithere 출발), label(기준 글), where: 'guide' | 'station', ownSi?, note? }
  function openExitHere(ctx) {
    const run = function () {
      return UG.exithere.findExits(state.G, ctx.start, {
        egress: state.egress || null, blocked: state.blocked, ownSi: ctx.ownSi, limit: 10,
        areas: UG.transfer ? UG.transfer.exitAreas : null
      });
    };
    state.exitHere = { ctx: ctx, res: run() };
    showExitList(true);
    if (state.egress === undefined) {   // 받으면 터널 출입구·수직구·차량기지를 넣어 다시
      loadEgress().then(function () {
        if (!state.exitHere || state.exitHere.ctx !== ctx) return;
        state.exitHere.res = run();
        showExitList(false);
      });
    }
  }

  function showExitList(fit) {
    const eh = state.exitHere, ctx = eh.ctx;
    const html = (ctx.where === 'guide' ? '<button type="button" class="icon-btn eh-close" data-eh-close aria-label="여기서 나가기 닫기">' +
      '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' : '') +
      (ctx.note ? '<p class="msg blocked">' + PN.esc(ctx.note) + '</p>' : '') +
      PN.exitHereHtml(eh.res, { basis: ctx.label, mpm: state.speed * 1000 / 60, loading: state.egress === undefined, noEgress: state.egress === null });
    if (ctx.where === 'guide') state.guide.showExits(html);
    else if (state.station) { state.station.tab = 'exit'; state.station.exitHtml = html; renderStation(); }
    // 지도: 후보 번호 핀, 처음에는 지금 위치와 후보들이 다 보이게
    state.guideLayer.setCandidates(eh.res.list);
    if (fit || !state.exitHere.fitted) {
      const pts = eh.res.list.map(function (c) { return [c.lat, c.lon]; });
      const s = ctx.start;
      if (s.lat != null) pts.push([s.lat, s.lon]);
      else if (s.kind === 'station') pts.push([state.g.stations[s.si].lat / 1e5, state.g.stations[s.si].lon / 1e5]);
      else if (s.kind === 'node') pts.push(GR.nodeLatLng(state.g, s.node));
      if (ctx.where === 'guide') { state.guideFollow = false; state.guide.setFollow(false); }
      if (pts.length) fitTo(pts, 16);
      state.exitHere.fitted = true;
    }
  }

  // 후보를 고름: 그곳까지 다시 찾아 길 안내를 (다시) 연다
  function pickExit(i) {
    const eh = state.exitHere;
    const c = eh && eh.res.list[i];
    if (!c) return;
    const ctx = eh.ctx, s = ctx.start;
    const from = s.kind === 'station' ? stationEndpoint(s.si) : Object.assign({}, s, { label: ctx.label, text: ctx.label });
    const to = { kind: 'egress', cand: c, lat: c.lat, lon: c.lon, text: c.title, label: c.title };
    state.exitHere = null;
    state.guideLayer.setCandidates(null);
    if (state.guide && state.guide.exitsOpen()) state.guide.hideExits();
    state.from = from; state.to = to; state.nearest = null; state.station = null;
    state.ui.fromInput.value = from.text || '';
    state.ui.toInput.value = c.title;
    syncPill();
    update();
    if (!state.plan || state.plan.to !== to) { toast('그곳까지 가는 길을 찾지 못했습니다. 다른 곳을 고르세요.', 8000); return; }
    if (!state.guide) setupGuide();
    openGuide(state.plan, ctx.label, '', 0);
  }

  // 역 시트의 '여기서 나가기'
  function stationExitHere() {
    const s = state.station;
    if (!s) return;
    clearReach();
    openExitHere({ start: { kind: 'station', si: s.si }, label: PN.yeok(state.g.stations[s.si].name), where: 'station', ownSi: s.si });
    state.sheet.set('half');
    const h = state.ui.viewStation.querySelector('#eh-title');
    if (h) h.focus({ preventScroll: true });
  }
  function closeStationExits() {
    if (state.exitHere && state.exitHere.ctx.where === 'station') state.exitHere = null;
    state.guideLayer.setCandidates(null);
  }

  /* =========================================================
     9. 역 시트: 여기서 지하로 갈 수 있는 곳 · 지하로 계속 이동 · 이 역 정보
     ========================================================= */
  function openStation(si, opts) {
    opts = opts || {};
    if (!state.G || (state.guide && state.guide.isOpen())) return;
    if (state.map) state.map.closePopup();
    closeStationExits();
    setExitFocus(null);
    state.station = { si: si, tab: opts.tab || 'info', arrived: opts.arrived || '', reach: null };
    loadExtra();   // 출구 주변 이름(아직 안 받았으면)
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
      f: s.f, tab: s.tab, arrived: s.arrived, reach: s.reach, saved: SV.places(), isSaved: isSavedStation(s.si), exitHtml: s.exitHtml,
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
    if (s.tab === 'exit') closeStationExits();
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
    const eh = ev.target.closest('[data-eh]');
    if (eh) { pickExit(+eh.dataset.eh); return; }
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
      case 'exit-here': if (s.tab === 'exit') setStationTab('info', false); else stationExitHere(); break;
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
    ui.sheet.setAttribute('aria-label', { route: '경로 결과', station: '역', info: '정보', msg: '알림' }[name]);
    state.sheet.set(size || 'half');
    ui.sheetBody.scrollTop = 0;
    syncChrome();
  }

  function hideSheet() { state.view = null; state.sheet.set('hidden'); syncChrome(); }

  // ×: 역 시트 -> (경로가 있으면) 경로로 돌아감, 경로 -> 경로 지우기, 정보·알림 -> 닫기
  function closeSheet() {
    if (state.view === 'station') {
      state.station = null;
      closeStationExits();
      setExitFocus(null);
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
     11. 떠 있는 버튼 · 레이어 · 정보 · 첫 안내 · 테마
     ========================================================= */
  function setupButtons() {
    const ui = state.ui;
    ui.goUnder.addEventListener('click', goNearestUnderground);
    ui.goUnderMini.addEventListener('click', goNearestUnderground);
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
  function onVisChange() {
    SV.set(CFG.keys.layers, state.vis); syncOnlyUnder();
    if (state.net) state.net.setVisible(state.vis);
    if (state.egressLayer) {   // 출구 후보: 켜면(줌 12 이상일 때) egress.json 을 받는다
      state.egressLayer.setVisible(state.vis.egress);
      wantEgress();
    }
  }

  // 화면 테마: auto(기기 설정) | dark | light
  function applyTheme(v, save) {
    if (['auto', 'dark', 'light'].indexOf(v) < 0) v = 'auto';
    if (v === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', v);
    if (save) SV.set(CFG.keys.theme, v);
    if (state.ui) state.ui.themeBtns.forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.themeSet === v)); });
  }

  // 처음 한 번: 안전 안내(평시에는 철도 터널에 들어가면 안 됨). 확인하면 다시 띄우지 않는다(정보 탭에도 한 줄).
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
    goNearestUnderground: goNearestUnderground, runNearest: runNearest, startGuide: function () { startGuide(false); },   // 시연: 걸음 세기 없이
    openStation: openStation, openSearch: openSearch, drawWalkLeg: drawWalkLeg, applyTheme: applyTheme,
    guide: function () { return state.guide; },
    keepCentered: keepCentered, aroundCenter: aroundCenter, switchAlt: switchAlt
  };

  /* 예전 미리보기 화면과 점검 스크립트가 쓰던 도우미 */
  globalThis.UGMap = {
    loadGraph: GR.loadGraph, validateGraph: GR.validateGraph, decodePolyline: GR.decodePolyline, nodeLatLng: GR.nodeLatLng,
    buildTrackGroups: LY.buildTrackGroups, buildStations: LY.buildStations, computeBounds: LY.computeBounds
  };

  if (typeof document !== 'undefined' && document.getElementById('map')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
