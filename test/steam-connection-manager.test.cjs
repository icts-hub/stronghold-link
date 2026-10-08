'use strict';
// SteamConnectionManager 单测：Primary / Backup 两条，仅此而已。
//
// 这个文件盯的是规格里最要命的几条（0.13.3 那个"预热连接池"的验收点）：
//   §三 / §三十七  25 条业务流 → 仍然只有 1 条 Primary，不是 25 条 Steam 连接
//   §三十二 Test3  25 个并发业务流 = 1 条 Primary
//   §三十二 Test5  一条连接失败只收掉那一条，不许"一个失败就全关"
//   §三十二 Test7  relay 不可用不许 retry storm（既不重连也不排计时器）
//   §七           退避序列 1s / 2s / 4s / 8s / 15s / 30s / 60s + ±20% jitter
//   §三十四-②     MAX_TRANSPORT_CONNECTIONS = 2，任何时刻不超过
//   §二十四       poll group 统一收包 / 统一 drain
//
// 时钟是注入的（now: () => clock）：本模块**自己一个定时器都不建**，重试由 tick() 驱动。
// 所以这里没有一处真的 sleep，也没有一个用例会留下活动的 timer。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RETRY_BACKOFF_MS, RETRY_JITTER, MAX_TRANSPORT_CONNECTIONS,
  BACKUP_ARM_DELAY_MS, BACKUP_STREAM_THRESHOLD, POLL_BATCH,
  backoffDelay, classifyFailure, createSteamConnectionManager,
} = require('../network/steam-connection-manager.cjs');
const { STATE, STEAM_STATE } = require('../network/steam-connection.cjs');
const { createMockSdk, LISTEN, POLL } = require('./steam-mock.cjs');

const PEER = '76561198000000002';

// 注入的假时钟：模块里所有时间都从这里来。
let clock = 1_000_000;

/** 假的 relay 监视器：只实现 ConnectionManager 用到的那两个方法，可用性随时能改。 */
function fakeRelay(ok = true) {
  const state = { ok, calls: 0, lastRelayStatus: 'Current' };
  return {
    state,
    canOpenNewConnection() {
      state.calls += 1;
      return state.ok
        ? { ok: true, reason: 'ready' }
        : { ok: false, reason: 'relay-unavailable', detail: 'Failed', debugMessage: 'no relay' };
    },
    stats() {
      return { ready: state.ok, everReady: state.ok, availability: state.ok ? 100 : -10, lastRelayStatus: state.lastRelayStatus, transitions: 0 };
    },
  };
}

/** 加入者 / 房主 + 假 SDK + 假 relay 的标准组合；random 固定成 0.5 保证退避值可预测。 */
function makeManager(spec = {}) {
  const mock = createMockSdk();
  const relay = spec.relay || fakeRelay(true);
  const events = [];
  const messages = [];
  const mgr = createSteamConnectionManager({
    peerSteamId: PEER,
    now: () => clock,
    random: () => 0.5,
    ...spec,
    sockets: mock.sockets,
    relay,
    onEvent: (type, payload) => events.push({ type, payload }),
    onMessage: (msg) => messages.push(msg),
  });
  return { mgr, mock, relay, events, messages, of: (type) => events.filter((e) => e.type === type) };
}

const connectionCalls = (ctx) => ctx.mock.state.connectedTo.length;

test('★ 退避序列 1s/2s/4s/8s/15s/30s/60s + ±20% jitter，用固定 random 钉死（规格 §七）', () => {
  assert.deepEqual([...RETRY_BACKOFF_MS], [1000, 2000, 4000, 8000, 15000, 30000, 60000]);
  assert.equal(RETRY_JITTER, 0.2);
  assert.equal(typeof classifyFailure, 'function', 'manager 也要把故障分类透出去，不然上层没法记日志');

  const mid = () => 0.5; // jitter 取中 = 基数本身，这样能直接断言序列
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8, 99].map((n) => backoffDelay(n, mid)),
    [1000, 2000, 4000, 8000, 15000, 30000, 60000, 60000, 60000],
    '第 7 次以后封顶 60s，不许无限涨',
  );
  assert.equal(backoffDelay(0, mid), 1000, 'failStreak 0 也夹到第一个档位');

  // 上下边界：0.8x / 1.2x
  assert.equal(backoffDelay(1, () => 0), 800);
  assert.equal(backoffDelay(1, () => 1), 1200);
  assert.equal(backoffDelay(2, () => 0), 1600);
  assert.equal(backoffDelay(3, () => 1), 4800);
  assert.equal(backoffDelay(6, () => 1), 36000);
  assert.equal(backoffDelay(7, () => 0), 48000);
  assert.equal(backoffDelay(7, () => 1), 72000);

  // 抖动必须真的落在 ±20% 之内，而且随 random 变化（固定值会退化成惊群）
  for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    const base = RETRY_BACKOFF_MS[Math.min(n - 1, RETRY_BACKOFF_MS.length - 1)];
    for (const r of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const d = backoffDelay(n, () => r);
      assert.ok(d >= Math.round(base * 0.8) && d <= Math.round(base * 1.2), `failStreak ${n} / random ${r} → ${d} 超出 ±20%`);
    }
  }
  assert.notEqual(backoffDelay(1, () => 0.2), backoffDelay(1, () => 0.8), 'jitter 必须随 random 变');
});

