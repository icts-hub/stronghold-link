'use strict';
// ============================================================================
// MiSans 字体子集裁剪（开发工具，不参与打包运行）
//
// 为什么需要它：
//   MiSans 官方 webfont 分包（misans-webfont）每个字重 188 个子集、约 5.8 MB，
//   三个字重就是 17 MB 以上。而我们界面上出现的汉字是有限且已知的集合，
//   所以这里按「界面真实字符集」把不需要的子集剔掉，只保留命中的那些。
//
// 用法：
//   npm i --no-save misans-webfont@4.3.1     # 只下载，不写入 package.json
//   node tools/prepare-misans.cjs            # 生成 src/ui/fonts/misans/
//   npm uninstall --no-save misans-webfont   # 裁完即可删除（产物已入库）
//
// 输出：
//   src/ui/fonts/misans/misans.css      只包含命中字符集的 @font-face
//   src/ui/fonts/misans/misans-*.woff2  对应子集文件
//   src/ui/fonts/misans/SOURCE.txt      来源、版本、许可、复现步骤
//
// 许可：MiSans 版权归小米所有（Copyright © 2020-2023 Beijing Xiaomi Mobile
//   Software Co.,Ltd.）。分包工具 cn-font-split 与 misans-webfont 仓库为
//   Apache-2.0。本项目按 MiSans 免费商用条款使用并保留署名，未修改字形。
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PKG = path.join(ROOT, 'node_modules', 'misans-webfont');
const OUT_DIR = path.join(ROOT, 'src', 'ui', 'fonts', 'misans');
const WEIGHTS = [
  { dir: 'misans-light', family: 'MiSans', weight: 300, tag: 'light' },
  { dir: 'misans-regular', family: 'MiSans', weight: 400, tag: 'regular' },
  { dir: 'misans-demibold', family: 'MiSans', weight: 600, tag: 'demibold' },
];

/** 界面文本来源：渲染层能看到的一切静态文字都在这里。 */
const TEXT_SOURCES = [
  'src/ui/index.html',
  'src/ui/styles/base.css',
  'src/ui/styles/components.css',
  'src/ui/styles/views.css',
  'src/ui/styles/tokens.css',
  'electron/main.cjs',
  'electron/preload.cjs',
];
const TEXT_GLOBS = ['network']; // 目录：整目录扫描 .cjs

/** 与具体文案无关、但一定会出现的字符区间（ASCII/标点/箭头/几何/全角）。 */
const ALWAYS = [
  [0x0020, 0x00ff], // 可见拉丁补充（含 ·、×、÷）；从 U+0020 起，控制字符不参与
  [0x2000, 0x206f], // 常用标点（— – … ‘ ’ “ ” ）
  [0x2070, 0x209f], // 上下标
  [0x20a0, 0x20bf], // 货币
  [0x2100, 0x214f], // 字母式符号（™ ℃ №）
  [0x2190, 0x21ff], // 箭头 ← ↑ → ↓ ↔
  [0x2200, 0x22ff], // 数学运算符（≈ ≤ ≥ ∞）
  [0x2460, 0x24ff], // 带圈数字 ① ②
  [0x2500, 0x257f], // 制表符 ─ │ ┌ ┐
  [0x25a0, 0x25ff], // 几何图形 ■ ▶ ▲ ●
  [0x2600, 0x26ff], // 杂项符号 ⚠ ★
  [0x2700, 0x27bf], // 装饰符号 ✓ ✗
  [0x3000, 0x303f], // CJK 标点。「」、【】、…
  [0x31c0, 0x31ef], // CJK 笔画
  [0xfe30, 0xfe4f], // CJK 兼容形式
  [0xff00, 0xffef], // 全角形式（，：；！？（））
];

function collectFiles() {
  const files = [];
  for (const rel of TEXT_SOURCES) {
    const abs = path.join(ROOT, rel);
    if (fs.existsSync(abs)) files.push(abs);
  }
  for (const dir of TEXT_GLOBS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (name.endsWith('.cjs') || name.endsWith('.js')) files.push(path.join(abs, name));
    }
  }
  return files;
}

