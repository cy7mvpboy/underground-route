/* layers.js — 지도와 지도 위 레이어 (Leaflet)
   - 철도망(구조별 선로), 역, 출구 번호, 간이 배경 지도(basemap.json), 경로.
   - 색은 모두 CSS 토큰(--tunnel 등)에서 읽는다. 테마가 바뀌면 restyle 로 다시 칠한다.
   - 그리는 층(아래 -> 위): 타일 200 · 간이 배경 300 · 철도망 400 · 경로 440 · 역 450 · 표시(핀·출구) 600 · 팝업 700 */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};
  const GR = UG.graph;

  const STRUCTS = ['tunnel', 'bridge', 'ground'];   // 선로 구조 (tables.structs 이름)
  const MAIN_W = [1.6, 2.0, 2.6, 3.6];              // 줌 단계별 선 굵기(px): 본선
  const SVC_W = [0.7, 1.0, 1.4, 2.0];               //                         측선
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
      tunnel: v('--tunnel'), bridge: v('--bridge'), ground: v('--ground'), ink: v('--ink'), paper: v('--surface'),
      muted: v('--muted'), coast: v('--coast'), admin: v('--admin'), start: v('--start')
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
    new MutationObserver(fire).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  }

  function zoomTier(z) { return z < 8 ? 0 : z < 10 ? 1 : z < 13 ? 2 : 3; }

  /* ---------- 지도 ---------- */
  function createMap(el, reduceMotion) {
    const map = L.map(el, {
      preferCanvas: true, zoomControl: false, minZoom: 6, maxZoom: 18, zoomSnap: 0.5,
      maxBounds: [[31.5, 122.0], [40.5, 133.0]], maxBoundsViscosity: 0.8,
      fadeAnimation: !reduceMotion, zoomAnimation: !reduceMotion, markerZoomAnimation: !reduceMotion, inertia: !reduceMotion
    });
    L.control.zoom({ position: 'bottomright', zoomInTitle: '확대', zoomOutTitle: '축소' }).addTo(map);
    L.control.scale({ position: 'bottomleft', imperial: false, maxWidth: 100 }).addTo(map);
    map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
    map.attributionControl.addAttribution('데이터: © ' + OSM_LINK + ' 기여자 (ODbL)');
    // 층(pane): 간이 배경 300, 지명 390, 경로 440, 역 450
    map.createPane('basemap').style.zIndex = 300;
    map.createPane('placenames').style.zIndex = 390;
    map.getPane('placenames').style.pointerEvents = 'none';
    map.createPane('route').style.zIndex = 440;
    map.createPane('stations').style.zIndex = 450;
    return map;
  }

  // 배경 타일: 실패해도 철도망만으로 동작한다. onState('ok' | 'none')
  function addBaseTiles(map, url, onState) {
    const tiles = L.tileLayer(url, { maxZoom: 19, attribution: '배경 지도 © ' + OSM_LINK });
    let loaded = 0, failed = 0, removed = false;
    tiles.on('tileload', function () { loaded++; if (loaded === 1) onState('ok'); });
    tiles.on('tileerror', function () {
      failed++;
      if (loaded > 0) return;
      onState('none');
      // 하나도 못 받았으면 더 요청하지 않는다(차단된 뷰어·오프라인)
      if (failed >= 6 && !removed) { removed = true; map.removeLayer(tiles); }
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

  // 그리는 순서: 측선 아래, 본선 위. 지상 -> 교량 -> 지하(맨 위)
  function NetworkLayer(map, g) {
    const renderer = L.canvas({ padding: 0.3 });
    const groups = buildTrackGroups(g);
    const parts = [];
    ['service', 'main'].forEach(function (tier) {
      ['ground', 'bridge', 'tunnel'].forEach(function (key) {
        if (!groups[key][tier].length) return;
        parts.push({ key: key, tier: tier, layer: L.polyline(groups[key][tier], { renderer: renderer, interactive: false, smoothFactor: 1.5 }) });
      });
    });
    let pal = null, zt = -1, dim = false, vis = null;
    function style(p) {
      const main = p.tier === 'main';
      const op = (main ? 0.95 : 0.5) * (dim ? 0.4 : 1);   // 경로를 보여 줄 때는 흐리게
      return { color: pal[p.key], weight: (main ? MAIN_W : SVC_W)[zt], opacity: op, lineCap: 'round', lineJoin: 'round' };
    }
    function restyle(force) {
      const t = zoomTier(map.getZoom());
      if (!force && t === zt) return;
      zt = t;
      parts.forEach(function (p) { p.layer.setStyle(style(p)); });
    }
    return {
      setPalette: function (p) { pal = p; restyle(true); },
      onZoom: function () { restyle(false); },
      setDim: function (on) { if (dim !== on) { dim = on; restyle(true); } },
      // vis = {tunnel, bridge, ground, service}. 순서를 지키려고 모두 뺐다가 정해진 순서로 넣는다.
      setVisible: function (v) {
        vis = v;
        parts.forEach(function (p) { map.removeLayer(p.layer); });
        parts.forEach(function (p) { if (vis[p.key] && (p.tier === 'main' || vis.service)) p.layer.addTo(map); });
      },
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

  // 역 원 표시(줌 11 이상). opts: { minZoom, popupHtml(st), popupPad() }
  function StationLayer(map, g, opts) {
    const renderer = L.canvas({ pane: 'stations', padding: 0.3, tolerance: 10 });
    const stations = buildStations(g);
    const markers = stations.map(function (st) {
      const m = L.circleMarker([st.lat, st.lon], { renderer: renderer, bubblingMouseEvents: false, radius: 3.5 });
      m.bindPopup(function () { return opts.popupHtml(st); }, { maxWidth: 280 });
      m.on('popupopen', function (ev) {
        const p = opts.popupPad();
        ev.popup.options.autoPanPaddingTopLeft = p.topLeft;
        ev.popup.options.autoPanPaddingBottomRight = p.bottomRight;
      });
      return m;
    });
    const group = L.layerGroup(markers);
    let pal = null, big = null;
    function style(st, zoom) {
      const ug = st.status !== 'none';
      return { radius: zoom < 13 ? 3.5 : 5, weight: 1.5, color: ug ? pal.paper : pal.ink, fillColor: ug ? pal.ink : pal.paper, fillOpacity: 1, opacity: 1 };
    }
    function sync(force) {
      const z = map.getZoom();
      const show = z >= opts.minZoom, has = map.hasLayer(group);
      if (show && !has) group.addTo(map);
      if (!show && has) { map.closePopup(); map.removeLayer(group); }
      const b = z >= 13;
      if (force || b !== big) { big = b; markers.forEach(function (m, i) { m.setStyle(style(stations[i], z)); }); }
      return show;
    }
    return {
      stations: stations,
      setPalette: function (p) { pal = p; sync(true); },
      sync: sync,
      open: function (si) { const m = markers[si]; if (m && map.hasLayer(group)) m.openPopup(); }
    };
  }

  /* ---------- 출구 번호 (줌 15 이상, 화면 안의 것만 만든다) ---------- */
  function ExitLayer(map, G, opts) {
    const g = G.g, EN = g.entrances, N = g.nodes;
    const group = L.layerGroup().addTo(map);
    const cache = new Map();      // 출입구 번호 -> 마커
    const used = new Set();       // 경로에 쓰인 출구는 RouteLayer 가 따로 그린다
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
        if (used.has(i)) continue;
        const v = EN.node[i];
        if (b.contains([N.lat[v] / 1e5, N.lon[v] / 1e5])) want.add(i);
      }
      group.eachLayer(function (m) { if (!want.has(m._exitIndex)) group.removeLayer(m); });
      want.forEach(function (i) { const m = marker(i); m._exitIndex = i; if (!group.hasLayer(m)) group.addLayer(m); });
    }
    map.on('moveend zoomend', sync);
    return {
      sync: sync,
      setUsed: function (list) { used.clear(); (list || []).forEach(function (i) { used.add(i); }); sync(); }
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
        // 시도 이름은 넓게 볼 때(줌 9 미만), 도시 이름은 줌 8 이상에서
        const on = showLabels && (l.k === 'region' ? z < 9 : z >= 8);
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

  /* ---------- 경로 ----------
     지하 구간: 터널 색 실선. 지상 노출 구간(교량·지상): 지상 색 굵은 점선 + 테두리.
     출발점·도착점에서 출구까지 걷는 가상 구간: 지상 색 점점선. */
  function RouteLayer(map) {
    const renderer = L.svg({ pane: 'route', padding: 0.3 });
    const group = L.layerGroup().addTo(map);
    const marks = L.layerGroup().addTo(map);
    let hl = null, pal = null, drawn = null;

    function pin(latlng, cls, text, title) {
      return L.marker(latlng, {
        icon: L.divIcon({ className: '', html: '<div class="pin ' + cls + '"><span>' + text + '</span></div>', iconSize: [28, 28], iconAnchor: [3, 31] }),
        keyboard: false, interactive: false, title: title
      });
    }
    function tag(latlng, ref, title) {
      return L.marker(latlng, {
        icon: L.divIcon({ className: '', html: '<span class="exit-tag used">' + esc(ref || '·') + '</span>', iconSize: [0, 0] }),
        keyboard: false, interactive: false, title: title, zIndexOffset: 500
      });
    }

    // segs: [{pts, exposed, walk}] -> 테두리 먼저, 그 위에 색 선
    function paint() {
      group.clearLayers();
      if (!drawn) return;
      const casing = [], under = [], exposed = [], walk = [];
      drawn.segs.forEach(function (s) {
        casing.push(s.pts);
        (s.walk ? walk : s.exposed ? exposed : under).push(s.pts);
      });
      const opt = { renderer: renderer, interactive: false, lineCap: 'round', lineJoin: 'round' };
      if (casing.length) L.polyline(casing, Object.assign({ color: pal.paper, weight: 10, opacity: 0.95 }, opt)).addTo(group);
      if (under.length) L.polyline(under, Object.assign({ color: pal.tunnel, weight: 5.5, opacity: 1 }, opt)).addTo(group);
      if (exposed.length) {
        L.polyline(exposed, Object.assign({ color: pal.ground, weight: 12, opacity: 0.25 }, opt)).addTo(group);
        L.polyline(exposed, Object.assign({ color: pal.ground, weight: 6.5, opacity: 1, dashArray: '10 7', lineCap: 'butt' }, opt)).addTo(group);
      }
      if (walk.length) L.polyline(walk, Object.assign({ color: pal.ground, weight: 4, opacity: 1, dashArray: '1 8' }, opt)).addTo(group);
    }

    return {
      setPalette: function (p) { pal = p; paint(); if (hl) hl.setStyle({ color: pal.ink }); },
      // view: { segs, from: {lat,lon}|null, to, exits: [{lat, lon, ref, title}], warnings: [{lat, lon}] }
      show: function (view) {
        drawn = view;
        paint();
        marks.clearLayers();
        (view.exits || []).forEach(function (x) { tag([x.lat, x.lon], x.ref, x.title).addTo(marks); });
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
      // 단계 하나 강조(눌렀을 때)
      highlight: function (lines) {
        if (hl) { map.removeLayer(hl); hl = null; }
        if (lines && lines.length) {
          hl = L.polyline(lines, { renderer: renderer, interactive: false, color: pal.ink, weight: 13, opacity: 0.22, lineCap: 'round', lineJoin: 'round' });
          hl.addTo(map);
          hl.bringToBack();
        }
      },
      clear: function () { drawn = null; paint(); marks.clearLayers(); this.highlight(null); }
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
    buildTrackGroups: buildTrackGroups, buildStations: buildStations, computeBounds: computeBounds,
    NetworkLayer: NetworkLayer, StationLayer: StationLayer, ExitLayer: ExitLayer, BasemapLayer: BasemapLayer, RouteLayer: RouteLayer
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
