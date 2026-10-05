'use strict';
// ============================================================================
// Stronghold Link — Steam 发送策略（分片 + 发送标志）
//
// 为什么单独成模块：现有 steam-adapter 是成熟内核（11 个测试覆盖），直接改它风险高。
// 把「怎么发」抽出来做成纯函数，先在本机把行为测透，下一步再把它接进内核。
//
// 两个要点：
//   1. 分片：把大块数据切成不超过 maxChunk 的小块，顺序不变。
//      Steam 的消息在 MTU 之上会分片，块越小越不容易出现队头阻塞（代价是开销略高）。
//   2. 发送标志：可靠通道用 Reliable；实时流量用 Unreliable，并关掉 Nagle
//      （NoNagle），避免消息被攒着一起发导致延迟尖峰。
//
// 常量来源：优先从 steamworks-ffi-node 读取（可选依赖，缺失时用文档值兜底）。
// ============================================================================

const FALLBACK_FLAGS = Object.freeze({
  NoNagle: 1,
  NoDelay: 4,
  Reliable: 8,
  Unreliable: 0,   // Steam 语义：不设 Reliable 位即为不可靠，因此该常量为 0
  AutoRestartBrokenSession: 32,
});

const DEFAULT_MAX_CHUNK = 4096;   // 4KB：延迟与开销的折中
const MIN_CHUNK = 256;
const MAX_CHUNK = 512 * 1024;

let cachedFlags = null;

/** 读取发送标志常量：能从绑定拿到就用绑定的，拿不到用文档值。 */
function loadSendFlags() {
  if (cachedFlags) return cachedFlags;
  try {
    // 可选依赖：缺失时不能报错（生产环境可能没装 Steam SDK）
    const mod = require('steamworks-ffi-node/dist/types/networking.js');
    const pick = (name, fallback) => (Number.isFinite(Number(mod[name])) ? Number(mod[name]) : fallback);
    cachedFlags = {
      NoNagle: pick('k_nSteamNetworkingSend_NoNagle', FALLBACK_FLAGS.NoNagle),
      NoDelay: pick('k_nSteamNetworkingSend_NoDelay', FALLBACK_FLAGS.NoDelay),
      Reliable: pick('k_nSteamNetworkingSend_Reliable', FALLBACK_FLAGS.Reliable),
      Unreliable: pick('k_nSteamNetworkingSend_Unreliable', FALLBACK_FLAGS.Unreliable),
      AutoRestartBrokenSession: pick('k_nSteamNetworkingSend_AutoRestartBrokenSession', FALLBACK_FLAGS.AutoRestartBrokenSession),
    };
  } catch (err) {
    cachedFlags = { ...FALLBACK_FLAGS };
  }
  return cachedFlags;
}

/** 该组发送标志是否可靠（Steam 用「是否设了 Reliable 位」表达，Unreliable 常量本身是 0）。 */
function isReliable(flags) {
  return (Number(flags) & loadSendFlags().Reliable) !== 0;
}

/** 归一化分片大小：非法值回落到默认，并夹到合理区间。 */
function normalizeChunkSize(value, fallback = DEFAULT_MAX_CHUNK) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  if (n < MIN_CHUNK) return MIN_CHUNK;
  if (n > MAX_CHUNK) return MAX_CHUNK;
  return Math.floor(n);
}

/**
 * 分片：顺序不变，返回 Buffer 切片数组。
 * @param {Buffer|string} data
 * @param {number} [maxChunk]
 * @returns {Buffer[]}
 */
function chunkBuffer(data, maxChunk = DEFAULT_MAX_CHUNK) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data === undefined || data === null ? '' : String(data));
  const size = normalizeChunkSize(maxChunk);
  if (buf.length === 0) return [buf];
  if (buf.length <= size) return [buf];
  const out = [];
  for (let offset = 0; offset < buf.length; offset += size) {
    // subarray 是视图不复制，发送端不会再改这些字节
    out.push(buf.subarray(offset, Math.min(offset + size, buf.length)));
  }
  return out;
}

/**
 * 发送标志。
 * @param {object} options
 * @param {'reliable'|'unreliable'} [options.channel]
 * @param {boolean} [options.noNagle]  默认 true：实时流量不吃 Nagle 的亏
 * @param {boolean} [options.noDelay]
 * @param {boolean} [options.autoRestart]
 */
function sendFlags({ channel = 'reliable', noNagle = true, noDelay = false, autoRestart = false } = {}) {
  const f = loadSendFlags();
  let flags = channel === 'unreliable' ? f.Unreliable : f.Reliable;
  if (noNagle) flags |= f.NoNagle;
  if (noDelay) flags |= f.NoDelay;
  if (autoRestart) flags |= f.AutoRestartBrokenSession;
  return flags;
}

/**
 * 生成一次发送计划：调用方按 chunks 顺序发出，每条都带同一组 flags。
 * @returns {{ channel:string, flags:number, chunks:Buffer[], chunkSize:number, totalBytes:number, chunkCount:number }}
 */
function createSendPlan(data, { channel = 'reliable', maxChunk = DEFAULT_MAX_CHUNK, noNagle = true, noDelay = false, autoRestart = false } = {}) {
  if (channel !== 'reliable' && channel !== 'unreliable') {
    throw new Error('未知通道：' + channel + '（只能是 reliable 或 unreliable）');
  }
  const size = normalizeChunkSize(maxChunk);
  const chunks = chunkBuffer(data, size);
  return {
    channel,
    flags: sendFlags({ channel, noNagle, noDelay, autoRestart }),
    chunks,
    chunkSize: size,
    totalBytes: chunks.reduce((sum, c) => sum + c.length, 0),
    chunkCount: chunks.length,
  };
}

module.exports = {
  FALLBACK_FLAGS,
  DEFAULT_MAX_CHUNK,
  MIN_CHUNK,
  MAX_CHUNK,
  loadSendFlags,
  isReliable,
  normalizeChunkSize,
  chunkBuffer,
  sendFlags,
  createSendPlan,
};
