'use strict';
// 只读探针：本机 Steam 自连（回环），把「连接句柄是什么类型」「getConnectionInfo /
// getConnectionRealTimeStatus / getDetailedConnectionStatus 到底返回什么」原样打出来。
//
// 目的：界面上 CURRENT ROUTE / PING / REMOTE POP / PENDING-UNACKED 全是 —，
// network/route-report.cjs 的 sampleRoute 会在 getConnectionInfo 返回空或抛异常时
// 静默退化成 NO_CONNECTION_INFO。这里要分清是「FFI 没这个函数」、
// 「句柄类型不对（BigInt vs Number）」，还是「函数在但字段是空的」。
//
// 独立进程运行（缺 SDK 时 SteamAPI_Init 会终止进程，不能放在应用主进程里试）。
// 用法：node tools\steam-route-probe.cjs
const path = require('node:path');
const fs = require('node:fs');

const out = { steps: [] };
const note = (name, value) => {
  out.steps.push({ name, value });
  console.log(`[route-probe] ${name}: ${JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `BIGINT:${v}` : v))}`);
};
const save = (extra = {}) => {
  Object.assign(out, extra);
  try { fs.writeFileSync(path.join(__dirname, 'steam-route-result.json'), JSON.stringify(out, null, 2), 'utf8'); } catch { /* ignore */ }
  console.log('RESULT ' + JSON.stringify(out));
};

const describe = (v) => {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'bigint') return 'bigint';
  if (t === 'number') return 'number';
  if (t === 'string') return 'string';
  if (t === 'object') return 'object keys=' + Object.keys(v).join(',');
  return t;
};

