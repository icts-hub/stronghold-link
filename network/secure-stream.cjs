'use strict';
// Stronghold Link — TCP 安全通道（阶段 3）。
//
// 握手（明文帧，之后全部加密）：
//   C -> S : SHL2 <clientNonce> <clientPub>
//   S -> C : SHL2-OK-HELLO <hostNonce> <hostPub> <serverTag>
//   C -> S : SHL2-AUTH <clientTag>
//   S -> C : SHL2-OK            （房主确认，之后开始转发；失败则 SHL2-DENY <原因>）
//
// * serverTag / clientTag 是用「PSK + ECDH」派生出的 authKey 对握手记录做的 HMAC：
//   房主证明自己知道口令，加入者也证明自己知道口令 —— 缺一个都握不上手。
// * 记录层：AES-256-GCM，帧格式 [4B 长度][8B 计数器][密文][16B 标签]，
//   计数器严格递增（TCP 有序），因此重放/乱序/篡改都会被拒绝并立刻断开。
// * 游戏数据在握手后完全透明：加密流还原出的仍是原来的字节流。

const { Transform } = require('node:stream');
const C = require('./crypto.cjs');

const HANDSHAKE_TIMEOUT_MS = 5000;
const MAX_HANDSHAKE_BYTES = 1024;
const MAGIC = C.PROTOCOL_TAG;

function makeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** 把内部失败原因翻译成界面可读的中文（两端都复用）。 */
function describeSecureReason(reason) {
  switch (reason) {
    case 'auth-failed': return '加密校验失败：数据被篡改，或两端口令不一致';
    case 'replay-or-gap': return '加密记录顺序异常（疑似重放或丢包），连接已断开';
    case 'length-mismatch': return '加密记录长度与实际不符，连接已断开';
    case 'too-large': return '加密记录超过允许的大小上限，连接已断开';
    case 'short-frame': return '收到不完整的加密记录，连接已断开';
    case 'bad-tag': return '口令不匹配（对端无法通过认证）';
    case 'timeout': return '加密握手超时：对方可能版本过旧，或口令不一致';
    case 'legacy-peer': return '对方使用的是 0.5.0 之前的明文握手，请双方升级到同一版本';
    case 'bad-protocol': return '对方发来的不是 Stronghold Link 加密握手数据';
    default: return reason || '加密通道错误';
  }
}

function secureError(code, reason) {
  const err = makeError(code, describeSecureReason(reason));
  err.reason = reason;
  return err;
}

/** 加密变换流：写入明文，读出加密帧。 */
class EncryptStream extends Transform {
  constructor(sealer) {
    super();
    this.sealer = sealer;
  }

  _transform(chunk, _encoding, callback) {
    try {
      callback(null, this.sealer.seal(chunk));
    } catch (err) {
      callback(err);
    }
  }
}

/** 解密变换流：写入加密帧（可能分片），读出明文。任何校验失败都会让流报错并断开。 */
class DecryptStream extends Transform {
  constructor(opener, onFailure) {
    super();
    this.opener = opener;
    this.onFailure = typeof onFailure === 'function' ? onFailure : null;
    this.buffer = Buffer.alloc(0);
  }

  _transform(chunk, _encoding, callback) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 4) {
      const declared = this.buffer.readUInt32BE(0);
      if (declared > C.MAX_RECORD_LENGTH + C.COUNTER_LENGTH + C.TAG_LENGTH) {
        this.fail('too-large');
        return callback(secureError('ESECURE', 'too-large'));
      }
      const total = 4 + declared;
      if (this.buffer.length < total) break;
      const frame = this.buffer.subarray(0, total);
      this.buffer = this.buffer.subarray(total);
      const result = this.opener.open(frame);
      if (!result.ok) {
        this.fail(result.reason);
        return callback(secureError('ESECURE', result.reason));
      }
      this.push(result.plaintext);
    }
    callback();
  }

  fail(reason) {
    if (this.onFailure) {
      try { this.onFailure(reason); } catch { /* 回调失败不影响断开 */ }
    }
  }
}

/** 行读取器：握手阶段按行读取，并把剩余字节交回调用方（可能是紧随其后的第一个加密帧）。 */
class LineReader {
  constructor(socket, timeoutMs = HANDSHAKE_TIMEOUT_MS) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.failure = null;