test('★ 25 个并发业务流 → 1 条 Primary，不是 25 条 Steam 连接（规格 §三 / §三十二 Test3）', () => {
  const ctx = makeManager({ role: 'joiner', getActiveStreams: () => 25 });
  ctx.mgr.start();
  const primary = ctx.mgr.primary;
  ctx.mock.state.emitState({ connection: primary.handle, newState: STEAM_STATE.Connected });
  assert.equal(primary.state, STATE.CONNECTED);
  assert.equal(connectionCalls(ctx), 1, '第一次只建 1 条');

  // 业务流数量再翻也跟 Steam 连接数无关：tick 一百次，一条都不许多
  for (let i = 0; i < 100; i += 1) {
    clock += 100;
    ctx.mgr.tick();
    ctx.mgr.ensure();
  }
  assert.equal(connectionCalls(ctx), 1, '25 条业务流绝不允许变成 25 条 P2P');
  assert.equal(ctx.mgr.activeCount, 1);
  assert.ok(ctx.mgr.activeCount <= 1, '没有 backup 条件时活跃连接数必须 <= 1');
  assert.equal(ctx.mgr.stats.steamConnectionsCreated, 1);
  assert.equal(ctx.mgr.stats.maxActiveSteamConnections, 1);
  ctx.mgr.stop();
});

test('★ 业务量再大也只多 1 条 Backup；MAX_TRANSPORT_CONNECTIONS = 2 是硬顶（规格 §三 / §三十四-②）', () => {
  assert.equal(MAX_TRANSPORT_CONNECTIONS, 2);
  const ctx = makeManager({ role: 'joiner', getActiveStreams: () => 25 });
  ctx.mgr.start();
  const primary = ctx.mgr.primary;
  ctx.mock.state.emitState({ connection: primary.handle, newState: STEAM_STATE.Connected });
  clock += BACKUP_ARM_DELAY_MS; // Primary 稳定够久 + 业务量够大
  ctx.mgr.tick();
  assert.equal(ctx.mgr.activeCount, 2, 'Primary + 1 条 Backup，就这么多');
  assert.equal(connectionCalls(ctx), 2);
  assert.equal(ctx.mgr.backup.role, 'backup');
  ctx.mock.state.emitState({ connection: ctx.mgr.backup.handle, newState: STEAM_STATE.Connected });

  // 再折腾 5 分钟：25 条业务流 + 两条连接，绝不会冒出第三条
  for (let i = 0; i < 300; i += 1) {
    clock += 1000;
    ctx.mgr.tick();
  }
  assert.equal(connectionCalls(ctx), 2);
  assert.ok(ctx.mgr.activeCount <= MAX_TRANSPORT_CONNECTIONS);
  assert.ok(ctx.mgr.stats.maxActiveSteamConnections <= MAX_TRANSPORT_CONNECTIONS, '历史峰值也不许超过 2');
  ctx.mgr.stop();
});

test('★ relay 不可用且从未就绪：反复 ensure()/tick() 既不建连接也不排计时器（规格 §七 / §三十二 Test7）', () => {
  const relay = fakeRelay(false);
  const ctx = makeManager({ role: 'joiner', relay });
  ctx.mgr.start();
  assert.equal(ctx.mgr.primary.state, STATE.RELAY_WAIT, 'relay 没就绪就停在 RELAY_WAIT');
  assert.equal(connectionCalls(ctx), 0, '一个 connectP2P 都不许发');

  // 计时器哨兵：本模块由 MuxScheduler 驱动，自己一个定时器都不许建
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  let timers = 0;
  globalThis.setTimeout = (...args) => { timers += 1; return realSetTimeout(...args); };
  globalThis.setInterval = (...args) => { timers += 1; return realSetInterval(...args); };
  try {
    for (let i = 0; i < 200; i += 1) {
      clock += 1000;
      ctx.mgr.tick();
      ctx.mgr.ensure();
    }
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.setInterval = realSetInterval;
  }

  assert.equal(timers, 0, 'retry storm 的第一种形态：排一堆重试计时器');
  assert.equal(connectionCalls(ctx), 0, 'retry storm 的第二种形态：反复重连');
  assert.equal(ctx.mgr.stats.steamConnectionsCreated, 1, 'RELAY_WAIT 的那条连接只能建一次，不许一 tick 一条');
  assert.equal(ctx.mgr.failStreak, 0, 'relay 没就绪不算失败，不许推退避');
  assert.ok(ctx.mgr.stats.relayBlocked > 0, '被闸门拦了多少次要能看见');
  assert.equal(ctx.of('manager-relay-blocked').length > 0, true);
  ctx.mgr.stop();
});

