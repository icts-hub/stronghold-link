'use strict';
// 只读诊断探针 5：直接量「Steam 给这条连接用的发送速率」—— getConnectionRealTimeStatus().sendRateBytesPerSecond。
// 这个字段就是 Valve 源码里 SNP_ClampSendRate() 的返回值（steamnetworkingsockets_snp.cpp:4595/4620），
// 即「应用配置的 SendRateMin/Max」与「带宽估计」夹紧之后的**真正生效的发送速率**。
//
// 目的：判定 sendRateMin/sendRateMax 到底有没有作用到连接上，以及被夹到 1024 之后连接实际用什么速率发。
//
// 用法：
//   node tools\steam-sendrate-status-probe.cjs --rate=default   （完全不下发，看 Steam 出厂值下连接用什么速率）
//   node tools\steam-sendrate-status-probe.cjs --rate=none
//   node tools\steam-sendrate-status-probe.cjs --rate=1024
//   node tools\steam-sendrate-status-probe.cjs --rate=4194304
//   node tools\steam-sendrate-status-probe.cjs --mode=before-connect --rate=1024   （在 connectP2P 之前下发）
// 只读：只写 stdout 与 --json 指定的文件。

const path = require('node:path');
const fs = require('node:fs');
const { applyNetConfig } = require('../network/steam-netconfig.cjs');

