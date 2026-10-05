'use strict';
// 网络 PHASE 7（中继服务端）单测：真实回环 UDP，两个客户端经服务端互通；
// 口令不符、超长包、限速、空闲逐出、未知端点一律丢弃并计数（绝不成为开放代理）。

const test = require('node:test');
const assert = require('node:assert');
const dgram = require('node:dgram');

const R = require('../network/relay/server.cjs');

const TOKEN = 'correct-horse-battery';

function client() {
  const socket = dgram.createSocket('udp4');
  const queue = [];
  socket.on('message', (msg) => queue.push(msg));
  return {
    socket,
    queue,
    bind: () => new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve)),
    hello: (serverPort, sessionId = 7) => socket.send(R.encode(R.TYPES.HELLO, { sessionId, payload: R.tokenDigest(TOKEN) }), serverPort, '127.0.0.1'),
    send: (serverPort, payload, sessionId = 7, peerId = 0) => socket.send(R.encode(R.TYPES.DATA, { sessionId, peerId, payload }), serverPort, '127.0.0.1'),
    close: () => new Promise((resolve) => { try { socket.close(resolve); } catch (err) { resolve(); } }),
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withServer(options, fn) {
  const server = R.createRelayServer({ sessionToken: TOKEN, host: '127.0.0.1', ...options });
  const info = await server.start();
  const a = client();
  const b = client();
  await a.bind();
  await b.bind();
  try {
    await fn({ server, info, a, b });
  } finally {
    await a.close();
    await b.close();
    await server.stop();
  }
}

test('协议编解码：类型/会话/端点/sha256 令牌摘要，严格拒绝非法包', () => {
  const frame = R.encode(R.TYPES.DATA, { sessionId: 7, peerId: 3, payload: Buffer.from('hi') });
  assert.equal(frame.length, R.HEADER_BYTES + 2);
  const msg = R.decode(frame);
  assert.equal(msg.type, R.TYPES.DATA);
  assert.equal(msg.sessionId, 7);
  assert.equal(msg.peerId, 3);
  assert.equal(msg.payload.toString(), 'hi');
  assert.equal(R.decode(Buffer.alloc(4)), null, '长度不足要拒绝');
  const bad = Buffer.from(frame); bad.writeUInt8(99, 0);
  assert.equal(R.decode(bad), null, '未知类型要拒绝');
  assert.equal(R.tokenDigest(TOKEN).length, R.TOKEN_DIGEST_BYTES);
  assert.equal(R.tokenDigest('x').equals(R.tokenDigest('y')), false);
});

test('两个客户端经中继真实互通：A 发的数据到达 B，且带出来源端点 ID', async () => {
  await withServer({}, async ({ info, a, b }) => {
    a.hello(info.port);
    b.hello(info.port);
    await wait(60);
    const helloA = R.decode(a.queue[0]);
    const helloB = R.decode(b.queue[0]);
    assert.equal(helloA.type, R.TYPES.HELLO_OK);
    assert.notEqual(helloA.peerId, helloB.peerId, '两个端点要有不同 ID');

    a.send(info.port, Buffer.from('ping-from-a'));
    await wait(80);
    const got = b.queue.map((m) => R.decode(m)).filter((m) => m.type === R.TYPES.DATA);
    assert.equal(got.length, 1, 'B 应收到 1 条转发数据');
    assert.equal(got[0].payload.toString(), 'ping-from-a');
    assert.equal(got[0].peerId, helloA.peerId, '转发帧要带来源端点 ID');
    assert.equal(a.queue.filter((m) => R.decode(m).type === R.TYPES.DATA).length, 0, '不能回给发送方自己');

  });
});

