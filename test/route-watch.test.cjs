'use strict';
// 网络 PHASE 9/10（中继路由监看）单测：注入测量函数，验证"有样本才写分、没样本不造数"。

const test = require('node:test');
const assert = require('node:assert');

const { createRelayRouteWatch, defaultCandidates } = require('../network/route/watch.cjs');

function fakeTimers() {
  const handles = [];
  return {
    handles,
    timers: {
      setInterval: (fn, ms) => { const h = { fn, ms, cleared: false }; handles.push(h); return h; },
      clearInterval: (h) => { if (h) h.cleared = true; },
    },
  };
}

test('候选清单：中继可实测，其余如实列出（未测量由 RouteManager 处理）', () => {
  const ids = defaultCandidates().map((c) => c.id);
  assert.ok(ids.includes('sl-relay-host'));
  assert.ok(ids.includes('steam-p2p-host'));
  assert.ok(ids.includes('direct-udp-host'));
});

test('测到真实样本：写入分数并记录范围与说明', async () => {
  const { timers } = fakeTimers();
  let calls = 0;
  const watch = createRelayRouteWatch({
    timers,
    measure: async () => { calls += 1; return { measured: true, rtt: 1, jitter: 0.5, packetLoss: 0, samples: 4, scope: 'loopback' }; },
  });
  const out = await watch.poll();
  assert.equal(calls, 2, '两个中继候选各探测一次');
  assert.equal(out.decision.action, 'select');
  const snap = watch.snapshot();
  assert.equal(snap.current, 'sl-relay-host');
  assert.equal(snap.currentScore, 100);
  assert.equal(snap.measurement.ok, true);
  assert.equal(snap.measurement.last.rtt, 1);
  assert.equal(snap.scope, 'loopback');
  assert.match(snap.note, /真实起一次本机中继/);
  assert.equal(snap.probeFailures, 0);
});

test('没测到样本：不写分数、计数失败，未测量候选不会被当成 0 分踢掉', async () => {
  const { timers } = fakeTimers();
  const watch = createRelayRouteWatch({
    timers,
    measure: async () => ({ measured: false, reason: '入会超时' }),
  });
  await watch.poll();
  const snap = watch.snapshot();
  assert.equal(snap.measurement.ok, false);
  // 注意两个计数器含义不同：probeFailures 统计"探测抛异常"，
  // measurement.failures 统计"这一轮没拿到可用样本"（本次属于后者）
  assert.equal(snap.measurement.failures, 2, '两个候选各没测到一次');
  assert.equal(snap.probeFailures, 0, '没有异常抛出，抛异常计数为 0');
  assert.equal(snap.current, null, '没有样本就不该选出路径');
  assert.equal(snap.ranking.length, 0, '未测量不参与排名');
  assert.ok(snap.unmeasuredReasons['steam-p2p-host'], '未测量的原因要给出来');
});

test('measure 抛异常：当轮跳过并计数，不崩监看', async () => {
  const { timers } = fakeTimers();
  const watch = createRelayRouteWatch({ timers, measure: async () => { throw new Error('临时端口耗尽'); } });
  const out = await watch.poll();
  assert.deepEqual(out.measured, []);
  const snap = watch.snapshot();
  assert.equal(snap.measurement.failures, 2, '异常被监看层接住并计数，不崩');
  assert.equal(snap.measurement.ok, false);
  assert.equal(snap.running, false);
});

test('start 立即探测并注册定时器，stop 清理定时器且不再增加轮次', async () => {
  const { timers, handles } = fakeTimers();
  let calls = 0;
  const watch = createRelayRouteWatch({
    timers,
    intervalMs: 15000,
    measure: async () => { calls += 1; return { measured: true, rtt: 2, jitter: 0, packetLoss: 0, samples: 2 }; },
  });
  watch.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(handles.length, 1);
  assert.equal(handles[0].ms, 15000, '默认间隔 15 秒，避免每轮都起服务端');
  const pollsAfterStart = watch.snapshot().polls;
  assert.ok(pollsAfterStart >= 1, 'start 应立即探测一次');

  watch.stop();
  assert.equal(handles[0].cleared, true);
  assert.equal(watch.snapshot().running, false);
  assert.equal(watch.snapshot().polls, pollsAfterStart, '停止后不应再增加轮次');
  assert.equal(calls >= 2, true);
});
