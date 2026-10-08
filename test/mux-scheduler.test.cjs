'use strict';
// MuxScheduler 单测（规格 §十八：整个网络层**唯一**的定时器）：
//   手动 tick 一回合（测试不碰真实定时器，快且确定）/ 数据源注册与反注册 /
//   数据源抛异常必须上报而不能 silent catch / every·once 走注入的假时钟 /
//   同一个 key 覆盖而不是叠加 / cancel·has·pendingTimers / tick 返回值与统计增长 /
//   start·stop 的开关语义，以及 stop 之后必须一点残留都不留。
// 全程用注入的假时钟，一个真实 setTimeout 都不等。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMuxScheduler, DEFAULT_INTERVAL_MS } = require('../network/mux-scheduler.cjs');

/**
 * 假时钟：现在几点完全由测试说了算。
 * autoAdvance > 0 时每次读表都自己往前走一点 —— 专门用来给 tick 造出非零耗时。
 */
function fakeClock(start = 1000) {
  const clock = { t: start, autoAdvance: 0 };
  clock.now = () => { const v = clock.t; clock.t += clock.autoAdvance; return v; };
  clock.advance = (ms) => { clock.t += ms; };
  return clock;
}

/** 造一个绑了假时钟的调度器；不调 start() 就不会有任何真实定时器。 */
function makeScheduler(clock, onEvent = () => {}) {
  return createMuxScheduler({ now: clock.now, onEvent, intervalMs: 4 });
}

test('手动 tick 一回合：返回 durationMs / timersFired，统计跟着涨', () => {
  const clock = fakeClock();
  const scheduler = makeScheduler(clock);

  assert.equal(scheduler.stats.ticks, 0);
  assert.equal(scheduler.stats.avgTickDurationMs, 0, '一次都没跑过时平均值必须是 0，不能是 NaN');

  const fired = [];
  scheduler.once('now', 0, () => fired.push('now'));
  scheduler.once('later', 1000, () => fired.push('later'));

  clock.autoAdvance = 2; // 这一回合"花了 2 毫秒"
  const r = scheduler.tick();
  clock.autoAdvance = 0;

  assert.equal(r.tick, 1);
  assert.equal(r.durationMs, 2, 'durationMs 取自注入的 now，所以测试里能精确控制');
  assert.equal(r.timersFired, 1, '只有到点的那张 deadline 表条目算数');
  assert.deepEqual(fired, ['now']);
  assert.equal(scheduler.stats.ticks, 1);
  assert.equal(scheduler.stats.lastTickAt, 1000);
  assert.equal(scheduler.stats.maxTickDurationMs, 2);
  assert.equal(scheduler.stats.avgTickDurationMs, 2);

  const r2 = scheduler.tick();
  assert.equal(r2.tick, 2);
  assert.equal(scheduler.stats.ticks, 2);
  assert.equal(scheduler.stats.maxTickDurationMs, 2, '峰值不因为后来变快而下降');
  assert.equal(scheduler.stats.avgTickDurationMs, 1, '(2+0)/2 —— 平均值要一直更新');
});

test('数据源每 tick 都跑，返回的反注册函数能把它摘掉', () => {
  const clock = fakeClock();
  const scheduler = makeScheduler(clock);
  const seen = [];

  const off = scheduler.addSource('net', (ctx) => seen.push([ctx.name, ctx.tick, ctx.now]));
  scheduler.addSource('relay', () => seen.push('relay'));
  assert.deepEqual(scheduler.sourceNames(), ['net', 'relay'], '数据源按注册顺序跑');
  assert.equal(scheduler.stats.sources, 2);

  scheduler.tick();
  scheduler.tick();

  assert.equal(seen.filter(Array.isArray).length, 2, '注册了的数据源每个 tick 都要被调一次');
  assert.equal(seen.filter((x) => x === 'relay').length, 2);
  assert.deepEqual(seen[0], ['net', 1, 1000], 'ctx 里带 name/tick/now，数据源不用自己去问时间');

  assert.equal(off(), true, '反注册函数返回是否真的摘掉了一个');
  assert.equal(scheduler.stats.sources, 1);
  scheduler.tick();
  assert.equal(seen.filter(Array.isArray).length, 2, '摘掉之后一次都不许再调');

  assert.equal(scheduler.removeSource('relay'), true);
  assert.equal(scheduler.removeSource('relay'), false, '摘第二次是 no-op，不该假装成功');
  assert.deepEqual(scheduler.sourceNames(), []);
});