    this.onData = (chunk) => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      this.pump();
    };
    this.onError = (err) => this.fail(err);
    this.onClose = () => this.fail(makeError('ECLOSED', '对端在握手完成前关闭了连接'));

    socket.on('data', this.onData);
    socket.once('error', this.onError);
    socket.once('close', this.onClose);
  }

  takeLine() {
    const index = this.buffer.indexOf(0x0a);
    if (index < 0) return null;
    const line = this.buffer.subarray(0, index).toString('utf8').trim();
    this.buffer = this.buffer.subarray(index + 1);
    return line;
  }

  pump() {
    for (;;) {
      const line = this.takeLine();
      if (line == null) break;
      const waiter = this.waiters.shift();
      if (!waiter) {
        // 没有等待者还收到整行：说明对端在协议之外多发数据，视为协议错误
        this.fail(makeError('EPROTOCOL', '收到了握手流程之外的报文'));
        return;
      }
      clearTimeout(waiter.timer);
      waiter.resolve(line);
    }
    if (this.waiters.length === 0 && this.buffer.length > MAX_HANDSHAKE_BYTES) {
      this.fail(makeError('EPROTOCOL', '握手数据过长'));
    }
  }

  fail(err) {
    if (this.failure) return;
    this.failure = err;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }

  nextLine(overrideMs) {
    if (this.failure) return Promise.reject(this.failure);
    const line = this.takeLine();
    if (line != null) return Promise.resolve(line);
    const timeout = Number.isFinite(overrideMs) ? overrideMs : this.timeoutMs;
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(secureError('ETIMEDOUT', 'timeout'));
      }, timeout);
      this.waiters.push(waiter);
    });
  }

  /** 结束行读取，返回剩余字节并摘掉监听。 */
  release() {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
    const rest = this.buffer;
    this.buffer = Buffer.alloc(0);
    this.fail(makeError('ECLOSED', '握手阶段已结束'));
    return rest;
  }
}

function transcriptOf(clientNonce, clientPub, hostNonce, hostPub) {
  return Buffer.concat([Buffer.from(MAGIC, 'utf8'), clientNonce, clientPub, hostNonce, hostPub]);
}

function sessionIdOf(clientNonce, hostNonce, clientPub, hostPub) {
  return require('node:crypto').createHash('sha256')
    .update(Buffer.concat([clientNonce, hostNonce, clientPub, hostPub]))
    .digest('hex').slice(0, 12);
}

function parseHex(value, bytes, label) {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]+$/.test(value) || value.length !== bytes * 2) {
    throw secureError('EPROTOCOL', 'bad-protocol');
  }
  return Buffer.from(value, 'hex');
}

function deny(socket, reason) {
  const message = `${MAGIC}-DENY ${describeSecureReason(reason)}\n`;
  try {
    // 先保证报文发出去再关闭，否则加入者只会看到「连接被关闭」而拿不到具体原因
    socket.write(message, () => { try { socket.end(); } catch { /* 已关闭 */ } });
  } catch {
    socket.destroy();
    return;
  }
  setTimeout(() => { try { socket.destroy(); } catch { /* 已关闭 */ } }, 500).unref?.();
}

/**
 * 房主侧：完成握手校验，返回 { sessionId, rest, keys, accept(), deny(reason) }。
 *
 * 重要：调用方拿到结果后**必须尽快**调用 accept() 或 deny()（例如先连本地游戏端口再 accept），
 * 因为加入者此刻正在等 SHL2-OK / SHL2-DENY。为防止调用方忘记，超时（pendingTimeoutMs）会自动 deny。
 */
