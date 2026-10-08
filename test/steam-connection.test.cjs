'use strict';
// SteamConnection 单测：一条 Steam P2P 的薄封装 + 它自己的状态机。
//
// 这个文件盯的是规格里最要命的几条：
//   §六            九态状态机；进 DEGRADED / BACKOFF 的**唯一**触发源是这条连接自己的回调
//   §八 / §三十四-③ Steam 登录 / CM / backend 的状态**不接进来** —— 结构上不可能因为 Steam 掉线
//                  就把这条连接标成 DEGRADED。这不是靠 if 挡住的，是入参里根本没有那个东西。
//   §二十          故障分类（5003 / 5008 / 4001 / relay 不可用）不许只写"连接失败"
//   §十四          发送按 maxChunk 分片；发送失败必须如实返回 false，不许谎报成功
//   §十三          出站队列两级水位与硬上限
//   §十九          generation / 健康度快照
//
// 全程不需要真实 Steam：用的是 test/steam-mock.cjs 的假 SDK。
// 时钟是注入的（now: () => clock），模块里也没有任何 setTimeout —— 一毫秒都不真等。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STATE, STEAM_STATE, SEND_FLAG, END_REASON,
  OUT_HIGH_WATER, OUT_LOW_WATER, OUT_MAX_WATER, DEFAULT_MAX_CHUNK,
  describeEndReason, classifyFailure, createSteamConnection,
} = require('../network/steam-connection.cjs');
const { createMockSdk, FIRST_CONNECTION } = require('./steam-mock.cjs');

const PEER = '76561198000000002';

// 注入的假时钟：模块里所有时间都从这里来。
let clock = 1_000_000;

/** 建一条连接，并把 onEvent 收到的每一件事记下来（供断言"该报的报了、不该报的没报"）。 */
function makeConn(spec = {}) {
  const events = [];
  const conn = createSteamConnection({
    id: 'primary-1',
    role: 'primary',
    peerSteamId: PEER,
    now: () => clock,
    onEvent: (type, payload) => events.push({ type, payload }),
    ...spec,
  });
  return { conn, events, of: (type) => events.filter((e) => e.type === type) };
}

/** 一条"已经连上"的连接：adopt 走的是房主侧收编入站连接那条路径，等于直接给它一个句柄。 */
function liveConn(spec = {}) {
  const ctx = makeConn(spec);
  ctx.conn.adopt(FIRST_CONNECTION);
  ctx.events.length = 0;
  return ctx;
}

/** 最小的假 sockets：只实现被测代码会碰到的方法，调用都能数出来。 */
function stubSockets(extra = {}) {
  const calls = { connectP2P: [], sendMessage: [], sendReliable: [], closeConnection: [] };
  return {
    calls,
    connectP2P(steamId, port) { calls.connectP2P.push({ steamId, port }); return FIRST_CONNECTION; },
    sendMessage(connection, data, flags) { calls.sendMessage.push({ connection, data: Buffer.from(data), flags }); return 1; },
    closeConnection(connection, reason, message, linger) { calls.closeConnection.push({ connection, reason, message, linger }); return true; },
    ...extra,
  };
}

test('STATE 就是规格 §六 的九态，取值冻结、名字与值一一对应', () => {
  const NINE = ['DISCONNECTED', 'STARTING', 'RELAY_WAIT', 'CONNECTING', 'CONNECTED', 'DEGRADED', 'CLOSING', 'CLOSED', 'BACKOFF'];
  assert.equal(Object.keys(STATE).length, 9);
  assert.deepEqual(Object.values(STATE).slice().sort(), NINE.slice().sort());
  for (const [k, v] of Object.entries(STATE)) assert.equal(v, k);
  assert.equal(Object.isFrozen(STATE), true, '状态取值不许被运行时改掉');
});

test('导出常量就是规格里那组值（分片 / 水位 / 发送标志）', () => {
  assert.equal(DEFAULT_MAX_CHUNK, 4096, '一条 Steam message 不许是几 MB 的大块');
  assert.equal(OUT_HIGH_WATER, 1 * 1024 * 1024);
  assert.equal(OUT_LOW_WATER, 128 * 1024);
  assert.equal(OUT_MAX_WATER, 8 * 1024 * 1024);
  assert.equal(SEND_FLAG.Unreliable, 0);
  assert.equal(SEND_FLAG.NoNagle, 1);
  assert.equal(SEND_FLAG.Reliable, 8);
  assert.equal(SEND_FLAG.Reliable | SEND_FLAG.NoNagle, 9, '发送用的就是这两位');
  assert.equal(Object.isFrozen(SEND_FLAG), true);
  assert.equal(Object.isFrozen(STEAM_STATE), true);
});

