'use strict';
// 网络 PHASE 9/10（路由监督器）单测：可控时钟 + 假定时器，验证监控、切换事件与探测失败处理。

const test = require('node:test');
const assert = require('node:assert');

const { createRouteSupervisor, ROUTE_CHANGED } = require('../network/route/supervisor.cjs');
const { createRouteManager } = require('../network/route/manager.cjs');

const good = { rtt: 18, packetLoss: 0, jitter: 1, measured: true };
const bad = { rtt: 240, packetLoss: 0.08, jitter: 70, measured: true };

function harness({ intervalMs = 1000, policy = {} } = {}) {
  let clock = 1_000_000;
  const intervals = [];
  const timers = {
    setInterval: (fn, ms) => { const h = { fn, ms, cleared: false }; intervals.push(h); return h; },
    clearInterval: (h) => { if (h) h.cleared = true; },
  };
  const manager = createRouteManager({ policy: { minObservationMs: 2000, cooldownMs: 5000, degradeBelow: 55, switchMargin: 12, ...policy }, now: () => clock });
  const changed = [];
  const supervisor = createRouteSupervisor({
    manager,
    intervalMs,
    timers,
    now: () => clock,
    onRouteChanged: (ev) => changed.push(ev),
  });
  return { supervisor, manager, intervals, changed, advance: (ms) => { clock += ms; }, at: () => clock };
}

test('候选注册与首轮探测：立即跑一次并把有样本的候选喂进决策', async () => {
  const h = harness();
  h.supervisor.manager.setCandidates([{ id: 'relay' }, { id: 'direct' }]);
  let calls = 0;
  const sup = createRouteSupervisor({
    manager: h.manager, intervalMs: 1000, timers: { setInterval: (f) => ({ fn: f }), clearInterval: () => {} },
    now: () => 1_000_000,
    sources: [{ id: 'relay', probe: async () => { calls += 1; return good; } }],
  });
  const out = await sup.poll();
  assert.equal(calls, 1);
  assert.deepEqual(out.measured, ['relay']);
  assert.equal(out.decision.action, 'select', '第一次决策应为初始选路');
  assert.equal(sup.snapshot().current, 'relay');
  assert.equal(sup.snapshot().polls, 1);
});

test('探测失败或没有样本：跳过这一轮，不写 0 也不改状态', async () => {
  const manager = createRouteManager({ now: () => 1_000_000 });
  const sup = createRouteSupervisor({
    manager,
    sources: [
      { id: 'a', probe: async () => { throw new Error('探测不可用'); } },
      { id: 'b', probe: async () => ({ measured: false }) },
    ],
    timers: { setInterval: (f) => ({ fn: f }), clearInterval: () => {} },
    now: () => 1_000_000,
  });
  const out = await sup.poll();
  assert.deepEqual(out.measured, [], '没有样本就不能喂数据');
  assert.equal(sup.snapshot().probeFailures, 1);
  assert.equal(manager.scoreOf('a'), null, '不能因为探测失败就给 0 分');
  assert.equal(manager.scoreOf('b'), null);
});

