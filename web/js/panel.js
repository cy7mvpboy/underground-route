/* panel.js — 시트 안의 화면 조각 (경로 결과 카드, 단계 목록, 분석 통계, 지도 팝업)
   - 경로 결과: 지상 노출 배지(크게) -> 총 거리·걷는 시간 -> 지나는 노선 칩 -> 안내 시작 -> 단계 목록 -> 출처·가정.
   - 단계 목록은 steps.js 의 planItems 가 만든 items 를 그린다:
       {kind:'enter'|'exit'|'arrive'|'walk', …} 와 {kind:'step', step: ride/transfer/warning/surface}
   - 각 단계 버튼에는 data-item(목록 위치)을 달아, 누르면 app.js 가 지도를 그 단계로 옮긴다.
   - 환승은 카드로 그린다(xfer*: 노선 칩, 갈아탈 방향, 승강장 깊이, 행동 안내 세 줄). 내용은 transfer.js 가 만든 item.xfer. */
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
      '<h3 class="sub-h" id="near-title">가까운 지하역 <span class="muted">' + (nb.isCenter ? '지도 중심 기준' : esc(nb.label) + ' 기준') + '</span></h3>' +
      '<ol class="near-list">' + nb.options.map(function (o, i) {
        return '<li><button type="button" class="row-btn near-btn" data-near="' + i + '" aria-pressed="' + (i === nb.chosen) + '">' +
          '<span class="row-main"><span class="row-title">' + esc(o.kind === 'entrance' ? exitName(o.name, o.ref) : yeok(o.name) + ' (출구 자료 없음)') + '</span>' +
          '<span class="row-sub"><span class="t-expo">지상 ' + fmtDist(o.len) + '</span> · 약 ' + fmtTime(o.len / mpm) + '</span></span>' +
          (i === nb.chosen ? '<span class="row-meta">안내 중</span>' : '') + '</button></li>';
      }).join('') + '</ol>' +
      (nb.isCenter ? '<p class="note">내 위치를 쓸 수 없어 지도 가운데에서 찾았습니다. 지도를 옮긴 뒤 다시 누르면 그곳에서 찾습니다.</p>' : '') +
      '</section>';
  }

  function blockedHtml(n) {
    return n ? '<p class="msg blocked">막은 구간 ' + n + '곳을 빼고 찾았습니다. <button type="button" class="link-btn" data-action="unblock">모두 풀기</button></p>' : '';
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
      '<ol class="steps" id="route-steps" aria-label="단계별 안내"></ol>' +
      '<div id="route-notes"></div>';
    return {
      top: el.querySelector('#route-top'), speedRow: el.querySelector('#speed-row'), speed: el.querySelector('#speed'),
      steps: el.querySelector('#route-steps'), notes: el.querySelector('#route-notes')
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
    R.top.innerHTML =
      '<div class="sv-head rc-head">' + headLine +
      '<div class="rc-main">' + expoBadge(view.exposed_m, true) +
      '<dl class="rc-nums"><div><dt>거리</dt><dd class="num">' + bigDist(view.total_m) + '</dd></div>' +
      '<div><dt>걷는 시간</dt><dd class="num">' + bigTime(view.minutes) + '</dd></div>' +
      (view.transfers ? '<div><dt>환승</dt><dd class="num"><b>' + view.transfers + '</b><small>회</small></dd></div>' : '') + '</dl></div>' +
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
    R.steps.innerHTML = view.items.map(itemHtml).join('');
    let notes = '';
    if (view.usesPoint) notes += '<p class="note">출발·도착 지점과 출구 사이는 지상 노출로 셉니다.' + (view.street ? ' 실제 걷는 길로 쟀습니다.' : ' 걷는 길을 받지 못해 직선 거리 × 1.3으로 쟀습니다.') + '</p>';
    if (view.hasTransfer) {
      notes += '<p class="note">환승 통로는 양쪽 승강장이 모두 지하면 지하로 이어진다고 가정합니다. 환승 거리 출처: ' +
        (view.seoulSource ? SEOUL_SRC + '(환승 시간은 그 기관 기준 초속 1.2m로 계산). 그 밖의 역은 ' : '') + '추정(직선 거리 × 1.3 + 50m). ' +
        '승강장 깊이: 서울교통공사 역사심도정보(2024-11-04, 1~8호선만).</p>';
    }
    // 덧붙는 공식 자료(extra.json)를 쓴 곳이 있으면 출처를 밝힌다
    const extraSrc = [];
    if (view.items.some(function (it) { return it.xfer && it.xfer.fast; })) extraSrc.push(UG.transfer.FAST_CREDIT);
    if (view.items.some(function (it) {
      return (it.kind === 'exit' || it.kind === 'arrive') && [it.conn ? it.conn.ref : null].concat((it.others || []).map(function (o) { return o.ref; }))
        .some(function (ref) { return ref && areasText(it.kind === 'exit' ? it.conn.si : it.si, ref); });
    })) extraSrc.push(UG.transfer.EXITS_CREDIT);
    notes += '<p class="note">데이터: © OpenStreetMap 기여자 (ODbL)' + (extraSrc.length ? ' · ' + esc(extraSrc.join(' · ')) : '') + (view.street ? ' · ' + esc(UG.walk ? UG.walk.ATTRIBUTION : '') : '') +
      '. 열차가 멈추고 전기가 끊겨 선로를 걸을 수 있다고 가정합니다. 실시간 피해 정보는 없습니다.</p>';
    R.notes.innerHTML = notes;
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
    return '<details class="exits"><summary>' + esc(label) + ' (' + list.length + ')</summary><ul>' +
      list.map(function (x) {
        const area = areasText(si, x.ref, 2);
        return '<li><button type="button" class="exit-btn" data-exit="' + x.ent + '"><span>' + esc(x.ref ? x.ref + '번 출구' : '번호 없는 출구') +
          (x.chosen ? ' <span class="cur">· 안내한 출구</span>' : '') + (area ? '<small class="exit-area">' + esc(area) + '</small>' : '') +
          '</span><span class="num">' + fmtDist(x.dist) + '</span></button></li>';
      }).join('') + '</ul></details>';
  }

  const WALK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4.5" r="1.8" fill="currentColor" stroke="none"/><path d="M10 21l2.5-6 2.5 2.5V21M12.5 15L11 9.5l-3 2v3M11 9.5l3.5 1.5 2 2.5"/></svg>';
  function expo(m) { return '<span class="t-expo">지상 ' + fmtDist(m) + '</span>'; }

  /* ---------- 환승 카드 (x = transfer.js 의 info 결과) ----------
     단계 목록과 길 안내 카드가 같은 조각을 쓴다: 지하/지상 표시, 갈아탈 방향, 승강장 깊이, 짧은 행동 안내 세 줄. */
  const XFER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h14M15 4.5L18.5 8 15 11.5M20 16H6M9 12.5L5.5 16 9 19.5"/></svg>';
  const MOVE_ICON = {   // 깊이 차이 화살표: 아래로 / 위로 / 같은 깊이(옆으로)
    down: '<path d="M12 4v15M6.5 13.5L12 19l5.5-5.5"/>', up: '<path d="M12 20V5M6.5 10.5L12 5l5.5 5.5"/>', side: '<path d="M4 12h15M13.5 6.5L19 12l-5.5 5.5"/>'
  };
  function xferBadge(x) {
    return x.underground ? '<span class="tag tag-ug">지하 통로</span>' : '<span class="tag tag-gr">지상 통로 · 노출</span>';
  }
  function xferChips(x) {
    return '<span class="x-chips">' + chip(x.from.line) + '<span class="x-arrow" aria-label="에서">→</span>' + chip(x.to.line) + '</span>';
  }
  // '5호선 방화 방면으로 갈아타기 (다음 역 마포)'
  function xferDirHtml(x) {
    if (!x.dir) return '<p class="x-dir">' + chip(x.to.line) + ' 승강장으로 갈아타기</p>';
    return '<p class="x-dir">' + chip(x.dir.line) + ' <b>' + esc(ro(x.dir.head)) + '</b> 갈아타기' +
      (x.dir.terminal && x.dir.next ? ' <span class="muted">(다음 역 ' + esc(x.dir.next) + ')</span>' : '') + '</p>';
  }
  // 승강장 두 줄과 그 사이의 오르내림. 두 승강장 모두 지하인데 깊이 기록이 하나도 없으면 숨긴다.
  function xferLevelsHtml(x) {
    const T = UG.transfer;
    if (!T || (!x.hasDepth && x.from.ug && x.to.ug)) return '';
    const row = function (lv) {
      return '<li class="xl-row">' + chip(lv.line) + '<span>승강장</span><span class="xl-v num">' + esc(T.levelText(lv)) + '</span></li>';
    };
    const d = x.delta_m, icon = d == null || Math.abs(d) < 1 ? 'side' : d > 0 ? 'down' : 'up';
    return '<ol class="xl" aria-label="승강장 높이">' + row(x.from) +
      '<li class="xl-move"><svg class="ic-s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + MOVE_ICON[icon] + '</svg>' +
      (x.move ? '<b>' + esc(x.move) + '</b> · ' : '') + '통로 <span class="num">' + fmtDist(x.distance_m) + '</span></li>' +
      row(x.to) + '</ol>';
  }
  // 길 안내 카드용 짧은 한 줄: '승강장 깊이 공항철도 자료 없음 → 5호선 B3 20.3m · 약 9m 아래로'
  function xferLevelsLine(x) {
    if (!x.hasDepth && x.from.ug && x.to.ug) return '';
    const s = function (lv) {
      if (/^B\d/.test(lv.floor)) return lv.floor + (lv.depth_m != null ? ' ' + lv.depth_m.toFixed(1) + 'm' : '');
      return lv.floor || (lv.ug ? '자료 없음' : '지상');
    };
    return '<p class="x-lv">승강장 깊이 ' + esc(x.from.line + ' ' + s(x.from)) + ' <span aria-label="에서">→</span> ' + esc(x.to.line + ' ' + s(x.to)) +
      (x.move ? ' · <b>' + esc(x.move) + '</b>' : '') + '</p>';
  }
  function xferMicroHtml(x) {
    return '<ol class="x-micro" aria-label="환승 순서">' + x.micro.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ol>';
  }
  function xferMeta(x) {
    return '<span class="num">' + fmtDist(x.distance_m) + '</span> · 약 ' + esc(UG.transfer ? UG.transfer.fmtMin(x.minutes) : fmtTime(x.minutes)) + ' · ' + esc(x.source_label) +
      (x.credits && x.credits.length ? ' · ' + esc(x.credits.join(' · ')) : '');
  }
  // 빠른 환승(extra.json 이 있을 때만): '승강장 앞쪽(진행 방향) 환승 계단 · 4-2번 문 부근'(문 번호는 작게)
  function xferFastHtml(x) {
    if (!x.fast || !UG.transfer) return '';
    const t = UG.transfer.fastText(x.fast);
    return '<p class="x-fast"><svg class="ic-s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 20h5v-5h5v-5h5V5h3"/></svg><span>' +
      (x.fast.side ? esc(t).replace(x.fast.side, '<b>' + x.fast.side + '</b>') : esc(t)) +
      (x.fast.door ? ' <small>· ' + esc(x.fast.door) + '번 문 부근</small>' : '') + '</span></p>';
  }
  // 출구 주변 이름(역세권 현황, extra.json 이 있을 때만): '동자동, 서울역 방면'
  function areasText(si, ref, max) {
    const a = UG.transfer ? UG.transfer.exitAreas(si, ref) : [];
    return a.length ? a.slice(0, max || 3).join(', ') + ' 방면' : '';
  }
  // 단계 목록의 환승 카드: 위는 누르는 단추(지도에서 보기), 아래는 자세한 내용
  function xferItemHtml(x, i, n) {
    return '<li class="step step-x' + (x.underground ? '' : ' is-expo') + '">' +
      '<button type="button" class="step-btn" data-item="' + i + '">' +
      '<span class="step-no x" aria-hidden="true">' + XFER_ICON + '</span>' +
      '<span class="step-title">' + n + esc(yeok(x.station)) + ' 환승 ' + xferBadge(x) + '</span>' +
      '<span class="step-dir">' + xferChips(x) + '</span>' +
      '<span class="step-meta">' + xferMeta(x) + '</span></button>' +
      '<div class="x-more">' + xferDirHtml(x) + xferFastHtml(x) + xferLevelsHtml(x) + xferMicroHtml(x) + '</div></li>';
  }

  function itemHtml(it, i) {
    const n = '<span class="sr-only">' + (i + 1) + '. </span>';
    if (it.kind === 'walk') {
      return '<li class="step">' + stepBtn(i, WALK_ICON, 's', n + '지상으로 바로 걷기', '지하로 돌아가는 길보다 지상 노출이 짧습니다.',
        expo(it.m) + ' · 약 ' + fmtTime(it.min)) + '</li>';
    }
    if (it.kind === 'enter') {
      const title = it.conn.kind === 'entrance' ? ro(exitName(it.stName, it.conn.ref)) + ' 들어가기' : ro(yeok(it.stName)) + ' 들어가기 (출구 자료 없음)';
      return '<li class="step">' + stepBtn(i, WALK_ICON, 's', n + esc(title), it.label ? esc(it.label) + '에서 걷기' : '',
        expo(it.m) + ' · 약 ' + fmtTime(it.min)) + '</li>';
    }
    if (it.kind === 'exit') {
      const title = it.conn.kind === 'entrance' ? ro(exitName(it.stName, it.conn.ref)) + ' 나가기' : yeok(it.stName) + '에서 나가기 (출구 자료 없음)';
      const area = it.conn.kind === 'entrance' ? areasText(it.conn.si, it.conn.ref) : '';   // '5번 출구로 나가기 · 동자동, 서울역 방면'
      return '<li class="step">' + stepBtn(i, WALK_ICON, 's', n + esc(title) + (area ? '<span class="step-area">· ' + esc(area) + '</span>' : ''),
        it.label ? esc(it.label) + '까지 걷기' : '', expo(it.m) + ' · 약 ' + fmtTime(it.min)) +
        exitsHtml(it.others, '출구가 막혔으면: 다른 출구', it.conn.si) + '</li>';
    }
    if (it.kind === 'arrive') {
      return '<li class="step">' + stepBtn(i, '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 21V4h10l-2 3.5 2 3.5H8v10z"/></svg>', 'e', n + esc(yeok(it.stName)) + ' 도착', '',
        it.others.length ? '출구 거리는 역 중심에서 잰 직선 거리입니다.' : '이 역은 출구 자료가 없습니다.') +
        exitsHtml(it.others, '출구', it.si) + '</li>';
    }
    const s = it.step;
    if (s.type === 'warning') {
      const where = s.at + (s.after_m ? ' 지나 ' + ST.fmtKm(s.after_m) : '');
      const kinds = Object.keys(s.structures).map(function (k) { return ST.STRUCT_KO[k] + ' ' + fmtDist(s.structures[k]); }).join(' · ');
      const until = s.ends_underground ? '다시 지하로 들어갈 때까지' : '도착할 때까지';
      return '<li class="step"><button type="button" class="warn" data-item="' + i + '">' + n +
        '<span class="warn-ic" aria-hidden="true">!</span><span><b>지상 노출 ' + fmtDist(s.exposure_m) + '</b> ' +
        esc(where) + '에서 ' + (s.portal ? '터널을 나와 ' : '') + until + ' (' + esc(kinds) + ')<span class="warn-go">지도에서 보기</span></span></button></li>';
    }
    if (s.type === 'surface') {
      return '<li class="step">' + stepBtn(i, s.no, 's', n + '지상으로 걸어 ' + esc(exitName(s.to_station, s.to_ref)) + '까지',
        esc(exitName(s.from_station, s.from_ref)) + '로 나가서 걷기 (지하로 이어진 길이 없음)',
        expo(s.distance_m) + ' · 약 ' + fmtTime(s.est_minutes)) + '</li>';
    }
    if (s.type === 'transfer' && it.xfer) return xferItemHtml(it.xfer, i, n);
    if (s.type === 'transfer') {
      const src = ST.SOURCE_KO[s.source] || '';
      return '<li class="step">' + stepBtn(i, s.no, 't', n + '<span class="step-chips">' + chip(s.from_line) + '<span aria-hidden="true">→</span>' + chip(s.to_line) + '</span>' +
        esc(yeok(s.station)) + ' 환승', '',
        '<span class="num">' + s.distance_m + 'm</span> · 약 ' + fmtTime(s.est_minutes) + (src ? ' · ' + esc(src) : '') + ' · ' +
        (s.underground ? '지하 통로' : '<span class="t-expo">지상</span>')) + '</li>';
    }
    // ride
    if (!s._tracks_m) {
      return '<li class="step">' + stepBtn(i, s.no, '', n + esc(yeok(s.from_station)) + ' 안에서 이동', '',
        '<span class="num">' + fmtDist(s.distance_m) + '</span> · 약 ' + fmtTime(s.est_minutes) +
        (s.exposure_m ? ' · ' + expo(s.exposure_m) : '')) + '</li>';
    }
    let title = esc(s.label);
    if (s.line) {
      const rest = s.label === s.line ? '' : s.label.indexOf(s.line + ' · ') === 0 ? s.label.slice(s.line.length + 3) : s.label;
      title = chip(s.line) + (rest ? '<span class="step-track">' + esc(rest) + '</span>' : '');
    }
    const nxt = s.direction.replace(' 방면', '');
    let head = s.direction;
    if (s.terminal_direction) head = s.terminal_direction + (s.terminal_direction === s.direction ? '' : ' (다음 역 ' + nxt + ')');
    const dir = head ? esc(s.from_station) + ' → ' + esc(head) : esc(s.from_station) + ' 이후 선로를 따라 다음 단계까지';
    const meta = (head ? esc(s.to_station) + '까지 ' : '') + '<span class="num">' + fmtDist(s.distance_m) + '</span> · 약 ' + fmtTime(s.est_minutes) +
      (s.exposure_m ? ' · ' + expo(s.exposure_m) : '');
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

  // 경로를 찾지 못했을 때 등: 알림 한 줄 + 고르는 방법
  function messageHtml(message, error) {
    return '<div class="sv-head"><p class="msg' + (error ? ' is-error' : '') + '">' + esc(message) + '</p></div>' +
      '<div class="hint"><p>위 검색 막대에서 목적지를 찾거나, 지도를 눌러 지점을 고르세요.</p>' +
      '<p>급할 때는 <b>가장 가까운 지하로 대피</b>를 누르세요.</p></div>';
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

  function pointPopupHtml(lat, lon, nearText) {
    return '<div class="pop"><p class="pop-name">고른 지점</p>' +
      '<p class="pop-meta">' + esc(nearText) + '</p>' +
      pickRow('data-lat="' + lat.toFixed(6) + '" data-lon="' + lon.toFixed(6) + '"', true) + '</div>';
  }

  UG.panel = {
    esc: esc, yeok: yeok, ro: ro, fmtDist: fmtDist, fmtTime: fmtTime, exitName: exitName, shortRegion: shortRegion,
    bigDist: bigDist, bigTime: bigTime, expoClass: expoClass, expoBadge: expoBadge,
    mountRoute: mountRoute, renderRoute: renderRoute, messageHtml: messageHtml, routeLines: routeLines,
    xferBadge: xferBadge, xferChips: xferChips, xferDirHtml: xferDirHtml, xferLevelsHtml: xferLevelsHtml, xferMicroHtml: xferMicroHtml, xferMeta: xferMeta,
    xferFastHtml: xferFastHtml, xferLevelsLine: xferLevelsLine, areasText: areasText,
    computeStats: computeStats, renderStats: renderStats, exitPopupHtml: exitPopupHtml, pointPopupHtml: pointPopupHtml
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