function buildCharset() {
  // 预留标点：与文案无关但界面会用到（ASCII、标点、箭头、几何、全角）
  const pad = new Set();
  for (const [from, to] of ALWAYS) for (let c = from; c <= to; c += 1) pad.add(c);
  // 界面真实字符：从渲染层与主进程的文本里逐字收集，控制字符不计
  const text = new Set();
  const perFile = [];
  for (const file of collectFiles()) {
    const raw = fs.readFileSync(file, 'utf8');
    let added = 0;
    for (const ch of raw) {
      const code = ch.codePointAt(0);
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
      if (!text.has(code)) { text.add(code); added += 1; }
    }
    perFile.push({ file: path.relative(ROOT, file).replace(/\\/g, '/'), added });
  }
  // 挑子集用并集；覆盖率断言只看界面真实字符
  const chars = new Set([...pad, ...text]);
  return { chars, pad, text, perFile };
}

/** 解析 unicode-range，支持 U+4E00-4E01、U+4E03、U+4?? 三种写法。 */
function parseRange(text) {
  const ranges = [];
  for (const rawPart of String(text).split(',')) {
    const part = rawPart.trim().replace(/^U\+/i, '');
    if (!part) continue;
    if (part.includes('?')) {
      const lo = parseInt(part.replace(/\?/g, '0'), 16);
      const hi = parseInt(part.replace(/\?/g, 'F'), 16);
      ranges.push([lo, hi]);
      continue;
    }
    const [a, b] = part.split('-');
    const lo = parseInt(a, 16);
    const hi = b ? parseInt(b, 16) : lo;
    if (Number.isFinite(lo) && Number.isFinite(hi)) ranges.push([lo, hi]);
  }
  return ranges;
}