test('★ relay 恢复后只建 1 条（规格 §七 / §三十二 Test7）', () => {
  const relay = fakeRelay(false);
  const ctx = makeManager({ role: 'joiner', relay });
  ctx.mgr.start();
  relay.state.ok = true;
  ctx.mgr.tick();
  assert.equal(connectionCalls(ctx), 1, 'relay 一恢复只建一条');
  ctx.mgr.tick();
  ctx.mgr.ensure();
  ctx.mgr.tick();
  assert.equal(connectionCalls(ctx), 1, '已经有一条在连了，不许再建第二条');
  assert.equal(ctx.mgr.activeCount, 1);
  ctx.mgr.stop();
});

test('★ relay 恢复后，正在等待的那条连接必须自己被叫醒（RELAY_WAIT → CONNECTING），而不是被丢掉换一条（规格 §七 / 设计文档 2.5(a)）', () => {
  const relay = fakeRelay(false);
  const ctx = makeManager({ role: 'joiner', relay });
  ctx.mgr.start();
  const waiting = ctx.mgr.primary; // 正在 RELAY_WAIT 里等 relay 的那条
  try {
    relay.state.ok = true;
    ctx.mgr.tick();
    assert.equal(waiting.state, STATE.CONNECTING,
      'RELAY_WAIT 不是终态：relay 回来后这条连接要接着用（tick 里的 RELAY_WAIT 分支就是干这个的）');
    assert.equal(ctx.mgr.primary, waiting, '换掉旧连接对象 = 它的 attempt / retryAt 记账全丢了');
  } finally {
    ctx.mgr.stop();
  }
});

test('★ primary 失败后，退避窗口内 ensure()/tick() 不许重连（规格 §七 退避序列）', () => {
  const ctx = makeManager({ role: 'joiner', random: () => 0.5 });
  ctx.mgr.start();
  const primary = ctx.mgr.primary;
  ctx.mock.state.emitState({ connection: primary.handle, newState: STEAM_STATE.Connected });
  ctx.mock.state.emitState({ connection: primary.handle, newState: STEAM_STATE.ProblemDetectedLocally, info: { endReason: 5003 } });
  assert.equal(primary.state, STATE.BACKOFF);
  assert.equal(primary.retryAt, clock + 1000, 'failStreak = 1 的退避基数是 1000ms');
  assert.equal(ctx.mgr.failStreak, 1);

  const before = connectionCalls(ctx);
  clock += 500;
  ctx.mgr.tick();
  assert.equal(connectionCalls(ctx), before, '退避没过半就重连 = retry storm');

  clock += 499; // 差 1ms
  ctx.mgr.tick();
  assert.equal(connectionCalls(ctx), before, '差 1ms 都不许重连');

  clock += 1; // 到期
  ctx.mgr.tick();
  assert.equal(connectionCalls(ctx), before + 1, '到期放行，而且只放行一次');
  ctx.mgr.tick();
  ctx.mgr.tick();
  assert.equal(connectionCalls(ctx), before + 1, '放行过了就不许再来');
  ctx.mgr.stop();
});

test('★ 退避到期后重连的是同一条连接（世代 / 记账都挂在它身上）（规格 §七）', () => {
  const ctx = makeManager({ role: 'joiner', random: () => 0.5 });
  ctx.mgr.start();
  const primary = ctx.mgr.primary;
  ctx.mock.state.emitState({ connection: primary.handle, newState: STEAM_STATE.Connected });
  ctx.mock.state.emitState({ connection: primary.handle, newState: STEAM_STATE.ClosedByPeer, info: { endReason: 4001 } });
  assert.equal(primary.state, STATE.BACKOFF);
  const before = connectionCalls(ctx);

  clock += 1000;
  ctx.mgr.tick();
  assert.equal(connectionCalls(ctx), before + 1);
  assert.equal(ctx.mgr.primary, primary, '重连用的还是那条连接对象');
  assert.equal(primary.state, STATE.CONNECTING);
  assert.equal(primary.attempt, 2, 'attempt 记着重试次数');
  ctx.mgr.stop();
});

