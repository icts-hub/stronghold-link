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
  var idleStart = performance.now();

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

  function frame(now) {
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

    
    // 指针缓动收敛后即停帧；"待机也在动"由中央循环的 idle 时钟负责，避免两个常驻 RAF
    if (Math.abs(tx - rx) > 0.002 || Math.abs(ty - ry) > 0.002) raf = requestAnimationFrame(frame);
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
    // rect 缓存 250ms：pointermove 不再每个事件都 getBoundingClientRect（方案 N）
    var rectCache = new WeakMap();
    function rectOf(el) {
      var now = (window.performance && performance.now) ? performance.now() : Date.now();
      var hit = rectCache.get(el);
      if (hit && now - hit.at < 250) return hit.rect;
      var r = el.getBoundingClientRect();
      rectCache.set(el, { at: now, rect: r });
      return r;
    }
    document.addEventListener('pointermove', function (e) {
      var target = e.target && e.target.closest ? e.target.closest('.fx-interactive') : null;
      if (!target) return;
      var rect = rectOf(target);
      if (!rect.width || !rect.height) return;
      var lx = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      var ly = clamp((e.clientY - rect.top) / rect.height, 0, 1);
      target.style.setProperty('--fx-local-x', (lx * 100).toFixed(2) + '%');
      target.style.setProperty('--fx-local-y', (ly * 100).toFixed(2) + '%');
    }, { passive: true });
    document.addEventListener('pointerout', function (e) {
      var target = e.target && e.target.closest ? e.target.closest('.fx-interactive') : null;
      if (!target) return;
      if (e.relatedTarget && target.contains(e.relatedTarget)) return;
      rectCache.delete(target);
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
    if (!reducedMotion() && !raf) raf = requestAnimationFrame(frame);
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

  /* ---------- 1b) 常驻 Idle 运动由 CSS @keyframes 负责（无 JS RAF、无每帧 setProperty） ---------- */

﻿  /* ---------- 2) 数字补间（每元素单一 tween；忽略自身写入，避免自触发循环） ---------- */
  var NUM = /(-?\d+(?:\.\d+)?)/;
  var tweens = new WeakMap();
  var lastWritten = new WeakMap();

  function startTween(el, raw, target, decimals) {
    var prev = tweens.get(el);
    var from = prev ? prev.current : (parseFloat(el.getAttribute('data-silk-value')) || 0);
    if (prev && prev.task) prev.task();
    var span = Math.abs(target - from);
    var dur = Math.max(150, Math.min(300, 150 + span * 4));
    var state = { current: from, to: target, t: 0, dur: dur, decimals: decimals, raw: raw, task: null };
    state.task = addTask(function (now, dt) {
      state.t += dt;
      var pr = Math.min(1, state.t / state.dur);
      var e = 1 - Math.pow(1 - pr, 3);
      state.current = from + (target - from) * e;
      var text = raw.replace(NUM, decimals ? state.current.toFixed(decimals) : String(Math.round(state.current)));
      lastWritten.set(el, text);
      el.textContent = text;
      if (pr >= 1) {
        state.current = target;
        el.setAttribute('data-silk-value', String(target));
        lastWritten.set(el, raw.replace(NUM, decimals ? target.toFixed(decimals) : String(Math.round(target))));
        if (state.task) state.task();
        tweens.delete(el);
      }
    });
    tweens.set(el, state);
  }

  function onNumberMutated(el) {
    if (reduce()) return;
    var raw = el.textContent || '';
    if (lastWritten.get(el) === raw) return;      // 自身写入不算数据变化
    var m = raw.match(NUM);
    if (!m) return;
    var target = parseFloat(m[1]);
    if (!isFinite(target)) return;
    startTween(el, raw, target, (m[1].split('.')[1] || '').length);
  }

  function watchNumbers() {
    var nodes = document.querySelectorAll('.readout__v');
    if (!nodes.length || !window.MutationObserver) return;
    var queued = new Set();
    var flushQueued = false;
    var mo = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i += 1) {
        var t = records[i].target;
        if (t && t.nodeType === 1) queued.add(t);
      }
      if (flushQueued) return;
      flushQueued = true;
      requestAnimationFrame(function () {
        flushQueued = false;
        queued.forEach(function (el) { queued.delete(el); onNumberMutated(el); });
      });
    });
    nodes.forEach(function (el) {
      var m = (el.textContent || '').match(NUM);
      el.setAttribute('data-silk-value', String(m ? parseFloat(m[1]) : 0));
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

﻿  ﻿  /* ---------- 6) 签名层：实心 ∞ 扫掠带（带内同心细线 + 交叉断口） ---------- */
  (function () {
    'use strict';
    if (typeof document === 'undefined') return;
    var NS = 'http://www.w3.org/2000/svg';

    function buildRibbon() {
      var host = document.querySelector('.bg') || document.querySelector('.ambient-system');
      if (!host) return;
      var old = host.querySelector('.ribbon-wrap');
      if (old) old.remove();

      var wrap = document.createElement('div');
      wrap.className = 'ribbon-wrap';
      wrap.setAttribute('aria-hidden', 'true');
      var svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '-110 -62 220 124');
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

      var g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'ribbon-group');

      // 同一条 ∞ 参数曲线，重复描边：由粗到细 -> 带内出现等距同心线（参考图的叠层边缘）
      var STEPS = 260;
      var A = 86;     // 横向半径
      var B = 30;     // 纵向半径（Gerono 双纽线）
      var d = '';
      for (var s = 0; s <= STEPS; s += 1) {
        var t = (s / STEPS) * Math.PI * 2;
        var x = A * Math.sin(t);
        var y = (B * Math.sin(2 * t)) / 1.35;
        d += (s === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2);
      }

      function stroke(cls, width, opacity, dash) {
        var p = document.createElementNS(NS, 'path');
        p.setAttribute('class', cls);
        p.setAttribute('d', d);
        p.setAttribute('fill', 'none');
        p.setAttribute('stroke-width', String(width));
        p.setAttribute('stroke-linejoin', 'round');
        p.setAttribute('stroke-linecap', 'round');
        if (opacity !== null && opacity !== undefined) p.style.opacity = String(opacity);
        if (dash) p.setAttribute('stroke-dasharray', dash);
        g.appendChild(p);
        return p;
      }

      // 1) 外描边（细墨线）-> 2) 实心带 -> 3) 带内同心细线 -> 4) 高光
      stroke('ribbon-outline', 30.5, 0.45);
      stroke('ribbon-base', 28, 1);
      var LINES = 9;
      for (var i = 1; i <= LINES; i += 1) {
        var w = 28 - (28 - 8) * (i / (LINES + 1));
        stroke('ribbon-band-line', w, (0.045 + 0.035 * (i / LINES)).toFixed(3));   // 连续线：等距同心，秩序感来自均匀而非断续
      }
      stroke('ribbon-highlight', 7, 0.5);

      // 5) 交叉处断口：右上方切一道，做出上下穿插的层次（与标志同一语言）
      var notch = document.createElementNS(NS, 'path');
      notch.setAttribute('class', 'ribbon-notch');
      notch.setAttribute('d', 'M2 -13 L34 12');
      notch.setAttribute('stroke-width', '26');
      notch.setAttribute('stroke-linecap', 'butt');
      g.appendChild(notch);

      svg.appendChild(g);
      wrap.appendChild(svg);
      host.insertBefore(wrap, host.firstChild);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildRibbon);
    else buildRibbon();
  })();
/* ---------- 7) 最小化/后台时暂停一切动画 ---------- */
(function () {
  'use strict';
  if (typeof document === 'undefined') return;
  var root = document.documentElement;

  function setPaused(paused) {
    if (paused) root.classList.add('shl-paused');
    else root.classList.remove('shl-paused');
  }
  // 本地兜底：页面不可见（最小化、切标签页）时也暂停
  function fromVisibility() { setPaused(Boolean(document.hidden)); }
  document.addEventListener('visibilitychange', fromVisibility);
  fromVisibility();

  // 主进程通知（更准：最小化/失焦都覆盖）
  try {
    var api = window.strongholdLink && window.strongholdLink.app;
    if (api && api.onActivity) api.onActivity(function (p) { setPaused(!(p && p.active)); });
  } catch (e) { /* 忽略 */ }

  // 暂停时顺带把常驻动画循环里的任务也停掉（如果有）
  try {
    var loop = window.__silkLoop;
    if (loop && typeof loop.pause === 'function') {
      document.addEventListener('visibilitychange', function () { loop.pause(Boolean(document.hidden)); });
    }
  } catch (e) { /* 忽略 */ }
})();
