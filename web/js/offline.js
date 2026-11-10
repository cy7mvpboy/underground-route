/* offline.js — 오프라인 사용: 서비스 워커(sw.js) 등록과 그 상태 보이기 (docs\graph-format.md 14.2절)
   - 배포본(스크립트 주소에 ?v=판, pages.yml 이 붙임)이고 맨 위 창일 때만 sw.js 를 등록한다.
     claude.ai 미리보기(iframe)·개발용 서버에서는 등록하지 않고 정보 탭 줄도 숨긴다(예전과 같다).
   - 등록은 첫 화면이 뜬 뒤(app.js 가 stage('interactive')), 데이터 저장은 뒤로 미룬 자료를 다 받은 뒤(stage('idle')).
     첫 로딩과 겨루지 않는다(14.1절). 데이터는 방금 받은 것이라 대부분 브라우저 캐시에서 온다.
   - 정보 탭 '오프라인 준비' 줄: 준비 중 · 준비됨(크기) · 멈춤(인터넷이 되면 이어서) · 새 버전.
     '홈 화면에 추가' 단추(안드로이드 Chrome 의 beforeinstallprompt), iOS 는 한 줄 안내.
   - 인터넷이 끊기면 검색 막대에 '오프라인' 표시(navigator.onLine).
   - 새 판: 뒤에서 설치되면 알림 한 줄. 적용은 앱을 다시 열 때 한 번 다시 불러와서(길 안내 중에는 하지 않는다). */
