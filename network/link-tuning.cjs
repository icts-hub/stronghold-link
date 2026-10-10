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
//   fairQuantum 4KB：出站队列**流间轮转**时每条流每个回合最多取多少字节（延迟专项 Phase 2）。
//     它是纯调度粒度：只决定"一条大响应的流能让另一条小包的流等多久"，不改变任何协议语义，
//     也不改变每条流内部的字节顺序。取 maxChunk 同量级，避免把大块切得太碎。
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
  fairQuantum: 4 * 1024,
  // fairQueue 默认开：出站队列按流分开、流间轮转（Phase 2）。关掉就是 0.14.2 的老行为 ——
  // 所有帧挤在同一条干道队列里，先到先发。留着这个开关有两个用处：一是真机 A/B 对照
  // （同一台机器、同一条链路，只翻这一个布尔值），二是万一公平调度在某个场景上出了
  // 意料之外的问题，用户能一行环境变量退回老行为，不用等新版本。
  fairQueue: true,
  callbackIntervalMs: 4,
  maxMessageBatch: 128,
  noNagle: true,
  noDelay: false,
  // 未定帧干道的救火窗口（加入者侧）。干道建出来后要把魔数送到房主、等房主回同一个
  // 魔数才算谈妥；真实链路上首包是会丢的（连接刚建出来、Steam 还没进 Connected，
  // sendMessage 却已经报成功），不补救就会永久吊死在一条哑干道上 —— 见
  // steam-adapter.cjs 里 retryUndecidedTrunks 的注释。
  // 放弃窗口必须显著大于一次成功握手的上限（实测 6.8 / 9.4 / 17.4 秒），否则会把
  // "慢但在动"的干道误杀成"死的"。
  trunkHelloRetryMs: 4000,
  trunkHelloGiveupMs: 30000,
});

const BOUNDS = Object.freeze({
  outFlushBytes: [1024, 1024 * 1024],
  fairQuantum: [512, 65536],
  callbackIntervalMs: [1, 200],
  maxMessageBatch: [1, 4096],
  trunkHelloRetryMs: [50, 60000],
  trunkHelloGiveupMs: [500, 600000],
});

const ENV_KEYS = Object.freeze({
  maxChunk: 'SHL_STEAM_MAX_CHUNK',
  outFlushBytes: 'SHL_STEAM_OUT_FLUSH_BYTES',
  fairQuantum: 'SHL_STEAM_FAIR_QUANTUM',
  fairQueue: 'SHL_STEAM_FAIR_QUEUE',
  callbackIntervalMs: 'SHL_STEAM_CALLBACK_MS',
  maxMessageBatch: 'SHL_STEAM_MAX_BATCH',
  noNagle: 'SHL_STEAM_NO_NAGLE',
  noDelay: 'SHL_STEAM_NO_DELAY',
  trunkHelloRetryMs: 'SHL_STEAM_TRUNK_HELLO_RETRY_MS',
  trunkHelloGiveupMs: 'SHL_STEAM_TRUNK_HELLO_GIVEUP_MS',
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
 * @returns {{maxChunk:number,outFlushBytes:number,fairQuantum:number,fairQueue:boolean,callbackIntervalMs:number,maxMessageBatch:number,noNagle:boolean,noDelay:boolean,notes:string[]}}
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
