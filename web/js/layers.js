/* layers.js — 지도와 지도 위 레이어 (Leaflet)
   - 철도망(구조별 선로), 역, 출구 번호, 간이 배경 지도(basemap.json), 경로, 도달 범위, 길 안내 표시, 내 위치.
   - 색은 모두 CSS 토큰(--safe 등)에서 읽는다. 테마가 바뀌면 setPalette 로 다시 칠한다.
   - 그리는 층(아래 -> 위): 타일 200 · 간이 배경 300 · 지명 390 · 철도망 400 · 도달 범위 430 · 길 안내 강조 445 · 경로 455 · 역 470 · 표시(핀·출구) 600 · 팝업 700
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
      reach: [v('--reach-1'), v('--reach-2'), v('--reach-3'), v('--reach-4')], sos: v('--sos')
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
    [['basemap', 300], ['placenames', 390], ['reach', 430], ['guide', 445], ['route', 455], ['stations', 470]].forEach(function (p) {
      map.createPane(p[0]).style.zIndex = p[1];
    });
    map.getPane('placenames').style.pointerEvents = 'none';
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

  // 지하 선로는 또렷하게, 지상·교량은 옅게(경로를 볼 때 노출 구간은 경로가 따로 진하게 그린다).
  // dim: 0 = 보통, 1 = 경로·도달 범위를 볼 때(전체를 약 25%로)
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
    return {
      setPalette: function (p) { pal = p; restyle(true); },
      onZoom: function () { restyle(false); },
      setDim: function (on) { const d = on ? 1 : 0; if (dim !== d) { dim = d; restyle(true); } },
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

  /* ---------- 경로 ----------
     맨 위 층(route)에 테두리(어두운 테마: 어두운 색, 밝은 테마: 흰색)를 먼저 깔고 그 위에 색 선을 그린다.
     지하: 밝은 청록 실선. 지상 노출(선로): 지상은 주황빨강, 교량은 호박색의 조금 굵은 끊은 선.
     지상 도보 구간(출발 지점·출구 사이 등): 주황빨강 끊은 선. segs: [{pts, kind: 'under'|'ground'|'bridge'|'walk'}] */
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
      const by = { under: [], ground: [], bridge: [], walk: [] };
      drawn.segs.forEach(function (s) { (by[s.kind] || by.ground).push(s.pts); });
      const opt = { renderer: renderer, interactive: false, lineCap: 'round', lineJoin: 'round' };
      const all = by.under.concat(by.ground, by.bridge, by.walk);
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

  /* ---------- 길 안내 표시: 지금 단계 강조(경로 아래 노란 띠), 다음 확인 지점, 지금 위치(GPS 또는 추정) ---------- */
  function GuideLayer(map) {
    const renderer = L.svg({ pane: 'guide', padding: 0.5 });
    const group = L.layerGroup().addTo(map);
    let pal = null, seg = null, posMarker = null, nextMarker = null;
    function paintSeg() {
      group.clearLayers();
      if (!seg || !seg.length || !pal) return;
      L.polyline(seg, { renderer: renderer, interactive: false, color: pal.sos, weight: 26, opacity: 0.55, lineCap: 'round', lineJoin: 'round' }).addTo(group);
    }
    return {
      setPalette: function (p) { pal = p; paintSeg(); },
      setSegment: function (lines) { seg = lines; paintSeg(); },
      // mode: 'gps' | 'est'
      setPosition: function (latlng, mode) {
        if (!latlng) { if (posMarker) { map.removeLayer(posMarker); posMarker = null; } return; }
        const html = '<span class="pos-dot pos-' + mode + '" aria-hidden="true"></span>';
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
      clear: function () { seg = null; group.clearLayers(); this.setPosition(null); this.setNext(null); }
    };
  }

  /* ---------- 내 위치 점 ---------- */
  function MeLayer(map) {
    let m = null;
    return {
      set: function (lat, lon) {
        const ll = [lat, lon];
        if (!m) m = L.marker(ll, { icon: L.divIcon({ className: '', html: '<span class="me-dot" aria-hidden="true"></span>', iconSize: [0, 0] }), keyboard: false, interactive: false, title: '내 위치', zIndexOffset: 900 }).addTo(map);
        else m.setLatLng(ll);
      },
      clear: function () { if (m) { map.removeLayer(m); m = null; } }
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
    NetworkLayer: NetworkLayer, StationLayer: StationLayer, ExitLayer: ExitLayer, BasemapLayer: BasemapLayer,
    RouteLayer: RouteLayer, ReachLayer: ReachLayer, GuideLayer: GuideLayer, MeLayer: MeLayer
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
