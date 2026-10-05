'use strict';
// 网络 PHASE 4a 单测：Steam 中继网络诊断（POP 延迟、中继状态、本地位置）。
// 用注入的假 utils 验证映射与排序；真实 SDK 的验证用 npm 探针另行执行。

const test = require('node:test');
const assert = require('node:assert');

const D = require('../network/steam-netdiag.cjs');

function fakeSdk({ pops = null, measuring = false, statusThrows = false, location = { locationString: 'x', dataAge: 3 } } = {}) {
  const list = pops === null ? [
    { popId: 1, popCode: 'lax', pingViaRelay: 42, viaRelayPOP: 3 },
    { popId: 2, popCode: 'sea', pingViaRelay: 18, viaRelayPOP: 1 },
    { popId: 3, popCode: 'iad', pingViaRelay: 0, viaRelayPOP: 0 },
    { popId: 4, popCode: 'fra', pingViaRelay: 210, viaRelayPOP: 3 },
  ] : pops;
  return {
    networkingUtils: {
      initRelayNetworkAccess() {},
      getRelayNetworkStatus() {
        if (statusThrows) throw new Error('relay status 不可用');
        return { availability: 100, availabilityName: 'Current', pingMeasurementInProgress: measuring, networkConfigAvailability: 100 };
      },
      getLocalPingLocation: () => location,
      getPOPCount: () => list.length,
      getPOPList: () => list,
      getPingToDataCenter: (id) => ({ pingMs: id === 1 ? 55 : 0 }),
      getDirectPingToPOP: (id) => (id === 2 ? 12 : 0),
    },
  };
}

test('POP 列表按实测延迟升序，测不到的排最后（不是排最前）', async () => {
  const diag = D.createSteamNetworkDiagnostics({ sdk: fakeSdk(), waitMs: 0 });
  const out = await diag.collect();
  assert.equal(out.available, true);
  assert.deepEqual(out.pops.map((p) => p.code), ['sea', 'lax', 'fra', 'iad'].sort((a, b) => {
    const order = { sea: 18, lax: 42, fra: 210, iad: Number.POSITIVE_INFINITY };
    return order[a] - order[b];
  }), '按 pingViaRelay 升序，ping=0（未测到）排最后');
  assert.equal(out.pops[out.pops.length - 1].code, 'iad', '未测到延迟的 POP 在末尾');
  assert.equal(out.pops[0].pingViaRelay, 18);
  assert.equal(out.pops[0].directPing, 12, '直连延迟单独带出');
  assert.equal(out.pops[1].pingToDataCenter, 55, '数据中心延迟兼容对象形状');
});

test('中继状态与本地位置原样带出，且标记测量中', async () => {
  const diag = D.createSteamNetworkDiagnostics({ sdk: fakeSdk({ measuring: true }), waitMs: 0 });
  const out = await diag.collect();
  assert.equal(out.relay.availabilityName, 'Current');
  assert.equal(out.relay.measuring, true);
  assert.equal(out.local.locationString, 'x');
  assert.ok(out.notes.some((n) => n.includes('仍在进行')), '测量未完成要如实提示');
  assert.equal(out.popCount, 4);
});

test('POP 数量按 maxPops 截断', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ popId: i, popCode: 'p' + i, pingViaRelay: 10 + i, viaRelayPOP: 0 }));
  const diag = D.createSteamNetworkDiagnostics({ sdk: fakeSdk({ pops: many }), maxPops: 5, waitMs: 0 });
  const out = await diag.collect();
  assert.equal(out.pops.length, 5);
  assert.equal(out.popCount, 30, 'POP 总数照实报');
  assert.equal(out.pops[0].code, 'p0');
});

test('Steam 不可用时如实说明原因，不返回任何数字', async () => {
  const diag = D.createSteamNetworkDiagnostics({ sdk: { networkingSockets: {} }, waitMs: 0 });
  const out = await diag.collect();
  assert.equal(out.available, false);
  assert.match(out.reason, /Steam 环境不可用/);
  assert.equal(out.relay, null);
  assert.equal(out.local, null);
  assert.deepEqual(out.pops, []);
});

test('接口抛异常时降级为 null，不影响整轮采集', async () => {
  const sdk = fakeSdk({ statusThrows: true, pops: [] });
  const diag = D.createSteamNetworkDiagnostics({ sdk, waitMs: 0 });
  const out = await diag.collect();
  assert.equal(out.available, true, '单个接口失败不等于整体不可用');
  assert.equal(out.relay, null);
  assert.deepEqual(out.pops, []);
  assert.ok(out.notes.some((n) => n.includes('没有读到 POP 列表')));
});

test('readPing：number / 对象 / 无效值 三种形状', () => {
  assert.equal(D.readPing(42), 42);
  assert.equal(D.readPing({ pingMs: 55 }), 55);
  assert.equal(D.readPing({ relayPing: 7 }), 7);
  assert.equal(D.readPing(0), null, '0 表示未测到，不当成 0ms');
  assert.equal(D.readPing(-1), null);
  assert.equal(D.readPing(null), null);
  assert.equal(D.readPing('abc'), null);
});
