'use strict';
// 动效系统的契约（时间基准、令牌、缓动语义、循环白名单）。
//
// 为什么要有它：动效代码最容易"看起来没问题但物理上错了"——比如相位用"每个 tick 加固定值"
// 推进，界面在自己的机器上很顺，换台机器（或掉帧、或窗口被系统限频）就快慢不对。
// 这些错误编译不报、跑起来也不报，只能靠断言把它们钉住。
//
// 这些检查不需要 Qt、不需要编译，直接在 CI 里跑。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const qmlDir = path.join(root, 'app_qml', 'qml');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'build' || ent.name === 'node_modules') continue;
      walk(full, out);
    } else if (ent.name.endsWith('.qml')) {
      out.push(full);
    }
  }
  return out;
}

const qmls = walk(qmlDir);
const rel = (p) => path.relative(root, p).split(path.sep).join('/');

test('★ 屏幕缩放比必须量化后再比较，否则静态图版会被"逐帧重绘"', () => {
  // 现场：版面的 scale 会随呼吸缩放/指针视差/切页顶动连续变化，uiScale 是 mapToItem 量出来的，
  // 逐帧比较会每帧都判定"变了"→ requestPaint → 静态图版变成逐帧重绘，画布背衬不停重新分配。
  // 实测后果：会话页内存 24 秒里从 272 MiB 涨到 469 MiB。量化到 0.05 一档后回落到 340 MiB 平稳。
  const src = read('app_qml/qml/Components/MotifPlate.qml');
  assert.match(src, /Math\.round\(\s*s\s*\/\s*0\.05\s*\)\s*\*\s*0\.05/,
    'MotifPlate 的 syncUiScale 没有把缩放比量化到 0.05 一档');
  assert.ok(!/Math\.abs\(\s*s\s*-\s*uiScale\s*\)\s*>\s*0\.02/.test(src),
    'syncUiScale 又回到"逐帧比较未量化的缩放比"了（会变成每帧重绘）');
});

test('★ 常驻相位必须按真实经过时间推进，不能"每 tick 加一个固定值"', () => {
  const src = read('app_qml/qml/Components/MotifPlate.qml');
  // 反面证据：直接对 phase 做常量累加（帧率相关）
  assert.ok(!/phase\s*=\s*\(\s*root\.phase\s*\+\s*0?\.\d+\s*\)/.test(src),
    'MotifPlate 的 phase 又变回"每 tick 加固定值"了 —— 这会让滑翔速度取决于 Timer 触发频率');
  // 正面证据：用时间戳求差，并且对异常大的间隔做了钳制（暂停/最小化回来不跳相）
  assert.match(src, /Date\.now\(\)/, 'MotifPlate 没有用 Date.now() 求真实时间差');
  assert.match(src, /Math\.min\(\s*\d+\s*,\s*now\s*-\s*root\.lastTickMs\s*\)/,
    'MotifPlate 没有钳制单帧间隔（恢复/掉帧时会跳一大段相位）');
  assert.match(src, /dt\s*\/\s*1000\s*\*\s*root\.phaseSpeed/,
    'MotifPlate 的相位没有按 phaseSpeed（每秒循环数）推进');
  // 暂停时必须清掉时间基准，否则恢复后第一帧 dt 巨大
  assert.match(src, /onRunningChanged[\s\S]{0,120}lastTickMs\s*=\s*0/,
    'MotifPlate 的 Timer 停止时没有重置 lastTickMs');
});

test('★ 动效令牌集中在 theme.js，并且真的被页面用上了', () => {
  const theme = read('app_qml/qml/theme.js');
  for (const k of ['DUR_PRESS', 'DUR_HOVER', 'DUR', 'DUR_ENTER', 'STAGGER',
    'LIFT', 'SKEW', 'DUR_WIPE', 'DUR_SWEEP', 'DUR_MOVE', 'STAGGER_WIPE']) {
    assert.match(theme, new RegExp(`var ${k}\\s*=`), `theme.js 缺少令牌 ${k}`);
  }
  // 令牌不是摆设：QML 侧必须引用它们
  let hits = 0;
  for (const f of qmls) {
    const t = fs.readFileSync(f, 'utf8');
    hits += (t.match(/T\.(DUR|STAGGER|SKEW|LIFT)/g) || []).length;
  }
  assert.ok(hits >= 40, `QML 里只引用了 ${hits} 次动效令牌，说明很多动画还在写死时长`);
});

