'use strict';
// Phase 8 验收测试（规格 §三十二 的 12 项）。
//
// 这份文件补的是"**端到端**"那一层：房主与加入者**两侧真正的适配器**都跑起来，中间用一根桥
// 把两个独立的假 SDK 对接起来。前面那些测试各自钉住一侧的行为，这里回答的是规格真正要问的：
// 「25 条本机 TCP 过去，Steam 层是不是还只有 1 条？」「32MB 传过去会不会膨胀、会不会少字节？」
//
// 与规格 §三十二 的逐项对照：
//   Test1  单 TCP                → test/steam-adapter.test.cjs「本机客户端 -> Steam -> 房主回包」
//   Test2  10 并发               → 本文件（与 Test3 合并：10 → 25 要连着看，单看 25 分不出"线性增长"和"常数"）
//   Test3  25 并发 → 1 Primary   → 本文件
//   Test4  连续建/关 100 条 TCP  → 本文件
//   Test5  Primary 强制断开      → test/steam-adapter.test.cjs 的两条迁移用例（房主侧 / 加入者侧）
//   Test6  断开且 Backup 存在    → **没有对应实现**：本版不建 Backup 连接（规格 §六 明确允许），见 docs 6.5
//   Test7  Relay 不可用不风暴    → test/campus-profile.test.cjs §3 / §9
//   Test8  Relay 恢复            → test/campus-profile.test.cjs §10
//   Test9  旧连接迟到 DATA 丢弃  → 本文件
//   Test10 HTTP/1.0 最后一段     → test/steam-adapter.test.cjs 两侧各一条
//   Test11 WebSocket 长连接      → 本文件
//   Test12 1MB / 8MB / 32MB      → 本文件
//
// 诚实声明：仍然是**注入的假 SDK**（本机没有 Steamworks SDK redistributable，Valve 不允许随包分发）。
// 这些用例能证明"我们这一侧的逻辑与计数是对的"，**不能证明**校园网下握手真的会成功。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');

const { createSteamHost, createSteamJoiner } = require('../network/steam-adapter.cjs');
const { createMockSdk, HOST_STEAM_ID, STATE, LISTEN } = require('./steam-mock.cjs');
const h = require('./helpers.cjs');
const mux = require('../network/stream-mux.cjs');

const JOINER_STEAM_ID = '76561198000000002';

/**
 * 一台"只收不回"的游戏服务。
 *
 * 为什么需要它：回声服务器会把上行原样送回来，于是本机客户端收到的字节里混着"自己刚发出去的那份"，
 * 想验证"下行顺序"就必须先把它们分干净。WebSocket 那条用例只关心下行时序，所以用这个版本。
 */
async function startSinkServer() {
  const sockets = new Set();
  const received = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => { /* 客户端断开属正常 */ });
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => received.push(Buffer.from(chunk)));
  });
  const port = await h.freePort();
  await h.listen(server, port);
  return {
    port,
    server,
    received,
    text: () => Buffer.concat(received).toString(),
    connections: () => sockets.size,
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await h.close(server);
    },
  };
}

/**
 * 把房主与加入者接成一条回路。
 *
 * 为什么要费这个劲：规格 §三十七 的验收指标（"P2P 数量与 Minecraft TCP 数量无关"）单看任何
 * 一侧都测不出来 —— 加入者那边数"我建了几条"，房主那边数"我收了几条流"，只有两边都在跑、
 * 数据真的来回走，才能证明"25 条 TCP 走一条 P2P 且互不串线"。
 *
 * 桥的方向：
 *   加入者 sendMessage → 房主 poll group（对端发来的消息）
 *   房主 sendMessage   → 加入者 receiveMessages（对端发来的消息）
 *
 * 桥是**动态**的：加入者每新开一条干道（迁移时会这样），桥就在房主那一侧补一次
 * Connecting + Connected，让房主真的经历"又有一个对端连进来了"。不这么做的话，
 * 迁移用例会卡在"新干道的魔数根本没送到房主"上 —— 那是测试脚手架的问题，不是产品的问题。
 *
 * 桥会**抽干** `state.sent`（而不是只读不删）：Test12 要传 32MB，留着不放会让假 SDK
 * 自己变成内存泄漏，那就测不出真实的内存行为。抽干的同时按连接留一份有上限的 tap，
 * 好让用例还能检查帧结构（OPEN 帧在最前面，128KB 足够覆盖几十条流）。
 */
