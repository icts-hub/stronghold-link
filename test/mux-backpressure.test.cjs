'use strict';
// 背压控制器单测（规格 §十三）：只对"流"抽象调 pauseLocal/resumeLocal，不碰 socket/Steam/帧。
//   每流两级水位（1MiB 暂停 / 128KiB 恢复）+ 滞回 / 全会话两级水位（8MiB / 2MiB）/
//   accepts() 给出唯一答案 / 反注册后不再计入总量 / reset / 单条流抛异常不能带倒控制器 /
//   stats.maxQueued 记历史峰值。
// 假流对象只提供控制器真正会碰的两样东西：queuedBytes 和 pause/resume 记账。

const test = require('node:test');
const assert = require('node:assert/strict');

const B = require('../network/mux-backpressure.cjs');

const KIB = 1024;
const MIB = 1024 * 1024;

/** 假流：queuedBytes 可写，pause/resume 只记调用次数。 */
function fakeStream(id, queuedBytes = 0) {
  return {
    id,
    queuedBytes,
    pauseCalls: 0,
    resumeCalls: 0,
    pauseLocal() { this.pauseCalls += 1; },
    resumeLocal() { this.resumeCalls += 1; },
  };
}

/** 9 条"略低于每流高水位"的流：加起来超过全局高水位，但谁都没到自己的高水位。 */
function nineStreams(queuedBytesEach) {
  const streams = [];
  for (let i = 0; i < 9; i++) streams.push(fakeStream('s' + i, queuedBytesEach));
  return streams;
}

test('四级水位常量就是规格里的数，且真的作用在默认配置上', () => {
  assert.equal(B.PER_STREAM_HIGH_WATER, 1 * MIB);
  assert.equal(B.PER_STREAM_LOW_WATER, 128 * KIB);
  assert.equal(B.GLOBAL_HIGH_WATER, 8 * MIB);
  assert.equal(B.GLOBAL_LOW_WATER, 2 * MIB);
  assert.deepEqual(B.createBackpressureController().config, {
    streamHigh: 1 * MIB,
    streamLow: 128 * KIB,
    globalHigh: 8 * MIB,
    globalLow: 2 * MIB,
  });
});

test('单条流涨到 streamHigh：暂停这条流并记账；重复 update 不重复动手', () => {
  const bp = B.createBackpressureController();
  const s = fakeStream('a');
  bp.register(s);
  assert.equal(bp.accepts(s), true, '刚注册、没积压，当然该继续读');

  s.queuedBytes = MIB - 1;
  bp.update();
  assert.equal(s.pauseCalls, 0, '差 1 字节都不暂停');

  s.queuedBytes = MIB;
  assert.equal(bp.update(), MIB, 'update 返回会话总积压，方便上层打日志');
  assert.equal(s.pauseCalls, 1);
  assert.equal(bp.stats.streamHighWaterHits, 1);
  assert.equal(bp.accepts(s), false);
  assert.deepEqual(bp.pausedStreams(), [s]);
  assert.equal(bp.stats.pausedStreams, 1);

  bp.update();
  assert.equal(s.pauseCalls, 1, '已经暂停的流不重复动手 —— 反复 pause 本机 socket 只会让状态更乱');
  assert.equal(bp.stats.streamHighWaterHits, 1, '水位命中次数记的是"事件"，不是 update 次数');
});

test('降到 streamLow：恢复这条流并记账；没暂停过的流不会被无脑 resume', () => {
  const bp = B.createBackpressureController();
  const s = fakeStream('a', MIB);
  bp.register(s);
  assert.equal(s.pauseCalls, 1);

  s.queuedBytes = 128 * KIB + 1;
  bp.update();
  assert.equal(s.resumeCalls, 0, '还差 1 字节到低水位，先别松手');

  s.queuedBytes = 128 * KIB;
  bp.update();
  assert.equal(s.resumeCalls, 1);
  assert.equal(bp.stats.streamLowWaterHits, 1);
  assert.equal(bp.accepts(s), true);
  assert.deepEqual(bp.pausedStreams(), []);

  bp.update();
  assert.equal(s.resumeCalls, 1, '本来就没暂停的流不该被无脑 resume');

  const fresh = B.createBackpressureController();
  const never = fakeStream('never', 0);
  fresh.register(never);
  fresh.update();
  assert.equal(never.resumeCalls, 0);
  assert.equal(fresh.stats.streamLowWaterHits, 0);
});

test('滞回：高低水位之间不翻状态，否则阈值上会来回抖', () => {
  const bp = B.createBackpressureController();
  const s = fakeStream('h', 500 * KIB);
  bp.register(s);
  assert.equal(s.pauseCalls, 0, '500KiB 在 128KiB~1MiB 之间，不该暂停');

  s.queuedBytes = MIB;
  bp.update();
  assert.equal(s.pauseCalls, 1);

  s.queuedBytes = 500 * KIB;
  bp.update();
  assert.equal(s.resumeCalls, 0, '只降一半不能恢复 —— 必须一路跌到 128KiB 才松手');
  assert.equal(bp.accepts(s), false, '滞回期间这条流仍然是"别读了"');
  assert.equal(bp.stats.streamLowWaterHits, 0);
});

