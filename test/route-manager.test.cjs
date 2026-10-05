'use strict';
// 网络 PHASE 5（RouteManager）单测：观察窗、冷却、滞回、防抖、事件与原因。
// 用可控时钟喂"质量曲线"，验证决策而不是靠感觉。

const test = require('node:test');
const assert = require('node:assert');

const M = require('../network/route/manager.cjs');

function setup({ policy = {}, candidates = ['direct', 'steam', 'relay'] } = {}) {
  let clock = 1_000_000;
  const events = [];
  const mgr = M.createRouteManager({
    policy: { minObservationMs: 4000, cooldownMs: 15000, degradeBelow: 55, switchMargin: 12, ...policy },
    now: () => clock,
  });
  mgr.onEvent((ev) => events.push(ev));
  mgr.setCandidates(candidates.map((id) => ({ id, name: id.toUpperCase() })));
  return { mgr, events, advance: (ms) => { clock += ms; return clock; }, at: () => clock };
}

const good = { rtt: 18, packetLoss: 0, jitter: 1 };      // ≈100 分
const bad = { rtt: 240, packetLoss: 0.08, jitter: 70 };  // ≈0 分

test('初始选路：没有当前路径时选分数最高的已测量候选', () => {
  const { mgr, events } = setup();
  mgr.update('steam', { rtt: 60 });
  mgr.update('direct', good);
  const decision = mgr.tick();
  assert.equal(decision.action, 'select');
  assert.equal(decision.to, 'direct');
  assert.equal(mgr.snapshot().current, 'direct');
  assert.ok(events.some((e) => e.type === 'route-changed' && e.reason === 'no-current-route'));
});

test('全部候选未测量：不选、如实说明', () => {
  const { mgr } = setup();
  mgr.update('direct', {});
  const decision = mgr.tick();
  assert.equal(decision.action, 'hold');
  assert.match(decision.reason, /全部未测量/);
  assert.equal(mgr.snapshot().current, null);
});

test('劣化要在最小观察窗之后才允许切换（观察期内不动）', () => {
  const { mgr, advance } = setup();
  mgr.update('direct', good);
  mgr.update('steam', good);
  mgr.tick();                                  // 选中 direct

  mgr.update('direct', bad);                   // 开始劣化
  const d1 = mgr.tick();
  assert.equal(d1.action, 'degrade');
  assert.equal(mgr.snapshot().state, 'degraded');

  advance(2000);
  const d2 = mgr.tick();
  assert.equal(d2.action, 'hold');
  assert.match(d2.reason, /劣化观察中/);

  advance(2500);                               // 累计 4500ms > 4000ms
  const d3 = mgr.tick();
  assert.equal(d3.action, 'switch');
  assert.equal(d3.to, 'steam');
});

test('冷却期内不再切换（防止刚切完又切走）', () => {
  const { mgr, advance } = setup();
  mgr.update('direct', good);
  mgr.update('steam', good);
  mgr.tick();

  mgr.update('direct', bad);
  mgr.tick();
  advance(4500);
  assert.equal(mgr.tick().action, 'switch');    // direct → steam
  assert.equal(mgr.snapshot().routeChanges, 2);

  // 刚切完就把当前路径弄差，冷却期内必须按住
  mgr.update('steam', bad);
  mgr.tick();
  advance(4500);
  const held = mgr.tick();
  assert.equal(held.action, 'hold');
  assert.match(held.reason, /冷却中/);

  mgr.update('direct', good);                   // direct 恢复：此时才存在"更优的候选"
  advance(11000);                               // 累计 > 15s 冷却
  const after = mgr.tick();
  assert.equal(after.action, 'switch');
  assert.equal(after.to, 'direct', '冷却结束后切回更优的候选');
});

