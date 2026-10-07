'use strict';
// 只读探针 3：用**普通 Node 进程**（不是 Electron）复刻一次「加入者」的动作，
// 直连房主 SteamID，发一个真的 HTTP 请求，把每一段的耗时打出来。
//
// 为什么需要它：steam-link-probe 已经证明这条 P2P 线路本身是
//   ping 23ms / 可用带宽 256KB/s / 丢包 0% / popIdRelay=0（直连，没走中继），
// 可我们自己的隧道跑同一个操作要 3.1 秒、每条连接只有 ~1KB/s。
// 那 3 秒只可能来自「房主的转发代码」或者「加入者的转发代码」。
// 这个探针把「加入者」换成一段我们完全看得见的普通 Node 代码：
//   * 如果这里也是 3.1 秒 -> 瓶颈在房主（对端）那半边；
//   * 如果这里是几十毫秒   -> 瓶颈在我们自己应用的加入者那半边。
//
// 用法：node tools\steam-mini-joiner.cjs [房主SteamID] [路径]
const path = require('node:path');

const HOST_ID = process.argv[2] || '76561198823179715';
const PATHNAME = process.argv[3] || '/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const stamp = () => String(Date.now() - t0).padStart(6) + 'ms';
const log = (...a) => console.log(stamp(), ...a);

(async () => {
  const mod = require('steamworks-ffi-node');
  const SDK = mod.default || mod.SteamworksSDK;
  const { ESteamNetworkingConnectionState, k_HSteamNetConnection_Invalid } = mod;

  const steam = SDK.getInstance();
  if (typeof steam.setSdkPath === 'function') steam.setSdkPath(path.resolve(__dirname, '..', 'steamworks_sdk'));
  if (typeof steam.setDebug === 'function') steam.setDebug(false);
  if (!steam.init({ appId: 480 })) { log('SteamAPI_Init 失败'); process.exit(1); }

  const sockets = steam.networkingSockets;
  steam.networkingUtils?.initRelayNetworkAccess?.();
  sockets.initAuthentication?.();

  const tick = () => {
    try { steam.runCallbacks(); } catch { /* 回调抛错不影响主循环 */ }
    try { sockets.runCallbacks(); } catch { /* 同上 */ }
  };

  for (let i = 0; i < 100; i += 1) {
    tick();
    const r = steam.networkingUtils?.getRelayNetworkStatus?.();
    if (r && Number(r.availability) === 100) break;
    await sleep(100);
  }
  log('中继网络就绪');

  const off = sockets.onConnectionStateChange((change) => {
    log(`状态变化 ${change.oldState}->${change.newState} ${change.info?.stateName || ''}`);
    if (change.newState === ESteamNetworkingConnectionState.Connecting) sockets.acceptConnection?.(change.connection);
  });

  const handle = sockets.connectP2P(String(HOST_ID), 0);
  if (handle === k_HSteamNetConnection_Invalid) { log('connectP2P 失败'); process.exit(1); }
  log(`connectP2P 句柄 ${handle}`);

  let connected = false;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !connected) {
    tick();
    try { connected = sockets.getConnectionInfo?.(handle)?.stateName === 'Connected'; } catch { /* 还没就绪 */ }
    await sleep(20);
  }
  if (!connected) { log('没连上，退出'); process.exit(1); }
  log('已连接，开始计时');

  const req = `GET ${PATHNAME} HTTP/1.1\r\nHost: 127.0.0.1:3000\r\nUser-Agent: shl-mini-joiner\r\nAccept: */*\r\nConnection: close\r\n\r\n`;
  const sendT = Date.now();
  let sendOk = false;
  try {
    const r = typeof sockets.sendMessage === 'function'
      ? sockets.sendMessage(handle, Buffer.from(req), 8)
      : sockets.sendReliable(handle, Buffer.from(req));
    sendOk = !(r && r.success === false);
  } catch (err) { log('发送失败 ' + err.message); }
  log(`发出 ${req.length} 字节的 HTTP 请求，sendMessage 返回 ${sendOk ? '成功' : '失败'}（发送本身耗时 ${Date.now() - sendT}ms）`);

  // 之后就是纯粹地收：每 2ms 轮一次，谁先到就记谁
  let received = 0;
  let firstAt = null;
  let headerAt = null;
  let doneAt = null;
  const arrivals = [];
  const hardStop = Date.now() + 30000;

  while (Date.now() < hardStop && doneAt == null) {
    tick();
    let msgs = null;
    try { msgs = sockets.receiveMessages?.(handle, 128); } catch (err) { log('receiveMessages 抛错 ' + err.message); break; }
    const list = Array.isArray(msgs) ? msgs : (msgs && Array.isArray(msgs.messages) ? msgs.messages : []);
    for (const m of list) {
      const buf = Buffer.isBuffer(m) ? m : (Buffer.isBuffer(m?.data) ? m.data : null);
      if (!buf || !buf.length) continue;
      if (firstAt == null) { firstAt = Date.now(); log(`首字节到达（距发出请求 ${firstAt - sendT}ms）`); }
      received += buf.length;
      arrivals.push({ at: Date.now() - sendT, bytes: received, head: buf.subarray(0, 24).toString('latin1').replace(/\r?\n/g, '\\n') });
      if (headerAt == null && buf.includes(Buffer.from('\r\n\r\n'))) headerAt = Date.now();
      if (/\r\n\r\n/.test(buf.toString('latin1'))) headerAt = headerAt || Date.now();
    }
    if (received > 0 && msgs !== null) {
      // 每收到一批就打一行，方便看出是不是"每次只来 4096"
      const last = arrivals[arrivals.length - 1];
      if (arrivals.length <= 40) log(`  第 ${arrivals.length} 批：累计 ${last.bytes} B（+${last.at}ms） ${JSON.stringify(last.head)}`);
    }
    if (connected) {
      try {
        const info = sockets.getConnectionInfo?.(handle);
        if (info && info.stateName && info.stateName !== 'Connected') { doneAt = Date.now(); log(`连接状态变为 ${info.stateName}，结束原因 "${info.endDebugMessage || ''}"`); }
      } catch { /* ignore */ }
    }
    await sleep(2);
  }

  log(`\n=== 汇总 ===`);
  log(`首字节 ${firstAt == null ? '未到达' : (firstAt - sendT) + 'ms'} / 响应头 ${headerAt == null ? '未到达' : (headerAt - sendT) + 'ms'} / 结束 ${doneAt == null ? '未结束' : (doneAt - sendT) + 'ms'}`);
  log(`共收到 ${received} 字节，分 ${arrivals.length} 批`);
  for (const a of arrivals.slice(0, 20)) log(`   +${a.at}ms  累计 ${a.bytes}B`);
  try { off?.(); } catch { /* ignore */ }
  try { sockets.closeConnection?.(handle, 0, 'probe done', false); } catch { /* ignore */ }
  process.exit(0);
})().catch((err) => { log('探针异常：' + String(err && err.stack ? err.stack : err).slice(0, 900)); process.exit(1); });
