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
const { sampleRoute, summarize } = require('./route-report.cjs');
const { resolveLinkTuning } = require('./link-tuning.cjs');
const { applyNetConfig, formatNetConfigReport } = require('./steam-netconfig.cjs');

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
 * 做法：把本 tick 内读到的小包先攒在 peer.out，攒够 OUT_FLUSH_BYTES 立即发，
 * 否则由 pump 在每个 tick 末尾合并成一条较大的消息发出。延迟代价 ≤ 一个 tick
 * （名义 4ms，Windows 上真实约 14ms；有流量时主轮询后会补几次 setImmediate，实际更短）。
 */
function queueOut(peer, chunk, flushBytes = OUT_FLUSH_BYTES) {
  if (!peer.out) peer.out = [];
  peer.out.push(Buffer.from(chunk));
  let total = 0;
  for (const b of peer.out) total += b.length;
  return total >= flushBytes;
}
/** 积压到这个量就先停止从本地 socket 读，等泵把 Steam 缓冲排空。 */
const PEER_OUT_HIGH_WATER = 1 * 1024 * 1024;
/** 降到这个量以下再恢复读本地 socket（迟滞，避免读一下停一下）。 */
const PEER_OUT_LOW_WATER = 128 * 1024;
/** 还在涨说明对端长期不排空，这条连接已经坏了，只能主动断开。 */
const PEER_OUT_MAX_WATER = 8 * 1024 * 1024;
/** 暂停后这么久还一点都送不出去，就不再等了 —— 一直停着会让对端无限等待。 */
const PEER_PAUSE_ABORT_MS = 30000;
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

// 预热连接池（加入者侧）—— 0.13.0 加的，治的是"每次新开连接都要重新握手"这个结构病。
//
// 现场（0.12.8 的 startup.log）：浏览器要开 6 条并发连接才画得出一个首页，而
// **Steam 的 P2P 握手在这条线路上是"排队"的** —— 五条连接在 19:25:59 同一秒发起，
// 接通时间却依次是 +9.8s / +36s / +35s / +45s / +45s，一条接一条，每条间隔 2~4 秒。
// 也就是说握手本身被限速到大约"每 3 秒一条"，跟我们在不在本地排队无关（Steam 自己就在排队）。
// 后果：最后那几条必然撞上建连超时 → 掐掉 → 重试 → 更慢。地图/贴图全是新连接，于是
// "每次都无法加载出地图"。
//
// 解药不是让握手变快（我们做不到），而是**让它发生在用户看不到的时候**：
// 平时就把几条连好的 P2P 连接养在池子里，浏览器一开连接直接从池子里拿，
// 建连耗时为零。池子里的连接对房主只是一个"连上了但一句话没说"的对端，不占带宽。
const PEER_POOL_TARGET = 4;
// 池子里的连接死掉后的补货间隔。补货是后台行为，失败也不该刷屏，所以退避。
const PEER_POOL_RETRY_MS = 3000;
const PEER_POOL_RETRY_MAX_MS = 15000;
// 补货之间最短也要等一下：万一房主那边一直把连接秒关，也不至于变成死循环。
const PEER_POOL_MIN_GAP_MS = 250;
// 池子里的连接最多闲多久。房主那边每条连接都对应一个到游戏端口的本机 socket，
// 而游戏服务器（Node http）会在 ~60 秒（headersTimeout）后把"一句话没说"的连接关掉。
// 我们提前一点自己换新，池子里就永远是能用的。
const PEER_POOL_MAX_IDLE_MS = 45000;

/**
 * 从队列头部丢掉已经确认进了 Steam 发送缓冲的 n 个字节。
 *
 * 为什么不能整块重发：sendChunk 会按 maxChunk 把一块切成多条 Steam 消息，
 * 中途某一片失败时**前面的片已经进了可靠队列**。整块重发会把它们发第二遍，
 * 对端收到的字节流就多了一段 —— 那比丢数据更糟，TCP 层再也对不齐。
 * 所以只丢确认发出的前缀，剩下的留在队列里等下一次重试。
 */
function dropFromOut(peer, n) {
  let left = n;
  while (left > 0 && peer.out && peer.out.length) {
    const head = peer.out[0];
    if (head.length <= left) { left -= head.length; peer.out.shift(); }
    else { peer.out[0] = head.subarray(left); left = 0; }
  }
}

