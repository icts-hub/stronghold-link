'use strict';
// 生成 ≤100MB 的 LZMA 分发包：
//   release/win-unpacked 里的全部文件 → tar.xz（xz 的 LZMA2，比 deflate 小约 35%）
//   同时写出解压即用的启动器 点我启动.cmd
//
// 用法：node tools/pack-lzma.cjs [--app-dir=...] [--out=...] [--name=...]
// 说明：Windows 自带的 C:\Windows\System32\tar.exe 已支持 -J（xz）。
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const argValue = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const pkg = require(path.join(root, 'package.json'));
const appDir = path.resolve(argValue('app-dir', path.join(root, '..', 'release', 'win-unpacked')));
const outDir = path.resolve(argValue('out', path.join(root, '..', 'release', 'lzma')));
const base = argValue('name', `Stronghold-Link-${pkg.version}-win-x64`);
const tarPath = path.join(outDir, `${base}.tar.xz`);

const step = (msg) => console.log(`[lzma] ${msg}`);
if (!fs.existsSync(appDir)) { console.error(`[lzma] 找不到 ${appDir}`); process.exit(1); }
if (!fs.existsSync(path.join(appDir, 'Stronghold Link.exe'))) {
  console.error('[lzma] 目录里没有 "Stronghold Link.exe"，不是有效的打包产物');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(tarPath, { force: true });

const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
step('压缩中，约 2 分钟...');
const r = spawnSync(tarExe, ['-cJf', tarPath, '-C', appDir, '.'], { stdio: 'inherit' });
if (r.status !== 0) { console.error('[lzma] tar 失败'); process.exit(1); }

const size = fs.statSync(tarPath).size;
const mb = size / 1024 / 1024;
const hash = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-FileHash '${tarPath}' -Algorithm SHA256).Hash`], { encoding: 'utf8' });
const sha = (hash.stdout || '').trim();

// 解压即用启动器
const cmd = [
  '@echo off',
  'chcp 65001 >nul',
  'setlocal',
  `set "DEST=%LOCALAPPDATA%\\StrongholdLink"`,
  'echo.',
  'echo   Stronghold Link 便携版',
  'echo   ------------------------------------',
  'echo   解压到：%DEST%',
  'echo   首次解压约 300 MB，需要一分钟左右，请不要关闭窗口。',
  'echo.',
  'if not exist "%DEST%" mkdir "%DEST%"',
  `tar -xf "%~dp0${base}.tar.xz" -C "%DEST%"`,
  'if errorlevel 1 (',
  '  echo.',
  '  echo   [失败] 解压失败。请确认系统存在 C:\\Windows\\System32\\tar.exe。',
  '  echo   也可以手动解压：右键压缩包选全部解压缩，目标选一个空文件夹。',
  '  echo.',
  '  pause',
  '  exit /b 1',
  ')',
  'if not exist "%DEST%\\Stronghold Link.exe" (',
  '  echo.',
  '  echo   [失败] 解压后没有找到 Stronghold Link.exe。',
  '  echo.',
  '  pause',
  '  exit /b 1',
  ')',
  'echo   解压完成，正在启动...',
  'echo.',
  'rem 优先走包内启动器：它会自动跳过导致闪退的 Chromium 沙箱',
  'if exist "%DEST%\\点我启动-Stronghold-Link.cmd" (',
  '  start "" "%DEST%\\点我启动-Stronghold-Link.cmd"',
  ') else (',
  '  start "" "%DEST%\\Stronghold Link.exe" --no-sandbox',
  ')',
  'exit /b 0',
  ''
].join('\r\n');
const cmdPath = path.join(outDir, '点我启动.cmd');
fs.writeFileSync(cmdPath, cmd, 'utf8');

step(`完成：${tarPath}`);
step(`大小：${mb.toFixed(2)} MB`);
step(`SHA256：${sha}`);
step(`启动器：${cmdPath}`);
if (mb > 100) step(`警告：超过 100MB 目标 ${(mb - 100).toFixed(2)} MB`);
console.log(tarPath);
