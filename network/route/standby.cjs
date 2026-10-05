'use strict';
// ============================================================================
// Stronghold Link — 备用通道决策（多通道选路第 1.5 步）
//
// 只做决策，不做动作：给定策略、现有通道、可用候选，回答
// 「要不要建备用通道、建哪一条、为什么」。
//
// 这样设计的原因：真正建立/销毁通道要动 session.cjs 里最敏感的一段代码，
// 先把决策抽出来用纯函数测透，接线时只剩"照着决定去执行"这一步。
//
// 诚实约定：任何条件不满足都返回 create=false **并说明原因**，
// 不做"尽力而为"的静默降级。
// ============================================================================

const { normalizeRoutePolicy } = require('./policy.cjs');

/** 备选可用作备用通道的候选类型（目前只有中继具备包级探测能力）。 */
const STANDBY_PROVIDER_KINDS = Object.freeze({ relay: 'relay' });

/**
 * @param {object} options
 * @param {object} [options.policy]      路由策略（未归一化也可）
 * @param {Array}  [options.channels]    现有通道 [{ id, provider, standby }]
 * @param {Array}  [options.candidates]  可用候选 [{ id, kind, available }]
 * @param {boolean} [options.sessionRunning]
 * @param {number} [options.maxStandby]  允许的备用通道数量上限（默认 1）
 */
function planStandby({ policy = null, channels = [], candidates = [], sessionRunning = true, maxStandby = 1 } = {}) {
  const p = normalizeRoutePolicy(policy);
  const notes = [];

  if (!p.enabled) {
    return { create: false, provider: null, reason: '多通道选路未启用（默认）：不会建立备用通道', notes, policy: p };
  }
  if (!sessionRunning) {
    return { create: false, provider: null, reason: '会话未运行：没有可依附的主通道', notes, policy: p };
  }
  if (p.standby === 'none') {
    return { create: false, provider: null, reason: '策略未要求备用通道（standby = none）', notes, policy: p };
  }

  const existing = channels.filter((c) => c && c.standby === true);
  if (existing.length >= maxStandby) {
    return {
      create: false,
      provider: null,
      reason: '已存在备用通道（' + existing.length + ' 条，上限 ' + maxStandby + '）',
      notes,
      policy: p,
    };
  }

  const wantedKind = STANDBY_PROVIDER_KINDS[p.standby] || null;
  if (!wantedKind) {
    return { create: false, provider: null, reason: '未知的备用模式：' + p.standby, notes, policy: p };
  }

  // 同一提供方不能既当主又当备（否则等同于没备）
  const inUse = new Set(channels.map((c) => c && c.provider).filter(Boolean));
  const usable = candidates.filter((c) => c
    && c.kind === wantedKind
    && c.available !== false
    && !inUse.has(c.id)
    && !(c.capabilities && c.capabilities.requiresReachablePort === true && c.reachable === false));

  if (!usable.length) {
    const unavailable = candidates.filter((c) => c && c.kind === wantedKind);
    if (unavailable.length) {
      notes.push('同类候选存在但当前不可用：' + unavailable.map((c) => c.id + '（' + (c.unavailableReason || '不可用') + '）').join('、'));
    }
    return {
      create: false,
      provider: null,
      reason: '没有可用的 ' + p.standby + ' 候选可作备用通道',
      notes,
      policy: p,
    };
  }

  // 选第一个可用候选（顺序由调用方决定；这里不做质量排序，质量由 RouteManager 负责）
  const picked = usable[0];
  notes.push('备用通道建立后不暴露给客户端，仅房主内部持有；切换时才接管入口');
  notes.push('切换会中断连接，客户端需要重连（不承诺无缝迁移）');
  return { create: true, provider: picked.id, kind: picked.kind, reason: '按策略建立备用通道：' + picked.id, notes, policy: p };
}

module.exports = { STANDBY_PROVIDER_KINDS, planStandby };
