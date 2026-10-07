'use strict';
// 只读诊断探针 4：两件事
//  (1) 把 SendRateMin/Max 的「夹紧下限」扫出来（-1、0、1、512、1023、1024、1025、2048 …），
//      回答「0 被夹到 1024」到底是不是因为有 1024 这个硬下限。
//  (2) 在一台**已经连着**的回环连接上，把速率从 4 MiB/s 改成 1024，看吞吐会不会掉下来 —
//      回答「这个参数是不是事后也生效、是不是真的能限速」。
//
// 用法：node tools\steam-sendrate-scan-probe.cjs [--seconds=4] [--json=...]
// 只读：只写 stdout 与 --json 指定的文件。

const path = require('node:path');
const fs = require('node:fs');
const { applyNetConfig } = require('../network/steam-netconfig.cjs');

const args = { seconds: 4, msg: 4096, json: null };
for (const arg of process.argv.slice(2)) {
  const m = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
  if (!m) continue;
  if (m[1] === 'seconds') args.seconds = Number(m[2]) || 4;
  else if (m[1] === 'msg') args.msg = Number(m[2]) || 4096;
  else if (m[1] === 'json') args.json = String(m[2]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const out = { scan: [], phases: [], lines: [] };
const say = (t = '') => { out.lines.push(t); log(t); };

function overrides(min, max) {
  const ov = {};
  for (const key of ['sendBufferSize', 'recvBufferSize', 'recvBufferMessages', 'nagleTime',
    'mtuPacketSize', 'iceEnable', 'icePenalty', 'sdrPenalty', 'ipAllowWithoutAuth']) ov[key] = null;
  ov.sendRateMin = min; ov.sendRateMax = max;
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

  // ---------- (1) 夹紧下限扫描 ----------
  say('=== (1) SendRateMin/Max 夹紧下限扫描（Global 作用域，逐次下发后回读） ===');
  say('请求值          读回 SendRateMin     读回 SendRateMax');
  const scans = [-1, 0, 1, 512, 1023, 1024, 1025, 2048, 65536, 262144, 1048576];
  for (const v of scans) {
    const r = applyNetConfig(steam, overrides(v, v), process.env);
    const pick = (k) => { const e = (r.applied || []).find((x) => x.key === k); return e ? e.effective : null; };
    const mn = pick('sendRateMin');
    const mx = pick('sendRateMax');
    say(`${String(v).padStart(10)}      ${String(mn).padStart(12)}     ${String(mx).padStart(12)}`);
    out.scan.push({ requested: v, readMin: mn, readMax: mx });
  }

  // ---------- (2) 在已建立的连接上改速率，看吞吐会不会掉 ----------
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
  say('');
  say('=== (2) 已建立连接上改速率：4 MiB/s → 1024 B/s → 回 4 MiB/s ===');

  const payload = Buffer.alloc(args.msg, 0x42);

  const runPhase = async (label, min, max, ms) => {
    const r = applyNetConfig(steam, overrides(min, max), process.env);
    const pick = (k) => { const e = (r.applied || []).find((x) => x.key === k); return e ? e.effective : null; };
    await sleep(200);
    const t0 = Date.now();
    let sent = 0;
    let failed = 0;
    let recv = 0;
    while (Date.now() - t0 < ms) {
      tick();
      try {
        const res = typeof sockets.sendMessage === 'function' ? sockets.sendMessage(inbound, payload, 8) : sockets.sendReliable(inbound, payload);
        if (res && res.success === false) failed += 1; else sent += payload.length;
      } catch { failed += 1; }
      try {
        const msgs = sockets.receiveMessages?.(inbound, 512);
        const list = Array.isArray(msgs) ? msgs : (msgs && Array.isArray(msgs.messages) ? msgs.messages : []);
        for (const m of list) { const b = Buffer.isBuffer(m) ? m : m?.data; if (b && b.length) recv += b.length; }
      } catch { /* 忽略 */ }
      await sleep(2);
    }
    const secs = (Date.now() - t0) / 1000;
    const line = `${label}  下发(${min}/${max}) 读回(${pick('sendRateMin')}/${pick('sendRateMax')})`
      + `  → 送 ${(sent / secs / 1024).toFixed(1)} KiB/s（失败 ${failed}）  私有队列收 ${(recv / secs / 1024).toFixed(1)} KiB/s`;
    say(line);
    out.phases.push({ label, min, max, readMin: pick('sendRateMin'), readMax: pick('sendRateMax'), sentPerSec: sent / secs, recvPerSec: recv / secs, failed });
  };

  await runPhase('[P1] 高', 4194304, 4194304, args.seconds * 1000);
  await runPhase('[P2] 低', 1024, 1024, args.seconds * 1000);
  await runPhase('[P3] 回高', 4194304, 4194304, args.seconds * 1000);

  if (args.json) { try { fs.writeFileSync(args.json, JSON.stringify(out, null, 2), 'utf8'); say('已写入 ' + args.json); } catch (err) { say('写失败：' + err.message); } }
  process.exit(0);
})().catch((err) => { log('探针异常：' + String(err && err.stack ? err.stack : err).slice(0, 1200)); process.exit(1); });
