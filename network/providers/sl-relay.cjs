'use strict';
// ============================================================================
// Stronghold Link — SLRelayProvider（Stronghold Relay 的 Provider 形态）
//
// 把 network/relay/client.cjs 组装成统一契约，使中继与本地中继 / Steam / 直连
// 并列成为 RouteManager 的候选。它同时提供**真实 RTT**（PING/PONG → 质量模块）。
//
// 诚实约定：
//   * 中继只负责转发，**不加密载荷**；加解密由上层安全通道负责（capabilities.encryption 如实写 none）；
//   * 入会失败直接让 start() 抛错（这条路径就是不可用），不假装 READY；
//   * 不提供可靠通道（UDP 转发），请求可靠通道由契约层按能力拦下；
//   * 服务端尚未部署公网实例 —— 目前只能在本地或自建实例上使用。
// ============================================================================

const { createProvider, CHANNELS } = require('./provider.cjs');
const { createRelayClient } = require('../relay/client.cjs');
const { createQuality } = require('../route/quality.cjs');

function createSlRelayProvider({ role = 'host', options = {}, deps = {} } = {}) {
  const makeClient = deps.createClient || createRelayClient;
  const serverHost = options.serverHost || '127.0.0.1';
  const serverPort = Number(options.serverPort) || 0;
  const sessionToken = options.sessionToken === undefined ? '' : String(options.sessionToken || '');
  const sessionId = Number.isFinite(Number(options.sessionId)) ? Number(options.sessionId) : 1;

  let client = null;
  let provider = null;
  const counters = { bytesToPeer: 0, bytesFromPeer: 0, packetsToPeer: 0, packetsFromPeer: 0 };
  const joined = { ok: false, peerId: null, elapsedMs: null };

  const implementation = {
    async start() {
      if (!serverPort) throw new Error('未配置中继服务端端口：这条路径不可用');
      if (!sessionToken) throw new Error('未设置会话口令：中继服务端会拒绝入会');
      client = makeClient({ serverHost, serverPort, sessionToken, sessionId });
      const out = await client.join({ timeoutMs: options.joinTimeoutMs || 3000 });
      if (!out.ok) throw new Error(out.reason || '中继入会失败');
      joined.ok = true;
      joined.peerId = out.peerId;
      joined.elapsedMs = out.elapsedMs;
      client.onMessage((payload, from) => {
        counters.bytesFromPeer += payload.length;
        counters.packetsFromPeer += 1;
        provider._emit('message', { data: payload, from });
      });
      return { relay: { serverHost, serverPort, sessionId, peerId: out.peerId } };
    },

    async stop() {
      if (!client) return { stopped: true, alreadyStopped: true };
      const current = client;
      client = null;
      joined.ok = false;
      await current.close();
      return { stopped: true };
    },

    send(data, { channel = CHANNELS.UNRELIABLE } = {}) {
      if (channel === CHANNELS.RELIABLE) {
        throw new Error('中继通道按数据报转发，不提供可靠语义：请改用本地中继或 Steam 通道');
      }
      if (!client || !client.joined) throw new Error('中继尚未入会，无法发送');
      const payload = Buffer.isBuffer(data) ? data : Buffer.from(data === undefined || data === null ? '' : String(data));
      client.send(payload);
      counters.bytesToPeer += payload.length;
      counters.packetsToPeer += 1;
      return { sent: true, bytes: payload.length };
    },

    describe() {
      return { server: serverHost + ':' + serverPort, sessionId, joined: { ...joined } };
    },
  };

  provider = createProvider({
    id: `sl-relay-${role}`,
    name: `Stronghold Relay（${role === 'host' ? '房主' : '加入者'}）`,
    capabilities: {
      transports: ['UDP'],
      reliable: false,
      unreliable: true,
      p2p: false,                 // 经服务端转发，不是点对点
      natTraversal: true,         // 双方只要能连上服务端即可，无需端口可达
      encryption: 'none',         // 中继只转发；载荷加密由上层安全通道负责
      requiresReachablePort: false,
      notes: [
        '经服务端转发，不做点对点；延迟通常高于直连',
        '中继不加密载荷：加密由上层安全通道（会话口令）负责',
        '服务端已实现并本机跑通，但尚未部署公网实例',
      ],
    },
    implementation,
  });

  const baseGetStats = provider.getStats;
  provider.getStats = () => ({
    ...baseGetStats(),
    ...counters,
    relay: { server: serverHost + ':' + serverPort, joined: joined.ok, peerId: joined.peerId },
    quality: client && client.getQuality ? client.getQuality() : createQuality().snapshot(),
  });
  provider.getQuality = () => (client && client.getQuality ? client.getQuality() : createQuality().snapshot());

  /** 主动测几轮 RTT，把样本喂给质量窗口（结果就是真实数字或"未测量"）。 */
  provider.probe = async ({ count = 3, timeoutMs = 1200 } = {}) => {
    if (!client || !client.joined) return { ok: false, reason: '尚未入会', quality: provider.getQuality() };
    let ok = 0;
    for (let i = 0; i < Math.max(1, count); i += 1) {
      const out = await client.ping({ timeoutMs });
      if (out.ok) ok += 1;
    }
    return { ok: ok > 0, replies: ok, quality: provider.getQuality() };
  };

  provider.ready = Promise.resolve({});
  return provider;
}

function registerSlRelayProvider(registry) {
  for (const role of ['host', 'joiner']) {
    const id = `sl-relay-${role}`;
    if (registry.has(id)) continue;
    registry.register({
      id,
      name: `Stronghold Relay（${role === 'host' ? '房主' : '加入者'}）`,
      kind: 'relay',
      capabilities: { transports: ['UDP'], reliable: false, unreliable: true, p2p: false, natTraversal: true, requiresReachablePort: false, encryption: 'none' },
      create: (options) => createSlRelayProvider({ role, options }),
    });
  }
  return registry;
}

module.exports = { createSlRelayProvider, registerSlRelayProvider };
