'use strict';
// 真机探针：把"发送侧天花板到底是多少"读出来。
//
// 为什么需要它：联机卡顿时，光看界面上的线路读数分不清是「Steam 线路慢」还是「本地发送参数太小」。
// 这个探针在真机上做三件事：
//   1. 解析当前生效的链路参数（link-tuning）与全局网络参数（steam-netconfig），含环境变量覆盖后的结果；
//   2. 真的把全局参数下发进 Steam，并**逐项读回核对**，看哪些真的生效了；
//   3. 报告 FFI 绑定到底有没有暴露下发/读取所需的符号 —— 不同版本的 steamworks-ffi-node 差别很大，
//      缺符号时我们只能降级，探针要如实说明降级原因，而不是假装设成功了。
//
// 用法（先启动并登录 Steam 客户端）：
//   node tools/steam-netconfig-probe.cjs
//   node tools/steam-netconfig-probe.cjs --app=480 --json=tools/steam-netconfig.json
//   $env:SHL_STEAM_SEND_RATE='8m'; node tools/steam-netconfig-probe.cjs     # 试一版更大的发送速率
// 注意：这个探针**不需要对端**，单独一台机器就能跑，所以可以拿到好友机器上直接出报告。
const path = require('node:path');
const fs = require('node:fs');
const { initSteamSdk } = require('../network/steam-adapter.cjs');
const { resolveLinkTuning } = require('../network/link-tuning.cjs');
const { resolveNetConfig, formatNetConfigReport, applyNetConfig, bindMissingSymbols, VALUE_ID, LABEL } = require('../network/steam-netconfig.cjs');

const appDir = path.join(__dirname, '..');

function parseArgs(argv) {
  const out = { app: 480, json: path.join(__dirname, 'steam-netconfig-result.json') };
  for (const arg of argv) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    if (m[1] === 'app') out.app = Number(m[2]) || 480;
    else if (m[1] === 'json') out.json = String(m[2]);
  }
  return out;
}

/** FFI 能力清单：能不能下发、能不能读回。直接用模块自己的绑定逻辑，避免探针和实现各说一套。 */
function describeBinding(steam) {
  const utils = steam?.networkingUtils || steam?.networkingSockets || null;
  const loader = utils?.libraryLoader || null;
  const out = {
    hasNetworkingUtils: Boolean(steam?.networkingUtils),
    hasLibraryLoader: Boolean(loader),
    hasGetLibrary: typeof loader?.getLibrary === 'function',
    hasUtilsInterfaceAccessor: typeof loader?.SteamAPI_SteamNetworkingUtils_SteamAPI === 'function',
    canBindSetGlobalConfigValueInt32: false,
    canBindGetConfigValue: false,
    globalScopeAvailable: false,
    interfacePointer: null,
    notes: [],
  };
  if (!loader) { out.notes.push('没有 libraryLoader，无法自己补声明缺失符号'); return out; }
  if (!out.hasGetLibrary) { out.notes.push('libraryLoader 没有 getLibrary()，拿不到底层 koffi 库句柄'); return out; }
  let lib = null;
  try { lib = loader.getLibrary(); } catch (err) { out.notes.push('getLibrary() 抛错：' + err.message); return out; }
  if (!lib || typeof lib.func !== 'function') { out.notes.push('getLibrary() 返回的对象没有 func()，无法补声明符号'); return out; }
  // 直接问实现要绑定结果：真名是 SetGlobalConfigValueInt32（不是 SetConfigValueInt32，后者 DLL 里根本没有）。
  const bound = bindMissingSymbols(loader);
  out.canBindSetGlobalConfigValueInt32 = Boolean(bound && bound.setInt32);
  out.canBindGetConfigValue = Boolean(bound && bound.getValue);
  out.globalScopeAvailable = Boolean(bound && bound.globalScope);
  if (bound && bound.failures && bound.failures.length) out.notes.push(...bound.failures);
  try { out.interfacePointer = loader.SteamAPI_SteamNetworkingUtils_SteamAPI() ? 'ok' : null; } catch (err) { out.notes.push('取 NetworkingUtils 接口指针失败：' + err.message); }
  if (!out.interfacePointer) out.notes.push('拿不到 NetworkingUtils 接口指针，全局参数无法下发');
  if (out.canBindSetGlobalConfigValueInt32 && !out.globalScopeAvailable) {
    out.notes.push('没有 SetGlobalConfigValueInt32，退回通用 SetConfigValue（同样能设全局，但多两个参数）');
  }
  return out;
}

