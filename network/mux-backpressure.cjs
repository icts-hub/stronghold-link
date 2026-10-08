'use strict';
// ============================================================================
// Stronghold Link — 背压控制器（规格 §十三）
//
// 职责只有一个：**决定什么时候暂停/恢复读本机 socket**。
//
// 为什么必须集中在一个地方：0.13.3 里背压逻辑散在 `applyBackpressure` / `resumeOrAbort` /
// `flushPeerOut` 三处，每条连接各自 pause/resume。多路复用之后一条干道上挂着 N 条流，
// 如果每条流各判各的，"到底现在该不该读"就没有唯一答案 —— 一条流觉得宽裕、另一条
// 已经积压到爆，暂停会被反复抵消。
//
// 两级水位（规格 §十三 的数值，正好等于项目里已有的三个常量）：
//
//   每条流：  ≥ 1 MiB 暂停这条流    ≤ 128 KiB 恢复
//   整个会话：≥ 8 MiB 暂停全部流    ≤ 2 MiB   恢复
//
// 全局水位更钝（8 MiB 才动手、2 MiB 才松手）是故意的：它是"整条干道快撑不住了"的
// 兜底，不是日常调速手段。日常调速交给每流那一级。
//
// 这个模块**不碰 socket、不碰 Steam、不碰帧**。它只对"流"这个抽象调 pauseLocal() /
// resumeLocal()，所以可以完全脱离网络单测。
// ============================================================================

/** 每条流出站队列的高水位：到这儿就暂停读这条流的本机 socket。 */
const PER_STREAM_HIGH_WATER = 1 * 1024 * 1024;

/** 每条流的低水位：降到这儿才恢复读。 */
const PER_STREAM_LOW_WATER = 128 * 1024;

/** 整个会话的高水位：到这儿把**所有**本机 socket 都暂停。 */
const GLOBAL_HIGH_WATER = 8 * 1024 * 1024;

/** 整个会话的低水位：降到这儿才全部恢复。 */
const GLOBAL_LOW_WATER = 2 * 1024 * 1024;

/** 积压字节的统一取数口：流对象可以给 queuedBytes 字段或 getQueuedBytes()。 */
function queuedOf(stream) {
  if (!stream) return 0;
  if (typeof stream.getQueuedBytes === 'function') {
    const n = Number(stream.getQueuedBytes());
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  const n = Number(stream.queuedBytes);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function createBackpressureController(options = {}) {
  const streamHigh = Number.isFinite(options.streamHigh) ? options.streamHigh : PER_STREAM_HIGH_WATER;
  const streamLow = Number.isFinite(options.streamLow) ? options.streamLow : PER_STREAM_LOW_WATER;
  const globalHigh = Number.isFinite(options.globalHigh) ? options.globalHigh : GLOBAL_HIGH_WATER;
  const globalLow = Number.isFinite(options.globalLow) ? options.globalLow : GLOBAL_LOW_WATER;
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};

  /** 所有被纳管的流。 */
  const streams = new Set();
  /** 因为**每流**水位被我们暂停的流。 */
  const paused = new Set();
  /** 因为**全局**水位把所有人都暂停了。 */
  let globalPaused = false;

  const stats = {
    totalQueued: 0,
    maxQueued: 0,
    pausedStreams: 0,
    globalPaused: false,
    streamHighWaterHits: 0,
    streamLowWaterHits: 0,
    globalHighWaterHits: 0,
    globalLowWaterHits: 0,
  };

  const callStream = (stream, method) => {
    if (stream && typeof stream[method] === 'function') {
      try { stream[method](); } catch { /* 单条流暂停/恢复失败不能带倒整个会话 */ }
    }
  };

  const pauseStream = (stream) => {
    if (paused.has(stream)) return false;
    paused.add(stream);
    stats.streamHighWaterHits += 1;
    callStream(stream, 'pauseLocal');
    onEvent('stream-paused', { stream: stream && stream.id, queuedBytes: queuedOf(stream), water: streamHigh });
    return true;
  };

  const resumeStream = (stream) => {
    if (!paused.has(stream)) return false;
    paused.delete(stream);
    stats.streamLowWaterHits += 1;
    callStream(stream, 'resumeLocal');
    onEvent('stream-resumed', { stream: stream && stream.id, queuedBytes: queuedOf(stream), water: streamLow });
    return true;
  };

  const pauseAll = () => {
    if (globalPaused) return false;
    globalPaused = true;
    stats.globalHighWaterHits += 1;
    for (const stream of streams) callStream(stream, 'pauseLocal');
    onEvent('global-paused', { totalQueued: stats.totalQueued, water: globalHigh, streams: streams.size });
    return true;
  };

  const resumeAll = () => {
    if (!globalPaused) return false;
    globalPaused = false;
    stats.globalLowWaterHits += 1;
    // 必须和 pauseAll 逐条对称。全局水位掐停的是**每一条流**的本机 socket，
    // 恢复时也要逐条放回去 —— 只把 globalPaused 翻回 false 的话，控制器自己认为
    // "已经不暂停了"（accepts() 也返回 true），可本机 socket 还停在暂停状态，
    // 只能指望上层收到 Window 帧时补救（mux-session.cjs 那条路径），
    // 没有 Window 帧的流会永久卡死。规格 §十三 的两级水位是对称的。
    // 自己撞到高水位、仍在 paused 集合里的流不能顺手放掉。
    for (const stream of streams) {
      if (paused.has(stream)) continue;
      callStream(stream, 'resumeLocal');
    }
    onEvent('global-resumed', { totalQueued: stats.totalQueued, water: globalLow, streams: streams.size });
    return true;
  };

  const recompute = () => {
    let total = 0;
    for (const stream of streams) {
      const q = queuedOf(stream);
      total += q;
      // 每流那一级：带滞回（涨到 high 才暂停，跌到 low 才恢复），避免在阈值上抖动。
      if (q >= streamHigh) pauseStream(stream);
      else if (q <= streamLow) resumeStream(stream);
    }
    stats.totalQueued = total;
    if (total > stats.maxQueued) stats.maxQueued = total;
    stats.pausedStreams = paused.size;

    if (total >= globalHigh) pauseAll();
    else if (total <= globalLow) resumeAll();
    stats.globalPaused = globalPaused;
    return total;
  };

  return {
    register(stream) {
      if (!stream) return;
      streams.add(stream);
      recompute();
    },
    unregister(stream) {
      if (!stream) return;
      streams.delete(stream);
      paused.delete(stream);
      recompute();
    },
    /** 某条流的积压变了（写完队列 / 队列被抽干之后调）。 */
    update() { return recompute(); },
    /** 被我们暂停的流（诊断用）。 */
    pausedStreams() { return [...paused]; },
    isGlobalPaused() { return globalPaused; },
    /** 这条流当前该不该继续读本机 socket。 */
    accepts(stream) {
      if (globalPaused) return false;
      return !paused.has(stream);
    },
    /** 重置（换 transport / 会话重来）。只清本地判断，不动 socket。 */
    reset() {
      paused.clear();
      globalPaused = false;
      stats.totalQueued = 0;
      stats.pausedStreams = 0;
      stats.globalPaused = false;
    },
    get size() { return streams.size; },
    get stats() { return { ...stats }; },
    config: { streamHigh, streamLow, globalHigh, globalLow },
  };
}

module.exports = {
  PER_STREAM_HIGH_WATER,
  PER_STREAM_LOW_WATER,
  GLOBAL_HIGH_WATER,
  GLOBAL_LOW_WATER,
  createBackpressureController,
};
