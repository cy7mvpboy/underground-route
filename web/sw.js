/* sw.js — 서비스 워커: 한 번 열면 앱과 데이터를 기기에 저장해 인터넷 없이 동작하게 한다(docs\graph-format.md 14.2절).
   - 판(VERSION): 배포할 때 pages.yml 이 아래 '__VERSION__' 을 커밋 번호(7자리)로 바꾼다. 판마다 저장소(캐시)가 하나다: 'jiharo-<판>'.
     sw.js 글자가 바뀌면 브라우저가 앱을 열 때 새 판을 뒤에서 설치한다.
   - 설치(install): index 페이지와 그 안의 <script src>(js/*.js, Leaflet)를 저장한다.
     예전 판의 데이터(data/*.json)가 있으면 서버에 바뀌었는지 물어(If-None-Match) 안 바뀌었으면 그대로 옮기고, 바뀌었으면 새로 받는다.
     새 판은 바로 쓰지 않고 기다린다(지금 쓰는 화면에 새 데이터가 섞이지 않게). 앱을 다시 열 때 적용한다(offline.js).
   - 처음 설치 때 데이터는 앱이 첫 화면과 뒤로 미룬 자료를 다 받은 뒤 받는다(offline.js 의 'fill'). 대부분 브라우저 캐시에서 온다.
   - 응답: 앱(페이지·스크립트·데이터)은 저장한 것 먼저. 배경 지도 타일·글꼴은 받을 때 저장해 두고(개수 제한),
     인터넷이 안 되거나 4초 안에 안 오면 저장한 것을 쓴다. 타일은 사용자가 본 것만 저장한다(미리 받지 않음, OSM 타일 사용 정책).
     Photon(장소 검색)·OSRM(도보 길)은 손대지 않는다(walk.js 가 따로 저장한다).
   - 화면과 주고받는 말(postMessage): 'status'(준비 상태 묻기) · 'fill'(데이터 받기, 화면이 이미 쓴 글꼴도 함께) · 'activate'(기다리는 새 판 적용).
     답은 { type: 'state', version, ready, bytes, filling } (fill 을 다 돌면 done·failed 를 더한다). */
'use strict';

const VERSION = '__VERSION__';
const CACHE = 'jiharo-' + VERSION;                     // 앱(페이지·스크립트·데이터): 판마다 하나
const TILES = 'jiharo-tiles', FONTS = 'jiharo-fonts';  // 판이 바뀌어도 두는 것
const TILE_MAX = 400, FONT_MAX = 150;                  // 저장 개수 한도(넘으면 오래된 것부터 지운다)
const WAIT_MS = 4000;                                  // 타일·글꼴 CSS: 저장한 것이 있으면 이만큼만 인터넷을 기다린다
// app.js 의 CFG 와 같은 목록(scripts\check_offline.js 가 확인한다)
const DATA = ['data/graph.json', 'data/basemap.json', 'data/extra.json', 'data/egress.json', 'data/passage.json', 'data/places.json'];
const SCOPE = self.registration.scope;                 // 예: https://cy7mvpboy.github.io/underground-route/
const PAGE = SCOPE;                                    // index 페이지(= './')

/* ---------- 요청 종류 ---------- */
// 'page'(index 페이지 열기) · 'app'(js/*.js·데이터·Leaflet) · 'tile' · 'font' · null(손대지 않음)
function kindOf(url, mode) {
  if (url.indexOf(SCOPE) === 0) {
    const path = url.slice(SCOPE.length).split('?')[0];
    if (mode === 'navigate') return path === '' || path === 'index.html' ? 'page' : null;
    return path.indexOf('js/') === 0 || DATA.indexOf(path) >= 0 ? 'app' : null;
  }
  const host = new URL(url).hostname;
  if (host === 'cdnjs.cloudflare.com') return 'app';
  if (host === 'tile.openstreetmap.org') return 'tile';
  if (host === 'fonts.googleapis.com' || host === 'fonts.gstatic.com') return 'font';
  return null;
}

// index 페이지 글에서 <script src="..."> 주소를 모두 찾는다(js/*.js?v=판, Leaflet). 앞에 페이지 주소
function shellUrls(html) {
  const out = [PAGE], re = /<script src="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) out.push(new URL(m[1], PAGE).href);
  return out;
}

// 다른 곳(cdnjs·글꼴·타일)의 no-cors 요청은 CORS 요청으로 다시 만든다.
// 내용을 볼 수 없는 응답(opaque)은 브라우저가 저장 공간을 크게(수 MB) 잡기 때문이다. 세 곳 모두 CORS 를 허용한다.
function cors(req) {
  const other = new URL(req.url).origin !== self.location.origin;
  return other && req.mode === 'no-cors' ? new Request(req.url, { mode: 'cors', credentials: 'omit' }) : req;
}

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* ---------- 설치 · 켜기 ---------- */
self.addEventListener('install', function (ev) { ev.waitUntil(install()); });

