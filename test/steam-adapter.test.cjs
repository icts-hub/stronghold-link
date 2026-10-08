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
// 多路复用的帧格式（已定稿在 stream-mux.cjs）—— 加入者侧所有上行数据都是帧，
// 假房主想喂它什么东西、想读它发了什么，都得自己编解码。
const mux = require('../network/stream-mux.cjs');

const CONN = 101;

/**
 * 加入者测试的默认接线：**老路径（单连接透传）**。
 *
 * 为什么默认关多路复用（0.14.0 默认是开的）：
 *  - 下面这些用例测的是"一条本机连接 = 一条 Steam 连接"的老语义 —— 重连重放、慢失败不重试、
 *    预热池命中、断开方与理由。这些机制在新架构里根本没有对应物（一局只有一条干道，
 *    它一死所有流一起死，本机客户端自己重连），照搬过来只会把两种语义搅在一起。
 *  - 老路径本身还不能删：现场升级顺序是"房主先升、朋友后升"，"新加入者 + 旧房主"会长期存在，
 *    而多路复用最终就是靠 markLegacyHost 退回这条路的。所以它必须继续被这批用例钉住。
 *  - 多路复用自己那条路（Steam 连接数与本机连接数无关、流号是偶数、不串线）由
 *    "★ 加入者多路复用"那条用例专门覆盖，它才是 0.14.0 的核心指标。
 *
 * poolTarget 已经彻底不存在了（0.14.0 的 Phase 5 把预热池整段删掉，见 steam-adapter.cjs
 * 文件顶部那段墓碑注释）。需要老路径行为的用例显式传 mux: false。
 */
const joinJoiner = (options = {}) => createSteamJoiner({ mux: false, ...options });

/**
 * 把"假房主"这一侧接起来：加入者的干道建好之后，房主用**魔数应答**（见 steam-adapter.cjs
 * 里 PEER_HELLO_TIMEOUT_MS 上方的握手方向说明：加入者先开口，房主应答）。
 *
 * 为什么必须显式回这一下：定帧（peer.framed === true）之前加入者一个业务字节都不发出去 ——
 * 万一对面是 0.13.3，那串帧会被原样转发给游戏服务，把 HTTP 请求头污染掉。所以测试里
 * 第一件事就是让加入者听到房主的应答。
 *
 * 返回第一条（也是新架构下唯一一条）Steam 连接，它同时是后续 pushToClient 用的 handle。
 */
const answerHello = async (mock, joiner, { timeoutMs = 3000 } = {}) => {
  assert.ok(
    await h.waitFor(() => mock.state.connectedTo.length >= 1, { timeoutMs }),
    '加入者应主动建一条 Steam 干道（首包是魔数）',
  );
  const handle = mock.state.connectedTo[0].handle;
  // 加入者建连后先发魔数；房主的应答跟在后面回来。顺序反过来也没关系 —— 两边都是队列。
  assert.ok(
    await h.waitFor(() => mock.state.sent.some((s) => s.connection === handle && s.data.includes(mux.HELLO_BYTES)), { timeoutMs }),
    '加入者的首包必须是魔数（对面是老房主时它会把这个字节转给游戏服务，正因如此才必须先发）',
  );
  mock.state.emitState({ connection: handle, newState: STATE.Connected, info: { identityRemote: HOST_STEAM_ID } });
  mock.state.pushToClient(handle, mux.encodeHello());
  assert.ok(
    await h.waitFor(() => (joiner.stats.muxPeers || 0) >= 1, { timeoutMs }),
    '房主应答魔数之后应进入多路复用（stats.muxPeers）',
  );
  return handle;
};

/**
 * 收集**加入者**发往某条 Steam 连接的全部帧。
 *
 * 一条消息里可能挤着好几帧（HELLO 后面跟着 OPEN/DATA 就是最常见的一种），所以必须用
 * createFrameDecoder 逐帧切，不能拿 Buffer.concat 当一帧读。
 */
const framesFrom = (mock, connection, { skipHello = false } = {}) => {
  const chunks = mock.state.sent.filter((s) => s.connection === connection).map((s) => s.data);
  if (!chunks.length) return [];
  let wire = Buffer.concat(chunks);
  if (skipHello) {
    // 魔数是裸 7 字节，不是帧，解码器会当场抛 EMUXFRAME —— 先切掉。
    assert.ok(wire.length >= mux.HELLO_BYTES.length && wire.subarray(0, mux.HELLO_MAGIC_BYTES.length).equals(Buffer.from(mux.HELLO_MAGIC)), '第一条消息应当是魔数');
    wire = wire.subarray(mux.HELLO_BYTES.length);
  }
  if (!wire.length) return [];
  const decoder = mux.createFrameDecoder();
  return decoder.push(wire);
};

/** 按流号取**加入者发出**的帧（顺序即发送顺序）。 */
const framesForStream = (mock, connection, streamId) =>
  framesFrom(mock, connection, { skipHello: true }).filter((f) => f.streamId === streamId);

/**
 * 这条流在加入者 OPEN 帧里报的世代号。
 *
 * 假房主回帧时必须原样带上它：世代号对不上会被判成"迟到帧"直接丢掉（规格 §十七），
 * 那是协议在正常工作，不是我们要测的东西。
 */
const generationOf = (mock, connection, streamId) => {
  const open = framesForStream(mock, connection, streamId).find((f) => f.type === mux.TYPE.Open);
  assert.ok(open, `流 ${streamId} 应该已经发过 OPEN 帧`);
  return open.generation;
};


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

test('房主：认出对端版本之前不开本地连接、也不发一个字节；老对端开口后各占一条（互不串线）', async () => {
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

    // ★ 阶段一：对端连上了，但还没开口。房主此时必须保持沉默。
    //   两条依据：
    //   · 规格 §二十三 —— 不许为"将来可能来的请求"提前建连接，本机 TCP 只能由对端真的开了一条流来驱动；
    //   · 4.3 的握手方向 —— 房主先发出去的字节，在 0.13.3 的加入者眼里就是 HTTP 响应开头的字节
    //     （"SHLMUX\x01" 会被它原样写进浏览器那条 TCP 流），而"房主先升、朋友后升"是最常见的升级顺序。
    //   这一段以前是"连上就建一条本地连接"，也就是 0.13.3 的行为，正是这次重构要消灭的。
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(game.connections(), 0, '对端还没开口，房主不该为它提前连游戏端口');
    assert.equal(mock.state.sent.length, 0, '房主在认出对端版本之前一个字节都不能发出去');

    // ★ 阶段二：两个对端都发来非魔数首包（= 老版本加入者），退回单连接透传。
    //   这时候才该出现"每个对端一条独立的本地连接"，而且回包各走各的 Steam 连接。
    mock.state.pushToHost(CONN, 'peer-A');
    mock.state.pushToHost(second, 'peer-B');
    assert.ok(await h.waitFor(() => game.connections() === 2, { timeoutMs: 3000 }), '老对端开口后本地服务应看到两条独立连接');
    assert.ok(await h.waitFor(() => mock.state.sent.filter((s) => ['peer-A', 'peer-B'].includes(s.data.toString())).length >= 2, { timeoutMs: 3000 }));
    const forA = mock.state.sent.find((s) => s.data.toString() === 'peer-A');
    const forB = mock.state.sent.find((s) => s.data.toString() === 'peer-B');
    assert.equal(forA.connection, CONN, 'A 的回包必须走 A 的连接');
    assert.equal(forB.connection, second, 'B 的回包必须走 B 的连接');
    // 退化的只是这一局：没有任何魔数漏进游戏端口。
    assert.equal(host.stats.legacyPeers, 2);
    assert.equal(host.stats.muxPeers || 0, 0);
  } finally {
    await host.stop();
    await game.close();
  }
});

