'use strict';
// Stronghold Link — 会话安全原语（阶段 3）。
//
// 只用 node:crypto，不引入任何第三方依赖。设计目标（按重要性排序）：
//   1) 机密性：链路上不再出现明文游戏数据（AES-256-GCM）。
//   2) 双向认证：双方都必须知道会话口令（PSK），单靠抓包无法冒充任何一端。
//   3) 前向保密：每次会话用临时 X25519 密钥协商，口令事后泄露也无法解密已录制流量。
//   4) 防重放：TCP 用严格递增记录计数器；UDP 用计数器 + 滑动窗口。
//
// 这不是「自创加密算法」：X25519 / HKDF-SHA256 / AES-256-GCM / scrypt 全部来自 node:crypto；
// 组合方式是类 Noise 的常规做法（PSK 参与认证与密钥派生，临时 ECDH 提供前向保密）。
//
// 威胁模型与边界（必须诚实）：
//   * 能防：同网段被动抓包、主动篡改、重放、无口令冒充、中间人（无口令时）。
//   * 不能防：口令本身被猜到/泄露（口令强度是短板——界面会对弱口令告警）；
//     也不能防端点已被攻破（终端的游戏数据在内存里是明文）。

const crypto = require('node:crypto');

const PROTOCOL_TAG = 'SHL2';
const KDF_INFO = 'stronghold-link/v2';
// scrypt 参数：约 16 MiB / ~50ms，用于把人类口令/邀请码口令硬化成 32 字节 PSK。
const SCRYPT_PARAMS = { N: 1 << 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const PSK_SALT = 'stronghold-link/v2-psk';
const KEY_LENGTH = 32;          // AES-256
const NONCE_LENGTH = 12;        // GCM 标准 96-bit nonce
const TAG_LENGTH = 16;
const COUNTER_LENGTH = 8;
const MAX_RECORD_LENGTH = 1024 * 1024; // 单条加密记录上限（防止对端用长度字段撑爆内存）
const PUBLIC_KEY_LENGTH = 32;   // X25519 原始公钥长度

// X25519 原始公钥的 SPKI(DER) 前缀：302a300506032b656e032100
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

/** 从会话口令派生 32 字节 PSK（scrypt 硬化，防止弱口令被离线暴力破解得太快）。 */
function derivePsk(passphrase, salt = PSK_SALT) {
  const text = String(passphrase ?? '');
  if (!text) throw new Error('会话口令不能为空');
  return Buffer.from(crypto.scryptSync(Buffer.from(text, 'utf8'), Buffer.from(salt, 'utf8'), KEY_LENGTH, SCRYPT_PARAMS));
}

/** 生成临时 X25519 密钥对。 */
function generateKeyPair() {
  return crypto.generateKeyPairSync('x25519');
}

/** 导出 32 字节原始公钥（便于放进握手报文）。 */
function publicKeyRaw(keyPair) {
  const der = keyPair.publicKey.export({ type: 'spki', format: 'der' });
  return Buffer.from(der.subarray(der.length - PUBLIC_KEY_LENGTH));
}

/** 导入对端 32 字节原始公钥。 */
function importPublicKeyRaw(raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== PUBLIC_KEY_LENGTH) throw new Error('对端公钥长度无效');
  return crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** X25519 ECDH。 */
function sharedSecret(keyPair, peerRawPublicKey) {
  return Buffer.from(crypto.diffieHellman({ privateKey: keyPair.privateKey, publicKey: importPublicKeyRaw(peerRawPublicKey) }));
}

function hkdf(ikm, salt, info, length = KEY_LENGTH) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), length));
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function randomBytes(n) {
  return crypto.randomBytes(n);
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * 由 ECDH 共享秘密 + PSK 派生会话密钥。
 * ikm 同时包含 ECDH 结果与 PSK：缺任何一半都推不出密钥（前向保密 + 口令认证同时成立）。
 */
function deriveSessionKeys({ sharedSecret: ecdh, psk, clientNonce, hostNonce, context = '' }) {
  if (!Buffer.isBuffer(ecdh) || ecdh.length !== KEY_LENGTH) throw new Error('ECDH 共享秘密无效');
  if (!Buffer.isBuffer(psk) || psk.length !== KEY_LENGTH) throw new Error('PSK 无效');
  const salt = Buffer.concat([Buffer.from(PROTOCOL_TAG, 'utf8'), clientNonce, hostNonce]);
  const ikm = Buffer.concat([ecdh, psk]);
  return {
    clientToServer: hkdf(ikm, salt, `${KDF_INFO}${context}/c2s`),
    serverToClient: hkdf(ikm, salt, `${KDF_INFO}${context}/s2c`),
    authKey: hkdf(ikm, salt, `${KDF_INFO}${context}/auth`),
  };
}

/** 握手认证标签：transcript 覆盖双方的 nonce 与公钥，防止握手被篡改。 */
function authTag(authKey, transcript, role) {
  return hmac(authKey, Buffer.concat([Buffer.from(`${KDF_INFO}/tag/${role}`, 'utf8'), transcript]));
}

/**
 * AEAD 记录封装器：严格递增计数器，nonce = 密钥前 4 字节 || 8 字节计数器。
 * 因为方向密钥不同、每次会话密钥都是新的，同一密钥下 nonce 永不重复。
 */
function createSealer(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH) throw new Error('加密密钥无效');
  const prefix = key.subarray(0, 4);
  let counter = 0n;
  return {
    get counter() { return counter; },
    /** 加密一条记录：返回 [4B 长度][8B 计数器][密文][16B 认证标签]。 */
    seal(plaintext) {
      const payload = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);
      if (payload.length > MAX_RECORD_LENGTH) throw new Error('单条记录超过大小上限');
      const nonce = Buffer.alloc(NONCE_LENGTH);
      prefix.copy(nonce, 0);
      nonce.writeBigUInt64BE(counter, 4);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LENGTH });
      const body = Buffer.concat([cipher.update(payload), cipher.final()]);
      const frame = Buffer.alloc(4 + COUNTER_LENGTH + body.length + TAG_LENGTH);
      // 长度字段 = 计数器 + 密文 + 标签（即除长度字段自身以外的全部字节）
      frame.writeUInt32BE(COUNTER_LENGTH + body.length + TAG_LENGTH, 0);
      frame.writeBigUInt64BE(counter, 4);
      body.copy(frame, 12);
      cipher.getAuthTag().copy(frame, 12 + body.length);
      counter += 1n;
      return frame;
    },
  };
}

