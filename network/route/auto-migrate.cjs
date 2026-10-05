'use strict';
// ============================================================================
// Stronghold Link — 路由事件的自动迁移处理（多通道选路的自动触发）
//
// 作用：把"监督器发现了 NETWORK_ROUTE_CHANGED"转成"要不要真的迁移会话通道"。
//
// 安全设计：默认策略下 **什么都不做**（policy.enabled 为假时直接拒绝并记日志），
// 因此接线本身不会改变任何既有行为；只有显式开启多通道策略后才会尝试迁移。
//
// 返回结构化结果，便于调用方（主进程）记录与界面展示。
// ============================================================================

/**
 * @param {object} options
 * @param {object} options.event    路由切换事件 { type, from, to, reason, transportRebuilt }
 * @param {object} [options.session] 会话实例（需有 migrateToStandby / note / getRoutePolicy）
 * @param {Function} [options.log]  外部日志（默认 console.log）
 */
async function handleRouteChange({ event = null, session = null, log = null } = {}) {
  const say = typeof log === 'function' ? log : (msg) => console.log(msg);
  if (!event || event.type !== 'NETWORK_ROUTE_CHANGED') {
    return { handled: false, attempted: false, reason: '不是路由切换事件' };
  }

  if (!session) {
    say('[route] 收到切换事件但没有会话：仅记录，不做迁移');
    return { handled: true, attempted: false, reason: '没有会话可迁移' };
  }
  if (typeof session.migrateToStandby !== 'function') {
    say('[route] 会话不支持迁移（版本不匹配）：仅记录');
    return { handled: true, attempted: false, reason: '会话不支持迁移' };
  }

  // 默认策略（未启用）在这里就被挡住：不会碰任何通道
  let enabled = false;
  try {
    const policy = typeof session.getRoutePolicy === 'function' ? session.getRoutePolicy() : null;
    enabled = Boolean(policy && policy.enabled);
  } catch (err) {
    enabled = false;
  }
  if (!enabled) {
    say('[route] 多通道选路未启用：收到切换事件但不迁移（策略默认关闭）');
    return { handled: true, attempted: false, reason: '多通道选路未启用（默认）' };
  }

  try {
    const out = await session.migrateToStandby();
    if (out && out.ok) {
      say('[route] 已按事件完成迁移：' + (event.from || '?') + ' → ' + (event.to || '?') + '（连接会中断，客户端需重连）');
      return { handled: true, attempted: true, migrated: true, steps: out.steps || [] };
    }
    say('[route] 迁移未执行：' + ((out && out.reason) || '未知原因') + (out && out.rolledBack ? '（已回滚）' : ''));
    return { handled: true, attempted: true, migrated: false, reason: (out && out.reason) || '未知原因', rolledBack: Boolean(out && out.rolledBack) };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    say('[route] 迁移过程抛错：' + message);
    return { handled: true, attempted: true, migrated: false, reason: message, error: true };
  }
}

module.exports = { handleRouteChange };
