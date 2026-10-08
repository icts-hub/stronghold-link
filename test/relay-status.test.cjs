'use strict';
// Relay Network 状态监视单测（规格 §五 / §七 / §二十）。这个模块是"relay 不可用时到底
// 该不该开新连接"的唯一判断出处，所以测试重点在两处：
//   1. 取值语义 —— 只有 100 是"可用"（0 是 Unknown！），≤ -10 才算"明确不可用"；
//   2. canOpenNewConnection() 的关键分支 —— 从没就绪过 + 明确不可用 ⇒ 拒绝开新连接；
//      曾经就绪过 ⇒ 允许按退避重试。这两条要是反了，校园网里就会继续 30 秒超时风暴。
// 时间一律用注入的假时钟，SDK 用假对象（含"没这个方法 / 抛异常"两种残废形态）。

const test = require('node:test');
const assert = require('node:assert/strict');

const R = require('../network/relay-status.cjs');
const { AVAILABILITY } = R;

/** 假时钟：本模块只在 at / lastChangeAt 上用 now()，不需要推进也能测；推进用于验证真的走了注入的时钟。 */
function fakeClock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms) { t += ms; return t; },
  };
}

/** 假 networkingUtils：initCalls 记账、status 可改、可切换两种抛错形态。 */
function fakeNetUtils(availability = AVAILABILITY.Unknown) {
  return {
    initCalls: 0,
    status: availability,
    throwOnInit: null,
    throwOnPoll: null,
    statusExtra: {},
    initRelayNetworkAccess() {
      this.initCalls += 1;
      if (this.throwOnInit) throw this.throwOnInit;
    },
    getRelayNetworkStatus() {
      if (this.throwOnPoll) throw this.throwOnPoll;
      return { availability: this.status, debugMessage: `availability=${this.status}`, ...this.statusExtra };
    },
  };
}

test('AVAILABILITY 取值就是 SDK 枚举本身，0 是 Unknown', () => {
  assert.equal(AVAILABILITY.CannotTry, -102);
  assert.equal(AVAILABILITY.Failed, -101);
  assert.equal(AVAILABILITY.Previously, -100);
  assert.equal(AVAILABILITY.Retrying, -10);
  assert.equal(AVAILABILITY.Unknown, 0);
  assert.equal(AVAILABILITY.NeverTried, 1);
  assert.equal(AVAILABILITY.Waiting, 2);
  assert.equal(AVAILABILITY.Attempting, 3);
  assert.equal(AVAILABILITY.Current, 100);
  assert.equal(R.AVAILABILITY_READY, 100, '唯一"可用"取值就是 Current');
  assert.equal(Object.isFrozen(AVAILABILITY), true, '枚举被冻住，别让谁运行时改掉它');
});

test('describeAvailability：九个取值都有中文说明，未知/读不出来的也给字符串', () => {
  // 日志里出现 -101 时必须能直接看懂是"连不上中继网络"，而不是去翻 SDK 头文件
  const names = [-102, -101, -100, -10, 0, 1, 2, 3, 100].map((v) => R.describeAvailability(v));
  for (const name of names) {
    assert.equal(typeof name, 'string');
    assert.ok(name.length > 0);
  }
  assert.equal(R.describeAvailability(-102), 'CannotTry（本机网络栈不允许）');
  assert.equal(R.describeAvailability(-101), 'Failed（连不上 Steam 中继网络）');
  assert.equal(R.describeAvailability(-100), 'Previously（以前连上过，现在没连）');
  assert.equal(R.describeAvailability(-10), 'Retrying（正在重试）');
  assert.equal(R.describeAvailability(0), 'Unknown（还没查）');
  assert.equal(R.describeAvailability(1), 'NeverTried（还没试过）');
  assert.equal(R.describeAvailability(2), 'Waiting（等 Steam 安排）');
  assert.equal(R.describeAvailability(3), 'Attempting（正在连）');
  assert.equal(R.describeAvailability(100), 'Current（已连上中继网络）');
  assert.equal(new Set(names).size, 9, '九个取值必须给九种不同的说法，否则日志分不出状态');

  assert.equal(R.describeAvailability(42), '未识别取值(42)', '将来 SDK 加新取值也要能读出来，不能崩');
  assert.equal(R.describeAvailability(undefined), 'Unknown（状态读不出来）');
  assert.equal(R.describeAvailability(NaN), 'Unknown（状态读不出来）');
  assert.equal(R.describeAvailability(Infinity), 'Unknown（状态读不出来）');
  assert.equal(R.describeAvailability('100'), 'Current（已连上中继网络）', 'SDK 有时给的是数字字符串');
});