/** 只靠环境变量和默认值解析，不碰 Steam —— 没有 Steam 客户端时也能看"本机会下发的值"。 */
function offlineReport(appId) {
  const tuning = resolveLinkTuning({});
  const net = resolveNetConfig({});
  return {
    appId,
    steamReady: false,
    tuning,
    netConfig: { available: false, reason: 'Steam 未就绪，仅显示将要下发的值', values: net.values, changed: net.changed, notes: net.notes },
    binding: null,
  };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const lines = [];
  const say = (text) => { lines.push(text); console.log(text); };
  let report = null;

  say('=== Stronghold-Link 发送侧参数探针 ===');
  say('appId=' + args.app + '  node=' + process.versions.node + '  electron=' + (process.versions.electron || '无（裸 node）'));

  let steam = null;
  let initError = null;
  try {
    const init = initSteamSdk({ appDir, appId: args.app, netConfig: {}, stats: null, debug: false });
    steam = init.steam;
    report = {
      appId: args.app,
      steamReady: true,
      tuning: resolveLinkTuning({}),
      netConfig: init.netConfig || null,
    };
  } catch (err) {
    initError = err;
    report = offlineReport(args.app);
    report.reason = err.message;
  }

  if (initError) {
    say('');
    say('Steam 初始化失败：' + initError.message);
    say('（这很正常 —— 需要 Steam 客户端已启动并登录。下面只列出本机会下发的值。）');
  }

  say('');
  say('── 链路参数（network/link-tuning.cjs，环境变量前缀 SHL_STEAM_）──');
  const t = report.tuning;
  say('  分片 maxChunk            ' + t.maxChunk + ' 字节   （1MB 要 ' + Math.ceil(1048576 / t.maxChunk) + ' 条 Steam 消息）');
  say('  攒发阈值 outFlushBytes   ' + t.outFlushBytes + ' 字节');
  say('  回调周期 callbackIntervalMs ' + t.callbackIntervalMs + ' ms   （Windows 上真实落地约 11~16ms，见 startCallbackLoop 注释）');
  say('  每轮取回 maxMessageBatch ' + t.maxMessageBatch + ' 条');
  say('  NoNagle=' + t.noNagle + '  NoDelay=' + t.noDelay);
  if (t.changed?.length) say('  被环境变量/参数覆盖：' + t.changed.join(' · '));
  if (t.notes?.length) for (const n of t.notes) say('  注意：' + n);

  say('');
  say('── 全局网络参数（network/steam-netconfig.cjs）──');
  const nc = report.netConfig;
  if (nc && Array.isArray(nc.values)) {
    for (const line of formatNetConfigReport(nc)) say('  ' + line);
  } else if (nc && nc.values && typeof nc.values === 'object') {
    for (const key of Object.keys(VALUE_ID)) {
      const v = nc.values[key];
      say('  ' + String(LABEL[key] || key).padEnd(22) + ' = ' + (v === null || v === undefined ? '（不下发）' : v));
    }
  }
  if (nc) {
    say('  下发结果：' + (nc.available ? (nc.applied?.length || 0) + ' 项成功' : '未生效 —— ' + (nc.reason || '未知原因')));
    if (nc.changed?.length) say('  与默认值不同：' + nc.changed.join(' · '));
    if (nc.notes?.length) for (const n of nc.notes) say('  注意：' + n);
  }

  say('');
  say('── FFI 绑定能力（缺符号就会走降级）──');
  if (steam) {
    report.binding = describeBinding(steam);
    const b = report.binding;
    say('  networkingUtils          ' + (b.hasNetworkingUtils ? '有' : '无'));
    say('  libraryLoader.getLibrary ' + (b.hasGetLibrary ? '有' : '无'));
    say('  补声明 SetGlobalConfigValueInt32 ' + (b.canBindSetGlobalConfigValueInt32 ? '可以' : '不行'));
    say('  补声明 GetConfigValue            ' + (b.canBindGetConfigValue ? '可以' : '不行'));
    say('  全局作用域入口                   ' + (b.globalScopeAvailable ? '有（SetGlobalConfigValueInt32）' : '无（退回通用 SetConfigValue）'));
    say('  NetworkingUtils 接口指针   ' + (b.interfacePointer ? '拿到' : '拿不到'));
    for (const n of b.notes) say('  ' + n);
  } else {
    report.binding = null;
    say('  Steam 未就绪，跳过。');
  }

  // 再单独跑一次纯下发（不经过 initSteamSdk），把"到底哪一项没生效"单独列出来。
  if (steam) {
    say('');
    say('── 逐项复核（重新下发一次并读回）──');
    let again = null;
    try { again = applyNetConfig(steam, {}); } catch (err) { say('  复核失败：' + err.message); }
    if (again) {
      report.recheck = again;
      for (const line of formatNetConfigReport(again)) say('  ' + line);
      for (const n of again.notes || []) say('  注意：' + n);
    }
  }

  report.lines = lines;
  try {
    fs.writeFileSync(args.json, JSON.stringify(report, null, 2), 'utf8');
    say('');
    say('已写入 ' + args.json);
  } catch (err) {
    say('写入 ' + args.json + ' 失败：' + err.message);
  }

  // 只读探针，不需要留任何句柄，直接退出。
  process.exit(initError ? 0 : 0);
})().catch((err) => {
  console.error('[steam-netconfig-probe] 未捕获错误：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
