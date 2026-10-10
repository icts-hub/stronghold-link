'use strict';
// 延迟专项（Phase 1 诊断 / Phase 3 对照）的真机测量探针。
//
// 干什么：在**同一台机器**上同时起房主与加入者（自己连自己，走真实 Steam P2P + SDR），
//   本地客户端按固定间隔发载荷、服务端原样回声，从而量出**应用层往返延迟**；
//   与此同时适配器自己的每秒延迟诊断会把 Steam 实时读数（RTT / 排队 / 可靠待发）写进
//   `net-latency-<role>-<时间戳>.jsonl`。两者合起来才能把用户要求的
//   "网络 RTT / MUX 排队 / 本地服务处理"三段时间分开看。
//
// 只读原则：除了数据面本身，本探针不改任何收发参数（chunk size、队列上限、调度刻度都不碰）。
//   它只是把现有实现跑起来并记录下来。要对比参数，用命令行开关换场景标签，别改这里。
//
// 用法：
//   node tools/steam-latency-probe.cjs --label idle --duration 20000
//   node tools/steam-latency-probe.cjs --label load20 --connections 20 --interval 250
//   node tools/steam-latency-probe.cjs --label burst --burst-every 5000 --burst-count 40
//   node tools/steam-latency-probe.cjs --label bulk-fair --bulk-connections 4 --bulk-payload 262144 --bulk-interval 20
// 真机 A/B 对照（Phase 3）就是翻适配器那边的环境变量，探针本身不改：
//   $env:SHL_STEAM_FAIR_QUEUE='0'  ⇒ 0.14.2 老行为（所有帧一条队列，先到先发）
//   $env:SHL_STEAM_FAIR_QUEUE='1'  ⇒ Phase 2 公平调度（按流分开、流间轮转）
// 需要 Steam 处于登录状态（appId 480 = Spacewar）。跑的时候 shell 里若有
//   ELECTRON_RUN_AS_NODE=1 要清掉（对纯 node 无影响，但别在 Electron 里跑）。
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { initSteamSdk, createSteamHost, createSteamJoiner } = require('../network/steam-adapter.cjs');

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const eq = argv.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const LABEL = argOf('--label', 'idle');
const DURATION_MS = Number(argOf('--duration', '20000'));
const CONNECTIONS = Math.max(1, Number(argOf('--connections', '1')));
const INTERVAL_MS = Math.max(20, Number(argOf('--interval', '500')));
const PAYLOAD_BYTES = Math.max(16, Number(argOf('--payload', '64')));
const BURST_EVERY_MS = Number(argOf('--burst-every', '0'));
const BURST_COUNT = Number(argOf('--burst-count', '0'));
// 并发大流量（Phase 2/3 的对照场景）：几条只灌不收的连接，按固定间隔往同一个入口端口
// 写大块载荷 —— 这就是"地图一动，人就飘"里的地图加载。回声服务会把它们原样送回来，
// 所以两个方向都被占满；探针只统计灌了多少字节，不解析回声。
const BULK_CONNECTIONS = Math.max(0, Number(argOf('--bulk-connections', '0')));
const BULK_PAYLOAD_BYTES = Math.max(1024, Number(argOf('--bulk-payload', String(256 * 1024))));
const BULK_INTERVAL_MS = Math.max(1, Number(argOf('--bulk-interval', '20')));
const LOG_DIR = argOf('--log-dir', path.join(__dirname, '..', '..', 'release', 'latency-logs'));
const QUIET = argv.includes('--quiet');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const stamp = () => {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};
const stats = (list) => {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    minMs: Number(sorted[0].toFixed(2)),
    p50Ms: Number(pick(0.5).toFixed(2)),
    p95Ms: Number(pick(0.95).toFixed(2)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(2)),
    meanMs: Number((sum / sorted.length).toFixed(2)),
  };
};

const log = (text) => { if (!QUIET) console.log('[lat] ' + text); };