async function startLoopback({ game }) {
  const hostMock = createMockSdk();
  const joinerMock = createMockSdk();
  const hostEvents = [];
  const joinerEvents = [];

  const host = createSteamHost({
    gameHost: '127.0.0.1',
    gamePort: game.port,
    sdk: hostMock.sdk,
    onEvent: (type, payload) => hostEvents.push({ type, payload }),
  });
  await host.ready;

  const localPort = await h.freePort();
  const joiner = createSteamJoiner({
    localPort,
    hostSteamId: HOST_STEAM_ID,
    sdk: joinerMock.sdk,
    onEvent: (type, payload) => joinerEvents.push({ type, payload }),
  });

  const tapCap = 128 * 1024;
  const tap = {
    up: new Map(), down: new Map(),
    upBytes: new Map(), downBytes: new Map(),
    maxUp: 0, maxDown: 0, countUp: 0, countDown: 0,
  };
  const hosts = new Set();   // 已经在房主那一侧"连进来"过的 Steam 连接号

  const record = (map, bytesMap, handle, data) => {
    const used = bytesMap.get(handle) || 0;
    if (used >= tapCap) return;
    const list = map.get(handle) || [];
    list.push(data);
    map.set(handle, list);
    bytesMap.set(handle, used + data.length);
  };
  const admit = (handle) => {
    if (hosts.has(handle)) return;
    hosts.add(handle);
    const info = { identityRemote: JOINER_STEAM_ID, listenSocket: LISTEN };
    hostMock.state.emitState({ connection: handle, newState: STATE.Connecting, info });
    hostMock.state.emitState({ connection: handle, newState: STATE.Connected, info });
  };

  const bridge = setInterval(() => {
    for (const s of joinerMock.state.sent.splice(0)) {
      admit(s.connection);
      tap.countUp += 1;
      if (s.data.length > tap.maxUp) tap.maxUp = s.data.length;
      record(tap.up, tap.upBytes, s.connection, s.data);
      hostMock.state.pushToHost(s.connection, s.data);
    }
    for (const s of hostMock.state.sent.splice(0)) {
      if (!hosts.has(s.connection)) continue;
      tap.countDown += 1;
      if (s.data.length > tap.maxDown) tap.maxDown = s.data.length;
      record(tap.down, tap.downBytes, s.connection, s.data);
      joinerMock.state.pushToClient(s.connection, s.data);
    }
  }, 1);
  bridge.unref();

  const handshook = await h.waitFor(() => (joiner.stats.muxPeers || 0) >= 1, { timeoutMs: 5000 });
  assert.ok(handshook, '回路应当在 5 秒内谈成多路复用（加入者先发魔数、房主应答）');

  /** 解一条连接上"这一侧发出去的帧"。首包魔数是裸字节，先切掉。 */
  const decodeTap = (map, handle, what) => {
    const chunks = map.get(handle) || [];
    if (!chunks.length) return [];
    let wire = Buffer.concat(chunks);
    assert.ok(
      wire.length >= mux.HELLO_BYTES.length
      && wire.subarray(0, mux.HELLO_MAGIC_BYTES.length).equals(Buffer.from(mux.HELLO_MAGIC)),
      `${what} 在连接 ${handle} 上的第一条消息应当是魔数`,
    );
    wire = wire.subarray(mux.HELLO_BYTES.length);
    return wire.length ? mux.createFrameDecoder().push(wire) : [];
  };

  return {
    game, host, joiner, hostMock, joinerMock, localPort, tap, hostEvents, joinerEvents,
    /** 加入者建过的干道连接号，按出现顺序。 */
    upHandles: () => [...tap.up.keys()],
    /** 加入者发出去的帧（首包魔数已切掉）。默认取最后一条干道。 */
    upFrames: (handle) => decodeTap(tap.up, handle === undefined ? [...tap.up.keys()].pop() : handle, '加入者'),
    /** 房主发出去的帧（首包魔数是应答，也要切掉）。 */
    downFrames: (handle) => decodeTap(tap.down, handle === undefined ? [...tap.down.keys()].pop() : handle, '房主'),
    async close() {
      clearInterval(bridge);
      await joiner.stop();
      await host.stop();
      await game.close();
    },
  };
}

