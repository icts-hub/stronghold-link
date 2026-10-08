'use strict';
// ============================================================================
// Stronghold Link — SteamConnection：一条 Steam P2P 传输（规格 §六 / §十九）
//
// 这是"会断的那个东西"。它断了不该带走任何别的东西 —— 流在 MuxSession 手里，
// 会话在 MuxSession 手里，这里只有一个 connection 句柄和它的状态。
//
// ── 状态机（规格 §六）──────────────────────────────────────────────────────
//
//   DISCONNECTED ──connect()──> STARTING ──relay 就绪──> CONNECTING ──Connected──> CONNECTED
//        ^                          │                        │                        │
//        │                          │ relay 不可用           │ 失败                    │ 心跳超时
//        │                          v                        v                        v
//        │                      RELAY_WAIT                BACKOFF <──退避 1s..60s── DEGRADED
//        │                          │                        │                        │
//        └────── close() ────── CLOSING ──────────────────> CLOSED <───────────────────┘
//
// **唯一能把这条连接推进 DEGRADED/CLOSED 的，是这条连接自己的 `onConnectionStateChange`
// 回调**（外加本类自己的心跳超时）。Steam 登录状态、CM 状态、backend 状态一律**不接进来**。
// 这是规格 §八 和 §三十四-③（"Steam CM disconnect → close all P2P"）在结构上不可能
// 发生的原因：本模块的入参里根本没有"Steam 登录状态"这个东西。
// ============================================================================

/** 状态机取值（规格 §六）。 */
const STATE = Object.freeze({
  DISCONNECTED: 'DISCONNECTED',
  STARTING: 'STARTING',
  RELAY_WAIT: 'RELAY_WAIT',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  DEGRADED: 'DEGRADED',
  CLOSING: 'CLOSING',
  CLOSED: 'CLOSED',
  BACKOFF: 'BACKOFF',
});

/** ESteamNetworkingConnectionState（dist/types/networking.d.ts）。 */
const STEAM_STATE = Object.freeze({
  None: 0,
  Connecting: 1,
  FindingRoute: 2,
  Connected: 3,
  ClosedByPeer: 4,
  ProblemDetectedLocally: 5,
  FinWait: -1,
  Linger: -2,
  Dead: -3,
});

/** EResultNetworkingConnectionEnd —— 规格 §二十 点名要区分的那几个。 */
const END_REASON = Object.freeze({
  1000: '正常关闭',
  4001: '对端超时：对方没在规定时间内回应',
  5001: '传输层通用错误',
  5002: '传输层内部错误',
  5003: '传输层超时',
  5008: 'P2P 会合失败',
});

/** 发送标志（dist/types/networking.d.ts:262-270）。 */
const SEND_FLAG = Object.freeze({ Unreliable: 0, NoNagle: 1, NoDelay: 4, Reliable: 8, UseCurrentThread: 16, AutoRestartBrokenSession: 32 });

/** 传输层自己的出站队列上限。到这儿说明对端不读了 —— 由会话层去暂停业务 socket。 */
const OUT_HIGH_WATER = 1 * 1024 * 1024;
const OUT_LOW_WATER = 128 * 1024;
const OUT_MAX_WATER = 8 * 1024 * 1024;

/** 默认分片（规格 §十四：不要发巨大 Steam message）。 */
const DEFAULT_MAX_CHUNK = 4096;

function describeEndReason(code) {
  const n = Number(code);
  if (!Number.isFinite(n)) return '';
  if (END_REASON[n]) return END_REASON[n];
  if (n >= 1000 && n < 2000) return '应用层正常关闭';
  if (n >= 2000 && n < 3000) return '应用层异常关闭';
  if (n >= 3000 && n < 4000) return '本机侧网络问题';
  if (n >= 4000 && n < 5000) return '对端侧网络问题';
  if (n >= 5000 && n < 6000) return '传输层问题';
  return '未知原因';
}

/** 规格 §二十 的故障分类。日志里不许只写"连接失败"。 */
function classifyFailure({ reason, relayUnavailable, everReady, elapsedMs }) {
  const n = Number(reason);
  if (relayUnavailable && !everReady) return 'RELAY_UNAVAILABLE';
  if (n === 5008) return 'P2P_RENDEZVOUS_FAILED';
  if (n === 5003) return 'P2P_TRANSPORT_FAILED';
  if (n === 4001) return 'REMOTE_CLOSED';
  if (n === 1000) return 'REMOTE_CLOSED';
  if (Number.isFinite(elapsedMs) && elapsedMs > 0 && elapsedMs < 2000 && !n) return 'LOCAL_NETWORK_ERROR';
  return 'P2P_TRANSPORT_FAILED';
}

