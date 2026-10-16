'use strict';
// 纹样系统与动效外壳的契约（0.14.6）。
//
// 为什么要有它 —— 这三类错误都是这个版本里真踩过的，而且都**不报错**：
//  1) 8 位十六进制色的字节序：Qt 的 QML 是 #AARRGGBB，不是 CSS 的 #RRGGBBAA。写反了不报语法错，
//     只是颜色整个变样（历史缺陷：转场时面板遮罩变成大块纯黑、黄绿色线条）。
//  2) 新增的 QML/JS 必须逐文件登记进 app_qml/qml.qrc，否则 rcc 里根本没有它，
//     改了也不生效（构建还报 "Nothing to be done"，极难自查）。
//  3) 源码编码事故：文件曾被 CP936 误读后写回，中文注释变成替换字符、行被吞、代码被裹进注释。
//     这类损坏肉眼很难逐个发现，但扫一遍替换字符就能当场看见。
//
// 这四条都不需要 Qt、不需要编译，直接在 CI 里跑。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// 递归收集源码文件（QML 与绘图 JS）
function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'build' || ent.name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.(qml|js)$/.test(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

const qmlDir = path.join(root, 'app_qml', 'qml');
const sources = walk(qmlDir);
const rel = (p) => path.relative(root, p).split(path.sep).join('/');

test('★ 8 位色一律写成 Qt 的 #AARRGGBB，不许混进 CSS 的 #RRGGBBAA', () => {
  // 判据：把项目里用到的六位色（调色板）全收集起来，然后看每个 8 位色的**前六位**是不是
  // 恰好等于其中一个调色板色 —— 这正是 CSS 顺序的特征（`#22282b00` 会被 Qt 读成
  // alpha=0x22 的另一种颜色，历史缺陷里整块面板因此变成near-black）。
  // Qt 正确顺序下前六位是 "AA RRGG"，不可能与调色板撞上，所以这条判据不误伤。
  const palette = new Set();
  for (const file of sources) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/#([0-9a-fA-F]{6})\b(?!\s*[0-9a-fA-F])/g)) {
      palette.add(m[1].toLowerCase());
    }
  }
  const bad = [];
  for (const file of sources) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/#([0-9a-fA-F]{8})\b/g)) {
        const hex = m[1].toLowerCase();
        if (palette.has(hex.slice(0, 6))) {
          bad.push(`${rel(file)}:${i + 1} #${hex} —— 前六位是调色板色，这是 CSS 顺序，请写成 #${hex.slice(6)}${hex.slice(0, 6)}`);
        }
      }
    });
  }
  assert.deepEqual(bad, [], `8 位色请写成 #AARRGGBB（alpha 在前）：\n${bad.join('\n')}`);
});

