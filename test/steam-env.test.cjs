'use strict';
// Steam 环境诊断测试（阶段 4）
// 运行：node --test --test-isolation=none test/steam-env.test.cjs
//
// 说明：这里检查的是「文件/模块是否存在」，不是「DLL 能否加载」——后者必须有真实 SDK 才能验证，
// 本机没有 Steamworks SDK redistributable（Valve 授权限制，不能随包分发），所以真实 init 无法在本机完成。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const env = require('../network/steam-env.cjs');

const APP_DIR = path.join(__dirname, '..');
const PLATFORM_LIB = env.PLATFORM_LIBRARY[process.platform];

/** 造一个假的 SDK 目录（只验证存在性检查逻辑，不代表 DLL 可用）。 */
function makeFakeSdkDir(baseDir, { withLibrary = true, dirName = 'steamworks_sdk' } = {}) {
  const redistributable = path.join(baseDir, dirName, 'redistributable_bin');
  fs.mkdirSync(redistributable, { recursive: true });
  if (withLibrary && PLATFORM_LIB) {
    const target = path.join(redistributable, PLATFORM_LIB);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'not-a-real-dll');
  }
  return redistributable;
}

test('目录名拼写容错：steamwork_sdk（少一个 s）也能识别，并如实提示', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shl-steam-typo-'));
  try {
    makeFakeSdkDir(temp, { dirName: 'steamwork_sdk' });
    const report = env.diagnoseSteam({ appDir: temp });
    assert.equal(report.available, true, `少一个 s 也应可用，blockers=${report.blockers.join('；')}`);
    assert.equal(report.sdk.dirName, 'steamwork_sdk');
    assert.match(report.sdk.note, /steamwork_sdk/);
    assert.match(report.sdk.note, /已兼容读取/);
    const step = report.steps.find((s) => s.title.includes('SDK'));
    assert.match(step.detail, /已兼容读取/, '界面里也应显示这条提示');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('兜底：直接把平台库文件放在应用目录下也能识别', () => {
  if (!PLATFORM_LIB) return;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shl-steam-flat-'));
  try {
    const flat = path.join(temp, PLATFORM_LIB);
    fs.mkdirSync(path.dirname(flat), { recursive: true });
    fs.writeFileSync(flat, 'not-a-real-dll');
    const report = env.diagnoseSteam({ appDir: temp });
    assert.equal(report.available, true, `平铺 DLL 也应可用，blockers=${report.blockers.join('；')}`);
    assert.equal(report.sdk.libraryExists, true);
    assert.match(report.sdk.note, /推荐放到 steamworks_sdk/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('候选目录：包含应用目录、上两级与 node_modules', () => {
  const dirs = env.candidateBaseDirs({ appDir: 'C:\\app\\sub' });
  assert.ok(dirs.some((d) => d.endsWith(path.join('app', 'sub'))));
  assert.ok(dirs.some((d) => d.endsWith('app')));
  assert.ok(dirs.some((d) => d.includes('node_modules')));
  const withExtra = env.candidateBaseDirs({ appDir: 'C:\\app', extraDirs: ['D:\\sdk-here'] });
  assert.equal(withExtra[0], path.resolve('D:\\sdk-here'), '自定义目录优先');
});

test('模块与 FFI 运行时：本机已安装 steamworks-ffi-node（真实检查）', () => {
  const moduleCheck = env.checkModule(APP_DIR);
  assert.equal(moduleCheck.available, true, `应能解析到 steamworks-ffi-node：${moduleCheck.error || ''}`);
  assert.equal(moduleCheck.hasSdkClass, true, '应导出 SteamworksSDK.getInstance');
  const ffi = env.checkFfiRuntime(APP_DIR);
  assert.equal(ffi.available, true, `koffi 应可用：${ffi.error || ''}`);
});

test('SDK 缺失时给出可执行的结论，而不是含糊失败（用一个没有 SDK 的目录验证）', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shl-steam-missing-'));
  try {
    const report = env.diagnoseSteam({ appDir: emptyDir });
    assert.equal(report.available, false, '没有 SDK redistributable 时必须判定为未就绪');
    assert.ok(report.blockers.some((b) => /redistributable/.test(b) || /steam_api/.test(b)), `blockers 应指出 SDK：${report.blockers.join('；')}`);
    const sdkStep = report.steps.find((s) => s.title.includes('SDK'));
    assert.equal(sdkStep.ok, false);
    assert.match(sdkStep.detail, /steamworks_sdk|redistributable/);
    assert.equal(report.sdk.found, false);
    assert.equal(report.sdk.library, PLATFORM_LIB);
    assert.ok(report.steps.some((s) => s.title === 'AppID'), '报告应包含 AppID 步骤');
    assert.ok(report.steps.some((s) => s.title === 'Steam 客户端'), '报告应包含 Steam 客户端步骤');
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('本机真实环境的自检结论结构完整（有/没有 SDK 都要给出可执行信息）', () => {
  const report = env.diagnoseSteam({ appDir: APP_DIR });
  assert.equal(typeof report.available, 'boolean');
  assert.equal(report.steps.length >= 4, true, '报告应包含多个步骤');
  if (report.available) {
    assert.equal(report.blockers.length, 0, '就绪时不应有 blocker');
    assert.equal(report.sdk.found, true);
  } else {
    assert.ok(report.blockers.length > 0, '未就绪时必须说明缺什么');
  }
});

test('SDK 目录存在且有本平台库文件时判定为就绪', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shl-steam-'));
  try {
    makeFakeSdkDir(temp, { withLibrary: true });
    const report = env.diagnoseSteam({ appDir: temp });
    assert.equal(report.available, true, `应判定就绪，blockers=${report.blockers.join('；')}`);
    assert.equal(report.sdk.found, true);
    assert.equal(report.sdk.libraryExists, true);
    const expectedSuffix = path.join(...PLATFORM_LIB.split('/'));
    assert.ok(report.sdk.libraryPath.endsWith(expectedSuffix), `实际路径：${report.sdk.libraryPath}`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('只有目录、缺本平台库文件时仍判为未就绪（区分两种缺失）', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shl-steam-'));
  try {
    makeFakeSdkDir(temp, { withLibrary: false });
    const report = env.diagnoseSteam({ appDir: temp });
    assert.equal(report.available, false);
    assert.equal(report.sdk.found, true, '目录找到了');
    assert.equal(report.sdk.libraryExists, false, '库文件缺失');
    assert.ok(report.blockers.some((b) => /缺少本平台库文件/.test(b)));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('steam_appid.txt：能读出数字 AppID，也能容忍非法内容', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shl-steam-'));
  try {
    fs.writeFileSync(path.join(temp, 'steam_appid.txt'), '480\n');
    const good = env.checkAppIdFile(temp);
    assert.equal(good.found, true);
    assert.equal(good.appId, 480);

    fs.writeFileSync(path.join(temp, 'steam_appid.txt'), 'not-a-number');
    const bad = env.checkAppIdFile(temp);
    assert.equal(bad.found, true);
    assert.equal(bad.appId, null, '非法内容不应被当成 AppID');

    const missing = env.checkAppIdFile(path.join(temp, 'nope'));
    assert.equal(missing.found, false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('显式传入 AppID 时优先于文件，且报告里标明 Spacewar', () => {
  const report = env.diagnoseSteam({ appDir: APP_DIR, appId: 480 });
  assert.equal(report.appId, 480);
  const step = report.steps.find((s) => s.title === 'AppID');
  assert.match(step.detail, /Spacewar/);
});