test('describeEndReason：§二十 点名的结束原因给中文，区间码给分层描述，非数字给空串（规格 §二十）', () => {
  assert.equal(describeEndReason(1000), END_REASON[1000]);
  assert.equal(describeEndReason(1000), '正常关闭');
  assert.equal(describeEndReason(4001), '对端超时：对方没在规定时间内回应');
  assert.equal(describeEndReason(5001), '传输层通用错误');
  assert.equal(describeEndReason(5002), '传输层内部错误');
  assert.equal(describeEndReason(5003), '传输层超时');
  assert.equal(describeEndReason(5008), 'P2P 会合失败');
  // 没点名的码按区间给个能读懂的分层，日志里不许只写"连接失败"
  assert.equal(describeEndReason(1500), '应用层正常关闭');
  assert.equal(describeEndReason(2500), '应用层异常关闭');
  assert.equal(describeEndReason(3500), '本机侧网络问题');
  assert.equal(describeEndReason(4500), '对端侧网络问题');
  assert.equal(describeEndReason(5500), '传输层问题');
  assert.equal(describeEndReason(9999), '未知原因');
  // 不是数字不许瞎猜
  assert.equal(describeEndReason('abc'), '');
  assert.equal(describeEndReason(undefined), '');
  assert.equal(describeEndReason('5003'), '传输层超时', '数字字符串要认');
});

test('★ classifyFailure：5008 / 5003 / 4001 分别落到会合失败 / 传输失败 / 对端关闭（规格 §二十）', () => {
  assert.equal(classifyFailure({ reason: 5008 }), 'P2P_RENDEZVOUS_FAILED', 'P2P 会合失败要能和别的传输错误分开');
  assert.equal(classifyFailure({ reason: 5003 }), 'P2P_TRANSPORT_FAILED');
  assert.equal(classifyFailure({ reason: 4001 }), 'REMOTE_CLOSED');
  assert.equal(classifyFailure({ reason: 1000 }), 'REMOTE_CLOSED', '对端正常关也是对端关');
  assert.equal(classifyFailure({ reason: 5001 }), 'P2P_TRANSPORT_FAILED', '没点名的传输层错误归到通用传输失败');
  // 连都还没连上就秒挂 = 本机网络问题，不是对端的问题
  assert.equal(classifyFailure({ reason: 0, elapsedMs: 500 }), 'LOCAL_NETWORK_ERROR');
  assert.equal(classifyFailure({ reason: 0, elapsedMs: 5000 }), 'P2P_TRANSPORT_FAILED', '挂得太久就不是"秒挂"了');
  assert.equal(classifyFailure({}), 'P2P_TRANSPORT_FAILED', '什么都不给也要有个分类，不许返回空串');
});

test('★ classifyFailure：relay 不可用且从未就绪 —— 一律 RELAY_UNAVAILABLE，压过具体错误码（规格 §七）', () => {
  assert.equal(classifyFailure({ reason: 5003, relayUnavailable: true, everReady: false }), 'RELAY_UNAVAILABLE');
  assert.equal(classifyFailure({ reason: 5008, relayUnavailable: true, everReady: false }), 'RELAY_UNAVAILABLE');
  assert.equal(classifyFailure({ reason: 4001, relayUnavailable: true, everReady: false }), 'RELAY_UNAVAILABLE');
  // 曾经就绪过：说明这条路本来通，掉的锅不在 relay 头上，按具体错误码分类
  assert.equal(classifyFailure({ reason: 5003, relayUnavailable: true, everReady: true }), 'P2P_TRANSPORT_FAILED');
  assert.equal(classifyFailure({ reason: 5008, relayUnavailable: true, everReady: true }), 'P2P_RENDEZVOUS_FAILED');
  // relay 好好的：不许把锅甩给 relay
  assert.equal(classifyFailure({ reason: 5003, relayUnavailable: false, everReady: false }), 'P2P_TRANSPORT_FAILED');
});

test('★ 入参里没有"Steam 登录状态"这个东西：塞进去也没用（规格 §八 / §三十四-③）', () => {
  // 构造时把各种"全局 Steam 状态"一起塞进入参 —— 模块里根本没有接住它们的地方，
  // 所以 Steam 客户端 / CM 掉线在结构上不可能让这条连接变成 DEGRADED。
  const sockets = stubSockets();
  const { conn } = makeConn({
    sockets,
    steamLoginState: 'LoggedOff',
    steamCmState: 'Disconnected',
    globalSteamState: 'Offline',
    loginState: 'LoggedOff',
    cmState: 'Disconnected',
    steamUserState: 0,
  });
  assert.equal(conn.state, STATE.DISCONNECTED, '那些"全局状态"一个字都不许影响状态机');
  conn.open();
  assert.equal(conn.state, STATE.CONNECTING, 'Steam 客户端掉线也不会让它变 DEGRADED —— 它压根不知道这件事');
  // 真正能让它掉线的只有一条路：这条连接自己的 onSteamStateChange
  conn.onSteamStateChange({ newState: STEAM_STATE.ProblemDetectedLocally, info: { endReason: 5003 } });
  assert.equal(conn.state, STATE.BACKOFF);
});

