// check_offline.js — 오프라인 사용(설치·서비스 워커) 설정을 글자와 작은 모의 실행으로 시험한다(docs\graph-format.md 14.2절).
// 사용법(프로젝트 폴더에서): node scripts\check_offline.js
//   1) index.html: manifest·apple-touch-icon 연결, theme-color = manifest = 디자인 토큰 --bg, offline.js 는 app.js 앞
//   2) manifest.webmanifest: 이름·시작 주소·범위·standalone·한국어, 아이콘 파일(PNG 크기가 적힌 것과 같음, maskable 포함)
//   3) sw.js: 판 자리표시 '__VERSION__' 한 줄, pages.yml 이 그 줄을 커밋 번호로 바꾸고 확인함, 데이터 목록 = app.js 의 CFG
//   4) sw.js 를 가짜 self 로 돌려 봄: 요청 종류(Photon·OSRM 은 손대지 않음), 앱 파일 목록(index 의 <script src> 전부), 오래된 것부터 지우기
//   5) offline.js: 등록 조건(서비스 워커 지원·보안 연결·맨 위 창·배포본(?v=)·claude.ai 아님). 미리보기·개발용에서는 등록하지 않음
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let ok = true;
const check = (cond, msg) => { console.log((cond ? 'OK  ' : 'NG  ') + msg); ok = ok && !!cond; };

const html = read('web/index.html');
const appJs = read('web/js/app.js');
const swJs = read('web/sw.js');
const offJs = read('web/js/offline.js');
const yml = read('.github/workflows/pages.yml');

