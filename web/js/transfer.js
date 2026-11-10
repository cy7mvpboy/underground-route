/* transfer.js — 환승 안내에 쓸 내용 만들기 (DOM 없음, Node 시험: scripts/check_transfer.js)
   steps.js 의 'transfer' 단계(route.py 와 같은 값)는 그대로 두고, 화면에 보여 줄 내용을 따로 만들어
   안내 목록 항목에 붙인다(item.xfer). 단계 목록 카드(panel.js)와 길 안내 카드(guide.js)가 같이 쓴다.
   - 승강장 깊이: stations[].depth(서울교통공사 1~8호선)에서 그 허브의 노선과 맞는 기록. 없으면 비워 둔다.
   - 갈아탈 방향: 다음 '타기' 단계의 종착역 방면(있으면), 없으면 다음 역 방면.
   - 시간: 서울교통공사 자료는 그 기관의 환승소요시간 기준(거리 ÷ 초속 1.2m), 추정 거리는 사용자가 고른 걷는 속도.
   - 짧은 행동 안내 세 줄: 승강장으로 올라가기 → 환승 통로 → 다음 선로로 내려가기. 시설 세부(계단 위치 등)는 지어내지 않는다.
   - 덧붙는 공식 자료(web/data/extra.json, 형식 'extra-1')가 있으면 쓴다. 없어도 모두 동작한다(setExtra 를 안 부르면 null).
       fast:  국토교통부 빠른 환승 정보 — 환승 계단이 승강장 앞쪽·가운데·뒤쪽 중 어디인지와 열차 문 번호
       exits: 서울교통공사 역세권 현황 — 출구마다 주변 동네·건물 이름 */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};

  const SEOUL_MPS = 1.2;        // 서울교통공사 환승소요시간 = 환승거리 ÷ 1.2 m/s
  const SAME_DEPTH_M = 1;       // 깊이 차이가 이보다 작으면 '같은 깊이'
  const SOURCE_LABEL = { seoul_metro: '서울교통공사 실측 거리', estimated: '추정 거리' };
  const FAST_CREDIT = '국토교통부 빠른 환승 정보';
  const EXITS_CREDIT = '서울교통공사 역세권 현황';
  const POS_KO = { front: '앞쪽', middle: '가운데', back: '뒤쪽' };
  const MIRROR = { front: 'back', middle: 'middle', back: 'front' };

  let extra = null;   // extra.json 내용(없으면 null)
  function setExtra(d) { extra = d && d.format === 'extra-1' ? d : null; }

  /* ---------- extra.json 값 맞추기 ----------
     역·노선은 번호나 이름 어느 쪽으로 와도 맞춘다(역 이름은 정규화해서 비교). */
  function sameStation(G, v, si) {
    if (v == null || v === '' || si == null || si < 0) return false;
    if (typeof v === 'number' || /^\d+$/.test(String(v))) return +v === si;
    const norm = UG.graph ? UG.graph.normalizeName : function (s) { return s; };
    return norm(v) === norm(G.g.stations[si].name);
  }
  // 노선: 번호면 그 허브의 노선 번호 목록(지선 승강장은 지선 번호)에 있는지, 이름이면 짧은·정식 이름과 같은지
  function sameLine(G, v, level) {
    if (v == null || !level) return false;
    const T = G.g.tables;
    if (typeof v === 'number') return (level.lineIds || []).indexOf(v) >= 0;
    return v === level.line || (level.lineIds || []).some(function (i) { return T.lines[i] === v || T.line_short[i] === v; });
  }

  // 출구 주변 이름(역세권 현황). 없으면 빈 배열
  function exitAreas(si, ref) {
    if (!extra || !extra.exits || si == null || si < 0 || !ref) return [];
    const st = extra.exits[String(si)];
    const list = st && st[String(ref)];
    return Array.isArray(list) ? list.filter(function (x) { return typeof x === 'string' && x; }) : [];
  }

  /* 빠른 환승: 이 역에서 A 노선 -> B 노선. 다음 '타기' 단계의 다음 역과 맞는 기록을 먼저, 없으면 같은 역·노선 아무 기록.
     자료의 앞·뒤는 열차 진행 방향(prev -> toward) 기준이다. 걸어온 방향(앞 단계에서 직전에 지난 역)이 prev 면 그대로,
     아니면 거꾸로 걷는 것이라 앞↔뒤를 바꾼다. 걸어오지 않았으면(이 역에서 출발) 앞·뒤를 말하지 않는다. */
  function fastTransfer(G, si, from, to, prevSi, nextSi, nextName) {
    if (!extra || !Array.isArray(extra.fast)) return null;
    const cand = extra.fast.filter(function (f) { return sameStation(G, f.s, si) && sameLine(G, f.line, from) && sameLine(G, f.to_line, to); });
    if (!cand.length) return null;
    // 갈아탄 뒤 첫 역이 맞는 항목 > 방향과 상관없는 항목(next 가 null) > 아무 항목
    const f = cand.find(function (c) { return sameStation(G, c.next, nextSi) || (c.next == null && c.next_name && nextName && sameStation(G, c.next_name, nextSi)); }) ||
      cand.find(function (c) { return c.next == null; }) || cand[0];
    let pos = POS_KO[f.pos] ? f.pos : '';
    const known = prevSi != null && prevSi >= 0;
    // 같은 방향 = 걸어온 직전 역이 prev 또는 prev_alt(다른 이전 역 목록) 중 하나. prev 가 null(그 역에서 출발하는 열차)이면 늘 반대 방향.
    const same = sameStation(G, f.prev, prevSi) || (Array.isArray(f.prev_alt) && f.prev_alt.some(function (p) { return sameStation(G, p, prevSi); }));
    if (pos && known && !same) pos = MIRROR[pos];
    if (!known && pos !== 'middle') pos = '';   // 가운데는 방향과 관계없이 그대로
    const door = f.car != null && f.car !== '' ? f.car + (f.door != null && f.door !== '' ? '-' + f.door : '') : '';
    return { pos: pos, side: POS_KO[pos] || '', door: door, cars: f.cars || null };
  }

  function yeok(n) { return n.endsWith('역') ? n : n + '역'; }
  // 조사 '로/으로'(panel.js 의 ro 와 같은 규칙)
  function ro(word) {
    const w = String(word), c = w.charCodeAt(w.length - 1);
    if (c < 0xac00 || c > 0xd7a3) return w + '(으)로';
    const jong = (c - 0xac00) % 28;
    return w + (jong === 0 || jong === 8 ? '로' : '으로');
  }
  function fmtDist(m) { m = Math.round(m); return m < 1000 ? m + 'm' : (m / 1000).toFixed(1) + 'km'; }
  // 분: 1분 미만은 '1분 미만', 60분 이상은 '1시간 5분'
  function fmtMin(min) {
    const m = Math.round(min);
    if (m < 1) return '1분 미만';
    const h = Math.floor(m / 60);
    return h ? h + '시간 ' + (m % 60) + '분' : m + '분';
  }

  /* ---------- 허브(노선별 승강장) 하나의 정보 ----------
     { line(짧은 노선 이름), hub(노드), lat, lon, ug(지하 승강장인지), floor('B3'|'고가'|'지상'|''), depth_m(승강장 깊이 m | null) } */
  function hubLevel(G, si, hub, shortName) {
    const g = G.g, s = g.stations[si], T = g.tables, N = g.nodes;
    const j = s.hubs.indexOf(hub);
    const lineSet = j >= 0 ? (T.line_sets[s.hub_ls[j]] || []) : [];
    // 깊이 기록은 노선 번호로 허브와 맞춘다(지선 승강장은 지선 기록만 쓴다)
    const d = Array.isArray(s.depth) ? s.depth.find(function (x) { return lineSet.indexOf(x.line) >= 0; }) : null;
    return {
      line: shortName || (G.hubShort.get(hub) || []).join('/'), hub: hub, lineIds: lineSet,
      lat: N.lat[hub] / 1e5, lon: N.lon[hub] / 1e5,
      ug: j >= 0 ? s.ug[j] === 1 : false,
      floor: d ? String(d.floor || '') : '',
      depth_m: d && isFinite(d.platform_m) ? +d.platform_m : null
    };
  }

  // 지하 층(B1~B8)인지
  function isBelow(level) { return /^B\d/.test(level.floor); }

  // 승강장 한 줄 글: 'B3 · 깊이 20.3m' | '고가' | '지상' | '지하 · 깊이 자료 없음'
  function levelText(level) {
    if (level.floor && isBelow(level)) return level.floor + (level.depth_m != null ? ' · 깊이 ' + level.depth_m.toFixed(1) + 'm' : '');
    if (level.floor) return level.floor;                    // 고가·지상 (자료 글자 그대로)
    return level.ug ? '지하 · 깊이 자료 없음' : '지상';
  }

  // 깊이 차이(+ = 더 깊이 내려감). 두 승강장 모두 지하 층 기록이 있을 때만.
  function depthDelta(a, b) {
    if (a.depth_m == null || b.depth_m == null || !isBelow(a) || !isBelow(b)) return null;
    return b.depth_m - a.depth_m;
  }
  function moveText(delta) {
    if (delta == null) return '';
    if (Math.abs(delta) < SAME_DEPTH_M) return '같은 깊이';
    return '약 ' + Math.round(Math.abs(delta)) + 'm ' + (delta > 0 ? '아래로' : '위로');
  }

  /* ---------- 환승 항목 하나 ----------
     plan.items[k] 가 transfer 단계일 때. 앞뒤 항목으로 '선로에서 올라오는지', '다음에 어느 방향 선로로 가는지'를 정한다. */
  function info(G, plan, k, speedKmh) {
    const it = plan.items[k], s = it.step, x = plan.route.path[s._idx[0]];
    const si = G.nodeStation[x.v];
    const from = hubLevel(G, si, x.u, s.from_line), to = hubLevel(G, si, x.v, s.to_line);
    const delta = depthDelta(from, to);
    // 앞: 바로 앞 '타기' 단계가 선로를 걸었는지(경고는 건너뛴다)
    let prev = null;
    for (let i = k - 1; i >= 0; i--) {
      const p = plan.items[i];
      if (p.kind === 'step' && p.step.type === 'warning') continue;
      prev = p; break;
    }
    const fromTrack = !!(prev && prev.kind === 'step' && prev.step.type === 'ride' && prev.step._tracks_m > 0);
    // 뒤: 다음 환승·지상 걷기 전까지 선로를 걷는 첫 '타기' 단계 = 갈아탈 방향
    let ride = null, after = null;
    for (let i = k + 1; i < plan.items.length; i++) {
      const n = plan.items[i];
      if (n.kind !== 'step') { after = after || n; break; }
      if (n.step.type === 'warning') continue;
      if (n.step.type !== 'ride') { after = after || n; break; }
      if (n.step._tracks_m > 0) { ride = n.step; break; }
    }
    let dir = null;
    if (ride && (ride.terminal_direction || ride.direction)) {
      const next = ride.direction ? ride.direction.replace(/ 방면$/, '') : '';
      const head = ride.terminal_direction || ride.direction;
      dir = { line: ride.line || to.line, head: head, next: next, terminal: !!ride.terminal_direction && ride.terminal_direction !== ride.direction };
    }
    // 빠른 환승(있으면): 걸어온 방향 = 앞 단계에서 이 역 직전에 지난 역, 갈 방향 = 다음 단계의 다음 역
    const pseq = fromTrack ? prev.step._seq || [] : [];
    const prevSi = pseq.length >= 2 ? pseq[pseq.length - 2][0] : -1;
    const nextSi = ride && ride._seq && ride._seq.length >= 2 ? ride._seq[1][0] : -1;
    const fast = fastTransfer(G, si, from, to, prevSi, nextSi, dir ? dir.next : '');
    const seoul = s.source === 'seoul_metro';
    const minutes = seoul ? s.distance_m / SEOUL_MPS / 60 : s.distance_m / ((speedKmh || 3.5) * 1000 / 60);
    const st = yeok(s.station);
    const dist = fmtDist(s.distance_m) + ', 약 ' + fmtMin(minutes);
    // 짧은 행동 안내 세 줄
    const micro = [
      fromTrack ? from.line + ' 선로에서 ' + st + ' 승강장으로 올라가기' : st + ' ' + from.line + ' 승강장에서 시작',
      '환승 통로를 따라 ' + ro(to.line + ' 승강장') + ' (' + dist + (s.underground ? '' : ', 지상 노출') + ')',
      ride ? (dir ? dir.head : to.line) + ' 선로로 내려가 걷기'
        : after && after.kind === 'exit' ? to.line + ' 승강장에서 나갈 출구 쪽으로'
        : to.line + ' 승강장 도착'
    ];
    return {
      station: s.station, from: from, to: to, delta_m: delta, move: moveText(delta),
      hasDepth: from.depth_m != null || to.depth_m != null, dir: dir,
      distance_m: s.distance_m, minutes: minutes, source: s.source, source_label: SOURCE_LABEL[s.source] || '추정 거리',
      speed_label: seoul ? '서울교통공사 기준 초속 1.2m' : '시속 ' + (speedKmh || 3.5).toFixed(1) + 'km',
      underground: !!s.underground, fromTrack: fromTrack, micro: micro,
      fast: fast, credits: fast ? [FAST_CREDIT] : []
    };
  }

  // 빠른 환승 글: '승강장 앞쪽(진행 방향) 환승 계단', 문 번호는 따로(작게) 쓴다
  function fastText(f) {
    if (!f) return '';
    if (f.pos === 'middle') return '승강장 가운데 환승 계단';   // 가운데는 걷는 방향과 관계없다
    return f.side ? '승강장 ' + f.side + '(진행 방향) 환승 계단' : '환승 계단';
  }

  // 안내 목록의 환승 항목마다 item.xfer 를 붙이고 환승 횟수를 돌려준다(app.js 가 경로·속도가 바뀔 때 부른다)
  function annotate(G, plan, speedKmh) {
    let n = 0;
    plan.items.forEach(function (it, k) {
      if (it.kind === 'step' && it.step.type === 'transfer') { it.xfer = info(G, plan, k, speedKmh); n++; }
    });
    if (plan.view) plan.view.transfers = n;
    return n;
  }

  UG.transfer = {
    SEOUL_MPS: SEOUL_MPS, SOURCE_LABEL: SOURCE_LABEL, FAST_CREDIT: FAST_CREDIT, EXITS_CREDIT: EXITS_CREDIT,
    info: info, annotate: annotate, hubLevel: hubLevel, levelText: levelText, depthDelta: depthDelta, moveText: moveText, fmtMin: fmtMin,
    setExtra: setExtra, hasExtra: function () { return !!extra; }, exitAreas: exitAreas, fastText: fastText
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = UG.transfer;
})(typeof globalThis !== 'undefined' ? globalThis : this);
