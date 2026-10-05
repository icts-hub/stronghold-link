'use strict';
// ============================================================================
// Stronghold Link — 路径评分
//
// 把 NetworkQuality 的测量值换算成 0–100 的可比较分数，供 RouteManager 选路。
//
// 三条规则：
//   1. 没测量就没有分数：任何一项是 null 就不参与计分，权重按剩余项归一，
//      全部为 null 时 score = null（宁可不选，也不拿"默认满分"去骗人）。
//   2. 权重可配置：延迟/丢包/抖动/可靠性四档，默认值见 DEFAULT_WEIGHTS。
//   3. 结果必须能解释：除了分数还给出每一部分的得分与人话原因，供界面与日志使用。
//
// 曲线（故意用直线，便于预期与排查）：
//   延迟   20ms 及以下满分，250ms 及以上 0 分
//   丢包   0% 满分，10% 及以上 0 分
//   抖动   2ms 及以下满分，80ms 及以上 0 分
//   可靠性 直接使用传入的 0–1（例如 1 - failed/total）
// ============================================================================

const DEFAULT_WEIGHTS = Object.freeze({ latency: 45, loss: 30, jitter: 15, reliability: 10 });

const CURVES = Object.freeze({
  latency: { best: 20, worst: 250, unit: 'ms', label: '延迟' },
  loss: { best: 0, worst: 0.1, unit: '', label: '丢包', percent: true },
  jitter: { best: 2, worst: 80, unit: 'ms', label: '抖动' },
});

function clamp01(value) {
  if (!Number.isFinite(value)) return null;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/** 越小越好的线性映射：best → 1 分，worst → 0 分。 */
function linearDown(value, { best, worst }) {
  if (!Number.isFinite(value)) return null;
  if (worst === best) return value <= best ? 1 : 0;
  const t = (value - best) / (worst - best);
  return clamp01(1 - t);
}

function formatPart(key, value) {
  const curve = CURVES[key];
  if (!curve || value === null || value === undefined) return null;
  if (curve.percent) return curve.label + ' ' + (value * 100).toFixed(2) + '%';
  return curve.label + ' ' + Math.round(value) + curve.unit;
}

/**
 * 打分。
 *
 * @param {object} quality                 NetworkQuality 快照（rtt / packetLoss / jitter）
 * @param {object} [options]
 * @param {object} [options.weights]       覆盖默认权重
 * @param {number} [options.reliability]   0–1；未知就不传（不参与计分）
 * @param {string} [options.id]            候选标识，原样带回
 */
function scoreQuality(quality, { weights = DEFAULT_WEIGHTS, reliability = null, id = null } = {}) {
  const q = quality || {};
  const parts = {
    latency: linearDown(q.rtt, CURVES.latency),
    loss: linearDown(q.packetLoss, CURVES.loss),
    jitter: linearDown(q.jitter, CURVES.jitter),
    reliability: reliability === null || reliability === undefined ? null : clamp01(Number(reliability)),
  };

  const measured = Object.values(parts).some((v) => v !== null);
  if (!measured) {
    return {
      id,
      score: null,
      measured: false,
      parts: { latency: null, loss: null, jitter: null, reliability: null },
      weightsUsed: {},
      reasons: ['未测量：没有可用的延迟/丢包/抖动数据'],
      source: { rtt: null, packetLoss: null, jitter: null, reliability: null },
    };
  }

  // 只对参与计分的项做权重归一：缺项不是"0 分"，而是"不参与"
  let totalWeight = 0;
  const weightsUsed = {};
  for (const key of Object.keys(parts)) {
    if (parts[key] === null) continue;
    const w = Number(weights[key]);
    if (!Number.isFinite(w) || w <= 0) continue;
    weightsUsed[key] = w;
    totalWeight += w;
  }
  if (totalWeight === 0) {
    return {
      id,
      score: null,
      measured: false,
      parts,
      weightsUsed: {},
      reasons: ['未测量：四项权重都为 0，无法评分'],
      source: { rtt: q.rtt ?? null, packetLoss: q.packetLoss ?? null, jitter: q.jitter ?? null, reliability },
    };
  }

  let score = 0;
  for (const [key, weight] of Object.entries(weightsUsed)) {
    score += parts[key] * (weight / totalWeight);
  }

  const reasons = [];
  for (const key of ['latency', 'loss', 'jitter']) {
    const text = formatPart(key, key === 'latency' ? (q.rtt ?? null) : key === 'loss' ? (q.packetLoss ?? null) : (q.jitter ?? null));
    reasons.push(text === null ? '未测量：' + CURVES[key].label : text);
  }
  reasons.push(reliability === null || reliability === undefined
    ? '未测量：可靠性'
    : '可靠性 ' + Math.round(parts.reliability * 100) + '%');

  return {
    id,
    score: Math.round(clamp01(score) * 100),
    measured: true,
    parts,
    weightsUsed,
    reasons,
    source: { rtt: q.rtt ?? null, packetLoss: q.packetLoss ?? null, jitter: q.jitter ?? null, reliability },
  };
}

/**
 * 给多个候选排序：分数高的在前，未测量的排在最后（不是最前）。
 * 同分保持输入顺序（稳定排序），便于界面展示可预期。
 */
function rankCandidates(candidates = [], options = {}) {
  return candidates
    .map((candidate, index) => {
      const result = scoreQuality(candidate.quality, { ...options, id: candidate.id, reliability: candidate.reliability ?? null });
      return { ...result, index, name: candidate.name || candidate.id || null };
    })
    .sort((a, b) => {
      const av = a.score === null ? Number.NEGATIVE_INFINITY : a.score;
      const bv = b.score === null ? Number.NEGATIVE_INFINITY : b.score;
      if (av === bv) return a.index - b.index;
      return bv - av;
    });
}

module.exports = { DEFAULT_WEIGHTS, CURVES, linearDown, scoreQuality, rankCandidates };
