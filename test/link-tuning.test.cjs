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
