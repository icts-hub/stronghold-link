'use strict';
// 只读探针 2：绕开我们自己的隧道代码，直接问 Steam —— 「这条 P2P 线路的真实 RTT 到底是多少」。
//
// 为什么需要它：现场每条 Steam 连接的吞吐都恰好是「4096 字节 / ~3.1 秒」，
// 而 4096 = steam-framing.cjs 的 DEFAULT_MAX_CHUNK。这个数字的形状既可能是
// 「链路 RTT 真的有 3 秒」，也可能是「我们自己某个定时器在限速」。
// 从应用外部量不出来，必须让 Steam 自己报数。
//
// 三个阶段，前两个阶段完全不发业务数据：
//   1) 本机到 Steam 骨干网各 POP 的 ping（networkingUtils.getPingToDataCenter）
//   2) 直连对端 SteamID 的 P2P 端口 0，读 getConnectionRealTimeStatus / getDetailedConnectionStatus
//   3) 可选：往这条探针连接上灌数据，量 Steam 发送缓冲到底肯收多快
//
// 用法：node tools\steam-link-probe.cjs [对端SteamID] [观察秒数] [--send]
const path = require('node:path');

const HOST_ID = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '76561198823179715';
// 注意：秒数只能取 argv[3]。对端 SteamID 本身也是纯数字，用 find() 会把它当成秒数。
const SECONDS = Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 20;
const DO_SEND = process.argv.includes('--send');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

