'use strict';
// 生成可分发的干净便携版：
//   1) 调用 electron-builder 产出 release/win-unpacked（若已存在则复用）
//   2) 剥掉所有 Valve SDK 运行库（授权不允许分发），只留放置说明
//   3) 放进 GPL 要求的许可/声明/源码指引，以及启动器与文档
//   4) 打成 release/github/<name>-<version>-portable-win-x64.zip
//
// 用法：node tools/prepare-portable.cjs [--skip-build]
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
// electron-builder 的产物在仓库外（../release/win-unpacked）；
// zip 放到仓库内的 release/github，这样 CI 里 Get-ChildItem 才找得到。
const argValue = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const appDir = path.resolve(argValue('app-dir', path.join(root, '..', 'release', 'win-unpacked')));
const outDir = path.resolve(argValue('out', path.join(root, 'release', 'github')));
const pkg = require(path.join(root, 'package.json'));
const skipBuild = process.argv.includes('--skip-build');

const step = (msg) => console.log(`[portable] ${msg}`);

if (!skipBuild) {
  step('调用 electron-builder 打包（npm run build:dir）...');
  const build = spawnSync('npm', ['run', 'build:dir'], { cwd: root, stdio: 'inherit', shell: true });
  if (build.status !== 0) { console.error('[portable] 打包失败'); process.exit(1); }
}
if (!fs.existsSync(appDir)) { console.error(`[portable] 找不到 ${appDir}`); process.exit(1); }

// 1) 剥掉 Valve SDK 运行库
const sdkDir = path.join(appDir, 'steamworks_sdk');
if (fs.existsSync(sdkDir)) fs.rmSync(sdkDir, { recursive: true, force: true });
const sdkNames = /^steam_api(64)?\.(dll|lib)$|^libsteam_api\.(so|dylib)$|^steamclient/i;
let removed = 0;
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (sdkNames.test(entry.name)) { fs.rmSync(full, { force: true }); removed += 1; }
  }
};
walk(appDir);
step(`已移除 Valve SDK 运行库 ${removed} 个（如果有）`);

// 2) 放回 SDK 放置说明
fs.mkdirSync(sdkDir, { recursive: true });
fs.copyFileSync(path.join(root, 'steamworks_sdk', 'README.md'), path.join(sdkDir, 'README.md'));

// 3) 许可 / 声明 / 文档 / 启动器
const files = [
  ['LICENSE', 'LICENSE.txt'],
  ['NOTICE.md', 'NOTICE.md'],
  ['steamworks_sdk/README.md', 'steamworks_sdk/README.md'],
  ['docs/STEAM-联机步骤.md', 'STEAM-联机步骤.md'],
  ['docs/STEAM-联机步骤.md', 'STEAM-GUIDE.md'],
  ['docs/启动闪退排查.md', '启动闪退排查.md'],
  ['docs/启动闪退排查.md', 'TROUBLESHOOTING.md'],
  ['dist-extras/START-HERE.cmd', 'START-HERE.cmd'],
  ['dist-extras/点我启动-Stronghold-Link.cmd', '点我启动-Stronghold-Link.cmd'],
  ['dist-extras/README-FIRST.txt', 'README-FIRST.txt'],
];
for (const [from, to] of files) {
  const src = path.join(root, from);
  if (!fs.existsSync(src)) { step(`跳过（不存在）：${from}`); continue; }
  fs.copyFileSync(src, path.join(appDir, to));
}
fs.writeFileSync(path.join(appDir, 'SOURCE-源码与许可.txt'),
  `本程序（Stronghold Link）的完整源代码在：\n  ${pkg.homepage || 'https://github.com/icts-hub/stronghold-link'}\n\n` +
  `许可：${pkg.license || 'GPL-3.0-or-later'}（见同目录 LICENSE.txt）\n` +
  '本发行包不含 Valve 的 Steamworks SDK 运行库，Steam 隧道需要你自行放置：\n  steamworks_sdk\\README.md\n', 'utf8');
step('许可 / 声明 / 文档 / 启动器 已就位');

// 4) 校验：确认包里真的没有 Valve 运行库
const left = [];
const verify = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) verify(full);
    else if (sdkNames.test(entry.name)) left.push(full);
  }
};
verify(appDir);
if (left.length) { console.error('[portable] 仍有 Valve SDK 残留：', left); process.exit(1); }
step('校验通过：包内无任何 Valve SDK 运行库');

// 5) 打 zip（用 .NET 压缩，保持长路径与中文文件名）
const zipName = `Stronghold-Link-${pkg.version}-portable-win-x64.zip`;
const zipPath = path.join(outDir, zipName);
fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(zipPath, { force: true });
step('压缩中（约 1 分钟）...');
const ps = spawnSync('powershell', [
  '-NoProfile', '-Command',
  `Compress-Archive -Path '${appDir}\\*' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`,
], { stdio: 'inherit' });
if (ps.status !== 0) { console.error('[portable] 压缩失败'); process.exit(1); }

const size = fs.statSync(zipPath).size;
const hash = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-FileHash '${zipPath}' -Algorithm SHA256).Hash`], { encoding: 'utf8' });
step(`完成：${zipPath}`);
step(`大小：${(size / 1024 / 1024).toFixed(2)} MB`);
step(`SHA256：${(hash.stdout || '').trim()}`);
console.log(zipPath);
