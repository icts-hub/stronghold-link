'use strict';
// 只读诊断探针：SendRateMin / SendRateMax 到底被 Steam 放成了多少。
//
// 背景：现场观测到每条连接只有约 1024 B/s（每 3.1 秒恰好 4096 字节）。
// 假设是 network/steam-netconfig.cjs 的 DEFAULTS 把 sendRateMin/sendRateMax 下发成 0，
// 而 Steam 把 0 夹紧成了 1024，正好等于观测速率。
//
// 本探针做四件事，顺序严格执行：
//   0. 独立进程 init Steam（appId 480，不做任何下发）→ 等 Relay 就绪，让 Steam 的带宽估计器
//      自己跑一会儿，然后读 SendRateMin/SendRateMax 的 **Global 作用域当前值**，
//      这就是 **Steam 自己的出厂默认值**（本次进程从未下发过任何东西）。
//   1. 用我们自己的 applyNetConfig(steam, {}) 把 DEFAULTS 原样下发一遍，再回读。
//   2. 三组对照：显式 0、显式 4194304、显式 1048576，各自回读。
//   3. 把第 0 步读到的原始默认值原样写回去，尽量不给正在运行的应用留下副作用。
//
// 只读：本文件除了往 stdout / 一个 JSON 结果文件写东西之外不改任何东西；
// 唯一的外部副作用就是上面第 1~3 步向 Steam 下发全局参数（进程私有会话，退出即散）。
//
// 用法（在 Stronghold-Link/source 下）：
//   node tools\steam-sendrate-probe.cjs
//   node tools\steam-sendrate-probe.cjs --json=tools/steam-sendrate-result.json

const path = require('node:path');
const fs = require('node:fs');
const netconfig = require('../network/steam-netconfig.cjs');

const {
  CONFIG_VALUE,
  CONFIG_TYPE_INT32,
  CONFIG_SCOPE_GLOBAL,
  DEFAULTS,
  APPLY_ORDER,
  VALUE_ID,
  LABEL,
  applyNetConfig,
  bindMissingSymbols,
  formatNetConfigReport,
} = netconfig;

// k_ESteamNetworkingGetConfigValueResult，探针要连"读不到"的原因一起报出来
const GET_RESULT_NAME = {
  [-1]: 'k_ESteamNetworkingGetConfigValue_BadValue',
  [-2]: 'k_ESteamNetworkingGetConfigValue_BadScopeObj',
  [-3]: 'k_ESteamNetworkingGetConfigValue_BufferTooSmall',
  0: 'k_ESteamNetworkingGetConfigValue_Invalid',
  1: 'k_ESteamNetworkingGetConfigValue_OK',
  2: 'k_ESteamNetworkingGetConfigValue_OK_Inherited',
  3: 'k_ESteamNetworkingGetConfigValue_OK_DefaultValue',
};

const args = { json: path.join(__dirname, 'steam-sendrate-result.json') };
for (const arg of process.argv.slice(2)) {
  const m = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
  if (m && m[1] === 'json' && m[2]) args.json = String(m[2]);
}

const report = { steps: {}, lines: [] };
const say = (text = '') => { report.lines.push(text); console.log(text); };

/**
 * 把 GetConfigValue 的原始返回码也读出来（模块里的 readBackInt32 只给值）。
 * 这里单独实现一份，是为了能区分"真的读到了 1024"与"读不到所以没核对上"。
 */
function readRaw(bound, iface, valueId, scope = CONFIG_SCOPE_GLOBAL, label = '') {
  if (!bound || typeof bound.getValue !== 'function') return { rc: null, reason: 'GetConfigValue 未绑定' };
  try {
    const dataType = Buffer.alloc(4);
    const result = Buffer.alloc(8);
    const cbResult = Buffer.alloc(8);
    cbResult.writeBigUInt64LE(8n, 0);
    const rc = bound.getValue(iface, valueId, scope, 0, dataType, result, cbResult);
    const type = dataType.readInt32LE(0);
    const out = {
      label,
      valueId,
      scope,
      rc,
      rcName: GET_RESULT_NAME[rc] || String(rc),
      dataType: type,
      typeName: type === CONFIG_TYPE_INT32 ? 'Int32' : '非 Int32',
      value: type === CONFIG_TYPE_INT32 ? result.readInt32LE(0) : null,
      cbResult: cbResult.readBigUInt64LE(0).toString(),
      error: null,
    };
    return out;
  } catch (err) {
    return { label, valueId, scope, rc: null, error: err && err.message ? err.message : String(err) };
  }
}

