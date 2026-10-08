'use strict';
// ============================================================================
// Stronghold Link — MuxStream：一条本机 TCP 连接在干道上的化身
//
// 一条流 = 一个流号 + 一个世代号 + 一条本机 socket + 两个方向的字节队列。
//
// 这个模块**刻意不知道 Steam 的存在**：它不 import steamworks、不碰 transport，
// 只跟"帧"和"本机 socket"打交道。可测性全押在这一条上 —— `test/mux-stream.test.cjs`
// 用一个假 socket 就能把生命周期、背压、世代号全跑一遍，不需要 Steam 运行时。
//
// ── 出站队列为什么存"帧"而不是"字节" ────────────────────────────────────────
// 规格 §二十七 要求控制帧优先于数据帧（防止一大坨 DATA 把 CLOSE / OPEN 堵在队尾）。
// 但如果把控制帧插到数据帧前面，又会违反规格 §十二「数据优先于最终 CLOSE」——
// 那条 CLOSE 前面的数据就永远发不出去了。
//
// 裁决：**优先级只作用于流之间，不作用于流内部**。每条流自己是一个严格的 FIFO
// 队列，队列里既有数据帧也有这条流自己的控制帧，顺序天然正确（数据一定在 CLOSE
// 前面）。调度器负责的是"下一批从哪条流取" —— 队头是控制帧的流优先被服务。
// 两条规格因此同时成立，而且不需要在队列里做任何插入。
// ============================================================================

const mux = require('./stream-mux.cjs');

/** 流状态（规格 §十二）。 */
const STATE = Object.freeze({
  OPENING: 'OPENING',
  OPEN: 'OPEN',
  HALF_CLOSED_LOCAL: 'HALF_CLOSED_LOCAL',
  HALF_CLOSED_REMOTE: 'HALF_CLOSED_REMOTE',
  CLOSED: 'CLOSED',
  RESET: 'RESET',
});

/** 一条流最多允许压多少字节。到这儿说明对端就是不读了，宁可掐掉也不能吃内存。 */
const DEFAULT_MAX_QUEUED_BYTES = 4 * 1024 * 1024;

/**
 * @param {object} spec
 * @param {number} spec.id            流号（规格 §十一：房主奇数 / 加入者偶数）
 * @param {number} [spec.generation]  世代号，默认 1
 * @param {string} [spec.role]        'host' | 'joiner'（只为日志好看）
 * @param {import('net').Socket} [spec.socket] 本机 socket
 * @param {number} [spec.maxQueuedBytes]
 * @param {number} [spec.initialCredit] 对端初始能接多少字节（由对端 Window 帧更新）
 * @param {() => number} [spec.now]
 * @param {(type: string, payload?: object) => void} [spec.onEvent]
 * @param {(stream: object) => void} [spec.onOverflow] 积压超过硬上限时叫一次
 */
