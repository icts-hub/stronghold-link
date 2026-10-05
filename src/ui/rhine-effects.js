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
