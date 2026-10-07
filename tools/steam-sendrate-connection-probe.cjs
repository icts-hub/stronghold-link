'use strict';
// 只读诊断探针 6（决定性）：判定 sendRateMin/sendRateMax 到底能不能限住 Steam 的发送，
// 以及**必须在什么时候下发**才生效。
//
// 探针 5 已经发现：在 connectP2P **之后**下发 SendRateMin/Max，连接实际的
// sendRateBytesPerSecond 是 104857600（=100 MiB/s，Clamp 上界）—— 参数根本没作用到连接上。
// steamnetworkingtypes.h:1225-1228 解释了原因：
//   "HOWEVER: once a connection is created, the effective value is then bound to the
//    connection.  Unlike other connection options, if you change it again at a higher
//    level, the new value will not be inherited by connections."
// 所以本探针只在 connectP2P **之前**下发，并且同时读**两个句柄**的状态：
// 自连场景下我们往 inbound 发，Steam 的统计要看出站句柄 outbound。
//
// 用法：node tools\steam-sendrate-connection-probe.cjs [--seconds=5] [--json=...]
// 只读：只写 stdout 与 --json 指定的文件。

const path = require('node:path');
const fs = require('node:fs');
const { applyNetConfig } = require('../network/steam-netconfig.cjs');

