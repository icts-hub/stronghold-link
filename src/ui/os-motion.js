/* ============================================================================
   Stronghold Link — 空间桌面的持续动效与真实读数
   ----------------------------------------------------------------------------
   一条 rAF 驱动全部：鼠标视差、玻璃反光、帧率统计。
   其余为 1s / 3s / 10s / 20s 定时器，页面隐藏即暂停。
   所有显示值都取自真实来源，取不到就保留 — ，不编造数字。
   ========================================================================= */
(function () {
  'use strict';

  var api = window.strongholdLink || null;
  var root = document.documentElement;
  var $ = function (id) { return document.getElementById(id); };
  var set = function (id, text) {
    var el = $(id);
    if (!el) return;
    var s = String(text);
    if (el.textContent !== s) el.textContent = s;
  };
  function reduce() {
    try { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  }
  /* 设置页里的动效强度优先于系统偏好，读的是 <html data-motion> */
  function userReduced() {
    try { return document.documentElement.getAttribute('data-motion') === 'reduced'; }
    catch (e) { return false; }
  }
  var REDUCED = reduce() || userReduced();
  /* 本机系统默认开启"减少动效"，截图与实测需要 --force-motion（等价于 URL 带 motion=force） */
  try {
    if (typeof location !== 'undefined' && String(location.search || '').indexOf('motion=force') >= 0) REDUCED = false;
  } catch (e) { /* 忽略 */ }
  try {
    window.addEventListener('shl-motion', function (ev) {
      REDUCED = (!(ev && ev.detail === 'full')) && (userReduced() || reduce());
    });
  } catch (e) { /* 忽略 */ }

  /* 活动状态广播：stage.js 订阅，最小化时确实停帧 */
  window.__shlActivity = window.__shlActivity || [];
  function broadcastActivity(active) {
    root.classList.toggle('shl-paused', !active);
    window.__shlActivity.forEach(function (fn) { try { fn(active); } catch (e) { /* 忽略 */ } });
  }

  /* ── 1 · 时间 ────────────────────────────────────────────────────────── */
  var WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  var BOOT = Date.now();
  function pad(n) { return String(n).padStart(2, '0'); }

  function clockTick() {
    var d = new Date();
    var t = $('osClockTime');
    if (t) {
      var html = pad(d.getHours()) + ':' + pad(d.getMinutes())
        + '<small>' + pad(d.getSeconds()) + '</small>';
      if (t.innerHTML !== html) t.innerHTML = html;
    }
    set('osClockDate', d.getFullYear() + '.' + pad(d.getMonth() + 1) + '.' + pad(d.getDate()));
    set('osClockWeek', WEEK[d.getDay()]);

    var year = d.getFullYear();
    set('osWorkBig', year);
    var start = new Date(year, 0, 1);
    var end = new Date(year + 1, 0, 1);
    var doy = Math.floor((d - start) / 86400000) + 1;
    var total = Math.round((end - start) / 86400000);
    var pct = (doy / total) * 100;
    var bar = $('osWorkBar');
    if (bar) bar.style.setProperty('--os-year', pct.toFixed(1) + '%');
    set('osWorkDayOfYear', '第 ' + doy + ' / ' + total + ' 天 · ' + pct.toFixed(1) + '%');
  }

  function uptimeTick() {
    var s = Math.floor((Date.now() - BOOT) / 1000);
    var text = pad(Math.floor(s / 3600)) + ':' + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60);
    set('osUptime', text);
    set('osUptimeStrip', text);
  }

  /* ── 2 · 真实状态读数 ────────────────────────────────────────────────── */
  function readInto(src, dst, transform) {
    var a = $(src);
    if (!a) return;
    var apply = function () {
      var v = (a.textContent || '').trim();
      set(dst, transform ? transform(v) : v);
    };
    apply();
    try {
      new MutationObserver(apply).observe(a, { childList: true, characterData: true, subtree: true });
    } catch (e) { /* 忽略 */ }
  }

  function mirror() {
    var digits = function (v) {
      var m = String(v).match(/\d+/);
      return m ? String(Number(m[0])) : v;
    };
    readInto('globalStatus', 'osAuth');
    readInto('sessionState', 'homeState');
    readInto('sessionState', 'osSessionState');
    readInto('detailEndpoint', 'homeEndpoint');
    readInto('profileCount', 'homeProfiles', digits);
    readInto('profileCount', 'osProfiles', digits);
    readInto('netLocal', 'osNetLocal');
  }

  function paint3d() {
    var has = root.classList.contains('has-3d');
    set('os3d', has ? 'READY' : 'CSS ONLY');
  }
  function paintBuild() {
    set('osFootBuild', 'BUILD v' + (window.__shlVersion || '—'));
    set('appVersion', window.__shlVersion || '—');
  }

  function pollMetrics() {
    if (!api || !api.app || typeof api.app.metrics !== 'function') return;
    api.app.metrics().then(function (m) {
      if (!m) return;
      var n = Number(m.totalMB);
      set('osProc', isFinite(n) && n > 0 ? (n + ' MB') : '—');
    }).catch(function () { /* 忽略 */ });
  }

  function pollProviders() {
    if (!api || !api.adapters || typeof api.adapters.list !== 'function') return;
    api.adapters.list().then(function (list) {
      if (!Array.isArray(list) || !list.length) return;
      var up = list.filter(function (a) { return a && a.status === 'running'; }).length;
      set('homeProviders', up + ' / ' + list.length);
    }).catch(function () { /* 忽略 */ });
  }

  /* ── 3 · 进行中模块 ──────────────────────────────────────────────────── */
  var TODAY = [
    { n: '01', t: '服务库', s: 'library', view: 'library' },
    { n: '02', t: '会话', s: 'session', view: 'session' },
    { n: '03', t: '网络自检', s: 'network', view: 'network' }
  ];

  function buildToday() {
    var box = $('osTodayList');
    if (!box) return;
    box.innerHTML = TODAY.map(function (it) {
      return '<div class="ostoday__i" data-go="' + it.view + '" role="button" tabindex="0">'
        + '<span class="ostoday__n">' + it.n + '</span>'
        + '<span class="ostoday__t">' + it.t + '</span>'
        + '<span class="ostoday__s" data-s="' + it.s + '">—</span></div>';
    }).join('');
    box.addEventListener('click', function (ev) {
      var row = ev.target && ev.target.closest ? ev.target.closest('[data-go]') : null;
      if (row && typeof window.showView === 'function') window.showView(row.dataset.go);
    });
    box.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      var row = ev.target && ev.target.closest ? ev.target.closest('[data-go]') : null;
      if (row) { ev.preventDefault(); if (typeof window.showView === 'function') window.showView(row.dataset.go); }
    });
  }

  function paintToday() {
    var box = $('osTodayList');
    if (!box) return;
    var n = $('profileCount');
    var c = n ? (n.textContent.match(/\d+/) || ['0'])[0] : '0';
    var st = $('sessionState');
    var state = st ? (st.textContent || '').trim().toUpperCase() : 'IDLE';
    var running = state !== 'IDLE' && state !== '' && state !== '—';
    var map = {
      library: c + ' 项',
      session: state,
      network: ($('netLocal') && ($('netLocal').textContent || '').trim() !== '—') ? 'READY' : 'PENDING'
    };
    box.querySelectorAll('[data-s]').forEach(function (el) {
      var v = map[el.dataset.s] || '—';
      if (el.textContent !== v) el.textContent = v;
      var row = el.closest('.ostoday__i');
      if (row) row.classList.toggle('is-on', el.dataset.s === 'session' && running);
    });
    var on = 0;
    if (Number(c) > 0) on += 1;
    if (running) on += 1;
    if (map.network === 'READY') on += 1;
    set('osTodayCount', on + ' / 3');
  }

  /* ── 4 · 当前视图 ────────────────────────────────────────────────────── */
  var VIEW_LABEL = {
    home: 'HOME', library: 'LIBRARY', session: 'SESSION',
    network: 'NETWORK', adapters: 'ADAPTERS', friends: 'FRIENDS', settings: 'SETTINGS'
  };
  function syncView() {
    var btn = document.querySelector('.rail.dock .nav button.active') || document.querySelector('[data-view].active');
    var name = (btn && btn.dataset && btn.dataset.view) || 'home';
    root.classList.toggle('os-home', name === 'home');
    set('osWorkIndex', VIEW_LABEL[name] || name.toUpperCase());
  }

  /* ── 5 · 一条 rAF：视差 + 反光 + 帧率 ───────────────────────────────── */
  var targetX = 0, targetY = 0;     // 归一化 -1..1
  var curX = 0, curY = 0;
  var mx = 50, my = 50, tmx = 50, tmy = 50;
  var frames = 0, fpsMark = 0;
  var MAX_PX = 4;

  if (!REDUCED) {
    window.addEventListener('mousemove', function (ev) {
      var w = window.innerWidth || 1, h = window.innerHeight || 1;
      targetX = (ev.clientX / w - 0.5) * 2;
      targetY = (ev.clientY / h - 0.5) * 2;
      tmx = (ev.clientX / w) * 100;
      tmy = (ev.clientY / h) * 100;
    }, { passive: true });
    window.addEventListener('mouseleave', function () { targetX = 0; targetY = 0; }, { passive: true });
  }

  function loop(now) {
    requestAnimationFrame(loop);
    if (document.hidden) return;
    frames += 1;
    if (!fpsMark) fpsMark = now;
    if (now - fpsMark >= 1000) {
      set('osFps', Math.round((frames * 1000) / (now - fpsMark)));
      frames = 0; fpsMark = now;
    }
    if (REDUCED) return;
    curX += (targetX - curX) * 0.06;
    curY += (targetY - curY) * 0.06;
    mx += (tmx - mx) * 0.08;
    my += (tmy - my) * 0.08;
    var px = (curX * MAX_PX).toFixed(2) + 'px';
    var py = (curY * MAX_PX * 0.75).toFixed(2) + 'px';
    if (root.style.getPropertyValue('--os-px') !== px) root.style.setProperty('--os-px', px);
    if (root.style.getPropertyValue('--os-py') !== py) root.style.setProperty('--os-py', py);
    root.style.setProperty('--os-mx', mx.toFixed(1));
    root.style.setProperty('--os-my', my.toFixed(1));
  }

  /* ── 6 · 启动 ────────────────────────────────────────────────────────── */
  function start() {
    mirror();
    buildToday();
    paint3d();
    paintToday();
    syncView();
    clockTick();
    uptimeTick();

    try {
      new MutationObserver(syncView).observe(document.body, {
        subtree: true, attributes: true, attributeFilter: ['class']
      });
    } catch (e) { /* 忽略 */ }
    try {
      new MutationObserver(paint3d).observe(root, { attributes: true, attributeFilter: ['class'] });
    } catch (e) { /* 忽略 */ }

    if (api && api.app) {
      if (typeof api.app.info === 'function') {
        api.app.info().then(function (info) {
          if (!info) return;
          window.__shlVersion = info.version;
          paintBuild();
          if (info.localNode) set('osNetLocal', info.localNode);
        }).catch(function () { /* 忽略 */ });
      }
      if (typeof api.app.onActivity === 'function') {
        try { api.app.onActivity(function (active) { broadcastActivity(!!active); }); } catch (e) { /* 忽略 */ }
      }
    }

    setInterval(clockTick, 1000);
    setInterval(uptimeTick, 1000);
    setInterval(paintToday, 3000);
    setInterval(pollMetrics, 10000);
    setInterval(pollProviders, 20000);
    pollMetrics();
    pollProviders();

    document.addEventListener('visibilitychange', function () {
      broadcastActivity(!document.hidden);
      if (!document.hidden) { clockTick(); uptimeTick(); paintToday(); }
    });

    requestAnimationFrame(loop);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
