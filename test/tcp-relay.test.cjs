'use strict';
// TCP 中继内核测试：node --test --test-isolation=none test/tcp-relay.test.cjs
//
// 注意：所有用例都用 try/finally 保证清理，避免某个断言失败后遗留监听端口把测试进程挂住。
// 房主侧固定 bindHost=127.0.0.1，因为 Windows 允许 0.0.0.0 与 127.0.0.1 同时绑定同一端口。
const test = require('node:test');
const assert = require('node:assert/strict');

const { createTcpHost, createTcpJoiner, describeError, validPort, normalizeToken } = require('../network/tcp-relay.cjs');
const h = require('./helpers.cjs');

const LOOPBACK = '127.0.0.1';

test('中继参数校验：非法端口 / 非法口令', () => {
  assert.throws(() => createTcpHost({ relayPort: 0, targetPort: 1000 }), /1–65535/);
  assert.throws(() => createTcpHost({ relayPort: 70000, targetPort: 1000 }), /1–65535/);
  assert.throws(() => createTcpJoiner({ localPort: 1000, host: '127.0.0.1', relayPort: -1 }), /1–65535/);
  assert.throws(() => createTcpJoiner({ localPort: 1000, host: '', relayPort: 1000 }), /房主地址不能为空/);
  assert.equal(validPort('2301'), 2301);
  assert.equal(normalizeToken(' abc123 '), 'abc123');
  assert.throws(() => normalizeToken('a'.repeat(65)), /64/);
  assert.throws(() => normalizeToken('bad token'), /空格/);
});

test('describeError 把系统错误码翻译成可读文案', () => {
  assert.match(describeError({ code: 'EADDRINUSE', message: 'listen EADDRINUSE' }, { port: 2301 }), /端口 2301 已被占用/);
  assert.match(describeError({ code: 'ECONNREFUSED', message: 'x' }, { host: '127.0.0.1', port: 3000 }), /拒绝连接/);
  assert.match(describeError({ code: 'ETIMEDOUT', message: 'x' }, { host: '10.0.0.9', port: 1 }), /超时/);
  assert.equal(describeError({ code: 'EWHATEVER', message: '原始信息' }), '原始信息');
});

