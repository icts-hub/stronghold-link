'use strict';
// ============================================================================
// Stronghold Link — Relay Network 状态监视（规格 §五 / §七 / §二十）
//
// 为什么必须有这个模块：0.13.3 里**根本没有 relay 感知**。`initRelayNetworkAccess()`
// 只在 `steam-adapter.cjs:156` 被叫过一次，之后 `getRelayNetworkStatus()` 全项目只在
// `network/steam-netdiag.cjs:61`（一个手点一次的诊断工具）里出现过。于是：
//
//   · 校园网里 relay 已经不可用了，加入者还在一条接一条地 connectP2P
//   · 每条都要等满 30 秒 TimeoutInitial 才失败
//   · 六条浏览器连接同时来 → 六条注定失败的握手 → 30 秒后同时报 5003
//
// 规格 §七 要求得很具体：**Relay Network 不可用时停止创建新 Steam 连接**，
// 恢复后**只创建 1 条**。这个模块就是那个判断的唯一出处。
//
// 两个 API 都是实测存在的（`steamworks-ffi-node@0.11.3`）：
//   networkingUtils.initRelayNetworkAccess()   dist/internal/SteamNetworkingUtilsManager.d.ts:124
//   networkingUtils.getRelayNetworkStatus()    dist/internal/SteamNetworkingUtilsManager.d.ts:148
// ============================================================================

/** ESteamNetworkingAvailability（dist/types/networking.d.ts）。 */
const AVAILABILITY = Object.freeze({
  CannotTry: -102,
  Failed: -101,
  Previously: -100,
  Retrying: -10,
  Unknown: 0,
  NeverTried: 1,
  Waiting: 2,
  Attempting: 3,
  Current: 100,
});

const AVAILABILITY_NAMES = Object.freeze({
  [-102]: 'CannotTry（本机网络栈不允许）',
  [-101]: 'Failed（连不上 Steam 中继网络）',
  [-100]: 'Previously（以前连上过，现在没连）',
  [-10]: 'Retrying（正在重试）',
  0: 'Unknown（还没查）',
  1: 'NeverTried（还没试过）',
  2: 'Waiting（等 Steam 安排）',
  3: 'Attempting（正在连）',
  100: 'Current（已连上中继网络）',
});

/** 唯一"可用"的取值。别再写 `>= 0` 之类的近似判断 —— 0 是 Unknown，不是可用。 */
const AVAILABILITY_READY = AVAILABILITY.Current;

function describeAvailability(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'Unknown（状态读不出来）';
  return AVAILABILITY_NAMES[n] || `未识别取值(${n})`;
}

/** 不可用 = 明确失败，或者已经退到"以前连过/正在重试"。Unknown/NeverTried/Waiting/Attempting 都还算"在路上"。 */
function isUnavailable(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  return n <= AVAILABILITY.Retrying;
}

function isReady(value) {
  return Number(value) === AVAILABILITY_READY;
}

/**
 * @param {object} spec
 * @param {object} [spec.netUtils]  `steam.networkingUtils`（可以后补，见 setNetUtils）
 * @param {() => number} [spec.now]
 * @param {(type:string, payload?:object) => void} [spec.onEvent]
 */
