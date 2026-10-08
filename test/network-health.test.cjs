'use strict';
// NetworkHealth 单测（规格 §十九 / §三十 / §三十一）。这个模块是"人看的网络状态"的唯一出处，
// 所以测试盯三件事：
//   1. snapshot() 真的把 §三十 点名的统计都收齐了（漏字段 = 日志里少一列，事后查不出来）；
//   2. linkState() 能把规格 §三十一 要求区分的状态两两分开（"连接中"这种模糊说法不算数）；
//   3. avgRTT() 的窗口与取数规则（窗口滑掉老样本，否则一次卡顿会永远拉高平均值）。
// manager / session / relay 一律用假对象，只实现本模块真正调用的那几个方法/字段。

const test = require('node:test');
const assert = require('node:assert/strict');

const H = require('../network/network-health.cjs');
const { STATE: CONN_STATE } = require('../network/steam-connection.cjs');
const { SESSION_STATE } = require('../network/mux-session.cjs');
const { AVAILABILITY } = require('../network/relay-status.cjs');

const { LINK_STATE, LINK_STATE_LABEL } = H;

function fakeClock(start = 5_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms) { t += ms; return t; },
  };
}

/** 一条分条连接（steam-connection 的对外形状）。 */
function fakeConn(slot, state, rtt = null) {
  return {
    slot,
    state,
    rtt,
    peer: `peer-${slot}`,
    ageMs: 1234,
    attempt: 2,
    failureText: '',
    retryInMs: 0,
    failureClass: '',
  };
}

/** 假 SteamConnectionManager：health() 报 §三十 里"Steam 连接"那一组的数。 */
function fakeManager() {
  const m = {
    steamConnectionsCreated: 11,
    steamConnectionsSucceeded: 7,
    steamConnectionsFailed: 4,
    steamConnectionsClosed: 6,
    activeSteamConnections: 1,
    maxActiveSteamConnections: 2,
    failStreak: 1,
    lastFailure: 'TimeoutInitial',
    primary: fakeConn('primary', CONN_STATE.CONNECTED, 30),
    backup: fakeConn('backup', CONN_STATE.DISCONNECTED, null),
    health() {
      return {
        steamConnectionsCreated: m.steamConnectionsCreated,
        steamConnectionsSucceeded: m.steamConnectionsSucceeded,
        steamConnectionsFailed: m.steamConnectionsFailed,
        steamConnectionsClosed: m.steamConnectionsClosed,
        activeSteamConnections: m.activeSteamConnections,
        maxActiveSteamConnections: m.maxActiveSteamConnections,
        failStreak: m.failStreak,
        lastFailure: m.lastFailure,
        primary: m.primary,
        backup: m.backup,
      };
    },
  };
  return m;
}

/** 假 MuxSession：health() 报 §三十 里"流"那一组的数。 */
function fakeSession(state = SESSION_STATE.ACTIVE) {
  const s = {
    state,
    activeStreams: 3,
    streamsOpened: 9,
    streamsClosed: 6,
    streamsReset: 1,
    staleFrames: 2,
    droppedFrames: 1,
    queuedBytes: 4096,
    globalPaused: false,
    pausedStreams: 0,
    framesSent: 100,
    framesReceived: 90,
    bytesToLocal: 111,
    bytesToRemote: 222,
    health() {
      return {
        state: s.state,
        activeStreams: s.activeStreams,
        streamsOpened: s.streamsOpened,
        streamsClosed: s.streamsClosed,
        streamsReset: s.streamsReset,
        staleFrames: s.staleFrames,
        droppedFrames: s.droppedFrames,
        queuedBytes: s.queuedBytes,
        globalPaused: s.globalPaused,
        pausedStreams: s.pausedStreams,
        framesSent: s.framesSent,
        framesReceived: s.framesReceived,
        bytesToLocal: s.bytesToLocal,
        bytesToRemote: s.bytesToRemote,
      };
    },
  };
  return s;
}

