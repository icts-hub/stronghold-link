'use strict';
// ============================================================================
// Stronghold Link — NetworkHealth：规格 §十九 / §三十 / §三十一 的落地点
//
// 三件事：
//   1. 把散在 manager / session / relay 里的计数收成**一份**快照（§三十 的那串统计）
//   2. 生成人可以读的日志行（`[Steam] login= relay= transport=` 之类）
//   3. 给出**能区分状态**的网络状态标签 —— 规格 §三十一 明确说"不要显示模糊的连接中"：
//      必须能分出 Steam ONLINE / Relay AVAILABLE / P2P CONNECTED / P2P DEGRADED /
//      RECONNECTING / RELAY UNAVAILABLE / SESSION RECOVERING
//
// 本模块**只读**：不改任何连接、不断任何流。它掉线了网络也该照跑。
// ============================================================================

const { STATE: CONN_STATE } = require('./steam-connection.cjs');
const { SESSION_STATE } = require('./mux-session.cjs');

/** 规格 §三十一 要求能区分出来的网络状态。 */
const LINK_STATE = Object.freeze({
  STEAM_OFFLINE: 'STEAM_OFFLINE',
  STEAM_ONLINE: 'STEAM_ONLINE',
  RELAY_UNAVAILABLE: 'RELAY_UNAVAILABLE',
  RELAY_AVAILABLE: 'RELAY_AVAILABLE',
  P2P_CONNECTING: 'P2P_CONNECTING',
  P2P_CONNECTED: 'P2P_CONNECTED',
  P2P_DEGRADED: 'P2P_DEGRADED',
  RECONNECTING: 'RECONNECTING',
  SESSION_RECOVERING: 'SESSION_RECOVERING',
  SESSION_CLOSED: 'SESSION_CLOSED',
});

const LINK_STATE_LABEL = Object.freeze({
  STEAM_OFFLINE: 'Steam 未登录',
  STEAM_ONLINE: 'Steam 在线',
  RELAY_UNAVAILABLE: '中继网络不可用',
  RELAY_AVAILABLE: '中继网络可用',
  P2P_CONNECTING: 'P2P 建连中',
  P2P_CONNECTED: 'P2P 已接通',
  P2P_DEGRADED: 'P2P 已降级',
  RECONNECTING: '正在重连',
  SESSION_RECOVERING: '会话恢复中',
  SESSION_CLOSED: '会话已结束',
});

const RTT_WINDOW = 20;

/**
 * 单个 Steam 传输连接的状态文案（规格 §三十）。界面直接显示，不再自己拼中文 ——
 * 免得同一个枚举在两个地方被译成两种说法。
 */
const CONN_STATE_LABEL = Object.freeze({
  DISCONNECTED: '未开始',
  STARTING: '启动中',
  RELAY_WAIT: '等中继',
  CONNECTING: '建连中',
  CONNECTED: '已接通',
  DEGRADED: '已降级',
  CLOSING: '关闭中',
  CLOSED: '已关闭',
  BACKOFF: '退避中',
});