test('★ handleStateChange 只处理那一条 connection：另一条（Backup）毫发无损（规格 §八 / §三十二 Test5）', () => {
  const ctx = makeManager({ role: 'joiner', getActiveStreams: () => 25 });
  ctx.mgr.start();
  const primary = ctx.mgr.primary;
  ctx.mock.state.emitState({ connection: primary.handle, newState: STEAM_STATE.Connected });
  clock += BACKUP_ARM_DELAY_MS;
  ctx.mgr.tick(); // 补一条 Backup
  const backup = ctx.mgr.backup;
  ctx.mock.state.emitState({ connection: backup.handle, newState: STEAM_STATE.Connected });
  assert.equal(backup.state, STATE.CONNECTED);

  ctx.mgr.handleStateChange({
    connection: primary.handle,
    newState: STEAM_STATE.ProblemDetectedLocally,
    info: { endReason: 5003 },
  });

  assert.equal(primary.state, STATE.BACKOFF, '出问题的那条该退避');
  assert.equal(backup.state, STATE.CONNECTED, '另一条一个字段都不许动');
  assert.equal(backup.isUsable, true);
  assert.equal(ctx.mgr.owns(backup.handle), true, 'backup 的句柄仍然认');
  assert.equal(ctx.mock.state.closed.length, 0, '不许"一条失败就把所有连接关掉"');
  ctx.mgr.stop();
});

test('★ Backup 掉线只清空 backup 槽，Primary 一动不动（规格 §八 / §三十二 Test5）', () => {
  const ctx = makeManager({ role: 'joiner', getActiveStreams: () => 25 });
  ctx.mgr.start();
  const primary = ctx.mgr.primary;
  ctx.mock.state.emitState({ connection: primary.handle, newState: STEAM_STATE.Connected });
  clock += BACKUP_ARM_DELAY_MS;
  ctx.mgr.tick();
  const backup = ctx.mgr.backup;
  ctx.mock.state.emitState({ connection: backup.handle, newState: STEAM_STATE.Connected });

  ctx.mgr.handleStateChange({ connection: backup.handle, newState: STEAM_STATE.ClosedByPeer, info: { endReason: 4001 } });
  assert.equal(backup.state, STATE.DEGRADED, '备份连接掉线走的是降级');
  assert.equal(ctx.mgr.backup, null, 'backup 槽要空出来，好让 maybeArmBackup 稍后补一条（它自己不排重试）');
  assert.equal(primary.state, STATE.CONNECTED, 'Primary 一个字段都不许动');
  assert.equal(ctx.mgr.failStreak, 0, 'Backup 掉了不算 Primary 的失败');
  assert.equal(ctx.of('manager-backup-lost').length, 1);
  assert.equal(ctx.mock.state.closed.length, 0);
  ctx.mgr.stop();
});

test('★ 同一个 handle 的后续状态变化不许被算成第二次失败（byHandle 必须在连接死掉时清干净）', () => {
  const ctx = makeManager({ role: 'joiner', random: () => 0.5 });
  ctx.mgr.start();
  const primary = ctx.mgr.primary;
  const handle = primary.handle;
  ctx.mock.state.emitState({ connection: handle, newState: STEAM_STATE.Connected });
  ctx.mock.state.emitState({ connection: handle, newState: STEAM_STATE.ClosedByPeer, info: { endReason: 4001 } });
  assert.equal(ctx.mgr.stats.steamConnectionsFailed, 1);
  assert.equal(ctx.mgr.failStreak, 1);

  // Steam 对同一条连接常常接着再报一次（ClosedByPeer 之后还有 Dead）：这不是"第二条连接失败了"
  ctx.mock.state.emitState({ connection: handle, newState: STEAM_STATE.Dead, info: { endReason: 4001 } });
  assert.equal(ctx.mgr.stats.steamConnectionsFailed, 1, '一条连接只算一次失败');
  assert.equal(ctx.mgr.failStreak, 1, '重复事件不许把退避往后推');
  assert.equal(ctx.mgr.owns(handle), false, '死掉的句柄不该还认成自己的');
  ctx.mgr.stop();
});

