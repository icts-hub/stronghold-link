'use strict';
// Stronghold Link — QML 版便携包打包器（阶段 5）。
//
// 为什么需要它：QML 版不是 Electron 应用，`tools/prepare-portable.cjs` 那条链路
// （electron-builder → win-unpacked → 剥 Valve SDK → 压 zip）完全用不上：QML 版要自己
// 凑齐四类东西才跑得起来 —— Qt 运行库（windeployqt）、Node 运行时（后端是独立 Node 进程）、
// 后端代码与它的 npm 依赖、法务文件（LICENSES/ + 声明 + 台账）。
//
// 三条硬性纪律（来自 QML_MIGRATION_PLAN.md 阶段 5）：
//   1. **法务文件在包内部**：LICENSES/、THIRD_PARTY_NOTICES.txt、ASSET_PROVENANCE.md、
//      asset-provenance.json 必须躺在分发目录里，不是旁边某个仓库目录。
//   2. **包里不许有 Valve 的东西**：steam_api64.dll / *.lib / *.exp / 调试探针 一律不许出现。
//      Steam 隧道要用的 redistributable 由用户自己放进 steamworks_sdk/（见包内 README-FIRST.txt）。
//   3. **素材清单按实际复制结果生成**：PORTABLE-CONTENTS.txt 里每个文件都带 sha256，
//      不许手抄（手抄的清单和真实包一定会飘）。
//
// LGPL 义务（LGPL-3.0-only 的 Qt）：动态链接 + 附全文 + **允许用户替换 Qt 库**。
// 所以本工具只做「复制 DLL 到 exe 旁边」，不加壳、不校验、不签名，用户拿别的 Qt6*.dll
// 覆盖上去必须能跑 —— 这也是不许在启动器里做完整性校验的原因。
//
// 用法：
//   node tools/pack-qml.cjs                 # 重新编译 → 部署 Qt → 组装 → 自检 → 压 zip
//   node tools/pack-qml.cjs --skip-build    # 用现有 exe（改打包器本身时用，省一分钟）
//   node tools/pack-qml.cjs --out D:\tmp\x  # 换输出目录（默认 <仓库>/../release）
//   node tools/pack-qml.cjs --no-zip        # 只组装目录，不压
//
// 输出目录默认在**仓库之外**（<仓库>/../release），原因有两个：一是与 electron-builder 的
// `build.directories.output = ../release` 惯例一致；二是 `tools/verify-asset-provenance.cjs`
// 会扫 source/release 与 source/app_qml/build/release/release，而 windeployqt 复制进来的
// Qt QML 模块带 .qml/.js（在守卫的 ASSET_EXT 里）会被判成「未登记素材」。

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const QT_DIR = valueOf('--qt', process.env.SHL_QT || 'D:\\Qt\\6.8.3\\mingw_64');
const MINGW_DIR = valueOf('--mingw', process.env.SHL_MINGW || 'D:\\Qt\\Tools\\mingw1310_64');
const OUT_DIR = path.resolve(valueOf('--out', path.join(ROOT, '..', 'release')));
const SKIP_BUILD = has('--skip-build');
const NO_ZIP = has('--no-zip');

const NAME = `Stronghold-Link-${VERSION}-qml-win-x64`;
const STAGE = path.join(OUT_DIR, NAME);
const ZIP = path.join(OUT_DIR, `${NAME}.zip`);
const BUILD_DIR = path.join(ROOT, 'app_qml', 'build', 'release');
const BUILT_EXE = path.join(BUILD_DIR, 'release', 'StrongholdLink.exe');

const QT_BIN = path.join(QT_DIR, 'bin');
const MINGW_BIN = path.join(MINGW_DIR, 'bin');
const NODE_EXE = process.execPath;
const NODE_DIR = path.dirname(NODE_EXE);