test('★ 公开 API 上只有一个状态入口（onSteamStateChange），没有第二条进来的路（规格 §八 / §三十四-③）', () => {
  const { conn } = makeConn({ sockets: stubSockets() });
  const names = Object.getOwnPropertyNames(conn);
  assert.deepEqual(names.filter((n) => /^on[A-Z]/.test(n)), ['onSteamStateChange'],
    '整个对象上的"输入型回调"只能有一个，多一个就是全局状态进来的后门');
  assert.deepEqual(names.filter((n) => /login|cmstate|globalsteam|userstate|account/i.test(n)), [],
    'API 表面不许出现任何"全局 Steam 状态"字段');
  assert.equal(typeof conn.setState, 'undefined', '不许有直接改状态的入口');
  assert.equal(typeof conn.onConnectionStateChange, 'undefined', '回调是由 manager 转发进来的，不是自己订阅的');
  // state 是只读 getter：外部赋值改不动它（严格模式下会直接抛）
  assert.throws(() => { conn.state = STATE.CONNECTED; });
  assert.equal(conn.state, STATE.DISCONNECTED);
});

test('open()：relay 闸门不放行就停在 RELAY_WAIT —— 不连、不算失败、不排重试（规格 §七）', () => {
  const sockets = stubSockets();
  const { conn, of } = makeConn({ sockets });
  const rc = conn.open({ relayGate: { ok: false, reason: 'relay-unavailable', detail: 'Failed', debugMessage: 'no relay' } });
  assert.equal(rc.ok, false);
  assert.equal(rc.code, 'RELAY_WAIT');
  assert.equal(conn.state, STATE.RELAY_WAIT);
  assert.equal(sockets.calls.connectP2P.length, 0, 'relay 没就绪就一个 connectP2P 都不许发');
  assert.equal(conn.failureClass, '', 'relay 没就绪不是失败，不许记 failureClass');
  assert.equal(conn.failureText, '');
  assert.equal(conn.retryAt, 0, 'RELAY_WAIT 不排重试 —— 这是 §三十四-④「无限 retry」的挡板');
  assert.equal(of('transport-relay-wait').length, 1);
  assert.equal(of('transport-failed').length, 0, '不许把它报成失败');
});

test('open()：没有 connectP2P 的 SDK 如实报 NOSDK 并落 CLOSED；connectP2P 抛异常落 BACKOFF 且不崩', () => {
  const noSdk = makeConn({ sockets: {} });
  assert.equal(noSdk.conn.open().code, 'NOSDK');
  assert.equal(noSdk.conn.state, STATE.CLOSED);
  assert.equal(noSdk.conn.failureClass, 'LOCAL_NETWORK_ERROR');

  const throwing = makeConn({ sockets: stubSockets({ connectP2P: () => { throw new Error('CLI 挂了'); } }) });
  const rc = throwing.conn.open();
  assert.equal(rc.ok, false);
  assert.equal(rc.code, 'ETHROW');
  assert.equal(rc.message, 'CLI 挂了');
  assert.equal(throwing.conn.state, STATE.BACKOFF, '抛异常要退避，不是把连接判死刑');
  assert.equal(throwing.conn.failureClass, 'P2P_TRANSPORT_FAILED');
  assert.equal(throwing.of('transport-failed').length, 1);
});

test('★ open() 走 connectP2P(peerSteamId, virtualPort) 进 CONNECTING；开着的时候再 open 是 BADSTATE', () => {
  const sockets = stubSockets();
  const { conn, of } = makeConn({ sockets, virtualPort: 7 });
  const rc = conn.open();
  assert.equal(rc.ok, true);
  assert.equal(rc.connection, FIRST_CONNECTION);
  assert.deepEqual(sockets.calls.connectP2P, [{ steamId: PEER, port: 7 }]);
  assert.equal(conn.state, STATE.CONNECTING);
  assert.equal(conn.handle, FIRST_CONNECTION);
  assert.equal(conn.attempt, 1);
  assert.equal(conn.isUsable, true);
  assert.equal(of('transport-connecting').length, 1);

  const again = conn.open();
  assert.equal(again.ok, false);
  assert.equal(again.code, 'BADSTATE');
  assert.equal(sockets.calls.connectP2P.length, 1, 'BADSTATE 不许偷偷再连一次');
});