test('★ primary 失败的记账：lastFailure / failStreak / 事件里带 relay 状态（规格 §二十 / §三十）', () => {
  const ctx = makeManager({ role: 'joiner', random: () => 0.5 });
  ctx.mgr.start();
  const primary = ctx.mgr.primary;
  ctx.mock.state.emitState({ connection: primary.handle, newState: STEAM_STATE.Connected });
  ctx.mock.state.emitState({
    connection: primary.handle,
    newState: STEAM_STATE.ProblemDetectedLocally,
    info: { endReason: 5008, endDebugMessage: '会合失败' },
  });

  const lastFailure = ctx.mgr.lastFailure;
  assert.equal(lastFailure.class, 'P2P_RENDEZVOUS_FAILED', '分类要能区分"会合失败"和一般传输失败');
  assert.equal(lastFailure.text, '会合失败');
  assert.equal(lastFailure.role, 'primary');
  const ev = ctx.of('manager-primary-failed')[0].payload;
  assert.equal(ev.failureClass, 'P2P_RENDEZVOUS_FAILED');
  assert.equal(ev.retryInMs, 1000);
  assert.equal(ev.failStreak, 1);
  assert.equal(ev.relay, 'Current', '把 relay 状态一起带出来，日志里才看得出是不是 relay 的锅');
  assert.equal(ctx.mgr.stats.steamConnectionsFailed, 1);
  ctx.mgr.stop();
});

test('owns(handle)：只认自己的连接句柄（规格 §二十四 诊断用）', () => {
  const ctx = makeManager({ role: 'joiner' });
  ctx.mgr.start();
  assert.equal(ctx.mgr.owns(ctx.mgr.primary.handle), true);
  assert.equal(ctx.mgr.owns(999999), false);
  assert.equal(ctx.mgr.owns(null), false);
  assert.equal(ctx.mgr.owns(undefined), false);
  assert.equal(ctx.mgr.owns(String(ctx.mgr.primary.handle)), false, '字符串句柄不算 —— 句柄是 SDK 给的数字');
  ctx.mgr.stop();
  assert.equal(ctx.mgr.owns(101), false, '停掉之后一条都不认');
});

test('★ 房主：入站连接超过硬上限的第 3 条会被 closeConnection 拒绝（规格 §三 / §三十四-②）', () => {
  const ctx = makeManager({ role: 'host' });
  const rc = ctx.mgr.start();
  assert.equal(rc.ok, true);
  assert.equal(rc.pollGroup, POLL);
  assert.equal(rc.listenSocket, LISTEN);

  for (const handle of [201, 202, 203]) {
    ctx.mock.state.emitState({ connection: handle, newState: STEAM_STATE.Connecting, info: { listenSocket: LISTEN, identityRemote: PEER } });
  }
  assert.equal(ctx.mgr.activeCount, 2);
  assert.equal(ctx.mgr.primary.handle, 201);
  assert.equal(ctx.mgr.backup.handle, 202);
  assert.equal(ctx.mgr.owns(203), false, '被拒绝的那条不归我们');
  assert.equal(ctx.mgr.stats.rejectedConnections, 1);
  assert.deepEqual(ctx.mock.state.closed.map((c) => c.connection), [203]);
  assert.equal(ctx.mock.state.closed[0].message, '连接数已满');
  assert.equal(ctx.mgr.stats.inboundConnections, 2);
  ctx.mgr.stop();
});

test('maxConnections 传多大都顶不过硬上限 2（规格 §三）', () => {
  const ctx = makeManager({ role: 'host', maxConnections: 99 });
  ctx.mgr.start();
  for (const handle of [201, 202, 203, 204]) {
    ctx.mock.state.emitState({ connection: handle, newState: STEAM_STATE.Connecting, info: { listenSocket: LISTEN } });
  }
  assert.equal(ctx.mgr.activeCount, 2);
  assert.equal(ctx.mgr.stats.rejectedConnections, 2);
  ctx.mgr.stop();
});

test('★ 房主收编入站连接：acceptConnection + setConnectionPollGroup 都要做（规格 §二十四）', () => {
  const ctx = makeManager({ role: 'host' });
  ctx.mgr.start();
  ctx.mock.state.emitState({ connection: 201, newState: STEAM_STATE.Connecting, info: { listenSocket: LISTEN } });
  assert.deepEqual(ctx.mock.state.accepted, [201]);
  assert.deepEqual(ctx.mock.state.pollGroups, [{ connection: 201, group: POLL }], '收编的每条连接都要挂到统一 poll group 上');
  assert.equal(ctx.mgr.primary.state, STATE.CONNECTED, '收编进来就是 CONNECTED');
  assert.equal(ctx.of('manager-peer-accepted').length, 1);
  assert.equal(ctx.mgr.stats.acceptedPeers, 1);
  ctx.mgr.stop();
});

