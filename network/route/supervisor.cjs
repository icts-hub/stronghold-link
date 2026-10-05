'use strict';
// ============================================================================
// Stronghold Link — 路由监督器（PHASE 9 监控 + PHASE 10 故障切换）
//
// 职责：按固定间隔从各候选路径取质量样本 → 喂给 RouteManager → 触发决策；
// 切换发生时抛出 NETWORK_ROUTE_CHANGED，交给上层重建传输。
//
// 三条约定：
//   1. 探测失败**不造数**：拿不到样本就跳过这一轮，不写 0、不写默认值；
//   2. 切换事件明确标注 transportRebuilt=true —— 是重建传输，不是无缝迁移；
//   3. 定时器可注入，便于用可控时钟做确定性测试（不依赖真实等待）。
// ============================================================================

const { createRouteManager } = require('./manager.cjs');

const DEFAULT_INTERVAL = 5000;
const ROUTE_CHANGED = 'NETWORK_ROUTE_CHANGED';

/**
 * @param {object} options
 * @param {object} [options.manager]       注入 RouteManager（默认自建）
 * @param {Array}  options.sources         [{ id, probe: async () => quality|null }]
 * @param {number} [options.intervalMs]
 * @param {object} [options.timers]        { setInterval, clearInterval } 注入用
 * @param {Function} [options.now]
 * @param {Function} [options.onRouteChanged] (event) => void
 * @param {Array}  [options.candidates]    候选清单（未给则用 sources 的 id）
 */
function createRouteSupervisor({
  manager = null,
  sources = [],
  intervalMs = DEFAULT_INTERVAL,
  timers = null,
  now = Date.now,
  onRouteChanged = null,
  candidates = null,
} = {}) {
  const mgr = manager || createRouteManager({ now });
  const clock = timers || { setInterval, clearInterval };
  const list = (candidates || sources.map((s) => ({ id: s.id, name: s.id }))).map((c) => ({ id: typeof c === 'string' ? c : c.id, name: (c && c.name) || (typeof c === 'string' ? c : c.id) }));
  mgr.setCandidates(list);

  let running = false;
  let handle = null;
  let polls = 0;
  let probeFailures = 0;
  let lastDecision = null;
  const events = [];

  // 切换事件由 RouteManager 的日志驱动，这里统一转成对外的 NETWORK_ROUTE_CHANGED
  mgr.onEvent((ev) => {
    if (ev.type !== 'route-changed' || !ev.from) return;      // 只转发"切换"，不转发初始选路
    const payload = {
      type: ROUTE_CHANGED,
      at: ev.at || now(),
      from: ev.from,
      to: ev.to,
      name: ev.name || null,
      score: ev.score === undefined ? null : ev.score,
      reason: ev.reason || null,
      transportRebuilt: true,                                  // 明确：重建传输，不是无缝迁移
    };
    events.push(payload);
    if (events.length > 50) events.splice(0, events.length - 50);
    if (typeof onRouteChanged === 'function') {
      try { onRouteChanged(payload); } catch (err) { /* 订阅者异常不影响监督 */ }
    }
  });

  async function poll() {
    polls += 1;
    const measured = [];
    for (const source of sources) {
      if (!source || typeof source.probe !== 'function') continue;
      let quality = null;
      try {
        quality = await source.probe();
      } catch (err) {
        probeFailures += 1;                                    // 如实计数，不造数
        continue;
      }
      if (!quality || quality.measured === false) continue;     // 没样本就跳过这一轮
      mgr.update(source.id, quality, { reliability: source.reliability === undefined ? null : source.reliability });
      measured.push(source.id);
    }
    lastDecision = mgr.tick();
    return { measured, decision: lastDecision };
  }

  function start() {
    if (running) return snapshot();
    running = true;
    handle = clock.setInterval(() => { poll().catch(() => { probeFailures += 1; }); }, intervalMs);
    poll().catch(() => { probeFailures += 1; });
    return snapshot();
  }

  function stop() {
    if (handle !== null) { try { clock.clearInterval(handle); } catch (err) { /* 忽略 */ } handle = null; }
    running = false;
    return snapshot();
  }

  function snapshot() {
    const state = mgr.snapshot();
    return {
      running,
      intervalMs,
      polls,
      probeFailures,
      lastDecision,
      routeChanges: state.routeChanges,
      current: state.current,
      currentScore: state.currentScore,
      state: state.state,
      ranking: state.ranking,
      policy: state.policy,
      events: events.slice(-10),
    };
  }

  return { start, stop, poll, snapshot, manager: mgr, get running() { return running; }, ROUTE_CHANGED };
}

module.exports = { DEFAULT_INTERVAL, ROUTE_CHANGED, createRouteSupervisor };
