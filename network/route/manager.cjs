'use strict';
// ============================================================================
// Stronghold Link — RouteManager（决策核心）
//
// 职责：拿到各候选路径的质量快照，决定「保持 / 标记劣化 / 切换」，并且**不许抖**。
//
// 本模块不碰网络：探测由调用方注入（update 喂质量快照），切换动作由调用方执行
// （收到 route-changed 事件后重建传输）。这样它可以纯逻辑单测。
//
// 四个防抖旋钮（都可配）：
//   degradeBelow    当前路径分数低于此值才算劣化（默认 55）
//   switchMargin    备选必须比当前高出这么多分才值得切（默认 12，滞回）
//   minObservationMs 连续劣化这么久才允许切换（默认 4000，最小观察窗）
//   cooldownMs      切换后这段时间内不再切（默认 15000，冷却）
//
// 状态机：idle → connected → degraded → switching → connected
//   * 未测量的候选永远不会被选中（score 为 null 不参与排名）。
//   * 每次决策都带原因，便于日志与界面展示。
// ============================================================================

const { scoreQuality } = require('./score.cjs');

const STATES = Object.freeze({
  IDLE: 'idle',
  CONNECTED: 'connected',
  DEGRADED: 'degraded',
  SWITCHING: 'switching',
});

const DEFAULT_POLICY = Object.freeze({
  degradeBelow: 55,
  switchMargin: 12,
  minObservationMs: 4000,
  cooldownMs: 15000,
  settleMs: 0,
  maxLog: 40,
});