function createRelayStatusMonitor(spec = {}) {
  const now = typeof spec.now === 'function' ? spec.now : Date.now;
  const onEvent = typeof spec.onEvent === 'function' ? spec.onEvent : () => {};

  let netUtils = spec.netUtils || null;
  let initCalled = false;
  let initError = '';
  /** 曾经读到过 Current 吗 —— §七 只允许"恢复后补 1 条"，前提就是知道什么叫"恢复"。 */
  let everReady = false;
  let last = null;
  let lastChangeAt = 0;
  let polls = 0;
  let pollErrors = 0;
  let transitions = 0;

  const normalize = (raw) => {
    const availability = raw && raw.availability !== undefined ? Number(raw.availability) : AVAILABILITY.Unknown;
    return {
      availability,
      availabilityName: (raw && raw.availabilityName) || describeAvailability(availability),
      ready: isReady(availability),
      unavailable: isUnavailable(availability),
      pingMeasurementInProgress: !!(raw && raw.pingMeasurementInProgress),
      networkConfigAvailability: raw && raw.networkConfigAvailability !== undefined ? Number(raw.networkConfigAvailability) : null,
      anyRelayAvailability: raw && raw.anyRelayAvailability !== undefined ? Number(raw.anyRelayAvailability) : null,
      debugMessage: (raw && raw.debugMessage) || '',
      at: now(),
      polls,
    };
  };

  const api = {
    AVAILABILITY,

    setNetUtils(next) { netUtils = next || null; return api; },
    get netUtils() { return netUtils; },

    /**
     * 尽早调（规格 §五：Steam 初始化完成后就调，**不要等第一次 Minecraft TCP 请求**）。
     * 失败不抛 —— relay 起不来是常态，不是崩溃理由。
     */
    init() {
      if (initCalled) return api.snapshot();
      initCalled = true;
      if (!netUtils || typeof netUtils.initRelayNetworkAccess !== 'function') {
        initError = 'SDK 没有 initRelayNetworkAccess（binding 不完整）';
        onEvent('relay-init-skipped', { reason: initError });
        return api.snapshot();
      }
      try {
        netUtils.initRelayNetworkAccess();
        onEvent('relay-init', { ok: true, at: now() });
      } catch (err) {
        initError = err && err.message ? err.message : String(err);
        onEvent('relay-init', { ok: false, reason: initError });
      }
      return api.poll();
    },

    /** 每 tick 或按 deadline 调一次，读一次状态并在变化时报事件。 */
    poll() {
      polls += 1;
      if (!netUtils || typeof netUtils.getRelayNetworkStatus !== 'function') {
        pollErrors += 1;
        return api.snapshot();
      }
      let raw = null;
      try {
        raw = netUtils.getRelayNetworkStatus();
      } catch (err) {
        pollErrors += 1;
        onEvent('relay-poll-error', { message: err && err.message ? err.message : String(err) });
        return api.snapshot();
      }
      const next = normalize(raw);
      const prev = last;
      if (!prev || prev.availability !== next.availability) {
        transitions += 1;
        lastChangeAt = next.at;
        if (next.ready && !everReady) everReady = true;
        onEvent('relay-status', {
          from: prev ? prev.availability : null,
          to: next.availability,
          fromName: prev ? prev.availabilityName : '',
          toName: next.availabilityName,
          ready: next.ready,
          unavailable: next.unavailable,
          debugMessage: next.debugMessage,
          everReady,
        });
      }
      last = next;
      return { ...next };
    },

    snapshot() {
      if (!last) {
        // 空快照的字段必须与"有状态"的那一支完全对齐（多一个少一个都会让上层
        // 在"SDK 没有 initRelayNetworkAccess"这条路径上读到 undefined）。
        return {
          availability: AVAILABILITY.Unknown,
          availabilityName: initError ? `Unknown（${initError}）` : describeAvailability(AVAILABILITY.Unknown),
          ready: false,
          unavailable: false,
          pingMeasurementInProgress: false,
          networkConfigAvailability: null,
          anyRelayAvailability: null,
          debugMessage: initError,
          at: 0,
          polls,
          initCalled,
          everReady,
          transitions,
          lastChangeAt,
          pollErrors,
          initError,
        };
      }
      return { ...last, initCalled, everReady, transitions, lastChangeAt, pollErrors, initError };
    },

    isReady() { return !!(last && last.ready); },
    isUnavailable() { return !!(last && last.unavailable); },
    get everReady() { return everReady; },
    get transitions() { return transitions; },
    get pollErrors() { return pollErrors; },

    /**
     * 规格 §七：Relay Network 不可用且**从来没就绪过** ⇒ 不许开新连接、也不许排新重试。
     * 注意是"从来没就绪过"：如果之前连上过中继、现在掉到 Retrying，那说明路径本来是通的，
     * 应该按退避重试而不是彻底放弃。
     */
    canOpenNewConnection() {
      if (!last) return { ok: true, reason: 'unknown' };
      if (last.ready) return { ok: true, reason: 'ready' };
      if (last.unavailable && !everReady) {
        return { ok: false, reason: 'relay-unavailable', detail: last.availabilityName, debugMessage: last.debugMessage };
      }
      return { ok: true, reason: 'transient' };
    },

    stats() {
      return {
        availability: last ? last.availability : AVAILABILITY.Unknown,
        availabilityName: last ? last.availabilityName : '',
        ready: !!(last && last.ready),
        everReady,
        transitions,
        polls,
        pollErrors,
        lastRelayStatus: last ? last.availabilityName : '',
        debugMessage: last ? last.debugMessage : initError,
      };
    },
  };

  return api;
}

module.exports = {
  AVAILABILITY,
  AVAILABILITY_READY,
  AVAILABILITY_NAMES,
  describeAvailability,
  isReady,
  isUnavailable,
  createRelayStatusMonitor,
};
