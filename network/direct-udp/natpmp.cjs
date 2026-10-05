'use strict';
// ============================================================================
// Stronghold Link — NAT-PMP（RFC 6886）
//
// 用途：向网关请求一个入站端口映射，让本机的 UDP 端口可以被对端直接找到。
// 这是「Direct UDP」在没有打洞条件时的兜底手段（打洞优先，映射次之）。
//
// 只实现需要的三件事：请求公网地址、请求映射、删除映射。收发由调用方用 dgram 完成。
// 报文体都是定长二进制，所以这里全部是纯函数，便于精确单测。
//
// 注意：NAT-PMP 是 Apple 提出的协议，很多家用路由器并不支持；
// 不支持时应当如实报「网关无响应」，而不是假装映射成功。
// ============================================================================

const PORT = 5351;                    // NAT-PMP 固定端口
const VERSION = 0;

const OPCODES = Object.freeze({
  EXTERNAL_ADDRESS: 0,
  MAP_UDP: 1,
  MAP_TCP: 2,
});

const RESULT_NAMES = Object.freeze({
  0: '成功',
  1: '不支持该版本',
  2: '未获授权（网关拒绝）',
  3: '网络故障',
  4: '资源不足',
  5: '不支持该操作码',
});

function resultName(code) {
  return RESULT_NAMES[code] || '未知结果码 ' + code;
}

/** 请求网关的公网地址（2 字节）。 */
function buildExternalAddressRequest() {
  return Buffer.from([VERSION, OPCODES.EXTERNAL_ADDRESS]);
}

/**
 * 请求端口映射（12 字节）。
 * @param {object} options
 * @param {'udp'|'tcp'} [options.protocol]
 * @param {number} options.internalPort     本机端口
 * @param {number} [options.externalPort]   希望映射到的外部端口（0 = 由网关决定）
 * @param {number} [options.lifetimeSeconds] 生命周期（秒），0 = 删除映射
 */
function buildMapRequest({ protocol = 'udp', internalPort, externalPort = 0, lifetimeSeconds = 3600 } = {}) {
  const port = Number(internalPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('本机端口必须是 1–65535 的整数');
  }
  const ext = Number(externalPort) || 0;
  if (ext !== 0 && (!Number.isInteger(ext) || ext < 1 || ext > 65535)) {
    throw new Error('外部端口必须是 0 或 1–65535 的整数');
  }
  const life = Number(lifetimeSeconds);
  if (!Number.isInteger(life) || life < 0 || life > 0xffffffff) {
    throw new Error('生命周期（秒）必须是非负整数');
  }
  const opcode = String(protocol).toLowerCase() === 'tcp' ? OPCODES.MAP_TCP : OPCODES.MAP_UDP;
  const buffer = Buffer.alloc(12);
  buffer.writeUInt8(VERSION, 0);
  buffer.writeUInt8(opcode, 1);
  buffer.writeUInt16BE(0, 2);            // reserved
  buffer.writeUInt16BE(port, 4);
  buffer.writeUInt16BE(ext, 6);
  buffer.writeUInt32BE(life, 8);
  return buffer;
}

/** 删除映射就是生命周期为 0 的映射请求。 */
function buildDeleteMappingRequest({ protocol = 'udp', internalPort } = {}) {
  return buildMapRequest({ protocol, internalPort, externalPort: 0, lifetimeSeconds: 0 });
}

function readIpv4(buffer, offset) {
  return [buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]].join('.');
}

/**
 * 解析网关响应。
 * @param {Buffer} input
 * @param {object} [options]
 * @param {'external'|'map'} [options.expect] 期望的响应类型（用于校验长度与操作码）
 * @returns {{ ok:boolean, reason:string|null, version:number|null, opcode:number|null,
 *             resultCode:number|null, resultName:string|null, epoch:number|null,
 *             externalAddress:string|null, internalPort:number|null,
 *             externalPort:number|null, lifetime:number|null }}
 */
function parseResponse(input, { expect = null } = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  const base = {
    ok: false, reason: null, version: null, opcode: null,
    resultCode: null, resultName: null, epoch: null,
    externalAddress: null, internalPort: null, externalPort: null, lifetime: null,
  };
  if (buffer.length < 4) return { ...base, reason: '响应过短（至少 4 字节）' };

  const version = buffer.readUInt8(0);
  const opcode = buffer.readUInt8(1);
  const resultCode = buffer.readUInt16BE(2);
  if (version !== VERSION) return { ...base, version, opcode, resultCode, reason: '版本不受支持：' + version };

  const parsed = {
    ...base,
    ok: resultCode === 0,
    version,
    opcode,
    resultCode,
    resultName: resultName(resultCode),
    reason: resultCode === 0 ? null : resultName(resultCode),
  };

  if (expect === 'external') {
    if (buffer.length < 12) return { ...parsed, ok: false, reason: '公网地址响应应为 12 字节，实际 ' + buffer.length };
    parsed.epoch = buffer.readUInt32BE(4);
    parsed.externalAddress = readIpv4(buffer, 8);
    return parsed;
  }

  if (expect === 'map') {
    if (buffer.length < 16) return { ...parsed, ok: false, reason: '映射响应应为 16 字节，实际 ' + buffer.length };
    parsed.epoch = buffer.readUInt32BE(4);
    parsed.internalPort = buffer.readUInt16BE(8);
    parsed.externalPort = buffer.readUInt16BE(10);
    parsed.lifetime = buffer.readUInt32BE(12);
    return parsed;
  }

  // 未声明期望类型时按长度推断，并如实标注推断依据
  if (buffer.length >= 16) {
    parsed.epoch = buffer.readUInt32BE(4);
    parsed.internalPort = buffer.readUInt16BE(8);
    parsed.externalPort = buffer.readUInt16BE(10);
    parsed.lifetime = buffer.readUInt32BE(12);
    parsed.inferred = 'map';
  } else if (buffer.length >= 12) {
    parsed.epoch = buffer.readUInt32BE(4);
    parsed.externalAddress = readIpv4(buffer, 8);
    parsed.inferred = 'external';
  }
  return parsed;
}

module.exports = {
  PORT,
  VERSION,
  OPCODES,
  RESULT_NAMES,
  resultName,
  buildExternalAddressRequest,
  buildMapRequest,
  buildDeleteMappingRequest,
  parseResponse,
};
