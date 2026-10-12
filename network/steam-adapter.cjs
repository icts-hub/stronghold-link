'use strict';
// Stronghold Link — Steam P2P 适配器（阶段 4）。
//
// 做什么：把「本机任意 TCP 服务的端口」与「Steam Networking Sockets 的 P2P 可靠消息流」对接。
//   房主：createListenSocketP2P -> 每个连进来的 Steam 对端各配一条到本地服务端口的 TCP 连接
//   加入者：本机监听一个入口端口（客户端连它）-> 每条本机连接 connectP2P(房主 SteamID) -> 数据互相搬运
//
// 不做什么（不夸大）：
//   * 不做 UDP：Steam 的可靠消息是「消息流」，这里只用于 TCP 流量；UDP 服务仍走本地 UDP 中继。
//   * 不做加密：Steam 通道本身由 Steam 加密并基于 SteamID 认证，这里**不再叠加**我们自己的 PSK 层
//     （重复加密没有安全收益，只会增加延迟与故障点）。想额外验证对端可以用口令，那是阶段 5 的事。
//   * 不做 Lobby/好友邀请：需要 matchmaking API 与真实 AppID，本版本没实现，界面里也不会假装有。
//
// SDK 依赖：steamworks-ffi-node + Steamworks SDK redistributable。缺 SDK 时 init() 会直接终止进程，
// 所以调用方**必须先**用 network/steam-env.cjs 做预检，本模块也会自己再查一遍。

const net = require('node:net');
const path = require('node:path');
const { diagnoseSteam } = require('./steam-env.cjs');
const { createSendPlan, isReliable } = require('./steam-framing.cjs');
const mux = require('./stream-mux.cjs');
const { sampleRoute, summarize } = require('./route-report.cjs');
const { resolveLinkTuning } = require('./link-tuning.cjs');
const { applyNetConfig, formatNetConfigReport } = require('./steam-netconfig.cjs');
// Phase 7（规格 §三十 / §三十一）：网络状态的判定与文案都住在这三个模块里，
// 适配器只负责把现场读数喂进去、把快照挂出去，自己**不判任何状态**。
const relayStatus = require('./relay-status.cjs');
const { createNetworkHealthMonitor } = require('./network-health.cjs');
const { createMuxScheduler } = require('./mux-scheduler.cjs');
const { STATE: CONN_STATE } = require('./steam-connection.cjs');
const { SESSION_STATE } = require('./mux-session.cjs');
// 延迟专项（0.14.3）：每秒一条的活链路样本。**只读**，不参与任何收发决策；
// 没有 logDir 时它只在内存里留最后一帧，不会往磁盘写东西（测试与探针因此不受影响）。
const { createNetLatencyDiag } = require('./net-latency-diag.cjs');
// 延迟专项 Phase 2：出站队列按流分开 + 轮转公平调度（见 egress-queue.cjs 的文件头）。
// 只换"怎么排队/怎么取队"，出队时机（确认进 Steam 缓冲之后）与背压判据一个字都没改。
const egress = require('./egress-queue.cjs');
const { performance: nodePerformance } = require('node:perf_hooks');
/** 单调毫秒。诊断计时用它而不是 Date.now()：后者会被系统时钟校正拉动，量出负数。 */
const hrNow = () => nodePerformance.now();

// 链路参数改由 network/link-tuning.cjs 统一解析，允许环境变量覆盖，方便在用户机器上直接实测。
// 这里的常量只作为"没传 tuning 时"的兜底，取值与 link-tuning 的默认值一致。
// 注意：这个值在 Windows 上**量不出差别** —— 本机 Electron 主进程实测 setInterval(4) 实际 14.3ms、
// setInterval(16) 实际 25.0ms，小于 16ms 的等待全被系统时钟粒度压平。所以它的作用只是声明
// "尽可能勤"，真正决定突发延迟的是下面 DRAIN_BURST 那一小段补轮询。想要真 4ms 只能烧掉一个核（见 startCallbackLoop）。
const CALLBACK_INTERVAL_MS = 4;
// 主轮询收到消息后，最多再补几次 setImmediate 把积压抽干。8 次 ≈ 1.1% 一个核（见 startCallbackLoop）。
const DRAIN_BURST = 8;
const OUT_FLUSH_BYTES = 16 * 1024; // 攒够 16KB 立刻发；否则挂到本回合末尾发
const DEFAULT_MAX_PEERS = 32;
const STEAM_ID_PATTERN = /^7656119\d{10,}$/;
// 每次从 Steam 取回的消息条数上限原先写死在这里，现在随 tuning 传入，默认 128 见 link-tuning.cjs。

/**
 * 统一发送入口（房主与加入者共用）。
 *
 * 与重构前的区别：
 *   * 按 maxChunk 分片（默认 4KB，见 steam-framing.cjs 的 DEFAULT_MAX_CHUNK），
 *     避免大块数据在 Steam 消息层产生队头阻塞 —— 64KB 试过，实测更慢，已回退；
 *   * 用 sendMessage(conn, chunk, flags) 发出，标志默认 Reliable | NoNagle；
 *   * 绑定没有 sendMessage（老版本或测试桩）时退回 sendReliable，行为与从前一致。
 *
 * @returns {{ success:boolean, chunks:number, bytes:number, reliable:boolean }}
 */
function sendChunk(steam, connection, payload, { channel = 'reliable', maxChunk, noNagle, noDelay } = {}) {
  let plan;
  try {
    plan = createSendPlan(payload, { channel, maxChunk, noNagle, noDelay });
  } catch (err) {
    return { success: false, chunks: 0, bytes: 0, reliable: channel === 'reliable', error: err.message };
  }
  const sockets = steam.networkingSockets;
  let ok = true;
  let sentBytes = 0;
  for (const chunk of plan.chunks) {
    let result;
    try {
      result = typeof sockets.sendMessage === 'function'
        ? sockets.sendMessage(connection, chunk, plan.flags)
        : sockets.sendReliable(connection, chunk);
    } catch (err) {
      ok = false;
      break;
    }
    if (result && result.success === false) { ok = false; break; }
    sentBytes += chunk.length;
  }
  return { success: ok, chunks: plan.chunks.length, bytes: sentBytes, reliable: isReliable(plan.flags) };
}

/**
 * 归一化 SteamID。
 *
 * 实测（本机真实 Steam，AppID 480，账号已登录）：
 *   steam.getStatus().steamId              -> "76561198000000000"   ← 正确的经典 SteamID64
 *   steam.networkingSockets.getIdentity()  -> "4699065985603207176"  ← FFI 返回的原始 64 位：
 *                                                                       accountID 在高 32 位，
 *                                                                       低位是 instance/type 位
 * 对照：0x0110000141366f9e（正确） vs 0x41366f9e00000008（getIdentity）
 * 因此对「不符合 17 位经典格式」的数字按位重建：
 *   steamId64 = (universe=1 << 56) | (type=1 << 52) | (instance=1 << 32) | (raw >> 32)
 */
function normalizeSteamId(value) {
  const text = String(value ?? '').trim();
  if (STEAM_ID_PATTERN.test(text)) return text;
  if (/^\d+$/.test(text)) {
    try {
      const accountId = BigInt(text) >> 32n;
      if (accountId > 0n) {
        const rebuilt = (1n << 56n) | (1n << 52n) | (1n << 32n) | accountId;
        const asText = rebuilt.toString();
        if (STEAM_ID_PATTERN.test(asText)) return asText;
      }
    } catch { /* 不是合法数字 */ }
  }
  return null;
}

/** 取本机 SteamID：优先 getStatus()，退化到 getIdentity() 并做字节序重建。 */
function resolveOwnSteamId(steam) {
  try {
    const fromStatus = normalizeSteamId(steam?.getStatus?.()?.steamId);
    if (fromStatus) return fromStatus;
  } catch { /* ignore */ }
  try {
    const fromIdentity = normalizeSteamId(steam?.networkingSockets?.getIdentity?.());
    if (fromIdentity) return fromIdentity;
  } catch { /* ignore */ }
  return null;
}

function makeError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.friendly = message;
  return err;
}

function loadSteamModule(appDir) {
  const resolved = require.resolve('steamworks-ffi-node', { paths: [appDir || process.cwd(), __dirname, ...module.paths] });
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(resolved);
}

/** 初始化 Steam SDK；缺 SDK/模块时抛出带 friendly 的错误（不会调用 init，避免进程被带走）。 */
function initSteamSdk({ appDir, appId, sdkPath, sdk, debug = false, netConfig = null, netConfigEnv = process.env, stats = null } = {}) {
  // 全局参数的下发结果要能在界面上看到，否则"到底设上没有"永远是个猜。
  const record = (report) => { if (stats) stats.netConfig = report; return report; };
  if (sdk) {
    // 注入的测试桩也走一遍全局参数，否则这条通路在单测里永远测不到。
    const injectedReport = record(applyNetConfig(sdk, netConfig || {}, netConfigEnv));
    if (debug) for (const line of formatNetConfigReport(injectedReport)) console.log(line);
    return { steam: sdk, injected: true, netConfig: injectedReport };
  }
  const diagnosis = diagnoseSteam({ appDir, appId });
  if (!diagnosis.available) {
    throw makeError('ESTEAMENV', `Steam 环境未就绪：${diagnosis.blockers.join('；')}。请按 docs/PHASE4-STEAM.md 配置后重试。`);
  }
  const mod = loadSteamModule(appDir);
  const SDK = mod.default || mod.SteamworksSDK;
  const steam = SDK.getInstance();
  if (typeof steam.setDebug === 'function') steam.setDebug(Boolean(debug));
  const resolvedSdkPath = sdkPath || (diagnosis.sdk.redistributable ? path.resolve(diagnosis.sdk.redistributable, '..') : null);
  if (resolvedSdkPath && typeof steam.setSdkPath === 'function') steam.setSdkPath(resolvedSdkPath);
  const ok = steam.init({ appId: Number(appId || diagnosis.appId || 480) });
  if (!ok) throw makeError('ESTEAMINIT', 'Steam 初始化失败：请确认 Steam 客户端已启动并登录，且 AppID 与 SDK 匹配。');
  // 全局网络参数必须在**建连之前**下发：SendRateMin/Max 决定发送侧天花板，
  // SendBufferSize 决定能压多少突发，NagleTime 决定小包等多久。连上之后再设就晚了。
  const netConfigReport = record(applyNetConfig(steam, netConfig || {}, netConfigEnv));
  if (debug) for (const line of formatNetConfigReport(netConfigReport)) console.log(line);
  if (steam.networkingUtils?.initRelayNetworkAccess) steam.networkingUtils.initRelayNetworkAccess();
  if (steam.networkingSockets?.initAuthentication) steam.networkingSockets.initAuthentication();
  return { steam, injected: false, netConfig: netConfigReport };
}

/**
 * 共享的「跑回调 + 收消息」循环。
 *
 * 节奏参考 chunyu-vpn 的 steam/steam_message_handler.cpp:85-93（有活就立刻再排一轮，没活才退让），
 * 但**不能照抄成常驻的 setTimeout/0 或 setImmediate 链** —— 本机 Electron 39.8.10 主进程实测：
 *   · 定时器粒度约 11~16ms：setTimeout(0) 链实际 11.1ms/轮、setTimeout(4) 16.7ms、setInterval(4) 14.3ms、
 *     连名义 16ms 的 setInterval 都落到 25.0ms。Windows 的时钟粒度把一切小于 16ms 的等待压平了，
 *     所以 intervalMs=4 从来没有真的 4ms；
 *   · setImmediate 链确实快（0.023ms/轮 = 43k 轮/秒），但**烧掉 84%~90% 的一个核**，
 *     而且限流救不了 —— 成本在事件循环回合本身（约 20µs/轮），不在轮询次数：
 *     限流到 1ms 只轮询 940 次/秒，CPU 反而升到 89%；基线 setInterval(4) 是 0%。
 *
 * 所以这里是**定时器主驱动 + 有界即时补轮询**：setInterval 每 intervalMs 叫一轮；某一轮真收到了消息，
 * 才额外挂最多 burst 次 setImmediate 把积压连着抽干，且**一旦抽空立刻停**，不自我续命。
 * 成本上限约 burst/14ms ≈ 570 回合/秒 ≈ 1.1% 一个核，且只在有流量时发生；空闲时与 setInterval 基线一样是 0%。
 * 收益是突发到货时不必一批等一个 14ms 定时器。
 */
function startCallbackLoop({ steam, pump, onFatal, label = '', onNotice = null, intervalMs = CALLBACK_INTERVAL_MS, burst = DRAIN_BURST }) {
  let lastNotice = 0;
  let lastPending = -1;
  const ceiling = Number.isFinite(Number(intervalMs)) && Number(intervalMs) >= 1 ? Math.floor(Number(intervalMs)) : CALLBACK_INTERVAL_MS;
  const burstCap = Number.isFinite(Number(burst)) && Number(burst) >= 0 ? Math.floor(Number(burst)) : DRAIN_BURST;
  let stopped = false;
  let timer = null;
  let drain = null;
  let budget = 0;
  // 抽成有返回值是为了让补轮询链知道"这一轮抽空了没有" —— 抽空就停，不把预算烧完。
  const tick = () => {
    if (stopped) return 0;
    let handled = 0;
    try {
      steam.runCallbacks?.();
      const ns = steam.networkingSockets;
      ns?.runCallbacks?.();
      // 实测更正：FFI 的 runCallbacks() 内部已经调用了 pollConnectionStates()
      // （SteamNetworkingSocketsManager.js L894-899），所以这里再显式调一次属于**冗余保险**，
      // 不是"根因修复"。保留它是为了兼容 runCallbacks 不做这件事的旧版 FFI。
      try { ns?.pollConnectionStates?.(); } catch (err) { /* 兼容旧版 FFI */ }
      try { ns?.ensureCallbackRegistered?.(); } catch (err) { /* 兼容旧版 FFI */ }
      // 证据日志：把"收到连接请求 / 连接状态变化"打到日志里，联机时一眼可见
      try {
        const now = Date.now();
        if (now - lastNotice > 2000) {
          lastNotice = now;
          const pending = (typeof ns?.getPendingConnectionRequests === 'function') ? (ns.getPendingConnectionRequests() || []) : [];
          if (pending.length && pending.length !== lastPending) {
            lastPending = pending.length;
            onNotice?.('Steam ' + (label ? label + ' ' : '') + '收到 ' + pending.length + ' 个连接请求');
          } else if (!pending.length) {
            lastPending = 0;
          }
        }
      } catch (err) { /* 证据日志失败不影响主流程 */ }
      handled = Number(pump()) || 0;
    } catch (err) {
      onFatal?.(err);
    }
    return stopped ? 0 : handled;
  };
  // 补轮询链：只有主轮询或上一轮补轮询真的收到了消息才继续，抽空即停。
  // 坑：这里**不能**对 setImmediate 调 unref() —— 自我续命的即时链一旦 unref，
  // 第二轮之后事件循环就不认它是待办，链会静默停住（裸 node 复现：unref 跑 2 轮，
  // 不 unref 跑 29215 轮）。链本身有界且抽空即止，留着重也无妨；stop() 会 clearImmediate。
  const drainTick = () => {
    if (stopped) return;
    budget -= 1;
    const handled = tick();
    if (stopped) return;
    if (handled > 0 && budget > 0) {
      drain = setImmediate(drainTick);
    } else {
      drain = null;
    }
  };
  // 主驱动。已经在补轮询链里时不另起一条链，避免两处叠加把预算翻倍。
  const onInterval = () => {
    if (stopped) return;
    const handled = tick();
    if (stopped) return;
    if (handled > 0 && burstCap > 0 && !drain) {
      budget = burstCap;
      drain = setImmediate(drainTick);
    }
  };
  timer = setInterval(onInterval, ceiling);
  timer.unref?.();
  // 立刻先跑一轮：setInterval 要等满一个周期才第一次响，而第一个连接请求可能就在这期间到。
  onInterval();
  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
    if (drain) clearImmediate(drain);
    timer = null;
    drain = null;
  };
}

/**
 * 发送合并（关键吞吐优化）。
 * 为什么需要：Minecraft 这类游戏会发**大量小包**，逐包调用 sendMessage 时，
 * 每条 Steam 消息的协议开销占绝对主导 —— 实测这类流量只有 ~30KB/s，
 * 而 HTTP 这类大块传输能到 ~1MB/s（协议开销被摊薄）。
 * 做法：把本 tick 内读到的小包先攒在队列里，攒够 outFlushBytes 立即发，
 * 否则由 pump 在每个 tick 末尾合并成一条较大的消息发出。延迟代价 ≤ 一个 tick
 * （名义 4ms，Windows 上真实约 14ms；有流量时主轮询后会补几次 setImmediate，实际更短）。
 *
 * 0.14.3（延迟专项 Phase 2）：队列**按流分开**（`key` = 流号；null = 干道级帧）。
 * 一条流一个 FIFO（流内字节顺序绝对不变），流与流之间由 flushPeerOut 轮转取队 ——
 * 于是"地图区块那几 MB 的响应"不会再挡在"玩家移动那 20 字节"前面。详见 egress-queue.cjs。
 *
 * @param {number|string|null} key 流号；null/'' = 干道队列（HELLO/PING/PONG/旧版透传）
 */
function queueOut(peer, chunk, flushBytes = OUT_FLUSH_BYTES, key = null) {
  // 入队时刻的打点（peer.outAt）在 egress.enqueue 里做：只在"这条队列本来是空的"这一刻记，
  // 算出来的才是"这批积压等了多久"，而不是"最后一帧进来多久了"（后者在小包洪水里永远是 0）。
  return egress.enqueue(peer, chunk, key) >= flushBytes;
}

/**
 * 一帧该进哪条出站队列：**按帧头里的流号**（egress-queue.cjs 的 per-stream FIFO）。
 *
 * 为什么不靠调用点传：pushFrames 有二十多个调用点，漏传一个，那条流的帧就会落到干道队列里
 * —— 顺序仍然是安全的（干道队列整段在前），但公平调度对它失效，而且这种漏传没有任何报错。
 * 帧头是定稿格式（stream-mux.cjs：`| len:4 | type:1 | streamId:4 | generation:4 | payload |`），
 * 解析一次成本是两次 readUInt，永远不会漏。
 *
 * 返回 null 的三种情况都进干道队列（整段排在所有流之前）：
 *   · 开场魔数 —— 裸包，不是帧，字节 4/5 不是 type/streamId；
 *   · 流号 0 的会话帧（PING/PONG）；
 *   · 长度不足 9 字节的异常输入。
 */
function frameOutKey(frame) {
  if (!Buffer.isBuffer(frame) || frame.length < 9) return null;
  if (mux.isHello(frame)) return null;
  const streamId = frame.readUInt32BE(5);
  return streamId === 0 ? null : streamId;
}

/**
 * 送进 queueOut 的最终 key：把"要不要按流分开"这个开关合进来。
 *
 * `SHL_STEAM_FAIR_QUEUE=0` 时一律返回 null ⇒ 所有帧进同一条干道队列、先到先发，
 * 也就是 0.14.2 的老行为。真机 A/B 对照（Phase 3）就靠翻这一个布尔值，
 * 代码不用改、也不用回退版本。
 */
function fairKey(frame, tuning) {
  if (tuning && tuning.fairQueue === false) return null;
  return frameOutKey(frame);
}
/** 积压到这个量就先停止从本地 socket 读，等泵把 Steam 缓冲排空。 */
const PEER_OUT_HIGH_WATER = 1 * 1024 * 1024;
/** 降到这个量以下再恢复读本地 socket（迟滞，避免读一下停一下）。 */
const PEER_OUT_LOW_WATER = 128 * 1024;
/** 还在涨说明对端长期不排空，这条连接已经坏了，只能主动断开。 */
const PEER_OUT_MAX_WATER = 8 * 1024 * 1024;
/** 暂停后这么久还一点都送不出去，就不再等了 —— 一直停着会让对端无限等待。 */
const PEER_PAUSE_ABORT_MS = 30000;
// 0.14.4：读一次 Steam 实时状态的最小间隔（毫秒），限制 getConnectionRealTimeStatus 的调用频率。
const STEAM_STATUS_MIN_INTERVAL_MS = 20;
// 加入者侧：一条 Steam P2P 连接"一个字节都没回来"就断了，多半是这次握手本身没成。
// 与其把浏览器的连接一起掐掉（页面就一直转圈），不如悄悄重连一次并把请求重放出去。
// 现场证据：首页 22 个资源里随机几个请求 0 字节 / ECONNRESET，失败耗时集中在 1.2~2.5 秒
// （正好是一次 P2P 握手的时间），而同一时刻别的请求 200 ms 就回来了 —— 不是带宽，是建连。
const PEER_RECONNECT_MAX = 3;
const PEER_RECONNECT_DELAY_MS = 150;
// 重放用的请求留档上限。HTTP 请求头一般不到 1 KiB，64 KiB 足够覆盖任何本机客户端的第一波数据；
// 一旦对端回了任何字节就作废 —— 半程的响应没法重放，那种情况只能断开让浏览器自己重来。
const PEER_REPLAY_MAX = 64 * 1024;
// 只有"快失败"才值得立刻重试。
//
// 现场教训（0.12.8）：建连失败原本一律重试，而这条线路上一次失败要等满 Steam 的
// TimeoutInitial（出厂 10 秒）。于是"10 秒超时 × 3 次重试 + 退避 ≈ 40 秒"，
// 实测 diag/latency.cjs 的首次请求首字节 **42533 ms** —— 比不重试还糟：
// 浏览器的请求和游戏的加载画面早就在干等里超时了。
//
// 快（< 5 秒）就断说明是对端主动关的（房主拒绝、连接数满、旧连接被替换），
// 换一条新连接立刻就能成，重试很有价值；慢失败说明链路本身在挣扎，
// 这时候再压三次握手只会让情况更坏 —— 让它失败，浏览器自然会重开。
const PEER_RETRY_FAST_MS = 5000;

