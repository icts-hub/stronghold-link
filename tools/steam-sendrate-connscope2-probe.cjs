'use strict';
// 只读诊断探针 9：以**连接**作用域读 SendRateMin/Max，确认连接真正持有的值。
//
// 背景：steamnetworkingtypes.h:1239 标注这两项是 "[connection int32]"，而
// steam-netconfig.cjs 只往 Global 下发、只从 Global 回读。本探针把三种读法全试一遍，
// 每种在独立子进程里跑（last 那种若签名不对会让 Steam 直接崩，父进程要把崩溃点标出来）。
//
//   父进程：node tools\steam-sendrate-connscope2-probe.cjs [--rate=1024]
//   子进程：node tools\steam-sendrate-connscope2-probe.cjs --child=<variant>

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { applyNetConfig, utilsHandle } = require('../network/steam-netconfig.cjs');

const VARIANT = (process.argv.find((a) => a.startsWith('--child=')) || '').slice(8);
const rateArg = (process.argv.find((a) => a.startsWith('--rate=')) || '--rate=1024').slice(7);
const RATE = Number.isFinite(Number(rateArg)) ? Number(rateArg) : rateArg;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (...a) => console.log(...a);

const GET_NAME = { 0: 'NotSet', 1: 'OK', 2: 'OK_Inherited', 3: 'NoSuchKey', 4: 'BadType', 5: 'BadScopeObj', 6: 'BufferTooSmall', 7: 'Fail' };
const SCOPE_GLOBAL = 1;
const SCOPE_CONNECTION = 2;
const ID_MIN = 10;
const ID_MAX = 11;

function overrides(rate) {
  const ov = {};
  for (const key of ['sendBufferSize', 'recvBufferSize', 'recvBufferMessages', 'nagleTime',
    'mtuPacketSize', 'iceEnable', 'icePenalty', 'sdrPenalty', 'ipAllowWithoutAuth']) ov[key] = null;
  if (typeof rate === 'number') { ov.sendRateMin = rate; ov.sendRateMax = rate; }
  return ov;
}