test('滞回：备选优势不足 switchMargin 时不切（避免来回抖）', () => {
  const { mgr, advance } = setup();
  mgr.update('direct', { rtt: 20 });            // 100 分：确保初始选 direct
  mgr.update('steam', { rtt: 135 });            // 50 分
  mgr.tick();
  assert.equal(mgr.snapshot().current, 'direct', '构造条件：初始当前路径是 direct');

  mgr.update('direct', { rtt: 130 });           // 52 分：低于阈值 55，但只比 steam 高 2 分
  assert.ok(mgr.snapshot().currentScore !== null);
  mgr.tick();
  advance(4500);
  const decision = mgr.tick();
  assert.equal(decision.action, 'hold');
  assert.match(decision.reason, /备选优势不足/);
});

test('来回抖动的曲线不会造成反复切换', () => {
  const { mgr, advance } = setup();
  mgr.update('direct', good);
  mgr.update('steam', { rtt: 40 });
  mgr.tick();
  const before = mgr.snapshot().routeChanges;

  // 模拟 20 秒内延迟锯齿：好 1 秒、差 1 秒，交替
  for (let i = 0; i < 10; i += 1) {
    mgr.update('direct', i % 2 === 0 ? good : bad);
    mgr.tick();
    advance(1000);
  }
  const after = mgr.snapshot().routeChanges;
  assert.ok(after - before <= 1, '20 秒内最多切一次，实际 ' + (after - before) + ' 次');
});

test('恢复：当前路径回到阈值以上会发出 route-recovered', () => {
  const { mgr, advance, events } = setup();
  mgr.update('direct', good);
  mgr.update('steam', good);
  mgr.tick();
  mgr.update('direct', bad);
  mgr.tick();
  advance(1000);
  mgr.update('direct', good);
  mgr.tick();
  assert.ok(events.some((e) => e.type === 'route-recovered'), '应记录恢复事件');
  assert.equal(mgr.snapshot().state, 'connected');
});

test('当前路径未测量也算劣化，且只有已测量的备选能被选中', () => {
  const { mgr, advance } = setup();
  mgr.setCurrent('direct');
  mgr.update('direct', {});                     // 未测量
  mgr.update('steam', {});                      // 未测量
  const d1 = mgr.tick();
  assert.equal(d1.action, 'degrade');
  advance(4500);
  const d2 = mgr.tick();
  assert.equal(d2.action, 'hold', '没有已测量的备选就不能切');
  assert.match(d2.reason, /没有其它已测量的候选/);

  mgr.update('steam', good);
  const d3 = mgr.tick();
  assert.equal(d3.action, 'switch');
  assert.equal(d3.to, 'steam');
});

test('切换事件如实标注「重建传输」，不假装无缝迁移', () => {
  const { mgr, advance, events } = setup();
  mgr.update('direct', good);
  mgr.update('steam', good);
  mgr.tick();
  mgr.update('direct', bad);
  mgr.tick();
  advance(4500);
  mgr.tick();
  const switched = events.filter((e) => e.type === 'route-changed' && e.from);
  assert.equal(switched.length, 1);
  assert.equal(switched[0].transportRebuilt, true);
  assert.match(switched[0].reason, /劣化切换/);
});

test('快照带策略、排名与事件日志，供界面直接展示', () => {
  const { mgr } = setup({ policy: { degradeBelow: 60 } });
  mgr.update('direct', good);
  mgr.update('steam', { rtt: 90 });
  mgr.tick();
  const snap = mgr.snapshot();
  assert.equal(snap.policy.degradeBelow, 60);
  assert.deepEqual(snap.ranking.map((r) => r.id), ['direct', 'steam']);
  assert.ok(Array.isArray(snap.log) && snap.log.length >= 1);
  assert.equal(snap.routeChanges, 1);
});

test('订阅者可退订，异常订阅者不影响决策', () => {
  const { mgr } = setup();
  const seen = [];
  const off = mgr.onEvent((ev) => seen.push(ev.type));
  mgr.onEvent(() => { throw new Error('订阅者自己炸了'); });
  mgr.update('direct', good);
  mgr.tick();
  assert.ok(seen.includes('route-changed'));
  off();
  const before = seen.length;
  mgr.update('direct', bad);
  mgr.tick();
  assert.equal(seen.length, before, '退订后不再收到');
  assert.throws(() => mgr.onEvent(null), /需要函数/);
});