test('监控到劣化 → 观察窗过后切换，并抛出 NETWORK_ROUTE_CHANGED', async () => {
  const h = harness();
  const quality = { relay: bad, direct: good };
  const sup = createRouteSupervisor({
    manager: h.manager,
    intervalMs: 1000,
    timers: { setInterval: (f) => ({ fn: f }), clearInterval: () => {} },
    now: () => h.at(),
    candidates: [{ id: 'relay', name: 'RELAY' }, { id: 'direct', name: 'DIRECT' }],
    sources: Object.keys(quality).map((id) => ({ id, probe: async () => quality[id] })),
    onRouteChanged: (ev) => h.changed.push(ev),
  });

  await sup.poll();
  assert.equal(sup.snapshot().current, 'direct', '初始应选分数高的 direct');

  // 把 direct 弄差、relay 变好：应切回
  quality.direct = bad;
  quality.relay = good;
  await sup.poll();                                   // 进入劣化观察
  assert.equal(sup.snapshot().state, 'degraded');

  h.advance(2500);                                    // 超过最小观察窗
  await sup.poll();
  const snap = sup.snapshot();
  assert.equal(snap.current, 'relay', '应切换到恢复的 relay');
  assert.equal(snap.events.length, 1, '应抛出一次切换事件');
  const ev = snap.events[0];
  assert.equal(ev.type, ROUTE_CHANGED);
  assert.equal(ev.from, 'direct');
  assert.equal(ev.to, 'relay');
  assert.equal(ev.transportRebuilt, true, '必须标注是重建传输，不是无缝迁移');
  // 注意：harness 已给同一个 manager 挂了监听，所以这里只断言"回调确实被触发"
  assert.ok(h.changed.length >= 1, '订阅回调也要收到');
});

test('冷却期内不会连续切换：多次探测只产生一次事件', async () => {
  const h = harness();
  const quality = { relay: good, direct: bad };
  const sup = createRouteSupervisor({
    manager: h.manager,
    intervalMs: 1000,
    timers: { setInterval: (f) => ({ fn: f }), clearInterval: () => {} },
    now: () => h.at(),
    candidates: [{ id: 'relay' }, { id: 'direct' }],
    sources: Object.keys(quality).map((id) => ({ id, probe: async () => quality[id] })),
  });
  await sup.poll();
  assert.equal(sup.snapshot().current, 'relay');

  for (let i = 0; i < 6; i += 1) {
    quality.relay = bad; quality.direct = good;        // 反复横跳
    h.advance(1000);
    await sup.poll();
  }
  const snap = sup.snapshot();
  assert.ok(snap.events.length <= 1, '冷却期内最多切一次，实际 ' + snap.events.length + ' 次');
});

test('start 注册定时器并可 stop 清理；running 状态准确', async () => {
  const h = harness({ intervalMs: 1000 });
  const sup = createRouteSupervisor({
    manager: h.manager,
    intervalMs: 1000,
    timers: { setInterval: (f, ms) => { const o = { f, ms, cleared: false }; h.intervals.push(o); return o; }, clearInterval: (o) => { o.cleared = true; } },
    now: () => h.at(),
    candidates: [{ id: 'relay' }],
    sources: [{ id: 'relay', probe: async () => good }],
  });
  sup.start();
  assert.equal(sup.running, true);
  assert.equal(h.intervals.length, 1);
  assert.equal(h.intervals[0].ms, 1000);
  assert.equal(sup.snapshot().polls, 1, 'start 应立即探测一次');

  const stopped = sup.stop();
  assert.equal(stopped.running, false);
  assert.equal(h.intervals[0].cleared, true, '定时器必须被清理');
  assert.equal(sup.start().running, true, '可以再次启动');
  sup.stop();
});

test('快照带出策略与排名，供界面直接展示', async () => {
  const h = harness({ policy: { degradeBelow: 60 } });
  const sup = createRouteSupervisor({
    manager: h.manager,
    timers: { setInterval: (f) => ({ fn: f }), clearInterval: () => {} },
    now: () => h.at(),
    candidates: [{ id: 'relay', name: 'RELAY' }, { id: 'direct', name: 'DIRECT' }],
    sources: [
      { id: 'relay', probe: async () => ({ rtt: 20, packetLoss: 0, jitter: 1, measured: true }) },
      { id: 'direct', probe: async () => ({ rtt: 120, packetLoss: 0, jitter: 4, measured: true }) },
    ],
  });
  await sup.poll();
  const snap = sup.snapshot();
  assert.equal(snap.policy.degradeBelow, 60);
  assert.deepEqual(snap.ranking.map((r) => r.id), ['relay', 'direct'], '排名按分数');
  assert.equal(snap.intervalMs, 5000, '默认间隔');
  assert.equal(snap.probeFailures, 0);
});