// 预热连接池（加入者侧）—— 0.13.0 加的，**0.14.0 已删除**。
//
// 它当时治的是"每次新开连接都要重新握手"这个结构病。现场（0.12.8 的 startup.log）：
// 浏览器要开 6 条并发连接才画得出一个首页，而 **Steam 的 P2P 握手在这条线路上是"排队"的** ——
// 五条连接在 19:25:59 同一秒发起，接通时间却依次是 +9.8s / +36s / +35s / +45s / +45s。
// 当时的解法是"平时就把几条连好的 P2P 连接养在池子里，浏览器一开连接直接从池子里拿"。
//
// 为什么现在删掉（规格 §四 / §二十三）：池子是**治标**，而且它自己变成了新的病灶。
// 0.13.3 的现场账本（12 分钟 292 行日志）：
//   · 本机连接进来 53 次命中池子、**62 次临时握手** —— 命中率只有 46%；
//   · 每条握手要 30 秒（Steam TimeoutInitial），而池子里连接的寿命只有 27~40 秒
//     （PEER_POOL_MAX_IDLE_MS 45000 × 随机 0.6~0.9）；
//   · refillPool() 是串行递归、一次只开一条，**增速永远追不上消耗**，池子长期是空的；
//   · 六条连接同时扑上来时日志原样是：`本机连接进来 127.0.0.1:56289 —— 临时握手（池子当时是空的）`（六连发）。
// 也就是说：预热池不但没消灭握手，还额外制造了一整轮 churn
// （累计开 83 / 就绪 67 / 命中 52 / 未命中 57 / 换新 12 / **自死 15** / 均寿 31s）。
//
// 0.14.0 的解法是结构性的：**一个远端玩家只握一次手，握出来的那条干道长期活着**，
// 所有浏览器连接变成这条干道上的流（规格 §三 / §九）。既然干道不随业务连接生灭，
// "为将来的请求提前养几条连接"这件事本身就失去意义 —— 池子该消失，不是调小。
//
// 这一段留在这里当墓碑：**不要把它改回来**，也不要再引入任何形式的
// `PEER_POOL_TARGET` / `PEER_POOL_MAX_IDLE_MS` 参数（规格 §二十三 明确点名）。

// 本机连接关掉之后，压在 peer.out 里的字节还得有机会出门。
//
// 游戏服务（Node http、以及任何按 HTTP/1.0 或 Connection: close 应答的服务）常常
// "回完响应立刻关掉本地连接"。而小于 outFlushBytes（16 KiB）的响应走的是
// flushPeerOutSoon —— 它挂在 setImmediate 上，比 socket 的 'close' 事件还晚。
// 原来 'close' 里是无条件立刻 closeConnection，于是那点尾巴字节再没机会发出去，
// 对端只看到"连接被关掉、什么都没收到"。
//
// 这个不是理论问题：本机 A/B 上用 HTTP/1.0 发同一个请求 100% 收不到响应，
// 改成 HTTP/1.1（keep-alive，服务端不回完就关）同一个请求 3/3 在 10 ms 内正常返回。
// 现场表现就是"页面/地图加载不出来，刷新一下才好"——因为刷新会重开一条连接，
// 而重开的那条只要服务端晚一点关就能成。
//
// 抽干的等待有上限：抽不干说明 Steam 侧本身堵着，不能把连接永远挂着。
const PEER_DRAIN_TRIES = 20;
const PEER_DRAIN_INTERVAL_MS = 10;

// ── 流多路复用（0.14.0）──────────────────────────────────────────────────────
//
// 0.13.x 的预热连接池是给"每条本机连接 = 一条独立 Steam 连接"打的补丁，而现场数据
// 说明补丁补不上：12 分钟里 **62 次没命中池子、11 次撞 30 秒建连超时**，页面本体
// 25 秒都没拿到 —— 因为一次页面加载要开 6~25 条连接，而这里握手要 11~36 秒。
//
// 0.14.0 换结构：只维持少数几条"干道"（trunk）P2P 连接，所有本机连接作为**流**编号
// 复用同一条干道。一局只需要几次握手，而不是几百次；干道空闲时不占带宽，也不需要
// 像以前的池子那样按寿命反复换新（换新本身就是额外的握手，现场统计里"自死 15"就是它）。
//
// 干道条数：**1 条**（规格 §三）。原来这里写的是"维持少数几条"，等于把池子换个名字 ——
// 一个远端玩家本来就只需要 1 条长期 Primary，再加 0~1 条备用；干道空闲时不占带宽，
// 也不需要像以前的池子那样按寿命反复换新（换新本身就是额外的握手）。真正需要扩容时
// 的判据是"这条干道满了"（PEER_STREAM_MAX_PER_TRUNK），而不是"先开三条放着"。
const PEER_TRUNK_TARGET = 1;
/** 一条干道最多承载几条流。到顶了就去开新干道，避免单条 Steam 连接被压垮。 */
const PEER_STREAM_MAX_PER_TRUNK = 64;
/**
 * 开场握手：**加入者先开口，房主应答**。
 *
 * 为什么方向不能反（这是拿旧加入者实测出来的）：0.13.3 的加入者不认识魔数，房主若主动
 * 先发，它会把那 7 个字节当成房主回的游戏数据原样写进浏览器 —— HTTP 响应变成
 * `SHLMUX\x01HTTP/1.1 200 OK`，浏览器直接解析失败。而用户的升级顺序是"房主先升、
 * 朋友后升"，所以「新房主 + 旧加入者」必然出现，绝不能让它被打断。
 *
 * 反过来就没事：加入者先发的就是浏览器的真实字节，新房子一看不是魔数就走老路径，
 * 全程一个字节都不多发 → 旧加入者完全兼容。
 *
 * PEER_HELLO_TIMEOUT_MS 现在只是**诊断用**的期望值（房主应答通常在一两个 RTT 内回到），
 * 不再作为"判定对面是不是新版"的手段 —— 新版房主是被动应答的，永远等不到主动魔数，
 * 拿超时去判只会把新+新组合错误地打回老路径，把多路复用整个废掉。
 */
const PEER_HELLO_TIMEOUT_MS = 1500;
/** 干道还没连上时，先替本机客户端攒着的字节上限。 */
const PEER_QUEUE_MAX_BYTES = 1024 * 1024;

/**
 * 干道断了以后，一条流最多等多久重新挂上（规格 §十六 的 stream recovery）。
 *
 * 为什么值得等：干道断掉的原因里，"真的没网了"反而是少数，多数是 Steam 中继换路、
 * CM 抖一下、对端进程重启。远小于让浏览器把整张地图重新拉一遍。所以传输层打嗝
 * 不该等价于"所有请求一起失败"。
 *
 * ★ 为什么是 60 秒而不是 8 秒：原来这里写的是 8000，配套注释的假设是"重连一条干道
 * 只要几十毫秒到一两秒"。**这个假设是错的**：同一条链路上一次成功握手本身就要
 * 6.8 / 9.4 / 17.4 秒（见 network/steam-netconfig.cjs 里 timeoutInitial 的实测记录，
 * 正因为如此它才从 Steam 出厂的 10 秒调到 30 秒）。8 秒连一次正常握手的上限都盖不住。
 * 现场日志里就有一条：`流结束（TunnelClosed）流号=14 … 干道断了以后 8000ms 内没能
 * 重新挂上 存活=1749s 上行=3229KiB` —— 一条活了 29 分钟、已经推了 3.2 MB 的连接，
 * 就因为干道打了个嗝而在 8 秒后被收掉；浏览器那边看到的就是"一直转圈"。
 * 现在这个期限必须盖住最坏情况："当前这条干道被放弃（PEER_HELLO_GIVEUP_MS）
 * + 重开一条并谈妥（再一次握手）"，所以取 60 秒。
 *
 * 为什么必须有上限：没有上限的话，一条死掉的流会永久占着一个已经连到游戏服务的
 * 本机连接，游戏侧看着"有人在连却什么都不发"，最后两边一起挂着。宁可明确收掉、
 * 让客户端重来一次 —— 那也是它本来就会做的事。
 */
const STREAM_MIGRATE_GRACE_MS = 60000;

/**
 * 未定帧干道的两个时间窗（加入者侧）。
 *
 * 干道建出来之后，加入者立刻把魔数排进队列，等房主回同一个魔数才算"谈妥"。
 * 真实链路上这一步有可能**把首包丢掉**：连接刚由 connectP2P 建出来、Steam 还没把它
 * 推进 Connected，sendMessage 却已经报了成功，于是那一帧再也没有第二次。
 * 以前这里没有任何补救，而 hasLiveTrunk() 又把"还没定帧的干道"也算成活的干道，于是
 * refillTrunks() 永远不会再补一条 —— 整局就吊死在那条哑干道上：
 *   · 它不再有任何回调会来管它，可 Steam 连接本身是活着的，两边都以为在等对方；
 *   · pickTrunk() 要求 framed === true，所以新来的本机连接一条都挂不上去，
 *     全被塞进 pendingSockets 一直等；
 *   · 浏览器那边就是"TCP 连上了，然后一直转圈，什么都不回来"。
 * 现场日志正是这个形状：14:47:31 房主记下 `有对端连进来` 之后，该干道的隧道存量
 * 每一行都是 `上行0KiB 下行0KiB`，一直持续到日志末尾（292 秒）—— 一个字节都没动过。
 *
 * PEER_HELLO_RETRY_MS  未定帧干道在这个间隔后重发一次魔数（首包丢了就靠它救回来）。
 * PEER_HELLO_GIVEUP_MS 到这个年纪还没谈妥就放弃这条、换一条重来。必须显著大于真实
 *                      链路一次成功握手的上限（实测 17.4 秒），否则会把"慢但在动"
 *                      的干道误杀成"死的"，反而制造出它想避免的问题。
 */
const PEER_HELLO_RETRY_MS = 4000;
const PEER_HELLO_GIVEUP_MS = 30000;

/**
 * 寄存流（orphan）的清扫周期。
 *
 * **不另起计时器**（规格 §十八）：房主的泵本来就是 4ms 一轮，在这里顺手看一眼即可，
 * 只用一个时间戳把它压到 500ms 一次 —— 4ms 扫一遍孤儿是纯浪费。
 */
const ORPHAN_SWEEP_MS = 500;

/**
 * 流"寄存在半路"（干道断了、socket 还活着、暂时没有归属干道）时，最多替它攒多少字节。
 *
 * 这段字节是**游戏服务在干道断开期间继续吐出来的响应**。丢掉它们就等于把一个
 * 已经发了一半的 HTTP 响应砍断 —— 浏览器只会看到内容不完整。攒到上限还连不回来，
 * 说明这条干道不是"打嗝"而是真没了，那时候断掉反而是对的。
 */
const STREAM_PARK_MAX_BYTES = 512 * 1024;

/**
 * 从**干道队列**头部丢掉已经确认进了 Steam 发送缓冲的 n 个字节。
 *
 * 为什么不能整块重发：sendChunk 会按 maxChunk 把一块切成多条 Steam 消息，
 * 中途某一片失败时**前面的片已经进了可靠队列**。整块重发会把它们发第二遍，
 * 对端收到的字节流就多了一段 —— 那比丢数据更糟，TCP 层再也对不齐。
 * 所以只丢确认发出的前缀，剩下的留在队列里等下一次重试。
 *
 * 0.14.3：多路复用路径改用"计划 + 按计划出队"（egress.planOut / egress.commit），
 * 因为一次 flush 的确认前缀可能**横跨干道与多条流**（轮转调度切出来的），
 * 光丢干道队列就与 Steam 报的确认字节数对不上了。
 * 这个函数只剩旧版透传路径与单元测试在用，保留原名以免打断既有调用。
 */
function dropFromOut(peer, n) {
  return egress.dropTrunk(peer, n);
}

/**
 * 0.14.4：读取一条 Steam 连接的实时状态（getConnectionRealTimeStatus）。
 * 绑定缺失、连接为空、调用抛错时一律返回 null。
 */
function readSteamRealtimeStatus(steam, connection) {
  const sockets = steam && steam.networkingSockets;
  if (!sockets || typeof sockets.getConnectionRealTimeStatus !== 'function') return null;
  if (connection == null) return null;
  try {
    const status = sockets.getConnectionRealTimeStatus(connection);
    return status && typeof status === 'object' ? status : null;
  } catch {
    return null;
  }
}