function createMuxStream(spec = {}) {
  const id = Number(spec.id) >>> 0;
  const now = typeof spec.now === 'function' ? spec.now : Date.now;
  const onEvent = typeof spec.onEvent === 'function' ? spec.onEvent : () => {};
  const onOverflow = typeof spec.onOverflow === 'function' ? spec.onOverflow : null;
  const role = spec.role === 'host' ? 'host' : 'joiner';
  const maxQueuedBytes = Number.isFinite(spec.maxQueuedBytes) ? spec.maxQueuedBytes : DEFAULT_MAX_QUEUED_BYTES;

  let generation = Number(spec.generation) >>> 0 || 1;
  /** 只被发起方（加入者）用；接收方（房主）固定 false。 */
  let allocateId = role === 'joiner';
  /** 接收侧开局就是 OPEN（对端已经发过 Open 了，我们不需要回一个）。 */
  const accepted = spec.accepted === true;

  /** @type {Array<{type:number, priority:number, buffer:Buffer, bytes:number, at:number}>} */
  const outQueue = [];
  let queuedBytes = 0;
  let maxQueuedSeen = 0;

  let state = accepted ? STATE.OPEN : STATE.OPENING;
  let localPaused = false;
  let localEnded = false;
  let remoteEnded = false;
  /** 对端还能再接多少字节（规格 §十三 的端到端背压）。 */
  let remoteCredit = Number.isFinite(spec.initialCredit) ? spec.initialCredit : 1 * 1024 * 1024;

  const createdAt = now();
  let lastActivity = createdAt;
  const counters = {
    openedAt: createdAt,
    closedAt: 0,
    inBytes: 0,
    outBytes: 0,
    outFrames: 0,
    inFrames: 0,
    windowsIn: 0,
    windowsOut: 0,
    staleDropped: 0,
    lastWindowCredit: remoteCredit,
  };

  // 注意是 let：attachSocket 会换 socket（reattach 场景），getter 必须跟着变。
  let socket = spec.socket || null;
  /** 我们自己挂到 socket 上的监听器，dispose 时要精确摘掉（避免 EventEmitter 泄漏）。 */
  const listeners = [];

  const enqueue = (type, buffer, bytes) => {
    outQueue.push({ type, priority: mux.PRIORITY[type] === undefined ? mux.PRIORITY_MAX : mux.PRIORITY[type], buffer, bytes, at: now() });
    queuedBytes += bytes;
    if (queuedBytes > maxQueuedSeen) maxQueuedSeen = queuedBytes;
    counters.outFrames += 1;
    if (queuedBytes > maxQueuedBytes && onOverflow) onOverflow(api);
    return bytes;
  };

  const api = {
    id,
    role,
    get generation() { return generation; },
    get state() { return state; },
    get socket() { return socket; },
    get queuedBytes() { return queuedBytes; },
    get remoteCredit() { return remoteCredit; },
    get localPaused() { return localPaused; },
    get lastActivity() { return lastActivity; },
    get createdAt() { return createdAt; },
    get size() { return outQueue.length; },
    get isClosed() { return state === STATE.CLOSED || state === STATE.RESET; },

    /** 上层（session）把 socket 换成新的一条时用（reattach 场景）。 */
    attachSocket(next) {
      api.disposeListeners();
      socket = next || null;
      return api;
    },

    /** 这个流现在由我们分配流号吗（只有发 Open 的那一侧是）。 */
    setAllocatesId(value) { allocateId = !!value; return api; },
    get allocatesId() { return allocateId; },

    /** 世代 +1（transport 重建后重新挂载这条流，规格 §十六）。 */
    bumpGeneration() {
      generation = (generation + 1) >>> 0 || 1;
      return generation;
    },

    /** 开局：把 OPEN 帧排进出站队列。 */
    open({ force = false } = {}) {
      if (api.isClosed) return 0;
      if (!force && state !== STATE.OPENING) return 0;
      if (state === STATE.OPENING) state = STATE.OPEN;
      // force 用于 reattach：本地早就 OPEN 了，但换了 transport 就得对新一代重发 Open。
      enqueue(mux.TYPE.Open, mux.encodeOpen(id, generation), 0);
      lastActivity = now();
      onEvent(force ? 'stream-reopened' : 'stream-open', { stream: id, generation, role });
      return 0;
    },

    /**
     * 本机读到的字节 → 出站队列（规格 §二十六 的 TCP data → stream queue → MUX framing）。
     * @returns {number} 实际收下的字节数（0 表示这条流已经不能再收了）
     */
    push(payload) {
      const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
      if (!buf.length) return 0;
      if (api.isClosed) return 0;
      lastActivity = now();
      const frames = mux.encodeDataChunks(id, generation, buf);
      for (const frame of frames) {
        // 水位按**净载荷**算（帧头 13 字节不计），这样阈值跟规格里的 MiB 数字直接对得上。
        const payloadBytes = Math.max(0, frame.length - mux.FRAME_HEADER);
        enqueue(mux.TYPE.Data, frame, payloadBytes);
      }
      return buf.length;
    },

    /** 对端还能再接多少字节（收 Window 帧时调）。 */
    noteRemoteCredit(credit) {
      remoteCredit = Number.isFinite(credit) && credit > 0 ? Math.floor(credit) : 0;
      counters.windowsIn += 1;
      counters.lastWindowCredit = remoteCredit;
      return remoteCredit;
    },

    /** 本端还能再接多少 -> 排一条 Window 帧告诉对端。 */
    sendWindow(credit) {
      const n = Number.isFinite(credit) && credit > 0 ? Math.floor(credit) : 0;
      enqueue(mux.TYPE.Window, mux.encodeWindow(id, generation, n), 0);
      counters.windowsOut += 1;
      return n;
    },

    /** 本机这一侧不再发数据了（收到 socket end / 主动关）。 */
    closeLocal() {
      if (api.isClosed || localEnded) return false;
      localEnded = true;
      if (remoteEnded) { finish(STATE.CLOSED); return true; }
      state = STATE.HALF_CLOSED_LOCAL;
      enqueue(mux.TYPE.Close, mux.encodeClose(id, generation), 0);
      onEvent('stream-half-closed', { stream: id, side: 'local', generation });
      return true;
    },

    /** 对端说它不再发数据了（收到 CLOSE 帧）。**不要立刻 destroy 对端 socket。** */
    closeRemote() {
      if (api.isClosed || remoteEnded) return false;
      remoteEnded = true;
      if (localEnded) { finish(STATE.CLOSED); return true; }
      state = STATE.HALF_CLOSED_REMOTE;
      onEvent('stream-half-closed', { stream: id, side: 'remote', generation });
      return true;
    },

    /** 异常释放（规格 §十二：RESET）。 */
    reset(reason = mux.RESET_REASON.Shutdown, { notify = true } = {}) {
      if (api.isClosed) return false;
      if (notify) enqueue(mux.TYPE.Reset, mux.encodeReset(id, generation, reason), 0);
      finish(STATE.RESET);
      onEvent('stream-reset', { stream: id, generation, reason, reasonName: mux.RESET_REASON_NAMES[reason] || String(reason) });
      return true;
    },

    /** 从出站队列取一帧（调度器调）。 */
    takeFrame() {
      const item = outQueue.shift();
      if (!item) return null;
      queuedBytes = Math.max(0, queuedBytes - item.bytes);
      counters.outBytes += item.bytes;
      lastActivity = now();
      return item;
    },

    /** 队头那帧的优先级（决定这条流这一轮该不该被先服务）。没积压时返回 null。 */
    headPriority() {
      return outQueue.length ? outQueue[0].priority : null;
    },
    hasPending() { return outQueue.length > 0; },
    /** 出站队列里还有没有数据帧（判断"这条流已经无话可说"用）。 */
    hasPendingData() { return outQueue.some((f) => f.type === mux.TYPE.Data); },

    /** 本机 socket 侧：把对端来的字节写出去（规格 §二十五 的最后一步）。 */
    writeLocal(payload) {
      if (!socket || socket.destroyed) return false;
      const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []);
      if (!buf.length) return false;
      counters.inBytes += buf.length;
      counters.inFrames += 1;
      lastActivity = now();
      // write 返回 false 表示内核缓冲满了 —— 这是**对端**的读速问题，
      // 由上层把这条流的 Window 额度降下去，而不是在这里阻塞。
      return socket.write(buf);
    },

    pauseLocal() {
      if (localPaused || !socket || socket.destroyed) return false;
      localPaused = true;
      try { socket.pause(); } catch { /* 已销毁的 socket pause 会抛，忽略 */ }
      return true;
    },
    resumeLocal() {
      if (!localPaused || !socket || socket.destroyed) return false;
      localPaused = false;
      try { socket.resume(); } catch { /* 同上 */ }
      return true;
    },

    /** 挂一个 socket 监听器并记下来（dispose 时精确摘除）。 */
    listen(event, handler) {
      if (!socket) return api;
      socket.on(event, handler);
      listeners.push([event, handler]);
      return api;
    },
    disposeListeners() {
      if (socket) for (const [event, handler] of listeners.splice(0)) {
        try { socket.removeListener(event, handler); } catch { /* ignore */ }
      }
      return api;
    },

    /** 彻底收摊：摘监听器、关 socket。`hard` 为真表示是 RESET（destroy），否则优雅 end。 */
    dispose({ hard = false } = {}) {
      api.disposeListeners();
      if (socket && !socket.destroyed) {
        try { if (hard) socket.destroy(); else socket.end(); } catch { /* ignore */ }
      }
      return api;
    },

    snapshot() {
      return {
        id,
        role,
        generation,
        state,
        queuedBytes,
        maxQueuedBytes,
        maxQueuedSeen,
        remoteCredit,
        localPaused,
        pending: outQueue.length,
        ageMs: Math.max(0, now() - createdAt),
        idleMs: Math.max(0, now() - lastActivity),
        inBytes: counters.inBytes,
        outBytes: counters.outBytes,
        outFrames: counters.outFrames,
        inFrames: counters.inFrames,
        windowsIn: counters.windowsIn,
        windowsOut: counters.windowsOut,
        staleDropped: counters.staleDropped,
        lastWindowCredit: counters.lastWindowCredit,
      };
    },

    counters,
  };

  function finish(next) {
    state = next;
    counters.closedAt = now();
    onEvent('stream-closed', { stream: id, generation, state: next, inBytes: counters.inBytes, outBytes: counters.outBytes });
  }

  return api;
}

module.exports = {
  STATE,
  DEFAULT_MAX_QUEUED_BYTES,
  createMuxStream,
};
