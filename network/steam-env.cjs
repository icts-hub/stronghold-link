'use strict';
// Stronghold Link — Steam 环境诊断（阶段 4）。
//
// 为什么需要这一层：steamworks-ffi-node 是 FFI 绑定，缺少 Steamworks SDK 的
// redistributable（steam_api64.dll）时，调用 init() 不是「返回 false」，
// 而是直接把进程带走（本机实测）。所以：
//   1) 先用纯文件系统检查判断环境是否完整；
//   2) 只有预检通过才允许真正 init；
//   3) 需要在应用里试探时，交给子进程去试（见 probeInChildProcess）。
//
// SDK 目录约定（与 steamworks-ffi-node 官方 verify-sdk-setup.js 一致）：
//   <base>/steamworks_sdk/redistributable_bin/win64/steam_api64.dll

const fs = require('node:fs');
const path = require('node:path');

/** 各平台需要的 redistributable 相对路径。 */
const PLATFORM_LIBRARY = {
  win32: process.arch === 'x64' ? 'win64/steam_api64.dll' : 'steam_api.dll',
  darwin: 'osx/libsteam_api.dylib',
  linux: process.arch === 'arm64' ? 'linuxarm64/libsteam_api.so' : 'linux64/libsteam_api.so',
};

/** 搜索 steamworks_sdk 的候选基目录（应用目录、上两级、node_modules）。 */
function candidateBaseDirs({ appDir, extraDirs = [] } = {}) {
  const dirs = [];
  const push = (value) => {
    if (!value) return;
    const resolved = path.resolve(value);
    if (!dirs.includes(resolved)) dirs.push(resolved);
  };
  for (const dir of extraDirs) push(dir);
  push(appDir || process.cwd());
  push(path.resolve(appDir || process.cwd(), '..'));
  push(path.resolve(appDir || process.cwd(), '../..'));
  push(path.join(appDir || process.cwd(), 'node_modules', 'steamworks-ffi-node'));
  push(path.join(appDir || process.cwd(), 'node_modules'));
  // 打包后（asar 内）appDir 是 resources/app.asar，用户没法往里放 DLL，
  // 所以必须也找 exe 同级目录与 resources/ ——实测这是打包版唯一能放 SDK 的地方。
  try { push(process.resourcesPath); } catch { /* 非 Electron 环境 */ }
  try { push(path.dirname(process.execPath)); } catch { /* 取不到就算了 */ }
  return dirs;
}

/** 在候选目录里找出 steamworks_sdk/redistributable_bin。 */
function findSdkRedistributable(options = {}) {
  const library = PLATFORM_LIBRARY[process.platform] || null;
  const searched = [];
  for (const base of candidateBaseDirs(options)) {
    // 1) 标准目录名，以及常见拼写变体（实测有用户把 steamworks_sdk 打成 steamwork_sdk）
    const names = ['steamworks_sdk', 'steamwork_sdk', 'steamworks-sdk', 'SteamworksSDK'];
    // 2) 再兜底：扫描这一层里形如 steamwork*sdk 的目录（大小写/多余字符都容忍）
    try {
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && /^steamworks?[-_ ]?sdk$/i.test(entry.name) && !names.includes(entry.name)) names.push(entry.name);
      }
    } catch { /* 目录不可读就算了 */ }

    for (const name of names) {
      const redistributable = path.join(base, name, 'redistributable_bin');
      const libraryPath = library ? path.join(redistributable, library) : null;
      searched.push(libraryPath || redistributable);
      if (fs.existsSync(redistributable)) {
        return {
          found: true,
          baseDir: base,
          dirName: name,
          // 目录名不是标准写法时如实告诉用户，但不阻止使用
          note: name === 'steamworks_sdk' ? null : `SDK 目录名是「${name}」（标准写法是 steamworks_sdk），已兼容读取。`,
          redistributable,
          library,
          libraryPath,
          libraryExists: Boolean(libraryPath && fs.existsSync(libraryPath)),
          searched,
        };
      }
    }

    // 3) 最后的兜底：用户直接把 steam_api64.dll 丢在这一层（或 redistributable_bin 这一层）
    const flatCandidates = library
      ? [path.join(base, library), path.join(base, 'redistributable_bin', library), path.join(base, 'redistributable_bin', path.basename(library))]
      : [];
    for (const candidate of flatCandidates) {
      searched.push(candidate);
      if (fs.existsSync(candidate)) {
        return {
          found: true,
          baseDir: base,
          dirName: null,
          note: `直接把 ${path.basename(candidate)} 放在这里也能用；推荐放到 steamworks_sdk/redistributable_bin/${library} 下。`,
          redistributable: path.dirname(candidate),
          library,
          libraryPath: candidate,
          libraryExists: true,
          searched,
        };
      }
    }
  }
  return { found: false, redistributable: null, library, libraryPath: null, libraryExists: false, searched };
}

/** 模块能否 require（FFI 绑定是否装上了）。 */
function checkModule(appDir) {
  try {
    const resolved = require.resolve('steamworks-ffi-node', { paths: [appDir || process.cwd(), __dirname, ...module.paths] });
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(resolved);
    const SDK = mod.default || mod.SteamworksSDK;
    return { available: true, resolved, hasSdkClass: typeof SDK?.getInstance === 'function' };
  } catch (err) {
    return { available: false, error: err.code === 'MODULE_NOT_FOUND' ? '未安装 steamworks-ffi-node' : String(err.message || err) };
  }
}