// ── Test2 / Test3 ─────────────────────────────────────────────────────────────
test('★ §三十二 Test2+Test3：25 条本机 TCP 并发，Steam 层仍然只有 1 条连接（Primary 1 / Backup 0），且互不串线', async () => {
  // 这一条是整个 0.14.0 的验收指标本身（规格 §三十七："25 TCP → 1 P2P，而不是 25 → 25"）。
  // 为什么 10 与 25 放在同一条里：单看 25 分不清"常数"和"碰巧"—— 10 条时是 1、25 条时还是 1，
  // 才说明它与本机 TCP 数量无关；只测一个点的话，一个"每 25 条才多建一条"的错误实现也能混过去。
  const game = await h.startEchoServer();
  let lb = null;
  try {
    lb = await startLoopback({ game });
    const TAGS = [];
    const clients = [];
    for (let i = 0; i < 25; i += 1) {
      const tag = `P${String(i).padStart(3, '0')}`;   // 4 字节定长：回声按定长切，不靠分隔符
      TAGS.push(tag);
      const socket = await h.connect(lb.localPort);
      clients.push(socket);
      socket.write(tag);
      if (i === 9) {
        // 10 条到齐、这一批的回声还没回来之前，Steam 层就必须已经只有 1 条。
        assert.equal(lb.joinerMock.state.connectedTo.length, 1, '10 条本机 TCP 时 Steam 连接数就应该是 1');
      }
    }

    assert.equal(lb.joinerMock.state.connectedTo.length, 1,
      '25 条本机 TCP 之后 Steam 连接数仍然是 1 —— Primary 恰好一条、Backup 一条都没有（规格 §三）');
    assert.equal(lb.joiner.stats.activeConnections, 1, '加入者自己数的活跃 Steam 连接也必须是 1');
    assert.equal(lb.joiner.stats.trunkCreated, 1, '从头到尾只该建过一条干道');

    // 每条连接都要收到**属于自己**的那 4 个字节，一条不落、一条不错。
    const echoes = await Promise.all(clients.map((socket) => h.collect(socket, 4, 8000)));
    echoes.forEach((buf, i) => {
      assert.equal(buf.length, 4, `第 ${i} 条连接应当收到 4 字节回声`);
      assert.equal(buf.toString(), TAGS[i], `第 ${i} 条连接收到的必须是它自己发的那 4 个字节（串线就是两个游戏请求互相污染）`);
    });

    // 加入者侧：25 条流、流号是连续偶数（房主用奇数，见规格 §十一）。
    assert.equal(lb.joiner.stats.streams, 25, '25 条本机连接应当成为干道上的 25 条流');
    assert.equal(lb.joiner.stats.totalStreams, 25);
    const opens = lb.upFrames().filter((f) => f.type === mux.TYPE.Open);
    assert.equal(opens.length, 25, '25 条流各发一条 OPEN');
    const ids = opens.map((f) => f.streamId);
    assert.equal(new Set(ids).size, 25, '流号两两不同');
    assert.ok(ids.every((id) => id % 2 === 0 && id >= mux.STREAM_ID_CLIENT_START), '加入者只分配偶数流号');

    // 房主侧：一条 Steam 连接、25 条流、游戏端口 25 条连接。
    assert.equal(lb.host.stats.peers, 1, '房主也只该看到 1 条 Steam 连接');
    assert.equal(lb.host.stats.streams, 25, '房主侧应当登记 25 条流');
    assert.equal(lb.game.connections(), 25, '游戏服务看到的是 25 条**本机**连接 —— 这是应该的，它们本来就是 25 个请求');

    // 收尾要干净：本机连接全关掉之后，两侧的流表都要回到 0，干道还在。
    for (const socket of clients) socket.destroy();
    assert.ok(await h.waitFor(() => lb.joiner.stats.streams === 0, { timeoutMs: 5000 }),
      '25 条本机连接全部关闭之后，加入者的流表应当回到 0');
    assert.equal(lb.joiner.stats.activeConnections, 1, '关掉 25 条流不许动那条干道');
  } finally {
    // 回路没搭起来也要把游戏服务收掉：留着一个开着的 server 会让测试进程挂住不退出，
    // 于是"某条用例失败"会表现成"整个文件卡死"，反而看不出真正的原因。
    if (lb) await lb.close(); else await game.close();
  }
});

