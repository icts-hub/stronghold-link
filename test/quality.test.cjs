'use strict';
// 网络 PHASE 2 单测：NetworkQuality（RTT / 抖动 / 丢包）与探针编排。
// 全部用手工构造的样本验证数学结果，不碰真实网络。

const test = require('node:test');
const assert = require('node:assert');

const Q = require('../network/route/quality.cjs');

test('没有样本时必须 measured=false，不能返回 0 冒充「质量很好」', () => {
  const quality = Q.createQuality();
  const snap = quality.snapshot();
  assert.equal(snap.measured, false);
  assert.equal(snap.samples, 0);
  assert.equal(snap.rtt, null);
  assert.equal(snap.rttAvg, null);
  assert.equal(snap.jitter, null);
  assert.equal(snap.packetLoss, null);
  assert.equal(snap.at, null);
});

test('RTT 统计：中位数做头条值，均值/极值供排查', () => {
  const quality = Q.createQuality();
  for (const rtt of [20, 22, 24, 26, 500]) quality.record({ rttMs: rtt });
  const snap = quality.snapshot();
  assert.equal(snap.samples, 5);
  assert.equal(snap.rtt, 24, '5 个样本的中位数是 24，不会被 500 的尖峰带走');
  assert.equal(snap.rttMin, 20);
  assert.equal(snap.rttMax, 500);
  assert.equal(snap.rttAvg, 118.4, '(20+22+24+26+500)/5');
  assert.equal(snap.measured, true);
});

test('抖动：相邻 RTT 差值的平均绝对值（RFC 3550 思路）', () => {
  const quality = Q.createQuality();
  for (const rtt of [20, 24, 22, 30]) quality.record({ rttMs: rtt });
  // |24-20|=4, |22-24|=2, |30-22|=8 → (4+2+8)/3 = 4.67
  assert.equal(quality.snapshot().jitter, 4.7);

  const single = Q.createQuality();
  single.record({ rttMs: 30 });
  assert.equal(single.snapshot().jitter, 0, '只有一个样本时抖动记为 0（不是 null）');
});

test('丢包：按窗口内实际收发比计算；全部超时 → 1；无发送 → null', () => {
  const quality = Q.createQuality();
  for (let i = 0; i < 9; i += 1) quality.record({ rttMs: 25 });
  quality.record({ rttMs: null });
  const snap = quality.snapshot();
  assert.equal(snap.sent, 10);
  assert.equal(snap.received, 9);
  assert.equal(snap.packetLoss, 0.1, '10 发 9 收 → 10% 丢包');
  assert.equal(snap.samples, 9, '超时的样本不进 RTT 序列');

  const allLost = Q.createQuality();
  allLost.record({ rttMs: null });
  allLost.record({ rttMs: null });
  const lost = allLost.snapshot();
  assert.equal(lost.packetLoss, 1);
  assert.equal(lost.rtt, null, '全丢时没有 RTT 可报');
  assert.equal(lost.measured, true, '发过探针就算测过，只是结果很差');
});

test('窗口只保留最近的样本，旧样本滚出统计', () => {
  const quality = Q.createQuality({ window: 4 });
  for (const rtt of [10, 20, 30, 40, 50, 60]) quality.record({ rttMs: rtt });
  const snap = quality.snapshot();
  assert.equal(snap.samples, 4, '窗口=4');
  assert.deepEqual([snap.rttMin, snap.rttMax], [30, 60], '只统计最近 4 个');
  assert.equal(snap.sent, 6, '收发计数是累计值，不受窗口影响');
});

test('reset 清空全部统计', () => {
  const quality = Q.createQuality();
  quality.record({ rttMs: 30 });
  quality.record({ rttMs: null });
  quality.reset();
  const snap = quality.snapshot();
  assert.equal(snap.measured, false);
  assert.equal(snap.sent, 0);
  assert.equal(snap.rtt, null);
});

test('探针编排：真实时钟往返 + 超时样本都如实记录', async () => {
  let clock = 0;
  const sent = [];
  const answers = [30, null, 12];   // 第二次超时
  const prober = Q.createProber({
    now: () => clock,
    timeoutMs: 100,
    send: (payload) => { sent.push(String(payload)); clock += answers[sent.length - 1] === null ? 100 : answers[sent.length - 1]; },
    waitOnce: async () => {
      const value = answers[sent.length - 1];
      return value === null ? null : Buffer.from('pong');
    },
  });

  const snap = await prober.round({ count: 3 });
  assert.equal(sent.length, 3, '三个探针都发出去了');
  assert.equal(snap.sent, 3);
  assert.equal(snap.received, 2);
  assert.equal(snap.samples, 2);
  assert.equal(snap.packetLoss, 0.3333, '3 发 2 收 → 33.33%');
  assert.ok(snap.rtt >= 12, 'RTT 来自真实时钟差值');

  await assert.rejects(async () => Q.createProber({ send: () => {} }), /需要 send 与 waitOnce/);
});

test('探针编排：send 抛异常时记为丢包，不中断整轮', async () => {
  let calls = 0;
  const prober = Q.createProber({
    send: () => { calls += 1; if (calls === 1) throw new Error('网卡没了'); },
    waitOnce: async () => Buffer.from('pong'),
    now: () => calls * 10,
  });
  const snap = await prober.round({ count: 2 });
  assert.equal(snap.sent, 2);
  assert.equal(snap.received, 1, '第一次发送失败按丢包计');
  assert.equal(calls, 2, '第二轮继续执行');
});

test('median/mean 纯函数边界', () => {
  assert.equal(Q.median([]), null);
  assert.equal(Q.median([5]), 5);
  assert.equal(Q.median([1, 3]), 2);
  assert.equal(Q.median([3, 1, 2]), 2);
  assert.equal(Q.mean([]), null);
  assert.equal(Q.mean([2, 4]), 3);
});
