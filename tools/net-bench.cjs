'use strict';
// ============================================================================
// Stronghold Link — 三链路吞吐实测
//
// 只报实测数字。测不到就写明原因，不填估算值，不写"理论上"。
//
//   raw-loopback      本机 TCP 回环，操作系统栈的上限基线
//   stronghold-relay  本工具自己的本地中继（房主 + 加入者 + 可选 AES-256-GCM）
//   steam-sdr         Steam Networking Sockets；本机单账号无法自连，
//                     没有 --steam-peer 时如实报 NOT MEASURED
//
// 用法：
//   node tools/net-bench.cjs
//   node tools/net-bench.cjs --size=16 --json=bench.json
//   node tools/net-bench.cjs --steam-peer=7656119xxxxxxxxxx --steam-app=480
//
// 每轮再打一份分片开销账：同样的字节数在 4KB 分片下要发多少条 Steam 消息。
// ============================================================================

const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTcpHost, createTcpJoiner } = require('../network/tcp-relay.cjs');
const { createSendPlan, DEFAULT_MAX_CHUNK } = require('../network/steam-framing.cjs');

const DEFAULT_SIZE_MB = 8;
const WRITE_CHUNK = 256 * 1024;

function parseArgs(argv) {
  const out = { sizeMB: DEFAULT_SIZE_MB, json: null, steamPeer: null, steamApp: 480, token: '' };
  for (const arg of argv) {
    if (arg.startsWith('--size=')) out.sizeMB = Math.max(1, Number(arg.slice(7)) || DEFAULT_SIZE_MB);
    else if (arg.startsWith('--json=')) out.json = arg.slice(7);
    else if (arg.startsWith('--steam-peer=')) out.steamPeer = arg.slice(13).trim() || null;
    else if (arg.startsWith('--steam-app=')) out.steamApp = Number(arg.slice(12)) || 480;
    else if (arg.startsWith('--token=')) out.token = arg.slice(8);
  }
  return out;
}

function listen(server, port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    try { server.close(() => resolve()); } catch (err) { resolve(); }
  });
}

/** 收字节的黑洞。记收到多少字节，收到目标量就 resolve。 */
function createSink() {
  let received = 0;
  let done = null;
  let target = Infinity;
  const waiters = [];
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      received += chunk.length;
      if (received >= target && done) { const d = done; done = null; d(); }
      while (waiters.length) waiters.shift()(received);
    });
    socket.on('error', () => { /* 对端断开是正常收尾 */ });
  });
  return {
    server,
    get received() { return received; },
    reset() { received = 0; },
    waitFor(bytes, timeoutMs) {
      target = bytes;
      if (received >= bytes) return Promise.resolve(received);
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(received), timeoutMs);
        done = () => { clearTimeout(timer); resolve(received); };
      });
    },
  };
}

/** 把 size 字节灌进一条已经连上的 socket，等对端真的收齐。 */
function push(socket, sink, bytes, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.alloc(WRITE_CHUNK, 0x5a);
    let sent = 0;
    sink.reset();
    const started = process.hrtime.bigint();
    const finish = sink.waitFor(bytes, timeoutMs).then((received) => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      resolve({ bytes: received, seconds, mbPerSec: received / seconds / (1024 * 1024) });
    });
    const pump = () => {
      while (sent < bytes) {
        const size = Math.min(WRITE_CHUNK, bytes - sent);
        sent += size;
        if (!socket.write(size === payload.length ? payload : payload.subarray(0, size))) break;
      }
      if (sent >= bytes) return;
      socket.once('drain', pump);
    };
    socket.once('error', reject);
    pump();
    finish.catch(reject);
  });
}

