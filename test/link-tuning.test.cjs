'use strict';
// 链路参数单测：解析优先级、边界夹取、非法值回落，以及分片默认值与发送侧一致。
// 全部本机可测，不依赖 Steam 运行时。

const test = require('node:test');
const assert = require('node:assert');

const T = require('../network/link-tuning.cjs');
const F = require('../network/steam-framing.cjs');

test('不给任何输入时用的是默认值，且没有改写记录', () => {
  const out = T.resolveLinkTuning();
  assert.equal(out.maxChunk, 4 * 1024);
  assert.equal(out.outFlushBytes, 16 * 1024);
  assert.equal(out.fairQuantum, 4 * 1024, '公平调度的流间粒度默认与分片同量级');
  assert.equal(out.fairQueue, true, '公平调度默认开');
  assert.equal(out.callbackIntervalMs, 4);
  assert.equal(out.maxMessageBatch, 128);
  assert.equal(out.noNagle, true);
  assert.equal(out.noDelay, false);
  assert.deepEqual(out.notes, []);
  assert.deepEqual(out.changed, []);
});

test('环境变量能覆盖默认值', () => {
  const out = T.resolveLinkTuning({}, {
    SHL_STEAM_MAX_CHUNK: '131072',
    SHL_STEAM_CALLBACK_MS: '2',
    SHL_STEAM_NO_DELAY: 'on',
  });
  assert.equal(out.maxChunk, 128 * 1024);
  assert.equal(out.callbackIntervalMs, 2);
  assert.equal(out.noDelay, true);
  assert.deepEqual(out.changed.sort(), ['callbackIntervalMs', 'maxChunk', 'noDelay']);
});

test('显式传入的 overrides 优先于环境变量', () => {
  const out = T.resolveLinkTuning(
    { maxChunk: 32768, noDelay: false },
    { SHL_STEAM_MAX_CHUNK: '131072', SHL_STEAM_NO_DELAY: 'on' },
  );
  assert.equal(out.maxChunk, 32768);
  assert.equal(out.noDelay, false);
});

test('越界的整数夹到边界，不静默接受任意值', () => {
  assert.equal(T.resolveLinkTuning({ callbackIntervalMs: 0 }).callbackIntervalMs, 1);
  assert.equal(T.resolveLinkTuning({ callbackIntervalMs: 100000 }).callbackIntervalMs, 200);
  assert.equal(T.resolveLinkTuning({ outFlushBytes: 1 }).outFlushBytes, 1024);
  assert.equal(T.resolveLinkTuning({ maxMessageBatch: 0 }).maxMessageBatch, 1);
  assert.equal(T.resolveLinkTuning({ fairQuantum: 1 }).fairQuantum, 512);
  assert.equal(T.resolveLinkTuning({ fairQuantum: 9999999 }).fairQuantum, 65536);
  assert.equal(T.resolveLinkTuning({}, { SHL_STEAM_FAIR_QUANTUM: '2048' }).fairQuantum, 2048);
});

test('公平调度开关：默认开，SHL_STEAM_FAIR_QUEUE=0 退回 0.14.2 的老调度（真机 A/B 就靠这一个布尔值）', () => {
  assert.equal(T.resolveLinkTuning().fairQueue, true);
  const off = T.resolveLinkTuning({}, { SHL_STEAM_FAIR_QUEUE: '0' });
  assert.equal(off.fairQueue, false);
  assert.deepEqual(off.changed, ['fairQueue']);
  assert.equal(T.resolveLinkTuning({}, { SHL_STEAM_FAIR_QUEUE: 'off' }).fairQueue, false);
  assert.equal(T.resolveLinkTuning({ fairQueue: false }).fairQueue, false, '显式 overrides 也能关');
  const junk = T.resolveLinkTuning({}, { SHL_STEAM_FAIR_QUEUE: '随便写' });
  assert.equal(junk.fairQueue, true, '非法值退回默认');
  assert.equal(junk.notes.length, 1, '并且留一条 notes，不静默');
});

test('无法识别的取值退回默认并留下 notes，不静默改行为', () => {
  const out = T.resolveLinkTuning({}, { SHL_STEAM_CALLBACK_MS: '快一点' });
  assert.equal(out.callbackIntervalMs, T.DEFAULTS.callbackIntervalMs);
  assert.equal(out.notes.length, 1);
  assert.match(out.notes[0], /callbackIntervalMs/);
  assert.ok(!out.changed.includes('callbackIntervalMs'));
});

test('空字符串等于没设置，不算改写也不算错误', () => {
  const out = T.resolveLinkTuning({}, { SHL_STEAM_MAX_CHUNK: '' });
  assert.equal(out.maxChunk, T.DEFAULTS.maxChunk);
  assert.deepEqual(out.notes, []);
});

test('maxChunk 与发送侧走同一套夹取规则，两处不会算出不同的值', () => {
  for (const input of [0, -1, 1, 100, 4096, 99999999]) {
    assert.equal(
      T.resolveLinkTuning({ maxChunk: input }).maxChunk,
      F.normalizeChunkSize(input, T.DEFAULTS.maxChunk),
      '输入 ' + input + ' 两侧结果必须一致',
    );
  }
});

