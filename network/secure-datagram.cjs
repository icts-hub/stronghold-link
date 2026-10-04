'use strict';
// Stronghold Link — UDP 安全通道（阶段 3）。
//
// UDP 无连接，所以握手是「数据报握手 + 重传」，由加入者侧主动重发 HELLO 直到收到 READY：
//   C -> S : HELLO      [1B 类型][16B clientNonce][32B clientPub]
//   S -> C : HELLO_OK   [1B][16B hostNonce][32B hostPub][32B serverTag]
//   C -> S : AUTH       [1B][32B clientTag]
//   S -> C : READY      [1B]        （房主确认；口令不对时回 DENY [1B][原因文本]）
//   之后：  DATA        [1B][8B 计数器][密文][16B 标签]（AES-256-GCM，逐包认证）
//
// * 密钥在 HELLO_OK 之后双方就已确定，因此即使 DATA 早于 READY 到达也能正确解密（UDP 不保证顺序）。
// * 重放保护：每个方向的滑动窗口；重放、过旧、篡改的数据报一律丢弃（不影响其他数据报）。
// * 本模块不做 I/O：只提供状态机，socket 收发仍由 udp-relay.cjs 负责，便于测试。

const C = require('./crypto.cjs');
const { describeSecureReason } = require('./secure-stream.cjs');

const TYPE_DATA = 0;
const TYPE_HELLO = 1;
const TYPE_HELLO_OK = 2;
const TYPE_AUTH = 3;
const TYPE_READY = 4;
const TYPE_DENY = 5;

const UDP_CONTEXT = '/udp';
const TRANSCRIPT_TAG = Buffer.from('SHL2-UDP', 'utf8');
const NONCE_LENGTH = 16;
const DENY_TEXT_LIMIT = 120;
const PENDING_TTL_MS = 10000;
const SESSION_IDLE_MS = 60000;

function transcriptOf(clientNonce, clientPub, hostNonce, hostPub) {
  return Buffer.concat([TRANSCRIPT_TAG, clientNonce, clientPub, hostNonce, hostPub]);
}

function sessionIdOf(clientNonce, hostNonce, clientPub, hostPub) {
  return require('node:crypto').createHash('sha256')
    .update(Buffer.concat([clientNonce, hostNonce, clientPub, hostPub]))
    .digest('hex').slice(0, 12);
}

function sealPacket(session, plaintext) {
  const frame = session.sealer.seal(plaintext);
  const packet = Buffer.alloc(1 + frame.length);
  packet[0] = TYPE_DATA;
  frame.copy(packet, 1);
  return packet;
}

/** 打开一条 DATA 数据报；失败返回 { ok:false, reason }。 */
function openDataPacket(session, packet) {
  const body = packet.subarray(1);
  if (body.length < C.COUNTER_LENGTH + C.TAG_LENGTH) return { ok: false, reason: 'short-frame' };
  const declared = body.readUInt32BE(0); // 与流模式一致的帧头（长度 + 计数器）
  if (declared !== body.length - 4) return { ok: false, reason: 'length-mismatch' };
  const counter = body.readBigUInt64BE(4);
  if (!session.replay.accept(counter)) return { ok: false, reason: 'replay' };
  const result = session.opener.open(body);
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, payload: result.plaintext };
}

/** 房主侧状态机：按「加入者数据报源地址」维护会话。 */
class SecureDatagramHost {
  constructor({ passphrase, onEvent = null, pendingTtlMs = PENDING_TTL_MS, sessionIdleMs = SESSION_IDLE_MS, canAccept = null } = {}) {
    this.psk = C.derivePsk(passphrase);
    this.onEvent = onEvent;
    this.pendingTtlMs = pendingTtlMs;
    this.sessionIdleMs = sessionIdleMs;
    this.canAccept = typeof canAccept === 'function' ? canAccept : null;
    this.pending = new Map(); // key -> { keys, transcript, serverTag, createdAt }
    this.sessions = new Map(); // key -> { keys, sealer, opener, replay, lastSeen, sessionId }
  }