/** koffi 是 FFI 运行时；某些 npm 配置会跳过它的原生构建。 */
function checkFfiRuntime(appDir) {
  try {
    require.resolve('koffi', { paths: [appDir || process.cwd(), __dirname, ...module.paths] });
    return { available: true };
  } catch (err) {
    return { available: false, error: '未找到 koffi（steamworks-ffi-node 的 FFI 运行时）' };
  }
}

/** steam_appid.txt（可选；也可以在启动会话时直接指定 AppID）。 */
function checkAppIdFile(appDir) {
  const file = path.join(appDir || process.cwd(), 'steam_appid.txt');
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return { found: true, file, appId: /^\d+$/.test(text) ? Number(text) : null, raw: text.slice(0, 32) };
  } catch {
    return { found: false, file, appId: null };
  }
}

/** 从注册表读 Steam 安装路径（Windows）——很多人的 Steam 装在 D:/E: 等非默认位置。 */
function steamPathFromRegistry() {
  if (process.platform !== 'win32') return null;
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamExe'], {
      encoding: 'utf8', windowsHide: true, timeout: 4000,
    });
    const matched = out.match(/SteamExe\s+REG_SZ\s+(.+)/i);
    if (matched) return matched[1].trim();
  } catch { /* 没有注册表项或不允许执行 */ }
  return null;
}

/** Steam 客户端是否安装：查常见目录 + 注册表（不保证正在运行）。 */
function checkSteamClient() {
  const candidates = [
    steamPathFromRegistry(),
    process.env.STEAM_PATH,
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Steam', 'steam.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Steam', 'steam.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Steam', 'steamapps'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Steam', 'steam.exe'),
    'C:\\Program Files (x86)\\Steam\\steam.exe',
  ].filter(Boolean);
  const found = candidates.filter((candidate) => {
    try { return fs.existsSync(candidate); } catch { return false; }
  });
  return {
    installedHint: found.length > 0,
    evidence: found.slice(0, 3),
    running: 'unknown', // 不猜：是否登录由 init 的结果给结论
    note: '只能在允许查询进程时判断是否正在运行；本工具不猜，实际以初始化结果为准。',
  };
}

/**
 * 完整诊断报告。纯文件系统 + require 检查，**不会**调用 Steam init（因此不会崩进程）。
 */
function diagnoseSteam({ appDir, extraDirs = [], appId = null } = {}) {
  const moduleCheck = checkModule(appDir);
  const ffi = checkFfiRuntime(appDir);
  const sdk = findSdkRedistributable({ appDir, extraDirs });
  const appIdFile = checkAppIdFile(appDir);
  const client = checkSteamClient();

  const blockers = [];
  const steps = [];

  if (!moduleCheck.available) blockers.push(moduleCheck.error);
  if (!ffi.available) blockers.push(ffi.error);
  if (!sdk.found) {
    blockers.push('缺少 Steamworks SDK 的 redistributable 目录（steamworks_sdk/redistributable_bin）');
  } else if (!sdk.libraryExists) {
    blockers.push(`缺少本平台库文件：${sdk.library}（当前平台 ${process.platform}/${process.arch}）`);
  }

  steps.push({ ok: moduleCheck.available, title: 'npm 依赖 steamworks-ffi-node', detail: moduleCheck.available ? moduleCheck.resolved : moduleCheck.error });
  steps.push({ ok: ffi.available, title: 'FFI 运行时 koffi', detail: ffi.available ? '已就绪' : ffi.error });
  steps.push({
    ok: Boolean(sdk.found && sdk.libraryExists),
    title: 'Steamworks SDK redistributable',
    detail: sdk.found
      ? (sdk.libraryExists
        ? `${sdk.libraryPath}${sdk.note ? `（${sdk.note}）` : ''}`
        : `找到目录但缺少 ${sdk.library}${sdk.note ? `（${sdk.note}）` : ''}`)
      : '未找到；请把官方 SDK 的 redistributable_bin 放到 steamworks_sdk/ 下',
  });
  steps.push({
    ok: true,
    title: 'AppID',
    detail: appId ? `使用 ${appId}${appId === 480 ? '（Spacewar 测试用）' : ''}`
      : (appIdFile.appId ? `steam_appid.txt = ${appIdFile.appId}` : '未指定；可在会话里填写，或创建 steam_appid.txt（测试可用 480）'),
  });
  steps.push({
    ok: client.installedHint,
    title: 'Steam 客户端',
    detail: client.installedHint ? `检测到安装目录：${client.evidence[0]}` : '未在常见目录发现 Steam；请先安装并登录 Steam',
  });

  return {
    available: blockers.length === 0,
    blockers,
    steps,
    module: moduleCheck,
    ffi,
    sdk: { found: sdk.found, redistributable: sdk.redistributable, library: sdk.library, libraryPath: sdk.libraryPath, libraryExists: sdk.libraryExists, dirName: sdk.dirName || null, note: sdk.note || null },
    appId: appId || appIdFile.appId || null,
    appIdFile,
    steamClient: client,
    platform: `${process.platform}/${process.arch}`,
  };
}

module.exports = {
  PLATFORM_LIBRARY,
  candidateBaseDirs,
  findSdkRedistributable,
  checkModule,
  checkFfiRuntime,
  checkAppIdFile,
  checkSteamClient,
  diagnoseSteam,
};