test('开关解析：只认写明的那几种写法，其余返回 null', () => {
  for (const v of ['1', 'true', 'on', 'yes', 'ON', ' True ']) assert.equal(T.parseSwitch(v), true);
  for (const v of ['0', 'false', 'off', 'no']) assert.equal(T.parseSwitch(v), false);
  for (const v of ['', null, undefined, 'maybe']) assert.equal(T.parseSwitch(v), null);
});

test('布尔项写成非法文本时退回默认并留 note', () => {
  const out = T.resolveLinkTuning({}, { SHL_STEAM_NO_NAGLE: '大概吧' });
  assert.equal(out.noNagle, T.DEFAULTS.noNagle);
  assert.equal(out.notes.length, 1);
});

test('notes 与 changed 都不共享内部数组，多次调用互不影响', () => {
  const a = T.resolveLinkTuning({}, { SHL_STEAM_CALLBACK_MS: 'zzz' });
  const b = T.resolveLinkTuning();
  assert.equal(a.notes.length, 1);
  assert.equal(b.notes.length, 0);
  assert.notEqual(a.notes, b.notes);
});

// ---- 0.14.4：Steam 待发可靠数据（pendingReliable）背压参数 ------------------

test('背压默认开，SHL_STEAM_BACKPRESSURE=0 退回 0.14.3，非法值退回默认并留 note', () => {
  const on = T.resolveLinkTuning();
  assert.equal(on.steamBackpressure, true);
  assert.deepEqual(on.changed, [], '默认值不算改写');

  const off = T.resolveLinkTuning({}, { SHL_STEAM_BACKPRESSURE: '0' });
  assert.equal(off.steamBackpressure, false);
  assert.deepEqual(off.changed, ['steamBackpressure']);
  assert.equal(T.resolveLinkTuning({}, { SHL_STEAM_BACKPRESSURE: 'off' }).steamBackpressure, false);
  assert.equal(T.resolveLinkTuning({ steamBackpressure: false }).steamBackpressure, false, '显式 overrides 也能关');

  const junk = T.resolveLinkTuning({}, { SHL_STEAM_BACKPRESSURE: '随便写' });
  assert.equal(junk.steamBackpressure, true);
  assert.equal(junk.notes.length, 1);
  assert.match(junk.notes[0], /steamBackpressure/);
});

test('背压水位默认 256KiB/64KiB，环境变量可覆盖，越界夹到边界', () => {
  const out = T.resolveLinkTuning();
  assert.equal(out.backlogHigh, 256 * 1024);
  assert.equal(out.backlogLow, 64 * 1024);

  const env = T.resolveLinkTuning({}, { SHL_STEAM_BACKLOG_HIGH: '524288', SHL_STEAM_BACKLOG_LOW: '131072' });
  assert.equal(env.backlogHigh, 512 * 1024);
  assert.equal(env.backlogLow, 128 * 1024);
  assert.deepEqual(env.changed.sort(), ['backlogHigh', 'backlogLow']);

  assert.equal(T.resolveLinkTuning({ backlogHigh: 1 }).backlogHigh, 16 * 1024);
  assert.equal(T.resolveLinkTuning({ backlogHigh: 99999999 }).backlogHigh, 8 * 1024 * 1024);
  assert.equal(T.resolveLinkTuning({ backlogLow: 1 }).backlogLow, 4 * 1024);
  const hugeLow = T.resolveLinkTuning({ backlogLow: 99999999 });
  assert.equal(hugeLow.backlogLow, T.DEFAULTS.backlogHigh, '先夹到上界，再被"低不得高于高"压回高水位');
});

test('低水位高于高水位时压到高水位并留 note，不出现"低>高"的抖动配置', () => {
  const out = T.resolveLinkTuning({ backlogHigh: 64 * 1024, backlogLow: 256 * 1024 });
  assert.equal(out.backlogLow, 64 * 1024);
  assert.equal(out.backlogHigh, 64 * 1024);
  assert.equal(out.notes.length, 1);
  assert.match(out.notes[0], /backlogLow/);
  assert.ok(out.changed.includes('backlogLow'));

  const fromEnv = T.resolveLinkTuning({}, { SHL_STEAM_BACKLOG_HIGH: '32768', SHL_STEAM_BACKLOG_LOW: '131072' });
  assert.equal(fromEnv.backlogLow, 32768);
  assert.equal(fromEnv.backlogHigh, 32768);
  assert.equal(fromEnv.notes.length, 1);
});

test('新增的三项：overrides 优先于环境变量', () => {
  const out = T.resolveLinkTuning(
    { steamBackpressure: false, backlogHigh: 32 * 1024, backlogLow: 16 * 1024 },
    { SHL_STEAM_BACKPRESSURE: '1', SHL_STEAM_BACKLOG_HIGH: '524288', SHL_STEAM_BACKLOG_LOW: '262144' },
  );
  assert.equal(out.steamBackpressure, false);
  assert.equal(out.backlogHigh, 32 * 1024);
  assert.equal(out.backlogLow, 16 * 1024);
});
