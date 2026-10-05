'use strict';
// ============================================================================
// Stronghold Link — NetworkQuality（网络质量测量）
//
// 只做一件事：把「探针样本」换算成 RTT / 抖动 / 丢包。
//   * 没有任何样本时 measured=false，界面必须显示 NOT MEASURED；
//     这里不会返回 0 去冒充"质量很好"。
//   * 抖动按 RFC 3550 思路：相邻两次 RTT 差值的平均绝对值。
//   * 丢包按窗口内的实际收发比：1 - received / sent（sent=0 时为 null）。
//   * 统计量用中位数做头条值（抗尖峰），同时给出均值/最小/最大供排查。
// ============================================================================

const DEFAULT_WINDOW = 32;

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function round(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * 创建质量测量容器。
 *
 * @param {object} [options]
 * @param {number} [options.window]  参与统计的最近样本数
 * @param {Function} [options.now]
 */
function createQuality({ window = DEFAULT_WINDOW, now = Date.now } = {}) {
  let rtts = [];
  let sent = 0;
  let received = 0;
  let lastAt = null;

  /**
   * 记录一次探针往返。
   * @param {object} input
   * @param {number} [input.rttMs]  往返毫秒；丢包（无应答）时为 null/undefined
   * @param {number} [input.sent]   本次探针发出的包数（默认 1）
   * @param {number} [input.received] 收到的应答数（有 rttMs 时默认 1，否则 0）
   */
  function record({ rttMs = null, sent: sentPackets = 1, received: receivedPackets = null, at = now() } = {}) {
    const sentCount = Math.max(0, Number(sentPackets) || 0);
    const gotAnswer = Number.isFinite(rttMs) && rttMs >= 0;
    const receivedCount = receivedPackets === null ? (gotAnswer ? 1 : 0) : Math.max(0, Number(receivedPackets) || 0);
    sent += sentCount;
    received += Math.min(receivedCount, sentCount || receivedCount);
    if (gotAnswer) {
      rtts.push(rttMs);
      if (rtts.length > window) rtts.splice(0, rtts.length - window);
    }
    lastAt = at;
    return snapshot();
  }

  function snapshot() {
    const measured = rtts.length > 0 || sent > 0;
    const jitterValues = [];
    if (rtts.length >= 2) {
      for (let i = 1; i < rtts.length; i += 1) jitterValues.push(Math.abs(rtts[i] - rtts[i - 1]));
    }
    const packetLoss = sent > 0 ? round(1 - received / sent, 4) : null;
    return {
      measured,
      samples: rtts.length,
      rtt: round(median(rtts)),
      rttAvg: round(mean(rtts)),
      rttMin: rtts.length ? round(Math.min(...rtts)) : null,
      rttMax: rtts.length ? round(Math.max(...rtts)) : null,
      jitter: jitterValues.length ? round(mean(jitterValues)) : (rtts.length ? 0 : null),
      packetLoss,
      sent,
      received,
      at: lastAt,
    };
  }

  function reset() {
    rtts = [];
    sent = 0;
    received = 0;
    lastAt = null;
  }

  return { record, snapshot, reset, get sampleCount() { return rtts.length; } };
}

/**
 * 用一个 Provider 的往返探测能力做测量：发送探针 → 等应答 → 记录 RTT。
 * 只做编排，不做网络；真正的收发由调用方给的 send/wait 完成（便于测试与复用）。
 *
 * @param {object} options
 * @param {(payload: Buffer) => any} options.send      发出一个探针
 * @param {(timeoutMs: number) => Promise<number|null>} options.waitOnce 等一次应答，超时返回 null
 * @param {object} [options.quality]                   复用的质量容器
 */
function createProber({ send, waitOnce, quality = createQuality(), timeoutMs = 1200, now = Date.now } = {}) {
  if (typeof send !== 'function' || typeof waitOnce !== 'function') {
    throw new Error('createProber 需要 send 与 waitOnce 两个函数');
  }
  /** 跑一轮探针（默认 3 个样本），返回本轮快照。 */
  async function round({ count = 3 } = {}) {
    for (let i = 0; i < count; i += 1) {
      const started = now();
      let payload;
      try {
        payload = Buffer.from(`SHLQ${started.toString(36)}${i}`);
        send(payload);
      } catch (err) {
        quality.record({ rttMs: null, sent: 1, received: 0 });
        continue;
      }
      let answer = null;
      try {
        answer = await waitOnce(timeoutMs);
      } catch (err) {
        answer = null;
      }
      quality.record({ rttMs: answer === null ? null : now() - started, sent: 1, received: answer === null ? 0 : 1 });
    }
    return quality.snapshot();
  }
  return { round, quality, snapshot: () => quality.snapshot(), reset: () => quality.reset() };
}

module.exports = {
  DEFAULT_WINDOW,
  createQuality,
  createProber,
  // 导出纯函数便于单测与复用
  median,
  mean,
};