async function serverHandshake(socket, { passphrase, psk: precomputedPsk, timeoutMs = HANDSHAKE_TIMEOUT_MS, pendingTimeoutMs = 8000, onEvent = null } = {}) {
  const emit = (type, payload) => { if (typeof onEvent === 'function') { try { onEvent(type, payload); } catch { /* ignore */ } } };
  const reader = new LineReader(socket, timeoutMs);
  let psk;
  try {
    // scrypt 很贵，所以由中继层一次性算好后传进来（psk）；这里只在没传时兜底计算。
    psk = Buffer.isBuffer(precomputedPsk) ? precomputedPsk : C.derivePsk(passphrase);
  } catch (err) {
    reader.release();
    deny(socket, 'no-passphrase');
    throw err;
  }

  let first;
  try {
    first = await reader.nextLine();
  } catch (err) {
    reader.release();
    throw err.code === 'ETIMEDOUT' ? secureError('ESECURE', 'timeout') : err;
  }

  if (first.startsWith(`${MAGIC}-`) || first.startsWith('SHL1')) {
    reader.release();
    const reason = first.startsWith('SHL1') ? 'legacy-peer' : 'bad-protocol';
    deny(socket, reason);
    throw secureError('ESECURE', reason);
  }
  const parts = first.split(/\s+/);
  if (parts[0] !== MAGIC || parts.length !== 3) {
    reader.release();
    deny(socket, 'bad-protocol');
    throw secureError('ESECURE', 'bad-protocol');
  }

  const clientNonce = parseHex(parts[1], 16, 'clientNonce');
  const clientPub = parseHex(parts[2], 32, 'clientPub');
  const hostKeys = C.generateKeyPair();
  const hostPub = C.publicKeyRaw(hostKeys);
  const hostNonce = C.randomBytes(16);

  let keys;
  try {
    keys = C.deriveSessionKeys({
      sharedSecret: C.sharedSecret(hostKeys, clientPub),
      psk,
      clientNonce,
      hostNonce,
    });
  } catch {
    reader.release();
    deny(socket, 'bad-protocol');
    throw secureError('ESECURE', 'bad-protocol');
  }

  const transcript = transcriptOf(clientNonce, clientPub, hostNonce, hostPub);
  const serverTag = C.authTag(keys.authKey, transcript, 'server');
  socket.write(`${MAGIC}-OK-HELLO ${hostNonce.toString('hex')} ${hostPub.toString('hex')} ${serverTag.toString('hex')}\n`);

  let third;
  try {
    third = await reader.nextLine();
  } catch (err) {
    reader.release();
    throw err.code === 'ETIMEDOUT' ? secureError('ESECURE', 'timeout') : err;
  }
  if (third.startsWith(`${MAGIC}-DENY`)) {
    // 加入者在本地就发现房主无法通过认证（多半是两端口令不一致）
    reader.release();
    throw secureError('ESECURE', 'bad-tag');
  }
  const thirdParts = third.split(/\s+/);
  if (thirdParts[0] !== `${MAGIC}-AUTH` || thirdParts.length !== 2) {
    reader.release();
    deny(socket, 'bad-protocol');
    throw secureError('ESECURE', 'bad-protocol');
  }
  const expectedClientTag = C.authTag(keys.authKey, Buffer.concat([transcript, serverTag]), 'client');
  if (!C.timingSafeEqual(expectedClientTag, parseHex(thirdParts[1], 32, 'clientTag'))) {
    reader.release();
    deny(socket, 'bad-tag');
    throw secureError('ESECURE', 'bad-tag');
  }

  const rest = reader.release();
  const sessionId = sessionIdOf(clientNonce, hostNonce, clientPub, hostPub);
  emit('secure-handshake', { sessionId });

  let settled = false;
  const safety = setTimeout(() => {
    if (settled) return;
    settled = true;
    emit('secure-failure', { reason: 'timeout' });
    deny(socket, 'timeout');
  }, pendingTimeoutMs);
  safety.unref?.();

  const finish = () => { settled = true; clearTimeout(safety); };

  return {
    sessionId,
    rest,
    keys,
    /** 确认握手（发 SHL2-OK）并返回两个变换流。 */
    accept() {
      if (settled) return null;
      finish();
      socket.write(`${MAGIC}-OK\n`);
      return {
        encrypt: new EncryptStream(C.createSealer(keys.serverToClient)),
        decrypt: new DecryptStream(C.createOpener(keys.clientToServer), (reason) => emit('secure-failure', { reason })),
      };
    },
    deny(reason) {
      if (settled) return;
      finish();
      deny(socket, reason);
    },
  };
}