test('状态机：Connecting / FindingRoute 都算 CONNECTING；认不出来的状态码一律返回 false 且不动状态（规格 §六）', () => {
  const { conn } = makeConn({ sockets: stubSockets() });
  conn.open();
  assert.equal(conn.onSteamStateChange({ newState: STEAM_STATE.FindingRoute }), true);
  assert.equal(conn.state, STATE.CONNECTING);
  assert.equal(conn.onSteamStateChange({ newState: STEAM_STATE.Connecting }), true);
  assert.equal(conn.state, STATE.CONNECTING);
  // 没见过的码必须如实说"我没处理"，不能默默当成某一态
  assert.equal(conn.onSteamStateChange({ newState: 42 }), false);
  assert.equal(conn.state, STATE.CONNECTING);
  assert.equal(conn.onSteamStateChange({ newState: STEAM_STATE.None }), false);
  assert.equal(conn.state, STATE.CONNECTING);
});

test('★ 回调 Connected → CONNECTED，并把 route / relay / remote 带出来（规格 §六 / §十九）', () => {
  const { conn, of } = makeConn({ sockets: stubSockets() });
  conn.open();
  clock += 120;
  assert.equal(conn.onSteamStateChange({
    newState: STEAM_STATE.Connected,
    info: { connectionDescription: 'relay:ams', popIdRelay: 3, identityRemote: PEER },
  }), true);
  assert.equal(conn.state, STATE.CONNECTED);
  assert.equal(conn.isConnected, true);
  const ev = of('transport-connected')[0];
  assert.equal(ev.payload.route, 'relay:ams', '走的直连还是中继必须可观测');
  assert.equal(ev.payload.relay, 3);
  assert.equal(ev.payload.remote, PEER);
  assert.equal(conn.health().aliveMs, 0, '刚连上 aliveMs 从 0 起算');
  clock += 5000;
  assert.equal(conn.health().aliveMs, 5000);
  assert.equal(conn.isUsable, true);
});

test('★ 从来没连上就断 → BACKOFF；连上过再断 → DEGRADED（规格 §六）', () => {
  const sockets = stubSockets();

  const never = makeConn({ sockets });
  never.conn.open();
  never.conn.onSteamStateChange({ newState: STEAM_STATE.ProblemDetectedLocally, info: { endReason: 5003 } });
  assert.equal(never.conn.state, STATE.BACKOFF, '一次都没连上，谈不上"降级"');
  assert.equal(never.conn.failureClass, 'P2P_TRANSPORT_FAILED');
  assert.equal(never.conn.isConnected, false);

  const wasLive = makeConn({ sockets });
  wasLive.conn.open();
  wasLive.conn.onSteamStateChange({ newState: STEAM_STATE.Connected });
  clock += 4000;
  wasLive.conn.onSteamStateChange({ newState: STEAM_STATE.ClosedByPeer, info: { endReason: 4001 } });
  assert.equal(wasLive.conn.state, STATE.DEGRADED, '连上过的那条是降级，不是回到起点的退避');
  assert.equal(wasLive.conn.failureClass, 'REMOTE_CLOSED');
  assert.equal(wasLive.conn.isConnected, true, 'DEGRADED 仍然算 connected —— 上层还等着它回来');
  const lost = wasLive.of('transport-lost')[0];
  assert.equal(lost.payload.aliveMs, 4000);
  assert.equal(lost.payload.reason, 4001);
  assert.equal(lost.payload.steamState, STEAM_STATE.ClosedByPeer);
  assert.equal(lost.payload.reasonText, END_REASON[4001]);
});

test('★ 断线时句柄交回、出站队列清空，失败原因如实记在连接上（规格 §二十）', () => {
  const { conn, of } = liveConn({ sockets: stubSockets() });
  const pending = Buffer.from('还没发出去的东西');
  conn.queue(pending);
  assert.equal(conn.queuedBytes, pending.length);
  assert.equal(conn.handle, FIRST_CONNECTION);

  conn.onSteamStateChange({ newState: STEAM_STATE.Dead, info: { endReason: 5003, endDebugMessage: '对端超时' } });
  assert.equal(conn.handle, null, '死掉之后不许再拿着旧句柄发东西');
  assert.equal(conn.isUsable, false);
  assert.equal(conn.queuedBytes, 0, '对端已经没了，队列里那些字节留着没有意义');
  assert.equal(conn.health().queueSize, 0);
  assert.equal(conn.health().failureReason, 5003);
  assert.equal(conn.failureText, '对端超时', 'SDK 给了 endDebugMessage 就用它，不用自己编');
  assert.equal(conn.failureClass, 'P2P_TRANSPORT_FAILED');
  assert.equal(of('transport-lost').length, 1);
});

