'use strict';
// 网络 PHASE 9/10（策略开关骨架）单测：默认关闭、非法值回落、关闭时不带备用模式。

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const P = require('../network/route/policy.cjs');
const { SessionManager } = require('../network/session.cjs');

test('默认关闭：没传策略时一切保持默认，standby 为 none', () => {
  const p = P.normalizeRoutePolicy(null);
  assert.equal(p.enabled, false, '默认必须是关闭');
  assert.equal(p.standby, 'none');
  assert.equal(p.degradeBelow, 55);
  assert.match(P.describeRoutePolicy(p), /未启用（默认）/);
});

test('只有明确 true 才打开；缺省或假值都不打开', () => {
  for (const input of [undefined, {}, { enabled: 'yes' }, { enabled: 1 }, { enabled: false }]) {
    assert.equal(P.normalizeRoutePolicy(input).enabled, false, JSON.stringify(input) + ' 不应打开开关');
  }
  assert.equal(P.normalizeRoutePolicy({ enabled: true }).enabled, true);
});

test('关闭时不保留备用模式（避免关了开关还留副作用）', () => {
  const off = P.normalizeRoutePolicy({ enabled: false, standby: 'relay' });
  assert.equal(off.standby, 'none');
  const on = P.normalizeRoutePolicy({ enabled: true, standby: 'relay' });
  assert.equal(on.standby, 'relay');
  assert.match(P.describeRoutePolicy(on), /需要重连/, '开启时必须写明切换会中断连接');
});

test('非法参数回落默认并被夹到区间内', () => {
  const p = P.normalizeRoutePolicy({ enabled: true, degradeBelow: 'abc', switchMargin: 999, minObservationMs: -5, cooldownMs: 1e9 });
  assert.equal(p.degradeBelow, 55, '非法值回落默认');
  assert.equal(p.switchMargin, 100, '过大夹到 100');
  assert.equal(p.minObservationMs, 0, '负数夹到 0');
  assert.equal(p.cooldownMs, 600000, '过大夹到上限');
});

test('Session 构造后即持有默认策略，且能读出说明（不改通道行为）', () => {
  const sm = new SessionManager({ appDir: path.resolve(__dirname, '..') });
  const policy = sm.getRoutePolicy();
  assert.equal(policy.enabled, false);
  assert.equal(policy.standby, 'none');
  assert.match(policy.description, /未启用（默认）/);
  assert.equal(sm.state, 'idle', '读取策略不应改变会话状态');
});
