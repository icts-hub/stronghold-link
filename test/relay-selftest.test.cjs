'use strict';
// 网络 PHASE 8（中继自检）单测：真实回环测量必须给出真实数字，失败路径不返回估算值。

const test = require('node:test');
const assert = require('node:assert');

const { runRelaySelfTest } = require('../network/relay/selftest.cjs');

test('自检通过：给出真实 RTT/抖动/丢包与投递结果（本机应很小）', async () => {
  const out = await runRelaySelfTest({ pings: 6 });
  assert.equal(out.ok, true, '本机自检必须能通过，失败原因：' + out.reason);
  assert.equal(out.measured, true);
  assert.equal(out.scope, 'loopback', '必须标明是本机回环测量');
  assert.ok(out.samples >= 6, '样本数应达到 6，实际 ' + out.samples);
  assert.ok(out.rtt !== null && out.rtt >= 0 && out.rtt < 200, '本机 RTT 应很小，实际 ' + out.rtt);
  assert.ok(out.rttMax >= out.rtt, '最大不应小于中位数');
  assert.ok(out.jitter !== null);
  assert.equal(out.delivered, 1, '真实投递必须成功，而不是只测心跳');
  assert.equal(out.forwarded >= 1, true, '服务端应记录到转发');
  assert.ok(out.serverPort > 0);
});

test('自检的说明必须写清适用范围与加密边界（避免被当成跨公网数据或端到端加密）', async () => {
  const out = await runRelaySelfTest({ pings: 3 });
  assert.ok(out.notes.some((n) => n.includes('本机回环')), '要说明只反映本机链路');
  assert.ok(out.notes.some((n) => n.includes('不加密载荷')), '要说明中继不加密载荷');
});

test('自检结束后不留端口与句柄（可连续跑两次且端口不同）', async () => {
  const first = await runRelaySelfTest({ pings: 2 });
  const second = await runRelaySelfTest({ pings: 2 });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(first.serverPort, second.serverPort, '每次应是新起的临时端口');
});

test('自检不会永远挂着：即使心跳全超时也能返回并如实说明', async () => {
  const started = Date.now();
  const out = await runRelaySelfTest({ pings: 1, timeoutMs: 1 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 15000, '自检必须有界，实际 ' + elapsed + 'ms');
  assert.equal(typeof out.ok, 'boolean');
  if (!out.ok) {
    assert.equal(out.reason !== null, true, '失败必须给原因');
    assert.equal(out.rtt, null, '失败时不能返回延迟数字');
  }
});
