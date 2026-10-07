'use strict';
// Steam P2P 适配器测试（阶段 4 + 通用化）：使用**注入的假 SDK**，不是真实 Steam。
// 运行：node --test --test-isolation=none test/steam-adapter.test.cjs
//
// 诚实声明：本机没有 Steamworks SDK redistributable（Valve 不允许随包分发），
// 真实 Steam P2P 无法在本机验证。这些测试验证的是「我们这一侧的桥接逻辑」：
// 状态机、accept/poll、消息搬运、多路复用、上限、清理，以及与本地 TCP 服务的对接。
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSteamHost, createSteamJoiner, STEAM_ID_PATTERN,
  CALLBACK_INTERVAL_MS, DRAIN_BURST, startCallbackLoop, initSteamSdk, createRouteReporter,
} = require('../network/steam-adapter.cjs');
const { createMockSdk, HOST_STEAM_ID, STATE } = require('./steam-mock.cjs');
const h = require('./helpers.cjs');

const CONN = 101;

// 预热连接池（0.13.0）是"用户看不见的时候偷偷养几条连好的连接"用的。它会在后台自己
// 建连接，于是所有"数一共有几条 Steam 连接"的断言都会失准。除了专门测池子的那两个
// 用例，其余一律关掉 —— 被测的是数据通路，不是池子。
const joinJoiner = (options = {}) => createSteamJoiner({ poolTarget: 0, ...options });

test('SteamID 校验：只接受 7656119 开头的 17 位数字', () => {
  assert.equal(STEAM_ID_PATTERN.test('76561198000000001'), true);
  assert.equal(STEAM_ID_PATTERN.test('12345'), false);
  assert.equal(STEAM_ID_PATTERN.test(''), false);
  assert.throws(() => joinJoiner({ localPort: 1234, hostSteamId: 'nope', sdk: {} }), /SteamID 格式不正确/);
  assert.throws(() => createSteamHost({ gamePort: 0, sdk: {} }), /1–65535/);
});

