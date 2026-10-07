'use strict';
// 只读诊断探针 3：在「把 SendRateMin/SendRateMax 钉成某个值」的前提下，同时量**双向**吞吐，
// 并打印 Steam 自己算出来的带宽估计（getConnectionRealTimeStatus().connectionStats）。
//
// 探针 2 的教训：它只数了「对端收到多少」，但读的是 outbound 句柄的接收队列 —— 在本机自连里
// 出站/入站句柄是同一个连接，发送方向的消息会被自己收回来，口径是错的。本探针改成：
//   A) 发送方向：Steam 收下多少字节（sendMessage 返回值）
//   B) 接收方向：从【两个句柄都读】真正的私有接收队列，去掉自己发出去又被自己收回来的部分
//   C) 打印 connectionStats，直接看 Steam 的 m_flBandwidthEstimate / m_nSendRate 这类字段
//
// 用法：
//   node tools\steam-sendrate-duplex-probe.cjs --rate=4194304
//   node tools\steam-sendrate-duplex-probe.cjs --rate=1024
//   node tools\steam-sendrate-duplex-probe.cjs --rate=default   （不下发，保持 Steam 出厂值）
//   node tools\steam-sendrate-duplex-probe.cjs --rate=none      （不下发，且先读一次当前值）
//
// 只读：只往 stdout 与命令行给的 --json 文件写。

const path = require('node:path');
const fs = require('node:fs');
const { applyNetConfig } = require('../network/steam-netconfig.cjs');