(async () => {
  const mod = require('steamworks-ffi-node');
  const SDK = mod.default || mod.SteamworksSDK;
  const { ESteamNetworkingConnectionState, k_HSteamNetConnection_Invalid } = mod;
  const { createSendPlan } = require('../network/steam-framing.cjs');

  const steam = SDK.getInstance();
  if (typeof steam.setSdkPath === 'function') steam.setSdkPath(path.resolve(__dirname, '..', 'steamworks_sdk'));
  if (typeof steam.setDebug === 'function') steam.setDebug(false);
  if (!steam.init({ appId: 480 })) { log('SteamAPI_Init 失败'); process.exit(1); }

  const sockets = steam.networkingSockets;
  const utils = steam.networkingUtils;
  const ownId = String(steam.getStatus?.().steamId || '');
  log(`本机 ${ownId}   对端 ${HOST_ID}   观察 ${SECONDS}s   灌数据=${DO_SEND}`);

  const tick = () => { try { steam.runCallbacks(); } catch { /* 回调抛错不影响主循环 */ } try { sockets.runCallbacks(); } catch { /* 同上 */ } };

  utils?.initRelayNetworkAccess?.();
  sockets.initAuthentication?.();

  let relay = null;
  for (let i = 0; i < 150; i += 1) {
    tick();
    relay = utils?.getRelayNetworkStatus?.() || null;
    if (relay && Number(relay.availability) === 100) break;
    await sleep(100);
  }
  log(`Steam 中继网络：${relay ? relay.availabilityName + '(' + relay.availability + ')' : '拿不到'}`);

  // ---- 阶段 1：本机到各 POP 的 ping ----
  const utilApi = new Set();
  for (let o = utils; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const n of Object.getOwnPropertyNames(o)) if (typeof utils[n] === 'function') utilApi.add(n);
  }
  log('networkingUtils 方法：' + [...utilApi].sort().join(', '));
  try {
    const pops = utils.getPOPList?.() || [];
    log(`POP 数量 ${pops.length}`);
    const sample = pops.slice(0, 6);
    for (const pop of sample) {
      let p;
      try { p = utils.getPingToDataCenter?.(pop.popId ?? pop); } catch (err) { p = 'ERR ' + err.message; }
      log(`  POP ${JSON.stringify(pop)} -> ping ${JSON.stringify(p, (_k, v) => (typeof v === 'bigint' ? String(v) : v))}`);
    }
  } catch (err) {
    log('取 POP ping 失败：' + err.message);
  }

  // ---- 阶段 2：直连对端 ----
  const handle = sockets.connectP2P(String(HOST_ID), 0);
  if (handle === k_HSteamNetConnection_Invalid) { log('connectP2P 失败'); process.exit(1); }
  log(`connectP2P 句柄 ${handle}`);

  const seen = [];
  const off = sockets.onConnectionStateChange((change) => {
    seen.push(`${change.oldState}->${change.newState}`);
    if (change.newState === ESteamNetworkingConnectionState.Connecting) sockets.acceptConnection?.(change.connection);
  });

  const deadline = Date.now() + 25000;
  let state = null;
  while (Date.now() < deadline) {
    tick();
    try { state = sockets.getConnectionInfo?.(handle)?.stateName || null; } catch { /* 句柄还没就绪 */ }
    if (state === 'Connected') break;
    await sleep(50);
  }
  log(`连接状态 ${state || '未连上'}   状态变化 ${seen.join(',')}`);
  if (state !== 'Connected') {
    try { off?.(); } catch { /* ignore */ }
    process.exit(1);
  }

  // ---- 阶段 3：观察 + 可选灌数据 ----
  const started = Date.now();
  let accepted = 0;
  let failed = 0;
  let lastAccepted = 0;
  let lastAt = started;
  let payload = null;

  while (Date.now() - started < SECONDS * 1000) {
    tick();

    if (DO_SEND && !payload) {
      payload = Buffer.alloc(4096, 0x41);
    }
    if (DO_SEND) {
      const plan = createSendPlan(payload, { channel: 'reliable' });
      let ok = false;
      try {
        const r = typeof sockets.sendMessage === 'function'
          ? sockets.sendMessage(handle, plan.chunks[0], plan.flags)
          : sockets.sendReliable(handle, plan.chunks[0]);
        ok = !(r && r.success === false);
      } catch { ok = false; }
      if (ok) { accepted += plan.chunks[0].length; } else { failed += 1; }
    }

    if (Date.now() - lastAt >= 1000) {
      const now = Date.now();
      const dt = (now - lastAt) / 1000;
      const dBytes = accepted - lastAccepted;
      lastAt = now;
      lastAccepted = accepted;
      let rt = null;
      let info = null;
      let detail = null;
      try { rt = sockets.getConnectionRealTimeStatus?.(handle) || null; } catch (err) { rt = { err: err.message }; }
      try { info = sockets.getConnectionInfo?.(handle) || null; } catch (err) { info = { err: err.message }; }
      try { detail = sockets.getDetailedConnectionStatus?.(handle) || null; } catch (err) { detail = 'ERR ' + err.message; }
      const t = ((now - started) / 1000).toFixed(0).padStart(3);
      log(`[${t}s] ping=${rt?.ping} sentUnacked=${rt?.sentUnackedReliable} pendingReliable=${rt?.pendingReliable} out=${rt?.outBytesPerSec}B/s in=${rt?.inBytesPerSec}B/s sendRate=${rt?.sendRateBytesPerSecond} | 本轮收下 ${dBytes}B (${(dBytes / dt / 1024).toFixed(2)} KiB/s) 失败 ${failed}`);
      if (info) log(`      info: popIdRelay=${info.popIdRelay} popIdRemote=${info.popIdRemote} state=${info.stateName} remoteAddr="${info.remoteAddress}" end="${info.endDebugMessage || ''}"`);
      if (detail && typeof detail === 'string') log('      detail: ' + detail.split('\n').map((s) => s.trim()).filter(Boolean).join(' | '));
    }
    await sleep(4);
  }

  log(`\n=== 收尾 ===\n灌数据 ${DO_SEND ? '开' : '关'}；共收下 ${accepted} B，失败 ${failed} 次`);
  if (DO_SEND && accepted > 0) log(`平均 ${(accepted / SECONDS / 1024).toFixed(2)} KiB/s`);
  try { off?.(); } catch { /* ignore */ }
  try { sockets.closeConnection?.(handle, 0, 'probe done', false); } catch { /* ignore */ }
  process.exit(0);
})().catch((err) => { log('探针异常：' + String(err && err.stack ? err.stack : err).slice(0, 900)); process.exit(1); });
