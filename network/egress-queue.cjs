'use strict';

/**
 * ============================================================================
 * 出站队列：**每条 TCP Stream 一条独立 FIFO + 轮转公平调度**（0.14.3 延迟专项 Phase 2）
 * ============================================================================
 *
 * ── 为什么需要这个模块 ──────────────────────────────────────────────────────
 *
 * 0.14.0~0.14.2 的发送队列是**一条扁平数组** `peer.out`：所有流的帧按到达顺序排在一起，
 * flush 时 Buffer.concat 成一大块发出去。
 *
 * 它对"一条流"是对的（FIFO 就是 TCP 语义），对"多条流"是错的：
 *
 *   流 A（地图区块，一个响应几 MB）先排进来 900 KB，流 B（玩家移动，20 字节）后到，
 *   于是 B 的 20 字节排在 900 KB 后面 —— 它要等前面全部发完才出门。
 *   现场感受就是"地图一动，人就飘"：加载区块时操作响应被压在同一个队列里。
 *
 * 规格里"每条 TCP 内部 FIFO、字节顺序不许乱"（Phase 2 ①）说的是**一条流内部**；
 * 流与流之间本来就没有顺序关系（它们是各自独立的 TCP 连接），所以可以也应该重排。
 * 本模块做的就是这件事：**流内严格 FIFO，流间轮转（round-robin），每个回合每条流最多
 * 取 quantum 字节**（Phase 2 ②）。900 KB 的 A 不再挡住 B —— B 最多等 A 的一个 quantum
 * （默认 4 KiB，和 maxChunk 同量级）。
 *
 * ── 顺序安全性（Phase 2 ⑦）────────────────────────────────────────────────
 *
 * OPEN / DATA / CLOSE / RESET 都是**同一条流的帧**，它们进的是同一个 per-stream 队列，
 * 顺序与入队顺序逐字节一致 ⇒ 协议顺序不可能被轮转打乱。
 * 只有"干道级"的帧（HELLO、PING/PONG、流号 0 的会话帧）走干道队列，整段排在所有流之前。
 *
 * ── 背压与内存上限照旧（Phase 2 ③）────────────────────────────────────────
 *
 * 本模块只负责"排队/取队"，**不做任何丢弃、不做无限缓冲**：
 *   · 上限仍然由 steam-adapter 的 PEER_OUT_HIGH_WATER / MAX_WATER 判定，
 *     它们读的就是本模块的 total()；
 *   · 出队只在 flushPeerOut 里"确认进了 Steam 发送缓冲"之后发生（前缀确认、前缀出队），
 *     与老实现完全一致 —— 发失败时数据留在队列里等下一次重试。
 *
 * ── 计数不能漂 ────────────────────────────────────────────────────────────
 *
 * `peer.outBytes` 是背压判据的输入，一旦漏减就会永久 pause 读本地 socket。
 * 所以每次 commit/clear 之后都用 resync() 按真实队列重算一遍（O(流数)，很小），
 * 就算别处有漏改的赋值，也会在**下一个 flush**自行纠正。
 */

/** 轮转量子：每回合每条流最多取这么多字节。取 maxChunk 同量级，避免把大块拆得太碎。 */
const DEFAULT_FAIR_QUANTUM = 4 * 1024;

/** 干道队列在诊断里的名字（流号 0 是保留号，不会与真实流撞）。 */
const TRUNK_KEY = 'trunk';

function ensure(peer) {
  if (!peer) return null;
  if (!Array.isArray(peer.out)) peer.out = [];
  if (!(peer.outStreams instanceof Map)) peer.outStreams = new Map();
  if (!Number.isFinite(peer.outBytes)) peer.outBytes = 0;
  if (!Number.isFinite(peer.outAt)) peer.outAt = 0;
  if (!Number.isFinite(peer.outTrunkAt)) peer.outTrunkAt = 0;
  if (peer.outCursorKey === undefined) peer.outCursorKey = null;
  return peer;
}

/**
 * 排队一帧/一段字节。
 *
 * @param {object} peer
 * @param {Buffer|Uint8Array|string} chunk
 * @param {number|string|null} key  流号；null = 干道队列（HELLO/PING/PONG/旧版透传字节）
 * @param {number} now              入队时刻（测试可注入）
 * @returns {number} 该干道当前排队总字节
 */
function enqueue(peer, chunk, key = null, now = Date.now()) {
  const p = ensure(peer);
  if (!p) return 0;
  // 复制一份：调用方可能复用/改写那块内存（老实现的 Buffer.from 也是复制，语义不变）。
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (!buf.length) return p.outBytes;
  if (key == null || key === '') {
    if (!p.out.length) { p.outTrunkAt = now; }
    p.out.push(buf);
    p.outBytes += buf.length;
    if (!p.outAt) p.outAt = p.outTrunkAt;
    return p.outBytes;
  }
  let q = p.outStreams.get(key);
  if (!q) { q = { key, queue: [], bytes: 0, at: 0 }; p.outStreams.set(key, q); }
  if (!q.queue.length) {
    q.at = now;
    if (!p.outAt || now < p.outAt) p.outAt = now;
  }
  q.queue.push(buf);
  q.bytes += buf.length;
  p.outBytes += buf.length;
  return p.outBytes;
}