test('数据源抛异常：tick 不抛，但必须报 scheduler-error 且 sourceErrors 加一（禁止 silent catch）', () => {
  const clock = fakeClock();
  const events = [];
  const scheduler = makeScheduler(clock, (type, payload) => events.push([type, payload]));
  const after = [];

  scheduler.addSource('boom', () => { throw new Error('数据源炸了'); });
  scheduler.addSource('ok', () => after.push('ok'));

  const r = scheduler.tick();
  assert.ok(r, '一个数据源炸了也不能让 tick 抛出去，否则整条时间线就断了');
  assert.deepEqual(after, ['ok'], '坏的数据源不能带倒同一 tick 里的其他数据源');
  assert.equal(scheduler.stats.sourceErrors, 1);
  assert.equal(scheduler.stats.timerErrors, 0, '数据源的账不能记到定时任务头上');

  const err = events.find(([type]) => type === 'scheduler-error');
  assert.ok(err, '规格 §三十六：禁止 silent catch —— 必须把失败报出来');
  assert.equal(err[1].kind, 'source');
  assert.equal(err[1].name, 'boom', '报出来的是数据源名字，日志里能直接对上是谁炸的');
  assert.equal(err[1].message, '数据源炸了');
  assert.match(err[1].stack, /数据源炸了/, '带上（截断的）栈，才好定位是数据源里哪一行');

  scheduler.tick();
  assert.equal(scheduler.stats.sourceErrors, 2, '每次都记账，不是只报第一次');
  assert.equal(events.filter(([type]) => type === 'scheduler-error').length, 2);
});

test('定时任务抛异常算在 timerErrors 上，同样不能带倒 tick', () => {
  const clock = fakeClock();
  const events = [];
  const scheduler = makeScheduler(clock, (type, payload) => events.push([type, payload]));

  scheduler.once('bad-timer', 0, () => { throw new Error('任务炸了'); });
  const r = scheduler.tick();

  assert.equal(r.timersFired, 1, '抛异常的任务也算"到点结算过"');
  assert.equal(scheduler.stats.timerErrors, 1);
  assert.equal(scheduler.stats.sourceErrors, 0, '定时任务出错不能算到数据源头上，否则排查方向全错');
  const err = events.find(([type]) => type === 'scheduler-error');
  assert.equal(err[1].kind, 'timer');
  assert.equal(err[1].message, '任务炸了');
  assert.ok(err[1].stack.includes('mux-scheduler.test.cjs'), '栈信息要带上，只有 message 定位不了');
  assert.equal(scheduler.has('bad-timer'), false, '一次性任务不管成没成功都要摘掉，否则每 tick 重炸一次');

  // 重复任务炸了之后还得继续按 interval 活着（不能因为一次异常就悄悄停掉）
  scheduler.every('bad-repeat', 10, () => { throw new Error('每次都炸'); });
  clock.advance(10);
  scheduler.tick();
  clock.advance(10);
  scheduler.tick();
  assert.equal(scheduler.stats.timerErrors, 3);
  assert.equal(scheduler.has('bad-repeat'), true, '重复任务一次失败不等于注销');
});

