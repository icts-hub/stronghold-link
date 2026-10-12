'use strict';
// ============================================================================
// 0.14.4 取证工具：Steam 待发可靠数据（pendingReliable）背压的确定性模型
// ============================================================================
//
// 管道（按 tick 推进，字节严格 FIFO，不重排、不丢失）：
//   生产端缓冲 → 我们的出站队列（egress-queue）→ Steam 可靠缓冲（pendingReliable）
//   → 按发送速率放行 → RTT → 对端
//
// 容量与限制：生产端缓冲满 ⇒ 后续字节不产生；Steam 缓冲（sendBufferSize，默认 2MiB）
// 满 ⇒ sendMessage 被拒（k_EResultLimitExceeded），被拒字节留在出站队列；丢包按 span
// 整块重传，重传期间队头阻塞。
//
// 模型不包含真实 Steam/SDR、拥塞控制、加密、ACK 细节与本机事件循环开销，
// 量出的是同口径下各水位策略的相对差别。
//
// 用法（由 tools/steam-egress-sim.cjs --backpressure 调用）：
//   const { simulateBackpressure, SCHEMES, SCENARIOS } = require('./steam-backpressure-model.cjs');

const TICK_MS = 4;
const STEAM_BUFFER_BYTES = 2 * 1024 * 1024;
const PRODUCER_BUFFER_BYTES = 256 * 1024;
const READ_BYTES_PER_TICK = 64 * 1024;
const LOW_RATIO = 0.25;

const KB = 1024;
const KBPS = 1024 / 1000; // 1 KB/s = 1.024 B/ms

const percentile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
const round2 = (n) => (n == null ? null : Number(n.toFixed(2)));

