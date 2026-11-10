/* lines.js — 노선 색 칩 (단계 목록·역 정보·검색 결과)
   - 수도권·부산·대구·대전·광주 도시철도의 널리 알려진 대표 색(근사값)을 한 표에 모았다.
   - 표에 없는 노선은 중립 칩(테두리만)으로 그린다.
   - 칩 글자색은 배경색과 대비가 더 큰 쪽(흰색 또는 거의 검은색)을 고른다.
   - DOM 을 쓰지 않는다(HTML 문자열만 만든다). */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};

  const COLORS = {
    '1호선': '#0052A4', '2호선': '#00A84D', '3호선': '#EF7C1C', '4호선': '#00A5DE', '5호선': '#996CAC',
    '6호선': '#CD7C2F', '7호선': '#747F00', '8호선': '#E6186C', '9호선': '#BDB092',
    '수인분당선': '#F5A200', '신분당선': '#D4003B', '경의중앙선': '#77C4A3', '공항철도': '#0090D2', '경춘선': '#0C8E72',
    '서해선': '#8FC31F', 'GTX-A': '#9A6292', '우이신설선': '#B0CE18', '신림선': '#6789CA', '김포골드라인': '#AD8605',
    '인천 1호선': '#7CA8D5', '인천 2호선': '#ED8B00',
    '부산 1호선': '#F06A00', '부산 2호선': '#81BF48', '부산 3호선': '#BB8C00', '부산 4호선': '#217DCB',
    '대구 1호선': '#D93F5C', '대구 2호선': '#00AA80', '대구 3호선': '#FFB100',
    '대전 1호선': '#007448', '광주 1호선': '#009088'
  };
  const INK_DARK = '#0B1214', INK_LIGHT = '#FFFFFF';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 노선 이름 -> 색(없으면 null). '2호선 성수지선'처럼 지선 이름은 본선 색을 쓴다.
  function colorOf(name) {
    if (!name) return null;
    if (COLORS[name]) return COLORS[name];
    const base = String(name).replace(/ (성수지선|신정지선)$/, '');
    return COLORS[base] || null;
  }

  // WCAG 상대 휘도와 대비
  function lum(hex) {
    const h = hex.replace('#', '');
    const c = [0, 2, 4].map(function (i) {
      const v = parseInt(h.substr(i, 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  function onColor(hex) { return contrast(hex, INK_LIGHT) >= contrast(hex, INK_DARK) ? INK_LIGHT : INK_DARK; }

  // 칩 HTML. opts.label 로 보이는 글자를 바꿀 수 있다(색은 name 으로 찾는다).
  function chip(name, opts) {
    const label = esc((opts && opts.label) || name);
    const c = colorOf(name);
    if (!c) return '<span class="lc lc-none">' + label + '</span>';
    return '<span class="lc" style="--lc:' + c + ';--lc-on:' + onColor(c) + '">' + label + '</span>';
  }

  // 순서대로 칩 여러 개(같은 이름이 이어지면 하나만)
  function chips(names) {
    const out = [];
    (names || []).forEach(function (n) { if (n && out[out.length - 1] !== n) out.push(n); });
    return out.map(function (n) { return chip(n); }).join('');
  }

  UG.lines = { COLORS: COLORS, colorOf: colorOf, onColor: onColor, contrast: contrast, chip: chip, chips: chips };
  if (typeof module !== 'undefined' && module.exports) module.exports = UG.lines;
})(typeof globalThis !== 'undefined' ? globalThis : this);
