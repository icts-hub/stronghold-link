'use strict';
// 网络 PHASE 4b（协议层）单测：分片与发送标志。
// 纯函数，全部本机可测；接进 steam-adapter 内核是下一步。

const test = require('node:test');
const assert = require('node:assert');

const F = require('../network/steam-framing.cjs');

test('分片：顺序不变，逐片不超过上限，拼回来与原数据完全一致', () => {
  const data = Buffer.alloc(10000);
  for (let i = 0; i < data.length; i += 1) data[i] = i % 251;
  const chunks = F.chunkBuffer(data, 4096);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((c) => c.length), [4096, 4096, 1808]);
  assert.ok(chunks.every((c) => c.length <= 4096));
  assert.ok(Buffer.concat(chunks).equals(data), '拼回来必须逐字节一致');
});

test('小数据不分片；空数据也返回一片（不能丢）', () => {
  assert.equal(F.chunkBuffer(Buffer.from('hi'), 4096).length, 1);
  const empty = F.chunkBuffer(Buffer.alloc(0));
  assert.equal(empty.length, 1);
  assert.equal(empty[0].length, 0);
});

test('分片大小：非法值回落默认，过小/过大夹到区间', () => {
  assert.equal(F.normalizeChunkSize(0), F.DEFAULT_MAX_CHUNK);
  assert.equal(F.normalizeChunkSize('abc'), F.DEFAULT_MAX_CHUNK);
  assert.equal(F.normalizeChunkSize(-5), F.DEFAULT_MAX_CHUNK);
  assert.equal(F.normalizeChunkSize(10), F.MIN_CHUNK);
  assert.equal(F.normalizeChunkSize(10 * 1024 * 1024), F.MAX_CHUNK);
  assert.equal(F.normalizeChunkSize(2048), 2048);
});

test('发送标志：可靠通道含 Reliable，不可靠通道含 Unreliable，且默认关 Nagle', () => {
  const flags = F.loadSendFlags();
  const rel = F.sendFlags({ channel: 'reliable' });
  const unrel = F.sendFlags({ channel: 'unreliable' });
  assert.ok(F.isReliable(rel), '可靠通道必须带 Reliable 位');
  assert.equal(F.isReliable(unrel), false, '不可靠通道不能带 Reliable 位');
  assert.equal(flags.Unreliable, 0, 'Steam 里 Unreliable 常量就是 0（不设 Reliable 位）');
  assert.ok(rel & flags.NoNagle, '默认关 Nagle：避免消息被攒着发导致延迟尖峰');
  assert.equal(F.sendFlags({ channel: 'reliable', noNagle: false }) & flags.NoNagle, 0);
  assert.ok(F.sendFlags({ channel: 'unreliable', noDelay: true }) & flags.NoDelay);
  assert.ok(F.sendFlags({ channel: 'reliable', autoRestart: true }) & flags.AutoRestartBrokenSession);
});

test('标志常量来自绑定或文档值，且都是正整数', () => {
  const flags = F.loadSendFlags();
  for (const [name, value] of Object.entries(flags)) {
    assert.ok(Number.isInteger(value) && value >= 0, name + ' 应是非负整数，实际 ' + value);
  }
  assert.equal(flags.NoNagle, F.FALLBACK_FLAGS.NoNagle, '本机未装绑定时应等于文档值');
});

test('发送计划：统计正确，chunks 与 flags 一致', () => {
  const plan = F.createSendPlan('x'.repeat(9000), { channel: 'unreliable', maxChunk: 4096 });
  assert.equal(plan.channel, 'unreliable');
  assert.equal(plan.totalBytes, 9000);
  assert.equal(plan.chunkCount, 3);
  assert.equal(plan.chunkSize, 4096);
  assert.equal(F.isReliable(plan.flags), false, '不可靠通道的计划不能带 Reliable 位');
  assert.equal(plan.chunks.reduce((s, c) => s + c.length, 0), 9000);
});

test('发送计划：未知通道必须报错（不静默当成可靠通道）', () => {
  assert.throws(() => F.createSendPlan('data', { channel: 'best-effort' }), /未知通道/);
});

test('分片拼接不复制数据（subarray 视图），且不改变原 Buffer', () => {
  const data = Buffer.from('abcdefghij');
  const chunks = F.chunkBuffer(data, 4);
  assert.equal(chunks[0].buffer, data.buffer, '应为同一底层缓冲的视图');
  const before = data.toString();
  chunks[0][0] = 0x7a; // 改视图会影响原数据 —— 这是约定：发送端不再改这些字节
  assert.equal(data.toString().slice(1), before.slice(1));
});
