/* places.js — 오프라인 장소 검색(web/data/places.json)
   - 브라우저와 Node(검증 시험) 양쪽에서 쓴다. DOM·Leaflet을 쓰지 않는다. 의존성 없음.
   - globalThis.UG.places 아래에 두고, 편의를 위해 globalThis.searchPlaces 도 둔다.
   - 사용: searchPlaces(index, '서울대병원', {near: [37.56, 126.97], limit: 10})
     → [{name, type, area, lat, lon, score}, ...] (점수 높은 순)
   - 형식·순위 규칙 설명: docs/graph-format.md 의 'places.json' 절 */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};

  /* ---------- 정규화 ---------- */
  // 소문자로 바꾸고, 괄호 안 내용과 한글·영문·숫자·자모가 아닌 글자(공백, ·, -, . 등)를 지운다.
  function normalize(s) {
    return String(s || '').toLowerCase()
      .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
      .replace(/[^0-9a-z가-힣ㄱ-ㆎ]/g, '');
  }

  // 끝의 '역'을 뗀다(세 글자 이상일 때만: '서울역'→'서울', '역'·'구역'은 그대로).
  function stripStation(k) {
    return (k.length >= 3 && k.charAt(k.length - 1) === '역') ? k.slice(0, -1) : k;
  }

  const SIDO = ['서울특별시', '부산광역시', '대구광역시', '인천광역시', '광주광역시', '대전광역시',
    '울산광역시', '세종특별자치시', '전남광주통합특별시', '경기도', '강원특별자치도', '강원도',
    '충청북도', '충청남도', '전북특별자치도', '전라북도', '전라남도', '경상북도', '경상남도',
    '제주특별자치도', '서울시', '부산시', '대구시', '인천시', '광주시', '대전시', '울산시'];
  const SIDO_RE = new RegExp('^(' + SIDO.join('|') + ')');

  // 이름 하나에서 검색 열쇠 여러 개를 만든다(첫 번째가 본 이름).
  function keysFor(name, type) {
    const k0 = stripStation(normalize(name));
    const out = [k0];
    const add = (k) => { if (k && k.length >= 2 && out.indexOf(k) < 0) out.push(k); };
    // 앞에 붙은 시·도 이름: '서울특별시강남구청' → '강남구청'
    const m = SIDO_RE.exec(k0);
    if (m && k0.length > m[0].length + 1) add(k0.slice(m[0].length));
    // 시·도 줄임: '세종특별자치시청' → '세종시청', '부산광역시청' → '부산시청', '제주특별자치도청' → '제주도청'
    for (const k of out.slice()) {
      if (/특별자치시|특별자치도|특별시|광역시/.test(k)) {
        add(k.replace(/특별자치시|특별자치도|특별시|광역시/, (w) => (w === '특별자치도' ? '도' : '시')));
      }
    }
    // '대학교' → '대': '서울대학교병원' → '서울대병원'
    for (const k of out.slice()) if (k.indexOf('대학교') >= 0) add(k.replace(/대학교/g, '대'));
    // 행정동 번호: '역삼1동' → '역삼동', '종로1234가동' → '종로동'
    if (type === 'dong') add(k0.replace(/[0-9]+가?동$/, '동'));
    // '은마'로 '은마아파트'를 찾는 것은 앞부분 맞춤으로 된다. 끝의 '아파트'를 뗀 열쇠를 따로 두면
    // '강남'이 '강남아파트'와 '같음'으로 맞아 강남구보다 앞서므로 두지 않는다.
    return out;
  }

  /* ---------- 초성 ---------- */
  const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
  function choseong(s) {
    let r = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      r += (c >= 0xac00 && c <= 0xd7a3) ? CHO.charAt(Math.floor((c - 0xac00) / 588)) : s.charAt(i);
    }
    return r;
  }
  const isChoseongOnly = (q) => /^[ㄱ-ㅎ]+$/.test(q);

  /* ---------- 순위 ---------- */
  // 종류별 가산점. 같은 맞춤 단계 안에서만 순서를 바꿀 만큼 작게 둔다.
  // 역은 '역'을 뗀 이름으로 맞추므로 '수원시청'·'경찰병원'처럼 시설과 이름이 같아지면 시설이 앞서게 낮게 둔다.
  const TYPE_BOOST = {
    sido: 80, sigungu: 70, dong: 60, university: 55, hospital: 50, gov: 50, station: 45,
    landmark: 40, apartment: 30, school: 25, police: 20, fire: 20, library: 20, village: 15
  };
  const BASE = { exact: 1000, prefix: 600, sub: 300 };

  /* ---------- 준비(한 번만) ---------- */
  // 이름을 미리 정규화해 둔다. index 객체에 숨은 속성으로 붙여 두고 다시 쓴다.
  // budgetMs 를 주면 그 시간만 하고 멈춘다(다 못 했으면 null). 다음에 부르면 멈춘 곳부터 이어서 한다.
  // 나눠서 만들어도 결과(열쇠와 그 순서)는 한 번에 만든 것과 같다. budgetMs 가 없으면 끝까지 한다.
  const now = typeof performance !== 'undefined' ? function () { return performance.now(); } : Date.now;
  function prepare(index, budgetMs) {
    if (index._prep) return index._prep;
    const P = index.p, types = index.types;
    if (!index._work) Object.defineProperty(index, '_work', { value: { i: 0, keys: [], keyEntry: [], keyAlias: [] }, enumerable: false, configurable: true });
    const w = index._work, keys = w.keys, keyEntry = w.keyEntry, keyAlias = w.keyAlias;
    const until = budgetMs != null ? now() + budgetMs : Infinity;
    for (; w.i < P.length; w.i++) {
      if ((w.i & 255) === 0 && now() > until) return null;   // 시간이 다 됐다: 이 장소(w.i)부터 다음에
      const i = w.i, e = P[i], type = types[e[1]];
      const names = [e[0]];
      if (e.length > 5 && e[5]) for (const a of e[5]) names.push(a);
      const seen = {};
      for (let j = 0; j < names.length; j++) {
        const ks = keysFor(names[j], type);
        for (let m = 0; m < ks.length; m++) {
          const k = ks[m];
          if (!k || seen[k]) continue;
          seen[k] = 1;
          keys.push(k); keyEntry.push(i); keyAlias.push(j === 0 && m === 0 ? 0 : 1);
        }
      }
    }
    const prep = {
      keys: keys, keyEntry: Int32Array.from(keyEntry), keyAlias: Uint8Array.from(keyAlias),
      cho: null, best: new Float32Array(P.length), boost: new Float32Array(P.length)
    };
    for (let i = 0; i < P.length; i++) prep.boost[i] = TYPE_BOOST[types[P[i][1]]] || 0;
    Object.defineProperty(index, '_prep', { value: prep, enumerable: false, configurable: true });
    delete index._work;
    return prep;
  }

  // 한 열쇠와 질의어의 맞춤 점수(맞지 않으면 0)
  function matchScore(k, q) {
    if (k === q) return BASE.exact;
    const at = k.indexOf(q);
    if (at < 0) return 0;
    const pen = Math.min(150, (k.length - q.length) * 8);
    return (at === 0 ? BASE.prefix : BASE.sub) - pen;
  }

  function distKm(lat1, lon1, lat2, lon2) {
    const x = (lon2 - lon1) * Math.cos((lat1 + lat2) * Math.PI / 360) * 111.32;
    const y = (lat2 - lat1) * 110.57;
    return Math.sqrt(x * x + y * y);
  }

  /* ---------- 검색 ---------- */
  function searchPlaces(index, query, opts) {
    opts = opts || {};
    const limit = opts.limit || 10;
    const near = opts.near || null;
    const prep = prepare(index);
    const P = index.p;
    const raw = String(query || '').trim();
    if (!raw) return [];

    // 질의어 변형: [질의어, 깎을 점수, 이 종류가 아니면 300점 더 깎음(-1 = 모두 같게)]
    // '아파트'를 뗀 것은 아파트를 앞세운다('은마아파트' → OSM 이름 '은마'). '대학교'→'대'.
    let q0 = stripStation(normalize(raw));
    if (!q0) return [];
    const variants = [[q0, 0, -1]];
    if (q0.length > 4 && /아파트$/.test(q0)) variants.push([q0.slice(0, -3), 10, index.types.indexOf('apartment')]);
    if (q0.indexOf('대학교') >= 0) variants.push([q0.replace(/대학교/g, '대'), 0, -1]);

    const cho = isChoseongOnly(q0);
    let keys = prep.keys;
    if (cho) {
      if (!prep.cho) prep.cho = prep.keys.map(choseong);
      keys = prep.cho;
    }

    const best = prep.best, touched = [];
    const KE = prep.keyEntry, KA = prep.keyAlias;
    for (const [q, vpen, onlyType] of variants) {
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k.length < q.length) continue;
        let s = matchScore(k, q);
        if (!s) continue;
        // 다른 종류도 버리지는 않고 크게 깎는다(서울 대치동 은마아파트처럼 OSM에 단지 이름이 없을 때 '은마종합상가'라도 나오게)
        if (onlyType >= 0 && P[KE[i]][1] !== onlyType) s -= 300;
        if (cho) s -= 100;              // 초성 맞춤은 글자 맞춤보다 낮게
        if (KA[i]) s -= 20;             // 별칭 맞춤은 본 이름보다 조금 낮게
        s -= vpen;
        const e = KE[i];
        if (best[e] === 0) touched.push(e);
        if (s > best[e]) best[e] = s;
      }
    }

    const res = [];
    for (const e of touched) {
      let s = best[e] + prep.boost[e];
      best[e] = 0;                      // 다음 검색을 위해 되돌림
      const p = P[e];
      const lat = p[2] / 1e5, lon = p[3] / 1e5;
      let d = null;
      if (near) {
        d = distKm(near[0], near[1], lat, lon);
        s += 150 / (1 + d / 2);         // 0km +150, 2km +75, 10km +25, 100km +3
      }
      res.push({ e: e, s: s, lat: lat, lon: lon, d: d });
    }
    res.sort((a, b) => b.s - a.s || P[a.e][0].length - P[b.e][0].length);
    return res.slice(0, limit).map((r) => {
      const p = P[r.e];
      const o = { name: p[0], type: index.types[p[1]], area: index.areas[p[4]] || '',
        lat: r.lat, lon: r.lon, score: Math.round(r.s) };
      if (r.d !== null) o.distance_km = Math.round(r.d * 10) / 10;
      return o;
    });
  }

  UG.places = { searchPlaces: searchPlaces, prepare: prepare, normalize: normalize,
    keysFor: keysFor, choseong: choseong };
  root.searchPlaces = searchPlaces;
  if (typeof module !== 'undefined' && module.exports) module.exports = UG.places;
})(typeof globalThis !== 'undefined' ? globalThis : this);
