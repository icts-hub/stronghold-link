'use strict';
// ============================================================================
// Stronghold Link — MuxScheduler：整个网络层**唯一**的定时器（规格 §十八）
//
// 规格原话：不要每个 Peer / 每个 Stream / 每个 socket 一个 setInterval。
// 0.13.3 有四个 per-peer 定时器在跑（`peer.reconnectTimer` / `peer.helloWatchdog` /
// `peer.poolWatchdog` / `poolState.timer`），每条连接一套，池子一波动就是几十个
// 定时器互相踩。这个模块把"什么时候该干什么"收进一张 deadline 表，一个 tick 里
// 全部结算。
//
// 节拍为什么是 4ms：实测（Electron 39.8.10 主进程）`setTimeout(0)` 自续链是
// 11.1ms/tick，`setTimeout(4)` 是 16.7ms/tick，`setInterval(4)` 是 14.3ms/tick。
// 也就是说 4ms 这个数字在 Electron 里其实达不到，真实节拍就是 11~17ms ——
// 够快（远小于任何网络 RTT），又不至于空转烧 CPU。**不要为了"更及时"改成 0**，
// 那只会让 tick 更慢而且更贵。
//
// 每个 tick 只做四件事，顺序固定：
//   1. runCallbacks()         —— 让 Steam 把回调吐出来
//   2. 收包                    —— 各 transport → session.receive()
//   3. 到期检查                —— deadline 表里到点的全部结算
//   4. 公平发送                —— session.takeFrames() → transport.send()
// ============================================================================

/** 默认节拍（毫秒）。见文件头注释：这是"够快且不空转"的折中，不是硬实时。 */
const DEFAULT_INTERVAL_MS = 4;