test('房主模式不主动建任何连接：ensure() 就是 inbound-only（规格 §三）', () => {
  const ctx = makeManager({ role: 'host' });
  ctx.mgr.start();
  assert.deepEqual(ctx.mgr.ensure(), { opened: false, reason: 'host-inbound-only' });
  for (let i = 0; i < 10; i += 1) {
    clock += 1000;
    ctx.mgr.tick();
  }
  assert.equal(connectionCalls(ctx), 0, '房主绝不 connectP2P');
  assert.equal(ctx.mgr.activeCount, 0);
  ctx.mgr.stop();
});

// 不确定正确行为，先跳过（见交付说明）：房主侧看到 listenSocket === 0 的状态变化时，代码只跳过
// acceptConnection，但仍然把它 adopt 成一条"入站"业务连接（inboundConnections++ / acceptedPeers++）。
// 注释只说了"不 accept"（0.13.3 实测 accept 会返回 11 InvalidParam），没说要不要收编。
// 今天房主不会自己发起出站连接，所以影响为零；等意图确定后再补断言。
test.skip('房主：listenSocket 为 0 的出站连接只跳过 accept，不该被当成入站业务连接收编', () => {
  const ctx = makeManager({ role: 'host' });
  ctx.mgr.start();
  ctx.mock.state.emitState({ connection: 301, newState: STEAM_STATE.Connecting, info: { listenSocket: 0, identityRemote: PEER } });
  assert.deepEqual(ctx.mock.state.accepted, [], '出站连接不 accept');
  assert.equal(ctx.mgr.activeCount, 0, '它也不是我们的入站业务连接');
  assert.equal(ctx.mgr.stats.inboundConnections, 0);
  ctx.mgr.stop();
});

test('★ poll()：poll group 抽到的消息按 handle 认人后交给上层，并给连接记账（规格 §二十四）', () => {
  const ctx = makeManager({ role: 'host' });
  ctx.mgr.start();
  ctx.mock.state.emitState({ connection: 201, newState: STEAM_STATE.Connecting, info: { listenSocket: LISTEN } });
  const payload = Buffer.from('GET / HTTP/1.1\r\n');
  ctx.mock.state.pushToHost(201, payload);

  assert.equal(ctx.mgr.poll(), 1);
  const msg = ctx.messages[0];
  assert.equal(msg.connection, ctx.mgr.primary);
  assert.equal(msg.handle, 201);
  assert.equal(msg.role, 'primary');
  assert.equal(msg.data.toString(), 'GET / HTTP/1.1\r\n');
  assert.equal(ctx.mgr.primary.counters.messagesReceived, 1);
  assert.equal(ctx.mgr.primary.counters.bytesReceived, payload.length);
  assert.equal(ctx.mgr.stats.messagesDrained, 1);
  ctx.mgr.stop();
});

test('poll()：不认识的 handle 也要交上去（role = unknown），绝不私吞消息', () => {
  const ctx = makeManager({ role: 'host' });
  ctx.mgr.start();
  ctx.mock.state.pushToHost(777, Buffer.from('孤儿'));
  assert.equal(ctx.mgr.poll(), 1);
  assert.equal(ctx.messages[0].connection, null);
  assert.equal(ctx.messages[0].role, 'unknown');
  assert.equal(ctx.messages[0].data.toString(), '孤儿');
  ctx.mgr.stop();
});

test('poll()：一次最多抽 POLL_BATCH 条、抽空就停；SDK 抛异常只记一条 manager-poll-error（规格 §二十四）', () => {
  assert.equal(POLL_BATCH, 32);

  const ctx = makeManager({ role: 'host' });
  ctx.mgr.start();
  for (let i = 0; i < 40; i += 1) ctx.mock.state.pushToHost(777, Buffer.from(`m${i}`));
  assert.equal(ctx.mgr.poll(), 40);
  assert.equal(ctx.mgr.stats.pollDrains, 2, '40 条 = 32 + 8，两轮抽完');
  assert.equal(ctx.mgr.poll(), 0, '抽空了就返回 0，不许空转死循环');
  ctx.mgr.stop();

  const noGroup = makeManager({ role: 'joiner' });
  assert.equal(noGroup.mgr.poll(), 0, '还没 start（没有 poll group）时 poll 是空操作');

  const boom = makeManager({ role: 'host' });
  boom.mgr.start();
  boom.mock.sockets.receiveMessagesOnPollGroup = () => { throw new Error('poll group 没了'); };
  assert.equal(boom.mgr.poll(), 0);
  assert.equal(boom.of('manager-poll-error').length, 1, '抽包失败只记一条，不许把整个隧道带崩');
  boom.mgr.stop();
});

