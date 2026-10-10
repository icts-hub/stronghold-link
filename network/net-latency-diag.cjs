'use strict';
// ============================================================================
// Stronghold Link — 活链路每秒延迟诊断（0.14.3 / 延迟专项 Phase 1）
//
// 为什么单独一个模块：现有 `network/network-health.cjs` 是 **5 秒一次、30 秒才落一行**
// 的粗粒度健康快照，它回答的是"隧道通不通、流开了几条"；现场遇到的却是"能玩、但操作
// 就是慢半拍"，这种问题只有**每秒**的样本才看得出形状（排队是持续的还是偶发的、
// 事件循环有没有卡、丢包是不是和帧率同步）。
//
// 三条纪律（照抄 `network/steam-netdiag.cjs` 的做派）：
//   1. **只读**。这里不 send、不 close、不改任何水位，唯一的副作用是写自己的样本文件。
//   2. **测不到就报 null + 原因**，绝不用估算值填坑 —— 界面上的"—"比一个编出来的数诚实。
//      `unavailable[]` 会逐个点名"哪个字段为什么没有"。
//   3. **不往 startup.log 里灌**。startup.log 有 256 KiB 上限（`electron/main.cjs:106`
//      `LOG_LIMIT = 256 * 1024`），每秒一行会在几分钟内把现场证据挤出去。样本写自己的
//      JSONL 文件（由调用方给 logDir），startup.log 只收一条 30 秒的摘要。
//
// 字段来源（都在本机真实存在，见 `tools/steam-api-surface-probe.cjs` 的实测）：
//   * Steam 实际 RTT / pendingReliable / sentUnackedReliable / usecQueueTime
//     ← `networkingSockets.getConnectionRealTimeStatus(conn)`（13 个字段全有值）
//   * 丢包 / 乱序 / 重传
//     ← `getDetailedConnectionStatus(conn)` 的多行文本（没有结构化字段，只能解析文本）
//   * 全局 / 每条流的排队字节、最老排队等待时间、本地 TCP writableLength
//     ← 活路径自己的队列（`peer.out` / `stream.queue` / `stream.socket.writableLength`）
//   * 事件循环延迟 ← `perf_hooks.monitorEventLoopDelay()`
//   * 每轮收包 + 分发耗时 ← 由活路径 pump 埋点喂进来（`recordPoll`）
//   * 房主 TCP/Node 服务处理时间 ← 由本地 socket 的 data 回调埋点喂进来（`recordServe`）
//
// **MUX PING/PONG RTT 在活路径上是 UNAVAILABLE**：`network/stream-mux.cjs:205-206`
// 定义了 encodePing/encodePong，活路径只在 `steam-adapter.cjs:1100`（房主）与
// `:1891`（加入者）**应答** Pong，两边都**从不发 Ping**（发 Ping 的只有规格实现
// `network/mux-session.cjs`，它不在数据路径上）。没有 Ping 就没有样本 —— 这里如实报
// null，而不是拿 Steam 的 RTT 冒充。
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');

/** 每秒一帧。用户要求的就是每秒。 */
const DEFAULT_INTERVAL_MS = 1000;
/** 单个样本文件上限，超了就滚动成 .1/.2…（一次联机几小时的量级远不到）。 */
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
/** 最多保留几个滚动文件。 */
const DEFAULT_MAX_FILES = 8;
/** `getDetailedConnectionStatus` 的文本解析结果缓存多久 —— 它是字符串，比其它读数贵。 */
const DETAILED_CACHE_MS = 5000;
/**
 * 挂到外部调度器（适配器那唯一一个 mux-scheduler）上用的 key。
 * 规格 §十八：整个网络层只许有一个调度器，所以本模块不自己起计时器，
 * 而是让调用方把它注进来；没有调度器时（单测/探针）才退回自己的 setInterval。
 */
const SCHEDULER_KEY = 'net-latency';
/**
 * `monitorEventLoopDelay` 的采样刻度（ms）。取 10 是 Node 文档的常规做法：
 * 刻度越细，采样器本身对事件循环的打扰越大。**注意它同时是这套读数的地板** ——
 * Windows 的系统定时器刻度约 15.6ms，本机实测空闲时 mean 就有 14~16ms，
 * 所以只有明显大于地板的停顿才是真信号（见 readLoop 的 floorNote）。
 */