test('isReady / isUnavailable：0 既不是可用也不是不可用', () => {
  assert.equal(R.isReady(100), true);
  assert.equal(R.isReady('100'), true, '字符串 100 也算可用（SDK 给字符串是常态）');
  for (const v of [-102, -101, -100, -10, 0, 1, 2, 3, 99, 101, null, undefined, NaN]) {
    assert.equal(R.isReady(v), false, `${v} 不是"可用"：只有 100 才是`);
  }

  // "不可用"限定在明确失败/退避这一类；Unknown/NeverTried/Waiting/Attempting 都还在路上，
  // 这时候掐掉一切只会让本该成功的连接永远起不来。
  for (const v of [-102, -101, -100, -10]) assert.equal(R.isUnavailable(v), true, `${v} 是明确不可用`);
  for (const v of [0, 1, 2, 3, 100]) assert.equal(R.isUnavailable(v), false, `${v} 不是"明确不可用"`);
  assert.equal(R.isUnavailable(undefined), false, '读不出来时不要武断地说"不可用"');
  assert.equal(R.isUnavailable(NaN), false);
});

test('init()：SDK 没有 initRelayNetworkAccess 时不抛，只把原因记下来', () => {
  const events = [];
  const monitor = R.createRelayStatusMonitor({ netUtils: {}, onEvent: (type, payload) => events.push([type, payload]) });

  let snap;
  assert.doesNotThrow(() => { snap = monitor.init(); }, 'binding 不完整是常态，不是崩溃理由');
  assert.equal(events[0][0], 'relay-init-skipped', '必须留下可观测的痕迹，不能 silent');
  assert.ok(events[0][1].reason.includes('initRelayNetworkAccess'));
  assert.equal(snap.initCalled, true);
  assert.equal(snap.availability, AVAILABILITY.Unknown, '没查过就是 Unknown');
  assert.equal(snap.ready, false);
  assert.equal(snap.unavailable, false, 'Unknown 不算不可用，否则会误拦新连接');
  assert.ok(String(snap.debugMessage).includes('initRelayNetworkAccess'), '原因要能从快照里读到');

  // 二次 init 幂等：不会重复发事件、不会重复调用 SDK
  assert.doesNotThrow(() => monitor.init());
  assert.equal(events.length, 1);
});

// 现场教训：需求是"SDK 没有 initRelayNetworkAccess（或 init 抛异常）时不抛异常，
// 但要把原因留在 snapshot 里"。空快照那一支的字段必须和"有状态"那一支完全对齐 ——
// 少一个 initError，上层就只能去 debugMessage / availabilityName 里猜。
test('init 失败的原因要能从 snapshot().initError 直接读到', () => {
  const monitor = R.createRelayStatusMonitor({ netUtils: {} });
  const snap = monitor.init();
  assert.equal(typeof snap.initError, 'string');
  assert.ok(snap.initError.length > 0);
  assert.ok(snap.initError.includes('initRelayNetworkAccess'));
});

test('init() 成功：只调一次 SDK 的 init，并立刻 poll 一次', () => {
  const clock = fakeClock();
  const events = [];
  const utils = fakeNetUtils(AVAILABILITY.Current);
  const monitor = R.createRelayStatusMonitor({ netUtils: utils, now: clock.now, onEvent: (t, p) => events.push([t, p]) });

  const snap = monitor.init();
  assert.equal(utils.initCalls, 1);
  assert.deepEqual(events.map(([t]) => t), ['relay-init', 'relay-status'], 'init 之后必须顺手读一次状态，否则到下一个 tick 之前都是瞎的');
  assert.equal(events[0][1].ok, true);
  assert.equal(snap.ready, true);
  assert.equal(snap.at, 1000, 'at 走的是注入的假时钟');
  assert.equal(monitor.snapshot().polls, 1);

  clock.advance(500);
  assert.equal(monitor.snapshot().polls, 1, '幂等的 init 不会再 poll 一次');
  assert.equal(utils.initCalls, 1);
  monitor.poll();
  assert.equal(monitor.snapshot().polls, 2);
  assert.equal(monitor.snapshot().at, 1500);
});

