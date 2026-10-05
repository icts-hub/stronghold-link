'use strict';
// 网络 PHASE 5（评分部分）单测：路径评分与候选排序。
// 纯函数，全部用手算期望值验证。

const test = require('node:test');
const assert = require('node:assert');

const S = require('../network/route/score.cjs');

test('延迟曲线：20ms 满分，250ms 归零，中间线性', () => {
  assert.equal(S.linearDown(20, S.CURVES.latency), 1);
  assert.equal(S.linearDown(250, S.CURVES.latency), 0);
  assert.equal(S.linearDown(500, S.CURVES.latency), 0, '超过最差值不加负分，夹到 0');
  assert.equal(S.linearDown(135, S.CURVES.latency), 0.5, '(135-20)/(250-20)=0.5 → 半分');
});

test('没测量就没有分数：不给"默认满分"', () => {
  const out = S.scoreQuality({});
  assert.equal(out.score, null);
  assert.equal(out.measured, false);
  assert.match(out.reasons[0], /未测量/);
  const out2 = S.scoreQuality({ rtt: null, packetLoss: null, jitter: null });
  assert.equal(out2.score, null);
});

test('缺项不参与计分，权重按剩余项归一', () => {
  // 只有延迟可用（24ms）：延迟得分 = 1-(24-20)/230 ≈ 0.9826 → 归一后就是它自己
  const out = S.scoreQuality({ rtt: 24 });
  assert.equal(out.measured, true);
  assert.equal(out.parts.loss, null);
  assert.deepEqual(Object.keys(out.weightsUsed), ['latency'], '只有延迟参与计分');
  assert.equal(out.score, 98);
  assert.ok(out.reasons.some((r) => r.startsWith('未测量：丢包')));
});

test('四项齐全时的加权总分（手算）', () => {
  // 延迟 135ms → 0.5；丢包 5% → 0.5；抖动 41ms → 0.5；可靠性 1 → 1
  const out = S.scoreQuality({ rtt: 135, packetLoss: 0.05, jitter: 41 }, { reliability: 1 });
  assert.equal(out.parts.latency, 0.5);
  assert.equal(out.parts.loss, 0.5);
  assert.equal(out.parts.jitter, 0.5);
  assert.equal(out.score, Math.round((0.5 * 45 + 0.5 * 30 + 0.5 * 15 + 1 * 10) / 100 * 100), '加权后 55 分');
  assert.equal(out.score, 55);
});

test('权重可配置：只关心延迟时，丢包差不影响分数', () => {
  const onlyLatency = { latency: 100, loss: 0, jitter: 0, reliability: 0 };
  const good = S.scoreQuality({ rtt: 30, packetLoss: 0.09, jitter: 70 }, { weights: onlyLatency, reliability: 0 });
  const bad = S.scoreQuality({ rtt: 200, packetLoss: 0, jitter: 0 }, { weights: onlyLatency, reliability: 1 });
  assert.ok(good.score > bad.score, '权重只在延迟时，30ms 应优于 200ms');
  assert.deepEqual(Object.keys(good.weightsUsed), ['latency'], '权重为 0 的项不参与计分');
});

test('可靠性未知时不参与计分（不假设它是满分）', () => {
  const withRel = S.scoreQuality({ rtt: 20 }, { reliability: 0.5 });
  const without = S.scoreQuality({ rtt: 20 });
  assert.equal(withRel.score, 91, '(45*1 + 10*0.5)/55 → 0.909');
  assert.equal(without.score, 100, '只有延迟且满分 → 100');
  assert.equal(without.parts.reliability, null);
  assert.ok(without.reasons.some((r) => r === '未测量：可靠性'));
});

test('候选排序：分数高的在前，未测量的排最后', () => {
  const ranked = S.rankCandidates([
    { id: 'relay', quality: { rtt: 45, packetLoss: 0, jitter: 4 } },
    { id: 'steam', quality: {} },                                   // 未测量
    { id: 'direct', quality: { rtt: 18, packetLoss: 0, jitter: 1 } },
  ]);
  assert.deepEqual(ranked.map((r) => r.id), ['direct', 'relay', 'steam']);
  assert.equal(ranked[0].score, 100);
  assert.equal(ranked[2].score, null);
  assert.equal(ranked[2].name, 'steam', '没有 name 时退回 id');
});

test('同分保持输入顺序（稳定），便于界面可预期', () => {
  const ranked = S.rankCandidates([
    { id: 'a', quality: { rtt: 20 } },
    { id: 'b', quality: { rtt: 20 } },
    { id: 'c', quality: { rtt: 20 } },
  ]);
  assert.deepEqual(ranked.map((r) => r.id), ['a', 'b', 'c']);
});

test('全 0 权重时不硬凑分数，如实返回未测量', () => {
  const out = S.scoreQuality({ rtt: 20 }, { weights: { latency: 0, loss: 0, jitter: 0, reliability: 0 } });
  assert.equal(out.score, null);
  assert.equal(out.measured, false);
  assert.match(out.reasons[0], /权重都为 0/);
});

test('原因文本可读：延迟/丢包/抖动/可靠性各一条', () => {
  const out = S.scoreQuality({ rtt: 24, packetLoss: 0.0012, jitter: 3 }, { reliability: 0.98 });
  assert.deepEqual(out.reasons, ['延迟 24ms', '丢包 0.12%', '抖动 3ms', '可靠性 98%']);
});