function parseFontFaces(css) {
  const faces = [];
  const re = /@font-face\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const body = m[1];
    const pick = (key) => {
      const hit = body.match(new RegExp(`${key}\\s*:\\s*([^;]+);`));
      return hit ? hit[1].trim() : '';
    };
    const urlHit = body.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/);
    faces.push({
      family: pick('font-family').replace(/['"]/g, ''),
      weight: pick('font-weight'),
      style: pick('font-style') || 'normal',
      display: pick('font-display') || 'swap',
      file: urlHit ? urlHit[1].replace(/^\.\//, '') : '',
      rangeText: pick('unicode-range'),
    });
  }
  return faces;
}

function main() {
  if (!fs.existsSync(PKG)) {
    console.error('缺少依赖：请先执行  npm i --no-save misans-webfont@4.3.1');
    process.exit(1);
  }
  const { chars, pad, text, perFile } = buildCharset();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('界面字符集来源：');
  for (const item of perFile) console.log(`  ${item.file}  +${item.added} 个新字符`);
  console.log(`界面真实字符 ${text.size} 个 + 预留标点 ${pad.size} 个 = 挑选用 ${chars.size} 个码位\n`);

  const covered = new Set();
  const blocks = [];
  const report = [];

  for (const w of WEIGHTS) {
    const weightDir = path.join(PKG, 'misans', w.dir);
    const cssPath = path.join(weightDir, 'result.css');
    if (!fs.existsSync(cssPath)) { console.error(`  缺少 ${w.dir}/result.css`); process.exit(1); }
    const faces = parseFontFaces(fs.readFileSync(cssPath, 'utf8'));
    let kept = 0;
    let bytes = 0;
    let index = 0;
    for (const face of faces) {
      const ranges = parseRange(face.rangeText);
      const hit = ranges.some(([lo, hi]) => {
        for (let c = lo; c <= hi; c += 1) if (chars.has(c)) return true;
        return false;
      });
      if (!hit) continue;
      const src = path.join(weightDir, face.file);
      if (!fs.existsSync(src)) continue;
      const outName = `misans-${w.tag}-${String(index).padStart(3, '0')}.woff2`;
      fs.copyFileSync(src, path.join(OUT_DIR, outName));
      bytes += fs.statSync(src).size;
      index += 1;
      kept += 1;
      for (const [lo, hi] of ranges) for (let c = lo; c <= hi; c += 1) covered.add(c);
      blocks.push(
        `@font-face {\n` +
        `  font-family: "SL MiSans";\n` +
        `  font-style: ${face.style};\n` +
        `  font-weight: ${w.weight};\n` +
        `  font-display: ${face.display};\n` +
        `  src: url("./${outName}") format("woff2");\n` +
        `  unicode-range: ${face.rangeText};\n}`,
      );
    }
    report.push({ weight: w.weight, tag: w.tag, kept, total: faces.length, bytes });
  }

  const header =
    '/* 由 tools/prepare-misans.cjs 生成 —— 请勿手工编辑。\n' +
    '   MiSans 子集：只包含 Stronghold Link 界面实际使用的字符区间。\n' +
    '   版权 © 2020-2023 Beijing Xiaomi Mobile Software Co.,Ltd.（详见 SOURCE.txt） */\n\n';
  fs.writeFileSync(path.join(OUT_DIR, 'misans.css'), header + blocks.join('\n') + '\n', 'utf8');

  const missingText = [...text].filter((c) => !covered.has(c));
  const missingPad = [...pad].filter((c) => !covered.has(c));
  const totalBytes = report.reduce((sum, r) => sum + r.bytes, 0);
  console.log('裁剪结果：');
  for (const r of report) {
    console.log(`  字重 ${r.weight} (${r.tag})：保留 ${r.kept}/${r.total} 个子集，${(r.bytes / 1024).toFixed(1)} KB`);
  }
  console.log(`  合计 ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  const fmt = (list) => list.slice(0, 40)
    .map((c) => `U+${c.toString(16).toUpperCase().padStart(4, '0')} ${String.fromCodePoint(c)}`)
    .join('  ');
  if (missingText.length) {
    console.log(`\n✗ 界面真实字符有 ${missingText.length} 个未被覆盖（会回退系统字体）：`);
    console.log(`  ${fmt(missingText)}`);
  } else {
    console.log('  ✓ 界面真实字符 100% 被 MiSans 子集覆盖，不会回退');
  }
  if (missingPad.length) console.log(`  · 预留标点里有 ${missingPad.length} 个未覆盖（界面不使用，仅记录）`);

  fs.writeFileSync(path.join(OUT_DIR, 'SOURCE.txt'), [
    'MiSans webfont 子集 —— 来源与许可',
    '',
    '字体：MiSans（Version 4.003）',
    '版权：Copyright © 2020-2023 Beijing Xiaomi Mobile Software Co.,Ltd. All Rights Reserved.',
    '设计：Beijing Xiaomi Mobile Software Co.,Ltd & Hanyi Fonts',
    '许可：MiSans 由小米免费提供，允许免费商用；本项目保留版权署名，未修改字形。',
    '',
    '分包来源：npm 包 misans-webfont@4.3.1（Apache-2.0）',
    '  仓库 https://github.com/mobeicanyue/misans-webfont',
    '  分包工具 cn-font-split@7.5.4（https://github.com/KonghaYao/cn-font-split）',
    '',
    '本目录内容为按界面字符集裁剪后的子集，不是上游完整分包：',
    ...report.map((r) => `  字重 ${r.weight} (${r.tag})：保留 ${r.kept}/${r.total} 个子集`),
    '',
    '复现步骤：',
    '  npm i --no-save misans-webfont@4.3.1',
    '  node tools/prepare-misans.cjs',
    '  npm uninstall --no-save misans-webfont',
    '',
  ].join('\n'), 'utf8');
  console.log(`\n已写出 ${path.relative(ROOT, path.join(OUT_DIR, 'misans.css'))} 与 ${report.reduce((s, r) => s + r.kept, 0)} 个 woff2`);
}

main();