const LOOP_RESOLUTION_MS = 10;

const round = (value, digits = 1) => {
  if (value == null || !Number.isFinite(value)) return null;
  const k = 10 ** digits;
  return Math.round(value * k) / k;
};

/** 把 Steam 的 bigint 微秒换成毫秒。`steam-connection.cjs:447` 是同样的换算。 */
function usecToMs(usec) {
  if (usec == null) return null;
  const n = typeof usec === 'bigint' ? Number(usec) : Number(usec);
  if (!Number.isFinite(n)) return null;
  return n / 1000;
}

/**
 * 解析 `getDetailedConnectionStatus()` 的多行文本。
 *
 * 原文长这样（实测，见 tools/steam-api-surface-probe.cjs）：
 *     Current rates:
 *         Ping:0ms    Max latency variance: ???ms
 *         Bytes buffered: 0
 *     Lifetime stats:
 *         Dropped   :          1 pkts  50.00%
 *         OutOfOrder:          0 pkts   0.00%
 * 两个数字都要拿：`pingMs` 与丢包/乱序计数。拿不到就 null。
 */
function parseDetailedStatus(text) {
  if (typeof text !== 'string' || !text) return null;
  const out = { pingMs: null, maxLatencyVarianceMs: null, bytesBuffered: null, sentPackets: null, recvPackets: null, droppedPackets: null, outOfOrderPackets: null, duplicatePackets: null, oooFixedPackets: null, seqLurchPackets: null, raw: text };
  const ping = /Ping:\s*(\d+)\s*ms/i.exec(text);
  if (ping) out.pingMs = Number(ping[1]);
  const variance = /Max latency variance:\s*([\d.]+|\?\?\?)\s*ms/i.exec(text);
  if (variance && variance[1] !== '???') out.maxLatencyVarianceMs = Number(variance[1]);
  const buffered = /Bytes buffered:\s*(\d+)/i.exec(text);
  if (buffered) out.bytesBuffered = Number(buffered[1]);
  const stat = (label) => {
    const re = new RegExp(label + '\\s*:\\s*(\\d+)\\s*pkts', 'i');
    const m = re.exec(text);
    return m ? Number(m[1]) : null;
  };
  out.droppedPackets = stat('Dropped');
  out.outOfOrderPackets = stat('OutOfOrder');
  out.oooFixedPackets = stat('OOOFixed');
  out.duplicatePackets = stat('Duplicate');
  out.seqLurchPackets = stat('SeqLurch');
  const totals = /Totals\s*\n\s*Sent:\s*(\d+)\s*pkts\s+(\d+)\s*bytes\s*\n\s*Recv:\s*(\d+)\s*pkts\s+(\d+)\s*bytes/i.exec(text);
  if (totals) {
    out.sentPackets = Number(totals[1]);
    out.sentBytes = Number(totals[2]);
    out.recvPackets = Number(totals[3]);
    out.recvBytes = Number(totals[4]);
  }
  return out;
}

/** 从任意形状的 peers 容器里取出数组：Map / Set / 数组都要能活。 */
function toArray(container) {
  if (!container) return [];
  if (Array.isArray(container)) return container.slice();
  if (typeof container.values === 'function') return [...container.values()];
  if (typeof container === 'object') return Object.values(container);
  return [];
}

/** 流的出站排队字节。字段名在各实现里略有出入，这里统一取。 */
function streamQueueBytes(stream) {
  if (!stream) return 0;
  let bytes = 0;
  if (Array.isArray(stream.queue) && stream.queue.length) for (const b of stream.queue) bytes += b.length || 0;
  else if (Number.isFinite(stream.queueBytes)) bytes += stream.queueBytes;
  if (Array.isArray(stream.parkQueue) && stream.parkQueue.length) for (const b of stream.parkQueue) bytes += b.length || 0;
  else if (Number.isFinite(stream.parkBytes)) bytes += stream.parkBytes;
  return bytes;
}