async function child() {
  const mod = require('steamworks-ffi-node');
  const SDK = mod.default || mod.SteamworksSDK;
  const { ESteamNetworkingConnectionState, k_HSteamNetConnection_Invalid } = mod;
  const steam = SDK.getInstance();
  steam.setSdkPath(path.resolve(__dirname, '..', 'steamworks_sdk'));
  steam.setDebug(false);
  if (!steam.init({ appId: 480 })) { line('init 失败'); process.exit(1); }
  const sockets = steam.networkingSockets;
  const utils = steam.networkingUtils;
  const ownId = String(steam.getStatus?.().steamId || '');
  const tick = () => { try { steam.runCallbacks(); } catch { /* 忽略 */ } try { sockets.runCallbacks(); } catch { /* 忽略 */ } };
  utils?.initRelayNetworkAccess?.();
  sockets.initAuthentication?.();
  for (let i = 0; i < 100; i += 1) { tick(); const r = utils?.getRelayNetworkStatus?.(); if (r && Number(r.availability) === 100) break; await sleep(100); }

  const rep = applyNetConfig(steam, overrides(RATE), process.env);
  const pick = (k) => { const e = (rep.applied || []).find((x) => x.key === k); return e ? e.effective : null; };
  line(`[child ${VARIANT}] 下发 rate=${RATE} → Global 读回 Min=${pick('sendRateMin')} Max=${pick('sendRateMax')}`);

  sockets.createListenSocketP2P(0);
  const pollGroup = sockets.createPollGroup?.();
  let handle = null;
  sockets.onConnectionStateChange((change) => {
    if (change.newState === ESteamNetworkingConnectionState.Connecting) {
      try { sockets.acceptConnection(change.connection); } catch { /* 忽略 */ }
      if (pollGroup) { try { sockets.setConnectionPollGroup(change.connection, pollGroup); } catch { /* 忽略 */ } }
      return;
    }
    if (change.newState === ESteamNetworkingConnectionState.Connected && handle == null) handle = change.connection;
  });
  const outbound = sockets.connectP2P(ownId, 0);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && handle == null) { tick(); await sleep(20); }
  if (handle == null || outbound === k_HSteamNetConnection_Invalid) { line('自连失败'); process.exit(1); }
  line(`[child ${VARIANT}] 自连建立 handle=${handle}`);

  const h = utilsHandle(steam);
  const lib = h.loader.getLibrary();
  const iface = h.iface;

  // 两种签名：scopeObj 声明为 int64（裸 number）或 int32
  const sig = VARIANT === 'int32' ? 'int32' : 'int64';
  line(`[child ${VARIANT}] 绑定 GetConfigValue，scopeObj 槽类型=${sig}`);
  const fn = lib.func('SteamAPI_ISteamNetworkingUtils_GetConfigValue', 'int', ['void*', 'int', 'int', sig, 'void*', 'void*', 'void*']);

  const read = (id, scope, obj) => {
    const dtype = Buffer.alloc(4);
    const buf = Buffer.alloc(8);
    const cb = Buffer.alloc(8);
    cb.writeBigUInt64LE(8n, 0);
    const rc = fn(iface, id, scope, obj, dtype, buf, cb);
    let v = null;
    try { v = buf.readInt32LE(0); } catch { /* 忽略 */ }
    return `${GET_NAME[rc] || rc} dataType=${dtype.readInt32LE(0)} value=${v}`;
  };

  const mode = VARIANT.startsWith('wrap') ? 'wrap' : (VARIANT === 'int32' ? 'int32' : 'raw');
  const objFor = (n) => {
    if (n === 0) return 0;
    if (mode === 'wrap') return { ToInt64: () => BigInt(n) };
    return n;
  };
  line(`[child ${VARIANT}] scopeObj 传法=${mode}`);

  line(`  Global            Min: ${read(ID_MIN, SCOPE_GLOBAL, 0)}   Max: ${read(ID_MAX, SCOPE_GLOBAL, 0)}`);
  line(`  Conn(handle)      Min: ${read(ID_MIN, SCOPE_CONNECTION, objFor(handle))}   Max: ${read(ID_MAX, SCOPE_CONNECTION, objFor(handle))}`);
  line(`  Conn(0 假对象)    Min: ${read(ID_MIN, SCOPE_CONNECTION, 0)}   Max: ${read(ID_MAX, SCOPE_CONNECTION, 0)}`);

  const s = (() => { try { return sockets.getConnectionRealTimeStatus(handle) || {}; } catch { return {}; } })();
  line(`  realtime.sendRateBytesPerSecond = ${s.sendRateBytesPerSecond}`);
  line(`[child ${VARIANT}] 完成`);
  process.exit(0);
}

function parent() {
  for (const v of ['int64raw', 'wrap_int64', 'int32']) {
    line('');
    line(`##################### 子进程变体：${v} #####################`);
    const r = spawnSync(process.execPath, [__filename, `--child=${v}`, `--rate=${RATE}`], { encoding: 'utf8', cwd: path.resolve(__dirname, '..') });
    const stdout = (r.stdout || '').trim();
    const stderr = (r.stderr || '').split('\n').filter((l) => l && !l.includes('minidump') && !l.includes('Caching Steam ID')).join('\n');
    if (stdout) line(stdout);
    if (stderr) line('[stderr] ' + stderr);
    line(`--> 子进程退出码 ${r.status}${r.signal ? ' 信号 ' + r.signal : ''}${r.status !== 0 ? '  （非 0 表示这一步崩了/失败）' : ''}`);
  }
}

if (VARIANT) { child().catch((e) => { line('异常：' + (e && e.stack ? e.stack : e)); process.exit(1); }); } else { parent(); }