/** 假 RelayStatusMonitor：本模块只调 isReady() / isUnavailable() / everReady / stats()。 */
function fakeRelay(spec = {}) {
  const r = {
    ready: false,
    unavailable: false,
    everReady: false,
    availability: AVAILABILITY.Unknown,
    lastRelayStatus: '',
    isReady() { return r.ready; },
    isUnavailable() { return r.unavailable; },
    stats() {
      return {
        availability: r.availability,
        ready: r.ready,
        everReady: r.everReady,
        lastRelayStatus: r.lastRelayStatus,
      };
    },
  };
  return Object.assign(r, spec);
}

const relayUp = () => fakeRelay({ ready: true, availability: AVAILABILITY.Current, lastRelayStatus: 'Current（已连上中继网络）' });
const relayDown = () => fakeRelay({ unavailable: true, availability: AVAILABILITY.Failed, lastRelayStatus: 'Failed（连不上 Steam 中继网络）' });

test('LINK_STATE / LINK_STATE_LABEL：十个状态都在，标签都是中文人话', () => {
  const states = Object.values(LINK_STATE);
  assert.equal(states.length, 10, '规格 §三十一 点名的状态一个都不能少');
  assert.equal(new Set(states).size, 10);
  for (const s of states) {
    // 状态机内部用英文枚举没问题，但给人看的那份必须是中文
    assert.equal(typeof LINK_STATE_LABEL[s], 'string');
    assert.ok(LINK_STATE_LABEL[s].length > 0);
    assert.ok(!LINK_STATE_LABEL[s].includes('_'), `${s} 的标签不该是英文枚举名`);
  }
  assert.equal(LINK_STATE_LABEL[LINK_STATE.P2P_CONNECTED], 'P2P 已接通');
  assert.equal(LINK_STATE_LABEL[LINK_STATE.RELAY_UNAVAILABLE], '中继网络不可用');
  assert.equal(LINK_STATE_LABEL[LINK_STATE.SESSION_RECOVERING], '会话恢复中');
  assert.equal(H.RTT_WINDOW, 20, 'RTT 滑动窗口大小是实现约定，测试里也要钉住');
});

test('没有任何数据源时 snapshot() 也能给出完整一份（不抛、不 undefined）', () => {
  const clock = fakeClock();
  const monitor = H.createNetworkHealthMonitor({ now: clock.now });
  const s = monitor.snapshot();

  assert.equal(s.at, 5000);
  assert.equal(s.uptimeMs, 0);
  assert.equal(s.samples, 0);
  assert.equal(s.steamLoggedOn, true, '默认按"已登录"起步（我们没被告知未登录）');
  assert.equal(s.transportReady, true);
  for (const key of ['steamConnectionsCreated', 'activeSteamConnections', 'activeStreams', 'queuedBytes', 'maxQueuedBytes', 'pausedStreams', 'failStreak', 'framesSent', 'bytesToRemote']) {
    assert.equal(s[key], 0, `${key} 缺失时要是 0 而不是 undefined`);
  }
  assert.equal(s.sessionState, SESSION_STATE.IDLE, '没有 session 就报 IDLE，别报 undefined');
  assert.equal(s.primaryState, CONN_STATE.DISCONNECTED);
  assert.equal(s.backupState, null);
  assert.equal(s.avgRTT, null, '没有样本时是 null（"还没测到"和"0ms"是两回事）');
  assert.equal(s.relayAvailability, null);
  assert.equal(s.relayReady, false);
  assert.equal(s.globalPaused, false);
  assert.equal(s.lastFailure, null);

  clock.advance(2500);
  assert.equal(monitor.snapshot().uptimeMs, 2500, 'uptimeMs 走注入的假时钟');
  assert.equal(monitor.statusText(), LINK_STATE_LABEL[LINK_STATE.STEAM_ONLINE], '什么都不知道时报"Steam 在线"，不是"连接中"');
});

