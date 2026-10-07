'use strict';
// 只读诊断探针 2：把 SendRateMin/SendRateMax 钉在一个具体值上，实测 Steam 回环连接的
// 真实吞吐 —— 用来判定「1024 B/s 是不是真的会把发送限成 1024 B/s」。
//
// 现场观测是「每 3.1 秒恰好 4096 字节」。本探针回答的是另一个问题：
//   如果 SendRateMin=SendRateMax=1024（0 被夹紧后的值）真的生效，吞吐会不会就是 ~1024 B/s？
// 对照组直接取 4 MiB/s 与 256 KiB/s（Steam 自己的默认值）。
//
// 用法：
//   node tools\steam-sendrate-throughput-probe.cjs --rate=4194304 --seconds=6 --json=tools\r1.json
//   node tools\steam-sendrate-throughput-probe.cjs --rate=1024    --seconds=6 --json=tools\r2.json
//
// 只读：不改任何已有文件；除命令行给出的 json 结果文件外只往 stdout 写。

const path = require('node:path');
const fs = require('node:fs');
const { applyNetConfig } = require('../network/steam-netconfig.cjs');

const args = { rate: null, seconds: 6, msg: 4096, json: null };
for (const arg of process.argv.slice(2)) {
  const m = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
  if (!m) continue;
  if (m[1] === 'rate') args.rate = Number(m[2]);
  else if (m[1] === 'seconds') args.seconds = Number(m[2]) || 6;
  else if (m[1] === 'msg') args.msg = Number(m[2]) || 4096;
  else if (m[1] === 'json') args.json = String(m[2]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const out = { rateRequested: args.rate, seconds: args.seconds, msg: args.msg, lines: [] };
const say = (t = '') => { out.lines.push(t); log(t); };

/** 只改速率两项，其余项显式跳过，避免污染别的全局参数。 */
function rateOverrides(rate) {
  const ov = {};
  for (const key of ['sendBufferSize', 'recvBufferSize', 'recvBufferMessages', 'nagleTime',
    'mtuPacketSize', 'iceEnable', 'icePenalty', 'sdrPenalty', 'ipAllowWithoutAuth']) ov[key] = null;
  ov.sendRateMin = rate;
  ov.sendRateMax = rate;
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
  const ownId = String(steam.getStatus?.().steamId || '');
  const tick = () => { try { steam.runCallbacks(); } catch { /* 忽略 */ } try { sockets.runCallbacks(); } catch { /* 忽略 */ } };
  steam.networkingUtils?.initRelayNetworkAccess?.();
  sockets.initAuthentication?.();
  for (let i = 0; i < 100; i += 1) {
    tick();
    const r = steam.networkingUtils?.getRelayNetworkStatus?.();
    if (r && Number(r.availability) === 100) break;
    await sleep(100);
  }

  // 先建立连接，再改速率：Global 作用域本来就该对之后的所有连接生效，
  // 但先建连能顺带观察"改之前 vs 改之后"的差别。
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

  const rt = () => { try { return sockets.getConnectionRealTimeStatus?.(inbound) || null; } catch { return null; } };
  const describe = () => {
    const r = rt() || {};
    return `ping=${r.ping ?? '?'}ms  inFlight=${r.sentUnackedReliable ?? '?'}  pending=${r.pendingReliable ?? '?'}`
      + `  queueTime=${r.m_usecQueueTime ?? '?'}us`;
  };
  say('自连已建立  出站句柄 ' + outbound + '  入站句柄 ' + inbound);
  say('改速率之前：  ' + describe());

  // 下发指定速率并读回
  const applied = applyNetConfig(steam, rateOverrides(args.rate), process.env);
  const eMin = (applied.applied || []).find((e) => e.key === 'sendRateMin');
  const eMax = (applied.applied || []).find((e) => e.key === 'sendRateMax');
  say(`下发 SendRateMin/SendRateMax = ${args.rate}  →  读回 min=${eMin ? eMin.effective : '—'} max=${eMax ? eMax.effective : '—'}`);
  out.readback = { min: eMin ? eMin.effective : null, max: eMax ? eMax.effective : null };
  await sleep(300);

  // 吞吐实测：每轮发一条 MSG 字节的可靠消息，数 Steam 收下多少字节
  const payload = Buffer.alloc(args.msg, 0x42);
  const started = Date.now();
  let attempted = 0;
  let sentBytes = 0;
  let recvBytes = 0;
  let recvBatches = 0;
  let failed = 0;
  const firstRecv = [];
  let lastReport = started;
  let lastSent = 0;

  while (Date.now() - started < args.seconds * 1000) {
    tick();
    attempted += 1;
    let ok = false;
    try {
      const r = typeof sockets.sendMessage === 'function' ? sockets.sendMessage(inbound, payload, 8) : sockets.sendReliable(inbound, payload);
      ok = !(r && r.success === false);
    } catch { ok = false; }
    if (ok) sentBytes += payload.length; else failed += 1;

    let msgs = null;
    try { msgs = sockets.receiveMessages?.(outbound, 256); } catch { msgs = null; }
    const list = Array.isArray(msgs) ? msgs : (msgs && Array.isArray(msgs.messages) ? msgs.messages : []);
    for (const m of list) {
      const buf = Buffer.isBuffer(m) ? m : (Buffer.isBuffer(m?.data) ? m.data : null);
      if (buf && buf.length) {
        recvBytes += buf.length;
        recvBatches += 1;
        if (firstRecv.length < 8) firstRecv.push({ at: Date.now() - started, bytes: buf.length, total: recvBytes });
      }
    }

    if (Date.now() - lastReport >= 1000) {
      const dt = (Date.now() - lastReport) / 1000;
      const dSent = sentBytes - lastSent;
      lastReport = Date.now();
      lastSent = sentBytes;
      say(`[${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s] 尝试 ${attempted} 条 / 收下 ${sentBytes}B / 失败 ${failed} 条`
        + ` | 本秒送 ${dSent}B (${(dSent / dt / 1024).toFixed(1)} KiB/s) | 对端收到 ${recvBytes}B/${recvBatches}批 | ${describe()}`);
    }
    await sleep(2);
  }

  const secs = (Date.now() - started) / 1000;
  say('');
  say('=== 汇总 rate=' + args.rate + ' ===');
  say('发送侧：Steam 收下 ' + sentBytes + ' B / ' + attempted + ' 条，失败 ' + failed + ' 条 → ' + (sentBytes / secs / 1024).toFixed(1) + ' KiB/s');
  say('接收侧：对端收到 ' + recvBytes + ' B / ' + recvBatches + ' 批 → ' + (recvBytes / secs / 1024).toFixed(1) + ' KiB/s');
  say('末尾状态：' + describe());
  for (const f of firstRecv) say('   首批 +' + f.at + 'ms  ' + f.bytes + 'B  累计 ' + f.total + 'B');

  out.result = { rate: args.rate, sentBytes, recvBytes, recvBatches, attempted, failed, seconds: secs, readback: out.readback };
  if (args.json) {
    try { fs.writeFileSync(args.json, JSON.stringify(out, null, 2), 'utf8'); say('已写入 ' + args.json); } catch (err) { say('写 ' + args.json + ' 失败：' + err.message); }
  }
  process.exit(0);
})().catch((err) => {
  log('探针异常：' + String(err && err.stack ? err.stack : err).slice(0, 1200));
  process.exit(1);
});
