/* ============================================================================
   Stronghold Link — 三维档案阵列场（背景主视觉）
   ----------------------------------------------------------------------------
   直接移植 RhineLabUI 的 ArchiveScene，常数与材质逐项对齐源码：
     * src/archive-loop.ts  LOOP_COLUMNS=9 LOOP_ROWS=32 COLUMN_SPACING=5.2
                            ROW_SPACING=0.62 POOL_LANES=[0,1,2,3,4,-2,-1,5,6]
     * src/scene.ts          cellPosition(cell) = ((lane-2)*5.2, -4.6, (row-15.5)*0.62)
                             InstancedMesh 每个表面一个，288 个实例，DynamicDrawUsage
                             frustumCulled=false，只有 Optical_Diffuser 投影
     * src/scene.ts          camera 用 2*atan(span/(2*distance)) 反推 fov。稳定态是
                             方位角 59 度、仰角 19 度、取景高度 7.33、距离 140，
                             也就是长焦压缩透视，不是广角贴近。
     * src/scene.ts          camera = aim + viewDir*distance，指针视差只给 0.12 世界单位
     * src/archive-lighting  hemi(#fffaf5,#b4a18c,0.65) + key(#fff7ed,1.4) 在 (-6,14,-5)
                             + fill(#ffffff,0.6) 在 (7,8,-10)，无 AmbientLight
     * src/motion.ts         idleWave = 0.075*sin(2*pi*t/8 + row*0.3 - lane*0.45)
                                       + 0.027*sin(2*pi*t/13 - row*0.17 + lane*0.3)
     * src/scene.ts          雾 near = 渲染距离+5，far = 渲染距离+25，与背景同色
                             ACESFilmic 曝光 1.05，地板 #d8c9b9 在 y=-4.63

   性能约定：
     * draw call = 阵列表面数（5 个），与实例数无关；五个 InstancedMesh 共用同一份
       instanceMatrix，每帧只写 288 个矩阵
     * 默认关闭阴影与透射；档位 high 以上才开，二者都是额外的一整趟渲染
     * 页面隐藏 / prefers-reduced-motion 停止渲染
     * WebGL 不可用直接返回，背景退回 CSS 层，界面绝不空白
   ========================================================================= */
