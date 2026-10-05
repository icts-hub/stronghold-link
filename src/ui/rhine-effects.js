/*
 * Stronghold Link — Dynamic UI interactions
 * -----------------------------------------
 * Renderer-only visual layer. No Node APIs, no IPC calls, no business state.
 * Safe to load after the existing inline application script.
 */
(function () {
  'use strict';

  if (typeof document === 'undefined') return;

  // 声明本脚本是 --px/--py（视差）的唯一驱动者：内联脚本检测到后会让位，避免两套视差
  window.__rhineFxOwner = true;

  var root = document.documentElement;
  var body = document.body;
  var raf = 0;
  var tx = 0.5, ty = 0.5;
  var rx = 0.5, ry = 0.5;
  var hidden = !!document.hidden;

  function reducedMotion() {
    try {
      if (root.classList.contains('force-motion')) return false;
      return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {
      return false;
    }
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function frame() {
    raf = 0;
    if (hidden || reducedMotion()) return;

    rx += (tx - rx) * 0.11;
    ry += (ty - ry) * 0.11;

    root.style.setProperty('--fx-pointer-x', rx.toFixed(4));
    root.style.setProperty('--fx-pointer-y', ry.toFixed(4));
    root.style.setProperty('--fx-pointer-x-px', (rx * window.innerWidth).toFixed(1) + 'px');
    root.style.setProperty('--fx-pointer-y-px', (ry * window.innerHeight).toFixed(1) + 'px');
    root.style.setProperty('--px', ((rx - 0.5) * 2).toFixed(4));
    root.style.setProperty('--py', ((ry - 0.5) * 2).toFixed(4));

    if (Math.abs(tx - rx) > 0.002 || Math.abs(ty - ry) > 0.002) {
      raf = requestAnimationFrame(frame);
    }
  }

  function pointerMove(e) {
    if (!e) return;
    if (hidden || reducedMotion()) return;
    tx = clamp(e.clientX / Math.max(1, window.innerWidth), 0, 1);
    ty = clamp(e.clientY / Math.max(1, window.innerHeight), 0, 1);
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function pointerLeave() {
    tx = 0.5;
    ty = 0.5;
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function markInteractive() {
    var selectors = [
      '.panel', '.lobby', '.terminal-modal', '.chanlist', '.term', '.invite',
      '.dialog', '.btn', '.nav button', '.theme-switch button', '.trow', '.cmd'
    ];

    document.querySelectorAll(selectors.join(',')).forEach(function (el) {
      if (!el.classList.contains('fx-interactive')) el.classList.add('fx-interactive');
    });
  }

  function bindLocalPointerReflection() {
    document.addEventListener('pointermove', function (e) {
      var target = e.target && e.target.closest
        ? e.target.closest('.fx-interactive')
        : null;
      if (!target) return;

      var rect = target.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      var lx = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      var ly = clamp((e.clientY - rect.top) / rect.height, 0, 1);
      target.style.setProperty('--fx-local-x', (lx * 100).toFixed(2) + '%');
      target.style.setProperty('--fx-local-y', (ly * 100).toFixed(2) + '%');
    }, { passive: true });

    document.addEventListener('pointerout', function (e) {
      var target = e.target && e.target.closest
        ? e.target.closest('.fx-interactive')
        : null;
      if (!target) return;
      if (e.relatedTarget && target.contains(e.relatedTarget)) return;
      target.style.removeProperty('--fx-local-x');
      target.style.removeProperty('--fx-local-y');
    }, { passive: true });
  }

  function observeDom() {
    if (!window.MutationObserver) return;
    var observer = new MutationObserver(function () {
      markInteractive();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function hookViewTransitions() {
    document.addEventListener('click', function (e) {
      var button = e.target && e.target.closest
        ? e.target.closest('[data-view]')
        : null;
      if (!button) return;
      var name = button.getAttribute('data-view');
      if (!name) return;
      document.documentElement.setAttribute('data-last-view', name);
    }, { passive: true });
  }

  function hookVisibility() {
    document.addEventListener('visibilitychange', function () {
      hidden = !!document.hidden;
      if (!hidden) {
        if (!raf) raf = requestAnimationFrame(frame);
      }
    });
  }

  function boot() {
    markInteractive();
    bindLocalPointerReflection();
    observeDom();
    hookViewTransitions();
    hookVisibility();
    window.addEventListener('pointermove', pointerMove, { passive: true });
    window.addEventListener('blur', pointerLeave, { passive: true });
    window.addEventListener('resize', function () {
      if (!raf) raf = requestAnimationFrame(frame);
    }, { passive: true });

    root.style.setProperty('--fx-pointer-x', '0.5');
    root.style.setProperty('--fx-pointer-y', '0.5');
    root.style.setProperty('--fx-pointer-x-px', (window.innerWidth * 0.5).toFixed(1) + 'px');
    root.style.setProperty('--fx-pointer-y-px', (window.innerHeight * 0.5).toFixed(1) + 'px');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();

/* ==========================================================================
   SILKY MOTION — renderer-only additions
   Central scheduler (idle-stopping single RAF) + data tween + packet flow
   + once-only scroll reveal + adaptive quality downgrade.
   No Node APIs, no IPC, no business state. Honors prefers-reduced-motion.
   ========================================================================== */
(function () {
  'use strict';
  if (typeof document === 'undefined' || typeof requestAnimationFrame !== 'function') return;

  var root = document.documentElement;
  var reduce = function () {
    try {
      if (root.classList.contains('force-motion')) return false;
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  };
  var hidden = function () { return !!document.hidden; };

  /* ---------- 1) Central motion loop：只有一个 RAF，空闲即停 ---------- */
  var tasks = new Set();
  var running = false;
  var lastT = 0;
  var frameCost = 0;
  var frames = 0;
  var lite = false;

  function loop(t) {
    var dt = lastT ? Math.min(64, t - lastT) : 16;
    lastT = t;
    var t0 = (window.performance && performance.now) ? performance.now() : t;
    tasks.forEach(function (fn) { try { fn(t, dt); } catch (e) { tasks.delete(fn); } });
    var cost = ((window.performance && performance.now) ? performance.now() : t) - t0;
    frameCost += cost;
    frames += 1;
    if (frames >= 90 && !lite) {
      var avg = frameCost / frames;
      // 帧预算吃紧（脚本耗时 > 8ms/帧）：降级而不是掉帧
      if (avg > 8) { lite = true; root.classList.add('fx-lite'); }
      frames = 0; frameCost = 0;
    }
    if (tasks.size && !hidden()) { requestAnimationFrame(loop); } else { running = false; lastT = 0; }
  }
  function kick() { if (!running && tasks.size && !hidden()) { running = true; lastT = 0; requestAnimationFrame(loop); } }
  function addTask(fn) { tasks.add(fn); kick(); return function () { tasks.delete(fn); }; }

  window.__silkLoop = {
    add: addTask,
    get size() { return tasks.size; },
    get lite() { return lite; }
  };

  /* ---------- 2) 数字补间：数据变化连续滚动，不闪断 ---------- */
  var NUM = /(-?\d+(?:\.\d+)?)/;
  function tweenNumber(el) {
    if (reduce()) return;
    var raw = el.textContent || '';
    var m = raw.match(NUM);
    if (!m) return;
    var target = parseFloat(m[1]);
    if (!isFinite(target)) return;
    var from = parseFloat(el.getAttribute('data-silk-value'));
    if (!isFinite(from)) { el.setAttribute('data-silk-value', String(target)); return; }
    if (Math.abs(target - from) < 1e-9) return;
    var decimals = (m[1].split('.')[1] || '').length;
    var span = Math.abs(target - from);
    var dur = Math.max(150, Math.min(300, 150 + span * 4));
    var t0 = 0;
    var off = addTask(function (t, dt) {
      t0 += dt;
      var p = Math.min(1, t0 / dur);
      var e = 1 - Math.pow(1 - p, 3);                  // ease-out cubic
      var v = from + (target - from) * e;
      var text = raw.replace(NUM, decimals ? v.toFixed(decimals) : String(Math.round(v)));
      watching = true;
      el.textContent = text;
      watching = false;
      if (p >= 1) { el.setAttribute('data-silk-value', String(target)); off(); }
    });
  }

  var watching = false;
  function watchNumbers() {
    var nodes = document.querySelectorAll('.readout__v');
    if (!nodes.length || !window.MutationObserver) return;
    var mo = new MutationObserver(function (records) {
      if (watching) return;
      records.forEach(function (r) { if (r.target && r.target.nodeType === 1) tweenNumber(r.target); });
    });
    nodes.forEach(function (el) {
      el.setAttribute('data-silk-value', String(parseFloat((el.textContent || '').match(NUM) ? (el.textContent || '').match(NUM)[1] : '0') || 0));
      mo.observe(el, { childList: true, characterData: true, subtree: true });
    });
  }

  /* ---------- 3) 网络包流：沿 SVG 路径平滑移动（惰性发现，视图可见后才取几何） ---------- */
  var silkPaths = [];
  var silkDots = [];
  var silkReady = false;
  var silkOffset = 0;

  function discoverPackets() {
    if (silkReady) return;
    var svg = document.getElementById('routeDiagram');
    if (!svg) return;
    var found = Array.prototype.slice.call(svg.querySelectorAll('path, line')).filter(function (el) {
      if (typeof el.getTotalLength !== 'function') return false;
      try { return el.getTotalLength() > 12; } catch (e) { return false; }
    });
    if (!found.length) return;              // 视图还没显示时几何长度为 0：下次再试
    silkPaths = found;
    silkDots = found.map(function () {
      var c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('r', '2.2');
      c.setAttribute('fill', 'currentColor');
      c.setAttribute('opacity', '0');
      c.setAttribute('class', 'silk-packet');
      svg.appendChild(c);
      return c;
    });
    silkReady = true;
  }

  function initPackets() {
    addTask(function (t, dt) {
      var view = document.getElementById('networkView');
      if (!view || !view.classList.contains('active')) return;   // 只在网络页跑
      if (reduce()) return;
      discoverPackets();
      if (!silkPaths.length) return;
      silkOffset = (silkOffset + dt / 2600) % 1;                 // 慢速：一个来回 2.6s
      for (var i = 0; i < silkPaths.length; i += 1) {
        var path = silkPaths[i];
        var len = 0;
        try { len = path.getTotalLength(); } catch (e) { continue; }
        if (!len) continue;
        var local = (silkOffset + i * 0.33) % 1;
        var eased = local < 0.5 ? 2 * local * local : 1 - Math.pow(-2 * local + 2, 2) / 2;
        var pt = null;
        try { pt = path.getPointAtLength(eased * len); } catch (e) { continue; }
        var dot = silkDots[i];
        if (!dot) continue;
        dot.setAttribute('opacity', (0.12 + 0.55 * Math.sin(Math.PI * local)).toFixed(3));
        dot.setAttribute('transform', 'translate(' + pt.x.toFixed(2) + ' ' + pt.y.toFixed(2) + ')');
      }
    });
  }

  /* ---------- 4) 滚动揭示：只播一次 ---------- */
  function initReveal() {
    if (!window.IntersectionObserver) return;
    var nodes = Array.prototype.slice.call(document.querySelectorAll('.panel, .trow, .step'));
    if (!nodes.length) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add('is-revealed');
        io.unobserve(en.target);                       // 只播一次，反复滚动不再重放
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
    nodes.forEach(function (el) {
      var rect = el.getBoundingClientRect();
      if (rect.top > window.innerHeight * 0.92) { el.classList.add('silk-watch'); io.observe(el); }
    });
  }

  /* ---------- 5) 玻璃面标记（反射只加在这些面上） ---------- */
  function markSurfaces() {
    var sel = '.panel, .dialog, .lobby';
    document.querySelectorAll(sel).forEach(function (el) {
      if (!el.classList.contains('fx-silk-surface')) el.classList.add('fx-silk-surface');
    });
  }

  function init() {
    markSurfaces();
    watchNumbers();
    initPackets();
    initReveal();
    if (window.MutationObserver) {
      var mo = new MutationObserver(function () { markSurfaces(); });
      mo.observe(document.body, { childList: true, subtree: true });
    }
    document.addEventListener('visibilitychange', function () { if (!hidden()) kick(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