// 现场教训：scheduler-error 的 payload 只取 ctx.name 是不够的 —— 定时任务那组
// ctx 是 { key, now, runs, interval }，本来就没有 name。定时任务炸了却报不出是哪个 key，
// 等于只告诉运维"某个定时任务出错了"，对不上 pendingTimers() 表，查不下去。
test('定时任务报错时要能指认是哪个 key 炸了', () => {
  const clock = fakeClock();
  const events = [];
  const scheduler = makeScheduler(clock, (type, payload) => events.push([type, payload]));

  scheduler.once('bad-timer', 0, () => { throw new Error('任务炸了'); });
  scheduler.tick();

  const err = events.find(([type]) => type === 'scheduler-error')[1];
  assert.equal(err.name || err.key, 'bad-timer', '报出来的身份要对得上 deadline 表里的 key');
});

test('every / once 走注入的 now：时间不推进就一次都不触发', () => {
  const clock = fakeClock(10000);
  const scheduler = makeScheduler(clock);
  const runs = [];

  scheduler.every('housekeep', 50, (ctx) => runs.push(['every', ctx.runs, ctx.now]));
  scheduler.once('late', 50, () => runs.push(['once']));
  assert.deepEqual(scheduler.pendingTimers().map((t) => t.key), ['housekeep', 'late']);
  assert.equal(scheduler.pendingTimers()[0].inMs, 50);

  clock.advance(49);
  scheduler.tick();
  assert.deepEqual(runs, [], '差 1 毫秒都不触发 —— 用的是注入的 now，不是真实时钟');

  clock.advance(1);
  scheduler.tick();
  assert.deepEqual(runs, [['every', 1, 10050], ['once']], '正好到点才结算，并且带上跑了几次');
  assert.equal(scheduler.has('late'), false, 'once 触发后就摘掉');
  assert.equal(scheduler.has('housekeep'), true, 'every 触发后留在表里');

  scheduler.tick();
  assert.equal(runs.length, 2, '同一时刻不会重复结算，不然周期任务会烧穿 CPU');

  clock.advance(50);
  scheduler.tick();
  assert.deepEqual(runs[2], ['every', 2, 10100]);
  assert.equal(scheduler.pendingTimers()[0].runs, 2, 'pendingTimers 里能看到它跑了几次');
});

test('同一个 key 重复 schedule 是覆盖不是叠加（"一个东西只许有一个定时器"）', () => {
  const clock = fakeClock();
  const scheduler = makeScheduler(clock);
  const fired = [];

  scheduler.schedule('peer-reconnect', 100, () => fired.push('first'));
  assert.equal(scheduler.pendingTimers().length, 1);
  scheduler.schedule('peer-reconnect', 10, () => fired.push('second'));
  assert.equal(scheduler.pendingTimers().length, 1, '还是只有一张表条目 —— 叠加就是两个重连定时器互相踩');
  assert.equal(scheduler.pendingTimers()[0].inMs, 10, 'deadline 被新的覆盖');

  clock.advance(10);
  scheduler.tick();
  assert.deepEqual(fired, ['second'], '旧的那个永远不许跑');
  assert.equal(scheduler.has('peer-reconnect'), false);
});

test('cancel / has / pendingTimers 的行为', () => {
  const clock = fakeClock(500);
  const scheduler = makeScheduler(clock);

  scheduler.every('hb', 100, () => {});
  scheduler.once('tmp', 20, () => {});
  assert.equal(scheduler.has('hb'), true);
  assert.equal(scheduler.has('tmp'), true);
  assert.equal(scheduler.has('nope'), false);

  assert.equal(scheduler.cancel('tmp'), true);
  assert.equal(scheduler.cancel('tmp'), false, '取消两次第二次是 no-op，不该报错也不该假装成功');
  assert.equal(scheduler.has('tmp'), false);

  const pend = scheduler.pendingTimers();
  assert.equal(pend.length, 1);
  assert.deepEqual(pend[0], { key: 'hb', at: 600, inMs: 100, interval: 100, runs: 0 },
    'pendingTimers 要给出"还有多久到点"，诊断时不用自己算时间');

  assert.equal(scheduler.cancel('hb'), true);
  assert.deepEqual(scheduler.pendingTimers(), []);
  assert.equal(scheduler.stats.timers, 0);
});