/** 把字节**插到最前面**（旧版重连补发用；帧序不能变，所以只能插到队头）。 */
function prepend(peer, chunks, now = Date.now()) {
  const p = ensure(peer);
  if (!p || !chunks || !chunks.length) return p ? p.outBytes : 0;
  const bufs = [];
  for (const chunk of chunks) { const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); if (buf.length) bufs.push(buf); }
  if (!bufs.length) return p.outBytes;
  p.out = bufs.concat(p.out);
  // 补发的字节现在排在队头，它们的等待从这一刻重新算（旧锚点属于上一条连接，
  // 拿它算会得出一个荒谬的"等了 30 秒"读数）。流队列里更老的锚点由 resync 取小值保留。
  p.outTrunkAt = now;
  resync(p);
  return p.outBytes;
}

/**
 * 当前排队总字节 —— **按真实队列现算，不用缓存计数**。
 *
 * 为什么不用缓存：这是背压判据（PEER_OUT_HIGH_WATER / MAX_WATER）的输入，
 * 一旦哪里漏减就会永久暂停读本地 socket，而且现象极难查。
 * 现算的代价是 O(干道队列长度 + 流数)：数据都在 per-stream 队列里带 bytes 计数，
 * 干道队列只有 HELLO/PING/PONG（旧版透传路径才有大量小块），所以这不是热点。
 */
function total(peer) {
  const p = ensure(peer);
  if (!p) return 0;
  let bytes = 0;
  for (const b of p.out) bytes += b.length;
  for (const q of p.outStreams.values()) bytes += q.bytes;
  return bytes;
}

/** 最老排队字节的入队时刻（0 = 队列是空的）。 */
function oldestAt(peer) {
  const p = ensure(peer);
  return p ? p.outAt : 0;
}

/**
 * 按真实队列重算字节数与最老入队时刻。
 * 每次 flush 之后都会调用，是"计数永不带病运行"的兜底。
 */
function resync(peer) {
  const p = ensure(peer);
  if (!p) return 0;
  let bytes = 0;
  let oldest = 0;
  if (p.out.length) {
    bytes += p.out.reduce((sum, b) => sum + b.length, 0);
    oldest = p.outTrunkAt || 0;
  }
  for (const q of p.outStreams.values()) {
    if (!q.queue.length) { q.bytes = 0; continue; }
    bytes += q.bytes;
    if (!oldest || (q.at && q.at < oldest)) oldest = q.at;
  }
  p.outBytes = bytes;
  p.outAt = oldest;
  return bytes;
}

function dropQueueBytes(peer, q, n) {
  let left = n;
  if (q == null) {
    while (left > 0 && peer.out.length) {
      const head = peer.out[0];
      if (head.length <= left) { left -= head.length; peer.out.shift(); }
      else { peer.out[0] = head.subarray(left); left = 0; }
    }
    if (!peer.out.length) peer.outTrunkAt = 0;
    return;
  }
  while (left > 0 && q.queue.length) {
    const head = q.queue[0];
    if (head.length <= left) { left -= head.length; q.bytes -= head.length; q.queue.shift(); }
    else { q.queue[0] = head.subarray(left); q.bytes -= left; left = 0; }
  }
  if (!q.queue.length) { q.bytes = 0; q.at = 0; peer.outStreams.delete(q.key); }
}

/**
 * 从**干道队列**头部丢弃 n 字节。
 *
 * 只给旧版/透传路径与单元测试用。多路复用路径**不能**用它：那条路径的确认前缀可能横跨
 * 干道与多条流（轮转计划切出来的），只丢干道就与 Steam 报的确认字节数对不上，
 * 必须走 planOut + commit 按计划出队。
 *
 * @returns {number} 丢弃后剩余字节
 */
function dropTrunk(peer, n) {
  const p = ensure(peer);
  if (!p) return 0;
  const left = Math.max(0, Number(n) || 0);
  if (left > 0) dropQueueBytes(p, null, left);
  return resync(p);
}

/**
 * 算出发送计划：**干道队列整段在前，然后各流轮转，每回合每条流最多 quantum 字节**。
 *
 * 注意：本函数会**更新轮转游标**（`peer.outCursorKey` = 本次计划里第一条流），
 * 这样"上一次只发出去一部分"时下一次会从**下一条流**接着发，而不是让第一条流一直霸占队首。
 *
 * @returns {{plan: Array<{q: object|null, key: (number|string|null), buf: Buffer}>, bytes: number}}
 */
