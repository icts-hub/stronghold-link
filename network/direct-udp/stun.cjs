'use strict';
// ============================================================================
// Stronghold Link — STUN（RFC 5389 / 8489）最小实现
//
// 用途：向 STUN 服务器问「我在公网看来是什么地址」，这是 UDP 打洞的第一步：
//   * 先拿到自己的公网映射（srflx），才能把它告诉对端去互相发包；
//   * 顺带判断 NAT 类型（同一服务器不同端口映射是否变化）留给上层策略。
//
// 只实现需要的部分：Binding Request / Binding Response（含 XOR-MAPPED-ADDRESS）。
// 纯函数，收发由调用方用 dgram 完成，便于单测与复用。
// ============================================================================

const crypto = require('node:crypto');

const MAGIC_COOKIE = 0x2112a442;
const HEADER_LENGTH = 20;

const MESSAGE_TYPES = Object.freeze({
  BINDING_REQUEST: 0x0001,
  BINDING_RESPONSE: 0x0101,
  BINDING_ERROR: 0x0111,
});

const ATTR = Object.freeze({
  MAPPED_ADDRESS: 0x0001,
  XOR_MAPPED_ADDRESS: 0x0020,
  ERROR_CODE: 0x0009,
});

/** 生成 12 字节事务 ID（请求与响应必须一致）。 */
function newTransactionId() {
  return crypto.randomBytes(12);
}

/** 构造 Binding Request（20 字节头，无属性）。 */
function buildBindingRequest({ transactionId = null } = {}) {
  const id = transactionId ? Buffer.from(transactionId) : newTransactionId();
  if (id.length !== 12) throw new Error('STUN 事务 ID 必须是 12 字节');
  const header = Buffer.alloc(HEADER_LENGTH);
  header.writeUInt16BE(MESSAGE_TYPES.BINDING_REQUEST, 0);
  header.writeUInt16BE(0, 2);                 // 长度（无属性）
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  id.copy(header, 8);
  return { buffer: header, transactionId: id };
}

function decodeAddress(buffer, offset, { xor = false, transactionId = null } = {}) {
  const family = buffer.readUInt8(offset + 1);
  const rawPort = buffer.readUInt16BE(offset + 2);
  const port = xor ? rawPort ^ (MAGIC_COOKIE >>> 16) : rawPort;

  if (family === 0x01) {                       // IPv4
    const bytes = Buffer.from(buffer.subarray(offset + 4, offset + 8));
    if (xor) {
      const cookie = Buffer.alloc(4);
      cookie.writeUInt32BE(MAGIC_COOKIE, 0);
      for (let i = 0; i < 4; i += 1) bytes[i] ^= cookie[i];
    }
    return { family: 'IPv4', port, address: [...bytes].join('.') };
  }

  if (family === 0x02) {                       // IPv6
    const bytes = Buffer.from(buffer.subarray(offset + 4, offset + 20));
    if (xor) {
      const mask = Buffer.concat([Buffer.alloc(4).fill(0), (() => {
        const c = Buffer.alloc(4);
        c.writeUInt32BE(MAGIC_COOKIE, 0);
        return c;
      })(), transactionId ? Buffer.from(transactionId) : Buffer.alloc(12)]);
      for (let i = 0; i < 16; i += 1) bytes[i] ^= mask[i];
    }
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16));
    return { family: 'IPv6', port, address: groups.join(':') };
  }

  return null;
}

/**
 * 解析 STUN 消息。
 * @returns {{ ok:boolean, type:number, typeName:string|null, transactionId:string|null,
 *             mapped:object|null, xorMapped:object|null, errorCode:number|null, reason:string|null }}
 */
function parseMessage(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  const empty = {
    ok: false, type: null, typeName: null, transactionId: null,
    mapped: null, xorMapped: null, errorCode: null, reason: '消息过短',
  };
  if (buffer.length < HEADER_LENGTH) return empty;

  const type = buffer.readUInt16BE(0);
  // 最高两位必须为 0（否则不是 STUN）
  if ((type & 0xc000) !== 0) return { ...empty, reason: '不是 STUN 消息（类型高两位非 0）' };
  const length = buffer.readUInt16BE(2);
  const cookie = buffer.readUInt32BE(4);
  if (cookie !== MAGIC_COOKIE) return { ...empty, reason: 'magic cookie 不匹配' };
  if (buffer.length < HEADER_LENGTH + length) return { ...empty, reason: '长度字段与实际字节数不符' };

  const transactionId = buffer.subarray(8, 20);
  const typeName = Object.entries(MESSAGE_TYPES).find(([, v]) => v === type)?.[0] || null;

  let mapped = null;
  let xorMapped = null;
  let errorCode = null;
  let reason = null;

  let offset = HEADER_LENGTH;
  const end = HEADER_LENGTH + length;
  while (offset + 4 <= end) {
    const attrType = buffer.readUInt16BE(offset);
    const attrLength = buffer.readUInt16BE(offset + 2);
    const valueOffset = offset + 4;
    if (valueOffset + attrLength > end) break;

    if (attrType === ATTR.MAPPED_ADDRESS && attrLength >= 8) {
      mapped = decodeAddress(buffer, valueOffset);
    } else if (attrType === ATTR.XOR_MAPPED_ADDRESS && attrLength >= 8) {
      xorMapped = decodeAddress(buffer, valueOffset, { xor: true, transactionId });
    } else if (attrType === ATTR.ERROR_CODE && attrLength >= 4) {
      errorCode = buffer.readUInt8(valueOffset + 2) * 100 + buffer.readUInt8(valueOffset + 3);
      reason = buffer.subarray(valueOffset + 4, valueOffset + attrLength).toString('utf8');
    }

    offset = valueOffset + attrLength + ((4 - (attrLength % 4)) % 4);   // 4 字节对齐
  }

  return {
    ok: true,
    type,
    typeName,
    transactionId: transactionId.toString('hex'),
    mapped,
    xorMapped,
    errorCode,
    reason,
  };
}

/** 事务 ID 是否与预期一致（防止把别的响应当自己的）。 */
function matchesTransaction(parsed, expectedTransactionId) {
  if (!parsed || !parsed.ok) return false;
  const expected = Buffer.isBuffer(expectedTransactionId)
    ? expectedTransactionId.toString('hex')
    : String(expectedTransactionId || '');
  return parsed.transactionId === expected;
}

module.exports = {
  MAGIC_COOKIE,
  HEADER_LENGTH,
  MESSAGE_TYPES,
  ATTR,
  newTransactionId,
  buildBindingRequest,
  parseMessage,
  matchesTransaction,
  decodeAddress,
};