test('口令不符：丢弃并计数，绝不转发（不是开放代理）', async () => {
  await withServer({}, async ({ server, info, a, b }) => {
    a.hello(info.port);
    b.hello(info.port);
    await wait(60);
    const before = b.queue.length;
    // 错误令牌的陌生客户端
    const stranger = dgram.createSocket('udp4');
    await new Promise((resolve) => stranger.bind(0, '127.0.0.1', resolve));
    stranger.send(R.encode(R.TYPES.HELLO, { sessionId: 7, payload: R.tokenDigest('wrong-token') }), info.port, '127.0.0.1');
    await wait(60);
    stranger.send(R.encode(R.TYPES.DATA, { sessionId: 7, payload: Buffer.from('evil') }), info.port, '127.0.0.1');
    await wait(60);
    assert.equal(b.queue.length, before, 'B 不应收到任何陌生人的数据');
    const stats = server.getStats();
    assert.equal(stats.dropped['token-mismatch'], 1);
    assert.ok(stats.dropped['unknown-peer'] >= 1, '未入会地址发数据要被丢弃');
    stranger.close();
  });
});

test('超长包与畸形包：丢弃并计数', async () => {
  await withServer({ maxPacketBytes: 64 }, async ({ server, info, a }) => {
    a.hello(info.port);
    await wait(50);
    a.send(info.port, Buffer.alloc(200, 1));
    a.socket.send(Buffer.alloc(4), info.port, '127.0.0.1');
    await wait(80);
    const stats = server.getStats();
    assert.equal(stats.dropped.oversized, 1);
    assert.equal(stats.dropped.malformed, 1);
    assert.equal(stats.packetsForwarded, 0);
  });
});

test('限速：超出令牌桶的包被丢弃并计数', async () => {
  await withServer({ ratePerSec: 2 }, async ({ server, info, a, b }) => {
    a.hello(info.port);
    b.hello(info.port);
    await wait(60);
    for (let i = 0; i < 12; i += 1) a.send(info.port, Buffer.from('x'));
    await wait(120);
    const stats = server.getStats();
    assert.ok(stats.dropped['rate-limited'] > 0, '超限的包必须被丢弃');
    assert.ok(stats.packetsForwarded <= 4, '只有少量包能通过，实际 ' + stats.packetsForwarded);
  });
});

test('空闲逐出：sweep 后端点与会话一并清理，统计可见', async () => {
  let clock = 1_000_000;
  await withServer({ idleTimeoutMs: 1000, now: () => clock }, async ({ server, info, a, b }) => {
    a.hello(info.port);
    b.hello(info.port);
    await wait(60);
    assert.equal(server.peers, 2);
    assert.equal(server.sessionsCount, 1);
    clock += 5000;
    const removed = server.sweep();
    assert.equal(removed, 2);
    assert.equal(server.peers, 0);
    assert.equal(server.sessionsCount, 0, '空会话要一起清理');
    assert.equal(server.getStats().evicted, 2);
  });
});

test('人数上限：超过后拒绝新端点（no-session），不影响已有端点', async () => {
  await withServer({ maxPeersPerSession: 2 }, async ({ server, info, a, b }) => {
    a.hello(info.port);
    b.hello(info.port);
    await wait(60);
    const third = client();
    await third.bind();
    third.hello(info.port);
    await wait(60);
    assert.equal(server.peers, 2, '只允许 2 个端点');
    assert.ok(server.getStats().dropped['no-session'] >= 1);
    await third.close();
  });
});

test('必须设置口令才能创建服务端（否则拒绝启动）', () => {
  assert.throws(() => R.createRelayServer({}), /必须设置会话口令/);
  assert.throws(() => R.createRelayServer({ sessionToken: '' }), /必须设置会话口令/);
});

test('BYE 后端点离开，会话清空；重复入会沿用原身份', async () => {
  await withServer({}, async ({ server, info, a, b }) => {
    a.hello(info.port);
    await wait(40);
    const first = R.decode(a.queue[0]).peerId;
    a.hello(info.port);                       // 重复入会
    await wait(50);
    assert.equal(R.decode(a.queue[1]).peerId, first, '重复入会不能换身份');
    assert.equal(server.peers, 1);
    a.socket.send(R.encode(R.TYPES.BYE, { sessionId: 7 }), info.port, '127.0.0.1');
    await wait(60);
    assert.equal(server.peers, 0);
    assert.equal(server.sessionsCount, 0);
  });
});
