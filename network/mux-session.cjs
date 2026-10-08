'use strict';
// ============================================================================
// Stronghold Link — MuxSession：一条干道上的全部流
//
// 规格 §十五 要求把三件事拆开：
//
//     SteamConnection（transport，1~2 条）  ── 会断、会重连、换一条是常事
//     MuxSession       （会话，1 个）        ── transport 断了它**不跟着死**
//     MuxStream        （流，N 条）          ── 业务 TCP 的化身
//
// 0.13.3 之所以"一条浏览器连接断开就销毁一条 Steam 连接、Steam 连接抖动就毁掉整个
// 页面加载"，根源就是这三件事在数据结构上是同一个对象（`peer`）。这个模块是那条
// 分界线：**它只认流号和世代号，不认 connection 句柄**。transport 换了，流还在，
// 世代号 +1 重挂一次就接着跑。
//
// 本模块不 require steamworks、不 require electron、不 require socket 之外的东西，
// 所以可以在没有 Steam 运行时的机器上把 Receive/Send 两条路径完整跑通。
// ============================================================================

const mux = require('./stream-mux.cjs');
const { STATE: STREAM_STATE, createMuxStream } = require('./mux-stream.cjs');
const { createBackpressureController } = require('./mux-backpressure.cjs');

/** 会话状态（规格 §十五 / 文档 Phase 2 第 8 条）。 */
const SESSION_STATE = Object.freeze({
  IDLE: 'IDLE',
  OPENING: 'OPENING',
  ACTIVE: 'ACTIVE',
  DEGRADED: 'DEGRADED',
  RECOVERING: 'RECOVERING',
  CLOSED: 'CLOSED',
});

/** transport 丢了之后给多久把流救回来；超过就用 end() 而不是 destroy() 收摊。 */
const SESSION_RECOVER_GRACE_MS = 60000;

/** 开工等业务多久。**绝不等于 Steam 的 30000ms**（规格 §二十一）。 */
const STREAM_OPEN_WAIT_MS = 3000;

/** 一次 takeFrames 最多吐多少帧 / 多少字节（规格 §十四：不要发巨大 Steam message）。 */
const SEND_BATCH_FRAMES = 64;
const SEND_BATCH_BYTES = 64 * 1024;

/** 心跳与空闲（规格 §十八：这些 deadline 全由调度器统一驱动，本模块不自建定时器）。 */
const PING_INTERVAL_MS = 5000;
const PONG_TIMEOUT_MS = 15000;
const STREAM_IDLE_MS = 300000;

function nextEven(id) {
  let n = (id + 2) >>> 0;
  if (n >= 0xfffffffe || n < mux.STREAM_ID_CLIENT_START) n = mux.STREAM_ID_CLIENT_START;
  return n;
}

/**
 * @param {object} spec
 * @param {'host'|'joiner'} spec.role
 * @param {number} [spec.maxStreams]
 * @param {(streamId:number, generation:number) => (import('net').Socket|null)} [spec.openLocalSocket]
 *        房主用：收到 Open 帧时在本机开一条到游戏端口的连接。
 * @param {object} [spec.backpressure]
 * @param {() => number} [spec.now]
 * @param {(type:string, payload?:object) => void} [spec.onEvent]
 */
