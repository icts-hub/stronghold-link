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