test('snapshot() 把 §三十 点名的统计收齐（字段清单逐个钉住）', () => {
  const monitor = H.createNetworkHealthMonitor({
    manager: fakeManager(),
    session: fakeSession(),
    relay: relayUp(),
  });
  const s = monitor.snapshot();

  const required = [
    'at', 'uptimeMs', 'samples', 'steamLoggedOn', 'transportReady',
    'steamConnectionsCreated', 'steamConnectionsSucceeded', 'steamConnectionsFailed', 'steamConnectionsClosed',
    'activeSteamConnections', 'maxActiveSteamConnections',
    'activeStreams', 'peakStreams', 'streamsOpened', 'streamsClosed', 'streamsReset',
    'staleFrames', 'droppedFrames', 'queuedBytes', 'maxQueuedBytes', 'globalPaused', 'pausedStreams',
    'avgRTT', 'lastRelayStatus', 'relayAvailability', 'relayReady', 'relayEverReady',
    'failStreak', 'lastFailure', 'sessionState', 'primaryState', 'backupState',
    'framesSent', 'framesReceived', 'bytesToLocal', 'bytesToRemote',
  ];
  for (const key of required) {
    assert.ok(Object.prototype.hasOwnProperty.call(s, key), `§三十 要的统计缺了 ${key}`);
  }

  // 值映射：manager / session / relay 报什么，快照里就该是什么
  assert.equal(s.steamConnectionsCreated, 11);
  assert.equal(s.steamConnectionsSucceeded, 7);
  assert.equal(s.steamConnectionsFailed, 4);
  assert.equal(s.steamConnectionsClosed, 6);
  assert.equal(s.activeSteamConnections, 1);
  assert.equal(s.maxActiveSteamConnections, 2);
  assert.equal(s.failStreak, 1);
  assert.equal(s.lastFailure, 'TimeoutInitial');
  assert.equal(s.primaryState, CONN_STATE.CONNECTED);
  assert.equal(s.backupState, CONN_STATE.DISCONNECTED);
  assert.equal(s.sessionState, SESSION_STATE.ACTIVE);
  assert.equal(s.activeStreams, 3);
  assert.equal(s.streamsOpened, 9);
  assert.equal(s.streamsClosed, 6);
  assert.equal(s.streamsReset, 1);
  assert.equal(s.staleFrames, 2);
  assert.equal(s.droppedFrames, 1);
  assert.equal(s.queuedBytes, 4096);
  assert.equal(s.globalPaused, false);
  assert.equal(s.pausedStreams, 0);
  assert.equal(s.framesSent, 100);
  assert.equal(s.framesReceived, 90);
  assert.equal(s.bytesToLocal, 111);
  assert.equal(s.bytesToRemote, 222);
  assert.equal(s.lastRelayStatus, 'Current（已连上中继网络）');
  assert.equal(s.relayAvailability, AVAILABILITY.Current);
  assert.equal(s.relayReady, true);
  assert.equal(s.relayEverReady, false);
});

test('sample() 累积峰值：maxQueuedBytes / peakStreams / maxActiveSteamConnections 只涨不跌', () => {
  const clock = fakeClock(1_000);
  const manager = fakeManager();
  const session = fakeSession();
  const monitor = H.createNetworkHealthMonitor({ now: clock.now, manager, session, relay: relayUp() });

  session.queuedBytes = 10_000;
  session.activeStreams = 3;
  manager.activeSteamConnections = 1;
  clock.advance(100);
  let s = monitor.sample();
  assert.equal(s.samples, 1);
  assert.equal(s.at, 1100, 'at 记的是最近一次采样的时刻');

  session.queuedBytes = 90_000;
  session.activeStreams = 7;
  manager.activeSteamConnections = 2;
  clock.advance(100);
  s = monitor.sample();
  assert.equal(s.samples, 2);
  assert.equal(s.queuedBytes, 90_000);
  assert.equal(s.maxQueuedBytes, 90_000);
  assert.equal(s.peakStreams, 7, '峰值是"历史最高同时在线流数"，规格 §三十 要用它定位连接泄漏');

  // 回落：当前值降下去，峰值必须留住
  session.queuedBytes = 0;
  session.activeStreams = 1;
  manager.activeSteamConnections = 0;
  clock.advance(100);
  s = monitor.sample();
  assert.equal(s.samples, 3);
  assert.equal(s.queuedBytes, 0);
  assert.equal(s.maxQueuedBytes, 90_000, '峰值不能被"现在好转了"抹掉');
  assert.equal(s.peakStreams, 7);
  assert.equal(s.maxActiveSteamConnections, 2, 'manager 报的峰值优先');
  assert.equal(s.uptimeMs, 300);

  // 没有 manager 时 maxActiveSteamConnections 回退到我们自己采到的峰值
  const solo = H.createNetworkHealthMonitor({ session: fakeSession() });
  solo.sample();
  assert.equal(solo.snapshot().maxActiveSteamConnections, 0);
});