const args = { rate: 'default', seconds: 6, msg: 4096, json: null };
for (const arg of process.argv.slice(2)) {
  const m = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
  if (!m) continue;
  if (m[1] === 'rate') args.rate = m[2];
  else if (m[1] === 'seconds') args.seconds = Number(m[2]) || 6;
  else if (m[1] === 'msg') args.msg = Number(m[2]) || 4096;
  else if (m[1] === 'json') args.json = String(m[2]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const out = { rate: args.rate, seconds: args.seconds, msg: args.msg, lines: [] };
const say = (t = '') => { out.lines.push(t); log(t); };
const clip = (o) => { try { return JSON.stringify(o); } catch { return String(o); } };

function rateOverrides(rate) {
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

  const listenSocket = sockets.createListenSocketP2P(0);
  if (listenSocket === k_HSteamListenSocket_Invalid) { say('createListenSocketP2P 失败'); process.exit(1); }
  const pollGroup = sockets.createPollGroup();
  let inbound = null;
  const handles = new Set();
  sockets.onConnectionStateChange((change) => {
    if (change.newState === ESteamNetworkingConnectionState.Connecting) {
      try { sockets.acceptConnection(change.connection); } catch { /* 忽略 */ }
      if (pollGroup) { try { sockets.setConnectionPollGroup(change.connection, pollGroup); } catch { /* 忽略 */ } }
      handles.add(change.connection);
      return;
    }
    if (change.newState === ESteamNetworkingConnectionState.Connected) { handles.add(change.connection); if (inbound == null) inbound = change.connection; }
  });

  const outbound = sockets.connectP2P(ownId, 0);
  if (outbound === k_HSteamNetConnection_Invalid) { say('connectP2P 失败'); process.exit(1); }
  handles.add(outbound);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && inbound == null) { tick(); await sleep(20); }
  if (inbound == null) { say('自连没成功'); process.exit(1); }
  say(`自连已建立  句柄集合 [${[...handles].join(', ')}]  （自连时出站/入站是同一连接）`);

  // ---- 改之前先读一次 ----
  let before = null;
  try { before = utils.readBackInt32 && null; } catch { /* 忽略 */ }
  const applied = applyNetConfig(steam, rateOverrides(args.rate), process.env);
  const pick = (k) => { const e = (applied.applied || []).find((x) => x.key === k); return e ? e.effective : null; };
  say(`改动前置状态（未读取，见上一支探针的 A 结论：出厂 262144）`);
  say(`下发 rate=${args.rate} → SendRateMin 读回=${pick('sendRateMin')}  SendRateMax 读回=${pick('sendRateMax')}`);
  out.readback = { min: pick('sendRateMin'), max: pick('sendRateMax') };
  await sleep(500);

  const status = (h) => { try { return sockets.getConnectionRealTimeStatus?.(h) || null; } catch { return null; } };
  const dumpStats = (h, label) => {
    const s = status(h);
    if (!s) { say(`  ${label} connectionStats: 取不到`); return null; }
    const cs = s.connectionStats || s.stats || null;
    const keys = cs ? Object.keys(cs) : Object.keys(s);
    say(`  ${label} status 顶层字段: ${keys.join(', ')}`);
    if (cs) say(`  ${label} connectionStats: ${clip(cs)}`);
    return s;
  };
  say('改速率之前的状态：');
  dumpStats(inbound, '[before]');

  // ---- 双向吞吐 ----
  const payload = Buffer.alloc(args.msg, 0x42);
  const started = Date.now();
  let attempted = 0;
  let sentBytes = 0;
  let failed = 0;
  let recvFromInbound = 0;
  let recvFromOutbound = 0;
  let recvBatches = 0;
  const firstRecv = [];
  let lastReport = started;
  let lastSent = 0;

  const drain = (h) => {
    let msgs = null;
    try { msgs = sockets.receiveMessages?.(h, 512); } catch { msgs = null; }
    const list = Array.isArray(msgs) ? msgs : (msgs && Array.isArray(msgs.messages) ? msgs.messages : []);
    let got = 0;
    for (const m of list) {
      const buf = Buffer.isBuffer(m) ? m : (Buffer.isBuffer(m?.data) ? m.data : null);
      if (buf && buf.length) {
        got += buf.length;
        recvBatches += 1;
        if (firstRecv.length < 8) firstRecv.push({ at: Date.now() - started, bytes: buf.length, handle: h });
      }
    }
    return got;
  };

  while (Date.now() - started < args.seconds * 1000) {
    tick();
    attempted += 1;
    let ok = false;
    try {
      const r = typeof sockets.sendMessage === 'function' ? sockets.sendMessage(inbound, payload, 8) : sockets.sendReliable(inbound, payload);
      ok = !(r && r.success === false);
    } catch { ok = false; }
    if (ok) sentBytes += payload.length; else failed += 1;

    recvFromInbound += drain(inbound);
    recvFromOutbound += drain(outbound);

    if (Date.now() - lastReport >= 1000) {
      const dt = (Date.now() - lastReport) / 1000;
      const dSent = sentBytes - lastSent;
      lastReport = Date.now();
      lastSent = sentBytes;
      say(`[${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s] 收下 ${sentBytes}B (本秒 ${(dSent / dt / 1024).toFixed(1)} KiB/s) 失败 ${failed}`
        + ` | 私有队列收到 in=${recvFromInbound}B out=${recvFromOutbound}B / ${recvBatches}批`);
    }
    await sleep(2);
  }

  const secs = (Date.now() - started) / 1000;
  say('');
  say(`=== 汇总 rate=${args.rate} ===`);
  say(`发送侧：Steam 收下 ${sentBytes} B / ${attempted} 条（失败 ${failed}）→ ${(sentBytes / secs / 1024).toFixed(1)} KiB/s`);
  say(`接收侧：私有队列 in=${recvFromInbound} B  out=${recvFromOutbound} B  合计 ${(recvFromInbound + recvFromOutbound) / secs / 1024} KiB/s，${recvBatches} 批`);
  for (const f of firstRecv) say(`   收到 +${f.at}ms  ${f.bytes}B  handle=${f.handle}`);
  say('改速率之后的状态：');
  const after = dumpStats(inbound, '[after]');
  out.result = { rate: args.rate, sentBytes, recvFromInbound, recvFromOutbound, recvBatches, attempted, failed, seconds: secs, readback: out.readback, afterStatus: after };
  if (args.json) { try { fs.writeFileSync(args.json, JSON.stringify(out, null, 2), 'utf8'); say('已写入 ' + args.json); } catch (err) { say('写失败：' + err.message); } }
  process.exit(0);
})().catch((err) => { log('探针异常：' + String(err && err.stack ? err.stack : err).slice(0, 1200)); process.exit(1); });