test('★ 缓动按语义分开用，不允许"一套曲线打天下"', () => {
  const seen = new Map();
  for (const f of qmls) {
    const t = fs.readFileSync(f, 'utf8');
    for (const m of t.matchAll(/Easing\.(\w+)/g)) {
      seen.set(m[1], (seen.get(m[1]) || 0) + 1);
    }
  }
  // 至少四种：位移/擦除用 Out*，循环用 InOutSine，循环漂移才允许 Linear
  assert.ok(seen.size >= 4, `只用了 ${seen.size} 种缓动（${[...seen.keys()].join('/')}），说明曲线没按物理意义分`);
  for (const need of ['OutCubic', 'OutQuint', 'InOutSine']) {
    assert.ok(seen.has(need), `缺少 ${need} 缓动`);
  }
  // Linear 只允许用在"匀速循环漂移"（扫描带/尘埃带），不能用在元素进退场
  const linear = (seen.get('Linear') || 0);
  assert.ok(linear <= 2, `有 ${linear} 处用了 Easing.Linear —— 位移/进退场不该匀速`);
});

test('★ 没有超长动画：单段时长超过 2 秒的只允许是常驻循环', () => {
  // 白名单全是"常驻循环"，不是转场：
  //   7300 / 11000 扫描带、16000 漂移带、13000 版面呼吸、24000 雷达扫线、
  //   96000 自转刻度环、150000 极慢光晕、2200 / 4600 面板数据点脉冲
  const allowed = new Set([2200, 2400, 4600, 7300, 11000, 13000, 16000, 24000, 96000, 150000]);
  const bad = [];
  for (const f of qmls) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const m = /duration:\s*(\d{4,})/.exec(line);
      if (!m) return;
      const ms = Number(m[1]);
      if (ms > 2000 && !allowed.has(ms)) bad.push(`${rel(f)}:${i + 1} duration=${ms}`);
    });
  }
  assert.deepEqual(bad, [], `这些动画太长（>2s，且不在常驻循环白名单里）：\n${bad.join('\n')}`);
});

test('★ 失焦/最小化必须停止常驻动效（只放行 bookkeeping 与验收用定时器）', () => {
  const main = read('app_qml/qml/Main.qml');
  assert.match(main, /readonly property bool awake:\s*root\.visible\s*&&\s*root\.visibility\s*!==\s*Window\.Minimized/,
    'Main.qml 没有 awake（可见 && 非最小化）这个总闸');

  // 用花括号配对切出每个 Timer 块（正则切不准，会一路吃到下一个块）
  const blocks = [];
  const re = /Timer\s*\{/g;
  let m;
  while ((m = re.exec(main)) !== null) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    let end = i;
    for (; i < main.length; i += 1) {
      if (main[i] === '{') depth += 1;
      else if (main[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    blocks.push(main.slice(m.index, end + 1));
  }
  assert.ok(blocks.length >= 5, `只解析到 ${blocks.length} 个 Timer，解析可能失效`);

  // 允许不挂 awake/animating 的：--cycle 验收定时器（只在命令行开关下跑）、--perf 心跳
  const bad = [];
  for (const b of blocks) {
    if (!/repeat:\s*true/.test(b)) continue;                    // 一次性定时器不用管
    if (/id:\s*cycleTimer/.test(b)) continue;
    if (/perfOn/.test(b)) continue;
    if (/awake|animating/.test(b)) continue;
    const idm = /id:\s*(\w+)/.exec(b);
    bad.push(idm ? idm[1] : b.split('\n')[0].trim());
  }
  assert.deepEqual(bad, [], `这些常驻 Timer 没挂 awake/animating（最小化/失焦后还在跑）：${bad.join(', ')}`);

  // 动效总闸必须是"可见 && 非最小化 && 有焦点"：装饰动画在别的程序抢焦点时停，但状态轮询仍按 awake 走
  assert.match(main, /readonly property bool animating:\s*awake\s*&&\s*root\.active/,
    'Main.qml 没有 animating（awake && active）这道动效总闸');
  assert.match(main, /id: hudTimer[\s\S]{0,200}running:\s*root\.animating/,
    'hudTimer（视差/呼吸驱动）没有挂在 animating 上');
});
