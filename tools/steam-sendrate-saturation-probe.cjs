'use strict';
// 只读诊断探针 7：判定"把 SendRateMin/SendRateMax 钉成同一个值"到底会不会限住真实吞吐。
//
// 做法（避免前人踩过的口径坑）：
//   1. 只在 connectP2P **之前**下发（连接级选项在建连时绑定，之后改无效）。
//   2. 饱和发送：不停 sendMessage，被拒（success===false / 返回 0 / 抛错）也继续，
//      每 1 秒记录"这一秒应用侧成功交出的字节数" —— 发送缓冲填满后，这个数就是
//      Steam 真正接受的速率，即限速值本身。
//   3. 累计丢弃条数：限速生效时，前 2MB 缓冲填满后必然大量被拒。
//
// 用法：node tools\steam-sendrate-saturation-probe.cjs [--rate=default|1024|262144|4194304] [--seconds=12] [--json=...]

const path = require('node:path');
const fs = require('node:fs');
const { applyNetConfig } = require('../network/steam-netconfig.cjs');

const args = { rate: 'default', seconds: 12, msg: 4096, json: null };
for (const arg of process.argv.slice(2)) {
  const m = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
  if (!m) continue;
  if (m[1] === 'rate') args.rate = m[2] === undefined ? 'default' : (Number.isFinite(Number(m[2])) ? Number(m[2]) : m[2]);
  else if (m[1] === 'seconds') args.seconds = Number(m[2]) || 12;
  else if (m[1] === 'msg') args.msg = Number(m[2]) || 4096;
  else if (m[1] === 'json') args.json = String(m[2]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KIB = (b) => (Number(b) / 1024).toFixed(2);
const line = (...a) => console.log(...a);
const j = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

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

  const result = { rate: args.rate, seconds: args.seconds, samples: [], notes: [] };

  // 下发必须在建连前
  const rep = applyNetConfig(steam, overrides(args.rate), process.env);
  const pick = (k) => { const e = (rep.applied || []).find((x) => x.key === k); return e ? e.effective : null; };
  line(`下发 rate=${args.rate} → 全局读回 SendRateMin=${pick('sendRateMin')} SendRateMax=${pick('sendRateMax')}`);

  if (!sockets.createListenSocketP2P) { line('本 SDK 没有 createListenSocketP2P'); process.exit(1); }
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

  const payload = Buffer.alloc(args.msg, 0x42);
  const st = () => { try { return sockets.getConnectionRealTimeStatus?.(handle) || {}; } catch { return {}; } };
  const s0 = st();
  line(`建连瞬间状态：rate=${s0.sendRateBytesPerSecond} state=${s0.state}`);
  result.connectedRate = s0.sendRateBytesPerSecond;

  // 空跑 2 秒让估计器/令牌桶进入稳态
  const warm = Date.now();
  while (Date.now() - warm < 2000) { tick(); await sleep(5); }
  const s1 = st();
  line(`空跑 2s 后：rate=${s1.sendRateBytesPerSecond} outB/s=${Math.round(Number(s1.outBytesPerSec) || 0)}`);
  result.warmRate = s1.sendRateBytesPerSecond;

  line(`饱和发送 ${args.seconds}s（每条 ${args.msg}B，2ms 间隔）`);
  const t0 = Date.now();
  let accWindow = 0, rejWindow = 0, errWindow = 0;
  let accTotal = 0, rejTotal = 0, errTotal = 0;
  let last = t0;
  let sampleShapes = new Set();
  while (Date.now() - t0 < args.seconds * 1000) {
    tick();
    let res;
    try {
      res = typeof sockets.sendMessage === 'function' ? sockets.sendMessage(handle, payload, 8) : sockets.sendReliable(handle, payload);
    } catch { errWindow += 1; errTotal += 1; res = undefined; }
    if (res !== undefined) {
      const ok = !(res && (res.success === false || res.result === 1 || Number(res) === 0));
      if (ok) { accWindow += args.msg; accTotal += args.msg; } else { rejWindow += 1; rejTotal += 1; }
      if (sampleShapes.size < 4) sampleShapes.add(j(res));
    }
    try { sockets.receiveMessages?.(handle, 512); } catch { /* 忽略 */ }

    const now = Date.now();
    if (now - last >= 1000) {
      const secs = (now - last) / 1000;
      const s = st();
      const accRate = accWindow / secs;
      line(`  [+${((now - t0) / 1000).toFixed(0)}s] 接受 ${KIB(accRate)} KiB/s（累计 ${KIB(accTotal)} KiB，拒 ${rejTotal} 条，错 ${errTotal}）`
        + `  | rate=${s.sendRateBytesPerSecond} outB/s=${Math.round(Number(s.outBytesPerSec) || 0)} pendingRel=${s.pendingReliable} unacked=${s.sentUnackedReliable} qTime=${s.usecQueueTime}us`);
      result.samples.push({ at: now - t0, accBytesPerSec: accRate, accTotal, rejTotal, sendRate: s.sendRateBytesPerSecond, outBytesPerSec: Number(s.outBytesPerSec) || 0, pendingReliable: s.pendingReliable, usecQueueTime: s.usecQueueTime });
      accWindow = 0; rejWindow = 0; errWindow = 0; last = now;
    }
    await sleep(2);
  }
  const secsAll = (Date.now() - t0) / 1000;
  line(`总计：接受 ${accTotal} B（平均 ${KIB(accTotal / secsAll)} KiB/s）  被拒 ${rejTotal} 条  异常 ${errTotal} 条`);
  line(`sendMessage 返回样本：${[...sampleShapes].join(' | ')}`);
  result.accTotal = accTotal; result.rejTotal = rejTotal; result.errTotal = errTotal;
  result.avgAccPerSec = accTotal / secsAll;
  result.sampleShapes = [...sampleShapes];

  if (args.json) { try { fs.writeFileSync(args.json, j(result), 'utf8'); line('已写入 ' + args.json); } catch (err) { line('写失败：' + err.message); } }
  try { if (off) off(); } catch { /* 忽略 */ }
  process.exit(0);
})().catch((err) => { line('探针异常：' + String(err && err.stack ? err.stack : err).slice(0, 1200)); process.exit(1); });