test('avgRTT()：无样本是 null、有样本取平均、30 个样本后只剩最后 20 个', () => {
  const manager = fakeManager();
  const monitor = H.createNetworkHealthMonitor({ manager });
  assert.equal(monitor.snapshot().avgRTT, null);

  manager.primary.rtt = 30;
  monitor.sample();
  assert.equal(monitor.snapshot().avgRTT, 30);

  manager.primary.rtt = 50;
  monitor.sample();
  assert.equal(monitor.snapshot().avgRTT, 40, '两个样本 (30+50)/2');
});

test('avgRTT() 窗口行为：30 个样本后只剩最后 20 个', () => {
  const manager = fakeManager();
  const monitor = H.createNetworkHealthMonitor({ manager });
  for (let i = 1; i <= 30; i++) {
    manager.primary.rtt = i;
    monitor.sample();
  }
  // 若窗口失效会得到全部 30 个的均值 16；窗口正确则是 11..30 的 20.5 → 21
  assert.equal(monitor.snapshot().avgRTT, 21, 'RTT_WINDOW=20：老样本必须滑出去，否则一次卡顿会永远拉高均值');
});

test('avgRTT() 取数规则：非正/非有限值不算样本，primary 没有就用 backup', () => {
  const manager = fakeManager();
  const monitor = H.createNetworkHealthMonitor({ manager });

  for (const bad of [0, -5, NaN, Infinity, 'not-a-number', null, undefined]) {
    manager.primary.rtt = bad;
    monitor.sample();
  }
  assert.equal(monitor.snapshot().avgRTT, null, '垃圾样本一个都不能进窗口（NaN 混进去均值就永远是 NaN）');

  manager.primary.rtt = null;
  manager.backup.rtt = 40;
  monitor.sample();
  assert.equal(monitor.snapshot().avgRTT, 40, '主连接还没 rtt 时用备连接的，别让 RTT 一直空着');

  manager.primary.rtt = 20;
  manager.backup.rtt = 200;
  monitor.sample();
  assert.equal(monitor.snapshot().avgRTT, 30, 'primary 有 rtt 就优先用它，备连接的高延迟不能拉偏主路径');
});

test('linkState()：规格 §三十一 的十个状态都能区分出来', () => {
  const build = (spec = {}) => H.createNetworkHealthMonitor({
    manager: spec.manager || fakeManager(),
    session: spec.session === null ? null : (spec.session || fakeSession()),
    relay: spec.relay || relayUp(),
    steamLoggedOn: spec.steamLoggedOn,
    transportReady: spec.transportReady,
  });

  assert.equal(build({ session: fakeSession(SESSION_STATE.CLOSED) }).linkState(), LINK_STATE.SESSION_CLOSED);
  assert.equal(build({ steamLoggedOn: false }).linkState(), LINK_STATE.STEAM_OFFLINE);
  assert.equal(build({ session: fakeSession(SESSION_STATE.RECOVERING) }).linkState(), LINK_STATE.SESSION_RECOVERING);
  assert.equal(build({ session: fakeSession(SESSION_STATE.DEGRADED) }).linkState(), LINK_STATE.RECONNECTING);

  const manager = fakeManager();
  manager.primary.state = CONN_STATE.BACKOFF;
  assert.equal(build({ manager }).linkState(), LINK_STATE.RECONNECTING, 'primary 退避中 = 正在重连');

  manager.primary.state = CONN_STATE.CONNECTED;
  assert.equal(build({ manager }).linkState(), LINK_STATE.P2P_CONNECTED, 'primary 接通就是 P2P 已接通');

  manager.primary.state = CONN_STATE.DEGRADED;
  assert.equal(build({ manager }).linkState(), LINK_STATE.P2P_DEGRADED);
  manager.primary.state = CONN_STATE.CONNECTED;

  // relay 那两个状态只在"没有正在跑的 P2P"时才轮得到（primary CONNECTED 会先把它盖住）
  const idleManager = fakeManager();
  idleManager.primary.state = CONN_STATE.DISCONNECTED;
  assert.equal(build({ manager: idleManager, relay: relayDown() }).linkState(), LINK_STATE.RELAY_UNAVAILABLE, '从没就绪过 + 明确不可用 ⇒ 中继不可用');
  assert.equal(build({ manager: idleManager, relay: relayUp() }).linkState(), LINK_STATE.RELAY_AVAILABLE);

  const connecting = fakeManager();
  for (const st of [CONN_STATE.CONNECTING, CONN_STATE.STARTING, CONN_STATE.RELAY_WAIT]) {
    connecting.primary.state = st;
    // relay 没用上（还没就绪），否则"中继可用"会先一步把状态报掉
    assert.equal(build({ manager: connecting, relay: fakeRelay() }).linkState(), LINK_STATE.P2P_CONNECTING, `${st} 都算"P2P 建连中"`);
  }

  const idle = H.createNetworkHealthMonitor({ manager: idleManager, session: fakeSession(), relay: fakeRelay() });
  idle.snapshot();
  assert.equal(idle.linkState(), LINK_STATE.STEAM_ONLINE, '登录着、没人连、relay 也没就绪 ⇒ 就是"Steam 在线"，不能含糊成"连接中"');
  assert.equal(idle.statusText(), 'Steam 在线');
});

