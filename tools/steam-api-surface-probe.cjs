'use strict';
// 只读探针：把 steamworks-ffi-node 在本机**实际暴露出来**的网络接口原样列出来。
//
// 为什么必须有：延迟专项的所有诊断字段都必须来自真实存在的 API。类型声明（.d.ts）与
// 运行时对象不一定一致 —— 这个绑定是按名字动态绑定的，.d.ts 里有结构体定义不等于
// networkingSockets 上真有那个方法。这个探针不猜、不推断，只做两件事：
//   1. Object.keys() 列出 networkingSockets / networkingUtils 上的全部方法名；
//   2. 真连一条本机 P2P（自己连自己），把 getConnectionRealTimeStatus() 的每个字段
//      连同类型和值一起打出来 —— 哪些字段真的能读、读出来是什么形状，一测便知。
//
// 只读：只写 stdout 与 --out 指定的文件，不改任何网络参数，不碰产品代码。
//
// 用法：
//   node tools\steam-api-surface-probe.cjs
//   node tools\steam-api-surface-probe.cjs --out=api-surface.json

const path = require('node:path');
const fs = require('node:fs');

const args = { out: null, appId: 480, waitMs: 20000 };
for (const arg of process.argv.slice(2)) {
  const m = /^--([a-zA-Z]+)(?:=(.*))?$/.exec(arg);
  if (!m) continue;
  if (m[1] === 'out') args.out = String(m[2]);
  else if (m[1] === 'appId') args.appId = Number(m[2]) || 480;
  else if (m[1] === 'waitMs') args.waitMs = Number(m[2]) || 20000;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const out = { appId: args.appId, sockets: [], utils: [], realTimeStatus: null, detailed: null, notes: [] };
const say = (t = '') => { out.notes.push(t); console.log(t); };

/** 探针关心的名字：有就是有，没有就是没有，不做任何猜测。 */
const CANDIDATES = [
  'createListenSocketP2P', 'createPollGroup', 'destroyPollGroup', 'setConnectionPollGroup',
  'receiveMessagesOnPollGroup', 'receiveMessagesOnConnection', 'sendMessage', 'sendMessages',
  'sendReliable', 'sendUnreliable', 'connectP2P', 'acceptConnection', 'closeConnection',
  'getConnectionInfo', 'getConnectionRealTimeStatus', 'getDetailedConnectionStatus',
  'getConnectionState', 'getIdentity', 'runCallbacks', 'pollConnectionStates',
  'initAuthentication', 'getAuthenticationStatus', 'getPendingConnectionRequests',
  'configureConnectionLanes', 'ConfigureConnectionLanes', 'sendMessagesToConnectionWithLane',
  'getConnectionLaneInfo', 'getConnectionLanes', 'setConnectionUserData', 'getConnectionUserData',
];

(async () => {
  const mod = require('steamworks-ffi-node');
  const SDK = mod.default || mod.SteamworksSDK;
  const { ESteamNetworkingConnectionState, k_HSteamNetConnection_Invalid, k_HSteamListenSocket_Invalid } = mod;

  const steam = SDK.getInstance();
  if (typeof steam.setSdkPath === 'function') steam.setSdkPath(path.resolve(__dirname, '..', 'steamworks_sdk'));
  if (typeof steam.setDebug === 'function') steam.setDebug(false);
  if (!steam.init({ appId: args.appId })) {
    say('SteamAPI_Init 失败（Steam 没开或未登录）—— 本次无法读取接口面');
    if (args.out) fs.writeFileSync(args.out, j({ ...out, initFailed: true }), 'utf8');
    process.exit(1);
  }

  const sockets = steam.networkingSockets;
  const utils = steam.networkingUtils;
  say(`模块版本：${(() => { try { return require('steamworks-ffi-node/package.json').version; } catch { return '?'; } })()}`);
  say(`sdk 路径：${typeof steam.getSdkPath === 'function' ? steam.getSdkPath() : '(无 getSdkPath)'}`);
  say(`自己的 SteamID：${String(steam.getStatus?.().steamId || '')}`);

  out.sockets = sockets ? Object.keys(sockets).sort() : [];
  out.utils = utils ? Object.keys(utils).sort() : [];
  say('');
  say(`=== steam.networkingSockets 上的方法（${out.sockets.length} 个）===`);
  say(out.sockets.join(' '));
  say('');
  say(`=== steam.networkingUtils 上的方法（${out.utils.length} 个）===`);
  say(out.utils.join(' '));

  say('');
  say('=== 关键接口存在性 ===');
  const has = (n) => (sockets && typeof sockets[n] === 'function');
  const presence = {};
  for (const n of CANDIDATES) {
    const ok = has(n);
    presence[n] = ok;
    if (ok) say(`  有   sockets.${n}()`);
  }
  const missing = CANDIDATES.filter((n) => !presence[n]);
  say(`  缺（${missing.length} 个）：${missing.join(' ')}`);
  out.presence = presence;
  out.missing = missing;

  const tick = () => {
    try { steam.runCallbacks(); } catch { /* 忽略 */ }
    try { sockets.runCallbacks(); } catch { /* 忽略 */ }
    try { sockets.pollConnectionStates?.(); } catch { /* 忽略 */ }
  };
  try { utils?.initRelayNetworkAccess?.(); } catch { /* 忽略 */ }
  try { sockets.initAuthentication?.(); } catch { /* 忽略 */ }

  // ---- 自己连自己，把真实读数打出来 ----
  let listenSocket = null;
  let inbound = null;
  let pollGroup = null;
  try {
    listenSocket = sockets.createListenSocketP2P(0);
    pollGroup = has('createPollGroup') ? sockets.createPollGroup() : null;
    sockets.onConnectionStateChange((change) => {
      if (change.newState === ESteamNetworkingConnectionState.Connecting) {
        try { sockets.acceptConnection(change.connection); } catch { /* 忽略 */ }
        if (pollGroup) { try { sockets.setConnectionPollGroup(change.connection, pollGroup); } catch { /* 忽略 */ } }
        return;
      }
      if (change.newState === ESteamNetworkingConnectionState.Connected && inbound == null) inbound = change.connection;
    });
    const ownId = String(steam.getStatus?.().steamId || '');
    const outbound = sockets.connectP2P(ownId, 0);
    if (outbound === k_HSteamNetConnection_Invalid) { say('connectP2P 失败，跳过实时状态读取'); }
    else {
      const deadline = Date.now() + args.waitMs;
      while (Date.now() < deadline && inbound == null) { tick(); await sleep(20); }
    }
  } catch (err) {
    say('自连异常：' + String(err && err.message ? err.message : err));
  }

  // 连上之后要给 Steam 一点时间算出 ping / 速率估计，否则字段全是 0。
  for (let i = 0; i < 25 && inbound != null; i += 1) { tick(); await sleep(100); }

  if (inbound == null) {
    say('');
    say('自连没成功：无法读到「连接级」实时字段，本次只报告接口存在性');
  } else {
    const rt = has('getConnectionRealTimeStatus') ? sockets.getConnectionRealTimeStatus(inbound) : undefined;
    say('');
    say('=== getConnectionRealTimeStatus(connection) 原样返回 ===');
    if (rt === undefined) say('  方法不存在（UNAVAILABLE）');
    else if (!rt) say('  返回空');
    else {
      const rows = {};
      for (const key of Object.keys(rt)) rows[key] = { type: typeof rt[key], value: typeof rt[key] === 'bigint' ? rt[key].toString() : rt[key] };
      out.realTimeStatus = rows;
      for (const [key, v] of Object.entries(rows)) say(`  ${key}  <${v.type}>  ${v.value}`);
    }
    const det = has('getDetailedConnectionStatus') ? (() => { try { return sockets.getDetailedConnectionStatus(inbound); } catch (err) { return 'ERROR: ' + err.message; } })() : undefined;
    out.detailed = det === undefined ? null : String(det);
    say('');
    say('=== getDetailedConnectionStatus(connection) 原文 ===');
    say(det === undefined ? '  方法不存在（UNAVAILABLE）' : String(det));
    const info = has('getConnectionInfo') ? (() => { try { return sockets.getConnectionInfo(inbound); } catch (err) { return null; } })() : null;
    out.connectionInfo = info || null;
    say('');
    say('=== getConnectionInfo(connection) 关键字段 ===');
    if (!info) say('  读不到');
    else for (const k of ['state', 'stateName', 'popIdRemote', 'popIdRelay', 'connectionDescription', 'remoteAddress']) say(`  ${k} = ${info[k]}`);
  }

  if (typeof sockets.receiveMessagesOnPollGroup === 'function' && pollGroup) {
    try { const batch = sockets.receiveMessagesOnPollGroup(pollGroup, 32); out.receiveBatch = Array.isArray(batch) ? batch.length : null; } catch (err) { out.receiveBatch = 'ERROR: ' + err.message; }
  }

  try { if (pollGroup && has('destroyPollGroup')) sockets.destroyPollGroup(pollGroup); } catch { /* 忽略 */ }
  try { if (listenSocket != null && listenSocket !== k_HSteamListenSocket_Invalid && has('closeListenSocket')) sockets.closeListenSocket(listenSocket); } catch { /* 忽略 */ }

  if (args.out) { try { fs.writeFileSync(args.out, j(out), 'utf8'); say('已写入 ' + args.out); } catch (err) { say('写失败：' + err.message); } }
  process.exit(0);
})().catch((err) => {
  console.log('探针异常：' + String(err && err.stack ? err.stack : err).slice(0, 1500));
  process.exit(1);
});