function connect(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

/** 分片开销账：同样字节数在不同分片下的 Steam 消息条数。 */
function framingCost(bytes) {
  // 说明为什么默认值是 4KB 而不是更大：每加一个分片尺寸，都是"少几条消息"换"丢一段要多等一轮重传"。
  // 4KB ≈ 路径 MTU 的 3 段，64KB ≈ 55 段；Steam 可靠通道有序，一条消息里丢任何一段都要等它重传完
  // 才轮到后面的消息（队头阻塞）。chunyu-vpn/net/multiplex_manager.cpp:9-11 实测项目选的是 1100 字节
  // 贴近路径 MTU。所以默认守在 4KB，想试大分片用 SHL_STEAM_MAX_CHUNK 覆盖。DEFAULT_MAX_CHUNK 就是 4KB，
  // 去重后 4KB 只出现一次，另留 1KB / 16KB / 64KB / 512KB 做对照。
  const sizes = [...new Set([1024, DEFAULT_MAX_CHUNK, 16 * 1024, 64 * 1024, 512 * 1024])].sort((a, b) => a - b);
  return sizes.map((size) => {
    const plan = createSendPlan(Buffer.alloc(bytes), { maxChunk: size });
    return {
      chunkSize: size,
      isDefault: size === DEFAULT_MAX_CHUNK,
      messages: plan.chunkCount,
      bytesPerMessage: Math.round(bytes / plan.chunkCount),
      flags: plan.flags,
    };
  });
}

async function benchRawLoopback(bytes) {
  const sink = createSink();
  const port = await listen(sink.server, 0);
  try {
    const socket = await connect(port);
    socket.setNoDelay(true);
    const result = await push(socket, sink, bytes);
    socket.destroy();
    return { measured: true, link: 'raw-loopback', ...result, note: '本机 TCP 回环，不含任何隧道代码' };
  } finally {
    await closeServer(sink.server);
  }
}

async function benchStrongholdRelay(bytes, token) {
  const sink = createSink();
  const gamePort = await listen(sink.server, 0);
  let host = null;
  let joiner = null;
  try {
    const relayPort = await freePort();
    const entryPort = await freePort();
    host = createTcpHost({ relayPort, targetHost: '127.0.0.1', targetPort: gamePort, authToken: token });
    await host.ready;
    joiner = createTcpJoiner({ localPort: entryPort, host: '127.0.0.1', relayPort, authToken: token });
    await joiner.ready;
    const socket = await connect(entryPort);
    socket.setNoDelay(true);
    const result = await push(socket, sink, bytes);
    socket.destroy();
    const stats = {
      hostBytesFromPeer: host.stats.bytesFromPeer,
      hostBytesToPeer: host.stats.bytesToPeer,
    };
    return {
      measured: true,
      link: 'stronghold-relay',
      ...result,
      encrypted: Boolean(token),
      note: token ? '本地中继 + AES-256-GCM' : '本地中继，未设口令所以不加密',
      stats,
    };
  } finally {
    if (joiner) { try { await joiner.stop(); } catch (err) { /* 清理失败不影响结论 */ } }
    if (host) { try { await host.stop(); } catch (err) { /* 同上 */ } }
    await closeServer(sink.server);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Steam SDR。需要两台机器两个 Steam 账号：Steam 不允许同一账号连自己。
 * 本机单账号时这里必然拿不到数字，如实返回原因。
 */
function benchSteamSdr({ steamPeer, steamApp, sizeMB }) {
  if (!steamPeer) {
    return {
      measured: false,
      link: 'steam-sdr',
      reason: 'NOT MEASURED：需要另一台机器上的第二个 Steam 账号。Steam P2P 不允许同一账号自连。',
      howTo: `在另一台机器上开同样版本的程序建房，然后运行 node tools/net-bench.cjs --steam-peer=<对方SteamID> --steam-app=${steamApp} --size=${sizeMB}`,
    };
  }
  return {
    measured: false,
    link: 'steam-sdr',
    reason: 'NOT IMPLEMENTED：跨机 Steam SDR 测速需要两端同时运行，本工具还没有对端侧的执行器。',
    howTo: '先用程序本身跑一局，在会话页读 CURRENT ROUTE 与 STEAM RX 对照本工具的 stronghold-relay 数字。',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bytes = Math.round(args.sizeMB * 1024 * 1024);
  const started = Date.now();

  console.log(`[net-bench] 每次传输 ${args.sizeMB} MB，本机 ${os.platform()} ${os.arch()}，${os.cpus().length} 核`);
  console.log('[net-bench] 只报实测值；测不到的链路写 NOT MEASURED 与原因。');

  const results = [];
  for (const round of [1, 2]) {
    const raw = await benchRawLoopback(bytes);
    results.push({ round, ...raw });
    console.log(`  第 ${round} 轮 raw-loopback      ${raw.mbPerSec.toFixed(1)} MB/s  ${raw.seconds.toFixed(2)}s  ${raw.bytes} 字节`);
  }
  const relay = await benchStrongholdRelay(bytes, args.token);
  results.push({ round: 1, ...relay });
  console.log(`  第 1 轮 stronghold-relay  ${relay.mbPerSec.toFixed(1)} MB/s  ${relay.seconds.toFixed(2)}s  加密=${relay.encrypted}`);

  const steam = benchSteamSdr({ steamPeer: args.steamPeer, steamApp: args.steamApp, sizeMB: args.sizeMB });
  results.push(steam);
  console.log(`  steam-sdr               ${steam.measured ? '' : 'NOT MEASURED'}  ${steam.reason}`);

  const bestRaw = Math.max(...results.filter((r) => r.link === 'raw-loopback').map((r) => r.mbPerSec));
  const summary = {
    generatedAt: new Date().toISOString(),
    host: `${os.platform()} ${os.arch()} ${os.cpus().length}core`,
    sizeMB: args.sizeMB,
    elapsedMs: Date.now() - started,
    rawLoopbackMBps: Number(bestRaw.toFixed(2)),
    strongholdRelayMBps: Number(relay.mbPerSec.toFixed(2)),
    steamSdrMBps: null,
    steamSdrNote: steam.reason,
    relayOverheadPercent: Number((((bestRaw - relay.mbPerSec) / bestRaw) * 100).toFixed(1)),
    framing: framingCost(bytes),
    results,
  };

  console.log('');
  console.log('  ── 实测汇总 ──');
  console.log(`  RAW TCP LOOPBACK   = ${summary.rawLoopbackMBps} MB/s`);
  console.log(`  STRONGHOLD RELAY   = ${summary.strongholdRelayMBps} MB/s  （相对回环损失 ${summary.relayOverheadPercent}%）`);
  console.log('  STEAM SDR          = NOT MEASURED  需要两台机器两个 Steam 账号');
  console.log('  MINECRAFT          = 由游戏自己决定，本工具不产生该数字');
  console.log('');
  console.log('  ── 分片开销（同样字节数的 Steam 消息条数）──');
  for (const row of summary.framing) {
    console.log(`  chunk=${String(row.chunkSize).padStart(6)}B  ${String(row.messages).padStart(6)} 条  ${row.bytesPerMessage} 字节/条`);
  }

  if (args.json) {
    fs.writeFileSync(path.resolve(args.json), JSON.stringify(summary, null, 2), 'utf8');
    console.log(`\n[net-bench] 已写入 ${path.resolve(args.json)}`);
  }
  return summary;
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error('[net-bench] 失败：' + (err && err.stack ? err.stack : err));
    process.exit(1);
  });
}

module.exports = { parseArgs, framingCost, benchRawLoopback, benchStrongholdRelay, benchSteamSdr, main };