test('init() 里 SDK 抛异常：不往上冒，原因记进 initError，后面照样能 poll', () => {
  const utils = fakeNetUtils(AVAILABILITY.Current);
  utils.throwOnInit = new Error('relay init 炸了');
  const events = [];
  const monitor = R.createRelayStatusMonitor({ netUtils: utils, onEvent: (t, p) => events.push([t, p]) });

  let snap;
  assert.doesNotThrow(() => { snap = monitor.init(); });
  const initEvent = events.find(([t]) => t === 'relay-init');
  assert.equal(initEvent[1].ok, false);
  assert.equal(initEvent[1].reason, 'relay init 炸了');
  assert.equal(utils.initCalls, 1);
  assert.equal(snap.initError, undefined, 'init() 返回的是 poll 的归一化结果，不是快照');
  assert.equal(monitor.snapshot().initError, 'relay init 炸了', 'init 失败时快照里要能看到原因');
  assert.equal(snap.ready, true, 'init 失败不妨碍紧接着的 poll 拿到真实状态');
  assert.equal(monitor.canOpenNewConnection().ok, true);
});

test('poll() 归一化：字段齐全、假时钟生效、返回值是拷贝', () => {
  const clock = fakeClock(7_000);
  const utils = fakeNetUtils(AVAILABILITY.Waiting);
  utils.statusExtra = { pingMeasurementInProgress: true, networkConfigAvailability: 1, anyRelayAvailability: 2, availabilityName: '自定义名' };
  const monitor = R.createRelayStatusMonitor({ netUtils: utils, now: clock.now });

  const got = monitor.poll();
  assert.equal(got.availability, AVAILABILITY.Waiting);
  assert.equal(got.availabilityName, '自定义名', 'SDK 自带的名字优先（上层可能已经本地化过）');
  assert.equal(got.ready, false);
  assert.equal(got.unavailable, false);
  assert.equal(got.pingMeasurementInProgress, true);
  assert.equal(got.networkConfigAvailability, 1);
  assert.equal(got.anyRelayAvailability, 2);
  assert.equal(got.at, 7000);
  assert.equal(got.polls, 1, 'polls 是这次 poll 的序号');

  utils.statusExtra = {};
  const plain = R.createRelayStatusMonitor({ netUtils: fakeNetUtils(AVAILABILITY.NeverTried) }).poll();
  assert.equal(plain.availabilityName, 'NeverTried（还没试过）', 'SDK 不给名字就自己翻');
  assert.equal(plain.networkConfigAvailability, null);
  assert.equal(plain.anyRelayAvailability, null);
  assert.equal(plain.pingMeasurementInProgress, false);

  // 返回值是拷贝：外部改它不能污染监视器内部状态
  got.availability = -9999;
  got.ready = true;
  assert.equal(monitor.snapshot().availability, AVAILABILITY.Waiting);
  assert.equal(monitor.isReady(), false);
});

test('availability 变化时才报 relay-status 事件，事件里带 from/to', () => {
  const utils = fakeNetUtils(AVAILABILITY.NeverTried);
  const events = [];
  const monitor = R.createRelayStatusMonitor({ netUtils: utils, onEvent: (t, p) => events.push([t, p]) });

  monitor.poll();
  assert.equal(events.length, 1);
  assert.equal(events[0][1].from, null, '第一次没有"从哪来"');
  assert.equal(events[0][1].fromName, '');
  assert.equal(events[0][1].to, AVAILABILITY.NeverTried);
  assert.equal(events[0][1].toName, 'NeverTried（还没试过）');
  assert.equal(monitor.transitions, 1);

  // 同值重复读：不报事件（debugMessage 变了也不算状态变化）
  utils.statusExtra = { debugMessage: '变了' };
  monitor.poll();
  monitor.poll();
  assert.equal(events.length, 1, '状态没变就别刷日志');
  assert.equal(monitor.transitions, 1);
  assert.equal(monitor.snapshot().debugMessage, '变了', '但快照里的细节要跟着更新');

  utils.status = AVAILABILITY.Attempting;
  utils.statusExtra = {};
  monitor.poll();
  assert.equal(events.length, 2);
  const [, payload] = events[1];
  assert.equal(payload.from, AVAILABILITY.NeverTried);
  assert.equal(payload.fromName, 'NeverTried（还没试过）');
  assert.equal(payload.to, AVAILABILITY.Attempting);
  assert.equal(payload.toName, 'Attempting（正在连）');
  assert.equal(monitor.transitions, 2);
  assert.equal(monitor.snapshot().lastChangeAt, monitor.snapshot().at, '变化时间点要记下来，便于算"卡了多久"');
});