let step = 0;
const log = (msg) => console.log(`[pack] ${msg}`);
const phase = (title) => { step += 1; console.log(`\n[pack] ── ${step}. ${title}`); };
const fail = (msg) => { console.error(`\n[pack] ✖ ${msg}`); process.exit(1); };

// --------------------------------------------------------------------- 工具

/** 在 PATH 上找一个可执行文件（CI 里 Qt 是 install-qt-action 装的，目录名不一定和我们本机一样）。 */
function which(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 先看 --qt/--mingw 指的目录，找不到再退回 PATH —— 两条路都堵死才报错。 */
function tool(name, dir, envName) {
  const local = path.join(dir, 'bin', name);
  if (fs.existsSync(local)) return local;
  const found = which(name);
  if (found) return found;
  fail(`找不到 ${name}：既不在 ${local}，也不在 PATH 上`
    + `（用 ${envName} 或 --qt/--mingw 指定 Qt 与 MinGW 的安装目录）`);
}

function run(cmd, args, opts = {}) {
  const label = `${path.basename(cmd)} ${args.join(' ')}`;
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PATH: `${QT_BIN};${MINGW_BIN};${NODE_DIR};${process.env.PATH}` },
    windowsHide: true,
    ...opts.spawn,
  });
  if (opts.quiet !== true) {
    const tail = String(res.stdout || '').trim().split('\n').slice(-6).join('\n');
    const errtail = String(res.stderr || '').trim().split('\n').slice(-6).join('\n');
    if (tail) console.log(tail.replace(/^/gm, '        '));
    if (errtail) console.log(errtail.replace(/^/gm, '        '));
  }
  if (res.error) fail(`${label} 无法执行：${res.error.message}`);
  if (res.status !== 0) fail(`${label} 退出码 ${res.status}`);
  return res;
}

function sha256(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex').toUpperCase();
}

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, base, out);
    else if (entry.isFile()) out.push(path.relative(base, abs));
  }
  return out;
}

const rel = (p) => p.split(path.sep).join('/');

/** 复制一棵目录，按规则跳过（用于剪掉 npm 包里的开发期垃圾）。 */
function copyTree(src, dst, skip = () => false, stats = { files: 0, bytes: 0 }) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (skip(entry, from)) continue;
    if (entry.isDirectory()) copyTree(from, to, skip, stats);
    else if (entry.isFile()) {
      fs.copyFileSync(from, to);
      stats.files += 1;
      stats.bytes += fs.statSync(to).size;
    }
  }
  return stats;
}