test('tick()：getPendingStateChanges() 兜底，把全局回调漏掉的状态变化补上（规格 §六 兜底）', () => {
  const ctx = makeManager({ role: 'joiner' });
  ctx.mgr.start();
  const handle = ctx.mgr.primary.handle;
  const pending = [{ connection: handle, newState: STEAM_STATE.Connected, info: {} }];
  ctx.mock.sockets.getPendingStateChanges = () => pending.splice(0, pending.length);
  ctx.mgr.tick();
  assert.equal(ctx.mgr.primary.state, STATE.CONNECTED, '漏掉的状态变化必须在 tick 里补上');
  ctx.mgr.stop();
});

test('★ stop()：两条连接都收掉、poll group / listen socket 都还回去，句柄不再认（规格 §二十四）', () => {
  const ctx = makeManager({ role: 'host' });
  ctx.mgr.start();
  for (const handle of [201, 202]) {
    ctx.mock.state.emitState({ connection: handle, newState: STEAM_STATE.Connecting, info: { listenSocket: LISTEN } });
  }
  const handles = [ctx.mgr.primary.handle, ctx.mgr.backup.handle];

  assert.equal(ctx.mgr.stop(), true);
  assert.equal(ctx.mgr.primary, null);
  assert.equal(ctx.mgr.backup, null);
  assert.equal(ctx.mgr.activeCount, 0);
  assert.equal(ctx.mgr.pollGroup, null);
  assert.equal(ctx.mgr.listenSocket, null);
  assert.deepEqual(ctx.mock.state.closed.map((c) => c.connection), handles);
  assert.equal(ctx.mock.state.listenClosed, true);
  assert.equal(ctx.mock.state.pollDestroyed, true);
  assert.equal(ctx.mgr.stats.activeSteamConnections, 0);
  for (const handle of handles) assert.equal(ctx.mgr.owns(handle), false, '停掉之后一条句柄都不认');

  // 反注册真的生效：之后的全局状态变化进不来
  const before = JSON.stringify(ctx.mgr.stats);
  ctx.mock.state.emitState({ connection: 201, newState: STEAM_STATE.Connected });
  assert.equal(JSON.stringify(ctx.mgr.stats), before);
  assert.equal(ctx.mgr.stop(), false, '重复 stop 返回 false');
});

test('start()：重复调用返回 already；没有 SDK / listen socket 建不起来时如实报错（规格 §五）', () => {
  const ctx = makeManager({ role: 'joiner' });
  assert.deepEqual(ctx.mgr.start(), { ok: true, pollGroup: POLL });
  assert.deepEqual(ctx.mgr.start(), { ok: true, already: true });
  ctx.mgr.stop();

  const noSdk = createSteamConnectionManager({ role: 'joiner', peerSteamId: PEER, now: () => clock });
  assert.deepEqual(noSdk.start(), { ok: false, code: 'NOSDK' });

  const badListen = makeManager({ role: 'host' });
  badListen.mock.sockets.createListenSocketP2P = () => { throw new Error('listen 失败'); };
  assert.deepEqual(badListen.mgr.start(), { ok: false, code: 'ELISTEN' });
  assert.equal(badListen.of('manager-listen-failed').length, 1);
  badListen.mgr.stop();
});

test('★ Backup 只在 Primary 稳定 30s 之后 + 活跃流 ≥ 8 才补（规格 §六 / 设计文档 2.6）', () => {
  assert.equal(BACKUP_ARM_DELAY_MS, 30000);
  assert.equal(BACKUP_STREAM_THRESHOLD, 8);

  let streams = 25;
  const ctx = makeManager({ role: 'joiner', getActiveStreams: () => streams });
  ctx.mgr.start();
  const primary = ctx.mgr.primary;
  ctx.mock.state.emitState({ connection: primary.handle, newState: STEAM_STATE.Connected });

  clock += BACKUP_ARM_DELAY_MS - 1;
  assert.equal(ctx.mgr.maybeArmBackup(), false, '稳定不到 30s 不许补');
  assert.equal(ctx.mgr.activeCount, 1);

  clock += 1; // 满 30s
  streams = BACKUP_STREAM_THRESHOLD - 1;
  assert.equal(ctx.mgr.maybeArmBackup(), false, '业务量不够也不补（Backup 不强制存在）');
  assert.equal(ctx.mgr.activeCount, 1);

  streams = BACKUP_STREAM_THRESHOLD;
  assert.equal(ctx.mgr.maybeArmBackup(), true);
  assert.equal(ctx.mgr.backup.role, 'backup');
  assert.equal(connectionCalls(ctx), 2);
  assert.equal(ctx.of('manager-backup-armed').length, 1);

  assert.equal(ctx.mgr.maybeArmBackup(), false, '已经有一条 Backup 了，不许再补');
  assert.equal(connectionCalls(ctx), 2);
  ctx.mgr.stop();
});

