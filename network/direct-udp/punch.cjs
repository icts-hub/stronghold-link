'use strict';
// ============================================================================
// Stronghold Link — UDP 打洞状态机
//
// 流程（经典双向打洞）：
//   1. 两端各自用 STUN 拿到自己的公网映射，通过会话通道交换候选地址；
//   2. 两端**同时**向对方候选地址发探测包（不能只发一端等，NAT 要靠出站包开口）；
//   3. 任一端收到对方的探测包即视为打通，并回一个确认，另一端据此确认；
//   4. 预算内没打通就**如实失败**并给出原因，交给上层回退（本地中继 / SL Relay）。
//
// socket 是注入的（只需 send(buf, port, address) 与 onMessage 回调），
// 因此本模块可以用假 socket + 可控时钟完整单测；端到端打洞需两台机器。
// ============================================================================

const crypto = require('node:crypto');

const MAGIC = Buffer.from('SHL1');
const NONCE_LENGTH = 8;
const PROBE_TYPE = 1;
const ACK_TYPE = 2;

const STATES = Object.freeze({
  IDLE: 'idle',
  PUNCHING: 'punching',
  ESTABLISHED: 'established',
  FAILED: 'failed',
});

const DEFAULT_POLICY = Object.freeze({
  intervalMs: 250,        // 探测包间隔
  budgetMs: 8000,         // 总预算
  nonceTtlMs: 30000,      // 自己发出的 nonce 有效期（防重放）
});

function buildPacket(type, nonce) {
  const buf = Buffer.alloc(MAGIC.length + 1 + NONCE_LENGTH);
  MAGIC.copy(buf, 0);
  buf.writeUInt8(type, MAGIC.length);
  Buffer.from(nonce).copy(buf, MAGIC.length + 1);
  return buf;
}

/**
 * 解析探测/确认包。magic 不对或长度不对一律返回 null（不猜）。
 * @returns {{ type:number, nonceHex:string }|null}
 */
function parsePacket(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (buf.length !== MAGIC.length + 1 + NONCE_LENGTH) return null;
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  const type = buf.readUInt8(MAGIC.length);
  if (type !== PROBE_TYPE && type !== ACK_TYPE) return null;
  return { type, nonceHex: buf.subarray(MAGIC.length + 1).toString('hex') };
}

/**
 * @param {object} options
 * @param {object} options.socket                注入的 socket：send(buf, port, address)
 * @param {Array}  options.remoteCandidates      [{ address, port }]
 * @param {object} [options.policy]
 * @param {Function} [options.now]
 * @param {Function} [options.onEstablished]     (peer) => void
 * @param {Function} [options.onFailed]          (reason) => void
 */