function copyFile(relFrom, relTo = relFrom) {
  const from = path.join(ROOT, relFrom);
  const to = path.join(STAGE, relTo);
  if (!fs.existsSync(from)) fail(`缺少要复制的文件：${relFrom}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

// ------------------------------------------------------- 1. 编译 QML 前端

function build() {
  phase('编译 QML 前端（qmake + mingw32-make）');
  const qmake = tool('qmake.exe', QT_DIR, 'SHL_QT');
  const make = tool('mingw32-make.exe', MINGW_DIR, 'SHL_MINGW');
  if (!fs.existsSync(BUILD_DIR)) fs.mkdirSync(BUILD_DIR, { recursive: true });

  run(qmake, [path.join(ROOT, 'app_qml', 'app_qml.pro')], { cwd: BUILD_DIR, quiet: true });
  run(make, ['-f', 'Makefile.Release', `-j${Math.max(2, require('node:os').cpus().length - 1)}`], { cwd: BUILD_DIR, quiet: true });
  if (!fs.existsSync(BUILT_EXE)) fail(`编译结束但没有产物：${BUILT_EXE}`);
  log(`产物 ${rel(path.relative(ROOT, BUILT_EXE))}  ${fs.statSync(BUILT_EXE).size.toLocaleString()} 字节`);
}

// ------------------------------------------------- 2. 组装目录 + Qt 部署

function stageApp() {
  phase(`组装 ${NAME}`);
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });

  copyFile(rel(path.relative(ROOT, BUILT_EXE)), 'StrongholdLink.exe');
  log(`StrongholdLink.exe  ${fs.statSync(path.join(STAGE, 'StrongholdLink.exe')).size.toLocaleString()} 字节`);

  // 后端代码：整个 backend/ 与 network/ 一起进包（backend 只 require 这两棵树 + node 内置模块，
  // 真正的证明在最后的冒烟测试里 —— 用包里的 node 把后端跑起来问一次 app.info）。
  const appStats = { files: 0, bytes: 0 };
  copyTree(path.join(ROOT, 'backend'), path.join(STAGE, 'backend'), () => false, appStats);
  copyTree(path.join(ROOT, 'network'), path.join(STAGE, 'network'), () => false, appStats);
  copyFile('package.json');
  log(`后端代码 backend/ + network/  ${appStats.files} 个文件  ${(appStats.bytes / 1024).toFixed(0)} KiB`);

  // Node 运行时：exe 同级 node/node.exe 是 backendbridge.cpp 的第三顺位查找路径
  // （SHL_NODE → appDir/node/node.exe → appDir/node.exe → appDir/../node/node.exe → PATH）。
  fs.mkdirSync(path.join(STAGE, 'node'), { recursive: true });
  fs.copyFileSync(NODE_EXE, path.join(STAGE, 'node', 'node.exe'));
  log(`node/node.exe  ${(fs.statSync(path.join(STAGE, 'node', 'node.exe')).size / 1048576).toFixed(1)} MB（${process.version}）`);

  // npm 依赖：steamworks-ffi-node（MIT，FFI 绑定）+ koffi（MIT，FFI 运行时）+ koffi 的
  // Windows x64 原生二进制。按**白名单**复制，而不是整包复制：
  //   · steamworks-ffi-node 整包 6.1 MB，其中 node_modules/（node-gyp + undici）3.9 MB 是
  //     安装期工具，运行时一个都不 require（dist/**/*.js 只 require 自己的 dist/ 与裸的 koffi）；
  //   · koffi 的真实代码在 src/koffi/（根上的 index.cjs 只有 50 字节的转发），
  //     而 lib/native、vendor、doc 是 C++ 源码与文档，运行时用不到；
  //   · @koromix/koffi-win32-x64 里的 koffi.lib 是链接期导入库，包里不该有 *.lib（自检会拦）。
  // 白名单写错的风险由后面的 selfcheck③ 兜住：用包里的 node 真去 require 这三个入口。
  const depPlan = [
    {
      name: 'steamworks-ffi-node',
      keep: (p) => p === 'package.json' || p === 'LICENSE' || p === 'README.md'
        || (p.startsWith('dist/') && !p.endsWith('.map'))
        || p.startsWith('prebuilds/win32-x64/'),
      why: 'dist/ + win32-x64 prebuild + 许可',
    },
    {
      name: 'koffi',
      keep: (p) => /^(package\.json|index\.(cjs|js|d\.ts)|indirect\.(cjs|js)|LICENSE\.txt|README\.md)$/.test(p)
        || (p.startsWith('src/koffi/') && !/\.(cc|hh|h|cpp|map)$/.test(p)),
      why: 'src/koffi 的 JS + 根转发层',
    },
    {
      name: '@koromix/koffi-win32-x64',
      keep: (p) => /^(package\.json|index\.js)$/.test(p) || /^win32_x64\/koffi\.node$/.test(p),
      why: 'win32_x64/koffi.node',
    },
  ];
  const depsStats = { files: 0, bytes: 0 };
  for (const plan of depPlan) {
    const src = path.join(ROOT, 'node_modules', ...plan.name.split('/'));
    if (!fs.existsSync(src)) fail(`缺少 npm 依赖：node_modules/${plan.name}`);
    const dst = path.join(STAGE, 'node_modules', ...plan.name.split('/'));
    const before = depsStats.files;
    copyTree(src, dst, (entry, from) => {
      if (!entry.isFile()) return false;
      return !plan.keep(rel(path.relative(src, from)));
    }, depsStats);
    log(`node_modules/${plan.name}  ${depsStats.files - before} 个文件（${plan.why}）`);
  }
  log(`npm 依赖合计  ${depsStats.files} 个文件  ${(depsStats.bytes / 1048576).toFixed(1)} MB`);
}

function deployQt() {
  phase('部署 Qt 运行库（windeployqt）');
  const windeployqt = tool('windeployqt.exe', QT_DIR, 'SHL_QT');
  // --compiler-runtime：把 mingw 的 libgcc/libstdc++/libwinpthread 一起带上，用户机器上没有 Qt 也能跑。
  // --no-translations：aqt 装的这套 Qt 没带 translations/catalogs.json（windeployqt 会打印警告），
  //                    反正本应用界面文案全是自己的中文，Qt 自带翻译用不上。
  // 不加 --no-opengl-sw：保留 opengl32sw.dll，显卡驱动异常/远程桌面上还能退到软件渲染。
  run(windeployqt, [
    '--release',
    '--compiler-runtime',
    '--no-translations',
    '--qmldir', path.join(ROOT, 'app_qml', 'qml'),
    '--dir', STAGE,
    path.join(STAGE, 'StrongholdLink.exe'),
  ], { quiet: true });
  // Qt 6 的 windeployqt 把插件摊在 exe 旁边的一级子目录里（platforms/、imageformats/…），
  // 不是 Qt 5 那种统一的 plugins/。这里按实际目录统计，不要写死名字。
  const OUR_DIRS = new Set(['backend', 'network', 'node', 'node_modules', 'qml']);
  const dlls = fs.readdirSync(STAGE).filter((n) => /^Qt6.*\.dll$/i.test(n));
  const pluginDirs = fs.readdirSync(STAGE, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !OUR_DIRS.has(e.name))
    .map((e) => `${e.name}(${walk(path.join(STAGE, e.name)).length})`);
  const qmlModules = fs.existsSync(path.join(STAGE, 'qml'))
    ? fs.readdirSync(path.join(STAGE, 'qml')).filter((n) => fs.statSync(path.join(STAGE, 'qml', n)).isDirectory())
    : [];
  log(`Qt6*.dll ${dlls.length} 个：${dlls.map((d) => d.replace(/^Qt6|\.dll$/g, '')).join(' ')}`);
  log(`插件目录 ${pluginDirs.join(' ')}`);
  log(`QML 模块 ${qmlModules.length} 个：${qmlModules.join(' ')}`);
}

// ------------------------------------------------------------- 3. 法务文件

function stageLegal() {
  phase('放法务文件（LGPL 义务 + 素材台账）');
  const required = [
    'LICENSES/GPL-3.0-only.txt',
    'LICENSES/LGPL-3.0-only.txt',
    'LICENSES/koffi-MIT.txt',
    'LICENSES/steamworks-ffi-node-MIT.txt',
    'THIRD_PARTY_NOTICES.txt',
    'ASSET_PROVENANCE.md',
    'asset-provenance.json',
  ];
  for (const file of required) copyFile(file);
  const lgpl = fs.readFileSync(path.join(STAGE, 'LICENSES', 'LGPL-3.0-only.txt'), 'utf8');
  if (!/GNU LESSER GENERAL PUBLIC LICENSE/.test(lgpl) || !/Version 3/.test(lgpl)) {
    fail('LICENSES/LGPL-3.0-only.txt 看起来不是 LGPL-3.0 全文');
  }
  log(`LICENSES/ ${fs.readdirSync(path.join(STAGE, 'LICENSES')).length} 份 + THIRD_PARTY_NOTICES.txt + 台账两份`);

  // 分发包说明（QML 版专用；dist-extras/ 那套是 Electron 版的，不能混用）
  const extras = path.join(ROOT, 'dist-extras-qml');
  if (!fs.existsSync(extras)) fail('缺少 dist-extras-qml/（QML 版的分发说明与启动器）');
  copyTree(extras, STAGE, () => false);
  // 同一份启动器再放一个英文名（非中文系统 / 命令行里好敲），与 Electron 版 dist-extras 的做法一致
  const launcher = '点我启动-StrongholdLink-QML版.cmd';
  fs.copyFileSync(path.join(STAGE, launcher), path.join(STAGE, 'START-HERE.cmd'));
  log(`dist-extras-qml/ ${fs.readdirSync(extras).length} 个文件（+ START-HERE.cmd 副本）`);
}

// ------------------------------------------------- 4. 清单 + 自检 + 压包

function generateManifest() {
  phase('生成 PORTABLE-CONTENTS.txt（按实际复制结果）');
  const files = walk(STAGE).map(rel).sort((a, b) => a.localeCompare(b, 'en'));
  const lines = [];
  lines.push('Stronghold Link — QML 版便携包内容清单 (portable contents manifest)');
  lines.push(`版本 / version : ${VERSION}`);
  lines.push(`构建时间 / built: ${new Date().toISOString()}`);
  lines.push(`Qt             : ${QT_DIR}`);
  lines.push(`Node           : ${process.version} (${NODE_EXE})`);
  lines.push('');
  lines.push('本清单由 tools/pack-qml.cjs 在组装结束时**按实际复制结果**生成（不许手抄）。');
  lines.push('This manifest is generated from the actual staged files by tools/pack-qml.cjs.');
  lines.push('');
  lines.push('Qt 以 LGPL-3.0-only 授权，动态链接分发；你可以用自己编译的 Qt6*.dll 覆盖包里的同名文件');
  lines.push('（本程序不加壳、不校验自校验、不做完整性检查）。全文见 LICENSES/LGPL-3.0-only.txt。');
  lines.push('Qt is distributed under LGPL-3.0-only via dynamic linking. You may replace the bundled');
  lines.push('Qt6*.dll files with your own builds; nothing in this package verifies or wraps them.');
  lines.push('');
  lines.push('包里**不含** Valve 的 Steamworks redistributable（steam_api64.dll 等）。');
  lines.push('This package does NOT contain Valve\'s Steamworks redistributable.');
  lines.push('');
  lines.push(`文件数 / files: ${files.length}`);
  lines.push('');
  lines.push('sha256                                                            bytes  path');
  let total = 0;
  for (const f of files) {
    if (f === 'PORTABLE-CONTENTS.txt') continue;
    const abs = path.join(STAGE, f);
    const size = fs.statSync(abs).size;
    total += size;
    lines.push(`${sha256(abs)}  ${String(size).padStart(10)}  ${f}`);
  }
  lines.push('');
  lines.push(`合计 / total: ${total} 字节 (${(total / 1048576).toFixed(1)} MiB)`);
  fs.writeFileSync(path.join(STAGE, 'PORTABLE-CONTENTS.txt'), `${lines.join('\n')}\n`, 'utf8');
  log(`清单 ${files.length} 个文件，合计 ${(total / 1048576).toFixed(1)} MiB`);
  return { files, total };
}

/** 包里绝对不许出现的东西。纯函数，好让测试直接喂文件名列表验证规则本身。 */
const FORBIDDEN = [
  [/steam_api64\.dll$/i, 'Valve 的 Steamworks redistributable'],
  [/steam_api\.dll$/i, 'Valve 的 Steamworks redistributable'],
  [/\.(lib|exp|pdb|ilk)$/i, '静态库/符号/调试数据库'],
  [/(^|\/)steamworks_sdk\//i, 'Steamworks SDK 目录'],
  [/probe/i, '调试探针'],
  [/\.(log|map|tmp)$/i, '日志/符号表/临时文件'],
  [/(^|\/)(test|tests|qml-qa|diag)\//i, '测试与诊断目录'],
  [/\.test\.cjs$/i, '测试文件'],
];

function forbiddenHits(files) {
  const hits = [];
  for (const f of files) for (const [re, why] of FORBIDDEN) if (re.test(f)) hits.push(`${f}  ← ${why}`);
  return hits;
}

/** 少一个就跑不起来的文件（写死成清单，打包时逐项核对）。 */
const REQUIRED_FILES = [
  'StrongholdLink.exe',
  'Qt6Core.dll', 'Qt6Gui.dll', 'Qt6Qml.dll', 'Qt6Quick.dll', 'Qt6Network.dll', 'Qt6QuickLayouts.dll',
  'platforms/qwindows.dll',
  'libgcc_s_seh-1.dll', 'libstdc++-6.dll', 'libwinpthread-1.dll',
  'node/node.exe',
  'backend/stronghold-backend.cjs', 'backend/business.cjs',
  'network/steam-adapter.cjs', 'network/session.cjs',
  'package.json',
  'node_modules/steamworks-ffi-node/package.json',
  'node_modules/steamworks-ffi-node/dist/index.js',
  'node_modules/steamworks-ffi-node/dist/types/networking.js',
  'node_modules/steamworks-ffi-node/prebuilds/win32-x64/steam-overlay.node',
  'node_modules/koffi/package.json',
  'node_modules/koffi/src/koffi/index.cjs',
  'node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node',
  'LICENSES/LGPL-3.0-only.txt', 'LICENSES/GPL-3.0-only.txt',
  'THIRD_PARTY_NOTICES.txt', 'ASSET_PROVENANCE.md', 'asset-provenance.json',
  'README-FIRST.txt', '点我启动-StrongholdLink-QML版.cmd', 'START-HERE.cmd',
  'PORTABLE-CONTENTS.txt',
];

function missingRequired(files) {
  const set = new Set(files);
  return REQUIRED_FILES.filter((n) => !set.has(n));
}

function forbiddenCheck() {
  phase('自检①：包里有没有不该有的东西');
  const all = walk(STAGE).map(rel);
  const hits = forbiddenHits(all);
  if (hits.length) fail(`包里有 ${hits.length} 个不该出现的东西：\n  ${hits.join('\n  ')}`);
  log(`干净：${all.length} 个文件里没有 Valve SDK / 静态库 / 探针 / 测试`);

  const missing = missingRequired(all);
  if (missing.length) fail(`包里缺 ${missing.length} 个必需文件：\n  ${missing.join('\n  ')}`);
  log(`必需文件齐全（${REQUIRED_FILES.length} 项）`);
}

/** 用包里的 node 把后端真的跑起来问一句 —— 这是「闭包完整」的唯一硬证明。 */
function smokeBackend() {
  phase('自检②：用包里的 node 启动打包后的后端');
  return new Promise((resolve, reject) => {
    const cfg = path.join(OUT_DIR, '.smoke-config');
    fs.rmSync(cfg, { recursive: true, force: true });
    const child = spawn(path.join(STAGE, 'node', 'node.exe'), [path.join(STAGE, 'backend', 'stronghold-backend.cjs')], {
      cwd: STAGE,
      env: { ...process.env, SHL_CONFIG_DIR: cfg, PATH: `${NODE_DIR};${process.env.PATH}`, SHL_BACKEND_LOCK: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => finish(new Error(`10 秒内没拿到 app.info 响应\nstdout: ${stdout}\nstderr: ${stderr}`)), 10000);
    function finish(err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* 忽略 */ }
      fs.rmSync(cfg, { recursive: true, force: true });
      if (err) reject(err); else resolve();
    }
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'response' && msg.id === 1) {
          if (!msg.ok || msg.result.version !== VERSION) {
            return finish(new Error(`app.info 回包不对：${line}`));
          }
          log(`后端应答 app.info → version=${msg.result.version} pid=${msg.result.pid} uptimeMs=${msg.result.uptimeMs}`);
          try { child.stdin.write(`${JSON.stringify({ type: 'request', id: 2, method: 'app.shutdown' })}\n`); } catch { /* 忽略 */ }
          setTimeout(() => finish(null), 300);
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => finish(err));
    child.on('exit', (code) => {
      if (!done && code !== 0) finish(new Error(`后端启动即退出 code=${code}\nstderr: ${stderr}`));
    });
    child.stdin.write(`${JSON.stringify({ type: 'request', id: 1, method: 'app.info' })}\n`);
  });
}

/** 剪过的 npm 依赖还能不能 require —— 剪错了就当场红，而不是等用户双击。 */
function smokeDeps() {
  phase('自检③：剪过的 npm 依赖能不能加载');
  const script = 'const k=require("koffi");const s=require("steamworks-ffi-node");'
    + 'const t=require("steamworks-ffi-node/dist/types/networking.js");'
    + 'console.log(JSON.stringify({koffi:typeof k.load==="function",steam:typeof s==="object"||typeof s==="function",types:typeof t==="object"}));';
  const res = run(path.join(STAGE, 'node', 'node.exe'), ['-e', script], { cwd: STAGE, quiet: true });
  const out = String(res.stdout).trim().split('\n').pop();
  let parsed;
  try { parsed = JSON.parse(out); } catch { fail(`依赖自检输出无法解析：${out}`); }
  if (!parsed.koffi || !parsed.steam || !parsed.types) fail(`依赖自检失败：${out}`);
  log(`koffi / steamworks-ffi-node / dist/types 全部加载成功`);
}

function zip() {
  phase('压 zip');
  fs.rmSync(ZIP, { force: true });
  // 用 Windows 自带的 bsdtar：比 Compress-Archive 快得多，而且入口名用正斜杠、中文名不乱码。
  const res = spawnSync('tar.exe', ['-a', '-c', '-f', ZIP, '-C', OUT_DIR, NAME], { encoding: 'utf8', windowsHide: true });
  if (res.status !== 0) fail(`tar 压包失败：${res.stderr || res.stdout}`);
  const list = spawnSync('tar.exe', ['-tf', ZIP], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const entries = String(list.stdout || '').trim().split('\n').length;
  const size = fs.statSync(ZIP).size;
  log(`${path.basename(ZIP)}  ${(size / 1048576).toFixed(2)} MB  ${entries} 个条目`);
  log(`SHA256 ${sha256(ZIP)}`);
}

// ------------------------------------------------------------------- main

const main = async () => {
  console.log(`[pack] Stronghold Link QML 便携包 v${VERSION}`);
  console.log(`[pack] 仓库 ${ROOT}`);
  console.log(`[pack] Qt ${QT_DIR}`);
  console.log(`[pack] 输出 ${OUT_DIR}`);

  if (!SKIP_BUILD) build();
  else {
    phase('跳过编译（--skip-build）');
    if (!fs.existsSync(BUILT_EXE)) fail(`没有现成产物：${BUILT_EXE}`);
    log(`用现有 ${rel(path.relative(ROOT, BUILT_EXE))}  ${fs.statSync(BUILT_EXE).size.toLocaleString()} 字节`);
  }

  stageApp();
  deployQt();
  stageLegal();
  const manifest = generateManifest();
  forbiddenCheck();
  await smokeBackend();
  smokeDeps();
  if (!NO_ZIP) zip();

  console.log(`\n[pack] ✔ 完成：${STAGE}`);
  console.log(`[pack]   ${manifest.files.length} 个文件 / ${(manifest.total / 1048576).toFixed(1)} MiB`);
  if (!NO_ZIP) console.log(`[pack]   ${ZIP}`);
};

// 被 require（测试）时只暴露规则，不开始打包。
module.exports = { forbiddenHits, missingRequired, REQUIRED_FILES, FORBIDDEN, VERSION, artifactName: NAME };

if (require.main === module) {
  main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
}