function createMuxScheduler(options = {}) {
  const intervalMs = Number.isFinite(options.intervalMs) ? Math.max(1, options.intervalMs) : DEFAULT_INTERVAL_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};

  /** @type {Map<string, (ctx: object) => void>} 每 tick 都跑的数据源，按注册顺序。 */
  const sources = new Map();
  /** @type {Map<string, {at:number, interval:number, fn:Function, runs:number}>} 到点才跑的任务。 */
  const timers = new Map();

  let running = false;
  let timerHandle = null;
  let stopped = false;
  let ticks = 0;
  let lastTickAt = 0;
  let lastTickDurationMs = 0;
  let maxTickDurationMs = 0;
  let totalTickDurationMs = 0;
  let startedAt = 0;
  let sourceErrors = 0;
  let timerErrors = 0;

  const stats = {
    get ticks() { return ticks; },
    get intervalMs() { return intervalMs; },
    get sources() { return sources.size; },
    get timers() { return timers.size; },
    get running() { return running; },
    get lastTickAt() { return lastTickAt; },
    get lastTickDurationMs() { return lastTickDurationMs; },
    get maxTickDurationMs() { return maxTickDurationMs; },
    get avgTickDurationMs() { return ticks ? Math.round((totalTickDurationMs / ticks) * 100) / 100 : 0; },
    get sourceErrors() { return sourceErrors; },
    get timerErrors() { return timerErrors; },
    get uptimeMs() { return startedAt ? Math.max(0, now() - startedAt) : 0; },
  };

  const safeCall = (fn, label, ctx) => {
    try { fn(ctx); return true; } catch (err) {
      if (label === 'source') sourceErrors += 1; else timerErrors += 1;
      // 规格 §三十六：禁止 silent catch。这里不抛（一个数据源炸了不能带倒整个网络层），
      // 但一定把原因报出去。
      // name 与 key 都要带上：数据源有 name，定时任务有 key（就是 pendingTimers() 里那个），
      // 只报 name 的话定时任务炸了只能知道"某个定时任务出错了"、对不上是谁。
      onEvent('scheduler-error', {
        kind: label,
        name: ctx && ctx.name ? ctx.name : '',
        key: ctx && ctx.key !== undefined ? ctx.key : '',
        message: err && err.message ? err.message : String(err),
        stack: err && err.stack ? String(err.stack).split('\n').slice(0, 3).join(' | ') : '',
      });
      return false;
    }
  };

  const drainTimers = (t) => {
    let fired = 0;
    for (const [key, entry] of [...timers]) {
      if (entry.at > t) continue;
      fired += 1;
      entry.runs += 1;
      if (entry.interval > 0) entry.at = t + entry.interval;
      else timers.delete(key);
      safeCall(entry.fn, 'timer', { key, now: t, runs: entry.runs, interval: entry.interval });
    }
    return fired;
  };

  /** 跑一个 tick。测试里可以直接调它，不需要真的等 4 毫秒。 */
  const tick = (context = {}) => {
    if (stopped) return null;
    const t0 = now();
    ticks += 1;
    lastTickAt = t0;

    const ctx = { now: t0, tick: ticks, intervalMs, ...context };
    for (const [name, fn] of [...sources]) safeCall(fn, 'source', { ...ctx, name });
    const timersFired = drainTimers(t0);

    const t1 = now();
    lastTickDurationMs = Math.max(0, t1 - t0);
    totalTickDurationMs += lastTickDurationMs;
    if (lastTickDurationMs > maxTickDurationMs) maxTickDurationMs = lastTickDurationMs;
    return { tick: ticks, durationMs: lastTickDurationMs, timersFired };
  };

  const step = () => {
    if (!running) return;
    tick();
    // 用自续 setTimeout 而不是 setInterval：setInterval 在 tick 变慢时会堆积回调，
    // 一堆积就是"同一毫秒里跑三遍"，比慢更糟。
    timerHandle = setTimeout(step, intervalMs);
    if (timerHandle && typeof timerHandle.unref === 'function') timerHandle.unref();
  };

  return {
    intervalMs,
    tick,
    stats,

    /** 注册一个每 tick 都跑的数据源。返回反注册函数。 */
    addSource(name, fn) {
      if (typeof fn !== 'function') throw new TypeError('addSource 需要一个函数');
      sources.set(String(name), fn);
      return () => sources.delete(String(name));
    },
    removeSource(name) { return sources.delete(String(name)); },
    sourceNames() { return [...sources.keys()]; },

    /**
     * 注册一个延迟任务。`interval` 给了就是重复任务。
     * 同一个 key 重复注册会覆盖（这正是"一个东西只许有一个定时器"的落地方式）。
     */
    schedule(key, delayMs, fn, { interval = 0 } = {}) {
      const k = String(key);
      if (typeof fn !== 'function') throw new TypeError('schedule 需要一个函数');
      timers.set(k, { at: now() + Math.max(0, delayMs), interval: Math.max(0, interval), fn, runs: 0 });
      return () => timers.delete(k);
    },
    /** 到点就跑一次的任务（等价于 schedule 不带 interval，写起来短一点）。 */
    once(key, delayMs, fn) { return this.schedule(key, delayMs, fn, { interval: 0 }); },
    /** 周期任务。每 tick 检查是否到点，不额外建定时器。 */
    every(key, intervalMs2, fn) { return this.schedule(key, intervalMs2, fn, { interval: intervalMs2 }); },
    cancel(key) { return timers.delete(String(key)); },
    has(key) { return timers.has(String(key)); },
    pendingTimers() { return [...timers].map(([key, e]) => ({ key, at: e.at, inMs: Math.max(0, e.at - now()), interval: e.interval, runs: e.runs })); },

    start() {
      if (running || stopped) return false;
      running = true;
      startedAt = now();
      onEvent('scheduler-started', { intervalMs });
      // 启动后立刻先跑一轮，不等满一个周期 —— 0.13.3 的 startCallbackLoop 也是这么做的。
      tick();
      timerHandle = setTimeout(step, intervalMs);
      if (timerHandle && typeof timerHandle.unref === 'function') timerHandle.unref();
      return true;
    },
    stop() {
      if (!running) { stopped = true; return false; }
      running = false;
      stopped = true;
      if (timerHandle) { clearTimeout(timerHandle); timerHandle = null; }
      sources.clear();
      timers.clear();
      onEvent('scheduler-stopped', { ticks, uptimeMs: stats.uptimeMs });
      return true;
    },
    get running() { return running; },
  };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  createMuxScheduler,
};