async function install() {
  const cache = await caches.open(CACHE);
  // 1) index 페이지: 브라우저 캐시를 믿지 않고 서버에 확인한다. 이 판의 페이지가 아니면(아직 예전 것이 오면) 설치를 그만두고 다음에 다시
  const page = await fetch(PAGE, { cache: 'no-cache' });
  if (!page.ok) throw new Error('page ' + page.status);
  const html = await page.clone().text();
  if (VERSION.indexOf('__') !== 0 && html.indexOf('?v=' + VERSION) < 0) throw new Error('page is not ' + VERSION);
  // 2) 스크립트: 하나라도 못 받으면 설치하지 않는다(반쪽 앱을 저장하지 않게)
  const urls = shellUrls(html).slice(1);
  const got = await Promise.all(urls.map(function (u) {
    return fetch(u).then(function (r) { if (!r.ok) throw new Error(u + ' ' + r.status); return r; });   // fetch 는 CORS 요청(Leaflet 도 내용이 보이는 응답)
  }));
  await cache.put(PAGE, page);
  await Promise.all(got.map(function (r, i) { return cache.put(urls[i], r); }));
  // 3) 예전 판의 데이터를 옮긴다(안 바뀌었으면 받지 않는다)
  await carryData(cache);
}

async function carryData(cache) {
  for (const u of DATA) {
    const url = new URL(u, SCOPE).href;
    const old = await caches.match(url, { ignoreVary: true });   // 새 저장소는 아직 비어 있으니 예전 판 것
    if (!old) continue;                                          // 없으면 나중에 fill 이 받는다
    const h = {};
    if (old.headers.get('etag')) h['If-None-Match'] = old.headers.get('etag');
    else if (old.headers.get('last-modified')) h['If-Modified-Since'] = old.headers.get('last-modified');
    const res = await fetch(url, { headers: h, cache: 'no-store' });
    if (res.status === 304) await cache.put(url, old);
    else if (res.ok) await cache.put(url, res);
    else throw new Error(url + ' ' + res.status);
  }
}

// 켜질 때: 예전 판 저장소를 지우고 열린 화면을 맡는다
self.addEventListener('activate', function (ev) {
  ev.waitUntil((async function () {
    const keep = [CACHE, TILES, FONTS];
    for (const k of await caches.keys()) if (k.indexOf('jiharo-') === 0 && keep.indexOf(k) < 0) await caches.delete(k);
    await self.clients.claim();
  })());
});

/* ---------- 응답 ---------- */
self.addEventListener('fetch', function (ev) {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const kind = kindOf(req.url, req.mode);
  if (kind === 'page') ev.respondWith(fromCache(PAGE, req));
  else if (kind === 'app') ev.respondWith(fromCache(req.url, req));
  else if (kind === 'tile') ev.respondWith(runtime(req, TILES, TILE_MAX, false));
  else if (kind === 'font') ev.respondWith(runtime(req, FONTS, FONT_MAX, new URL(req.url).hostname === 'fonts.gstatic.com'));
  // 그 밖(Photon·OSRM·manifest·아이콘)은 손대지 않는다: 브라우저가 평소처럼 받는다
});