  emit(type, payload) {
    if (typeof this.onEvent === 'function') { try { this.onEvent(type, payload); } catch { /* ignore */ } }
  }

  /** 处理一个数据报：返回 { action: 'reply'|'data'|'drop', reply?, payload?, reason? }。 */
  handle(packet, key) {
    if (!Buffer.isBuffer(packet) || packet.length === 0) return { action: 'drop', reason: 'empty' };
    const type = packet[0];
    const now = Date.now();

    if (type === TYPE_HELLO) {
      this.sweep(now);
      if (packet.length !== 1 + NONCE_LENGTH + 32) return { action: 'drop', reason: 'bad-hello' };
      const clientNonce = packet.subarray(1, 1 + NONCE_LENGTH);
      const clientPub = packet.subarray(1 + NONCE_LENGTH);
      let keys;
      try {
        const hostKeys = C.generateKeyPair();
        const hostPub = C.publicKeyRaw(hostKeys);
        const hostNonce = C.randomBytes(NONCE_LENGTH);
        keys = C.deriveSessionKeys({
          sharedSecret: C.sharedSecret(hostKeys, clientPub),
          psk: this.psk,
          clientNonce,
          hostNonce,
          context: UDP_CONTEXT,
        });
        const transcript = transcriptOf(clientNonce, clientPub, hostNonce, hostPub);
        const serverTag = C.authTag(keys.authKey, transcript, 'server');
        this.pending.set(key, { keys, transcript, serverTag, createdAt: now, sessionId: sessionIdOf(clientNonce, hostNonce, clientPub, hostPub) });
        const reply = Buffer.alloc(1 + NONCE_LENGTH + 32 + 32);
        reply[0] = TYPE_HELLO_OK;
        hostNonce.copy(reply, 1);
        hostPub.copy(reply, 1 + NONCE_LENGTH);
        serverTag.copy(reply, 1 + NONCE_LENGTH + 32);
        return { action: 'reply', reply, kind: 'hello-ok' };
      } catch {
        return { action: 'drop', reason: 'bad-hello' };
      }
    }

    if (type === TYPE_AUTH) {
      const pending = this.pending.get(key);
      if (!pending) return { action: 'drop', reason: 'no-pending' };
      if (packet.length !== 1 + 32) return { action: 'drop', reason: 'bad-auth' };
      const expected = C.authTag(pending.keys.authKey, Buffer.concat([pending.transcript, pending.serverTag]), 'client');
      if (!C.timingSafeEqual(expected, packet.subarray(1))) {
        this.pending.delete(key);
        const text = Buffer.from(describeSecureReason('bad-tag'), 'utf8').subarray(0, DENY_TEXT_LIMIT);
        const reply = Buffer.alloc(1 + text.length);
        reply[0] = TYPE_DENY;
        text.copy(reply, 1);
        this.emit('secure-deny', { key, reason: 'bad-tag' });
        return { action: 'reply', reply, kind: 'deny' };
      }
      // 认证通过但不再接受新会话（例如房间已满）：在 AUTH 阶段就明确拒绝，而不是先 READY 再断开
      if (this.canAccept && !this.canAccept(key)) {
        this.pending.delete(key);
        this.emit('secure-deny', { key, reason: 'room-full' });
        return { action: 'reply', reply: denyPacket('房间已满'), kind: 'deny' };
      }
      const session = {
        keys: pending.keys,
        sealer: C.createSealer(pending.keys.serverToClient),
        opener: C.createOpener(pending.keys.clientToServer, { strictOrder: false }),
        replay: C.createReplayWindow(1024),
        lastSeen: now,
        sessionId: pending.sessionId,
      };
      this.pending.delete(key);
      this.sessions.set(key, session);
      if (this.sessions.size > 64) this.sessions.delete(this.sessions.keys().next().value);
      this.emit('secure-handshake', { key, sessionId: session.sessionId });
      return { action: 'reply', reply: Buffer.from([TYPE_READY]), kind: 'ready', sessionId: session.sessionId };
    }

    if (type === TYPE_DATA) {
      const session = this.sessions.get(key);
      if (!session) return { action: 'drop', reason: 'no-session' };
      session.lastSeen = now;
      const opened = openDataPacket(session, packet);
      if (!opened.ok) {
        if (opened.reason === 'replay' || opened.reason === 'auth-failed') this.emit('secure-failure', { key, reason: opened.reason });
        return { action: 'drop', reason: opened.reason };
      }
      return { action: 'data', payload: opened.payload, session };
    }

    return { action: 'drop', reason: `unknown-type-${type}` };
  }

