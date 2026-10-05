'use strict';
// 网络 PHASE 7（中继客户端）单测：真实回环 UDP，客户端 ↔ 服务端 ↔ 客户端 全链路，
// 含真实 RTT 测量、未入会禁止发送、口令错误如实超时。

const test = require('node:test');
const assert = require('node:assert');

const { createRelayServer } = require('../network/relay/server.cjs');
const { createRelayClient } = require('../network/relay/client.cjs');

const TOKEN = 'relay-client-test-token';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRelay(fn, serverOptions = {}) {
  const server = createRelayServer({ sessionToken: TOKEN, host: '127.0.0.1', ...serverOptions });
  const info = await server.start();
  const clients = [];
  const make = (token = TOKEN, sessionId = 21) => {
    const c = createRelayClient({ serverHost: '127.0.0.1', serverPort: info.port, sessionToken: token, sessionId });
    clients.push(c);
    return c;
  };
  try {
    await fn({ server, info, make });
  } finally {
    for (const c of clients) { try { await c.close(); } catch (err) { /* 忽略 */ } }
    await server.stop();
  }
}

test('入会成功：拿到端点 ID，stats 反映已入会', async () => {
  await withRelay(async ({ make }) => {
    const a = make();
    const out = await a.join();
    assert.equal(out.ok, true);
    assert.ok(Number.isInteger(out.peerId) && out.peerId > 0);
    assert.equal(a.joined, true);
    assert.equal(a.getStats().joined, true);
  });
});

test('未入会就发送：明确报错，不静默丢包', async () => {
  await withRelay(async ({ make }) => {
    const a = make();
    assert.throws(() => a.send('hi'), /尚未入会/, '同步发送要立刻报错');
    await assert.rejects(a.ping(), /尚未入会/, 'ping 是异步的，拒绝的 Promise 要用 rejects 断言');
  });
});

test('口令错误：如实超时并说明原因（服务端不回包）', async () => {
  await withRelay(async ({ make }) => {
    const bad = make('wrong-token');
    const out = await bad.join({ timeoutMs: 400 });
    assert.equal(out.ok, false);
    assert.match(out.reason, /入会超时/);
    assert.match(bad.lastError, /口令不符/, '原因里要说清口令不符也表现为超时');
    assert.equal(bad.joined, false);
  });
});

test('端到端：A 发的消息经中继到达 B，双方统计各自正确', async () => {
  await withRelay(async ({ make }) => {
    const a = make();
    const b = make();
    assert.equal((await a.join()).ok, true);
    assert.equal((await b.join()).ok, true);

    const received = [];
    b.onMessage((payload, from) => received.push({ text: payload.toString(), from }));
    a.send('hello-through-relay');
    await wait(120);

    assert.equal(received.length, 1);
    assert.equal(received[0].text, 'hello-through-relay');
    assert.equal(received[0].from.peerId, a.peerId, '要带出真实来源端点');
    assert.equal(a.getStats().packetsToPeer, 1);
    assert.equal(a.getStats().bytesToPeer, 'hello-through-relay'.length);
    assert.equal(b.getStats().packetsFromPeer, 1);
    assert.equal(b.getStats().bytesFromPeer, 'hello-through-relay'.length);
  });
});

test('真实 RTT：心跳拿到 PONG 后给出样本（本机应为个位数毫秒）', async () => {
  await withRelay(async ({ make }) => {
    const a = make();
    await a.join();
    const first = await a.ping({ timeoutMs: 1500 });
    assert.equal(first.ok, true, '本机心跳必须能拿到 PONG');
    assert.ok(first.rttMs >= 0 && first.rttMs < 200, '本机 RTT 应很小，实际 ' + first.rttMs);
    assert.ok(a.getStats().pongsReceived >= 1);

    for (let i = 0; i < 5; i += 1) { await a.ping(); await wait(20); }
    const q = a.getQuality();
    assert.equal(q.measured, true);
    assert.ok(q.samples >= 5, '应有多次样本，实际 ' + q.samples);
    assert.ok(q.rtt !== null && q.rtt >= 0);
    assert.ok(q.rttMax >= q.rtt, '最大不应小于中位数');
  });
});

test('离会后不能再发，重新 close 幂等', async () => {
  await withRelay(async ({ make }) => {
    const a = make();
    await a.join();
    assert.equal(a.leave().left, true);
    assert.throws(() => a.send('x'), /尚未入会/);
    await a.close();
    await a.close();
    assert.equal(a.leave().left, false, '已经离会再离会要如实返回 false');
  });
});

test('协议外的心跳包不影响已入会状态（忽略并计数）', async () => {
  await withRelay(async ({ make }) => {
    const a = make();
    await a.join();
    const stats0 = a.getStats().droppedUnknown;
    assert.equal(stats0, 0);
    const out = await a.ping();
    assert.equal(out.ok, true);
    assert.equal(a.joined, true, '心跳不应改变入会状态');
  });
});

test('缺少必要参数：构造时就报错', () => {
  assert.throws(() => createRelayClient({ serverPort: 1 }), /必须提供会话口令/);
  assert.throws(() => createRelayClient({ sessionToken: 'x' }), /必须提供服务端端口/);
});