/** pendingReliable：已经进了 Steam 队列、还没送到对端的可靠字节数。取不到返回 null。 */
function steamBacklogBytes(status) {
  if (!status || typeof status !== 'object') return null;
  const value = Number(status.pendingReliable);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

/**
 * 按 STEAM_STATUS_MIN_INTERVAL_MS 节流采样一条连接的 Steam 待发可靠字节数。
 * 积压比上次采样变小时刷新 peer.lastProgressAt；记录 peer.steamBacklog 与 steamBacklogPeak。
 * 关掉 steamBackpressure 或连接为空时清空读数并返回 null。
 */
function sampleSteamBacklog(steam, peer, tuning, now = Date.now()) {
  if (!peer) return null;
  if (!tuning || tuning.steamBackpressure === false || peer.connection == null) {
    peer.steamBacklog = null;
    return null;
  }
  if (peer.steamStatusAt && now - peer.steamStatusAt < STEAM_STATUS_MIN_INTERVAL_MS) {
    return Number.isFinite(peer.steamBacklog) ? peer.steamBacklog : null;
  }
  peer.steamStatusAt = now;
  const status = readSteamRealtimeStatus(steam, peer.connection);
  const backlog = steamBacklogBytes(status);
  if (backlog == null) {
    peer.steamBacklog = null;
    return null;
  }
  const prev = Number.isFinite(peer.steamBacklog) ? peer.steamBacklog : null;
  if (prev != null && backlog < prev) peer.lastProgressAt = Date.now();
  peer.steamBacklog = backlog;
  peer.steamBacklogPeak = Math.max(peer.steamBacklogPeak || 0, backlog);
  return backlog;
}

/**
 * 一条 Steam 连接上游的全部本机数据源 socket：peer.socket（老路径）与各条流的
 * stream.socket（多路复用路径，此时 peer.socket 为 null）。
 */
function collectSourceSockets(peer) {
  const list = [];
  if (!peer) return list;
  if (peer.socket && !peer.socket.destroyed) list.push(peer.socket);
  const streams = peer.streams;
  if (streams && typeof streams.values === 'function') {
    for (const stream of streams.values()) {
      const socket = stream && stream.socket;
      if (socket && !socket.destroyed && !list.includes(socket)) list.push(socket);
    }
  }
  return list;
}

function pauseSourceSockets(peer) {
  for (const socket of collectSourceSockets(peer)) {
    try { if (typeof socket.pause === 'function') socket.pause(); } catch { /* 暂停失败就继续按老路走 */ }
  }
}

function resumeSourceSockets(peer) {
  for (const socket of collectSourceSockets(peer)) {
    try { if (typeof socket.resume === 'function') socket.resume(); } catch { /* 恢复失败会在 socket 的 close 里收尾 */ }
  }
}

/**
 * 每个泵 tick 对一条连接做一次 0.14.4 背压判定：采样 Steam 待发量，
 * 达到 tuning.backlogHigh 就对这条连接调 applyBackpressure。返回本次采到的字节数。
 */
function pumpPeerBackpressure(steam, peer, tuning, now = Date.now()) {
  if (!peer || peer.connection == null) return null;
  const backlog = sampleSteamBacklog(steam, peer, tuning, now);
  if (backlog == null || !tuning || tuning.steamBackpressure === false) return backlog;
  if (backlog >= tuning.backlogHigh) applyBackpressure(peer, tuning);
  return backlog;
}

/**
 * 发送失败 = Steam 的发送缓冲满了（k_EResultLimitExceeded）。此时**必须停下来等**：
 * 继续从本地 socket 读，读进来也只能丢掉，而丢掉就是在可靠流上戳一个洞。
 * 做法是暂停本地 socket，等泵把积压发出去之后再恢复（见 pump 里的 resume）。
 */
function applyBackpressure(peer, tuning = null) {
  if (!peer || peer.stalled) return;
  const backlog = peerOutBytes(peer);
  if (backlog >= PEER_OUT_MAX_WATER) {
    // 积压到硬上限还是发不出去：这条 Steam 连接已经不健康了。
    // 主动断开，让浏览器/游戏看到一次干净的复位并自己重连 —— 比让它永远挂着强。
    peer.stalled = true;
    peer.dropWhy = `本机积压 ${Math.round(backlog / 1024)} KiB 超过硬上限，Steam 一直不接收`;
    for (const socket of collectSourceSockets(peer)) {
      try { socket.destroy(); } catch { /* 断开失败不影响其它连接 */ }
    }
    return;
  }
  // 0.14.4：除本机队列水位外，再加一路 Steam 待发量水位；peer.backlogPaused 记录是哪一路触发的。
  const steamHigh = tuning && tuning.steamBackpressure !== false
    && Number.isFinite(peer.steamBacklog)
    && peer.steamBacklog >= tuning.backlogHigh;
  if (steamHigh) peer.backlogPaused = true;
  if ((backlog >= PEER_OUT_HIGH_WATER || steamHigh) && !peer.paused) {
    peer.paused = true;
    peer.pausedAt = Date.now();
    pauseSourceSockets(peer);
  }
}

/**
 * 背压恢复：暂停中的连接一旦能把积压送出去（或已经明显排空）就恢复读本地 socket。
 * 停了 PEER_PAUSE_ABORT_MS 还一点都送不出去，说明这条 Steam 连接已经不通了 ——
 * 一直停着会让浏览器/游戏无限等待，不如断开让它重连一次。
 *
 * **判断"还送得出去"必须看 lastProgressAt，不能看 lastSendAt。**
 * lastSendAt 只在 flushPeerOut 整块发完时更新，而 Steam 发送缓冲一满，
 * sendChunk 就只确认得了前缀、返回 success:false —— 于是一条"慢但在动"的连接
 * 会被当成死的：积压一时降不到低水位就永远等不到恢复，30 秒后准时 destroy。
 * 现场表现就是"几 MB 的大文件每传 ~28KB 必断、小文件全好"。
 * lastProgressAt 记录的是**任何**一个字节被确认进 Steam 队列的时刻，慢也算在动。
 */
function resumeOrAbort(peer, written, tuning = null) {
  if (!peer || !peer.paused) return;
  // 两路水位都降下来才恢复：本机队列能送出去（或已排空）且 Steam 待发量降到 backlogLow。
  const steamGate = !!(tuning && tuning.steamBackpressure !== false) && Number.isFinite(peer.steamBacklog);
  const steamLow = !steamGate || peer.steamBacklog <= tuning.backlogLow;
  if ((written > 0 || peerOutBytes(peer) <= PEER_OUT_LOW_WATER) && steamLow) {
    peer.paused = false;
    peer.pausedAt = 0;
    peer.backlogPaused = false;
    resumeSourceSockets(peer);
    return;
  }
  const idleSince = Math.max(peer.pausedAt || 0, peer.lastProgressAt || 0, peer.lastSendAt || 0);
  if (idleSince && Date.now() - idleSince > PEER_PAUSE_ABORT_MS) {
    peer.stalled = true;
    peer.dropWhy = `暂停后 ${Math.round((Date.now() - idleSince) / 1000)} 秒一个字节都没送出去`;
    for (const socket of collectSourceSockets(peer)) {
      try { socket.destroy(); } catch { /* 断开失败会在 socket 的 close 里收尾 */ }
    }
  }
}

function flushPeerOut(steam, peer, sendChunk, tuning = null) {
  if (!peer || peer.connection == null) return 0;
  // 取队：干道队列整段在前，然后各条流轮转、每回合每条流最多 fairQuantum 字节。
  // 一条流内部仍然是严格 FIFO（它就是一条 TCP），所以协议顺序不可能被轮转打乱；
  // 变的是"谁先出门"—— 几 MB 的地图区块响应不再挡住玩家移动那 20 字节。
  const planInfo = egress.planOut(peer, tuning ? tuning.fairQuantum : undefined);
  if (!planInfo.bytes) return 0;
  const payload = planInfo.plan.length === 1
    ? planInfo.plan[0].buf
    : Buffer.concat(planInfo.plan.map((seg) => seg.buf));
  const result = sendChunk(steam, peer.connection, payload, {
    channel: 'reliable',
    maxChunk: tuning ? tuning.maxChunk : undefined,
    noNagle: tuning ? tuning.noNagle : undefined,
    noDelay: tuning ? tuning.noDelay : undefined,
  });
  // **先确认再出队。**
  // 老代码在这里无条件 peer.out = []，然后才看 result —— 发送失败时那一整块数据
  // 已经不在队列里了，调用方只把它计进 stats.dropped 就完事。这等于在可靠流上
  // 戳一个洞：对端（浏览器/游戏）永远等不到那几个字节，几秒后连接被掐断。
  // 实测表现就是"几 MB 的大文件传到一半必断、小文件全好、按 Range 切片又全好"。
  const confirmed = result && Number.isFinite(result.bytes)
    ? Math.max(0, Math.min(result.bytes, payload.length))
    : 0;
  if (confirmed > 0) {
    if (peer.replay) {
      // 加入者侧的请求留档：只记真的进了 Steam 队列的那段前缀。
      // 对端一旦回过字节就作废（见 pump），因为半程的响应重放没有意义。
      peer.replay.push(Buffer.from(payload.subarray(0, confirmed)));
      peer.replayBytes = (peer.replayBytes || 0) + confirmed;
      while (peer.replayBytes > PEER_REPLAY_MAX && peer.replay.length > 1) {
        const expired = peer.replay.shift();
        peer.replayBytes -= expired.length;
      }
    }
    egress.commit(peer, planInfo, confirmed);
    // **只确认了前缀也算"在动"。**
    // 背压期间 Steam 缓冲是满的，几乎每次 flush 都只能确认头一片（见上），
    // 所以 lastSendAt（整块发完才更新）在慢速传输里几乎是冻结的。
    // resumeOrAbort 的 30 秒看门狗必须看这个"任何一个字节出去过"的时刻，
    // 否则一条还在慢慢吐数据的连接会被误判成死连接掐掉。
    peer.lastProgressAt = Date.now();
  }
  if (!result || !result.success) {
    applyBackpressure(peer, tuning);
    return -1;
  }
  egress.clear(peer);
  peer.lastSendAt = Date.now();
  return payload.length;
}

/**
 * 让攒下的数据在**当前事件循环回合结束时**就发出去，而不是干等下一个泵 tick。
 *
 * 为什么要加这一层：泵是 4ms 一次的 setInterval，而主进程还要跑 IPC、Provider 轮询、
 * 内存看护等一堆事。定时器一旦被别的活挤后，小包就要多等十几到几十毫秒 —— 玩起来就是"卡"。
 * setImmediate 挂在当前回合末尾，同一回合里所有 socket data 事件已经全部落进 peer.out，
 * 所以合并效果不变，但不再依赖定时器准不准。
 *
 * 阈值没到且回合结束时仍没有数据时会有一次空转，代价可以忽略。
 *
 * 发送失败时不用在这里补救：数据仍留在 peer.out 里，泵的下一个 tick 会自动重试，
 * 背压也已经由 flushPeerOut 里的 applyBackpressure 施加。
 */
function flushPeerOutSoon(steam, peer, sendChunk, tuning = null) {
  if (!peer || peer.flushPending) return;
  peer.flushPending = true;
  setImmediate(() => {
    peer.flushPending = false;
    if (peer.connection == null || !peerOutBytes(peer)) return;
    flushPeerOut(steam, peer, sendChunk, tuning);
  });
}
function peerOutBytes(peer) {
  return egress.total(peer);
}

/**
 * 把 peer.out 里剩下的字节抽干之后，再执行 onDone（通常是关掉 Steam 连接）。
 *
 * 为什么必须这么做：本机连接一关，压在小包合并路径（flushPeerOutSoon，setImmediate）
 * 里的那点字节就成了孤儿 —— 没人再泵它，而立刻 closeConnection 会让它永远发不出去。
 * 对端看到的是"连接被关"，不是"收到一个短响应"。回环上 100% 复现，真实游戏服务同样
 * 是"回完就关"的写法，所以这条路径就是现场"地图加载不出来、刷新才好"的来源。
 *
 * 抽不干（Steam 侧堵着）时给足够次数的重试，超过就把剩余字节计成丢弃并照常收尾，
 * 绝不把连接无限挂着。
 */
function drainThenClose({ peer, steam, sendChunk, tuning, stats, onDone, tries = PEER_DRAIN_TRIES, intervalMs = PEER_DRAIN_INTERVAL_MS }) {
  if (!peer || peer.connection == null || !peerOutBytes(peer)) { onDone(); return; }
  let left = tries;
  const step = () => {
    const written = flushPeerOut(steam, peer, sendChunk, tuning);
    if (written >= 0 && !peerOutBytes(peer)) { onDone(); return; }
    if (--left <= 0) {
      if (stats) stats.dropped += peerOutBytes(peer);
      onDone();
      return;
    }
    const t = setTimeout(step, intervalMs);
    if (typeof t.unref === 'function') t.unref();
  };
  step();
}

function createStats(role) {
  return {
    role,
    protocol: 'STEAM',
    peers: 0,
    connections: 0,
    totalPeers: 0,
    packetsToPeer: 0,
    packetsFromPeer: 0,
    bytesToPeer: 0,
    bytesFromPeer: 0,
    rejected: 0,
    dropped: 0,
    sendStalls: 0,
    failed: 0,
    // 加入者侧："一个字节都没回来就断了"的连接被悄悄重连了几次。
    // 这个数字只涨不跌，用来判断现场到底是"偶发握手失败"还是"一直在失败"。
    reconnects: 0,
    // 加入者侧预热连接池（0.13.0）的计数器 —— **0.14.0 随池子一起删除**。
    // 那些字段（poolCreated / poolReady / poolHits / poolMisses / poolRetired / poolLost / poolLifeMs）
    // 现在恒为 0 且没有任何代码写它们；留着只会让人以为池子还在跑。看多路复用的健康看
    // `stats.muxPeers` / `stats.legacyPeers` / `stats.totalStreams` 与 `provider.netState()`。
    encrypted: true, // Steam 通道自带加密与身份认证
    sessionId: null,
    startedAt: null,
  };
}

/**
 * 线路报告器：把活连接交给 route-report 判定，并附上原始 socket 字节计数。
 *
 * 存在的意义是回答"到底慢在哪一层"：
 *   rawSocket.rawRxBytesPerSec 是游戏进程真正收进本地 socket 的字节速率
 *   steam.inBytesPerSec        是 Steam 传输层真正收到网络的字节速率
 * 两者接近说明瓶颈在对端或线路；raw 明显低于 steam 说明卡在本地这一侧。
 */
function createRouteReporter(steam, stats) {
  let last = null;

  function rawRates(at) {
    const current = {
      at,
      to: Number(stats.bytesToPeer) || 0,
      from: Number(stats.bytesFromPeer) || 0,
    };
    let rawTxBytesPerSec = null;
    let rawRxBytesPerSec = null;
    if (last && at > last.at) {
      const seconds = (at - last.at) / 1000;
      rawTxBytesPerSec = Math.max(0, Math.round((current.to - last.to) / seconds));
      rawRxBytesPerSec = Math.max(0, Math.round((current.from - last.from) / seconds));
    }
    last = current;
    return { rawTxBytesPerSec, rawRxBytesPerSec };
  }

  return function report(connections, at = Date.now()) {
    const list = (connections || []).filter((c) => c != null);
    const reports = list.map((connection) => {
      try {
        return sampleRoute(steam, connection, { now: () => at });
      } catch (err) {
        return null;
      }
    }).filter(Boolean);
    const summary = summarize(reports);
    const raw = rawRates(at);
    return {
      ok: true,
      protocol: 'STEAM',
      role: stats.role,
      at,
      connections: summary.count,
      route: summary.route,
      routeLabel: summary.routeLabel,
      relayed: summary.relayed,
      relayPop: summary.relayPop,
      remotePop: summary.remotePop,
      remoteAddress: summary.remoteAddress,
      ping: summary.ping,
      steamInBytesPerSec: summary.steamInBytesPerSec,
      steamOutBytesPerSec: summary.steamOutBytesPerSec,
      // 判断"Steam 是不是在限速"的证据：上限顶住不动 + 积压持续增长 = 被限速。
      // 积压长期为 0 而 ping 高则是延迟问题，调带宽没用。
      sendRateBytesPerSecond: summary.sendRateBytesPerSecond,
      pendingReliable: summary.pendingReliable,
      sentUnackedReliable: summary.sentUnackedReliable,
      usecQueueTime: summary.usecQueueTime,
      qualityLocal: summary.qualityLocal,
      steamInPacketsPerSec: summary.steamInPacketsPerSec,
      steamOutPacketsPerSec: summary.steamOutPacketsPerSec,
      tuning: stats.tuning ? { ...stats.tuning } : null,
      // 全局网络参数不是"每条连接"的属性，但界面只在会话页有位置显示它，
      // 所以跟路线读数一起送出去。缺报告就是 null，不编造默认值。
      netConfig: stats.netConfig ? {
        available: Boolean(stats.netConfig.available),
        transport: stats.netConfig.transport || null,
        reason: stats.netConfig.reason || null,
        applied: Array.isArray(stats.netConfig.applied) ? [...stats.netConfig.applied] : [],
        changed: Array.isArray(stats.netConfig.changed) ? [...stats.netConfig.changed] : [],
        notes: Array.isArray(stats.netConfig.notes) ? [...stats.netConfig.notes] : [],
      } : null,
      rawSocket: {
        bytesToPeer: Number(stats.bytesToPeer) || 0,
        bytesFromPeer: Number(stats.bytesFromPeer) || 0,
        packetsToPeer: Number(stats.packetsToPeer) || 0,
        packetsFromPeer: Number(stats.packetsFromPeer) || 0,
        rawTxBytesPerSec: raw.rawTxBytesPerSec,
        rawRxBytesPerSec: raw.rawRxBytesPerSec,
      },
      peers: reports,
    };
  };
}

function invalidHandles(steamModule) {
  // 常量在包的 types 里导出；拿不到就退化为 0（视为无效句柄判定不可用）
  return {
    connection: steamModule?.k_HSteamNetConnection_Invalid ?? 0,
    listenSocket: steamModule?.k_HSteamListenSocket_Invalid ?? 0,
  };
}

function connectionStates(steamModule) {
  const states = steamModule?.ESteamNetworkingConnectionState || {};
  return {
    Connecting: states.Connecting ?? 1,
    Connected: states.Connected ?? 3,
    ClosedByPeer: states.ClosedByPeer ?? 4,
    ProblemDetectedLocally: states.ProblemDetectedLocally ?? 5,
  };
}

/** 房主：Steam 监听 socket -> 本地服务端口（每个对端一条 TCP 连接）。 */
function createSteamHost(options = {}) {
  const {
    appDir = process.cwd(),
    appId = null,
    sdkPath = null,
    sdk = null,
    steamModule = null,
    gameHost = '127.0.0.1',
    gamePort,
    maxPeers = DEFAULT_MAX_PEERS,
    tuning: tuningOptions = null,
    netConfig: netConfigOptions = null,
    netConfigEnv = process.env,
    onEvent = null,
    debug = false,
    logDir = null,
  } = options;

  if (!Number.isInteger(Number(gamePort)) || Number(gamePort) < 1 || Number(gamePort) > 65535) {
    throw makeError('EINVALIDPORT', '本地服务端口必须是 1–65535 的整数');
  }

  const stats = createStats('host');
  const tuning = resolveLinkTuning(tuningOptions || {});
  stats.tuning = { ...tuning };
  const peers = new Map(); // connection -> { connection, steamId, socket, connected, queue }
  let steam = null;
  let moduleRef = steamModule;
  let listenSocket = null;
  let pollGroup = null;
  let stopLoop = null;
  let offStateChange = null;
  let stopped = false;
  // 每秒延迟诊断（延迟专项 Phase 1）。只读：它读 peers/stats/连接实时状态，不参与收发决策。
  let latencyDiag = null;
  // 房主没有别的东西需要定时，所以这个调度器是专门为诊断起的（规格 §十八：仍然只有一个）。
  let latencyScheduler = null;
  const sampleState = { lastPeerSampleAt: 0 };

  const emit = (type, payload) => {
    if (typeof onEvent !== 'function') return;
    try { onEvent(type, payload); } catch { /* 事件回调不允许影响转发 */ }
  };

  /**
   * 房主侧的一条"干道"：一条 Steam P2P 连接，里面可以并行跑很多条流。
   *
   * 0.14.0 之前这里是"一条 Steam 连接 = 一个到游戏端口的本机 socket"。现在先建干道，
   * **确定对端会多路复用之前不碰游戏端口** —— 否则每次握手都会顺手在游戏服务上开一个
   * 连接，而对方可能一个字节都不发（那正是以前"游戏服务 60 秒超时关连接"的来源）。
   */
  /**
   * 把一串已经编码好的帧排进发送队列，并尽快发出去。
   * 攒够 outFlushBytes 就立刻发，否则挂到本回合末尾 —— 与本地 socket 数据那条路径同一个节奏。
   */
  const pushFrames = (peer, frames) => {
    if (peer.dropped || !frames.length) return;
    let shouldFlush = false;
    for (const frame of frames) {
      // 干道级上行计数。多路复用这条路原来一个字节都不记，"隧道存量"那行
      // 才会出现"流上明明上行 41KiB、干道上却是 上行0KiB"这种自相矛盾的读数。
      peer.bytesToPeer += frame.length;
      // 队列**按流分开**（多路复用公平调度的关键）：流号从帧头里读，OPEN/DATA/CLOSE/RESET
      // 因为同属一条流所以进同一个 FIFO，流内顺序逐字节不变。
      if (queueOut(peer, frame, tuning.outFlushBytes, fairKey(frame, tuning))) shouldFlush = true;
    }
    if (shouldFlush) {
      const written = flushPeerOut(steam, peer, sendChunk, tuning);
      if (written < 0) {
        stats.sendStalls += 1;
        emit('error', { stage: 'steam-send', error: { code: 'ESTEAMSEND', friendly: 'Steam 发送缓冲已满，已暂停读取本机连接等待排空', message: 'sendMessage buffer full' } });
      }
    } else {
      flushPeerOutSoon(steam, peer, sendChunk, tuning);
    }
  };

  /** 一条流上的字节转给游戏端口那条本机 socket；还没连上就先攒着。 */
  const writeStream = (stream, payload) => {
    if (!stream || stream.socket.destroyed || !payload.length) return;
    if (!stream.connected) {
      if (stream.queueBytes + payload.length > PEER_QUEUE_MAX_BYTES) {
        // 连上都还没连上就攒了 1MB：与其带伤上路，不如断开让客户端重来一次。
        stats.dropped += 1;
        stream.socket.destroy();
        return;
      }
      stream.queue.push(Buffer.from(payload));
      stream.queueBytes += payload.length;
      return;
    }
    stream.socket.write(payload);
  };

  /**
   * 干道断了以后**还活着的流**（规格 §十六 的 stream recovery）。
   *
   * 早先的写法是"干道一断就把所有流的 socket destroy 掉，浏览器自己会重开"。这在
   * HTTP 短请求上看着还行，但每次传输层打嗝都等于把整页资源全部作废 —— 而重连一条
   * 干道只要几十毫秒到一两秒（见 STREAM_MIGRATE_GRACE_MS）。所以改成：先寄存，
   * 等新干道把 `OPEN(同一个流号, 更高的世代)` 送上来就原地复活，超时才真收掉。
   *
   * ★★ 键是**对端身份 + 流号**，不是光一个流号 —— 这一条曾经错过，代价很大。
   *
   * 加入者的偶数流号是**每个加入者各自从 2 开始**的（`nextStreamId = STREAM_ID_CLIENT_START`），
   * 规格 §十一 只保证"房主用奇数、加入者用偶数、两侧不相撞"，它**保证不了加入者之间不重号**。
   * 三个人同房时，两个加入者的 2、4、6… 是完全重号的。房主这边如果只按流号索引这张表，
   * 就会出现"第三人抢占隧道"：
   *   · 后一个加入者的 OPEN(2) 把前一个加入者寄存中的流**连同它到游戏端口的 socket 一起接管过去**
   *     （`adoptOrphan` 把 `stream.owner` 改成新对端）——B 的请求打到 A 的连接上，A 的响应送给 B；
   *   · 或者反过来，后一个加入者 park 时把前一个加入者寄存着的那条**直接 destroy 掉**。
   * 这两条路都只在"干道断过一次"之后才会走到，所以平时完全看不出来，专挑三个人同房时发作。
   *
   * 声明位置在 openStream 之前：openStream 与新干道上的 OPEN 帧都会读它。
   * 加入者侧（另一份实现）只用得上流号：它对端自始至终只有房主一个，不存在重号。
   */
  const orphanStreams = new Map();   // 对端身份#流号 -> stream

  /**
   * 寄存流的键。
   *
   * 身份优先用 SteamID —— 它跨重连稳定，同一个加入者的新干道才能把旧流认回来；
   * 拿不到 SteamID 时退化成这条 Steam 连接的对象串（重连后认不回来，但**绝不会认错人**：
   * 认不回来只是多开一条到游戏端口的连接，认错人就是把两个人的数据串在一起）。
   */
  const orphanKey = (peer, streamId) => String((peer && peer.steamId) || (peer && peer.connection) || '?') + '#' + streamId;

  /**
   * 开一条流 = 在游戏端口上开一个本机连接。
   *
   * 对游戏服务来说，多路复用是透明的：浏览器开几条连接，它就看到几个连接，
   * 只不过这些连接共享同一条 Steam 干道。
   *
   * @param {number} generation 对端为这条流分配的世代号（规格 §十七）。同一个流号
   *   配上更高的世代 = 对端在 transport 重建后重新挂载这条流（规格 §十六 的 reattach）。
   */
  const openStream = (peer, streamId, generation = 0) => {
    const existing = peer.streams.get(streamId);
    if (existing) {
      // reattach：流号相同、世代更高，就把世代推上去，后续帧按新世代校验。
      if ((generation >>> 0) > (existing.generation >>> 0)) existing.generation = generation >>> 0;
      return existing;
    }
    // 先看寄存区：**同一个对端 + 同一个流号**在新干道上重新出现，就是规格 §十六 的 reattach。
    // 这时绝不能新建一条到游戏端口的连接 —— 那会让游戏看到"同一件事被开了两个连接"，
    // 而且原来那条连接上已经发了一半的响应就永远送不出去了。
    // 注意"同一个对端"这一半：只比流号的话，另一个加入者的流 2 会认领走这个人的流 2。
    const parked = orphanStreams.get(orphanKey(peer, streamId));
    if (parked) {
      if (parked.socket.destroyed) {
        orphanStreams.delete(orphanKey(peer, streamId));
      } else if ((generation >>> 0) >= (parked.generation >>> 0)) {
        return adoptOrphan(peer, parked, generation);
      }
      // 世代比寄存的那份还旧：迟到帧，装作没看见。下面会当作一条全新流处理 ——
      // 但**不复用那个 socket**，旧的那份留给清扫器收掉，免得两代流写同一个 socket。
    }
    if (peer.streams.size >= PEER_STREAM_MAX_PER_TRUNK) {
      pushFrames(peer, [mux.encodeReset(streamId, generation, mux.RESET_REASON.StreamLimit)]);
      return null;
    }
    const stream = {
      id: streamId,
      generation: generation >>> 0,
      socket: net.createConnection({ host: gameHost, port: Number(gamePort) }),
      connected: false,
      queue: [],
      queueBytes: 0,
      remoteCredit: PEER_OUT_HIGH_WATER,   // 对端说"我还能再接这么多字节"（规格 §十三）
      bornAt: Date.now(),
      bytesToPeer: 0,
      bytesFromPeer: 0,
      /** 当前归属的干道。**所有 socket 回调都读它**，不捕获 peer —— 换挂才有意义。 */
      owner: peer,
      /** 干道断开期间游戏服务继续吐出来的字节（只有"寄存中"时才非空）。 */
      parkQueue: [],
      parkBytes: 0,
      parkedAt: 0,
      migrations: 0,
    };
    peer.streams.set(streamId, stream);
    stats.streams = peer.streams.size;
    stats.totalStreams = (stats.totalStreams || 0) + 1;

    stream.socket.setNoDelay(true);
    // 干道正处在背压暂停中时，这条新流也要一起停住（连上之后不会开始读游戏服务端）。
    if (peer.paused) { try { stream.socket.pause(); } catch { /* 暂停失败就继续按老路走 */ } }
    stream.socket.on('connect', () => {
      stream.connected = true;
      for (const chunk of stream.queue.splice(0)) stream.socket.write(chunk);
      stream.queueBytes = 0;
      const owner = stream.owner;
      emit('stream-added', { peer: owner?.steamId || String(owner?.connection ?? '?'), stream: streamId });
    });
    stream.socket.on('data', (chunk) => {
      const serveStartedAt = hrNow();
      stats.bytesToPeer += chunk.length;
      stats.packetsToPeer += 1;
      stream.bytesToPeer += chunk.length;
      const owner = stream.owner;
      if (!owner || owner.dropped || owner.framed !== true) {
        // 没有归属干道（或者它已经废了）：**不能丢**，先寄存着。
        // 这一段往往是"响应的后半截"，丢掉就等于把一个 HTTP 响应砍断。
        if (stream.parkBytes + chunk.length > STREAM_PARK_MAX_BYTES) {
          stats.dropped += 1;
          try { stream.socket.destroy(); } catch { /* 断一条流不影响别的流 */ }
          return;
        }
        stream.parkQueue.push(Buffer.from(chunk));
        stream.parkBytes += chunk.length;
        return;
      }
      // 数据帧与 CLOSE 帧走同一个有序队列 —— 游戏服务"回完响应立刻关连接"时，
      // 那段响应必然排在 CLOSE 前面，不会再出现"最后一段字节丢掉"。
      pushFrames(owner, mux.encodeDataChunks(streamId, stream.generation, chunk));
      // 本地服务给的那段字节：从 Node 的 data 回调进门、到编码完塞进 Steam 队列出门的耗时。
      // 这是"房主 TCP/Node 服务处理时间"里我们能测的那一半（另一半在游戏进程里，测不到）。
      if (latencyDiag) latencyDiag.recordServe({ ms: hrNow() - serveStartedAt, bytes: chunk.length });
    });
    stream.socket.on('error', (err) => {
      stats.failed += 1;
      emit('error', { stage: 'game-socket', error: { code: err.code, friendly: `连接本地服务端口失败：${err.message}`, message: err.message } });
      stream.socket.destroy();
    });
    stream.socket.on('close', () => {
      const owner = stream.owner;
      const ageMs = Date.now() - stream.bornAt;
      // 已经寄存起来的流：socket 是自己收掉的，账在清扫器那边结。
      // 删键必须用它**寄存时的那个键**，不能拿"创建它的对端"现算 —— 寄存中的流
      // 不一定归属于创建者（虽然改双键之后已经不可能被别人接管，但这个键始终是权威来源）。
      if (!owner) { orphanStreams.delete(stream.orphanKey || orphanKey(peer, streamId)); return; }
      owner.streams.delete(streamId);
      stats.streams = owner.streams.size;
      // 游戏侧正常收尾时也要把 CLOSE 送出去 —— 但**不能**在干道已经废掉时硬发。
      if (!owner.dropped && owner.framed === true) pushFrames(owner, [mux.encodeClose(streamId, stream.generation)]);
      emit('stream-left', {
        peer: owner.steamId || String(owner.connection),
        stream: streamId,
        kind: 'LocalServiceClosed',
        reason: '本机服务端口把这条件接关了（响应正常收尾，或游戏侧自己超时）',
        ageMs,
        bytesToPeer: stream.bytesToPeer,
        bytesFromPeer: stream.bytesFromPeer,
      });
    });
    return stream;
  };

  /** 把一条寄存中的流重新挂到新干道上，并补发它在断开期间收到的字节。 */
  const adoptOrphan = (peer, stream, generation) => {
    orphanStreams.delete(stream.orphanKey || orphanKey(peer, stream.id));
    stream.orphanKey = '';
    stream.owner = peer;
    stream.generation = generation >>> 0;
    stream.parkedAt = 0;
    stream.migrations += 1;
    peer.streams.set(stream.id, stream);
    stats.streams = peer.streams.size;
    stats.streamsMigrated = (stats.streamsMigrated || 0) + 1;
    // 补发寄存期间游戏服务吐出来的字节：**必须在重新登记之后**，否则 owner 还是空的。
    if (stream.parkBytes) {
      const parked = stream.parkQueue.splice(0);
      stream.parkBytes = 0;
      for (const chunk of parked) pushFrames(peer, mux.encodeDataChunks(stream.id, stream.generation, chunk));
    }
    // socket 在寄存期间自己关了：补一条 CLOSE，让对端知道这条流结束了。
    if (stream.socket.destroyed) {
      pushFrames(peer, [mux.encodeClose(stream.id, stream.generation)]);
    }
    emit('stream-added', { peer: peer.steamId || String(peer.connection), stream: stream.id, migrated: true });
    return stream;
  };

  /**
   * 干道断了：把挂在它上面的流**寄存**起来（socket 不动），等新干道来接。
   *
   * 不销毁的理由见 STREAM_MIGRATE_GRACE_MS 与 orphanStreams 的注释。
   */
  const parkPeerStreams = (peer, reason) => {
    if (!peer.streams.size) return 0;
    const now = Date.now();
    let parked = 0;
    for (const stream of [...peer.streams.values()]) {
      peer.streams.delete(stream.id);
      if (stream.socket.destroyed) continue;
      stream.owner = null;
      stream.parkedAt = now;
      // ★ 键里必须带对端身份：两个加入者的流号是各自从 2 开始重号的，
      // 只按流号取/放会让第三个人把前一个人的流（连它的 socket）抢走或销毁。
      const key = orphanKey(peer, stream.id);
      const prev = orphanStreams.get(key);
      // 同一个对端、同一个流号又寄进来一份：旧的那份不可能还活着，直接收掉。
      if (prev && prev !== stream) { try { prev.socket.destroy(); } catch { /* ignore */ } }
      stream.orphanKey = key;
      orphanStreams.set(key, stream);
      parked += 1;
    }
    stats.streams = peer.streams.size;
    stats.streamsParked = (stats.streamsParked || 0) + parked;
    if (parked) emit('notice', { text: `干道断了，先把 ${parked} 条流寄存 ${STREAM_MIGRATE_GRACE_MS / 1000} 秒等重挂（原因：${reason}）` });
    return parked;
  };

  /** 兜底：寄存超过宽限期还没等到新干道的流，真收掉。 */
  const sweepOrphans = (now = Date.now()) => {
    if (!orphanStreams.size) return 0;
    let gone = 0;
    for (const [key, stream] of [...orphanStreams]) {
      if (stream.socket.destroyed) { orphanStreams.delete(key); continue; }
      if (now - stream.parkedAt < STREAM_MIGRATE_GRACE_MS) continue;
      orphanStreams.delete(key);
      gone += 1;
      stats.streamsMigrateExpired = (stats.streamsMigrateExpired || 0) + 1;
      try { stream.socket.destroy(); } catch { /* ignore */ }
      emit('stream-left', {
        peer: '（无干道）',
        stream: stream.id,
        kind: 'TunnelClosed',
        reason: `干道断了以后 ${STREAM_MIGRATE_GRACE_MS}ms 内没能重新挂上`,
        ageMs: now - stream.bornAt,
        bytesToPeer: stream.bytesToPeer,
        bytesFromPeer: stream.bytesFromPeer,
      });
    }
    return gone;
  };

  /** 真正销毁一条干道上的所有流（协议违规、会话停止 —— 这两种情况不该迁移）。 */
  const destroyPeerStreams = (peer, reason) => {
    for (const stream of [...peer.streams.values()]) {
      peer.streams.delete(stream.id);
      stream.owner = null;
      try { if (!stream.socket.destroyed) stream.socket.destroy(); } catch { /* ignore */ }
      emit('stream-left', {
        peer: peer.steamId || String(peer.connection),
        stream: stream.id,
        kind: 'TunnelClosed',
        reason,
        ageMs: Date.now() - stream.bornAt,
        bytesToPeer: stream.bytesToPeer,
        bytesFromPeer: stream.bytesFromPeer,
      });
    }
    stats.streams = peer.streams.size;
  };

  /**
   * 收到一帧。
   *
   * 顺序按规格 §二十五 的接收路径走：**先认流、再验世代、最后才动 socket**。
   * 世代不匹配就直接丢，绝不写进本机 socket —— 否则旧连接迟到的字节会污染这条流。
   */
  const handleStreamFrame = (peer, frame) => {
    const { type, streamId } = frame;
    if (type === mux.TYPE.Open) {
      // 对端开了新流：在游戏端口上补一个连接。数据会跟在后面，所以先连再写。
      openStream(peer, streamId, frame.generation);
      return;
    }
    if (streamId === mux.STREAM_ID_SESSION) {
      // 整条干道级别的控制帧（Ping/Pong）。没接收端点时只记账，不影响任何流。
      if (type === mux.TYPE.Ping) pushFrames(peer, [mux.encodePong()]);
      return;
    }
    const stream = peer.streams.get(streamId);
    if (!stream) {
      // 对端已经收到过我们的 Reset/Close，后面的零星帧直接忽略。
      if (type !== mux.TYPE.Reset) stats.dropped += 1;
      return;
    }

    const verdict = mux.checkGeneration(frame, stream.generation);
    if (verdict === 'stale') {
      // 旧连接上迟到的帧 —— 规格 §十七 硬要求：直接丢弃，不许写进 socket。
      stats.staleFrames = (stats.staleFrames || 0) + 1;
      return;
    }
    if (verdict === 'future') {
      // 比本地世代新却不是 Open：协议违规。只掐这一条流，不牵连其它（规格 §二十五）。
      stats.dropped += 1;
      pushFrames(peer, [mux.encodeReset(streamId, stream.generation, mux.RESET_REASON.Protocol)]);
      peer.streams.delete(streamId);
      stats.streams = peer.streams.size;
      try { if (!stream.socket.destroyed) stream.socket.destroy(); } catch { /* ignore */ }
      return;
    }

    if (type === mux.TYPE.Data) {
      // 下行计数必须在这里加：`流结束 ... 下行=0KiB` 曾经永远是 0，害得人以为
      // "朋友一个字节都没送上来"，其实只是房主这条路从来没有记过账
      // （加入者侧的对应位置见另一份 handleStreamFrame 实现）。
      stream.bytesFromPeer += frame.payload.length;
      writeStream(stream, frame.payload);
      return;
    }
    if (type === mux.TYPE.Window) { stream.remoteCredit = mux.decodeWindowCredit(frame.payload); return; }
    if (type === mux.TYPE.Close) { if (!stream.socket.destroyed) stream.socket.end(); return; }
    if (type === mux.TYPE.Reset) {
      stats.streamsReset = (stats.streamsReset || 0) + 1;
      if (!stream.socket.destroyed) stream.socket.destroy();
    }
  };

  const attachPeer = (connection, steamId) => {
    let peer = peers.get(connection);
    if (peer) return peer;
    peer = {
      connection,
      steamId,
      framed: null,           // null=还没听到对端开口, true=多路复用, false=老对端（单连接透传）
      decoder: mux.createFrameDecoder(),
      streams: new Map(),     // streamId -> { id, socket, connected, queue, queueBytes }
      socket: null,           // 只为老对端模式准备（那条路径上一条 Steam 连接只有一条流）
      connected: false,
      queue: [],
      out: [],
      bornAt: Date.now(),
      bytesToPeer: 0,
      bytesFromPeer: 0,
    };
    peers.set(connection, peer);
    stats.peers = peers.size;
    stats.connections = peers.size;
    stats.totalPeers += 1;

    // ★ 房主**不主动开口**：多路复用的 HELLO 由加入者先发，房主认出魔数之后才回一条。
    //
    // 为什么必须这样 —— 这是一条裸字节管道，先开口那一侧的魔数在旧版对端眼里就是业务数据：
    //   · 房主先发 ⇒ 0.13.3 的加入者会把 "SHLMUX\x01" 当成 HTTP 响应开头的几个字节，
    //     整页解析失败。而"房主先升级、朋友后升级"恰好是最常见的升级顺序。
    //   · 房主被动应答 ⇒ 新房主对旧加入者**一个字节都不多发**，旧加入者照旧走
    //     attachLegacySocket，完全无感。
    // 代价只有一个组合：旧房主 + 新加入者（加入者发出去的魔数会被旧房主转发进游戏端口）。
    // 这一条靠升级顺序规避：房主先升。见 docs/0.14.0-网络架构重构.md 的 4.3。
    emit('peer-joined', { peer: steamId || String(connection) });
    return peer;
  };

  /** 老对端（≤0.13.3）走这条路：一条 Steam 连接对着一个游戏端口 socket，字节原样透传。 */
  const attachLegacySocket = (peer) => {
    if (peer.socket) return peer.socket;
    const connection = peer.connection;
    const steamId = peer.steamId;
    peer.socket = net.createConnection({ host: gameHost, port: Number(gamePort) });
    peer.legacy = true;
    peer.socket.setNoDelay(true);
    peer.socket.on('connect', () => {
      peer.connected = true;
      for (const chunk of peer.queue.splice(0)) peer.socket.write(chunk);
      emit('peer-connected', { peer: steamId || String(connection) });
    });
    peer.socket.on('data', (chunk) => {
      stats.bytesToPeer += chunk.length;
      stats.packetsToPeer += 1;
      peer.bytesToPeer += chunk.length;
      const active = steam.networkingSockets.isConnectionActive(connection);
      if (!active) { stats.dropped += 1; return; }
      if (queueOut(peer, chunk, tuning.outFlushBytes)) {
        const written = flushPeerOut(steam, peer, sendChunk, tuning);
        if (written < 0) {
          // 数据没有丢：它还在 peer.out 里，泵的下一个 tick 会重发。
          // 这里只记账与报告；真正止血的是 flushPeerOut 里的背压（暂停读本地 socket）。
          stats.sendStalls += 1;
          emit('error', { stage: 'steam-send', error: { code: 'ESTEAMSEND', friendly: 'Steam 发送缓冲已满，已暂停读取本机连接等待排空', message: 'sendMessage buffer full' } });
        }
      } else {
        // 没到阈值也别等下一个泵 tick：挂到本回合末尾就发，少等最多一个 tick 的时间。
        flushPeerOutSoon(steam, peer, sendChunk, tuning);
      }
    });
    peer.socket.on('error', (err) => {
      stats.failed += 1;
      emit('error', { stage: 'game-socket', error: { code: err.code, friendly: `连接本地服务端口失败：${err.message}`, message: err.message } });
      peer.socket.destroy();
    });
    peer.socket.on('close', () => {
      const info = peerSample(peer, Date.now());
      peers.delete(connection);
      stats.peers = peers.size;
      stats.connections = peers.size;
      // 游戏服务常常"回完响应立刻关本地连接"（HTTP/1.0 / Connection: close），
      // 而小于 outFlushBytes 的响应还排在 flushPeerOutSoon 的 setImmediate 里。
      // 立刻 closeConnection 会把那点尾巴永远留在 peer.out —— 先把队列抽干再关。
      drainThenClose({
        peer,
        steam,
        sendChunk,
        tuning,
        stats,
        onDone: () => {
          if (steam?.networkingSockets?.isConnectionActive(connection)) {
            // ▲ 最后一个参数是"允许 Steam 把尚未上线的数据送完再关"（linger）。
            // 原来这里是 false = 立刻关，Steam 会把刚交给它、还没真正出门的字节一起丢掉。
            // 游戏服务恰恰是"回完响应立刻关本地连接"的写法（HTTP/1.0 / Connection: close），
            // 于是那段响应永远到不了对端，浏览器只看到连接被关 —— 现场表现就是
            // "页面/地图加载不出来，刷新一下才好"（刷新时服务端晚一点关就成了）。
            // 加入者那边的 dropPeer 一直用的就是 true，房主这条路径漏了。
            steam.networkingSockets.closeConnection(connection, 0, '本地服务连接关闭', true);
          }
        },
      });
      // 这一支是"本机游戏服务自己把连接关了"——以前只留一句"连接断开"，
      // 于是"是游戏服务断了还是网络断了"永远分不清。
      if (firstGone(peer)) {
        emit('peer-left', {
          peer: steamId || String(connection),
          kind: peer.dropWhy ? 'LocalTunnelAbort' : 'LocalServiceClosed',
          reason: peer.dropWhy || '本机服务端口把这条件接关了（响应正常收尾，或游戏侧自己超时）',
          ...info,
        });
      }
    });
    return peer.socket;
  };


  const handleStateChange = (change) => {
    const states = connectionStates(moduleRef);
    const { connection, newState } = change;
    const steamId = String(change.info?.identityRemote || '');
    if (newState === states.Connecting) {
      // 只处理「真的从我们的监听 socket 进来」的连接。
      // 实测：同一个 Steam 客户端自连时（同一账号、同进程跑房主+加入者），进程里也会看到自己发起的
      // 出站连接，它的 info.listenSocket === 0；对它调 acceptConnection 会返回 11（InvalidParam）。
      // 记录每一次进入 Connecting 的事件 —— 没有这行日志，就无法判断"房主到底有没有收到请求"。
      const lsRaw = change.info ? change.info.listenSocket : undefined;
      try {
        emit('notice', { text: 'Steam 连接事件：对端 ' + (steamId || '?') + ' · listenSocket=' + JSON.stringify(lsRaw) + (lsRaw === 0 ? '（判定为出站，跳过）' : '（判定为入站，接受）') });
      } catch (err) { /* 日志失败不影响主流程 */ }
      if (change.info && lsRaw === 0) return;
      if (peers.size >= maxPeers) {
        stats.rejected += 1;
        emit('rejected', { reason: 'max-peers', peer: steamId, limit: maxPeers });
        steam.networkingSockets.closeConnection(connection, 100, '房间已满', false);
        return;
      }
      const result = steam.networkingSockets.acceptConnection(connection);
      if (result !== 0 && result !== 1 && result !== true) {
        stats.rejected += 1;
        emit('rejected', { reason: 'accept-failed', peer: steamId, result });
        steam.networkingSockets.closeConnection(connection, 101, '拒绝连接', false);
        return;
      }
      if (pollGroup) steam.networkingSockets.setConnectionPollGroup(connection, pollGroup);
      return;
    }
    if (newState === states.Connected) {
      attachPeer(connection, steamId);
      return;
    }
    if (newState === states.ClosedByPeer || newState === states.ProblemDetectedLocally) {
      const peer = peers.get(connection);
      if (peer) {
        const info = peerCloseInfo(peer, change, states, Date.now());
        peers.delete(connection);
        stats.peers = peers.size;
        stats.connections = peers.size;
        // 干道断了：把流**寄存**起来等新干道来接，而不是就地收掉（规格 §十六）。
        // 以前这里 destroy 所有流的 socket —— 传输层打一个嗝就等于浏览器里所有请求
        // 一起失败、整页资源重来一遍。寄存的代价只是几百 KB 内存和一个 8 秒的期限。
        // **房主这边不主动拉新干道**：它是被动应答的一方，"新干道"由加入者重新发起
        // （加入者那边 dropPeer 之后会 refillTrunks）。房主要做的只是别把流收掉。
        parkPeerStreams(peer, change.info?.endDebugMessage || 'Steam 连接断开');
        if (peer.socket) { try { peer.socket.destroy(); } catch { /* ignore */ } }
        if (firstGone(peer)) emit('peer-left', { peer: peer.steamId || String(connection), ...info });
      }
    }
  };

  /** 把字节喂给解码器，逐帧交给流层。协议错乱就断开这条干道（宁可重连也不要串线）。 */
  const feedDecoder = (peer, chunk) => {
    let frames;
    try {
      frames = peer.decoder.push(chunk);
    } catch (err) {
      stats.failed += 1;
      emit('error', { stage: 'mux-decode', error: { code: err.code || 'EMUXFRAME', friendly: `Steam 数据流格式不对，已断开这条连接：${err.message}`, message: err.message } });
      peer.dropped = true;
      peers.delete(peer.connection);
      stats.peers = peers.size;
      stats.connections = peers.size;
      // 协议错乱是另一回事：这条干道上的字节已经不可信，**不许寄存**（否则错的字节
      // 会被搬到新干道上接着错）。直接收摊，让客户端重来。
      destroyPeerStreams(peer, '数据流格式不对');
      if (peer.socket) { try { peer.socket.destroy(); } catch { /* ignore */ } }
      if (firstGone(peer)) emit('peer-left', { ...peerCloseInfo(peer, null, states, Date.now()), peer: peer.steamId || String(peer.connection), kind: 'BadFraming', reason: err.message });
      try { steam.networkingSockets.closeConnection(peer.connection, 0, '数据格式不对', false); } catch { /* ignore */ }
      return;
    }
    for (const frame of frames) handleStreamFrame(peer, frame);
  };

  const pump = () => {
    if (stopped || !pollGroup) return 0;
    // 先发送本 tick 攒下的小包（合并成大消息）
    for (const peer of peers.values()) {
      // 0.14.4：先采一次 Steam 侧积压（超水位就先暂停本地数据源），再 flush、再判恢复。
      pumpPeerBackpressure(steam, peer, tuning);
      resumeOrAbort(peer, flushPeerOut(steam, peer, sendChunk, tuning), tuning);
    }
    // 「每轮 Steam 消息轮询 + 分发耗时」的取数口（延迟专项）：只量这一段，
    // 不含上面的 flush 与下面的 samplePeers —— 那两个的耗时各自有别的账。
    const pollStartedAt = hrNow();
    const messages = steam.networkingSockets.receiveMessagesOnPollGroup(pollGroup, tuning.maxMessageBatch) || [];
    for (const message of messages) {
      const peer = peers.get(message.connection);
      if (!peer) { stats.dropped += 1; continue; }
      const data0 = Buffer.isBuffer(message.data) ? message.data : Buffer.from(message.data || []);
      stats.bytesFromPeer += data0.length;
      stats.packetsFromPeer += 1;
      peer.bytesFromPeer += data0.length;

      // 还没听到对端开口：第一条消息决定这局走"多路复用"还是"老对端透传"。
      if (peer.framed === null) {
        if (mux.isOurHello(data0)) {
          peer.framed = true;
          peer.connected = true;
          stats.muxPeers = (stats.muxPeers || 0) + 1;
          // 加入者先开口，房主认出魔数后才回一条（见 attachPeer 里的说明）。
          // 回包必须排在 rest 里那些 OPEN 对应的数据帧**之前** —— 加入者要收到这条应答
          // 才会把 framed 定成 true，先收到流数据会让它以为对端在乱说话。
          pushFrames(peer, [mux.encodeHello()]);
          const rest = data0.subarray(mux.HELLO_BYTES.length);
          if (rest.length) feedDecoder(peer, rest);
          // 一局只握手一次，之后所有本机连接都挂在上面 —— 上层只需要知道"通了"。
          emit('peer-connected', { peer: peer.steamId || String(message.connection), mux: true });
          continue;
        }
        // 是魔数，但版本对不上（比如 0.14.0 开发期的 v1 帧格式）。**绝不能**把这几个
        // 字节当游戏流量转发出去 —— 那会污染 HTTP 请求头。吞掉魔数，退回单连接模式。
        let data = data0;
        if (mux.isHello(data)) {
          stats.versionMismatch = (stats.versionMismatch || 0) + 1;
          emit('notice', {
            text: `对端的隧道协议版本是 ${mux.helloVersion(data)}，本机是 ${mux.MUX_VERSION}` +
              ' —— 这一局退回单连接模式（能用，但要慢很多），两边升到同一版即可恢复多路复用',
          });
          data = data.subarray(mux.HELLO_BYTES.length);
          if (!data.length) continue;
        }
        // 对端不是 0.14.0（或者根本没开口）：退回 0.13.3 的单连接行为，
        // 这样"朋友还没升级"时也只是慢，不会完全连不上。
        peer.framed = false;
        stats.legacyPeers = (stats.legacyPeers || 0) + 1;
        attachLegacySocket(peer);
        if (!peer.connected) {
          if (peer.queue.length > 256) {
            // 连上之前就积压了 256 块。丢掉最早那块同样是在可靠流上挖洞，
            // 与其带伤上路，不如断开让客户端重连一次。
            stats.dropped += 1;
            try { peer.socket.destroy(); } catch { /* 断开失败不影响其它连接 */ }
            continue;
          }
          peer.queue.push(data);
          continue;
        }
        peer.socket.write(data);
        continue;
      }
      if (peer.framed === true) {
        // 加入者因为"首包可能会丢"会重发魔数（见 retryUndecidedTrunks）。这条干道早就
        // 谈妥了，这种迟到的重发必须**吞掉** —— 喂进解码器会被当成帧头解出垃圾，
        // 整条干道以 BadFraming 收场，等于把刚救回来的隧道又毙一次。
        //
        // 吞掉的同时**再答一次**。理由是这条链路上"加入者的魔数到了、房主的应答丢了"
        // 完全可能发生：房主这边早就 framed === true，它不会再主动说第二句话，而加入者
        // 会一直等到 PEER_HELLO_GIVEUP_MS 才放弃换新（默认 30 秒白等）。重答一次只要 7
        // 个字节，却能把这种情况从"30 秒后重开一条干道"缩成"下一个重发周期就好"。
        // 不会来回打乒乓：加入者一旦定帧就不再发魔数了。
        if (mux.isOurHello(data0)) {
          stats.helloRepeat = (stats.helloRepeat || 0) + 1;
          pushFrames(peer, [mux.encodeHello()]);
          const rest = data0.subarray(mux.HELLO_BYTES.length);
          if (rest.length) feedDecoder(peer, rest);
          continue;
        }
        feedDecoder(peer, data0);
        continue;
      }
      const data = data0;
      // 老对端：一个字节都不改，原样透传。
      if (!peer.connected) {
        if (peer.queue.length > 256) {
          stats.dropped += 1;
          try { peer.socket.destroy(); } catch { /* 断开失败不影响其它连接 */ }
          continue;
        }
        peer.queue.push(data);
        continue;
      }
      peer.socket.write(data);
    }
    // 返回值供 startCallbackLoop 判断"这一轮有没有活"，决定下一次轮询是立刻还是退让。
    if (latencyDiag) latencyDiag.recordPoll({ ms: hrNow() - pollStartedAt, messages: messages.length });
    samplePeers({ peers, steam, emit, state: sampleState });
    // 寄存流的清扫挂在这条本来就有的泵上（规格 §十八：不许每个流各起一个计时器）。
    // 用一个时间戳把它压到 ORPHAN_SWEEP_MS 一次 —— 泵是 4ms 一轮，4ms 扫一遍孤儿纯浪费。
    const now = Date.now();
    if (orphanStreams.size && now - (sampleState.lastOrphanSweepAt || 0) >= ORPHAN_SWEEP_MS) {
      sampleState.lastOrphanSweepAt = now;
      sweepOrphans(now);
    }
    return messages.length;
  };

  const ready = (async () => {
    const init = initSteamSdk({ appDir, appId, sdkPath, sdk, debug, netConfig: netConfigOptions, netConfigEnv, stats });
    steam = init.steam;
    if (!moduleRef) moduleRef = sdk ? null : loadSteamModule(appDir);
    const handles = invalidHandles(moduleRef);
    const sockets = steam.networkingSockets;
    if (!sockets?.createListenSocketP2P) throw makeError('ESTEAMAPI', 'steamworks-ffi-node 未提供 networkingSockets 接口');

    listenSocket = sockets.createListenSocketP2P(0);
    if (moduleRef && listenSocket === handles.listenSocket) throw makeError('ESTEAMLISTEN', '创建 Steam P2P 监听 socket 失败');
    if (listenSocket == null || listenSocket === 0) throw makeError('ESTEAMLISTEN', '创建 Steam P2P 监听 socket 失败');
    pollGroup = sockets.createPollGroup();
    if (pollGroup == null || pollGroup === 0) throw makeError('ESTEAMPOLL', '创建 Steam P2P Poll Group 失败');

    offStateChange = sockets.onConnectionStateChange(handleStateChange);
    stopLoop = startCallbackLoop({
      label: 'STEAM',
      onNotice: (msg) => { try { emit('notice', { text: msg }); } catch (err) { /* 日志失败不影响转发 */ } },
      steam,
      pump,
      intervalMs: tuning.callbackIntervalMs,
      onFatal: (err) => emit('error', { stage: 'callbacks', error: { code: 'ESTEAMCALLBACK', friendly: `Steam 回调出错：${err.message}`, message: err.message } }),
    });
    stats.startedAt = Date.now();
    const steamId = resolveOwnSteamId(steam);
    if (!steamId) emit('error', { stage: 'steam-identity', error: { code: 'ESTEAMID', friendly: '未能获取本机 SteamID：请确认 Steam 已登录，且 AppID 与 SDK 匹配。', message: 'resolveOwnSteamId failed' } });
    stats.sessionId = steamId;
    emit('listening', { protocol: 'STEAM', role: 'host', steamId, gameHost, gamePort: Number(gamePort) });
    return { steamId, gameHost, gamePort: Number(gamePort) };
  })();
  ready.catch(() => { /* 由调用方决定如何提示 */ });

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (stopLoop) stopLoop();
    stopLoop = null;
    try { offStateChange?.(); } catch { /* ignore */ }
    for (const peer of peers.values()) {
      // 会话停了就不再重连，寄存区里那些流也没有"新干道"可等 —— 一起收干净。
      destroyPeerStreams(peer, '隧道已停止');
      try { peer.socket?.destroy(); } catch { /* ignore */ }
    }
    for (const stream of [...orphanStreams.values()]) {
      try { if (!stream.socket.destroyed) stream.socket.destroy(); } catch { /* ignore */ }
    }
    orphanStreams.clear();
    peers.clear();
    stats.peers = 0;
    stats.connections = 0;
    try { if (listenSocket != null && steam?.networkingSockets) steam.networkingSockets.closeListenSocket(listenSocket); } catch { /* ignore */ }
    try { if (pollGroup != null && steam?.networkingSockets) steam.networkingSockets.destroyPollGroup(pollGroup); } catch { /* ignore */ }
    listenSocket = null;
    pollGroup = null;
    if (latencyDiag) { latencyDiag.dispose(); latencyDiag = null; }
    if (latencyScheduler) { try { latencyScheduler.stop(); } catch { /* ignore */ } latencyScheduler = null; }
    emit('stopped', {});
  };

  const reportRoute = createRouteReporter(steam, stats);

  // 每秒延迟诊断（延迟专项 Phase 1）。房主侧以前**没有任何周期性网络日志**
  // （netState/net-status 只挂在加入者上，见 createSteamJoiner 的注释），
  // 所以"能玩但慢"这种事在房主机器上一直是黑箱。这里补上，且只读。
  // 房主侧本来一条周期性网络任务都没有（健康采样/Relay 轮询只挂在加入者上），
  // 所以这里给它一个 250ms 刻度的诊断调度器，把每秒诊断挂上去 —— 房主也守
  // "整个网络层只有一个调度器"这条规矩，不给每个 peer/流/socket 各起计时器。
  latencyScheduler = createMuxScheduler({ intervalMs: 250, onEvent: (type, payload) => emit(type, payload) });
  latencyScheduler.start();
  latencyDiag = createNetLatencyDiag({
    role: 'host',
    logDir,
    scheduler: latencyScheduler,
    sockets: () => (steam && steam.networkingSockets) || null,
    connections: () => [...peers.values()]
      .filter((p) => p.connected && p.connection != null)
      .map((p) => ({ connection: p.connection, label: p.steamId || String(p.connection) })),
    peers: () => peers,
    peerLabel: (p) => (p && (p.steamId || String(p.connection))) || '?',
    peerOutBytes: (p) => peerOutBytes(p),
    // 分流出站队列：能看出公平调度有没有真的把"大响应"和"小包"分开
    peerOutQueues: (p) => egress.queueRows(p),
    streamsOf: (p) => (p && p.streams) || [],
    counters: () => stats,
    onEvent: (type, payload) => emit(type, payload),
  });
  latencyDiag.start();

  return {
    ready: ready.then((info) => info),
    stop,
    stats,
    isHost: true,
    route: () => reportRoute([...peers.values()].filter((p) => p.connected && p.connection != null).map((p) => p.connection)),
    /** 每秒延迟诊断的最新一帧（只读）。 */
    latency: () => (latencyDiag ? latencyDiag.snapshot() : { available: false, reason: '诊断未启动' }),
    options: { role: 'host', protocol: 'STEAM', gameHost, gamePort: Number(gamePort), maxPeers, appId },
  };
}

