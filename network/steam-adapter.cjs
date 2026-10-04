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

const CALLBACK_INTERVAL_MS = 16;
const DEFAULT_MAX_PEERS = 16;
const STEAM_ID_PATTERN = /^7656119\d{10,}$/;
const MAX_MESSAGE_BATCH = 128;

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
function initSteamSdk({ appDir, appId, sdkPath, sdk, debug = false } = {}) {
  if (sdk) return { steam: sdk, injected: true };
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
  if (steam.networkingUtils?.initRelayNetworkAccess) steam.networkingUtils.initRelayNetworkAccess();
  if (steam.networkingSockets?.initAuthentication) steam.networkingSockets.initAuthentication();
  return { steam, injected: false };
}

/** 共享的「跑回调 + 收消息」循环。 */
function startCallbackLoop({ steam, pump, onFatal }) {
  const timer = setInterval(() => {
    try {
      steam.runCallbacks?.();
      steam.networkingSockets?.runCallbacks?.();
      pump();
    } catch (err) {
      onFatal?.(err);
    }
  }, CALLBACK_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
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
    failed: 0,
    encrypted: true, // Steam 通道自带加密与身份认证
    sessionId: null,
    startedAt: null,
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
    onEvent = null,
    debug = false,
  } = options;

  if (!Number.isInteger(Number(gamePort)) || Number(gamePort) < 1 || Number(gamePort) > 65535) {
    throw makeError('EINVALIDPORT', '本地服务端口必须是 1–65535 的整数');
  }

  const stats = createStats('host');
  const peers = new Map(); // connection -> { connection, steamId, socket, connected, queue }
  let steam = null;
  let moduleRef = steamModule;
  let listenSocket = null;
  let pollGroup = null;
  let stopLoop = null;
  let offStateChange = null;
  let stopped = false;

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
      const active = steam.networkingSockets.isConnectionActive(connection);
      if (!active) { stats.dropped += 1; return; }
      const result = steam.networkingSockets.sendReliable(connection, chunk);
      if (!result?.success) { stats.dropped += 1; emit('error', { stage: 'steam-send', error: { code: 'ESTEAMSEND', friendly: '发送到 Steam 对端失败', message: 'sendReliable failed' } }); }
    });
    peer.socket.on('error', (err) => {
      stats.failed += 1;
      emit('error', { stage: 'game-socket', error: { code: err.code, friendly: `连接本地服务端口失败：${err.message}`, message: err.message } });
      peer.socket.destroy();
    });
    peer.socket.on('close', () => {
      peers.delete(connection);
      stats.peers = peers.size;
      stats.connections = peers.size;
      if (steam?.networkingSockets?.isConnectionActive(connection)) {
        steam.networkingSockets.closeConnection(connection, 0, '本地服务连接关闭', false);
      }
      emit('peer-left', { peer: steamId || String(connection) });
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
      if (change.info && change.info.listenSocket === 0) return;
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
        peers.delete(connection);
        stats.peers = peers.size;
        stats.connections = peers.size;
        peer.socket.destroy();
        emit('peer-left', { peer: peer.steamId || String(connection), reason: change.info?.endDebugMessage || '' });
      }
    }
  };

  const pump = () => {
    if (stopped || !pollGroup) return;
    const messages = steam.networkingSockets.receiveMessagesOnPollGroup(pollGroup, MAX_MESSAGE_BATCH) || [];
    for (const message of messages) {
      const peer = peers.get(message.connection);
      if (!peer) { stats.dropped += 1; continue; }
      const data = Buffer.isBuffer(message.data) ? message.data : Buffer.from(message.data || []);
      stats.bytesFromPeer += data.length;
      stats.packetsFromPeer += 1;
      if (!peer.connected) { peer.queue.push(data); if (peer.queue.length > 256) peer.queue.shift(); continue; }
      peer.socket.write(data);
    }
  };

  const ready = (async () => {
    const init = initSteamSdk({ appDir, appId, sdkPath, sdk, debug });
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
      steam,
      pump,
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

  return {
    ready: ready.then((info) => info),
    stop,
    stats,
    isHost: true,
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
    onEvent = null,
    debug = false,
  } = options;

  const listenPort = Number(localPort);
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) throw makeError('EINVALIDPORT', '本地入口端口必须是 1–65535 的整数');
  if (!STEAM_ID_PATTERN.test(String(hostSteamId || ''))) throw makeError('EINVALIDSTEAMID', '房主 SteamID 格式不正确（应以 7656119 开头的 17 位数字）');

  const stats = createStats('joiner');
  const peers = new Map(); // localSocket -> { socket, connection, connected, queue }
  const maxConnections = Number(options.maxConnections) > 0 ? Number(options.maxConnections) : DEFAULT_MAX_PEERS;
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

  /** 关掉一条通道（两个方向都收尾），并更新统计。 */
  const dropPeer = (peer, { closeConnection = true } = {}) => {
    if (!peer || peer.dropped) return;
    peer.dropped = true;
    peers.delete(peer.socket);
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
    try { peer.socket.destroy(); } catch { /* ignore */ }
  };

  const emit = (type, payload) => {
    if (typeof onEvent !== 'function') return;
    try { onEvent(type, payload); } catch { /* 事件回调不允许影响转发 */ }
  };

  const handleStateChange = (change) => {
    const peer = findByConnection(change.connection);
    if (!peer) return;
    const states = connectionStates(moduleRef);
    if (change.newState === states.Connected) {
      peer.connected = true;
      stats.sessionId = String(hostSteamId);
      for (const chunk of peer.queue.splice(0)) {
        const result = steam.networkingSockets.sendReliable(change.connection, chunk);
        if (!result?.success) stats.dropped += 1;
      }
      emit('peer-connected', { peer: `房主 ${hostSteamId}（本机客户端 ${peer.socket.remotePort || '?'}）` });
      return;
    }
    if (change.newState === states.ClosedByPeer || change.newState === states.ProblemDetectedLocally) {
      const reason = change.info?.endDebugMessage || 'Steam P2P 连接断开';
      emit('peer-left', { peer: `房主 ${hostSteamId}`, reason });
      dropPeer(peer, { closeConnection: false });
    }
  };

  const pump = () => {
    if (stopped) return;
    for (const peer of peers.values()) {
      if (peer.connection == null) continue;
      const messages = steam.networkingSockets.receiveMessages(peer.connection, MAX_MESSAGE_BATCH) || [];
      for (const message of messages) {
        const data = Buffer.isBuffer(message.data) ? message.data : Buffer.from(message.data || []);
        stats.bytesFromPeer += data.length;
        stats.packetsFromPeer += 1;
        if (!peer.socket.destroyed) peer.socket.write(data);
        else stats.dropped += 1;
      }
    }
  };

  const server = net.createServer((socket) => {
    if (stopped) { socket.destroy(); return; }
    if (peers.size >= maxConnections) {
      stats.rejected += 1;
      emit('rejected', { reason: 'max-connections', peer: `${socket.remoteAddress}:${socket.remotePort}`, limit: maxConnections });
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    const peer = { socket, connection: null, connected: false, queue: [] };
    peers.set(socket, peer);
    stats.connections = peers.size;
    stats.totalPeers += 1;
    emit('client-added', { peer: `${socket.remoteAddress}:${socket.remotePort}` });

    socket.on('data', (chunk) => {
      stats.bytesToPeer += chunk.length;
      stats.packetsToPeer += 1;
      if (peer.connection == null || !peer.connected) {
        // Steam P2P 还没连上：先缓存一点，连上后立刻补发（浏览器/RDP 都会先发数据）
        if (peer.queue.length < 256) peer.queue.push(Buffer.from(chunk));
        else { peer.queue.shift(); peer.queue.push(Buffer.from(chunk)); stats.dropped += 1; }
        return;
      }
      const result = steam.networkingSockets.sendReliable(peer.connection, chunk);
      if (!result?.success) { stats.dropped += 1; emit('error', { stage: 'steam-send', error: { code: 'ESTEAMSEND', friendly: '发送到房主失败', message: 'sendReliable failed' } }); }
    });
    socket.on('error', () => { /* 客户端断开属正常 */ });
    socket.on('close', () => dropPeer(peer));

    // 每条本机连接对应一条独立的 Steam P2P 连接 —— 这是「通用内网穿透」的关键：
    // 浏览器、RDP、游戏等都会开多条并发连接，一条隧道只能扛一路。
    try {
      const connection = steam.networkingSockets.connectP2P(String(hostSteamId), 0);
      if (connection == null || connection === 0) throw makeError('ESTEAMCONNECT', 'Steam P2P 连接创建失败');
      peer.connection = connection;
      stats.activeConnections = (stats.activeConnections || 0) + 1;
    } catch (err) {
      stats.failed += 1;
      emit('error', { stage: 'steam-connect', error: { code: err.code || 'ESTEAMCONNECT', friendly: `创建 Steam P2P 连接失败：${err.message}`, message: err.message } });
      socket.destroy();
      peers.delete(socket);
      stats.connections = peers.size;
    }
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
        const init = initSteamSdk({ appDir, appId, sdkPath, sdk, debug });
        steam = init.steam;
        if (!moduleRef) moduleRef = sdk ? null : loadSteamModule(appDir);
        const socketsApi = steam.networkingSockets;
        if (!socketsApi?.connectP2P) throw makeError('ESTEAMAPI', 'steamworks-ffi-node 未提供 networkingSockets 接口');
        offStateChange = socketsApi.onConnectionStateChange(handleStateChange);
        stopLoop = startCallbackLoop({
          steam,
          pump,
          onFatal: (err) => emit('error', { stage: 'callbacks', error: { code: 'ESTEAMCALLBACK', friendly: `Steam 回调出错：${err.message}`, message: err.message } }),
        });
        emit('listening', { protocol: 'STEAM', role: 'joiner', bindHost, port: listenPort, hostSteamId: String(hostSteamId) });
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
    if (stopLoop) stopLoop();
    stopLoop = null;
    try { offStateChange?.(); } catch { /* ignore */ }
    for (const peer of [...peers.values()]) dropPeer(peer);
    peers.clear();
    stats.connections = 0;
    await new Promise((resolve) => server.close(() => resolve()));
    emit('stopped', {});
  };

  return {
    ready,
    stop,
    stats,
    isHost: false,
    options: { role: 'joiner', protocol: 'STEAM', bindHost, localPort: listenPort, hostSteamId: String(hostSteamId), appId, maxConnections },
  };
}

module.exports = {
  STEAM_ID_PATTERN,
  normalizeSteamId,
  resolveOwnSteamId,
  CALLBACK_INTERVAL_MS,
  initSteamSdk,
  createSteamHost,
  createSteamJoiner,
};