test('linkState() 的优先级：会话结束 > Steam 未登录 > 会话恢复/降级 > 分条状态', () => {
  const manager = fakeManager();
  manager.primary.state = CONN_STATE.CONNECTED;

  // 会话已结束是最强的信号：哪怕 Steam 掉线、P2P 刚接通，也该报"会话已结束"
  const closed = H.createNetworkHealthMonitor({ manager, session: fakeSession(SESSION_STATE.CLOSED), relay: relayUp(), steamLoggedOn: false });
  assert.equal(closed.linkState(), LINK_STATE.SESSION_CLOSED, '会话 CLOSED 压过"Steam 未登录"（必须能报出会话真的没了）');

  // Steam 未登录也压过 P2P 状态：未登录时的 CONNECTED 是残影
  const offline = H.createNetworkHealthMonitor({ manager, session: fakeSession(), relay: relayUp(), steamLoggedOn: false });
  assert.equal(offline.linkState(), LINK_STATE.STEAM_OFFLINE, 'Steam 未登录压过 primary CONNECTED');

  // 会话在救（RECOVERING）比单条分条连接更重要
  const recovering = H.createNetworkHealthMonitor({ manager, session: fakeSession(SESSION_STATE.RECOVERING), relay: relayUp() });
  assert.equal(recovering.linkState(), LINK_STATE.SESSION_RECOVERING, '整条会话在恢复，比"P2P 已接通"更值得报');

  // relay 曾经就绪过 ⇒ 现在掉下去也只是暂时的，不该报 RELAY_UNAVAILABLE（那会让上层放弃重试）
  const relayManager = fakeManager();
  relayManager.primary.state = CONN_STATE.CONNECTING;
  relayManager.backup = null;
  const transient = H.createNetworkHealthMonitor({ manager: relayManager, session: fakeSession(), relay: fakeRelay({ unavailable: true, everReady: true, availability: AVAILABILITY.Failed }) });
  assert.equal(transient.linkState(), LINK_STATE.P2P_CONNECTING, 'everReady 为真时不再报"中继不可用"，否则恢复路径会被自己掐死');
});