/**
 * @param {object} spec
 * @param {string|number} spec.id            本进程内唯一标识（日志用）
 * @param {'primary'|'backup'} spec.role
 * @param {string} spec.peerSteamId
 * @param {object} spec.sockets              `steam.networkingSockets`
 * @param {number} [spec.virtualPort]
 * @param {number} [spec.maxChunk]
 * @param {() => number} [spec.now]
 * @param {(type:string, payload?:object) => void} [spec.onEvent]
 */
function createSteamConnection(spec = {}) {
  const id = String(spec.id || 'conn');
  const role = spec.role === 'backup' ? 'backup' : 'primary';
  const peerSteamId = String(spec.peerSteamId || '');
  const sockets = spec.sockets || null;
  const virtualPort = Number.isFinite(spec.virtualPort) ? spec.virtualPort : 0;
  const maxChunk = Number.isFinite(spec.maxChunk) ? spec.maxChunk : DEFAULT_MAX_CHUNK;
  const now = typeof spec.now === 'function' ? spec.now : Date.now;
  const onEvent = typeof spec.onEvent === 'function' ? spec.onEvent : () => {};

  let state = STATE.DISCONNECTED;
  let connection = null;
  let generation = 1;

  let createdAt = 0;
  let connectedAt = 0;
  let closedAt = 0;
  let lastStateChangeAt = 0;
  let lastRecvAt = 0;
  let lastSendAt = 0;
  let lastPongAt = 0;
  let failureReason = 0;
  let failureText = '';
  let failureClass = '';
  let attempt = 0;
  let retryAt = 0;

  const counters = {
    messagesSent: 0,
    messagesReceived: 0,
    bytesSent: 0,
    bytesReceived: 0,
    sendFailures: 0,
    sendStalls: 0,
    queueHighWaterHits: 0,
  };

  /** @type {Array<{data:Buffer, at:number}>} */
  const outQueue = [];
  let queuedBytes = 0;
  let maxQueuedSeen = 0;
  let paused = false;
  let lastStatus = null;

  const emit = (type, payload) => {
    try { onEvent(type, payload); } catch { /* 回调不能带倒网络层 */ }
  };

  const setState = (next, detail = {}) => {
    if (state === next) return state;
    const prev = state;
    // 失败分类不能只进事件：规格 §十九 要求 health() 能报出 failureReason / failureClass，
    // 只放在事件 payload 里的话，事后调 health() 排查会拿到空字符串。
    // 只在真的带 failureClass（= 真的失败）时写回，正常关闭的 reasonText 不冒充失败原因。
    if (detail.failureClass) {
      failureClass = detail.failureClass;
      if (detail.reasonText) failureText = detail.reasonText;
    }
    state = next;
    lastStateChangeAt = now();
    if (next === STATE.CONNECTED && !connectedAt) connectedAt = lastStateChangeAt;
    if (next === STATE.CLOSED) closedAt = lastStateChangeAt;
    emit('transport-state', {
      id, role, peer: peerSteamId, generation,
      from: prev, to: next,
      elapsedMs: createdAt ? now() - createdAt : 0,
      reason: detail.reason !== undefined ? detail.reason : '',
      reasonText: detail.reasonText || (detail.reason !== undefined ? describeEndReason(detail.reason) : ''),
      failureClass: detail.failureClass || '',
      attempt,
      ...detail,
    });
    return state;
  };

  const sendFlags = () => SEND_FLAG.Reliable | SEND_FLAG.NoNagle;

  const sendOne = (data) => {
    if (!sockets || !connection) return { ok: false, code: 'NOCONN' };
    try {
      if (typeof sockets.sendMessage === 'function') {
        const rc = sockets.sendMessage(connection, data, sendFlags());
        // Steam 的 sendMessage 返回 EResult：>= 0 是成功（>0 表示"排上了但不保证送达"）。
        const ok = typeof rc === 'number' ? rc >= 0 : rc !== false;
        return { ok, code: ok ? '' : `ERESULT ${rc}` };
      }
      if (typeof sockets.sendReliable === 'function') {
        sockets.sendReliable(connection, data);
        return { ok: true, code: '' };
      }
      return { ok: false, code: 'NOSEND' };
    } catch (err) {
      return { ok: false, code: err && err.message ? err.message : String(err) };
    }
  };

  const api = {
    id,
    role,
    peerSteamId,
    get state() { return state; },
    get generation() { return generation; },
    get handle() { return connection; },
    get attempt() { return attempt; },
    get retryAt() { return retryAt; },
    get queuedBytes() { return queuedBytes; },
    get isConnected() { return state === STATE.CONNECTED || state === STATE.DEGRADED; },
    get isUsable() { return connection !== null && state !== STATE.CLOSED && state !== STATE.CLOSING && state !== STATE.DISCONNECTED; },
    get failureClass() { return failureClass; },
    get failureText() { return failureText; },
    get lastRecvAt() { return lastRecvAt; },
    get lastPongAt() { return lastPongAt; },
    counters,

    /** 规格 §十九 要求跟踪的那个 generation：重连一次 +1，用来挡旧连接上的迟到帧。 */
    bumpGeneration() { generation += 1; return generation; },

    /**
     * 主动开一条。relay 不可用时**直接进 RELAY_WAIT 并且不排任何重试**
     * （规格 §七：不能因为 relay unavailable 产生大量 reconnect）。
     */
    open({ relayGate } = {}) {
      // RELAY_WAIT 必须放行：规格 §七 要求 relay 恢复后**只创建 1 条** ——
      // 唤醒那个已经在等 relay 的同一个对象，而不是另建一条、把它丢在 RELAY_WAIT 里。
      // （实测教训：原守卫只放行 DISCONNECTED/BACKOFF 时，manager 的唤醒路径恒返回
      //   BADSTATE，连接永远醒不过来，实际靠 ensure() 另建一条顶上。）
      if (state !== STATE.DISCONNECTED && state !== STATE.BACKOFF && state !== STATE.RELAY_WAIT) {
        return { ok: false, code: 'BADSTATE', state };
      }
      // 注意 attempt 的口径：它数的是 **open() 被调用的次数**，包含被 relayGate 拦下、
      // 停在 RELAY_WAIT 的那些（那种情况下 connectP2P 根本没发生）。真实的握手次数看
      // manager.stats.steamConnectionsCreated。两者混用会把校园网下的握手次数高估。
      attempt += 1;
      createdAt = now();
      setState(STATE.STARTING, { gate: relayGate ? relayGate.reason : '' });
      if (relayGate && relayGate.ok === false) {
        // 不排重试、不报错、不算失败 —— 就是"在等 relay"，等监视器来叫醒。
        setState(STATE.RELAY_WAIT, { reason: relayGate.reason, reasonText: relayGate.detail || '' });
        emit('transport-relay-wait', { id, role, detail: relayGate.detail || '', debugMessage: relayGate.debugMessage || '' });
        return { ok: false, code: 'RELAY_WAIT' };
      }
      if (!sockets || typeof sockets.connectP2P !== 'function') {
        failureClass = 'LOCAL_NETWORK_ERROR';
        failureText = 'SDK 没有 connectP2P';
        setState(STATE.CLOSED, { reasonText: failureText, failureClass });
        return { ok: false, code: 'NOSDK' };
      }
      let handle = null;
      try {
        handle = sockets.connectP2P(String(peerSteamId), virtualPort);
      } catch (err) {
        failureText = err && err.message ? err.message : String(err);
        failureClass = 'P2P_TRANSPORT_FAILED';
        setState(STATE.BACKOFF, { reasonText: failureText, failureClass });
        emit('transport-failed', { id, role, peer: peerSteamId, reason: failureText, elapsedMs: now() - createdAt, attempt });
        return { ok: false, code: 'ETHROW', message: failureText };
      }
      connection = handle;
      setState(STATE.CONNECTING, { attempt });
      emit('transport-connecting', { id, role, peer: peerSteamId, attempt, generation, elapsedMs: 0 });
      return { ok: true, connection: handle };
    },

    /** 房主侧：把一条入站连接收编（`acceptConnection` + `setConnectionPollGroup` 由上层做）。 */
    adopt(handle, { inbound = true, info = null } = {}) {
      connection = handle;
      createdAt = createdAt || now();
      attempt += 1;
      setState(STATE.CONNECTED, { inbound, remote: info && info.identityRemote ? String(info.identityRemote) : '' });
      return api;
    },

    /** 由 manager 的全局回调转发进来。**只有这条路径能推动状态机。** */
    onSteamStateChange(change) {
      const next = Number(change && change.newState);
      const info = (change && change.info) || {};
      const reason = info.endReason;
      if (next === STEAM_STATE.Connected) {
        failureReason = 0;
        failureText = '';
        failureClass = '';
        lastRecvAt = now();
        setState(STATE.CONNECTED, { reason: reason !== undefined ? reason : '', attempt });
        emit('transport-connected', {
          id, role, peer: peerSteamId, generation,
          route: info.connectionDescription || '',
          relay: info.popIdRelay !== undefined ? info.popIdRelay : '',
          remote: info.identityRemote ? String(info.identityRemote) : '',
        });
        return true;
      }
      if (next === STEAM_STATE.Connecting || next === STEAM_STATE.FindingRoute) {
        if (state !== STATE.CONNECTING) setState(STATE.CONNECTING, { attempt });
        return true;
      }
      if (next === STEAM_STATE.ClosedByPeer || next === STEAM_STATE.ProblemDetectedLocally ||
          next === STEAM_STATE.FinWait || next === STEAM_STATE.Linger || next === STEAM_STATE.Dead) {
        failureReason = Number.isFinite(Number(reason)) ? Number(reason) : 0;
        failureText = info.endDebugMessage || describeEndReason(failureReason);
        failureClass = classifyFailure({ reason: failureReason, elapsedMs: now() - createdAt });
        const wasConnected = !!connectedAt;
        connection = null;
        outQueue.length = 0;
        queuedBytes = 0;
        setState(wasConnected ? STATE.DEGRADED : STATE.BACKOFF, {
          reason: failureReason, reasonText: failureText, failureClass,
          elapsedMs: createdAt ? now() - createdAt : 0,
        });
        emit('transport-lost', {
          id, role, peer: peerSteamId, generation,
          steamState: next, reason: failureReason, reasonText: failureText,
          failureClass, elapsedMs: createdAt ? now() - createdAt : 0,
          aliveMs: connectedAt ? now() - connectedAt : 0,
          bytesSent: counters.bytesSent, bytesReceived: counters.bytesReceived,
        });
        return true;
      }
      return false;
    },

    /** 心跳超时：连接还挂着但对方不吭声了。**降级而不是关闭**（规格 §六 的 DEGRADED）。 */
    markDegraded(reason) {
      if (state !== STATE.CONNECTED) return false;
      setState(STATE.DEGRADED, { reasonText: reason || '心跳超时', failureClass: 'P2P_TRANSPORT_FAILED' });
      return true;
    },
    markHealthy(detail) {
      if (state !== STATE.DEGRADED) return false;
      setState(STATE.CONNECTED, { reasonText: '心跳恢复', ...detail });
      return true;
    },

    /** 重连前把这条收掉。会话层不受影响 —— 它已经在 MuxSession 手里了。 */
    close(reason = 0, debug = '本地主动关闭', { linger = false } = {}) {
      if (state === STATE.CLOSED) return false;
      setState(STATE.CLOSING, { reason, reasonText: debug });
      const handle = connection;
      connection = null;
      if (handle !== null && sockets && typeof sockets.closeConnection === 'function') {
        try { sockets.closeConnection(handle, reason, debug, linger); } catch (err) {
          emit('transport-close-error', { id, message: err && err.message ? err.message : String(err) });
        }
      }
      setState(STATE.CLOSED, { reason, reasonText: debug });
      return true;
    },

    /** 进退避，等 manager 到点再叫 open()。 */
    backoff(delayMs, detail = {}) {
      retryAt = now() + Math.max(0, delayMs);
      setState(STATE.BACKOFF, { retryInMs: Math.max(0, delayMs), ...detail });
      return retryAt;
    },

    /** 本机收到的字节 → 出站队列（规格 §二十六 的统一 send queue）。 */
    queue(data) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
      if (!buf.length) return 0;
      if (queuedBytes + buf.length > OUT_MAX_WATER) {
        counters.sendStalls += 1;
        return 0;
      }
      outQueue.push({ data: buf, at: now() });
      queuedBytes += buf.length;
      if (queuedBytes > maxQueuedSeen) maxQueuedSeen = queuedBytes;
      if (!paused && queuedBytes >= OUT_HIGH_WATER) {
        paused = true;
        counters.queueHighWaterHits += 1;
        emit('transport-queue-high', { id, role, queuedBytes, water: OUT_HIGH_WATER });
      }
      return buf.length;
    },

    /**
     * 把队列里的字节按 maxChunk 分片发出去。返回这一轮实际发掉的字节数。
     * 分片是关键：一条 1 MiB 的响应如果整块塞给 sendMessage，就是"一个巨大 Steam message"。
     */
    flush({ maxBytes = 256 * 1024 } = {}) {
      if (!api.isUsable) return 0;
      let sent = 0;
      while (outQueue.length && sent < maxBytes) {
        const item = outQueue[0];
        const take = Math.min(item.data.length, maxChunk, maxBytes - sent);
        const slice = take === item.data.length ? item.data : item.data.subarray(0, take);
        const rc = sendOne(slice);
        if (!rc.ok) {
          counters.sendFailures += 1;
          emit('transport-send-failed', { id, role, code: rc.code, queuedBytes, backpressured: true });
          break;
        }
        counters.messagesSent += 1;
        counters.bytesSent += slice.length;
        sent += slice.length;
        lastSendAt = now();
        if (take === item.data.length) outQueue.shift();
        else item.data = item.data.subarray(take);
        queuedBytes -= slice.length;
      }
      if (paused && queuedBytes <= OUT_LOW_WATER) {
        paused = false;
        emit('transport-queue-low', { id, role, queuedBytes, water: OUT_LOW_WATER });
      }
      return sent;
    },

    /** 立即发一小段（控制帧、Pong 之类，不排队）。 */
    sendNow(data) {
      if (!api.isUsable) return false;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
      const rc = sendOne(buf);
      if (!rc.ok) { counters.sendFailures += 1; return false; }
      counters.messagesSent += 1;
      counters.bytesSent += buf.length;
      lastSendAt = now();
      return true;
    },

    /** manager 的 poll group 抽到消息后转发进来记账。 */
    noteReceived(bytes) {
      counters.messagesReceived += 1;
      counters.bytesReceived += bytes;
      lastRecvAt = now();
      return lastRecvAt;
    },
    notePong() { lastPongAt = now(); return lastPongAt; },

    /** 规格 §十九 要求的健康数据。优先用 Steam 的实时状态，不自造数字。 */
    refreshStatus() {
      if (!connection || !sockets || typeof sockets.getConnectionRealTimeStatus !== 'function') return lastStatus;
      try {
        const rt = sockets.getConnectionRealTimeStatus(connection);
        if (rt) {
          lastStatus = {
            ping: Number.isFinite(Number(rt.ping)) ? Number(rt.ping) : null,
            connectionQualityLocal: rt.connectionQualityLocal !== undefined ? Number(rt.connectionQualityLocal) : null,
            connectionQualityRemote: rt.connectionQualityRemote !== undefined ? Number(rt.connectionQualityRemote) : null,
            outBytesPerSec: rt.outBytesPerSec !== undefined ? Number(rt.outBytesPerSec) : null,
            inBytesPerSec: rt.inBytesPerSec !== undefined ? Number(rt.inBytesPerSec) : null,
            sendRateBytesPerSecond: rt.sendRateBytesPerSecond !== undefined ? Number(rt.sendRateBytesPerSecond) : null,
            pendingReliable: rt.pendingReliable !== undefined ? Number(rt.pendingReliable) : null,
            sentUnackedReliable: rt.sentUnackedReliable !== undefined ? Number(rt.sentUnackedReliable) : null,
            usecQueueTimeMs: rt.usecQueueTime !== undefined && rt.usecQueueTime !== null ? Math.round(Number(rt.usecQueueTime) / 1000) : null,
            at: now(),
          };
        }
      } catch (err) {
        emit('transport-status-error', { id, message: err && err.message ? err.message : String(err) });
      }
      return lastStatus;
    },

    health() {
      return {
        id, role, peer: peerSteamId, state, generation, attempt,
        connected: state === STATE.CONNECTED || state === STATE.DEGRADED,
        ageMs: createdAt ? Math.max(0, now() - createdAt) : 0,
        aliveMs: connectedAt ? Math.max(0, now() - connectedAt) : 0,
        lastRecvAgoMs: lastRecvAt ? Math.max(0, now() - lastRecvAt) : null,
        lastSendAgoMs: lastSendAt ? Math.max(0, now() - lastSendAt) : null,
        lastStateChangeAgoMs: lastStateChangeAt ? Math.max(0, now() - lastStateChangeAt) : null,
        retryInMs: retryAt ? Math.max(0, retryAt - now()) : 0,
        queuedBytes, maxQueuedSeen, backpressured: paused, queueSize: outQueue.length,
        failureReason, failureText, failureClass,
        rtt: lastStatus ? lastStatus.ping : null,
        pendingReliable: lastStatus ? lastStatus.pendingReliable : null,
        ...counters,
      };
    },
  };

  return api;
}

module.exports = {
  STATE,
  STEAM_STATE,
  SEND_FLAG,
  END_REASON,
  OUT_HIGH_WATER,
  OUT_LOW_WATER,
  OUT_MAX_WATER,
  DEFAULT_MAX_CHUNK,
  describeEndReason,
  classifyFailure,
  createSteamConnection,
};