// ── Test4 ─────────────────────────────────────────────────────────────────────
test('★ §三十二 Test4：连续建/关 100 条本机 TCP，Steam 连接数一条都不多（规格 §三十七）', async () => {
  // 池子时代最刺眼的就是这一条：连续 100 个请求会让池子不停地"换新 / 自死 / 重建"
  // （现场账本：累计开 83 / 就绪 67 / 命中 52 / 未命中 57 / 换新 12 / **自死 15** / 均寿 31s）。
  // 现在干道与请求无关，这个循环应该一个字节的握手都不产生。
  const game = await h.startEchoServer();
  let lb = null;
  try {
    lb = await startLoopback({ game });
    const baseline = lb.joinerMock.state.connectedTo.length;
    assert.equal(baseline, 1, '起点就是 1 条干道');

    for (let i = 0; i < 100; i += 1) {
      const tag = `Q${String(i).padStart(4, '0')}`;   // 5 字节定长
      const socket = await h.connect(lb.localPort);
      socket.write(tag);
      const echo = await h.collect(socket, 5, 8000);
      assert.equal(echo.toString(), tag, `第 ${i} 次请求的回声必须原样回来`);
      socket.destroy();
    }

    assert.equal(lb.joinerMock.state.connectedTo.length, baseline,
      '100 次建/关之后 Steam 连接数必须与起点完全相同 —— 一次多余握手都不许有');
    assert.equal(lb.joiner.stats.trunkCreated, 1, '全程只建过一条干道');
    assert.equal(lb.joiner.stats.streamsMigrateExpired || 0, 0, '本机正常关闭不是"迁移失败"');

    // 流表要清干净：关掉的流不能留在账上（留着就是内存与流号的双重泄漏）。
    assert.ok(await h.waitFor(() => lb.joiner.stats.streams === 0, { timeoutMs: 5000 }),
      '100 条流全部关闭之后，加入者的流表应当回到 0');
    assert.equal(lb.joiner.stats.totalStreams, 100, '累计开过 100 条流');

    // 干道本身没被这些关闭动作波及。
    assert.equal(lb.joiner.stats.activeConnections, 1, '关流绝不能动干道');
    assert.equal(lb.joinerMock.state.closed.length, 0, '整轮测试不该关掉任何一条 Steam 连接');
  } finally {
    // 回路没搭起来也要把游戏服务收掉：留着一个开着的 server 会让测试进程挂住不退出，
    // 于是"某条用例失败"会表现成"整个文件卡死"，反而看不出真正的原因。
    if (lb) await lb.close(); else await game.close();
  }
});