test('statusText()：返回中文标签；logLines() 给出行级细节', () => {
  const manager = fakeManager();
  const session = fakeSession();
  const monitor = H.createNetworkHealthMonitor({ manager, session, relay: relayUp(), steamLoggedOn: true });
  assert.equal(monitor.statusText(), 'P2P 已接通');
  assert.equal(LINK_STATE_LABEL[monitor.linkState()], monitor.statusText());

  // maxQueuedBytes 是本模块自己采出来的峰值，所以要先 sample() 一次
  monitor.sample();
  const lines = monitor.logLines();
  assert.ok(Array.isArray(lines));
  const steamLine = lines.find((l) => l.startsWith('[Steam] login='));
  assert.ok(steamLine, '必须有 [Steam] login= 开头的一行');
  assert.ok(steamLine.includes('login=ONLINE'));
  assert.ok(steamLine.includes('relay=100'), 'relay 那一列要带上可用性数值/名字');
  assert.ok(steamLine.includes('transport=READY'));

  assert.ok(lines.some((l) => l === '[P2P] role=primary state=connected peer=peer-primary route=30ms relay=Current（已连上中继网络） rtt=30'),
    'primary CONNECTED 时必须有一行 state=connected 且带 peer/rtt');
  assert.ok(lines.some((l) => l.startsWith('[MUX] streams=')), '有 session 时必须有 [MUX] streams= 开头的一行');
  const muxLine = lines.find((l) => l.startsWith('[MUX] streams='));
  assert.ok(muxLine.includes('maxQueued=4096') && muxLine.includes('session=ACTIVE'));

  // 没有 session 时不产生 MUX 行（不能凭空报流数量）
  const noSession = H.createNetworkHealthMonitor({ manager, relay: relayUp() });
  assert.equal(noSession.logLines().some((l) => l.startsWith('[MUX]')), false);

  // 未登录/未就绪时第一行要如实说 OFFLINE / NOT-READY
  const offline = H.createNetworkHealthMonitor({ steamLoggedOn: false, transportReady: false });
  const offlineLine = offline.logLines()[0];
  assert.ok(offlineLine.includes('login=OFFLINE'));
  assert.ok(offlineLine.includes('relay=UNKNOWN'), '没有 relay 源时报 UNKNOWN，不能假装是 0');
  assert.ok(offlineLine.includes('transport=NOT-READY'));
});

test('logLines()：建连中 / 降级 / 失败三种分条状态各有自己的格式', () => {
  const manager = fakeManager();
  const monitor = H.createNetworkHealthMonitor({ manager, session: fakeSession(), relay: relayUp() });

  manager.primary.state = CONN_STATE.CONNECTING;
  manager.primary.rtt = null;
  let line = monitor.logLines().find((l) => l.startsWith('[P2P] role=primary'));
  assert.ok(line.includes('state=connecting'), '状态名小写、机器可读');
  assert.ok(line.includes('elapsed=1234ms') && line.includes('attempt=2'), '建连中要能看出等了多久、第几次尝试');

  manager.primary.state = CONN_STATE.DEGRADED;
  line = monitor.logLines().find((l) => l.startsWith('[P2P] role=primary'));
  assert.ok(line.includes('state=degraded'));

  manager.primary.state = CONN_STATE.BACKOFF;
  manager.primary.failureText = 'TimeoutInitial';
  manager.primary.retryInMs = 5000;
  manager.primary.failureClass = 'transient';
  line = monitor.logLines().find((l) => l.startsWith('[P2P] role=primary'));
  assert.ok(line.includes('state=failed'), 'BACKOFF 对外说"失败"更直白');
  assert.ok(line.includes('reason=TimeoutInitial') && line.includes('retryIn=5000ms') && line.includes('class=transient'),
    '失败原因/重试间隔/分类都要带上 —— 排障时全靠这一行');

  // 没数据的分条（backup 是 DISCONNECTED）不该出现在日志里
  assert.equal(monitor.logLines().filter((l) => l.includes('role=backup')).length, 0);
});

test('summaryLine()：一行能读懂，含"网络"与中文状态、RTT 空时显示 —', () => {
  const monitor = H.createNetworkHealthMonitor({ manager: fakeManager(), session: fakeSession(), relay: relayUp() });
  const line = monitor.summaryLine();
  assert.ok(line.includes('网络'), '摘要必须能一眼认出是网络那一行');
  assert.ok(line.includes('P2P 已接通'));
  assert.ok(line.includes('｜'), '分段用全角竖线，日志里好扫');
  assert.ok(line.includes('Steam连接 现1/峰2'), '当前的/峰值的连接数都要有，才看得出一路涨没涨');
  assert.ok(line.includes('流 现3/峰0'), 'peakStreams 靠 sample() 采，还没采过就是 0 —— 这正是必须定期 sample() 的原因');

  monitor.sample();
  assert.ok(monitor.summaryLine().includes('流 现3/峰3'));
  assert.ok(monitor.summaryLine().includes('RTT 30ms'));

  const noRtt = H.createNetworkHealthMonitor({ manager: fakeManager(), session: fakeSession() });
  assert.ok(noRtt.summaryLine().includes('RTT —'), '没样本时显示 —，而不是 NaN 或 0ms');
});