/** 加入者：本机 TCP 入口 -> Steam P2P 单条连接（房主 SteamID）。 */
function createSteamJoiner(options = {}) {
  const {
    appDir = process.cwd(),
    appId = null,
    sdkPath = null,
    sdk = null,
    steamModule = null,
    bindHost = '127.0.0.1',
    localPort,
    hostSteamId,
    tuning: tuningOptions = null,
    netConfig: netConfigOptions = null,
    netConfigEnv = process.env,
    // 只有"这次握手很快就被判死"才值得重试。默认见 PEER_RETRY_FAST_MS；
    // 做成可注入是为了测试能直接控制这个门槛，不必真的等满 5 秒。
    retryFastMs = PEER_RETRY_FAST_MS,
    // 流多路复用总开关。默认开；关掉就退回 0.13.3 的"每条本机连接一条 Steam 连接"
    // （测试里大量断言依赖老行为，也留一条随时能对照的路）。
    mux: muxOption = null,
    onEvent = null,
    debug = false,
    logDir = null,
  } = options;

  const listenPort = Number(localPort);
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) throw makeError('EINVALIDPORT', '本地入口端口必须是 1–65535 的整数');
  if (!STEAM_ID_PATTERN.test(String(hostSteamId || ''))) throw makeError('EINVALIDSTEAMID', '房主 SteamID 格式不正确（应以 7656119 开头的 17 位数字）');

  const stats = createStats('joiner');
  const tuning = resolveLinkTuning(tuningOptions || {});
  stats.tuning = { ...tuning };
  const peers = new Map(); // localSocket -> { socket, connection, connected, queue }
  const maxConnections = Number(options.maxConnections) > 0 ? Number(options.maxConnections) : DEFAULT_MAX_PEERS;
  const retryFastLimit = Number.isFinite(Number(retryFastMs)) && Number(retryFastMs) >= 0 ? Number(retryFastMs) : PEER_RETRY_FAST_MS;
  // 默认开多路复用。SHL_STEAM_MUX=0 或 options.mux=false 退回老行为。
  const muxEnabled = (() => {
    const raw = muxOption != null ? muxOption : process.env.SHL_STEAM_MUX;
    if (raw == null || String(raw).trim() === '') return true;
    const s = String(raw).trim().toLowerCase();
    return !(s === '0' || s === 'false' || s === 'off' || s === 'no');
  })();
  // 唯一的流编号发号器。从 1 开始，0 留给"没有流"。
  // 加入者只分配**偶数**流号（规格 §十一）：房主用奇数、加入者用偶数，两边永远不撞号。
  let nextStreamId = mux.STREAM_ID_CLIENT_START;
  // 一旦确认对面是老版本（等不到开场魔数），整局就退回单连接透传，不再反复试探。
  let legacyHost = !muxEnabled;
  let legacyAnnounced = false;
  let steam = null;
  let moduleRef = steamModule;
  let stopLoop = null;
  let offStateChange = null;
  let stopped = false;
  // 每秒延迟诊断（延迟专项 Phase 1）。只读，见 createNetLatencyDiag 的文件头。
  let latencyDiag = null;

  /** 按 Steam 连接句柄找回对应的本机客户端。 */
  const findByConnection = (connection) => {
    for (const peer of peers.values()) if (peer.connection === connection) return peer;
    return null;
  };

  /** 所有干道上正在跑的流总数 = 此刻有几条本机连接在用这条隧道。 */
  const countStreams = () => {
    let n = 0;
    for (const peer of peers.values()) n += peer.streams ? peer.streams.size : 0;
    return n;
  };

  /**
   * 干道断了、但**本机客户端那条 TCP 还活着**的流（规格 §十六 的 stream recovery）。
   *
   * 为什么值得救：加入者这边一条流就是浏览器/游戏的一条真实 TCP 连接。干道一断就
   * destroy 它，等于把这半局里所有正在传的东西一起作废 —— 页面重新加载、地图重新拉。
   * 而干道断掉的原因多数是"传输层打了个嗝"（中继换路、CM 抖一下），重新握手只要
   * 几十毫秒到一两秒（见 STREAM_MIGRATE_GRACE_MS）。所以先寄存，等新干道谈妥之后
   * 用**同一个流号、更高的世代**重新 OPEN 一次，两边原地复活。
   *
   * 键就是流号：加入者**这一侧**同一时刻只可能有一条活的流用这个号 —— 它对端自始至终
   * 只有房主一个，不存在"两个对端重号"这回事（重号只可能发生在房主那边，见房主侧
   * orphanStreams 的注释），所以这里用扁平表是安全的。
   */
  const orphanStreams = new Map();   // streamId -> stream

  /** 干道断了：把挂在它上面的流寄存在这里，**不动本机 socket**。 */
  const parkTrunkStreams = (peer, reason) => {
    if (!peer.streams || !peer.streams.size) return 0;
    const now = Date.now();
    let n = 0;
    for (const stream of [...peer.streams.values()]) {
      peer.streams.delete(stream.id);
      const sock = stream.localSocket || stream.socket;
      if (!sock || sock.destroyed) continue;
      stream.trunk = null;          // 没有归属干道：socket 上的 data 会攒进 parkQueue
      stream.parkedAt = now;
      const prev = orphanStreams.get(stream.id);
      if (prev && prev !== stream) { try { const p = prev.localSocket || prev.socket; p?.destroy(); } catch { /* ignore */ } }
      orphanStreams.set(stream.id, stream);
      n += 1;
    }
    stats.streams = countStreams();
    stats.streamsParked = (stats.streamsParked || 0) + n;
    if (n) emit('notice', { text: `干道断了，先把 ${n} 条本机连接寄存 ${STREAM_MIGRATE_GRACE_MS / 1000} 秒等新干道来接（原因：${reason}）` });
    return n;
  };

  /**
   * 新干道谈妥了：把寄存的流原地复活。
   *
   * 顺序很关键：**OPEN 必须先出去**，房主看到它才会把原来那个游戏端口的连接认回来，
   * 后面补发的字节才有地方落。世代 +1 是规格 §十七 的要求 —— 旧干道上迟到的字节
   * 带着旧世代，房主一看世代对不上就直接丢，不会写进复活后的流里。
   */
  const resumeOrphanStreams = (peer) => {
    if (!orphanStreams.size) return 0;
    let n = 0;
    for (const [id, stream] of [...orphanStreams]) {
      const sock = stream.localSocket || stream.socket;
      if (!sock || sock.destroyed) { orphanStreams.delete(id); continue; }
      if (peer.streams.size >= PEER_STREAM_MAX_PER_TRUNK) break;
      orphanStreams.delete(id);
      stream.generation += 1;
      stream.trunk = peer;
      stream.parkedAt = 0;
      stream.migrations = (stream.migrations || 0) + 1;
      peer.streams.set(id, stream);
      pushFrames(peer, [mux.encodeOpen(id, stream.generation)]);
      // 寄存期间浏览器/游戏继续发过来的字节，跟在 OPEN 后面按原顺序补发。
      if (stream.parkBytes) {
        const parked = stream.parkQueue.splice(0);
        stream.parkBytes = 0;
        for (const chunk of parked) pushFrames(peer, mux.encodeDataChunks(id, stream.generation, chunk));
      }
      n += 1;
    }
    stats.streams = countStreams();
    stats.streamsMigrated = (stats.streamsMigrated || 0) + n;
    if (n) emit('notice', { text: `新干道已谈妥，${n} 条本机连接原地复活（世代 +1，房主侧不会看到连接断开）` });
    return n;
  };

  /** 兜底：寄存超过宽限期还没等到新干道的流，真收掉，让客户端自己重连。 */
  const sweepOrphanStreams = (now = Date.now()) => {
    if (!orphanStreams.size) return 0;
    let gone = 0;
    for (const [id, stream] of [...orphanStreams]) {
      const sock = stream.localSocket || stream.socket;
      if (!sock || sock.destroyed) { orphanStreams.delete(id); continue; }
      if (now - stream.parkedAt < STREAM_MIGRATE_GRACE_MS) continue;
      orphanStreams.delete(id);
      gone += 1;
      stats.streamsMigrateExpired = (stats.streamsMigrateExpired || 0) + 1;
      try { sock.destroy(); } catch { /* ignore */ }
      if (firstGone(stream)) {
        emit('stream-left', {
          peer: '（无干道）',
          kind: 'TunnelClosed',
          reason: `干道断了以后 ${STREAM_MIGRATE_GRACE_MS}ms 内没能重新挂上`,
          ageMs: now - stream.bornAt,
          bytesToPeer: stream.bytesToPeer,
          bytesFromPeer: stream.bytesFromPeer,
        });
      }
    }
    return gone;
  };

  /**
   * 关掉一条通道（两个方向都收尾），并更新统计。
   *
   * 注意 peers 是按 peer.key 索引的：干道用对端 Steam 连接句柄当 key，老路径的透传连接
   * 用本机 socket 当 key。（0.14.0 之前还有一种"预热池成员"——socket 为 null、拿占位对象当
   * key，被浏览器领走时再换成真 socket；那个池子已经删了，见文件顶部 PEER_POOL 墓碑注释。）
   */
  const dropPeer = (peer, { closeConnection = true, parkStreams = true, closeReason = '数据流格式不对', closeKind = 'BadFraming' } = {}) => {
    if (!peer || peer.dropped) return;
    peer.dropped = true;
    // 干道死了，但上面那些本机连接（浏览器/游戏）很可能还活着 —— 规格 §十六：传输层
    // 断开不等于会话结束。先把流寄存在 orphanStreams 里等新干道来接（STREAM_MIGRATE_GRACE_MS 宽限），
    // 而不是反手把它们 destroy 掉。唯一的例外是协议错乱（parkStreams=false）：那种
    // 情况把字节原样搬到新干道上只会接着错，必须真收掉。
    if (peer.framed !== false && peer.streams && peer.streams.size) {
      if (parkStreams) parkTrunkStreams(peer, 'Steam 连接断开');
      else closeTrunkStreams(peer, closeReason, closeKind);
    }
    if (peer.reconnectTimer) { clearTimeout(peer.reconnectTimer); peer.reconnectTimer = null; }
    peers.delete(peer.key);
    stats.connections = peers.size;
    if (closeConnection && peer.connection != null) {
      try {
        if (steam?.networkingSockets?.isConnectionActive?.(peer.connection)) {
          steam.networkingSockets.closeConnection(peer.connection, 0, '本机客户端断开', true);
        }
      } catch { /* ignore */ }
      stats.activeConnections = Math.max(0, (stats.activeConnections || 1) - 1);
    }
    peer.connection = null;
    if (peer.socket) {
      // destroy() 会把还在写缓冲里的字节一起丢掉。刚搬过来的"最后一个响应"往往正躺在
      // 那里，所以有积压时走 end()：先冲干净再 FIN，字节才真的到得了本机客户端。
      try { if (!peer.socket.destroyed && peer.socket.writableLength > 0) peer.socket.end(); else peer.socket.destroy(); } catch { /* ignore */ }
    }
    if (peer.framed !== false) {
      // 干道（不是老路径的透传连接）死了：立刻拉起下一条。
      // 不这么做的话，最后一条干道断了就再也没人建，本机客户端会一直卡在排队或者
      // "连上了一个不存在的干道"上 —— 而重连恰恰是浏览器此刻唯一能做的事，得给它一条路。
      refillTrunks();
    }
  };

  /**
   * 悄悄重连一条"一个字节都没回来"的 Steam P2P 连接。
   *
   * 为什么要这么做：浏览器的每一条 TCP 连接都对应一条独立的 P2P 连接，一个首页就要开十几条。
   * 只要其中几条握手没成，页面就会一直转圈 —— 而失败的那几条其实重试一次多半就通了。
   * 重连期间本机客户端 socket 保持打开，数据继续进 peer.queue，连上后由 Connected 分支补发。
   */
  const schedulePeerReconnect = (peer) => {
    if (!peer || peer.dropped || peer.reconnectTimer) return;
    peer.reconnects += 1;
    peer.connected = false;
    const stale = peer.connection;
    peer.connection = null;
    if (stale != null) {
      try { steam.networkingSockets.closeConnection(stale, 0, '重连中', false); } catch { /* 已经断了也无所谓 */ }
      stats.activeConnections = Math.max(0, (stats.activeConnections || 1) - 1);
    }
    // 重放：把已经发出去、却一个字节都没回来的那段请求放回队列，新连接连上后重发。
    if (peer.replay && peer.replay.length) {
      const redo = Buffer.concat(peer.replay);
      if (redo.length && peer.queue.length < 256) peer.queue.push(redo);
      peer.replay = [];
      peer.replayBytes = 0;
    }
    // 新连接上还没有任何数据发出去 —— 旧连接队列里剩下的字节（若还有）没有任何意义：
    // 它们属于那条已经关掉的 P2P 连接，重发只会让对端收到重复字节。
    egress.clear(peer);
    peer.paused = false;
    peer.pausedAt = 0;
    peer.stalled = false;
    peer.lastProgressAt = 0;
    peer.lastSendAt = 0;
    stats.reconnects = (stats.reconnects || 0) + 1;
    peer.reconnectTimer = setTimeout(() => {
      peer.reconnectTimer = null;
      if (stopped || peer.dropped || peer.socket.destroyed || peer.connection != null) return;
      try {
        const connection = steam.networkingSockets.connectP2P(String(hostSteamId), 0);
        if (connection == null || connection === 0) throw makeError('ESTEAMCONNECT', 'Steam P2P 连接创建失败');
        peer.connection = connection;
        peer.attemptStartedAt = Date.now();
        stats.activeConnections = (stats.activeConnections || 0) + 1;
      } catch (err) {
        emit('error', { stage: 'steam-reconnect', error: { code: err.code || 'ESTEAMCONNECT', friendly: `重连 Steam P2P 失败：${err.message}`, message: err.message } });
        if (peer.reconnects < PEER_RECONNECT_MAX) schedulePeerReconnect(peer);
        else dropPeer(peer, { closeConnection: false });
      }
    }, PEER_RECONNECT_DELAY_MS * peer.reconnects);
    if (peer.reconnectTimer && peer.reconnectTimer.unref) peer.reconnectTimer.unref();
  };

  const emit = (type, payload) => {
    if (typeof onEvent !== 'function') return;
    try { onEvent(type, payload); } catch { /* 事件回调不允许影响转发 */ }
  };

  const sampleState = { lastPeerSampleAt: 0 };

  // ── 干道还没建起来时的排队（0.14.0）────────────────────────────────────────
  //
  // connectP2P 当场失败（房主还没进房间、Steam 没起来）时**不能**像老代码那样把本机
  // socket 直接掐掉：用户看到的是"点了没反应"，而浏览器的重试往往要等好几秒。
  // 也不能在这里等握手 —— 规格 §二十一：回调里绝不允许 await，浏览器那条连接必须
  // 立刻被受理。所以先把它挂在这条队列上，等 refillTrunks 建出干道再挂流。
  const pendingSockets = [];
  /** 排队的本机连接上限。再往上就是"Steam 一直没起来"，攒着只会白占内存。 */
  const PENDING_SOCKET_MAX = 32;
  /** 排队中的连接自己关掉时要把位置腾出来（浏览器取消导航、用户刷新都会发生）。 */
  const dropPendingSocket = (socket) => {
    const i = pendingSockets.indexOf(socket);
    if (i >= 0) pendingSockets.splice(i, 1);
  };

  /** 把这批排队的连接一次性作废（判定成老房主、或者会话停了）。 */
  const releasePendingSockets = (why) => {
    if (!pendingSockets.length) return 0;
    const n = pendingSockets.length;
    for (const socket of pendingSockets.splice(0)) {
      stats.dropped += 1;
      emit('stream-left', { peer: `本机客户端 :${socket.remotePort || '?'}`, kind: 'TunnelClosed', reason: why });
      try { if (!socket.destroyed) socket.destroy(); } catch { /* 断开失败不影响其它连接 */ }
    }
    return n;
  };

  // ── 流多路复用（0.14.0）───────────────────────────────────────────────────
  // 为什么要做：浏览器每开一条 TCP 连接，老版本就要现握手一次 Steam P2P，而这个握手是
  // **排队限速**的（实测单条 6.8 / 9.4 / 17.4 秒，最坏顶到 30 秒超时）。一个首页要开十几条
  // 连接，于是用户看到的永远是"页面/地图转不出来"。多路复用之后一局只握一次手，
  // 所有本机连接都作为"流"跑在同一条 Steam 干道上。

  /** 把一串已编码的帧排进干道的发送队列，并尽快发出去。 */
  const pushFrames = (peer, frames) => {
    if (!peer || peer.dropped || !frames.length) return;
    let shouldFlush = false;
    for (const frame of frames) if (queueOut(peer, frame, tuning.outFlushBytes, fairKey(frame, tuning))) shouldFlush = true;
    if (shouldFlush) {
      const written = flushPeerOut(steam, peer, sendChunk, tuning);
      if (written < 0) {
        stats.sendStalls += 1;
        emit('error', { stage: 'steam-send', error: { code: 'ESTEAMSEND', friendly: 'Steam 发送缓冲已满，已暂停读取本机连接等待排空', message: 'sendMessage buffer full' } });
      }
    } else {
      flushPeerOutSoon(steam, peer, sendChunk, tuning);
    }
  };

  /** 这条干道已经发出魔数、但**还没等到房主应答**（v2 未定帧），帧只能先扣在手里。 */
  const holdsFrames = (trunk) => trunk != null && !trunk.dropped && trunk.framed === null;

  /**
   * 干道还没定帧时，把要发的帧**扣住先不发**。
   *
   * 为什么不能直接发：对面可能压根不是 0.14.0 —— 老房主会把我们发的字节原样转发给游戏
   * 服务。OPEN 帧的头几个字节就会把 HTTP 请求头污染掉，那比慢更糟（请求直接失效）。
   * 所以魔数发出去之后，在等到房主应答之前一个字节都不再出去；听到应答之后由
   * flushHeldFrames 按原顺序补发。反过来判定成老房主时这些流只能作废（见 markLegacyHost）。
   */
  const holdFrames = (trunk, frames) => {
    if (!trunk.heldFrames) trunk.heldFrames = [];
    if (trunk.heldBytes == null) trunk.heldBytes = 0;
    for (const frame of frames) {
      /*
       * 上限按字节算（1 MiB，与 PEER_QUEUE_MAX_BYTES 同一个量级）：扣住的帧只在
       * "干道握手那一小会儿"存在，正常最多几十 KB；真涨到 1 MiB 说明对端一直不开口
       * 而客户端还在猛灌 —— 这时候继续攒只是把内存和延迟一起拖大，不如断开让客户端重连。
       */
      if (trunk.heldBytes + frame.length > PEER_QUEUE_MAX_BYTES) {
        stats.dropped += 1;
        // 帧头已经定稿（见 stream-mux.cjs）：[len:4][type:1][streamId:4]… —— 从第 5 字节
        // 起就是流号。只掐这一条流，不牵连干道上的其它流（规格 §二十五）。
        const streamId = frame.length >= mux.FRAME_HEADER ? frame.readUInt32BE(5) : 0;
        const stream = trunk.streams.get(streamId);
        if (stream) {
          trunk.streams.delete(streamId);
          stats.streams = countStreams();
          const sock = stream.localSocket || stream.socket;
          try { if (sock && !sock.destroyed) sock.destroy(); } catch { /* 断开失败不影响其它流 */ }
        }
        continue;
      }
      trunk.heldFrames.push(Buffer.from(frame));
      trunk.heldBytes += frame.length;
    }
  };

  /** 判定为多路复用之后，把扣住的帧按原顺序补发出去（顺序不能变：OPEN 必须排在最前）。 */
  const flushHeldFrames = (trunk) => {
    const frames = trunk.heldFrames;
    if (!frames || !frames.length) return;
    trunk.heldFrames = [];
    trunk.heldBytes = 0;
    pushFrames(trunk, frames);
  };

  /**
   * 丢掉某条流还扣在手里的帧。
   *
   * 为什么必须丢：本机客户端在定帧之前就断了，那条流已经没了；补发时留着的 DATA 帧
   * 会撞上一个房主那边根本没被 OPEN 过的流号 —— 房主只能记一次 dropped，白挨一发。
   */
  const dropHeldFramesFor = (trunk, streamId) => {
    const frames = trunk && trunk.heldFrames;
    if (!frames || !frames.length) return;
    const kept = [];
    let bytes = 0;
    for (const frame of frames) {
      if (frame.length >= mux.FRAME_HEADER && frame.readUInt32BE(5) === streamId) continue;
      kept.push(frame);
      bytes += frame.length;
    }
    trunk.heldFrames = kept;
    trunk.heldBytes = bytes;
  };

  /** 收到一帧。 */
  const handleStreamFrame = (peer, frame) => {
    const { type, streamId } = frame;
    if (streamId === mux.STREAM_ID_SESSION) {
      if (type === mux.TYPE.Ping) pushFrames(peer, [mux.encodePong()]);
      return;
    }
    const stream = peer.streams.get(streamId);
    if (type === mux.TYPE.Open) {
      // 客户端才是开流的那一方；房主给我们开流说明协议错乱。
      stats.dropped += 1;
      return;
    }
    if (!stream) { if (type !== mux.TYPE.Reset) stats.dropped += 1; return; }

    const verdict = mux.checkGeneration(frame, stream.generation);
    if (verdict === 'stale') { stats.staleFrames = (stats.staleFrames || 0) + 1; return; }
    if (verdict === 'future') {
      stats.dropped += 1;
      // 只掐这一条流，不牵连其它（规格 §二十五）。
      pushFrames(peer, [mux.encodeReset(streamId, stream.generation, mux.RESET_REASON.Protocol)]);
      peer.streams.delete(streamId);
      stats.streams = peer.streams.size;
      try { if (stream.socket && !stream.socket.destroyed) stream.socket.destroy(); } catch { /* ignore */ }
      return;
    }

    if (type === mux.TYPE.Data) {
      stream.bytesFromPeer += frame.payload.length;
      if (stream.localSocket && !stream.localSocket.destroyed) stream.localSocket.write(frame.payload);
      else if (stream.socket && !stream.socket.destroyed) stream.socket.write(frame.payload);
      else stats.dropped += 1;
      return;
    }
    if (type === mux.TYPE.Window) { stream.remoteCredit = mux.decodeWindowCredit(frame.payload); return; }
    if (type === mux.TYPE.Close) {
      // 房主的游戏服务把这条连接关了。**数据帧一定排在 CLOSE 前面**（同一个有序队列），
      // 所以这里把最后那段响应写完再 end 就行 —— 0.13.3 那个"最后一段字节丢掉"的坑
      // 在多路复用里从结构上就不存在了。
      const sock = stream.localSocket || stream.socket;
      if (sock && !sock.destroyed) sock.end();
      return;
    }
    if (type === mux.TYPE.Reset) {
      stats.streamsReset = (stats.streamsReset || 0) + 1;
      const sock = stream.localSocket || stream.socket;
      if (sock && !sock.destroyed) sock.destroy();
    }
  };

  const feedDecoder = (peer, chunk) => {
    let frames;
    try {
      frames = peer.decoder.push(chunk);
    } catch (err) {
      stats.failed += 1;
      emit('error', { stage: 'mux-decode', error: { code: err.code || 'EMUXFRAME', friendly: `Steam 数据流格式不对，已断开这条连接：${err.message}`, message: err.message } });
      // parkStreams: false —— 协议错乱时不寄存。把已经串了位的字节原样搬到新干道上，
      // 只会让错位继续传播；这里必须真收掉这条链路，让客户端从干净状态重来。
      dropPeer(peer, { closeConnection: true, parkStreams: false });
      return;
    }
    for (const frame of frames) handleStreamFrame(peer, frame);
  };

  /** 干道断了：挂在上面的所有流一起收摊（浏览器会自己重开，下一次会走别的干道）。 */
  const closeTrunkStreams = (peer, reason, kind = 'TunnelClosed') => {
    for (const stream of [...peer.streams.values()]) {
      peer.streams.delete(stream.id);
      const sock = stream.localSocket || stream.socket;
      try { if (sock && !sock.destroyed) sock.destroy(); } catch { /* ignore */ }
      if (firstGone(stream)) {
        emit('stream-left', {
          peer: `流 ${stream.id}`,
          kind,
          reason,
          ageMs: Date.now() - stream.bornAt,
          bytesToPeer: stream.bytesToPeer,
          bytesFromPeer: stream.bytesFromPeer,
        });
      }
    }
    stats.streams = countStreams();
  };

  /** 挑一条能干活的干道：已经谈妥多路复用、还没满、最闲的那条。 */
  const pickTrunk = () => {
    if (legacyHost) return null;
    let best = null;
    let bestLoad = Infinity;
    for (const peer of peers.values()) {
      if (peer.dropped || peer.legacy || peer.framed !== true) continue;
      if (!peer.connected || peer.connection == null) continue;
      if (peer.streams.size >= PEER_STREAM_MAX_PER_TRUNK) continue;
      // 流的条数 + 还没发出去的积压（按 64KB 折算）一起看，免得挑到一条正堵着的干道。
      const load = peer.streams.size + peerOutBytes(peer) / (64 * 1024);
      if (load < bestLoad) { bestLoad = load; best = peer; }
    }
    return best;
  };

  /**
   * 开一条干道。
   *
   * **故意先不开口**：老版本房主（≤0.13.3）收到我们主动发的魔数只会把它当成游戏流量
   * 原样转发给游戏服务，把请求头污染掉。所以先听 —— 0.14.0 的房主一接受连接就会先报
   * 魔数，听到了才谈得上多路复用；等不到就当老对端，这条干道退回单连接透传。
   *
   * 0.14.0 之前这里还有一个 `{ warm }` 参数，用来生成"预热池成员"（没有本机客户端、
   * 等浏览器来领）。池子已删，参数一并去掉 —— 干道就是干道，没有第二种用途。
   */
  const spawnTrunk = () => {
    if (stopped || peers.size >= maxConnections) return null;
    let connection;
    try {
      connection = steam.networkingSockets.connectP2P(String(hostSteamId), 0);
      if (connection == null || connection === 0) throw makeError('ESTEAMCONNECT', 'Steam P2P 连接创建失败');
    } catch {
      // 房主还没进房间、Steam 没起来等等 —— 安静地等下一次 refillTrunks。
      return null;
    }
    const peer = {
      key: { trunk: true },
      socket: null,
      legacy: legacyHost,
      framed: legacyHost ? false : null,   // null=还没听到对端开口
      decoder: mux.createFrameDecoder(),
      streams: new Map(),
      connection,
      connected: false,
      queue: [],
      out: [],
      bornAt: Date.now(),
      attemptStartedAt: Date.now(),
      bytesToPeer: 0,
      bytesFromPeer: 0,
      reconnects: 0,
      readyCounted: false,
      replay: [],
      replayBytes: 0,
      reconnectTimer: null,
      // 未定帧干道的救火记账（见 PEER_HELLO_RETRY_MS / retryUndecidedTrunks）
      helloSentAt: 0,
      helloAttempts: 0,
      // 定帧之前扣住的帧（见 holdFrames）。定帧之后一直是空的。
      heldFrames: [],
      heldBytes: 0,
    };
    peers.set(peer.key, peer);
    stats.connections = peers.size;
    stats.activeConnections = (stats.activeConnections || 0) + 1;
    if (peer.framed === null) {
      // **首包就是魔数**（见 PEER_HELLO_TIMEOUT_MS 上方：加入者先开口，房主应答）。
      // 为什么不能等房主先说：旧加入者不认识魔数，房主主动发就会污染它的 HTTP 响应 ——
      // 而升级顺序是"房主先升"，那个组合必然出现。
      // 也没有"等不到应答就退回老路径"的定时器：新版房主是被动应答的，用超时判定只会
      // 把新+新组合误判成老房主，把多路复用整个废掉。真等不到应答时，本机连接会一直
      // 停在排队或扣帧状态（客户端自己会超时重连），而不是被我们错误地改成透传。
      //
      // ★ 但"不退回老路径"不等于"什么都不做"：首包丢了必须重发，重发还不行就得换一条。
      // 这两件事由 retryUndecidedTrunks() 在泵里做（见 PEER_HELLO_RETRY_MS 的注释）。
      pushFrames(peer, [mux.encodeHello()]);
      peer.helloSentAt = Date.now();
      peer.helloAttempts = 1;
    }
    return peer;
  };

  /**
   * 判定出"对面是老房主"之后，把还停在未定帧干道上的流全部作废。
   *
   * 为什么只能作废、不能退回单连接：这些流的 OPEN 帧从来**没有发出去过**（干道还没定帧
   * 就不会发帧，见 holdFrames），所以退不回"这条 TCP 连接 = 一条 Steam 连接"的老模型 ——
   * 老模型要求整条干道从头到尾就是这一条流。与其偷偷改语义，不如干净地掐掉，让客户端重连：
   * 那时 legacyHost 已经是 true，重连会直接走老路径，数据一个字节都不会错位。
   *
   * 边界：这是**每个会话最多发生一次**的窗口 —— 从干道建好（发魔数）到收到房主第一个字节，
   * 正常是一两个 RTT（毫秒级），只有"对面是老房主"时才会走到这里，而那次之后所有连接都走
   * 已判定好的老路径。代价只落在"刚好在这个窗口里开出来的连接"上，最多几条。
   */
  const expireUndecidedStreams = (peer, reason) => {
    if (!peer || !peer.streams || !peer.streams.size) return 0;
    const expired = [];
    for (const stream of [...peer.streams.values()]) {
      peer.streams.delete(stream.id);
      expired.push(stream);
    }
    peer.heldFrames = [];
    peer.heldBytes = 0;
    stats.streams = countStreams();
    for (const stream of expired) {
      stats.dropped += 1;
      const sock = stream.localSocket || stream.socket;
      try { if (sock && !sock.destroyed) sock.destroy(); } catch { /* 断开失败不影响其它流 */ }
      if (firstGone(stream)) {
        emit('stream-left', {
          peer: `流 ${stream.id}`,
          kind: 'TunnelClosed',
          reason,
          ageMs: Date.now() - stream.bornAt,
          bytesToPeer: stream.bytesToPeer,
          bytesFromPeer: stream.bytesFromPeer,
        });
      }
    }
    return expired.length;
  };

  /**
   * 认定对面是老房主：整局退回单连接透传。
   *
   * 做成"整局一个判断"而不是"每条连接各判各的"——对面是什么版本，是这一局的性质，
   * 不是某条连接的偶发。学到一次就够了，后面开的连接不用再各等一次。
   *
   * 触发条件是**协议事实**，不是超时：我们一发魔数，新房子就会回魔数、老房主则会把
   * 字节原样转发给游戏端口并把游戏的响应回给我们 —— 于是我们收到的第一个字节就是
   * 非魔数。用超时判"是不是新版"会误伤新+新组合（见 PEER_HELLO_TIMEOUT_MS 上方）。
   */
  const markLegacyHost = (peer) => {
    if (peer && peer.framed === null) {
      peer.framed = false;
      peer.legacy = true;
      stats.legacyPeers = (stats.legacyPeers || 0) + 1;
    }
    if (!legacyHost) {
      legacyHost = true;
      // 已经谈妥多路复用的干道继续用（那条路本来就好），只是不再新开。
      for (const p of peers.values()) {
        if (p.framed === null) { p.framed = false; p.legacy = true; }
      }
      // 还停在未定帧干道上的流一条都发不出去，全部作废（见 expireUndecidedStreams）。
      // 这里的提示每条干道只可能触发一次，所以不做去重。
      for (const p of peers.values()) {
        const n = expireUndecidedStreams(p, '对面是老版本（没有多路复用），这条流作废：请客户端重连一次，重连会走单连接模式');
        if (n > 0) emit('notice', { text: `${n} 条本机连接排在一条还没谈妥的干道上，对面是老版本用不了多路复用，已让它们重连（重连走单连接模式）。` });
      }
      // 排队等干道的客户端同理：干道可能已经不会再来了，让它们重连去走老路径。
      releasePendingSockets('对面是老版本，排队中的连接一并作废');
    }
    if (!legacyAnnounced) {
      legacyAnnounced = true;
      emit('notice', { text: '对面像是旧版本（没有多路复用）：本次会话退回单连接模式。双方都升到 0.14.0 之后，一局只需握一次手，页面和地图就不用再等握手了。' });
    }
  };

  /** 有没有一条"还活着、还没被判定成老房主、还能再挂流"的干道。 */
  const hasLiveTrunk = () => {
    for (const peer of peers.values()) {
      if (peer.dropped || !peer.streams || peer.framed === false) continue;
      if (peer.streams.size >= PEER_STREAM_MAX_PER_TRUNK) continue;
      return true;
    }
    return false;
  };

  /**
   * 保证"活着且没满的干道"至少有 PEER_TRUNK_TARGET 条。够数就什么都不做。
   *
   * 为什么不是"先开三条放着"（规格 §三）：干道是长期连接，空闲不占带宽，但每多一条
   * 就是一次额外握手 —— 而握手正是这条线路上最贵的东西。真扛不住时该扩容的判据是
   * "这条干道满了"（PEER_STREAM_MAX_PER_TRUNK），由 pickTrunk 自然触发。
   */
  const refillTrunks = () => {
    if (stopped || legacyHost || !steam) return;
    if (hasLiveTrunk()) return;
    const created = spawnTrunk();
    if (created) {
      // 干道是**等会儿**才谈妥的，所以这里只负责"把干道建出来"，真正的挂流交给
      // 之后那次 refillTrunks（Connected、或者下一条本机连接进来时）。
      stats.trunkCreated = (stats.trunkCreated || 0) + 1;
    }
  };

  /**
   * 未定帧干道的救火（加入者侧，挂在泵上跑，不另起计时器）。
   *
   * 为什么必须有这件事：`hasLiveTrunk()` 把"还没定帧的干道"也算成活的，这是**故意的** ——
   * 否则每来一条本机连接都会再开一条干道。但它同时意味着：一旦某条未定帧的干道永远等不到
   * 房主应答（首包丢了，见 PEER_HELLO_RETRY_MS 的注释），`refillTrunks()` 就再也不会补新的，
   * 整局永久吊死在那条哑干道上。现场那次 292 秒零字节就是这么来的。
   *
   * 所以：等不到就重发魔数；重发到 PEER_HELLO_GIVEUP_MS 还等不到，就放弃这条、换一条重来。
   * 寄存中的流（orphanStreams）会原地等到新干道谈妥，本机连接一条都不用断。
   */
  const retryUndecidedTrunks = (now = Date.now()) => {
    if (stopped || legacyHost || !steam) return;
    // 两个窗口可以按环境变量调（SHL_STEAM_TRUNK_HELLO_RETRY_MS / _GIVEUP_MS），
    // 测试也靠它把等待压到几十毫秒，不然一条用例要跑 30 秒。
    const retryMs = tuning.trunkHelloRetryMs || PEER_HELLO_RETRY_MS;
    const giveupMs = tuning.trunkHelloGiveupMs || PEER_HELLO_GIVEUP_MS;
    for (const peer of [...peers.values()]) {
      if (peer.framed !== null || peer.dropped) continue;
      if (now - peer.bornAt >= giveupMs) {
        stats.trunkAbandoned = (stats.trunkAbandoned || 0) + 1;
        emit('notice', {
          text: `干道建起来了但 ${Math.round((now - peer.bornAt) / 1000)} 秒没等到房主应答`
            + `（共发了 ${peer.helloAttempts || 1} 次魔数），换一条重来 —— 本机连接原地等着，不用刷新页面`,
        });
        // dropPeer 会关掉这条 Steam 连接，并把它上面的流寄存起来（这里正常是 0 条：
        // pickTrunk 只认 framed === true，未定帧的干道根本挂不上流）。
        // **必须先把它从 peers 里摘掉再 refillTrunks** —— hasLiveTrunk() 认的就是 peers。
        dropPeer(peer, { parkStreams: true });
        refillTrunks();
        continue;
      }
      if (now - (peer.helloSentAt || peer.bornAt) < retryMs) continue;
      // 队列里还有没发出去的字节就别再塞：魔数大概已经在队里等着发了。
      // 只在"已经发出去、对端却没回"的情况下才补一条。
      if (peerOutBytes(peer)) continue;
      peer.helloSentAt = now;
      peer.helloAttempts = (peer.helloAttempts || 1) + 1;
      stats.trunkHelloResend = (stats.trunkHelloResend || 0) + 1;
      pushFrames(peer, [mux.encodeHello()]);
    }
  };

  /**
   * 干道建出来之后，把排队等着的本机连接挂上去。
   *
   * 顺序即先后（队列本身就是按到达顺序 push 的）：早到的连接先拿到流号，
   * 浏览器那种"主请求先发、子资源后发"的次序才不会被搅乱。
   */
  const drainPendingSockets = () => {
    if (!pendingSockets.length) return;
    for (const socket of [...pendingSockets]) {
      if (socket.destroyed) { dropPendingSocket(socket); continue; }
      const trunk = pickTrunk();
      if (!trunk) return;
      dropPendingSocket(socket);
      bindStream(socket, trunk);
      stats.totalPeers += 1;
      emit('client-added', { peer: `${socket.remoteAddress}:${socket.remotePort}`, trunk: true, queued: true });
    }
  };

  /**
   * 开一条流 = 本机客户端的一条 TCP 连接。
   *
   * 关键：**不等握手**。OPEN 帧和正文直接排进干道的队列，干道什么时候谈妥什么时候发，
   * 顺序天然正确。用户等的是"干道握手"，而干道是提前养好的，所以通常是 0 秒。
   */
  const bindStream = (socket, trunk) => {
    // 加入者是规格 §十一 里的 Client：只分配**偶数**流号，房主用奇数，两边永远不撞号。
    const streamId = nextStreamId;
    nextStreamId += 2;
    if (nextStreamId > 0xfffffffe) nextStreamId = mux.STREAM_ID_CLIENT_START;
    const stream = {
      id: streamId,
      generation: 1,          // 这条流的世代：transport 重建后 +1，用来丢旧连接的迟到帧
      socket,
      trunk,
      bornAt: Date.now(),
      bytesToPeer: 0,
      bytesFromPeer: 0,
      // 干道断开、这条流被寄存期间，浏览器/游戏继续发来的字节攒在这里（上限 STREAM_PARK_MAX_BYTES）。
      parkQueue: [],
      parkBytes: 0,
      parkedAt: 0,
      migrations: 0,
    };
    trunk.streams.set(streamId, stream);
    stats.streams = countStreams();
    stats.totalStreams = (stats.totalStreams || 0) + 1;
    socket.setNoDelay(true);
    // 干道正处于背压暂停时，新挂上来的流也一起暂停。
    if (trunk.paused) { try { socket.pause(); } catch { /* 暂停失败就继续按老路走 */ } }
    // 先发 OPEN，房主看到它才会去连游戏端口；正文跟在后面，顺序由同一个队列保证。
    // 但**定帧之前一个字节都不发**（见 holdFrames）：对面可能是老房主，OPEN 的帧头
    // 喂给游戏服务就是污染请求头。扣住，等听到魔数再按原顺序补发。
    if (holdsFrames(trunk)) holdFrames(trunk, [mux.encodeOpen(streamId, stream.generation)]);
    else pushFrames(trunk, [mux.encodeOpen(streamId, stream.generation)]);
    socket.on('data', (chunk) => {
      // 加入者侧真正在跑的"服务处理"就在这里（干道上的 MUX 路径）。老路径 bindLocalSocket
      // 那条只在没有干道时用，两条都要埋点，否则有干道时这一格永远是 UNAVAILABLE。
      const serveStartedAt = hrNow();
      stats.bytesToPeer += chunk.length;
      stats.packetsToPeer += 1;
      stream.bytesToPeer += chunk.length;
      // 一律读 stream.trunk，**不认闭包里的 trunk**：干道断了以后这条流会被重新挂到
      // 另一条干道上（resumeOrphanStreams），闭包里那条已经不是它的归属了。
      const owner = stream.trunk;
      if (!owner || owner.dropped) {
        // 寄存中：**攒着，别丢**。这些字节是浏览器正在发的请求正文，丢掉就是请求损坏；
        // 而寄存的初衷恰恰是"这半局不作废"。攒不下（超过 512 KiB）说明不是打嗝，
        // 这条流真没救了，断开让客户端自己重来。
        if (stream.parkBytes + chunk.length > STREAM_PARK_MAX_BYTES) {
          stats.dropped += 1;
          try { socket.destroy(); } catch { /* 断一条流不影响别的流 */ }
          if (latencyDiag) latencyDiag.recordServe({ ms: hrNow() - serveStartedAt, bytes: chunk.length });
          return;
        }
        stream.parkQueue.push(Buffer.from(chunk));
        stream.parkBytes += chunk.length;
        if (latencyDiag) latencyDiag.recordServe({ ms: hrNow() - serveStartedAt, bytes: chunk.length });
        return;
      }
      if (holdsFrames(owner)) {
        // 干道还在等房主开口：正文也一起扣住，否则它会在 OPEN 之前漏出去。
        holdFrames(owner, mux.encodeDataChunks(streamId, stream.generation, chunk));
        if (latencyDiag) latencyDiag.recordServe({ ms: hrNow() - serveStartedAt, bytes: chunk.length });
        return;
      }
      if (owner.framed !== true) {
        // 这条干道已经被判定成"老房主"：走老路径的连接不在这里，这条流已作废。
        stats.dropped += 1;
        if (latencyDiag) latencyDiag.recordServe({ ms: hrNow() - serveStartedAt, bytes: chunk.length });
        return;
      }
      pushFrames(owner, mux.encodeDataChunks(streamId, stream.generation, chunk));
      if (latencyDiag) latencyDiag.recordServe({ ms: hrNow() - serveStartedAt, bytes: chunk.length });
    });
    // 错误处理要保持文件里既有风格：socket 的错误（ECONNRESET 之类）属正常断开，
    // 后续 close 会把流清掉，这里不需要额外记账。
    socket.on('error', () => { /* 客户端断开属正常 */ });
    socket.on('close', () => {
      // 还扣在手里的帧要跟着这条流一起丢掉：这条流已经不会再有 OPEN 了，
      // 补发时那半条 DATA 会撞上一个房主那边根本不存在的流号。
      // 这条流此刻的归属干道（可能为空 —— 寄存期间本机客户端自己关掉了）。
      const owner = stream.trunk;
      dropHeldFramesFor(owner, streamId);
      // 寄存表里也要摘掉，否则这条已经关掉的本地连接会被清扫器当成"待重挂的流"，
      // 一路带到新干道上，凭空给房主多开一个游戏端口的连接。
      orphanStreams.delete(streamId);
      if (owner) owner.streams.delete(streamId);
      stats.streams = countStreams();
      if (owner && !owner.dropped && owner.framed === true) pushFrames(owner, [mux.encodeClose(streamId, stream.generation)]);
      if (firstGone(stream)) {
        emit('stream-left', {
          peer: `本机客户端 :${socket.remotePort || '?'}`,
          kind: 'LocalClientClosed',
          reason: '浏览器/游戏自己关掉了这条本机连接',
          ageMs: Date.now() - stream.bornAt,
          bytesToPeer: stream.bytesToPeer,
          bytesFromPeer: stream.bytesFromPeer,
        });
      }
    });
    return stream;
  };

  /**
   * Steam 说这条连接要关了，但**对端可能刚把最后一段数据交给我们**，它还躺在
   * Steam 的接收队列里没被泵走。泵是按 tick 跑的，而状态回调随时会来 —— 一旦
   * 这里先跑 dropPeer 把本机 socket 拆了，队列里那段数据就再没人读，浏览器只会
   * 看到"连接被关、什么都没收到"。
   *
   * 现场正是这个形状：房主的游戏服务"回完响应立刻关本地连接"（HTTP/1.0 /
   * Connection: close），房主随即收掉 Steam 连接，于是那段响应永远到不了浏览器，
   * 表现就是页面/地图加载不出来、刷新一下才好。
   *
   * 所以拆连接之前先把队列读干净、写进本机 socket（多路复用模式则交给流层路由）。
   */
  const drainReceivedInto = (peer) => {
    if (!peer || peer.connection == null) return 0;
    if (peer.framed !== true && (!peer.socket || peer.socket.destroyed)) return 0;
    let moved = 0;
    for (;;) {
      const batch = steam.networkingSockets.receiveMessages(peer.connection, tuning.maxMessageBatch) || [];
      if (!batch.length) break;
      for (const message of batch) {
        const data = Buffer.isBuffer(message.data) ? message.data : Buffer.from(message.data || []);
        stats.bytesFromPeer += data.length;
        stats.packetsFromPeer += 1;
        peer.bytesFromPeer += data.length;
        if (peer.framed === true) feedDecoder(peer, data);
        else if (!peer.socket.destroyed) peer.socket.write(data);
        else peer.queue.push(data);
        moved += 1;
      }
      if (batch.length < tuning.maxMessageBatch) break;
    }
    return moved;
  };


  const handleStateChange = (change) => {
    const peer = findByConnection(change.connection);
    if (!peer) return;
    const states = connectionStates(moduleRef);
    if (change.newState === states.Connected) {
      peer.connected = true;
      stats.sessionId = String(hostSteamId);
      if (peer.framed !== false) {
        // 多路复用干道：Steam 连上只代表"链路通了"，真正谈妥要等听到开场魔数（见 pump）。
        // 所以这里**不能**补发 peer.queue —— 那是老模型"连上之前的积压"，而干道的积压
        // 现在扣在 heldFrames 里，必须等定帧之后按帧序补发，否则 OPEN 会排在正文后面。
        // 也不在这里做重连：一条干道断了只是断一条，重连交给 refillTrunks 重新拉。
        if (!peer.readyCounted) { peer.readyCounted = true; stats.trunksReady = (stats.trunksReady || 0) + 1; }
        emit('peer-connected', { peer: `房主 ${hostSteamId}（Steam 干道已连上，等待开场魔数）`, mux: true });
        // 这条干道还在等魔数、还没满，refillTrunks 会看到"够数了"而不重复建。
        refillTrunks();
        return;
      }
      const pending = peer.queue.splice(0);
      for (let i = 0; i < pending.length; i++) {
        const result = sendChunk(steam, change.connection, pending[i], {
          channel: 'reliable',
          maxChunk: tuning.maxChunk,
          noNagle: tuning.noNagle,
          noDelay: tuning.noDelay,
        });
        if (!result?.success) {
          // 没发出去的（含这一条）放回出站队列队头交给泵重试。
          // 老代码在这里直接丢弃：连接刚建立的头几个包就缺了，对端一样永远等不到。
          egress.prepend(peer, pending.slice(i));
          stats.sendStalls += 1;
          break;
        }
      }
      emit('peer-connected', { peer: `房主 ${hostSteamId}（本机客户端 ${peer.socket ? peer.socket.remotePort || '?' : '?'}）` });
      return;
    }
    if (change.newState === states.ClosedByPeer || change.newState === states.ProblemDetectedLocally) {
      const info = peerCloseInfo(peer, change, states, Date.now());
      // 拆连接之前先把 Steam 接收队列里剩下的字节搬给本机客户端：
      // 对端常常是"发完最后一个响应就关"，那点字节不能因为我们收连接就丢掉。
      drainReceivedInto(peer);
      const attemptMs = peer.attemptStartedAt ? Date.now() - peer.attemptStartedAt : null;
      // 一个字节都没回来 ⇒ 这次握手或首包丢了。对方可能只是这一条连接没建成，
      // 悄悄重连一次比把浏览器的连接一起掐掉好得多（后者表现就是页面一直转圈）。
      // 但**只重试快失败**：慢失败（等满 Steam 的建连超时）说明链路在挣扎，
      // 再压三次握手只会把浏览器的等待拉长到几十秒，见 PEER_RETRY_FAST_MS 的注释。
      const fastFail = attemptMs != null && attemptMs < retryFastLimit;
      // peer.socket 只有老路径才有（干道的 socket 是 null），所以这里必须显式判空 ——
      // 干道重连不靠逐流重放，它整条重拉，语义完全不同（见上面的 mux 分支）。
      if (peer.socket && peer.bytesFromPeer === 0 && !peer.socket.destroyed && fastFail && peer.reconnects < PEER_RECONNECT_MAX) {
        emit('peer-left', { peer: `房主 ${hostSteamId}`, ...info, attemptMs, willRetry: true, retry: peer.reconnects + 1 });
        schedulePeerReconnect(peer);
        return;
      }
      if (firstGone(peer)) emit('peer-left', { peer: `房主 ${hostSteamId}`, ...info, attemptMs, retried: peer.reconnects });
      dropPeer(peer, { closeConnection: false });
      // 干道断了：挂在上面的流由 dropPeer **寄存**下来（规格 §十六：传输断开 ≠ 会话结束），
      // 本机连接一条都没断。这里立刻拉一条新干道 —— 它一谈妥就会把寄存的流原地复活
      // （resumeOrphanStreams），用户那边完全看不到这次断链。
      refillTrunks();
    }
  };

  const pump = () => {
    if (stopped) return 0;
    // 先发送本 tick 攒下的小包（合并成大消息）—— 这是吞吐的关键
    for (const peer of peers.values()) {
      pumpPeerBackpressure(steam, peer, tuning);
      resumeOrAbort(peer, flushPeerOut(steam, peer, sendChunk, tuning), tuning);
    }
    let handled = 0;
    // 「每轮 Steam 消息轮询 + 分发耗时」（延迟专项）：加入者侧是**逐干道**收，
    // 所以这里量的是"所有干道收一遍 + 分发给本地流"的合计。
    const pollStartedAt = hrNow();
    for (const peer of peers.values()) {
      if (peer.connection == null) continue;
      const messages = steam.networkingSockets.receiveMessages(peer.connection, tuning.maxMessageBatch) || [];
      handled += messages.length;
      for (const message of messages) {
        let data = Buffer.isBuffer(message.data) ? message.data : Buffer.from(message.data || []);
        stats.bytesFromPeer += data.length;
        stats.packetsFromPeer += 1;
        peer.bytesFromPeer += data.length;

        // ── 分帧判定（0.14.0）────────────────────────────────────────────────
        // 干道的首包是我们自己发的魔数（见 spawnTrunk），这里等的是**房主的应答**：
        // 收到魔数说明对面也是 0.14.0，这条 Steam 连接就是干道，本机所有连接作为流跑在上面。
        // 收到非魔数说明对面是老房主 —— 它把我们发的东西（含魔数）当成游戏流量转发了，
        // 于是这条干道报废，整局退回单连接透传。
        if (peer.framed === null) {
          if (mux.isOurHello(data)) {
            // 房主应答了：谈妥多路复用。
            peer.framed = true;
            peer.legacy = false;
            peer.connected = true;
            stats.muxPeers = (stats.muxPeers || 0) + 1;
            emit('peer-connected', { peer: `房主 ${hostSteamId}（多路复用干道，1 条 Steam 连接承载所有本机连接）`, mux: true });
            // 魔数后面可能紧跟真实帧（房主把 HELLO 应答和第一批帧合在一条消息里发出来）。
            const rest = data.subarray(mux.HELLO_BYTES.length);
            if (rest.length) feedDecoder(peer, rest);
            // 定帧之前扣住的帧现在才能发 —— 顺序保持原样，OPEN 在最前。
            flushHeldFrames(peer);
            // 干道谈妥了，先把排队等它、以及后面才到的本机连接挂上去。挂完若还有排队
            // （这条已满），refillTrunks 会再拉一条新干道把它们接走。
            drainPendingSockets();
            // 规格 §十六：上一条干道断掉时寄存下来的流，在这里原地复活 —— 同一个流号、
            // 世代 +1 重发 OPEN，房主侧把原来那个游戏端口连接认回来，两边都不用重来。
            resumeOrphanStreams(peer);
            refillTrunks();
            continue;
          }
          if (mux.isHello(data)) {
            // 魔数对、版本号不对：对面是另一个 0.14.x。这种只能退回单连接模式 ——
            // 帧格式不一致时硬解只会把这一局弄成随机错乱。
            stats.versionMismatch = (stats.versionMismatch || 0) + 1;
            emit('notice', { text: `对端的隧道协议版本是 ${mux.helloVersion(data)}，本机是 ${mux.MUX_VERSION} —— 这一局退回单连接模式（能用，但要慢很多），两边升到同一版即可恢复多路复用` });
            // 魔数这 7 个字节绝不能进游戏服务（房主侧 pump 对这种情况也是这么剥的）。
            if (data.length >= mux.HELLO_BYTES.length) data = data.subarray(mux.HELLO_BYTES.length);
            markLegacyHost(peer);
          } else {
            // 不是魔数 ⇒ 对面是老房主（≤0.13.3）。整局退回单连接透传，下面就走老路径。
            markLegacyHost(peer);
          }
        } else if (peer.framed === true) {
          // 房主可能因为我们补发魔数而多答一次（见 retryUndecidedTrunks）。这条干道早就
          // 谈妥了，迟到的应答必须吞掉 —— 它不是合法帧，喂进解码器会被当成帧头解出垃圾。
          if (mux.isOurHello(data)) {
            stats.helloRepeat = (stats.helloRepeat || 0) + 1;
            const rest = data.subarray(mux.HELLO_BYTES.length);
            if (rest.length) feedDecoder(peer, rest);
            continue;
          }
          feedDecoder(peer, data);
          continue;
        }

        // ── 老路径（legacy 透传）────────────────────────────────────────────
        // 对端已经开口了 —— 重放留档立刻作废（半程的响应没法重放）。
        if (peer.replay && peer.replay.length) { peer.replay = []; peer.replayBytes = 0; }
        if (peer.socket && !peer.socket.destroyed) peer.socket.write(data);
        else stats.dropped += 1;
      }
    }
    if (latencyDiag) latencyDiag.recordPoll({ ms: hrNow() - pollStartedAt, messages: handled });
    samplePeers({
      peers, steam, emit, state: sampleState,
    });
    // 寄存流的兜底清扫。**不另起计时器**（规格 §十八：整个网络层只允许一个统一调度器），
    // 挂在本来就 4ms 一轮的泵上，用时间戳把周期压到 ORPHAN_SWEEP_MS。
    const sweepNow = Date.now();
    if (orphanStreams.size && sweepNow - (sampleState.lastOrphanSweepAt || 0) >= ORPHAN_SWEEP_MS) {
      sampleState.lastOrphanSweepAt = sweepNow;
      sweepOrphanStreams(sweepNow);
    }
    // 未定帧干道的救火（重发魔数 / 放弃换新）。同样挂在泵上、同样用时间戳压到
    // ORPHAN_SWEEP_MS 一次 —— 这是"首包丢了就永久吊死"的唯一补救，见 retryUndecidedTrunks。
    if (sweepNow - (sampleState.lastTrunkRetryAt || 0) >= ORPHAN_SWEEP_MS) {
      sampleState.lastTrunkRetryAt = sweepNow;
      retryUndecidedTrunks(sweepNow);
    }
    return handled;
  };

  /**
   * 把一条本机客户端 socket 挂到 peer 上（老路径：一条本机连接 = 一条 Steam 连接）。
   * 监听器必须在拿去用之前就挂上，否则浏览器在挂上之前发来的字节会丢。
   */
  const bindLocalSocket = (peer, socket) => {
    peer.socket = socket;
    peer.key = socket;
    peer.boundAt = Date.now();
    peers.set(socket, peer);
    socket.setNoDelay(true);
    // 连接正处于背压暂停时，新绑上来的 socket 也一起暂停。
    if (peer.paused) { try { socket.pause(); } catch { /* 暂停失败就继续按老路走 */ } }

    socket.on('data', (chunk) => {
      const serveStartedAt = hrNow();
      stats.bytesToPeer += chunk.length;
      stats.packetsToPeer += 1;
      peer.bytesToPeer += chunk.length;
      if (peer.connection == null || !peer.connected) {
        // Steam P2P 还没连上：先缓存一点，连上后立刻补发（浏览器/RDP 都会先发数据）
        if (peer.queue.length < 256) peer.queue.push(Buffer.from(chunk));
        else {
          // 连上之前就积压了 256 块。丢掉最早那块同样是在可靠流上挖洞，
          // 与其带伤上路，不如断开让客户端重连一次。
          stats.dropped += 1;
          try { peer.socket.destroy(); } catch { /* 断开失败不影响其它连接 */ }
        }
        return;
      }
      // 合并发送（加入者=好友上行方向，MC 的小包主要走这里）
      if (queueOut(peer, chunk, tuning.outFlushBytes)) {
        const written = flushPeerOut(steam, peer, sendChunk, tuning);
        if (written < 0) {
          // 同上：数据留在 peer.out 里等泵重试，不丢。
          stats.sendStalls += 1;
          emit('error', { stage: 'steam-send', error: { code: 'ESTEAMSEND', friendly: 'Steam 发送缓冲已满，已暂停读取本机连接等待排空', message: 'sendMessage buffer full' } });
        }
      } else {
        // 没到阈值也别等下一个泵 tick：挂到本回合末尾就发，少等最多一个 tick 的时间。
        flushPeerOutSoon(steam, peer, sendChunk, tuning);
      }
      // 本机客户端那段字节：从 data 回调进门、到编码入队/发出的耗时（加入者侧的"服务处理"）。
      if (latencyDiag) latencyDiag.recordServe({ ms: hrNow() - serveStartedAt, bytes: chunk.length });
    });
    socket.on('error', () => { /* 客户端断开属正常 */ });
    socket.on('close', () => {
      if (firstGone(peer)) {
        const info = peerSample(peer, Date.now());
        emit('peer-left', {
          peer: `本机客户端 :${info.port}`,
          kind: peer.dropWhy ? 'LocalTunnelAbort' : 'LocalClientClosed',
          reason: peer.dropWhy || '浏览器/游戏自己关掉了这条本机连接',
          ...info,
        });
      }
      // 本机客户端关掉连接时，最后那点字节（比如浏览器的最后一次请求尾）可能还在
      // peer.out 里排队等 flushPeerOutSoon。先抽干再拆连接，别把它们留在队列里。
      drainThenClose({ peer, steam, sendChunk, tuning, stats, onDone: () => dropPeer(peer) });
    });
  };

  /**
   * 老房主模式（对面是 ≤0.13.3）下的受理路径 —— 也就是 0.13.x 原本那段代码，一行没改。
   *
   * 为什么整段留着：多路复用是靠**带内握手**谈出来的，谈不成就要能干净地退回"一条本机
   * 连接 = 一条 Steam 连接"。老模型在功能上完全够用（就是慢），而且现场升级顺序是
   * "房主先升、朋友后升"，所以这个组合一定会长期存在。
   */
  const acceptLegacy = (socket) => {
    const peer = {
      key: socket,
      socket,
      legacy: true,          // 老路径：写 peer.socket，不走帧
      framed: false,
      connection: null,
      connected: false,
      queue: [],
      out: [],
      bornAt: Date.now(),
      attemptStartedAt: 0,
      bytesToPeer: 0,
      bytesFromPeer: 0,
      reconnects: 0,
      replay: [],
      replayBytes: 0,
      reconnectTimer: null,
    };
    bindLocalSocket(peer, socket);
    stats.connections = peers.size;
    stats.totalPeers += 1;
    emit('client-added', { peer: `${socket.remoteAddress}:${socket.remotePort}` });

    // 老房主不认识帧（那还是 0.14.0 才有的东西），所以这里仍然是"每条本机连接一条
    // 独立的 Steam P2P 连接"。这是老版本**唯一**能用的语义，不是这次重构的目标。
    try {
      const connection = steam.networkingSockets.connectP2P(String(hostSteamId), 0);
      if (connection == null || connection === 0) throw makeError('ESTEAMCONNECT', 'Steam P2P 连接创建失败');
      peer.connection = connection;
      peer.attemptStartedAt = Date.now();
      stats.activeConnections = (stats.activeConnections || 0) + 1;
    } catch (err) {
      stats.failed += 1;
      emit('error', { stage: 'steam-connect', error: { code: err.code || 'ESTEAMCONNECT', friendly: `创建 Steam P2P 连接失败：${err.message}`, message: err.message } });
      socket.destroy();
      peers.delete(peer.key);
      stats.connections = peers.size;
      return;
    }
  };

  /**
   * 新受理路径（0.14.0）：本机连接变成干道上的一条**流**。
   *
   * 核心指标：**Steam 连接数与本机连接数无关**。浏览器开 25 条 TCP，这里也只会有 1 条
   * Steam 干道 —— 而握手（校园网下单条 6~30 秒）是这条线路上最贵的东西，25 次握手就是
   * "页面永远转不出来"的全部原因。
   *
   * 规格 §二十一：这个回调**绝不允许 await、绝不允许等握手**。浏览器那条连接必须在
   * 本回合内被受理完（拿不到干道就排队，见 pendingSockets），否则用户看到的就是卡住。
   */
  const acceptStream = (socket) => {
    if (stopped) { socket.destroy(); return; }
    let trunk = pickTrunk();
    if (!trunk) {
      // 没有能立刻用的干道：现建一条。connectP2P 是同步的，失败就返回 null。
      // 排在干道建立之前，浏览器这条连接是"零等待"的。
      refillTrunks();
      trunk = pickTrunk();
    }
    if (trunk) {
      bindStream(socket, trunk);
      stats.connections = peers.size;
      stats.totalPeers += 1;
      emit('client-added', { peer: `${socket.remoteAddress}:${socket.remotePort}`, trunk: true });
      // 干道满了就再拉一条（pickTrunk 已经跳过满的，所以这是"用完即补"）。
      refillTrunks();
      return;
    }
    // 连干道都建不出来（房主还没进房间、Steam 没起来）。**不能**像老代码那样直接掐掉
    // 这条连接：用户看到的是"点了没反应"，而浏览器的重试要等好几秒。
    // 挂进排队等下一次干道建好，客户端那边只是慢，不是错。
    if (pendingSockets.length >= PENDING_SOCKET_MAX) {
      stats.rejected += 1;
      emit('rejected', { reason: 'pending-full', peer: `${socket.remoteAddress}:${socket.remotePort}`, limit: PENDING_SOCKET_MAX });
      socket.destroy();
      return;
    }
    pendingSockets.push(socket);
    socket.setNoDelay(true);
    socket.on('error', () => { /* 客户端断开属正常 */ });
    socket.on('close', () => dropPendingSocket(socket));
    emit('notice', { text: `Steam 连接暂时建不起来，已把这条本机连接排队（当前 ${pendingSockets.length} 条）。干道一通就会挂上去，不需要刷新页面。` });
    refillTrunks();
  };

  const server = net.createServer((socket) => {
    if (stopped) { socket.destroy(); return; }
    if (peers.size >= maxConnections) {
      stats.rejected += 1;
      emit('rejected', { reason: 'max-connections', peer: `${socket.remoteAddress}:${socket.remotePort}`, limit: maxConnections });
      socket.destroy();
      return;
    }
    // 加入者这边**没有**"先听房主开口"这一步：首包由我们自己发（见 spawnTrunk 里的
    // pushFrames(encodeHello)）。等房主先说会打断旧加入者，代价大得多。
    if (legacyHost) acceptLegacy(socket);
    else acceptStream(socket);
  });

  const ready = new Promise((resolve, reject) => {
    server.once('error', (err) => {
      stats.failed += 1;
      const friendly = err.code === 'EADDRINUSE'
        ? `端口 ${listenPort} 已被占用：可能本程序已经启动了一个会话，或被其它软件占用。`
        : `本地入口端口监听失败：${err.message}`;
      reject(Object.assign(err, { friendly }));
    });
    server.listen(listenPort, bindHost, async () => {
      stats.startedAt = Date.now();
      try {
        const init = initSteamSdk({ appDir, appId, sdkPath, sdk, debug, netConfig: netConfigOptions, netConfigEnv, stats });
        steam = init.steam;
        if (!moduleRef) moduleRef = sdk ? null : loadSteamModule(appDir);
        const socketsApi = steam.networkingSockets;
        if (!socketsApi?.connectP2P) throw makeError('ESTEAMAPI', 'steamworks-ffi-node 未提供 networkingSockets 接口');
        offStateChange = socketsApi.onConnectionStateChange(handleStateChange);
        stopLoop = startCallbackLoop({
          label: 'STEAM',
          onNotice: (msg) => { try { emit('notice', { text: msg }); } catch (err) { /* 日志失败不影响转发 */ } },
          steam,
          pump,
          intervalMs: tuning.callbackIntervalMs,
          onFatal: (err) => emit('error', { stage: 'callbacks', error: { code: 'ESTEAMCALLBACK', friendly: `Steam 回调出错：${err.message}`, message: err.message } }),
        });
        // Phase 7：Relay 状态**不等第一次业务请求**才初始化（规格 §五）。
        // 走到这里说明 SDK 拿到了 Steam 实例、networkingSockets 可用 —— 这已经蕴含 Steam
        // 在线（真没登录的话 initSteamSdk 那一步就会抛出来）。不做二次探测，因为探测不到。
        relayMonitor.setNetUtils(steam.networkingUtils);
        relayMonitor.init();
        healthMonitor.setSteamLoggedOn(true);
        healthMonitor.setTransportReady(true);
        emit('listening', { protocol: 'STEAM', role: 'joiner', bindHost, port: listenPort, hostSteamId: String(hostSteamId) });
        // 隧道一起来就把干道先握上 —— 用户第一次开页面时它通常已经谈妥了，于是"零等待"。
        // 一条就够（PEER_TRUNK_TARGET）：干道空闲时不占带宽，多开一条只是多一次握手。
        refillTrunks();
        resolve({ host: bindHost, port: listenPort, hostSteamId: String(hostSteamId) });
      } catch (err) {
        stats.failed += 1;
        reject(err);
      }
    });
  });
  ready.catch(() => { /* 由调用方决定如何提示 */ });

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    // 唯一的调度器停了，它的采样与诊断计时器一起停 —— 不留孤儿计时器（规格 §十八 / §三十八-H）。
    try { healthScheduler.stop(); } catch { /* 停不下来也不能拦住关会话 */ }
    if (stopLoop) stopLoop();
    stopLoop = null;
    try { offStateChange?.(); } catch { /* ignore */ }
    // 还在排队等干道的本机连接要一起收掉：会话都停了，它们永远等不到干道了。
    releasePendingSockets('会话已停止');
    // parkStreams: false —— 会话都停了，没有"下一条干道"会来接这些流，寄存只是让它们
    // 多活 8 秒再被清扫器收掉。这里直接收摊，本机客户端立刻拿到断开、自己去重连。
    // kind/reason 要写清楚是"正常停止"：默认那对（BadFraming / 数据流格式不对）是给协议
    // 错乱用的，正常关会话却打这行，会让人以为隧道坏了（真机第一次跑就踩到了）。
    for (const peer of [...peers.values()]) dropPeer(peer, { parkStreams: false, closeReason: '会话正常停止', closeKind: 'SessionStopped' });
    // 更早之前断掉的那条干道寄存下来的流（还在等新干道）也要一起收掉。
    for (const stream of [...orphanStreams.values()]) {
      const sock = stream.localSocket || stream.socket;
      try { if (sock && !sock.destroyed) sock.destroy(); } catch { /* ignore */ }
    }
    orphanStreams.clear();
    peers.clear();
    stats.connections = 0;
    await new Promise((resolve) => server.close(() => resolve()));
    if (latencyDiag) { latencyDiag.dispose(); latencyDiag = null; }
    emit('stopped', {});
  };

  // ── Phase 7：网络健康（规格 §三十 / §三十一）─────────────────────────────────
  // 这一层**只读**：判定只在 network-health.cjs 的 linkState() 一处发生，日志与界面都拿它
  // 的快照，谁都不许再判一遍 —— "连接中"这种模糊词就是从"各处自己判一下"长出来的。
  // 每个字段都现场从 peers / stats 算出来，不另存一份镜像：镜像迟早会和真身不一致。
  const relayMonitor = relayStatus.createRelayStatusMonitor({
    onEvent: (type, payload) => emit(type, payload),
  });

  /** 干道峰值 + "曾经连上过几条"的累计：后者用 WeakSet 记，不持有 peer，不制造泄漏。 */
  let trunkPeak = 0;
  let trunksEverLive = 0;
  const liveSeen = new WeakSet();
  const queuedOutBytes = () => {
    let n = 0;
    for (const p of peers.values()) for (const chunk of (p.out || [])) n += chunk.length;
    return n;
  };
  const surveyPeers = () => {
    const all = [...peers.values()];
    const live = [];
    for (const p of all) {
      if (!p.connected) continue;
      live.push(p);
      if (!liveSeen.has(p)) { liveSeen.add(p); trunksEverLive += 1; }
    }
    if (live.length > trunkPeak) trunkPeak = live.length;
    return { all, live };
  };

  const managerShim = {
    health() {
      const { all, live } = surveyPeers();
      // 只报三种**事实**：连通了 / 有连接但还没通 / 一条都没有。
      // **不猜** BACKOFF，也不猜 DEGRADED —— 适配器这边没有足够证据区分它们，
      // 编一个出来只会让人对着面板去查一个不存在的问题（§三十一 不许模糊，同理也不许假）。
      const state = live.length
        ? CONN_STATE.CONNECTED
        : (all.length ? CONN_STATE.CONNECTING : CONN_STATE.DISCONNECTED);
      const prime = live.find((p) => p.framed === true) || live[0] || all[0] || null;
      return {
        steamConnectionsCreated: stats.totalPeers || 0,
        steamConnectionsSucceeded: trunksEverLive,
        steamConnectionsFailed: stats.failed || 0,
        steamConnectionsClosed: 0,
        activeSteamConnections: live.length,
        maxActiveSteamConnections: trunkPeak,
        failStreak: 0,
        lastFailure: null,
        queuedBytes: queuedOutBytes(),
        primary: prime
          ? {
            state,
            peer: prime.steamId != null ? String(prime.steamId) : String(hostSteamId),
            // 适配器不测 RTT：宁可让界面显示"—"，也不要编一个数出来。
            rtt: null,
            ageMs: prime.bornAt ? Date.now() - prime.bornAt : 0,
            attempt: 1,
            failureText: '',
            failureClass: '',
            retryInMs: null,
          }
          : null,
        // 规格 §三：Backup 是 0~1 条、**不强制存在**。适配器当前只有干道这一条路，如实报 null。
        backup: null,
      };
    },
  };

  const sessionShim = {
    health() {
      const { all, live } = surveyPeers();
      let paused = 0;
      for (const p of all) if (p.paused) paused += 1;
      return {
        // 会话停了就是 CLOSED；干道还在就是 ACTIVE；一条都没有就是 IDLE（"正在重连"由
        // primaryState 去表达）。适配器目前不区分 RECOVERING/DEGRADED —— 那是 Phase 6 的事，
        // 在那之前宁可不报，也不报一个自己都不信的中间态。
        state: stopped ? SESSION_STATE.CLOSED : (live.length ? SESSION_STATE.ACTIVE : SESSION_STATE.IDLE),
        activeStreams: countStreams(),
        streamsOpened: stats.totalStreams || 0,
        streamsClosed: stats.streamsClosed || 0,
        streamsReset: 0,
        staleFrames: 0,
        droppedFrames: stats.dropped || 0,
        queuedBytes: queuedOutBytes(),
        globalPaused: false,
        pausedStreams: paused,
      };
    },
  };

  const healthMonitor = createNetworkHealthMonitor({
    relay: relayMonitor,
    manager: managerShim,
    session: sessionShim,
    onEvent: (type, payload) => emit(type, payload),
    // 初值都是 false：SDK 还没起来之前不许显示"已就绪"。
    steamLoggedOn: false,
    transportReady: false,
  });

  // 整个网络层**只允许这一个调度器**（规格 §十八）：Relay 轮询、健康采样、诊断日志
  // 全部挂在它上面，不许每个 peer / 每个流 / 每个 socket 各起一个 setInterval。
  //
  // 刻度取 250ms 而不是默认的 4ms：4ms 是给数据泵用的忙刻度，诊断层不需要那么勤，
  // 拿它轮询 Relay 等于每秒问 Steam 250 次（纯浪费，还会把日志刷爆）。
  // 三个任务各自用 every 定自己的周期，互不牵连。
  const NET_POLL_INTERVAL_MS = Number.isFinite(options.netPollIntervalMs) && options.netPollIntervalMs > 0
    ? options.netPollIntervalMs
    : 5000;
  const NET_LOG_INTERVAL_MS = Number.isFinite(options.netLogIntervalMs) && options.netLogIntervalMs > 0
    ? options.netLogIntervalMs
    : 30000;
  const healthScheduler = createMuxScheduler({ intervalMs: 250, onEvent: (type, payload) => emit(type, payload) });
  healthScheduler.every('relay-poll', NET_POLL_INTERVAL_MS, () => relayMonitor.poll());
  healthScheduler.every('health-sample', NET_POLL_INTERVAL_MS, () => healthMonitor.sample());
  healthScheduler.every('net-log', NET_LOG_INTERVAL_MS, () => {
    const lines = healthMonitor.logLines();
    if (lines.length) emit('net-status', { lines, summary: healthMonitor.summaryLine() });
    healthMonitor.assertInvariants();
  });
  healthScheduler.start();

  // 每秒延迟诊断（延迟专项 Phase 1）：挂在上面那唯一一个调度器上，不另起计时器。
  latencyDiag = createNetLatencyDiag({
    role: 'joiner',
    logDir,
    scheduler: healthScheduler,
    sockets: () => (steam && steam.networkingSockets) || null,
    connections: () => [...peers.values()]
      .filter((p) => p.connected && p.connection != null)
      .map((p) => ({ connection: p.connection, label: p.steamId || String(p.connection) })),
    peers: () => peers,
    peerLabel: (p) => (p && (p.steamId || String(p.connection))) || '?',
    peerOutBytes: (p) => peerOutBytes(p),
    // 分流出站队列：能看出公平调度有没有真的把"大响应"和"小包"分开
    peerOutQueues: (p) => egress.queueRows(p),
    streamsOf: (p) => (p && p.streams) || [],
    counters: () => stats,
    onEvent: (type, payload) => emit(type, payload),
  });
  latencyDiag.start();

  const reportRoute = createRouteReporter(steam, stats);

  return {
    ready,
    stop,
    stats,
    isHost: false,
    // 规格 §三十一：界面拿这一份就够显示"Steam 在线 / Relay 可用 / P2P 已连 / 几条流 / RTT"，
    // 不需要自己再判一遍状态。读不到真实读数时字段是 null，界面显示"—"，不显示假状态。
    netState: () => healthMonitor.snapshot(),
    /** 每秒延迟诊断的最新一帧（只读）。 */
    latency: () => (latencyDiag ? latencyDiag.snapshot() : { available: false, reason: '诊断未启动' }),
    route: () => reportRoute([...peers.values()].filter((p) => p.connected && p.connection != null).map((p) => p.connection)),
    options: { role: 'joiner', protocol: 'STEAM', bindHost, localPort: listenPort, hostSteamId: String(hostSteamId), appId, maxConnections },
  };
}

