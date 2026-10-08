'use strict';
// ============================================================================
// Stronghold Link — SteamConnectionManager：Primary / Backup 两条，仅此而已
//
// 这是 0.13.3 那个"预热连接池"（`PEER_POOL_TARGET = 4`、随机 27~40 秒寿命、
// 串行 `refillPool()`、池子空了就现场握手 30 秒）的**替代品**，而且是刻意做成
// 很小的一块：
//
//   0.13.3：为"未来可能来的每一条本机 TCP"提前养 4 条 Steam 连接，寿命到了换新
//   0.14.0：为"当前这一个远端玩家"维持 **1 条** Primary（必要时 +1 条 Backup）
//
// 规格 §二十三 的原话是"不能再建 4/8/几十条预热 P2P"，§三十四-② 是"固定创建 3/4/8
// 条 P2P"。这里用 `maxConnections = 2` 硬顶死，并且**没有任何"提前建"的路径**：
// `ensure()` 只在 Primary 真的不在了、或者 Backup 条件成立时才建。
//
// 它还owns 一个 poll group（规格 §二十四：继续用 createPollGroup /
// receiveMessagesOnPollGroup，不要每连接一个轮询循环）。
// ============================================================================

const { createSteamConnection, STATE, STEAM_STATE, classifyFailure } = require('./steam-connection.cjs');

/** 规格 §七 的退避序列。第 n 次失败取 `[min(n, 6)]`。 */
const RETRY_BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000, 15000, 30000, 60000]);

/** 规格 §七 的随机抖动：±20%。 */
const RETRY_JITTER = 0.2;

/** 硬上限。规格 §三：一个远端玩家 = 1 条 Primary，必要时 0~1 条 Backup。 */
const MAX_TRANSPORT_CONNECTIONS = 2;

/** Primary 稳定多久之后才考虑补 Backup。 */
const BACKUP_ARM_DELAY_MS = 30000;

/** 业务量到多少才值得补 Backup（规格 §六：Backup 不强制存在）。 */
const BACKUP_STREAM_THRESHOLD = 8;

/** 一次 poll 最多抽多少条消息。 */
const POLL_BATCH = 32;

function backoffDelay(failStreak, random = Math.random) {
  const idx = Math.min(Math.max(0, failStreak - 1), RETRY_BACKOFF_MS.length - 1);
  const base = RETRY_BACKOFF_MS[idx];
  const factor = 1 + (random() * 2 - 1) * RETRY_JITTER;
  return Math.max(250, Math.round(base * factor));
}

/**
 * @param {object} spec
 * @param {'host'|'joiner'} spec.role
 * @param {string} [spec.peerSteamId]   joiner 必填
 * @param {object} spec.sockets         `steam.networkingSockets`
 * @param {object} spec.relay           `createRelayStatusMonitor()` 的返回值
 * @param {() => number} [spec.now]
 * @param {(type:string, payload?:object) => void} [spec.onEvent]
 * @param {(msg:{connection:object, data:Buffer, handle:any, role:string}) => void} [spec.onMessage]
 */
