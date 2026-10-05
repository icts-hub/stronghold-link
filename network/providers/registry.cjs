'use strict';
// ============================================================================
// Stronghold Link — Provider 注册表
//
// 作用：让「有哪些传输通道」成为数据，而不是散在 session.cjs / 界面里的 if/else。
// 界面（ADAPTERS 页）与 RouteManager 都从这里取清单与能力声明。
//
// 注意：注册表只登记「工厂 + 能力」，不负责启动；启动由 Session/RouteManager 决定。
// ============================================================================

const { defineCapabilities } = require('./provider.cjs');

/** Provider 分类：决定界面分组与 RouteManager 的候选顺序。 */
const PROVIDER_KINDS = Object.freeze({
  LOCAL: 'local',      // 本地中继：需要房主端口可达
  STEAM: 'steam',      // Steam P2P：自带穿透与加密
  DIRECT: 'direct',    // 直连 UDP：打洞/端口映射
  RELAY: 'relay',      // 第三方/自有中继服务器
  NONE: 'none',        // 不做转发（仅连接说明）
});

function createRegistry() {
  const entries = new Map();

  /**
   * 登记一个 Provider。
   * @param {object} entry
   * @param {string} entry.id
   * @param {string} entry.name
   * @param {string} entry.kind   PROVIDER_KINDS
   * @param {Function} entry.create  (options) => provider（经 createProvider 包装过的）
   * @param {object} entry.capabilities
   * @param {boolean} [entry.available] 当前环境是否可用（例如 Steam SDK 是否就绪）
   * @param {string} [entry.unavailableReason]
   */
  function register(entry = {}) {
    const { id, name, kind = PROVIDER_KINDS.LOCAL, create, capabilities, available = true, unavailableReason = null } = entry;
    if (!id || typeof id !== 'string') throw new Error('注册 Provider 需要 id');
    if (typeof create !== 'function') throw new Error(`Provider ${id} 需要一个 create 工厂函数`);
    if (!Object.values(PROVIDER_KINDS).includes(kind)) throw new Error(`Provider ${id} 的 kind 非法：${kind}`);
    entries.set(id, {
      id,
      name: name || id,
      kind,
      create,
      capabilities: defineCapabilities(capabilities),
      available: available !== false,
      unavailableReason: available === false ? (unavailableReason || '当前环境不可用') : null,
    });
    return entries.get(id);
  }

  function get(id) {
    const entry = entries.get(id);
    if (!entry) throw new Error(`未注册的 Provider：${id}`);
    return entry;
  }

  function has(id) {
    return entries.has(id);
  }

  function list({ kind = null, onlyAvailable = false } = {}) {
    return [...entries.values()]
      .filter((entry) => (kind ? entry.kind === kind : true))
      .filter((entry) => (onlyAvailable ? entry.available : true));
  }

  /** 界面/日志用：把能力声明摊平成可读文本，不夸大。 */
  function describeAll() {
    return list().map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      available: entry.available,
      unavailableReason: entry.unavailableReason,
      transports: entry.capabilities.transports.join(' / ') || '—',
      capabilities: entry.capabilities,
      summary: [
        entry.capabilities.transports.join('/') || '—',
        entry.capabilities.reliable ? 'reliable' : null,
        entry.capabilities.unreliable ? 'unreliable' : null,
        entry.capabilities.p2p ? 'p2p' : 'forward',
        entry.capabilities.natTraversal ? 'nat-traversal' : null,
        `enc:${entry.capabilities.encryption}`,
      ].filter(Boolean).join(' · '),
    }));
  }

  function size() {
    return entries.size;
  }

  return { register, get, has, list, describeAll, size, entries };
}

/** 进程级默认注册表：各 Provider 在各自模块里自登记，避免中心化 import 列表。 */
const defaultRegistry = createRegistry();

module.exports = { PROVIDER_KINDS, createRegistry, defaultRegistry };
