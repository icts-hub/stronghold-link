'use strict';
// Phase 7（规格 §三十 / §三十一）：网络健康读数。
//
// 这一层是**给界面和日志看的**，所以最要紧的不是它报得漂亮，而是它**不报假的**：
//   · 读不到的字段必须是 null（界面显示"—"），不许填个 0 冒充读数；
//   · SDK 缺 getRelayNetworkStatus 时不许假装"Relay 可用"；
//   · 状态与文案由监视器一处给出，界面不重新判断一遍 —— 否则"连接中"这种模糊词
//     就会从界面那边偷偷长回来。
//
// 诚实声明：本机没有真实 Steamworks SDK，用的是注入的假 SDK。这里验证的是
// "适配器把现场读数如实喂给监视器、并且不编造它拿不到的东西"。
const test = require('node:test');
const assert = require('node:assert/strict');

const { createSteamJoiner } = require('../network/steam-adapter.cjs');
const { createMockSdk, HOST_STEAM_ID, STATE } = require('./steam-mock.cjs');
const { LINK_STATE, LINK_STATE_LABEL, CONN_STATE_LABEL } = require('../network/network-health.cjs');
const mux = require('../network/stream-mux.cjs');
const h = require('./helpers.cjs');

/** 池子会自己在后台建连接，会让"一共几条 Steam 连接"的断言失准 —— 一律关掉。 */
const joinJoiner = (options = {}) => createSteamJoiner({ poolTarget: 0, ...options });

/** 把假房主接起来：加入者先发魔数，房主用魔数应答（0.14.0 的握手方向）。 */
const connectTrunk = async (mock, joiner) => {
  assert.ok(
    await h.waitFor(() => mock.state.connectedTo.length >= 1, { timeoutMs: 3000 }),
    '加入者应主动建一条 Steam 干道',
  );
  const handle = mock.state.connectedTo[0].handle;
  mock.state.emitState({ connection: handle, newState: STATE.Connected, info: { identityRemote: HOST_STEAM_ID } });
  mock.state.pushToClient(handle, mux.encodeHello());
  assert.ok(
    await h.waitFor(() => (joiner.stats.muxPeers || 0) >= 1, { timeoutMs: 3000 }),
    '房主应答魔数之后应进入多路复用',
  );
  return handle;
};

test('★ Phase 7：netState() 一处给全状态与文案 —— 3 条本机连接仍然只报 1 条 Steam 连接，RTT 读不到就报 null', async () => {
  const mock = createMockSdk();
  const localPort = await h.freePort();
  const joiner = joinJoiner({ localPort, hostSteamId: HOST_STEAM_ID, sdk: mock.sdk });
  const clients = [];
  try {
    await joiner.ready;
    assert.equal(typeof joiner.netState, 'function', '加入者必须把 netState() 挂出来，界面才有一处可读');

    // ① 一条业务连接都还没有的时候：不许凭空报"已接通"。
    const cold = joiner.netState();
    assert.equal(cold.activeSteamConnections, 0, '还没建干道时不能报有活的 Steam 连接');
    assert.equal(cold.activeStreams, 0, '还没有本机连接时不能报有流');
    assert.equal(cold.stateLabel, LINK_STATE_LABEL[cold.state], '文案必须来自监视器，界面不许自己拼');

    await connectTrunk(mock, joiner);
    for (let i = 0; i < 3; i += 1) clients.push(await h.connect(localPort));
    assert.ok(await h.waitFor(() => joiner.netState().activeStreams === 3, { timeoutMs: 3000 }),
      '三条本机连接应各自成为干道上的一条流');

    const s = joiner.netState();
    // ② 核心：规格 §三十七 —— Steam 连接数与业务连接数无关。
    assert.equal(s.activeSteamConnections, 1, `3 条本机连接只允许有 1 条 Steam 连接，实际 ${s.activeSteamConnections}`);
    assert.equal(s.activeStreams, 3, `应报 3 条流，实际 ${s.activeStreams}`);
    assert.equal(s.state, LINK_STATE.P2P_CONNECTED, `干道连上了就该报 P2P_CONNECTED，实际 ${s.state}`);
    assert.equal(s.stateLabel, LINK_STATE_LABEL[LINK_STATE.P2P_CONNECTED], '状态文案应与枚举一一对应');

    // ③ 适配器不测 RTT：宁可报 null（界面显示"—"），也不许编一个数。
    assert.equal(s.avgRTT, null, '适配器测不到 RTT 时必须报 null，不许编造');
    // ④ Backup 是 0~1 条、不强制存在（规格 §三）：没有就如实报空文案。
    assert.equal(s.backupState, null, '没有 Backup 时不该报一个假状态');
    assert.equal(s.backupLabel, '', '没有 Backup 时文案应为空，界面才知道要显示"无"');

    // ⑤ 文案是人话，不是枚举名 —— 界面直接显示，不需要再翻译一遍。
    assert.equal(s.primaryLabel, CONN_STATE_LABEL.CONNECTED);
    assert.ok(s.primaryLabel && !/^[A-Z_]+$/.test(s.primaryLabel), `主连接文案应是中文，实际 ${s.primaryLabel}`);

    // ⑥ 峰值与累计都记着：事后复盘要知道"这一局最多同时开了几条"。
    assert.equal(s.maxActiveSteamConnections, 1, '峰值应为 1（规格 §三十八-F：不许涨到和业务连接数一样多）');
    assert.ok(s.steamConnectionsCreated >= 1, '应记下建过几条 Steam 连接');
    assert.ok(s.streamsOpened >= 3, `应记下开过至少 3 条流，实际 ${s.streamsOpened}`);
  } finally {
    for (const c of clients) c.destroy();
    await joiner.stop();
  }
});

