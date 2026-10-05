'use strict';
// ============================================================================
// Stronghold Link — 通道迁移动作计划（多通道选路最后一步的执行半）
//
// 只产出**有序动作清单与回滚清单**，不自己执行。配合 route/standby.cjs 的决策，
// 将来接线进 session.cjs 时只剩"照着清单执行"这一步，风险面最小。
//
// 为什么顺序是"先停主、再绑备"：同一个入口端口不能双绑；因此切换必然有一个
// 毫秒级空档。**不承诺无缝迁移** —— 这句话会出现在计划里，也会被写进日志与界面。
// ============================================================================

const STEPS = Object.freeze({
  STOP: 'stop-channel',
  BIND: 'bind-channel',
  VERIFY: 'verify-channel',
  PROMOTE: 'promote-channel',
});

/**
 * @param {object} options
 * @param {object} options.current    当前（主）通道 { id, provider, port, ready }
 * @param {object} options.standby    备用通道 { id, provider, port, ready }
 * @param {boolean} [options.samePort] 备用是否要接管同一入口端口（默认 true）
 * @param {number} [options.healthTimeoutMs]
 * @param {boolean} [options.allowInterrupt] 是否接受切换期中断（默认 true；false 时拒绝切换）
 */
function planMigration({
  current = null,
  standby = null,
  samePort = true,
  healthTimeoutMs = 3000,
  allowInterrupt = true,
} = {}) {
  const notes = [
    '切换会中断现有连接，客户端需要重连（不承诺无缝迁移）',
  ];

  if (!standby) {
    return { ok: false, reason: '没有备用通道可切换', steps: [], rollback: [], notes };
  }
  if (!current) {
    return { ok: false, reason: '没有当前通道（应走初始选路而不是切换）', steps: [], rollback: [], notes };
  }
  if (current.provider && standby.provider && current.provider === standby.provider) {
    return { ok: false, reason: '备用与当前是同一个提供方：切换没有意义', steps: [], rollback: [], notes };
  }
  if (standby.ready === false) {
    return { ok: false, reason: '备用通道尚未就绪，不能切换', steps: [], rollback: [], notes };
  }
  if (!allowInterrupt) {
    return { ok: false, reason: '策略不接受切换期中断：已拒绝本次切换', steps: [], rollback: [], notes };
  }

  const targetPort = samePort ? (current.port || standby.port || null) : (standby.port || null);
  if (samePort && !targetPort) {
    return { ok: false, reason: '同端口接管需要已知入口端口，但当前与备用都没有端口信息', steps: [], rollback: [], notes };
  }

  const steps = [
    { action: STEPS.STOP, channel: current.id, provider: current.provider, port: current.port || null, reason: '先释放入口端口（同端口不能双绑）' },
    { action: STEPS.BIND, channel: standby.id, provider: standby.provider, port: targetPort, reason: '让备用接管入口端口' },
    { action: STEPS.VERIFY, channel: standby.id, port: targetPort, timeoutMs: healthTimeoutMs, reason: '确认备用已在监听并可用' },
    { action: STEPS.PROMOTE, channel: standby.id, provider: standby.provider, reason: '标记为新主通道并抛出 NETWORK_ROUTE_CHANGED' },
  ];

  // 回滚：把原主通道按原端口重新拉起；不做静默失败
  const rollback = [
    { action: STEPS.BIND, channel: current.id, provider: current.provider, port: current.port || targetPort, reason: '回滚：把原主通道重新监听回原端口' },
    { action: STEPS.VERIFY, channel: current.id, port: current.port || targetPort, timeoutMs: healthTimeoutMs, reason: '回滚后确认原主通道可用' },
  ];

  notes.push('回滚仅在 BIND 或 VERIFY 失败时执行；回滚失败必须如实报错，不允许两条通道都停着');
  return {
    ok: true,
    reason: '可以切换：' + (current.provider || current.id) + ' → ' + (standby.provider || standby.id),
    targetPort,
    samePort,
    steps,
    rollback,
    notes,
  };
}

/** 把计划转成可读的多行文本（用于会话日志）。 */
function describeMigration(plan) {
  if (!plan || !plan.ok) return '不执行切换：' + ((plan && plan.reason) || '计划无效');
  const lines = [plan.reason, '入口端口 ' + (plan.targetPort === null ? '（各自端口）' : plan.targetPort)];
  plan.steps.forEach((s, i) => lines.push((i + 1) + '. ' + s.action + ' → ' + (s.provider || s.channel)));
  plan.notes.forEach((n) => lines.push('注：' + n));
  return lines.join('\n');
}

module.exports = { STEPS, planMigration, describeMigration };