// ---------------------------------------------------------------------------
// 隧道体检：定时把「每条连接走了多少字节、队列里还压着多少、Steam 自己怎么看这条连接」
// 报给上层，并在连接结束时带上**断开方与理由**。
//
// 为什么必须有：现场只能看到"游戏卡住了 / 敌人不出来"，看不到是哪一侧、在第几秒、
// 以什么理由把连接关掉的。这些信息 Steam 都给了（endReason / endDebugMessage /
// getDetailedConnectionStatus），只是以前读完就扔了。
// ---------------------------------------------------------------------------

/** 体检间隔：够密能看到趋势，又不至于把日志淹掉。 */
const PEER_SAMPLE_MS = 15000;

/**
 * 读 Steam 的连接详情（多行文本，含 Bytes buffered / Est avail bandwidth / 丢包率）。
 * 这是一次调用就能拿到的、唯一能区分「线路真慢」和「我们自己发得慢」的一手数据。
 */
function readConnectionStatus(steam, connection) {
  try {
    const sockets = steam && steam.networkingSockets;
    if (!sockets || connection == null || typeof sockets.getDetailedConnectionStatus !== 'function') return '';
    const text = sockets.getDetailedConnectionStatus(connection);
    return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, 220) : '';
  } catch { return ''; }
}

