'use strict';
// ============================================================================
// Stronghold Link — SteamP2PProvider
//
// 现阶段（网络 PHASE 3）只做一件事：把现有 steam-adapter 内核包装成 Provider，
// 让 session 不再直接依赖 Steam 内核对象。能力声明按**当前真实实现**写：
//
//   transports: ['TCP']      —— 现在只把 Steam 可靠消息流当 TCP 隧道用
//   reliable:   true         —— 走 sendReliable
//   unreliable: false        —— 不可靠通道（UDP 游戏流量）尚未实现，PHASE 4 才做
//   p2p / natTraversal: true —— Steam 传输层自带穿透与中继选择
//   encryption: 'steam-transport'
//
// 不可靠通道与实时质量（getConnectionRealTimeStatus / getDetailedConnectionStatus）
// 属于 PHASE 4；在此之前这里如实声明"不支持"，调用会得到明确报错，
// 界面也会显示对应能力为 NOT IMPLEMENTED。
// ============================================================================

const { createSteamHost, createSteamJoiner } = require('../steam-adapter.cjs');
const { createKernelProvider } = require('./kernel-provider.cjs');
const { PROVIDER_KINDS, defaultRegistry } = require('./registry.cjs');

const STEAM_SEND_UNSUPPORTED = 'Steam 通道当前按连接桥接本机 TCP 端口，不提供按消息发送（PHASE 4 会补不可靠通道）';

function createSteamP2PProvider({ role, options = {} }) {
  const isHost = role === 'host';
  const id = isHost ? 'steam-p2p-host' : 'steam-p2p-joiner';
  const name = `Steam P2P（${isHost ? '房主' : '加入者'}）`;

  return createKernelProvider({
    id,
    name,
    capabilities: {
      transports: ['TCP'],
      reliable: true,
      unreliable: false,          // PHASE 4：sendUnreliable + 分片
      p2p: true,
      natTraversal: true,
      encryption: 'steam-transport',
      maxPeers: Number(options.maxPeers || 0) || 0,
      requiresReachablePort: false,
      notes: [
        '加密与身份认证由 Steam 传输层负责（不叠加口令层）',
        '当前仅承载 TCP 流量；UDP 游戏的不可靠通道尚未实现',
      ],
    },
    createKernel: isHost ? (opts) => createSteamHost(opts) : (opts) => createSteamJoiner(opts),
    kernelOptions: () => ({ ...options }),
    extras: (kernelStats) => ({
      encrypted: true,                    // Steam 传输层自带加密
      sessionId: kernelStats.sessionId || null,
      totalPeers: kernelStats.totalPeers || kernelStats.connections || 0,
      role,
      protocol: 'STEAM',
    }),
    sendUnsupported: STEAM_SEND_UNSUPPORTED,
  });
}

function registerSteamProvider(registry = defaultRegistry) {
  for (const role of ['host', 'joiner']) {
    const id = `steam-p2p-${role}`;
    if (registry.has(id)) continue;
    registry.register({
      id,
      name: `Steam P2P（${role === 'host' ? '房主' : '加入者'}）`,
      kind: PROVIDER_KINDS.STEAM,
      capabilities: {
        transports: ['TCP'],
        reliable: true,
        unreliable: false,
        p2p: true,
        natTraversal: true,
        encryption: 'steam-transport',
        requiresReachablePort: false,
      },
      create: (options) => createSteamP2PProvider({ role, options }),
    });
  }
  return registry;
}

module.exports = {
  STEAM_SEND_UNSUPPORTED,
  createSteamP2PProvider,
  registerSteamProvider,
};
