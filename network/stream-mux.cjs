'use strict';
// ============================================================================
// Stronghold Link — 流多路复用（把多条本机 TCP 连接塞进一条 Steam P2P 连接）
//
// 为什么需要它（现场数据）：Steam 的 P2P 握手在这条链路上要 **11~36 秒**，而且经常
// 直接顶到 30 秒超时。而"每条浏览器 TCP 连接 = 一条独立 Steam 连接"的老设计，让
// 一次页面加载（6~25 条连接）变成 6~25 次握手 —— 预热连接池只能打补丁：
// 现场 12 分钟里 62 次没命中池子、11 次 5003、页面本体 25 秒都没拿到。
//
// 解法：一个远端玩家只握 **1 条**长期干道（SteamConnection），所有本机连接作为
// **流**编号复用这条干道。一局只需要几次握手，而不是几百次。
//
// ── 线上格式 v2（0.14.0）─────────────────────────────────────────────────────
//
//   +--------+--------+------------+--------------+------------------+
//   | len:4  | type:1 | streamId:4 | generation:4 | payload: len-9   |
//   +--------+--------+------------+--------------+------------------+
//   len = type + streamId + generation + payload 的字节数（不含自己这 4 字节）
//   FRAME_HEADER = 13
//
// 为什么带长度前缀：Steam 的消息是可靠有序的字节流，但我们的发送层会按 maxChunk
// （默认 4KB）把一大坨数据切成多条消息。没有长度前缀的话帧会被切碎、无法还原；
// 有了它，帧可以任意跨消息边界，发送层就能继续放心地把小包攒成大消息。
//
// 为什么有 generation：transport 断掉重建之后，旧连接上"在路上"的帧可能迟到。
// 如果它们被当成新连接的数据写进本机 socket，就会污染这条流（规格 §十七）。
// 每个流有一个世代号，只有世代号匹配的帧才被接受。
//
// ── 这个模块**只做**分帧 ──────────────────────────────────────────────────────
// 它不碰 socket、不碰 Steam、不管背压、不认识 Session/Stream 对象。可靠性与有序性
// 由 Steam Networking 负责，**不要在这里重新实现 TCP**（规格 §十）。
// ============================================================================

/** 帧头：4 字节长度 + 1 字节类型 + 4 字节流号 + 4 字节世代号。 */
const FRAME_HEADER = 13;

/** 单帧 payload 上限。超了说明对端/内存出了问题，宁可断开也不分配。 */
const MAX_FRAME_BYTES = 1024 * 1024;

/** 数据帧的建议最大 payload：一条本机 socket 的读块再大也切成这个尺寸发。 */
const MAX_DATA_PAYLOAD = 64 * 1024;

/** 线上的协议版本号（写在开场魔数的第 7 个字节）。 */
const MUX_VERSION = 2;

/**
 * 帧类型。
 *
 * Hello 不走帧格式 —— 它是干道上的**第一条裸消息**，用一段固定魔数表示。这样老版本
 * （不认识多路复用）的对端能立刻被识别出来，我们好退回单连接模式，而不是把魔数当
 * 业务数据喂给游戏服务。
 */
const TYPE = Object.freeze({
  Data: 0x01,
  Open: 0x02,
  Close: 0x03,
  Reset: 0x04,
  Window: 0x05,
  Ping: 0x06,
  Pong: 0x07,
  // 0.14.6：跨世代恢复专用的两个帧（见 createStreamAudit 旁边 resendTailFrames 的注释）。
  // 只在"确认过对端会确认字节"之后才发，老版本收到只会当成不认识的类型忽略，因此不破坏兼容。
  Ack: 0x08,     // 接收方通告：这条流我已经按顺序交给本机 socket 的字节数（绝对偏移）
  Resume: 0x09,  // 发送方通告：接下来的 DATA 从这条流的第 X 个字节开始（补发前必发）
});

/**
 * 发送优先级（规格 §二十七）：数字越小越先发。
 *
 * 用途：一大坨 DATA 不能把 OPEN/CLOSE/RESET 堵在队列后面 —— 否则"关一条流"要等
 * 前面几 MB 传完才生效，浏览器会看到连接卡住。
 */
const PRIORITY = Object.freeze({
  [TYPE.Reset]: 0,
  [TYPE.Close]: 1,
  [TYPE.Open]: 2,
  [TYPE.Window]: 3,
  [TYPE.Resume]: 3,
  [TYPE.Ack]: 3,
  [TYPE.Pong]: 4,
  [TYPE.Ping]: 4,
  [TYPE.Data]: 5,
});

