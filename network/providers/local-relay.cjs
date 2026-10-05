'use strict';
// ============================================================================
// Stronghold Link — LocalRelayProvider
//
// 把现有的 TCP / UDP 中继内核包装成统一 Provider。语义如实声明：
//   * 它是「本机端口转发器」，不是点对点传输：房主侧必须让端口可达
//     （局域网 / 已有 VPN / 用户自己做的端口映射），因此
//     requiresReachablePort = true、natTraversal = false。
//   * TCP 通道天然可靠有序；UDP 通道是逐包转发（不可靠、可能丢序），
//     所以 UDP 的 reliable=false、unreliable=true —— 这是传输事实，
//     不是我们"缩水"，写清楚才能让 RouteManager 正确筛路。
//   * 不提供按消息发送：它是字节流/数据报转发器，应用应连接本机入口端口。
//     调用 send() 会得到明确报错，不会静默成功。
// ============================================================================

const { createTcpHost, createTcpJoiner } = require('../tcp-relay.cjs');
const { createUdpHost, createUdpJoiner } = require('../udp-relay.cjs');
const { createKernelProvider } = require('./kernel-provider.cjs');
const { PROVIDER_KINDS, defaultRegistry } = require('./registry.cjs');

const RELAY_SEND_UNSUPPORTED = '本地中继按端口转发字节流/数据报，不提供按消息发送；请让客户端连接本机入口端口';

/** 本地中继的加密由我们自己的口令层提供（未设口令时为明文）。 */
function relayEncryption(authToken) {
  return authToken ? 'psk-aead' : 'none';
}

function relayNotes({ protocol, role, authToken }) {
  const notes = [
    role === 'host'
      ? '房主侧：把监听端口开放给好友，流量转发到本机服务端口'
      : '加入者侧：本机监听入口端口，流量转发到房主中继端口',
  ];
  if (protocol === 'UDP') notes.push('UDP 逐包转发：不可靠、可能丢序（游戏实时流量适用）');
  if (!authToken) notes.push('未设置会话口令：链路上是明文');
  if (!authToken === false) notes.push('已启用会话口令：AES-256-GCM 记录/数据报加密');
  return notes;
}

/**
 * 创建一条本地中继通道的 Provider。
 *
 * @param {object} options
 * @param {'host'|'joiner'} options.role
 * @param {'TCP'|'UDP'}     options.protocol
 * @param {object}          options.options  传给内核的参数（bindHost/port/authToken/...）
 */
function createLocalRelayProvider({ role, protocol, options = {} }) {
  const proto = String(protocol || 'TCP').toUpperCase() === 'UDP' ? 'UDP' : 'TCP';
  const authToken = options.authToken === undefined ? '' : String(options.authToken || '');
  const isHost = role === 'host';
  const id = `local-${proto.toLowerCase()}-${isHost ? 'host' : 'joiner'}`;
  const name = `${isHost ? '房主' : '加入者'} · 本地 ${proto} 中继`;

  const createKernel = isHost
    ? (opts) => (proto === 'UDP'
      ? createUdpHost({ ...opts, relayPort: opts.relayPort ?? opts.listenPort })
      : createTcpHost({ ...opts, relayPort: opts.relayPort ?? opts.listenPort }))
    : (opts) => (proto === 'UDP'
      ? createUdpJoiner({ ...opts, localPort: opts.localPort ?? opts.listenPort })
      : createTcpJoiner({ ...opts, localPort: opts.localPort ?? opts.listenPort }));

  return createKernelProvider({
    id,
    name,
    capabilities: {
      transports: [proto],
      // TCP 可靠有序；UDP 逐包转发
      reliable: proto === 'TCP',
      unreliable: proto === 'UDP',
      p2p: false,
      natTraversal: false,
      encryption: relayEncryption(authToken),
      maxPeers: Number(options.maxConnections || options.maxClients || 0) || 0,
      requiresReachablePort: true,
      notes: relayNotes({ protocol: proto, role, authToken }),
    },
    createKernel,
    kernelOptions: () => ({ ...options }),
    // 内核独有字段原样带出，界面与 RouteManager 都能看到
    extras: (kernelStats) => ({
      encrypted: Boolean(kernelStats.encrypted),
      sessionId: kernelStats.sessionId || null,
      role,
      protocol: proto,
    }),
    sendUnsupported: RELAY_SEND_UNSUPPORTED,
  });
}

/** 登记到默认注册表（界面与 RouteManager 从这里取能力声明）。 */
function registerLocalRelayProviders(registry = defaultRegistry) {
  const entries = [
    { proto: 'TCP', role: 'host' },
    { proto: 'TCP', role: 'joiner' },
    { proto: 'UDP', role: 'host' },
    { proto: 'UDP', role: 'joiner' },
  ];
  for (const { proto, role } of entries) {
    const id = `local-${proto.toLowerCase()}-${role}`;
    if (registry.has(id)) continue;
    registry.register({
      id,
      name: `本地 ${proto} 中继（${role === 'host' ? '房主' : '加入者'}）`,
      kind: PROVIDER_KINDS.LOCAL,
      capabilities: {
        transports: [proto],
        reliable: proto === 'TCP',
        unreliable: proto === 'UDP',
        p2p: false,
        natTraversal: false,
        encryption: 'psk-aead',
        requiresReachablePort: true,
      },
      create: (options) => createLocalRelayProvider({ role, protocol: proto, options }),
    });
  }
  return registry;
}

module.exports = {
  RELAY_SEND_UNSUPPORTED,
  createLocalRelayProvider,
  registerLocalRelayProviders,
};