// 앱 파일: 저장한 것 먼저. 없으면 받아서 이 판 저장소에 넣는다(페이지는 설치 때만 넣는다)
async function fromCache(key, req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(key, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(cors(req));
  if (res.ok && key !== PAGE) cache.put(key, res.clone()).catch(function () { /* 저장 공간 부족 등 */ });
  return res;
}

// 타일·글꼴: 받으면 저장해 둔다. 저장한 것이 있으면 인터넷이 안 되거나 WAIT_MS 안에 안 올 때 그것을 쓴다.
// cacheFirst = 글꼴 파일(주소마다 내용이 바뀌지 않음): 저장한 것을 바로 쓴다.
async function runtime(req, name, max, cacheFirst) {
  const cache = await caches.open(name);
  const copy = await cache.match(req.url, { ignoreVary: true });
  if (copy && cacheFirst) return copy;
  const net = fetch(cors(req)).catch(function () { return fetch(req); }).then(function (res) {
    if (res.ok) keep(cache, name, max, req.url, res.clone());
    return res;
  });
  if (!copy) return net;
  return Promise.race([
    net.then(function (r) { return r.ok ? r : copy; }, function () { return copy; }),
    wait(WAIT_MS).then(function () { return copy; })
  ]);
}

// 저장하고 가끔(20번에 한 번) 한도를 넘은 만큼 오래된 것부터 지운다. 다시 받은 타일은 맨 뒤로 가므로 '최근에 본 것'이 남는다
const puts = {};
function keep(cache, name, max, url, res) {
  cache.put(url, res).then(function () {
    puts[name] = (puts[name] || 0) + 1;
    if (puts[name] % 20 === 1) return trim(cache, max);
  }).catch(function () { /* 무시 */ });
}
async function trim(cache, max) {
  const keys = await cache.keys();                     // 넣은 순서
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

/* ---------- 데이터 받기 · 상태 ---------- */
let filling = null;
const absent = new Set();                              // 서버에 없는 데이터(404): 없어도 앱이 동작하는 파일

self.addEventListener('message', function (ev) {
  const type = ev.data && ev.data.type;
  if (type === 'activate') self.skipWaiting();
  else if (type === 'status') ev.waitUntil(status().then(function (s) { if (ev.source) ev.source.postMessage(s); }));
  else if (type === 'fill') ev.waitUntil(Promise.all([fill(), keepFonts(ev.data.css, ev.data.faces)]));
});

// 아직 저장하지 않은 데이터를 하나씩 받는다(한 번에 하나: 다른 요청과 겨루지 않게). 하나 받을 때마다 화면에 알린다
function fill() {
  if (filling) return filling;
  filling = (async function () {
    const cache = await caches.open(CACHE);
    let failed = false;
    for (const u of DATA) {
      const url = new URL(u, SCOPE).href;
      if (await cache.match(url, { ignoreVary: true })) continue;
      try {
        const res = await fetch(url);
        if (res.ok) { await cache.put(url, res); absent.delete(u); } else if (res.status === 404) absent.add(u); else failed = true;
      } catch (e) { failed = true; }                   // 인터넷 끊김: 다음에 이어서
      tell(await status());
    }
    return failed;
  })().then(async function (failed) {
    filling = null;
    tell(Object.assign(await status(), { done: true, failed: failed }));   // 다 돌았다: 못 받은 것이 있으면 failed
  }, function () { filling = null; });
  return filling;
}

// 첫 방문 때 서비스 워커가 맡기 전에 받은 글꼴도 저장한다: 처음 연 뒤 바로 인터넷이 끊겨도 같은 글꼴로 보이게.
// css = 화면이 받은 글꼴 CSS 주소, faces = 화면에 쓴 글꼴 조각('굵기|글자 범위'). 다른 곳의 CSS 가 받은 글꼴 파일은
// 주소가 화면에 보이지 않아(Resource Timing 에 안 나옴), CSS 에서 굵기·글자 범위가 같은 @font-face 의 파일을 찾는다.
// 방금 받은 것이라 글꼴 파일은 브라우저 캐시에서 온다
async function keepFonts(css, faces) {
  if (!Array.isArray(css) || !Array.isArray(faces)) return;
  const cache = await caches.open(FONTS);
  const want = new Set(faces.map(norm));
  const save = async function (u) {
    if (kindOf(u) !== 'font' || await cache.match(u, { ignoreVary: true })) return;
    try { const res = await fetch(u, { mode: 'cors', credentials: 'omit' }); if (res.ok) await cache.put(u, res); } catch (e) { /* 다음에 */ }
  };
  for (const u of css.slice(0, 5)) {
    if (typeof u !== 'string' || u.indexOf('https://fonts.googleapis.com/') !== 0) continue;
    await save(u);
    const res = await cache.match(u, { ignoreVary: true });
    if (!res) continue;
    for (const block of (await res.text()).split('@font-face').slice(1)) {
      const w = /font-weight:\s*(\d+)/.exec(block), r = /unicode-range:\s*([^;]+);/.exec(block), f = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/.exec(block);
      if (w && r && f && want.has(norm(w[1] + '|' + r[1]))) await save(f[1]);
    }
  }
  await trim(cache, FONT_MAX);
}
function norm(s) { return String(s).toUpperCase().replace(/\s+/g, ''); }   // 'U+ac00-d7a3, U+20' -> 'U+AC00-D7A3,U+20'

// 준비 상태: 페이지와 데이터가 모두 있으면 ready. bytes = 이 판 저장소 크기(페이지·스크립트·데이터)
async function status() {
  const cache = await caches.open(CACHE);
  let bytes = 0;
  for (const req of await cache.keys()) {
    const r = await cache.match(req);
    if (r) bytes += (await r.blob()).size;
  }
  const has = async function (u) { return !!(await cache.match(new URL(u, SCOPE).href, { ignoreVary: true })); };
  let ready = await has('./');
  for (const u of DATA) if (!absent.has(u) && !(await has(u))) ready = false;
  return { type: 'state', version: VERSION, ready: ready, bytes: bytes, filling: !!filling };
}

function tell(msg) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    list.forEach(function (c) { c.postMessage(msg); });
  });
}
