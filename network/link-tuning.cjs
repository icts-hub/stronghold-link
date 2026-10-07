'use strict';
// ============================================================================
// Stronghold Link — Steam P2P 链路参数
//
// 为什么单独一个模块：这几个数字决定了好友那边卡不卡，而它们的合理值取决于真实网络，
// 只能靠实测调。集中在一处并且允许环境变量覆盖，就能在用户机器上直接试，不用重新打包。
//
// 写这条注释的原因：这些默认值都是实测选出来的，不是抄来的。
//   maxChunk 4096：一度改成 65536，又改回来了。调大的理由是每条 Steam 消息都有协议头
//     开销（4KB 时 1MB 要 256 条消息）；调小的理由是可靠通道有序，消息越大丢一段之后
//     队头阻塞的代价越大（64KB ≈ 55 个 UDP 段 vs 4KB ≈ 3 个）。游戏卡的是尾延迟，
//     所以先保持 4KB 这个实测过的基线；要试大分片设 SHL_STEAM_MAX_CHUNK 即可。
//     这样"改全局参数"和"改分片"是两件事，一次只动一个变量才说得清是谁起的作用。
//   outFlushBytes 16KB：攒够就立刻发，不等下一个 tick；再大就开始伤延迟。
//   callbackIntervalMs 4：16ms 时小包型游戏明显卡，4ms 是实测出来的。
//   noDelay 默认关：NoDelay 让消息绕过 Steam 自己的发送节奏控制，延迟更低，
//     但拥塞时可能加重丢包。我们的流量是 TCP 隧道，丢包会被重传放大，所以默认不开，
//     留作实测开关。
//
// 环境变量一律是 SHL_STEAM_ 前缀，非法值退回默认并记一条 notes，不静默改行为。
// ============================================================================

const { normalizeChunkSize } = require('./steam-framing.cjs');

const DEFAULTS = Object.freeze({
  maxChunk: 4 * 1024,
  outFlushBytes: 16 * 1024,
  callbackIntervalMs: 4,
  maxMessageBatch: 128,
  noNagle: true,
  noDelay: false,
});

const BOUNDS = Object.freeze({
  outFlushBytes: [1024, 1024 * 1024],
  callbackIntervalMs: [1, 200],
  maxMessageBatch: [1, 4096],
});

const ENV_KEYS = Object.freeze({
  maxChunk: 'SHL_STEAM_MAX_CHUNK',
  outFlushBytes: 'SHL_STEAM_OUT_FLUSH_BYTES',
  callbackIntervalMs: 'SHL_STEAM_CALLBACK_MS',
  maxMessageBatch: 'SHL_STEAM_MAX_BATCH',
  noNagle: 'SHL_STEAM_NO_NAGLE',
  noDelay: 'SHL_STEAM_NO_DELAY',
});

/** 解析布尔开关：1/true/on/yes 为真，0/false/off/no 为假，其余返回 null 表示没写。 */
function parseSwitch(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(text)) return true;
  if (['0', 'false', 'off', 'no'].includes(text)) return false;
  return null;
}

/** 解析整数并在区间内夹取：非法返回 null，越界夹到边界。 */
function parseIntInRange(value, [min, max]) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.floor(n);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

/**
 * 解析最终生效的链路参数。
 *
 * 优先级：显式传入的 overrides > 环境变量 > 默认值。
 * 每一处被改写都记进 notes，界面与日志可以直接显示"这次跑的不是默认配置"。
 *
 * @param {object} [overrides]
 * @param {object} [env]
 * @returns {{maxChunk:number,outFlushBytes:number,callbackIntervalMs:number,maxMessageBatch:number,noNagle:boolean,noDelay:boolean,notes:string[]}}
 */
function resolveLinkTuning(overrides = {}, env = process.env) {
  const notes = [];
  const out = { ...DEFAULTS };
  const source = {};

  for (const key of Object.keys(DEFAULTS)) {
    const explicit = overrides ? overrides[key] : undefined;
    const fromEnv = env ? env[ENV_KEYS[key]] : undefined;
    let value = null;
    let origin = null;

    if (explicit !== undefined && explicit !== null) {
      if (typeof DEFAULTS[key] === 'boolean') {
        value = parseSwitch(explicit);
        if (value === null && typeof explicit === 'boolean') value = explicit;
      } else {
        value = parseIntInRange(explicit, BOUNDS[key] || [0, Number.MAX_SAFE_INTEGER]);
      }
      origin = 'options';
    } else if (fromEnv !== undefined && fromEnv !== null && fromEnv !== '') {
      if (typeof DEFAULTS[key] === 'boolean') value = parseSwitch(fromEnv);
      else value = parseIntInRange(fromEnv, BOUNDS[key] || [0, Number.MAX_SAFE_INTEGER]);
      origin = 'env:' + ENV_KEYS[key];
    }

    if (value === null) {
      if (origin === 'options' || origin) notes.push(`${key} 的取值无法识别，已退回默认 ${DEFAULTS[key]}`);
      continue;
    }
    out[key] = value;
    source[key] = origin;
  }

  // 分片大小走与发送侧同一套夹取规则，避免两处算出不同的值。
  out.maxChunk = normalizeChunkSize(out.maxChunk, DEFAULTS.maxChunk);
  out.notes = notes;
  out.changed = Object.keys(source);
  return out;
}

module.exports = {
  DEFAULTS,
  BOUNDS,
  ENV_KEYS,
  parseSwitch,
  parseIntInRange,
  resolveLinkTuning,
};
