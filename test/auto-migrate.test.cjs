'use strict';
// 网络 PHASE 9/10（自动迁移触发）单测：默认策略下绝不动通道，启用后才尝试迁移。

const test = require('node:test');
const assert = require('node:assert');

const { handleRouteChange } = require('../network/route/auto-migrate.cjs');

const EVENT = { type: 'NETWORK_ROUTE_CHANGED', from: 'local-tcp-host', to: 'sl-relay-host', reason: '劣化切换' };

function fakeSession({ enabled = false, migrateResult = { ok: true, steps: ['stop-channel'] }, throwOnMigrate = false } = {}) {
  const calls = [];
  const logs = [];
  return {
    calls,
    logs,
    getRoutePolicy: () => ({ enabled, standby: enabled ? 'relay' : 'none' }),
    async migrateToStandby() {
      calls.push('migrateToStandby');
      if (throwOnMigrate) throw new Error('迁移内部错误');
      return migrateResult;
    },
    note: (text) => logs.push(text),
  };
}

test('默认策略（未启用）：收到切换事件也不迁移，通道完全不动', async () => {
  const session = fakeSession({ enabled: false });
  const out = await handleRouteChange({ event: EVENT, session, log: () => {} });
  assert.equal(out.handled, true);
  assert.equal(out.attempted, false);
  assert.match(out.reason, /未启用（默认）/);
  assert.deepEqual(session.calls, [], '绝不能调用迁移');
});

test('启用后成功：调用一次迁移并带回动作清单', async () => {
  const session = fakeSession({ enabled: true, migrateResult: { ok: true, steps: ['stop-channel', 'bind-channel'] } });
  const seen = [];
  const out = await handleRouteChange({ event: EVENT, session, log: (m) => seen.push(m) });
  assert.equal(out.migrated, true);
  assert.deepEqual(out.steps, ['stop-channel', 'bind-channel']);
  assert.deepEqual(session.calls, ['migrateToStandby']);
  assert.ok(seen.some((m) => m.includes('客户端需重连')), '日志要写明会中断');
});

test('启用但迁移被拒（例如没有备用通道）：如实返回原因，不抛错', async () => {
  const session = fakeSession({ enabled: true, migrateResult: { ok: false, reason: '没有备用通道可切换' } });
  const out = await handleRouteChange({ event: EVENT, session, log: () => {} });
  assert.equal(out.attempted, true);
  assert.equal(out.migrated, false);
  assert.match(out.reason, /没有备用通道/);
});

test('启用且迁移失败并回滚：结果里带 rolledBack 标记', async () => {
  const session = fakeSession({ enabled: true, migrateResult: { ok: false, reason: '备用绑定失败', rolledBack: true } });
  const out = await handleRouteChange({ event: EVENT, session, log: () => {} });
  assert.equal(out.rolledBack, true);
  assert.match(out.reason, /备用绑定失败/);
});

test('迁移抛错：被接住并如实报告，不让主进程崩', async () => {
  const session = fakeSession({ enabled: true, throwOnMigrate: true });
  const out = await handleRouteChange({ event: EVENT, session, log: () => {} });
  assert.equal(out.error, true);
  assert.match(out.reason, /迁移内部错误/);
});

test('不是切换事件 / 没有会话：不尝试迁移', async () => {
  const a = await handleRouteChange({ event: { type: 'state' }, session: fakeSession({ enabled: true }), log: () => {} });
  assert.equal(a.handled, false);
  const b = await handleRouteChange({ event: EVENT, session: null, log: () => {} });
  assert.equal(b.attempted, false);
  assert.match(b.reason, /没有会话/);
  const c = await handleRouteChange({ event: EVENT, session: { }, log: () => {} });
  assert.match(c.reason, /不支持迁移/);
});

test('getRoutePolicy 抛错时按未启用处理（安全侧兜底）', async () => {
  const session = {
    calls: [],
    getRoutePolicy() { throw new Error('策略读取失败'); },
    async migrateToStandby() { session.calls.push('x'); return { ok: true }; },
  };
  const out = await handleRouteChange({ event: EVENT, session, log: () => {} });
  assert.equal(out.attempted, false, '读不到策略时必须按关闭处理');
  assert.deepEqual(session.calls, []);
});
