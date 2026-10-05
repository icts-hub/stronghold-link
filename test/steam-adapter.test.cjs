'use strict';
// Steam P2P 适配器测试（阶段 4 + 通用化）：使用**注入的假 SDK**，不是真实 Steam。
// 运行：node --test --test-isolation=none test/steam-adapter.test.cjs
//
// 诚实声明：本机没有 Steamworks SDK redistributable（Valve 不允许随包分发），
// 真实 Steam P2P 无法在本机验证。这些测试验证的是「我们这一侧的桥接逻辑」：
// 状态机、accept/poll、消息搬运、多路复用、上限、清理，以及与本地 TCP 服务的对接。
const test = require('node:test');
const assert = require('node:assert/strict');

const { createSteamHost, createSteamJoiner, STEAM_ID_PATTERN } = require('../network/steam-adapter.cjs');
const { createMockSdk, HOST_STEAM_ID, STATE } = require('./steam-mock.cjs');
const h = require('./helpers.cjs');

const CONN = 101;

test('SteamID 校验：只接受 7656119 开头的 17 位数字', () => {
  assert.equal(STEAM_ID_PATTERN.test('76561198000000001'), true);
  assert.equal(STEAM_ID_PATTERN.test('12345'), false);
  assert.equal(STEAM_ID_PATTERN.test(''), false);
  assert.throws(() => createSteamJoiner({ localPort: 1234, hostSteamId: 'nope', sdk: {} }), /SteamID 格式不正确/);
  assert.throws(() => createSteamHost({ gamePort: 0, sdk: {} }), /1–65535/);
});

