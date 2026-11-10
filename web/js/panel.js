/* panel.js — 패널 화면 조각 (길 안내 결과, 분석 통계)
   - 길 안내: 요약(총 거리·걷는 시간·지상 노출) -> 걷는 속도 -> 단계 목록 -> 출처·가정.
   - 단계 목록은 app.js 가 만든 items 를 그린다:
       {kind:'enter'|'exit'|'arrive'|'walk', …} 와 {kind:'step', step: steps.js 의 ride/transfer/warning}
   - 각 단계 버튼에는 data-item(목록 위치)을 달아, 누르면 app.js 가 지도를 그 단계로 옮긴다. */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};
  const ST = UG.steps;

  const LABEL = { tunnel: '지하(터널)', bridge: '교량', ground: '지상' };
  const STRUCTS = ['tunnel', 'bridge', 'ground'];
  const CONF_LABEL = { good: '좋음', caveat: '주의', unchecked: '미검증' };
  const REGION_SHORT = {
    '서울특별시': '서울', '경기도': '경기', '인천광역시': '인천', '부산광역시': '부산', '대구광역시': '대구',
    '대전광역시': '대전', '세종특별자치시': '세종', '울산광역시': '울산', '강원특별자치도': '강원',
    '충청북도': '충북', '충청남도': '충남', '전북특별자치도': '전북', '전남광주통합특별시': '전남·광주',
    '경상북도': '경북', '경상남도': '경남'
  };
  const SEOUL_SRC = '서울교통공사 환승역 환승거리(2025-03-31), 서울 열린데이터광장, 공공누리 제1유형';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // 거리: 1km 미만은 m, 그 이상은 km 소수 1자리
  function fmtDist(m) { m = Math.round(m); return m < 1000 ? m + 'm' : ST.fmtKm(m); }
  function fmtTime(min) { return ST.fmtMinutes(Math.round(min)); }
  function shortRegion(name) { return REGION_SHORT[name] || name; }
  function yeok(name) { return name.endsWith('역') ? name : name + '역'; }   // '서울역'에 '역'을 또 붙이지 않는다
  function exitName(stName, ref) { return yeok(stName) + ' ' + (ref ? ref + '번 출구' : '출구'); }

  /* ---------- 길 안내 ---------- */
  // 처음 한 번 뼈대를 만든다(속도 선택 칸은 다시 그리지 않아 포커스가 유지된다).
  function mountRoute(el, speed) {
    el.innerHTML =
      '<div id="route-top"></div>' +
      '<div class="speed" id="speed-row" hidden><label for="speed">걷는 속도(시간 계산에 씀)</label>' +
      '<select id="speed">' + [3.0, 3.5, 4.0].map(function (v) {
        return '<option value="' + v + '"' + (v === speed ? ' selected' : '') + '>시속 ' + v.toFixed(1) + 'km</option>';
      }).join('') + '</select></div>' +
      '<ol class="steps" id="route-steps" aria-label="단계별 안내"></ol>' +
      '<div id="route-notes" class="tabpanel-notes"></div>';
    return {
      top: el.querySelector('#route-top'), speedRow: el.querySelector('#speed-row'), speed: el.querySelector('#speed'),
      steps: el.querySelector('#route-steps'), notes: el.querySelector('#route-notes')
    };
  }

  // 경로가 없을 때: 고르는 방법 안내 + 고른 끝점 설명 + (있으면) 오류
  function renderIdle(R, info) {
    R.speedRow.hidden = true;
    R.steps.innerHTML = '';
    let html = '';
    if (info.message) html += '<p class="msg' + (info.error ? ' is-error' : '') + '">' + esc(info.message) + '</p>';
    if (info.fromText || info.toText) {
      html += '<div class="hint">' +
        (info.fromText ? '<p class="ep-note"><span class="k">출발</span> ' + esc(info.fromText) + '</p>' : '') +
        (info.toText ? '<p class="ep-note"><span class="k">도착</span> ' + esc(info.toText) + '</p>' : '') + '</div>';
    }
    html += '<div class="hint"><p><b>출발</b>과 <b>도착</b>을 고르면 지상 노출이 가장 적은 길을 찾습니다.</p>' +
      '<p>역 이름을 입력하거나, 지도를 눌러 지점을 고르거나, 내 위치를 누르세요.</p>' +
      '<p>지하로만 갈 수 없으면 지상으로 나가야 하는 곳과 거리를 빨간색으로 알려 줍니다.</p></div>';
    R.top.innerHTML = html;
    R.notes.innerHTML = '<p class="note src">데이터: © OpenStreetMap 기여자 (ODbL). 열차가 멈추고 전기가 끊겨 선로를 걸을 수 있다고 가정합니다.</p>';
  }

  // view: { total_m, exposed_m, minutes, items, hasTransfer, seoulSource, usesPoint, speed }
  function renderRoute(R, view) {
    const exp = Math.round(view.exposed_m);
    R.top.innerHTML =
      '<dl class="sum">' +
      '<div><dt>총 거리</dt><dd class="num">' + fmtDist(view.total_m) + '</dd></div>' +
      '<div><dt>걷는 시간</dt><dd>' + fmtTime(view.minutes) + '</dd></div>' +
      '<div><dt>지상 노출</dt><dd class="num ' + (exp > 0 ? 'bad' : 'good') + '">' + fmtDist(exp) + '</dd></div>' +
      '</dl>';
    R.speedRow.hidden = false;
    R.steps.innerHTML = view.items.map(itemHtml).join('');
    let notes = '';
    if (view.usesPoint) notes += '<p class="note">지도에서 고른 지점과 출구 사이는 직선 거리 × 1.3으로 계산하고 모두 지상 노출로 셉니다.</p>';
    if (view.hasTransfer) {
      notes += '<p class="note">환승 통로는 양쪽 승강장이 모두 지하면 지하로 이어진다고 가정합니다. 환승 거리 출처: ' +
        (view.seoulSource ? SEOUL_SRC + '. 그 밖의 역은 ' : '') + '추정(직선 거리 × 1.3 + 50m).</p>';
    }
    notes += '<p class="note src">데이터: © OpenStreetMap 기여자 (ODbL). 열차가 멈추고 전기가 끊겨 선로를 걸을 수 있다고 가정합니다. 실시간 피해 정보는 없습니다.</p>';
    R.notes.innerHTML = notes;
  }

  function peekText(view) {
    const exp = Math.round(view.exposed_m);
    return fmtDist(view.total_m) + ' · ' + fmtTime(view.minutes) + ' · 지상 <span class="' + (exp > 0 ? 'bad' : '') + '">' + fmtDist(exp) + '</span>';
  }

  function stepBtn(i, no, noCls, title, dir, meta) {
    return '<button type="button" class="step-btn" data-item="' + i + '">' +
      '<span class="step-no ' + noCls + '" aria-hidden="true">' + no + '</span>' +
      '<span class="step-title">' + title + '</span>' +
      (dir ? '<span class="step-dir">' + dir + '</span>' : '') +
      (meta ? '<span class="step-meta">' + meta + '</span>' : '') + '</button>';
  }

  function exitsHtml(list, label) {
    if (!list || !list.length) return '';
    return '<details class="exits"><summary>' + esc(label) + ' (' + list.length + ')</summary><ul>' +
      list.map(function (x) {
        return '<li><button type="button" class="exit-btn" data-exit="' + x.ent + '"><span>' + esc(x.ref ? x.ref + '번 출구' : '번호 없는 출구') +
          (x.chosen ? ' <span class="cur">· 안내한 출구</span>' : '') + '</span><span class="num">' + fmtDist(x.dist) + '</span></button></li>';
      }).join('') + '</ul></details>';
  }

  function itemHtml(it, i) {
    const n = '<span class="sr-only">' + (i + 1) + '. </span>';
    if (it.kind === 'walk') {
      return '<li class="step">' + stepBtn(i, '걷', 's', n + '지상으로 바로 걷기',
        '지하로 돌아가는 길보다 지상 노출이 짧습니다.',
        '<span class="bad">지상 ' + fmtDist(it.m) + '</span> · 약 ' + fmtTime(it.min)) + '</li>';
    }
    if (it.kind === 'enter') {
      const title = it.conn.kind === 'entrance' ? exitName(it.stName, it.conn.ref) + '로 들어가기' : yeok(it.stName) + '으로 들어가기 (출구 자료 없음)';
      return '<li class="step">' + stepBtn(i, '출', 's', n + esc(title), it.label ? esc(it.label) + '에서' : '',
        '<span class="bad">지상 ' + fmtDist(it.m) + '</span> · 약 ' + fmtTime(it.min)) + '</li>';
    }
    if (it.kind === 'exit') {
      const title = it.conn.kind === 'entrance' ? exitName(it.stName, it.conn.ref) + '로 나가기' : yeok(it.stName) + '에서 나가기 (출구 자료 없음)';
      return '<li class="step">' + stepBtn(i, '도', 'e', n + esc(title), it.label ? esc(it.label) + '까지' : '',
        '<span class="bad">지상 ' + fmtDist(it.m) + '</span> · 약 ' + fmtTime(it.min)) +
        exitsHtml(it.others, '출구가 막혔으면: 다른 출구') + '</li>';
    }
    if (it.kind === 'arrive') {
      return '<li class="step">' + stepBtn(i, '도', 'e', n + esc(yeok(it.stName)) + ' 도착', '', it.others.length ? '출구 거리는 역 중심에서 잰 직선 거리입니다.' : '이 역은 출구 자료가 없습니다.') +
        exitsHtml(it.others, '출구') + '</li>';
    }
    const s = it.step;
    if (s.type === 'warning') {
      const where = s.at + (s.after_m ? ' 지나 ' + ST.fmtKm(s.after_m) : '');
      const kinds = Object.keys(s.structures).map(function (k) { return ST.STRUCT_KO[k] + ' ' + fmtDist(s.structures[k]); }).join(' · ');
      const until = s.ends_underground ? '다시 지하로 들어갈 때까지' : '도착할 때까지';
      return '<li class="step"><button type="button" class="warn" data-item="' + i + '">' + n + '※ <b>지상 노출 ' + fmtDist(s.exposure_m) + '</b> — ' +
        esc(where) + '에서 ' + (s.portal ? '터널을 나와 ' : '') + until + ' (' + esc(kinds) + ')</button></li>';
    }
    if (s.type === 'transfer') {
      const src = ST.SOURCE_KO[s.source] || '';
      return '<li class="step">' + stepBtn(i, s.no, 't', n + '환승 · ' + esc(s.station),
        esc(s.from_line + ' → ' + s.to_line),
        '<span class="num">' + s.distance_m + 'm</span> · 약 ' + fmtTime(s.est_minutes) + (src ? ' · ' + esc(src) : '') + ' · ' +
        (s.underground ? '지하 통로' : '<span class="bad">지상</span>')) + '</li>';
    }
    // ride
    if (!s._tracks_m) {
      return '<li class="step">' + stepBtn(i, s.no, '', n + esc(yeok(s.from_station)) + ' 안에서 이동', '',
        '<span class="num">' + fmtDist(s.distance_m) + '</span> · 약 ' + fmtTime(s.est_minutes) +
        (s.exposure_m ? ' · <span class="bad">지상 노출 ' + fmtDist(s.exposure_m) + '</span>' : '')) + '</li>';
    }
    let title = esc(s.label);
    if (s.line) {
      const rest = s.label === s.line ? '' : s.label.indexOf(s.line + ' · ') === 0 ? s.label.slice(s.line.length + 3) : s.label;
      title = '<span class="lb">' + esc(s.line) + '</span>' + esc(rest);
    }
    const nxt = s.direction.replace(' 방면', '');
    let head = s.direction;
    if (s.terminal_direction) head = s.terminal_direction + (s.terminal_direction === s.direction ? '' : ' (다음 역 ' + nxt + ')');
    const dir = head ? esc(s.from_station) + ' → ' + esc(head) : esc(s.from_station) + ' 이후 선로를 따라 다음 단계까지';
    const meta = (head ? esc(s.to_station) + '까지 ' : '') + '<span class="num">' + fmtDist(s.distance_m) + '</span> · 약 ' + fmtTime(s.est_minutes) +
      (s.exposure_m ? ' · <span class="bad">지상 노출 ' + fmtDist(s.exposure_m) + '</span>' : '');
    let pass = '';
    if (s.passing.length || head) {
      const all = s.passing.map(function (p) { return '<li>' + esc(p.station) + '<span class="num">' + ST.fixed1(p.at_m / 1000) + '</span></li>'; });
      all.push('<li class="end">' + esc(s.to_station) + '<span class="num">' + ST.fixed1(s.distance_m / 1000) + '</span></li>');
      pass = '<ol class="pass" aria-label="지나는 역(단계 출발부터 km)">' + all.join('') + '</ol>';
    }
    let parts = '';
    if (s.track_parts.length > 1) {
      parts = '<p class="parts">선 구간: ' + s.track_parts.map(function (p) {
        const span = p.from_station !== p.to_station ? ' ' + p.from_station + '→' + p.to_station : '';
        return esc(p.name + span + ' ' + ST.fmtKm(p.distance_m));
      }).join(' · ') + '</p>';
    }
    return '<li class="step">' + stepBtn(i, s.no, '', n + title, dir, meta) +
      '<div class="step-more">' + pass + parts + '</div></li>';
  }

  /* ---------- 분석: 통계 (본선 선로 km, 구조별·지역별) ---------- */
  function computeStats(g) {
    const E = g.edges, T = g.tables;
    const track = T.kinds.indexOf('track'), main = T.services.indexOf('');
    const structKey = T.structs.map(function (n) { return STRUCTS.indexOf(n) >= 0 ? n : null; });
    const nation = { km: { tunnel: 0, bridge: 0, ground: 0 }, total: 0, service: 0 };
    const regions = T.regions.map(function (r, i) { return { index: i, name: r.name, conf: r.conf, km: { tunnel: 0, bridge: 0, ground: 0 }, total: 0 }; });
    for (let e = 0; e < E.a.length; e++) {
      if (E.k[e] !== track) continue;
      const key = structKey[E.s[e]];
      if (!key) continue;
      const km = E.len[e] / 1000;
      if (E.svc[e] !== main) { nation.service += km; continue; }
      nation.km[key] += km;
      nation.total += km;
      const r = regions[E.rg[e]];
      if (r) { r.km[key] += km; r.total += km; }
    }
    const stations = { total: 0, all: 0, part: 0 };
    g.stations.forEach(function (s) {
      stations.total++;
      const ug = (s.ug || []).filter(function (x) { return x === 1; }).length;
      if (s.hubs.length && ug === s.hubs.length) stations.all++; else if (ug > 0) stations.part++;
    });
    return {
      nation: nation,
      regions: regions.filter(function (r) { return r.total > 0; }).sort(function (a, b) { return b.total - a.total; }),
      stations: stations
    };
  }

  function fmtKmInt(v) { return Math.round(v).toLocaleString('ko-KR'); }
  function pct(v, total) { return total > 0 ? v / total * 100 : 0; }
  function fmtPct(v, total) { return pct(v, total).toFixed(1); }

  function renderStats(ui, stats, g, onRegion) {
    const n = stats.nation;
    ui.peekTotal.textContent = fmtKmInt(n.total);
    ui.peekTunnel.textContent = fmtPct(n.km.tunnel, n.total);
    ui.peekBar.innerHTML = STRUCTS.map(function (k) { return '<span class="seg-' + k + '" style="width:' + pct(n.km[k], n.total).toFixed(2) + '%"></span>'; }).join('');
    ui.peekBar.setAttribute('aria-label', '전국 본선 구조 비율: ' + STRUCTS.map(function (k) { return LABEL[k] + ' ' + fmtPct(n.km[k], n.total) + '%'; }).join(', '));
    ui.nationRows.innerHTML = STRUCTS.map(function (k) {
      return '<tr><td><span class="key"><span class="sw sw-' + k + '"></span>' + LABEL[k] + '</span></td>' +
        '<td class="r num">' + fmtKmInt(n.km[k]) + '</td><td class="r num">' + fmtPct(n.km[k], n.total) + '%</td></tr>';
    }).join('');
    ui.nationFoot.innerHTML =
      '<tr><td>본선 합계</td><td class="r num">' + fmtKmInt(n.total) + '</td><td class="r num">100%</td></tr>' +
      '<tr><td>측선(따로 셈)</td><td class="r num">' + fmtKmInt(n.service) + '</td><td></td></tr>';
    const s = stats.stations;
    ui.stationCount.textContent = '역 ' + s.total.toLocaleString('ko-KR') + '곳 중 지하역 ' + s.all.toLocaleString('ko-KR') +
      '곳, 일부 노선만 지하인 역 ' + s.part.toLocaleString('ko-KR') + '곳.';
    ui.regionRows.innerHTML = stats.regions.map(function (r) {
      const share = pct(r.km.tunnel, r.total);
      const c = CONF_LABEL[r.conf] ? r.conf : 'unchecked';
      return '<tr>' +
        '<td><button type="button" class="rg-btn" id="rg-' + r.index + '" data-region="' + r.index + '" title="' + esc(r.name) + '">' + esc(shortRegion(r.name)) + '</button></td>' +
        '<td class="r num">' + fmtKmInt(r.total) + '</td>' +
        '<td class="r"><span class="share"><span class="num">' + share.toFixed(1) + '%</span><span class="mini" aria-hidden="true"><span style="width:' + share.toFixed(1) + '%"></span></span></span></td>' +
        '<td><span class="pill pill-' + c + '">' + CONF_LABEL[c] + '</span></td></tr>';
    }).join('');
    ui.regionRows.onclick = function (ev) { const b = ev.target.closest('.rg-btn'); if (b) onRegion(+b.dataset.region); };
    const extra = (g.attribution || []).filter(function (a) { return a.indexOf('OpenStreetMap') < 0; });
    ui.srcNote.textContent = '데이터: © OpenStreetMap 기여자 (ODbL)' + (g.osm_base ? ' · OSM 기준 ' + g.osm_base : '') +
      (extra.length ? ' · ' + extra.join(' · ') : '');
  }

  /* ---------- 팝업 ---------- */
  function pickRow(attrs) {
    return '<div class="pick-row"><button type="button" class="pick-btn" data-pick="from" ' + attrs + '>여기서 출발</button>' +
      '<button type="button" class="pick-btn" data-pick="to" ' + attrs + '>여기로 도착</button></div>';
  }

  function stationPopupHtml(st, T) {
    const status = st.status === 'all' ? '지하역' : st.status === 'part' ? '일부 노선만 지하' : '지상역';
    const dot = st.status === 'none' ? 'dot-gr' : 'dot-ug';
    const lines = st.hubs.map(function (h) {
      const names = h.lines.length ? h.lines.map(esc).join(', ') : '노선 이름 없음';
      return '<li><span class="tag ' + (h.ug ? 'tag-ug">지하' : 'tag-gr">지상') + '</span><span>' + names + '</span></li>';
    }).join('');
    const reg = T.regions[st.region];
    const meta = reg ? esc(reg.name) + ' · 데이터 신뢰도 ' + (CONF_LABEL[reg.conf] || CONF_LABEL.unchecked) : '';
    return '<div class="pop"><p class="pop-name">' + esc(st.name) + '</p>' +
      '<p class="pop-status"><span class="dot ' + dot + '"></span>' + status + '</p>' +
      '<ul class="pop-lines">' + lines + '</ul>' +
      (meta ? '<p class="pop-meta">' + meta + '</p>' : '') + pickRow('data-station="' + st.index + '"') + '</div>';
  }

  function exitPopupHtml(stName, ref, ent) {
    return '<div class="pop"><p class="pop-name">' + esc(exitName(stName, ref)) + '</p>' +
      '<p class="pop-meta">이 출구를 출발점이나 도착점으로 고를 수 있습니다.</p>' + pickRow('data-exit="' + ent + '"') + '</div>';
  }

  function pointPopupHtml(lat, lon, nearText) {
    return '<div class="pop"><p class="pop-name">고른 지점</p>' +
      '<p class="pop-meta">' + esc(nearText) + '</p>' +
      pickRow('data-lat="' + lat.toFixed(6) + '" data-lon="' + lon.toFixed(6) + '"') + '</div>';
  }

  UG.panel = {
    esc: esc, yeok: yeok, fmtDist: fmtDist, fmtTime: fmtTime, exitName: exitName, shortRegion: shortRegion,
    mountRoute: mountRoute, renderIdle: renderIdle, renderRoute: renderRoute, peekText: peekText,
    computeStats: computeStats, renderStats: renderStats,
    stationPopupHtml: stationPopupHtml, exitPopupHtml: exitPopupHtml, pointPopupHtml: pointPopupHtml
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