function planOut(peer, quantum = DEFAULT_FAIR_QUANTUM) {
  const p = ensure(peer);
  if (!p) return { plan: [], bytes: 0 };
  const plan = [];
  for (const buf of p.out) plan.push({ q: null, key: null, buf });
  const streams = [];
  for (const q of p.outStreams.values()) if (q.queue.length) streams.push(q);
  if (streams.length) {
    const qn = Number.isFinite(quantum) && quantum > 0 ? Math.floor(quantum) : Infinity;
    // 轮转起点必须**跨 flush 记住**：一次 flush 被 Steam 接受的字节数经常小于一个 quantum
    // （发送缓冲快满时只收下几 KB，拥塞链路上是常态）。若每次 planOut 都从 Map 里第一条流
    // 重新开始，第一条流就永远排在计划最前面，后面的流被无限期饿死 —— 现场症状正是
    // "地图一动、人就飘"。本地环回 400MB/s 复现不出来，限速模型一跑就现形。
    let startIndex = 0;
    if (p.outCursorKey != null) {
      const at = streams.findIndex((q) => q.key === p.outCursorKey);
      if (at >= 0) startIndex = (at + 1) % streams.length;
    }
    const ordered = streams.slice(startIndex).concat(streams.slice(0, startIndex));
    p.outCursorKey = ordered[0].key;
    const cursors = ordered.map((q) => ({ q, i: 0, off: 0 }));
    let active = cursors;
    while (active.length) {
      const next = [];
      for (const c of active) {
        let need = qn;
        while (need > 0 && c.i < c.q.queue.length) {
          const buf = c.q.queue[c.i];
          const avail = buf.length - c.off;
          const take = need === Infinity ? avail : Math.min(need, avail);
          if (take > 0) {
            // 整块取走时直接复用原 Buffer（不切 subarray），只有被量子截断的那一段才是视图。
            plan.push({ q: c.q, key: c.q.key, buf: (take === buf.length && c.off === 0) ? buf : buf.subarray(c.off, c.off + take) });
            c.off += take;
            need -= take;
          }
          if (c.off >= buf.length) { c.i += 1; c.off = 0; } else break;
        }
        if (c.i < c.q.queue.length) next.push(c);
      }
      active = next;
    }
  }
  let bytes = 0;
  for (const seg of plan) bytes += seg.buf.length;
  return { plan, bytes };
}

/**
 * 按"确认发出的前缀"出队。
 *
 * @param {number} confirmed 已被 Steam 接收的字节数（前缀）
 * @returns {number} 出队后剩余字节
 */
function commit(peer, planInfo, confirmed) {
  const p = ensure(peer);
  if (!p || !planInfo || !planInfo.plan) return p ? p.outBytes : 0;
  let left = Math.max(0, Math.min(Number(confirmed) || 0, planInfo.bytes));
  if (left > 0) {
    // 同一队列在计划里可能有多段（轮转切出来的），把属于它的字节先加起来再一次性出队 ——
    // 计划里同一队列的段**保持着队列顺序**，所以"总前缀长度"就是它要从队头丢掉的字节数。
    const drops = new Map();
    for (const seg of planInfo.plan) {
      if (left <= 0) break;
      const take = Math.min(left, seg.buf.length);
      drops.set(seg.q, (drops.get(seg.q) || 0) + take);
      left -= take;
    }
    for (const [q, n] of drops) dropQueueBytes(p, q, n);
  }
  resync(p);
  return p.outBytes;
}

/** 整队清空（整块发送成功之后）。 */
function clear(peer) {
  const p = ensure(peer);
  if (!p) return 0;
  p.out = [];
  p.outStreams = new Map();
  p.outBytes = 0;
  p.outAt = 0;
  p.outTrunkAt = 0;
  p.outCursorKey = null;
  return 0;
}

/**
 * 诊断用：每条队列的排队量与"最老那批字节等了多久"（Phase 1 要求的分流视角）。
 * @returns {Array<{key: string, bytes: number, waitedMs: number|null, frames: number}>}
 */
function queueRows(peer, now = Date.now()) {
  const p = ensure(peer);
  if (!p) return [];
  const rows = [];
  if (p.out.length) {
    rows.push({
      key: TRUNK_KEY,
      bytes: p.out.reduce((sum, b) => sum + b.length, 0),
      waitedMs: p.outTrunkAt ? Math.max(0, now - p.outTrunkAt) : null,
      frames: p.out.length,
    });
  }
  for (const q of p.outStreams.values()) {
    if (!q.queue.length) continue;
    rows.push({ key: String(q.key), bytes: q.bytes, waitedMs: q.at ? Math.max(0, now - q.at) : null, frames: q.queue.length });
  }
  rows.sort((a, b) => (b.waitedMs || 0) - (a.waitedMs || 0));
  return rows;
}

module.exports = {
  DEFAULT_FAIR_QUANTUM,
  TRUNK_KEY,
  enqueue,
  prepend,
  total,
  oldestAt,
  resync,
  dropTrunk,
  planOut,
  commit,
  clear,
  queueRows,
};