function peerSample(peer, now) {
  return {
    port: (peer.socket && peer.socket.remotePort) || 0,
    ageMs: peer.bornAt ? now - peer.bornAt : 0,
    outBytes: peerOutBytes(peer),
    bytesToPeer: peer.bytesToPeer || 0,
    bytesFromPeer: peer.bytesFromPeer || 0,
    paused: !!peer.paused,
    stalled: !!peer.stalled,
    // 多路复用之后"一条 Steam 连接"不等于"一条本机连接"，这两个字段必须一起看，
    // 否则日志会显示"只有 3 条连接"却跑着 20 个流，看起来像丢数据。
    streams: peer.streams ? peer.streams.size : 0,
    framed: peer.framed === true ? 'mux' : peer.framed === false ? 'legacy' : '',
  };
}

/** 连接结束时的完整交代：谁关的（对端 / 本地发现有问题）、Steam 给的理由、走了多少字节。 */
function peerCloseInfo(peer, change, states, now) {
  const info = (change && change.info) || {};
  return {
    kind: change && states && change.newState === states.ClosedByPeer ? 'ClosedByPeer' : 'ProblemDetectedLocally',
    endReason: info.endReason,
    reason: info.endDebugMessage || 'Steam P2P 连接断开',
    ...peerSample(peer, now),
  };
}

