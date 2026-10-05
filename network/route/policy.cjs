'use strict';
// ============================================================================
// Stronghold Link — 多通道路由策略（PHASE 9/10 的开关骨架）
//
// 目的：把"是否启用会话层多通道选路"变成**显式开关**，默认关闭。
// 关闭时行为与重构前后完全一致（只建主通道），这样这个功能的每一步都能安全落地。
//
// 见 docs/多通道选路设计.md。
// ============================================================================

const DEFAULT_POLICY = Object.freeze({
  enabled: false,          // 默认关闭：关闭时只建主通道，行为逐字节不变
  degradeBelow: 55,        // 主通道低于此分视为劣化
  switchMargin: 12,        // 备用需高出这么多分才值得切
  minObservationMs: 4000,  // 最小观察窗
  cooldownMs: 15000,       // 切换冷却
  standby: 'none',         // none = 不预建备用；relay = 预建中继备用通道
});

const STANDBY_MODES = Object.freeze(['none', 'relay']);

function clampSeconds(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * 归一化策略：非法值一律回落到默认，并且**不因为传了奇怪的值就悄悄打开开关**。
 * @param {object} [input]
 */
function normalizeRoutePolicy(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const enabled = raw.enabled === true;                      // 只有明确 true 才开
  const standby = STANDBY_MODES.includes(raw.standby) ? raw.standby : DEFAULT_POLICY.standby;
  return {
    enabled,
    // 关闭时把其余参数也保持为默认值，避免"关了开关但参数还在影响别处"
    degradeBelow: clampSeconds(raw.degradeBelow, DEFAULT_POLICY.degradeBelow, 0, 100),
    switchMargin: clampSeconds(raw.switchMargin, DEFAULT_POLICY.switchMargin, 0, 100),
    minObservationMs: clampSeconds(raw.minObservationMs, DEFAULT_POLICY.minObservationMs, 0, 600000),
    cooldownMs: clampSeconds(raw.cooldownMs, DEFAULT_POLICY.cooldownMs, 0, 600000),
    standby: enabled ? standby : DEFAULT_POLICY.standby,
  };
}

/** 给界面用的一句话说明（明确未实现的状态）。 */
function describeRoutePolicy(policy) {
  const p = normalizeRoutePolicy(policy);
  if (!p.enabled) return '多通道选路未启用（默认）：只建主通道，切换不会重建会话通道';
  return '多通道选路已启用：备用模式 ' + p.standby
    + '，阈值 ' + p.degradeBelow + ' 分，滞回 ' + p.switchMargin + ' 分，观察窗 '
    + Math.round(p.minObservationMs / 1000) + 's，冷却 ' + Math.round(p.cooldownMs / 1000) + 's'
    + '（切换会中断连接，需要重连）';
}

module.exports = { DEFAULT_POLICY, STANDBY_MODES, normalizeRoutePolicy, describeRoutePolicy };