test('everReady：第一次读到 100 之后永远是 true，哪怕后来掉下去', () => {
  const utils = fakeNetUtils(AVAILABILITY.Current);
  const monitor = R.createRelayStatusMonitor({ netUtils: utils });
  assert.equal(monitor.everReady, false);

  monitor.poll();
  assert.equal(monitor.everReady, true);
  assert.equal(monitor.isReady(), true);

  utils.status = AVAILABILITY.Failed;
  monitor.poll();
  assert.equal(monitor.isReady(), false);
  assert.equal(monitor.isUnavailable(), true);
  assert.equal(monitor.everReady, true, '"曾经连上过"这个事实不能被抹掉 —— 它决定现在该退避重试还是彻底放弃');
  assert.equal(monitor.snapshot().everReady, true);
});

test('canOpenNewConnection()：没读到过状态就允许试（unknown）', () => {
  const monitor = R.createRelayStatusMonitor({});
  assert.deepEqual(monitor.canOpenNewConnection(), { ok: true, reason: 'unknown' });
  assert.equal(monitor.pollErrors, 0);
  monitor.poll();
  assert.equal(monitor.pollErrors, 1, '没有 netUtils 时 poll 记一次错，不能静默');
  assert.deepEqual(monitor.canOpenNewConnection(), { ok: true, reason: 'unknown' }, '读不出来不等于不可用');
});

test('canOpenNewConnection()：明确不可用且从没就绪过 ⇒ 拒绝开新连接', () => {
  // 规格 §七 的核心：relay 起不来的时候，开新连接只会换回 30 秒超时 + 5003
  for (const value of [AVAILABILITY.CannotTry, AVAILABILITY.Failed, AVAILABILITY.Previously, AVAILABILITY.Retrying]) {
    const monitor = R.createRelayStatusMonitor({ netUtils: fakeNetUtils(value) });
    monitor.poll();
    const verdict = monitor.canOpenNewConnection();
    assert.equal(verdict.ok, false, `${value} 时不该再开新连接`);
    assert.equal(verdict.reason, 'relay-unavailable');
    assert.equal(verdict.detail, R.describeAvailability(value), '拒绝时要带上人话原因，日志直接能用');
    assert.equal(verdict.debugMessage, `availability=${value}`);
  }

  // Unknown / Waiting / Attempting 还在路上，允许试
  for (const value of [AVAILABILITY.Unknown, AVAILABILITY.NeverTried, AVAILABILITY.Waiting, AVAILABILITY.Attempting]) {
    const monitor = R.createRelayStatusMonitor({ netUtils: fakeNetUtils(value) });
    monitor.poll();
    assert.equal(monitor.canOpenNewConnection().ok, true, `${value} 只是"还没连上"，不能一刀切`);
  }

  const ready = R.createRelayStatusMonitor({ netUtils: fakeNetUtils(AVAILABILITY.Current) });
  ready.poll();
  assert.deepEqual(ready.canOpenNewConnection(), { ok: true, reason: 'ready' });
});

test('canOpenNewConnection()：曾经就绪过 ⇒ 掉线只是暂时，允许按退避重试', () => {
  const utils = fakeNetUtils(AVAILABILITY.Current);
  const monitor = R.createRelayStatusMonitor({ netUtils: utils });
  monitor.poll();
  assert.equal(monitor.everReady, true);

  utils.status = AVAILABILITY.Failed;
  monitor.poll();
  const verdict = monitor.canOpenNewConnection();
  assert.equal(verdict.ok, true, '路径本来是通的，按退避重试才有意义（彻底放弃会把可恢复的会话判死）');
  assert.equal(verdict.reason, 'transient');
  assert.equal(verdict.reason === 'relay-unavailable', false);

  // 掉回 Retrying(-10) 也一样
  utils.status = AVAILABILITY.Retrying;
  monitor.poll();
  assert.equal(monitor.canOpenNewConnection().reason, 'transient');
  assert.equal(monitor.transitions, 3);
});

