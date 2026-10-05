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

  // 背景主视觉由 SVG ∞ 线带负责（rhine-effects.js 第 6 段）：线条严格平行等距，
  // 读起来是"整齐的 ∞"。3D 薄片版仍保留在下面，改成 true 即可切回。
  var USE_3D_RIBBON = true;
  if (!USE_3D_RIBBON) return;

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
  camera.position.set(0, 14, 300);
  camera.lookAt(0, 2, 0);

  var ambient = new THREE.AmbientLight(0xffffff, 0.92);
  scene.add(ambient);
  var key = new THREE.DirectionalLight(0xffffff, 0.16);
  key.position.set(-60, 90, 70);
  scene.add(key);
  var fill = new THREE.DirectionalLight(0xffffff, 0.10);
  fill.position.set(70, -40, -60);
  scene.add(fill);

  var A = 68;          // ∞ 横向半径
  var B = 26;          // 纵向起伏
  var WIDTH = 27;      // 带宽（收窄才像带子）
  var LONG = 180;         // 沿路径的小方块数
  var WIDE = 20;          // 沿带宽的小方块数
  var LAYERS = 3;         // 厚度方向层数（薄带）
  var THICK_TOTAL = 2.6;  // 总厚度
  var SLAB = (THICK_TOTAL / LAYERS) * 0.9;
  var CUBE_L = 99;        // 占位（真实长度在下面按弧长算）
  var TWIST = 0.26;    // 扭转强度（更缓慢，∞ 形态更易读）

  var tmp = { pos: new THREE.Vector3(), tan: new THREE.Vector3(), wid: new THREE.Vector3() };
  var normal = new THREE.Vector3();
  var basis = new THREE.Matrix4();
  var quat = new THREE.Quaternion();
  var one = new THREE.Vector3(1, 1, 1);
  var tmpColor = new THREE.Color();
  var base = new THREE.Color(1, 1, 1);
  var segLen = ((Math.PI * 2 * A) / LONG) * 1.04;   // 片与片首尾相接

  function pointAt(t, u, out) {
    var x = A * Math.sin(t);
    var z = (A * Math.sin(2 * t)) / 3.6;
    var y = Math.sin(2 * t) * (B / 2);

    var dx = A * Math.cos(t);
    var dz = (A * 2 * Math.cos(2 * t)) / 3.6;
    var dy = Math.cos(2 * t) * B;
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    var tx = dx / len, ty = dy / len, tz = dz / len;

    var theta = t * TWIST;   // 统一扭转（不随 u 变化）：线条保持平行等距
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

  var box = new THREE.BoxGeometry(segLen, SLAB, (WIDTH / WIDE) * 0.92);   // 每个小方块：长×厚×宽
  // 逐实例颜色：明暗由我们按"带面位置"算出来（平滑、连续、有序），
  // 不依赖每块自己的朝向 -> 避免逐面光照导致的乱纹
  var material = new THREE.MeshLambertMaterial({ color: 0xffffff });
  var count = LONG * WIDE * LAYERS;
  var mesh = new THREE.InstancedMesh(box, material, count);
  mesh.frustumCulled = false;
  mesh.rotation.z = -0.05;
  scene.add(mesh);

  function buildField() {
    var i = 0;
    var m = new THREE.Matrix4();
    var pos = new THREE.Vector3();
    for (var s = 0; s < LONG; s += 1) {
      var t = (s / LONG) * Math.PI * 2;
      for (var wi = 0; wi < WIDE; wi += 1) {
      var u = (wi + 0.5) / WIDE;
      pointAt(t, u, tmp);                                    // 带上的一点
      normal.crossVectors(tmp.tan, tmp.wid).normalize();     // 带面法向 = 厚度方向
      // 基：X=切向（块长），Y=法向（厚度），Z=带宽方向
      basis.makeBasis(tmp.tan, normal, tmp.wid);
      quat.setFromRotationMatrix(basis);
      for (var k = 0; k < LAYERS; k += 1) {
        var off = (LAYERS === 1 ? 0 : (k / (LAYERS - 1) - 0.5)) * THICK_TOTAL;
        pos.copy(tmp.pos).addScaledVector(normal, off);
        m.compose(pos, quat, one);
        mesh.setMatrixAt(i, m);
        // 平滑明暗：带面中间最亮、两侧渐暗；厚度方向自上而下轻微递减
        var across = Math.cos((u - 0.5) * Math.PI);              // -?..1..?  中间=1
        var depth = 1 - (LAYERS === 1 ? 0 : k / (LAYERS - 1));   // 顶层更亮
        var lum = 0.80 + 0.16 * across * (0.75 + 0.25 * depth) + 0.06 * depth;
        if (lum > 1) lum = 1;
        tmpColor.setRGB(lum * base.r, lum * base.g, lum * base.b);
        mesh.setColorAt(i, tmpColor);
        i += 1;
      }
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  function applyTheme() {
    var paper = rgb('--paper-rgb', '242, 240, 235');
    var luma = (paper[0] * 0.299 + paper[1] * 0.587 + paper[2] * 0.114) / 255;
    var isLight = luma > 0.5;
    base.setRGB(isLight ? 0.945 : 0.20, isLight ? 0.938 : 0.235, isLight ? 0.922 : 0.255);
    material.color.setRGB(1, 1, 1);   // 实际颜色来自逐实例颜色
    ambient.intensity = isLight ? 0.92 : 0.88;
    key.intensity = isLight ? 0.16 : 0.22;
    fill.intensity = isLight ? 0.08 : 0.12;
    buildField();
  }

  function resize() {
    var w = host.clientWidth || window.innerWidth;
    var h = host.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    var far = Math.max(1, Math.min(w, h));
    camera.position.set(0, 12, far * 0.305);
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
