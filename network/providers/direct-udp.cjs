'use strict';
// ============================================================================
// Stronghold Link — DirectUDPProvider（P6 组装）
//
// 把 PHASE 6 的零件拼成统一 Provider：
//   STUN 取本机公网映射 → 与对端候选双向打洞 → 打通后走不可靠 UDP 直连。
//
// 诚实约定：
//   * 打洞失败**不**假装直连成功：状态仍为 READY（socket 已绑定），
//     但 directStatus.punched = false 且带原因，send() 会明确报错让上层回退。
//   * 本机实测：UPnP 与 NAT-PMP 在本网络都无响应，STUN 映射为端点无关且不改写端口。
//   * 真实双机打洞未验证（需两台机器），只在本机做过协议层与自打洞实验。
//
// 依赖注入：dgram / STUN 查询 / 打洞机都可由调用方替换，便于确定性单测。
// ============================================================================

const dgram = require('node:dgram');
const { createProvider, PROVIDER_STATES, CHANNELS } = require('./provider.cjs');
const stun = require('../direct-udp/stun.cjs');
const { createPuncher } = require('../direct-udp/punch.cjs');

const DEFAULT_STUN = Object.freeze([
  { host: 'stun.l.google.com', port: 19302 },
  { host: 'stun.cloudflare.com', port: 3478 },
]);

const DIRECT_NOT_READY = '直连尚未打通，无法发送；请等待打洞完成或回退到中继通道';

/** 用真实 dgram socket 向 STUN 服务器问一次公网映射。 */
function queryStun(socket, servers, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; cleanup(); resolve(value); } };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const onMessage = (msg) => {
      const parsed = stun.parseMessage(msg);
      if (!parsed.ok) return;
      const addr = parsed.xorMapped || parsed.mapped;
      if (addr) finish({ ...addr, via: 'stun' });
    };
    function cleanup() {
      clearTimeout(timer);
      try { socket.removeListener('message', onMessage); } catch (err) { /* 忽略 */ }
    }
    socket.on('message', onMessage);
    for (const server of servers) {
      const { buffer } = stun.buildBindingRequest();
      try { socket.send(buffer, server.port, server.host); } catch (err) { /* 单个服务器失败不影响其它 */ }
    }
  });
}

