'use strict';
// UDP 中继内核测试（阶段 2 转发 + 阶段 3 加密）
// 运行：node --test --test-isolation=none test/udp-relay.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');

const { createUdpHost, createUdpJoiner } = require('../network/udp-relay.cjs');
const D = require('../network/secure-datagram.cjs');
const h = require('./helpers.cjs');

const LOOPBACK = '127.0.0.1';
const startUdpEcho = h.startUdpEcho;
const udpRoundTrip = h.udpRoundTrip;
const udpSend = h.udpSend;
const freeUdpPort = h.freeUdpPort;

test('UDP 参数校验：非法端口 / 空地址', () => {
  assert.throws(() => createUdpHost({ relayPort: 0, targetPort: 1000 }), /1–65535/);
  assert.throws(() => createUdpHost({ relayPort: 1000, targetPort: 70000 }), /1–65535/);
  assert.throws(() => createUdpJoiner({ localPort: 0, host: LOOPBACK, relayPort: 1 }), /1–65535/);
  assert.throws(() => createUdpJoiner({ localPort: 1000, host: '  ', relayPort: 1 }), /房主地址不能为空/);
});

test('UDP 单向链路：host + joiner 转发，数据报原样往返', async () => {
  const echo = await startUdpEcho();
  const relayPort = await freeUdpPort();
  const localPort = await freeUdpPort();
  const host = createUdpHost({ bindHost: LOOPBACK, relayPort, targetHost: LOOPBACK, targetPort: echo.port });
  const joiner = createUdpJoiner({ bindHost: LOOPBACK, localPort, host: LOOPBACK, relayPort });
  try {
    await host.ready;
    await joiner.ready;

    const reply = await udpRoundTrip(localPort, 'udp-ping');
    assert.ok(reply, '应收到回包');
    assert.equal(reply.toString(), 'udp-ping');
    assert.equal(echo.seen.length, 1);

    // 大一点的数据报（接近常见 MTU 之内）
    const payload = Buffer.alloc(1200, 9);
    const big = await udpRoundTrip(localPort, payload);
    assert.ok(big && big.equals(payload), '1200 字节数据报应原样返回');

    assert.ok(host.stats.packetsFromPeer >= 2, `host 应统计到入包，实际 ${host.stats.packetsFromPeer}`);
    assert.ok(host.stats.packetsToPeer >= 2);
    assert.ok(joiner.stats.bytesFromPeer >= 1200);
    assert.equal(host.stats.clients, 1, 'host 侧应为该加入者建立一个会话');
    assert.equal(echo.peers(), 1, '游戏服务只应看到 host 的一个源端口');
  } finally {
    await joiner.stop();
    await host.stop();
    await echo.close();
  }
});

test('UDP 加密模式：口令正确可通，口令错误的数据报不但没有回包，也不会到达游戏服务', async () => {
  const echo = await startUdpEcho();
  const relayPort = await freeUdpPort();
  const goodLocal = await freeUdpPort();
  const badLocal = await freeUdpPort();
  const host = createUdpHost({ bindHost: LOOPBACK, relayPort, targetHost: LOOPBACK, targetPort: echo.port, authToken: 'udp-token' });
  const badEvents = [];
  const good = createUdpJoiner({ bindHost: LOOPBACK, localPort: goodLocal, host: LOOPBACK, relayPort, authToken: 'udp-token' });
  const bad = createUdpJoiner({
    bindHost: LOOPBACK, localPort: badLocal, host: LOOPBACK, relayPort, authToken: 'wrong-token',
    onEvent: (type, payload) => badEvents.push({ type, payload }),
  });
  try {
    await host.ready;
    await good.ready;
    await bad.ready;

    const ok = await udpRoundTrip(goodLocal, 'with-token');
    assert.ok(ok && ok.toString() === 'with-token');
    assert.equal(echo.seen.length, 1);
    assert.equal(host.stats.encrypted, true, '房主侧应处于加密模式');

    const denied = await udpRoundTrip(badLocal, 'bad-token');
    assert.equal(denied, null, '口令错误不应收到任何回包');
    assert.equal(echo.seen.length, 1, '口令错误的数据报不应到达游戏服务');
    assert.equal(host.stats.clients, 1, '口令错误的来源不应建立会话');
    assert.ok(
      await h.waitFor(() => badEvents.some((e) => e.type === 'error' && /口令不匹配/.test(e.payload.error.friendly)), { timeoutMs: 3000 }),
      '口令错误的加入者应拿到可读原因',
    );
    // 修正口令后（模拟用户重新开始会话）应当能正常工作
    await bad.stop();
    const fixed = createUdpJoiner({ bindHost: LOOPBACK, localPort: badLocal, host: LOOPBACK, relayPort, authToken: 'udp-token' });
    try {
      await fixed.ready;
      const retry = await udpRoundTrip(badLocal, 'fixed-token');
      assert.ok(retry && retry.toString() === 'fixed-token', '换成正确口令后应恢复');
    } finally {
      await fixed.stop();
    }
  } finally {
    await bad.stop();
    await good.stop();
    await host.stop();
    await echo.close();
  }
});

