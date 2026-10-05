/* ============================================================================
   Stronghold Link — 三维 ∞ 方块带（背景主视觉）
   ----------------------------------------------------------------------------
   参考 RhineLabUI 的扫掠带状：**用许多细长方块沿双纽线拼接**成一条扭转的带子，
   侧面因此出现细密"梳齿"，这正是参考图质感的来源。

   性能与内存约定（对应 RAM300 方案）：
     * 单个 InstancedMesh（一次 draw call），无逐帧几何计算
     * 30 FPS 门控 + DPR ≤ 1.0 + antialias 关闭
     * 页面隐藏 / prefers-reduced-motion 停止渲染（减少动效只画一帧）
     * WebGL 不可用直接返回：背景保留 CSS/SVG 层，界面绝不空白
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
    return;                                  // 没有 WebGL：保留 CSS/SVG 背景
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1));
  host.insertBefore(canvas, host.firstChild);

  var scrim = document.createElement('div');
  scrim.className = 'stage-scrim';
  host.insertBefore(scrim, canvas.nextSibling);

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(34, 1, 1, 600);
  camera.position.set(0, 16, 260);
  camera.lookAt(0, 2, 0);

  var ambient = new THREE.AmbientLight(0xffffff, 0.42);
  scene.add(ambient);
  var key = new THREE.DirectionalLight(0xffffff, 1.15);
  key.position.set(-60, 90, 70);
  scene.add(key);
  var fill = new THREE.DirectionalLight(0xffffff, 0.3);
  fill.position.set(70, -40, -60);
  scene.add(fill);

  var A = 68;          // ∞ 横向半径
  var B = 26;          // 纵向起伏
  var WIDTH = 27;      // 带宽（收窄才像带子）
  var THICK = 0.62;    // 方块厚度（薄板）
  var LONG = 150;      // 沿路径方块数
  var WIDE = 7;        // 沿带宽方块数
  var TWIST = 1.05;    // 扭转强度（过大就会折向镜头）

  var tmp = { pos: new THREE.Vector3(), tan: new THREE.Vector3(), wid: new THREE.Vector3() };
  var normal = new THREE.Vector3();
  var basis = new THREE.Matrix4();
  var quat = new THREE.Quaternion();
  var one = new THREE.Vector3(1, 1, 1);
  var segLen = ((Math.PI * 2 * A) / LONG) * 1.28;

  function pointAt(t, u, out) {
    var x = A * Math.sin(t);
    var z = (A * Math.sin(2 * t)) / 3.6;
    var y = Math.sin(2 * t) * (B / 2) + Math.sin(t) * 4;

    var dx = A * Math.cos(t);
    var dz = (A * 2 * Math.cos(2 * t)) / 3.6;
    var dy = Math.cos(2 * t) * B + Math.cos(t) * 4;
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    var tx = dx / len, ty = dy / len, tz = dz / len;

    var theta = t * 0.5 + (u - 0.5) * Math.PI * TWIST;
    var wx = Math.cos(theta), wy = Math.sin(theta) * 0.85, wz = Math.sin(theta) * 0.4;
    var dot = wx * tx + wy * ty + wz * tz;
    wx -= tx * dot; wy -= ty * dot; wz -= tz * dot;
    var wl = Math.sqrt(wx * wx + wy * wy + wz * wz) || 1;
    wx /= wl; wy /= wl; wz /= wl;

    var off = (u - 0.5) * WIDTH;
    out.pos.set(x + wx * off, y + wy * off, z + wz * off);
    out.tan.set(tx, ty, tz);
    out.wid.set(wx, wy, wz);
    return out;
  }

  var box = new THREE.BoxGeometry(segLen, THICK, (WIDTH / WIDE) * 1.06);
  var material = new THREE.MeshLambertMaterial({ color: 0xffffff });
  var count = LONG * WIDE;
  var mesh = new THREE.InstancedMesh(box, material, count);
  mesh.frustumCulled = false;
  mesh.rotation.z = -0.10;
  scene.add(mesh);

  function buildField() {
    var i = 0;
    var m = new THREE.Matrix4();
    for (var s = 0; s < LONG; s += 1) {
      var t = (s / LONG) * Math.PI * 2;
      for (var u = 0; u < WIDE; u += 1) {
        pointAt(t, (u + 0.5) / WIDE, tmp);
        normal.crossVectors(tmp.tan, tmp.wid).normalize();
        basis.makeBasis(tmp.tan, tmp.wid, normal);
        quat.setFromRotationMatrix(basis);
        m.compose(tmp.pos, quat, one);
        mesh.setMatrixAt(i, m);
        i += 1;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  function applyTheme() {
    var paper = rgb('--paper-rgb', '242, 240, 235');
    var luma = (paper[0] * 0.299 + paper[1] * 0.587 + paper[2] * 0.114) / 255;
    var isLight = luma > 0.5;
    material.color.setRGB(isLight ? 0.93 : 0.15, isLight ? 0.922 : 0.18, isLight ? 0.905 : 0.195);
    ambient.intensity = isLight ? 0.44 : 0.36;
    key.intensity = isLight ? 1.12 : 0.72;
    fill.intensity = isLight ? 0.34 : 0.24;
    buildField();
  }

  function resize() {
    var w = host.clientWidth || window.innerWidth;
    var h = host.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    var far = Math.max(1, Math.min(w, h));
    camera.position.set(0, 15, far * 0.235);
    camera.lookAt(0, 2, 0);
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
      clock += 0.0045;
      var far = Math.max(1, Math.min(host.clientWidth || 1440, host.clientHeight || 900));
      camera.position.x = Math.sin(Math.sin(clock * 0.35) * 0.075) * far * 0.22;
      camera.position.y = 16 + Math.sin(clock * 0.5) * 2.5;
      camera.lookAt(0, 2, 0);
    }
    renderer.render(scene, camera);
  }

  try { document.documentElement.classList.add('has-3d'); } catch (e) { /* 忽略 */ }
  applyTheme();
  resize();
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
  } catch (e) { /* 忽略 */ }
})();