/** 与 createSealer 对应的解封器：要求计数器严格递增（TCP 有序流，天然防重放）。 */
function createOpener(key, { strictOrder = true } = {}) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH) throw new Error('解密密钥无效');
  const prefix = key.subarray(0, 4);
  let expected = 0n;
  return {
    get expected() { return expected; },
    /** 解开一条完整的 [4B 长度][8B 计数器][密文][16B 标签]；失败返回 { ok:false, reason }。 */
    open(frame) {
      if (!Buffer.isBuffer(frame) || frame.length < 4 + COUNTER_LENGTH + TAG_LENGTH) return { ok: false, reason: 'short-frame' };
      const declared = frame.readUInt32BE(0);
      if (declared !== frame.length - 4) return { ok: false, reason: 'length-mismatch' };
      if (declared - TAG_LENGTH - COUNTER_LENGTH > MAX_RECORD_LENGTH) return { ok: false, reason: 'too-large' };
      const counter = frame.readBigUInt64BE(4);
      if (strictOrder && counter !== expected) return { ok: false, reason: 'replay-or-gap' };
      const nonce = Buffer.alloc(NONCE_LENGTH);
      prefix.copy(nonce, 0);
      nonce.writeBigUInt64BE(counter, 4);
      const tagStart = frame.length - TAG_LENGTH;
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LENGTH });
      decipher.setAuthTag(frame.subarray(tagStart));
      try {
        const plaintext = Buffer.concat([decipher.update(frame.subarray(12, tagStart)), decipher.final()]);
        expected = counter + 1n;
        return { ok: true, plaintext };
      } catch {
        return { ok: false, reason: 'auth-failed' };
      }
    },
  };
}

/**
 * UDP 用的重放窗口：允许乱序，但同一计数器只能被接受一次。
 * windowSize 位图记录「最高计数器往下的窗口内已见计数」。
 */
function createReplayWindow(windowSize = 1024) {
  const seen = new Set();
  let highest = -1n;
  const maxSeen = windowSize * 2;
  return {
    /** 接受则返回 true 并记录；重放/过旧返回 false。 */
    accept(counter) {
      const value = BigInt(counter);
      if (value < 0n) return false;
      if (highest >= 0n && value + BigInt(windowSize) <= highest) return false; // 太旧，直接丢
      if (seen.has(value.toString())) return false;
      seen.add(value.toString());
      if (value > highest) highest = value;
      if (seen.size > maxSeen) {
        const floor = highest - BigInt(windowSize);
        for (const key of seen) if (BigInt(key) < floor) seen.delete(key);
      }
      return true;
    },
    get highest() { return highest; },
    get size() { return seen.size; },
  };
}

module.exports = {
  PROTOCOL_TAG,
  KDF_INFO,
  KEY_LENGTH,
  NONCE_LENGTH,
  TAG_LENGTH,
  COUNTER_LENGTH,
  MAX_RECORD_LENGTH,
  PUBLIC_KEY_LENGTH,
  derivePsk,
  generateKeyPair,
  publicKeyRaw,
  importPublicKeyRaw,
  sharedSecret,
  hkdf,
  hmac,
  randomBytes,
  timingSafeEqual,
  deriveSessionKeys,
  authTag,
  createSealer,
  createOpener,
  createReplayWindow,
};