test('getRelayNetworkStatus 抛异常：poll 不抛、pollErrors 加一、上一次状态保留', () => {
  const utils = fakeNetUtils(AVAILABILITY.Current);
  const events = [];
  const monitor = R.createRelayStatusMonitor({ netUtils: utils, onEvent: (t, p) => events.push([t, p]) });
  monitor.poll();

  utils.throwOnPoll = new Error('relay 状态读不出来');
  let snap;
  assert.doesNotThrow(() => { snap = monitor.poll(); }, 'SDK 偶尔抽一下不能让整个 loop 崩');
  assert.equal(monitor.pollErrors, 1);
  assert.equal(events.filter(([t]) => t === 'relay-poll-error').length, 1);
  assert.equal(events.find(([t]) => t === 'relay-poll-error')[1].message, 'relay 状态读不出来');
  assert.equal(snap.availability, AVAILABILITY.Current, '读失败时保留上一次已知状态，别假装 relay 掉了');
  assert.equal(monitor.isReady(), true);
  assert.equal(snap.polls, 1, '读失败不改写上一次成功的快照');
  assert.equal(monitor.stats().polls, 2, '内部计数照涨：读数失败也算 poll 过一次');
  assert.equal(monitor.stats().pollErrors, 1);

  utils.throwOnPoll = null;
  monitor.poll();
  assert.equal(monitor.pollErrors, 1, '恢复之后不再累加');
});

test('缺 getRelayNetworkStatus 也算 poll 出错；setNetUtils() 可以后补', () => {
  const monitor = R.createRelayStatusMonitor({ netUtils: { initRelayNetworkAccess() {} } });
  monitor.poll();
  assert.equal(monitor.pollErrors, 1);
  assert.equal(monitor.snapshot().ready, false);

  const utils = fakeNetUtils(AVAILABILITY.Current);
  assert.equal(monitor.setNetUtils(utils), monitor, 'setNetUtils 返回自己，方便链式调用');
  assert.equal(monitor.netUtils, utils);
  assert.equal(monitor.poll().ready, true, '后补上就能用 —— Steam 初始化是异步的，常常先建监视器后拿到 utils');
  assert.equal(monitor.setNetUtils(null).netUtils, null, '传 null 就是清掉（Steam 重启时用得上）');
});

test('stats() 汇总诊断字段，且不带内部对象引用', () => {
  const utils = fakeNetUtils(AVAILABILITY.Failed);
  const monitor = R.createRelayStatusMonitor({ netUtils: utils });
  monitor.poll();
  const s = monitor.stats();
  assert.equal(s.availability, AVAILABILITY.Failed);
  assert.equal(s.availabilityName, 'Failed（连不上 Steam 中继网络）');
  assert.equal(s.lastRelayStatus, 'Failed（连不上 Steam 中继网络）');
  assert.equal(s.ready, false);
  assert.equal(s.everReady, false);
  assert.equal(s.transitions, 1);
  assert.equal(s.polls, 1);
  assert.equal(s.pollErrors, 0);
  assert.equal(s.debugMessage, `availability=${AVAILABILITY.Failed}`);

  utils.status = AVAILABILITY.Current;
  utils.statusExtra = { availabilityName: 'Current（中继已就绪）' };
  monitor.poll();
  assert.equal(monitor.stats().lastRelayStatus, 'Current（中继已就绪）');
  assert.equal(monitor.stats().everReady, true);

  // 没 poll 过、init 也没成功过时，debugMessage 回落到 initError（而不是空串）
  const broken = R.createRelayStatusMonitor({ netUtils: {} });
  broken.init();
  assert.ok(String(broken.stats().debugMessage).includes('initRelayNetworkAccess'));
  assert.equal(broken.stats().availability, AVAILABILITY.Unknown);
  assert.equal(broken.stats().lastRelayStatus, '');
});
