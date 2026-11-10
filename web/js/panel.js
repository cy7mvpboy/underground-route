/* panel.js — 시트 안의 화면 조각 (경로 결과 카드, 단계 목록, 갈림길 그림, 여기서 나가기 목록, 지도 팝업)
   - 글은 걷는 사람이 할 일만: 어디로·어느 쪽·얼마나·몇 분. 출처·가정·통계는 '정보' 탭(index.html) 한 곳에만 둔다.
   - 경로 결과: 지상 노출 배지(크게) -> 거리·시간 -> 작은 칩(환승·갈림길 수, 데이터 확인 부족 지역) -> 지나는 노선 칩 -> 안내 시작 -> 단계 목록.
   - 단계 목록은 steps.js 의 planItems 가 만든 items 를 그린다:
       {kind:'enter'|'exit'|'arrive'|'walk', …} 와 {kind:'step', step: ride/transfer/warning/surface}
   - 각 단계 버튼에는 data-item(목록 위치)을 달아, 누르면 app.js 가 지도를 그 단계로 옮긴다.
   - 환승은 카드로 그린다(노선 칩 + 한 줄 '방화 방면 · 앞쪽 계단 · 275m · 4분' + 깊이 칩). 내용은 transfer.js 가 만든 item.xfer. */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};
  const ST = UG.steps;

  const REGION_SHORT = {
    '서울특별시': '서울', '경기도': '경기', '인천광역시': '인천', '부산광역시': '부산', '대구광역시': '대구',
    '대전광역시': '대전', '세종특별자치시': '세종', '울산광역시': '울산', '강원특별자치도': '강원',
    '충청북도': '충북', '충청남도': '충남', '전북특별자치도': '전북', '전남광주통합특별시': '전남·광주',
    '경상북도': '경북', '경상남도': '경남'
  };
  const EXPO_AMBER_M = 500;   // 지상 노출 배지: 0m 청록, 500m 미만 호박색, 그 이상 주황빨강

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
  // 조사 '로/으로': 받침이 없거나 ㄹ 받침이면 '로' (예: 출구로, 서울역으로, 오금 방면으로)
  function ro(word) {
    const c = String(word).charCodeAt(String(word).length - 1);
    if (c < 0xac00 || c > 0xd7a3) return word + '(으)로';
    const jong = (c - 0xac00) % 28;
    return word + (jong === 0 || jong === 8 ? '로' : '으로');
  }
  function chip(n) { return UG.lines ? UG.lines.chip(n) : '<span class="lc lc-none">' + esc(n) + '</span>'; }

  // 큰 숫자 + 작은 단위: '12.3km' -> <b>12.3</b><small>km</small>, '3시간 5분' -> <b>3</b><small>시간</small> <b>5</b><small>분</small>
  function bigDist(m) {
    const t = fmtDist(m), u = t.endsWith('km') ? 'km' : 'm';
    return '<b>' + t.slice(0, -u.length) + '</b><small>' + u + '</small>';
  }
  function bigTime(min) {
    return fmtTime(min).replace(/(\d+)(시간|분)/g, '<b>$1</b><small>$2</small>').replace('1분 미만', '<b>1</b><small>분 미만</small>');
  }
  function expoClass(m) { const e = Math.round(m); return e === 0 ? 'ok' : e < EXPO_AMBER_M ? 'mid' : 'bad'; }
  function expoBadge(m, big) {
    return '<p class="xbadge xb-' + expoClass(m) + (big ? ' xb-big' : '') + '"><span class="xb-k">지상 노출</span><span class="xb-v num">' + bigDist(m) + '</span></p>';
  }

  // '가장 가까운 지하로' 후보 목록. nb = { label, isCenter, options: [{name, ref, kind, len}], chosen }
  function nearestHtml(nb, mpm) {
    return '<section class="near" aria-labelledby="near-title">' +
      '<h3 class="sub-h" id="near-title">가까운 지하역 <span class="muted">' + (nb.isCenter ? '지도 중심' : esc(nb.label)) + '</span></h3>' +
      '<ol class="near-list">' + nb.options.map(function (o, i) {
        return '<li><button type="button" class="row-btn near-btn" data-near="' + i + '" aria-pressed="' + (i === nb.chosen) + '">' +
          '<span class="row-main"><span class="row-title">' + esc(o.kind === 'entrance' ? exitName(o.name, o.ref) : yeok(o.name)) + '</span>' +
          '<span class="row-sub"><span class="t-expo">지상 ' + fmtDist(o.len) + '</span> · ' + fmtTime(o.len / mpm) + '</span></span>' +
          (i === nb.chosen ? '<span class="row-meta">안내 중</span>' : '') + '</button></li>';
      }).join('') + '</ol></section>';
  }

  function blockedHtml(n) {
    return n ? '<p class="msg blocked">막은 구간 ' + n + '곳 제외 <button type="button" class="link-btn" data-action="unblock">모두 풀기</button></p>' : '';
  }

  /* ---------- 경로 결과 ---------- */
  // 처음 한 번 뼈대를 만든다(속도 선택 칸은 다시 그리지 않아 포커스가 유지된다).
  function mountRoute(el, speed) {
    el.innerHTML =
      '<div id="route-top"></div>' +
      '<div class="speed" id="speed-row" hidden><label for="speed">걷는 속도</label>' +
      '<select id="speed">' + [3.0, 3.5, 4.0].map(function (v) {
        return '<option value="' + v + '"' + (v === speed ? ' selected' : '') + '>시속 ' + v.toFixed(1) + 'km</option>';
      }).join('') + '</select></div>' +
      '<ol class="steps" id="route-steps" aria-label="단계별 안내"></ol>';
    return {
      top: el.querySelector('#route-top'), speedRow: el.querySelector('#speed-row'), speed: el.querySelector('#speed'),
      steps: el.querySelector('#route-steps')
    };
  }

  // 지나는 노선(순서대로)
  function routeLines(items) {
    const out = [];
    items.forEach(function (it) {
      if (it.kind !== 'step') return;
      const s = it.step;
      const n = s.type === 'ride' && s._tracks_m > 0 ? s.line : s.type === 'surface' ? '지상 걷기' : null;
      if (n && out[out.length - 1] !== n) out.push(n);
    });
    return out;
  }

  // view: { total_m, exposed_m, minutes, items, hasTransfer, seoulSource, usesPoint, speed, nearest?, blocked, fromText, toText, street, endSi }
  function renderRoute(R, view) {
    const lines = routeLines(view.items);
    let headLine;
    if (view.nearest) {
      const o = view.nearest.options[view.nearest.chosen];
      headLine = '<p class="rc-kicker">가장 가까운 지하</p><p class="rc-od"><b>' + esc(o.kind === 'entrance' ? exitName(o.name, o.ref) : yeok(o.name)) + '</b></p>';
    } else {
      headLine = '<p class="rc-od"><span>' + esc(view.fromText || '출발') + '</span><span class="rc-arrow" aria-label="에서">→</span><b>' + esc(view.toText || '도착') + '</b></p>';
    }
    // 요약: 노출 배지 · 거리 · 시간(큰 숫자), 환승·갈림길 수와 '데이터 확인 부족 지역'은 작은 칩. 문장은 쓰지 않는다.
    const counts = [];
    if (view.transfers) counts.push('환승 ' + view.transfers);
    if (view.junctions && view.junctions.length) counts.push('갈림길 ' + view.junctions.length);
    R.top.innerHTML =
      '<div class="sv-head rc-head">' + headLine +
      '<div class="rc-main">' + expoBadge(view.exposed_m, true) +
      '<p class="rc-nums"><span class="num"><span class="sr-only">거리 </span>' + bigDist(view.total_m) + '</span>' +
      '<span class="num"><span class="sr-only">걷는 시간 </span>' + bigTime(view.minutes) + '</span></p></div>' +
      (counts.length || view.lowConf ? '<p class="rc-chips">' + counts.map(function (c) { return '<span class="cnt">' + c + '</span>'; }).join('') +
        (view.lowConf ? '<span class="cnt cnt-warn">데이터 확인 부족 지역</span>' : '') + '</p>' : '') +
      (lines.length ? '<p class="rc-lines" aria-label="지나는 노선">' + lines.map(function (n, i) {
        return (i ? '<span class="rc-sep" aria-hidden="true">›</span>' : '') + (n === '지상 걷기' ? '<span class="lc lc-walk">지상 걷기</span>' : chip(n));
      }).join('') + '</p>' : '') +
      '<button type="button" class="btn-primary" data-action="guide">' +
      '<svg class="ic" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 3.5l15 8.5-15 8.5 3.5-8.5z"/></svg>안내 시작</button></div>' +
      (view.nearest ? nearestHtml(view.nearest, view.speed * 1000 / 60) : '') +
      blockedHtml(view.blocked) +
      (view.endSi >= 0 ? '<button type="button" class="btn-secondary btn-wide" data-action="station" data-si="' + view.endSi + '">' +
        '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><circle cx="12" cy="12" r="3.2"/></svg>' +
        esc(yeok(view.endStation)) + '에서 지하로 갈 수 있는 곳</button>' : '');
    R.speedRow.hidden = false;
    R.steps.innerHTML = view.items.map(function (it, i) { return itemHtml(it, i, view); }).join('');
    // 출처·가정 글은 '정보' 탭 한 곳에만 둔다
  }

  function stepBtn(i, no, noCls, title, dir, meta) {
    return '<button type="button" class="step-btn" data-item="' + i + '">' +
      '<span class="step-no ' + noCls + '" aria-hidden="true">' + no + '</span>' +
      '<span class="step-title">' + title + '</span>' +
      (dir ? '<span class="step-dir">' + dir + '</span>' : '') +
      (meta ? '<span class="step-meta">' + meta + '</span>' : '') + '</button>';
  }

  // si: 출구가 속한 역(출구 주변 이름을 찾을 때)
  function exitsHtml(list, label, si) {
    if (!list || !list.length) return '';
    return '<details class="exits"><summary>' + esc(label) + ' ' + list.length + '곳</summary><ul>' +
      list.map(function (x) {
        const area = areasText(si, x.ref, 2);
        return '<li><button type="button" class="exit-btn" data-exit="' + x.ent + '"><span>' + esc(x.ref ? x.ref + '번 출구' : '출구') +
          (x.chosen ? ' <span class="cur">· 안내</span>' : '') + (area ? '<small class="exit-area">' + esc(area) + '</small>' : '') +
          '</span><span class="num">' + fmtDist(x.dist) + '</span></button></li>';
      }).join('') + '</ul></details>';
  }

  const WALK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4.5" r="1.8" fill="currentColor" stroke="none"/><path d="M10 21l2.5-6 2.5 2.5V21M12.5 15L11 9.5l-3 2v3M11 9.5l3.5 1.5 2 2.5"/></svg>';
  function expo(m) { return '<span class="t-expo">지상 ' + fmtDist(m) + '</span>'; }

  /* ---------- 환승 카드 (x = transfer.js 의 info 결과) ----------
     단계 목록: 제목 한 줄(공덕역 환승 + 노선 칩)과 할 일 한 줄('방화 방면 · 앞쪽 계단 · 275m · 4분').
     깊이는 갈아탈 승강장의 층을 아는 경우만 작은 칩('B3'). 길 안내 카드도 같은 한 줄(xferLine)을 쓴다.
     지하 통로가 기본이라 따로 쓰지 않고, 지상 통로만 '지상 통로' 표시(노출). */
  const XFER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h14M15 4.5L18.5 8 15 11.5M20 16H6M9 12.5L5.5 16 9 19.5"/></svg>';
  function xferBadge(x) { return x.underground ? '' : '<span class="tag tag-gr">지상 통로</span>'; }
  function xferChips(x) {
    return '<span class="x-chips">' + chip(x.from.line) + '<span class="x-arrow" aria-label="에서">→</span>' + chip(x.to.line) + '</span>';
  }
  // '방화 방면 · 앞쪽 계단 · 275m · 4분' (noDist = 거리·시간 빼고)
  function xferLine(x, noDist) {
    const parts = [x.dir ? x.dir.head : x.to.line + ' 승강장'];
    if (x.fast && x.fast.side) parts.push(x.fast.side + ' 계단');
    if (!noDist) parts.push(fmtDist(x.distance_m), fmtTime(x.minutes));
    return parts.join(' · ');
  }
  function depthChip(x) { return /^B\d/.test(x.to.floor || '') ? '<span class="cnt">' + esc(x.to.floor) + '</span>' : ''; }
  // 출구 주변 이름(역세권 현황, extra.json 이 있을 때만): '동자동, 서울역 방면'
  function areasText(si, ref, max) {
    const a = UG.transfer ? UG.transfer.exitAreas(si, ref) : [];
    return a.length ? a.slice(0, max || 2).join(', ') + ' 방면' : '';
  }
  function xferItemHtml(x, i, n) {
    return '<li class="step step-x' + (x.underground ? '' : ' is-expo') + '">' +
      '<button type="button" class="step-btn" data-item="' + i + '">' +
      '<span class="step-no x" aria-hidden="true">' + XFER_ICON + '</span>' +
      '<span class="step-title">' + n + esc(yeok(x.station)) + ' 환승 ' + xferChips(x) + xferBadge(x) + '</span>' +
      '<span class="step-dir"><span class="num">' + esc(xferLine(x)) + '</span>' + depthChip(x) + '</span></button></li>';
  }

  /* ---------- 갈림길 (junctions.js) ----------
     Y자 그림: 걷는 방향이 위. 고른 갈래는 경로 색 + 화살촉, 다른 갈래는 흐리게.
     big = 길 안내 카드용 큰 그림, 아니면 단계 목록의 작은 그림. 갈 쪽 글은 제목·줄 글에 있다. */
  function forkSvg(j, big) {
    const gl = UG.junctions.junctionGlyph(j), C = gl.center[0];
    const all = gl.branches.slice().sort(function (a, b) { return (a.role === 'chosen') - (b.role === 'chosen'); });   // 고른 갈래를 맨 위에
    let s = '<line class="fk-in" x1="' + C + '" y1="' + gl.incoming.y + '" x2="' + C + '" y2="' + C + '"/>';
    all.forEach(function (b) {
      const r = b.draw * Math.PI / 180, ux = Math.sin(r), uy = -Math.cos(r);
      const go = b.role === 'chosen';
      const ex = go ? b.x - ux * 7 : b.x, ey = go ? b.y - uy * 7 : b.y;   // 화살촉 자리만큼 줄인다
      s += '<line class="' + (go ? 'fk-go' : 'fk-alt') + '" x1="' + C + '" y1="' + C + '" x2="' + ex.toFixed(1) + '" y2="' + ey.toFixed(1) + '"/>';
      if (go) {
        const px = -uy, py = ux, tx = b.x + ux * 6, ty = b.y + uy * 6;
        s += '<polygon class="fk-head" points="' + [[tx, ty], [b.x - ux * 9 + px * 10, b.y - uy * 9 + py * 10], [b.x - ux * 9 - px * 10, b.y - uy * 9 - py * 10]]
          .map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ') + '"/>';
      }
    });
    s += '<circle class="fk-c" cx="' + C + '" cy="' + C + '" r="' + (big ? 6 : 9) + '"/>';
    return '<svg class="fork' + (big ? ' fork-big' : '') + '" viewBox="' + (big ? '4 0 92 100' : '0 0 100 100') + '" aria-hidden="true">' + s + '</svg>';
  }
  // 대략 거리: 1km 넘으면 km 소수 1자리, 아니면 10m 단위
  function approxM(m) { return m >= 1000 ? (m / 1000).toFixed(1) + 'km' : Math.max(10, Math.round(m / 10) * 10) + 'm'; }
  // 갈림길 짧은 글: '강동 지나 260m 갈림길 → 오른쪽 갈래 (둔촌동 방면)'
  function junctionShort(j) {
    const where = j.prev ? j.prev.name + (j.fromPrev_m < 30 ? ' 바로 뒤 ' : ' 지나 ' + approxM(j.fromPrev_m) + ' ') : '';
    return where + '갈림길 → ' + j.chosen.side + (j.chosen.toward ? ' (' + j.chosen.toward + ' 방면)' : '');
  }
  // 단계 목록 안의 갈림길 줄: 작은 Y자 + 짧은 글. 누르면 지도에서 그 갈림길로(data-jn)
  function junctionRows(list) {
    if (!list.length) return '';
    return '<ul class="jn-rows" aria-label="갈림길">' + list.map(function (x) {
      return '<li><button type="button" class="jn-row" data-jn="' + x.n + '">' + forkSvg(x.j, false) +
        '<span>' + esc(junctionShort(x.j)) + '</span></button></li>';
    }).join('') + '</ul>';
  }

  /* ---------- 여기서 나가기 (exithere.js 후보 목록) ---------- */
  const EH_ICON = {
    exit: '<path d="M13 4H6v16h7"/><path d="M11 12h9M17 8.5l3.5 3.5-3.5 3.5"/>',
    portal: '<path d="M4 20v-8a8 8 0 0 1 16 0v8"/><path d="M9.5 20l1-6M14.5 20l-1-6M2 20h20"/>',
    shaft: '<path d="M5 21V9h14v12"/><path d="M12 17V3M8 7l4-4 4 4"/>',
    depot: '<path d="M3 20V9l9-5 9 5v11"/><path d="M7 20v-6h10v6M7 17h10"/>'
  };
  EH_ICON.emergency_exit = EH_ICON.shaft;
  function ehSvg(k) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (EH_ICON[k] || EH_ICON.exit) + '</svg>';
  }
  function ehIcon(k) { return '<span class="eh-ic eh-' + k + '">' + ehSvg(k) + '</span>'; }
  // 여기서 나가기 목록: 번호 · 종류 그림 · 이름 · 거리/시간만. res = findExits 결과, o = { basis(어디 기준인지), mpm(분당 m) }
  function exitHereHtml(res, o) {
    const list = res.list;
    let html = '<div class="eh-head"><h3 class="eh-title" id="eh-title" tabindex="-1">여기서 나가기</h3>' +
      '<p class="eh-basis">' + esc(o.basis) + '</p></div>';
    if (!list.length) return html + '<p class="msg">5km 안에 나갈 곳 없음</p>';
    return html + '<ol class="eh-list" aria-labelledby="eh-title">' + list.map(function (c, i) {
      const m = c.under_m + c.extra_m;
      return '<li><button type="button" class="row-btn eh-btn" data-eh="' + i + '">' +
        '<span class="eh-no num" aria-hidden="true">' + (i + 1) + '</span>' + ehIcon(c.k) +
        '<span class="row-main"><span class="row-title">' + esc(c.title) + '</span><span class="sr-only">' + esc(c.kindLabel) + '</span></span>' +
        '<span class="row-meta num">' + fmtDist(m) + '<small>' + fmtTime(m / o.mpm) + '</small></span></button></li>';
    }).join('') + '</ol>';
  }

  // 단계 줄의 '거리 · 시간'
  function distTime(m, min, exposed) { return (exposed ? expo(m) : '<span class="num">' + fmtDist(m) + '</span>') + ' · ' + fmtTime(min); }

  function itemHtml(it, i, view) {
    const n = '<span class="sr-only">' + (i + 1) + '. </span>';
    if (it.kind === 'approach') {   // 선로 위 지금 위치 -> 첫 노드(여기서 나가기)
      const t = it.toward ? (/역$|출구|수직구|출입구/.test(it.toward) ? it.toward : it.toward + '역') : '';
      return '<li class="step">' + stepBtn(i, ehSvg('portal'), '', n + esc(t ? ro(t) + ' 선로 따라 걷기' : '선로 따라 걷기'), distTime(it.m, it.min), '') + '</li>';
    }
    if (it.kind === 'egress') {     // 나갈 곳(종류는 그림으로)
      const c = it.cand;
      return '<li class="step">' + stepBtn(i, ehSvg(c.k), 'e', n + '<span class="sr-only">' + esc(c.kindLabel) + ' </span>' + esc(ro(c.title)) + ' 나가기',
        it.m > 0 ? distTime(it.m, it.min, it.surface) : '', '') + '</li>';
    }
    if (it.kind === 'walk') return '<li class="step">' + stepBtn(i, WALK_ICON, 's', n + '지상으로 바로 걷기', distTime(it.m, it.min, true), '') + '</li>';
    if (it.kind === 'enter') {
      const title = ro(it.conn.kind === 'entrance' ? exitName(it.stName, it.conn.ref) : yeok(it.stName)) + ' 들어가기';
      return '<li class="step">' + stepBtn(i, WALK_ICON, 's', n + esc(title), distTime(it.m, it.min, true), '') + '</li>';
    }
    if (it.kind === 'exit') {
      const title = it.conn.kind === 'entrance' ? ro(exitName(it.stName, it.conn.ref)) + ' 나가기' : yeok(it.stName) + '에서 나가기';
      const area = it.conn.kind === 'entrance' ? areasText(it.conn.si, it.conn.ref) : '';   // '5번 출구로 나가기 · 동자동, 서울역 방면'
      return '<li class="step">' + stepBtn(i, WALK_ICON, 's', n + esc(title) + (area ? '<span class="step-area">· ' + esc(area) + '</span>' : ''),
        distTime(it.m, it.min, true), '') + exitsHtml(it.others, '다른 출구', it.conn.si) + '</li>';
    }
    if (it.kind === 'arrive') {
      return '<li class="step">' + stepBtn(i, '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 21V4h10l-2 3.5 2 3.5H8v10z"/></svg>', 'e', n + esc(yeok(it.stName)) + ' 도착', '', '') +
        exitsHtml(it.others, '출구', it.si) + '</li>';
    }
    const s = it.step;
    if (s.type === 'warning') {     // '지상 1.1km · 신도림 지나 0.3km부터'
      const where = s.at + (s.after_m ? ' 지나 ' + ST.fmtKm(s.after_m) : '');
      return '<li class="step"><button type="button" class="warn" data-item="' + i + '">' + n +
        '<span class="warn-ic" aria-hidden="true">!</span><span><b>지상 ' + fmtDist(s.exposure_m) + '</b> · ' + esc(where) + '부터</span></button></li>';
    }
    if (s.type === 'surface') {
      return '<li class="step">' + stepBtn(i, s.no, 's', n + '지상으로 ' + esc(exitName(s.to_station, s.to_ref)) + '까지', distTime(s.distance_m, s.est_minutes, true), '') + '</li>';
    }
    if (s.type === 'transfer' && it.xfer) return xferItemHtml(it.xfer, i, n);
    if (s.type === 'transfer') {
      return '<li class="step">' + stepBtn(i, s.no, 't', n + esc(yeok(s.station)) + ' 환승 <span class="step-chips">' + chip(s.from_line) + '<span aria-hidden="true">→</span>' + chip(s.to_line) + '</span>' +
        (s.underground ? '' : '<span class="tag tag-gr">지상 통로</span>'), distTime(s.distance_m, s.est_minutes), '') + '</li>';
    }
    // ride
    if (!s._tracks_m) return '<li class="step">' + stepBtn(i, s.no, '', n + esc(yeok(s.from_station)) + ' 안에서 이동', distTime(s.distance_m, s.est_minutes), '') + '</li>';
    let title = esc(s.label);
    if (s.line) {
      const rest = s.label === s.line ? '' : s.label.indexOf(s.line + ' · ') === 0 ? s.label.slice(s.line.length + 3) : s.label;
      title = chip(s.line) + (rest ? '<span class="step-track">' + esc(rest) + '</span>' : '');
    }
    // '방화 방면 · 공덕까지 3.3km · 56분' (방면 역 = 도착 역이면 '까지'를 쓰지 않는다)
    const head = s.terminal_direction || s.direction;
    const toPart = s.to_station && s.to_station + ' 방면' !== head ? esc(s.to_station) + '까지 ' : '';
    const line = (head ? esc(head) + ' · ' : '') + toPart + distTime(s.distance_m, s.est_minutes) + (s.exposure_m ? ' · ' + expo(s.exposure_m) : '');
    // 지나는 역은 접어 둔다('역 3곳 지나감'을 누르면 펼침)
    const pass = s.passing.length ? '<details class="pass-d"><summary>역 ' + s.passing.length + '곳 지나감</summary><ol class="pass">' +
      s.passing.map(function (p) { return '<li>' + esc(p.station) + '<span class="num">' + ST.fixed1(p.at_m / 1000) + '</span></li>'; }).join('') + '</ol></details>' : '';
    // 이 단계 안의 갈림길(역 사이에서 선로가 갈라지는 곳)
    const jns = [];
    ((view && view.junctions) || []).forEach(function (j, k) { if (s._idx.indexOf(j.pos) >= 0) jns.push({ n: k, j: j }); });
    return '<li class="step">' + stepBtn(i, s.no, '', n + title, line, '') +
      '<div class="step-more">' + pass + junctionRows(jns) + '</div></li>';
  }

  // 경로를 찾지 못했을 때 등: 알림 한 줄 + 고르는 방법
  function messageHtml(message, error) {
    return '<div class="sv-head"><p class="msg' + (error ? ' is-error' : '') + '">' + esc(message) + '</p></div>';
  }

  /* ---------- 지도 팝업 (출구, 고른 지점) ---------- */
  function pickRow(attrs, save) {
    return '<div class="pick-row"><button type="button" class="pick-btn" data-pick="from" ' + attrs + '>여기서 출발</button>' +
      '<button type="button" class="pick-btn pick-to" data-pick="to" ' + attrs + '>여기로 가기</button></div>' +
      (save ? '<button type="button" class="pick-btn pick-save" data-pick="save" ' + attrs + '>☆ 이 장소 저장</button>' : '');
  }

  function exitPopupHtml(stName, ref, ent) {
    return '<div class="pop"><p class="pop-name">' + esc(exitName(stName, ref)) + '</p>' +
      '<p class="pop-meta">이 출구를 출발점이나 도착점으로 고를 수 있습니다.</p>' + pickRow('data-exit="' + ent + '"', false) + '</div>';
  }

  // 출구 후보 표시(egress.json) 팝업: 이름, 종류 · 짧은 설명
  function egressPopupHtml(it) {
    const X = UG.exithere, kind = X ? X.KIND_KO[it.k] || it.k : it.k;
    const note = X ? X.noteOf(it) : '';
    return '<div class="pop"><p class="pop-name">' + esc(it.name) + '</p><p class="pop-meta">' + esc(kind) + (note ? ' · ' + esc(note) : '') +
      (it.k === 'shaft' || it.k === 'emergency_exit' ? ' · 지상 계단이 있는지는 확인하지 못했습니다' : '') + '</p></div>';
  }

  function pointPopupHtml(lat, lon, nearText) {
    return '<div class="pop"><p class="pop-name">고른 지점</p>' +
      '<p class="pop-meta">' + esc(nearText) + '</p>' +
      pickRow('data-lat="' + lat.toFixed(6) + '" data-lon="' + lon.toFixed(6) + '"', true) + '</div>';
  }

  UG.panel = {
    esc: esc, yeok: yeok, ro: ro, fmtDist: fmtDist, fmtTime: fmtTime, exitName: exitName, shortRegion: shortRegion,
    bigDist: bigDist, bigTime: bigTime, expoClass: expoClass, expoBadge: expoBadge,
    mountRoute: mountRoute, renderRoute: renderRoute, messageHtml: messageHtml, routeLines: routeLines,
    xferBadge: xferBadge, xferChips: xferChips, xferLine: xferLine, depthChip: depthChip, areasText: areasText, junctionShort: junctionShort, approxM: approxM,
    forkSvg: forkSvg, exitHereHtml: exitHereHtml, ehIcon: ehIcon, ehSvg: ehSvg,
    exitPopupHtml: exitPopupHtml, pointPopupHtml: pointPopupHtml, egressPopupHtml: egressPopupHtml
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