test('markDegraded / markHealthy：心跳超时只降级不关连接，恢复了还能回来（规格 §六）', () => {
  const { conn, of } = liveConn({ sockets: stubSockets() });
  assert.equal(conn.markDegraded('心跳超时'), true);
  assert.equal(conn.state, STATE.DEGRADED);
  assert.equal(conn.isConnected, true, '降级之后连接还在，只是不健康');
  assert.equal(conn.isUsable, true);
  assert.equal(of('transport-state').pop().payload.failureClass, 'P2P_TRANSPORT_FAILED');
  assert.equal(of('transport-state').pop().payload.to, STATE.DEGRADED);

  assert.equal(conn.markHealthy(), true);
  assert.equal(conn.state, STATE.CONNECTED);
  // 只有从 CONNECTED 才能降级、只有从 DEGRADED 才能恢复 —— 别的状态上调用一律 false
  assert.equal(conn.markHealthy(), false, '本来就好好的，不需要"恢复"');
  assert.equal(conn.markDegraded('再来一次'), true);
  assert.equal(conn.markDegraded('还是一样'), false, '已经在 DEGRADED 了就别重复报');

  const never = makeConn({ sockets: stubSockets() });
  never.conn.open();
  assert.equal(never.conn.markDegraded('还没连上呢'), false, '没连上的连接没有"降级"可言');
  assert.equal(never.conn.state, STATE.CONNECTING);
});

// 现场教训：这条原本是 test.skip —— markDegraded() 把 failureClass 塞进了 transport-state 事件
// （下面那条用例钉住），但 setState() 只把它放进事件 payload、从不写回模块变量，于是
// health() 读到的永远是 ''。降级原因只活在事件流里、落到 health()/日志快照上就丢了，
// 排查时等于没有。已修 steam-connection.cjs 的 setState()（真的带 failureClass 时才写回），
// 这条随之转成硬断言。
test('★ markDegraded 的失败分类必须出现在 health() 上，而不是只在事件里（规格 §十九）', () => {
  const { conn } = liveConn({ sockets: stubSockets() });
  conn.markDegraded('心跳超时');
  assert.equal(conn.health().failureClass, 'P2P_TRANSPORT_FAILED');
  assert.equal(conn.health().failureText, '心跳超时');
  // 恢复正常时不许把失败原因擦掉：它是"上一次为什么降级"的证据，不是当前状态。
  conn.markHealthy({});
  assert.equal(conn.health().failureClass, 'P2P_TRANSPORT_FAILED');
});

test('★ close()：CLOSING → CLOSED 终态、把句柄还给 SDK，重复调用安全（规格 §六）', () => {
  const sockets = stubSockets();
  const { conn, of } = liveConn({ sockets });
  assert.equal(conn.close(0, '本地主动关闭'), true);
  assert.equal(conn.state, STATE.CLOSED);
  assert.equal(conn.handle, null);
  assert.equal(conn.isUsable, false);
  assert.equal(conn.isConnected, false);
  assert.deepEqual(sockets.calls.closeConnection, [
    { connection: FIRST_CONNECTION, reason: 0, message: '本地主动关闭', linger: false },
  ]);
  assert.deepEqual(of('transport-state').map((e) => e.payload.to), ['CLOSING', 'CLOSED'], '必须经过 CLOSING 再到 CLOSED');

  assert.equal(conn.close(), false, '已经关了再关一次不许报成功');
  assert.equal(sockets.calls.closeConnection.length, 1, '也不许再调一次 SDK 的 closeConnection');
  assert.equal(conn.state, STATE.CLOSED);
});

test('close() 时 SDK 抛异常不崩，只留一条 transport-close-error', () => {
  const sockets = stubSockets({ closeConnection: () => { throw new Error('CLI 已经没了'); } });
  const { conn, of } = liveConn({ sockets });
  assert.equal(conn.close(), true);
  assert.equal(conn.state, STATE.CLOSED, 'SDK 关不掉也不影响我们自己的终态');
  assert.equal(of('transport-close-error').length, 1);
  assert.equal(of('transport-close-error')[0].payload.message, 'CLI 已经没了');
});

