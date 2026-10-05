'use strict';
// ============================================================================
// Stronghold Link — Stronghold Relay 服务端（含协议编解码）
//
// 定位：当打洞失败、双方又都没有公网端口时，用一台双方都连得上的中继转发。
//
// 安全边界（**绝不做开放 UDP 代理**）：
//   * 必须有正确会话口令（sessionToken）才能入会，否则丢弃并计数；
//   * 只在自己的会话内两两转发，不跨会话、不转发给未入会的地址；
//   * 包大小上限（默认 1200 字节，贴近常见 MTU）、每会话人数上限；
//   * 令牌桶限速，超限丢弃并计数（不排队、不放大）；
//   * 空闲超时逐出，不留长期占用。
//
// 协议（定长头 + 载荷，全部大端）：
//   [0]      类型：1 HELLO / 2 HELLO_OK / 3 DATA / 4 BYE / 5 PING / 6 PONG
//   [1..4]   会话 ID（DATA/BYE/PING/PONG 必须与入会时一致）
//   [5..8]   端点 ID
//   HELLO 载荷：16 字节令牌摘要（不发明文口令）
//   DATA  载荷：业务字节
// ============================================================================

const crypto = require('node:crypto');
const dgram = require('node:dgram');

const TYPES = Object.freeze({ HELLO: 1, HELLO_OK: 2, DATA: 3, BYE: 4, PING: 5, PONG: 6 });
const HEADER_BYTES = 9;
const TOKEN_DIGEST_BYTES = 16;
const DEFAULT_MAX_PACKET = 1200;

const DROP_REASONS = Object.freeze({
  BAD_TOKEN: 'token-mismatch',
  UNKNOWN_PEER: 'unknown-peer',
  OVERSIZED: 'oversized',
  RATE_LIMITED: 'rate-limited',
  NO_SESSION: 'no-session',
  MALFORMED: 'malformed',
});

/** 口令摘要：不发明文口令，服务端只比摘要。 */
function tokenDigest(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest().subarray(0, TOKEN_DIGEST_BYTES);
}

function encode(type, { sessionId = 0, peerId = 0, payload = Buffer.alloc(0) } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const buffer = Buffer.alloc(HEADER_BYTES + body.length);
  buffer.writeUInt8(type, 0);
  buffer.writeUInt32BE(sessionId >>> 0, 1);
  buffer.writeUInt32BE(peerId >>> 0, 5);
  body.copy(buffer, HEADER_BYTES);
  return buffer;
}

/** 严格解码：类型未知或长度不足都返回 null，不猜。 */
function decode(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (buffer.length < HEADER_BYTES) return null;
  const type = buffer.readUInt8(0);
  if (!Object.values(TYPES).includes(type)) return null;
  return {
    type,
    sessionId: buffer.readUInt32BE(1),
    peerId: buffer.readUInt32BE(5),
    payload: buffer.subarray(HEADER_BYTES),
  };
}