/** 同一条连接只允许报一次"结束" —— 本地 socket 与 Steam 两侧都会回调，重复行会把日志淹掉。 */
function firstGone(peer) {
  if (!peer || peer.goneReported) return false;
  peer.goneReported = true;
  return true;
}

function samplePeers({ peers, steam, emit, state, pool = null, now = Date.now() }) {
  if (!state || now - (state.lastPeerSampleAt || 0) < PEER_SAMPLE_MS) return;
  state.lastPeerSampleAt = now;
  const list = [];
  for (const peer of peers.values()) {
    list.push({ ...peerSample(peer, now), status: readConnectionStatus(steam, peer.connection) });
  }
  if (list.length || pool) emit('peer-stats', { peers: list, pool, at: now });
}

module.exports = {
  sendChunk,
  STEAM_ID_PATTERN,
  normalizeSteamId,
  resolveOwnSteamId,
  CALLBACK_INTERVAL_MS,
  DRAIN_BURST,
  startCallbackLoop,
  initSteamSdk,
  createSteamHost,
  createSteamJoiner,
  createRouteReporter,
  queueOut,
  flushPeerOut,
  flushPeerOutSoon,
  peerOutBytes,
  dropFromOut,
  applyBackpressure,
  resumeOrAbort,
  readSteamRealtimeStatus,
  steamBacklogBytes,
  sampleSteamBacklog,
  pumpPeerBackpressure,
  collectSourceSockets,
  pauseSourceSockets,
  resumeSourceSockets,
  STEAM_STATUS_MIN_INTERVAL_MS,
  PEER_OUT_HIGH_WATER,
  PEER_OUT_LOW_WATER,
  PEER_OUT_MAX_WATER,
  PEER_PAUSE_ABORT_MS,
};
