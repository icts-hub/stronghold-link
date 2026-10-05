/* ============================================================================
   Stronghold Link — 三维舞台（Three.js）
   ----------------------------------------------------------------------------
   用我们自己的几何表达「网络基础设施」：一片节点方阵 + 路由链路 + 深度雾 +
   缓慢相机轨道 + 琥珀高亮在用路径 + 扫描线。不是档案盒，也不复制任何第三方美术。

   安全约定：
     * window.THREE 不存在、WebGL 初始化失败、或系统偏好「减少动态效果」时，
       本文件不做任何事，界面保留原来的 CSS 网格背景（绝不能变白）。
     * 只读 CSS 变量取色，主题切换时重新取；不写死颜色。
     * 页面不可见时暂停渲染。
   ========================================================================= */
(function () {
  'use strict';

  var host = document.querySelector('.bg');
  if (!host || typeof window.THREE === 'undefined') return;      // 没挂上 Three：保留 CSS 背景
  if (typeof window.WebGLRenderingContext === 'undefined') return; // 环境不支持 WebGL

  var reduceMotion = false;
  try {
    reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduceMotion && typeof location !== 'undefined' && String(location.search || '').indexOf('motion=force') >= 0) reduceMotion = false;
  } catch (e) { /* 忽略 */ }

  function token(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name);
      return (v || '').trim() || fallback;
    } catch (e) { return fallback; }
  }
  function rgb(name, fallback) {
    var raw = token(name, '').split(',').map(function (x) { return Number(x.trim()); });
    if (raw.length < 3 || raw.some(function (x) { return !isFinite(x); })) {
      return fallback.split(',').map(function (x) { return Number(x.trim()); });
    }
    return raw;
  }
  function color(rgbArr, alpha) {
    return 'rgba(' + rgbArr[0] + ',' + rgbArr[1] + ',' + rgbArr[2] + ',' + (alpha === undefined ? 1 : alpha) + ')';
  }

  var THREE = window.THREE;
  var canvas = document.createElement('canvas');
  canvas.className = 'stage-canvas';
  canvas.setAttribute('aria-hidden', 'true');

  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch (err) {
    return; // 没有 WebGL：保留 CSS 背景
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  host.insertBefore(canvas, host.firstChild);

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(38, 1, 1, 400);

  // 节点方阵：长条方柱按网格排布，越远越淡（靠雾）
  var COLS = 26;
  var ROWS = 16;
  var SPACING = 6.2;
  var count = COLS * ROWS;
  var box = new THREE.BoxGeometry(1.35, 1, 3.6);
  var material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5 });
  var field = new THREE.InstancedMesh(box, material, count);
  var dummy = new THREE.Object3D();
  var i = 0;
  for (var r = 0; r < ROWS; r += 1) {
    for (var c = 0; c < COLS; c += 1) {
      dummy.position.set((c - COLS / 2) * SPACING, 0, (r - ROWS / 2) * SPACING);
      var h = 1 + ((r * 7 + c * 3) % 5) * 0.35;
      dummy.scale.set(1, h, 1);
      dummy.updateMatrix();
      field.setMatrixAt(i, dummy.matrix);
      i += 1;
    }
  }
  field.instanceMatrix.needsUpdate = true;
  field.frustumCulled = false;
  scene.add(field);

  // 三条链路：中间一条为「在用路径」（琥珀），两侧为备用（线色）
  var routeGroup = new THREE.Group();
  var activeLine = null;
  var standbyLines = [];
  function buildRoutes(accent, lineColor) {
    routeGroup.clear();
    standbyLines = [];
    for (var k = -1; k <= 1; k += 1) {
      var z = k * SPACING * 3;
      var points = [
        new THREE.Vector3(-COLS * SPACING * 0.42, 6.5, z),
        new THREE.Vector3(0, 9.5 + (k === 0 ? 1.6 : 0), z),
        new THREE.Vector3(COLS * SPACING * 0.42, 6.5, z),
      ];
      var geo = new THREE.BufferGeometry().setFromPoints(points);
      var mat = new THREE.LineBasicMaterial({ transparent: true, opacity: k === 0 ? 0.85 : 0.35 });
      var line = new THREE.Line(geo, mat);
      if (k === 0) { line.material.color.set(color(accent, 1)); activeLine = line; } else { line.material.color.set(color(lineColor, 1)); standbyLines.push(line); }
      routeGroup.add(line);
    }
  }
  scene.add(routeGroup);

  // 扫描面：一条极窄的横向带，沿纵深缓慢推进
  var scan = new THREE.Mesh(
    new THREE.PlaneGeometry(COLS * SPACING * 0.9, 1),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.12 })
  );
  scan.rotation.x = -Math.PI / 2;
  scene.add(scan);

  function applyTheme() {
    var paper = rgb('--paper-rgb', '242, 240, 235');
    var ink = rgb('--ink-rgb', '8, 10, 8');
    var accent = rgb('--accent-rgb', '197, 161, 107');
    var line = rgb('--line-rgb', '170, 165, 154');
    scene.fog = new THREE.Fog(new THREE.Color(color(paper, 1)), 60, 210);
    material.color.set(color(ink, 1));
    material.opacity = 0.42;
    buildRoutes(accent, line);
    scan.material.color.set(color(accent, 1));
  }

  function resize() {
    var w = host.clientWidth || window.innerWidth;
    var h = host.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }

  var clock = 0;
  var running = true;
  function frame() {
    if (!running) return;
    requestAnimationFrame(frame);
    if (!reduceMotion) clock += 0.0016;
    var radius = 96;
    var angle = reduceMotion ? -0.55 : -0.55 + clock;
    camera.position.set(Math.cos(angle) * radius, 34 + (reduceMotion ? 0 : Math.sin(clock * 0.7) * 4), Math.sin(angle) * radius);
    camera.lookAt(0, 4, 0);
    if (!reduceMotion) {
      scan.position.set(0, 7, ((clock * 26) % (ROWS * SPACING)) - (ROWS * SPACING) / 2);
      if (activeLine) activeLine.material.opacity = 0.6 + Math.sin(clock * 6) * 0.25;
    }
    renderer.render(scene, camera);
  }

  applyTheme();
  resize();
  frame();

  window.addEventListener('resize', resize);
  try {
    if (window.MutationObserver) {
      new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    document.addEventListener('visibilitychange', function () {
      var visible = !document.hidden;
      if (visible && !running) { running = true; frame(); }
      else if (!visible) running = false;
    });
  } catch (e) { /* 忽略 */ }
})();