test('★ Phase 7：SDK 读不到 Relay 状态时不许假装可用 —— 但已经在跑的连接不受影响（规格 §八）', async () => {
  const mock = createMockSdk();
  // 假 SDK 的 networkingUtils 只有 initRelayNetworkAccess，没有 getRelayNetworkStatus。
  // 这正是"binding 不完整"的真实处境，监视器必须如实说"读不到"，而不是默认"可用"。
  assert.equal(typeof mock.sdk.networkingUtils.getRelayNetworkStatus, 'undefined',
    '本用例的前提就是 SDK 读不到 Relay 状态；假 SDK 哪天补上了这个接口，这条断言会先红，提醒改写');

  const localPort = await h.freePort();
  const joiner = joinJoiner({ localPort, hostSteamId: HOST_STEAM_ID, sdk: mock.sdk });
  try {
    await joiner.ready;
    await connectTrunk(mock, joiner);

    const s = joiner.netState();
    assert.equal(s.relayReady, false, '读不到 Relay 状态时绝不许报"可用"');
    assert.equal(s.relayEverReady, false, '一次都没读到过就别说"曾经可用"');
    // 规格 §八 / §三十四-③：Relay 状态读不到不该影响已经在跑的 Steam P2P 连接。
    assert.equal(s.state, LINK_STATE.P2P_CONNECTED, 'Relay 读数缺失不能把已连通的 P2P 报成断线');
    assert.equal(s.activeSteamConnections, 1, 'Relay 读数缺失不该影响连接数');
  } finally {
    await joiner.stop();
  }
});

test('★ Phase 7：net-status 事件带着 [Steam]/[P2P]/[MUX] 三行交给日志（规格 §三十）', async () => {
  const mock = createMockSdk();
  const localPort = await h.freePort();
  const events = [];
  const joiner = joinJoiner({
    localPort, hostSteamId: HOST_STEAM_ID, sdk: mock.sdk,
    // 真实的 30 秒不适合放进测试；周期本身可配，行为完全一样。
    netLogIntervalMs: 40,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  const clients = [];
  try {
    await joiner.ready;
    await connectTrunk(mock, joiner);
    clients.push(await h.connect(localPort));

    const seen = await h.waitFor(
      () => events.some((e) => e.type === 'net-status' && e.payload.lines.length >= 3),
      { timeoutMs: 3000 },
    );
    assert.ok(seen, '应周期性地抛出 net-status，否则 startup.log 里没有网络状态的时间线');

    const lines = events.filter((e) => e.type === 'net-status').pop().payload.lines;
    for (const prefix of ['[Steam]', '[P2P]', '[MUX]']) {
      assert.ok(lines.some((l) => l.startsWith(prefix)), `net-status 必须带 ${prefix} 那一行，实际：${lines.join(' / ')}`);
    }
    const p2p = lines.find((l) => l.startsWith('[P2P]'));
    assert.ok(p2p.includes('connected'), `[P2P] 行要能看出连接状态，实际：${p2p}`);
    const muxLine = lines.find((l) => l.startsWith('[MUX]'));
    assert.ok(/streams=1\b/.test(muxLine), `[MUX] 行要报出流数，实际：${muxLine}`);
    const steam = lines.find((l) => l.startsWith('[Steam]'));
    assert.ok(steam.includes('login=') && steam.includes('relay=') && steam.includes('transport='),
      `[Steam] 行要同时给出 login / relay / transport，实际：${steam}`);
    const last = events.filter((e) => e.type === 'net-status').pop();
    assert.ok(typeof last.payload.summary === 'string' && last.payload.summary.length > 0,
      'net-status 还应带一句汇总，扫日志时一眼能看出这一局怎么样');
  } finally {
    for (const c of clients) c.destroy();
    await joiner.stop();
  }
});

test('★ Phase 7：会话停止后唯一的调度器不再留一个计时器（规格 §十八 / §三十八-H）', async () => {
  const mock = createMockSdk();
  const localPort = await h.freePort();
  const joiner = joinJoiner({
    localPort, hostSteamId: HOST_STEAM_ID, sdk: mock.sdk,
    netLogIntervalMs: 20, netPollIntervalMs: 20,
  });
  try {
    await joiner.ready;
    await connectTrunk(mock, joiner);
    assert.ok(await h.waitFor(() => joiner.netState().samples >= 1, { timeoutMs: 3000 }),
      '健康采样应已经在跑，否则这条用例证明不了"停得掉"');

    await joiner.stop();
    const afterStop = joiner.netState();
    assert.equal(afterStop.state, LINK_STATE.SESSION_CLOSED, '会话停掉之后应报 SESSION_CLOSED，不许再报成别的');

    // 采样数如果还在涨，就说明调度器还活着 —— 那正是"长期运行计时器只增不减"的病根。
    await h.wait(200);
    assert.equal(joiner.netState().samples, afterStop.samples,
      '停止之后采样不许再增长：调度器必须真的停了');
  } finally {
    await joiner.stop();
  }
});