test('health() 把规格 §十九 要的字段都交出来', () => {
  const { conn } = liveConn({ sockets: stubSockets() });
  conn.queue(Buffer.from('1234'));
  const h = conn.health();
  for (const key of ['id', 'role', 'peer', 'state', 'generation', 'attempt', 'connected',
    'ageMs', 'aliveMs', 'lastRecvAgoMs', 'lastSendAgoMs', 'lastStateChangeAgoMs', 'retryInMs',
    'queuedBytes', 'maxQueuedSeen', 'backpressured', 'queueSize',
    'failureReason', 'failureText', 'failureClass', 'rtt', 'pendingReliable',
    'messagesSent', 'messagesReceived', 'bytesSent', 'bytesReceived',
    'sendFailures', 'sendStalls', 'queueHighWaterHits']) {
    assert.ok(Object.prototype.hasOwnProperty.call(h, key), `health 缺少字段 ${key}`);
  }
  assert.equal(h.id, 'primary-1');
  assert.equal(h.peer, PEER);
  assert.equal(h.state, STATE.CONNECTED);
  assert.equal(h.connected, true);
  assert.equal(h.queueSize, 1);
  assert.equal(h.queuedBytes, 4);
  assert.equal(h.rtt, null, '拿不到实时状态就给 null，不自造数字');
  conn.close();
  assert.equal(conn.health().connected, false, 'close 之后 health 必须如实反映');
  assert.equal(conn.health().state, STATE.CLOSED);
});

test('★ sendNow 优先 sendMessage(conn, data, Reliable|NoNagle)，返回 >= 0 才算成功（规格 §十四）', () => {
  const mock = createMockSdk();
  const { conn } = liveConn({ sockets: mock.sockets });
  assert.equal(conn.sendNow(Buffer.from('ping')), true);
  assert.equal(mock.state.sent.length, 1);
  assert.equal(mock.state.sent[0].via, 'sendMessage');
  assert.equal(mock.state.sent[0].connection, FIRST_CONNECTION);
  assert.equal(mock.state.sent[0].flags, SEND_FLAG.Reliable | SEND_FLAG.NoNagle);
  assert.equal(mock.state.sent[0].data.toString(), 'ping');
  assert.equal(conn.counters.messagesSent, 1);
  assert.equal(conn.counters.bytesSent, 4);

  // 数字型 EResult：0 和正数都算成功（>0 是"排上了但不保证送达"）
  for (const rc of [0, 1, 13]) {
    const c = liveConn({ sockets: stubSockets({ sendMessage: () => rc }) });
    assert.equal(c.conn.sendNow(Buffer.from('x')), true, `EResult ${rc} 算成功`);
  }
  for (const rc of [-1, -2]) {
    const c = liveConn({ sockets: stubSockets({ sendMessage: () => rc }) });
    assert.equal(c.conn.sendNow(Buffer.from('x')), false, `EResult ${rc} 是失败`);
    assert.equal(c.conn.counters.sendFailures, 1);
    assert.equal(c.conn.counters.bytesSent, 0, '没发出去就不许记字节数');
  }
});

test('★ SDK 只有 sendReliable 时退回它；两个都没有就如实说发不出去（规格 §十四）', () => {
  const sent = [];
  const sockets = { connectP2P: () => FIRST_CONNECTION, sendReliable: (connection, data) => { sent.push(Buffer.from(data)); return 0; } };
  const { conn } = liveConn({ sockets });
  assert.equal(conn.sendNow(Buffer.from('可靠发送')), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].toString(), '可靠发送');

  const none = liveConn({ sockets: {} });
  assert.equal(none.conn.sendNow(Buffer.from('x')), false);
  assert.equal(none.conn.counters.sendFailures, 1);
  assert.equal(none.conn.counters.bytesSent, 0);
});

test('★ sendMessage 报失败必须如实返回 false，不许偷偷改走 sendReliable 谎报成功', () => {
  const reliable = [];
  const sockets = {
    connectP2P: () => FIRST_CONNECTION,
    sendMessage: () => -1,
    sendReliable: (connection, data) => { reliable.push(Buffer.from(data)); return 0; },
  };
  const { conn } = liveConn({ sockets });
  assert.equal(conn.sendNow(Buffer.from('x')), false);
  assert.equal(reliable.length, 0, '失败就是失败 —— 不能让上层以为发出去了');
  assert.equal(conn.counters.sendFailures, 1);
  assert.equal(conn.counters.messagesSent, 0);
});

test('★ 发送接口抛异常不崩：如实返回 false 并记 sendFailures，数据留在队列里', () => {
  const sockets = { connectP2P: () => FIRST_CONNECTION, sendMessage: () => { throw new Error('CLI 崩了'); } };
  const { conn } = liveConn({ sockets });
  assert.equal(conn.sendNow(Buffer.from('x')), false);
  assert.equal(conn.counters.sendFailures, 1);

  const payload = Buffer.from('要发的数据');
  conn.queue(payload);
  assert.equal(conn.flush({ maxBytes: 1024 }), 0);
  assert.equal(conn.queuedBytes, payload.length, '抛异常时数据必须留在队列里');
  assert.equal(conn.counters.sendFailures, 2);
  assert.equal(conn.counters.bytesSent, 0);
});

