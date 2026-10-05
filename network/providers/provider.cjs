'use strict';
// ============================================================================
// Stronghold Link — NetworkProvider 契约
//
// 为什么需要它：现在 session.cjs 直接 require 三个中继内核，用 if/else 分派，
// 上层（尤其界面与将来的 RouteManager）被迫知道「Steam / UDP / Relay」的差别。
// 这一层把差别收进 Provider：上层只会看到
//
//   start() / stop()
//   send(data, { channel })
//   onMessage(handler) / onEvent(handler)
//   getState() / getStats() / getQuality() / getCapabilities() / describe()
//
// 三条设计原则：
//   1. 能力显式声明：不支持的能力（例如不可靠通道）必须能被上层查到，
//      调用不支持的能力要**明确报错**，而不是静默降级成可靠通道。
//   2. 状态机统一：idle → starting → ready → stopping → stopped，异常进 error。
//   3. 统计与质量统一：由本层创建（network/stats.cjs、network/route/quality.cjs），
//      Provider 只负责往里写真实数字。
// ============================================================================

const { createStats } = require('../stats.cjs');
const { createQuality } = require('../route/quality.cjs');

const PROVIDER_STATES = Object.freeze({
  IDLE: 'idle',
  STARTING: 'starting',
  READY: 'ready',
  STOPPING: 'stopping',
  STOPPED: 'stopped',
  ERROR: 'error',
});

/** 数据通道语义。可靠=有序不丢；不可靠=允许丢包、低延迟（UDP 游戏流量用）。 */
const CHANNELS = Object.freeze({ RELIABLE: 'reliable', UNRELIABLE: 'unreliable' });

/** 传输类型。用于 RouteManager 按「游戏需要 TCP 还是 UDP」筛路。 */
const TRANSPORTS = Object.freeze({ TCP: 'TCP', UDP: 'UDP' });

const REQUIRED_METHODS = ['start', 'stop', 'send', 'getStats', 'getCapabilities'];
const OPTIONAL_METHODS = ['getQuality', 'getState', 'describe', 'onMessage', 'onEvent', 'probe', 'sendReliable', 'sendUnreliable'];

function normalizeTransports(input) {
  const list = Array.isArray(input) ? input : [];
  const out = [];
  for (const item of list) {
    const value = String(item || '').toUpperCase();
    if (value === TRANSPORTS.TCP || value === TRANSPORTS.UDP) {
      if (!out.includes(value)) out.push(value);
    }
  }
  return out;
}

/**
 * 归一化能力声明。所有字段都有明确默认值（默认「不支持」），
 * 免得某个 Provider 少写一个字段就被当成支持。
 */
function defineCapabilities(input = {}) {
  return Object.freeze({
    transports: Object.freeze(normalizeTransports(input.transports)),
    reliable: input.reliable === true,
    unreliable: input.unreliable === true,
    /** 是否真正的点对点（含 NAT 穿透），false 表示需要可达地址/端口映射 */
    p2p: input.p2p === true,
    /** 是否自带 NAT 穿透（Steam SDR / 打洞）；决定 RouteManager 的期望值 */
    natTraversal: input.natTraversal === true,
    /** 加密来源：psk-aead=我们自己的口令层；steam-transport=Steam 负责；none=明文 */
    encryption: ['psk-aead', 'steam-transport', 'none'].includes(input.encryption) ? input.encryption : 'none',
    /** 单会话最多对端数（0 表示不适用/不限） */
    maxPeers: Number.isFinite(Number(input.maxPeers)) ? Number(input.maxPeers) : 0,
    /** 需要用户自己保证端口可达（没穿透能力时为 true） */
    requiresReachablePort: input.requiresReachablePort === true,
    notes: Array.isArray(input.notes) ? input.notes.map(String) : [],
  });
}

function assertProvider(provider) {
  if (!provider || typeof provider !== 'object') {
    throw new Error('Provider 必须是对象');
  }
  if (!provider.id || typeof provider.id !== 'string') {
    throw new Error('Provider 必须有字符串 id');
  }
  const missing = REQUIRED_METHODS.filter((name) => typeof provider[name] !== 'function');
  if (missing.length) {
    throw new Error(`Provider 缺少必需方法：${missing.join('、')}`);
  }
  const caps = provider.getCapabilities();
  if (!caps || !Array.isArray(caps.transports)) {
    throw new Error('getCapabilities() 必须返回带 transports 数组的能力声明');
  }
  return true;
}

/**
 * 用统一契约包装一个具体实现。
 *
 * @param {object}   options
 * @param {string}   options.id           例如 'local-relay' / 'steam-p2p' / 'direct-udp' / 'sl-relay'
 * @param {string}   options.name         界面显示名
 * @param {object}   options.capabilities defineCapabilities 的输入
 * @param {object}   options.implementation 具体实现，见下方注释
 */