// ── Test9 ─────────────────────────────────────────────────────────────────────
test('★ §三十二 Test9：旧 connection 上迟到的 DATA 必须被丢掉（generation 对不上就是脏数据）', async () => {
  // 规格 §十七 的验收：`Stream 8 generation 3` 的旧字节，绝不能被写进复活的 `Stream 8 generation 4`。
  // 为什么这一条比"能不能重连"更重要：重连失败用户看得见（页面转圈），脏字节用户看不见 ——
  // 表现是地图文件校验不过、或者贴图错位，那种问题在现场根本查不出来。
  const game = await h.startEchoServer();
  let lb = null;
  try {
    lb = await startLoopback({ game });
    const client = await h.connect(lb.localPort);
    client.write('W-1');            // 第一条流、世代 1
    const first = await h.collect(client, 3, 5000);
    assert.equal(first.toString(), 'W-1', '第一条流应当正常工作');
    const streamId = mux.STREAM_ID_CLIENT_START;
    assert.equal(lb.joiner.stats.streams, 1);
    const trunkA = lb.upHandles()[0];

    // 干道断：**两侧**都收到断开（真实 Steam 连接是两边一起断的），加入者把流寄存起来。
    const closeInfo = { identityRemote: HOST_STEAM_ID, endDebugMessage: 'I/O Operation Failed' };
    lb.joinerMock.state.emitState({ connection: trunkA, newState: STATE.ClosedByPeer, info: closeInfo });
    lb.hostMock.state.emitState({ connection: trunkA, newState: STATE.ClosedByPeer, info: closeInfo });
    assert.ok(await h.waitFor(() => (lb.joiner.stats.streamsParked || 0) >= 1, { timeoutMs: 3000 }),
      '干道断了之后这条流应当被寄存');
    assert.equal(client.destroyed, false, '干道断了本机连接不许断');
    assert.equal(lb.host.stats.streamsParked || 0, 1, '房主那一侧同样只寄存、不拆游戏端口那条连接');

    // 新干道谈妥（加入者会自己拉一条，桥把它接到房主），流原地复活、世代 +1。
    assert.ok(await h.waitFor(() => lb.joiner.stats.streamsMigrated >= 1, { timeoutMs: 10000 }),
      '新干道建立后应当把寄存的流认回来');
    const handles = lb.upHandles();
    assert.equal(handles.length, 2, '应当建了第二条干道');
    const trunkB = handles[1];
    assert.equal(lb.joinerMock.state.connectedTo.length, 2, '全程只该有这两条 Steam 连接（旧的死、新的活）');

    // 认回流与"OPEN 真的上了线路"是两件事：`streamsMigrated` 在**入队**那一刻就涨了，
    // 而发出去要等下一个泵周期（4ms 一轮，攒到 16KB 也发）。所以要等线路，不能等计数。
    const openFilter = (f) => f.type === mux.TYPE.Open;
    assert.ok(await h.waitFor(() => lb.upFrames(trunkB).some(openFilter), { timeoutMs: 5000 }),
      '新干道上应当重发 OPEN');
    const open = lb.upFrames(trunkB).filter(openFilter).pop();
    assert.equal(open.streamId, streamId, '复活用的还是同一个流号');
    assert.equal(open.generation, 2, '复活后世代必须 +1（否则分不清新字节和旧连接的迟到字节）');

    // ★ 关键一步：在**新干道**上灌一帧旧世代的 DATA，以及一帧旧世代的 CLOSE。
    const staleBefore = lb.joiner.stats.staleFrames || 0;
    lb.joinerMock.state.pushToClient(trunkB, mux.encodeData(streamId, 1, Buffer.from('STALE-BYTES')));
    lb.joinerMock.state.pushToClient(trunkB, mux.encodeClose(streamId, 1));
    assert.ok(await h.waitFor(() => (lb.joiner.stats.staleFrames || 0) > staleBefore, { timeoutMs: 3000 }),
      '世代对不上的帧应当被计成 staleFrames（规格 §十七）');
    await h.wait(150);
    assert.equal(client.destroyed, false, '旧世代的 CLOSE 不许把复活的流关掉 —— 它属于上一个世代');

    // 新世代的字节必须照常通过 —— 证明"丢的是旧的，不是这条流废了"。
    lb.joinerMock.state.pushToClient(trunkB, mux.encodeData(streamId, 2, Buffer.from('FRESH')));
    const fresh = await h.collect(client, 5, 5000);
    assert.equal(fresh.toString(), 'FRESH', '新世代的字节必须原样到达');
    assert.ok(!fresh.includes(Buffer.from('STALE')), '旧世代那 11 个字节一个都不许漏给本机连接');
  } finally {
    // 回路没搭起来也要把游戏服务收掉：留着一个开着的 server 会让测试进程挂住不退出，
    // 于是"某条用例失败"会表现成"整个文件卡死"，反而看不出真正的原因。
    if (lb) await lb.close(); else await game.close();
  }
});