function createRouteManager({ policy = {}, weights = undefined, now = Date.now } = {}) {
  const cfg = { ...DEFAULT_POLICY, ...policy };
  const candidates = new Map();   // id → { id, name }
  const scores = new Map();       // id → 评分结果

  let state = STATES.IDLE;
  let current = null;
  let degradedSince = null;
  let lastSwitchAt = null;
  let routeChanges = 0;
  let log = [];
  const listeners = new Set();

  function emit(type, payload = {}) {
    const event = { type, at: now(), ...payload };
    log.push(event);
    if (log.length > cfg.maxLog) log.splice(0, log.length - cfg.maxLog);
    for (const fn of listeners) {
      try { fn(event); } catch (err) { /* 订阅者异常不影响决策 */ }
    }
    return event;
  }

  function setCandidates(list = []) {
    candidates.clear();
    for (const item of list) {
      const id = typeof item === 'string' ? item : item && item.id;
      if (!id) continue;
      candidates.set(id, { id, name: (item && item.name) || id });
      if (!scores.has(id)) scores.set(id, scoreQuality(null, { id, weights }));
    }
    return [...candidates.values()];
  }

  /** 喂一次测量结果（quality 为 NetworkQuality 快照）。 */
  function update(id, quality, { reliability = null } = {}) {
    if (!candidates.has(id)) candidates.set(id, { id, name: id });
    const result = scoreQuality(quality, { id, weights, reliability });
    scores.set(id, result);
    return result;
  }

  function scoreOf(id) {
    const s = scores.get(id);
    return s && s.measured ? s.score : null;
  }

  /** 按分数排名，只包含已测量的候选。 */
  function ranking() {
    return [...candidates.values()]
      .map((c) => ({ ...c, score: scoreOf(c.id), reasons: (scores.get(c.id) || {}).reasons || [] }))
      .filter((c) => c.score !== null)
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  }

  function setCurrent(id, { silent = false } = {}) {
    if (!id) return null;
    if (!candidates.has(id)) candidates.set(id, { id, name: id });
    const changed = current !== id;
    current = id;
    if (state === STATES.IDLE) state = STATES.CONNECTED;
    degradedSince = null;
    if (changed && !silent) {
      routeChanges += 1;
      emit('route-changed', { to: id, name: (candidates.get(id) || {}).name, reason: 'initial' });
    }
    return current;
  }

  /**
   * 走一拍：根据当前分数与时间决定状态与是否切换。
   * @returns {{ action: 'hold'|'degrade'|'switch'|'select', to?: string, reason: string, state: string }}
   */
  function tick() {
    const at = now();
    const ranked = ranking();

    // 还没有当前路径：选一个最好的（这是选路，不是切换）
    if (!current) {
      if (!ranked.length) {
        return { action: 'hold', reason: '没有可用候选（全部未测量）', state };
      }
      const best = ranked[0];
      setCurrent(best.id, { silent: true });
      routeChanges += 1;
      emit('route-changed', { to: best.id, name: best.name, reason: 'no-current-route' });
      return { action: 'select', to: best.id, reason: '初始选路：' + best.name + '（' + best.score + ' 分）', state };
    }

    const currentScore = scoreOf(current);

    // 当前路径不可用（未测量）或分数过低 → 进入劣化观察
    const degraded = currentScore === null || currentScore < cfg.degradeBelow;
    if (!degraded) {
      if (state === STATES.DEGRADED) {
        emit('route-recovered', { id: current, score: currentScore });
      }
      degradedSince = null;
      state = state === STATES.SWITCHING ? state : STATES.CONNECTED;
      return { action: 'hold', reason: '当前路径正常（' + currentScore + ' 分）', state };
    }

    if (degradedSince === null) {
      degradedSince = at;
      state = STATES.DEGRADED;
      emit('route-degraded', {
        id: current,
        score: currentScore,
        reason: currentScore === null ? '当前路径没有测量数据' : '当前路径分数低于阈值 ' + cfg.degradeBelow,
      });
      return { action: 'degrade', reason: '开始观察劣化', state };
    }

    const observed = at - degradedSince;
    if (observed < cfg.minObservationMs) {
      return { action: 'hold', reason: '劣化观察中（' + observed + 'ms / ' + cfg.minObservationMs + 'ms）', state };
    }

    if (lastSwitchAt !== null && at - lastSwitchAt < cfg.cooldownMs) {
      return { action: 'hold', reason: '冷却中（' + (at - lastSwitchAt) + 'ms / ' + cfg.cooldownMs + 'ms）', state };
    }

    const best = ranked.find((c) => c.id !== current) || null;
    if (!best) {
      return { action: 'hold', reason: '没有其它已测量的候选可切', state };
    }
    const margin = best.score - (currentScore === null ? 0 : currentScore);
    if (best.score <= (currentScore === null ? 0 : currentScore) + cfg.switchMargin) {
      return { action: 'hold', reason: '备选优势不足（' + margin + ' 分 / 需要超过 ' + cfg.switchMargin + ' 分）', state };
    }

    state = STATES.SWITCHING;
    const from = current;
    current = best.id;
    lastSwitchAt = at;
    degradedSince = null;
    routeChanges += 1;
    emit('route-changed', {
      from,
      to: best.id,
      name: best.name,
      score: best.score,
      reason: '劣化切换：' + from + ' → ' + best.name,
      // 诚实标注：这是"重建传输"，不是无缝迁移
      transportRebuilt: true,
    });
    state = STATES.CONNECTED;
    return { action: 'switch', to: best.id, reason: '切换到 ' + best.name + '（' + best.score + ' 分）', state };
  }

  function snapshot() {
    return {
      state,
      current,
      currentScore: current ? scoreOf(current) : null,
      degradedSince,
      lastSwitchAt,
      routeChanges,
      ranking: ranking(),
      policy: { ...cfg },
      log: log.slice(-20),
    };
  }

  return {
    setCandidates,
    setCurrent,
    update,
    tick,
    snapshot,
    scoreOf,
    ranking,
    onEvent(fn) {
      if (typeof fn !== 'function') throw new Error('onEvent 需要函数');
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get state() { return state; },
  };
}

module.exports = { STATES, DEFAULT_POLICY, createRouteManager };