test('host + joiner 双向转发，大小数据都完整', async () => {
  const echo = await h.startEchoServer();
  const relayPort = await h.freePort();
  const localPort = await h.freePort();
  const host = createTcpHost({ bindHost: LOOPBACK, relayPort, targetHost: LOOPBACK, targetPort: echo.port });
  const joiner = createTcpJoiner({ bindHost: LOOPBACK, localPort, host: LOOPBACK, relayPort });
  let client;
  try {
    await host.ready;
    await joiner.ready;

    client = await h.connect(localPort);
    const small = h.collect(client, 6);
    client.write('ping-1');
    assert.equal((await small).toString(), 'ping-1');

    const payload = Buffer.alloc(256 * 1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
    const large = h.collect(client, payload.length, 8000);
    client.write(payload);
    const received = await large;
    assert.equal(received.length, payload.length);
    assert.ok(received.equals(payload), '大包内容必须一致');

    assert.ok(await h.waitFor(() => host.stats.bytesFromPeer >= payload.length, { timeoutMs: 2000 }), 'host 应统计到来自对端的字节');
    assert.ok(await h.waitFor(() => joiner.stats.bytesToPeer >= payload.length, { timeoutMs: 2000 }), 'joiner 应统计到发往对端的字节');
    assert.equal(host.stats.connections, 1);
  } finally {
    client?.destroy();
    await joiner.stop();
    await host.stop();
    await echo.close();
  }
});

test('端口被占用时 ready 会 reject，且错误带 friendly 文案', async () => {
  const blocker = await h.startEchoServer();
  const host = createTcpHost({ bindHost: LOOPBACK, relayPort: blocker.port, targetHost: LOOPBACK, targetPort: blocker.port });
  try {
    await assert.rejects(host.ready, (err) => {
      assert.equal(err.code, 'EADDRINUSE');
      assert.match(err.friendly, /已被占用/);
      return true;
    });
  } finally {
    await host.stop(); // 启动失败后停止也必须安全
    await host.stop();
    await blocker.close();
  }
});

test('目标端口无人监听：客户端被关闭，中继不崩溃并上报可读错误', async () => {
  const deadPort = await h.freePort();
  const relayPort = await h.freePort();
  const events = [];
  const host = createTcpHost({
    bindHost: LOOPBACK, relayPort, targetHost: LOOPBACK, targetPort: deadPort,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  let client;
  try {
    await host.ready;
    client = await h.connect(relayPort);
    const outcome = await h.waitClosed(client);
    assert.ok(outcome !== 'timeout', `客户端应在目标不可达时被关闭，实际：${outcome}`);
    assert.ok(await h.waitFor(() => events.some((e) => e.type === 'error' && /拒绝连接|超时/.test(e.payload.error.friendly)), { timeoutMs: 3000 }));
    assert.equal(host.stats.failed >= 1, true);
  } finally {
    client?.destroy();
    await host.stop();
  }
});

test('停止后端口释放，stop 幂等', async () => {
  const echo = await h.startEchoServer();
  const relayPort = await h.freePort();
  const host = createTcpHost({ bindHost: LOOPBACK, relayPort, targetHost: LOOPBACK, targetPort: echo.port });
  try {
    await host.ready;
    assert.equal(await h.isPortFree(relayPort), false, '运行中端口应处于占用状态');
    await host.stop();
    assert.equal(await h.isPortFree(relayPort), true, '停止后端口必须可以重新绑定');
    await host.stop(); // 幂等
  } finally {
    await host.stop();
    await echo.close();
  }
});

test('停止会断开活动连接（不留悬挂 socket）', async () => {
  const echo = await h.startEchoServer();
  const relayPort = await h.freePort();
  const host = createTcpHost({ bindHost: LOOPBACK, relayPort, targetHost: LOOPBACK, targetPort: echo.port });
  let client;
  try {
    await host.ready;
    client = await h.connect(relayPort);
    assert.ok(await h.waitFor(() => echo.connections() === 1, { timeoutMs: 2000 }));
    await host.stop();
    assert.notEqual(await h.waitClosed(client), 'timeout', '客户端连接应被主动关闭');
    assert.equal(host.stats.connections, 0);
  } finally {
    client?.destroy();
    await host.stop();
    await echo.close();
  }
});

test('最大连接数生效：超出上限的连接被立即拒绝', async () => {
  const echo = await h.startEchoServer();
  const relayPort = await h.freePort();
  const events = [];
  const host = createTcpHost({
    bindHost: LOOPBACK, relayPort, targetHost: LOOPBACK, targetPort: echo.port, maxConnections: 1,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  let first;
  let second;
  try {
    await host.ready;
    first = await h.connect(relayPort);
    assert.ok(await h.waitFor(() => host.stats.connections === 1, { timeoutMs: 2000 }));

    second = await h.connect(relayPort);
    assert.equal(await h.waitClosed(second), 'closed');
    assert.ok(events.some((e) => e.type === 'rejected' && e.payload.reason === 'max-connections'));
    assert.equal(host.stats.rejected, 1);
    assert.ok(first.writable);
  } finally {
    first?.destroy();
    second?.destroy();
    await host.stop();
    await echo.close();
  }
});

test('口令模式：口令一致可以转发，口令不一致被房主拒绝且原因可读', async () => {
  const echo = await h.startEchoServer();
  const relayPort = await h.freePort();
  const goodLocal = await h.freePort();
  const badLocal = await h.freePort();

  const host = createTcpHost({ bindHost: LOOPBACK, relayPort, targetHost: LOOPBACK, targetPort: echo.port, authToken: 'token-abc' });
  const good = createTcpJoiner({ bindHost: LOOPBACK, localPort: goodLocal, host: LOOPBACK, relayPort, authToken: 'token-abc' });
  const badEvents = [];
  const bad = createTcpJoiner({
    bindHost: LOOPBACK, localPort: badLocal, host: LOOPBACK, relayPort, authToken: 'wrong-token',
    onEvent: (type, payload) => badEvents.push({ type, payload }),
  });
  let client;
  let badClient;
  try {
    await host.ready;
    await good.ready;
    await bad.ready;

    client = await h.connect(goodLocal);
    const reply = h.collect(client, 4);
    client.write('okay');
    assert.equal((await reply).toString(), 'okay');

    badClient = await h.connect(badLocal);
    const outcome = await h.waitClosed(badClient);
    assert.notEqual(outcome, 'timeout', '口令错误时本地客户端应被关闭');
    assert.ok(await h.waitFor(() => host.stats.rejected >= 1, { timeoutMs: 2000 }));
    assert.ok(
      await h.waitFor(() => badEvents.some((e) => e.type === 'error' && /口令不匹配/.test(e.payload.error.friendly)), { timeoutMs: 2000 }),
      '加入者应拿到“口令不匹配”的可读原因',
    );
  } finally {
    client?.destroy();
    badClient?.destroy();
    await bad.stop();
    await good.stop();
    await host.stop();
    await echo.close();
  }
});

test('无口令时保持旧版裸转发行为（向后兼容）', async () => {
  const echo = await h.startEchoServer();
  const relayPort = await h.freePort();
  const localPort = await h.freePort();
  const host = createTcpHost({ bindHost: LOOPBACK, relayPort, targetHost: LOOPBACK, targetPort: echo.port });
  const joiner = createTcpJoiner({ bindHost: LOOPBACK, localPort, host: LOOPBACK, relayPort });
  let client;
  try {
    await host.ready;
    await joiner.ready;
    client = await h.connect(localPort);
    const reply = h.collect(client, 7);
    client.write('legacy!');
    assert.equal((await reply).toString(), 'legacy!');
  } finally {
    client?.destroy();
    await joiner.stop();
    await host.stop();
    await echo.close();
  }
});