// ── Test11 ────────────────────────────────────────────────────────────────────
test('★ §三十二 Test11：WebSocket 那种"一条长连接、来回几十个来回"的场景必须一直稳', async () => {
  // WebSocket 与 HTTP 请求的区别在于它**一直开着**：一次世代错乱、一次前台切后台的抖动、
  // 一次"关流时把干道一起收了"，都会让整局游戏掉线，而不是让某一个请求重来一次。
  // 所以这里用 60 个来回 + 中途穿插长连接空闲，检查流一直在、世代一直没变、上下行顺序都对。
  const game = await startSinkServer();   // 只收不回：下行内容必须全部来自用例自己推的帧
  let lb = null;
  try {
    lb = await startLoopback({ game });
    const client = await h.connect(lb.localPort);
    const streamId = mux.STREAM_ID_CLIENT_START;
    const trunk = lb.upHandles()[0];        // 长连接用例里自始至终只有这一条干道
    const received = [];
    let buffered = Buffer.alloc(0);
    client.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      // 每条下行消息正好 5 字节（`<-NN;`）。
      while (buffered.length >= 5) {
        received.push(buffered.subarray(0, 5).toString());
        buffered = buffered.subarray(5);
      }
    });

    const ROUNDS = 60;
    for (let i = 0; i < ROUNDS; i += 1) {
      const n = String(i).padStart(2, '0');
      client.write(`->${n};`);                                                                       // 上行
      lb.joinerMock.state.pushToClient(CONN_OF(lb), mux.encodeData(streamId, 1, Buffer.from(`<-${n};`))); // 下行
      if (i === 20 || i === 40) await h.wait(250);   // 模拟"长连接闲着"：空闲不许被误判成死流
      assert.ok(await h.waitFor(() => received.length >= i + 1, { timeoutMs: 5000 }),
        `第 ${i} 个来回的下行消息应当到达（长连接一旦断在半路，游戏就是掉线而不是慢）`);
    }

    assert.deepEqual(received, Array.from({ length: ROUNDS }, (_, i) => `<-${String(i).padStart(2, '0')};`),
      '60 个下行消息必须按原顺序、一条不差地到达');
    // 上行也要按顺序落到游戏服务上（只收不回的服务器让这件事可以干净地断言）。
    assert.ok(await h.waitFor(() => game.text().length >= ROUNDS * 5, { timeoutMs: 5000 }),
      '60 个上行消息应当全部到达游戏服务');
    assert.equal(game.text(), Array.from({ length: ROUNDS }, (_, i) => `->${String(i).padStart(2, '0')};`).join(''),
      '上行 60 个消息也必须按原顺序、一条不差');

    assert.equal(client.destroyed, false, '整轮下来这条长连接不许断');
    assert.equal(lb.joiner.stats.streams, 1, '全程只有这一条流');
    assert.equal(lb.joiner.stats.streamsMigrated || 0, 0, '长连接期间不该发生任何迁移');
    assert.equal(lb.joinerMock.state.connectedTo.length, 1, '也不该冒出第二条 Steam 连接');
    const opens = lb.upFrames().filter((f) => f.type === mux.TYPE.Open);
    assert.equal(opens.length, 1, 'OPEN 只发一次（重复 OPEN 会把房主那边的游戏连接开重）');
    assert.equal(opens[0].generation, 1, '没有迁移，世代就不该变');

    const tunnelClosed = lb.joinerEvents.filter((e) => e.type === 'stream-left' && e.payload && e.payload.kind === 'TunnelClosed');
    assert.equal(tunnelClosed.length, 0, '长连接期间不该报出任何"隧道关闭"的流事件');
  } finally {
    // 回路没搭起来也要把游戏服务收掉：留着一个开着的 server 会让测试进程挂住不退出，
    // 于是"某条用例失败"会表现成"整个文件卡死"，反而看不出真正的原因。
    if (lb) await lb.close(); else await game.close();
  }
});

/** 当前唯一那条干道的连接号（长连接用例里它一直是同一条）。 */
const CONN_OF = (lb) => lb.upHandles()[0];

// ── Test12 ────────────────────────────────────────────────────────────────────
/** 往本机那条 TCP 连接里灌一段可复现的图案数据（返回 Promise，尊重背压）。 */
const PATTERN = Buffer.alloc(4096);
for (let i = 0; i < PATTERN.length; i += 1) PATTERN[i] = (i * 37 + 11) & 0xff;

function writePattern(socket, bytes) {
  return new Promise((resolve, reject) => {
    let left = bytes;
    socket.once('error', reject);
    const pump = () => {
      while (left > 0) {
        const take = Math.min(left, PATTERN.length);
        left -= take;
        const slice = take === PATTERN.length ? PATTERN : PATTERN.subarray(0, take);
        if (!socket.write(slice)) { socket.once('drain', pump); return; }
      }
      socket.off('error', reject);
      resolve();
    };
    pump();
  });
}