function createProvider({ id, name, capabilities, implementation = {} }) {
  if (!id) throw new Error('createProvider 需要 id');
  const caps = defineCapabilities(capabilities);

  const events = new Set();
  const messageHandlers = new Set();
  const stats = implementation.stats || createStats();
  const quality = implementation.quality || createQuality();

  let state = PROVIDER_STATES.IDLE;
  let lastError = null;
  let startedAt = null;

  function setState(next) {
    if (state === next) return;
    const previous = state;
    state = next;
    emit('state', { provider: id, from: previous, to: next, at: Date.now() });
  }

  function emit(type, payload = {}) {
    const event = { type, provider: id, at: Date.now(), ...payload };
    for (const handler of events) {
      try {
        handler(event);
      } catch (err) {
        // 事件处理器的异常不能影响 Provider 自身
      }
    }
    return event;
  }

  function fail(err) {
    lastError = err && err.message ? err.message : String(err);
    setState(PROVIDER_STATES.ERROR);
    emit('error', { error: { message: lastError } });
    return lastError;
  }

  async function start(input = {}) {
    if (state === PROVIDER_STATES.READY || state === PROVIDER_STATES.STARTING) {
      throw new Error(`${name || id} 已经启动`);
    }
    setState(PROVIDER_STATES.STARTING);
    try {
      const result = typeof implementation.start === 'function' ? await implementation.start(input) : { transport: null };
      startedAt = Date.now();
      if (implementation.deferReady === true) {
        // 就绪由实现驱动（例如内核的 ready promise）：包装层不抢跑，
        // 免得端口还没监听就对外宣称 READY。
        return result;
      }
      setState(PROVIDER_STATES.READY);
      emit('ready', { result });
      return result;
    } catch (err) {
      fail(err);
      throw err;
    }
  }

  async function stop() {
    if (state === PROVIDER_STATES.STOPPED || state === PROVIDER_STATES.IDLE) return { stopped: true, alreadyStopped: true };
    setState(PROVIDER_STATES.STOPPING);
    try {
      const result = typeof implementation.stop === 'function' ? await implementation.stop() : { stopped: true };
      setState(PROVIDER_STATES.STOPPED);
      emit('stopped', { result });
      return result;
    } catch (err) {
      fail(err);
      throw err;
    }
  }

  /**
   * 发送数据。
   * channel 不支持时**抛错**：宁可让上层知道，也不要悄悄换成可靠通道，
   * 否则实时流量会被重传拖成高延迟，而调用方以为走的是不可靠通道。
   */
  function send(data, { channel = CHANNELS.RELIABLE } = {}) {
    if (!Object.values(CHANNELS).includes(channel)) {
      throw new Error(`未知通道：${channel}`);
    }
    if (channel === CHANNELS.UNRELIABLE && !caps.unreliable) {
      throw new Error(`${name || id} 不支持不可靠通道（capabilities.unreliable=false）`);
    }
    if (channel === CHANNELS.RELIABLE && !caps.reliable) {
      throw new Error(`${name || id} 不支持可靠通道（capabilities.reliable=false）`);
    }
    if (state !== PROVIDER_STATES.READY) {
      throw new Error(`${name || id} 尚未就绪（当前状态：${state}）`);
    }
    if (typeof implementation.send !== 'function') {
      throw new Error(`${name || id} 未实现 send`);
    }
    return implementation.send(data, { channel });
  }

  function onMessage(handler) {
    if (typeof handler !== 'function') throw new Error('onMessage 需要函数');
    messageHandlers.add(handler);
    return () => messageHandlers.delete(handler);
  }

  function onEvent(handler) {
    if (typeof handler !== 'function') throw new Error('onEvent 需要函数');
    events.add(handler);
    return () => events.delete(handler);
  }

  /** Provider 内部收到数据时调用（由具体实现接线）。 */
  function deliver(message) {
    for (const handler of messageHandlers) {
      try {
        handler(message);
      } catch (err) {
        // 同上：单个订阅者异常不影响其它订阅者
      }
    }
  }

  function describe() {
    const own = {
      id,
      name: name || id,
      state,
      capabilities: caps,
      transports: caps.transports.join(' / ') || '—',
      startedAt,
      lastError,
    };
    // 实现可以提供额外字段，但包装层的元信息优先（身份与状态必须准确）
    if (typeof implementation.describe === 'function') {
      try {
        return { ...implementation.describe(), ...own };
      } catch (err) {
        return { ...own, describeError: err && err.message ? err.message : String(err) };
      }
    }
    return own;
  }

  /** 由实现调用：确认真正就绪（配合 implementation.deferReady）。 */
  function markReady(result) {
    startedAt = startedAt || Date.now();
    setState(PROVIDER_STATES.READY);
    emit('ready', { result });
    return true;
  }

  const provider = {
    id,
    name: name || id,
    start,
    stop,
    send,
    onMessage,
    onEvent,
    deliver,
    getState: () => state,
    getStats: () => stats.snapshot(),
    getQuality: () => quality.snapshot(),
    getCapabilities: () => caps,
    describe,
    // 供具体实现与测试使用
    _stats: stats,
    _quality: quality,
    _emit: emit,
    _fail: fail,
    _markReady: markReady,
  };

  // 允许实现通过 implementation.attach(provider) 拿到包装后的对象（用于反向接线）
  if (typeof implementation.attach === 'function') implementation.attach(provider);
  assertProvider(provider);
  return provider;
}

module.exports = {
  PROVIDER_STATES,
  CHANNELS,
  TRANSPORTS,
  REQUIRED_METHODS,
  OPTIONAL_METHODS,
  defineCapabilities,
  assertProvider,
  createProvider,
};