test('全局水位：到 8MiB 所有流都暂停，降到 2MiB 以下才全部放开', () => {
  const bp = B.createBackpressureController();
  const streams = nineStreams(1000 * KIB); // 9×1000KiB ≈ 8.8MiB，单条都没到 1MiB
  for (const s of streams) bp.register(s);

  assert.equal(bp.isGlobalPaused(), true, '全会话积压超过 8MiB 的高水位');
  assert.equal(bp.stats.totalQueued, 9 * 1000 * KIB);
  assert.ok(streams.every((s) => s.pauseCalls === 1), '全局水位动手时每一条流都要暂停读本机 socket');
  assert.equal(bp.stats.globalHighWaterHits, 1);
  assert.equal(bp.stats.streamHighWaterHits, 0, '每流积压都没到 1MiB，走的确实是全局那条路径');
  assert.ok(streams.every((s) => bp.accepts(s) === false));
  assert.equal(bp.accepts(fakeStream('没纳管的')), false, '全局暂停时对谁都返回 false');
  assert.equal(bp.stats.globalPaused, true);

  // 落在 2MiB~8MiB 之间：既不恢复也不重复暂停（全局这一级也要滞回）
  for (const s of streams) s.queuedBytes = 500 * KIB;
  bp.update();
  assert.equal(bp.isGlobalPaused(), true, '还在高水位和低水位之间，不该翻状态');
  assert.equal(bp.stats.globalLowWaterHits, 0);
  assert.equal(bp.stats.globalHighWaterHits, 1);

  for (const s of streams) s.queuedBytes = 100 * KIB; // 共 900KiB
  bp.update();
  assert.equal(bp.isGlobalPaused(), false, '降到低水位以下就该放开');
  assert.equal(bp.stats.globalLowWaterHits, 1);
  assert.equal(bp.stats.globalPaused, false);
  assert.ok(streams.every((s) => bp.accepts(s) === true));
  assert.equal(bp.stats.streamLowWaterHits, 0, '这些流本来就没被每流那一级暂停，不该记低水位命中');
});

// 现场教训：pauseAll() 对每条流都调了 pauseLocal()，如果全局恢复时 resumeAll() 只翻自己的
// 标志位、不调 resumeLocal()，那么被全局水位掐停的本机 socket 不会自己松开 ——
// 控制器以为"已经不暂停了"（accepts() 也返回 true），实际上流还停着，
// 只能指望上层在收到 Window 帧（mux-session.cjs:350）时顺手救一次，
// 没有 Window 帧的流会永久卡死。规格 §十三 的两级水位必须对称。
test('全局恢复时必须把被全局掐停的流 resumeLocal 回来', () => {
  const bp = B.createBackpressureController();
  const streams = nineStreams(1000 * KIB);
  for (const s of streams) bp.register(s);
  assert.equal(bp.isGlobalPaused(), true);

  for (const s of streams) s.queuedBytes = 0;
  bp.update();

  assert.equal(bp.isGlobalPaused(), false);
  assert.equal(bp.stats.globalLowWaterHits, 1);
  assert.ok(streams.every((s) => s.resumeCalls === 1), '全局恢复必须对称地撤销当初的 pauseLocal');
});

test('accepts()：全局暂停时对谁都 false；单流暂停时只对它 false', () => {
  const bp = B.createBackpressureController();
  const a = fakeStream('a', 2 * MIB);
  const b = fakeStream('b', 0);
  bp.register(a);
  bp.register(b);

  assert.equal(bp.accepts(a), false);
  assert.equal(bp.accepts(b), true, '别的流积压不关它的事 —— 这正是"每条流各判各的"要避免的');
  assert.equal(bp.accepts(fakeStream('nobody')), true, '没纳管的流不在我们的判断范围里');

  const all = B.createBackpressureController();
  const c = fakeStream('c', 0);
  all.register(c);
  assert.equal(all.isGlobalPaused(), false);
  assert.equal(all.accepts(c), true);
});

test('unregister：摘掉的流不再计入总量，也不会再被 pause/resume', () => {
  const bp = B.createBackpressureController();
  const bad = fakeStream('bad', 2 * MIB);
  const other = fakeStream('other', 0);
  bp.register(bad);
  bp.register(other);
  assert.equal(bad.pauseCalls, 1);

  bp.unregister(bad);
  assert.equal(bp.size, 1);
  assert.equal(bp.stats.pausedStreams, 0, '已摘掉的流不能还挂在暂停名单上');
  assert.deepEqual(bp.pausedStreams(), []);
  assert.equal(bp.stats.totalQueued, 0, '摘掉之后它的积压不再算进会话总量');

  bad.queuedBytes = 4 * MIB;
  bp.update();
  assert.equal(bad.pauseCalls, 1, '已经摘掉的流不许再被暂停（对象可能已经被回收）');
  assert.equal(bp.stats.streamHighWaterHits, 1, '也不许再记一笔水位命中');
  assert.equal(bp.stats.totalQueued, 0);

  // 防御：null/undefined 不该让控制器炸
  assert.doesNotThrow(() => { bp.register(null); bp.unregister(null); bp.unregister(undefined); });
  assert.equal(bp.size, 1);
});