test('assertInvariants()：正常空数组；越过硬上限时逐条报出来', () => {
  const events = [];
  const manager = fakeManager();
  const monitor = H.createNetworkHealthMonitor({ manager, session: fakeSession(), onEvent: (t, p) => events.push([t, p]) });

  assert.deepEqual(monitor.assertInvariants(), [], '一切正常时必须返回空数组（上层靠它决定要不要告警）');
  assert.equal(events.length, 0, '没问题就别发事件');

  // 规格 §三十九 的硬上限：一个远端玩家最多 2 条 Steam 连接
  manager.activeSteamConnections = 3;
  manager.maxActiveSteamConnections = 2;
  let problems = monitor.assertInvariants();
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes('超过硬上限 2'), `问题描述要说清上限是多少，实际是：${problems[0]}`);
  assert.ok(problems[0].includes('3'));
  assert.equal(events.length, 1);
  assert.equal(events[0][0], 'health-invariant-violated');
  assert.deepEqual(events[0][1].problems, problems, '事件里带上问题列表，日志才不用二次查询');

  // 当前值正常、历史峰值超限：也要报（峰值超限说明之前泄漏过，不能因为现在好转就吞掉）
  manager.activeSteamConnections = 1;
  manager.maxActiveSteamConnections = 5;
  problems = monitor.assertInvariants();
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes('峰值') && problems[0].includes('5'));

  // 积压 16MiB 以上：背压没生效的信号
  manager.maxActiveSteamConnections = 2;
  const sess = fakeSession();
  sess.queuedBytes = 17 * 1024 * 1024;
  const heavy = H.createNetworkHealthMonitor({ manager, session: sess });
  const heavyProblems = heavy.assertInvariants();
  assert.equal(heavyProblems.length, 1);
  assert.ok(heavyProblems[0].includes('16MiB'));

  // 三条同时越界就报三条，不能只报第一条
  manager.activeSteamConnections = 4;
  manager.maxActiveSteamConnections = 6;
  const all = H.createNetworkHealthMonitor({ manager, session: sess });
  assert.equal(all.assertInvariants().length, 3);
});

test('setSources / setSteamLoggedOn / setTransportReady 可以后补和更新', () => {
  const monitor = H.createNetworkHealthMonitor({});
  assert.equal(monitor.linkState(), LINK_STATE.STEAM_ONLINE);

  const manager = fakeManager();
  monitor.setSources({ manager });
  assert.equal(monitor.linkState(), LINK_STATE.P2P_CONNECTED, '后补 manager 之后就能看见 P2P 状态');

  const session = fakeSession(SESSION_STATE.RECOVERING);
  monitor.setSources({ session });
  assert.equal(monitor.linkState(), LINK_STATE.SESSION_RECOVERING);
  assert.equal(monitor.logLines().length, 3, '第一行 + P2P 行 + MUX 行');

  // 只传部分字段时不该把其它源清掉（增量更新，别把 relay 弄丢）
  const relay = relayDown();
  monitor.setSources({ relay });
  assert.equal(monitor.snapshot().relayAvailability, AVAILABILITY.Failed);
  manager.primary.state = CONN_STATE.DISCONNECTED;
  monitor.setSources({ session: null });
  assert.equal(monitor.snapshot().relayAvailability, AVAILABILITY.Failed, '只更新 session 不该把 relay 一起丢掉');
  assert.equal(monitor.linkState(), LINK_STATE.RELAY_UNAVAILABLE);

  assert.equal(monitor.setSteamLoggedOn(false), monitor, '这些 setter 都返回自己，方便链式调用');
  assert.equal(monitor.linkState(), LINK_STATE.STEAM_OFFLINE);
  monitor.setSteamLoggedOn(true);
  monitor.setTransportReady(false);
  const s = monitor.snapshot();
  assert.equal(s.steamLoggedOn, true);
  assert.equal(s.transportReady, false, 'transport 没就绪也要如实记录（只影响展示，不影响任何连接判断）');
});