test('★ 房主多路复用：等魔数才应答、等 OPEN 才连游戏端口，一条 Steam 连接承载多条流且不串线', async () => {
  // 房主侧是整个 0.14.0 的另一半：加入者那一半（偶数流号、OPEN 在前、定帧前扣住字节）
  // 全靠房主这一侧配合才成立。这里钉住三件事：
  //   · 4.3 的握手方向 —— 房主**不主动开口**，认出魔数才回一条 HELLO（回早了会污染旧加入者的 HTTP 响应）
  //   · 规格 §二十三 —— 不是"连上就建本地连接"，而是"收到 OPEN 才建"
  //   · 规格 §九 / §三十七 —— N 条流共用 1 条 Steam 连接
  const game = await h.startEchoServer();
  const mock = createMockSdk();
  const events = [];
  const host = createSteamHost({
    gamePort: game.port, sdk: mock.sdk,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  try {
    await host.ready;
    mock.state.emitState({ connection: CONN, newState: STATE.Connecting, info: { identityRemote: '76561198000000002' } });
    mock.state.emitState({ connection: CONN, newState: STATE.Connected, info: { identityRemote: '76561198000000002' } });
    await h.wait(60);
    assert.equal(mock.state.sent.length, 0, '房主不主动开口：对端还没发魔数之前一个字节都不发');

    // 对端开口：HELLO + 两条 OPEN + 流 2 的一段数据（挤在同一条消息里，真机上很常见）。
    mock.state.pushToHost(CONN, Buffer.concat([
      mux.encodeHello(),
      mux.encodeOpen(2, 1),
      mux.encodeOpen(4, 1),
      mux.encodeData(2, 1, Buffer.from('hello-from-client')),
    ]));
    assert.ok(await h.waitFor(() => (host.stats.muxPeers || 0) === 1, { timeoutMs: 3000 }),
      '认出魔数后应计成一个多路复用对端');
    assert.equal(host.stats.legacyPeers || 0, 0, '认出魔数就不该退回单连接模式');

    // 房主回一条魔数 —— 而且**只回一条**（每帧回一次的话版本协商会被自己搅乱）。
    assert.ok(await h.waitFor(
      () => mock.state.sent.some((s) => s.connection === CONN && s.data.includes(mux.HELLO_BYTES)),
      { timeoutMs: 2000 },
    ), '房主认出魔数后必须回一条魔数，加入者才敢定帧');
    assert.equal(mock.state.sent.filter((s) => s.data.includes(mux.HELLO_BYTES)).length, 1, 'HELLO 应答只该发一次');

    // OPEN 才连游戏端口：两条流 ⇒ 游戏服务看到两条连接，而 Steam 连接仍然只有一条。
    assert.ok(await h.waitFor(() => game.connections() === 2, { timeoutMs: 3000 }),
      '每条流对应游戏端口上的一条连接');
    assert.equal(host.stats.peers, 1, 'N 条流共用 1 条 Steam 连接 —— 这正是本次重构的核心指标');
    assert.equal(host.stats.streams, 2, '两条流都要登记在册');

    // 上行真的落到了游戏服务上（echo 会原样回），而且回包带的是**流 2** 的号。
    assert.ok(await h.waitFor(
      () => framesFrom(mock, CONN, { skipHello: true }).some((f) => f.type === mux.TYPE.Data && f.payload.toString() === 'hello-from-client'),
      { timeoutMs: 3000 },
    ), '游戏服务的回声应装箱回对端');
    const echo = framesFrom(mock, CONN, { skipHello: true })
      .find((f) => f.type === mux.TYPE.Data && f.payload.toString() === 'hello-from-client');
    assert.equal(echo.streamId, 2, '回声必须走原来那条流的号，不能串到别的流上');

    // 下行隔离：只给流 4 写，回声只能出现在流 4 上。
    mock.state.pushToHost(CONN, mux.encodeData(4, 1, Buffer.from('only-four')));
    assert.ok(await h.waitFor(
      () => framesFrom(mock, CONN, { skipHello: true }).some((f) => f.type === mux.TYPE.Data && f.payload.toString() === 'only-four'),
      { timeoutMs: 3000 },
    ), '流 4 的数据应到达它的游戏连接并回声回来');
    const isolated = framesFrom(mock, CONN, { skipHello: true })
      .filter((f) => f.type === mux.TYPE.Data && f.payload.toString() === 'only-four');
    assert.equal(isolated.length, 1, '只该回声一次');
    assert.equal(isolated[0].streamId, 4, '流 4 的数据绝不能出现在流 2 上（串线就是两个游戏请求互相污染）');

    // ★ 迟到的重复魔数（现场 2026-10-08 的"永久吊死"就是栽在这一步的反面）。
    //   加入者因为"干道首包可能会丢"会补发魔数（见 steam-adapter.cjs 的 retryUndecidedTrunks）。
    //   这条干道早就谈妥了，重发必须被**吞掉**，绝不能喂进解码器 —— 那会被当成帧头解出垃圾，
    //   整条干道以 BadFraming 收场，等于把刚救回来的隧道又毙一次。
    //   同时房主**再答一条魔数**：加入者要是没收到第一次应答，会一直等到放弃超时（默认 30 秒）
    //   才换新干道；重答一次只要 7 个字节，就能把"应答丢了"从 30 秒白等缩成一个重发周期。
    const helloReplies = () => mock.state.sent.filter((s) => s.connection === CONN && s.data.includes(mux.HELLO_BYTES)).length;
    const helloRepliesBefore = helloReplies();
    const framesBefore = framesFrom(mock, CONN, { skipHello: true }).length;
    mock.state.pushToHost(CONN, mux.encodeHello());
    assert.ok(await h.waitFor(() => helloReplies() > helloRepliesBefore, { timeoutMs: 2000 }),
      '迟到的重复魔数必须被再答一次 —— 加入者没收到第一次应答时就靠它活下来');
    assert.equal(host.stats.helloRepeat, 1, '重复魔数要计数（诊断要知道这条链路上丢过应答）');
    assert.equal(host.stats.failed || 0, 0, '重复魔数绝不能被当成非法帧（BadFraming 会把整条干道毙掉）');
    assert.equal(framesFrom(mock, CONN, { skipHello: true }).length, framesBefore,
      '吞掉重复魔数不该产生任何新帧，魔数那 7 个字节也绝不能漏进游戏服务');

    // 对端关掉一条流：房主用 end() 收尾，不是 destroy() —— 那是规格 §十二 的要求
    // （最后一段数据还在管道里，destroy 会把它一起丢掉）。
    mock.state.pushToHost(CONN, mux.encodeClose(4, 1));
    assert.ok(await h.waitFor(() => game.connections() === 1, { timeoutMs: 3000 }),
      '关掉一条流只该让游戏端口少一条连接，另一条继续跑');
    assert.equal(host.stats.peers, 1, '关流绝不能动 Steam 连接');

    // ★ 记账：`流结束 ... 上行=XKiB 下行=YKiB` 是现场唯一的字节级证据，
    //   而房主这一侧原来**从来没有给 stream.bytesFromPeer 记过账** —— 日志里
    //   532 条流全是 `下行=0KiB`，"朋友一个字节都没送上来"这个假象被当成了故障现场。
    //   同一类坑这在 0.14.0 里已经出现三次：预热池四个计数被两道白名单丢掉、
    //   netState 没被 Provider 转发、这里是流级下行计数根本没写。
    //   断言取的是 `stream-left` 事件（日志那一行就是它渲染的），不是内部字段。
    const left = await (async () => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const found = events.find((e) => e.type === 'stream-left' && e.payload.stream === 4);
        if (found) return found.payload;
        await h.wait(20);
      }
      return null;
    })();
    assert.ok(left, '关掉的那条流必须报一次 stream-left（现场日志的"流结束"就是它）');
    assert.equal(left.bytesFromPeer, Buffer.byteLength('only-four'),
      '下行字节必须记到流上：这条流只收到过 only-four，一个不多一个不少');
    assert.ok(left.bytesToPeer > 0, '上行字节也要记：echo 服务的回声确实回了对端');
  } finally {
    await host.stop();
    await game.close();
  }
});