function createDirectUDPProvider({
  role = 'host',
  options = {},
  deps = {},
} = {}) {
  const createSocket = deps.createSocket || (() => dgram.createSocket('udp4'));
  const stunQuery = deps.queryStun || queryStun;
  const makePuncher = deps.createPuncher || createPuncher;
  const servers = options.stunServers || DEFAULT_STUN;
  const authToken = options.authToken === undefined ? '' : String(options.authToken || '');

  let socket = null;
  // 直连通道没有内核可镜像，自己计数（字段名与统一统计保持一致）
  const counters = { bytesToPeer: 0, bytesFromPeer: 0, packetsToPeer: 0, packetsFromPeer: 0 };
  let puncher = null;
  let provider = null;
  let srflx = null;
  let directStatus = { punched: false, reason: '尚未开始打洞', peer: null, attempts: 0 };
  const notes = [];

  const implementation = {
    deferReady: true,

    async start() {
      socket = createSocket();
      counters.bytesToPeer = 0; counters.bytesFromPeer = 0;
      counters.packetsToPeer = 0; counters.packetsFromPeer = 0;
      await new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        socket.once('error', onError);
        socket.bind(options.port || 0, options.bindHost || '0.0.0.0', () => {
          socket.removeListener('error', onError);
          resolve();
        });
      });
      const bound = socket.address();
      provider.localPort = bound.port;

      // 1) STUN：取公网映射（失败不致命，如实记录）
      try {
        srflx = await stunQuery(socket, servers, options.stunTimeoutMs || 4000);
      } catch (err) {
        srflx = null;
      }
      if (!srflx) notes.push('本次未能从 STUN 取得公网映射（打洞仍可尝试，但成功率下降）');

      // 2) 打洞（有对端候选才做）
      const remoteCandidates = Array.isArray(options.remoteCandidates) ? options.remoteCandidates : [];
      if (!remoteCandidates.length) {
        directStatus = { punched: false, reason: '还没有对端候选地址（等待交换）', peer: null, attempts: 0 };
        provider._markReady({ localPort: bound.port, srflx });
        return { localPort: bound.port, srflx };
      }

      puncher = makePuncher({
        socket: { send: (buf, port, address) => socket.send(buf, port, address) },
        remoteCandidates,
        policy: options.punchPolicy || {},
      });
      socket.on('message', (msg, rinfo) => {
        counters.bytesFromPeer += msg.length;
        counters.packetsFromPeer += 1;
        if (puncher) puncher.handlePacket(msg, rinfo);
      });

      directStatus = { punched: false, reason: '打洞进行中', peer: null, attempts: 0 };
      puncher.start();
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          const snap = puncher.tick();
          if (snap.state === 'established' || snap.state === 'failed') {
            clearInterval(timer);
            directStatus = {
              punched: snap.state === 'established',
              reason: snap.reason || (snap.state === 'established' ? '打洞成功' : '打洞失败'),
              peer: snap.peer,
              attempts: snap.attempts,
              confirmed: Boolean(snap.confirmed),
            };
            resolve();
          }
        }, Math.max(50, (options.punchPolicy && options.punchPolicy.intervalMs) || 250));
      });

      provider._markReady({ localPort: bound.port, srflx, punched: directStatus.punched });
      return { localPort: bound.port, srflx, direct: directStatus };
    },

    async stop() {
      if (puncher) { try { puncher.stop(); } catch (err) { /* 忽略 */ } puncher = null; }
      if (!socket) return { stopped: true, alreadyStopped: true };
      const current = socket;
      socket = null;
      await new Promise((resolve) => {
        try { current.close(resolve); } catch (err) { resolve(); }
      });
      return { stopped: true };
    },

    send(data, { channel = CHANNELS.UNRELIABLE } = {}) {
      if (channel === CHANNELS.RELIABLE) {
        throw new Error('直连 UDP 不提供可靠通道：请改用可靠通道（本地中继 / Steam）');
      }
      if (!directStatus.punched || !directStatus.peer) {
        // 绝不静默丢包：让上层看到原因并回退
        throw new Error(DIRECT_NOT_READY + '（' + directStatus.reason + '）');
      }
      const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      socket.send(payload, directStatus.peer.port, directStatus.peer.address);
      counters.bytesToPeer += payload.length;
      counters.packetsToPeer += 1;
      return { sent: true, bytes: payload.length, to: directStatus.peer };
    },

    describe() {
      return {
        localPort: socket && socket.address ? socket.address().port : null,
        srflx,
        direct: directStatus,
      };
    },
  };

  provider = createProvider({
    id: `direct-udp-${role}`,
    name: `直连 UDP（${role === 'host' ? '房主' : '加入者'}）`,
    capabilities: {
      transports: ['UDP'],
      reliable: false,
      unreliable: true,
      p2p: true,
      natTraversal: true,
      encryption: authToken ? 'psk-aead' : 'none',
      requiresReachablePort: false,
      notes: [
        '打洞成功即为点对点直连；失败会明确报错，由上层回退到中继',
        '本机实测：UPnP 与 NAT-PMP 均无响应；STUN 映射为端点无关且不改写端口',
        '真实双机打洞尚未验证（需两台机器）',
      ],
    },
    implementation,
  });

  const baseGetStats = provider.getStats;
  provider.getStats = () => ({
    ...baseGetStats(),
    ...counters,
    srflx: srflx ? srflx.address + ':' + srflx.port : null,
    punched: directStatus.punched,
  });
  provider.getDiagnostics = () => ({
    srflx,
    direct: directStatus,
    stunServers: servers.map((s) => s.host + ':' + s.port),
    notes: notes.slice(),
  });
  provider.ready = Promise.resolve({});
  return provider;
}

function registerDirectUDPProvider(registry) {
  for (const role of ['host', 'joiner']) {
    const id = `direct-udp-${role}`;
    if (registry.has(id)) continue;
    registry.register({
      id,
      name: `直连 UDP（${role === 'host' ? '房主' : '加入者'}）`,
      kind: 'direct',
      capabilities: { transports: ['UDP'], reliable: false, unreliable: true, p2p: true, natTraversal: true, requiresReachablePort: false },
      create: (options) => createDirectUDPProvider({ role, options }),
    });
  }
  return registry;
}

module.exports = { DEFAULT_STUN, DIRECT_NOT_READY, queryStun, createDirectUDPProvider, registerDirectUDPProvider, PROVIDER_STATES };