  /** 加密一条要发给某个加入者的数据报；没有会话返回 null。 */
  seal(key, plaintext) {
    const session = this.sessions.get(key);
    if (!session) return null;
    session.lastSeen = Date.now();
    return sealPacket(session, plaintext);
  }

  hasSession(key) {
    return this.sessions.has(key);
  }

  sessionsCount() {
    return this.sessions.size;
  }

  drop(key) {
    this.pending.delete(key);
    this.sessions.delete(key);
  }

  sweep(now = Date.now()) {
    for (const [key, entry] of this.pending) {
      if (now - entry.createdAt > this.pendingTtlMs) this.pending.delete(key);
    }
    for (const [key, session] of this.sessions) {
      if (now - session.lastSeen > this.sessionIdleMs) {
        this.sessions.delete(key);
        this.emit('session-expired', { key });
      }
    }
  }
}

/** 加入者侧状态机：主动重传 HELLO，收到 READY 后进入就绪。 */
class SecureDatagramClient {
  constructor({ passphrase, onEvent = null, retryMs = 250, maxAttempts = 12 } = {}) {
    this.psk = C.derivePsk(passphrase);
    this.onEvent = onEvent;
    this.retryMs = retryMs;
    this.maxAttempts = maxAttempts;
    this.attempts = 0;
    this.state = 'idle'; // idle | waiting | keys | ready | failed
    this.keys = null;
    this.transcript = null;
    this.serverTag = null;
    this.clientNonce = null;
    this.clientPub = null;
    this.clientKeys = null;
    this.sealer = null;
    this.opener = null;
    this.replay = null;
    this.sessionId = null;
    this.lastError = null;
  }

  emit(type, payload) {
    if (typeof this.onEvent === 'function') { try { this.onEvent(type, payload); } catch { /* ignore */ } }
  }

  get ready() { return this.state === 'ready'; }
  get canEncrypt() { return this.state === 'keys' || this.state === 'ready'; }

  /** 生成并记录一次握手，返回要发送的 HELLO 数据报。 */
  hello() {
    this.clientKeys = C.generateKeyPair();
    this.clientPub = C.publicKeyRaw(this.clientKeys);
    this.clientNonce = C.randomBytes(NONCE_LENGTH);
    this.keys = null;
    this.state = 'waiting';
    this.attempts += 1;
    const packet = Buffer.alloc(1 + NONCE_LENGTH + 32);
    packet[0] = TYPE_HELLO;
    this.clientNonce.copy(packet, 1);
    this.clientPub.copy(packet, 1 + NONCE_LENGTH);
    return packet;
  }

