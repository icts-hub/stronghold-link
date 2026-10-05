'use strict';
// 网络 PHASE 6（DirectUDPProvider）单测：用注入的假 socket / 假 STUN / 假打洞机，
// 验证契约一致性、打通与未打通两条路径、以及"绝不静默丢包"。

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const D = require('../network/providers/direct-udp.cjs');

function fakeSocket() {
  const socket = new EventEmitter();
  socket.sent = [];
  socket.closed = false;
  socket.bound = null;
  socket.bind = (port, host, cb) => { socket.bound = { port: port || 41234, host }; if (cb) setImmediate(cb); };
  socket.address = () => socket.bound || { port: 41234, address: '0.0.0.0' };
  socket.send = (buf, port, address) => { socket.sent.push({ bytes: buf.length, port, address }); };
  socket.close = (cb) => { socket.closed = true; if (cb) setImmediate(cb); };
  return socket;
}

/** 假打洞机：按脚本返回状态。 */
function scriptedPuncher(states) {
  let i = 0;
  return () => ({
    start() { return { state: states[0].state }; },
    tick() { const s = states[Math.min(i, states.length - 1)]; i += 1; return s; },
    handlePacket() { return { handled: true }; },
    stop() { return { state: 'failed' }; },
  });
}

const ESTABLISHED = { state: 'established', reason: '收到对端确认', peer: { address: '203.0.113.7', port: 5000 }, attempts: 2, confirmed: true };
const FAILED = { state: 'failed', reason: '打洞超时（8000ms）：对端未响应，可能需要中继', peer: null, attempts: 30, confirmed: false };

async function makeProvider({ states, stunResult = { family: 'IPv4', address: '198.51.100.2', port: 41234 }, options = {} } = {}) {
  const socket = fakeSocket();
  const provider = D.createDirectUDPProvider({
    role: 'host',
    options: { remoteCandidates: [{ address: '203.0.113.7', port: 5000 }], punchPolicy: { intervalMs: 50 }, ...options },
    deps: {
      createSocket: () => socket,
      queryStun: async () => stunResult,
      createPuncher: scriptedPuncher(states || [ESTABLISHED]),
    },
  });
  await provider.start();
  return { provider, socket };
}

test('能力声明如实：UDP 不可靠、非点对点可达端口、不声称可靠通道', () => {
  const provider = D.createDirectUDPProvider({ role: 'host' });
  const caps = provider.getCapabilities();
  assert.deepEqual(caps.transports, ['UDP']);
  assert.equal(caps.reliable, false, 'UDP 不能声称可靠');
  assert.equal(caps.unreliable, true);
  assert.equal(caps.p2p, true);
  assert.equal(caps.natTraversal, true);
  assert.equal(caps.requiresReachablePort, false, '打洞不要求端口可达');
  assert.equal(caps.encryption, 'none', '未设口令时如实标注明文');
  assert.ok(caps.notes.some((n) => n.includes('尚未验证')), '必须在能力里写明未验证');
});

test('打洞成功：状态 READY，send 走不可靠通道并送到对端', async () => {
  const { provider, socket } = await makeProvider();
  assert.equal(provider.getState(), 'ready');
  const stats = provider.getStats();
  assert.equal(stats.srflx, '198.51.100.2:41234');
  assert.equal(stats.punched, true);

  const out = provider.send(Buffer.from('hello'), { channel: 'unreliable' });
  assert.equal(out.sent, true);
  assert.equal(out.bytes, 5);
  assert.deepEqual(out.to, { address: '203.0.113.7', port: 5000 });
  assert.equal(socket.sent[socket.sent.length - 1].address, '203.0.113.7');
  assert.equal(provider.getStats().bytesToPeer, 5, '统计要真实累加');
  assert.equal(provider.getStats().packetsToPeer, 1);
});

test('打洞失败：不假装直连，send 明确报错并带原因（绝不静默丢包）', async () => {
  const { provider } = await makeProvider({ states: [FAILED] });
  assert.equal(provider.getState(), 'ready', 'socket 绑定成功仍算 READY');
  assert.equal(provider.getStats().punched, false);
  assert.equal(provider.getDiagnostics().direct.punched, false);
  assert.throws(() => provider.send(Buffer.from('x'), { channel: 'unreliable' }), /直连尚未打通/);
  assert.throws(() => provider.send(Buffer.from('x'), { channel: 'unreliable' }), /打洞超时/);
});

test('可靠通道请求被拒绝：由契约层按能力声明拦下', async () => {
  const { provider } = await makeProvider();
  // capabilities.reliable=false 时，Provider 包装层会先于实现抛错 —— 这正是想要的行为
  assert.throws(() => provider.send(Buffer.from('x'), { channel: 'reliable' }), /不支持可靠通道/);
});

test('STUN 拿不到映射：仍可 READY，但如实记录提示', async () => {
  const { provider } = await makeProvider({ stunResult: null });
  assert.equal(provider.getState(), 'ready');
  assert.equal(provider.getStats().srflx, null);
  const diag = provider.getDiagnostics();
  assert.equal(diag.srflx, null);
  assert.ok(diag.notes.some((n) => n.includes('未能从 STUN 取得公网映射')));
});

test('没有对端候选时不打洞，如实说明等待交换', async () => {
  const socket = fakeSocket();
  const provider = D.createDirectUDPProvider({
    role: 'joiner',
    options: { remoteCandidates: [] },
    deps: { createSocket: () => socket, queryStun: async () => null, createPuncher: scriptedPuncher([ESTABLISHED]) },
  });
  await provider.start();
  assert.equal(provider.getState(), 'ready');
  assert.match(provider.getDiagnostics().direct.reason, /还没有对端候选地址/);
  assert.throws(() => provider.send(Buffer.from('x'), { channel: 'unreliable' }), /直连尚未打通/);
});

test('stop 关闭真实 socket 并停掉打洞机', async () => {
  const { provider, socket } = await makeProvider();
  const out = await provider.stop();
  assert.equal(out.stopped, true);
  assert.equal(socket.closed, true);
  assert.equal(provider.getState(), 'stopped');
  const again = await provider.stop();
  assert.equal(again.alreadyStopped, true, '重复停止要幂等');
});

test('注册表登记两个角色，能力与 Provider 一致', () => {
  const registry = { items: new Map(), has(id) { return this.items.has(id); }, register(e) { this.items.set(e.id, e); } };
  D.registerDirectUDPProvider(registry);
  assert.deepEqual([...registry.items.keys()], ['direct-udp-host', 'direct-udp-joiner']);
  const caps = registry.items.get('direct-udp-host').capabilities;
  assert.equal(caps.unreliable, true);
  assert.equal(caps.reliable, false);
});