test('★ 房主：对端的干道断了 —— 游戏端口那条连接不拆，新干道用同一个流号 + 世代重开后原地认回来（规格 §十六 / §十七）', async () => {
  // 这一条与加入者侧那条迁移用例是一对：加入者负责"寄存 + 用同一个流号、世代 +1 重开"，
  // 房主负责"别把游戏端口那条连接拆掉，等它回来"。两边缺一半，用户看到的都还是掉线。
  // 为什么值得这么做（而不是让浏览器重连）：房主这条连接的另一端是游戏自己的 Web 服务，
  // 它保存着这一局的会话状态；拆掉再连，等于让游戏从零开始处理一个陌生的新请求。
  const net = require('node:net');
  const gameSockets = new Set();
  const game = net.createServer((socket) => {
    gameSockets.add(socket);
    socket.on('error', () => { /* 测试里不关心 */ });
    socket.on('close', () => gameSockets.delete(socket));
    socket.on('data', (chunk) => socket.write(chunk));
  });
  const gamePort = await h.freePort();
  await new Promise((resolve) => game.listen(gamePort, '127.0.0.1', resolve));

  const mock = createMockSdk();
  const events = [];
  const host = createSteamHost({
    gamePort, sdk: mock.sdk,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  try {
    await host.ready;
    mock.state.emitState({ connection: CONN, newState: STATE.Connecting, info: { identityRemote: '76561198000000002' } });
    mock.state.emitState({ connection: CONN, newState: STATE.Connected, info: { identityRemote: '76561198000000002' } });
    mock.state.pushToHost(CONN, Buffer.concat([
      mux.encodeHello(),
      mux.encodeOpen(2, 1),
      mux.encodeData(2, 1, Buffer.from('before-outage')),
    ]));
    assert.ok(await h.waitFor(() => gameSockets.size === 1, { timeoutMs: 3000 }), 'OPEN 之后游戏端口应有一条连接');
    const gameSocket = [...gameSockets][0];
    assert.ok(await h.waitFor(
      () => framesFrom(mock, CONN, { skipHello: true }).some((f) => f.payload.toString() === 'before-outage'),
      { timeoutMs: 3000 },
    ), '断链前的数据通路要先正常工作，否则后面的断言说明不了问题');

    // ── 干道断（真机上是 5003 / I/O Operation Failed）──
    mock.state.emitState({
      connection: CONN,
      newState: STATE.ClosedByPeer,
      info: { identityRemote: '76561198000000002', endDebugMessage: 'I/O Operation Failed' },
    });
    await h.wait(120);
    assert.equal(gameSockets.size, 1, '干道断了**绝不能**拆游戏端口那条连接');
    assert.equal(gameSocket.destroyed, false, '游戏侧 socket 必须还活着（它保存着这一局的会话状态）');
    assert.equal(host.stats.streamsParked, 1, '那条流应被寄存，等新干道来接');
    assert.equal(host.stats.peers, 0, '旧干道已经从连接表里摘掉了');

    // ── 新干道进来，用**同一个流号、世代 2** 重新 OPEN ──
    const second = CONN + 1;
    mock.state.emitState({ connection: second, newState: STATE.Connecting, info: { identityRemote: '76561198000000002' } });
    mock.state.emitState({ connection: second, newState: STATE.Connected, info: { identityRemote: '76561198000000002' } });
    mock.state.pushToHost(second, Buffer.concat([mux.encodeHello(), mux.encodeOpen(2, 2)]));

    assert.ok(await h.waitFor(() => (host.stats.streamsMigrated || 0) === 1, { timeoutMs: 3000 }),
      '世代 +1 的 OPEN 应让房主把那条流**认回来**，而不是当成新流');
    assert.equal(gameSockets.size, 1, '认回来 = 复用原来那条游戏连接；新开一条就等于这半局白跑了');
    assert.equal([...gameSockets][0], gameSocket, '必须还是同一个 socket 对象');
    assert.equal(host.stats.streams, 1, '流重新登记在新干道上');
    assert.equal(host.stats.totalStreams, 1,
      '累计开流数必须还是 1：认回不是新开 —— 这个数被拿去做"一局里到底开了多少条本机连接"的诊断，虚高会让统计失真');

    // 认回来之后两个方向继续跑。
    mock.state.pushToHost(second, mux.encodeData(2, 2, Buffer.from('after-migrate')));
    assert.ok(await h.waitFor(
      () => framesFrom(mock, second, { skipHello: true }).some((f) => f.payload.toString() === 'after-migrate'),
      { timeoutMs: 3000 },
    ), '认回之后上行应继续工作');
    const after = framesFrom(mock, second, { skipHello: true })
      .find((f) => f.payload.toString() === 'after-migrate');
    assert.equal(after.type, mux.TYPE.Data);
    assert.equal(after.streamId, 2, '回包必须走流 2');
    assert.equal(after.generation, 2, '新干道上的帧必须带新世代，否则会被对端当成迟到帧丢掉');

    // 用户不该看到任何"流被关了"的事件 —— 这条流从来没断过。
    const leftKinds = events.filter((e) => e.type === 'stream-left').map((e) => e.payload?.kind);
    assert.ok(!leftKinds.includes('TunnelClosed'),
      `干道断链不该产生 TunnelClosed 的流事件（实际 ${JSON.stringify(leftKinds)}）`);
  } finally {
    await host.stop();
    await new Promise((resolve) => game.close(resolve));
  }
});

test('★ 房主 + 两个加入者：两个人的流号都是从 2 开始重号的 —— 谁也不能抢走、销毁对方寄存中的流（现场"第三人抢占隧道"）', async () => {
  // 为什么这条必须存在：规格 §十一 只保证"房主用奇数、加入者用偶数"，它**保证不了加入者
  // 之间不重号**。每个加入者的 nextStreamId 都是各自从 STREAM_ID_CLIENT_START = 2 开始数，
  // 所以三个人同房时 A 和 B 的流号是完全一样的 2、4、6…。
  // 房主那边原来用一张只按流号索引的裸表（orphanStreams）寄存断链的流，于是有两条路会让
  // 第三个人"抢"走前一个人的隧道：
  //   · B 的 OPEN(2) 把 A 寄存中的流**连它到游戏端口那条连接一起接管过去** ——
  //     B 的请求打到 A 的会话上、A 的响应送给 B，看起来像游戏串号；
  //   · 或者 B 寄流时把 A 寄存着的那条**直接 destroy 掉** —— A 的本机连接凭空断掉。
  // 两条路都只在"干道断过一次"之后才走到，专挑三个人同房时发作，现场极难定位。
  const net = require('node:net');
  const gameSockets = new Set();
  let connSeq = 0;
  const game = net.createServer((socket) => {
    const id = ++connSeq;
    gameSockets.add(socket);
    socket.on('error', () => { /* 测试里不关心 */ });
    socket.on('close', () => gameSockets.delete(socket));
    // 每条游戏连接给自己盖一个号，回包带上它：一眼就能看出"这是谁那条连接答的"。
    socket.on('data', (chunk) => socket.write(Buffer.concat([Buffer.from('#' + id + '|'), chunk])));
  });
  const gamePort = await h.freePort();
  await new Promise((resolve) => game.listen(gamePort, '127.0.0.1', resolve));

  const mock = createMockSdk();
  const events = [];
  const host = createSteamHost({
    gamePort, sdk: mock.sdk,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  const JOINER_A = '76561198000000002';
  const JOINER_B = '76561198000000003';
  const CONN_A = CONN;
  const CONN_B = CONN + 1;
  // 取某条干道上回过的那段业务数据（回包形如 `#1|a1`）。
  const dataOn = (connection, text) => framesFrom(mock, connection, { skipHello: true })
    .filter((f) => f.type === mux.TYPE.Data && f.payload.toString().endsWith('|' + text))
    .map((f) => f.payload.toString());
  try {
    await host.ready;

    // ── A 先进来：流 2 连到游戏端口，拿到 1 号游戏连接 ──
    mock.state.emitState({ connection: CONN_A, newState: STATE.Connected, info: { identityRemote: JOINER_A } });
    mock.state.pushToHost(CONN_A, Buffer.concat([
      mux.encodeHello(), mux.encodeOpen(2, 1), mux.encodeData(2, 1, Buffer.from('a1')),
    ]));
    assert.ok(await h.waitFor(() => gameSockets.size === 1, { timeoutMs: 3000 }), 'A 的流 2 应开一条游戏连接');
    assert.ok(await h.waitFor(() => dataOn(CONN_A, 'a1').length === 1, { timeoutMs: 3000 }), 'A 自己先要能正常收发');
    assert.equal(dataOn(CONN_A, 'a1')[0], '#1|a1', 'A 的数据要走 1 号游戏连接');

    // ── B 随后进来，也用流号 2：**必须给 B 单开一条**，不能把 A 的接管走 ──
    mock.state.emitState({ connection: CONN_B, newState: STATE.Connected, info: { identityRemote: JOINER_B } });
    mock.state.pushToHost(CONN_B, Buffer.concat([
      mux.encodeHello(), mux.encodeOpen(2, 1), mux.encodeData(2, 1, Buffer.from('b1')),
    ]));
    assert.ok(await h.waitFor(() => gameSockets.size === 2, { timeoutMs: 3000 }),
      '两个加入者的流号撞号，B 的 OPEN(2) 必须**新开**一条游戏连接，而不是接管 A 的');
    assert.equal(host.stats.streamsMigrated || 0, 0, '两个加入者之间不该发生任何"流的迁移"');
    assert.equal(host.stats.streamsParked || 0, 0, '没人断链，就不该有寄存');
    assert.ok(await h.waitFor(() => dataOn(CONN_B, 'b1').length === 1, { timeoutMs: 3000 }), 'B 也要能正常收发');
    assert.equal(dataOn(CONN_B, 'b1')[0], '#2|b1', 'B 的数据必须走 B 自己那条连接（拿到 A 的回答就是串号）');
    assert.deepEqual(dataOn(CONN_B, 'a1'), [], 'A 的流量绝不能出现在 B 的干道上');

    // ── A 的干道断了：A 的流 2 寄存，它到游戏端口那条连接不许拆 ──
    const socketA = [...gameSockets][0];
    const socketB = [...gameSockets][1];
    mock.state.emitState({ connection: CONN_A, newState: STATE.ClosedByPeer, info: { identityRemote: JOINER_A, endDebugMessage: 'I/O Operation Failed' } });
    await h.wait(120);
    assert.equal(host.stats.streamsParked, 1, 'A 的流应被寄存');
    assert.equal(socketA.destroyed, false, 'A 寄存中的游戏连接必须还活着');

    // ── B 的干道也断了（它也用流号 2）—— **绝不能顺手把 A 寄存的那条 destroy 掉** ──
    mock.state.emitState({ connection: CONN_B, newState: STATE.ClosedByPeer, info: { identityRemote: JOINER_B, endDebugMessage: 'I/O Operation Failed' } });
    await h.wait(120);
    assert.equal(host.stats.streamsParked, 2, 'B 的流也该被寄存');
    assert.equal(socketA.destroyed, false, 'B 寄流时绝不能销毁 A 寄存中的那条流 —— 这是"第三人抢占"最阴的一路');
    assert.equal(socketB.destroyed, false, 'B 自己那条当然也不能被拆');

    // ── B 用同一个流号、世代 +1 回来：认回的必须是 **B 自己那条** ──
    const CONN_B2 = CONN + 2;
    mock.state.emitState({ connection: CONN_B2, newState: STATE.Connected, info: { identityRemote: JOINER_B } });
    mock.state.pushToHost(CONN_B2, Buffer.concat([
      mux.encodeHello(), mux.encodeOpen(2, 2), mux.encodeData(2, 2, Buffer.from('b2')),
    ]));
    assert.ok(await h.waitFor(() => (host.stats.streamsMigrated || 0) === 1, { timeoutMs: 3000 }), 'B 应认回一条寄存流');
    assert.equal(gameSockets.size, 2, 'B 认回 = 复用游戏连接，不是新开一条');
    assert.ok(await h.waitFor(() => dataOn(CONN_B2, 'b2').length === 1, { timeoutMs: 3000 }), 'B 认回后要能接着收发');
    assert.equal(dataOn(CONN_B2, 'b2')[0], '#2|b2', 'B 认回的必须是 2 号连接（认成 1 号就是抢了 A 的会话）');

    // ── A 也回来：它必须拿回 **1 号**，两个人各回各家 ──
    const CONN_A2 = CONN + 3;
    mock.state.emitState({ connection: CONN_A2, newState: STATE.Connected, info: { identityRemote: JOINER_A } });
    mock.state.pushToHost(CONN_A2, Buffer.concat([
      mux.encodeHello(), mux.encodeOpen(2, 2), mux.encodeData(2, 2, Buffer.from('a2')),
    ]));
    assert.ok(await h.waitFor(() => (host.stats.streamsMigrated || 0) === 2, { timeoutMs: 3000 }), 'A 也应认回一条寄存流');
    assert.equal(gameSockets.size, 2, '两个人都认回之后，游戏端口上仍然只有两条连接');
    assert.ok(await h.waitFor(() => dataOn(CONN_A2, 'a2').length === 1, { timeoutMs: 3000 }), 'A 认回后也要能接着收发');
    assert.equal(dataOn(CONN_A2, 'a2')[0], '#1|a2', 'A 必须拿回 1 号连接 —— 拿回 2 号就是两个人的会话对调了');
    assert.equal(host.stats.streams, 1,
      'stats.streams 是"每条干道上活着的流数"（不是全局数）：两个人各认回一条，所以是 1');
    assert.equal(events.filter((e) => e.type === 'stream-added').length, 4,
      '两条流各被登记了两次（各自认回那次），一共 4 次 stream-added');

    // 全程谁都不该被"隧道关闭"扫地出门。
    const leftKinds = events.filter((e) => e.type === 'stream-left').map((e) => e.payload?.kind);
    assert.equal(leftKinds.length, 0, `两位加入者的流都不该被收掉（实际 ${JSON.stringify(leftKinds)}）`);
  } finally {
    await host.stop();
    // `server.close()` 只等"已经建立的连接全都结束"，任何一条漏网都会把测试挂死而不是报错。
    // 断言半路失败时寄存中的流可能还活着，所以这里显式收掉测试自己造的那些连接。
    for (const socket of gameSockets) { try { socket.destroy(); } catch { /* ignore */ } }
    await new Promise((resolve) => game.close(resolve));
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

test('★ 加入者多路复用（规格 §三 / §三十七）：Steam 连接数与本机 TCP 连接数无关，多条本机连接共用一条干道且不串线', async () => {
  // 现场故障就是这个用例要钉住的东西：0.13.3 是"一条本机 TCP = 一条 Steam P2P"，浏览器一个
  // 首页要开 6~25 条 TCP，于是要现握手 6~25 次；校园网下单次握手 30 秒甚至超时（Steam
  // reason 5003），用户看到的就是"页面/地图永远转不出来"。
  // 0.14.0 规格 §三：一个远端玩家 = 1 条长期干道（Primary），0~1 条 Backup —— 不是预先开
  // 3~4 条固定 trunk。规格 §三十七：本机连接是干道上的"流"，加入者只用**偶数**流号。
  // 所以这里的核心断言是：**3 条本机 TCP ⇒ 仍然只有 1 条 Steam 连接**。
  const mock = createMockSdk();
  const localPort = await h.freePort();
  const events = [];
  const joiner = createSteamJoiner({
    localPort, hostSteamId: HOST_STEAM_ID, sdk: mock.sdk,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  const clients = [];
  try {
    await joiner.ready;
    // 模拟浏览器 / RDP 这类会开多条并发连接的客户端。注意：这里**不**逐条等它建 Steam 连接。
    for (let i = 0; i < 3; i += 1) clients.push(await h.connect(localPort));

    const trunk = await answerHello(mock, joiner);

    // ① 核心指标：Steam 连接数与本机连接数无关。
    await h.wait(150); // 给"万一要再建干道"留出暴露的时间，别让断言赢在时序上
    assert.equal(mock.state.connectedTo.length, 1,
      `3 条本机 TCP 只允许建 1 条 Steam 干道，实际 ${mock.state.connectedTo.length}`);
    assert.equal(joiner.stats.connections, 1, '连接表里只该有一条（干道），本机连接是它上面的流');
    assert.equal(joiner.stats.streams, 3, '三条本机连接应各自成为干道上的一条流');

    // ② 流号必须是偶数（规格 §三十七：房主奇数、加入者偶数 —— 碰撞就从这里杜绝）。
    const opened = framesFrom(mock, trunk, { skipHello: true })
      .filter((f) => f.type === mux.TYPE.Open)
      .map((f) => f.streamId);
    assert.equal(opened.length, 3, `三条本机连接应各发一个 OPEN 帧，实际 ${opened.length}`);
    for (const id of opened) {
      assert.equal(id % 2, 0, `加入者分配的流号必须是偶数（实际 ${id}）：奇数归房主，混用就会两条流抢同一个号`);
      assert.ok(id >= mux.STREAM_ID_CLIENT_START, `流号要从 STREAM_ID_CLIENT_START(${mux.STREAM_ID_CLIENT_START}) 起，不能占用会话/房主区间（实际 ${id}）`);
    }
    assert.equal(new Set(opened).size, 3, '三条流必须是三个不同的流号');

    // ③ 上行不串线：每条本机连接的数据只带自己的流号，而且编号顺序即连接顺序。
    clients.forEach((client, index) => client.write(`client-${index}`));
    assert.ok(await h.waitFor(() => {
      const datas = framesFrom(mock, trunk, { skipHello: true }).filter((f) => f.type === mux.TYPE.Data);
      return clients.every((_, i) => datas.some((f) => f.payload.toString() === `client-${i}`));
    }, { timeoutMs: 3000 }), '三条数据都应以 DATA 帧发出去');

    const datas = framesFrom(mock, trunk, { skipHello: true }).filter((f) => f.type === mux.TYPE.Data);
    assert.equal(datas.length, 3, `三条本机连接一共只该发三个 DATA 帧（不许重复发），实际 ${datas.length}`);
    for (let i = 0; i < 3; i += 1) {
      const own = datas.filter((f) => f.payload.toString() === `client-${i}`);
      assert.equal(own.length, 1, `client-${i} 应只发一次`);
      assert.equal(own[0].streamId, opened[i], `client-${i} 必须走它自己那条流（第 ${i} 条本机连接 = 流 ${opened[i]}）`);
    }

    // ④ 下行不串线：房主按流号回，每条本机连接只该收到自己的那一份。
    const got = clients.map((client) => h.collect(client, 7));
    opened.forEach((streamId, index) => mock.state.pushToClient(
      trunk, mux.encodeData(streamId, generationOf(mock, trunk, streamId), Buffer.from(`back-${index}`)),
    ));
    const replies = await Promise.all(got);
    replies.forEach((buffer, index) => assert.equal(buffer.toString(), `back-${index}`, `第 ${index} 个客户端应收到自己的回包`));

    // ⑤ 一条本机连接断开 ≠ 干道断开：只关它自己那条流，其它流继续跑。
    clients[0].destroy();
    assert.ok(await h.waitFor(
      () => framesFrom(mock, trunk, { skipHello: true }).some((f) => f.type === mux.TYPE.Close && f.streamId === opened[0]),
      { timeoutMs: 2000 },
    ), '断开的本机连接应只在自己的流上发 Close 帧');
    assert.ok(!mock.state.closed.some((c) => c.connection === trunk),
      '一条本机连接断开**绝不能**关掉干道：干道一断，所有本机连接一起死，用户就得重新等一次握手');
    assert.equal(joiner.stats.connections, 1, '干道仍在，连接的条数不该变');
    assert.equal(joiner.stats.streams, 2, '只该少掉那一条流');

    clients[1].write('still-alive');
    assert.ok(await h.waitFor(() => framesFrom(mock, trunk, { skipHello: true }).some((f) => f.type === mux.TYPE.Data && f.payload.toString() === 'still-alive'), { timeoutMs: 2000 }),
      '其它本机连接应继续跑在同一条干道上');
  } finally {
    for (const client of clients) client.destroy();
    await joiner.stop();
  }
});

test('★ 加入者多路复用：房主应答之前，本机数据只能扣着，绝不能提前发出去（规格 §八：老房主会把字节原样转给游戏服务）', async () => {
  // 这是"必须先发魔数、又必须在定帧前扣住业务字节"这两条要求之间的那道缝：
  // 加入者一发魔数，浏览器可能同时就把 HTTP 请求灌进来了。此时对端身份还没定 ——
  // 万一对面是 0.13.3，它会把我们写的每一个字节原样转给游戏端口，
  // 于是 `SHLMUX\x02<二进制帧头>GET / HTTP/1.1` 一起糊到 Web 服务脸上，请求直接失效。
  // 所以定帧之前只能扣住（holdFrames），听到房主应答后按原顺序补发（OPEN 必须在最前）。
  const mock = createMockSdk();
  const localPort = await h.freePort();
  const joiner = createSteamJoiner({ localPort, hostSteamId: HOST_STEAM_ID, sdk: mock.sdk, poolTarget: 0 });
  const client = await h.connect(localPort);
  try {
    // 本机客户端先说话：这一句必须被扣住，不能跟着魔数一起出去。
    client.write('GET / HTTP/1.1\r\n\r\n');
    assert.ok(await h.waitFor(() => mock.state.connectedTo.length >= 1, { timeoutMs: 3000 }));
    const trunk = mock.state.connectedTo[0].handle;
    assert.ok(await h.waitFor(() => {
      const chunks = mock.state.sent.filter((s) => s.connection === trunk);
      return chunks.length > 0 && chunks[0].data.includes(mux.HELLO_BYTES);
    }, { timeoutMs: 3000 }), '干道建好后第一件事是发魔数');

    // 房主还没应答：干道上的总字节数必须正好是那 7 个字节 —— 多一个字节就是数据泄漏。
    await h.wait(200);
    const wired = Buffer.concat(mock.state.sent.filter((s) => s.connection === trunk).map((s) => s.data));
    assert.equal(wired.toString('latin1'), mux.HELLO_BYTES.toString('latin1'),
      `定帧之前只能发那 7 字节魔数，实际发了 ${wired.length} 字节：${JSON.stringify(wired.toString('latin1'))}`);

    // 房主应答 → 扣住的帧按原顺序补发。
    mock.state.emitState({ connection: trunk, newState: STATE.Connected, info: { identityRemote: HOST_STEAM_ID } });
    mock.state.pushToClient(trunk, mux.encodeHello());
    assert.ok(await h.waitFor(() => (joiner.stats.muxPeers || 0) >= 1, { timeoutMs: 3000 }), '房主应答后应进入多路复用');

    const frames = framesFrom(mock, trunk, { skipHello: true });
    assert.equal(frames.length, 2, `补发的顺序应是 OPEN 然后 DATA，实际 ${frames.map((f) => mux.typeName(f.type)).join(',')}`);
    assert.equal(frames[0].type, mux.TYPE.Open, 'OPEN 必须排在最前（房主先要知道这个流号是谁的）');
    assert.equal(frames[1].type, mux.TYPE.Data, 'DATA 跟在 OPEN 后面');
    assert.equal(frames[1].streamId, frames[0].streamId, '两条帧必须属于同一条流');
    assert.equal(frames[1].payload.toString(), 'GET / HTTP/1.1\r\n\r\n', '扣住的字节要原样补发，一个都不能丢');
  } finally {
    client.destroy();
    await joiner.stop();
  }
});

test('加入者：对面认出魔数却把字节转给了游戏服务 ⇒ 整局退回单连接模式，本机连接一个字节都不许被污染', async () => {
  // 这就是"新加入者 + 旧房主（≤0.13.3）"的真实组合。老房主不认识魔数，把它连同后面的
  // 业务字节一起转给了游戏端口，于是游戏服务的响应（HTTP 报文）直接回到我们手上。
  // 判据是**协议事实**而不是超时：收到的第一个字节不是魔数，就说明对面不是 0.14.0。
  //
  // 为什么退得这么狠：多路复用是靠带内握手谈出来的，谈不成就只能整局退回"一条本机连接
  // = 一条 Steam 连接"。停在这条干道上的流一条都发不出去（OPEN 帧从没出过门），
  // 所以只能作废、让客户端重连 —— 重连时 legacyHost 已经是 true，走老路径，数据不会错位。
  const mock = createMockSdk();
  const localPort = await h.freePort();
  const events = [];
  const joiner = createSteamJoiner({
    localPort, hostSteamId: HOST_STEAM_ID, sdk: mock.sdk, poolTarget: 0,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  let legacyClient = null;
  let streamClient = null;
  try {
    await joiner.ready;
    streamClient = await h.connect(localPort); // 这条会变成干道上的一条流
    assert.ok(await h.waitFor(() => mock.state.connectedTo.length >= 1, { timeoutMs: 3000 }), '本机连接应让加入者去建干道');
    const trunk = mock.state.connectedTo[0].handle;
    assert.ok(await h.waitFor(() => mock.state.sent.some((s) => s.connection === trunk && s.data.includes(mux.HELLO_BYTES)), { timeoutMs: 3000 }));

    // 老房主把字节转给了游戏服务，游戏服务回了一句 HTTP —— 第一个字节不是魔数。
    // 先挂上监听：作废是立刻发生的，等事后再 waitClosed 会错过 'close' 事件。
    const closedWait = h.waitClosed(streamClient);
    mock.state.pushToClient(trunk, Buffer.from('HTTP/1.1 200 OK\r\n\r\n'));

    // 停在干道上的那条流必须被如实作废（浏览器会自己重连），而不是拿到半份脏数据。
    assert.ok(await h.waitFor(() => events.some((e) => e.type === 'stream-left' && String(e.payload.reason).includes('老版本')), { timeoutMs: 3000 }),
      '退回老路径时要报出 stream-left 并说清原因');
    assert.notEqual(await closedWait, 'timeout', '已作废的流必须如实关掉本机连接，不能挂着不动');

    // 关键是"退回老路径"真的生效了：下一条本机连接直接建自己的 Steam 连接，而且
    // 裸字节原样透传（老房主只认这个）。
    legacyClient = await h.connect(localPort);
    assert.ok(await h.waitFor(() => mock.state.connectedTo.length >= 2, { timeoutMs: 3000 }), '退回老路径后应改为一条本机连接一条 Steam 连接');
    const legacy = mock.state.connectedTo[1].handle;
    mock.state.emitState({ connection: legacy, newState: STATE.Connected, info: { identityRemote: HOST_STEAM_ID } });
    legacyClient.write('GET / HTTP/1.0\r\n\r\n');
    assert.ok(await h.waitFor(() => mock.state.sent.some((s) => s.connection === legacy && s.data.toString() === 'GET / HTTP/1.0\r\n\r\n'), { timeoutMs: 3000 }),
      '老路径必须原样透传，一个字节都不许加（老房主不认识帧）');
    assert.ok(!mock.state.sent.some((s) => s.connection === legacy && s.data.includes(mux.HELLO_BYTES)),
      '退回老路径之后不许再发魔数：那 7 个字节会被原样转给游戏服务，把请求头污染掉');
  } finally {
    streamClient?.destroy();
    legacyClient?.destroy();
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

test('★ 加入者：隧道一起来就把干道先握上，而且**只握一条**（规格 §三 / §二十三：不许为将来的请求预热）', async () => {
  // 这条用例的前身是"预热连接池趁没人用的时候先把连接养好"。0.14.0 把那个池子删了
  // （见 steam-adapter.cjs 顶部墓碑注释），但**"提前把连接准备好"这个意图本身是对的** ——
  // 只是现在只准备一条：一条干道能顶 64 条流，多开一条就只是多一次握手，而握手是这条
  // 线路上最贵的东西（校园网下单条 6~30 秒）。
  const mock = createMockSdk();
  const localPort = await h.freePort();
  const joiner = createSteamJoiner({ localPort, hostSteamId: HOST_STEAM_ID, sdk: mock.sdk });
  try {
    await joiner.ready;
    // 关键：**一条本机客户端都还没有**的时候，干道就应该在握了。
    assert.ok(
      await h.waitFor(() => mock.state.connectedTo.length >= 1, { timeoutMs: 3000 }),
      '干道应在没有任何本机客户端时就先握上 —— 用户点开页面时它就是现成的',
    );
    await h.wait(150);
    assert.equal(mock.state.connectedTo.length, 1, '只许握一条：第二条干道要等第一条真的满了才拉（规格 §三）');
  } finally {
    await joiner.stop();
  }
});

test('★ 加入者：干道建起来但房主一直不应答（首包丢了）—— 必须补发魔数、超期换一条，绝不能永久吊死', async () => {
  // 现场（2026-10-08，0.14.0 首日）就是这么挂的：14:47:29 旧干道被 Steam 以 4001 掐掉，
  // 14:47:31 加入者重新拉了一条，然后**那条干道 292 秒一个字节都没走过** —— 房主侧日志
  // 里"隧道存量"每一行都是 `上行0KiB 下行0KiB`。
  //
  // 为什么会永久吊死：干道建出来时魔数是直接排进队列的（spawnTrunk 里那一句），而首包在
  // 真实链路上是会丢的 —— 连接刚由 connectP2P 建好、Steam 还没把它推进 Connected，
  // sendMessage 就已经报了成功，那一帧再也没有第二次。于是：
  //   · peer 永远停在 framed === null；
  //   · hasLiveTrunk() 把"还没谈妥的干道"也算成活的 ⇒ refillTrunks() 再也不会补新的；
  //   · pickTrunk() 要求 framed === true ⇒ 之后每条本机连接都挂不上，全塞进 pendingSockets；
  //   · 旧干道上寄存的流等满 STREAM_MIGRATE_GRACE_MS 被清扫 ⇒ 浏览器那边"一直转圈"。
  // 三个断言分别钉住三个环节：补发魔数、超期换新、换出来的新干道仍然能把这局救回来。
  const mock = createMockSdk();
  const localPort = await h.freePort();
  const joiner = createSteamJoiner({
    localPort,
    hostSteamId: HOST_STEAM_ID,
    sdk: mock.sdk,
    // 把两个窗口压到几十毫秒，不然一条用例得跑半分钟。
    // giveup 留得比 retry 宽裕得多，好让 102 号在被放弃之前有足够时间完成握手。
    tuning: { trunkHelloRetryMs: 50, trunkHelloGiveupMs: 800 },
  });
  let client = null;
  try {
    await joiner.ready;
    assert.ok(
      await h.waitFor(() => mock.state.connectedTo.length >= 1, { timeoutMs: 3000 }),
      '加入者应主动建一条 Steam 干道（首包是魔数）',
    );
    const first = mock.state.connectedTo[0].handle;

    // 本机客户端在"还没有任何一条谈妥的干道"时进来：它应当被排队，而不是被拒掉。
    client = await h.connect(localPort);

    // ── ① 房主一句话都不回 ⇒ 必须补发魔数（一次都不重发就只能靠运气）
    assert.ok(
      await h.waitFor(
        () => mock.state.sent.filter((s) => s.connection === first && s.data.includes(mux.HELLO_BYTES)).length >= 2,
        { timeoutMs: 3000 },
      ),
      '等不到房主应答时必须补发魔数 —— 首包丢了就靠它救回来',
    );
    assert.ok(joiner.stats.trunkHelloResend >= 1, '补发要记账（stats.trunkHelloResend）');

    // ── ② 补发还是等不到 ⇒ 放弃这条、换一条重来，绝不许永远守着一条哑干道
    assert.ok(
      await h.waitFor(() => mock.state.connectedTo.length >= 2, { timeoutMs: 3000 }),
      '一直等不到应答时必须换一条新干道（hasLiveTrunk 不许把未定帧的干道一直算成活的）',
    );
    assert.ok(joiner.stats.trunkAbandoned >= 1, '放弃要记账（stats.trunkAbandoned）');
    assert.ok(mock.state.closed.some((c) => c.connection === first), '被放弃的那条 Steam 连接必须真的关掉');

    // ── ③ 换出来的新干道仍然能把这局救回来：房主这次应答，排队的本机连接要挂上去
    const second = mock.state.connectedTo[1].handle;
    mock.state.emitState({ connection: second, newState: STATE.Connected, info: { identityRemote: HOST_STEAM_ID } });
    mock.state.pushToClient(second, mux.encodeHello());
    assert.ok(
      await h.waitFor(() => (joiner.stats.muxPeers || 0) >= 1, { timeoutMs: 3000 }),
      '换出来的新干道应当能正常谈妥（不能因为刚才那次放弃就变成再也不会握手）',
    );
    const opened = await h.waitFor(
      () => framesFrom(mock, second, { skipHello: true }).filter((f) => f.type === mux.TYPE.Open).length >= 1,
      { timeoutMs: 3000 },
    );
    assert.ok(opened, '排队中的本机连接应当在新干道谈妥后自动挂上去（用户不用刷新页面）');
    assert.ok(client && !client.destroyed, '这一路折腾下来本机连接一条都不该被掐掉');

    // ── ④ 补发的魔数在已经谈妥的干道上必须被吞掉，不能喂进解码器当成帧头
    assert.equal(joiner.stats.failed || 0, 0, '迟到的魔数应答绝不能被当成非法帧（BadFraming）');
  } finally {
    if (client) client.destroy();
    await joiner.stop();
  }
});

test('★ 加入者：20 条本机连接进来，Steam 连接数仍然是 1（规格 §三十七 / §九 的硬守卫）', async () => {
  // 这是整个 0.14.0 重构要证明的那一条：**Steam 连接数与本机 TCP 数无关**。
  // 0.13.3 的现场是"一次页面加载 6~25 个 TCP → 6~25 次 30 秒握手，池子命中率 46%"，
  // 于是页面永远转不出来。20 这个数字取的是规格 §三十二 Test3 的 25 并发压一点余量。
  const mock = createMockSdk();
  const localPort = await h.freePort();
  const joiner = createSteamJoiner({ localPort, hostSteamId: HOST_STEAM_ID, sdk: mock.sdk });
  const clients = [];
  try {
    await joiner.ready;
    const handle = await answerHello(mock, joiner);
    for (let i = 0; i < 20; i += 1) clients.push(await h.connect(localPort));
    assert.ok(await h.waitFor(() => joiner.stats.totalStreams >= 20, { timeoutMs: 3000 }), '20 条本机连接应各自挂成一条流');
    await h.wait(100);

    assert.equal(mock.state.connectedTo.length, 1, '20 条本机连接绝不许变成 20 条 Steam 连接');
    assert.equal(joiner.stats.activeConnections, 1, '活跃 Steam 连接数必须是 1');
    assert.equal(joiner.stats.totalStreams, 20, '20 条流都该在');
    for (const client of clients) assert.ok(client && !client.destroyed, '本机连接不该被莫名掐掉');
    // 流号必须是"偶数、两两不同" —— 撞号的话两边会把数据写到错误的流上。
    const opened = framesFrom(mock, handle, { skipHello: true }).filter((f) => f.type === mux.TYPE.Open).map((f) => f.streamId);
    assert.equal(opened.length, 20, '20 条本机连接应各发一条 OPEN');
    assert.equal(new Set(opened).size, 20, '流号必须两两不同');
    for (const id of opened) {
      assert.equal(id % 2, 0, `加入者只许用偶数流号（规格 §十一），实际 ${id}`);
      assert.ok(id >= mux.STREAM_ID_CLIENT_START, `流号应从客户端起始号开始，实际 ${id}`);
    }
    assert.equal(handle, mock.state.connectedTo[0].handle, '还是那条开局的干道，没有换过');
  } finally {
    for (const client of clients) client.destroy();
    await joiner.stop();
  }
});

test('★ 加入者：同一条干道被报两次 Connected，也只算"就绪"一条（stats.trunksReady 口径）', async () => {
  // 真实 Steam 上中继换路会重报 Connected。计数不设防的话"就绪"会比"累计开"还大，
  // 现场日志看起来就像开了两条干道，判断"够不够"也会跟着失准。
  const mock = createMockSdk();
  const localPort = await h.freePort();
  const joiner = createSteamJoiner({ localPort, hostSteamId: HOST_STEAM_ID, sdk: mock.sdk });
  try {
    await joiner.ready;
    assert.ok(await h.waitFor(() => mock.state.connectedTo.length >= 1, { timeoutMs: 3000 }));
    const handle = mock.state.connectedTo[0].handle;
    mock.state.emitState({ connection: handle, newState: STATE.Connected, info: {} });
    mock.state.emitState({ connection: handle, newState: STATE.Connected, info: {} });
    await h.wait(50);
    assert.equal(joiner.stats.trunkCreated, 1, '只该开过一条干道');
    assert.equal(joiner.stats.trunksReady, 1, '就绪必须按条数算，不能按事件次数算');
  } finally {
    await joiner.stop();
  }
});

test('★ 加入者：干道断了不等于这半局作废 —— 本机连接一条不断，流被寄存并在新干道上原地复活（规格 §十六 / §十七）', async () => {
  // 现场形状：校园网/严格 NAT 下 Steam P2P 会中途断（5003 / I/O Operation Failed），
  // 0.13.3 的做法是"一条本机 TCP = 一条 Steam 连接"，断了就把浏览器那条 TCP 一起掐掉，
  // 于是页面白屏、地图重新下。0.14.0 规格 §十六 要求把 transport 和 session 分开：
  //   · 干道断 ⇒ 本机连接**一条都不许断**，字节寄存起来（上限 STREAM_PARK_MAX_BYTES）
  //   · 立刻拉一条新干道；它一谈妥就把寄存的流用**同一个流号、世代 +1** 重新 OPEN
  //   · 房主据此把原来那个游戏端口连接认回来（规格 §十七：旧世代的迟到帧直接丢）
  const mock = createMockSdk();
  const localPort = await h.freePort();
  const events = [];
  const joiner = createSteamJoiner({
    localPort, hostSteamId: HOST_STEAM_ID, sdk: mock.sdk,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  const clients = [];
  try {
    await joiner.ready;
    clients.push(await h.connect(localPort));
    clients.push(await h.connect(localPort));
    const trunkA = await answerHello(mock, joiner);

    const idsA = framesFrom(mock, trunkA, { skipHello: true })
      .filter((f) => f.type === mux.TYPE.Open).map((f) => f.streamId);
    assert.equal(idsA.length, 2, '两条本机连接应各发一个 OPEN 帧');
    for (const id of idsA) assert.equal(generationOf(mock, trunkA, id), 1, '第一条干道上的流从世代 1 开始');

    // ── 干道 A 断了（真机上就是 Steam reason 5003 / I/O Operation Failed）──
    mock.state.emitState({
      connection: trunkA,
      newState: STATE.ClosedByPeer,
      info: { identityRemote: HOST_STEAM_ID, endDebugMessage: 'I/O Operation Failed' },
    });

    // ① 本机连接一条都不能断 —— 这是整个 Phase 6 的存在理由。
    await h.wait(120);
    assert.ok(clients.every((c) => !c.destroyed && c.writable),
      '干道断了绝不能掐本机连接：用户的页面正跑在上面');
    assert.equal(joiner.stats.streams, 0, '这 2 条流已经不属于任何干道（都寄存起来了）');
    assert.equal(joiner.stats.streamsParked, 2, '两条流应被寄存，而不是被 destroy');
    assert.equal(joiner.stats.streamsMigrateExpired || 0, 0, '宽限期内不该有流被判定为"没救回来"');

    // ② 断链期间浏览器继续发的字节要**攒住**，不能丢（那是请求正文）也不能记成丢弃。
    const droppedBefore = joiner.stats.dropped || 0;
    clients[0].write('during-outage');
    await h.wait(100);
    assert.equal(joiner.stats.dropped || 0, droppedBefore,
      '寄存期间的字节必须攒住：丢掉一个字节就是请求损坏，浏览器只会看到半截响应');

    // ③ 断链本身要触发拉新干道（不是等下一次本机连接进来才想起来建）。
    assert.ok(await h.waitFor(() => mock.state.connectedTo.length >= 2, { timeoutMs: 3000 }),
      '干道断了应立刻拉一条新的：否则重连进来的客户端又要等一次握手');
    const trunkB = mock.state.connectedTo[1].handle;
    assert.notEqual(trunkB, trunkA, '必须是一条新的 Steam 连接');
    assert.ok(await h.waitFor(
      () => mock.state.sent.some((s) => s.connection === trunkB && s.data.includes(mux.HELLO_BYTES)),
      { timeoutMs: 2000 },
    ), '新干道也要走一遍开场魔数（加入者先开口）');
    mock.state.emitState({ connection: trunkB, newState: STATE.Connected, info: { identityRemote: HOST_STEAM_ID } });
    mock.state.pushToClient(trunkB, mux.encodeHello());

    // ④ 复活：**同一个流号**、世代 +1 重发 OPEN。
    assert.ok(await h.waitFor(
      () => framesFrom(mock, trunkB, { skipHello: true }).filter((f) => f.type === mux.TYPE.Open).length === 2,
      { timeoutMs: 3000 },
    ), '新干道谈妥后应把两条寄存的流都重新 OPEN 一次');
    const reopens = framesFrom(mock, trunkB, { skipHello: true }).filter((f) => f.type === mux.TYPE.Open);
    assert.deepEqual(reopens.map((f) => f.streamId).sort((a, b) => a - b), [...idsA].sort((a, b) => a - b),
      '必须复用原来的流号：换个号房主就认不回原来那个游戏端口连接，等于全断一次');
    for (const frame of reopens) {
      assert.equal(frame.generation, 2, `流 ${frame.streamId} 在新 transport 上世代必须是 +1（规格 §十七）`);
    }
    assert.equal(joiner.stats.streams, 2, '两条流都回到干道上了');
    assert.ok((joiner.stats.streamsMigrated || 0) >= 2, 'stats.streamsMigrated 要如实记账（诊断要看这个数）');

    // ⑤ 断链期间攒下的字节必须在 OPEN **之后**补发，而且带新世代。
    const framesB = framesFrom(mock, trunkB, { skipHello: true });
    const firstOpenAt = framesB.findIndex((f) => f.type === mux.TYPE.Open);
    const parkedAt = framesB.findIndex((f) => f.type === mux.TYPE.Data && f.payload.toString() === 'during-outage');
    assert.ok(parkedAt >= 0, '断链期间攒下的字节必须补发出去，不能悄悄吞掉');
    assert.ok(parkedAt > firstOpenAt,
      '补发的字节必须排在 OPEN 之后：OPEN 在前房主才认得出这是哪条流，否则那段字节会撞上一个不存在的流号');
    assert.equal(framesB[parkedAt].generation, 2, '补发的字节要带新世代，否则会被房主当成旧连接的迟到帧丢掉');

    // ⑥ 复活之后两个方向都要能继续跑（迁移不是"勉强连上"，是恢复原状）。
    clients[1].write('after-recovery');
    assert.ok(await h.waitFor(
      () => framesFrom(mock, trunkB, { skipHello: true }).some((f) => f.type === mux.TYPE.Data && f.payload.toString() === 'after-recovery'),
      { timeoutMs: 2000 },
    ), '复活后的上行应继续工作');
    const got = h.collect(clients[1], 18);
    mock.state.pushToClient(trunkB, mux.encodeData(idsA[1], 2, Buffer.from('back-after-recovery')));
    assert.equal((await got).toString(), 'back-after-recovery', '复活后的下行应继续工作');

    // ⑦ 用户不该看到任何"连接断了"的流级事件 —— 流从来没断过。
    const leftKinds = events.filter((e) => e.type === 'stream-left').map((e) => e.payload?.kind);
    assert.ok(!leftKinds.includes('TunnelClosed'),
      `干道断链不该产生任何 TunnelClosed 的流事件（实际 ${JSON.stringify(leftKinds)}）：那正是"用户掉线了"的信号`);
  } finally {
    for (const client of clients) client.destroy();
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