(function () {
  'use strict';

  /* ── 运行期控制面 ─────────────────────────────────────────────────────
     设置页的 3D 开关要真停真起。只改 data-stage-3d 属性的话，画布被 CSS 藏
     起来，WebGL 上下文、几何、材质、环境贴图全都留着，内存一点不省。
     所以这里先挂一个控制面，再决定要不要建场景：
       disable() 把整个场景销毁并把 GPU 资源交回系统
       enable()  把 data-stage-3d 置回 1 并重新注入一份本脚本
     live() 用来判断当前有没有活着的实例，避免重复注入。 */
  function injectStageScript() {
    if (typeof document === 'undefined' || !document.body) return;
    if (document.querySelector('script[data-stage-runtime]')) return;
    var s = document.createElement('script');
    s.src = 'stage.js';
    s.setAttribute('data-stage-runtime', '1');
    document.body.appendChild(s);
  }
  window.__shlStage = {
    enable: function () {
      if (typeof window.__shlStageLive === 'function') return;
      var root = document.documentElement;
      if (root && root.setAttribute) root.setAttribute('data-stage-3d', '1');
      injectStageScript();
    },
    disable: function () {
      var root = document.documentElement;
      if (root && root.setAttribute) root.setAttribute('data-stage-3d', '0');
      if (typeof window.__shlStageLive === 'function') window.__shlStageLive();
    },
    live: function () { return typeof window.__shlStageLive === 'function'; }
  };

  var host = document.querySelector('.bg');
  if (!host || typeof window.THREE === 'undefined') return;
  if (typeof window.WebGLRenderingContext === 'undefined') return;

  var reduceMotion = false;
  try {
    reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (typeof location !== 'undefined' && String(location.search || '').indexOf('motion=force') >= 0) reduceMotion = false;
  } catch (e) { /* 忽略 */ }

  /* ── 图形档位 ─────────────────────────────────────────────────────────
     由界面偏好写入 <html data-stage>，设置页可实时切换。
     data-stage-3d="0" 表示不建画布，退回 CSS 背景层。 */
  var QUALITY = {
    performance: { dpr: 0.85, fps: 20, shadows: false, transmission: 0 },
    balanced: { dpr: 1.0, fps: 30, shadows: false, transmission: 0 },
    high: { dpr: 1.25, fps: 30, shadows: true, transmission: 0.78 },
    ultra: { dpr: 1.5, fps: 40, shadows: true, transmission: 0.78 },
    custom: { dpr: 1.0, fps: 30, shadows: false, transmission: 0 }
  };
  var TIER_LADDER = ['ultra', 'high', 'balanced', 'performance'];

  function attr(name) {
    try { return document.documentElement.getAttribute(name); } catch (e) { return null; }
  }

  var quality = 'balanced';
  if (attr('data-stage-3d') === '0') return;
  var askedTier = attr('data-stage');
  if (askedTier && QUALITY[askedTier]) quality = askedTier;

  function spec() {
    if (quality !== 'custom') return QUALITY[quality] || QUALITY.balanced;
    var dpr = Number(attr('data-stage-dpr'));
    var fps = Number(attr('data-stage-fps'));
    return {
      dpr: (isFinite(dpr) && dpr > 0) ? dpr : 1.0,
      fps: (isFinite(fps) && fps > 0) ? fps : 30,
      shadows: false,
      transmission: attr('data-stage-modules') === '0' ? 0 : 0.78
    };
  }

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

  /* 源码是 Math.min(devicePixelRatio,1.5) * Math.min(w/1920, h/1080)，
     窗口小的时候会低于 1；这里补一个 0.6 的下限，避免小窗口糊成一片 */
  function pixelRatio() {
    var w = host.clientWidth || window.innerWidth || 1920;
    var h = host.clientHeight || window.innerHeight || 1080;
    var base = Math.min(window.devicePixelRatio || 1, spec().dpr);
    var fit = Math.min(w / 1920, h / 1080);
    return Math.max(0.6, base * Math.max(0.75, fit));
  }

  /* ── 阵列常数：逐项照抄源码 ─────────────────────────────────────────── */
  var LOOP_COLUMNS = 9;
  var LOOP_ROWS = 32;
  var COLUMN_SPACING = 5.2;
  var ROW_SPACING = 0.62;
  var POOL_LANES = [0, 1, 2, 3, 4, -2, -1, 5, 6];
  var BASE_Y = -4.6;

  /* src/scene.ts 的稳定构图：方位角 59 度、仰角 19 度、取景高度 7.33、距离 140 */
  var BASE_YAW = 59 * Math.PI / 180;
  var BASE_ELEV = 19 * Math.PI / 180;
  var BASE_SPAN = 7.33;
  var BASE_DIST = 140;
  var BASE_AIM = { x: -1.091, y: -0.045, z: 0.481 };

  var modTriangles = 0;

  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas: canvas, antialias: false, alpha: false, powerPreference: 'low-power'
    });
  } catch (err) {
    return;
  }
  renderer.setPixelRatio(pixelRatio());
  host.insertBefore(canvas, host.firstChild);

  var scrim = document.createElement('div');
  scrim.className = 'stage-scrim';
  host.insertBefore(scrim, canvas.nextSibling);

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(3, 16 / 9, 0.5, 400);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  /* 源项目用 PMREMGenerator + RoomEnvironment 做环境光，强度 0.48。
     RoomEnvironment 属于 three 的 addons，不在这份 UMD 核心里，所以按同样的
     思路搭一间棚：白盒内壁 + 顶灯 + 一暖一冷侧板 + 地面反弹。没有这一层，
     MeshPhysicalMaterial 拿不到任何 IBL，盒面会一片死灰。 */
  function studioEnvironment() {
    var pmrem = new THREE.PMREMGenerator(renderer);
    var env = new THREE.Scene();
    env.add(new THREE.Mesh(
      new THREE.BoxGeometry(10, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide })
    ));
    function panel(w, h, x, y, z, ry, color, gain) {
      var mat = new THREE.MeshBasicMaterial({ color: color });
      mat.color.multiplyScalar(gain);
      var m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      m.position.set(x, y, z);
      m.rotation.y = ry;
      env.add(m);
    }
    panel(7, 2.4, 0, 4.9, 0, 0, 0xffffff, 7);
    panel(5, 1.8, 1.6, 4.88, -3.4, 0, 0xfff4e6, 4);
    panel(4, 6, -4.9, 1, 0, Math.PI / 2, 0xfff6e8, 3);
    panel(4, 6, 4.9, 1, 0, -Math.PI / 2, 0xf1f5ff, 2);
    panel(10, 10, 0, -4.9, 0, 0, 0xd6cec3, 0.7);
    var tex = pmrem.fromScene(env, 0.04).texture;
    env.traverse(function (n) {
      if (n.geometry) n.geometry.dispose();
      if (n.material) n.material.dispose();
    });
    pmrem.dispose();
    return tex;
  }

  try {
    scene.environment = studioEnvironment();
    scene.environmentIntensity = 0.32;
  } catch (e) { /* 环境贴图失败就退回纯灯光 */ }

  /* 灯光照抄 src/archive-lighting.ts，没有 AmbientLight */
  var hemi = new THREE.HemisphereLight(0xfffaf5, 0xb4a18c, 0.45);
  scene.add(hemi);
  var key = new THREE.DirectionalLight(0xfff7ed, 1.55);
  key.position.set(-6, 14, -5);
  scene.add(key);
  var fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(7, 8, -10);
  scene.add(fill);

  /* 地板：源码有，色 #d8c9b9，在 y=-4.63，长焦俯视下只在缝隙里露一点 */
  var floor = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: 0xd8c9b9, roughness: 0.95 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -4.63;
  scene.add(floor);

  /* ── 槽位与矩阵 ─────────────────────────────────────────────────────── */
  var cells = [];
  var positions = [];
  var matrix = null;
  var parts = [];
  var group = new THREE.Group();
  scene.add(group);

  var mtx = new THREE.Matrix4();
  var pos = new THREE.Vector3();
  var quat = new THREE.Quaternion();
  var scl = new THREE.Vector3(1, 1, 1);
  var euler = new THREE.Euler();

  function buildCells() {
    cells.length = 0;
    positions.length = 0;
    for (var i = 0; i < LOOP_COLUMNS * LOOP_ROWS; i += 1) {
      var lane = POOL_LANES[Math.floor(i / LOOP_ROWS)];
      var row = i % LOOP_ROWS;
      cells.push({ lane: lane, row: row });
      positions.push(new THREE.Vector3(
        (lane - 2) * COLUMN_SPACING,
        BASE_Y,
        (row - 15.5) * ROW_SPACING
      ));
    }
  }

  /* src/motion.ts 的 idleWave：相邻卡片相位错开，最大位移 0.102 */
  var K8 = (Math.PI * 2) / 8;
  var K13 = (Math.PI * 2) / 13;
  function idleWave(row, lane, t) {
    return 0.075 * Math.sin(t * K8 + row * 0.3 - lane * 0.45)
      + 0.027 * Math.sin(t * K13 - row * 0.17 + lane * 0.3);
  }
  /* 稳定态就是 idleWave 的整片静默漂移，另加一张被抽出的档案。
     抽出高度取源片预览态的 0.4 世界单位，左右邻片各抬一点，避免单点突兀。 */
  var LIFT = 0.4;
  var FOCUS_LANE = 2;
  var FOCUS_ROW = 12;
  function field(row, lane, t) {
    var h = idleWave(row, lane, t);
    if (lane === FOCUS_LANE) {
      var d = row - FOCUS_ROW;
      h += LIFT * Math.exp(-0.5 * (d / 2.6) * (d / 2.6));
    }
    return h;
  }

  /* 源码：五个表面进阵列，Carbon_Ink 直接 continue 永不渲染 */
  var ARRAY_SURFACES = ['Frosted_Polymer', 'Ivory_Edges', 'Titanium_Fasteners',
    'Champagne_Index', 'Optical_Diffuser'];

  /* 阵列材质色：src/scene.ts 第 286-327 行的 arrayMat 分支 */
  function arrayColor(name) {
    if (name === 'Frosted_Polymer') return 0xfff7ed;
    if (name === 'Optical_Diffuser') return 0x806447;
    if (name === 'Ivory_Edges') return 0xfff5e9;
    if (name === 'Champagne_Index') return 0xe4d6c5;
    return 0xf0eade;
  }

  function tuneMaterial(src, name) {
    var mat = new THREE.MeshPhysicalMaterial({
      color: arrayColor(name),
      roughness: name === 'Ivory_Edges' ? 0.38 : 0.28,
      metalness: name === 'Champagne_Index' ? 0.05 : 0.02,
      clearcoat: name === 'Frosted_Polymer' ? 0.3 : 0,
      clearcoatRoughness: 0.25,
      envMapIntensity: 0.6
    });
    if (name === 'Frosted_Polymer') {
      mat.transmission = spec().transmission;
      mat.thickness = 0.12;
      mat.ior = 1.46;
      mat.attenuationColor = new THREE.Color(0xeee6df);
      mat.attenuationDistance = 2;
      /* 源码用高度渐变把下半段做得更粗糙、更暗，盒体才有厚度感 */
      mat.onBeforeCompile = function (shader) {
        shader.vertexShader = 'varying float vH;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvH = position.y / 3.7;'
        );
        shader.fragmentShader = 'varying float vH;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\nroughnessFactor = mix(0.48, 0.035, smoothstep(0.36, 0.68, vH));'
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <color_fragment>',
          '#include <color_fragment>\ndiffuseColor.rgb *= mix(vec3(0.40, 0.30, 0.20), vec3(1.0, 0.98, 0.94), smoothstep(0.1, 1.0, vH));'
        );
      };
    }
    mat.userData.baseColor = mat.color.clone();
    return mat;
  }

  function matName(m) {
    return (m && m.name ? m.name : '').replace(/\.\d+$/, '');
  }

  function disposeParts() {
    while (group.children.length) {
      var old = group.children.pop();
      group.remove(old);
      if (old.geometry) old.geometry.dispose();
      if (old.material) old.material.dispose();
    }
    parts.length = 0;
  }

  function buildArray(root) {
    disposeParts();
    root.updateMatrixWorld(true);
    var count = LOOP_COLUMNS * LOOP_ROWS;
    /* 五个表面共用同一份 instanceMatrix：每帧只写一次 288 个矩阵 */
    matrix = new THREE.InstancedBufferAttribute(new Float32Array(16 * count), 16);
    matrix.setUsage(THREE.DynamicDrawUsage);
    modTriangles = 0;
    root.traverse(function (node) {
      if (!node.isMesh || !node.geometry) return;
      var name = matName(node.material);
      if (ARRAY_SURFACES.indexOf(name) < 0) return;
      var geo = node.geometry.clone();
      geo.applyMatrix4(node.matrixWorld);
      var part = new THREE.InstancedMesh(geo, tuneMaterial(node.material, name), count);
      part.instanceMatrix = matrix;
      part.frustumCulled = false;
      part.castShadow = false;
      part.receiveShadow = false;
      parts.push(part);
      group.add(part);
      var idx = geo.index;
      modTriangles += (idx ? idx.count : geo.attributes.position.count) / 3;
    });
    writeInstances(0);
  }

  /* 每帧重组 288 个矩阵：
     position = 槽位 + 高度场（idleWave + 抬升），rotation.x = 局部坡度 * 0.024 */
  function writeInstances(t) {
    if (!matrix) return;
    var arr = matrix.array;
    for (var n = 0; n < cells.length; n += 1) {
      var c = cells[n];
      var p = positions[n];
      var slope = field(c.row + 0.5, c.lane, t) - field(c.row - 0.5, c.lane, t);
      euler.set(slope * 0.024, 0, 0);
      quat.setFromEuler(euler);
      pos.set(p.x, p.y + field(c.row, c.lane, t), p.z);
      mtx.compose(pos, quat, scl);
      mtx.toArray(arr, n * 16);
    }
    matrix.needsUpdate = true;
  }

  /* ── GLB 加载 ───────────────────────────────────────────────────────── */
  function loadModel() {
    if (typeof THREE.GLTFLoader !== 'function') return;
    var loader = new THREE.GLTFLoader();
    loader.load('assets/archive-cassette.glb',
      function (gltf) {
        if (!gltf || !gltf.scene) return;
        buildArray(gltf.scene);
        applyTheme();
      },
      undefined,
      function () { /* 加载失败就只留空场，背景退回 CSS 层 */ });
  }

  /* ── 主题 ───────────────────────────────────────────────────────────── */
  var isLight = true;
  var fogColor = new THREE.Color(0xeae5e1);

  function applyTheme() {
    var paper = rgb('--paper-rgb', '234, 229, 225');
    var luma = (paper[0] * 0.299 + paper[1] * 0.587 + paper[2] * 0.114) / 255;
    isLight = luma > 0.5;
    fogColor.setRGB(paper[0] / 255, paper[1] / 255, paper[2] / 255);
    if (!isLight) fogColor.multiplyScalar(0.55);

    hemi.intensity = isLight ? 0.45 : 0.3;
    hemi.groundColor.set(isLight ? 0xb4a18c : 0x2a2622);
    key.intensity = isLight ? 1.55 : 0.92;
    fill.intensity = isLight ? 0.6 : 0.34;
    floor.material.color.set(isLight ? 0xd8c9b9 : 0x3a352f);

    parts.forEach(function (p) {
      var base = p.material.userData.baseColor;
      if (base) p.material.color.copy(base).multiplyScalar(isLight ? 1 : 0.5);
    });
    scene.background = fogColor.clone();
  }

  /* ── 相机 ───────────────────────────────────────────────────────────── */
  var pointer = { x: 0, y: 0 };
  var smoothPointer = { x: 0, y: 0 };
  var aim = new THREE.Vector3(BASE_AIM.x, BASE_AIM.y, BASE_AIM.z);
  var camPos = new THREE.Vector3();

  function resize() {
    var w = host.clientWidth || window.innerWidth;
    var h = host.clientHeight || window.innerHeight;
    renderer.setPixelRatio(pixelRatio());
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }

  /* 方位角 / 仰角 / 距离 / 取景高度四个量做 30~90 秒级慢呼吸，
     指针视差只给 0.12 世界单位，和源码一致 */
  function placeCamera(t) {
    var yaw = BASE_YAW + (1.4 * Math.PI / 180) * Math.sin(t * (Math.PI * 2) / 72);
    var elev = BASE_ELEV + (0.9 * Math.PI / 180) * Math.sin(t * (Math.PI * 2) / 58 + 1.1);
    var dist = BASE_DIST + 5 * Math.sin(t * (Math.PI * 2) / 86 + 2.3);
    var span = BASE_SPAN + 0.22 * Math.sin(t * (Math.PI * 2) / 64);

    aim.set(
      BASE_AIM.x + 0.35 * Math.sin(t * (Math.PI * 2) / 72 + 0.6),
      BASE_AIM.y + 0.18 * Math.sin(t * (Math.PI * 2) / 86 + 1.9),
      BASE_AIM.z + 0.3 * Math.sin(t * (Math.PI * 2) / 90 + 2.7)
    );
    var vx = -Math.sin(yaw) * Math.cos(elev);
    var vy = Math.sin(elev);
    var vz = Math.cos(yaw) * Math.cos(elev);
    camPos.set(
      aim.x + vx * dist + smoothPointer.x * 0.12,
      aim.y + vy * dist - smoothPointer.y * 0.12,
      aim.z + vz * dist
    );
    camera.position.copy(camPos);
    camera.lookAt(aim);
    camera.fov = 2 * Math.atan(span / (2 * dist)) * 180 / Math.PI;
    camera.updateProjectionMatrix();
    /* 雾锚在渲染相机上，near/far 随距离走，远端永远在化进纸色前停住 */
    var rendered = camera.position.distanceTo(aim);
    scene.fog = new THREE.Fog(fogColor.getHex(), rendered + 5, rendered + 25);
    key.position.set(-6 + 1.5 * Math.sin(t * (Math.PI * 2) / 90), 14, -5 + 2 * Math.cos(t * (Math.PI * 2) / 74));
  }

  if (!reduceMotion) {
    window.addEventListener('mousemove', function (ev) {
      var w = window.innerWidth || 1;
      var h = window.innerHeight || 1;
      pointer.x = ((ev.clientX / w) - 0.5) * 2;
      pointer.y = ((ev.clientY / h) - 0.5) * 2;
    }, { passive: true });
  }

  /* ── 主循环 ─────────────────────────────────────────────────────────── */
  var clock = 0;
  var running = true;
  var disposed = false;
  var rafId = 0;
  var releaseTimer = 0;
  /* 最小化后隔多久真正释放场景。留一点延迟是为了避免用户快速最小化又恢复
     时白做一次销毁加重建。 */
  var RELEASE_DELAY_MS = 1200;
  var lastPaint = 0;
  var FRAME_MIN_MS = Math.round(1000 / spec().fps);

  var autoLocked = false;
  var costSum = 0, costCount = 0, cooldown = 0;

  function adapt(costMs) {
    if (autoLocked) return;
    costSum += costMs;
    costCount += 1;
    if (costCount < 90) return;
    var avg = costSum / costCount;
    costSum = 0; costCount = 0;
    if (cooldown > 0) { cooldown -= 1; return; }
    var budget = 1000 / Math.max(1, spec().fps);
    var fps = 1000 / Math.max(0.01, avg + budget * 0.35);
    if (fps >= 45) return;
    var at = TIER_LADDER.indexOf(quality);
    if (at < 0 || at >= TIER_LADDER.length - 1) return;
    var next = TIER_LADDER[at + 1];
    var from = quality;
    quality = next;
    cooldown = 3;
    FRAME_MIN_MS = Math.round(1000 / spec().fps);
    renderer.setPixelRatio(pixelRatio());
    resize();
    try {
      window.dispatchEvent(new CustomEvent('shl-quality-auto', { detail: { from: from, to: next, fps: Math.round(fps) } }));
    } catch (e) { /* 忽略 */ }
  }

  function frame(now) {
    if (disposed || !running) return;
    rafId = requestAnimationFrame(frame);
    var t = now || 0;
    if (document.hidden) return;
    if (!reduceMotion) {
      if (t - lastPaint < FRAME_MIN_MS) return;
      lastPaint = t;
      clock += 0.033;
      smoothPointer.x += (pointer.x - smoothPointer.x) * 0.05;
      smoothPointer.y += (pointer.y - smoothPointer.y) * 0.05;
      placeCamera(clock);
      writeInstances(clock);
    }
    var cost0 = (window.performance && performance.now) ? performance.now() : 0;
    renderer.render(scene, camera);
    if (cost0) adapt(((window.performance && performance.now) ? performance.now() : 0) - cost0);
  }

  try { document.documentElement.classList.add('has-3d'); } catch (e) { /* 忽略 */ }
  buildCells();
  applyTheme();
  resize();
  placeCamera(0);
  loadModel();
  if (reduceMotion) { placeCamera(0); writeInstances(0); }
  frame(0);

  window.addEventListener('resize', onResize);
  /* 设置页实时切档：像素密度、帧率、阴影与透射即时生效 */
  window.addEventListener('shl-quality', onQualityChange);
  var observer = null;
  function onResize() { resize(); }
  function onQualityChange(ev) {
    if (disposed) return;
    var next = ev && ev.detail;
    if (!next || !QUALITY[next]) return;
    quality = next;
    autoLocked = true;
    FRAME_MIN_MS = Math.round(1000 / spec().fps);
    renderer.setPixelRatio(pixelRatio());
    renderer.shadowMap.enabled = spec().shadows;
    resize();
    loadModel();
    if (!running) { running = true; frame(0); }
  }
  function onVisibility() {
    if (disposed) return;
    setActive(!document.hidden);
  }
  function releaseEnabled() { return attr('data-stage-release') === '1'; }
  /* 前台恢复 / 最小化。开着「最小化时释放」就在延迟后把场景整个交回系统，
     否则只停循环。 */
  function setActive(active) {
    if (disposed) return;
    if (active) {
      if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = 0; }
      if (!running) { running = true; frame(0); }
      return;
    }
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (releaseEnabled() && !releaseTimer) {
      releaseTimer = setTimeout(function () {
        releaseTimer = 0;
        disposeStage();
      }, RELEASE_DELAY_MS);
    }
  }
  var activityHook = function (active) { setActive(active); };
  try {
    if (window.MutationObserver) {
      observer = new MutationObserver(function () { applyTheme(); writeInstances(clock); });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    document.addEventListener('visibilitychange', onVisibility);
    window.__shlActivity = window.__shlActivity || [];
    window.__shlActivity.push(activityHook);
  } catch (e) { /* 忽略 */ }

  /* ── 销毁：把这一份实例占的资源全部交回系统 ───────────────────────────
     几何、材质、环境贴图、渲染器与 WebGL 上下文一个不留，监听器与活动钩子
     也要摘掉，否则最小化释放之后钩子还会来拉起一个已经死掉的实例。 */
  function disposeStage() {
    if (disposed) return;
    disposed = true;
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = 0; }
    try { window.removeEventListener('resize', onResize); } catch (e) { /* 忽略 */ }
    try { window.removeEventListener('shl-quality', onQualityChange); } catch (e) { /* 忽略 */ }
    try { document.removeEventListener('visibilitychange', onVisibility); } catch (e) { /* 忽略 */ }
    if (observer) { try { observer.disconnect(); } catch (e) { /* 忽略 */ } observer = null; }
    try {
      var list = window.__shlActivity;
      if (Array.isArray(list)) {
        for (var i = list.length - 1; i >= 0; i -= 1) if (list[i] === activityHook) list.splice(i, 1);
      }
    } catch (e) { /* 忽略 */ }
    try {
      for (var p = 0; p < parts.length; p += 1) {
        var part = parts[p];
        if (!part) continue;
        if (part.geometry && part.geometry.dispose) part.geometry.dispose();
        var mat = part.material;
        if (mat) {
          if (mat.map && mat.map.dispose) mat.map.dispose();
          if (mat.dispose) mat.dispose();
        }
      }
    } catch (e) { /* 忽略 */ }
    parts = [];
    matrix = null;
    try {
      while (group.children.length) group.remove(group.children[0]);
      scene.remove(group);
      scene.remove(floor);
      scene.remove(hemi);
      scene.remove(key);
      scene.remove(fill);
      if (floor.geometry) floor.geometry.dispose();
      if (floor.material) floor.material.dispose();
      if (scene.environment) { scene.environment.dispose(); scene.environment = null; }
      scene.background = null;
      scene.fog = null;
    } catch (e) { /* 忽略 */ }
    try {
      if (renderer) {
        renderer.renderLists.dispose();
        renderer.dispose();
        if (renderer.forceContextLoss) renderer.forceContextLoss();
      }
    } catch (e) { /* 忽略 */ }
    renderer = null;
    try { if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas); } catch (e) { /* 忽略 */ }
    try { if (scrim && scrim.parentNode) scrim.parentNode.removeChild(scrim); } catch (e) { /* 忽略 */ }
    try { document.documentElement.classList.remove('has-3d'); } catch (e) { /* 忽略 */ }
    window.__shlStageLive = null;
  }
  /* 函数声明会提升，所以上面 injectStageScript 里的 typeof 判断在注入完成前
     也拿得到这个引用。 */
  window.__shlStageLive = disposeStage;
})();