function createPuncher({ socket, remoteCandidates = [], policy = {}, now = Date.now, onEstablished = null, onFailed = null } = {}) {
  const cfg = { ...DEFAULT_POLICY, ...policy };
  let state = STATES.IDLE;
  let peer = null;
  let reason = null;
  const ownNonces = new Map();      // nonceHex → 发出时间
  const seenNonces = new Set();     // 收到的 nonce（去重，防重放）
  let attempts = 0;
  let startedAt = null;
  let confirmed = false;            // 是否已收到对方对我们探测的确认

  function candidatesValid() {
    return remoteCandidates.filter((c) => c && typeof c.address === 'string' && Number.isInteger(c.port) && c.port > 0);
  }

  function sendProbes() {
    const nonce = crypto.randomBytes(NONCE_LENGTH);
    const hex = nonce.toString('hex');
    ownNonces.set(hex, now());
    const packet = buildPacket(PROBE_TYPE, nonce);
    let sent = 0;
    for (const candidate of candidatesValid()) {
      try {
        socket.send(packet, candidate.port, candidate.address);
        sent += 1;
      } catch (err) {
        // 单个候选发不出去不影响其它候选（例如 IPv6 不可用）
      }
    }
    attempts += 1;
    return sent;
  }

  function gc() {
    const at = now();
    for (const [hex, at0] of ownNonces) {
      if (at - at0 > cfg.nonceTtlMs) ownNonces.delete(hex);
    }
  }

  function establish(candidate, { viaAck }) {
    if (state === STATES.ESTABLISHED) return;
    state = STATES.ESTABLISHED;
    peer = { address: candidate.address, port: candidate.port };
    reason = viaAck ? '收到对端确认' : '收到对端探测包';
    if (typeof onEstablished === 'function') onEstablished(peer);
  }

  /** 收到一个 UDP 包（由调用方从真实 socket 转发进来）。 */
  function handlePacket(buffer, rinfo) {
    const parsed = parsePacket(buffer);
    if (!parsed) return { handled: false, reason: '不是本协议的包' };
    const from = { address: rinfo && rinfo.address, port: rinfo && rinfo.port };
    if (!from.address || !from.port) return { handled: false, reason: '缺少来源地址' };

    if (parsed.type === PROBE_TYPE) {
      if (seenNonces.has(parsed.nonceHex)) return { handled: true, duplicate: true };
      seenNonces.add(parsed.nonceHex);
      // 对方先打进来了：回一个确认，让对端也能确认这条路径
      try {
        socket.send(buildPacket(ACK_TYPE, Buffer.from(parsed.nonceHex, 'hex')), from.port, from.address);
      } catch (err) { /* 回包失败不改变"已打通"的事实：我们确实收到了对端 */ }
      establish(from, { viaAck: false });
      return { handled: true, established: true, peer };
    }

    if (parsed.type === ACK_TYPE) {
      // 只认自己发过的 nonce，避免被无关包"打成已连接"
      if (!ownNonces.has(parsed.nonceHex)) return { handled: true, ignored: 'nonce 不是本端发出的' };
      confirmed = true;
      if (state !== STATES.ESTABLISHED) establish(from, { viaAck: true });
      return { handled: true, established: true, peer, confirmed: true };
    }

    return { handled: false, reason: '未知包类型' };
  }

  function start() {
    if (state === STATES.PUNCHING || state === STATES.ESTABLISHED) {
      return { state, peer };
    }
    if (!socket || typeof socket.send !== 'function') {
      state = STATES.FAILED;
      reason = '没有可用的 UDP socket';
      if (typeof onFailed === 'function') onFailed(reason);
      return { state, peer: null, reason };
    }
    if (!candidatesValid().length) {
      state = STATES.FAILED;
      reason = '没有可用的对端候选地址';
      if (typeof onFailed === 'function') onFailed(reason);
      return { state, peer: null, reason };
    }
    state = STATES.PUNCHING;
    startedAt = now();
    reason = null;
    sendProbes();
    return { state, peer: null };
  }

  /** 走一拍：按间隔继续发探测，超预算则失败。 */
  function tick() {
    if (state === STATES.ESTABLISHED || state === STATES.FAILED) return snapshot();
    if (state === STATES.IDLE) return start();
    const elapsed = now() - startedAt;
    if (elapsed >= cfg.budgetMs) {
      state = STATES.FAILED;
      reason = '打洞超时（' + elapsed + 'ms）：对端未响应，可能需要中继';
      if (typeof onFailed === 'function') onFailed(reason);
      return snapshot();
    }
    if (elapsed >= attempts * cfg.intervalMs) sendProbes();
    gc();
    return snapshot();
  }

  function snapshot() {
    return {
      state,
      peer,
      reason,
      attempts,
      confirmed,
      elapsedMs: startedAt === null ? 0 : now() - startedAt,
      candidates: candidatesValid().length,
      policy: { ...cfg },
    };
  }

  function stop() {
    if (state !== STATES.ESTABLISHED) {
      state = STATES.FAILED;
      reason = reason || '已取消';
    }
    return snapshot();
  }

  return { start, tick, handlePacket, snapshot, stop, parsePacket, STATES, get state() { return state; } };
}

module.exports = { MAGIC, NONCE_LENGTH, PROBE_TYPE, ACK_TYPE, STATES, DEFAULT_POLICY, buildPacket, parsePacket, createPuncher };
