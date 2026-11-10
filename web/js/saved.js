/* saved.js — 이 브라우저에만 저장하는 것 (localStorage. 못 쓰면 저장 없이 동작한다)
   - 설정(pref): 걷는 속도, 레이어, 마지막 지도 보기, 화면 테마, 첫 안내를 읽었는지
   - 저장한 장소: '집', '가족 약속 장소'(각각 하나) + 사용자가 이름을 붙인 장소
   - 최근 검색: 최근에 고른 검색 결과 8개
   장소 모양: { id, name(저장 이름), title(장소 이름), sub, kind: 'station'|'point', si?, lat, lon } */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};

  const HOME = '집', FAMILY = '가족 약속 장소';
  const KEY_SAVED = 'ugmap.saved.v1', KEY_RECENT = 'ugmap.recent.v1', RECENT_MAX = 8;

  function get(key, def) {
    try { const v = JSON.parse(root.localStorage.getItem(key) || 'null'); return v == null ? def : v; } catch (e) { return def; }
  }
  function set(key, v) { try { root.localStorage.setItem(key, JSON.stringify(v)); return true; } catch (e) { return false; } }

  // 검색 결과·지도 지점 -> 저장할 모양(필요한 값만)
  function clean(r) {
    const o = { title: String(r.title || ''), sub: String(r.sub || ''), kind: r.kind === 'station' ? 'station' : 'point', lat: +r.lat, lon: +r.lon };
    if (o.kind === 'station') o.si = +r.si;
    return o;
  }
  function valid(p) { return p && p.title && isFinite(p.lat) && isFinite(p.lon); }

  /* ---------- 저장한 장소 ----------
     시연(demo.js) 동안에는 useMemory(true): 저장한 장소를 이 브라우저 저장소 대신 메모리 목록에 둔다.
     보는 사람이 저장해 둔 장소는 읽지도 바꾸지도 않고, 시연을 끝내면(useMemory(false)) 그대로 돌아온다. */
  let memory = null;   // null = 브라우저 저장소를 쓴다, 배열 = 시연용 메모리 목록
  function useMemory(on) { memory = on ? [] : null; }
  function store(list) { if (memory) { memory = list; return true; } return set(KEY_SAVED, list); }
  function places() {
    const list = memory || get(KEY_SAVED, []);
    return Array.isArray(list) ? list.filter(valid) : [];
  }
  // 같은 저장 이름이 있으면 바꾼다. 돌려주는 값: 저장했으면 true(저장소를 못 쓰면 false)
  function savePlace(name, r) {
    name = String(name || '').trim().slice(0, 20);
    if (!name || !valid(r)) return false;
    const list = places().filter(function (p) { return p.name !== name; });
    const p = Object.assign(clean(r), { id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name });   // 같은 순간에 둘을 저장해도 겹치지 않게
    // 집 -> 가족 약속 장소 -> 나머지(저장한 순서) 순으로 둔다
    list.push(p);
    list.sort(function (a, b) { return rank(a) - rank(b); });
    return store(list);
  }
  function rank(p) { return p.name === HOME ? 0 : p.name === FAMILY ? 1 : 2; }
  function removePlace(id) { return store(places().filter(function (p) { return p.id !== id; })); }
  function placeByName(name) { return places().find(function (p) { return p.name === name; }) || null; }

  /* ---------- 최근 검색 ---------- */
  function recent() {
    const list = get(KEY_RECENT, []);
    return Array.isArray(list) ? list.filter(valid) : [];
  }
  function addRecent(r) {
    if (!valid(r)) return;
    const o = clean(r);
    const same = function (p) { return p.title === o.title && Math.abs(p.lat - o.lat) < 0.0005 && Math.abs(p.lon - o.lon) < 0.0005; };
    set(KEY_RECENT, [o].concat(recent().filter(function (p) { return !same(p); })).slice(0, RECENT_MAX));
  }
  function clearRecent() { set(KEY_RECENT, []); }

  UG.saved = {
    HOME: HOME, FAMILY: FAMILY, get: get, set: set,
    places: places, savePlace: savePlace, removePlace: removePlace, placeByName: placeByName, useMemory: useMemory,
    recent: recent, addRecent: addRecent, clearRecent: clearRecent
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
