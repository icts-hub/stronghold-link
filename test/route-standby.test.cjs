'use strict';
// 网络 PHASE 9/10（备用通道决策）单测：默认不建、条件不满足一律说明原因、不静默降级。

const test = require('node:test');
const assert = require('node:assert');

const { planStandby } = require('../network/route/standby.cjs');

const RELAY = [{ id: 'sl-relay-host', kind: 'relay', available: true }];

test('默认策略（未启用）：不建备用通道，理由写明是默认关闭', () => {
  const out = planStandby({ policy: null, candidates: RELAY });
  assert.equal(out.create, false);
  assert.equal(out.provider, null);
  assert.match(out.reason, /未启用（默认）/);
});

test('启用但 standby=none：不建，并说明是策略没要求', () => {
  const out = planStandby({ policy: { enabled: true, standby: 'none' }, candidates: RELAY });
  assert.equal(out.create, false);
  assert.match(out.reason, /策略未要求/);
});

test('启用 relay 且有可用候选：决定建立，并带出两条必须说明的事项', () => {
  const out = planStandby({ policy: { enabled: true, standby: 'relay' }, candidates: RELAY });
  assert.equal(out.create, true);
  assert.equal(out.provider, 'sl-relay-host');
  assert.match(out.reason, /按策略建立备用通道/);
  assert.ok(out.notes.some((n) => n.includes('不暴露给客户端')), '要说明备用不外露');
  assert.ok(out.notes.some((n) => n.includes('需要重连')), '要说明切换会断连');
});

test('会话未运行：不建（没有主通道可依附）', () => {
  const out = planStandby({ policy: { enabled: true, standby: 'relay' }, candidates: RELAY, sessionRunning: false });
  assert.equal(out.create, false);
  assert.match(out.reason, /会话未运行/);
});

test('已有备用通道：不重复建（默认上限 1）', () => {
  const out = planStandby({
    policy: { enabled: true, standby: 'relay' },
    candidates: RELAY,
    channels: [{ id: 'c1', provider: 'local-tcp-host' }, { id: 'c2', provider: 'sl-relay-joiner', standby: true }],
  });
  assert.equal(out.create, false);
  assert.match(out.reason, /已存在备用通道/);
});

test('同一提供方已经当主通道：不能拿它当备（等于没备）', () => {
  const out = planStandby({
    policy: { enabled: true, standby: 'relay' },
    candidates: RELAY,
    channels: [{ id: 'c1', provider: 'sl-relay-host' }],
  });
  assert.equal(out.create, false);
  assert.match(out.reason, /没有可用的 relay 候选/);
});

test('候选不可用：不建，并把不可用原因带出来供界面显示', () => {
  const out = planStandby({
    policy: { enabled: true, standby: 'relay' },
    candidates: [{ id: 'sl-relay-host', kind: 'relay', available: false, unavailableReason: '服务端尚未部署公网实例' }],
  });
  assert.equal(out.create, false);
  assert.match(out.reason, /没有可用的 relay 候选/);
  assert.ok(out.notes.some((n) => n.includes('尚未部署公网实例')), '不可用原因要带出来');
});

test('需要端口可达的候选在不可达时不作备用（如实排除）', () => {
  const out = planStandby({
    policy: { enabled: true, standby: 'relay' },
    candidates: [{ id: 'sl-relay-host', kind: 'relay', available: true, capabilities: { requiresReachablePort: true }, reachable: false }],
  });
  assert.equal(out.create, false, '需要可达端口但不可达的候选不能静默当备用');
});

test('未知备用模式：不建并如实报错，不猜', () => {
  const out = planStandby({ policy: { enabled: true, standby: 'magic' }, candidates: RELAY });
  assert.equal(out.create, false);
  assert.match(out.reason, /策略未要求|未知的备用模式/);
});
