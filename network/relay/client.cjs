'use strict';
// ============================================================================
// Stronghold Link — Stronghold Relay 客户端
//
// 面向消息（不是字节流）：入会 → 收发 DATA → PING/PONG 测真实 RTT → 离会。
// 与 network/relay/server.cjs 共用协议编解码。
//
// 诚实约定：
//   * 没入会就 send() 直接报错，不静默丢包；
//   * 入会失败/超时给出明确原因（口令不符时服务端不会回包，因此表现为超时 —— 这点在原因里写明）；
//   * RTT 只在收到对应 PONG 时才算数，没有样本就不报数字。
// ============================================================================

const dgram = require('node:dgram');
const { TYPES, encode, decode, tokenDigest } = require('./server.cjs');
const { createQuality } = require('../route/quality.cjs');

const DEFAULT_JOIN_TIMEOUT = 3000;

/**
 * @param {object} options
 * @param {string} options.serverHost
 * @param {number} options.serverPort
 * @param {string} options.sessionToken
 * @param {number} [options.sessionId]
 * @param {object} [options.createSocket]  注入用（测试）
 * @param {Function} [options.now]
 */
function createRelayClient({
  serverHost = '127.0.0.1',
  serverPort,
  sessionToken,
  sessionId = 1,
  createSocket = null,
  now = Date.now,
} = {}) {
  if (!serverPort) throw new Error('必须提供服务端端口');
  if (sessionToken === undefined || sessionToken === null || String(sessionToken) === '') {
    throw new Error('必须提供会话口令：服务端会拒绝无口令的客户端');
  }

  const socket = createSocket ? createSocket() : dgram.createSocket('udp4');
  const quality = createQuality({ window: 32 });
  const digest = tokenDigest(sessionToken);

  let joined = false;
  let peerId = null;
  let lastError = null;
  const subscribed = new Set();
  const pendingPings = new Map();          // 序号 → 发出时间
  let pingSeq = 0;
  const counters = { packetsToPeer: 0, packetsFromPeer: 0, bytesToPeer: 0, bytesFromPeer: 0, pongsReceived: 0, droppedUnknown: 0 };

  function emitMessage(payload, from) {
    for (const fn of subscribed) {
      try { fn(payload, from); } catch (err) { /* 订阅者异常不影响收发 */ }
    }
  }

  function handleMessage(buffer) {
    const msg = decode(buffer);
    if (!msg) { counters.droppedUnknown += 1; return; }
    if (msg.type === TYPES.HELLO_OK) {
      joined = true;
      peerId = msg.peerId;
      return;
    }
    if (msg.type === TYPES.DATA) {
      counters.packetsFromPeer += 1;
      counters.bytesFromPeer += msg.payload.length;
      emitMessage(Buffer.from(msg.payload), { peerId: msg.peerId });
      return;
    }
    if (msg.type === TYPES.PONG) {
      counters.pongsReceived += 1;
      // 载荷不足 4 字节说明对端没回显序号：忽略这次样本，不猜、不抛错
      const sentAt = msg.payload.length >= 4 ? pendingPings.get(msg.payload.readUInt32BE(0)) : undefined;
      if (sentAt !== undefined) {
        const rtt = now() - sentAt;
        quality.record({ rttMs: rtt, sent: 1, received: 1, at: now() });
      }
      return;
    }
    counters.droppedUnknown += 1;
  }

  async function join({ timeoutMs = DEFAULT_JOIN_TIMEOUT } = {}) {
    await new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      socket.once('error', onError);
      socket.bind(0, () => {
        socket.removeListener('error', onError);
        socket.on('message', handleMessage);
        resolve();
      });
    });
    socket.send(encode(TYPES.HELLO, { sessionId, payload: digest }), serverPort, serverHost);

    const started = now();
    while (now() - started < timeoutMs) {
      if (joined) return { ok: true, peerId, sessionId, elapsedMs: now() - started };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    lastError = '入会超时（' + timeoutMs + 'ms）：服务端未确认。口令不符时服务端不会回包，因此也表现为超时';
    return { ok: false, peerId: null, reason: lastError };
  }

  function send(payload, { sessionIdOverride = null } = {}) {
    if (!joined) throw new Error('尚未入会，无法发送：' + (lastError || '请先调用 join()'));
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload === undefined || payload === null ? '' : String(payload));
    socket.send(encode(TYPES.DATA, { sessionId: sessionIdOverride === null ? sessionId : sessionIdOverride, peerId, payload: body }), serverPort, serverHost);
    counters.packetsToPeer += 1;
    counters.bytesToPeer += body.length;
    return { sent: true, bytes: body.length };
  }

  /** 发一次心跳并等 PONG；返回本次 RTT（毫秒）或 null。 */
  async function ping({ timeoutMs = 1500 } = {}) {
    if (!joined) throw new Error('尚未入会，无法测量 RTT');
    pingSeq += 1;
    const token = Buffer.alloc(4);
    token.writeUInt32BE(pingSeq, 0);
    const before = quality.snapshot().samples;
    pendingPings.set(pingSeq, now());
    socket.send(encode(TYPES.PING, { sessionId, peerId, payload: token }), serverPort, serverHost);
    const started = now();
    while (now() - started < timeoutMs) {
      if (quality.snapshot().samples > before) {
        pendingPings.delete(pingSeq);
        const snap = quality.snapshot();
        return { ok: true, rttMs: snap.rtt, jitter: snap.jitter };
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    pendingPings.delete(pingSeq);
    return { ok: false, rttMs: null, reason: '心跳超时：服务端未回 PONG' };
  }

  function leave() {
    if (!joined) return { left: false, reason: '尚未入会' };
    try { socket.send(encode(TYPES.BYE, { sessionId, peerId }), serverPort, serverHost); } catch (err) { /* 离会包发不出去也要继续关闭 */ }
    joined = false;
    return { left: true };
  }

  async function close() {
    leave();
    await new Promise((resolve) => { try { socket.close(resolve); } catch (err) { resolve(); } });
    return { closed: true };
  }

  return {
    join, send, ping, leave, close,
    onMessage(fn) {
      if (typeof fn !== 'function') throw new Error('onMessage 需要函数');
      subscribed.add(fn);
      return () => subscribed.delete(fn);
    },
    getStats: () => ({ ...counters, joined, peerId, quality: quality.snapshot() }),
    getQuality: () => quality.snapshot(),
    get joined() { return joined; },
    get peerId() { return peerId; },
    get lastError() { return lastError; },
  };
}

module.exports = { DEFAULT_JOIN_TIMEOUT, createRelayClient };