/** 线性同余伪随机（固定种子 ⇒ 结果可复现）。 */
function makeRandom(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * 跑一次背压实验。
 *
 * @param {object} options
 * @param {'off'|'A'|'B'|'C'} options.scheme  控制策略
 * @param {number} [options.backlogHigh]      高水位（字节，A/B/C 的初值）
 * @param {number} [options.backlogLow]       低水位（字节，默认 high/4）
 * @param {number} [options.queueLowMs]       B：恢复前要求的 Steam 排队时间上限
 * @param {number} [options.rateBytesPerMs]   链路可持续速率
 * @param {number} [options.rttMs]            端到端 RTT
 * @param {number} [options.chunkRateBytesPerMs] 生产端区块数据需求速率
 * @param {number} [options.durationMs]
 * @param {number} [options.tickMs]
 * @param {number} [options.moveIntervalMs]   移动包间隔（默认 20ms = 50Hz）
 * @param {number} [options.moveBytes]        移动包载荷
 * @param {number} [options.streams]          共享同一 Steam 连接的流数
 * @param {number} [options.lossRate]         丢包率（0~1，按 span 计）
 * @param {number} [options.lossRtoMs]
 * @param {number} [options.producerBufferBytes]
 * @param {number} [options.steamBufferBytes]
 * @param {number} [options.burstBytes]       起始一次性突发字节数
 * @param {number} [options.seed]             丢包随机种子
 */
function simulateBackpressure(options = {}) {
  const scheme = options.scheme || 'A';
  const tickMs = Math.max(1, options.tickMs || TICK_MS);
  const durationMs = Math.max(tickMs * 10, options.durationMs || 6000);
  const rate = options.rateBytesPerMs || 256 * KBPS;
  const rttMs = options.rttMs == null ? 60 : options.rttMs;
  const chunkRate = options.chunkRateBytesPerMs == null ? 400 * KBPS : options.chunkRateBytesPerMs;
  const moveIntervalMs = Math.max(tickMs, options.moveIntervalMs || 20);
  const moveBytes = Math.max(1, options.moveBytes || 64);
  const streams = Math.max(1, options.streams || 1);
  const lossRate = Math.max(0, Math.min(0.5, options.lossRate || 0));
  const lossRtoMs = options.lossRtoMs == null ? 200 : options.lossRtoMs;
  const producerCap = options.producerBufferBytes || PRODUCER_BUFFER_BYTES;
  const steamCap = options.steamBufferBytes || STEAM_BUFFER_BYTES;
  const burstBytes = options.burstBytes || 0;
  const queueLowMs = options.queueLowMs == null ? 250 : options.queueLowMs;
  const rand = makeRandom(options.seed || 20261012);

  let high = options.backlogHigh || 256 * KB;
  let low = options.backlogLow || Math.max(4 * KB, Math.floor(high * LOW_RATIO));

  let now = 0;
  let producerBytes = 0;
  let queueBytes = 0;
  let steamBytes = 0;
  const producerFifo = [];   // 生产端缓冲：{label, bytes, writtenAt}
  const queueFifo = [];      // 我们的出站队列
  const steamFifo = [];      // 已交给 Steam 的字节（pendingReliable）
  const inflight = [];       // 链路上：{at, label, bytes, writtenAt}
  const pendingMoves = [];   // 到点了但生产端缓冲满、写不进去的移动包

  const pendingSamples = [];
  const moveLatencies = [];
  let producedBytes = 0;
  let deliveredBytes = 0;
  let suppressedBytes = 0;
  let pausedTicks = 0;
  let ticks = 0;
  let flips = 0;
  let limitExceeded = 0;
  let idleTicks = 0;
  let lossEvents = 0;
  let retriedBytes = 0;
  let flushedBytes = 0;
  let lastMoveAt = 0;
  let windowStartedAt = 0;
  let departedInWindow = 0;
  let pauseState = false;
  let peakSteamBytes = 0;
  let chunkCarry = 0; // 区块需求按整字节累计，避免浮点尾数污染完整性统计
  let rateCarry = 0;  // 链路预算同样按整字节累计

  if (burstBytes > 0) {
    const admitted = Math.min(burstBytes, producerCap);
    producerFifo.push({ label: 'burst', bytes: admitted, writtenAt: 0 });
    producerBytes = admitted;
    producedBytes += admitted;
    suppressedBytes += burstBytes - admitted;
  }

  const chunkPerTick = chunkRate * tickMs;
  const admit = (label, bytes, writtenAt) => {
    producerFifo.push({ label, bytes, writtenAt });
    producerBytes += bytes;
    producedBytes += bytes;
  };

  while (now < durationMs) {
    ticks += 1;

    // 1) 到点的移动包排进生产端缓冲（写不进去就按原定时间继续等）
    while (now - lastMoveAt >= moveIntervalMs) {
      lastMoveAt += moveIntervalMs;
      pendingMoves.push({ writtenAt: lastMoveAt });
    }
    for (let i = 0; i < pendingMoves.length;) {
      if (producerBytes + moveBytes > producerCap) break;
      const mv = pendingMoves[i];
      admit('move', moveBytes, mv.writtenAt);
      pendingMoves.splice(i, 1);
    }

    // 2) 区块数据需求：生产端缓冲没地方就写不进去（游戏侧被抑制）
    chunkCarry += chunkPerTick;
    const demand = Math.floor(chunkCarry);
    chunkCarry -= demand;
    const room = Math.max(0, producerCap - producerBytes);
    const admitted = Math.min(demand, room);
    if (admitted > 0) {
      const per = Math.floor(admitted / streams);
      for (let s = 0; s < streams; s++) {
        const bytes = s === streams - 1 ? admitted - per * (streams - 1) : per;
        if (bytes > 0) admit('chunk', bytes, now);
      }
    }
    suppressedBytes += demand - admitted;

    // 3) 我们读生产端缓冲（暂停时这一步不执行）
    if (pauseState) {
      pausedTicks += 1;
    } else if (producerBytes > 0) {
      let take = Math.min(producerBytes, READ_BYTES_PER_TICK);
      while (take > 0 && producerFifo.length) {
        const head = producerFifo[0];
        const moved = Math.min(head.bytes, take);
        queueFifo.push({ label: head.label, bytes: moved, writtenAt: head.writtenAt });
        queueBytes += moved;
        producerBytes -= moved;
        take -= moved;
        head.bytes -= moved;
        if (head.bytes === 0) producerFifo.shift();
      }
    }

    // 4) flush 给 Steam：容量满就被拒（k_EResultLimitExceeded），被拒的留在我们队列里
    if (queueBytes > 0) {
      const accept = Math.min(queueBytes, Math.max(0, steamCap - steamBytes));
      if (accept < queueBytes) limitExceeded += 1;
      let remaining = accept;
      while (remaining > 0 && queueFifo.length) {
        const head = queueFifo[0];
        const moved = Math.min(head.bytes, remaining);
        steamFifo.push({ label: head.label, bytes: moved, writtenAt: head.writtenAt, retryAt: 0 });
        steamBytes += moved;
        flushedBytes += moved;
        queueBytes -= moved;
        remaining -= moved;
        head.bytes -= moved;
        if (head.bytes === 0) queueFifo.shift();
      }
    }

    // 5) Steam 按速率放行（丢包整块重传，重传期间队头阻塞）
    if (steamBytes > peakSteamBytes) peakSteamBytes = steamBytes;
    if (steamBytes <= 0) idleTicks += 1;
    rateCarry += rate * tickMs;
    let budget = Math.floor(rateCarry);
    rateCarry -= budget;
    while (budget > 0 && steamFifo.length) {
      const head = steamFifo[0];
      if (head.retryAt > now) break;
      if (head.retryAt === 0 && lossRate > 0 && rand() < lossRate) {
        head.retryAt = now + lossRtoMs;
        lossEvents += 1;
        retriedBytes += head.bytes;
        break;
      }
      const take = Math.min(head.bytes, budget);
      head.bytes -= take;
      steamBytes -= take;
      budget -= take;
      inflight.push({ at: now + rttMs, label: head.label, bytes: take, writtenAt: head.writtenAt });
      if (head.bytes === 0) steamFifo.shift();
    }

    // 6) 送达
    for (let i = inflight.length - 1; i >= 0; i--) {
      if (inflight[i].at > now) continue;
      const span = inflight[i];
      inflight.splice(i, 1);
      deliveredBytes += span.bytes;
      departedInWindow += span.bytes;
      if (span.label === 'move') moveLatencies.push(now - span.writtenAt);
    }

    // 7) 1Hz 采样（与真机 net-latency-diag.cjs 同口径：pendingReliable）
    if (now - windowStartedAt >= 1000) {
      windowStartedAt = now;
      pendingSamples.push(steamBytes);
      const effRate = departedInWindow / 1000;
      departedInWindow = 0;
      if (scheme === 'C') {
        const bdp = effRate * rttMs;
        high = Math.max(64 * KB, Math.min(1024 * KB, Math.round(2 * bdp + 32 * KB)));
        low = Math.max(4 * KB, Math.round(high * LOW_RATIO));
      }
    }

    // 8) 控制：高低水位之间滞回；B 另外要求排队时间也降下来
    if (scheme !== 'off') {
      const queueMs = steamBytes / rate;
      if (!pauseState && steamBytes >= high) {
        pauseState = true;
        flips += 1;
      } else if (pauseState && steamBytes <= low && (scheme !== 'B' || queueMs <= queueLowMs)) {
        pauseState = false;
        flips += 1;
      }
    }

    now += tickMs;
  }

  const sortedPending = [...pendingSamples].sort((a, b) => a - b);
  const sortedMove = [...moveLatencies].sort((a, b) => a - b);
  const seconds = durationMs / 1000;
  // 完整性与否只看"生产 = 送达 + 仍留在管道里"：仿真结束时还没送完的字节不是丢失。
  const inflightBytes = inflight.reduce((n, span) => n + span.bytes, 0);
  const bufferedBytes = producerBytes + queueBytes + steamBytes + inflightBytes;
  const lostBytes = producedBytes - deliveredBytes - bufferedBytes;
  return {
    scheme,
    params: { highKB: round2(high / KB), lowKB: round2(low / KB), rateKBps: round2(rate / KBPS), rttMs, chunkRateKBps: round2(chunkRate / KBPS), streams, lossRate },
    pending: {
      n: sortedPending.length,
      p50KB: round2(percentile(sortedPending, 0.5) / KB),
      p95KB: round2(percentile(sortedPending, 0.95) / KB),
      maxKB: round2((sortedPending.length ? sortedPending[sortedPending.length - 1] : 0) / KB),
      peakKB: round2(peakSteamBytes / KB),
    },
    move: {
      n: sortedMove.length,
      p50Ms: round2(percentile(sortedMove, 0.5)),
      p95Ms: round2(percentile(sortedMove, 0.95)),
      maxMs: round2(sortedMove.length ? sortedMove[sortedMove.length - 1] : 0),
    },
    throughputKBps: round2(deliveredBytes / KB / seconds),
    suppressedKB: round2(suppressedBytes / KB),
    pauseRatio: round2(ticks ? pausedTicks / ticks : 0),
    flips,
    limitExceeded,
    idleRatio: round2(ticks ? idleTicks / ticks : 0),
    loss: { events: lossEvents, retriedKB: round2(retriedBytes / KB) },
    integrity: {
      producedBytes,
      deliveredBytes,
      flushedBytes,
      bufferedBytes,
      lostBytes,
      balanced: lostBytes === 0,
    },
    simMs: now,
  };
}

const SCHEMES = [
  { id: 'off', label: '0.14.3（完全不停）' },
  { id: 'A', label: 'A 双水位 256/64KiB', backlogHigh: 256 * KB },
  { id: 'A128', label: 'A 双水位 128/32KiB', backlogHigh: 128 * KB },
  { id: 'A512', label: 'A 双水位 512/128KiB', backlogHigh: 512 * KB },
  { id: 'B', label: 'B 双水位 256/64KiB + 排队时间门', backlogHigh: 256 * KB, queueLowMs: 250 },
  { id: 'C', label: 'C 按实测速率/RTT 自适应', backlogHigh: 256 * KB },
];

const SCENARIOS = [
  { id: 'heavy', label: '持续重负载：区块需求 1MB/s + 50Hz 移动包', options: { chunkRateBytesPerMs: 1024 * KBPS } },
  { id: 'sustained', label: '中等负载：区块需求 400KB/s + 50Hz 移动包', options: {} },
  { id: 'burst900', label: '先 900KiB 突发再转持续流', options: { burstBytes: 900 * KB, durationMs: 8000 } },
  { id: 'slow', label: '慢生产端 180KB/s（低于链路 256KB/s）', options: { chunkRateBytesPerMs: 180 * KBPS, durationMs: 6000 } },
  { id: 'multi', label: '两条流共享同一连接', options: { streams: 2, chunkRateBytesPerMs: 1024 * KBPS } },
  { id: 'lossy', label: '2% 丢包 + 40ms 额外延迟', options: { lossRate: 0.02, rttMs: 100, chunkRateBytesPerMs: 1024 * KBPS } },
  { id: 'rtt20', label: '低 RTT 20ms', options: { rttMs: 20, chunkRateBytesPerMs: 1024 * KBPS } },
  { id: 'rtt120', label: '高 RTT 120ms', options: { rttMs: 120, chunkRateBytesPerMs: 1024 * KBPS } },
  { id: 'cap', label: '起始 3MiB 突发（超过 Steam 缓冲）', options: { burstBytes: 3 * KB * KB, durationMs: 6000 } },
];

module.exports = {
  simulateBackpressure, SCHEMES, SCENARIOS,
  TICK_MS, STEAM_BUFFER_BYTES, PRODUCER_BUFFER_BYTES, READ_BYTES_PER_TICK,
  KB, KBPS, percentile, round2,
};
