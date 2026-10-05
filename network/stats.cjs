'use strict';
// ============================================================================
// Stronghold Link — NetworkStats（统一统计结构）
//
// 目标：所有 Provider（本地中继 / Steam P2P / Direct UDP / SL Relay）共用同一份
// 统计语义，界面与 RouteManager 不需要知道底层是谁。
//
// 两条硬规则：
//   1. 只做「累计计数」与「按时间差分」，不做平滑、不做估算、不补点。
//   2. 计数可以由中继内核自己累加（mirrorStats 直读外部对象），
//      本模块只负责采样与速率换算，避免为了统计去改动成熟的内核。
// ============================================================================

const MAX_SAMPLES = 60;
const MIN_SAMPLE_INTERVAL_MS = 200;

/** 空计数。字段与现有中继内核保持一致，便于直接镜像。 */
function emptyCounters() {
  return {
    connections: 0,
    totalConnections: 0,
    rejected: 0,
    failed: 0,
    dropped: 0,
    bytesToPeer: 0,
    bytesFromPeer: 0,
    packetsToPeer: 0,
    packetsFromPeer: 0,
  };
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 创建统计容器。
 *
 * @param {object}  [options]
 * @param {object}  [options.mirror]  外部计数对象（中继内核自己的 stats）；给了就直读它
 * @param {Function}[options.now]     取当前时间的函数（测试可注入）
 * @param {number}  [options.maxSamples]
 */
function createStats({ mirror = null, now = Date.now, maxSamples = MAX_SAMPLES } = {}) {
  const own = emptyCounters();
  const counters = mirror || own;
  let samples = [];
  let last = null;

  const read = () => {
    const out = {};
    for (const key of Object.keys(emptyCounters())) out[key] = num(counters[key]);
    return out;
  };

  /** 手工累加（自建计数时用；镜像模式下仍会写进镜像对象）。 */
  function add(field, amount = 1) {
    if (!(field in own)) throw new Error(`未知的统计字段：${field}`);
    counters[field] = num(counters[field]) + num(amount);
    return counters[field];
  }

  /**
   * 采一个点。间隔小于 MIN_SAMPLE_INTERVAL_MS 时直接返回上一个结果，
   * 避免界面高频轮询把采样序列冲成噪声。
   */
  function sample(at = now()) {
    const current = read();
    if (last && at - last.at < MIN_SAMPLE_INTERVAL_MS) {
      return { sample: samples[samples.length - 1] || null, throttled: true };
    }
    let rateToPeer = 0;
    let rateFromPeer = 0;
    if (last) {
      const seconds = Math.max(0.05, (at - last.at) / 1000);
      rateToPeer = Math.max(0, Math.round((current.bytesToPeer - last.bytesToPeer) / seconds));
      rateFromPeer = Math.max(0, Math.round((current.bytesFromPeer - last.bytesFromPeer) / seconds));
    }
    const point = {
      at,
      rateToPeer,
      rateFromPeer,
      connections: current.connections,
      totalToPeer: current.bytesToPeer,
      totalFromPeer: current.bytesFromPeer,
    };
    samples.push(point);
    if (samples.length > maxSamples) samples.splice(0, samples.length - maxSamples);
    last = { at, ...current };
    return { sample: point, throttled: false };
  }

  function snapshot(at = now()) {
    sample(at);
    const current = read();
    const point = samples[samples.length - 1] || null;
    return {
      ...current,
      rateToPeer: point ? point.rateToPeer : 0,
      rateFromPeer: point ? point.rateFromPeer : 0,
      samples: samples.slice(-maxSamples).map((s) => ({ ...s })),
      sampledAt: point ? point.at : null,
    };
  }

  function reset() {
    samples = [];
    last = null;
    if (!mirror) for (const key of Object.keys(own)) own[key] = 0;
  }

  return {
    counters,
    add,
    sample,
    snapshot,
    reset,
    get sampleCount() { return samples.length; },
  };
}

/**
 * 把已有中继内核的 stats 镜像成统一统计。
 * 内核继续按自己的方式累加，这里只读不写（`add` 也会写回同一个对象）。
 */
function mirrorStats(externalStats, options = {}) {
  if (!externalStats || typeof externalStats !== 'object') {
    throw new Error('mirrorStats 需要一个统计对象');
  }
  const stats = createStats({ ...options, mirror: externalStats });
  // 未出现的字段补零，保证 snapshot 的键集合稳定
  for (const key of Object.keys(emptyCounters())) {
    if (externalStats[key] === undefined) externalStats[key] = 0;
  }
  return stats;
}

module.exports = {
  MAX_SAMPLES,
  MIN_SAMPLE_INTERVAL_MS,
  emptyCounters,
  createStats,
  mirrorStats,
};
