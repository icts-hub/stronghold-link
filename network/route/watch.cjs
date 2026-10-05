'use strict';
// ============================================================================
// Stronghold Link — 中继路由监看（PHASE 9/10 的真实测量源）
//
// 把「路由监督器」接到唯一能在本机真实测量的候选上：Stronghold Relay 自检。
// 每轮探测会真的起一次中继服务端 + 两个客户端并测 RTT/抖动/丢包，
// 因此这里的数据全部是实测值；其余候选（本地中继 / Steam / 直连）没有样本，
// 由 RouteManager 如实视为"未测量"，不会因为探测不到就被当成 0 分而误踢出。
//
// 注意开销：每轮探测都会起临时端口与两个客户端，间隔不宜太短（默认 15 秒）。
// ============================================================================

const { createRouteSupervisor } = require('./supervisor.cjs');
const { runRelaySelfTest } = require('../relay/selftest.cjs');
const { UNMEASURED_REASONS } = require('../routes.cjs');

const DEFAULT_INTERVAL = 15000;

/** 候选清单：中继两条可本机实测，其余如实标为未测量。 */
function defaultCandidates() {
  return [
    { id: 'sl-relay-host', name: 'Stronghold Relay（房主）' },
    { id: 'sl-relay-joiner', name: 'Stronghold Relay（加入者）' },
    { id: 'local-tcp-host', name: '本地 TCP 中继（房主）' },
    { id: 'local-udp-host', name: '本地 UDP 中继（房主）' },
    { id: 'steam-p2p-host', name: 'Steam P2P（房主）' },
    { id: 'direct-udp-host', name: '直连 UDP（房主）' },
  ];
}

/**
 * @param {object} [options]
 * @param {number} [options.intervalMs]  探测间隔（默认 15 秒）
 * @param {number} [options.pings]       每轮心跳次数
 * @param {Function} [options.measure]   注入测量函数（测试用）
 * @param {Function} [options.onRouteChanged]
 * @param {object} [options.timers]
 * @param {Function} [options.now]
 */
function createRelayRouteWatch({
  intervalMs = DEFAULT_INTERVAL,
  pings = 4,
  measure = null,
  onRouteChanged = null,
  timers = null,
  now = Date.now,
  candidates = null,
} = {}) {
  const measureOnce = measure || (() => runRelaySelfTest({ pings }));
  const measured = { ok: false, last: null, lastAt: null, failures: 0 };

  async function probeRelay() {
    let out = null;
    try {
      out = await measureOnce();
    } catch (err) {
      measured.failures += 1;
      return null;                       // 探测异常：这一轮没有样本
    }
    if (!out || !out.measured) {
      measured.failures += 1;
      measured.ok = false;
      return null;                       // 没测到就不写数
    }
    measured.ok = true;
    measured.last = { rtt: out.rtt, jitter: out.jitter, packetLoss: out.packetLoss, samples: out.samples, scope: out.scope };
    measured.lastAt = now();
    return { rtt: out.rtt, jitter: out.jitter, packetLoss: out.packetLoss, measured: true, samples: out.samples };
  }

  const supervisor = createRouteSupervisor({
    intervalMs,
    timers,
    now,
    candidates: candidates || defaultCandidates(),
    onRouteChanged,
    sources: [
      { id: 'sl-relay-host', probe: probeRelay },
      { id: 'sl-relay-joiner', probe: probeRelay },
    ],
  });

  function snapshot() {
    const base = supervisor.snapshot();
    return {
      ...base,
      measurement: { ...measured },
      scope: 'loopback',
      note: '每轮探测都会真实起一次本机中继并测 RTT；未列出的候选按未测量处理，不会被当成 0 分',
      unmeasuredReasons: UNMEASURED_REASONS,
    };
  }

  return {
    start: () => supervisor.start(),
    stop: () => supervisor.stop(),
    poll: () => supervisor.poll(),
    snapshot,
    supervisor,
    get running() { return supervisor.running; },
  };
}

module.exports = { DEFAULT_INTERVAL, defaultCandidates, createRelayRouteWatch };