test('★ flush 按 maxChunk 分片、一次最多发 maxBytes，剩下的留在队列里（规格 §十四）', () => {
  const slices = [];
  const sockets = { connectP2P: () => FIRST_CONNECTION, sendMessage: (c, data) => { slices.push(Buffer.from(data)); return 1; } };
  const { conn } = liveConn({ sockets });
  const payload = Buffer.alloc(10000, 7);

  assert.equal(conn.queue(payload), 10000);
  assert.equal(conn.flush({ maxBytes: 256 * 1024 }), 10000);
  assert.deepEqual(slices.map((s) => s.length), [4096, 4096, 1808], '每一片都不许超过 maxChunk');
  assert.equal(Buffer.concat(slices).equals(payload), true, '分片拼回来必须一个字节都不差');
  assert.equal(conn.queuedBytes, 0);
  assert.equal(conn.counters.messagesSent, 3);
  assert.equal(conn.counters.bytesSent, 10000);

  // 预算只有 5000 字节：发满就停，剩下的原样留着
  slices.length = 0;
  conn.queue(payload);
  assert.equal(conn.flush({ maxBytes: 5000 }), 5000);
  assert.deepEqual(slices.map((s) => s.length), [4096, 904]);
  assert.equal(conn.queuedBytes, 5000);
  assert.equal(conn.health().queueSize, 1, '没发完的那一坨还在队列头上');
  assert.equal(conn.flush({ maxBytes: 5000 }), 5000, '下一轮接着发，不重不漏');
  assert.equal(conn.queuedBytes, 0);
  assert.equal(Buffer.concat(slices).equals(payload), true, '两轮 flush 发完的就是那一整坨，顺序不许乱');
});

test('★ flush 发送失败时数据必须留在队列里，一个字节都不许丢（规格 §十三 / §十四）', () => {
  let ok = false;
  const slices = [];
  const sockets = { connectP2P: () => FIRST_CONNECTION, sendMessage: (c, data) => { if (!ok) return -1; slices.push(Buffer.from(data)); return 1; } };
  const { conn, of } = liveConn({ sockets });
  const payload = Buffer.alloc(9000, 3);
  conn.queue(payload);

  assert.equal(conn.flush({ maxBytes: 1024 * 1024 }), 0);
  assert.equal(conn.queuedBytes, 9000, '发不出去就原样待在队列里');
  assert.equal(conn.health().queueSize, 1);
  assert.equal(conn.counters.sendFailures, 1);
  assert.equal(conn.counters.bytesSent, 0, '失败的那一片不算已发送');
  assert.equal(of('transport-send-failed').length, 1);

  ok = true;
  assert.equal(conn.flush({ maxBytes: 1024 * 1024 }), 9000, '能发了就一个字节不少地补出去');
  assert.equal(Buffer.concat(slices).equals(payload), true);
  assert.equal(conn.queuedBytes, 0);
});

test('flush：连接不可用时返回 0 且不碰队列，连上之后旧数据必须补发（规格 §十六）', () => {
  const sockets = stubSockets();
  const { conn } = makeConn({ sockets });
  const payload = Buffer.from('等连接');
  conn.queue(payload);
  assert.equal(conn.isUsable, false);
  assert.equal(conn.flush({ maxBytes: 1024 }), 0);
  assert.equal(conn.queuedBytes, payload.length);
  assert.equal(sockets.calls.sendMessage.length, 0);

  conn.open();
  conn.onSteamStateChange({ newState: STEAM_STATE.Connected });
  assert.equal(conn.flush({ maxBytes: 1024 }), payload.length, '连上之后队列里的旧数据要补发');
  assert.equal(conn.queuedBytes, 0);
});

test('★ 出站队列水位：过 1 MiB 报背压，降到 128 KiB 以下恢复（规格 §十三）', () => {
  const { conn, of } = liveConn({ sockets: stubSockets() });
  conn.queue(Buffer.alloc(OUT_HIGH_WATER + 1));
  assert.equal(conn.health().backpressured, true);
  assert.equal(conn.counters.queueHighWaterHits, 1);
  assert.equal(conn.health().maxQueuedSeen, OUT_HIGH_WATER + 1);
  assert.equal(of('transport-queue-high').length, 1);
  assert.equal(of('transport-queue-high')[0].payload.water, OUT_HIGH_WATER);

  assert.equal(conn.flush({ maxBytes: OUT_HIGH_WATER + 1 }), OUT_HIGH_WATER + 1, '一次把队列灌进 Steam');
  assert.equal(conn.queuedBytes, 0);
  assert.equal(conn.health().backpressured, false, '降到 low water 以下就要解除背压，不然会话会被永久暂停');
  assert.equal(of('transport-queue-low').length, 1);
});

