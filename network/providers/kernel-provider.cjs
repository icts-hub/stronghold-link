'use strict';
// ============================================================================
// Stronghold Link — 内核 → Provider 适配层
//
// 现有 TCP / UDP / Steam 内核是成熟的（有完整测试与真机验证），重构的目标是
// **包装而不是重写**。这一层把内核对象（{ stats, ready, stop } + onEvent 回调）
// 适配成统一 Provider 契约：
//
//   * ready 语义原样保留：Provider 暴露 .ready，交给 session 的 _awaitReady 处理
//     超时与友好报错，报错文案与重构前完全一致。
//   * 状态由 ready 的真实结果驱动（deferReady）：监听成功才 READY，失败进 ERROR。
//   * 统计直接镜像内核的 stats（只读直取），并按需附加内核独有字段
//     （例如 encrypted / sessionId / totalPeers），不复制、不改写内核计数。
//   * 内核事件按原样转发（type/payload 不变），session 的日志行为不受影响。
// ============================================================================

const { createProvider, PROVIDER_STATES } = require('./provider.cjs');
const { mirrorStats } = require('../stats.cjs');
const { createRawSocketMeter } = require('../route-report.cjs');

/**
 * @param {object} options
 * @param {string} options.id                  Provider id（如 'local-tcp-host'）
 * @param {string} options.name                界面显示名
 * @param {object} options.capabilities        能力声明
 * @param {Function} options.createKernel      (options) => kernel；kernel 需有 ready/stats/stop
 * @param {Function} [options.kernelOptions]   (input) => 传给 createKernel 的选项
 * @param {Function} [options.stopKernel]      (kernel) => Promise；默认调用 kernel.stop()
 * @param {Function} [options.extras]          (kernelStats) => 附加字段
 * @param {Function} [options.send]            (kernel, data, {channel}) => any；不提供则明确报错
 * @param {string}   [options.sendUnsupported] 不支持发送时的说明文案
 */
function createKernelProvider({
  id,
  name,
  capabilities,
  createKernel,
  kernelOptions = () => ({}),
  stopKernel = async (kernel) => (typeof kernel.stop === 'function' ? kernel.stop() : undefined),
  extras = () => ({}),
  send = null,
  sendUnsupported = '这条通道按连接转发字节流，不提供按消息发送',
}) {
  if (typeof createKernel !== 'function') throw new Error('createKernelProvider 需要 createKernel');

  let kernel = null;
  let provider = null;
  let stats = null;

  const implementation = {
    // ready 由内核驱动，包装层不抢跑
    deferReady: true,

    async start(input = {}) {
      const options = kernelOptions(input) || {};
      const onEvent = (type, payload) => {
        if (!provider) return;
        const body = payload || {};
        // 既有消费者习惯读顶层字段（payload.reason 等），这里两种读法都保留
        provider._emit(type, { ...body, payload: body });
      };
      kernel = createKernel({ ...options, onEvent });
      stats = mirrorStats(kernel.stats || {});
      const ready = kernel.ready;
      if (ready && typeof ready.then === 'function') {
        provider.ready = ready.then(
          (result) => { provider._markReady(result); return result; },
          (err) => { provider._fail(err); throw err; },
        );
        // 避免未处理的 rejection：真正的错误由 session 的 _awaitReady 消费
        provider.ready.catch(() => {});
      } else {
        provider.ready = Promise.resolve({});
        provider._markReady({});
      }
      return { kernel: true };
    },

    async stop() {
      if (!kernel) return { stopped: true, alreadyStopped: true };
      const current = kernel;
      kernel = null;
      stats = null;
      return stopKernel(current);
    },

    send: send
      ? (data, ctx) => send(kernel, data, ctx)
      : () => { throw new Error(sendUnsupported); },

    describe() {
      return {
        id,
        name,
        kernel: kernel ? 'attached' : 'detached',
        ready: Boolean(kernel && kernel.ready),
      };
    },
  };

  provider = createProvider({ id, name, capabilities, implementation });

  // 统计：镜像内核计数 + 内核独有字段（encrypted / sessionId / totalPeers 等）
  const baseGetStats = provider.getStats;
  provider.getStats = () => {
    if (!stats) return { ...baseGetStats(), ...extras({}) };
    return { ...stats.snapshot(), ...(extras(kernel && kernel.stats ? kernel.stats : {}) || {}) };
  };

  /** 内核的真实统计对象（供需要直读的调用方使用，例如测试断言）。 */
  provider.getKernelStats = () => (kernel && kernel.stats ? kernel.stats : null);
  provider.getKernel = () => kernel;

  /**
   * 线路报告。内核自己有 route() 就用内核的；没有就按 Provider 类型如实标注。
   * 本地中继与直连 TCP 是单一链路，不存在直连/中继之分，不冒充 UNKNOWN。
   * 无论走哪条分支都附带 rawSocket：直接数本地 socket 的收发字节，
   * 这是"RAW SOCKET RX"，用来和 Steam 侧自报的速率对照。
   */
  const rawMeter = createRawSocketMeter();
  provider.route = () => {
    const raw = rawMeter.read(kernel && kernel.stats ? kernel.stats : {});
    if (kernel && typeof kernel.route === 'function') {
      try {
        const report = kernel.route();
        if (report && typeof report === 'object') {
          // 内核自己给了 rawSocket 就用内核的，否则用本地 socket 计数
          return { ok: true, provider: id, ...report, rawSocket: report.rawSocket || raw };
        }
      } catch (err) {
        return { ok: false, provider: id, reason: `线路读取失败：${err.message}`, route: 'UNKNOWN', routeLabel: 'UNKNOWN', rawSocket: raw };
      }
    }
    if (id.startsWith('local-')) return { ok: true, provider: id, route: 'LOCAL_TCP', routeLabel: 'LOCAL TCP', relayed: false, rawSocket: raw, peers: [] };
    if (id.startsWith('direct-')) return { ok: true, provider: id, route: 'DIRECT_TCP', routeLabel: 'DIRECT TCP', relayed: false, rawSocket: raw, peers: [] };
    return { ok: false, provider: id, reason: 'PROVIDER_HAS_NO_ROUTE', route: 'UNKNOWN', routeLabel: 'UNKNOWN', rawSocket: raw, peers: [] };
  };

  provider.ready = Promise.resolve({});

  return provider;
}

module.exports = { createKernelProvider, PROVIDER_STATES };