test('UDP 无口令时保持裸转发（向后兼容，无 12 字节头）', async () => {
  const echo = await startUdpEcho();
  const relayPort = await freeUdpPort();
  const localPort = await freeUdpPort();
  const host = createUdpHost({ bindHost: LOOPBACK, relayPort, targetHost: LOOPBACK, targetPort: echo.port });
  const joiner = createUdpJoiner({ bindHost: LOOPBACK, localPort, host: LOOPBACK, relayPort });
  try {
    await host.ready;
    await joiner.ready;
    const reply = await udpRoundTrip(localPort, 'plain');
    assert.ok(reply && reply.toString() === 'plain');
    assert.equal(echo.seen[0].msg.length, 5, '不应附加口令头');
  } finally {
    await joiner.stop();
    await host.stop();
    await echo.close();
  }
});

test('UDP 会话隔离：两个加入者各自映射到游戏服务的不同源端口', async () => {
  const echo = await startUdpEcho();
  const relayPort = await freeUdpPort();
  const localA = await freeUdpPort();
  const localB = await freeUdpPort();
  const host = createUdpHost({ bindHost: LOOPBACK, relayPort, targetHost: LOOPBACK, targetPort: echo.port });
  const a = createUdpJoiner({ bindHost: LOOPBACK, localPort: localA, host: LOOPBACK, relayPort });
  const b = createUdpJoiner({ bindHost: LOOPBACK, localPort: localB, host: LOOPBACK, relayPort });
  try {
    await host.ready;
    await a.ready;
    await b.ready;

    assert.ok(await udpRoundTrip(localA, 'from-A'));
    assert.ok(await udpRoundTrip(localB, 'from-B'));

    assert.equal(host.stats.clients, 2, 'host 应为两个加入者各建一个会话');
    assert.equal(echo.peers(), 2, '两个加入者应体现为游戏服务的两个不同源端口');
    const payloads = echo.seen.map((s) => s.msg.toString()).sort();
    assert.deepEqual(payloads, ['from-A', 'from-B']);
  } finally {
    await b.stop();
    await a.stop();
    await host.stop();
    await echo.close();
  }
});

test('UDP 会话老化：空闲超时后回收映射，端口仍可用', async () => {
  const echo = await startUdpEcho();
  const relayPort = await freeUdpPort();
  const localPort = await freeUdpPort();
  const events = [];
  const host = createUdpHost({
    bindHost: LOOPBACK, relayPort, targetHost: LOOPBACK, targetPort: echo.port,
    clientIdleMs: 120, onEvent: (type, payload) => events.push({ type, payload }),
  });
  const joiner = createUdpJoiner({ bindHost: LOOPBACK, localPort, host: LOOPBACK, relayPort, clientIdleMs: 120 });
  try {
    await host.ready;
    await joiner.ready;
    assert.ok(await udpRoundTrip(localPort, 'keepalive'));
    assert.equal(host.stats.clients, 1);
    assert.ok(await h.waitFor(() => host.stats.clients === 0, { timeoutMs: 8000 }), '空闲会话应被回收');
    assert.ok(events.some((e) => e.type === 'client-expired'));
    // 回收后再来一包仍能建立新会话（端口没被关掉）
    assert.ok(await udpRoundTrip(localPort, 'again'));
    assert.equal(host.stats.clients, 1);
  } finally {
    await joiner.stop();
    await host.stop();
    await echo.close();
  }
});