/** 最大优先级数值（DATA）—— 调度器分组用。 */
const PRIORITY_MAX = 5;

/**
 * 流号（规格 §十一：两侧各自分配，奇偶分开，永远不会撞号）。
 *
 *   0                = 整条干道（Ping / Pong 这类 session 级控制帧）
 *   1, 3, 5, 7 …     = **房主**发起
 *   2, 4, 6, 8 …     = **加入者**发起（本机 TCP 一进来就开一条）
 */
const STREAM_ID_SESSION = 0;
const STREAM_ID_HOST_START = 1;
const STREAM_ID_CLIENT_START = 2;

/** Reset 帧 1 字节载荷里的原因码（诊断用）。 */
const RESET_REASON = Object.freeze({
  Protocol: 1,
  StreamLimit: 2,
  Backpressure: 3,
  Shutdown: 4,
  Decode: 5,
  Stale: 6,
});

const RESET_REASON_NAMES = Object.freeze({
  1: '协议违规',
  2: '流数超过上限',
  3: '积压太久',
  4: '这一侧正在关闭',
  5: '帧解析失败',
  6: '收到过期世代的帧',
});

/** 干道开场的裸魔数（不带帧头，必须是这条连接上的第一条消息）。 */
const HELLO_MAGIC = 'SHLMUX';
/** 只比魔数本身（6 字节）—— 版本号单独看，这样别的版本能被识别出来而不是乱解析。 */
const HELLO_MAGIC_BYTES = Buffer.from(HELLO_MAGIC, 'ascii');
/** 魔数 + 版本号，实际发出去的字节。 */
const HELLO_BYTES = Buffer.from(`${HELLO_MAGIC}${String.fromCharCode(MUX_VERSION)}`, 'binary');

const EMPTY = Buffer.alloc(0);

/**
 * 这段字节是不是干道开场魔数（**只看 6 字节魔数，不看版本**）。
 *
 * 只认前缀、不认版本，是为了让"对面是别的版本"这件事能被**识别**出来并安全退回
 * 单连接模式，而不是当成乱码去解析。
 */
function isHello(buf) {
  if (!buf || buf.length < HELLO_MAGIC_BYTES.length) return false;
  return buf.subarray(0, HELLO_MAGIC_BYTES.length).equals(HELLO_MAGIC_BYTES);
}

/**
 * 魔数后面那个版本字节。不是魔数、或者字节不够（半包）时返回 null。
 * @returns {number|null}
 */
function helloVersion(buf) {
  if (!isHello(buf) || buf.length < HELLO_BYTES.length) return null;
  return buf.readUInt8(HELLO_MAGIC_BYTES.length);
}

/** 这段字节是不是**我们这个版本**的开场握手。 */
function isOurHello(buf) {
  return helloVersion(buf) === MUX_VERSION;
}

/** 开场握手包（裸发，不加帧头）。 */
function encodeHello() {
  return Buffer.from(HELLO_BYTES);
}

/**
 * 打包一帧。
 * @param {number} type TYPE 里的值
 * @param {number} streamId 0 表示"整条干道"，普通流出 STREAM_ID_* 分配
 * @param {number} generation 这条流的世代号（session 级帧用 0）
 * @param {Buffer|string} [payload]
 */
function encodeFrame(type, streamId, generation, payload = EMPTY) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const out = Buffer.allocUnsafe(FRAME_HEADER + body.length);
  out.writeUInt32BE(9 + body.length, 0);
  out.writeUInt8(type & 0xff, 4);
  out.writeUInt32BE(streamId >>> 0, 5);
  out.writeUInt32BE(generation >>> 0, 9);
  if (body.length) body.copy(out, FRAME_HEADER);
  return out;
}

const encodeData = (streamId, generation, payload) => encodeFrame(TYPE.Data, streamId, generation, payload);
const encodeOpen = (streamId, generation) => encodeFrame(TYPE.Open, streamId, generation);
const encodeClose = (streamId, generation) => encodeFrame(TYPE.Close, streamId, generation);

/** Reset 带一个原因码，日志里能说清楚"为什么掐的这条流"。 */
function encodeReset(streamId, generation, reason = RESET_REASON.Protocol) {
  return encodeFrame(TYPE.Reset, streamId, generation, Buffer.from([reason & 0xff]));
}

