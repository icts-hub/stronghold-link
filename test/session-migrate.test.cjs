'use strict';
// 网络 PHASE 9/10（会话内迁移接线）单测：用假 provider 对验证动作顺序、端口接管与回滚。
// 不碰真实端口；真实双通道切换需两台机器（见 docs/跨机验证手册.md）。

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { SessionManager } = require('../network/session.cjs');

function fakeProvider(id, { failStart = false, state = 'ready' } = {}) {
  const calls = [];
  const provider = {
    id,
    calls,
    getState: () => (provider.started ? state : 'stopped'),
    started: false,
    async start(options) {
      calls.push({ op: 'start', port: (options && options.port) || null });
      if (failStart) { const err = new Error(id + ' 绑定失败'); throw err; }
      provider.started = true;
    },
    async stop() { calls.push({ op: 'stop' }); provider.started = false; },
  };
  return provider;
}

function makeSession({ enabled = true, standby = 'relay' } = {}) {
  const sm = new SessionManager({ appDir: path.resolve(__dirname, '..') });
  sm.routePolicy = { enabled, standby, degradeBelow: 55, switchMargin: 12, minObservationMs: 4000, cooldownMs: 15000 };
  sm.state = 'running';        // 备用决策要求"会话在运行"，否则按设计拒绝
  return sm;
}

function attach(sm, { currentOpts = {}, standbyOpts = {} } = {}) {
  const current = fakeProvider('local-tcp-host', currentOpts);
  const standby = fakeProvider('sl-relay-host', standbyOpts);
  current.started = true;
  standby.started = true;
  sm.channels = [
    { provider: current, listen: { host: '0.0.0.0', port: 8081 }, standby: false },
    { provider: standby, listen: { host: '0.0.0.0', port: 0 }, standby: true },
  ];
  return { current, standby };
}

test('备用决策：策略关闭时永远不建，并说明是默认关闭', () => {
  const sm = makeSession({ enabled: false });
  const out = sm.planStandbyChannel([{ id: 'sl-relay-host', kind: 'relay', available: true }]);
  assert.equal(out.create, false);
  assert.match(out.reason, /未启用（默认）/);
});

test('备用决策：策略启用且有中继候选时决定建立', () => {
  const sm = makeSession({ enabled: true, standby: 'relay' });
  const out = sm.planStandbyChannel([{ id: 'sl-relay-host', kind: 'relay', available: true }]);
  assert.equal(out.create, true);
  assert.equal(out.provider, 'sl-relay-host');
});

test('没有备用通道时：拒绝切换、不做任何动作、写入 warn 日志', () => {
  const sm = makeSession();
  const { current } = attach(sm);
  sm.channels = sm.channels.filter((c) => c.standby !== true);
  return sm.migrateToStandby().then((out) => {
    assert.equal(out.ok, false);
    assert.match(out.reason, /没有备用通道/);
    assert.deepEqual(current.calls, [], '拒绝时不能动通道');
  });
});

test('切换成功：先停主 → 备绑同一端口 → 验证 → 提升，通道标记互换', async () => {
  const sm = makeSession();
  const { current, standby } = attach(sm);
  const out = await sm.migrateToStandby();
  assert.equal(out.ok, true);
  assert.deepEqual(out.steps, ['stop-channel', 'bind-channel', 'verify-channel', 'promote-channel']);
  assert.deepEqual(current.calls.map((c) => c.op), ['stop']);
  assert.deepEqual(standby.calls.map((c) => c.op), ['start']);
  assert.equal(standby.calls[0].port, 8081, '备用必须接管主通道的入口端口');
  assert.equal(sm.channels[1].standby, false, '备用提升为当前');
  assert.equal(sm.channels[0].standby, true, '原主通道降为备用');
});

test('切换失败：回滚到原端口，结果里如实标 rolledBack', async () => {
  const sm = makeSession();
  const { current } = attach(sm, { standbyOpts: { failStart: true } });
  const out = await sm.migrateToStandby();
  assert.equal(out.ok, false);
  assert.match(out.reason, /绑定失败/);
  assert.equal(out.rolledBack, true);
  assert.deepEqual(current.calls.map((c) => [c.op, c.port]), [['stop', null], ['start', 8081]], '回滚要把原通道按原端口拉起');
});

test('回滚也失败：如实标注两条通道可能都不可用，不谎报成功', async () => {
  const sm = makeSession();
  const current = fakeProvider('local-tcp-host');
  current.started = true;
  current.start = async () => { throw new Error('原端口已被占用，回滚失败'); };   // 回滚时拉不起来
  const standby = fakeProvider('sl-relay-host', { failStart: true });           // 切换本身就失败
  standby.started = true;
  sm.channels = [
    { provider: current, listen: { port: 8081 }, standby: false },
    { provider: standby, listen: { port: 0 }, standby: true },
  ];
  const out = await sm.migrateToStandby();
  assert.equal(out.ok, false);
  assert.equal(out.rolledBack, false);
  assert.match(out.rollbackError, /回滚失败/);
});

test('策略关闭时拒绝切换（不接受切换期中断），不动通道', async () => {
  const sm = makeSession({ enabled: false });
  const { current, standby } = attach(sm);
  const out = await sm.migrateToStandby();
  assert.equal(out.ok, false);
  assert.match(out.reason, /不接受切换期中断/);
  assert.deepEqual(current.calls, []);
  assert.deepEqual(standby.calls, []);
});

test('没有备用通道时 _channelDescriptors 不会误标', () => {
  const sm = makeSession();
  attach(sm);
  const desc = sm._channelDescriptors();
  assert.equal(desc.length, 2);
  assert.equal(desc.filter((d) => d.standby).length, 1);
  assert.equal(desc[0].port, 8081);
  assert.equal(desc[0].provider, 'local-tcp-host');
});