test('reset：清掉暂停状态，但历史峰值保留（换会话时还要靠它复盘）', () => {
  const bp = B.createBackpressureController();
  const a = fakeStream('a', 3 * MIB);
  bp.register(a);
  assert.equal(bp.accepts(a), false);

  bp.reset();
  assert.equal(bp.isGlobalPaused(), false);
  assert.deepEqual(bp.pausedStreams(), []);
  assert.equal(bp.stats.pausedStreams, 0);
  assert.equal(bp.stats.globalPaused, false);
  assert.equal(bp.stats.totalQueued, 0);
  assert.equal(bp.accepts(a), true, 'reset 之后所有流重新允许读');
  assert.equal(bp.stats.maxQueued, 3 * MIB, '峰值是诊断数据，reset 不该抹掉');
  assert.equal(bp.size, 1, 'reset 只清本地判断，不动纳管关系');
});

test('单条流的 pauseLocal 抛异常不能带倒控制器', () => {
  const events = [];
  const bp = B.createBackpressureController({ onEvent: (type, payload) => events.push([type, payload]) });
  const bad = { id: 'bad', queuedBytes: 2 * MIB, pauseLocal() { throw new Error('socket 已经没了'); } };
  const good = fakeStream('good', 2 * MIB);

  bp.register(bad);
  assert.doesNotThrow(() => bp.register(good), '一条流暂停失败不能把 register 整条路径带崩');

  assert.equal(good.pauseCalls, 1, '坏的流抛异常之后，其他流照样被处理');
  assert.equal(bp.accepts(good), false);
  assert.equal(bp.accepts(bad), false, '抛异常也照样按"已暂停"处理，不然后面每 tick 都重试一次');
  assert.equal(bp.stats.streamHighWaterHits, 2, '账要记上：异常不等于没发生过高水位');
  assert.ok(events.some(([type]) => type === 'stream-paused'), '流暂停事件照发，日志里能看见');

  // resumeLocal 抛异常同样不能带倒控制器
  const bad2 = { id: 'bad2', queuedBytes: MIB, pauseLocal() {}, resumeLocal() { throw new Error('resume 也炸'); } };
  bp.register(bad2);
  bad2.queuedBytes = 0;
  assert.doesNotThrow(() => bp.update());
  assert.equal(bp.accepts(bad2), true, 'resume 失败也得把它从暂停名单里放出来，否则永远卡住');
  assert.equal(bp.stats.streamLowWaterHits, 1);
});

test('stats.maxQueued 记的是历史峰值，且 stats 是快照不是内部对象', () => {
  const bp = B.createBackpressureController();
  const a = fakeStream('a', 0);
  bp.register(a);

  a.queuedBytes = 3 * MIB;
  bp.update();
  assert.equal(bp.stats.maxQueued, 3 * MIB);

  a.queuedBytes = 0;
  bp.update();
  assert.equal(bp.stats.totalQueued, 0);
  assert.equal(bp.stats.maxQueued, 3 * MIB, '峰值只涨不跌，否则"刚才最惨的时候积压多少"就查不出来了');

  a.queuedBytes = 5 * MIB;
  bp.update();
  assert.equal(bp.stats.maxQueued, 5 * MIB);

  const snap = bp.stats;
  snap.maxQueued = -1;
  snap.totalQueued = -1;
  assert.equal(bp.stats.maxQueued, 5 * MIB, 'stats 每次都是新对象，外面改它不能污染控制器内部状态');
  assert.equal(bp.stats.totalQueued, 5 * MIB);
});

test('积压取数口：getQueuedBytes 优先，读不出来的值一律当 0', () => {
  const bp = B.createBackpressureController();
  const s = {
    id: 'getter',
    queuedBytes: 10,
    getQueuedBytes: () => 2 * MIB,
    pauseCalls: 0,
    pauseLocal() { this.pauseCalls += 1; },
    resumeLocal() {},
  };
  bp.register(s);
  assert.equal(bp.stats.totalQueued, 2 * MIB, '有 getQueuedBytes 就以它为准');
  assert.equal(s.pauseCalls, 1);

  // NaN / 负数 / null 当 0：绝不能拿 NaN 去和阈值比（比较永远 false，背压就静默失效了）
  bp.register({ id: 'nan', queuedBytes: NaN });
  bp.register({ id: 'neg', queuedBytes: -5 });
  bp.register({ id: 'null', queuedBytes: null });
  bp.register({ id: 'undef' });
  assert.equal(bp.stats.totalQueued, 2 * MIB);
  assert.equal(bp.isGlobalPaused(), false);

  bp.register({ id: 'str', queuedBytes: '1024' });
  assert.equal(bp.stats.totalQueued, 2 * MIB + 1024, '数字字符串也认得出来（SDK 有时给字符串）');
});