test('queue：超过 8 MiB 硬上限就拒收并记 sendStalls —— 内存不许无限涨（规格 §十三 / §三十四-⑦）', () => {
  const { conn } = liveConn({ sockets: stubSockets() });
  assert.equal(conn.queue(Buffer.alloc(OUT_MAX_WATER)), OUT_MAX_WATER, '刚好到顶还能收');
  assert.equal(conn.queue(Buffer.from([1])), 0, '到顶了就一个字节都不收');
  assert.equal(conn.counters.sendStalls, 1);
  assert.equal(conn.queuedBytes, OUT_MAX_WATER);
  assert.equal(conn.health().queueSize, 1);
  assert.equal(conn.queue(Buffer.alloc(0)), 0, '空数据不入队');
  assert.equal(conn.counters.sendStalls, 1, '空数据不算 stall');
});

test('refreshStatus：优先用 Steam 的实时状态，SDK 没有这个接口就返回上次快照且不崩（规格 §十九）', () => {
  const noRt = liveConn({ sockets: stubSockets() });
  assert.equal(noRt.conn.refreshStatus(), null, 'SDK 不给实时状态就如实返回 null，不自造数字');
  assert.equal(noRt.conn.health().rtt, null);

  const sockets = stubSockets({
    getConnectionRealTimeStatus: () => ({
      ping: 42, connectionQualityLocal: 0.9, connectionQualityRemote: 0.8,
      outBytesPerSec: 1000, inBytesPerSec: 2000, sendRateBytesPerSecond: 3000,
      pendingReliable: 7, sentUnackedReliable: 5, usecQueueTime: 2500,
    }),
  });
  const { conn } = liveConn({ sockets });
  const rt = conn.refreshStatus();
  assert.equal(rt.ping, 42);
  assert.equal(rt.usecQueueTimeMs, 3, 'usecQueueTime 要换成毫秒');
  assert.equal(conn.health().rtt, 42);
  assert.equal(conn.health().pendingReliable, 7);

  const boom = liveConn({ sockets: stubSockets({ getConnectionRealTimeStatus: () => { throw new Error('句柄过期'); } }) });
  assert.equal(boom.conn.refreshStatus(), null, '抛异常时返回上次快照（这里是 null），不许崩');
  assert.equal(boom.of('transport-status-error').length, 1);
});

test('onEvent 抛异常不能带倒网络层：该做的事照样做完（规格 §二十六 日志不许反噬链路）', () => {
  const conn = createSteamConnection({
    id: 'x', peerSteamId: PEER, sockets: stubSockets(), now: () => clock,
    onEvent: () => { throw new Error('日志回调炸了'); },
  });
  assert.equal(conn.open().ok, true);
  assert.equal(conn.state, STATE.CONNECTING);
  conn.onSteamStateChange({ newState: STEAM_STATE.Connected });
  assert.equal(conn.state, STATE.CONNECTED);
  assert.equal(conn.close(), true);
  assert.equal(conn.state, STATE.CLOSED);
});

test('generation / bumpGeneration：重连一次 +1，用来挡旧连接上的迟到帧（规格 §十九 / §十七）', () => {
  const { conn, of } = liveConn({ sockets: stubSockets() });
  assert.equal(conn.generation, 1);
  assert.equal(conn.bumpGeneration(), 2);
  conn.markDegraded('重连前先降级');
  assert.equal(of('transport-state').pop().payload.generation, 2, '之后的事件都要带新世代');
  assert.equal(conn.bumpGeneration(), 3);
});

test('adopt：房主侧收编入站连接 —— 直接进 CONNECTED，并记下远端身份（规格 §六）', () => {
  const { conn, of } = makeConn({ sockets: stubSockets() });
  assert.equal(conn.role, 'primary');
  conn.adopt(202, { inbound: true, info: { identityRemote: PEER } });
  assert.equal(conn.state, STATE.CONNECTED);
  assert.equal(conn.handle, 202, '收编的必须是 SDK 给的那个句柄');
  const ev = of('transport-state').pop();
  assert.equal(ev.payload.to, STATE.CONNECTED);
  assert.equal(ev.payload.remote, PEER);
});

test('noteReceived / notePong：收包与心跳记账都落到时间戳上（规格 §十八 / §十九）', () => {
  const { conn } = liveConn({ sockets: stubSockets() });
  clock += 700;
  assert.equal(conn.noteReceived(1234), clock);
  assert.equal(conn.counters.messagesReceived, 1);
  assert.equal(conn.counters.bytesReceived, 1234);
  assert.equal(conn.health().lastRecvAgoMs, 0);
  clock += 300;
  assert.equal(conn.notePong(), clock);
  assert.equal(conn.lastPongAt, clock);
  assert.equal(conn.health().lastRecvAgoMs, 300);
});