/**
 * @param {object} options
 * @param {'host'|'joiner'|string} [options.role]        房主还是加入者（写进每一帧）
 * @param {Function} [options.now]                       () => 毫秒时间戳（测试可注入）
 * @param {number}   [options.intervalMs]                采样间隔，默认 1000
 * @param {string}   [options.logDir]                    样本文件目录；**不给就不写文件**
 * @param {Function} [options.sockets]                   () => networkingSockets（没有就 null）
 * @param {Function} [options.connections]               () => 干道连接列表 [{connection,label}]
 * @param {Function} [options.peers]                     () => 活路径的 peers 容器
 * @param {Function} [options.peerLabel]                 (peer) => 可读标签
 * @param {Function} [options.peerOutBytes]              (peer) => 干道出站排队字节
 * @param {Function} [options.peerOutQueues]              (peer) => 每条出站队列的
 *                                                          [{key,bytes,waitedMs,frames}]
 *                                                        （0.14.3 的分流出站队列，见
 *                                                        egress-queue.cjs 的 queueRows）
 * @param {Function} [options.streamsOf]                 (peer) => 流容器
 * @param {Function} [options.counters]                  () => 活路径 stats 的只读快照
 * @param {Function} [options.onEvent]                   (type, payload) => void
 * @param {boolean}  [options.monitorLoop]               是否测事件循环延迟，默认 true
 * @param {boolean}  [options.enabled]                   默认 true
 */