/* ---------- 1) index.html ---------- */
const head = html.slice(0, html.indexOf('<style>'));
check(/<link rel="manifest" href="manifest\.webmanifest">/.test(head), 'index.html 앞부분에 <link rel="manifest" href="manifest.webmanifest">');
check(/<link rel="apple-touch-icon" href="icons\/apple-touch-icon\.png">/.test(head), 'apple-touch-icon 연결');
const themeMeta = (head.match(/<meta name="theme-color" content="([^"]+)">/) || [])[1];
const bgToken = (html.match(/:root \{[\s\S]*?--bg: (#[0-9A-Fa-f]{6});/) || [])[1];
const scripts = [];
html.replace(/<script src="js\/([a-z0-9_-]+)\.js"><\/script>/g, (m, f) => scripts.push(f));
check(scripts.indexOf('offline') >= 0 && scripts.indexOf('offline') < scripts.indexOf('app'), 'offline.js 를 app.js 앞에서 불러옴(app.js 가 시작할 때 UG.offline.init)');
const jsFiles = fs.readdirSync(path.join(ROOT, 'web/js')).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3));
check(jsFiles.every((f) => scripts.indexOf(f) >= 0), `web\\js 의 스크립트 ${jsFiles.length}개가 모두 index.html 에 있음(서비스 워커가 index 의 <script src> 로 앱 파일을 저장한다)`);
check(/UG\.offline\.stage\('interactive'\)/.test(appJs) && /UG\.offline\.stage\('idle'\)/.test(appJs) && /UG\.offline\.init\(/.test(appJs),
  'app.js 가 offline.js 에 알림: init(시작), interactive(첫 화면), idle(뒤로 미룬 자료를 다 받음)');

/* ---------- 2) manifest ---------- */
let man = null;
try { man = JSON.parse(read('web/manifest.webmanifest')); } catch (e) { man = null; }
check(!!man, 'manifest.webmanifest 가 JSON 으로 읽힘');
if (man) {
  check(man.name === '지하로' && man.short_name === '지하로' && man.lang === 'ko', 'name·short_name = 지하로, lang = ko');
  check(man.start_url === './' && man.scope === './' && man.display === 'standalone' && !('id' in man), 'start_url·scope = ./, display = standalone, id 없음(= start_url, 같은 github.io 의 다른 앱과 겹치지 않게)');
  check(man.theme_color === themeMeta && man.background_color === bgToken && themeMeta === bgToken, `theme_color·background_color = <meta theme-color> = 어두운 화면 --bg (${bgToken})`);
  const pngSize = (f) => { const b = fs.readFileSync(f); return b.toString('latin1', 1, 4) === 'PNG' ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null; };
  const icons = man.icons || [];
  const bad = icons.filter((ic) => {
    const f = path.join(ROOT, 'web', ic.src);
    if (!fs.existsSync(f) || ic.type !== 'image/png') return true;
    const s = pngSize(f);
    return !s || ic.sizes !== s[0] + 'x' + s[1];
  });
  check(icons.length >= 3 && bad.length === 0, `아이콘 ${icons.length}개: 파일이 있고 PNG 크기 = sizes` + (bad.length ? ' (틀림: ' + bad.map((b) => b.src).join(', ') + ')' : ''));
  check(icons.some((ic) => ic.sizes === '192x192') && icons.some((ic) => ic.sizes === '512x512' && ic.purpose === 'maskable'), '192 아이콘과 512 maskable 아이콘이 있음');
  const apple = pngSize(path.join(ROOT, 'web/icons/apple-touch-icon.png'));
  check(!!apple && apple[0] === 180 && apple[1] === 180, 'apple-touch-icon.png = 180×180');
}

/* ---------- 3) sw.js 판 표시와 pages.yml ---------- */
const verLines = swJs.split('\n').filter((l) => /^const VERSION = /.test(l));
check(verLines.length === 1 && verLines[0] === "const VERSION = '__VERSION__';", "sw.js 에 판 자리표시 한 줄: const VERSION = '__VERSION__';");
check(yml.indexOf(`sed -i "s/^const VERSION = '__VERSION__';/const VERSION = '\${GITHUB_SHA::7}';/" _site/sw.js`) >= 0 &&
  yml.indexOf(`grep -q "^const VERSION = '\${GITHUB_SHA::7}';" _site/sw.js`) >= 0,
  'pages.yml 이 _site/sw.js 의 판 자리표시를 커밋 번호(스크립트 ?v= 와 같은 7자리)로 바꾸고 바뀌었는지 확인함');
check(/\?v=\$\{GITHUB_SHA::7\}/.test(yml), 'pages.yml 이 스크립트 주소에도 같은 ?v=커밋 번호를 붙임(설치할 때 페이지 판을 맞춰 봄)');
const swData = JSON.parse((swJs.match(/const DATA = (\[[^\]]*\])/) || [])[1].replace(/'/g, '"'));
const cfgData = ['dataUrl', 'basemapUrl', 'placesUrl', 'extraUrl', 'passageUrl', 'egressUrl'].map((k) => (appJs.match(new RegExp(k + ": '([^']+)'")) || [])[1]);
check(swData.length === cfgData.length && cfgData.every((u) => swData.indexOf(u) >= 0), `sw.js 의 데이터 목록 = app.js CFG (${swData.join(', ')})`);

/* ---------- 4) sw.js 를 가짜 self 로 돌려 보기 ---------- */
const SCOPE = 'https://cy7mvpboy.github.io/underground-route/';
const stamped = swJs.replace(/^const VERSION = '__VERSION__';/m, "const VERSION = 'abc1234';");   // pages.yml 의 sed 와 같은 바꾸기
const events = {};
const ctx = vm.createContext({
  self: { registration: { scope: SCOPE }, location: { origin: 'https://cy7mvpboy.github.io', href: SCOPE + 'sw.js' }, addEventListener: (t, f) => { events[t] = f; } },
  URL, Request: function Request(u, o) { this.url = u; Object.assign(this, o); }, setTimeout, console, Promise
});
vm.runInContext(stamped, ctx);
const run = (expr) => vm.runInContext(expr, ctx);
check(['install', 'activate', 'fetch', 'message'].every((t) => typeof events[t] === 'function'), 'install·activate·fetch·message 를 받음');
check(run('CACHE') === 'jiharo-abc1234', '저장소 이름에 판이 들어감: jiharo-abc1234 (켜질 때 다른 jiharo- 판 저장소를 지움)');
const kinds = [
  [SCOPE, 'navigate', 'page'], [SCOPE + '?x=1', 'navigate', 'page'], [SCOPE + 'index.html', 'navigate', 'page'], [SCOPE + 'docs/a.html', 'navigate', null],
  [SCOPE + 'js/app.js?v=abc1234', 'no-cors', 'app'], [SCOPE + 'data/graph.json', 'cors', 'app'], [SCOPE + 'data/places.json', 'cors', 'app'],
  [SCOPE + 'manifest.webmanifest', 'cors', null], [SCOPE + 'icons/icon-192.png', 'no-cors', null], [SCOPE + 'sw.js', 'same-origin', null],
  ['https://cy7mvpboy.github.io/other-repo/js/app.js', 'no-cors', null],
  ['https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js', 'no-cors', 'app'],
  ['https://tile.openstreetmap.org/12/3492/1585.png', 'no-cors', 'tile'],
  ['https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR', 'no-cors', 'font'], ['https://fonts.gstatic.com/s/ibmplexsanskr/v11/a.woff2', 'cors', 'font'],
  ['https://photon.komoot.io/api/?q=%EA%B0%95%EB%82%A8', 'cors', null], ['https://routing.openstreetmap.de/routed-foot/route/v1/foot/127,37;127.1,37.1', 'cors', null]
];
const wrong = kinds.filter(([u, m, k]) => run('kindOf')(u, m) !== k);
check(wrong.length === 0, `요청 종류 ${kinds.length}가지: 페이지·앱 파일·타일·글꼴, Photon·OSRM·manifest·다른 저장소는 손대지 않음` + (wrong.length ? ' (틀림: ' + wrong.map((w) => w[0]).join(', ') + ')' : ''));
const built = '<!doctype html>\n<html lang="ko">\n' + html.replace(/src="js\/([a-z0-9_-]*)\.js"/g, 'src="js/$1.js?v=abc1234"') + '</html>\n';   // pages.yml 처럼
const shell = run('shellUrls')(built);
const jsShell = shell.filter((u) => u.indexOf(SCOPE + 'js/') === 0);
check(shell[0] === SCOPE && jsShell.length === scripts.length && jsShell.every((u) => /\?v=abc1234$/.test(u)) &&
  shell.indexOf('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js') > 0,
  `설치 때 저장할 앱 파일: 페이지 + 스크립트 ${jsShell.length}개(모두 ?v=판) + Leaflet`);
check(built.indexOf('?v=abc1234') >= 0, "설치할 때 맞춰 보는 글자('?v=' + 판)가 배포한 페이지에 있음");
// 오래된 것부터 지우기(trim): 넣은 순서대로 keys() 가 오고, 한도를 넘은 앞쪽을 지운다
const store = ['t1', 't2', 't3', 't4', 't5'];
const fake = { keys: async () => store.slice(), delete: async (k) => { store.splice(store.indexOf(k), 1); return true; } };
run('trim')(fake, 3).then(() => {
  check(store.join(',') === 't3,t4,t5', '저장 개수 한도: 넘으면 먼저 넣은 것부터 지움(타일 400·글꼴 150)');
  check(run('TILE_MAX') === 400 && run('FONT_MAX') === 150, '한도 값: 타일 400, 글꼴 150');

  /* ---------- 5) offline.js 등록 조건 ---------- */
  check(/'serviceWorker' in navigator/.test(offJs) && /root\.top === root\.self/.test(offJs) && /\.register\('sw\.js'\)/.test(offJs) && /\.catch\(/.test(offJs),
    'offline.js: 서비스 워커 지원·맨 위 창을 확인하고 register 실패는 조용히 넘김');
  const allowedIn = (o) => {
    const win = {
      isSecureContext: o.secure !== false, location: { hostname: o.host || 'cy7mvpboy.github.io' },
      document: { currentScript: { src: o.src || 'https://cy7mvpboy.github.io/underground-route/js/offline.js?v=abc1234' }, getElementById: () => null }
    };
    win.self = win; win.top = o.framed ? {} : win;
    const nav = o.noSw ? {} : { serviceWorker: {} };
    const c2 = vm.createContext({ globalThis: win, navigator: nav });
    vm.runInContext(offJs, c2);
    return win.UG.offline.allowed();
  };
  check(allowedIn({}) === true, '배포본(github.io, ?v=판, 맨 위 창): 등록함');
  check(allowedIn({ src: 'https://x.claudeusercontent.com/js/offline.js' }) === false, '판 표시(?v=)가 없는 사본(개발용·미리보기): 등록하지 않음');
  check(allowedIn({ framed: true }) === false, 'iframe 안(claude.ai 미리보기처럼): 등록하지 않음');
  check(allowedIn({ host: 'abc.claudeusercontent.com' }) === false && allowedIn({ host: 'claude.ai' }) === false, 'claude.ai·claudeusercontent.com: 등록하지 않음');
  check(allowedIn({ noSw: true }) === false && allowedIn({ secure: false }) === false, '서비스 워커가 없거나 보안 연결이 아니면 등록하지 않음');

  process.exitCode = ok ? 0 : 1;
  console.log(ok ? '\n모두 통과' : '\n실패 있음');
});