/** 加入者侧：完成握手，返回 { sessionId, rest, encrypt, decrypt }；任何认证失败都会抛出可读错误。 */
async function clientHandshake(socket, { passphrase, psk: precomputedPsk, timeoutMs = HANDSHAKE_TIMEOUT_MS, finalTimeoutMs = 12000, onEvent = null } = {}) {
  const emit = (type, payload) => { if (typeof onEvent === 'function') { try { onEvent(type, payload); } catch { /* ignore */ } } };
  const reader = new LineReader(socket, timeoutMs);
  const psk = Buffer.isBuffer(precomputedPsk) ? precomputedPsk : C.derivePsk(passphrase);
  const clientKeys = C.generateKeyPair();
  const clientPub = C.publicKeyRaw(clientKeys);
  const clientNonce = C.randomBytes(16);

  socket.write(`${MAGIC} ${clientNonce.toString('hex')} ${clientPub.toString('hex')}\n`);

  let second;
  try {
    second = await reader.nextLine();
  } catch (err) {
    reader.release();
    throw err.code === 'ETIMEDOUT' ? secureError('ESECURE', 'timeout') : err;
  }
  if (second.startsWith(`${MAGIC}-DENY`)) {
    const reason = second.slice(`${MAGIC}-DENY`.length).trim();
    reader.release();
    const err = secureError('EDENIED', 'bad-tag');
    err.denyReason = reason;
    err.message = reason || err.message;
    throw err;
  }
  const parts = second.split(/\s+/);
  if (parts[0] !== `${MAGIC}-OK-HELLO` || parts.length !== 4) {
    reader.release();
    throw secureError('ESECURE', 'bad-protocol');
  }
  const hostNonce = parseHex(parts[1], 16, 'hostNonce');
  const hostPub = parseHex(parts[2], 32, 'hostPub');
  const serverTag = parseHex(parts[3], 32, 'serverTag');

  const keys = C.deriveSessionKeys({
    sharedSecret: C.sharedSecret(clientKeys, hostPub),
    psk,
    clientNonce,
    hostNonce,
  });
  const transcript = transcriptOf(clientNonce, clientPub, hostNonce, hostPub);
  if (!C.timingSafeEqual(C.authTag(keys.authKey, transcript, 'server'), serverTag)) {
    // 告诉房主「我这边认证不通过」，否则房主只能看到连接被关闭
    try { socket.write(`${MAGIC}-DENY ${describeSecureReason('bad-tag')}\n`); } catch { /* 忽略 */ }
    reader.release();
    socket.destroy();
    throw secureError('EDENIED', 'bad-tag');
  }
  socket.write(`${MAGIC}-AUTH ${C.authTag(keys.authKey, Buffer.concat([transcript, serverTag]), 'client').toString('hex')}\n`);

  let final;
  try {
    // 房主可能要先连本地游戏端口再 accept，所以这一步给更长的等待时间
    final = await reader.nextLine(finalTimeoutMs);
  } catch (err) {
    reader.release();
    throw err.code === 'ETIMEDOUT' ? secureError('ESECURE', 'timeout') : err;
  }
  if (final.startsWith(`${MAGIC}-DENY`)) {
    const reason = final.slice(`${MAGIC}-DENY`.length).trim();
    reader.release();
    const err = secureError('EDENIED', 'bad-tag');
    err.denyReason = reason;
    err.message = reason || err.message;
    throw err;
  }
  if (final !== `${MAGIC}-OK`) {
    reader.release();
    throw secureError('ESECURE', 'bad-protocol');
  }

  const rest = reader.release();
  const sessionId = sessionIdOf(clientNonce, hostNonce, clientPub, hostPub);
  emit('secure-handshake', { sessionId });
  return {
    sessionId,
    rest,
    encrypt: new EncryptStream(C.createSealer(keys.clientToServer)),
    decrypt: new DecryptStream(C.createOpener(keys.serverToClient), (reason) => emit('secure-failure', { reason })),
  };
}

module.exports = {
  MAGIC,
  HANDSHAKE_TIMEOUT_MS,
  EncryptStream,
  DecryptStream,
  serverHandshake,
  clientHandshake,
  describeSecureReason,
  secureError,
};
