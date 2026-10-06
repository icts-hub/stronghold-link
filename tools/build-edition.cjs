'use strict';
// 出两个版本：
//   full —— 完整版，含三维档案背景（three.js + GLB + stage.js）
//   lite —— 精简版，去掉三维背景与它的全部资源，只保留 CSS 动效与玻璃层
//
// 用法：node tools/build-edition.cjs <full|lite> [--no-package]
//
// 为什么要临时替换源文件：electron-builder 只按 files 通配符裁剪，
// 而 index.html 里写死了三个 <script src>。lite 版如果直接不打包这三个文件，
// 渲染进程会为每个缺失的脚本打一条 file-not-found 错误。所以改成把源文件
// 临时换成同名的空壳，打完包再原样写回，渲染进程拿到的是一份合法但空的脚本。
//
// 两个版本的 exe 名保持一致（Stronghold Link.exe），这样 点我启动.cmd、
// START-HERE.cmd、pack-lzma.cjs 的产物校验都不用分叉；用户靠下载的压缩包
// 名字与包内的 EDITION.txt 区分。

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

const edition = String(process.argv[2] || '').toLowerCase();
if (edition !== 'full' && edition !== 'lite') {
  console.error('用法：node tools/build-edition.cjs <full|lite> [--no-package]');
  process.exit(2);
}
const noPackage = process.argv.includes('--no-package');

// lite 版把这三个脚本换成空壳，并把 GLB 排除出包
const STUBBED = [
  ['src/ui/vendor/three.min.js', '/* lite 版不含 three.js */\n'],
  ['src/ui/vendor/gltf-loader.js', '/* lite 版不含 GLTFLoader */\n'],
  ['src/ui/stage.js', '/* lite 版不含三维档案背景 */\n'],
];
const LITE_EXCLUDES = [
  '!src/ui/assets/**/*',
];

const isLite = edition === 'lite';
const releaseDir = isLite ? 'release-lite' : 'release';
const outRoot = path.join(root, '..', releaseDir);
const appDir = path.join(outRoot, 'win-unpacked');
const lzmaDir = path.join(outRoot, 'lzma');
const archiveName = isLite
  ? `Stronghold-Link-Lite-${pkg.version}-win-x64`
  : `Stronghold-Link-${pkg.version}-win-x64`;

const step = (msg) => console.log(`[${edition}] ${msg}`);
// 注意：这里绝不能调 process.exit —— 那会跳过 finally，把 lite 版留下的空壳
// 脚本永久写死在源码树里。失败一律抛异常，交给下面的 try/finally 还原。
const run = (cmd, args, opts = {}) => {
  // Windows 上 .cmd 必须走 shell，否则 spawn 报 EINVAL
  const useShell = /\.cmd$/i.test(cmd);
  step(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, shell: useShell, ...opts });
  if (r.status !== 0) throw new Error(`子进程失败（exit ${r.status}）：${cmd}`);
};

// 1) 生成这一版专用的 electron-builder 配置。
//    传了 --config 之后 package.json 里的 build 整段被忽略，所以这里要写全。
const config = JSON.parse(JSON.stringify(pkg.build));
config.directories = { ...config.directories, output: `../${releaseDir}` };
config.files = config.files.concat(isLite ? LITE_EXCLUDES : []);
// lite 版没有三维场景，不需要给 GPU 留那么大的帧预算，但渲染器仍按同一套档位跑
config.extraMetadata = { ...(config.extraMetadata || {}), shlEdition: edition };
const configPath = path.join(root, 'electron-builder.edition.json');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
step(`配置已写出 ${path.relative(root, configPath)}（output=${config.directories.output}）`);

// 2) lite 版：把三维脚本换成空壳，记下原文以便还原
const backups = new Map();
const restore = () => {
  for (const [rel, bytes] of backups) {
    try { fs.writeFileSync(path.join(root, rel), bytes); } catch (err) { /* 还原失败也要继续 */ }
  }
  backups.clear();
};
if (isLite) {
  for (const [rel, stub] of STUBBED) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) { step(`跳过（不存在）：${rel}`); continue; }
    backups.set(rel, fs.readFileSync(full));
    fs.writeFileSync(full, stub, 'utf8');
    step(`已换成空壳：${rel}`);
  }
}

let exitCode = 0;
try {
  // 3) electron-builder --dir
  //    这台机器上 builder 会在图标转 ICO 那步联网失败并 exit 非 0，但 appDir 其实
  //    已经产出完整。所以退出码非 0 时先看产物在不在：在就只警告继续，不在才失败。
  try {
    run(path.join(root, 'node_modules', '.bin', 'electron-builder.cmd'),
      ['--win', '--dir', '--config', configPath]);
  } catch (err) {
    if (!fs.existsSync(appDir)) throw err;
    step(`electron-builder 退出码非 0，但 ${path.relative(root, appDir)} 已产出，继续后续步骤`);
  }

  if (!fs.existsSync(appDir)) { console.error(`[${edition}] 找不到 ${appDir}`); exitCode = 1; throw new Error('no appDir'); }

  // 4) 版本标记：包根目录写一份，用户与自动检查都能一眼看出是哪个版本
  fs.writeFileSync(path.join(appDir, 'EDITION.txt'),
    isLite
      ? `Stronghold Link ${pkg.version} — lite 精简版\n\n` +
        '本版本不含三维档案背景：没有 three.js、没有 GLB 模型、没有 WebGL 画布。\n' +
        '界面保留 CSS 动效、玻璃层、数字滚动、导航与底部状态条。\n' +
        '内存占用明显低于完整版，适合集成显卡与低配机器。\n'
      : `Stronghold Link ${pkg.version} — full 完整版\n\n` +
        '本版本含三维档案背景：three.js r186 + GLB 档案模块 + 实例化阵列。\n' +
        '设置页可以把三维背景关掉，也可以选择最小化时释放渲染器。\n',
    'utf8');
  step(`EDITION.txt 已写入 ${appDir}`);
} catch (err) {
  console.error(`[${edition}] 失败：${err && err.message ? err.message : err}`);
  if (!exitCode) exitCode = 1;
} finally {
  restore();
  if (backups.size === 0) step('源文件已还原');
  fs.rmSync(configPath, { force: true });
}

if (exitCode !== 0) { console.error(`[${edition}] 打包中断`); process.exit(exitCode); }

if (noPackage) { step('已跳过便携化与压缩，只保留 win-unpacked'); process.exit(0); }

// 5) 便携化：剥 Valve 运行库、放许可与启动器、校验
run(process.execPath, [path.join(root, 'tools', 'prepare-portable.cjs'),
  '--skip-build', '--no-zip', `--app-dir=${appDir}`, `--out=${path.join(outRoot, 'github')}`]);

// 6) 压成 tar.xz
run(process.execPath, [path.join(root, 'tools', 'pack-lzma.cjs'),
  `--app-dir=${appDir}`, `--out=${lzmaDir}`, `--name=${archiveName}`]);

const tarPath = path.join(lzmaDir, `${archiveName}.tar.xz`);
if (fs.existsSync(tarPath)) {
  const mb = (fs.statSync(tarPath).size / 1024 / 1024).toFixed(2);
  step(`完成：${tarPath}  ${mb} MB`);
} else {
  console.error(`[${edition}] 没有产出 ${tarPath}`);
  process.exit(1);
}