(async () => {
  const mod = require('steamworks-ffi-node');
  const SDK = mod.default || mod.SteamworksSDK;
  const { ESteamNetworkingConnectionState, k_HSteamNetConnection_Invalid, k_HSteamListenSocket_Invalid } = mod;
  const steam = SDK.getInstance();
  if (typeof steam.setSdkPath === 'function') steam.setSdkPath(path.resolve(__dirname, '..', 'steamworks_sdk'));
  if (typeof steam.setDebug === 'function') steam.setDebug(false);
  if (!steam.init({ appId: 480 })) return save({ ok: false, error: 'init failed' });

  const sockets = steam.networkingSockets;
  const ownId = steam.getStatus?.().steamId || sockets.getIdentity?.();
  note('steamId', String(ownId));

  // FFI 到底给了哪些函数？自己属性和原型链都要看 —— 方法在原型上，
  // 只看 Object.keys 会得出"没有 getConnectionInfo"的错误结论。
  const all = new Set();
  for (let o = sockets; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const n of Object.getOwnPropertyNames(o)) all.add(n);
  }
  note('api', [...all].filter((n) => typeof sockets[n] === 'function').sort());
  note('api-has', {
    getConnectionInfo: typeof sockets.getConnectionInfo === 'function',
    getConnectionRealTimeStatus: typeof sockets.getConnectionRealTimeStatus === 'function',
    getDetailedConnectionStatus: typeof sockets.getDetailedConnectionStatus === 'function',
    sendMessage: typeof sockets.sendMessage === 'function',
    sendReliable: typeof sockets.sendReliable === 'function',
    receiveMessages: typeof sockets.receiveMessages === 'function',
    receiveMessagesOnPollGroup: typeof sockets.receiveMessagesOnPollGroup === 'function',
  });

  steam.networkingUtils?.initRelayNetworkAccess?.();
  sockets.initAuthentication?.();

  const tick = () => { try { steam.runCallbacks(); } catch {} try { sockets.runCallbacks(); } catch {} };

  // 等 Steam Relay 就绪（Current = 100），不然连接根本建不起来
  let relay = null;
  for (let i = 0; i < 150; i += 1) {
    tick();
    relay = steam.networkingUtils?.getRelayNetworkStatus?.() || null;
    if (relay && Number(relay.availability) === 100) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  note('relay', relay ? { availability: relay.availability, name: relay.availabilityName } : null);

  const listenSocket = sockets.createListenSocketP2P(0);
  note('listenSocket', describe(listenSocket));
  if (listenSocket === k_HSteamListenSocket_Invalid) return save({ ok: false, error: 'createListenSocketP2P failed' });
  const pollGroup = sockets.createPollGroup();
  note('pollGroup', describe(pollGroup));

  let connected = null;
  let sawState = [];
  const off = sockets.onConnectionStateChange((change) => {
    sawState.push({ c: describe(change.connection), old: change.oldState, next: change.newState, name: change.info?.stateName || '' });
    if (change.newState === ESteamNetworkingConnectionState.Connecting) {
      const r = sockets.acceptConnection(change.connection);
      note('acceptConnection', { result: r });
      if (pollGroup) sockets.setConnectionPollGroup(change.connection, pollGroup);
      return;
    }
    if (change.newState === ESteamNetworkingConnectionState.Connected && connected == null) {
      connected = change.connection;
    }
  });

  const handle = sockets.connectP2P(String(ownId), 0);
  note('connectP2P', { handle: describe(handle), raw: typeof handle === 'bigint' ? String(handle) : handle });
  if (handle === k_HSteamNetConnection_Invalid) return save({ ok: false, error: 'connectP2P failed' });

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && connected == null) {
    tick();
    await new Promise((r) => setTimeout(r, 50));
  }
  note('stateChanges', sawState);
  note('connectedHandle', describe(connected));
  if (connected == null) {
    try { off?.(); } catch {}
    try { sockets.closeConnection(handle, 0, 'probe done', false); } catch {}
    try { sockets.closeListenSocket(listenSocket); } catch {}
    try { steam.shutdown(); } catch {}
    return save({ ok: false, error: 'never reached Connected' });
  }

  // 先发一点数据，让连接真正进入传输态
  try { sockets.sendReliable?.(connected, Buffer.from('shl-route-probe')); } catch { /* ignore */ }
  for (let i = 0; i < 20; i += 1) { tick(); await new Promise((r) => setTimeout(r, 25)); }

  // 句柄类型不同，逐个试一遍 —— 这是判断「函数在、句柄类型不对」的关键
  const attempts = [
    ['as-is', connected],
    ['Number()', Number(connected)],
    ['String()', String(connected)],
  ];
  for (const [label, h] of attempts) {
    for (const fn of ['getConnectionInfo', 'getConnectionRealTimeStatus', 'getDetailedConnectionStatus']) {
      const f = sockets[fn];
      if (typeof f !== 'function') { note(`${fn}(${label})`, 'FUNCTION_MISSING'); continue; }
      try {
        const v = f.call(sockets, h);
        note(`${fn}(${label})`, { type: describe(v), value: v === undefined ? 'undefined' : v });
      } catch (err) {
        note(`${fn}(${label})`, { threw: String(err && err.message ? err.message : err) });
      }
    }
  }

  // 原始地址接口也一并看一眼
  for (const fn of ['getConnectionAddr', 'getRemoteAddress', 'getConnectionAddress']) {
    const f = sockets[fn];
    if (typeof f !== 'function') { note(fn, 'FUNCTION_MISSING'); continue; }
    try {
      const v = f.call(sockets, connected);
      note(fn, { type: describe(v), value: v && typeof v === 'object' ? v : String(v) });
    } catch (err) {
      note(fn, { threw: String(err && err.message ? err.message : err) });
    }
  }

  try { off?.(); } catch {}
  try { sockets.closeConnection(connected, 0, 'probe done', false); } catch {}
  try { sockets.closeListenSocket(listenSocket); } catch {}
  try { pollGroup && sockets.destroyPollGroup(pollGroup); } catch {}
  try { steam.shutdown(); } catch {}
  save({ ok: true });
  process.exit(0);
})().catch((err) => {
  save({ ok: false, error: String(err && err.stack ? err.stack : err).slice(0, 800) });
  process.exit(1);
});