test('start / stop：running 翻转，stop 之后 tick 返回 null，且不许再启动', () => {
  const clock = fakeClock();
  const events = [];
  const scheduler = makeScheduler(clock, (type) => events.push(type));
  const ran = [];
  scheduler.addSource('src', () => ran.push(1));

  assert.equal(scheduler.running, false);
  assert.equal(scheduler.start(), true);
  assert.equal(scheduler.running, true);
  assert.equal(ran.length, 1, 'start 后立刻先跑一轮，不等满一个周期');
  assert.equal(scheduler.stats.ticks, 1);
  assert.equal(scheduler.stats.intervalMs, 4);

  clock.advance(500);
  assert.equal(scheduler.stats.uptimeMs, 500, 'uptime 也走注入的 now');
  assert.equal(scheduler.start(), false, '已经在跑了，重复 start 不能再起一个循环');

  assert.equal(scheduler.stop(), true);
  assert.equal(scheduler.running, false);
  assert.equal(scheduler.tick(), null, '停止之后 tick 返回 null —— 上层据此知道调度器已经关了');
  assert.equal(scheduler.stop(), false, '重复 stop 是 no-op');
  assert.equal(scheduler.start(), false, 'stop 之后不许再启动同一个调度器，否则会同时存在两个循环');
  assert.deepEqual(events, ['scheduler-started', 'scheduler-stopped']);
});

test('stop 必须把 timers 和 sources 清空，一点残留都不留', () => {
  const clock = fakeClock();
  const scheduler = makeScheduler(clock);
  let ran = 0;

  scheduler.addSource('src', () => { ran += 1; });
  scheduler.every('hb', 10, () => {});
  scheduler.once('later', 1000, () => {});
  assert.equal(scheduler.stats.sources, 1);
  assert.equal(scheduler.stats.timers, 2);

  scheduler.tick();
  assert.equal(ran, 1);

  scheduler.start();
  scheduler.stop();

  assert.equal(scheduler.stats.sources, 0, '规格 §十八 只许有一个调度器：停掉之后不能再有数据源残留');
  assert.equal(scheduler.stats.timers, 0, '停掉之后不能再有 deadline 残留');
  assert.deepEqual(scheduler.sourceNames(), []);
  assert.deepEqual(scheduler.pendingTimers(), []);
  assert.equal(scheduler.tick(), null, '残留的 tick 会继续调已经被释放的数据源，必须彻底停住');
});

test('节拍：默认 4ms，越界值夹到至少 1ms', () => {
  assert.equal(DEFAULT_INTERVAL_MS, 4, '文件头注释里的实测结论就是 4ms，不要随手改');
  assert.equal(createMuxScheduler().intervalMs, 4);
  assert.equal(createMuxScheduler({ intervalMs: 0 }).intervalMs, 1, '0 会变成忙等，夹到 1');
  assert.equal(createMuxScheduler({ intervalMs: -5 }).intervalMs, 1);
  assert.equal(createMuxScheduler({ intervalMs: NaN }).intervalMs, 4, '读不出来的值退回默认，不是变成 0');
  assert.equal(createMuxScheduler({ intervalMs: 16 }).intervalMs, 16);
});

test('注册接口拒绝非函数：不许静默丢掉一个数据源/任务', () => {
  const clock = fakeClock();
  const scheduler = makeScheduler(clock);
  assert.throws(() => scheduler.addSource('x', null), TypeError);
  assert.throws(() => scheduler.schedule('x', 10, null), TypeError);
  assert.deepEqual(scheduler.sourceNames(), [], '抛异常时不能留下半截注册');
  assert.deepEqual(scheduler.pendingTimers(), []);
});