(async () => {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const startedAt = Date.now();
  const { steam } = initSteamSdk({ appDir: path.join(__dirname, '..'), appId: 480 });

  // 房主的"游戏端口"：一个回声服务。真正的游戏在这里做同样的事。
  const echo = net.createServer((socket) => {
    socket.on('error', () => { /* 客户端断开属正常 */ });
    socket.on('data', (chunk) => { socket.write(chunk); });
  });
  const echoPort = await new Promise((res) => echo.listen(0, '127.0.0.1', () => res(echo.address().port)));

  const host = createSteamHost({
    appDir: path.join(__dirname, '..'),
    appId: 480,
    gamePort: echoPort,
    logDir: LOG_DIR,
    onEvent: (type, payload) => { if (!QUIET && type !== 'peer-stats' && type !== 'net-latency') log(`host 事件 ${type} ${JSON.stringify(payload || {})}`); },
  });
  const hostInfo = await host.ready;
  log(`房主就绪 steamId=${hostInfo.steamId} 回声端口=${echoPort}`);

  const entryPort = await new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
  const joiner = createSteamJoiner({
    appDir: path.join(__dirname, '..'),
    appId: 480,
    localPort: entryPort,
    hostSteamId: hostInfo.steamId,
    logDir: LOG_DIR,
    onEvent: (type, payload) => { if (!QUIET && type !== 'peer-stats' && type !== 'net-latency' && type !== 'net-status') log(`joiner 事件 ${type} ${JSON.stringify(payload || {})}`); },
  });
  await joiner.ready;
  log(`加入者就绪 入口端口=${entryPort}`);

  // 应用层往返测量：每条连接按序号发一个定长载荷，收到同样序号的原样回声算一次 RTT。
  const samples = [];
  const pending = new Map();
  let seq = 0;
  const clients = [];
  const sendOne = (client) => {
    if (!client.writable || client.destroyed) return;
    seq += 1;
    const head = Buffer.from(`#${seq}|`);
    const body = Buffer.alloc(Math.max(0, PAYLOAD_BYTES - head.length), 0x2e);
    const frame = Buffer.concat([head, body]);
    pending.set(seq, Date.now());
    client.write(frame);
  };
  for (let i = 0; i < CONNECTIONS; i += 1) {
    const client = net.createConnection({ host: '127.0.0.1', port: entryPort });
    client.on('error', () => { /* 由 close 统一处理 */ });
    client.on('data', (chunk) => {
      // 一次可能收到多帧回声，逐帧解析 `#序号|`。
      let text = chunk.toString('latin1');
      let idx = text.indexOf('#');
      while (idx >= 0) {
        const end = text.indexOf('|', idx);
        if (end < 0) break;
        const id = Number(text.slice(idx + 1, end));
        const at = pending.get(id);
        if (at) {
          pending.delete(id);
          samples.push({ id, ms: Date.now() - at, at: Date.now() });
        }
        idx = text.indexOf('#', end + 1);
      }
    });
    clients.push(client);
    await new Promise((r) => client.once('connect', r));
  }
  log(`${CONNECTIONS} 条本地连接已建立，开始测量：时延间隔 ${INTERVAL_MS}ms，时长 ${DURATION_MS}ms`);

  // 并发大流量连接（可选）。测量小包的连接与它们跑在**同一条干道**上，正因为如此，
  // 出站队列怎么调度直接决定小包要排在多少字节之后。
  const bulkClients = [];
  let bulkBytesSent = 0;
  let bulkStalls = 0;
  if (BULK_CONNECTIONS > 0) {
    const bulkBuffer = Buffer.alloc(BULK_PAYLOAD_BYTES, 0x2e);
    const bulkPump = (client) => {
      if (!client.writable || client.destroyed) return;
      const ok = client.write(bulkBuffer);
      bulkBytesSent += bulkBuffer.length;
      if (ok) { client.__bulkTimer = setTimeout(() => bulkPump(client), BULK_INTERVAL_MS); } else {
        bulkStalls += 1;
        client.once('drain', () => bulkPump(client));
      }
    };
    for (let i = 0; i < BULK_CONNECTIONS; i += 1) {
      const client = net.createConnection({ host: '127.0.0.1', port: entryPort });
      client.on('error', () => { /* 由 close 统一处理 */ });
      client.on('data', () => { /* 回声原样回来，丢掉：这里只制造负载 */ });
      bulkClients.push(client);
      await new Promise((r) => client.once('connect', r));
      bulkPump(client);
    }
    log(`并发大流量：${BULK_CONNECTIONS} 条连接，每 ${BULK_INTERVAL_MS}ms 灌 ${BULK_PAYLOAD_BYTES} 字节`);
  }

  const tick = setInterval(() => { for (const client of clients) sendOne(client); }, INTERVAL_MS);
  let burstTimer = null;
  if (BURST_EVERY_MS > 0 && BURST_COUNT > 0) {
    burstTimer = setInterval(() => {
      log(`突发：一次塞 ${BURST_COUNT} 帧（模拟连续加载区块）`);
      for (let i = 0; i < BURST_COUNT; i += 1) sendOne(clients[i % clients.length]);
    }, BURST_EVERY_MS);
  }
  await wait(DURATION_MS);
  clearInterval(tick);
  if (burstTimer) clearInterval(burstTimer);
  for (const client of bulkClients) { if (client.__bulkTimer) clearTimeout(client.__bulkTimer); }
  await wait(1500); // 收尾：把最后几帧的回声等回来

  const hostSnap = typeof host.latency === 'function' ? host.latency() : null;
  const joinerSnap = typeof joiner.latency === 'function' ? joiner.latency() : null;
  const result = {
    label: LABEL,
    at: new Date().toISOString(),
    params: { durationMs: DURATION_MS, connections: CONNECTIONS, intervalMs: INTERVAL_MS, payloadBytes: PAYLOAD_BYTES, burstEveryMs: BURST_EVERY_MS, burstCount: BURST_COUNT, bulkConnections: BULK_CONNECTIONS, bulkPayloadBytes: BULK_PAYLOAD_BYTES, bulkIntervalMs: BULK_INTERVAL_MS },
    tuning: { fairQueue: process.env.SHL_STEAM_FAIR_QUEUE || null, fairQuantum: process.env.SHL_STEAM_FAIR_QUANTUM || null, maxChunk: process.env.SHL_STEAM_MAX_CHUNK || null, callbackMs: process.env.SHL_STEAM_CALLBACK_MS || null },
    bulk: { connections: BULK_CONNECTIONS, bytesSent: bulkBytesSent, stalls: bulkStalls, bytesPerSec: BULK_CONNECTIONS ? Math.round(bulkBytesSent / (DURATION_MS / 1000)) : 0 },
    appRtt: stats(samples.map((s) => s.ms)),
    sent: seq,
    echoed: samples.length,
    host: hostSnap,
    joiner: joinerSnap,
    hostStats: host.stats,
    joinerStats: joiner.stats,
  };
  const outFile = path.join(LOG_DIR, `latency-${LABEL}-${stamp()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');

  log(`应用层往返：${JSON.stringify(result.appRtt)}`);
  log(`诊断帧（房主）：${JSON.stringify(hostSnap && { role: hostSnap.role, seq: hostSnap.seq, steamRttMs: hostSnap.steamRttMs, globalQueueBytes: hostSnap.globalQueueBytes, eventLoop: hostSnap.eventLoop && hostSnap.eventLoop.p99Ms, poll: hostSnap.poll && hostSnap.poll.avgMs })}`);
  log(`线：${hostSnap && hostSnap.line}`);
  log(`结果写入 ${outFile}`);

  for (const client of clients) { try { client.destroy(); } catch { /* ignore */ } }
  for (const client of bulkClients) { try { client.destroy(); } catch { /* ignore */ } }
  await joiner.stop();
  await host.stop();
  await new Promise((r) => echo.close(() => r()));
  log(`总耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  process.exit(0);
})().catch((err) => {
  console.error('[lat] 失败 ' + String(err && err.stack ? err.stack : err));
  process.exit(1);
});