/**
 * 发送失败 = Steam 的发送缓冲满了（k_EResultLimitExceeded）。此时**必须停下来等**：
 * 继续从本地 socket 读，读进来也只能丢掉，而丢掉就是在可靠流上戳一个洞。
 * 做法是暂停本地 socket，等泵把积压发出去之后再恢复（见 pump 里的 resume）。
 */
function applyBackpressure(peer) {
  if (!peer || peer.stalled) return;
  const backlog = peerOutBytes(peer);
  if (backlog >= PEER_OUT_MAX_WATER) {
    // 积压到硬上限还是发不出去：这条 Steam 连接已经不健康了。
    // 主动断开，让浏览器/游戏看到一次干净的复位并自己重连 —— 比让它永远挂着强。
    peer.stalled = true;
    peer.dropWhy = `本机积压 ${Math.round(backlog / 1024)} KiB 超过硬上限，Steam 一直不接收`;
    try { peer.socket?.destroy(); } catch { /* 断开失败不影响其它连接 */ }
    return;
  }
  if (backlog >= PEER_OUT_HIGH_WATER && !peer.paused && peer.socket && !peer.socket.destroyed) {
    peer.paused = true;
    peer.pausedAt = Date.now();
    try { peer.socket.pause(); } catch { /* 暂停失败就继续按老路走 */ }
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
function resumeOrAbort(peer, written) {
  if (!peer || !peer.paused) return;
  if (written > 0 || peerOutBytes(peer) <= PEER_OUT_LOW_WATER) {
    peer.paused = false;
    peer.pausedAt = 0;
    try { peer.socket.resume(); } catch { /* 恢复失败会在 socket 的 close 里收尾 */ }
    return;
  }
  const idleSince = Math.max(peer.pausedAt || 0, peer.lastProgressAt || 0, peer.lastSendAt || 0);
  if (idleSince && Date.now() - idleSince > PEER_PAUSE_ABORT_MS) {
    peer.stalled = true;
    peer.dropWhy = `暂停后 ${Math.round((Date.now() - idleSince) / 1000)} 秒一个字节都没送出去`;
    try { peer.socket.destroy(); } catch { /* 断开失败会在 socket 的 close 里收尾 */ }
  }
}

function flushPeerOut(steam, peer, sendChunk, tuning = null) {
  if (!peer || !peer.out || !peer.out.length || peer.connection == null) return 0;
  const payload = peer.out.length === 1 ? peer.out[0] : Buffer.concat(peer.out);
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
    dropFromOut(peer, confirmed);
    // **只确认了前缀也算"在动"。**
    // 背压期间 Steam 缓冲是满的，几乎每次 flush 都只能确认头一片（见上），
    // 所以 lastSendAt（整块发完才更新）在慢速传输里几乎是冻结的。
    // resumeOrAbort 的 30 秒看门狗必须看这个"任何一个字节出去过"的时刻，
    // 否则一条还在慢慢吐数据的连接会被误判成死连接掐掉。
    peer.lastProgressAt = Date.now();
  }
  if (!result || !result.success) {
    applyBackpressure(peer);
    return -1;
  }
  peer.out = [];
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
    if (!peer.out || !peer.out.length || peer.connection == null) return;
    flushPeerOut(steam, peer, sendChunk, tuning);
  });
}
function peerOutBytes(peer) {
  if (!peer || !peer.out) return 0;
  let t = 0; for (const b of peer.out) t += b.length; return t;
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
    // 加入者侧预热连接池（0.13.0）：趁没人用的时候先把连接养好，浏览器一进来直接拿现成的。
    // 这四个数字是判断"用户到底还要不要等握手"的唯一依据：
    //   poolCreated 一共在后台开过几条、poolReady 其中真正握手成功的、
    //   poolHits 有多少条本机连接直接拿到了现成的（= 零等待）、poolMisses 没拿到只能现握手的。
    poolCreated: 0,
    poolReady: 0,
    poolHits: 0,
    poolMisses: 0,
    // 预热连接的**死因**要分开数，否则看不出池子是不是在白白抢握手名额：
    //   poolRetired 看门狗按寿命主动换新（计划内，一条换一条）；
    //   poolLost 自己断的（计划外，补货就是一次额外的 Steam 握手）；
    //   poolLifeMs 所有预热连接活过的毫秒总数，除以 (retired+lost) 就是平均寿命。
    poolRetired: 0,
    poolLost: 0,
    poolLifeMs: 0,
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
  const sampleState = { lastPeerSampleAt: 0 };

  const emit = (type, payload) => {
    if (typeof onEvent !== 'function') return;
    try { onEvent(type, payload); } catch { /* 事件回调不允许影响转发 */ }
  };

  const attachPeer = (connection, steamId) => {
    let peer = peers.get(connection);
    if (peer) return peer;
    peer = {
      connection,
      steamId,
      socket: net.createConnection({ host: gameHost, port: Number(gamePort) }),
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
      if (steam?.networkingSockets?.isConnectionActive(connection)) {
        steam.networkingSockets.closeConnection(connection, 0, '本地服务连接关闭', false);
      }
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
    emit('peer-joined', { peer: steamId || String(connection) });
    return peer;
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
        peer.socket.destroy();
        if (firstGone(peer)) emit('peer-left', { peer: peer.steamId || String(connection), ...info });
      }
    }
  };

  const pump = () => {
    if (stopped || !pollGroup) return 0;
    // 先发送本 tick 攒下的小包（合并成大消息）
    for (const peer of peers.values()) {
      resumeOrAbort(peer, flushPeerOut(steam, peer, sendChunk, tuning));
    }
    const messages = steam.networkingSockets.receiveMessagesOnPollGroup(pollGroup, tuning.maxMessageBatch) || [];
    for (const message of messages) {
      const peer = peers.get(message.connection);
      if (!peer) { stats.dropped += 1; continue; }
      const data = Buffer.isBuffer(message.data) ? message.data : Buffer.from(message.data || []);
      stats.bytesFromPeer += data.length;
      stats.packetsFromPeer += 1;
      peer.bytesFromPeer += data.length;
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
    }
    // 返回值供 startCallbackLoop 判断"这一轮有没有活"，决定下一次轮询是立刻还是退让。
    samplePeers({ peers, steam, emit, state: sampleState });
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
    for (const peer of peers.values()) { try { peer.socket.destroy(); } catch { /* ignore */ } }
    peers.clear();
    stats.peers = 0;
    stats.connections = 0;
    try { if (listenSocket != null && steam?.networkingSockets) steam.networkingSockets.closeListenSocket(listenSocket); } catch { /* ignore */ }
    try { if (pollGroup != null && steam?.networkingSockets) steam.networkingSockets.destroyPollGroup(pollGroup); } catch { /* ignore */ }
    listenSocket = null;
    pollGroup = null;
    emit('stopped', {});
  };

  const reportRoute = createRouteReporter(steam, stats);

  return {
    ready: ready.then((info) => info),
    stop,
    stats,
    isHost: true,
    route: () => reportRoute([...peers.values()].filter((p) => p.connected && p.connection != null).map((p) => p.connection)),
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
    poolGapMs = null,
    onEvent = null,
    debug = false,
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
  // 预热池目标条数。0 = 彻底关掉，退回"每条浏览器连接都现握手"的老行为。
  const poolTargetLimit = (() => {
    const raw = options.poolTarget != null ? options.poolTarget : process.env.SHL_STEAM_POOL;
    if (raw == null || String(raw).trim() === '') return PEER_POOL_TARGET;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 16) : PEER_POOL_TARGET;
  })();
  // 补货间隔。测试里调成 0 才跑得快；线上保持 250ms 是因为 Steam 本来就一条一条放行，
  // 同时压只会互相拖慢。
  const poolGapLimit = Number.isFinite(Number(poolGapMs)) && Number(poolGapMs) >= 0 ? Number(poolGapMs) : PEER_POOL_MIN_GAP_MS;
  const poolState = { timer: null, failStreak: 0 };
  let steam = null;
  let moduleRef = steamModule;
  let stopLoop = null;
  let offStateChange = null;
  let stopped = false;

  /** 按 Steam 连接句柄找回对应的本机客户端。 */
  const findByConnection = (connection) => {
    for (const peer of peers.values()) if (peer.connection === connection) return peer;
    return null;
  };

  /**
   * 关掉一条通道（两个方向都收尾），并更新统计。
   *
   * 注意 peers 是按 peer.key 索引的，不是按 socket —— 预热池里的连接还没有本机客户端
   * （socket 为 null），它用一个唯一的占位对象当 key，被浏览器领走时再换成真 socket。
   */
  const dropPeer = (peer, { closeConnection = true, warmWhy = '' } = {}) => {
    if (!peer || peer.dropped) return;
    peer.dropped = true;
    if (peer.reconnectTimer) { clearTimeout(peer.reconnectTimer); peer.reconnectTimer = null; }
    if (peer.poolWatchdog) { clearTimeout(peer.poolWatchdog); peer.poolWatchdog = null; }
    const wasWarm = peer.warm === true;
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
    if (peer.socket) { try { peer.socket.destroy(); } catch { /* ignore */ } }
    // 池子里的连接死了要补货；被领走再死的则不用（那是正常业务流量）。
    if (wasWarm) {
      // 池子里的连接死了要补货；被领走再死的则不用（那是正常业务流量）。
      //
      // 死因要分开记：看门狗按寿命主动换新是**计划内**的，一条换一条，池子不额外抢握手
      // 名额；自己断开是**计划外**的，补货就是一次额外的 Steam 握手。两者混在一起看
      // 不出来 —— 曾经出现过 150 秒造 44 条（按 4 槽 × 34 秒只该造 ~18 条）却查不出
      // 多出来的那些死在哪，现场日志里预热连接的死亡是静默的。
      const lived = Date.now() - (peer.bornAt || Date.now());
      stats.poolLifeMs = (stats.poolLifeMs || 0) + lived;
      if (warmWhy === 'watchdog') stats.poolRetired = (stats.poolRetired || 0) + 1;
      else stats.poolLost = (stats.poolLost || 0) + 1;
      // "连上过并且活了一会儿"才算一次成功，否则记一次失败用来退避 ——
      // 房主一直秒关的时候不能让补货变成死循环。
      poolState.failStreak = (peer.connected && Date.now() - peer.bornAt > 1000) ? 0 : poolState.failStreak + 1;
      refillPool();
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
    peer.out = [];
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

  const handleStateChange = (change) => {
    const peer = findByConnection(change.connection);
    if (!peer) return;
    const states = connectionStates(moduleRef);
    if (change.newState === states.Connected) {
      peer.connected = true;
      stats.sessionId = String(hostSteamId);
      if (peer.warm) {
        // 池子里的连接连上了。给它一个寿命上限：房主那边每条连接都对应一个到游戏端口的
        // 本机 socket，而游戏服务器 ~60 秒（Node 的 headersTimeout）就会把"一句话没说"
        // 的连接关掉。与其等它被关掉再补货，不如主动换新，池子里永远是新鲜的。
        //
        // 寿命要**抖开**：几条预热连接是在同一秒里养起来的，如果都用同一个到期时间，
        // 它们会一起死、一起重握，正好撞上用户此刻的真实连接 —— 白白排在它前面。
        // 只数一次：真实 Steam 上同一条连接会不止一次报 Connected（中继换路会重报），
        // 不设这个开关的话"就绪"会比"累计开"还大，看着像池子开了双份。
        if (!peer.readyCounted) { peer.readyCounted = true; stats.poolReady = (stats.poolReady || 0) + 1; }
        if (peer.poolWatchdog) clearTimeout(peer.poolWatchdog);
        const idleMs = Math.round(PEER_POOL_MAX_IDLE_MS * (0.6 + Math.random() * 0.3));
        peer.poolWatchdog = setTimeout(() => {
          peer.poolWatchdog = null;
          if (peer.warm && !peer.dropped) dropPeer(peer, { closeConnection: true, warmWhy: 'watchdog' });
        }, idleMs);
        if (peer.poolWatchdog.unref) peer.poolWatchdog.unref();
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
          // 没发出去的（含这一条）放回 peer.out 交给泵重试。
          // 老代码在这里直接丢弃：连接刚建立的头几个包就缺了，对端一样永远等不到。
          peer.out.unshift(...pending.slice(i));
          stats.sendStalls += 1;
          break;
        }
      }
      emit('peer-connected', { peer: `房主 ${hostSteamId}（本机客户端 ${peer.socket ? peer.socket.remotePort || '?' : '?'}）` });
      return;
    }
    if (change.newState === states.ClosedByPeer || change.newState === states.ProblemDetectedLocally) {
      const info = peerCloseInfo(peer, change, states, Date.now());
      if (peer.warm) {
        // 池子里的连接死了：没有人在等它，安静丢掉，补货交给 refillPool。
        dropPeer(peer, { closeConnection: false, warmWhy: 'peer-closed' });
        return;
      }
      const attemptMs = peer.attemptStartedAt ? Date.now() - peer.attemptStartedAt : null;
      // 一个字节都没回来 ⇒ 这次握手或首包丢了。对方可能只是这一条连接没建成，
      // 悄悄重连一次比把浏览器的连接一起掐掉好得多（后者表现就是页面一直转圈）。
      // 但**只重试快失败**：慢失败（等满 Steam 的建连超时）说明链路在挣扎，
      // 再压三次握手只会把浏览器的等待拉长到几十秒，见 PEER_RETRY_FAST_MS 的注释。
      const fastFail = attemptMs != null && attemptMs < retryFastLimit;
      if (peer.bytesFromPeer === 0 && !peer.socket.destroyed && fastFail && peer.reconnects < PEER_RECONNECT_MAX) {
        emit('peer-left', { peer: `房主 ${hostSteamId}`, ...info, attemptMs, willRetry: true, retry: peer.reconnects + 1 });
        schedulePeerReconnect(peer);
        return;
      }
      if (firstGone(peer)) emit('peer-left', { peer: `房主 ${hostSteamId}`, ...info, attemptMs, retried: peer.reconnects });
      dropPeer(peer, { closeConnection: false });
    }
  };

  const pump = () => {
    if (stopped) return 0;
    // 先发送本 tick 攒下的小包（合并成大消息）—— 这是吞吐的关键
    for (const peer of peers.values()) {
      resumeOrAbort(peer, flushPeerOut(steam, peer, sendChunk, tuning));
    }
    let handled = 0;
    for (const peer of peers.values()) {
      if (peer.connection == null) continue;
      const messages = steam.networkingSockets.receiveMessages(peer.connection, tuning.maxMessageBatch) || [];
      handled += messages.length;
      for (const message of messages) {
        const data = Buffer.isBuffer(message.data) ? message.data : Buffer.from(message.data || []);
        stats.bytesFromPeer += data.length;
        stats.packetsFromPeer += 1;
        peer.bytesFromPeer += data.length;
        // 对端已经开口了 —— 重放留档立刻作废（半程的响应没法重放）。
        if (peer.replay && peer.replay.length) { peer.replay = []; peer.replayBytes = 0; }
        if (peer.socket && !peer.socket.destroyed) peer.socket.write(data);
        else stats.dropped += 1;
      }
    }
    samplePeers({
      peers, steam, emit, state: sampleState,
      // 池子状态一起报出去：现场只要看"命中/未命中"，就知道用户还要不要等握手。
      pool: { target: poolTargetLimit, warm: warmCount(), created: stats.poolCreated, ready: stats.poolReady, hits: stats.poolHits, misses: stats.poolMisses, retired: stats.poolRetired, lost: stats.poolLost, lifeMs: stats.poolLifeMs },
    });
    return handled;
  };

  // ── 预热连接池 ────────────────────────────────────────────────────────────
  // 见文件顶部 PEER_POOL_TARGET 的长注释：握手是排队限速的，唯一的解法是
  // 让它在用户看不见的时候完成。这里负责"养着几条连好但还没人用的 P2P 连接"。

  /** 池子里活着的、已经连上、还没有本机客户端的连接有几条。 */
  const warmCount = () => {
    let n = 0;
    for (const peer of peers.values()) if (peer.warm && !peer.dropped) n += 1;
    return n;
  };

  /** 从池子里领一条已经连上的连接。领不到返回 null，调用方照旧现握手。 */
  const takeWarmPeer = () => {
    for (const peer of peers.values()) {
      if (!peer.warm || peer.dropped || !peer.connected || peer.connection == null) continue;
      peer.warm = false;
      if (peer.poolWatchdog) { clearTimeout(peer.poolWatchdog); peer.poolWatchdog = null; }
      peers.delete(peer.key);
      return peer;
    }
    return null;
  };

  /** 之后按退避补货。poolState.timer 保证同时只有一次补货在跑。 */
  const refillPool = () => {
    if (stopped || poolTargetLimit <= 0 || poolState.timer) return;
    if (warmCount() >= poolTargetLimit) return;
    const delay = poolState.failStreak > 0
      ? Math.min(PEER_POOL_RETRY_MS * poolState.failStreak, PEER_POOL_RETRY_MAX_MS)
      : poolGapLimit;
    poolState.timer = setTimeout(() => {
      poolState.timer = null;
      if (stopped || warmCount() >= poolTargetLimit) return;
      // 一次只开一条：Steam 那边本来就是一条一条放行的，同时压只会互相拖慢。
      const created = spawnWarmPeer();
      if (!created) poolState.failStreak += 1;
      else poolState.failStreak = 0;
      refillPool();
    }, delay);
    if (poolState.timer && poolState.timer.unref) poolState.timer.unref();
  };

  /**
   * 开一条"没有本机客户端"的 P2P 连接放进池子。
   *
   * key 用唯一占位对象而不是 socket：peers 是按 key 索引的，池子里的成员还没有 socket。
   * 被浏览器领走时 takeWarmPeer 会把它从旧 key 摘下来，再由 bindLocalSocket 用真 socket 挂上去。
   */
  const spawnWarmPeer = () => {
    if (stopped || peers.size >= maxConnections) return null;
    let connection;
    try {
      connection = steam.networkingSockets.connectP2P(String(hostSteamId), 0);
      if (connection == null || connection === 0) throw makeError('ESTEAMCONNECT', 'Steam P2P 连接创建失败');
    } catch {
      // 房主还没进房间、Steam 没起来等等 —— 这是后台预热，安静地等下一次。
      return null;
    }
    const peer = {
      key: { warm: true },
      socket: null,
      warm: true,
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
      poolWatchdog: null,
    };
    peers.set(peer.key, peer);
    stats.connections = peers.size;
    stats.poolCreated = (stats.poolCreated || 0) + 1;
    stats.activeConnections = (stats.activeConnections || 0) + 1;
    return peer;
  };

  /**
   * 把一条本机客户端 socket 挂到 peer 上（新开的和从池子里领来的走同一条路）。
   * 监听器必须在拿去用之前就挂上，否则浏览器在挂上之前发来的字节会丢。
   */
  const bindLocalSocket = (peer, socket) => {
    peer.socket = socket;
    peer.key = socket;
    peer.boundAt = Date.now();
    peers.set(socket, peer);
    socket.setNoDelay(true);

    socket.on('data', (chunk) => {
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
      dropPeer(peer);
    });
  };

  const server = net.createServer((socket) => {
    if (stopped) { socket.destroy(); return; }
    if (peers.size >= maxConnections) {
      stats.rejected += 1;
      emit('rejected', { reason: 'max-connections', peer: `${socket.remoteAddress}:${socket.remotePort}`, limit: maxConnections });
      socket.destroy();
      return;
    }
    // 池子里有连好的就直接用 —— 浏览器这条连接的建连耗时就是 0。
    // 这是"地图/贴图每次都要重新握手、于是永远加载不出来"的解药，见 PEER_POOL_TARGET。
    const warm = takeWarmPeer();
    if (warm) {
      bindLocalSocket(warm, socket);
      stats.connections = peers.size;
      stats.totalPeers += 1;
      stats.poolHits = (stats.poolHits || 0) + 1;
      emit('client-added', { peer: `${socket.remoteAddress}:${socket.remotePort}`, warm: true, waitedMs: Date.now() - warm.bornAt });
      refillPool();
      return;
    }

    const peer = {
      key: socket,
      socket,
      warm: false,
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
      poolWatchdog: null,
    };
    bindLocalSocket(peer, socket);
    stats.connections = peers.size;
    stats.totalPeers += 1;
    // 池子空了才会走到这里 —— 这条连接的用户得等一次完整握手。这个数字只涨不跌，
    // 现场只要看它就知道池子到底有没有起作用（0 = 用户一次都没等过）。
    stats.poolMisses = (stats.poolMisses || 0) + 1;
    emit('client-added', { peer: `${socket.remoteAddress}:${socket.remotePort}` });

    // 每条本机连接对应一条独立的 Steam P2P 连接 —— 这是「通用内网穿透」的关键：
    // 浏览器、RDP、游戏等都会开多条并发连接，一条隧道只能扛一路。
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
    // 池子被领走一条就补一条 —— 补货在后台，不挡任何人的路。
    refillPool();
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
        emit('listening', { protocol: 'STEAM', role: 'joiner', bindHost, port: listenPort, hostSteamId: String(hostSteamId) });
        // 隧道一起来就开始养池子 —— 越早养好，浏览器第一次开页面就越不用等握手。
        refillPool();
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
    if (poolState.timer) { clearTimeout(poolState.timer); poolState.timer = null; }
    if (stopLoop) stopLoop();
    stopLoop = null;
    try { offStateChange?.(); } catch { /* ignore */ }
    for (const peer of [...peers.values()]) dropPeer(peer);
    peers.clear();
    stats.connections = 0;
    await new Promise((resolve) => server.close(() => resolve()));
    emit('stopped', {});
  };

  const reportRoute = createRouteReporter(steam, stats);

  return {
    ready,
    stop,
    stats,
    isHost: false,
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
  PEER_OUT_HIGH_WATER,
  PEER_OUT_LOW_WATER,
  PEER_OUT_MAX_WATER,
  PEER_PAUSE_ABORT_MS,
};