const args = { seconds: 5, msg: 4096, json: null };
for (const arg of process.argv.slice(2)) {
  const m = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
  if (!m) continue;
  if (m[1] === 'seconds') args.seconds = Number(m[2]) || 5;
  else if (m[1] === 'msg') args.msg = Number(m[2]) || 4096;
  else if (m[1] === 'json') args.json = String(m[2]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const out = { scenarios: [], lines: [] };
const say = (t = '') => { out.lines.push(t); log(t); };
const j = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const KIB = (b) => (Number(b) / 1024).toFixed(1);

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

  const listenSocket = sockets.createListenSocketP2P(0);
  if (listenSocket === k_HSteamListenSocket_Invalid) { say('createListenSocketP2P 失败'); process.exit(1); }
  const pollGroup = sockets.createPollGroup();

  let inbound = null;
  let onState = null;
  const st = (h) => { try { return sockets.getConnectionRealTimeStatus?.(h) || null; } catch { return null; } };
  const fmt = (h, tag) => {
    const s = st(h) || {};
    return `${tag}(h=${h}) rate=${s.sendRateBytesPerSecond} outB/s=${Math.round(Number(s.outBytesPerSec) || 0)}`
      + ` inB/s=${Math.round(Number(s.inBytesPerSec) || 0)} outPkt/s=${(Number(s.outPacketsPerSec) || 0).toFixed(1)}`
      + ` pendingRel=${s.pendingReliable} unackedRel=${s.sentUnackedReliable} qTime=${s.usecQueueTime}us state=${s.state}`;
  };

  const scenario = async (label, rate) => {
    say('');
    say(`================= 场景：${label}（connectP2P 之前下发 rate=${rate}）=================`);
    const rec = { label, rate, samples: [] };

    // 下发（必须在建连之前）
    const r = applyNetConfig(steam, overrides(rate), process.env);
    const pick = (k) => { const e = (r.applied || []).find((x) => x.key === k); return e ? e.effective : null; };
    say(`全局读回：SendRateMin=${pick('sendRateMin')}  SendRateMax=${pick('sendRateMax')}`);
    rec.readback = { min: pick('sendRateMin'), max: pick('sendRateMax') };

    inbound = null;
    onState = sockets.onConnectionStateChange((change) => {
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
    say(`自连建立：outbound(h=${outbound})  inbound(h=${inbound})  两者是否同句柄=${outbound === inbound}`);
    say('  ' + fmt(outbound, '[outbound]'));
    say('  ' + fmt(inbound, '[inbound ]'));
    rec.handleSame = outbound === inbound;

    // 打流量
    const payload = Buffer.alloc(args.msg, 0x42);
    const t0 = Date.now();
    let accepted = 0;
    let refused = 0;
    let sendErr = 0;
    let recvOut = 0;
    let recvIn = 0;
    let lastA = 0;
    let lastT = t0;
    let lastSample = t0;
    const firstRecv = [];
    say(`  打流量 ${args.seconds}s（每条 ${args.msg}B，往 inbound 句柄发）`);
    while (Date.now() - t0 < args.seconds * 1000) {
      tick();
      try {
        const res = typeof sockets.sendMessage === 'function' ? sockets.sendMessage(inbound, payload, 8) : sockets.sendReliable(inbound, payload);
        if (res && res.success === false) refused += 1; else accepted += payload.length;
      } catch { sendErr += 1; }
      try {
        const m1 = sockets.receiveMessages?.(outbound, 512);
        const l1 = Array.isArray(m1) ? m1 : (m1 && Array.isArray(m1.messages) ? m1.messages : []);
        for (const m of l1) { const b = Buffer.isBuffer(m) ? m : m?.data; if (b && b.length) { recvOut += b.length; if (firstRecv.length < 6) firstRecv.push({ at: Date.now() - t0, bytes: b.length, handle: 'outbound' }); } }
        const m2 = sockets.receiveMessages?.(inbound, 512);
        const l2 = Array.isArray(m2) ? m2 : (m2 && Array.isArray(m2.messages) ? m2.messages : []);
        for (const m of l2) { const b = Buffer.isBuffer(m) ? m : m?.data; if (b && b.length) { recvIn += b.length; if (firstRecv.length < 6) firstRecv.push({ at: Date.now() - t0, bytes: b.length, handle: 'inbound' }); } }
      } catch { /* 忽略 */ }

      if (Date.now() - lastSample >= 1000) {
        const now = Date.now();
        const accPerSec = (accepted - lastA) / ((now - lastT) / 1000);
        lastA = accepted; lastT = now; lastSample = now;
        say(`  [+${((now - t0) / 1000).toFixed(0)}s] 交给 Steam ${KIB(accPerSec)} KiB/s（拒 ${refused} 错 ${sendErr}）`
          + `  私有队列收 out=${recvOut}B in=${recvIn}B`
          + `  | ${fmt(outbound, 'out')}  | ${fmt(inbound, 'in')}`);
        rec.samples.push({ at: now - t0, acceptedPerSec: accPerSec, recvOut, recvIn, rateOut: (st(outbound) || {}).sendRateBytesPerSecond, rateIn: (st(inbound) || {}).sendRateBytesPerSecond });
      }
      await sleep(2);
    }
    const secs = (Date.now() - t0) / 1000;
    say(`  小计：交给 Steam ${accepted} B（${KIB(accepted / secs)} KiB/s），被拒 ${refused} 条，异常 ${sendErr} 条`);
    say(`        私有接收队列：outbound 句柄 ${recvOut} B / inbound 句柄 ${recvIn} B`);
    for (const f of firstRecv) say(`        首批 +${f.at}ms ${f.bytes}B on ${f.handle}`);
    rec.acceptedPerSec = accepted / secs; rec.refused = refused; rec.recvOut = recvOut; rec.recvIn = recvIn;
    rec.finalRateOut = (st(outbound) || {}).sendRateBytesPerSecond;
    rec.finalRateIn = (st(inbound) || {}).sendRateBytesPerSecond;
    out.scenarios.push(rec);

    // 清理连接，进入下一场景
    try { sockets.closeConnection(outbound, 1000, 'probe done', false); } catch { /* 忽略 */ }
    try { sockets.closeConnection(inbound, 1000, 'probe done', false); } catch { /* 忽略 */ }
    try { if (onState) onState(); } catch { /* 忽略 */ }
    await sleep(1500);
  };

  await scenario('A 完全不下发（Steam 出厂值）', 'default');
  await scenario('B 只下发 sendRateMin=sendRateMax=1024', 1024);
  await scenario('C 只下发 sendRateMin=sendRateMax=4194304', 4194304);

  if (args.json) { try { fs.writeFileSync(args.json, j(out), 'utf8'); say('已写入 ' + args.json); } catch (err) { say('写失败：' + err.message); } }
  process.exit(0);
})().catch((err) => { log('探针异常：' + String(err && err.stack ? err.stack : err).slice(0, 1200)); process.exit(1); });