test('★ 源码里不许出现替换字符或 BOM（编码事故的回归护栏）', () => {
  const bad = [];
  for (const file of sources) {
    const buf = fs.readFileSync(file);
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bad.push(`${rel(file)} 带 UTF-8 BOM`);
    const text = buf.toString('utf8');
    if (text.includes('\uFFFD')) {
      const line = text.split(/\r?\n/).findIndex((l) => l.includes('\uFFFD')) + 1;
      bad.push(`${rel(file)}:${line} 含替换字符 U+FFFD`);
    }
    if (/[\uE000-\uF8FF]/.test(text)) bad.push(`${rel(file)} 含私用区字符（编码事故的典型残留）`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('★ 纹样模块：六个子系统与四个组合模板的出口都在', () => {
  const src = read('app_qml/qml/plate/motifs.js');
  assert.match(src, /^\.pragma library/m, 'motifs.js 必须是 .pragma library');
  // 子系统一：飞鸟与羽毛（形态系列 A–G + 鸟群编队）
  assert.match(src, /function bird\(/, '缺少 bird()');
  assert.match(src, /function flock\(/, '缺少 flock()');
  assert.match(src, /function feather\(/, '缺少 feather()');
  assert.match(src, /var POSES/, '缺少鸟类形态表 POSES');
  for (const k of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
    assert.match(src, new RegExp(`\\b${k}:\\s*\\{`), `形态系列缺少 ${k}`);
  }
  // 子系统二～六
  for (const fn of ['halo', 'haloCore', 'wing', 'wingArc', 'arch', 'roseWindow',
    'axisNet', 'angleScale', 'goldenSpiral', 'polygonNest', 'circularText', 'seal']) {
    assert.match(src, new RegExp(`function ${fn}\\(`), `缺少 ${fn}()`);
  }
  // 参考图语汇（"看着舒适"那一版新增的柔光/技术标记）
  for (const fn of ['lightShafts', 'softGlow', 'softMass', 'backdrop', 'hairAxis', 'dashArc', 'medallion']) {
    assert.match(src, new RegExp(`function ${fn}\\(`), `缺少 ${fn}()`);
  }
  // 四个组合模板 + 入口
  for (const t of ['templateA', 'templateB', 'templateC', 'templateD']) {
    assert.match(src, new RegExp(`function ${t}\\(`), `缺少 ${t}()`);
  }
  assert.match(src, /function template\(ctx, name/, '缺少模板入口 template()');
  // 屏幕补偿：小窗口下线条要按 1/scale 加粗，否则整块糊掉
  assert.match(src, /var PX = 1\.0/, '缺少屏幕补偿系数 PX');
});

test('★ 新增的 QML/JS 都登记进 qml.qrc', () => {
  const qrc = read('app_qml/qml.qrc');
  for (const f of [
    'qml/plate/motifs.js', 'qml/plate/sketch.js', 'qml/quotes.js',
    'qml/Components/MotifPlate.qml', 'qml/Components/QuoteLine.qml',
    'qml/Components/Sweep.qml', 'qml/Components/WindowBar.qml', 'qml/Components/EdgeGrip.qml',
  ]) {
    assert.ok(qrc.includes(f), `qml.qrc 没登记 ${f}（rcc 里不会有它，改了也不生效）`);
  }
});

test('★ 题词那一行必须画在标题栏之上（z 小于标题栏就会整条被盖掉）', () => {
  const src = read('app_qml/qml/Main.qml');
  // 只认"整行就是 z: 数字"的写法：注释里提到的 z:1200 不能算（这个坑第一次写这条断言时就踩了）
  const zAfter = (id) => {
    const at = new RegExp(`^[ \\t]*id:[ \\t]*${id}\\b`, 'm').exec(src);
    if (!at) return null;
    const m = /^[ \t]*z:[ \t]*(\d+)/m.exec(src.slice(at.index, at.index + 1200));
    return m ? Number(m[1]) : null;
  };
  const chromeZ = zAfter('chrome');
  const quoteZ = zAfter('quoteLine');
  assert.ok(chromeZ !== null, 'Main.qml 里找不到标题栏 chrome 的 z');
  assert.ok(quoteZ !== null, 'Main.qml 里找不到题词 quoteLine 的 z');
  assert.ok(quoteZ > chromeZ,
    `题词的 z(${quoteZ}) 必须大于标题栏的 z(${chromeZ})：标题栏有不透光纸底，盖住就一个字都看不见`);
});

test('★ 转场纹样（模板 D）必须压在最上层，且不被进场缓动/合并重绘拖平', () => {
  const src = read('app_qml/qml/Main.qml');
  const plate = read('app_qml/qml/Components/MotifPlate.qml');

  // 玫瑰窗是"仪式性转场层"，规范要求压在最上层：z 必须高过百叶(950)与整窗斜切带(960)，
  // 否则这两层转场会在它上面，把短促闪现的玫瑰窗盖掉（踩过的坑）。
  const zAfter = (id) => {
    const at = new RegExp(`^[ \\t]*id:[ \\t]*${id}\\b`, 'm').exec(src);
    if (!at) return null;
    const m = /^[ \t]*z:[ \t]*(\d+)/m.exec(src.slice(at.index, at.index + 1200));
    return m ? Number(m[1]) : null;
  };
  const dZ = zAfter('transitionMotifPlate');
  const blindsZ = zAfter('blinds');
  const sweepZ = zAfter('pageSweep');
  assert.ok(dZ !== null && blindsZ !== null && sweepZ !== null, 'Main.qml 里找不到转场层的 z');
  assert.ok(dZ > Math.max(blindsZ, sweepZ),
    `转场玫瑰窗 z(${dZ}) 必须高过百叶(${blindsZ})与斜切带(${sweepZ})，否则会被盖掉`);

  // 转场层是自己在 0→1→0 地跑，不能再叠 MotifPlate 的进场缓动（会把上升段拖平），
  // 而且必须逐帧同步重绘（Immediate），否则 Canvas 的合并重绘会吞掉中间值 —— 两处都踩过坑。
  const dBlock = src.slice(src.indexOf('id: transitionMotifPlate'), src.indexOf('id: pageSweep'));
  assert.match(dBlock, /animateReveal:\s*false/, '转场层必须关闭进场缓动 animateReveal: false');
  assert.match(dBlock, /renderMode:\s*Canvas\.Immediate/, '转场层必须逐帧同步重绘 renderMode: Canvas.Immediate');
  assert.match(plate, /property bool animateReveal/, 'MotifPlate 缺 animateReveal 开关');
  assert.match(plate, /property int renderMode/, 'MotifPlate 缺 renderMode 开关');
  assert.match(plate, /enabled:\s*root\.animateReveal/, 'MotifPlate 的 Behavior 没接到 animateReveal 开关');
  assert.match(plate, /renderStrategy:\s*root\.renderMode/, 'MotifPlate 的 renderStrategy 没接到 renderMode');
});

test('★ 鸟群要"浩浩荡荡"：鸟够多、铺得开、而且是多股不是一列', () => {
  // 用户口径原话："鸟多一点，繁杂一点，不要只有一列，要浩浩荡荡的，那种鸟群"。
  // 这类要求只能量出来：用一个"假 canvas"跑 motifs.js，数 bird() 里那次 destination-out
  // （每只鸟恰好一次），就能拿到每张图的真实鸟数与它们的落点分布。
  const vm = require('node:vm');
  const src = read('app_qml/qml/plate/motifs.js').replace(/^\s*\.pragma\s+library\s*$/m, '');

  const makeCtx = () => {
    const st = { birds: [], a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const stack = [];
    const mul = (m) => {
      const { a, b, c, d, e, f } = st;
      st.a = a * m.a + c * m.b; st.b = b * m.a + d * m.b;
      st.c = a * m.c + c * m.d; st.d = b * m.c + d * m.d;
      st.e = a * m.e + c * m.f + e; st.f = b * m.e + d * m.f + f;
    };
    const noop = () => {};
    const ctx = {
      canvas: { width: 980, height: 520 },
      save() { stack.push({ ...st }); },
      restore() { const s = stack.pop(); if (s) Object.assign(st, s); },
      translate(x, y) { mul({ a: 1, b: 0, c: 0, d: 1, e: x, f: y }); },
      rotate(r) { const co = Math.cos(r), si = Math.sin(r); mul({ a: co, b: si, c: -si, d: co, e: 0, f: 0 }); },
      scale(x, y) { mul({ a: x, b: 0, c: 0, d: y, e: 0, f: 0 }); },
      setTransform: noop, resetTransform: noop, transform: noop,
      beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop, arcTo: noop, ellipse: noop,
      rect: noop, quadraticCurveTo: noop, bezierCurveTo: noop, stroke: noop, fill: noop, clip: noop,
      fillRect: noop, strokeRect: noop, clearRect: noop, setLineDash: noop, reset: noop,
      measureText: () => ({ width: 8 }), fillText: noop, strokeText: noop,
      createLinearGradient: () => ({ addColorStop: noop }),
      createRadialGradient: () => ({ addColorStop: noop }),
      createPattern: () => null, drawImage: noop, getLineDash: () => [],
    };
    Object.defineProperty(ctx, 'globalCompositeOperation', {
      get: () => st.gco || 'source-over',
      set: (v) => { st.gco = v; if (v === 'destination-out') st.birds.push({ x: st.e, y: st.f }); },
    });
    Object.defineProperty(ctx, 'globalAlpha', { get: () => 1, set: noop });
    ctx.__birds = () => st.birds;
    return ctx;
  };

  const sandbox = { Math, console };
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;globalThis.__api = { templateA: templateA, templateB: templateB, templateC: templateC, flock: flock };',
    sandbox);
  const api = sandbox.__api;

  const draw = (fn, w = 980, h = 520, opt = { seed: 61, t: 1, phase: 0 }) => {
    const ctx = makeCtx();
    fn(ctx, w, h, opt);
    return ctx.__birds();
  };

  const a = draw(api.templateA);
  // 现在的量级：模板 A 79 只（原版 33）、C 64 只（原版 14）、B 22 只（原版 7）。
  // 门槛压在实测值之下留出调整余量，但明显高于"一列小鸟"的旧版 —— 掉回去就会被拦住。
  assert.ok(a.length >= 60, `模板 A 的鸟太少（${a.length} 只），用户要的是"浩浩荡荡的鸟群"`);
  const aSpanX = (Math.max(...a.map((b) => b.x)) - Math.min(...a.map((b) => b.x))) / 980;
  const aSpanY = (Math.max(...a.map((b) => b.y)) - Math.min(...a.map((b) => b.y))) / 520;
  assert.ok(aSpanX >= 0.6, `模板 A 的鸟横向只铺开 ${(aSpanX * 100).toFixed(0)}%，不够"浩荡"`);
  assert.ok(aSpanY >= 0.6, `模板 A 的鸟纵向只铺开 ${(aSpanY * 100).toFixed(0)}%，不够"浩荡"`);

  const c = draw(api.templateC, 980, 520, { seed: 131, t: 1, phase: 0 });
  assert.ok(c.length >= 45, `模板 C 的鸟太少（${c.length} 只）`);
  assert.ok(draw(api.templateB, 980, 520, { seed: 97, t: 1, phase: 0 }).length >= 14, '模板 B 的穿拱鸟群太少');

  // "不要只有一列"：同一条水平航线、同样的总鸟数，多股编队的法向（y）铺开必须明显更大
  const spreadY = (streams) => {
    const birds = draw((ctx, w, h, o) => api.flock(ctx, o), 980, 120,
      { path: 'line', x0: 20, y0: 60, x1: 960, y1: 60, streams, count: 24, lateral: 120,
        wander: 6, minGap: 0.24, size: 22, seed: 5, t: 1 });
    const ys = birds.map((b) => b.y);
    return Math.max(...ys) - Math.min(...ys);
  };
  const one = spreadY(1);
  const three = spreadY(3);
  assert.ok(three > one * 2.5, `三股编队的法向铺开（${three.toFixed(0)}px）没有明显大于单列（${one.toFixed(0)}px）—— 又做成一列了`);
});

test('★ 引语模块：数据集、落盘接口与标题栏一行都在', () => {
  const quotes = read('app_qml/qml/quotes.js');
  const keys = [...quotes.matchAll(/key:\s*["']([^"']+)["']/g)].map((m) => m[1]);
  assert.ok(keys.length >= 30, `离线兜底条目太少（${keys.length} 条）`);
  assert.equal(new Set(keys).size, keys.length, '存在重复的 key');
  for (const kind of ['哲学', '文学', '诗歌']) {
    assert.ok(quotes.includes(kind), `缺少分类 ${kind}`);
  }
  const backend = read('backend/business.cjs');
  for (const m of ['quotes.load', 'quotes.save', 'quotes.fetch']) {
    assert.ok(backend.includes(`'${m}'`), `后端没注册 ${m}`);
  }
  assert.match(backend, /AbortSignal\.timeout\(/, '联网抓取必须带超时');
  assert.ok(read('app_qml/qml/Components/QuoteLine.qml').includes('signal step('), 'QuoteLine 缺少 step 信号');
});

test('★ 纹样设计规范文档在位（交付物的一部分）', () => {
  const doc = read('docs/纹样设计规范.md');
  assert.ok(doc.split('\n').length >= 200, '规范文档太短，六子系统的口径写不下');
  for (const n of ['1', '2', '3', '4', '5', '6']) {
    assert.match(doc, new RegExp(`^#+\\s*3\\.${n}`, 'm'), `规范缺少第 3.${n} 子系统`);
  }
  for (const t of ['鸟群 + 圣徽', '羽翼 + 圣堂拱', '坐标轴', '玫瑰窗']) {
    assert.ok(doc.includes(t), `规范缺少组合模板「${t}」`);
  }
  assert.match(doc, /验收/, '规范缺少验收清单');
});