/** 读 Reset 帧的原因码。 */
function decodeResetReason(payload) {
  if (!Buffer.isBuffer(payload) || !payload.length) return 0;
  return payload.readUInt8(0);
}

/**
 * 窗口通告（规格 §十三 的端到端背压）。
 *
 * 语义：**本端还能为这条流再接多少字节**（绝对值，不是增量）。对端据此决定要不要
 * 暂停读它那侧的本机 socket。没有这条帧，B 那侧的游戏服务读得慢时，A 会一直往
 * 隧道里灌数据，最终把内存吃光。
 */
function encodeWindow(streamId, generation, credit) {
  const n = Number.isFinite(Number(credit)) ? Math.max(0, Math.min(Math.floor(Number(credit)), 0xffffffff)) : 0;
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32BE(n, 0);
  return encodeFrame(TYPE.Window, streamId, generation, buf);
}

/** 读窗口通告里的额度。 */
function decodeWindowCredit(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 4) return 0;
  return payload.readUInt32BE(0);
}

/**
 * 0.14.6：Ack —— 接收方通告"这条流我已经按顺序交给本机 socket 的字节数"。
 *
 * 与 Window（额度）是两件事：Window 说的是"我还能接多少"，Ack 说的是"我已经收下并
 * 交付了多少"。跨世代补发只信 Ack —— 有它才能保证补发既不重复也不留空洞。
 */
function encodeAck(streamId, generation, delivered) {
  const n = Number.isFinite(Number(delivered)) ? Math.max(0, Math.min(Math.floor(Number(delivered)), 0xffffffff)) : 0;
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32BE(n, 0);
  return encodeFrame(TYPE.Ack, streamId, generation, buf);
}

/**
 * 0.14.6：Resume —— 发送方通告"接下来的 DATA 从这条流的第 offset 个字节开始"。
 *
 * 有它，接收方就能把重复补发的那截字节切掉（补发点必然 ≤ 它已交付的位置），
 * 也能在补发点比它已交付的位置还大时立刻发现"中间真缺了一段"并如实断开。
 */
function encodeResume(streamId, generation, offset) {
  const n = Number.isFinite(Number(offset)) ? Math.max(0, Math.min(Math.floor(Number(offset)), 0xffffffff)) : 0;
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32BE(n, 0);
  return encodeFrame(TYPE.Resume, streamId, generation, buf);
}

/** 读 Ack / Resume 里的字节偏移。 */
function decodeStreamOffset(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 4) return 0;
  return payload.readUInt32BE(0);
}

/** Ping / Pong 挂在 streamId = 0 上（session 级）。 */
const encodePing = () => encodeFrame(TYPE.Ping, STREAM_ID_SESSION, 0);
const encodePong = () => encodeFrame(TYPE.Pong, STREAM_ID_SESSION, 0);

/** 把一大块数据切成不超过 maxPayload 的数据帧，顺序不变。 */
function encodeDataChunks(streamId, generation, payload, maxPayload = MAX_DATA_PAYLOAD) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const cap = Number.isFinite(Number(maxPayload)) && Number(maxPayload) > 0
    ? Math.min(Math.floor(Number(maxPayload)), MAX_FRAME_BYTES)
    : MAX_DATA_PAYLOAD;
  if (buf.length <= cap) return [encodeData(streamId, generation, buf)];
  const out = [];
  for (let offset = 0; offset < buf.length; offset += cap) {
    out.push(encodeData(streamId, generation, buf.subarray(offset, Math.min(offset + cap, buf.length))));
  }
  return out;
}

/** 帧类型的可读名字（日志用）。 */
function typeName(type) {
  for (const [key, value] of Object.entries(TYPE)) if (value === type) return key;
  return `未知(${type})`;
}

/**
 * 这个缓冲区开头是不是（可能是**没凑齐**的）握手魔数。
 *
 * 只看前缀：'SH' 也要认，因为以 'S'（0x53）开头的合法帧根本不存在 —— 那会被当成
 * 长度 0x53xxxxxx，必然超上限。所以"等更多字节"永远是安全的。
 */
function matchesHelloPrefix(buf) {
  const n = Math.min(buf.length, HELLO_MAGIC_BYTES.length);
  return n > 0 && buf.subarray(0, n).equals(HELLO_MAGIC_BYTES.subarray(0, n));
}