/** 同时读 min / max 两项，并把"默认值来源"的三种作用域都试一遍。 */
function readBoth(bound, iface, tag) {
  const out = { tag, at: Date.now(), items: [] };
  for (const [key, id] of [['sendRateMin', CONFIG_VALUE.SendRateMin], ['sendRateMax', CONFIG_VALUE.SendRateMax]]) {
    const g = readRaw(bound, iface, id, CONFIG_SCOPE_GLOBAL, LABEL[key]);
    out.items.push(g);
    say(`    ${LABEL[key].padEnd(12)} 值=${g.value === null || g.value === undefined ? '（读不到）' : g.value}`
      + `  rc=${g.rcName}  dataType=${g.typeName}${g.error ? '  错误=' + g.error : ''}`);
  }
  return out;
}

/** 等 Relay 就绪并让带宽估计器跑一会儿；这段时间内绝不下发任何配置。 */
async function warmUp(tick, waitMs) {
  let relay = null;
  for (let i = 0; i < 100; i += 1) {
    tick();
    try { relay = tick.utils()?.getRelayNetworkStatus?.() || null; } catch { relay = null; }
    if (relay && Number(relay.availability) === 100) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    tick();
    await new Promise((r) => setTimeout(r, 50));
  }
  return relay;
}

(async () => {
  const mod = require('steamworks-ffi-node');
  const SDK = mod.default || mod.SteamworksSDK;
  const steam = SDK.getInstance();
  const sdkPath = path.resolve(__dirname, '..', 'steamworks_sdk');
  if (typeof steam.setSdkPath === 'function') steam.setSdkPath(sdkPath);
  if (typeof steam.setDebug === 'function') steam.setDebug(false);

  say('=== SendRateMin / SendRateMax 真机探针（只读 + 受控下发）===');
  say('appId=480  node=' + process.versions.node + '  electron=' + (process.versions.electron || '无（裸 node）'));
  say('sdkPath=' + sdkPath);
  say('DEFAULTS.sendRateMin=' + JSON.stringify(DEFAULTS.sendRateMin) + '  DEFAULTS.sendRateMax=' + JSON.stringify(DEFAULTS.sendRateMax));
  say('DEFAULTS.transport 未设（默认走 DEFAULT_TRANSPORT=' + netconfig.DEFAULT_TRANSPORT + ' 预设）');
  say('');

  const ok = steam.init({ appId: 480 });
  if (!ok) {
    say('Steam init 失败（需要 Steam 客户端已启动并登录）。');
    process.exit(0);
  }

  const sockets = steam.networkingSockets;
  const utils = steam.networkingUtils;
  say('Steam 已就绪  steamId=' + (steam.getStatus?.().steamId || sockets?.getIdentity?.() || '未知'));

  const tick = () => { try { steam.runCallbacks(); } catch { /* ignore */ } try { sockets?.runCallbacks(); } catch { /* ignore */ } };
  tick.utils = () => utils;
  try { utils?.initRelayNetworkAccess?.(); } catch { /* ignore */ }
  try { sockets?.initAuthentication?.(); } catch { /* ignore */ }

  // ---------------------------------------------------------------- 绑定符号
  const loader = utils?.libraryLoader || sockets?.libraryLoader || null;
  let iface = null;
  let bound = null;
  say('');
  say('── 符号绑定 ──');
  say('  libraryLoader            ' + (loader ? '有' : '无'));
  say('  getLibrary()             ' + (loader && typeof loader.getLibrary === 'function' ? '有' : '无'));
  try { iface = loader?.SteamAPI_SteamNetworkingUtils_SteamAPI?.() || null; } catch (err) { say('  取接口指针抛错：' + err.message); }
  say('  NetworkingUtils 接口指针  ' + (iface ? '拿到' : '拿不到'));
  try { bound = loader ? bindMissingSymbols(loader) : null; } catch (err) { bound = null; say('  bindMissingSymbols 抛错：' + err.message); }
  say('  SetGlobalConfigValueInt32 ' + (bound && bound.setInt32 ? '可以' : '不行'));
  say('  GetConfigValue            ' + (bound && bound.getValue ? '可以' : '不行'));
  say('  入口作用域                 ' + (bound && bound.globalScope ? 'Global 专用入口' : '通用 SetConfigValue(scope=Global)'));
  if (bound?.failures?.length) for (const f of bound.failures) say('  ' + f);
  if (!bound || !iface) {
    say('符号不全，探针无法继续。');
    try { fs.writeFileSync(args.json, JSON.stringify(report, null, 2), 'utf8'); } catch { /* ignore */ }
    process.exit(0);
  }

  // ------------------------------------------------- 0. 下发前的 Steam 默认值
  say('');
  say('── [0] 下发任何配置之前 ──');
  process.stdout.write('  等 Relay 就绪并让带宽估计器自然跑 3 秒（此间零下发）... ');
  const relay = await warmUp(tick, 3000);
  say('完成');
  say('  Relay availability=' + (relay ? relay.availability + '(' + (relay.availabilityName || '') + ')' : '未知'));
  report.steps.relay = relay ? { availability: relay.availability, name: relay.availabilityName } : null;
  say('  Steam 出厂默认值（Global 作用域，本进程从未下发过）：');
  report.steps.before = readBoth(bound, iface, 'before-any-set');
  const defMin = report.steps.before.items[0]?.value;
  const defMax = report.steps.before.items[1]?.value;

  // --------------------------------------------- 1. 下发我们的 DEFAULTS（原样）
  say('');
  say('── [1] applyNetConfig(steam, {}) —— 原样下发 DEFAULTS ──');
  const netEnv = { ...process.env };
  const def = applyNetConfig(steam, {}, netEnv);
  report.steps.defaultsApply = def;
  say('  transport 预设：' + def.transport);
  say('  available=' + def.available + '  reason=' + (def.reason || '（无）'));
  for (const line of formatNetConfigReport(def)) say('  ' + line);
  for (const n of def.notes || []) say('  注意：' + n);
  const rateEntry = (def.applied || []).filter((e) => e.key === 'sendRateMin' || e.key === 'sendRateMax');
  say('  速率两项的逐项结果：');
  for (const e of rateEntry) say('    ' + e.name + ' 请求=' + e.requested + ' → 读回=' + (e.effective === null ? '读不到' : e.effective) + (e.note ? '  （' + e.note + '）' : ''));
  report.steps.afterDefaults = readBoth(bound, iface, 'after-defaults');

  // ------------------------------------------------------------ 2. 三组对照
  say('');
  say('── [2] 受控对照：只下发 sendRateMin/sendRateMax，其余全部显式跳过（null）──');
  const others = {};
  for (const key of APPLY_ORDER) {
    if (key !== 'sendRateMin' && key !== 'sendRateMax') others[key] = null;
  }
  const trials = [
    { name: '0（= 我们 DEFAULTS 的值）', rate: 0 },
    { name: '4194304（4 MiB/s 大值）', rate: 4194304 },
    { name: '1048576（1 MiB/s 参考）', rate: 1048576 },
  ];
  report.steps.trials = [];
  for (const trial of trials) {
    const ov = { ...others, sendRateMin: trial.rate, sendRateMax: trial.rate };
    const r = applyNetConfig(steam, ov, netEnv);
    const eMin = (r.applied || []).find((e) => e.key === 'sendRateMin') || null;
    const eMax = (r.applied || []).find((e) => e.key === 'sendRateMax') || null;
    const raw = readBoth(bound, iface, 'trial-' + trial.rate);
    report.steps.trials.push({ requested: trial.rate, label: trial.name, report: r, raw });
    say('  请求 ' + trial.name + '：');
    say('    ' + LABEL.sendRateMin + ' 请求=' + (eMin ? eMin.requested : '—') + '  读回=' + (eMin && eMin.effective !== null ? eMin.effective : '读不到')
      + (eMin && eMin.note ? '  （' + eMin.note + '）' : ''));
    say('    ' + LABEL.sendRateMax + ' 请求=' + (eMax ? eMax.requested : '—') + '  读回=' + (eMax && eMax.effective !== null ? eMax.effective : '读不到')
      + (eMax && eMax.note ? '  （' + eMax.note + '）' : ''));
    if (r.notes?.length) for (const n of r.notes) say('      注意：' + n);
  }

  // ------------------------------------------------------------- 3. 复原默认
  say('');
  say('── [3] 还原 ──');
  const restoreMin = defMin === null || defMin === undefined ? 0 : defMin;
  const restoreMax = defMax === null || defMax === undefined ? 0 : defMax;
  const restore = applyNetConfig(steam, { ...others, sendRateMin: restoreMin, sendRateMax: restoreMax }, netEnv);
  report.steps.restore = restore;
  say('  把下发前读到的原值写回：SendRateMin=' + restoreMin + '  SendRateMax=' + restoreMax);
  const restoreDeadline = Date.now() + 1200;
  while (Date.now() < restoreDeadline) { tick(); await new Promise((r) => setTimeout(r, 50)); }
  report.steps.afterRestore = readBoth(bound, iface, 'after-restore');

  // --------------------------------------------------------------- 汇总结论
  const t = report.steps.afterDefaults?.items || [];
  const t0 = report.steps.trials[0]?.raw?.items || [];
  const t1 = report.steps.trials[1]?.raw?.items || [];
  say('');
  say('── 汇总（Global 作用域读回值）──');
  say('  项目'.padEnd(22) + 'SendRateMin   SendRateMax');
  const row = (name, a, b) => say('  ' + name.padEnd(20) + String(a === null || a === undefined ? '读不到' : a).padEnd(14) + String(b === null || b === undefined ? '读不到' : b));
  row('下发前(Steam 默认)', defMin, defMax);
  row('下发 DEFAULTS 后', t[0]?.value, t[1]?.value);
  row('显式下发 0 后', t0[0]?.value, t0[1]?.value);
  row('显式下发 4194304 后', t1[0]?.value, t1[1]?.value);
  row('还原后', report.steps.afterRestore?.items[0]?.value, report.steps.afterRestore?.items[1]?.value);

  say('');
  say('── 结论字段 ──');
  say('  A. 下发前 Steam 默认值        SendRateMin=' + defMin + '  SendRateMax=' + defMax);
  say('  B. 下发 0 之后读回            SendRateMin=' + t0[0]?.value + '  SendRateMax=' + t0[1]?.value
    + (Number(t0[0]?.value) === 1024 ? '   ← 0 被夹紧成 1024' : ''));
  say('  C. 下发 4194304 之后读回      SendRateMin=' + t1[0]?.value + '  SendRateMax=' + t1[1]?.value
    + (Number(t1[0]?.value) === 4194304 ? '   ← 大值可以设上去' : ''));
  say('  D. DEFAULTS 下发后读回        SendRateMin=' + t[0]?.value + '  SendRateMax=' + t[1]?.value);

  try {
    fs.writeFileSync(args.json, JSON.stringify(report, null, 2), 'utf8');
    say('');
    say('已写入 ' + args.json);
  } catch (err) {
    say('写 ' + args.json + ' 失败：' + err.message);
  }

  process.exit(0);
})().catch((err) => {
  console.error('[steam-sendrate-probe] 未捕获错误：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