test('UDP 最大会话数：超出上限的来源被拒绝（口令模式，只有已认证来源能建立会话）', async () => {
  const echo = await startUdpEcho();
  const relayPort = await freeUdpPort();
  const host = createUdpHost({ bindHost: LOOPBACK, relayPort, targetHost: LOOPBACK, targetPort: echo.port, maxClients: 1, authToken: 'udp-tok' });
  try {
    await host.ready;
    // 两个独立客户端各自与房主完成加密握手，模拟两个加入者
    const makeClient = () => {
      const client = new D.SecureDatagramClient({ passphrase: 'udp-tok' });
      const sock = dgram.createSocket('udp4');
      const state = { client, sock, replies: [], ready: false, denied: false, denyReason: '' };
      sock.on('message', (msg) => {
        const result = client.handle(msg);
        if (result.action === 'send') sock.send(result.reply, relayPort, LOOPBACK);
        else if (result.action === 'ready') state.ready = true;
        else if (result.action === 'error') { state.denied = true; state.denyReason = String(result.reason || ''); }
        else if (result.action === 'data') state.replies.push(result.payload);
      });
      state.start = async () => {
        await new Promise((r) => sock.bind(0, LOOPBACK, r));
        sock.send(client.hello(), relayPort, LOOPBACK);
        return h.waitFor(() => state.ready, { timeoutMs: 3000 });
      };
      return state;
    };

    const first = makeClient();
    const second = makeClient();
    try {
      assert.equal(await first.start(), true, '第一个加入者应完成握手');
      // 第二个加入者认证通过，但会收到「房间已满」的明确拒绝
      await second.start();
      assert.equal(await h.waitFor(() => second.denied, { timeoutMs: 2000 }), true, '超限加入者应收到 DENY');
      assert.match(second.denyReason, /房间已满/);
      assert.equal(second.client.seal(Buffer.from('two')), null, '被拒绝后不应还能加密发送');

      first.sock.send(first.client.seal(Buffer.from('one')), relayPort, LOOPBACK);
      await h.wait(400);
      assert.equal(host.stats.clients, 1, '只应建立一个会话映射');
      assert.equal(host.stats.rejected >= 1, true, '超限来源应被记为拒绝');
      assert.equal(first.replies.length, 1, '已建立会话的来源应正常收到回包');
      assert.equal(second.replies.length, 0, '超限来源不应收到回包');
    } finally {
      first.sock.close();
      second.sock.close();
    }
  } finally {
    await host.stop();
    await echo.close();
  }
});

test('UDP 停止后端口释放，stop 幂等', async () => {
  const echo = await startUdpEcho();
  const relayPort = await freeUdpPort();
  const host = createUdpHost({ bindHost: LOOPBACK, relayPort, targetHost: LOOPBACK, targetPort: echo.port });
  try {
    await host.ready;
    assert.equal((await require('../network/session.cjs').checkUdpPortFree(relayPort, LOOPBACK)).free, false);
    await host.stop();
    await h.wait(150);
    assert.equal((await require('../network/session.cjs').checkUdpPortFree(relayPort, LOOPBACK)).free, true, '停止后 UDP 端口必须可重新绑定');
    await host.stop();
  } finally {
    await host.stop();
    await echo.close();
  }
});

test('UDP 加密模式：房主中继能独立完成数据报握手并回 READY（不经过 joiner 中继）', async () => {
  const echo = await startUdpEcho();
  const relayPort = await freeUdpPort();
  const host = createUdpHost({ bindHost: LOOPBACK, relayPort, targetHost: LOOPBACK, targetPort: echo.port, authToken: 'direct-tok' });
  const sock = dgram.createSocket('udp4');
  const client = new D.SecureDatagramClient({ passphrase: 'direct-tok' });
  try {
    await host.ready;
    await new Promise((r) => sock.bind(0, LOOPBACK, r));
    let ready = false;
    const replies = [];
    sock.on('message', (msg) => {
      const result = client.handle(msg);
      if (result.action === 'send') sock.send(result.reply, relayPort, LOOPBACK);
      else if (result.action === 'ready') ready = true;
      else if (result.action === 'data') replies.push(result.payload);
    });
    sock.send(client.hello(), relayPort, LOOPBACK);
    assert.equal(await h.waitFor(() => ready, { timeoutMs: 3000 }), true, '应完成握手');
    assert.equal(host.stats.encrypted, true);
    assert.ok(host.stats.sessionId, '房主应记录会话标识');

    sock.send(client.seal(Buffer.from('direct-secure')), relayPort, LOOPBACK);
    assert.equal(await h.waitFor(() => replies.length === 1, { timeoutMs: 3000 }), true, '应收到加密回包');
    assert.equal(replies[0].toString(), 'direct-secure');
  } finally {
    sock.close();
    await host.stop();
    await echo.close();
  }
});

test('UDP 加密模式：口令不一致时无法建立会话，数据报不会被转发到游戏', async () => {
  const echo = await startUdpEcho();
  const relayPort = await freeUdpPort();
  const host = createUdpHost({ bindHost: LOOPBACK, relayPort, targetHost: LOOPBACK, targetPort: echo.port, authToken: 'right-tok' });
  const sock = dgram.createSocket('udp4');
  const client = new D.SecureDatagramClient({ passphrase: 'wrong-tok' });
  try {
    await host.ready;
    await new Promise((r) => sock.bind(0, LOOPBACK, r));
    let failed = false;
    sock.on('message', (msg) => {
      const result = client.handle(msg);
      if (result.action === 'send') sock.send(result.reply, relayPort, LOOPBACK);
      else if (result.action === 'error') failed = true;
    });
    sock.send(client.hello(), relayPort, LOOPBACK);
    assert.equal(await h.waitFor(() => failed, { timeoutMs: 3000 }), true, '加入者应发现口令不匹配');
    assert.equal(host.stats.clients, 0, '不应建立任何会话');
    assert.equal(echo.seen.length, 0, '游戏服务不应收到任何数据报');
  } finally {
    sock.close();
    await host.stop();
    await echo.close();
  }
});
