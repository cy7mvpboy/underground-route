/* layers.js — 지도와 지도 위 레이어 (Leaflet)
   - 철도망(구조별 선로), 역, 출구 번호, 간이 배경 지도(basemap.json), 경로, 도달 범위, 길 안내 표시, 내 위치.
   - 색은 모두 CSS 토큰(--safe 등)에서 읽는다. 테마가 바뀌면 setPalette 로 다시 칠한다.
   - 그리는 층(아래 -> 위): 타일 200 · 간이 배경 300 · 지명 390 · 철도망 400 · 도달 범위 430 · 길 안내 강조 445 · 경로 455 · 역 470
                           · 내 위치 정확도 원 480 · 표시(핀·출구) 600 · 내 위치 점 640 · 팝업 700
   - 경로를 보여 줄 때는 철도망을 흐리게(약 25%) 하고, 역은 경로가 지나는 역만 남긴다. */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};
  const GR = UG.graph;

  const STRUCTS = ['tunnel', 'bridge', 'ground'];   // 선로 구조 (tables.structs 이름)
  const UNDER_W = [1.6, 2.2, 3.0, 4.0];             // 줌 단계별 선 굵기(px): 지하 본선
  const OVER_W = [1.0, 1.4, 2.0, 2.6];              //                         지상·교량 본선
  const SVC_W = [0.6, 0.9, 1.2, 1.6];               //                         측선
  const OSM_LINK = '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- 색·테마 ---------- */
  function readPalette() {
    const cs = getComputedStyle(document.documentElement);
    const v = function (n) { return cs.getPropertyValue(n).trim(); };
    return {
      safe: v('--safe'), route: v('--route-safe'), bridge: v('--bridge'), expo: v('--expo'), text: v('--text'),
      surface: v('--surface'), bg: v('--bg'), muted: v('--muted'), casing: v('--casing'), coast: v('--coast'), admin: v('--admin'),
      reach: [v('--reach-1'), v('--reach-2'), v('--reach-3'), v('--reach-4')], sos: v('--sos'), me: v('--me')
    };
  }

  function watchTheme(cb) {
    let queued = false;
    const fire = function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; cb(); });
    };
    const mq = matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', fire); else if (mq.addListener) mq.addListener(fire);
    new MutationObserver(fire).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  function zoomTier(z) { return z < 9 ? 0 : z < 11 ? 1 : z < 14 ? 2 : 3; }

  /* ---------- 지도 ---------- */
  function createMap(el, reduceMotion) {
    const map = L.map(el, {
      preferCanvas: true, zoomControl: false, minZoom: 6, maxZoom: 18, zoomSnap: 0.5,
      maxBounds: [[31.5, 122.0], [40.5, 133.0]], maxBoundsViscosity: 0.8,
      fadeAnimation: !reduceMotion, zoomAnimation: !reduceMotion, markerZoomAnimation: !reduceMotion, inertia: !reduceMotion
    });
    L.control.zoom({ position: 'topright', zoomInTitle: '확대', zoomOutTitle: '축소' }).addTo(map);   // 넓은 화면 오른쪽 위. 폰에서는 CSS 로 숨긴다(두 손가락 확대)
    L.control.scale({ position: 'bottomleft', imperial: false, maxWidth: 90 }).addTo(map);
    map.attributionControl.setPosition('bottomleft');   // 오른쪽 아래는 둥근 단추 자리
    map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
    map.attributionControl.addAttribution('© ' + OSM_LINK + ' 기여자 (ODbL)');
    [['basemap', 300], ['placenames', 390], ['reach', 430], ['guide', 445], ['route', 455], ['stations', 470], ['meacc', 480], ['me', 640]].forEach(function (p) {
      map.createPane(p[0]).style.zIndex = p[1];
    });
    ['placenames', 'meacc', 'me'].forEach(function (n) { map.getPane(n).style.pointerEvents = 'none'; });   // 누르기는 아래 지도·역으로
    return map;
  }

  // 배경 타일: 실패해도 철도망만으로 동작한다. onState('ok' | 'none')
  function addBaseTiles(map, url, onState) {
    const tiles = L.tileLayer(url, { maxZoom: 19 });   // 출처(© OpenStreetMap 기여자)는 지도 왼쪽 아래 출처 줄에 함께 적었다
    let loaded = 0, failed = 0, removed = false;
    tiles.on('tileload', function () { loaded++; if (loaded === 1) onState('ok'); });
    tiles.on('tileerror', function () {
      failed++;
      if (loaded > 0) return;
      onState('none');
      if (failed >= 6 && !removed) { removed = true; map.removeLayer(tiles); }   // 하나도 못 받았으면 더 요청하지 않는다
    });
    tiles.addTo(map);
    setTimeout(function () { if (loaded === 0) onState('none'); }, 8000);
    return tiles;
  }

  /* ---------- 철도망 ---------- */
  // 선로 간선을 구조 x 본선/측선으로 묶는다. 각 묶음은 선 조각 배열(멀티 폴리라인).
  function buildTrackGroups(g) {
    const E = g.edges, T = g.tables;
    const track = T.kinds.indexOf('track'), main = T.services.indexOf('');
    const structKey = T.structs.map(function (n) { return STRUCTS.indexOf(n) >= 0 ? n : null; });
    const groups = {};
    STRUCTS.forEach(function (k) { groups[k] = { main: [], service: [] }; });
    for (let e = 0; e < E.a.length; e++) {
      if (E.k[e] !== track) continue;
      const key = structKey[E.s[e]];
      if (!key) continue;
      groups[key][E.svc[e] === main ? 'main' : 'service'].push(GR.edgeShape(g, e));
    }
    return groups;
  }

  // 그릴 선로 간선 번호(선로이고 구조가 지하·교량·지상인 것), 간선 번호 순
  function trackEdges(g) {
    const E = g.edges, T = g.tables, track = T.kinds.indexOf('track');
    const structKey = T.structs.map(function (n) { return STRUCTS.indexOf(n) >= 0 ? n : null; });
    const out = [];
    for (let e = 0; e < E.a.length; e++) if (E.k[e] === track && structKey[E.s[e]]) out.push(e);
    return out;
  }
  // edges 중 양 끝 노드를 감싼 네모가 box = [남, 서, 북, 동] 과 겹치는 간선(첫 화면에 먼저 그릴 선로)
  function edgesInBox(g, edges, box) {
    const E = g.edges, N = g.nodes;
    return edges.filter(function (e) {
      const la1 = N.lat[E.a[e]] / 1e5, lo1 = N.lon[E.a[e]] / 1e5, la2 = N.lat[E.b[e]] / 1e5, lo2 = N.lon[E.b[e]] / 1e5;
      return Math.max(la1, la2) >= box[0] && Math.min(la1, la2) <= box[2] && Math.max(lo1, lo2) >= box[1] && Math.min(lo1, lo2) <= box[3];
    });
  }

  // 화면이 놀 때 fn 을 부른다(requestIdleCallback 이 없는 브라우저는 setTimeout)
  function whenIdle(fn) {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 300 });
    else setTimeout(fn, 16);
  }

  /* 지하 선로는 또렷하게, 지상·교량은 옅게(경로를 볼 때 노출 구간은 경로가 따로 진하게 그린다).
     dim: 0 = 보통, 1 = 경로·도달 범위를 볼 때(전체를 약 25%로)
     전국 선로(약 9만 6천 점)를 한 번에 그리면 느린 폰에서 첫 화면이 늦게 뜬다. 그래서 두 번에 나눠 그린다.
       1) 만들 때: 지금 보이는 곳(둘레 포함, 화면 2배)에 닿는 선로만 묶는다. setVisible 로 바로 그려진다.
       2) drawRest(done): 화면이 놀 때 나머지 선 모양을 조금씩(한 번에 약 8ms) 풀어 두고,
          다 풀면 묶음(6개)을 하나씩 전국 선로로 바꾼다. 다 바꾼 뒤 모습은 예전(전국을 한 번에 그림)과 같다(같은 묶음·같은 순서). */
  const REST_SLICE_MS = 8;
  function NetworkLayer(map, g) {
    const renderer = L.canvas({ padding: 0.3 });
    const E = g.edges, main = g.tables.services.indexOf('');
    const structs = g.tables.structs;
    const edges = trackEdges(g);
    const shapes = new Array(E.a.length);   // 간선 번호 -> 선 모양(L.LatLng 배열). 한 번만 푼다
    function shape(e) {
      if (!shapes[e]) shapes[e] = GR.edgeShape(g, e).map(function (p) { return L.latLng(p[0], p[1]); });
      return shapes[e];
    }
    // 간선 목록 -> 묶음 [{key, tier, lines}] (측선 아래·본선 위, 지상 < 교량 < 지하 순서). buildTrackGroups 와 같은 묶음이다.
    function groupLines(list) {
      const groups = {};
      STRUCTS.forEach(function (k) { groups[k] = { main: [], service: [] }; });
      list.forEach(function (e) { groups[structs[E.s[e]]][E.svc[e] === main ? 'main' : 'service'].push(shape(e)); });
      const out = [];
      ['service', 'main'].forEach(function (tier) {
        ['ground', 'bridge', 'tunnel'].forEach(function (key) {
          if (groups[key][tier].length) out.push({ key: key, tier: tier, lines: groups[key][tier] });
        });
      });
      return out;
    }
    function makePart(gr) {
      return { key: gr.key, tier: gr.tier, layer: L.polyline(gr.lines, { renderer: renderer, interactive: false, smoothFactor: 1.5 }) };
    }
    const b = map.getBounds().pad(0.5);
    let parts = groupLines(edgesInBox(g, edges, [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()])).map(makePart);
    let full = false, restStarted = false;
    let pal = null, zt = -1, dim = 0, vis = null;
    function style(p) {
      const main = p.tier === 'main', under = p.key === 'tunnel';
      const base = !main ? 0.3 : under ? 0.95 : 0.5;
      const op = dim ? (under ? 0.28 : 0.2) * (main ? 1 : 0.6) : base;
      const color = under ? pal.safe : p.key === 'bridge' ? pal.bridge : pal.expo;
      return { color: color, weight: (!main ? SVC_W : under ? UNDER_W : OVER_W)[zt], opacity: op, lineCap: 'round', lineJoin: 'round' };
    }
    function restyle(force) {
      const t = zoomTier(map.getZoom());
      if (!force && t === zt) return;
      zt = t;
      parts.forEach(function (p) { p.layer.setStyle(style(p)); });
    }
    // 보이게 할 묶음을 정해진 순서로 지도에 넣는다
    function shown(p) { return vis[p.key] && (p.tier === 'main' || vis.service); }
    function show() {
      parts.forEach(function (p) { if (shown(p)) p.layer.addTo(map); });
    }
    function drawRest(done) {
      if (full || restStarted) return;
      restStarted = true;
      let i = 0, groups = null, k = 0;
      // 1) 나머지 선 모양 풀기(한 번에 약 8ms)
      const decode = function () {
        const until = performance.now() + REST_SLICE_MS;
        while (i < edges.length) {
          shape(edges[i++]);
          if ((i & 63) === 0 && performance.now() > until) break;
        }
        if (i < edges.length) { whenIdle(decode); return; }
        groups = groupLines(edges);
        whenIdle(swap);
      };
      // 2) 묶음 하나씩 전국 선로로 바꾸기: 새 묶음을 넣고 같은 묶음의 첫 화면 선을 뺀다.
      //    새 묶음은 맨 위에 쌓이므로, 6개를 다 바꾸면 순서가 예전과 같아진다.
      const swap = function () {
        const p = makePart(groups[k++]);
        if (pal) p.layer.setStyle(style(p));
        const old = parts.filter(function (q) { return q.key === p.key && q.tier === p.tier && !q.full; })[0];
        p.full = true;
        parts = parts.filter(function (q) { return q !== old; }).concat([p]);
        if (vis && shown(p)) p.layer.addTo(map);
        if (old) map.removeLayer(old.layer);
        if (k < groups.length) { whenIdle(swap); return; }
        full = true;
        if (done) done();
      };
      whenIdle(decode);
    }
    return {
      setPalette: function (p) { pal = p; restyle(true); },
      onZoom: function () { restyle(false); },
      setDim: function (on) { const d = on ? 1 : 0; if (dim !== d) { dim = d; restyle(true); } },
      // vis = {tunnel, bridge, ground, service}. 순서를 지키려고 모두 뺐다가 정해진 순서로 넣는다.
      setVisible: function (v) {
        vis = v;
        parts.forEach(function (p) { map.removeLayer(p.layer); });
        show();
      },
      drawRest: drawRest,
      isFull: function () { return full; },
      count: function () { return parts.length; }
    };
  }

  /* ---------- 역 ---------- */
  function lineNames(T, ls) {
    const out = [];
    (T.line_sets[ls] || []).forEach(function (i) { const n = T.lines[i]; if (n && out.indexOf(n) < 0) out.push(n); });
    return out;
  }

  // 역: 허브(노선별 승강장)마다 노선 이름과 지하 여부. status = all | part | none
  function buildStations(g) {
    const T = g.tables;
    return g.stations.map(function (s, i) {
      const hubs = (s.hubs || []).map(function (h, j) {
        return { node: h, lines: lineNames(T, (s.hub_ls || [])[j]), ug: (s.ug || [])[j] === 1 };
      });
      const ugN = hubs.filter(function (h) { return h.ug; }).length;
      const status = hubs.length > 0 && ugN === hubs.length ? 'all' : (ugN > 0 ? 'part' : 'none');
      return { index: i, name: s.name, lat: s.lat / 1e5, lon: s.lon / 1e5, region: s.rg, hubs: hubs, status: status };
    });
  }

  // 역 점(줌 11 이상). 누르면 opts.onClick(역 번호).
  // setOnly(Set, mode) 이면 그 역만(줌과 관계없이): mode 'route' = 경로가 지나는 역(크게), 'reach' = 도달 범위의 역(작게, 색 띠가 보이게).
  function StationLayer(map, g, opts) {
    const renderer = L.canvas({ pane: 'stations', padding: 0.3, tolerance: 10 });
    const stations = buildStations(g);
    const markers = stations.map(function (st) {
      const m = L.circleMarker([st.lat, st.lon], { renderer: renderer, bubblingMouseEvents: false, radius: 4 });
      m.on('click', function () { opts.onClick(st.index); });
      return m;
    });
    const group = L.layerGroup();
    let pal = null, only = null, mode = 'route', shown = new Set();
    function style(st, z) {
      const big = z >= 13;
      if (only && mode === 'reach') return { radius: big ? 4 : 2.5, weight: 1.2, color: pal.text, fillColor: pal.casing, fillOpacity: 1, opacity: 0.9 };
      if (only) return { radius: big ? 6 : 5, weight: 2.5, color: pal.route, fillColor: pal.casing, fillOpacity: 1, opacity: 1 };
      if (st.status === 'none') return { radius: big ? 4 : 2.5, weight: 1, color: pal.bg, fillColor: pal.muted, fillOpacity: 0.9, opacity: 0.9 };
      return { radius: big ? 5.5 : 3.5, weight: big ? 2 : 1.5, color: pal.safe, fillColor: pal.bg, fillOpacity: 1, opacity: 1 };
    }
    function sync() {
      const z = map.getZoom();
      const want = new Set();
      if (only) only.forEach(function (i) { want.add(i); });
      else if (z >= opts.minZoom) stations.forEach(function (st) { want.add(st.index); });
      if (!map.hasLayer(group)) group.addTo(map);
      shown.forEach(function (i) { if (!want.has(i)) group.removeLayer(markers[i]); });
      want.forEach(function (i) { markers[i].setStyle(style(stations[i], z)); if (!shown.has(i)) group.addLayer(markers[i]); });
      shown = want;
      return want.size > 0;
    }
    return {
      stations: stations,
      setPalette: function (p) { pal = p; sync(); },
      sync: sync,
      setOnly: function (set, m) { only = set && set.size ? set : null; mode = m || 'route'; sync(); }
    };
  }

  /* ---------- 출구 번호 (줌 15 이상, 화면 안의 것만 만든다) ---------- */
  function ExitLayer(map, G, opts) {
    const g = G.g, EN = g.entrances, N = g.nodes;
    const group = L.layerGroup().addTo(map);
    const cache = new Map();      // 출입구 번호 -> 마커
    const used = new Set();       // 경로에 쓰인 출구는 RouteLayer 가 따로 그린다
    let onlySt = null;            // 경로를 볼 때: 출발·도착 역의 출구만
    function marker(i) {
      if (cache.has(i)) return cache.get(i);
      const v = EN.node[i];
      const ref = EN.ref[i] || '·';
      const m = L.marker([N.lat[v] / 1e5, N.lon[v] / 1e5], {
        icon: L.divIcon({ className: '', html: '<span class="exit-tag">' + esc(ref) + '</span>', iconSize: [0, 0] }),
        keyboard: false, title: g.stations[EN.station[i]].name + '역 ' + (EN.ref[i] ? EN.ref[i] + '번 출구' : '출구'),
        bubblingMouseEvents: false
      });
      m.bindPopup(function () { return opts.popupHtml(i); }, { maxWidth: 260 });
      cache.set(i, m);
      return m;
    }
    function sync() {
      if (map.getZoom() < opts.minZoom) { group.clearLayers(); return; }
      const b = map.getBounds().pad(0.2);
      const want = new Set();
      for (let i = 0; i < EN.node.length; i++) {
        if (used.has(i) || (onlySt && !onlySt.has(EN.station[i]))) continue;
        const v = EN.node[i];
        if (b.contains([N.lat[v] / 1e5, N.lon[v] / 1e5])) want.add(i);
      }
      group.eachLayer(function (m) { if (!want.has(m._exitIndex)) group.removeLayer(m); });
      want.forEach(function (i) { const m = marker(i); m._exitIndex = i; if (!group.hasLayer(m)) group.addLayer(m); });
    }
    map.on('moveend zoomend', sync);
    return {
      sync: sync,
      setUsed: function (list) { used.clear(); (list || []).forEach(function (i) { used.add(i); }); sync(); },
      setOnlyStations: function (set) { onlySt = set && set.size ? set : null; sync(); }
    };
  }

  /* ---------- 간이 배경 지도 (해안선·시도 경계·지명) ----------
     타일을 못 받을 때(오프라인·차단된 뷰어)도 위치를 알아볼 수 있게. data = basemap.json */
  function BasemapLayer(map, data) {
    const renderer = L.canvas({ pane: 'basemap', padding: 0.3 });
    const prec = data.precision == null ? 5 : data.precision;
    const coast = [], admin = [];
    (data.lines || []).forEach(function (l) { (l.k === 'admin' ? admin : coast).push(GR.decodePolyline(l.p, prec)); });
    const coastLayer = L.polyline(coast, { renderer: renderer, interactive: false, smoothFactor: 1.5 });
    const adminLayer = L.polyline(admin, { renderer: renderer, interactive: false, smoothFactor: 1.5 });
    coastLayer.addTo(map); adminLayer.addTo(map);
    const labels = (data.labels || []).map(function (p) {
      return {
        k: p.k, m: L.marker([p.lat, p.lon], {
          pane: 'placenames', interactive: false, keyboard: false,
          icon: L.divIcon({ className: '', html: '<span class="place-label ' + (p.k === 'region' ? 'region' : 'city') + '">' + esc(p.name) + '</span>', iconSize: [0, 0] })
        })
      };
    });
    const labelGroup = L.layerGroup().addTo(map);
    let showLabels = true;
    function sync() {
      const z = map.getZoom();
      labels.forEach(function (l) {
        const on = showLabels && (l.k === 'region' ? z < 9 : z >= 8);   // 시도 이름은 넓게 볼 때, 도시 이름은 줌 8 이상
        if (on && !labelGroup.hasLayer(l.m)) labelGroup.addLayer(l.m);
        if (!on && labelGroup.hasLayer(l.m)) labelGroup.removeLayer(l.m);
      });
    }
    map.on('zoomend', sync);
    sync();
    if (data.attribution && String(data.attribution).indexOf('OpenStreetMap') < 0) map.attributionControl.addAttribution(esc(data.attribution));
    return {
      setPalette: function (pal) {
        coastLayer.setStyle({ color: pal.coast, weight: 1.4, opacity: 0.9 });
        adminLayer.setStyle({ color: pal.admin, weight: 1, opacity: 0.9, dashArray: '4 4' });
      },
      setLabels: function (on) { showLabels = on; sync(); }
    };
  }

  // 모양을 모르는 연결(지하도 모양이 없는 환승, 지하도 선 끝 ↔ 승강장)의 옅은 점선. 경로와 길 안내 그림이 같이 쓴다.
  // 실제 통로처럼 보이지 않게 가늘고 흐리게.
  function xferLink(pal) {
    return { color: pal.text, weight: 2.5, opacity: 0.5, dashArray: '5 7', lineCap: 'round' };
  }

  /* ---------- 경로 ----------
     맨 위 층(route)에 테두리(어두운 테마: 어두운 색, 밝은 테마: 흰색)를 먼저 깔고 그 위에 색 선을 그린다.
     지하: 밝은 청록 실선. 지상 노출(선로): 지상은 주황빨강, 교량은 호박색의 조금 굵은 끊은 선.
     지상 도보 구간(출발 지점·출구 사이 등): 주황빨강 끊은 선.
     모양을 모르는 곳(지하도 모양이 없는 환승, 지하도 선 끝 ↔ 승강장): 테두리 없이 옅은 점선(xferLink)만.
     역 안 지하도 모양(passage.json)이 있는 출구 구간·환승은 app.js 가 그 선을 'under' 로 넘긴다.
     segs: [{pts, kind: 'under'|'ground'|'bridge'|'walk'|'xfer'}]
     other: 고르지 않은 다른 경로(지하 우선 ↔ 대안)의 선 [[lat, lon], …] — 비교용으로 가늘고 옅게, 경로 아래에 */
  function RouteLayer(map) {
    const renderer = L.svg({ pane: 'route', padding: 0.5 });
    const hlGroup = L.layerGroup().addTo(map);       // 누른 단계 강조(경로 아래)
    const group = L.layerGroup().addTo(map);
    const marks = L.layerGroup().addTo(map);
    const blockedGroup = L.layerGroup().addTo(map);  // 막은 구간
    let pal = null, drawn = null, blockedLines = [], hlLines = null;

    function paintBlocked() {
      blockedGroup.clearLayers();
      if (!blockedLines.length || !pal) return;
      const opt = { renderer: renderer, interactive: false, lineCap: 'butt' };
      L.polyline(blockedLines, Object.assign({ color: pal.casing, weight: 10, opacity: 0.95 }, opt)).addTo(blockedGroup);
      L.polyline(blockedLines, Object.assign({ color: pal.text, weight: 5, opacity: 0.9, dashArray: '3 5' }, opt)).addTo(blockedGroup);
      const first = blockedLines[0], mid = first[Math.floor(first.length / 2)];
      L.marker(mid, {
        icon: L.divIcon({ className: '', html: '<span class="blocked-tag">막힘</span>', iconSize: [0, 0] }),
        keyboard: false, interactive: false, title: '막은 구간'
      }).addTo(blockedGroup);
    }

    function pin(latlng, cls, text, title) {
      return L.marker(latlng, {
        icon: L.divIcon({ className: '', html: '<div class="pin ' + cls + '"><span>' + text + '</span></div>', iconSize: [34, 34], iconAnchor: [17, 40] }),
        keyboard: false, interactive: false, title: title, zIndexOffset: 1000
      });
    }
    function tag(latlng, ref, title) {
      return L.marker(latlng, {
        icon: L.divIcon({ className: '', html: '<span class="exit-tag used">' + esc(ref || '·') + '</span>', iconSize: [0, 0] }),
        keyboard: false, interactive: false, title: title, zIndexOffset: 500
      });
    }

    function paint() {
      group.clearLayers();
      if (!drawn || !pal) return;
      const by = { under: [], ground: [], bridge: [], walk: [], xfer: [] };
      drawn.segs.forEach(function (s) { (by[s.kind] || by.ground).push(s.pts); });
      const opt = { renderer: renderer, interactive: false, lineCap: 'round', lineJoin: 'round' };
      const all = by.under.concat(by.ground, by.bridge, by.walk);
      if (drawn.other && drawn.other.length) L.polyline(drawn.other, Object.assign({ color: pal.text, weight: 3.5, opacity: 0.4 }, opt)).addTo(group);
      if (by.xfer.length) L.polyline(by.xfer, Object.assign({}, opt, xferLink(pal))).addTo(group);
      if (all.length) L.polyline(all, Object.assign({ color: pal.casing, weight: 12, opacity: 1 }, opt)).addTo(group);
      if (by.under.length) L.polyline(by.under, Object.assign({ color: pal.route, weight: 6.5, opacity: 1 }, opt)).addTo(group);
      if (by.ground.length) L.polyline(by.ground, Object.assign({ color: pal.expo, weight: 7.5, opacity: 1, dashArray: '14 8', lineCap: 'butt' }, opt)).addTo(group);
      if (by.bridge.length) L.polyline(by.bridge, Object.assign({ color: pal.bridge, weight: 7.5, opacity: 1, dashArray: '14 8', lineCap: 'butt' }, opt)).addTo(group);
      if (by.walk.length) L.polyline(by.walk, Object.assign({ color: pal.expo, weight: 7, opacity: 1, dashArray: '7 8' }, opt)).addTo(group);
    }
    function paintHl() {
      hlGroup.clearLayers();
      if (!hlLines || !hlLines.length || !pal) return;
      L.polyline(hlLines, { renderer: renderer, interactive: false, color: pal.text, weight: 22, opacity: 0.22, lineCap: 'round', lineJoin: 'round' }).addTo(hlGroup);
    }

    return {
      setPalette: function (p) { pal = p; paint(); paintBlocked(); paintHl(); },
      setBlocked: function (lines) { blockedLines = lines || []; paintBlocked(); },
      // view: { segs, from: {lat,lon}|null, to, exits: [{lat, lon, ref, title}], warnings: [{lat, lon}], other: [[lat, lon], …]|null }
      show: function (view) {
        drawn = view;
        paint();
        marks.clearLayers();
        (view.exits || []).forEach(function (x) { tag([x.lat, x.lon], x.ref, x.title).addTo(marks); });
        (view.junctions || []).forEach(function (j) {   // 갈림길: 작은 마름모
          L.marker([j.lat, j.lon], {
            icon: L.divIcon({ className: '', html: '<span class="jn-dot" aria-hidden="true"></span>', iconSize: [0, 0] }),
            keyboard: false, interactive: false, title: '갈림길'
          }).addTo(marks);
        });
        (view.warnings || []).forEach(function (w) {
          L.marker([w.lat, w.lon], {
            icon: L.divIcon({ className: '', html: '<span class="warn-pin"><span>!</span></span>', iconSize: [0, 0] }),
            keyboard: false, interactive: false, title: '지상 노출 시작'
          }).addTo(marks);
        });
        if (view.from) pin([view.from.lat, view.from.lon], 'pin-from', '출', '출발').addTo(marks);
        if (view.to) pin([view.to.lat, view.to.lon], 'pin-to', '도', '도착').addTo(marks);
      },
      // 경로 없이 출발·도착 핀만
      pins: function (from, to) {
        drawn = null; paint(); marks.clearLayers();
        if (from) pin([from.lat, from.lon], 'pin-from', '출', '출발').addTo(marks);
        if (to) pin([to.lat, to.lon], 'pin-to', '도', '도착').addTo(marks);
      },
      highlight: function (lines) { hlLines = lines; paintHl(); },
      clear: function () { drawn = null; paint(); marks.clearLayers(); hlLines = null; paintHl(); }
    };
  }

  /* ---------- 도달 범위 ('여기서 지하로 갈 수 있는 곳') ----------
     segs = reach.segments() 결과(띠마다 선 조각). 먼 띠를 아래에, 가까운 띠를 위에 칠한다. */
  function ReachLayer(map) {
    const renderer = L.canvas({ pane: 'reach', padding: 0.3 });
    const group = L.layerGroup().addTo(map);
    let pal = null, data = null;
    function paint() {
      group.clearLayers();
      if (!data || !pal) return;
      for (let b = data.segs.length - 1; b >= 0; b--) {
        if (!data.segs[b].length) continue;
        L.polyline(data.segs[b], { renderer: renderer, interactive: false, color: pal.casing, weight: 9, opacity: 0.9, lineCap: 'round', lineJoin: 'round' }).addTo(group);
      }
      for (let b = data.segs.length - 1; b >= 0; b--) {
        if (!data.segs[b].length) continue;
        L.polyline(data.segs[b], { renderer: renderer, interactive: false, color: pal.reach[b], weight: 5, opacity: 1, lineCap: 'round', lineJoin: 'round' }).addTo(group);
      }
      if (data.origin) {
        L.marker(data.origin, {
          icon: L.divIcon({ className: '', html: '<span class="reach-origin" aria-hidden="true"></span>', iconSize: [0, 0] }),
          keyboard: false, interactive: false, title: '출발 역'
        }).addTo(group);
      }
    }
    return {
      setPalette: function (p) { pal = p; paint(); },
      show: function (segs, origin) { data = { segs: segs, origin: origin }; paint(); },
      clear: function () { data = null; group.clearLayers(); },
      active: function () { return !!data; }
    };
  }

  /* ---------- 길 안내 표시 ----------
     지금 단계 강조(경로 아래 노란 띠), 다음 확인 지점, 추정 위치(GPS 가 없을 때: 속이 빈 점선 고리 + '추정' 글),
     환승 그림(두 노선 승강장 점과 노선 칩, 그 사이 지하도 선. 모양 자료가 없으면 옅은 점선),
     눌러 본 출구의 지하도 선(출구 -> 승강장).
     GPS 로 찾은 진짜 위치는 MeLayer(파란 점)가 그린다. */
  function GuideLayer(map) {
    const renderer = L.svg({ pane: 'guide', padding: 0.5 });
    const group = L.layerGroup().addTo(map);
    const xferGroup = L.layerGroup().addTo(map);
    let pal = null, seg = null, posMarker = null, nextMarker = null, xfer = null, xferRenderer = null;
    function paintSeg() {
      group.clearLayers();
      if (!seg || !seg.length || !pal) return;
      L.polyline(seg, { renderer: renderer, interactive: false, color: pal.sos, weight: 26, opacity: 0.55, lineCap: 'round', lineJoin: 'round' }).addTo(group);
    }
    // 지하도 조각 그리기(passage.js 의 [{kind, pts}]): 'under' = 테두리 + 경로의 지하 색 실선, 'xfer' = 옅은 점선(xferLink)
    function drawPieces(pieces, group) {
      const opt = { renderer: xferRenderer, interactive: false, lineCap: 'round', lineJoin: 'round' };
      const under = pieces.filter(function (p) { return p.kind === 'under'; }).map(function (p) { return p.pts; });
      const gaps = pieces.filter(function (p) { return p.kind !== 'under'; }).map(function (p) { return p.pts; });
      if (gaps.length) L.polyline(gaps, Object.assign({}, opt, xferLink(pal))).addTo(group);
      if (under.length) {
        L.polyline(under, Object.assign({ color: pal.casing, weight: 11, opacity: 1 }, opt)).addTo(group);
        L.polyline(under, Object.assign({ color: pal.route, weight: 6, opacity: 1 }, opt)).addTo(group);
      }
    }
    function ensurePane() {
      if (!map.getPane('xfer')) map.createPane('xfer').style.zIndex = 462;   // 경로(455) 위
      xferRenderer = xferRenderer || L.svg({ pane: 'xfer', padding: 0.5 });
    }
    // 환승 그림: 두 승강장 점과 노선 칩, 그 사이 통로.
    // 통로 모양(passage.json)이 있으면 그 지하도 선(xfer.pieces), 없으면 옅은 점선 하나(xferLink).
    // 모양을 모를 때 통로처럼 보이는 굵은 직선·화살표는 그리지 않는다(사용자 결정 2026-11-10).
    function paintXfer() {
      xferGroup.clearLayers();
      if (!xfer || !pal) return;
      ensurePane();
      const a = L.latLng(xfer.from.lat, xfer.from.lon), b = L.latLng(xfer.to.lat, xfer.to.lon);
      drawPieces(xfer.pieces || [{ kind: 'xfer', pts: [a, b] }], xferGroup);
      const right = map.project(b, 16).x >= map.project(a, 16).x;   // 이름표는 서로 바깥쪽에 단다(겹치지 않게)
      [[a, xfer.from, right ? 'l' : 'r', '출발 승강장'], [b, xfer.to, right ? 'r' : 'l', '갈아탈 승강장']].forEach(function (h) {
        const chipHtml = UG.lines ? UG.lines.chip(h[1].line) : esc(h[1].line);
        L.marker(h[0], {
          icon: L.divIcon({ className: '', iconSize: [0, 0], html: '<span class="xh xh-' + h[2] + '"><span class="xh-dot"></span><span class="xh-t">' + chipHtml + '<span>승강장</span></span></span>' }),
          keyboard: false, interactive: false, zIndexOffset: 1700, title: h[3] + ': ' + h[1].line
        }).addTo(xferGroup);
      });
    }
    /* 갈림길 그림(지도): 들어오는 선 + 갈래마다 처음 약 150m. 고른 갈래는 경로 색 굵게, 다른 갈래는 흐리게.
       갈래 끝에 이름표('오른쪽 갈래 · 둔촌동 방면'), 가운데에 마름모. fork = {center, incoming, branches: [{pts, chosen, label}]} */
    let fork = null, forkRenderer = null;
    const forkGroup = L.layerGroup().addTo(map);
    function paintFork() {
      forkGroup.clearLayers();
      if (!fork || !pal) return;
      if (!map.getPane('fork')) map.createPane('fork').style.zIndex = 463;   // 경로(455)·환승 그림(462) 위
      forkRenderer = forkRenderer || L.svg({ pane: 'fork', padding: 0.5 });
      const opt = { renderer: forkRenderer, interactive: false, lineCap: 'round', lineJoin: 'round' };
      const alts = fork.branches.filter(function (b) { return !b.chosen; }), go = fork.branches.filter(function (b) { return b.chosen; });
      const lines = [fork.incoming].concat(fork.branches.map(function (b) { return b.pts; }));
      L.polyline(lines, Object.assign({ color: pal.casing, weight: 14, opacity: 1 }, opt)).addTo(forkGroup);
      alts.forEach(function (b) { L.polyline(b.pts, Object.assign({ color: pal.muted, weight: 6, opacity: 0.8, dashArray: '2 9' }, opt)).addTo(forkGroup); });
      L.polyline([fork.incoming].concat(go.map(function (b) { return b.pts; })), Object.assign({ color: pal.route, weight: 8, opacity: 1 }, opt)).addTo(forkGroup);
      const c = map.project(L.latLng(fork.center[0], fork.center[1]), 17);
      fork.branches.forEach(function (b) {
        const tip = b.pts[b.pts.length - 1], left = map.project(L.latLng(tip[0], tip[1]), 17).x < c.x;
        L.marker(tip, {
          icon: L.divIcon({ className: '', iconSize: [0, 0], html: '<span class="fork-tag' + (b.chosen ? ' is-go' : '') + (left ? ' at-l' : ' at-r') + '">' + esc(b.label) + '</span>' }),
          keyboard: false, interactive: false, zIndexOffset: b.chosen ? 1900 : 1800
        }).addTo(forkGroup);
      });
      L.marker(fork.center, {
        icon: L.divIcon({ className: '', iconSize: [0, 0], html: '<span class="jn-dot is-cur" aria-hidden="true"></span>' }),
        keyboard: false, interactive: false, zIndexOffset: 1850, title: '갈림길'
      }).addTo(forkGroup);
    }
    /* 여기서 나가기 후보: 목록 번호와 같은 번호 핀. list = [{lat, lon, k, title}] */
    const candGroup = L.layerGroup().addTo(map);
    let cands = null;
    function paintCands() {
      candGroup.clearLayers();
      (cands || []).forEach(function (c, i) {
        L.marker([c.lat, c.lon], {
          icon: L.divIcon({ className: '', iconSize: [0, 0], html: '<span class="eh-pin eh-pin-' + c.k + '"><b>' + (i + 1) + '</b></span>' }),
          keyboard: false, interactive: false, zIndexOffset: 2100 - i, title: (i + 1) + '. ' + c.title
        }).addTo(candGroup);
      });
    }
    /* 출구 하나의 지하도 선(역 시트·결과에서 출구를 눌렀을 때): 출구 -> 승강장 허브. pieces = passage.js 조각 */
    const exitGroup = L.layerGroup().addTo(map);
    let exitPath = null;
    function paintExit() {
      exitGroup.clearLayers();
      if (!exitPath || !pal) return;
      ensurePane();
      drawPieces(exitPath, exitGroup);
    }
    return {
      setPalette: function (p) { pal = p; paintSeg(); paintXfer(); paintFork(); paintExit(); },
      setExitPath: function (pieces) { exitPath = pieces || null; paintExit(); },
      setSegment: function (lines) { seg = lines; paintSeg(); },
      setFork: function (f) { fork = f || null; paintFork(); },
      setCandidates: function (list) { cands = list && list.length ? list : null; paintCands(); },
      // x = transfer.js 의 info 결과(없으면 지운다)
      setTransfer: function (x) { if ((x || null) === xfer) return; xfer = x || null; paintXfer(); },
      // 추정 위치(GPS 없음): 속이 빈 점선 고리와 이름표('추정 위치', '확인한 곳'). latlng 이 없으면 지운다.
      setEstimate: function (latlng, label) {
        if (!latlng) { if (posMarker) { map.removeLayer(posMarker); posMarker = null; } return; }
        const html = '<span class="pos-est" aria-hidden="true"><span class="pos-ring"></span><span class="pos-tag">' + esc(label || '추정') + '</span></span>';
        if (!posMarker) posMarker = L.marker(latlng, { icon: L.divIcon({ className: '', html: html, iconSize: [0, 0] }), keyboard: false, interactive: false, zIndexOffset: 2000 }).addTo(map);
        else { posMarker.setLatLng(latlng); posMarker.setIcon(L.divIcon({ className: '', html: html, iconSize: [0, 0] })); }
      },
      setNext: function (latlng, label) {
        if (nextMarker) { map.removeLayer(nextMarker); nextMarker = null; }
        if (!latlng) return;
        nextMarker = L.marker(latlng, {
          icon: L.divIcon({ className: '', html: '<span class="next-cp"><span class="next-cp-dot"></span><span class="next-cp-t">' + esc(label) + '</span></span>', iconSize: [0, 0] }),
          keyboard: false, interactive: false, zIndexOffset: 1500, title: '다음 확인 지점: ' + label
        }).addTo(map);
      },
      clear: function () {
        seg = null; group.clearLayers(); xfer = null; xferGroup.clearLayers(); fork = null; forkGroup.clearLayers(); cands = null; candGroup.clearLayers();
        exitPath = null; exitGroup.clearLayers();
        this.setEstimate(null); this.setNext(null);
      }
    };
  }

  /* ---------- 출구 후보 (egress.json: 터널 출입구·수직구·비상 출구·차량기지) ----------
     레이어 펼침의 '출구 후보'로 켜고 끈다. 터널 출입구·수직구는 줌 13 이상, 차량기지는 줌 12 이상, 화면 안의 것만 만든다.
     opts = { minZoom, depotZoom, icon(k) -> svg, popupHtml(item) } */
  function EgressLayer(map, opts) {
    const group = L.layerGroup().addTo(map), cache = new Map();
    let items = null, on = true;
    function marker(i) {
      if (cache.has(i)) return cache.get(i);
      const it = items[i];
      const m = L.marker([it.lat, it.lon], {
        icon: L.divIcon({ className: '', iconSize: [0, 0], html: '<span class="eg-tag eg-' + esc(it.k) + '">' + opts.icon(it.k) + '</span>' }),
        keyboard: false, title: it.name, bubblingMouseEvents: false
      });
      m.bindPopup(function () { return opts.popupHtml(it); }, { maxWidth: 260 });
      cache.set(i, m);
      return m;
    }
    function sync() {
      if (!items || !on) { group.clearLayers(); return; }
      const z = map.getZoom(), b = map.getBounds().pad(0.2), want = new Set();
      items.forEach(function (it, i) {
        if (z < (it.k === 'depot' ? opts.depotZoom : opts.minZoom) || !isFinite(it.lat)) return;
        if (b.contains([it.lat, it.lon])) want.add(i);
      });
      group.eachLayer(function (m) { if (!want.has(m._egIndex)) group.removeLayer(m); });
      want.forEach(function (i) { const m = marker(i); m._egIndex = i; if (!group.hasLayer(m)) group.addLayer(m); });
    }
    map.on('moveend zoomend', sync);
    return {
      setData: function (d) { items = d && Array.isArray(d.items) ? d.items : null; cache.clear(); group.clearLayers(); sync(); },
      setVisible: function (v) { on = !!v; sync(); },
      sync: sync
    };
  }

  /* ---------- 내 위치 (GPS) ----------
     파란 점(흰 테두리) + 옅은 정확도 원 + 천천히 퍼지는 고리(움직임 줄이기 설정이면 없음) + 방향 부채꼴(heading 이 있을 때).
     자기 층에 그려(점 640, 정확도 원 480) 경로·역·핀보다 늘 위에 보인다.
     DOM 은 한 번만 만들고 위치가 바뀌면 옮기기만 한다(고리 움직임이 끊기지 않게).
     fix = {lat, lon, acc(m), heading(도, 북쪽 0 · 시계 방향, 없으면 null)}
     look = {stale: 오래된 위치(흐리게), hidden: 숨김(길 안내 중 GPS 가 끊겼을 때), tag: 점 옆 작은 경고 글} */
  const ME_HTML = '<span class="me" aria-hidden="true"><svg class="me-head" viewBox="-30 -30 60 60"><path d="M0 0L-14-27A30 30 0 0 1 14-27Z"/></svg>' +
    '<span class="me-pulse"></span><span class="me-dot"></span><span class="me-tag"></span></span>';
  function MeLayer(map) {
    const renderer = L.svg({ pane: 'meacc', padding: 0.3 });
    let m = null, circle = null, pal = null, fix = null;
    const look = { stale: false, hidden: false, tag: '' };
    function circleStyle() {
      return { color: pal ? pal.me : '#3D8BFF', weight: 1.5, opacity: look.stale ? 0.3 : 0.6, fillColor: pal ? pal.me : '#3D8BFF', fillOpacity: look.stale ? 0.06 : 0.13 };
    }
    function paint() {
      if (!fix || look.hidden) {
        if (m) { map.removeLayer(m); m = null; }
        if (circle) { map.removeLayer(circle); circle = null; }
        return;
      }
      const ll = [fix.lat, fix.lon];
      const r = Math.min(fix.acc || 0, 3000);   // 정확도가 아주 나쁘면(수 km) 원을 키우지 않는다
      if (r >= 5) {
        if (!circle) circle = L.circle(ll, Object.assign({ renderer: renderer, radius: r, interactive: false }, circleStyle())).addTo(map);
        else { circle.setLatLng(ll); circle.setRadius(r); circle.setStyle(circleStyle()); }
      } else if (circle) { map.removeLayer(circle); circle = null; }
      if (!m) m = L.marker(ll, { pane: 'me', icon: L.divIcon({ className: '', html: ME_HTML, iconSize: [0, 0] }), keyboard: false, interactive: false }).addTo(map);
      else m.setLatLng(ll);
      const el = m.getElement() && m.getElement().firstChild;
      if (!el) return;
      el.classList.toggle('is-stale', look.stale);
      const head = el.querySelector('.me-head');
      const hasHead = fix.heading != null && isFinite(fix.heading);
      head.style.display = hasHead ? '' : 'none';
      if (hasHead) head.style.transform = 'translate(-50%, -50%) rotate(' + Math.round(fix.heading) + 'deg)';
      const tag = el.querySelector('.me-tag');
      tag.textContent = look.tag;
      tag.hidden = !look.tag;
    }
    return {
      set: function (f) { fix = f; paint(); },
      setLook: function (o) { Object.keys(o || {}).forEach(function (k) { look[k] = o[k]; }); paint(); },
      setPalette: function (p) { pal = p; if (circle) circle.setStyle(circleStyle()); },
      clear: function () { fix = null; paint(); }
    };
  }

  /* ---------- 범위 ---------- */
  // 본선 선로 끝점으로 전국·지역 범위 [남, 서, 북, 동]
  function computeBounds(g) {
    const E = g.edges, T = g.tables;
    const track = T.kinds.indexOf('track'), main = T.services.indexOf('');
    const all = [90, 180, -90, -180];
    const regions = T.regions.map(function () { return null; });
    function grow(b, la, lo) { if (la < b[0]) b[0] = la; if (lo < b[1]) b[1] = lo; if (la > b[2]) b[2] = la; if (lo > b[3]) b[3] = lo; }
    for (let e = 0; e < E.a.length; e++) {
      if (E.k[e] !== track || E.svc[e] !== main) continue;
      const r = E.rg[e];
      if (r >= 0 && !regions[r]) regions[r] = [90, 180, -90, -180];
      for (const n of [E.a[e], E.b[e]]) {
        const la = g.nodes.lat[n] / 1e5, lo = g.nodes.lon[n] / 1e5;
        grow(all, la, lo);
        if (r >= 0) grow(regions[r], la, lo);
      }
    }
    return { all: all, regions: regions };
  }

  UG.layers = {
    STRUCTS: STRUCTS, esc: esc, readPalette: readPalette, watchTheme: watchTheme, createMap: createMap, addBaseTiles: addBaseTiles,
    buildTrackGroups: buildTrackGroups, trackEdges: trackEdges, edgesInBox: edgesInBox, whenIdle: whenIdle,
    buildStations: buildStations, computeBounds: computeBounds,
    NetworkLayer: NetworkLayer, StationLayer: StationLayer, ExitLayer: ExitLayer, BasemapLayer: BasemapLayer,
    RouteLayer: RouteLayer, ReachLayer: ReachLayer, GuideLayer: GuideLayer, MeLayer: MeLayer, EgressLayer: EgressLayer
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
