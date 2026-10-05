'use strict';
// 网络 PHASE 7（SLRelayProvider）单测：真实回环中继服务端 + 两个 Provider，
// 验证契约、真实 RTT、组网投递、入会失败如实报错。

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { createRelayServer } = require('../network/relay/server.cjs');
const { createSlRelayProvider } = require('../network/providers/sl-relay.cjs');

const TOKEN = 'sl-relay-provider-token';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRelay(fn, serverOptions = {}) {
  const server = createRelayServer({ sessionToken: TOKEN, host: '127.0.0.1', ...serverOptions });
  const info = await server.start();
  const providers = [];
  const make = (overrides = {}) => {
    const p = createSlRelayProvider({
      role: overrides.role || 'host',
      options: { serverHost: '127.0.0.1', serverPort: info.port, sessionToken: TOKEN, sessionId: 33, ...overrides.options },
    });
    providers.push(p);
    return p;
  };
  try {
    await fn({ server, info, make });
  } finally {
    for (const p of providers) { try { await p.stop(); } catch (err) { /* 忽略 */ } }
    await server.stop();
  }
}

test('能力声明如实：不点对点、不加密载荷、不声称可靠通道', () => {
  const p = createSlRelayProvider({ role: 'host', options: { serverPort: 1, sessionToken: 'x' } });
  const caps = p.getCapabilities();
  assert.equal(caps.p2p, false, '中继是转发，不能声称点对点');
  assert.equal(caps.reliable, false);
  assert.equal(caps.unreliable, true);
  assert.equal(caps.encryption, 'none', '中继不加密载荷，必须如实声明');
  assert.equal(caps.natTraversal, true);
  assert.ok(caps.notes.some((n) => n.includes('尚未部署公网实例')));
});

test('入会成功：状态 READY，describe 带出服务端与会话', async () => {
  await withRelay(async ({ info, make }) => {
    const p = make();
    await p.start();
    assert.equal(p.getState(), 'ready');
    const d = p.describe();
    assert.equal(d.server, '127.0.0.1:' + info.port);
    assert.equal(d.sessionId, 33);
    assert.equal(d.joined.ok, true);
    assert.ok(d.joined.peerId > 0);
  });
});

test('两个 Provider 经中继真实互投，接收统计与来源端点正确', async () => {
  await withRelay(async ({ make }) => {
    const a = make();
    const b = make({ role: 'joiner' });
    await a.start();
    await b.start();

    const got = [];
    // 用事件接口订阅（与内核 Provider 的用法一致）：emit('message', { data, from })
    b.onEvent((ev) => { if (ev.type === 'message') got.push({ text: ev.data.toString(), from: ev.from.peerId }); });
    a.send(Buffer.from('via sl-relay'), { channel: 'unreliable' });
    await wait(150);

    assert.equal(got.length, 1);
    assert.equal(got[0].text, 'via sl-relay');
    assert.equal(got[0].from, a.describe().joined.peerId);
    assert.equal(a.getStats().packetsToPeer, 1);
    assert.equal(a.getStats().bytesToPeer, 'via sl-relay'.length);
    assert.equal(b.getStats().packetsFromPeer, 1);
    assert.equal(b.getStats().relay.joined, true);
  });
});

test('probe()：拿到真实的 RTT 与抖动样本（本机应很小）', async () => {
  await withRelay(async ({ make }) => {
    const p = make();
    await p.start();
    const out = await p.probe({ count: 4 });
    assert.equal(out.ok, true);
    assert.equal(out.replies, 4);
    assert.equal(out.quality.measured, true);
    assert.ok(out.quality.samples >= 4, '样本数应达到 4，实际 ' + out.quality.samples);
    assert.ok(out.quality.rtt !== null && out.quality.rtt < 200, '本机 RTT 应很小，实际 ' + out.quality.rtt);
    assert.equal(p.getStats().quality.measured, true, '统计里也要能看到质量');
  });
});

test('入会失败：start() 抛错且状态为 error，不假装 READY', async () => {
  await withRelay(async ({ info }) => {
    const p = createSlRelayProvider({
      role: 'host',
      options: { serverHost: '127.0.0.1', serverPort: info.port, sessionToken: 'wrong-token', sessionId: 33, joinTimeoutMs: 400 },
    });
    try {
      await assert.rejects(p.start(), /入会超时/);
      assert.equal(p.getState(), 'error');
      assert.equal(p.getStats().relay.joined, false);
    } finally {
      await p.stop();   // 必须收尾：否则 socket 不关，node --test 进程不退出
    }
  });
});

test('配置缺失或不通：未给端口/口令时不假装可用', async () => {
  const noPort = createSlRelayProvider({ role: 'host', options: { sessionToken: 'x' } });
  await assert.rejects(noPort.start(), /未配置中继服务端端口/);

  const noToken = createSlRelayProvider({ role: 'host', options: { serverPort: 1 } });
  await assert.rejects(noToken.start(), /未设置会话口令/);
});

test('可靠通道由契约层拦下；未入会时发送报错', async () => {
  const p = createSlRelayProvider({ role: 'host', options: { serverPort: 1, sessionToken: 'x' } });
  assert.throws(() => p.send(Buffer.from('x'), { channel: 'reliable' }), /不支持可靠通道/);

  await withRelay(async ({ make }) => {
    const q = make();
    // 未 start 时由契约的状态守卫先拦下（比实现层守卫更早，这是想要的分层）
    assert.throws(() => q.send(Buffer.from('x'), { channel: 'unreliable' }), /尚未就绪/);
    assert.equal((await q.probe()).ok, false, '未入会的 probe 如实返回 false');
  });
});

test('stop 后状态停止且可重复调用；注册表登记两个角色', async () => {
  await withRelay(async ({ make }) => {
    const p = make();
    await p.start();
    await p.stop();
    assert.equal(p.getState(), 'stopped');
    const again = await p.stop();
    assert.equal(again.alreadyStopped, true);
  });

  const registry = { items: new Map(), has(id) { return this.items.has(id); }, register(e) { this.items.set(e.id, e); } };
  require('../network/providers/sl-relay.cjs').registerSlRelayProvider(registry);
  assert.deepEqual([...registry.items.keys()], ['sl-relay-host', 'sl-relay-joiner']);
  assert.equal(registry.items.get('sl-relay-host').capabilities.p2p, false);
});

test('中继不加密载荷：能力声明与说明一致（加密由上层负责）', () => {
  const p = createSlRelayProvider({ role: 'joiner', options: { serverPort: 1, sessionToken: 'x' } });
  const caps = p.getCapabilities();
  assert.equal(caps.encryption, 'none');
  assert.ok(caps.notes.some((n) => n.includes('不加密载荷')), '说明里必须写清这一点，避免误解为端到端加密');
  // 未入会时质量如实为未测量，而不是 0
  const q = p.getQuality();
  assert.equal(q.measured, false);
  assert.equal(q.rtt, null);
});