test('房主：Steam 对端连进来后，消息能双向搬运到本地服务端口', async () => {
  const game = await h.startEchoServer();
  const mock = createMockSdk();
  const events = [];
  const host = createSteamHost({
    gameHost: '127.0.0.1', gamePort: game.port, sdk: mock.sdk,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  try {
    const info = await host.ready;
    assert.equal(info.steamId, HOST_STEAM_ID, '应返回本机 SteamID');
    assert.ok(events.some((e) => e.type === 'listening'));

    mock.state.emitState({ connection: CONN, oldState: 0, newState: STATE.Connecting, info: { identityRemote: '76561198000000002' } });
    assert.deepEqual(mock.state.accepted, [CONN], 'Connecting 必须 accept');
    assert.equal(mock.state.pollGroups.length, 1, '必须加入 poll group');
    mock.state.emitState({ connection: CONN, oldState: STATE.Connecting, newState: STATE.Connected, info: { identityRemote: '76561198000000002' } });
    assert.ok(events.some((e) => e.type === 'peer-joined'));
    assert.equal(host.stats.peers, 1);

    mock.state.pushToHost(CONN, 'from-steam');
    assert.ok(await h.waitFor(() => host.stats.bytesFromPeer >= 10, { timeoutMs: 3000 }), '应统计到来自 Steam 的字节');

    assert.ok(await h.waitFor(() => mock.state.sent.some((s) => s.data.toString() === 'from-steam'), { timeoutMs: 3000 }),
      `本地回包应发回 Steam，实际发送：${mock.state.sent.map((s) => s.data.toString()).join('|')}`);
    assert.ok(host.stats.bytesToPeer >= 10);
  } finally {
    await host.stop();
    await game.close();
  }
});

test('房主：每个对端各占一条独立的本地连接（互不串线）', async () => {
  const game = await h.startEchoServer();
  const mock = createMockSdk();
  const host = createSteamHost({ gamePort: game.port, sdk: mock.sdk });
  try {
    await host.ready;
    const second = CONN + 1;
    for (const connection of [CONN, second]) {
      mock.state.emitState({ connection, newState: STATE.Connecting, info: { identityRemote: `7656119800000000${connection}` } });
      mock.state.emitState({ connection, newState: STATE.Connected, info: { identityRemote: `7656119800000000${connection}` } });
    }
    assert.equal(host.stats.peers, 2);
    assert.ok(await h.waitFor(() => game.connections() === 2, { timeoutMs: 3000 }), '本地服务应看到两条独立连接');

    mock.state.pushToHost(CONN, 'peer-A');
    mock.state.pushToHost(second, 'peer-B');
    assert.ok(await h.waitFor(() => mock.state.sent.filter((s) => ['peer-A', 'peer-B'].includes(s.data.toString())).length >= 2, { timeoutMs: 3000 }));
    const forA = mock.state.sent.find((s) => s.data.toString() === 'peer-A');
    const forB = mock.state.sent.find((s) => s.data.toString() === 'peer-B');
    assert.equal(forA.connection, CONN, 'A 的回包必须走 A 的连接');
    assert.equal(forB.connection, second, 'B 的回包必须走 B 的连接');
  } finally {
    await host.stop();
    await game.close();
  }
});

test('房主：超过最大对端数时拒绝，并在断开时清理', async () => {
  const game = await h.startEchoServer();
  const mock = createMockSdk();
  const events = [];
  const host = createSteamHost({ gamePort: game.port, sdk: mock.sdk, maxPeers: 1, onEvent: (type, payload) => events.push({ type, payload }) });
  try {
    await host.ready;
    mock.state.emitState({ connection: CONN, newState: STATE.Connecting, info: { identityRemote: '76561198000000002' } });
    mock.state.emitState({ connection: CONN, newState: STATE.Connected, info: { identityRemote: '76561198000000002' } });
    assert.equal(host.stats.peers, 1);

    const second = CONN + 1;
    mock.state.emitState({ connection: second, newState: STATE.Connecting, info: { identityRemote: '76561198000000003' } });
    assert.equal(host.stats.rejected, 1);
    assert.ok(mock.state.closed.some((c) => c.connection === second && c.reason === 100), '超限对端应被关闭');

    mock.state.emitState({ connection: CONN, newState: STATE.ClosedByPeer, info: { identityRemote: '76561198000000002', endDebugMessage: 'bye' } });
    assert.equal(host.stats.peers, 0);
    assert.ok(events.some((e) => e.type === 'peer-left'));
  } finally {
    await host.stop();
    await game.close();
  }
});

test('房主：不会 accept 自己发起的出站连接（listenSocket=0，自连时的真实情况）', async () => {
  const game = await h.startEchoServer();
  const mock = createMockSdk();
  const host = createSteamHost({ gamePort: game.port, sdk: mock.sdk });
  try {
    await host.ready;
    // 出站连接：info.listenSocket === 0，accept 它会返回 11
    mock.state.emitState({ connection: CONN, newState: STATE.Connecting, info: { identityRemote: '76561198000000001', listenSocket: 0 } });
    assert.deepEqual(mock.state.accepted, [], '出站连接不应被 accept');
    assert.equal(host.stats.peers, 0);
    assert.equal(host.stats.rejected, 0, '这不是「被拒绝的连接」，只是不属于本监听 socket');
    // 入站连接：listenSocket 是我们的监听句柄，应当 accept
    mock.state.emitState({ connection: CONN + 1, newState: STATE.Connecting, info: { identityRemote: '76561198000000002', listenSocket: 11 } });
    assert.deepEqual(mock.state.accepted, [CONN + 1]);
  } finally {
    await host.stop();
    await game.close();
  }
});

test('房主：stop 会关闭监听与 poll group，且可重复调用', async () => {
  const game = await h.startEchoServer();
  const mock = createMockSdk();
  const host = createSteamHost({ gamePort: game.port, sdk: mock.sdk });
  try {
    await host.ready;
    await host.stop();
    assert.equal(mock.state.listenClosed, true);
    assert.equal(mock.state.pollDestroyed, true);
    await host.stop(); // 幂等
  } finally {
    await game.close();
  }
});

test('加入者：本机客户端 -> Steam -> 房主回包 -> 本机客户端', async () => {
  const mock = createMockSdk();
  const localPort = await h.freePort();
  const events = [];
  const joiner = createSteamJoiner({
    localPort, hostSteamId: HOST_STEAM_ID, sdk: mock.sdk,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  let client;
  try {
    const info = await joiner.ready;
    assert.equal(info.hostSteamId, HOST_STEAM_ID);
    assert.ok(events.some((e) => e.type === 'listening'));

    client = await h.connect(localPort);
    assert.ok(await h.waitFor(() => mock.state.connectedTo.length === 1, { timeoutMs: 2000 }), '应为这条本机连接新建 Steam 连接');
    const handle = mock.state.connectedTo[0].handle;
    assert.equal(mock.state.connectedTo[0].steamId, HOST_STEAM_ID);
    assert.equal(mock.state.connectedTo[0].port, 0);

    client.write('hello-host');
    mock.state.emitState({ connection: handle, newState: STATE.Connected, info: { identityRemote: HOST_STEAM_ID } });
    assert.ok(await h.waitFor(() => mock.state.sent.some((s) => s.connection === handle && s.data.toString() === 'hello-host'), { timeoutMs: 3000 }),
      `本机数据应经 sendReliable 发往房主，实际：${mock.state.sent.map((s) => s.data.toString()).join('|')}`);

    const received = h.collect(client, 6);
    mock.state.pushToClient(handle, 'reply!');
    assert.equal((await received).toString(), 'reply!');
    assert.ok(joiner.stats.bytesFromPeer >= 6);

    mock.state.emitState({ connection: handle, newState: STATE.ClosedByPeer, info: { identityRemote: HOST_STEAM_ID, endDebugMessage: 'host quit' } });
    assert.notEqual(await h.waitClosed(client), 'timeout', '房主断开后本机客户端应被关闭');
  } finally {
    client?.destroy();
    await joiner.stop();
  }
});

test('加入者多路复用（通用内网穿透的核心）：每条本机连接独立一条 Steam 连接，数据不串线', async () => {
  const mock = createMockSdk();
  const localPort = await h.freePort();
  const joiner = createSteamJoiner({ localPort, hostSteamId: HOST_STEAM_ID, sdk: mock.sdk });
  const clients = [];
  try {
    await joiner.ready;
    // 模拟浏览器 / RDP 这类会开多条并发连接的客户端
    for (let i = 0; i < 3; i += 1) clients.push(await h.connect(localPort));
    assert.ok(await h.waitFor(() => mock.state.connectedTo.length === 3, { timeoutMs: 3000 }),
      `3 条本机连接应各建一条 Steam 连接，实际 ${mock.state.connectedTo.length}`);
    const handles = mock.state.connectedTo.map((c) => c.handle);
    assert.equal(new Set(handles).size, 3, '三条件接必须是不同的 Steam 连接');
    assert.equal(joiner.stats.connections, 3);

    for (const handle of handles) mock.state.emitState({ connection: handle, newState: STATE.Connected, info: { identityRemote: HOST_STEAM_ID } });
    clients.forEach((client, index) => client.write(`client-${index}`));
    assert.ok(await h.waitFor(() => mock.state.sent.length >= 3, { timeoutMs: 3000 }), '三条数据都应发出');

    for (let i = 0; i < 3; i += 1) {
      const matched = mock.state.sent.filter((s) => s.data.toString() === `client-${i}`);
      assert.equal(matched.length, 1, `client-${i} 应只发一次`);
      assert.equal(matched[0].connection, handles[i], `client-${i} 必须走它自己的 Steam 连接`);
    }

    const got = clients.map((client) => h.collect(client, 7));
    handles.forEach((handle, index) => mock.state.pushToClient(handle, `back-${index}`));
    const replies = await Promise.all(got);
    replies.forEach((buffer, index) => assert.equal(buffer.toString(), `back-${index}`, `第 ${index} 个客户端应收到自己的回包`));

    clients[0].destroy();
    assert.ok(await h.waitFor(() => mock.state.closed.some((c) => c.connection === handles[0]), { timeoutMs: 2000 }), '断开的本机客户端应关闭对应 Steam 连接');
    assert.equal(joiner.stats.connections, 2);
    clients[1].write('still-alive');
    assert.ok(await h.waitFor(() => mock.state.sent.some((s) => s.data.toString() === 'still-alive' && s.connection === handles[1]), { timeoutMs: 2000 }), '其它连接应继续工作');
  } finally {
    for (const client of clients) client.destroy();
    await joiner.stop();
  }
});

test('加入者：并发上限生效，超出会被拒绝', async () => {
  const mock = createMockSdk();
  const localPort = await h.freePort();
  const joiner = createSteamJoiner({ localPort, hostSteamId: HOST_STEAM_ID, sdk: mock.sdk, maxConnections: 2 });
  const clients = [];
  try {
    await joiner.ready;
    clients.push(await h.connect(localPort));
    clients.push(await h.connect(localPort));
    assert.ok(await h.waitFor(() => joiner.stats.connections === 2, { timeoutMs: 2000 }));
    clients.push(await h.connect(localPort));
    assert.notEqual(await h.waitClosed(clients[2]), 'timeout', '超出上限的连接应被关闭');
    assert.equal(joiner.stats.rejected, 1);
    assert.equal(mock.state.connectedTo.length, 2, '超限连接不应创建 Steam 连接');
  } finally {
    for (const client of clients) client.destroy();
    await joiner.stop();
  }
});

test('加入者：本机入口被占用时报可读错误', async () => {
  const busy = await h.startEchoServer();
  const mock = createMockSdk();
  const joiner = createSteamJoiner({ localPort: busy.port, hostSteamId: HOST_STEAM_ID, sdk: mock.sdk });
  try {
    await assert.rejects(joiner.ready, (err) => {
      assert.match(err.friendly, /已被占用/);
      return true;
    });
  } finally {
    await joiner.stop();
    await busy.close();
  }
});

test('环境未就绪（把 appDir 指向没有 SDK 的目录）时拒绝启动，并给出可执行提示', async () => {
  const os = require('node:os');
  const fsPromises = require('node:fs');
  const path = require('node:path');
  const game = await h.startEchoServer();
  const emptyDir = fsPromises.mkdtempSync(path.join(os.tmpdir(), 'shl-no-sdk-'));
  try {
    const host = createSteamHost({ appDir: emptyDir, gamePort: game.port, appId: 480 });
    await assert.rejects(host.ready, (err) => {
      assert.equal(err.code, 'ESTEAMENV');
      assert.match(err.friendly, /Steam 环境未就绪/);
      assert.match(err.friendly, /redistributable|steam_api/);
      assert.match(err.friendly, /PHASE4-STEAM/);
      return true;
    });
  } finally {
    fsPromises.rmSync(emptyDir, { recursive: true, force: true });
    await game.close();
  }
});

// ---- PHASE 4b：发送策略（分片 + 发送标志）---------------------------------
const { sendChunk } = require('../network/steam-adapter.cjs');
const F = require('../network/steam-framing.cjs');

function fakeSockets({ withSendMessage = true } = {}) {
  const calls = [];
  const sockets = {
    sendMessage: withSendMessage
      ? (conn, data, flags) => { calls.push({ conn, bytes: data.length, flags, via: 'sendMessage' }); return { success: true }; }
      : undefined,
    sendReliable: (conn, data) => { calls.push({ conn, bytes: data.length, via: 'sendReliable' }); return { success: true }; },
  };
  return { steam: { networkingSockets: sockets }, calls };
}

test('发送走 sendMessage，标志为 Reliable | NoNagle，小数据只发一条', () => {
  const { steam, calls } = fakeSockets();
  const out = sendChunk(steam, 7, Buffer.from('hello'), { channel: 'reliable' });
  assert.equal(out.success, true);
  assert.equal(out.chunks, 1);
  assert.equal(out.bytes, 5);
  assert.equal(out.reliable, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].via, 'sendMessage');
  assert.ok(F.isReliable(calls[0].flags), '必须带 Reliable 位');
  assert.ok(calls[0].flags & F.loadSendFlags().NoNagle, '必须关 Nagle');
});

test('大块数据按 4KB 分片，全部走 sendMessage', () => {
  const { steam, calls } = fakeSockets();
  const payload = Buffer.alloc(10000, 7);
  const out = sendChunk(steam, 3, payload, { channel: 'reliable' });
  assert.equal(out.bytes, 10000);
  assert.equal(out.chunks, 3);
  assert.ok(calls.every((c) => c.via === 'sendMessage'));
  assert.ok(calls.every((c) => c.bytes <= 4096), '每片不超过 4KB');
  assert.equal(calls.reduce((s, c) => s + c.bytes, 0), 10000, '总字节数不变');
});

test('绑定没有 sendMessage 时退回 sendReliable（行为与从前一致）', () => {
  const { steam, calls } = fakeSockets({ withSendMessage: false });
  const out = sendChunk(steam, 5, Buffer.from('legacy'), { channel: 'reliable' });
  assert.equal(out.success, true);
  assert.equal(calls[0].via, 'sendReliable', '老绑定/测试桩必须能继续工作');
});

test('发送失败会如实返回 success=false，不谎报成功', () => {
  const steam = { networkingSockets: { sendMessage: () => ({ success: false }) } };
  const out = sendChunk(steam, 1, Buffer.from('x'), { channel: 'reliable' });
  assert.equal(out.success, false);
});

test('发送抛异常时返回失败而不是崩掉会话', () => {
  const steam = { networkingSockets: { sendMessage: () => { throw new Error('连接已断开'); } } };
  const out = sendChunk(steam, 1, Buffer.from('x'), { channel: 'reliable' });
  assert.equal(out.success, false);
});