test('源方法抛异常时不该带倒快照（只读模块的基本要求）', () => {
  const boom = () => { throw new Error('SDK 炸了'); };
  const monitor = H.createNetworkHealthMonitor({
    manager: { health: boom },
    session: { health: boom },
    relay: { isReady: boom, isUnavailable: boom, everReady: false, stats: boom },
  });
  // 本模块只读，源坏掉时应当抛出去（上层看得见），但绝不能悄悄返回半份假快照
  assert.throws(() => monitor.snapshot());
  assert.throws(() => monitor.sample());
  assert.throws(() => monitor.linkState());
});

// 这条是给界面用的（规格 §三十一）。快照里必须自带 state / stateLabel / statusText，
// 否则界面为了显示一句人话，只能自己拿 sessionState/primaryState 再判一遍 ——
// "连接中"这种模糊词就是从那种地方长回来的。
test('★ snapshot() 自带状态与文案：界面拿到就能显示，不用自己再判一遍（规格 §三十一）', () => {
  const manager = fakeManager();
  manager.primary.state = CONN_STATE.CONNECTED;
  const monitor = H.createNetworkHealthMonitor({ manager, session: fakeSession(), relay: relayUp() });

  const s = monitor.snapshot();
  assert.equal(s.state, LINK_STATE.P2P_CONNECTED, '快照里的 state 必须与 linkState() 是同一个判定');
  assert.equal(s.state, monitor.linkState());
  assert.equal(s.stateLabel, LINK_STATE_LABEL[LINK_STATE.P2P_CONNECTED]);
  assert.equal(s.statusText, monitor.statusText());
  // 文案必须是人话，不能把英文枚举名直接甩到界面上
  assert.ok(!s.stateLabel.includes('_'), `stateLabel 不该是枚举名：${s.stateLabel}`);
  // 主备两条各自的中文状态（§三十 要求能分别看到）
  assert.equal(s.primaryLabel, '已接通');
  assert.equal(s.backupLabel, '未开始');
  assert.equal(s.primaryState, CONN_STATE.CONNECTED);
  assert.equal(s.backupState, CONN_STATE.DISCONNECTED);

  // 状态变了，快照里的文案要跟着变 —— 这正是界面每帧重绘依赖的东西
  manager.primary.state = CONN_STATE.CONNECTED;
  manager.backup = null;
  assert.equal(monitor.snapshot().backupLabel, '', '没有 Backup 时给空串，界面自己决定怎么措辞');

  manager.primary.state = CONN_STATE.BACKOFF;
  const backoff = monitor.snapshot();
  assert.equal(backoff.state, LINK_STATE.RECONNECTING, '退避中就是"正在重连"');
  assert.equal(backoff.stateLabel, LINK_STATE_LABEL[LINK_STATE.RECONNECTING]);
  assert.equal(backoff.primaryLabel, '退避中');

  // 会话已结束时必须以会话为准，不能因为 Steam 没登录就报 STEAM_OFFLINE 把人带偏
  const closed = H.createNetworkHealthMonitor({ manager, session: fakeSession(SESSION_STATE.CLOSED), relay: relayUp(), steamLoggedOn: false });
  assert.equal(closed.snapshot().state, LINK_STATE.SESSION_CLOSED);
  assert.equal(closed.snapshot().stateLabel, '会话已结束');
});

test('CONN_STATE_LABEL：九个连接状态一个不落，且都不是英文枚举名', () => {
  const labels = Object.values(H.CONN_STATE_LABEL);
  assert.equal(labels.length, 9, 'steam-connection.cjs 的九个状态必须都有中文文案');
  for (const [key, text] of Object.entries(H.CONN_STATE_LABEL)) {
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 0, `${key} 缺文案`);
    assert.ok(!text.includes('_'), `${key} 的文案不该是枚举名`);
  }
  // 与真实状态机对齐：枚举里有的，这里都得有
  for (const st of Object.values(CONN_STATE)) {
    assert.ok(H.CONN_STATE_LABEL[st], `steam-connection 的 ${st} 在文案表里缺一条`);
  }
});
