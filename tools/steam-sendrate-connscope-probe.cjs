'use strict';
// 只读诊断探针 8（定位真相）：Steam 的 SendRateMin/Max 是**连接级**选项
// （steamnetworkingtypes.h:1239 标注 "[connection int32]"）。我们的 steam-netconfig.cjs 只往
// **Global** 作用域下发、也只从 Global 作用域回读 —— 回读到的 1024 到底是不是连接真正在用的值，未知。
// 本探针用 GetConfigValue 以 **CONFIG_SCOPE_CONNECTION = 2**（scopeObj = 连接句柄）直接读连接自身的配置，
// 与全局值、与 getConnectionRealTimeStatus().sendRateBytesPerSecond 并排打印。
//
// 用法：node tools\steam-sendrate-connscope-probe.cjs [--rate=default|1024|4194304] [--json=...]

const path = require('node:path');
const fs = require('node:fs');
const { applyNetConfig, utilsHandle } = require('../network/steam-netconfig.cjs');

const args = { rate: 'default', json: null };
for (const arg of process.argv.slice(2)) {
  const m = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
  if (!m) continue;
  if (m[1] === 'rate') args.rate = Number.isFinite(Number(m[2])) ? Number(m[2]) : 'default';
  else if (m[1] === 'json') args.json = String(m[2]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (...a) => console.log(...a);
const j = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

const SCOPE_GLOBAL = 1;
const SCOPE_CONNECTION = 2;
const ID_SEND_RATE_MIN = 10;
const ID_SEND_RATE_MAX = 11;
const GET_RESULT_NAME = { 0: 'NotSet', 1: 'OK', 2: 'OK_Inherited', 3: 'NoSuchKey', 4: 'BadType', 5: 'BadScopeObj', 6: 'BufferTooSmall', 7: 'Fail' };

function overrides(rate) {
  const ov = {};
  for (const key of ['sendBufferSize', 'recvBufferSize', 'recvBufferMessages', 'nagleTime',
    'mtuPacketSize', 'iceEnable', 'icePenalty', 'sdrPenalty', 'ipAllowWithoutAuth']) ov[key] = null;
  if (typeof rate === 'number') { ov.sendRateMin = rate; ov.sendRateMax = rate; }
  return ov;
}

(async () => {
  const mod = require('steamworks-ffi-node');
  const SDK = mod.default || mod.SteamworksSDK;
  const { ESteamNetworkingConnectionState, k_HSteamNetConnection_Invalid } = mod;

  const steam = SDK.getInstance();
  if (typeof steam.setSdkPath === 'function') steam.setSdkPath(path.resolve(__dirname, '..', 'steamworks_sdk'));
  if (typeof steam.setDebug === 'function') steam.setDebug(false);
  if (!steam.init({ appId: 480 })) { line('SteamAPI_Init 失败'); process.exit(1); }

  const sockets = steam.networkingSockets;
  const utils = steam.networkingUtils;
  const ownId = String(steam.getStatus?.().steamId || '');
  const tick = () => { try { steam.runCallbacks(); } catch { /* 忽略 */ } try { sockets.runCallbacks(); } catch { /* 忽略 */ } };
  utils?.initRelayNetworkAccess?.();
  sockets.initAuthentication?.();
  for (let i = 0; i < 100; i += 1) { tick(); const r = utils?.getRelayNetworkStatus?.(); if (r && Number(r.availability) === 100) break; await sleep(100); }

  // ---- 从 netconfig 模块拿 loader 与 utils 接口指针，自己补声明带 scope 的 GetConfigValue ----
  const h = utilsHandle(steam);
  if (!h) { line('utilsHandle(steam) 拿不到 loader，退出'); process.exit(1); }
  const lib = h.loader.getLibrary();
  const iface = h.iface;
  line(`utils 接口指针 = ${iface}（loader: ${h.loader.constructor?.name || 'unknown'}）`);
  // 签名与 network/steam-netconfig.cjs:396-400 完全一致（7 个参数，最后一个是 cbResult）
  const getConfigValue = lib.func('SteamAPI_ISteamNetworkingUtils_GetConfigValue', 'int', ['void*', 'int', 'int', 'int64', 'void*', 'void*', 'void*']);
  line('已补声明 SteamAPI_ISteamNetworkingUtils_GetConfigValue(iface, valueId, scope, scopeObj, pDataType, pResult, cbResult)');

  const readScoped = (valueId, scope, scopeObj) => {
    const dtype = Buffer.alloc(4);
    const buf = Buffer.alloc(8);
    const cbResult = Buffer.alloc(8);
    cbResult.writeBigUInt64LE(8n, 0);
    // koffi 对 int64 标量槽：用 { ToInt64 } 包装，避免把裸 number 当作用域对象指针
    const boxed = typeof scopeObj === 'number' && scopeObj !== 0 ? { ToInt64: () => BigInt(scopeObj) } : scopeObj;
    const rc = getConfigValue(iface, valueId, scope, boxed, dtype, buf, cbResult);
    return { rc, rcName: GET_RESULT_NAME[rc] || String(rc), dataType: dtype.readInt32LE(0), value: buf.readInt32LE(0) };
  };

  const result = { rate: args.rate, reads: [] };

  const rep = applyNetConfig(steam, overrides(args.rate), process.env);
  const pick = (k) => { const e = (rep.applied || []).find((x) => x.key === k); return e ? e.effective : null; };
  line(`下发 rate=${args.rate} → applyNetConfig 报告的 Global 读回：SendRateMin=${pick('sendRateMin')} SendRateMax=${pick('sendRateMax')}`);

  const listenSocket = sockets.createListenSocketP2P(0);
  const pollGroup = sockets.createPollGroup?.();
  let handle = null;
  const off = sockets.onConnectionStateChange((change) => {
    if (change.newState === ESteamNetworkingConnectionState.Connecting) {
      try { sockets.acceptConnection(change.connection); } catch { /* 忽略 */ }
      if (pollGroup) { try { sockets.setConnectionPollGroup(change.connection, pollGroup); } catch { /* 忽略 */ } }
      return;
    }
    if (change.newState === ESteamNetworkingConnectionState.Connected && handle == null) handle = change.connection;
  });
  const outbound = sockets.connectP2P(ownId, 0);
  if (outbound === k_HSteamNetConnection_Invalid) { line('connectP2P 失败'); process.exit(1); }
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && handle == null) { tick(); await sleep(20); }
  if (handle == null) { line('自连没成功'); process.exit(1); }
  line(`自连建立：outbound=${outbound} inbound=${handle} 同句柄=${outbound === handle}`);

  line('');
  line('=== GetConfigValue 按作用域读 SendRateMin / SendRateMax ===');
  const rows = [];
  for (const [tag, scope, scopeObj] of [
    ['Global(scope=1,obj=0)', SCOPE_GLOBAL, 0],
    ['Conn outbound(scope=2)', SCOPE_CONNECTION, outbound],
    ['Conn inbound (scope=2)', SCOPE_CONNECTION, handle],
    ['Conn 假句柄(scope=2)', SCOPE_CONNECTION, 999999],
  ]) {
    let a; let b;
    try { a = readScoped(ID_SEND_RATE_MIN, scope, scopeObj); } catch (err) { a = { rcName: 'threw:' + err.message, value: null, dataType: null }; }
    try { b = readScoped(ID_SEND_RATE_MAX, scope, scopeObj); } catch (err) { b = { rcName: 'threw:' + err.message, value: null, dataType: null }; }
    line(`  ${tag.padEnd(24)} Min: ${String(a.rcName).padEnd(12)} dataType=${a.dataType} value=${a.value}   |   Max: ${String(b.rcName).padEnd(12)} dataType=${b.dataType} value=${b.value}`);
    rows.push({ tag, scope, min: a, max: b });
  }
  result.reads = rows;

  const st = () => { try { return sockets.getConnectionRealTimeStatus?.(handle) || {}; } catch { return {}; } };
  const s = st();
  line('');
  line(`getConnectionRealTimeStatus(handle).sendRateBytesPerSecond = ${s.sendRateBytesPerSecond}`);
  result.realtimeSendRate = s.sendRateBytesPerSecond;

  if (args.json) { try { fs.writeFileSync(args.json, j(result), 'utf8'); line('已写入 ' + args.json); } catch (err) { line('写失败：' + err.message); } }
  try { if (off) off(); } catch { /* 忽略 */ }
  process.exit(0);
})().catch((err) => { line('探针异常：' + String(err && err.stack ? err.stack : err).slice(0, 1500)); process.exit(1); });