function createSteamConnectionManager(spec = {}) {
  const role = spec.role === 'host' ? 'host' : 'joiner';
  const sockets = spec.sockets || null;
  const relay = spec.relay || null;
  const peerSteamId = String(spec.peerSteamId || '');
  const now = typeof spec.now === 'function' ? spec.now : Date.now;
  const onEvent = typeof spec.onEvent === 'function' ? spec.onEvent : () => {};
  const onMessage = typeof spec.onMessage === 'function' ? spec.onMessage : () => {};
  const maxConnections = Number.isFinite(spec.maxConnections) ? Math.min(spec.maxConnections, MAX_TRANSPORT_CONNECTIONS) : MAX_TRANSPORT_CONNECTIONS;
  const random = typeof spec.random === 'function' ? spec.random : Math.random;

  let primary = null;
  let backup = null;
  let pollGroup = null;
  let listenSocket = null;
  let started = false;
  let connectionSeq = 0;
  let failStreak = 0;
  let lastFailure = null;
  let unsubscribe = null;
  /** 房主侧：handle -> SteamConnection，用来把 poll group 抽到的消息认回哪条连接。 */
  const byHandle = new Map();

  const stats = {
    steamConnectionsCreated: 0,
    steamConnectionsSucceeded: 0,
    steamConnectionsFailed: 0,
    steamConnectionsClosed: 0,
    activeSteamConnections: 0,
    maxActiveSteamConnections: 0,
    inboundConnections: 0,
    rejectedConnections: 0,
    pollDrains: 0,
    messagesDrained: 0,
    acceptedPeers: 0,
    lastRelayStatus: '',
    relayBlocked: 0,
  };

  const emit = (type, payload) => {
    try { onEvent(type, payload); } catch { /* ignore */ }
  };

  const activeList = () => [primary, backup].filter((c) => c && c.isUsable);
  const activeCount = () => activeList().length;

  const noteActive = () => {
    stats.activeSteamConnections = activeCount();
    if (stats.activeSteamConnections > stats.maxActiveSteamConnections) stats.maxActiveSteamConnections = stats.activeSteamConnections;
  };

  const newConnection = (slot) => {
    connectionSeq += 1;
    const conn = createSteamConnection({
      id: `${slot}-${connectionSeq}`,
      role: slot,
      peerSteamId,
      sockets,
      virtualPort: spec.virtualPort,
      maxChunk: spec.maxChunk,
      now,
      onEvent: (type, payload) => {
        if (type === 'transport-connected') {
          stats.steamConnectionsSucceeded += 1;
          failStreak = 0;
        }
        emit(type, payload);
      },
    });
    if (slot === 'primary') primary = conn; else backup = conn;
    // ★ 这个计数器只管一件事：**建过几个 transport 连接对象**。它不是"握了几次手"——
    // 同一个对象在 BACKOFF 到点后重新 open() 会在线上真的再握一次手，但对象还是那一个，
    // 这里不重复计数（那次握手记在 conn.attempt 上，成败记在 steamConnectionsSucceeded/Failed）。
    // 三个数一起看才能判断有没有 retry storm：建得少 + 失败多 + attempt 涨得快 = 在反复重试。
    stats.steamConnectionsCreated += 1;
    noteActive();
    return conn;
  };

  /** 记下 handle，poll group 抽到消息时靠它认人。 */
  const trackHandle = (conn) => {
    if (conn && conn.handle !== null && conn.handle !== undefined) byHandle.set(conn.handle, conn);
  };

  /**
   * 决定"现在该不该建新连接"。规格 §七：relay 不可用时**既不建也不排重试**。
   * @returns {{opened:boolean, reason:string}}
   */
  const ensure = () => {
    if (!started) return { opened: false, reason: 'not-started' };
    if (role === 'host') return { opened: false, reason: 'host-inbound-only' };

    const livePrimary = primary && primary.isUsable && primary.state !== STATE.BACKOFF && primary.state !== STATE.RELAY_WAIT;
    if (livePrimary) {
      maybeArmBackup();
      return { opened: false, reason: 'primary-live' };
    }
    if (activeCount() >= maxConnections) return { opened: false, reason: 'at-cap' };

    // ★ 退避窗口内绝不新建连接（规格 §七 / §三十四-④）。这一条是实测打出来的：
    // BACKOFF 的连接 connection===null ⇒ 不计入 activeCount()，下面的 at-cap 拦不住；
    // livePrimary 只判 state 也拦不住；于是 tick() 每跑一次都会走到下面 newConnection()
    // 并立刻再来一次 connectP2P —— 退避序列被完全绕过（retry storm）。
    // 到点之后的唤醒是 tick() 里 BACKOFF 分支的职责，这里只负责"没到点就别动"。
    if (primary && primary.state === STATE.BACKOFF) return { opened: false, reason: 'backoff' };

    const gate = relay && typeof relay.canOpenNewConnection === 'function' ? relay.canOpenNewConnection() : { ok: true, reason: 'no-monitor' };
    if (gate.ok === false) {
      stats.relayBlocked += 1;
      if (!primary) {
        const conn = newConnection('primary');
        conn.open({ relayGate: gate });
      }
      emit('manager-relay-blocked', { reason: gate.reason, detail: gate.detail || '', debugMessage: gate.debugMessage || '' });
      return { opened: false, reason: 'relay-unavailable' };
    }

    const conn = newConnection('primary');
    const rc = conn.open({ relayGate: gate });
    if (rc.ok) { trackHandle(conn); return { opened: true, reason: 'opened' }; }
    return { opened: false, reason: rc.code || 'open-failed' };
  };

  /** 规格 §六：只在 Primary 稳定够久 + 业务量够大时才补 Backup。 */
  const maybeArmBackup = () => {
    if (activeCount() >= maxConnections) return false;
    if (backup && backup.isUsable) return false;
    const p = primary;
    if (!p || p.state !== STATE.CONNECTED) return false;
    const aliveMs = p.health().aliveMs;
    if (aliveMs < BACKUP_ARM_DELAY_MS) return false;
    const streams = Number.isFinite(spec.activeStreams) ? spec.activeStreams : (typeof spec.getActiveStreams === 'function' ? spec.getActiveStreams() : 0);
    if (!(streams >= BACKUP_STREAM_THRESHOLD)) return false;
    const gate = relay && typeof relay.canOpenNewConnection === 'function' ? relay.canOpenNewConnection() : { ok: true };
    if (gate.ok === false) return false;
    const conn = newConnection('backup');
    const rc = conn.open({ relayGate: gate });
    if (rc.ok) {
      trackHandle(conn);
      emit('manager-backup-armed', { aliveMs, streams });
      return true;
    }
    backup = null;
    return false;
  };

  /** 由全局 onConnectionStateChange 转发 / getPendingStateChanges 兜底。 */
  const handleStateChange = (change) => {
    const handle = change && change.connection;
    let conn = handle !== undefined && handle !== null ? byHandle.get(handle) : null;

    // 房主侧：一条全新的入站连接。
    if (!conn && role === 'host') {
      const info = (change && change.info) || {};
      const newState = Number(change && change.newState);
      if (newState === STEAM_STATE.Connecting || newState === STEAM_STATE.FindingRoute) {
        // 出站连接（listenSocket === 0）不 accept —— 0.13.3 实测对它 accept 会返回 11 InvalidParam。
        if (info.listenSocket) {
          try {
            if (sockets && typeof sockets.acceptConnection === 'function') sockets.acceptConnection(handle);
            if (pollGroup !== null && sockets && typeof sockets.setConnectionPollGroup === 'function') sockets.setConnectionPollGroup(handle, pollGroup);
          } catch (err) {
            emit('manager-accept-failed', { message: err && err.message ? err.message : String(err) });
          }
        }
        if (activeCount() >= maxConnections) {
          stats.rejectedConnections += 1;
          try { if (sockets && typeof sockets.closeConnection === 'function') sockets.closeConnection(handle, 0, '连接数已满', false); } catch { /* ignore */ }
          emit('manager-peer-rejected', { reason: 'at-cap', active: activeCount() });
          return false;
        }
        conn = newConnection(primary ? 'backup' : 'primary');
        conn.adopt(handle, { inbound: true, info });
        byHandle.set(handle, conn);
        stats.inboundConnections += 1;
        stats.steamConnectionsSucceeded += 1;
        stats.acceptedPeers += 1;
        noteActive();
        emit('manager-peer-accepted', { id: conn.id, slot: conn.role, active: activeCount() });
        return true;
      }
      return false;
    }

    if (!conn) return false;
    const before = conn.state;
    const handled = conn.onSteamStateChange(change);
    if (!handled) return false;
    const after = conn.state;
    if (before !== STATE.CLOSED && (after === STATE.DEGRADED || after === STATE.BACKOFF)) {
      stats.steamConnectionsFailed += 1;
      stats.steamConnectionsClosed += 1;
      lastFailure = { at: now(), class: conn.failureClass, text: conn.failureText, role: conn.role };
      // ★ 句柄要在 onSteamStateChange() 之前取：上面那一句已经在 steam-connection.cjs
      // 里把 conn.connection 置 null，直接 byHandle.delete(conn.handle) 删的是 null 键（空操作）。
      // 死句柄留在表里，同一个 handle 再报一次状态（ClosedByPeer 后常接 Dead）就会被
      // 当成"新的失败"重复记账：steamConnectionsFailed 记两次、failStreak 被推下一档。
      const deadHandle = (handle !== null && handle !== undefined) ? handle : conn.handle;
      if (deadHandle !== null && deadHandle !== undefined) byHandle.delete(deadHandle);
      if (conn.role === 'primary') {
        failStreak += 1;
        const delay = backoffDelay(failStreak, random);
        conn.backoff(delay, { reason: conn.failureText, failureClass: conn.failureClass });
        emit('manager-primary-failed', {
          peer: peerSteamId, elapsedMs: conn.health().ageMs, reason: conn.failureText,
          failureClass: conn.failureClass, retryInMs: delay, failStreak,
          relay: relay ? relay.stats().lastRelayStatus : '',
        });
      } else {
        backup = null;
        emit('manager-backup-lost', { reason: conn.failureText, failureClass: conn.failureClass });
      }
      noteActive();
    } else if (after === STATE.CONNECTED) {
      noteActive();
    }
    return true;
  };

  /** 抽空 poll group，把消息按 connection 认人后交给上层。规格 §二十四：统一 poll / 统一 drain。 */
  const poll = () => {
    if (pollGroup === null || !sockets || typeof sockets.receiveMessagesOnPollGroup !== 'function') return 0;
    let drained = 0;
    for (let i = 0; i < 8; i += 1) {
      let batch = null;
      try { batch = sockets.receiveMessagesOnPollGroup(pollGroup, POLL_BATCH); } catch (err) {
        emit('manager-poll-error', { message: err && err.message ? err.message : String(err) });
        break;
      }
      if (!batch || !batch.length) break;
      stats.pollDrains += 1;
      for (const msg of batch) {
        drained += 1;
        stats.messagesDrained += 1;
        const conn = byHandle.get(msg.connection) || null;
        if (conn) conn.noteReceived(msg.data ? msg.data.length : 0);
        onMessage({ connection: conn, data: msg.data, handle: msg.connection, role: conn ? conn.role : 'unknown', at: msg.timeReceived || now() });
      }
      if (batch.length < POLL_BATCH) break;
    }
    return drained;
  };

  /**
   * 每 tick 调一次（由 MuxScheduler 驱动，本模块**不建任何定时器**）。
   * 顺带兜底 `getPendingStateChanges()` —— 全局回调漏掉的状态变化在这里补上。
   */
  const tick = () => {
    if (!started) return null;

    if (sockets && typeof sockets.getPendingStateChanges === 'function') {
      try {
        const pending = sockets.getPendingStateChanges();
        if (Array.isArray(pending)) for (const change of pending) handleStateChange(change);
      } catch { /* 兜底轮询失败不影响主路径 */ }
    }

    for (const conn of [primary, backup]) {
      if (!conn) continue;
      if (conn.state === STATE.BACKOFF && conn.retryAt && now() >= conn.retryAt) {
        const gate = relay && typeof relay.canOpenNewConnection === 'function' ? relay.canOpenNewConnection() : { ok: true };
        const rc = conn.open({ relayGate: gate });
        if (rc.ok) { trackHandle(conn); }
      } else if (conn.state === STATE.RELAY_WAIT) {
        const gate = relay && typeof relay.canOpenNewConnection === 'function' ? relay.canOpenNewConnection() : { ok: true };
        // 规格 §七：relay 恢复后**只创建 1 条**，确认 CONNECTED 之后再决定要不要补。
        // 唤醒的是同一个占位对象（不是另建一条、把旧的丢在 RELAY_WAIT 里），所以这里
        // 同样不动 steamConnectionsCreated —— 见 newConnection() 里的口径说明。
        if (gate.ok !== false) { const rc = conn.open({ relayGate: gate }); if (rc.ok) trackHandle(conn); }
      } else if (conn.isConnected) {
        conn.refreshStatus();
      }
    }

    ensure();
    noteActive();
    return { active: activeCount(), failStreak, lastFailure };
  };

  const api = {
    role,
    get primary() { return primary; },
    get backup() { return backup; },
    get pollGroup() { return pollGroup; },
    get listenSocket() { return listenSocket; },
    get activeCount() { return activeCount(); },
    get failStreak() { return failStreak; },
    get lastFailure() { return lastFailure ? { ...lastFailure } : null; },
    stats,

    start() {
      if (started) return { ok: true, already: true };
      if (!sockets) return { ok: false, code: 'NOSDK' };
      // started 只在"真的能开工"之后才置位：NOSDK / ELISTEN 提前返回时如果已经置位，
      // 对象会认为自己启动了，stop() 会返回 true 并去关一堆从来没建过的东西。
      started = true;

      if (pollGroup === null && typeof sockets.createPollGroup === 'function') {
        try { pollGroup = sockets.createPollGroup(); } catch (err) {
          emit('manager-pollgroup-error', { message: err && err.message ? err.message : String(err) });
        }
      }

      if (typeof sockets.onConnectionStateChange === 'function') {
        const ret = sockets.onConnectionStateChange(handleStateChange);
        // 实测这个 API 返回的是**反注册函数**（SteamNetworkingSocketsManager.d.ts:408）。
        if (typeof ret === 'function') unsubscribe = ret;
      }

      if (role === 'host') {
        if (typeof sockets.createListenSocketP2P === 'function') {
          try {
            listenSocket = sockets.createListenSocketP2P(Number.isFinite(spec.virtualPort) ? spec.virtualPort : 0);
            emit('manager-listening', { listenSocket });
          } catch (err) {
            emit('manager-listen-failed', { message: err && err.message ? err.message : String(err) });
            // 启动失败要把已经建好的 poll group / 状态变化订阅收回去，并把 started 复位 ——
            // 否则这次失败会留下一个"认为自己活着"的空壳，后面 stop() 还会去关它。
            if (unsubscribe) { try { unsubscribe(); } catch { /* ignore */ } unsubscribe = null; }
            if (pollGroup !== null && typeof sockets.destroyPollGroup === 'function') {
              try { sockets.destroyPollGroup(pollGroup); } catch { /* ignore */ }
            }
            pollGroup = null;
            started = false;
            return { ok: false, code: 'ELISTEN' };
          }
        }
        emit('manager-started', { role, pollGroup, listenSocket });
        return { ok: true, pollGroup, listenSocket };
      }

      emit('manager-started', { role, pollGroup });
      ensure();
      return { ok: true, pollGroup };
    },

    stop(reason = '隧道已停止') {
      if (!started) return false;
      started = false;
      for (const conn of [primary, backup]) {
        if (!conn) continue;
        // 已经 CLOSED 的连接不重复计数：它会自己把 steamConnectionsClosed 记一次，
        // 这里再记一次就成了"关了两条"的假账。
        const alreadyClosed = conn.state === STATE.CLOSED;
        try { conn.close(0, reason, { linger: false }); } catch { /* ignore */ }
        if (!alreadyClosed) stats.steamConnectionsClosed += 1;
      }
      primary = null;
      backup = null;
      byHandle.clear();
      if (unsubscribe) { try { unsubscribe(); } catch { /* ignore */ } unsubscribe = null; }
      if (listenSocket !== null && sockets && typeof sockets.closeListenSocket === 'function') {
        try { sockets.closeListenSocket(listenSocket); } catch { /* ignore */ }
      }
      if (pollGroup !== null && sockets && typeof sockets.destroyPollGroup === 'function') {
        try { sockets.destroyPollGroup(pollGroup); } catch { /* ignore */ }
      }
      listenSocket = null;
      pollGroup = null;
      noteActive();
      emit('manager-stopped', { reason });
      return true;
    },

    /** 统一出口：优先 Primary，不行就 Backup；都没有就让上层排队（返回 ok:false）。 */
    send(buffer) {
      const p = primary;
      if (p && p.isUsable) {
        const n = p.queue(buffer);
        if (n > 0) return { ok: true, via: 'primary', queued: n };
      }
      const b = backup;
      if (b && b.isUsable) {
        const n = b.queue(buffer);
        if (n > 0) return { ok: true, via: 'backup', queued: n };
      }
      // 两条都不可用：让上层排队等（返回 ok:false），**不在这里建连接、也不报 relay 阻塞**
      // —— relayBlocked 只由 ensure() 的 relay 闸门记账，这里加 0 是无意义的死代码。
      return { ok: false, via: '', queued: 0 };
    },

    /** 直接把两条连接的队列往 Steam 里灌（调度器在发送阶段调）。 */
    flush(maxBytes) {
      let sent = 0;
      const p = primary;
      if (p && p.isUsable) sent += p.flush({ maxBytes });
      const b = backup;
      if (b && b.isUsable) sent += b.flush({ maxBytes });
      return sent;
    },

    handleStateChange,
    poll,
    tick,
    ensure,
    maybeArmBackup,

    /** 某个 handle 是不是我们认识的（诊断用）。 */
    owns(handle) { return byHandle.has(handle); },

    health() {
      return {
        role,
        peer: peerSteamId,
        activeSteamConnections: activeCount(),
        maxActiveSteamConnections: stats.maxActiveSteamConnections,
        failStreak,
        lastFailure: lastFailure ? { ...lastFailure } : null,
        relay: relay ? relay.stats() : null,
        primary: primary ? primary.health() : null,
        backup: backup ? backup.health() : null,
        ...stats,
      };
    },
  };

  return api;
}

module.exports = {
  RETRY_BACKOFF_MS,
  RETRY_JITTER,
  MAX_TRANSPORT_CONNECTIONS,
  BACKUP_ARM_DELAY_MS,
  BACKUP_STREAM_THRESHOLD,
  POLL_BATCH,
  backoffDelay,
  classifyFailure,
  createSteamConnectionManager,
};