const args = { rate: 'default', mode: 'after-connect', seconds: 5, msg: 4096, json: null };
for (const arg of process.argv.slice(2)) {
  const m = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
  if (!m) continue;
  if (m[1] === 'rate') args.rate = m[2];
  else if (m[1] === 'mode') args.mode = m[2];
  else if (m[1] === 'seconds') args.seconds = Number(m[2]) || 5;
  else if (m[1] === 'msg') args.msg = Number(m[2]) || 4096;
  else if (m[1] === 'json') args.json = String(m[2]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const out = { rate: args.rate, mode: args.mode, samples: [], lines: [] };
const say = (t = '') => { out.lines.push(t); log(t); };
// BigInt 安全序列化
const j = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

function overrides(rate) {
  const ov = {};
  for (const key of ['sendBufferSize', 'recvBufferSize', 'recvBufferMessages', 'nagleTime',
    'mtuPacketSize', 'iceEnable', 'icePenalty', 'sdrPenalty', 'ipAllowWithoutAuth']) ov[key] = null;
  if (rate !== 'default' && rate !== 'none') { ov.sendRateMin = rate; ov.sendRateMax = rate; }
  return ov;
}

(async () => {
  const mod = require('steamworks-ffi-node');
  const SDK = mod.default || mod.SteamworksSDK;
  const { ESteamNetworkingConnectionState, k_HSteamNetConnection_Invalid, k_HSteamListenSocket_Invalid } = mod;

  const steam = SDK.getInstance();
  if (typeof steam.setSdkPath === 'function') steam.setSdkPath(path.resolve(__dirname, '..', 'steamworks_sdk'));
  if (typeof steam.setDebug === 'function') steam.setDebug(false);
  if (!steam.init({ appId: 480 })) { say('SteamAPI_Init 失败'); process.exit(1); }

  const sockets = steam.networkingSockets;
  const utils = steam.networkingUtils;
  const ownId = String(steam.getStatus?.().steamId || '');
  const tick = () => { try { steam.runCallbacks(); } catch { /* 忽略 */ } try { sockets.runCallbacks(); } catch { /* 忽略 */ } };
  utils?.initRelayNetworkAccess?.();
  sockets.initAuthentication?.();
  for (let i = 0; i < 100; i += 1) {
    tick();
    const r = utils?.getRelayNetworkStatus?.();
    if (r && Number(r.availability) === 100) break;
    await sleep(100);
  }

  const doApply = (label) => {
    const r = applyNetConfig(steam, overrides(args.rate), process.env);
    const pick = (k) => { const e = (r.applied || []).find((x) => x.key === k); return e ? e.effective : null; };
    say(`${label}：下发 rate=${args.rate} → 全局读回 SendRateMin=${pick('sendRateMin')} SendRateMax=${pick('sendRateMax')}`);
    return { min: pick('sendRateMin'), max: pick('sendRateMax') };
  };

  if (args.mode === 'before-connect') out.readback = doApply('connectP2P 之前');

  const listenSocket = sockets.createListenSocketP2P(0);
  if (listenSocket === k_HSteamListenSocket_Invalid) { say('createListenSocketP2P 失败'); process.exit(1); }
  const pollGroup = sockets.createPollGroup();
  let inbound = null;
  sockets.onConnectionStateChange((change) => {
    if (change.newState === ESteamNetworkingConnectionState.Connecting) {
      try { sockets.acceptConnection(change.connection); } catch { /* 忽略 */ }
      if (pollGroup) { try { sockets.setConnectionPollGroup(change.connection, pollGroup); } catch { /* 忽略 */ } }
      return;
    }
    if (change.newState === ESteamNetworkingConnectionState.Connected && inbound == null) inbound = change.connection;
  });
  const outbound = sockets.connectP2P(ownId, 0);
  if (outbound === k_HSteamNetConnection_Invalid) { say('connectP2P 失败'); process.exit(1); }
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && inbound == null) { tick(); await sleep(20); }
  if (inbound == null) { say('自连没成功'); process.exit(1); }

  if (args.mode !== 'before-connect') out.readback = doApply('connectP2P 之后');

  const st = () => { try { return sockets.getConnectionRealTimeStatus?.(inbound) || null; } catch { return null; } };
  const show = (tag) => {
    const s = st() || {};
    say(`  ${tag}  sendRateBytesPerSecond=${s.sendRateBytesPerSecond}`
      + `  outBytes/s=${s.outBytesPerSec}  inBytes/s=${s.inBytesPerSec}`
      + `  outPkt/s=${s.outPacketsPerSec}  pendingReliable=${s.pendingReliable}  sentUnacked=${s.sentUnackedReliable}`
      + `  queueTime=${s.usecQueueTime}us  ping=${s.ping}`);
    return s;
  };
  say('');
  say('=== 连上后（还没发数据）===');
  show('[idle]');
  await sleep(1000);
  show('[idle+1s]');

  say('');
  say(`=== 打流量 ${args.seconds}s，每秒采样 sendRateBytesPerSecond ===`);
  const payload = Buffer.alloc(args.msg, 0x42);
  const t0 = Date.now();
  let sentTotal = 0;
  let lastSent = 0;
  let lastT = t0;
  let lastSample = t0;
  while (Date.now() - t0 < args.seconds * 1000) {
    tick();
    let ok = false;
    try {
      const r = typeof sockets.sendMessage === 'function' ? sockets.sendMessage(inbound, payload, 8) : sockets.sendReliable(inbound, payload);
      ok = !(r && r.success === false);
    } catch { ok = false; }
    if (ok) sentTotal += payload.length;
    if (Date.now() - lastSample >= 1000) {
      const s = show(`[+${((Date.now() - t0) / 1000).toFixed(0)}s]`);
      const now = Date.now();
      out.samples.push({ at: now - t0, sendRateBytesPerSecond: s.sendRateBytesPerSecond, outBytesPerSec: s.outBytesPerSec, acceptedPerSec: (sentTotal - lastSent) / ((now - lastT) / 1000) });
      lastSent = sentTotal; lastT = now; lastSample = now;
    }
    await sleep(2);
  }
  const s = show('[end]');
  out.finalStatus = { sendRateBytesPerSecond: s.sendRateBytesPerSecond, outBytesPerSec: s.outBytesPerSec, inBytesPerSec: s.inBytesPerSec, ping: s.ping };

  if (args.json) { try { fs.writeFileSync(args.json, j(out), 'utf8'); say('已写入 ' + args.json); } catch (err) { say('写失败：' + err.message); } }
  process.exit(0);
})().catch((err) => { log('探针异常：' + String(err && err.stack ? err.stack : err).slice(0, 1200)); process.exit(1); });