  /** 处理来自房主的数据报；返回 { action, reply?, payload?, reason? }。 */
  handle(packet) {
    if (!Buffer.isBuffer(packet) || packet.length === 0) return { action: 'drop', reason: 'empty' };
    const type = packet[0];

    if (type === TYPE_HELLO_OK) {
      if (packet.length !== 1 + NONCE_LENGTH + 32 + 32) return { action: 'drop', reason: 'bad-hello-ok' };
      const hostNonce = packet.subarray(1, 1 + NONCE_LENGTH);
      const hostPub = packet.subarray(1 + NONCE_LENGTH, 1 + NONCE_LENGTH + 32);
      const serverTag = packet.subarray(1 + NONCE_LENGTH + 32);
      let keys;
      try {
        keys = C.deriveSessionKeys({
          sharedSecret: C.sharedSecret(this.clientKeys, hostPub),
          psk: this.psk,
          clientNonce: this.clientNonce,
          hostNonce,
          context: UDP_CONTEXT,
        });
      } catch {
        return { action: 'drop', reason: 'bad-hello-ok' };
      }
      const transcript = transcriptOf(this.clientNonce, this.clientPub, hostNonce, hostPub);
      if (!C.timingSafeEqual(C.authTag(keys.authKey, transcript, 'server'), serverTag)) {
        this.state = 'failed';
        this.lastError = describeSecureReason('bad-tag');
        this.emit('secure-failure', { reason: 'bad-tag' });
        return { action: 'error', reason: 'bad-tag' };
      }
      this.keys = keys;
      this.transcript = transcript;
      this.serverTag = serverTag;
      this.sealer = C.createSealer(keys.clientToServer);
      this.opener = C.createOpener(keys.serverToClient, { strictOrder: false });
      this.replay = C.createReplayWindow(1024);
      this.sessionId = sessionIdOf(this.clientNonce, hostNonce, this.clientPub, hostPub);
      this.state = 'keys';
      const auth = Buffer.alloc(1 + 32);
      auth[0] = TYPE_AUTH;
      C.authTag(keys.authKey, Buffer.concat([transcript, serverTag]), 'client').copy(auth, 1);
      return { action: 'send', reply: auth, kind: 'auth' };
    }

    if (type === TYPE_READY) {
      if (this.state === 'keys' || this.state === 'waiting') {
        this.state = 'ready';
        this.emit('secure-handshake', { sessionId: this.sessionId });
        return { action: 'ready', sessionId: this.sessionId };
      }
      return { action: 'drop', reason: 'unexpected-ready' };
    }

    if (type === TYPE_DENY) {
      const reason = packet.subarray(1).toString('utf8') || describeSecureReason('bad-tag');
      this.state = 'failed';
      this.lastError = reason;
      this.emit('secure-deny', { reason });
      return { action: 'error', reason };
    }

    if (type === TYPE_DATA) {
      if (!this.canEncrypt || !this.opener) return { action: 'drop', reason: 'no-keys' };
      const session = { opener: this.opener, replay: this.replay };
      const opened = openDataPacket(session, packet);
      if (!opened.ok) {
        if (opened.reason === 'replay' || opened.reason === 'auth-failed') this.emit('secure-failure', { reason: opened.reason });
        return { action: 'drop', reason: opened.reason };
      }
      return { action: 'data', payload: opened.payload };
    }

    return { action: 'drop', reason: `unknown-type-${type}` };
  }

  /** 加密一条要发给房主的数据报；密钥未就绪返回 null。 */
  seal(plaintext) {
    if (!this.canEncrypt || !this.sealer) return null;
    return sealPacket({ sealer: this.sealer }, plaintext);
  }
}

/** 构造一个 DENY 数据报（房间已满、口令不匹配等）。 */
function denyPacket(reason) {
  const text = Buffer.from(String(reason || describeSecureReason('bad-tag')), 'utf8').subarray(0, DENY_TEXT_LIMIT);
  const packet = Buffer.alloc(1 + text.length);
  packet[0] = TYPE_DENY;
  text.copy(packet, 1);
  return packet;
}

module.exports = {
  TYPE_DATA,
  TYPE_HELLO,
  TYPE_HELLO_OK,
  TYPE_AUTH,
  TYPE_READY,
  TYPE_DENY,
  UDP_CONTEXT,
  denyPacket,
  SecureDatagramHost,
  SecureDatagramClient,
};
