'use strict';
// 网络 PHASE 9/10（迁移动作计划）单测：顺序、同端口、回滚清单与拒绝条件。

const test = require('node:test');
const assert = require('node:assert');

const M = require('../network/route/migrate.cjs');

const current = { id: 'c-main', provider: 'local-tcp-host', port: 8081, ready: true };
const standby = { id: 'c-standby', provider: 'sl-relay-host', port: 0, ready: true };

test('同端口接管：先停主 → 绑备到同端口 → 验证 → 提升，顺序不能反', () => {
  const plan = M.planMigration({ current, standby });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.steps.map((s) => s.action), [
    M.STEPS.STOP, M.STEPS.BIND, M.STEPS.VERIFY, M.STEPS.PROMOTE,
  ]);
  assert.equal(plan.targetPort, 8081, '备用要接管主通道的入口端口');
  assert.equal(plan.steps[0].channel, 'c-main');
  assert.equal(plan.steps[1].port, 8081);
});

test('不同端口时按备用自己的端口，不动主通道端口', () => {
  const plan = M.planMigration({ current, standby: { ...standby, port: 9000 }, samePort: false });
  assert.equal(plan.targetPort, 9000);
});

test('回滚清单：把原主通道重新绑回原端口并验证', () => {
  const plan = M.planMigration({ current, standby });
  assert.deepEqual(plan.rollback.map((s) => s.action), [M.STEPS.BIND, M.STEPS.VERIFY]);
  assert.equal(plan.rollback[0].channel, 'c-main');
  assert.equal(plan.rollback[0].port, 8081);
  assert.ok(plan.notes.some((n) => n.includes('回滚失败必须如实报错')));
});

test('必须写明"会中断、需要重连"，不假装无缝迁移', () => {
  const plan = M.planMigration({ current, standby });
  assert.ok(plan.notes.some((n) => n.includes('客户端需要重连')), '计划里必须有这句');
  const text = M.describeMigration(plan);
  assert.match(text, /不承诺无缝迁移/);
  assert.match(text, /1\. stop-channel/, '文本要按序号列出动作');
});

test('拒绝条件：没有备用 / 没有当前 / 同一提供方 / 备用未就绪 / 不接受中断', () => {
  assert.match(M.planMigration({ current, standby: null }).reason, /没有备用通道/);
  assert.match(M.planMigration({ current: null, standby }).reason, /没有当前通道/);
  assert.match(M.planMigration({ current, standby: { ...standby, provider: 'local-tcp-host' } }).reason, /同一个提供方/);
  assert.match(M.planMigration({ current, standby: { ...standby, ready: false } }).reason, /尚未就绪/);
  assert.match(M.planMigration({ current, standby, allowInterrupt: false }).reason, /不接受切换期中断/);
});

test('同端口接管但缺端口信息：拒绝而不是随便挑一个端口', () => {
  const plan = M.planMigration({
    current: { id: 'a', provider: 'x', port: null, ready: true },
    standby: { id: 'b', provider: 'y', port: null, ready: true },
  });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /需要已知入口端口/);
  assert.deepEqual(plan.steps, [], '拒绝时不能给出半截动作清单');
});

test('所有拒绝路径都不返回动作清单（避免被误执行）', () => {
  const rejects = [
    M.planMigration({ current, standby: null }),
    M.planMigration({ current: null, standby }),
    M.planMigration({ current, standby: { ...standby, ready: false } }),
    M.planMigration({ current, standby, allowInterrupt: false }),
  ];
  for (const r of rejects) {
    assert.equal(r.ok, false);
    assert.deepEqual(r.steps, []);
    assert.deepEqual(r.rollback, []);
    assert.ok(r.reason && r.reason.length > 4, '必须给出原因');
  }
});
