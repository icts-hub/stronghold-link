'use strict';
// 只读基准：把「房主」与「加入者」两个角色都放在**本机自己**（Steam 自连回环），
// 直接量 Steam 的发送通道到底肯收多快、以及对面到底多久能收到。
//
// 为什么需要它：steam-mini-joiner 已经证明，一个完全不含应用转发代码的普通 Node 进程
// 去连小五大帅b 的房主端，拿到的仍是「3167 毫秒、恰好 4096 字节」——
// 和我们的隧道一模一样。也就是说要么房主端的发送代码有问题，要么那台机器那条上行有问题。
// 这个基准把房主端搬到本机：如果本机自连也是 4096 字节/3 秒，就是代码问题（本地可复现、可迭代）；
// 如果本机自连又快又顺，就说明问题在那台机器/那条上行，代码这边再改也没用。
//
// 两个方向分开量：
//   A) 发送方向 —— 每 2ms 试发一条 4KiB 消息，数 Steam 收下多少条；
//   B) 接收方向 —— 同时数对端到底收到了多少字节。
//
// 用法：node tools\steam-loopback-bench.cjs [秒数] [每条消息字节数]
const path = require('node:path');

const SECONDS = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 10;
const MSG = Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 4096;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

(async () => {
  const mod = require('steamworks-ffi-node');
  const SDK = mod.default || mod.SteamworksSDK;
  const { ESteamNetworkingConnectionState, k_HSteamNetConnection_Invalid, k_HSteamListenSocket_Invalid } = mod;

  const steam = SDK.getInstance();
  if (typeof steam.setSdkPath === 'function') steam.setSdkPath(path.resolve(__dirname, '..', 'steamworks_sdk'));
  if (typeof steam.setDebug === 'function') steam.setDebug(false);
  if (!steam.init({ appId: 480 })) { log('SteamAPI_Init 失败'); process.exit(1); }

  const sockets = steam.networkingSockets;
  const ownId = String(steam.getStatus?.().steamId || '');
  log(`本机 ${ownId}   观察 ${SECONDS}s   每条 ${MSG} B`);

  const tick = () => { try { steam.runCallbacks(); } catch { /* 忽略 */ } try { sockets.runCallbacks(); } catch { /* 忽略 */ } };
  steam.networkingUtils?.initRelayNetworkAccess?.();
  sockets.initAuthentication?.();
  for (let i = 0; i < 100; i += 1) {
    tick();
    const r = steam.networkingUtils?.getRelayNetworkStatus?.();
    if (r && Number(r.availability) === 100) break;
    await sleep(100);
  }

  const listenSocket = sockets.createListenSocketP2P(0);
  if (listenSocket === k_HSteamListenSocket_Invalid) { log('createListenSocketP2P 失败'); process.exit(1); }
  const pollGroup = sockets.createPollGroup();

  let inbound = null; // 房主侧句柄（对端连进来的那条）
  const off = sockets.onConnectionStateChange((change) => {
    if (change.newState === ESteamNetworkingConnectionState.Connecting) {
      sockets.acceptConnection(change.connection);
      if (pollGroup) sockets.setConnectionPollGroup(change.connection, pollGroup);
      return;
    }
    if (change.newState === ESteamNetworkingConnectionState.Connected && inbound == null) inbound = change.connection;
  });

  const outbound = sockets.connectP2P(ownId, 0);
  if (outbound === k_HSteamNetConnection_Invalid) { log('connectP2P 失败'); process.exit(1); }

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && inbound == null) { tick(); await sleep(20); }
  if (inbound == null) { log('自连没成功'); process.exit(1); }
  log(`自连已建立：出站句柄 ${outbound}，入站句柄 ${inbound}`);

  const payload = Buffer.alloc(MSG, 0x42);
  const started = Date.now();
  let attempted = 0;
  let accepted = 0;
  let failed = 0;
  let received = 0;
  let receiveBatches = 0;
  const timeline = [];
  let lastReport = started;
  let lastAccepted = 0;

  while (Date.now() - started < SECONDS * 1000) {
    tick();

    // A) 发送方向
    attempted += 1;
    let ok = false;
    try {
      const r = typeof sockets.sendMessage === 'function' ? sockets.sendMessage(inbound, payload, 8) : sockets.sendReliable(inbound, payload);
      ok = !(r && r.success === false);
    } catch { ok = false; }
    if (ok) accepted += payload.length; else failed += 1;

    // B) 接收方向（对端那条句柄上收）
    let msgs = null;
    try { msgs = sockets.receiveMessages?.(outbound, 256); } catch { msgs = null; }
    const list = Array.isArray(msgs) ? msgs : (msgs && Array.isArray(msgs.messages) ? msgs.messages : []);
    for (const m of list) {
      const buf = Buffer.isBuffer(m) ? m : (Buffer.isBuffer(m?.data) ? m.data : null);
      if (buf && buf.length) {
        received += buf.length;
        receiveBatches += 1;
        if (timeline.length < 30) timeline.push({ at: Date.now() - started, batch: receiveBatches, got: buf.length, total: received });
      }
    }

    if (Date.now() - lastReport >= 1000) {
      const dt = (Date.now() - lastReport) / 1000;
      lastReport = Date.now();
      const dAcc = accepted - lastAccepted;
      lastAccepted = accepted;
      let rt = null;
      try { rt = sockets.getConnectionRealTimeStatus?.(inbound) || null; } catch { rt = null; }
      log(`[${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s] 发出尝试 ${attempted} 次 收下 ${accepted}B 失败 ${failed} 次 | 本秒 ${dAcc}B (${(dAcc / dt / 1024).toFixed(1)} KiB/s) | 收到 ${received}B / ${receiveBatches} 批 | sentUnacked=${rt?.sentUnackedReliable} pending=${rt?.pendingReliable}`);
    }
    await sleep(2);
  }

  log(`\n=== 汇总 ===`);
  log(`发送方向：尝试 ${attempted} 次，Steam 收下 ${accepted} B，失败 ${failed} 次`);
  log(`接收方向：对端收到 ${received} B，共 ${receiveBatches} 批`);
  if (accepted > 0) log(`发送侧实际速率 ${(accepted / SECONDS / 1024).toFixed(1)} KiB/s`);
  for (const t of timeline.slice(0, 15)) log(`   +${t.at}ms  第 ${t.batch} 批 +${t.got}B  累计 ${t.total}B`);
  try { off?.(); } catch { /* 忽略 */ }
  process.exit(0);
})().catch((err) => { log('基准异常：' + String(err && err.stack ? err.stack : err).slice(0, 900)); process.exit(1); });