/**
 * 增量解帧器：喂进去任意边界的字节块，吐出完整的帧。
 *
 * 一条干道上一个解帧器。`push` 可能返回 0 帧（字节还不够）、1 帧或多帧。
 * 解出来的帧形状：`{ type, streamId, generation, payload }`。
 */
function createFrameDecoder({ maxFrame = MAX_FRAME_BYTES } = {}) {
  const cap = Number.isFinite(Number(maxFrame)) && Number(maxFrame) > 0 ? Math.floor(Number(maxFrame)) : MAX_FRAME_BYTES;
  let buf = EMPTY;
  return {
    push(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || EMPTY);
      if (bytes.length) buf = buf.length ? Buffer.concat([buf, bytes]) : bytes;
      const frames = [];
      for (;;) {
        if (buf.length < 4) break;
        // 握手魔数是**裸字节**，不是帧。它本来只该出现在一条干道的第一个消息里，
        // 但发队列会把排在后面的东西拼进同一条消息（见 steam-adapter.cjs 的
        // flushPeerOut：peer.out 有多项时 Buffer.concat），所以"迟到的重复魔数"
        // 完全可能被粘在某条数据帧后面。老的解帧器会把它当帧头读 —— 长度读出来是
        // 0x53484C4D = 1397247053，直接 EMUXFRAME，整条干道以 BadFraming 收场。
        //
        // 无歧义识别：任何合法帧的长度都在 [9, cap] 里，而 'SHLM' 当长度读出来是
        // 1397247053，必然超上限。所以"边界处是魔术字前缀"与"合法帧"不可能撞车。
        // 前缀不全就等更多字节（以 'S' 开头的合法帧同样不存在）。
        if (matchesHelloPrefix(buf)) {
          if (buf.length < HELLO_BYTES.length) break;
          buf = buf.subarray(HELLO_BYTES.length);
          continue;
        }
        const len = buf.readUInt32BE(0);
        // len >= 9 是"至少要有 type + streamId + generation"；超上限说明这条干道的
        // 字节流已经错乱，与其分配一大块内存，不如让调用方断开重来。
        if (len < 9 || len > cap) throw Object.assign(new Error(`流多路复用帧长度不合法：${len}`), { code: 'EMUXFRAME', length: len });
        if (buf.length < 4 + len) break;
        frames.push({
          type: buf.readUInt8(4),
          streamId: buf.readUInt32BE(5),
          generation: buf.readUInt32BE(9),
          payload: buf.subarray(FRAME_HEADER, 4 + len),
        });
        buf = buf.subarray(4 + len);
      }
      return frames;
    },
    /** 还压在解帧器里、不够组成一帧的字节数（诊断用）。 */
    get pending() { return buf.length; },
    reset() { buf = EMPTY; },
  };
}

/**
 * 世代校验（规格 §十七）—— 收到一帧时该不该处理。
 *
 * @param {{generation:number}} frame
 * @param {number} streamGeneration 本地记的这条流的世代
 * @returns {'ok'|'stale'|'future'}
 *   ok     = 世代相同，正常处理
 *   stale  = 旧连接迟到的帧，**必须直接丢弃**
 *   future = 比本地新，但又不是 Open —— 协议违规，该 Reset 这条流
 */
function checkGeneration(frame, streamGeneration) {
  const got = Number(frame && frame.generation) >>> 0;
  const want = Number(streamGeneration) >>> 0;
  if (got === want) return 'ok';
  return got < want ? 'stale' : 'future';
}

module.exports = {
  FRAME_HEADER,
  MAX_FRAME_BYTES,
  MAX_DATA_PAYLOAD,
  MUX_VERSION,
  TYPE,
  PRIORITY,
  PRIORITY_MAX,
  STREAM_ID_SESSION,
  STREAM_ID_HOST_START,
  STREAM_ID_CLIENT_START,
  RESET_REASON,
  RESET_REASON_NAMES,
  HELLO_MAGIC,
  HELLO_MAGIC_BYTES,
  HELLO_BYTES,
  isHello,
  helloVersion,
  isOurHello,
  encodeHello,
  encodeFrame,
  encodeData,
  encodeOpen,
  encodeClose,
  encodeReset,
  decodeResetReason,
  encodeWindow,
  decodeWindowCredit,
  encodeAck,
  encodeResume,
  decodeStreamOffset,
  encodePing,
  encodePong,
  encodeDataChunks,
  typeName,
  createFrameDecoder,
  checkGeneration,
};