test('房主：本地服务回完响应立刻关连接时，最后那点字节也必须发出去（现场"地图加载不出来"的来源）', async () => {
  // 小于 outFlushBytes（16 KiB）的响应走的是 flushPeerOutSoon —— 它挂在 setImmediate 上，
  // 而 socket 的 'close' 事件比它更早。原来的 close 处理器无条件立刻 closeConnection，
  // 于是"回完就关"的服务（HTTP/1.0、Connection: close，正是游戏服务的行为）最后那段
  // 响应会永远留在 peer.out 里发不出去 —— 对端只看到"连接被关"，一个字节都没收到。
  // 本机 A/B 上是 100% 复现：同一个请求 HTTP/1.0 全挂，HTTP/1.1（keep-alive，服务端不回完就关）3/3 正常。
  const net = require('node:net');
  const game = net.createServer((socket) => {
    socket.on('data', () => { socket.write('HTTP/1.0 200 OK\r\n\r\nhi'); socket.end(); });
  });
  await new Promise((resolve) => game.listen(0, '127.0.0.1', resolve));

  const mock = createMockSdk();
  // 顺序才是重点：mock 的 sendReliable 对已关的连接也照样"成功"，所以只断言"发过"是抓不到
  // 这个 bug 的 —— 必须断言"响应是在 Steam 连接被关掉之前发出去的"。
  const realClose = mock.sockets.closeConnection;
  let sentBeforeClose = null;
  mock.sockets.closeConnection = (connection, reason, message, linger) => {
    if (sentBeforeClose === null) {
      sentBeforeClose = mock.state.sent.some((s) => s.data.toString().includes('hi'));
    }
    return realClose(connection, reason, message, linger);
  };

  const host = createSteamHost({ gameHost: '127.0.0.1', gamePort: game.address().port, sdk: mock.sdk });
  try {
    await host.ready;
    mock.state.emitState({ connection: CONN, oldState: 0, newState: STATE.Connecting, info: { identityRemote: '76561198000000002' } });
    mock.state.emitState({ connection: CONN, oldState: STATE.Connecting, newState: STATE.Connected, info: { identityRemote: '76561198000000002' } });

    mock.state.pushToHost(CONN, 'GET / HTTP/1.0\r\n\r\n');
    assert.ok(await h.waitFor(() => mock.state.sent.some((s) => s.data.toString().includes('hi')), { timeoutMs: 3000 }),
      `本地服务回完就关连接，响应仍然必须发出去；实际发送：${mock.state.sent.map((s) => s.data.toString()).join('|')}`);
    // 只断言"发过"是不够的：mock 的 sendReliable 对已关的连接也照样返回成功，
    // 而真正丢数据的是 Steam 侧 —— 关连接时若不允许 linger，刚交给它、还没出门的字节会被丢掉。
    const closeCall = mock.state.closed.find((c) => c.message === '本地服务连接关闭');
    assert.ok(closeCall, '本地服务关连接后应当收掉对应的 Steam 连接');
    assert.equal(closeCall.linger, true, '关连接必须允许 linger，否则最后那段响应会被 Steam 直接丢掉');
    assert.equal(sentBeforeClose, true, '响应必须在 Steam 连接被关掉之前发出去（先发完再关，不能反过来）');
  } finally {
    await host.stop();
    await game.close();
  }
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
  const joiner = joinJoiner({
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

test('加入者：Steam 发送缓冲满时，送到对端的字节流不能出现空洞（现场故障回归）', async () => {
  // 现场故障：几 MB 的资源传到 2~3 MiB 必断（TX_autochessi_D.png 3.29 MiB，连试 3 次全败），
  // 但同一台服务器上 384 KiB 的 Range 切片次次成功。
  // 根因是 flushPeerOut 先清空 peer.out 再看发送结果 —— Steam 发送缓冲满
  // （SendMessageToConnection 返回 k_EResultLimitExceeded）时那一整块就地蒸发，
  // 可靠流上从此多出一个洞：对端永远等不到那几个字节，几秒后连接被撕掉。
  // 这条用例用真实 TCP + 会失败的 sendMessage 逼出同一条路径，然后逐字节比对。
  const mock = createMockSdk();
  const realSend = mock.sdk.networkingSockets.sendMessage;
  let calls = 0;
  let failures = 0;
  mock.sdk.networkingSockets.sendMessage = (connection, data, flags) => {
    calls += 1;
    // 每三次失败一次，逼出"一个批次里发到一半失败"这种最刁钻的情况
    if (calls % 3 === 0) { failures += 1; return { success: false, result: 2 }; }
    return realSend(connection, data, flags); // 只有真正发成功的才进 state.sent
  };

  const localPort = await h.freePort();
  const joiner = joinJoiner({ localPort, hostSteamId: HOST_STEAM_ID, sdk: mock.sdk });
  let client;
  try {
    await joiner.ready;
    client = await h.connect(localPort);
    assert.ok(await h.waitFor(() => mock.state.connectedTo.length === 1, { timeoutMs: 2000 }));
    const handle = mock.state.connectedTo[0].handle;
    mock.state.emitState({ connection: handle, newState: STATE.Connected, info: { identityRemote: HOST_STEAM_ID } });

    const payload = Buffer.alloc(256 * 1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 7 + 11) % 251;
    client.write(payload);

    const wired = () => mock.state.sent.reduce((n, s) => n + s.data.length, 0);
    assert.ok(await h.waitFor(() => wired() >= payload.length, { timeoutMs: 20000 }),
      `发送失败重试后必须把全部 ${payload.length} 字节送到，实际只到了 ${wired()} —— 差值就是被丢掉的洞`);

    assert.ok(failures > 0, '本次必须真的触发过发送失败，否则没覆盖到这条路径');
    const wire = Buffer.concat(mock.state.sent.map((s) => s.data));
    assert.equal(wire.length, payload.length, '送到对端的字节数必须与写进去的完全一致');
    assert.ok(wire.equals(payload), '送到对端的字节流必须逐字节一致：不允许有空洞或重复');
    assert.equal(joiner.stats.dropped, 0, '可靠流上不允许计任何 dropped');
  } finally {
    client?.destroy();
    await joiner.stop();
  }
});

test('加入者多路复用（通用内网穿透的核心）：每条本机连接独立一条 Steam 连接，数据不串线', async () => {
  const mock = createMockSdk();
  const localPort = await h.freePort();
  const joiner = joinJoiner({ localPort, hostSteamId: HOST_STEAM_ID, sdk: mock.sdk });
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

test('加入者：连接结束时必须报出「谁关的、活了多久、搬了多少字节」（隧道体检日志的依据）', async () => {
  // 现场只能看到"游戏卡住了"，看不到是哪一侧、在第几秒、以什么理由关掉了连接。
  // 这些 Steam 都给了（endReason / endDebugMessage），这个用例保证它们不会被丢掉。
  const mock = createMockSdk();
  const localPort = await h.freePort();
  const events = [];
  const joiner = joinJoiner({
    localPort,
    hostSteamId: HOST_STEAM_ID,
    sdk: mock.sdk,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  let client;
  try {
    await joiner.ready;
    client = await h.connect(localPort);
    assert.ok(await h.waitFor(() => mock.state.connectedTo.length === 1, { timeoutMs: 3000 }), '本机连接应建一条 Steam 连接');
    const handle = mock.state.connectedTo[0].handle;
    mock.state.emitState({ connection: handle, newState: STATE.Connected, info: { identityRemote: HOST_STEAM_ID } });
    assert.ok(await h.waitFor(() => events.some((e) => e.type === 'peer-connected'), { timeoutMs: 2000 }), '接上要有事件');

    client.write('hello-tunnel');
    assert.ok(await h.waitFor(() => mock.state.sent.length >= 1, { timeoutMs: 3000 }), '上行数据应发出');
    mock.state.pushToClient(handle, 'reply-from-host');
    assert.ok(await h.waitFor(() => joiner.stats.bytesFromPeer > 0, { timeoutMs: 3000 }), '下行回包应计入字节数');

    mock.state.emitState({
      connection: handle,
      newState: STATE.ProblemDetectedLocally,
      info: { endReason: 4006, endDebugMessage: 'Remote host closed connection' },
    });

    assert.ok(await h.waitFor(() => events.some((e) => e.type === 'peer-left'), { timeoutMs: 3000 }), '断开必须抛 peer-left');
    const left = events.filter((e) => e.type === 'peer-left').pop();
    assert.equal(left.payload.kind, 'ProblemDetectedLocally', '要区分"本地判定出问题"与"对端关闭"');
    assert.equal(left.payload.endReason, 4006, 'Steam 给的 endReason 不能丢');
    assert.match(String(left.payload.reason), /Remote host closed connection/, 'endDebugMessage 要原样带上');
    assert.ok(Number.isFinite(left.payload.ageMs) && left.payload.ageMs >= 0, '要报出这条连接活了多久');
    assert.equal(left.payload.bytesToPeer, 'hello-tunnel'.length, '要报出这条连接实际搬了多少上行字节');
    assert.equal(left.payload.bytesFromPeer, 'reply-from-host'.length, '要报出这条连接实际搬了多少下行字节');
    assert.ok(Number.isFinite(left.payload.outBytes), '要报出断开时还积压着多少字节');
    assert.ok(Number.isFinite(left.payload.port), '要报出是本机哪个端口');
  } finally {
    if (client) client.destroy();
    await joiner.stop();
  }
});

test('加入者：首字节都没回来就断的连接要悄悄重连并重放请求（现场"页面一直转圈"的回归）', async () => {
  // 现场症状：一个首页要开十几条本机连接 = 十几条独立 Steam P2P 连接，
  // 随机几条握手没成（0 字节、1.2~2.5 秒后 ECONNRESET），浏览器就一直转圈。
  // 这种情况重连一次多半就通，所以不能把浏览器的连接一起掐掉。
  const mock = createMockSdk();
  const localPort = await h.freePort();
  const events = [];
  const joiner = joinJoiner({
    localPort,
    hostSteamId: HOST_STEAM_ID,
    sdk: mock.sdk,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  const request = 'GET /index.html HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n';
  let client;
  try {
    await joiner.ready;
    client = await h.connect(localPort);
    assert.ok(await h.waitFor(() => mock.state.connectedTo.length === 1, { timeoutMs: 3000 }), '本机连接应建一条 Steam 连接');
    const first = mock.state.connectedTo[0].handle;
    mock.state.emitState({ connection: first, newState: STATE.Connected, info: { identityRemote: HOST_STEAM_ID } });
    assert.ok(await h.waitFor(() => events.some((e) => e.type === 'peer-connected'), { timeoutMs: 2000 }), '接上要有事件');

    client.write(request);
    assert.ok(
      await h.waitFor(() => mock.state.sent.some((s) => s.connection === first && s.data.toString() === request), { timeoutMs: 3000 }),
      '请求应沿第一条连接发出去',
    );

    // 对端一个字节都没回就断了 —— 正是现场那种"这次握手没成"。
    mock.state.emitState({
      connection: first,
      newState: STATE.ProblemDetectedLocally,
      info: { endReason: 4001, endDebugMessage: 'Timed out' },
    });

    assert.ok(await h.waitFor(() => events.some((e) => e.type === 'peer-left' && e.payload.willRetry), { timeoutMs: 3000 }), '要报出"这次失败会重试"');
    const retryNotice = events.filter((e) => e.type === 'peer-left' && e.payload.willRetry).pop();
    assert.equal(retryNotice.payload.retry, 1, '要报出这是第几次重试');
    assert.equal(await h.waitClosed(client, 400), 'timeout', '重连期间不能把浏览器的连接一起关掉');

    assert.ok(await h.waitFor(() => mock.state.connectedTo.length === 2, { timeoutMs: 3000 }), '应悄悄建第二条 Steam 连接');
    const second = mock.state.connectedTo[1].handle;
    mock.state.emitState({ connection: second, newState: STATE.Connected, info: { identityRemote: HOST_STEAM_ID } });

    assert.ok(
      await h.waitFor(() => mock.state.sent.some((s) => s.connection === second && s.data.toString() === request), { timeoutMs: 3000 }),
      '没被对端确认过的请求要在新连接上重放（否则对端永远等不到，浏览器一直转圈）',
    );
    assert.equal(joiner.stats.reconnects, 1, '重连次数要计入统计，便于现场判断是偶发还是一直在失败');

    // 新连接真的可用：回包要能到本机客户端。
    mock.state.pushToClient(second, 'HTTP/1.1 200 OK\r\n\r\nhi');
    const got = await h.collect(client, 24, 2000);
    assert.match(got.toString(), /200 OK/, '重连之后数据流要通');
  } finally {
    if (client) client.destroy();
    await joiner.stop();
  }
});

test('加入者：一直建不起来时重连次数有上限，最终如实关掉本机连接（不无限重试）', async () => {
  const mock = createMockSdk();
  const localPort = await h.freePort();
  const events = [];
  const joiner = joinJoiner({
    localPort,
    hostSteamId: HOST_STEAM_ID,
    sdk: mock.sdk,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  let client;
  let clientClosed = null;
  try {
    await joiner.ready;
    client = await h.connect(localPort);
    // 先挂上监听：等到最后才挂的话，"已经关掉了"这一刻已经过去，永远等不到。
    const closedWait = h.waitClosed(client, 6000).then((value) => { clientClosed = value; });
    for (let round = 0; round < 4; round++) {
      const target = round + 1;
      assert.ok(await h.waitFor(() => mock.state.connectedTo.length === target, { timeoutMs: 3000 }), `第 ${target} 条连接应建起来`);
      const handle = mock.state.connectedTo[target - 1].handle;
      mock.state.emitState({ connection: handle, newState: STATE.Connected, info: { identityRemote: HOST_STEAM_ID } });
      mock.state.emitState({
        connection: handle,
        newState: STATE.ProblemDetectedLocally,
        info: { endReason: 5003, endDebugMessage: 'timed out' },
      });
      await h.wait(60);
    }
    assert.equal(joiner.stats.reconnects, 3, '重试上限内应恰好重连 3 次');
    assert.equal(mock.state.connectedTo.length, 4, '到上限后不应再建新连接');
    await closedWait;
    assert.notEqual(clientClosed, 'timeout', '重试耗尽后必须如实关掉本机连接，不能让浏览器干等');
    assert.ok(events.some((e) => e.type === 'peer-left' && !e.payload.willRetry), '最终收尾要有一次不带 willRetry 的 peer-left');
  } finally {
    if (client) client.destroy();
    await joiner.stop();
  }
});

test('加入者：慢失败不许重试 —— 0.12.8 那 42 秒干等就是这么来的', async () => {
  // 现场：一次建连失败要等满 Steam 的 TimeoutInitial（出厂 10 秒）才被判死，
  // 而 0.12.8 对**任何**失败都重试，于是 10 秒 × 3 次 + 退避 ≈ 40 秒。
  // diag/latency.cjs 量到的首次请求首字节 42533 ms 就是这么来的 —— 比不重试还糟：
  // 浏览器的请求和游戏的加载画面早就超时了。
  //
  // 现在只有"快失败"（握手耗时 < retryFastMs）才重试。这里把门槛设成 0，
  // 等价于"任何失败都算慢失败"，正好用来钉住"不重试"这条路径。
  const mock = createMockSdk();
  const localPort = await h.freePort();
  const events = [];
  const joiner = joinJoiner({
    localPort,
    hostSteamId: HOST_STEAM_ID,
    sdk: mock.sdk,
    retryFastMs: 0,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  let client;
  let clientClosed = null;
  try {
    await joiner.ready;
    client = await h.connect(localPort);
    const closedWait = h.waitClosed(client, 3000).then((value) => { clientClosed = value; });
    assert.ok(await h.waitFor(() => mock.state.connectedTo.length === 1, { timeoutMs: 3000 }), '本机连接应建一条 Steam 连接');
    const handle = mock.state.connectedTo[0].handle;
    mock.state.emitState({ connection: handle, newState: STATE.Connected, info: { identityRemote: HOST_STEAM_ID } });
    mock.state.emitState({
      connection: handle,
      newState: STATE.ProblemDetectedLocally,
      info: { endReason: 5003, endDebugMessage: 'Timed out attempting to connect' },
    });

    await closedWait;
    assert.notEqual(clientClosed, 'timeout', '慢失败必须立刻如实关掉本机连接，不能让浏览器干等 40 秒');
    assert.equal(joiner.stats.reconnects, 0, '慢失败不许重连');
    assert.equal(mock.state.connectedTo.length, 1, '不该再多建连接');
    const last = events.filter((e) => e.type === 'peer-left').pop();
    assert.ok(last, '要有一次收尾的 peer-left');
    assert.ok(!last.payload.willRetry, '这条不该带 willRetry');
    assert.ok(Number.isFinite(last.payload.attemptMs), '要报出这次握手耗时，供现场判断是不是撞上了建连超时');
  } finally {
    if (client) client.destroy();
    await joiner.stop();
  }
});

test('加入者：预热连接池趁没人用的时候先把连接养好，浏览器一进来就直接拿现成的（现场"每次都无法加载出地图"的回归）', async () => {
  const mock = createMockSdk();
  const localPort = await h.freePort();
  const joiner = createSteamJoiner({
    localPort, hostSteamId: HOST_STEAM_ID, sdk: mock.sdk,
    poolTarget: 2, poolGapMs: 0,
  });
  let client = null;
  try {
    await joiner.ready;
    // 池子应该在**没有任何本机客户端**的情况下自己把两条 Steam 连接建起来：
    // Steam 的握手是排队限速的（现场实测 ~1 条 / 3 秒），这段等待以前全落在用户点开页面的那一刻。
    assert.ok(await h.waitFor(() => mock.state.connectedTo.length >= 2, { timeoutMs: 3000 }), '池子应主动预热两条 Steam 连接');
    // 让它们进入 Connected（房主那边这时才真正去连游戏端口）。
    for (const entry of mock.state.connectedTo.slice()) mock.state.emitState({ connection: entry.handle, newState: STATE.Connected, info: {} });
    assert.ok(await h.waitFor(() => (joiner.stats.poolReady || 0) >= 2, { timeoutMs: 3000 }), '两条预热连接都应该就绪');

    // 关键一步：浏览器现在才连进来，它必须直接命中池子，而不是从零开始握手。
    client = await h.connect(localPort);
    assert.ok(await h.waitFor(() => joiner.stats.poolHits === 1, { timeoutMs: 2000 }), '第一条本机连接应命中池子');
    assert.equal(mock.state.connectedTo.length, 2, '命中池子不该再发起新的握手 —— 用户就不该等');

    // 命中的那条必须是真的通的：请求发得出去，回包也收得回来。
    client.write(Buffer.from('hello-pool'));
    assert.ok(await h.waitFor(() => mock.state.sent.some((s) => s.data.toString() === 'hello-pool'), { timeoutMs: 2000 }), '本机请求应经池子里的连接送出去');
    const used = mock.state.sent.find((s) => s.data.toString() === 'hello-pool').connection;
    assert.ok(mock.state.connectedTo.some((c) => c.handle === used), '送出去的必须走池子里预热好的那条连接');

    const back = h.collect(client, 'reply-from-pool'.length);
    mock.state.pushToClient(used, Buffer.from('reply-from-pool'));
    assert.equal((await back).toString(), 'reply-from-pool', '回包应原样到达本机客户端');
  } finally {
    if (client) client.destroy();
    await joiner.stop();
  }
});

test('加入者：池子里的连接不会被领两次，也不会超过目标条数', async () => {
  const mock = createMockSdk();
  const localPort = await h.freePort();
  const joiner = createSteamJoiner({
    localPort, hostSteamId: HOST_STEAM_ID, sdk: mock.sdk,
    poolTarget: 2, poolGapMs: 0,
  });
  const clients = [];
  try {
    await joiner.ready;
    assert.ok(await h.waitFor(() => mock.state.connectedTo.length >= 2, { timeoutMs: 3000 }));
    for (const entry of mock.state.connectedTo.slice()) mock.state.emitState({ connection: entry.handle, newState: STATE.Connected, info: {} });
    assert.ok(await h.waitFor(() => (joiner.stats.poolReady || 0) >= 2, { timeoutMs: 3000 }));

    // 两条本机连接各领一条池子里的连接，谁都不该被领两次。
    clients.push(await h.connect(localPort));
    clients.push(await h.connect(localPort));
    assert.ok(await h.waitFor(() => joiner.stats.poolHits === 2, { timeoutMs: 2000 }), '两条连接都应命中池子');

    // 被领走之后池子会补货，但**不应该超过目标条数**（预热是后台行为，不能无限开连接）。
    await h.wait(120);
    const live = mock.state.connectedTo.length;
    assert.ok(live <= 4, `预热总量应受目标条数约束，实际 ${live}`);
    assert.equal(joiner.stats.poolFailures || 0, 0);
  } finally {
    for (const client of clients) client.destroy();
    await joiner.stop();
  }
});

test('加入者：同一条预热连接被报两次 Connected 也不能把"就绪"数成两条', async () => {
  // 真实 Steam 上中继换路会重报 Connected。计数不设防的话"就绪"会比"累计开"还大，
  // 现场日志看起来就像池子开了双份，判断"池子够不够"也会跟着失准。
  const mock = createMockSdk();
  const localPort = await h.freePort();
  const joiner = createSteamJoiner({
    localPort, hostSteamId: HOST_STEAM_ID, sdk: mock.sdk,
    poolTarget: 1, poolGapMs: 0,
  });
  try {
    await joiner.ready;
    assert.ok(await h.waitFor(() => mock.state.connectedTo.length >= 1, { timeoutMs: 3000 }));
    const handle = mock.state.connectedTo[0].handle;
    mock.state.emitState({ connection: handle, newState: STATE.Connected, info: {} });
    mock.state.emitState({ connection: handle, newState: STATE.Connected, info: {} });
    await h.wait(50);
    assert.equal(joiner.stats.poolCreated, 1, '只该开过一条预热连接');
    assert.equal(joiner.stats.poolReady, 1, '就绪必须按条数算，不能按事件次数算');
  } finally {
    await joiner.stop();
  }
});

test('加入者：对端"发完最后一个响应就关连接"时，那段响应也必须送到本机客户端（现场"地图加载不出来"的来源）', async () => {
  // 房主的游戏服务是"回完响应立刻关本地连接"的写法（HTTP/1.0 / Connection: close），
  // 房主随即收掉 Steam 连接，于是"连接关闭"的通知和最后一段数据几乎同时到加入者这边。
  // 原来加入者一收到关闭通知就 dropPeer：destroy 本机 socket，Steam 接收队列里那段数据
  // 再没人读 —— 浏览器只看到"连接被关"，一个字节都没收到，页面就一直转圈。
  // 真机 A/B 上是 100% 复现：HTTP/1.0 的请求 4/4 全挂（40 秒超时、下行 0 字节），
  // 修好之后 4/4 在 10 ms 内返回（下行 122 字节）。
  const mock = createMockSdk();
  const localPort = await h.freePort();
  const joiner = joinJoiner({ localPort, hostSteamId: HOST_STEAM_ID, sdk: mock.sdk });
  let client;
  try {
    await joiner.ready;
    client = await h.connect(localPort);
    assert.ok(await h.waitFor(() => mock.state.connectedTo.length === 1, { timeoutMs: 3000 }), '本机连接应建一条 Steam 连接');
    const handle = mock.state.connectedTo[0].handle;
    mock.state.emitState({ connection: handle, newState: STATE.Connected, info: { identityRemote: HOST_STEAM_ID } });
    client.write('GET / HTTP/1.0\r\n\r\n');
    assert.ok(await h.waitFor(() => mock.state.sent.length >= 1, { timeoutMs: 3000 }), '请求应发往房主');

    // 数据先到、关闭通知紧跟其后，中间不给泵任何机会 —— 这正是真机上的时序：
    // 泵是按 tick 跑的，而连接状态回调随时会插进来。
    const reply = 'HTTP/1.0 200 OK\r\n\r\nhi';
    const collected = h.collect(client, reply.length, 3000);
    mock.state.pushToClient(handle, reply);
    mock.state.emitState({ connection: handle, newState: STATE.ClosedByPeer, info: { endReason: 1000, endDebugMessage: '' } });

    assert.equal((await collected).toString(), reply, '对端关连接之前发来的那段响应必须完整送到本机客户端');
  } finally {
    if (client) client.destroy();
    await joiner.stop();
  }
});

test('加入者：并发上限生效，超出会被拒绝', async () => {
  const mock = createMockSdk();
  const localPort = await h.freePort();
  const joiner = joinJoiner({ localPort, hostSteamId: HOST_STEAM_ID, sdk: mock.sdk, maxConnections: 2 });
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
  const joiner = joinJoiner({ localPort: busy.port, hostSteamId: HOST_STEAM_ID, sdk: mock.sdk });
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
const {
  sendChunk, queueOut, flushPeerOut, flushPeerOutSoon,
  peerOutBytes, dropFromOut, applyBackpressure, resumeOrAbort,
  PEER_OUT_HIGH_WATER, PEER_OUT_MAX_WATER,
} = require('../network/steam-adapter.cjs');
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

test('大块数据按 maxChunk 分片，全部走 sendMessage', () => {
  const { steam, calls } = fakeSockets();
  const payload = Buffer.alloc(10000, 7);
  const out = sendChunk(steam, 3, payload, { channel: 'reliable', maxChunk: 4096 });
  assert.equal(out.bytes, 10000);
  assert.equal(out.chunks, 3);
  assert.ok(calls.every((c) => c.via === 'sendMessage'));
  assert.ok(calls.every((c) => c.bytes <= 4096), '每片不超过 maxChunk');
  assert.equal(calls.reduce((s, c) => s + c.bytes, 0), 10000, '总字节数不变');
});

test('默认分片是 4KB：10000 字节按 4096 切成三条，而不是一条 10000 的大消息', () => {
  // 这条断言锁住的是"默认值到底是多少"，不是"分片好不好"。
  // 分片大小是延迟与开销的取舍，理由写在 network/steam-framing.cjs 的 DEFAULT_MAX_CHUNK 上面。
  // 想试大分片设 SHL_STEAM_MAX_CHUNK，测试也跟着这里改。
  const { steam, calls } = fakeSockets();
  const payload = Buffer.alloc(10000, 7);
  const out = sendChunk(steam, 3, payload, { channel: 'reliable' });
  assert.equal(out.bytes, 10000);
  assert.equal(out.chunks, 3);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.bytes), [4096, 4096, 1808]);
});

test('显式放大 maxChunk 时 10000 字节合成一条', () => {
  const { steam, calls } = fakeSockets();
  const payload = Buffer.alloc(10000, 7);
  const out = sendChunk(steam, 3, payload, { channel: 'reliable', maxChunk: 64 * 1024 });
  assert.equal(out.chunks, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bytes, 10000);
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

// ---------------------------------------------------------------------------
// 攒包与提前冲刷：这两处决定小包要等多久才上路，是"卡不卡"的关键路径。
// ---------------------------------------------------------------------------

test('queueOut：没到阈值返回 false，到了返回 true', () => {
  const peer = { out: [] };
  assert.equal(queueOut(peer, Buffer.alloc(100), 1024), false);
  assert.equal(queueOut(peer, Buffer.alloc(900), 1024), false, '累计 1000 仍未到 1024');
  assert.equal(queueOut(peer, Buffer.alloc(24), 1024), true, '累计 1024 刚好到阈值');
  assert.equal(peer.out.reduce((s, b) => s + b.length, 0), 1024);
});

test('flushPeerOut：攒下的多块合并成一条消息发出，发完清空', () => {
  const { steam, calls } = fakeSockets();
  const peer = { connection: 9, out: [Buffer.from('aa'), Buffer.from('bb')] };
  const written = flushPeerOut(steam, peer, sendChunk);
  assert.equal(written, 4);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bytes, 4, '两块必须合并成一条，不是两条');
  assert.deepEqual(peer.out, []);
});

test('flushPeerOut：tuning 会一路传到发送标志与分片', () => {
  const { steam, calls } = fakeSockets();
  const peer = { connection: 9, out: [Buffer.alloc(10000, 3)] };
  const written = flushPeerOut(steam, peer, sendChunk, { maxChunk: 4096, noNagle: true, noDelay: true });
  assert.equal(written, 10000);
  assert.equal(calls.length, 3, '按 4096 切成三条');
  assert.ok(calls.every((c) => c.bytes <= 4096));
  assert.ok(calls[0].flags & F.loadSendFlags().NoDelay, 'noDelay 打开时必须带上 NoDelay 位');
});

test('flushPeerOut：没有对端连接时什么都不发，也不报错', () => {
  const { steam, calls } = fakeSockets();
  assert.equal(flushPeerOut(steam, { connection: null, out: [Buffer.from('x')] }, sendChunk), 0);
  assert.equal(calls.length, 0);
});

test('flushPeerOut：发送失败返回 -1，且**数据必须留在队列里**', () => {
  // 这是"几 MB 的大文件传到一半必断、小文件全好"的根因回归测试。
  // 老代码先 `peer.out = []` 再看 result：发送失败时那一整块数据已经不在队列里，
  // 调用方只把它计进 stats.dropped 就完事。可靠流上就此多了一个洞 ——
  // 对端（浏览器/游戏）永远等不到那几个字节，几秒后连接被掐断。
  const steam = { networkingSockets: { sendMessage: () => ({ success: false }) } };
  const peer = { connection: 1, out: [Buffer.from('hello')] };
  assert.equal(flushPeerOut(steam, peer, sendChunk), -1);
  assert.equal(peerOutBytes(peer), 5, '失败后数据必须还在队列里等泵重试');
  assert.equal(peer.out[0].toString(), 'hello');
});

test('flushPeerOut：重试成功后才出队，不会把已确认的部分再发一遍', () => {
  let fails = 1;
  const sent = [];
  const steam = {
    networkingSockets: {
      sendMessage: (conn, data) => {
        if (fails-- > 0) return { success: false };
        sent.push(Buffer.from(data));
        return { success: true };
      },
    },
  };
  const peer = { connection: 1, out: [Buffer.from('abcdef')] };
  assert.equal(flushPeerOut(steam, peer, sendChunk), -1, '第一次发送失败');
  assert.equal(peerOutBytes(peer), 6);
  assert.equal(flushPeerOut(steam, peer, sendChunk), 6, '第二次成功');
  assert.equal(peerOutBytes(peer), 0);
  assert.equal(Buffer.concat(sent).toString(), 'abcdef', '确认为失败的整块可以重发');
});

test('flushPeerOut：分片中途中失败时只丢已确认的前缀，重试不产生重复字节', () => {
  // 第三条路：既不整块重发（会重复），也不整块丢弃（会有洞）。
  // Steam 已经收下的片不能再发，没收下的片必须留着。
  // 注意 maxChunk 有下限 MIN_CHUNK=256，写更小的值会被夹上去，分片数就不是你以为的那个。
  const seen = [];
  let allow = 2; // maxChunk=256，每次 flush 分成 3 片，只放行前两片
  const steam = {
    networkingSockets: {
      sendMessage: (conn, data) => {
        if (allow-- > 0) { seen.push(Buffer.from(data)); return { success: true }; }
        return { success: false };
      },
    },
  };
  const tuning = { maxChunk: 256 };
  const original = Buffer.concat([Buffer.alloc(256, 0x41), Buffer.alloc(256, 0x42), Buffer.alloc(256, 0x43)]);
  const peer = { connection: 1, out: [original] };

  assert.equal(flushPeerOut(steam, peer, sendChunk, tuning), -1);
  assert.equal(Buffer.concat(seen).toString(), 'A'.repeat(256) + 'B'.repeat(256), '前两片已经进了 Steam 队列');
  assert.equal(peerOutBytes(peer), 256, '只剩最后一片没发出去');
  assert.equal(peer.out[0].toString(), 'C'.repeat(256));

  allow = 99;
  assert.equal(flushPeerOut(steam, peer, sendChunk, tuning), 256, '重试只补发剩下的一片');
  assert.equal(Buffer.concat(seen).toString(), original.toString(), '合起来正好是原文，不多不少');
  assert.equal(peerOutBytes(peer), 0);
});

test('dropFromOut：按字节跨块丢弃，最后一块可以只丢一部分', () => {
  const peer = { out: [Buffer.from('abc'), Buffer.from('defg'), Buffer.from('hi')] };
  dropFromOut(peer, 4);
  assert.deepEqual(peer.out.map((b) => b.toString()), ['efg', 'hi']);
  dropFromOut(peer, 999);
  assert.equal(peerOutBytes(peer), 0, '丢的比剩的多也不许越界');
});

test('applyBackpressure：积压到高水位暂停读本地 socket，到硬上限主动断开', () => {
  // 发送失败说明 Steam 缓冲满了。继续读本地 socket 只能丢，丢就是可靠流上的洞，
  // 所以必须停下来等 —— 这是修复的另一半。
  let paused = 0;
  let destroyed = 0;
  const mk = (socket = {}) => ({
    connection: 1,
    out: [],
    socket: Object.assign({ destroyed: false, pause: () => { paused += 1; }, destroy: () => { destroyed += 1; } }, socket),
  });

  const peer = mk();
  peer.out.push(Buffer.alloc(PEER_OUT_HIGH_WATER));
  applyBackpressure(peer);
  assert.equal(peer.paused, true, '超过高水位必须暂停');
  assert.equal(paused, 1);
  applyBackpressure(peer);
  assert.equal(paused, 1, '已经暂停就不要反复 pause');
  assert.equal(destroyed, 0);

  const peer2 = mk();
  peer2.out.push(Buffer.alloc(PEER_OUT_MAX_WATER));
  applyBackpressure(peer2);
  assert.equal(destroyed, 1, '涨到硬上限说明连接已坏，主动断开让客户端重连');
  assert.equal(peer2.stalled, true);
});

test('applyBackpressure：没有 socket 的 peer 不能抛错（测试桩与早期状态）', () => {
  const peer = { connection: 1, out: [Buffer.alloc(PEER_OUT_MAX_WATER)] };
  assert.doesNotThrow(() => applyBackpressure(peer));
});

test('resumeOrAbort：能把积压送出去就恢复读本地 socket', () => {
  let resumed = 0;
  const peer = {
    connection: 1,
    out: [Buffer.alloc(1024)],
    paused: true,
    pausedAt: Date.now(),
    socket: { destroyed: false, resume: () => { resumed += 1; }, destroy: () => { throw new Error('不该断开'); } },
  };
  resumeOrAbort(peer, 1024);
  assert.equal(peer.paused, false);
  assert.equal(resumed, 1);
});

test('resumeOrAbort：停满 30 秒还一点都送不出去就断开，不让对端无限等待', () => {
  // 暂停是为了等缓冲排空，但如果这条 Steam 连接其实已经不通了，
  // 一直停着只会让浏览器/游戏永远转圈 —— 那和丢数据的观感一样糟。
  let destroyed = 0;
  const peer = {
    connection: 1,
    out: [Buffer.alloc(PEER_OUT_HIGH_WATER)],
    paused: true,
    pausedAt: Date.now() - 60000,
    lastSendAt: 0,
    socket: { destroyed: false, resume() {}, destroy: () => { destroyed += 1; } },
  };
  resumeOrAbort(peer, -1);
  assert.equal(destroyed, 1);
  assert.equal(peer.stalled, true);
});

test('resumeOrAbort：刚暂停不久、还在重试的连接不能掐断', () => {
  let destroyed = 0;
  const peer = {
    connection: 1,
    out: [Buffer.alloc(PEER_OUT_HIGH_WATER)],
    paused: true,
    pausedAt: Date.now(),
    lastSendAt: Date.now(),
    socket: { destroyed: false, resume() {}, destroy: () => { destroyed += 1; } },
  };
  resumeOrAbort(peer, -1);
  assert.equal(destroyed, 0, '才刚开始重试，不能掐断');
  assert.equal(peer.paused, true, '积压还没降下来，保持暂停');
});

test('resumeOrAbort：还在往外吐字节的慢连接不能掐断（哪怕 lastSendAt 很旧）', () => {
  // 现场故障（「卫戍协议：盟约」大文件加载不出来）：
  // Steam 发送缓冲满的时候 sendChunk 每次只确认得了头一片，整块永远发不完，
  // 于是 lastSendAt 冻在很久以前。老逻辑据此判定"这条连接死了"，
  // 30 秒后准时 destroy —— 现场读数是每条连接都恰好断在同一个字节数上。
  let destroyed = 0;
  const peer = {
    connection: 1,
    out: [Buffer.alloc(PEER_OUT_HIGH_WATER)],
    paused: true,
    pausedAt: Date.now() - 60000,
    lastSendAt: Date.now() - 60000,
    lastProgressAt: Date.now() - 1000,
    socket: { destroyed: false, resume() {}, destroy: () => { destroyed += 1; } },
  };
  resumeOrAbort(peer, -1);
  assert.equal(destroyed, 0, '还在动就不算死连接');
  assert.equal(peer.paused, true, '积压还高，保持暂停，别把内存堆到硬上限');
});

test('flushPeerOut：只确认了前缀也要记成"有进展"，否则慢速传输会被看门狗误杀', () => {
  const peer = {
    connection: 1,
    out: [Buffer.alloc(3 * 4096)],
    socket: { destroyed: false, pause() {}, resume() {} },
  };
  const before = Date.now();
  const written = flushPeerOut(null, peer, () => ({ success: false, chunks: 3, bytes: 4096 }), null);
  assert.equal(written, -1, '没整块发完，仍按"这一 tick 没成功"返回 -1');
  assert.ok(peer.lastProgressAt >= before, '确认出去 4096 字节就必须记成有进展');
  assert.equal(peerOutBytes(peer), 2 * 4096, '确认的前缀要丢掉，剩下的留在队列里重试');
  assert.equal(peer.lastSendAt, undefined, '整块没发完就不该更新 lastSendAt');
});

test('resumeOrAbort：没被暂停的连接什么都不做', () => {
  let touched = 0;
  const peer = {
    connection: 1,
    out: [],
    socket: { destroyed: false, resume: () => { touched += 1; }, destroy: () => { touched += 1; } },
  };
  resumeOrAbort(peer, 0);
  assert.equal(touched, 0);
});

test('flushPeerOutSoon：挂到本回合末尾就发，不等下一个泵 tick', async () => {
  const { steam, calls } = fakeSockets();
  const peer = { connection: 4, out: [Buffer.from('ping')] };
  flushPeerOutSoon(steam, peer, sendChunk, { maxChunk: 64 * 1024 });
  assert.equal(calls.length, 0, '调用当刻还没发，要等本回合结束');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bytes, 4);
  assert.deepEqual(peer.out, []);
});

test('flushPeerOutSoon：同一回合里连续调用只排一次，不会重复发', async () => {
  const { steam, calls } = fakeSockets();
  const peer = { connection: 4, out: [] };
  flushPeerOutSoon(steam, peer, sendChunk);
  flushPeerOutSoon(steam, peer, sendChunk);
  flushPeerOutSoon(steam, peer, sendChunk);
  peer.out.push(Buffer.from('one'));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1, '排三次也必须只发一次');
});

test('flushPeerOutSoon：排到之后如果已经被 pump 发空，就不发空消息', async () => {
  const { steam, calls } = fakeSockets();
  const peer = { connection: 4, out: [Buffer.from('x')] };
  flushPeerOutSoon(steam, peer, sendChunk);
  flushPeerOut(steam, peer, sendChunk); // 模拟 pump tick 抢先发掉
  assert.equal(calls.length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1, '不许补发一条空消息');
});

// ------------------------------------------------- 收消息循环的节奏（定时器主驱动 + 有界补轮询）

test('startCallbackLoop：反复调用 pump，stop 之后不再调用', async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let ticks = 0;
  const stop = startCallbackLoop({
    steam: { runCallbacks: () => {}, networkingSockets: {} },
    pump: () => { ticks += 1; return 0; },
    intervalMs: 1,
  });
  await sleep(40);
  const seen = ticks;
  assert.ok(seen >= 3, `40ms 内至少应轮询 3 次，实际 ${seen}`);
  stop();
  await sleep(25);
  assert.ok(ticks - seen <= 1, `stop 之后不该再轮询，又多跑了 ${ticks - seen} 次`);
});

test('startCallbackLoop：启动后立刻先轮询一轮，不等满一个定时器周期', async () => {
  let ticks = 0;
  const stop = startCallbackLoop({
    steam: { runCallbacks: () => {}, networkingSockets: {} },
    pump: () => { ticks += 1; return 0; },
    intervalMs: 5000,
  });
  assert.equal(ticks, 1, 'setInterval 要等满周期才第一次响，所以必须显式先跑一轮');
  stop();
});

// 下面几条把 intervalMs 设成 200ms：窗口内主轮询只可能响那一次启动轮询，
// 于是"pump 被多调了几次"就唯一地来自补轮询链，与机器快慢无关。
const quietLoop = (pump, extra = {}) => startCallbackLoop({
  steam: { runCallbacks: () => {}, networkingSockets: {} },
  pump,
  intervalMs: 200,
  ...extra,
});

test('startCallbackLoop：收到消息后补轮询把积压抽干，抽空即停', async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let calls = 0;
  const stop = quietLoop(() => { calls += 1; return calls <= 5 ? 1 : 0; }, { burst: 8 });
  await sleep(40);
  stop();
  // 启动那轮 1 次 + 补轮询 5 次（第 5 次抽空即停），而不是把 8 次预算烧完
  assert.equal(calls, 6, `应在抽空处停下，实际 ${calls} 次`);
});

test('startCallbackLoop：补轮询有界，持续有活也不会变成空转链', async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let calls = 0;
  // 不传 burst，用默认的 DRAIN_BURST —— 顺带锁住这个默认值
  const stop = quietLoop(() => { calls += 1; return 1; });
  await sleep(40);
  stop();
  // 启动 1 次 + 预算 DRAIN_BURST 次。若补轮询链自我续命，40ms 内会是几万次（实测裸 setImmediate 链 43k/秒）。
  assert.equal(calls, 1 + DRAIN_BURST, `补轮询必须有界，实际 ${calls} 次`);
});

test('startCallbackLoop：DRAIN_BURST 是个克制的小数字，别让它变成空转', () => {
  assert.ok(Number.isInteger(DRAIN_BURST) && DRAIN_BURST >= 1, 'DRAIN_BURST 应为正整数');
  // 每 14ms 一个主轮询 + DRAIN_BURST 次补轮询，预算越大越接近空转（裸即时链约 43k 轮/秒烧 84% 一个核）
  assert.ok(DRAIN_BURST <= 16, `DRAIN_BURST 应为个位数级别，实际 ${DRAIN_BURST}`);
  assert.equal(CALLBACK_INTERVAL_MS, 4);
});

test('startCallbackLoop：burst=0 时退回纯定时器，不补轮询', async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let calls = 0;
  const stop = quietLoop(() => { calls += 1; return 1; }, { burst: 0 });
  await sleep(40);
  stop();
  assert.equal(calls, 1, `burst=0 时只有启动那一次，实际 ${calls} 次`);
});

test('startCallbackLoop：stop 会掐断正在跑的补轮询链', async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let calls = 0;
  const stop = quietLoop(() => { calls += 1; return 1; }, { burst: 64 });
  const stopAt = calls;
  stop();
  await sleep(30);
  assert.ok(calls - stopAt <= 1, `stop 之后补轮询链不该再跑，又多跑了 ${calls - stopAt} 次`);
});

test('startCallbackLoop：pump 抛异常走 onFatal 且循环不倒', async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const seen = [];
  let calls = 0;
  const stop = quietLoop(() => { calls += 1; throw new Error('pump 炸了'); }, { burst: 2 });
  await sleep(30);
  stop();
  assert.ok(calls >= 1, '抛异常也要算进调用次数');
  assert.equal(seen.length, 0, '没有传 onFatal 时不该凭空产生错误记录');
  // 传了 onFatal 时要收得到
  let fatals = 0;
  const stop2 = startCallbackLoop({
    steam: { runCallbacks: () => {}, networkingSockets: {} },
    pump: () => { throw new Error('pump 炸了'); },
    onFatal: () => { fatals += 1; },
    intervalMs: 1,
  });
  await sleep(30);
  stop2();
  assert.ok(fatals >= 2, `onFatal 应被反复调用，实际 ${fatals} 次`);
});

// ------------------------------------------------- 全局网络参数接进初始化

/** 造一个能接受 SetGlobalConfigValueInt32 的最小 steam 桩，够 initSteamSdk 走完一条通路。 */
function netConfigCapableSdk() {
  const sets = [];
  const library = {
    func(name) {
      // 真名是 SetGlobalConfigValueInt32（..._SetConfigValueInt32 在 DLL 里不存在，见 steam-netconfig.cjs 注释）。
      if (name === 'SteamAPI_ISteamNetworkingUtils_SetGlobalConfigValueInt32') {
        return (iface, valueId, value) => { sets.push({ valueId, value }); return true; };
      }
      if (name === 'SteamAPI_ISteamNetworkingUtils_GetConfigValue') {
        return (iface, valueId, scope, scopeObj, dataType, result, cbResult) => {
          dataType.writeInt32LE(1, 0);
          result.writeInt32LE(sets.filter((s) => s.valueId === valueId).pop().value, 0);
          if (cbResult) cbResult.writeBigUInt64LE(8n, 0);
          return 1;
        };
      }
      throw new Error('unexpected symbol ' + name);
    },
  };
  const loader = { SteamAPI_SteamNetworkingUtils_SteamAPI: () => ({ __iface: true }), getLibrary: () => library };
  return { steam: { networkingUtils: { libraryLoader: loader } }, sets };
}

test('initSteamSdk：注入的 sdk 也下发全局参数，并把同一份报告挂到 stats 上', () => {
  const { steam } = netConfigCapableSdk();
  const stats = {};
  const out = initSteamSdk({ sdk: steam, stats, netConfigEnv: {} });
  assert.equal(out.injected, true, '传了 sdk 就是注入模式');
  assert.ok(out.netConfig, '返回值里要有报告');
  assert.equal(out.netConfig.available, true);
  assert.ok(out.netConfig.applied.length > 0, '至少要真的设过一项');
  assert.equal(stats.netConfig, out.netConfig, 'stats 上挂的应是同一份报告对象');
});

test('initSteamSdk：sdk 不接受全局参数时只降级，不抛异常', () => {
  const stats = {};
  const out = initSteamSdk({ sdk: { networkingUtils: {} }, stats, netConfigEnv: {} });
  assert.equal(out.injected, true);
  assert.equal(out.netConfig.available, false);
  assert.ok(typeof out.netConfig.reason === 'string' && out.netConfig.reason.length > 0, '要说清为什么没下发');
  assert.equal(stats.netConfig, out.netConfig);
});

test('createRouteReporter：把全局网络参数报告一起送出去（界面要显示它）', () => {
  const stats = {
    netConfig: {
      available: true,
      reason: null,
      applied: [{ name: 'SendBufferSize', requested: 2097152, effective: 2097152, ok: true }],
      changed: ['SendBufferSize=2097152'],
      notes: [],
    },
  };
  const report = createRouteReporter({ networkingSockets: {} }, stats)([], Date.now());
  assert.equal(report.netConfig.available, true);
  assert.deepEqual(report.netConfig.changed, ['SendBufferSize=2097152']);
  assert.equal(report.netConfig.applied.length, 1);
});

test('createRouteReporter：没有全局参数报告时是 null，不编造默认值', () => {
  const report = createRouteReporter({ networkingSockets: {} }, {})([], Date.now());
  assert.equal(report.netConfig, null);
});
