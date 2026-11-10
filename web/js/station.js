/* station.js — 역 시트 (도착한 뒤, 또는 지도에서 역을 눌렀을 때)
   세 가지 할 일: ① 여기서 지하로 갈 수 있는 곳(reach.js) ② 지하로 계속 이동 ③ 이 역 정보
   + '여기서 나가기' 단추(이 역 출구·가까운 터널 출입구 등, exithere.js): 누르면 아래 칸이 후보 목록이 된다(탭은 아무것도 고르지 않은 상태)
   - stationFacts(G, si): 노선(승강장별 지하 여부·깊이), 환승(통로 거리·출처·지하 여부), 출구(번호, 역 중심에서 직선 거리)
   - 나머지는 HTML 만 만든다. 누르는 동작은 data-act 로 표시하고 app.js 가 처리한다. */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};
  const GR = UG.graph || (typeof require === 'function' ? require('./graph.js') : null);

  const TABS = [
    { id: 'reach', label: '여기서 지하로<br>갈 수 있는 곳', sr: '여기서 지하로 갈 수 있는 곳',
      icon: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="8" stroke-dasharray="2.6 2.6"/>' },
    { id: 'go', label: '지하로<br>계속 이동', sr: '지하로 계속 이동',
      icon: '<path d="M4 19V11a8 8 0 0 1 16 0v8"/><path d="M9 14h6M13 11.5l2.5 2.5-2.5 2.5"/><path d="M2 19h20"/>' },
    { id: 'info', label: '이 역<br>정보', sr: '이 역 정보',
      icon: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.6" r=".6" fill="currentColor"/>' }
  ];

  function esc(s) { return UG.panel.esc(s); }
  function svg(path, cls) {
    return '<svg class="' + (cls || 'ic') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
  }

  /* ---------- 역 정보 모으기 (DOM 없음) ---------- */
  function stationFacts(G, si) {
    const g = G.g, s = g.stations[si], T = g.tables, E = g.edges, EN = g.entrances, N = g.nodes;
    const lat = s.lat / 1e5, lon = s.lon / 1e5;
    const hubs = s.hubs.map(function (h, j) {
      const short = [];
      (G.hubShort.get(h) || []).forEach(function (n) { if (n && short.indexOf(n) < 0) short.push(n); });
      return { node: h, lines: short, full: G.hubLines.get(h) || [], ug: s.ug[j] === 1 };
    });
    const ugN = hubs.filter(function (h) { return h.ug; }).length;
    const status = hubs.length && ugN === hubs.length ? 'all' : ugN ? 'part' : 'none';
    // 환승: 이 역 허브끼리 잇는 환승 간선
    const hubIdx = new Map(hubs.map(function (h, i) { return [h.node, i]; }));
    const transfers = [], seen = new Set();
    hubs.forEach(function (h, i) {
      for (let k = G.adjStart[h.node]; k < G.adjStart[h.node + 1]; k++) {
        const e = G.adjEdge[k], w = G.adjNode[k];
        if (E.k[e] !== G.codes.transfer || !hubIdx.has(w) || seen.has(e)) continue;
        seen.add(e);
        transfers.push({ a: hubs[i].lines, b: hubs[hubIdx.get(w)].lines, m: E.len[e], source: T.sources[E.src[e]] || '', ug: G.weight[e] === g.weights.under });
      }
    });
    transfers.sort(function (x, y) { return x.m - y.m; });
    // 출구: 번호 순(숫자 먼저), 거리는 역 중심(OSM 역 노드 평균)에서 직선
    const exits = (G.stationEntrances[si] || []).map(function (i) {
      const v = EN.node[i];
      return { ent: i, ref: EN.ref[i], dist: GR.haversine(lat, lon, N.lat[v] / 1e5, N.lon[v] / 1e5) };
    }).sort(function (a, b) {
      const na = parseFloat(a.ref), nb = parseFloat(b.ref);
      if (isFinite(na) && isFinite(nb) && na !== nb) return na - nb;
      if (isFinite(na) !== isFinite(nb)) return isFinite(na) ? -1 : 1;
      return String(a.ref).localeCompare(String(b.ref), 'ko') || a.dist - b.dist;
    });
    // 깊이(있을 때만): [{line: 노선 번호 또는 이름, floor, platform_m, track_m}]
    const depth = Array.isArray(s.depth) ? s.depth.map(function (d) {
      const line = typeof d.line === 'number' ? (T.line_short[d.line] || T.lines[d.line] || '') : String(d.line || '');
      return { line: line, floor: d.floor || '', platform_m: d.platform_m, track_m: d.track_m };
    }) : null;
    const reg = T.regions[s.rg];
    const lines = [];
    hubs.forEach(function (h) { h.lines.forEach(function (n) { if (lines.indexOf(n) < 0) lines.push(n); }); });
    return {
      si: si, name: s.name, lat: lat, lon: lon, hubs: hubs, lines: lines, status: status,
      transfers: transfers, exits: exits, depth: depth && depth.length ? depth : null,
      region: reg ? reg.name : '', conf: reg ? reg.conf : 'unchecked'
    };
  }

  /* ---------- 시트 HTML ---------- */
  // view = { f(stationFacts), tab, arrived, reach(reachFrom 결과|null), speed, saved(저장한 장소 목록), isSaved }
  function head(view) {
    const f = view.f, PN = UG.panel, LN = UG.lines;
    const status = f.status === 'all' ? '지하역' : f.status === 'part' ? '일부 노선만 지하' : '지상역';
    return '<div class="sv-head st-head">' +
      (view.arrived ? '<p class="st-arrived">' + svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 'ic ic-s') + esc(view.arrived) + '</p>' : '') +
      '<div class="st-title"><h2 class="st-name" id="st-name" tabindex="-1">' + esc(PN.yeok(f.name)) + '</h2>' +
      '<button type="button" class="icon-btn st-save" data-act="save-station" aria-pressed="' + !!view.isSaved + '" aria-label="' + (view.isSaved ? '저장한 장소' : '이 역 저장') + '" title="' + (view.isSaved ? '저장한 장소' : '이 역 저장') + '">' +
      svg('<path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>') + '</button></div>' +
      (f.lines.length ? '<p class="st-chips">' + f.lines.map(function (n) { return LN.chip(n); }).join('') + '</p>' : '') +
      '<div class="st-row"><p class="st-status"><span class="st-dot st-dot-' + f.status + '" aria-hidden="true"></span>' + status +
      (f.region ? ' · ' + esc(PN.shortRegion(f.region)) : '') + '</p>' +
      // 여기서 나가기: 이 역 출구와 가까운 터널 출입구·수직구·차량기지(누르면 아래 칸이 후보 목록이 된다)
      '<button type="button" class="btn-secondary st-exit" id="st-exit" data-act="exit-here" aria-pressed="' + (view.tab === 'exit') + '" aria-controls="st-panel">' +
      PN.ehSvg('exit').replace('<svg ', '<svg class="ic" ') + '여기서 나가기</button></div>' +
      '<div class="st-tabs" role="tablist" aria-label="이 역에서 할 일">' + TABS.map(function (t) {
        const on = t.id === view.tab;
        return '<button type="button" class="st-tab" role="tab" id="st-tab-' + t.id + '" data-tab="' + t.id + '" aria-selected="' + on + '" aria-controls="st-panel"' + (on || (view.tab === 'exit' && t.id === TABS[0].id) ? '' : ' tabindex="-1"') + '>' +
          svg(t.icon) + '<span aria-hidden="true">' + t.label + '</span><span class="sr-only">' + t.sr + '</span></button>';
      }).join('') + '</div></div>';
  }

  // view.tab: 'reach' | 'go' | 'info' | 'exit'(여기서 나가기 후보 목록, view.exitHtml 은 app.js 가 panel.exitHereHtml 로 만든다)
  function sheetHtml(view) {
    if (view.tab === 'exit') return head(view) + '<div class="st-panel" id="st-panel" role="region" aria-labelledby="st-exit">' + (view.exitHtml || '') + '</div>';
    return head(view) + '<div class="st-panel" id="st-panel" role="tabpanel" aria-labelledby="st-tab-' + view.tab + '">' +
      (view.tab === 'reach' ? reachHtml(view) : view.tab === 'go' ? goHtml(view) : infoHtml(view)) + '</div>';
  }

  // ① 여기서 지하로 갈 수 있는 곳
  function reachHtml(view) {
    const f = view.f, r = view.reach, PN = UG.panel, LN = UG.lines, S = view.stations;
    if (!r || !r.sources.length) {
      return '<p class="msg">지하 승강장 없는 역</p>';
    }
    const total = r.counts[r.counts.length - 1];
    const hourly = r.counts[1];
    let html = '<p class="rc-lead"><b class="num">' + hourly + '</b>곳 <span>지하로 1시간 안에 갈 수 있는 역</span></p>' +
      '<ol class="bands" aria-label="걷는 시간별로 닿는 역 수(누적)">' + r.bands.map(function (b, i) {
        return '<li><span class="band-sw band-' + (i + 1) + '" aria-hidden="true"></span><span class="band-t">' + (b.min < 60 ? b.min + '분' : b.min / 60 + '시간') + ' 안</span>' +
          '<b class="num">' + r.counts[i] + '</b><span class="band-u">곳</span><span class="band-m num">~' + PN.fmtDist(b.m) + '</span></li>';
      }).join('') + '</ol>';
    if (total) {
      html += '<h3 class="sub-h">가장 멀리 갈 수 있는 역 <span class="muted">4시간 안</span></h3><ol class="far">' + r.farthest.map(function (x) {
        const s = S[x.si];
        return '<li><button type="button" class="row-btn" data-act="go-station" data-si="' + x.si + '">' +
          '<span class="row-main"><span class="row-title">' + esc(PN.yeok(s.name)) + '</span>' +
          '<span class="row-chips">' + LN.chips(view.linesOf(x.si)) + '</span></span>' +
          '<span class="row-meta num">' + PN.fmtDist(x.m) + '<small>' + PN.fmtTime(x.m / (r.speed * 1000 / 60)) + '</small></span></button></li>';
      }).join('') + '</ol>';
    } else {
      html += '<p class="msg">4시간 안에 지하로 닿는 역 없음</p>';
    }
    return html;
  }

  // ② 지하로 계속 이동
  function goHtml(view) {
    const PN = UG.panel, SV = UG.saved, places = view.saved || [];
    const fam = places.find(function (p) { return p.name === SV.FAMILY; });
    const home = places.find(function (p) { return p.name === SV.HOME; });
    let html = '<div class="qa-list">';
    html += fam ? qa('go-saved', fam.id, '가족 약속 장소까지 지하로', fam.title, 'family')
      : '<p class="qa-empty">' + svg(ICONS.family) + '<span><b>가족 약속 장소</b> 저장: 검색 결과 ☆ · 지도 길게 누르기</span></p>';
    if (home) html += qa('go-saved', home.id, '집까지 지하로', home.title, 'home');
    places.forEach(function (p) { if (p !== fam && p !== home) html += qa('go-saved', p.id, PN.esc(p.name) + '까지 지하로', p.title, 'pin'); });
    html += '</div><button type="button" class="btn-secondary btn-wide" data-act="go-search">' + svg('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>') + '목적지 검색</button>';
    return html;
  }
  const ICONS = {
    family: '<circle cx="8" cy="8" r="2.6"/><circle cx="16.5" cy="9" r="2.1"/><path d="M3.5 19c.5-3.5 2.3-5.5 4.5-5.5s4 2 4.5 5.5M13 19c.3-2.6 1.6-4 3.5-4s3.2 1.4 3.5 4"/>',
    home: '<path d="M4 11l8-6.5 8 6.5"/><path d="M6 9.8V19h12V9.8"/><path d="M10 19v-5h4v5"/>',
    pin: '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>'
  };
  function qa(act, id, label, sub, icon) {
    return '<button type="button" class="qa" data-act="' + act + '" data-id="' + esc(id) + '">' + svg(ICONS[icon] || ICONS.pin) +
      '<span class="qa-t"><b>' + label + '</b><small>' + esc(sub || '') + '</small></span>' +
      svg('<path d="M9 6l6 6-6 6"/>', 'ic ic-chev') + '</button>';
  }

  // 깊이 글: 지하(B1~B8)면 '지하 2층 · 승강장 11.8m · 선로 12.9m', 고가·지상이면 그 글자만(값이 음수일 수 있다)
  function depthText(d) {
    const under = /^B\d/.test(d.floor);
    if (!under) return esc(d.floor);
    return esc(d.floor) + (isFinite(d.platform_m) ? ' · ' + (+d.platform_m).toFixed(1) + 'm' : '');
  }

  // ③ 이 역 정보
  function infoHtml(view) {
    const f = view.f, PN = UG.panel, LN = UG.lines;
    const depthOf = function (names) {
      if (!f.depth) return null;
      return f.depth.find(function (d) { return names.indexOf(d.line) >= 0; }) || null;
    };
    let html = '<div class="st-go-row"><button type="button" class="btn-secondary" data-act="route-to">' + svg('<path d="M5 12h13M13 6l6 6-6 6"/>') + '여기로 가기</button>' +
      '<button type="button" class="btn-secondary" data-act="route-from">' + svg('<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>') + '여기서 출발</button></div>';
    html += '<h3 class="sub-h">승강장</h3><ul class="facts">' + f.hubs.map(function (h) {
      const d = depthOf(h.lines);
      return '<li><span class="row-chips">' + LN.chips(h.lines) + '</span>' +
        '<span class="fact-v"><span class="tag ' + (h.ug ? 'tag-ug">지하' : 'tag-gr">지상') + '</span>' +
        (d ? '<span class="num">' + depthText(d) + '</span>' : '') +
        '</span></li>';
    }).join('') + '</ul>';
    if (f.transfers.length) {
      html += '<h3 class="sub-h">환승</h3><ul class="facts">' + f.transfers.map(function (t) {
        return '<li><span class="row-chips">' + LN.chips(t.a) + '<span class="arrow" aria-label="와">↔</span>' + LN.chips(t.b) + '</span>' +
          '<span class="fact-v"><span class="num">' + PN.fmtDist(t.m) + '</span>' + (t.ug ? '' : ' · <span class="bad">지상 통로</span>') + '</span></li>';
      }).join('') + '</ul>';
    }
    // 출구 주변 이름(서울교통공사 역세권 현황, extra.json 이 있을 때만)
    const areas = f.exits.map(function (x) { return UG.transfer ? UG.transfer.exitAreas(f.si, x.ref) : []; });
    const hasAreas = areas.some(function (a) { return a.length; });
    if (f.exits.length) html += '<h3 class="sub-h">출구 <span class="muted">' + f.exits.length + '곳</span></h3><ul class="exit-grid' + (hasAreas ? ' has-areas' : '') + '">' + f.exits.map(function (x, i) {
      return '<li><button type="button" class="exit-chip" data-act="exit" data-exit="' + x.ent + '"><b>' + esc(x.ref ? x.ref + '번' : '번호 없음') + '</b><span class="num">' + PN.fmtDist(x.dist) + '</span>' +
        (areas[i].length ? '<small class="exit-area">' + esc(areas[i].slice(0, 2).join(', ')) + '</small>' : '') + '</button></li>';
    }).join('') + '</ul>';
    return html;
  }

  UG.station = { TABS: TABS, stationFacts: stationFacts, sheetHtml: sheetHtml, ICONS: ICONS, svg: svg };
})(typeof globalThis !== 'undefined' ? globalThis : this);