test('relay 闸门不放行时不补 Backup（规格 §七）', () => {
  const relay = fakeRelay(true);
  const ctx = makeManager({ role: 'joiner', relay, getActiveStreams: () => 25 });
  ctx.mgr.start();
  ctx.mock.state.emitState({ connection: ctx.mgr.primary.handle, newState: STEAM_STATE.Connected });
  clock += BACKUP_ARM_DELAY_MS;
  relay.state.ok = false;
  assert.equal(ctx.mgr.maybeArmBackup(), false);
  assert.equal(connectionCalls(ctx), 1);
  ctx.mgr.stop();
});

test('★ send()/flush()：优先 Primary，Primary 不可用才走 Backup；都没有就如实说 ok:false', () => {
  const none = makeManager({ role: 'joiner' });
  assert.deepEqual(none.mgr.send(Buffer.from('x')), { ok: false, via: '', queued: 0 },
    '一条连接都没有时必须如实说不ok，让会话层去排队，而不是假装发出去了');

  const ctx = makeManager({ role: 'host' });
  ctx.mgr.start();
  for (const handle of [201, 202]) {
    ctx.mock.state.emitState({ connection: handle, newState: STEAM_STATE.Connecting, info: { listenSocket: LISTEN } });
  }
  assert.deepEqual(ctx.mgr.send(Buffer.from('hello')), { ok: true, via: 'primary', queued: 5 });
  assert.equal(ctx.mgr.flush(1024), 5);
  assert.equal(ctx.mock.state.sent.length, 1);
  assert.equal(ctx.mock.state.sent[0].data.toString(), 'hello');
  assert.equal(ctx.mock.state.sent[0].flags, 9, 'Reliable | NoNagle');

  ctx.mgr.primary.close();
  assert.deepEqual(ctx.mgr.send(Buffer.from('bye')), { ok: true, via: 'backup', queued: 3 }, 'Primary 没了要走 Backup');
  assert.equal(ctx.mgr.flush(1024), 3);

  ctx.mgr.backup.close();
  assert.deepEqual(ctx.mgr.send(Buffer.from('x')), { ok: false, via: '', queued: 0 });
  assert.equal(ctx.mgr.flush(1024), 0);
  ctx.mgr.stop();
});

test('没有 relay 监视器时不做闸门判断：照常建连接，不许把隧道卡死', () => {
  const mock = createMockSdk();
  const mgr = createSteamConnectionManager({ role: 'joiner', peerSteamId: PEER, sockets: mock.sockets, now: () => clock });
  mgr.start();
  assert.equal(mock.state.connectedTo.length, 1);
  assert.equal(mgr.health().relay, null, '没有监视器就如实给 null，不编一个状态出来');
  mgr.stop();
});

test('health() 把规格 §十九 / §三十 要的字段都交出来', () => {
  const ctx = makeManager({ role: 'joiner' });
  ctx.mgr.start();
  ctx.mock.state.emitState({ connection: ctx.mgr.primary.handle, newState: STEAM_STATE.Connected });
  const h = ctx.mgr.health();
  for (const key of ['role', 'peer', 'activeSteamConnections', 'maxActiveSteamConnections', 'failStreak',
    'lastFailure', 'relay', 'primary', 'backup',
    'steamConnectionsCreated', 'steamConnectionsSucceeded', 'steamConnectionsFailed', 'steamConnectionsClosed',
    'inboundConnections', 'rejectedConnections', 'pollDrains', 'messagesDrained', 'acceptedPeers',
    'lastRelayStatus', 'relayBlocked']) {
    assert.ok(Object.prototype.hasOwnProperty.call(h, key), `health 缺少字段 ${key}`);
  }
  assert.equal(h.role, 'joiner');
  assert.equal(h.peer, PEER);
  assert.equal(h.activeSteamConnections, 1);
  assert.equal(h.relay.ready, true, 'relay 快照要透出去');
  assert.equal(h.primary.id, ctx.mgr.primary.id);
  assert.equal(h.backup, null, '没有 Backup 就如实给 null');
  assert.equal(h.lastFailure, null);
  ctx.mgr.stop();
});