function createMuxSession(spec = {}) {
  const role = spec.role === 'host' ? 'host' : 'joiner';
  const now = typeof spec.now === 'function' ? spec.now : Date.now;
  const onEvent = typeof spec.onEvent === 'function' ? spec.onEvent : () => {};
  const openLocalSocket = typeof spec.openLocalSocket === 'function' ? spec.openLocalSocket : null;
  const maxStreams = Number.isFinite(spec.maxStreams) ? spec.maxStreams : 64;
  const maxQueuedBytes = Number.isFinite(spec.maxQueuedBytes) ? spec.maxQueuedBytes : undefined;

  const backpressure = spec.backpressure || createBackpressureController({
    streamHigh: spec.streamHigh,
    streamLow: spec.streamLow,
    globalHigh: spec.globalHigh,
    globalLow: spec.globalLow,
    onEvent,
  });

  /** @type {Map<number, object>} 流号 -> MuxStream */
  const streams = new Map();
  /** 不属于任何流的帧（Ping/Pong）。 */
  const sessionQueue = [];
  const decoder = mux.createFrameDecoder();

  let state = SESSION_STATE.IDLE;
  let transport = null;
  /** 曾经挂上过 transport 吗 —— 决定这次 attach 是"开工"还是"重挂"。 */
  let everAttached = false;
  let reattachCount = 0;
  let openedAt = 0;
  let degradedAt = 0;
  let nextStreamId = mux.STREAM_ID_CLIENT_START;
  /** 出站 round-robin 的游标，保证没有哪条流能一直霸占带宽（规格 §二十六）。 */
  let rrCursor = 0;

  const stats = {
    streamsOpened: 0,
    streamsClosed: 0,
    streamsReset: 0,
    staleFrames: 0,
    badFrames: 0,
    droppedFrames: 0,
    protocolViolations: 0,
    bytesToLocal: 0,
    bytesToRemote: 0,
    framesSent: 0,
    framesReceived: 0,
    windowsSent: 0,
    pingsSent: 0,
    pongsSent: 0,
    lastPingSentAt: 0,
    lastPongAt: 0,
    lastRttMs: null,
    reattachCount: 0,
    transportLost: 0,
  };

  const emit = (type, payload) => {
    try { onEvent(type, payload); } catch { /* 日志/界面回调不能带倒网络层 */ }
  };

  const setState = (next, reason) => {
    if (state === next) return state;
    const prev = state;
    state = next;
    if (next === SESSION_STATE.ACTIVE && !openedAt) openedAt = now();
    if (next === SESSION_STATE.DEGRADED) degradedAt = now();
    emit('session-state', { from: prev, to: next, reason: reason || '' });
    return state;
  };

  // ── 出站：排队与取帧 ────────────────────────────────────────────────────
  const enqueueSession = (type, buffer, bytes) => {
    sessionQueue.push({ type, priority: mux.PRIORITY[type], buffer, bytes, at: now(), session: true });
  };

  const removeStream = (stream, { hard = false, silent = false } = {}) => {
    if (!streams.has(stream.id)) return false;
    streams.delete(stream.id);
    backpressure.unregister(stream);
    stream.dispose({ hard });
    if (!silent) {
      if (hard) stats.streamsReset += 1;
      else stats.streamsClosed += 1;
      emit('stream-removed', { stream: stream.id, generation: stream.generation, hard, ...stream.snapshot() });
    }
    return true;
  };

  /**
   * 出站队列已经空了、又已经收摊的流，到这儿才真正摘掉。
   * 这是"数据优先于 CLOSE"的落地点：CLOSE 帧排在数据帧后面，只有它也被取走之后，
   * 这条流才允许从表里消失。
   */
  const reap = () => {
    let n = 0;
    for (const stream of [...streams.values()]) {
      if (stream.isClosed && !stream.hasPending()) { removeStream(stream, { hard: stream.state === STREAM_STATE.RESET }); n += 1; }
    }
    return n;
  };

  const streamList = () => [...streams.values()];

  /** 按"队头优先级 + 轮转"取一批帧（规格 §二十六 公平调度 / §二十七 控制帧优先）。 */
  const takeFrames = (options = {}) => {
    const maxFrames = Number.isFinite(options.maxFrames) ? options.maxFrames : SEND_BATCH_FRAMES;
    const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : SEND_BATCH_BYTES;
    const out = [];
    let bytes = 0;

    // ★ 注意 mux.PRIORITY 是**按帧类型数值**索引的（PRIORITY[0x01] === 5），
    //   所以这里必须用 mux.PRIORITY[mux.TYPE.Window]，写 .Window 会拿到 undefined，
    //   整个优先级循环一次都不跑（踩过一次，六个用例一起红）。
    const CONTROL_MAX = mux.PRIORITY[mux.TYPE.Window];

    // 第一轮：队头是控制帧（Reset/Close/Open/Window）的流，按优先级从高到低服务。
    // 这一轮不受轮转游标影响 —— 一条流要发 CLOSE 不该排在别人后面。
    for (let prio = 0; prio <= CONTROL_MAX && out.length < maxFrames && bytes < maxBytes; prio += 1) {
      for (const stream of streamList()) {
        if (out.length >= maxFrames || bytes >= maxBytes) break;
        if (stream.headPriority() !== prio) continue;
        const frame = stream.takeFrame();
        if (frame) { out.push(frame); bytes += frame.bytes; stats.framesSent += 1; }
      }
    }

    // 第二轮：剩下的（数据帧 + 会话级 ping/pong）轮转，谁也不许霸占带宽。
    // 这一轮**不再挑优先级** —— 能在第一轮发掉的控制帧已经发掉了；留到这里的
    // 要么是数据帧，要么是"排在数据后面的那条 CLOSE"（严格 FIFO，不能跳过它，
    // 否则队列会卡死在一条永远取不出来的 CLOSE 上）。
    const rest = streamList();
    const total = rest.length + (sessionQueue.length ? 1 : 0);
    let guard = 0;
    while (out.length < maxFrames && bytes < maxBytes && guard < total * maxFrames) {
      guard += 1;
      if (!total) break;
      rrCursor = (rrCursor + 1) % total;
      let item = null;
      if (rrCursor < rest.length) {
        item = rest[rrCursor].takeFrame();
      } else if (sessionQueue.length) {
        item = sessionQueue.shift();
      }
      if (item) { out.push(item); bytes += item.bytes; stats.framesSent += 1; }
      else if (!rest.some((s) => s.hasPending()) && !sessionQueue.length) break;
    }

    if (out.length) reap();
    return out;
  };

  // ── 本机 socket 接线 ────────────────────────────────────────────────────
  const wireSocket = (stream, socket) => {
    stream.attachSocket(socket);
    stream.listen('data', (chunk) => {
      stream.push(chunk);
      stats.bytesToRemote += chunk.length;
      // 对端 Window 额度用光就暂停读本机 socket（端到端背压，规格 §十三）。
      if (stream.remoteCredit <= 0) stream.pauseLocal();
      backpressure.update();
    });
    stream.listen('end', () => {
      // 本机这一侧发完了：把 CLOSE 排到数据后面（严格 FIFO，所以数据一定在前面）。
      stream.closeLocal();
      emit('stream-local-end', { stream: stream.id, generation: stream.generation });
    });
    stream.listen('error', (err) => {
      stats.protocolViolations += 0;
      emit('stream-socket-error', { stream: stream.id, message: err && err.message ? err.message : String(err) });
      stream.reset(mux.RESET_REASON.Protocol);
      removeStream(stream, { hard: true });
    });
    stream.listen('close', () => {
      if (!stream.isClosed) stream.closeLocal();
    });
    return stream;
  };

  const newStream = (id, generation, socket, accepted) => {
    const stream = createMuxStream({
      id,
      generation,
      role,
      socket,
      accepted,
      maxQueuedBytes,
      now,
      onEvent: (type, payload) => emit(type, payload),
      onOverflow: (s) => {
        // 积压超过硬上限：对端就是不在读了。只掐这一条流，绝不碰别的流（规格 §二十五）。
        emit('stream-overflow', { stream: s.id, queuedBytes: s.queuedBytes, limit: maxQueuedBytes });
        s.reset(mux.RESET_REASON.Backpressure);
        removeStream(s, { hard: true });
      },
    });
    streams.set(id, stream);
    backpressure.register(stream);
    stats.streamsOpened += 1;
    return stream;
  };

  // ── 接收路径（规格 §二十五）────────────────────────────────────────────
  const dispatch = (frame) => {
    stats.framesReceived += 1;
    const { type, streamId, generation } = frame;

    // 会话级：流号 0，只走 Ping/Pong。
    if (streamId === mux.STREAM_ID_SESSION) {
      if (type === mux.TYPE.Ping) { enqueueSession(mux.TYPE.Pong, mux.encodePong(), 0); stats.pongsSent += 1; return true; }
      if (type === mux.TYPE.Pong) {
        stats.lastPongAt = now();
        if (stats.lastPingSentAt) stats.lastRttMs = Math.max(0, stats.lastPongAt - stats.lastPingSentAt);
        return true;
      }
      stats.droppedFrames += 1;
      return false;
    }

    if (type === mux.TYPE.Open) {
      // 房主只接受 Open，自己不发 Open。加入者的流号是偶数（规格 §十一）。
      if (role !== 'host') {
        stats.protocolViolations += 1;
        enqueueSession(mux.TYPE.Reset, mux.encodeReset(streamId, generation, mux.RESET_REASON.Protocol), 0);
        emit('protocol-violation', { rule: 'open-from-joiner', stream: streamId });
        return false;
      }
      if (streamId % 2 !== 0) {
        stats.protocolViolations += 1;
        enqueueSession(mux.TYPE.Reset, mux.encodeReset(streamId, generation, mux.RESET_REASON.Protocol), 0);
        emit('protocol-violation', { rule: 'odd-stream-id-from-client', stream: streamId });
        return false;
      }
      const existing = streams.get(streamId);
      if (existing) {
        // 同流号 + 更高世代 = reattach（规格 §十六）。推高世代复用，不重开 socket。
        if (generation > existing.generation) {
          while (existing.generation < generation) existing.bumpGeneration();
          existing.setAllocatesId(false);
          emit('stream-reattached', { stream: streamId, generation });
          return true;
        }
        return true;
      }
      if (streams.size >= maxStreams) {
        enqueueSession(mux.TYPE.Reset, mux.encodeReset(streamId, generation, mux.RESET_REASON.StreamLimit), 0);
        emit('stream-refused', { stream: streamId, reason: 'limit', maxStreams });
        return false;
      }
      const socket = openLocalSocket ? openLocalSocket(streamId, generation) : null;
      const stream = newStream(streamId, generation, socket, true);
      stream.setAllocatesId(false);
      if (socket) wireSocket(stream, socket);
      emit('stream-accepted', { stream: streamId, generation, hasSocket: !!socket });
      return true;
    }

    const stream = streams.get(streamId);
    if (!stream) {
      // 迟到帧：流已经收摊了。Reset 是"终结"帧，不必再答；别的就丢。
      if (type !== mux.TYPE.Reset) stats.droppedFrames += 1;
      return false;
    }

    const verdict = mux.checkGeneration(frame, stream.generation);
    if (verdict === 'stale') {
      // 旧 transport 上的迟到数据 —— 直接丢，绝不写进本机 socket（规格 §十七）。
      stats.staleFrames += 1;
      emit('stale-frame', { stream: streamId, generation, local: stream.generation, type: mux.typeName(type) });
      return false;
    }
    if (verdict === 'future' && type !== mux.TYPE.Open) {
      // 比本机新的世代：协议违规，只掐这一条流。
      stats.protocolViolations += 1;
      stream.reset(mux.RESET_REASON.Protocol);
      removeStream(stream, { hard: true });
      emit('protocol-violation', { rule: 'future-generation', stream: streamId, generation, local: stream.generation });
      return false;
    }

    switch (type) {
      case mux.TYPE.Data: {
        const flushed = stream.writeLocal(frame.payload);
        stats.bytesToLocal += frame.payload ? frame.payload.length : 0;
        // 本机写不动了 —— 用 Window(0) 让**对端**停止读它那边的 socket。
        if (flushed === false) {
          stream.sendWindow(0);
          stats.windowsSent += 1;
        }
        return true;
      }
      case mux.TYPE.Window:
        stream.noteRemoteCredit(mux.decodeWindowCredit(frame.payload));
        // 对端腾出额度了，恢复读本机 socket（前提是本地背压没在拦）。
        if (stream.remoteCredit > 0 && backpressure.accepts(stream)) stream.resumeLocal();
        backpressure.update();
        return true;
      case mux.TYPE.Close:
        // 对端不再发数据了。**不要立刻 destroy**（规格 §十二）——
        // 本机这一侧如果还有话要说，流会停在 HALF_CLOSED_REMOTE 继续把数据发完。
        stream.closeRemote();
        if (!stream.hasPendingData()) {
          const s = stream.socket;
          if (s && !s.destroyed) { try { s.end(); } catch { /* ignore */ } }
        }
        return true;
      case mux.TYPE.Reset:
        stats.streamsReset += 1;
        removeStream(stream, { hard: true, silent: true });
        emit('stream-reset', { stream: streamId, generation, reason: mux.decodeResetReason(frame.payload) });
        return true;
      default:
        stats.droppedFrames += 1;
        return false;
    }
  };

  // ── 对外 API ────────────────────────────────────────────────────────────
  const api = {
    role,
    get state() { return state; },
    get transport() { return transport; },
    get streamCount() { return streams.size; },
    get streamIds() { return [...streams.keys()]; },
    backpressure,
    stats,

    /**
     * 收字节 → 解帧 → 分发。**解帧失败只影响这条 transport**，
     * 绝不做"destroy all peers"（规格 §二十五）。返回值让上层决定怎么办。
     */
    receive(buffer) {
      let frames;
      try {
        frames = decoder.push(buffer);
      } catch (err) {
        stats.badFrames += 1;
        // 解帧失败 = 这条 transport 上的字节流已经对不齐了，局面不可恢复。
        // 必须重置解码器，否则下一条 transport 接上来时会拿着残留半帧继续错下去。
        // **注意这里不碰任何 stream**：规格 §二十五 明说 frame malformed 只 RESET 那条流，
        // 不要 destroy all peers。会话和流原地保留，等新 transport 来 reattach。
        try { decoder.reset(); } catch { /* ignore */ }
        emit('frame-error', { code: err && err.code, message: err && err.message ? err.message : String(err) });
        return { ok: false, code: (err && err.code) || 'EMUXFRAME', frames: 0 };
      }
      for (const frame of frames) dispatch(frame);
      return { ok: true, frames: frames.length };
    },

    /** 供测试直接喂帧（跳过字节解码）。 */
    dispatchFrame(frame) { return dispatch(frame); },

    /** 加入者：本机来了一条连接 → 分配偶数流号 → 立刻排队 Open → 立刻收数据。 */
    openStream(socket) {
      if (state === SESSION_STATE.CLOSED) return null;
      const id = nextStreamId;
      nextStreamId = nextEven(id);
      const stream = newStream(id, 1, socket, false);
      stream.open();
      if (socket) wireSocket(stream, socket);
      // 会话还没 ACTIVE 也照样排进队列 —— 规格 §二十一：不允许浏览器在这儿等。
      emit('stream-opened', { stream: id, generation: 1, state, transport: transport ? transport.id : '' });
      return stream;
    },

    getStream(id) { return streams.get(id) || null; },
    snapshotStream(id) { const s = streams.get(id); return s ? s.snapshot() : null; },

    /** 调度器每 tick 调一次。 */
    takeFrames,
    reap,

    /** 心跳与空闲检查 —— 由调度器按 deadline 调，本模块不自建定时器（规格 §十八）。 */
    heartbeat() {
      if (state === SESSION_STATE.CLOSED) return null;
      const t = now();
      // ★ 先判超时再发下一个 Ping。反过来的话，一个已经死掉的对端会被我们每 5 秒
      //   一次的 Ping "续命"，永远报不出 pong-timeout —— 连接看起来一直活着。
      if (stats.lastPingSentAt) {
        const since = stats.lastPongAt ? t - stats.lastPongAt : t - stats.lastPingSentAt;
        if (since >= PONG_TIMEOUT_MS) return 'pong-timeout';
      }
      if (t - stats.lastPingSentAt >= PING_INTERVAL_MS) {
        stats.lastPingSentAt = t;
        enqueueSession(mux.TYPE.Ping, mux.encodePing(), 0);
        stats.pingsSent += 1;
        return 'ping';
      }
      return null;
    },

    /** 空闲太久的流直接收掉（防止对端悄悄消失留下半开连接）。 */
    sweepIdle(maxIdleMs = STREAM_IDLE_MS) {
      const t = now();
      const dead = [];
      for (const stream of streamList()) {
        if (!stream.isClosed && t - stream.lastActivity > maxIdleMs) { dead.push(stream.id); stream.reset(mux.RESET_REASON.Shutdown); removeStream(stream, { hard: true }); }
      }
      if (dead.length) emit('streams-reaped', { ids: dead, maxIdleMs });
      return dead;
    },

    /**
     * 挂上一条 transport。**第二次调用就是 reattach**：流全部保留、世代 +1、
     * 由发起方重发 Open（规格 §十六）。会话状态从 DEGRADED 回到 RECOVERING/ACTIVE。
     */
    attachTransport(t) {
      if (state === SESSION_STATE.CLOSED) return api;
      const reattach = everAttached;
      transport = t || null;
      everAttached = true;
      if (!reattach) {
        setState(SESSION_STATE.OPENING, 'attach');
        return api;
      }
      reattachCount += 1;
      stats.reattachCount += 1;
      setState(SESSION_STATE.RECOVERING, 'reattach');
      let rebound = 0;
      for (const stream of streamList()) {
        if (stream.isClosed) continue;
        stream.bumpGeneration();
        stream.setAllocatesId(role === 'joiner');
        // 发起方重发 Open（新一代）；接收方只推高世代，等对端的 Open 来对齐。
        // 必须 force：这条流在本地早就是 OPEN 了，普通的 open() 会直接返回 0 什么都不排。
        if (role === 'joiner') stream.open({ force: true });
        rebound += 1;
      }
      emit('session-reattach', { streams: rebound, transport: transport ? transport.id : '' });
      return api;
    },

    /** transport 没了。**会话不销毁**，只是降级（规格 §十五）。 */
    detachTransport(reason) {
      if (state === SESSION_STATE.CLOSED) return api;
      transport = null;
      stats.transportLost += 1;
      setState(SESSION_STATE.DEGRADED, reason || 'transport-lost');
      return api;
    },

    /** 收到第一条帧 / transport 报 CONNECTED 时调，用来把 OPENING/RECOVERING 推到 ACTIVE。 */
    markLive(detail) {
      if (state === SESSION_STATE.OPENING || state === SESSION_STATE.RECOVERING) setState(SESSION_STATE.ACTIVE, detail || 'live');
      return state;
    },

    /** 宽限期过了还没救回来：用 end() 收摊（不是 destroy，给游戏端一个干净的 EOF）。 */
    graceExpired() {
      if (state !== SESSION_STATE.DEGRADED) return false;
      if (now() - degradedAt < SESSION_RECOVER_GRACE_MS) return false;
      emit('session-grace-expired', { degradedForMs: now() - degradedAt });
      api.close('recover-grace-expired', { hard: false });
      return true;
    },

    close(reason, { hard = false } = {}) {
      if (state === SESSION_STATE.CLOSED) return api;
      for (const stream of streamList()) {
        if (!stream.isClosed) stream.reset(mux.RESET_REASON.Shutdown, { notify: false });
        removeStream(stream, { hard, silent: true });
      }
      sessionQueue.length = 0;
      decoder.reset();
      backpressure.reset();
      setState(SESSION_STATE.CLOSED, reason || 'close');
      return api;
    },

    health() {
      let queuedBytes = 0;
      for (const stream of streamList()) queuedBytes += stream.queuedBytes;
      return {
        role,
        state,
        transport: transport ? transport.id : '',
        transportLost: stats.transportLost,
        reattachCount: stats.reattachCount,
        activeStreams: streams.size,
        queuedBytes,
        maxQueuedBytes: backpressure.stats.maxQueued,
        globalPaused: backpressure.isGlobalPaused(),
        pausedStreams: backpressure.pausedStreams().length,
        rttMs: stats.lastRttMs,
        lastPongAt: stats.lastPongAt,
        uptimeMs: openedAt ? Math.max(0, now() - openedAt) : 0,
        degradedForMs: state === SESSION_STATE.DEGRADED ? Math.max(0, now() - degradedAt) : 0,
        ...stats,
      };
    },
  };

  return api;
}

module.exports = {
  SESSION_STATE,
  SESSION_RECOVER_GRACE_MS,
  STREAM_OPEN_WAIT_MS,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  STREAM_IDLE_MS,
  SEND_BATCH_FRAMES,
  SEND_BATCH_BYTES,
  createMuxSession,
};