function createNetworkHealthMonitor(spec = {}) {
  const now = typeof spec.now === 'function' ? spec.now : Date.now;
  const onEvent = typeof spec.onEvent === 'function' ? spec.onEvent : () => {};

  let relay = spec.relay || null;
  let manager = spec.manager || null;
  let session = spec.session || null;
  /** Steam 登录/transport 就绪是不是我们知道的（**只读**，绝不据此断连接，规格 §八）。 */
  let steamLoggedOn = spec.steamLoggedOn !== false;
  let transportReady = spec.transportReady !== false;

  const rttSamples = [];
  let maxQueuedBytes = 0;
  let samples = 0;
  let lastSampleAt = 0;
  let peakStreams = 0;
  let peakConnections = 0;
  const startedAt = now();

  const pushRtt = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return;
    rttSamples.push(n);
    if (rttSamples.length > RTT_WINDOW) rttSamples.shift();
  };

  const avgRTT = () => (rttSamples.length ? Math.round(rttSamples.reduce((a, b) => a + b, 0) / rttSamples.length) : null);

  const api = {
    LINK_STATE,
    LINK_STATE_LABEL,
    CONN_STATE_LABEL,

    setSources({ relay: r, manager: m, session: s } = {}) {
      if (r !== undefined) relay = r;
      if (m !== undefined) manager = m;
      if (s !== undefined) session = s;
      return api;
    },
    /** Steam 登录状态只是**展示**用。它永远不会让本模块去关任何连接（规格 §八 / §三十四-③）。 */
    setSteamLoggedOn(value) { steamLoggedOn = !!value; return api; },
    setTransportReady(value) { transportReady = !!value; return api; },

    /** 采一帧。调度器按 deadline 调（比如每秒一次），不要在热路径上每 tick 调。 */
    sample() {
      samples += 1;
      lastSampleAt = now();
      const mh = manager ? manager.health() : null;
      const sh = session ? session.health() : null;
      const rh = relay ? relay.stats() : null;

      if (sh) {
        if (sh.queuedBytes > maxQueuedBytes) maxQueuedBytes = sh.queuedBytes;
        if (sh.activeStreams > peakStreams) peakStreams = sh.activeStreams;
      }
      if (mh) {
        if (mh.activeSteamConnections > peakConnections) peakConnections = mh.activeSteamConnections;
        if (mh.primary && mh.primary.rtt) pushRtt(mh.primary.rtt);
        else if (mh.backup && mh.backup.rtt) pushRtt(mh.backup.rtt);
      }
      return api.snapshot();
    },

    snapshot() {
      const mh = manager ? manager.health() : null;
      const sh = session ? session.health() : null;
      const rh = relay ? relay.stats() : null;
      // 规格 §三十一：把状态与文案一并放进快照，界面只负责显示。
      // linkState() 不读快照（它读 session/manager 的 health），所以这里不会递归。
      const link = api.linkState();
      return {
        state: link,
        stateLabel: LINK_STATE_LABEL[link] || link,
        statusText: LINK_STATE_LABEL[link] || link,
        at: lastSampleAt || now(),
        uptimeMs: Math.max(0, now() - startedAt),
        samples,
        steamLoggedOn,
        transportReady,
        // 规格 §三十 点名要的那串统计
        steamConnectionsCreated: mh ? mh.steamConnectionsCreated : 0,
        steamConnectionsSucceeded: mh ? mh.steamConnectionsSucceeded : 0,
        steamConnectionsFailed: mh ? mh.steamConnectionsFailed : 0,
        steamConnectionsClosed: mh ? mh.steamConnectionsClosed : 0,
        activeSteamConnections: mh ? mh.activeSteamConnections : 0,
        maxActiveSteamConnections: mh ? mh.maxActiveSteamConnections : peakConnections,
        activeStreams: sh ? sh.activeStreams : 0,
        peakStreams,
        streamsOpened: sh ? sh.streamsOpened : 0,
        streamsClosed: sh ? sh.streamsClosed : 0,
        streamsReset: sh ? sh.streamsReset : 0,
        staleFrames: sh ? sh.staleFrames : 0,
        droppedFrames: sh ? sh.droppedFrames : 0,
        queuedBytes: sh ? sh.queuedBytes : 0,
        maxQueuedBytes,
        globalPaused: sh ? !!sh.globalPaused : false,
        pausedStreams: sh ? sh.pausedStreams : 0,
        avgRTT: avgRTT(),
        lastRelayStatus: rh ? rh.lastRelayStatus : '',
        relayAvailability: rh ? rh.availability : null,
        relayReady: rh ? !!rh.ready : false,
        relayEverReady: rh ? !!rh.everReady : false,
        failStreak: mh ? mh.failStreak : 0,
        lastFailure: mh ? mh.lastFailure : null,
        sessionState: sh ? sh.state : SESSION_STATE.IDLE,
        primaryState: mh && mh.primary ? mh.primary.state : CONN_STATE.DISCONNECTED,
        backupState: mh && mh.backup ? mh.backup.state : null,
        // 规格 §三十一：状态与文案由监视器自己给。判定规则只有一份（linkState），
        // 界面拿到 stateLabel / statusText 直接显示，**不重新判断一遍** ——
        // 否则"连接中"这种模糊词就会从界面那边偷偷长回来。
        primaryLabel: mh && mh.primary ? (CONN_STATE_LABEL[mh.primary.state] || mh.primary.state) : CONN_STATE_LABEL.DISCONNECTED,
        backupLabel: mh && mh.backup ? (CONN_STATE_LABEL[mh.backup.state] || mh.backup.state) : '',
        framesSent: sh ? sh.framesSent : 0,
        framesReceived: sh ? sh.framesReceived : 0,
        bytesToLocal: sh ? sh.bytesToLocal : 0,
        bytesToRemote: sh ? sh.bytesToRemote : 0,
      };
    },

    /**
     * 规格 §三十一：给出**不模糊**的状态。判断顺序（与下面的代码逐条对应）：
     * 会话是否已结束 → Steam 是否登录 → 会话是否在救 → 单条连接的状态 →
     * relay 可用性 → 传输是否就绪。
     *
     * 会话 CLOSED 排在最前面是有意的：会话已经结束了就是结束了，
     * 这时候再去报"Steam 没登录"会把用户往错的方向带（他该做的是重新开局，不是修 Steam）。
     */
    linkState() {
      const sh = session ? session.health() : null;
      const mh = manager ? manager.health() : null;

      if (sh && sh.state === SESSION_STATE.CLOSED) return LINK_STATE.SESSION_CLOSED;
      if (!steamLoggedOn) return LINK_STATE.STEAM_OFFLINE;

      const primaryState = mh && mh.primary ? mh.primary.state : CONN_STATE.DISCONNECTED;
      const relayUnavailable = relay ? (relay.isUnavailable() && !relay.everReady) : false;

      // 会话正在救 —— 这个比分条连接的状态更重要，先报它。
      if (sh && sh.state === SESSION_STATE.RECOVERING) return LINK_STATE.SESSION_RECOVERING;
      if (sh && sh.state === SESSION_STATE.DEGRADED) return LINK_STATE.RECONNECTING;

      // 连上了就是连上了，跟 relay 当前报什么无关（relay 状态是"能不能新建"，
      // 不是"这条已经在跑的还活着没有"——规格 §八 就是这么分的）。
      if (primaryState === CONN_STATE.CONNECTED) return LINK_STATE.P2P_CONNECTED;
      if (primaryState === CONN_STATE.DEGRADED) return LINK_STATE.P2P_DEGRADED;
      if (primaryState === CONN_STATE.BACKOFF) return LINK_STATE.RECONNECTING;
      if (relayUnavailable) return LINK_STATE.RELAY_UNAVAILABLE;
      if (relay && relay.isReady()) return LINK_STATE.RELAY_AVAILABLE;
      if (primaryState === CONN_STATE.CONNECTING || primaryState === CONN_STATE.STARTING || primaryState === CONN_STATE.RELAY_WAIT) {
        return LINK_STATE.P2P_CONNECTING;
      }
      if (!transportReady) return LINK_STATE.STEAM_ONLINE;
      return LINK_STATE.STEAM_ONLINE;
    },

    statusText() {
      const s = api.linkState();
      return LINK_STATE_LABEL[s] || s;
    },

    /** 规格 §三十 要求的那几行日志。返回字符串数组，由上层决定往哪写。 */
    logLines() {
      const s = api.snapshot();
      const lines = [];
      lines.push(`[Steam] login=${steamLoggedOn ? 'ONLINE' : 'OFFLINE'} relay=${s.relayAvailability === null ? 'UNKNOWN' : s.relayAvailability}(${s.lastRelayStatus || '—'}) transport=${transportReady ? 'READY' : 'NOT-READY'}`);
      const mh = manager ? manager.health() : null;
      for (const slot of ['primary', 'backup']) {
        const c = mh ? mh[slot] : null;
        if (!c) continue;
        if (c.state === CONN_STATE.CONNECTED) {
          lines.push(`[P2P] role=${slot} state=connected peer=${c.peer} route=${c.rtt !== null && c.rtt !== undefined ? `${c.rtt}ms` : '—'} relay=${s.lastRelayStatus || '—'} rtt=${c.rtt !== null && c.rtt !== undefined ? c.rtt : '—'}`);
        } else if (c.state === CONN_STATE.CONNECTING || c.state === CONN_STATE.STARTING || c.state === CONN_STATE.RELAY_WAIT) {
          lines.push(`[P2P] role=${slot} state=${c.state.toLowerCase()} peer=${c.peer} elapsed=${c.ageMs}ms attempt=${c.attempt}`);
        } else if (c.state === CONN_STATE.DEGRADED || c.state === CONN_STATE.BACKOFF) {
          lines.push(`[P2P] role=${slot} state=${c.state === CONN_STATE.BACKOFF ? 'failed' : 'degraded'} peer=${c.peer} reason=${c.failureText || '—'} elapsed=${c.ageMs}ms relay=${s.lastRelayStatus || '—'} retryIn=${c.retryInMs}ms class=${c.failureClass || '—'}`);
        }
      }
      if (session) {
        lines.push(`[MUX] streams=${s.activeStreams} opened=${s.streamsOpened} closed=${s.streamsClosed} reset=${s.streamsReset} queued=${s.queuedBytes} maxQueued=${s.maxQueuedBytes} stale=${s.staleFrames} dropped=${s.droppedFrames} session=${s.sessionState}`);
      }
      return lines;
    },

    /** 一行摘要，给隧道体检日志用。 */
    summaryLine() {
      const s = api.snapshot();
      return `网络 ${api.statusText()} ｜ Steam连接 现${s.activeSteamConnections}/峰${s.maxActiveSteamConnections} 建${s.steamConnectionsCreated} 成${s.steamConnectionsSucceeded} 败${s.steamConnectionsFailed} ｜ 流 现${s.activeStreams}/峰${s.peakStreams} 开${s.streamsOpened} 关${s.streamsClosed} 重${s.streamsReset} ｜ 积压${s.queuedBytes}B/峰${s.maxQueuedBytes}B ｜ RTT ${s.avgRTT === null ? '—' : `${s.avgRTT}ms`}`;
    },

    /** 上限守卫：漏了哪个字段就在这儿暴露出来（规格 §三十九"不要伪造成功"）。 */
    assertInvariants() {
      const s = api.snapshot();
      const problems = [];
      if (s.maxActiveSteamConnections > 2) problems.push(`Steam 连接峰值 ${s.maxActiveSteamConnections} 超过硬上限 2`);
      if (s.activeSteamConnections > 2) problems.push(`当前 Steam 连接 ${s.activeSteamConnections} 超过硬上限 2`);
      if (s.queuedBytes > 16 * 1024 * 1024) problems.push(`积压 ${s.queuedBytes} 字节超过 16MiB`);
      if (problems.length) onEvent('health-invariant-violated', { problems });
      return problems;
    },
  };

  return api;
}

module.exports = {
  LINK_STATE,
  LINK_STATE_LABEL,
  CONN_STATE_LABEL,
  RTT_WINDOW,
  createNetworkHealthMonitor,
};