(function (root) {
  'use strict';
  const UG = root.UG = root.UG || {};
  const doc = root.document;
  const me = doc && doc.currentScript;
  const VER = me ? (/[?&]v=([\w-]+)/.exec(me.src) || [])[1] : null;   // 배포본 판. 없으면 개발용

  const TEXT = {
    busy: '오프라인 준비 중', ready: '오프라인 사용 준비됨', paused: '오프라인 준비 멈춤 · 연결되면 이어서',
    updated: '새 버전 받음 · 다시 열면 적용', toast: '새 버전 — 다시 열면 적용'
  };
  let opts = {}, ui = null, last = null, failed = false, idle = false, updated = false, reloading = false, installEv = null, persisted = false;
  const noop = function () { /* 무시 */ };

  // 서비스 워커를 쓸 곳인지: 지원, 보안 연결(https·localhost), 맨 위 창(claude.ai 미리보기는 iframe), 배포본
  function allowed() {
    let top = false;
    try { top = root.top === root.self; } catch (e) { top = false; }
    return !!(VER && 'serviceWorker' in navigator && root.isSecureContext && top && !/(^|\.)claude(usercontent)?\.(ai|com)$/.test(root.location.hostname));
  }

  // app.js boot 에서: o = { toast(글, ms), busy() = 길 안내 중인지 }
  function init(o) {
    opts = o || {};
    const $ = function (id) { return doc.getElementById(id); };
    ui = { chip: $('net-chip'), row: $('off-row'), text: $('off-text'), install: $('off-install'), ios: $('off-ios') };
    if (!ui.chip || !ui.row) { ui = null; return; }
    const syncNet = function () { ui.chip.hidden = navigator.onLine !== false; };
    root.addEventListener('offline', syncNet);
    root.addEventListener('online', function () {
      syncNet();
      if (!allowed()) return;
      navigator.serviceWorker.getRegistration().then(function (r) { if (r) r.update().catch(noop); }).catch(noop);
      if (idle) send(fillMsg());   // 끊겨서 멈췄던 데이터 저장을 잇는다
    });
    syncNet();
    if (!allowed()) return;
    ui.row.hidden = false;
    render();
    setupInstall();
    const sw = navigator.serviceWorker;
    sw.addEventListener('message', function (ev) {
      const d = ev.data;
      if (!d || d.type !== 'state') return;
      last = d;
      if (d.filling) failed = false;
      if (d.done) failed = !!d.failed && !d.ready;
      render();
      // 설치한 앱으로 열었으면 저장 공간이 부족해도 지우지 않게 브라우저에 한 번 부탁한다
      if (d.ready && !persisted && isStandalone() && navigator.storage && navigator.storage.persist) { persisted = true; navigator.storage.persist().catch(noop); }
    });
    if (sw.startMessages) sw.startMessages();
    sw.addEventListener('controllerchange', function () { if (reloading) root.location.reload(); });
    // 지난번에 설치해 둔 새 판이 기다리고 있으면 지금(앱을 막 열었을 때) 적용하고 한 번 다시 불러온다
    sw.getRegistration().then(function (r) {
      if (!r || !r.waiting || !sw.controller || busy()) return;
      reloading = true;
      r.waiting.postMessage({ type: 'activate' });
    }).catch(noop);
  }

  // app.js 가 알려 주는 단계: 'interactive'(첫 화면이 뜸) · 'idle'(뒤로 미룬 자료를 다 받음)
  function stage(name) {
    if (!ui || !allowed()) return;
    if (name === 'interactive') register();
    if (name === 'idle') { idle = true; send(fillMsg()); }
  }

  // 데이터 저장 부탁. 지금까지 쓴 글꼴도 알려 준다(서비스 워커가 맡기 전에 받은 글꼴도 저장하게):
  // 글꼴 CSS 주소와, 받은 글꼴 조각의 '굵기|글자 범위'(글꼴 파일 주소는 화면에서 알 수 없어 서비스 워커가 CSS 에서 찾는다)
  function fillMsg() {
    const css = [], faces = [];
    try {
      performance.getEntriesByType('resource').forEach(function (e) { if (e.name.indexOf('https://fonts.googleapis.com/') === 0) css.push(e.name); });
      doc.fonts.forEach(function (f) { if (f.status === 'loaded') faces.push(f.weight + '|' + f.unicodeRange); });
    } catch (e) { /* 없어도 된다 */ }
    return { type: 'fill', css: css, faces: faces };
  }

  function register() {
    navigator.serviceWorker.register('sw.js').then(function (r) {
      // 새 판이 뒤에서 설치되면(이미 다른 판이 이 화면을 맡고 있을 때) 알림 한 줄
      const watch = function () {
        const w = r.installing;
        if (w) w.addEventListener('statechange', function () {
          if (w.state === 'installed' && navigator.serviceWorker.controller) newVersion();
          if (w.state === 'redundant' && !r.active) { failed = true; render(); }   // 처음 설치 실패(인터넷 끊김·저장 공간 부족): 다음에 열 때 다시
        });
      };
      r.addEventListener('updatefound', watch);
      watch();
      if (r.waiting && navigator.serviceWorker.controller && !reloading) newVersion();
      send({ type: 'status' });
    }).catch(function () { ui.row.hidden = true; });   // 등록이 막힌 곳: 예전처럼
  }

  // 이 화면을 맡은(없으면 켜질) 서비스 워커에게 말하기
  function send(msg) {
    navigator.serviceWorker.ready.then(function (r) { if (r.active) r.active.postMessage(msg); }).catch(noop);
  }

  function newVersion() {
    if (updated) return;
    updated = true;
    render();
    if (!busy() && opts.toast) opts.toast(TEXT.toast, 8000);   // 길 안내 중이면 알림 없이 정보 탭에만
  }

  function busy() { try { return !!(opts.busy && opts.busy()); } catch (e) { return false; } }
  function isStandalone() { return root.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
  function mb(b) { return (b / 1048576).toFixed(1) + 'MB'; }

  // 정보 탭 줄: data-state = busy(회색 점) · ready(청록) · paused(호박색)
  function render() {
    if (!ui || ui.row.hidden) return;
    let state = 'busy', text = TEXT.busy + (last && last.bytes ? ' · ' + mb(last.bytes) : '');
    if (updated) { state = 'ready'; text = TEXT.updated; }
    else if (last && last.ready) { state = 'ready'; text = TEXT.ready + ' · ' + mb(last.bytes); }
    else if (failed) { state = 'paused'; text = TEXT.paused; }
    ui.row.dataset.state = state;
    ui.text.textContent = text;
  }

  // 홈 화면에 추가: 안드로이드 Chrome 은 설치할 수 있을 때 beforeinstallprompt 가 온다. iOS 는 공유 메뉴로만 된다
  function setupInstall() {
    if (isStandalone()) return;   // 이미 설치한 앱으로 열었다
    root.addEventListener('beforeinstallprompt', function (ev) { ev.preventDefault(); installEv = ev; ui.install.hidden = false; });
    root.addEventListener('appinstalled', function () { installEv = null; ui.install.hidden = true; });
    ui.install.addEventListener('click', function () {
      if (!installEv) return;
      installEv.prompt();   // 브라우저의 설치 창(한 번만 쓸 수 있다)
      installEv = null;
      ui.install.hidden = true;
    });
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    ui.ios.hidden = !ios;
  }

  UG.offline = { init: init, stage: stage, allowed: allowed, state: function () { return { last: last, failed: failed, updated: updated }; } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