/** 收到的图案数据的 sha256（不把 32MB 留在内存里对比，省得测出来的内存是测试自己的）。 */
const patternHash = (bytes) => {
  const hash = crypto.createHash('sha256');
  let left = bytes;
  while (left > 0) {
    const take = Math.min(left, PATTERN.length);
    hash.update(take === PATTERN.length ? PATTERN : PATTERN.subarray(0, take));
    left -= take;
  }
  return hash.digest('hex');
};

function readPattern(socket, bytes, timeoutMs) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    let total = 0;
    const finish = () => {
      socket.off('data', onData);
      clearTimeout(timer);
      resolve({ total, hash: hash.digest('hex') });
    };
    const onData = (chunk) => {
      const take = Math.min(chunk.length, bytes - total);
      hash.update(chunk.subarray(0, take));
      total += take;
      if (total >= bytes) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    socket.on('data', onData);
  });
}

for (const megabytes of [1, 8, 32]) {
  const bytes = megabytes * 1024 * 1024;
  test(`★ §三十二 Test12：${megabytes}MB 大 payload 端到端一个字节不许少、一个字节不许胀（内存不许无限涨）`, async () => {
    // 规格 §十四 要求"不要发巨大 Steam message"，§十三 要求"禁止无限 Buffer"。
    // 所以这一条同时钉三件事：
    //   · 收到的 sha256 与发出去的完全一致（分片、拼帧、乱序防护任何一处错了这里都会红）
    //   · 单条 Steam 消息不超过 maxChunk（4KB）—— 也就是"没有偷偷塞一条 1MB 的大消息"
    //   · 传完之后账目回到起点（流还在、没有多余连接、没有残留积压）
    const game = await h.startEchoServer();
    const lb = await startLoopback({ game });
    const timeoutMs = megabytes >= 32 ? 120000 : 30000;
    try {
      const client = await h.connect(lb.localPort);
      const reading = readPattern(client, bytes, timeoutMs);
      await writePattern(client, bytes);
      const got = await reading;

      assert.equal(got.total, bytes, `${megabytes}MB 必须一个字节不少地回来`);
      assert.equal(got.hash, patternHash(bytes), `${megabytes}MB 的内容必须逐字节一致`);

      // 分片检查：这条线路上单条 Steam 消息不许超过 maxChunk。
      // 默认 maxChunk 是 4096（link-tuning.cjs 的 DEFAULT_MAX_CHUNK / 规格 §十四 的 MAX_CHUNK）。
      const cap = 4096;
      assert.ok(lb.tap.maxUp <= cap, `上行单条消息最大 ${lb.tap.maxUp} 字节，不该超过 ${cap}`);
      assert.ok(lb.tap.maxDown <= cap, `下行单条消息最大 ${lb.tap.maxDown} 字节，不该超过 ${cap}`);
      // 也没有把 16KB 的 flush 攒成一个巨大的消息（那会让小请求排在它后面一起卡住）。
      assert.ok(lb.tap.countUp > bytes / (16 * 1024), '上行应当是"攒到 16KB 就发"的多次发送，而不是一条巨消息');

      // 账目回到起点：一条流、一条连接、没有迁移、没有因为"寄存攒不下"而丢东西。
      assert.equal(lb.joiner.stats.streams, 1, `${megabytes}MB 传完之后还是那一条流`);
      assert.equal(lb.joiner.stats.streamsMigrated || 0, 0, '传大文件期间不该发生迁移');
      assert.equal(lb.joiner.stats.streamsMigrateExpired || 0, 0, '更不该有流被清扫掉');
      assert.equal(lb.joinerMock.state.connectedTo.length, 1, `传 ${megabytes}MB 也不会多建一条 Steam 连接`);
    } finally {
      // 回路没搭起来也要把游戏服务收掉：留着一个开着的 server 会让测试进程挂住不退出，
    // 于是"某条用例失败"会表现成"整个文件卡死"，反而看不出真正的原因。
    if (lb) await lb.close(); else await game.close();
    }
  });
}