function createNetLatencyDiag(options = {}) {
  const {
    role = 'host',
    now = Date.now,
    intervalMs = DEFAULT_INTERVAL_MS,
    logDir = null,
    filePrefix = 'net-latency',
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    maxFiles = DEFAULT_MAX_FILES,
    sockets = null,
    connections = () => [],
    peers = () => new Map(),
    peerLabel = (peer) => String((peer && (peer.steamId || peer.label)) || '?'),
    peerOutBytes = null,
    peerOutQueues = null,
    streamsOf = (peer) => (peer && peer.streams) || [],
    counters = () => ({}),
    onEvent = null,
    monitorLoop = true,
    enabled = true,
    scheduler = null,
  } = options;

  const stats = {
    samples: 0,
    startedAt: null,
    lastSampleAt: null,
    fileWrites: 0,
    fileErrors: 0,
    filePath: null,
    rotations: 0,
    readErrors: 0,
  };

  let timer = null;
  let scheduled = false;
  let running = false;
  let last = null;
  let fileBytes = 0;
  let stream = null;
  let detailedCache = { at: 0, byConnection: new Map() };
  let loopHistogram = null;

  const emit = (type, payload) => {
    if (typeof onEvent !== 'function') return;
    try { onEvent(type, payload); } catch { /* 诊断回调绝不允许影响转发 */ }
  };

  // ---- 事件循环延迟：只读直方图，不开定时器 ----
  if (monitorLoop) {
    try {
      // eslint-disable-next-line global-require
      const { monitorEventLoopDelay } = require('node:perf_hooks');
      if (typeof monitorEventLoopDelay === 'function') {
        loopHistogram = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
        loopHistogram.enable();
      }
    } catch { loopHistogram = null; }
  }

  // ---- 样本文件：默认不写（测试与探针不该往仓库里丢文件） ----
  function ensureFile() {
    if (!logDir || stream) return stream;
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
      const file = path.join(logDir, `${filePrefix}-${role}-${stamp}.jsonl`);
      stream = fs.createWriteStream(file, { flags: 'a' });
      stream.on('error', () => { stats.fileErrors += 1; stream = null; });
      stats.filePath = file;
      fileBytes = 0;
      pruneOldFiles();
    } catch { stats.fileErrors += 1; stream = null; }
    return stream;
  }

  /** 只保留最近 maxFiles 个样本文件，避免长期联机把磁盘塞满。 */
  function pruneOldFiles() {
    try {
      const names = fs.readdirSync(logDir).filter((n) => n.startsWith(`${filePrefix}-`) && n.endsWith('.jsonl'));
      if (names.length <= maxFiles) return;
      const withTime = names.map((n) => {
        try { return { n, t: fs.statSync(path.join(logDir, n)).mtimeMs }; } catch { return { n, t: 0 }; }
      }).sort((a, b) => a.t - b.t);
      for (const item of withTime.slice(0, withTime.length - maxFiles)) {
        try { fs.unlinkSync(path.join(logDir, item.n)); } catch { /* 删不掉就算了 */ }
      }
    } catch { /* 列目录失败不影响采样 */ }
  }

  function writeSample(sample) {
    if (!logDir) return;
    const out = ensureFile();
    if (!out) return;
    let line;
    try { line = JSON.stringify(sample) + '\n'; } catch { return; }
    try {
      out.write(line);
      stats.fileWrites += 1;
      fileBytes += Buffer.byteLength(line);
      if (fileBytes > maxFileBytes) { rotate(); }
    } catch { stats.fileErrors += 1; }
  }

  function rotate() {
    try { if (stream) stream.end(); } catch { /* ignore */ }
    stream = null;
    fileBytes = 0;
    stats.rotations += 1;
    // 下一次 ensureFile 会新建一个带时间戳的文件；旧的由 pruneOldFiles 限量。
  }

  // ---- Steam 侧读数 ----
  function readConnections() {
    const ns = typeof sockets === 'function' ? sockets() : sockets;
    const list = toArray(typeof connections === 'function' ? connections() : connections);
    const rows = [];
    const unavailable = [];
    for (const item of list) {
      const connection = item && (item.connection !== undefined ? item.connection : item);
      if (connection == null) continue;
      const label = (item && item.label) || String(connection);
      const row = {
        label,
        rttMs: null, qualityLocal: null, qualityRemote: null,
        pendingReliable: null, sentUnackedReliable: null, pendingUnreliable: null,
        queueMs: null, outBytesPerSec: null, inBytesPerSec: null,
        outPacketsPerSec: null, inPacketsPerSec: null, sendRateBytesPerSecond: null,
        pingMs: null, droppedPackets: null, outOfOrderPackets: null, bytesBuffered: null,
      };
      let realtime = null;
      if (ns && typeof ns.getConnectionRealTimeStatus === 'function') {
        try { realtime = ns.getConnectionRealTimeStatus(connection); } catch { stats.readErrors += 1; realtime = null; }
      } else {
        unavailable.push('rttMs: 没有 getConnectionRealTimeStatus');
      }
      if (realtime) {
        row.rttMs = Number.isFinite(realtime.ping) ? realtime.ping : null;
        row.qualityLocal = Number.isFinite(realtime.connectionQualityLocal) ? realtime.connectionQualityLocal : null;
        row.qualityRemote = Number.isFinite(realtime.connectionQualityRemote) ? realtime.connectionQualityRemote : null;
        row.pendingReliable = Number.isFinite(realtime.pendingReliable) ? realtime.pendingReliable : null;
        row.sentUnackedReliable = Number.isFinite(realtime.sentUnackedReliable) ? realtime.sentUnackedReliable : null;
        row.pendingUnreliable = Number.isFinite(realtime.pendingUnreliable) ? realtime.pendingUnreliable : null;
        row.queueMs = usecToMs(realtime.usecQueueTime);
        row.outBytesPerSec = Number.isFinite(realtime.outBytesPerSec) ? realtime.outBytesPerSec : null;
        row.inBytesPerSec = Number.isFinite(realtime.inBytesPerSec) ? realtime.inBytesPerSec : null;
        row.outPacketsPerSec = Number.isFinite(realtime.outPacketsPerSec) ? realtime.outPacketsPerSec : null;
        row.inPacketsPerSec = Number.isFinite(realtime.inPacketsPerSec) ? realtime.inPacketsPerSec : null;
        row.sendRateBytesPerSecond = Number.isFinite(realtime.sendRateBytesPerSecond) ? realtime.sendRateBytesPerSecond : null;
      }
      // 丢包/乱序只能从这一段文本里读，且是**累计值**（看趋势要看差值）。
      if (ns && typeof ns.getDetailedConnectionStatus === 'function') {
        const cached = detailedCache.byConnection.get(String(connection));
        let text = cached && (now() - detailedCache.at) < DETAILED_CACHE_MS ? cached : null;
        if (!text) {
          try { text = ns.getDetailedConnectionStatus(connection); } catch { stats.readErrors += 1; text = null; }
          if (text) detailedCache.byConnection.set(String(connection), text);
        } else {
          text = cached;
        }
        const parsed = parseDetailedStatus(text);
        if (parsed) {
          row.pingMs = parsed.pingMs;
          row.droppedPackets = parsed.droppedPackets;
          row.outOfOrderPackets = parsed.outOfOrderPackets;
          row.bytesBuffered = parsed.bytesBuffered;
        }
      }
      rows.push(row);
    }
    detailedCache.at = now();
    return { rows, unavailable };
  }

  // ---- 活路径队列读数 ----
  function readQueues() {
    const unavailable = [];
    const peerList = toArray(typeof peers === 'function' ? peers() : peers);
    const peerRows = [];
    const streams = [];
    const egressQueues = [];
    let globalBytes = 0;
    let oldestQueuedMs = null;
    for (const peer of peerList) {
      if (!peer) continue;
      const label = peerLabel(peer);
      let outBytes = null;
      if (typeof peerOutBytes === 'function') {
        try { outBytes = Number(peerOutBytes(peer)) || 0; } catch { outBytes = null; }
      } else if (Array.isArray(peer.out)) {
        outBytes = 0;
        for (const b of peer.out) outBytes += (b && b.length) || 0;
      } else if (Number.isFinite(peer.outBytes)) outBytes = peer.outBytes;
      if (outBytes == null) unavailable.push(`globalQueueBytes(${label}): 活路径没有暴露干道队列字节`);
      else {
        globalBytes += outBytes;
        // 最老排队数据的等待时间：只有记了入队时刻才算得出来（`peer.outAt`）。
        if (outBytes > 0 && Number.isFinite(peer.outAt) && peer.outAt > 0) {
          const waited = Math.max(0, now() - peer.outAt);
          if (oldestQueuedMs == null || waited > oldestQueuedMs) oldestQueuedMs = waited;
        }
      }
      // 分流出站队列（0.14.3）：Phase 2 的公平调度有没有真的把"大响应"和"小包"分开 ——
      // 只看一个总数看不出来，必须能看到"哪条流排了多少、最老那批等了多久"。
      if (typeof peerOutQueues === 'function') {
        try {
          for (const row of toArray(peerOutQueues(peer))) {
            if (!row) continue;
            egressQueues.push({ peer: label, key: row.key, bytes: row.bytes, waitedMs: row.waitedMs, frames: row.frames });
          }
        } catch { stats.readErrors += 1; }
      }
      const streamList = toArray(streamsOf(peer));
      for (const s of streamList) {
        if (!s) continue;
        const qb = streamQueueBytes(s);
        const sock = s.socket || s.conn || null;
        streams.push({
          peer: label,
          stream: s.id != null ? s.id : null,
          connected: s.connected !== false,
          queueBytes: qb,
          // 本地 TCP 内核缓冲区还没被取走的字节数：Node 直接给，不用自己记账。
          writableLength: sock && Number.isFinite(sock.writableLength) ? sock.writableLength : null,
          remoteCredit: Number.isFinite(s.remoteCredit) ? s.remoteCredit : null,
          bytesToPeer: Number.isFinite(s.bytesToPeer) ? s.bytesToPeer : null,
          bytesFromPeer: Number.isFinite(s.bytesFromPeer) ? s.bytesFromPeer : null,
        });
      }
      peerRows.push({ label, outBytes, outAt: Number.isFinite(peer.outAt) && peer.outAt > 0 ? peer.outAt : null, paused: Boolean(peer.paused), stalled: Boolean(peer.stalled), frames: Number.isFinite(peer.frames) ? peer.frames : null, framed: peer.framed, streams: toArray(streamsOf(peer)).length });
    }
    if (oldestQueuedMs == null && globalBytes > 0) {
      unavailable.push('oldestQueuedMs: 队列里有字节但没记入队时刻（需 peer.outAt）');
    }
    const streamQueueBytesTotal = streams.reduce((acc, s) => acc + (s.queueBytes || 0), 0);
    const writableTotal = streams.reduce((acc, s) => acc + (s.writableLength || 0), 0);
    return { globalBytes, oldestQueuedMs, streamQueueBytesTotal, writableTotal, peers: peerRows, streams, egressQueues, unavailable };
  }

  function readLoop() {
    if (!loopHistogram) return { available: false, meanMs: null, p50Ms: null, p99Ms: null, maxMs: null, reason: 'perf_hooks.monitorEventLoopDelay 不可用' };
    try {
      const nano = 1e6; // ns -> ms
      return {
        available: true,
        meanMs: round(loopHistogram.mean / nano, 2),
        p50Ms: round(loopHistogram.percentile(50) / nano, 2),
        p99Ms: round(loopHistogram.percentile(99) / nano, 2),
        maxMs: round(loopHistogram.max / nano, 2),
        // 报的是**我们配置的**刻度，不是从直方图读的：本机 Node 24 上
        // `IntervalHistogram.resolution` 是 undefined（实测 resolution:1 与 resolution:10
        // 的读数还几乎一样），读它只会得到 NaN。宁可标明来源，也不给一个编出来的数。
        configuredResolutionMs: LOOP_RESOLUTION_MS,
        // 实测地板：Windows 系统定时器刻度约 15.6ms，空闲时 mean 就在 14~16ms。
        // 也就是说低于这个地板的读数区分不出"空闲"和"轻微延迟"，只有明显大于它的
        // （比如 GC 停顿、同步大 JSON 解析）才是真信号。
        floorNote: 'Windows 定时器刻度约 15.6ms：空闲时 mean 就有 14~16ms，低于此值不可区分',
      };
    } catch (err) {
      return { available: false, meanMs: null, p50Ms: null, p99Ms: null, maxMs: null, reason: `直方图读取失败：${err.message}` };
    }
  }

  const pollStats = { count: 0, lastMs: null, maxMs: null, totalMs: 0, lastMessages: null, lastDispatchMs: null, totalMessages: 0 };
  const serveStats = { count: 0, lastMs: null, maxMs: null, totalMs: 0, totalBytes: 0 };

  /** 活路径 pump 每轮喂一次：收包 + 分发耗时。 */
  function recordPoll(entry = {}) {
    const ms = Number(entry.ms);
    if (!Number.isFinite(ms)) return;
    const dispatch = Number(entry.dispatchMs);
    pollStats.count += 1;
    pollStats.lastMs = round(ms, 3);
    pollStats.totalMs += ms;
    if (pollStats.maxMs == null || ms > pollStats.maxMs) pollStats.maxMs = round(ms, 3);
    if (Number.isFinite(dispatch)) pollStats.lastDispatchMs = round(dispatch, 3);
    if (Number.isFinite(entry.messages)) {
      pollStats.lastMessages = entry.messages;
      pollStats.totalMessages += entry.messages;
    }
  }

  /** 本地 socket 的 data 回调每轮喂一次：房主 TCP + Node 侧的处理耗时。 */
  function recordServe(entry = {}) {
    const ms = Number(entry.ms);
    if (!Number.isFinite(ms)) return;
    serveStats.count += 1;
    serveStats.lastMs = round(ms, 3);
    serveStats.totalMs += ms;
    if (serveStats.maxMs == null || ms > serveStats.maxMs) serveStats.maxMs = round(ms, 3);
    if (Number.isFinite(entry.bytes)) serveStats.totalBytes += entry.bytes;
  }

  function sample() {
    if (!enabled) return null;
    const at = now();
    const steam = readConnections();
    const queues = readQueues();
    const loop = readLoop();
    let counterSnapshot = {};
    try { counterSnapshot = counters() || {}; } catch { stats.readErrors += 1; }
    const unavailable = [...steam.unavailable, ...queues.unavailable];
    unavailable.push('muxRttMs: 活路径只应答 Pong、从不发 Ping，没有样本（stream-mux.cjs:205 定义了 encodePing 但无人调用）');

    const worst = steam.rows.reduce((acc, r) => {
      if (r.rttMs == null) return acc;
      if (acc == null || r.rttMs > acc) return r.rttMs;
      return acc;
    }, null);

    const frame = {
      at,
      iso: new Date(at).toISOString(),
      role,
      seq: stats.samples + 1,
      // 网络 RTT（这一条是"网络"本身）
      steamRttMs: worst,
      steamConnections: steam.rows,
      // MUX 排队（这一条是"我们自己排队"）
      globalQueueBytes: queues.globalBytes,
      oldestQueuedMs: queues.oldestQueuedMs,
      streamQueueBytes: queues.streamQueueBytesTotal,
      // 本地 TCP 内核缓冲
      tcpWritableLength: queues.writableTotal,
      // Node / 事件循环
      eventLoop: loop,
      // 每轮收包与分发
      poll: { ...pollStats, avgMs: pollStats.count ? round(pollStats.totalMs / pollStats.count, 3) : null },
      // 房主 TCP + Node 服务处理（本地 data 回调耗时）
      serve: { ...serveStats, avgMs: serveStats.count ? round(serveStats.totalMs / serveStats.count, 3) : null },
      peers: queues.peers,
      streams: queues.streams,
      // 按流分开的出站队列（每条流排了多少、最老那批等了多久）
      egressQueues: queues.egressQueues,
      counters: {
        bytesToPeer: counterSnapshot.bytesToPeer ?? null,
        bytesFromPeer: counterSnapshot.bytesFromPeer ?? null,
        packetsToPeer: counterSnapshot.packetsToPeer ?? null,
        packetsFromPeer: counterSnapshot.packetsFromPeer ?? null,
        dropped: counterSnapshot.dropped ?? null,
        failed: counterSnapshot.failed ?? null,
        sendStalls: counterSnapshot.sendStalls ?? null,
        streams: counterSnapshot.streams ?? null,
        totalStreams: counterSnapshot.totalStreams ?? null,
        streamsParked: counterSnapshot.streamsParked ?? null,
        streamsMigrated: counterSnapshot.streamsMigrated ?? null,
      },
      tuning: counterSnapshot.tuning || null,
      unavailable,
    };
    // 一行可读文本：现场贴日志时看这个，比 JSON 好读。
    frame.line = renderLine(frame);
    stats.samples += 1;
    stats.lastSampleAt = at;
    last = frame;
    writeSample(frame);
    emit('net-latency', frame);
    return frame;
  }

  function renderLine(frame) {
    const na = 'UNAVAILABLE';
    const rtt = frame.steamRttMs == null ? na : `${frame.steamRttMs}ms`;
    const conn = frame.steamConnections[0] || {};
    const pend = conn.pendingReliable == null ? na : `${conn.pendingReliable}B`;
    const unacked = conn.sentUnackedReliable == null ? na : `${conn.sentUnackedReliable}B`;
    const sq = conn.queueMs == null ? na : `${round(conn.queueMs, 2)}ms`;
    const loop = frame.eventLoop.available ? `${frame.eventLoop.p50Ms}/${frame.eventLoop.p99Ms}ms` : na;
    const poll = frame.poll.lastMs == null ? na : `${frame.poll.lastMs}/${frame.poll.maxMs}ms`;
    const serve = frame.serve.lastMs == null ? na : `${frame.serve.lastMs}/${frame.serve.maxMs}ms`;
    // 队列里一个字节都没有时，"最老的等待"就是 0 —— 这时候报 UNAVAILABLE 会让人以为
    // 是"读不出来"，而不是"本来就没积压"。
    const idleQueue = !frame.globalQueueBytes && !frame.streamQueueBytes;
    const old = frame.oldestQueuedMs != null ? `${frame.oldestQueuedMs}ms` : (idleQueue ? '0ms(空闲)' : na);
    const up = stats.startedAt ? Math.round((frame.at - stats.startedAt) / 1000) : 0;
    return `[LT] ${frame.role} up=${up}s 网络RTT=${rtt} Steam排队=${sq} 可靠待发=${pend} 未确认=${unacked}`
      + ` | MUX排队 干道=${frame.globalQueueBytes}B 流=${frame.streamQueueBytes}B 最老=${old} MUX-RTT=${na}`
      + ` | 本地TCP writable=${frame.tcpWritableLength}B`
      + ` | Node 事件循环=${loop} 收包分发=${poll} 服务处理=${serve}`
      + ` | 干道${frame.peers.length} 流${frame.streams.length}`;
  }

  function start() {
    if (running || !enabled) return false;
    running = true;
    stats.startedAt = now();
    ensureFile();
    // 第一帧立刻采一次：不然要等满一个周期才看得到数据。
    try { sample(); } catch { stats.readErrors += 1; }
    // 规格 §十八：整个网络层只允许一个调度器。适配器会把它那唯一一个
    // mux-scheduler 注进来（scheduler.every），这里就不再自起计时器；
    // 只有单测/探针这种没有适配器的场合才退回自己的 setInterval。
    const tick = () => {
      try { sample(); } catch { stats.readErrors += 1; }
    };
    if (scheduler && typeof scheduler.every === 'function') {
      scheduler.every(SCHEDULER_KEY, Math.max(100, intervalMs), tick);
      scheduled = true;
      return true;
    }
    timer = setInterval(tick, Math.max(100, intervalMs));
    timer.unref?.();
    return true;
  }

  function stop() {
    running = false;
    if (timer) { clearInterval(timer); timer = null; }
    if (scheduled && scheduler && typeof scheduler.cancel === 'function') {
      try { scheduler.cancel(SCHEDULER_KEY); } catch { /* ignore */ }
    }
    scheduled = false;
    return true;
  }

  function dispose() {
    stop();
    if (loopHistogram) { try { loopHistogram.disable(); } catch { /* ignore */ } loopHistogram = null; }
    try { if (stream) stream.end(); } catch { /* ignore */ }
    stream = null;
  }

  /** 给 netState()/界面用的一帧快照（比 JSONL 那一帧精简，去掉明细数组）。 */
  function snapshot() {
    const f = last;
    if (!f) return { available: false, reason: '还没有采到样本', role, samples: 0 };
    const conn = f.steamConnections[0] || {};
    return {
      available: true,
      role: f.role,
      at: f.at,
      seq: f.seq,
      samples: stats.samples,
      steamRttMs: f.steamRttMs,
      steamQueueMs: conn.queueMs ?? null,
      steamPendingReliable: conn.pendingReliable ?? null,
      steamSentUnackedReliable: conn.sentUnackedReliable ?? null,
      droppedPackets: conn.droppedPackets ?? null,
      outOfOrderPackets: conn.outOfOrderPackets ?? null,
      muxRttMs: null,
      globalQueueBytes: f.globalQueueBytes,
      streamQueueBytes: f.streamQueueBytes,
      oldestQueuedMs: f.oldestQueuedMs,
      tcpWritableLength: f.tcpWritableLength,
      eventLoopP50Ms: f.eventLoop.p50Ms,
      eventLoopP99Ms: f.eventLoop.p99Ms,
      pollAvgMs: f.poll.avgMs,
      pollMaxMs: f.poll.maxMs,
      serveAvgMs: f.serve.avgMs,
      serveMaxMs: f.serve.maxMs,
      peers: f.peers.length,
      streams: f.streams.length,
      unavailable: f.unavailable,
      line: f.line,
      filePath: stats.filePath,
    };
  }

  return {
    start,
    stop,
    dispose,
    sample,
    snapshot,
    recordPoll,
    recordServe,
    get running() { return running; },
    stats,
    pollStats,
    serveStats,
    get lastFrame() { return last; },
    lines: (n = 3) => (last ? [last.line] : []).slice(0, n),
    parseDetailedStatus,
  };
}

module.exports = { createNetLatencyDiag, parseDetailedStatus, usecToMs, DEFAULT_INTERVAL_MS };
