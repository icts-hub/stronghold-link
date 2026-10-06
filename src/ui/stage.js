/* ============================================================================
   Stronghold Link — 三维分析场（背景主视觉）
   ----------------------------------------------------------------------------
   参考图的空间感来自"大量同向长条阵列 + 台阶式高低差 + 极低对比的暖灰"。
   这里用单个 InstancedMesh 铺出一整片梁阵，靠排距、缝隙、少量凸起平台
   产生纵深，再叠近雾做空气感。

   性能约定：
     * 1 个 InstancedMesh，1 次 draw call，无逐帧几何计算
     * BoxGeometry + MeshLambertMaterial + 逐实例颜色，无贴图无阴影
     * 30 FPS 门控，DPR ≤ 1.0，antialias 关闭
     * 页面隐藏 / prefers-reduced-motion 停止渲染
     * WebGL 不可用直接返回，背景退回 CSS 层，界面绝不空白
   ========================================================================= */
(function () {
  'use strict';

  var host = document.querySelector('.bg');
  if (!host || typeof window.THREE === 'undefined') return;
  if (typeof window.WebGLRenderingContext === 'undefined') return;

  var reduceMotion = false;
  try {
    reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (typeof location !== 'undefined' && String(location.search || '').indexOf('motion=force') >= 0) reduceMotion = false;
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

  var THREE = window.THREE;
  var canvas = document.createElement('canvas');
  canvas.className = 'stage-canvas';
  canvas.setAttribute('aria-hidden', 'true');

  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, alpha: true, powerPreference: 'low-power' });
  } catch (err) {
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1));
  host.insertBefore(canvas, host.firstChild);

  var scrim = document.createElement('div');
  scrim.className = 'stage-scrim';
  host.insertBefore(scrim, canvas.nextSibling);

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(30, 1, 1, 1600);

  var ambient = new THREE.AmbientLight(0xffffff, 0.62);
  scene.add(ambient);
  var key = new THREE.DirectionalLight(0xffffff, 0.72);
  key.position.set(-120, 230, 140);
  scene.add(key);
  var fill = new THREE.DirectionalLight(0xffffff, 0.16);
  fill.position.set(110, -60, -90);
  scene.add(fill);

  /* 底板：缝隙里透出的深一点的暖灰，梁与梁之间才有分隔 */
  var floorMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  var floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, -1.2, -200);
  floor.scale.set(1400, 1400, 1);
  scene.add(floor);

  /* ── 梁阵参数 ───────────────────────────────────────────────────────── */
  var ROWS = 130;             // 纵深方向排数
  var SEGS = 8;               // 每排分段数，用来做沿长度的明暗变化
  var BEAM_W = 3.6;           // 梁宽
  var ROW_GAP = 1.15;         // 排间缝隙
  var ROW_PITCH = BEAM_W + ROW_GAP;
  var LEN_TOTAL = 340;        // 整排长度
  var SEG_LEN = LEN_TOTAL / SEGS;
  var SEG_GAP = 0.1;          // 分段之间的细缝
  var FLAT_H = 2.6;           // 基础梁厚
  var RISE = 0.12;            // 每往后退一排抬高一点，整体几乎水平，只有局部台阶

  var box = new THREE.BoxGeometry(1, 1, 1);
  var material = new THREE.MeshLambertMaterial({ color: 0xffffff });
  var count = ROWS * SEGS;
  var mesh = new THREE.InstancedMesh(box, material, count);
  mesh.frustumCulled = false;
  scene.add(mesh);

  var group = new THREE.Group();          // 整片场地的朝向
  group.add(mesh);
  scene.add(group);

  /* 凸起平台：参考图里几处明显高出来的方块组 */
  /* 凸起平台：参考图里几处明显高出来的方块组，高度是相对基础梁厚的增量 */
  var PLATFORMS = [
    { row: 7, seg: 3, rows: 2, segs: 2, h: 1.7 },
    { row: 7, seg: 4, rows: 2, segs: 1, h: 1.0 },
    { row: 16, seg: 1, rows: 1, segs: 2, h: 1.4 },
    { row: 16, seg: 1, rows: 1, segs: 1, h: 2.0 },
    { row: 26, seg: 6, rows: 2, segs: 2, h: 1.2 },
    { row: 33, seg: 2, rows: 1, segs: 1, h: 1.0 },
    { row: 41, seg: 5, rows: 2, segs: 2, h: 1.6 },
    { row: 49, seg: 0, rows: 1, segs: 2, h: 1.1 },
    { row: 57, seg: 4, rows: 2, segs: 1, h: 1.9 },
    { row: 66, seg: 7, rows: 1, segs: 1, h: 1.3 },
    { row: 74, seg: 3, rows: 2, segs: 2, h: 1.5 },
    { row: 82, seg: 6, rows: 1, segs: 2, h: 1.2 }
  ];

  function platformAt(row, seg) {
    for (var i = 0; i < PLATFORMS.length; i += 1) {
      var p = PLATFORMS[i];
      if (row >= p.row && row < p.row + p.rows && seg >= p.seg && seg < p.seg + p.segs) return p.h;
    }
    return 0;
  }

  var tmpColor = new THREE.Color();
  var base = new THREE.Color(1, 1, 1);
  var groove = new THREE.Color(1, 1, 1);
  var mtx = new THREE.Matrix4();
  var pos = new THREE.Vector3();
  var quat = new THREE.Quaternion();
  var scl = new THREE.Vector3();

  /* 伪随机但稳定：同一条梁每次构建结果一致 */
  function hash(a, b) {
    var x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  function buildField() {
    var i = 0;
    for (var r = 0; r < ROWS; r += 1) {
      var z = -r * ROW_PITCH;
      var y0 = r * RISE;
      for (var s = 0; s < SEGS; s += 1) {
        var extra = platformAt(r, s);
        var h = FLAT_H + extra;
        var x = (s - (SEGS - 1) / 2) * SEG_LEN;
        pos.set(x, y0 + h / 2, z);
        scl.set(SEG_LEN - SEG_GAP, h, BEAM_W);
        mtx.compose(pos, quat, scl);
        mesh.setMatrixAt(i, mtx);

        /* 明暗：排内靠中的段稍亮，每条梁有极轻微色差，凸起块更亮 */
        var grain = hash(r, s) * 0.03;
        var center = 1 - Math.abs(s - (SEGS - 1) / 2) / (SEGS * 0.9);
        var depth = Math.max(0, 1 - r / (ROWS * 1.35));
        var lum = 0.9 + 0.05 * center + 0.05 * depth + grain + (extra > 0 ? 0.03 : 0);
        if (lum > 1) lum = 1;
        tmpColor.setRGB(lum * base.r, lum * base.g, lum * base.b);
        mesh.setColorAt(i, tmpColor);
        i += 1;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  function applyTheme() {
    var paper = rgb('--paper-rgb', '243, 241, 236');
    var luma = (paper[0] * 0.299 + paper[1] * 0.587 + paper[2] * 0.114) / 255;
    var isLight = luma > 0.5;
    if (isLight) {
      base.setRGB(1.0, 0.995, 0.982);
      groove.setRGB(0.9, 0.885, 0.855);
    } else {
      base.setRGB(0.36, 0.375, 0.40);
      groove.setRGB(0.07, 0.08, 0.10);
    }
    ambient.intensity = isLight ? 0.52 : 0.5;
    key.intensity = isLight ? 1.0 : 0.72;
    fill.intensity = isLight ? 0.2 : 0.2;
    floorMat.color.copy(groove);
    var fogRgb = isLight ? [243, 241, 236] : [18, 20, 24];
    scene.fog = new THREE.Fog(
      (fogRgb[0] << 16) | (fogRgb[1] << 8) | fogRgb[2],
      210,
      900
    );
    buildField();
  }

  /* ── 相机与尺寸 ─────────────────────────────────────────────────────── */
  var viewFar = 900;
  function resize() {
    var w = host.clientWidth || window.innerWidth;
    var h = host.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    viewFar = Math.max(560, Math.min(w, h) * 1.35);
    camera.far = viewFar * 3;
    camera.updateProjectionMatrix();
  }

  var HOME = new THREE.Vector3(-96, 30, 30);
  var LOOK = new THREE.Vector3(48, 5, -150);
  var px = 0, py = 0, tx = 0, ty = 0;

  function placeCamera() {
    camera.position.set(HOME.x + px, HOME.y + py, HOME.z);
    camera.lookAt(LOOK.x, LOOK.y + py * 0.35, LOOK.z);
  }

  try { group.rotation.y = 0; } catch (e) { /* 忽略 */ }

  /* 鼠标视差：几何层系数 0.4，最大位移远小于 1 个单位，只做"有回应"的感觉 */
  if (!reduceMotion) {
    window.addEventListener('mousemove', function (ev) {
      var w = window.innerWidth || 1;
      var h = window.innerHeight || 1;
      tx = ((ev.clientX / w) - 0.5) * 2;
      ty = ((ev.clientY / h) - 0.5) * 2;
    }, { passive: true });
  }

  var clock = 0;
  var running = true;
  var lastPaint = 0;
  var FRAME_MIN_MS = 33;

  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    var t = now || 0;
    if (document.hidden) return;
    if (!reduceMotion) {
      if (t - lastPaint < FRAME_MIN_MS) return;
      lastPaint = t;
      clock += 0.033;
      /* 30s / 60s / 90s 三个慢周期叠加，避免看出循环 */
      var a = Math.sin(clock / 30);
      var b = Math.sin(clock / 60 + 1.1);
      var c = Math.sin(clock / 90 + 2.3);
      HOME.x = -96 + a * 12 + c * 7;
      HOME.y = 30 + b * 3.2;
      LOOK.x = 48 + a * 5;
      LOOK.y = 5 + c * 2.6;
      px += (tx * 4.2 - px) * 0.045;
      py += (ty * 2.6 - py) * 0.045;
      key.position.set(-120 + a * 30, 230 + b * 18, 140 + c * 24);
      placeCamera();
    }
    renderer.render(scene, camera);
  }

  try { document.documentElement.classList.add('has-3d'); } catch (e) { /* 忽略 */ }
  applyTheme();
  resize();
  placeCamera();
  frame(0);

  window.addEventListener('resize', resize);
  try {
    if (window.MutationObserver) {
      new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    document.addEventListener('visibilitychange', function () {
      var visible = !document.hidden;
      if (visible && !running) { running = true; frame(0); }
      else if (!visible) running = false;
    });
    /* 自测开关：最小化时确实停帧 */
    window.__shlActivity = window.__shlActivity || [];
    window.__shlActivity.push(function (active) {
      if (active && !running) { running = true; frame(0); }
      else if (!active) running = false;
    });
  } catch (e) { /* 忽略 */ }
})();