/** 令牌桶：不限速时 ratePerSec <= 0。 */
function createRateLimiter({ ratePerSec = 0, burst = null } = {}) {
  if (!(ratePerSec > 0)) return { allow: () => true, limited: false };
  const capacity = Number.isFinite(burst) && burst > 0 ? burst : Math.max(1, Math.ceil(ratePerSec));
  let tokens = capacity;
  let last = Date.now();
  return {
    limited: true,
    allow(now = Date.now()) {
      const elapsed = Math.max(0, now - last) / 1000;
      last = now;
      tokens = Math.min(capacity, tokens + elapsed * ratePerSec);
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

/**
 * @param {object} options
 * @param {string} options.sessionToken       必填：入会口令
 * @param {number} [options.port]             0 表示随机端口
 * @param {string} [options.host]
 * @param {number} [options.maxSessions]
 * @param {number} [options.maxPeersPerSession]
 * @param {number} [options.idleTimeoutMs]
 * @param {number} [options.maxPacketBytes]
 * @param {number} [options.ratePerSec]
 * @param {Function} [options.now]
 * @param {object} [options.createSocket]     注入用（测试）
 */
function createRelayServer({
  sessionToken,
  port = 0,
  host = '127.0.0.1',
  maxSessions = 32,
  maxPeersPerSession = 8,
  idleTimeoutMs = 60000,
  maxPacketBytes = DEFAULT_MAX_PACKET,
  ratePerSec = 0,
  now = Date.now,
  createSocket = null,
} = {}) {
  if (sessionToken === undefined || sessionToken === null || String(sessionToken) === '') {
    throw new Error('中继服务端必须设置会话口令：没有口令就成了开放代理');
  }
  const expectedToken = tokenDigest(sessionToken);
  const socket = createSocket ? createSocket() : dgram.createSocket('udp4');

  const sessions = new Map();          // sessionId → { id, peers: Map<key, peer>, createdAt }
  const peersByKey = new Map();        // "addr:port" → { sessionId, peerId, lastSeenAt, limiter }
  let nextPeerId = 1;
  let listening = false;
  const counters = {
    packetsIn: 0, packetsForwarded: 0, bytesForwarded: 0,
    sessions: 0, peers: 0, evicted: 0,
  };
  const dropped = Object.fromEntries(Object.values(DROP_REASONS).map((r) => [r, 0]));

  function keyOf(rinfo) {
    return rinfo.address + ':' + rinfo.port;
  }
  function drop(reason) {
    dropped[reason] = (dropped[reason] || 0) + 1;
    return false;
  }
  function send(buffer, rinfo) {
    try { socket.send(buffer, rinfo.port, rinfo.address); return true; } catch (err) { return false; }
  }

  function handleHello(msg, rinfo) {
    if (msg.payload.length < TOKEN_DIGEST_BYTES) return drop(DROP_REASONS.MALFORMED);
    const token = msg.payload.subarray(0, TOKEN_DIGEST_BYTES);
    if (!crypto.timingSafeEqual(token, expectedToken)) return drop(DROP_REASONS.BAD_TOKEN);

    const key = keyOf(rinfo);
    const existing = peersByKey.get(key);
    if (existing) {
      // 重复入会：沿用原身份，重新发一次确认
      // 端点对象的字段是 id（不是 peerId）—— 写错会发出 peerId=0，端点身份就丢了
      send(encode(TYPES.HELLO_OK, { sessionId: existing.sessionId, peerId: existing.id }), rinfo);
      return true;
    }

    const requested = msg.sessionId >>> 0;
    let session = sessions.get(requested);
    if (!session) {
      if (sessions.size >= maxSessions) return drop(DROP_REASONS.NO_SESSION);
      session = { id: requested, peers: new Map(), createdAt: now() };
      sessions.set(requested, session);
      counters.sessions += 1;
    }
    if (session.peers.size >= maxPeersPerSession) return drop(DROP_REASONS.NO_SESSION);

    const peer = { id: nextPeerId, sessionId: session.id, rinfo: { address: rinfo.address, port: rinfo.port }, lastSeenAt: now(), limiter: createRateLimiter({ ratePerSec }) };
    nextPeerId += 1;
    session.peers.set(key, peer);
    peersByKey.set(key, peer);
    counters.peers += 1;
    send(encode(TYPES.HELLO_OK, { sessionId: session.id, peerId: peer.id }), rinfo);
    return true;
  }

  function handleData(msg, rinfo) {
    const key = keyOf(rinfo);
    const peer = peersByKey.get(key);
    if (!peer) return drop(DROP_REASONS.UNKNOWN_PEER);
    if (peer.sessionId !== msg.sessionId) return drop(DROP_REASONS.NO_SESSION);
    peer.lastSeenAt = now();
    if (!peer.limiter.allow(now())) return drop(DROP_REASONS.RATE_LIMITED);

    const session = sessions.get(peer.sessionId);
    if (!session) return drop(DROP_REASONS.NO_SESSION);

    const frame = encode(TYPES.DATA, { sessionId: session.id, peerId: peer.id, payload: msg.payload });
    let forwarded = 0;
    for (const [otherKey, other] of session.peers) {
      if (otherKey === key) continue;                 // 不回给自己
      if (send(frame, other.rinfo)) {
        forwarded += 1;
        counters.bytesForwarded += frame.length;
      }
    }
    counters.packetsForwarded += forwarded;
    return forwarded > 0;
  }

  function handleBye(msg, rinfo) {
    const key = keyOf(rinfo);
    const peer = peersByKey.get(key);
    if (!peer) return drop(DROP_REASONS.UNKNOWN_PEER);
    peersByKey.delete(key);
    const session = sessions.get(peer.sessionId);
    if (session) {
      session.peers.delete(key);
      if (session.peers.size === 0) sessions.delete(session.id);
    }
    counters.peers = Math.max(0, counters.peers - 1);
    return true;
  }

  function handleMessage(buffer, rinfo) {
    counters.packetsIn += 1;
    if (buffer.length > maxPacketBytes) return drop(DROP_REASONS.OVERSIZED);
    const msg = decode(buffer);
    if (!msg) return drop(DROP_REASONS.MALFORMED);
    if (msg.type === TYPES.HELLO) return handleHello(msg, rinfo);
    if (msg.type === TYPES.DATA) return handleData(msg, rinfo);
    if (msg.type === TYPES.BYE) return handleBye(msg, rinfo);
    if (msg.type === TYPES.PING) {
      const peer = peersByKey.get(keyOf(rinfo));
      if (peer) peer.lastSeenAt = now();
      send(encode(TYPES.PONG, { sessionId: msg.sessionId, peerId: peer ? peer.id : 0 }), rinfo);
      return true;
    }
    return drop(DROP_REASONS.MALFORMED);
  }

  /** 逐出空闲端点；由调用方按需触发（不启内部定时器，便于测试与关停）。 */
  function sweep() {
    const at = now();
    let removed = 0;
    for (const [key, peer] of peersByKey) {
      if (at - peer.lastSeenAt <= idleTimeoutMs) continue;
      peersByKey.delete(key);
      const session = sessions.get(peer.sessionId);
      if (session) {
        session.peers.delete(key);
        if (session.peers.size === 0) sessions.delete(session.id);
      }
      removed += 1;
    }
    counters.peers = Math.max(0, counters.peers - removed);
    counters.evicted += removed;
    return removed;
  }

  async function start() {
    socket.on('message', handleMessage);
    await new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      socket.once('error', onError);
      socket.bind(port, host, () => {
        socket.removeListener('error', onError);
        listening = true;
        resolve();
      });
    });
    return { host, port: socket.address().port, listening };
  }

  async function stop() {
    if (!listening) return { stopped: true, alreadyStopped: true };
    listening = false;
    await new Promise((resolve) => {
      try { socket.close(resolve); } catch (err) { resolve(); }
    });
    return { stopped: true, stats: getStats() };
  }

  function getStats() {
    return {
      listening,
      address: listening ? socket.address() : null,
      ...counters,
      sessionsActive: sessions.size,
      peersActive: peersByKey.size,
      dropped: { ...dropped },
      limits: { maxSessions, maxPeersPerSession, idleTimeoutMs, maxPacketBytes, ratePerSec },
    };
  }

  return { start, stop, sweep, getStats, handleMessage, TYPES, DROP_REASONS, tokenDigest, get peers() { return peersByKey.size; }, get sessionsCount() { return sessions.size; } };
}

module.exports = {
  TYPES, HEADER_BYTES, TOKEN_DIGEST_BYTES, DEFAULT_MAX_PACKET, DROP_REASONS,
  tokenDigest, encode, decode, createRateLimiter, createRelayServer,
};
