'use strict';
// 网络 PHASE 5 单测：活连接线路判定。
//
// 这一组测的是"到底走没走 Steam 中继"这句话能不能被信。
// 全部用注入的假连接信息，不碰真实 SDK；判定规则来自 Valve 自己的字段，
// 任何拿不到的字段都必须落成 null 或 UNKNOWN，不允许编造。

const test = require('node:test');
const assert = require('node:assert');

const R = require('../network/route-report.cjs');
const { createKernelProvider } = require('../network/providers/kernel-provider.cjs');
const { createRouteReporter } = require('../network/steam-adapter.cjs');
const { SessionManager, STATES } = require('../network/session.cjs');

// SteamNetworkingPOPID 是小端打包的四个 ASCII 字符
const POP_TYO1 = 0x316f7974; // 'tyo1'
const OFF = R.ADDR_REMOTE_OFFSET;

function packPop(code) {
  let value = 0;
  for (let i = 0; i < code.length; i += 1) value += code.charCodeAt(i) << (i * 8);
  return value >>> 0;
}

function ipv4Buffer(octets, port) {
  const buf = Buffer.alloc(R.CONNECTION_INFO_SIZE);
  buf[OFF + 10] = 0xff;
  buf[OFF + 11] = 0xff;
  buf[OFF + 12] = octets[0];
  buf[OFF + 13] = octets[1];
  buf[OFF + 14] = octets[2];
  buf[OFF + 15] = octets[3];
  buf.writeUInt16BE(port, OFF + 16);
  return buf;
}

test('popCode：按小端解出四个 ASCII 字符', () => {
  assert.strictEqual(R.popCode(POP_TYO1), 'tyo1');
  assert.strictEqual(R.popCode(packPop('lax')), 'lax');
  assert.strictEqual(R.popCode(packPop('iad')), 'iad');
  assert.strictEqual(R.popCode(packPop('sea1')), 'sea1');
});

test('popCode：0 与非法值返回 null，不返回占位字符串', () => {
  assert.strictEqual(R.popCode(0), null);
  assert.strictEqual(R.popCode(null), null);
  assert.strictEqual(R.popCode(undefined), null);
  assert.strictEqual(R.popCode(NaN), null);
  // 非可打印字节必须落 null，不能拼出乱码冒充 POP
  assert.strictEqual(R.popCode(0x00000001), null);
});

test('parseIpAddr：IPv4 映射地址与网络字节序端口', () => {
  const buf = ipv4Buffer([203, 0, 113, 7], 27015);
  const addr = R.parseIpAddr(buf);
  assert.deepStrictEqual(addr, { host: '203.0.113.7', port: 27015, family: 4 });
});

test('parseIpAddr：全零表示未设置，不冒充 0.0.0.0', () => {
  const buf = Buffer.alloc(R.CONNECTION_INFO_SIZE);
  const addr = R.parseIpAddr(buf);
  assert.strictEqual(addr.host, null);
  assert.strictEqual(addr.port, null);
  assert.strictEqual(R.formatAddress(addr), null);
});

test('parseIpAddr：IPv6 地址逐段还原', () => {
  const buf = Buffer.alloc(R.CONNECTION_INFO_SIZE);
  buf.writeUInt16BE(0x2001, OFF);
  buf.writeUInt16BE(0x0db8, OFF + 2);
  buf.writeUInt16BE(0x0001, OFF + 14);
  buf.writeUInt16BE(4433, OFF + 16);
  const addr = R.parseIpAddr(buf);
  assert.strictEqual(addr.host, '2001:db8:0:0:0:0:0:1');
  assert.strictEqual(addr.family, 6);
  assert.strictEqual(R.formatAddress(addr), '[2001:db8:0:0:0:0:0:1]:4433');
});

test('parseIpAddr：缓冲区太短返回 null，不越界读', () => {
  assert.strictEqual(R.parseIpAddr(Buffer.alloc(10)), null);
  assert.strictEqual(R.parseIpAddr(null), null);
});

test('classify：popIdRelay 非 0 就是走中继，这是唯一的判据', () => {
  const info = { popIdRelay: POP_TYO1, popIdRemote: packPop('lax'), state: 3, stateName: 'Connected' };
  const out = R.classify(info);
  assert.strictEqual(out.route, R.ROUTE.RELAY);
  assert.strictEqual(out.relayed, true);
  assert.strictEqual(out.relayPop, 'tyo1');
  assert.strictEqual(out.remotePop, 'lax');
});

test('classify：popIdRelay 为 0 且远端 POP 有值就是直连', () => {
  const out = R.classify({ popIdRelay: 0, popIdRemote: packPop('nrt') });
  assert.strictEqual(out.route, R.ROUTE.DIRECT);
  assert.strictEqual(out.relayed, false);
  assert.strictEqual(out.relayPop, null);
  assert.strictEqual(out.remotePop, 'nrt');
});

test('classify：两个 POP 都没有就是 UNKNOWN，不猜', () => {
  const out = R.classify({ popIdRelay: 0, popIdRemote: 0 });
  assert.strictEqual(out.route, R.ROUTE.UNKNOWN);
  assert.strictEqual(out.relayed, false);
  assert.strictEqual(out.routeLabel, 'UNKNOWN');
});

test('classify：空输入不抛异常', () => {
  assert.strictEqual(R.classify(null).route, R.ROUTE.UNKNOWN);
  assert.strictEqual(R.classify(undefined).route, R.ROUTE.UNKNOWN);
  assert.strictEqual(R.classify({}).route, R.ROUTE.UNKNOWN);
});

test('classify：POP 解不出文本时仍如实报中继，不误判成直连', () => {
  // 0xff 非 0，说明这条连接被中继了，只是 POP 文本解不出四个 ASCII 字符。
  // 曾经拿"解出来的字符串是否为空"当判据，会把中继误判成直连 —— 这是致命误报。
  const out = R.classify({ popIdRelay: 0xff, popIdRemote: POP_TYO1 });
  assert.strictEqual(out.route, R.ROUTE.RELAY);
  assert.strictEqual(out.relayed, true);
  assert.strictEqual(out.relayPop, null);
  assert.strictEqual(out.relayPopId, 0xff);
  assert.strictEqual(out.remotePop, 'tyo1');
});

test('classify：远端 POP 解不出文本时仍然算直连，不退化成 UNKNOWN', () => {
  const out = R.classify({ popIdRelay: 0, popIdRemote: 0x1 });
  assert.strictEqual(out.route, R.ROUTE.DIRECT);
  assert.strictEqual(out.relayed, false);
  assert.strictEqual(out.remotePop, null);
  assert.strictEqual(out.remotePopId, 1);
});

test('sampleRoute：线路、POP、实时速率一起给出', () => {
  const steam = { networkingSockets: {} };
  const report = R.sampleRoute(steam, 7, {
    now: () => 1000,
    info: { popIdRelay: POP_TYO1, popIdRemote: packPop('lax'), state: 3, stateName: 'Connected' },
    realtime: { ping: 41, inBytesPerSec: 30720, outBytesPerSec: 10240, connectionQualityLocal: 0.9, connectionQualityRemote: 0.8 },
    address: { host: '198.51.100.9', port: 40000, family: 4 },
  });
  assert.strictEqual(report.available, true);
  assert.strictEqual(report.route, R.ROUTE.RELAY);
  assert.strictEqual(report.relayPop, 'tyo1');
  assert.strictEqual(report.remotePop, 'lax');
  assert.strictEqual(report.remoteAddress, '198.51.100.9:40000');
  assert.strictEqual(report.ping, 41);
  assert.strictEqual(report.steamInBytesPerSec, 30720);
  assert.strictEqual(report.steamOutBytesPerSec, 10240);
  assert.strictEqual(report.sampledAt, 1000);
});

test('sampleRoute：拿不到连接信息时如实报不可用', () => {
  const report = R.sampleRoute({ networkingSockets: {} }, 7, { info: null, now: () => 5 });
  assert.strictEqual(report.available, false);
  assert.strictEqual(report.reason, 'NO_CONNECTION_INFO');
});

test('sampleRoute：没有 networkingSockets 或没有连接时返回 null', () => {
  assert.strictEqual(R.sampleRoute(null, 1), null);
  assert.strictEqual(R.sampleRoute({ networkingSockets: {} }, null), null);
});

test('sampleRoute：实时状态读不到时速率落 null，不落 0', () => {
  const report = R.sampleRoute({ networkingSockets: {} }, 1, {
    info: { popIdRelay: 0, popIdRemote: packPop('lax'), state: 3 },
    realtime: null,
    address: null,
    now: () => 1,
  });
  assert.strictEqual(report.available, true);
  assert.strictEqual(report.ping, null);
  assert.strictEqual(report.steamInBytesPerSec, null);
  assert.strictEqual(report.remoteAddress, null);
});

test('summarize：全部直连就报直连，混线不挑一条代表全部', () => {
  const direct = R.classify({ popIdRelay: 0, popIdRemote: packPop('lax') });
  const relay = R.classify({ popIdRelay: POP_TYO1, popIdRemote: packPop('lax') });
  const same = R.summarize([
    { available: true, ...direct, ping: 10, steamInBytesPerSec: 100, steamOutBytesPerSec: 50 },
    { available: true, ...direct, ping: 30, steamInBytesPerSec: 200, steamOutBytesPerSec: 100 },
  ]);
  assert.strictEqual(same.route, R.ROUTE.DIRECT);
  assert.strictEqual(same.count, 2);
  assert.strictEqual(same.ping, 20);
  assert.strictEqual(same.steamInBytesPerSec, 300);

  const mixed = R.summarize([
    { available: true, ...direct },
    { available: true, ...relay },
  ]);
  assert.strictEqual(mixed.route, 'MIXED');
  assert.strictEqual(mixed.relayed, true);
  assert.strictEqual(mixed.relayPop, 'tyo1');
});

test('summarize：一条速率缺值就整体落 null，不做局部求和冒充总量', () => {
  const direct = R.classify({ popIdRelay: 0, popIdRemote: packPop('lax') });
  const out = R.summarize([
    { available: true, ...direct, steamInBytesPerSec: 100 },
    { available: true, ...direct, steamInBytesPerSec: null },
  ]);
  assert.strictEqual(out.steamInBytesPerSec, null);
});

test('createRawSocketMeter：第一次采样没有速率，第二次才做差分', () => {
  const meter = R.createRawSocketMeter();
  const first = meter.read({ bytesToPeer: 1000, bytesFromPeer: 2000 }, 1000);
  assert.strictEqual(first.rawTxBytesPerSec, null, '第一个采样点没有上一个点做差分');
  assert.strictEqual(first.rawRxBytesPerSec, null);
  assert.strictEqual(first.bytesFromPeer, 2000);

  const second = meter.read({ bytesToPeer: 3000, bytesFromPeer: 12000 }, 3000);
  assert.strictEqual(second.rawTxBytesPerSec, 1000, '(3000-1000)/2s');
  assert.strictEqual(second.rawRxBytesPerSec, 5000, '(12000-2000)/2s');
});

test('createRawSocketMeter：计数器回绕时不报负数速率', () => {
  const meter = R.createRawSocketMeter();
  meter.read({ bytesToPeer: 900000, bytesFromPeer: 900000 }, 1000);
  const out = meter.read({ bytesToPeer: 10, bytesFromPeer: 10 }, 2000);
  assert.strictEqual(out.rawTxBytesPerSec, null);
  assert.strictEqual(out.rawRxBytesPerSec, null);
});

test('createRawSocketMeter：没有内核统计时全部落 0 与 null，不抛异常', () => {
  const meter = R.createRawSocketMeter();
  const out = meter.read(null, 1000);
  assert.strictEqual(out.bytesFromPeer, 0);
  assert.strictEqual(out.rawRxBytesPerSec, null);
});

test('summarize：一条 ping 缺值就整体落 null，不拿剩下的平均冒充全网延迟', () => {  const out = R.summarize([
    { available: true, route: R.ROUTE.DIRECT, relayed: false, ping: 40, steamInBytesPerSec: 1, steamOutBytesPerSec: 1 },
    { available: true, route: R.ROUTE.DIRECT, relayed: false, ping: 60, steamInBytesPerSec: 1, steamOutBytesPerSec: 1 },
  ]);
  assert.strictEqual(out.ping, 50);
  const missing = R.summarize([
    { available: true, route: R.ROUTE.DIRECT, relayed: false, ping: 40, steamInBytesPerSec: 1, steamOutBytesPerSec: 1 },
    { available: true, route: R.ROUTE.DIRECT, relayed: false, ping: null, steamInBytesPerSec: 1, steamOutBytesPerSec: 1 },
  ]);
  assert.strictEqual(missing.ping, null);
});

test('createRouteReporter：rawSocket 速率来自本地 socket 字节计数', () => {
  const stats = { role: 'host', bytesToPeer: 0, bytesFromPeer: 0, packetsToPeer: 0, packetsFromPeer: 0 };
  const steam = { networkingSockets: {} };
  const report = createRouteReporter(steam, stats);

  stats.bytesToPeer = 1000;
  stats.bytesFromPeer = 2000;
  const first = report([], 1000);
  assert.strictEqual(first.rawSocket.rawTxBytesPerSec, null, '第一个采样点没有上一个点做差分');
  assert.strictEqual(first.rawSocket.bytesFromPeer, 2000);

  stats.bytesToPeer = 5000;
  stats.bytesFromPeer = 12000;
  const second = report([], 2000);
  assert.strictEqual(second.rawSocket.rawTxBytesPerSec, 4000, '1 秒内发了 4000 字节');
  assert.strictEqual(second.rawSocket.rawRxBytesPerSec, 10000, '1 秒内收了 10000 字节');
});

test('createRouteReporter：没有活连接时线路报 UNKNOWN，不报直连', () => {
  const stats = { role: 'joiner', bytesToPeer: 0, bytesFromPeer: 0 };
  const report = createRouteReporter({ networkingSockets: {} }, stats)([], 1);
  assert.strictEqual(report.route, R.ROUTE.UNKNOWN);
  assert.strictEqual(report.connections, 0);
  assert.deepStrictEqual(report.peers, []);
  assert.strictEqual(report.protocol, 'STEAM');
  assert.strictEqual(report.role, 'joiner');
});

test('createRouteReporter：单个连接抛异常不影响整体报告', () => {
  const stats = { role: 'host', bytesToPeer: 0, bytesFromPeer: 0 };
  const steam = {
    networkingSockets: {
      getConnectionInfo() { throw new Error('句柄已失效'); },
    },
  };
  const report = createRouteReporter(steam, stats)([1], 1);
  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.route, R.ROUTE.UNKNOWN);
});

test('kernel-provider：内核有 route() 就透传', () => {
  const provider = createKernelProvider({
    id: 'steam-p2p-host',
    name: 'x',
    capabilities: {},
    createKernel: () => ({ ready: Promise.resolve({}), stats: {}, stop() {}, route: () => ({ route: 'STEAM_SDR_RELAY', routeLabel: 'STEAM SDR RELAY', relayed: true, relayPop: 'tyo1' }) }),
  });
  return provider.start({}).then(() => {
    const out = provider.route();
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.route, 'STEAM_SDR_RELAY');
    assert.strictEqual(out.relayPop, 'tyo1');
    assert.strictEqual(out.provider, 'steam-p2p-host');
  });
});

test('kernel-provider：本地中继与直连按真实链路标注，不冒充 UNKNOWN', () => {
  const local = createKernelProvider({
    id: 'local-tcp-host', name: 'x', capabilities: {}, createKernel: () => ({ ready: Promise.resolve({}), stats: {}, stop() {} }),
  });
  const direct = createKernelProvider({
    id: 'direct-udp-host', name: 'x', capabilities: {}, createKernel: () => ({ ready: Promise.resolve({}), stats: {}, stop() {} }),
  });
  assert.strictEqual(local.route().route, 'LOCAL_TCP');
  assert.strictEqual(direct.route().route, 'DIRECT_TCP');
  assert.strictEqual(local.route().relayed, false);
});

test('kernel-provider：既没有内核也没有已知类型时明确报不支持', () => {
  const provider = createKernelProvider({
    id: 'mystery-host', name: 'x', capabilities: {}, createKernel: () => ({ ready: Promise.resolve({}), stats: {}, stop() {} }),
  });
  const out = provider.route();
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'PROVIDER_HAS_NO_ROUTE');
  assert.strictEqual(out.route, 'UNKNOWN');
});

test('kernel-provider：route() 抛异常被兜住，不冒泡到调用方', () => {
  const provider = createKernelProvider({
    id: 'steam-p2p-joiner', name: 'x', capabilities: {},
    createKernel: () => ({ ready: Promise.resolve({}), stats: {}, stop() {}, route() { throw new Error('连接已关闭'); } }),
  });
  return provider.start({}).then(() => {
    const out = provider.route();
    assert.strictEqual(out.ok, false);
    assert.match(out.reason, /连接已关闭/);
    assert.strictEqual(out.route, 'UNKNOWN');
  });
});

function sessionWith(providers) {
  const sm = new SessionManager();
  sm.state = STATES.RUNNING;
  sm.role = 'host';
  sm.channels = providers.map((provider, index) => ({
    rule: { protocol: 'TCP' },
    listen: { port: 50900 + index },
    peer: { host: '127.0.0.1', port: 3000 },
    provider,
  }));
  return sm;
}

test('session.getRouteReport：Steam 中继连在跑就报中继与 POP', () => {
  const sm = sessionWith([{
    id: 'steam-p2p-host',
    route: () => ({
      ok: true, route: 'STEAM_SDR_RELAY', routeLabel: 'STEAM SDR RELAY', relayed: true,
      relayPop: 'tyo1', remotePop: 'lax', remoteAddress: '203.0.113.7:27015',
      ping: 38, steamInBytesPerSec: 30720, steamOutBytesPerSec: 10240,
      rawSocket: { rawRxBytesPerSec: 30000, rawTxBytesPerSec: 9000 },
    }),
  }]);
  const out = sm.getRouteReport();
  assert.strictEqual(out.route, 'STEAM_SDR_RELAY');
  assert.strictEqual(out.relayed, true);
  assert.strictEqual(out.relayPop, 'tyo1');
  assert.strictEqual(out.remoteAddress, '203.0.113.7:27015');
  assert.strictEqual(out.steamInBytesPerSec, 30720);
  assert.strictEqual(out.rawSocket.rawRxBytesPerSec, 30000);
  assert.strictEqual(out.running, true);
  assert.strictEqual(out.channels.length, 1);
  assert.strictEqual(out.channels[0].listenPort, 50900);
});

test('session.getRouteReport：中继优先于直连，直连优先于其它', () => {
  const sm = sessionWith([
    { id: 'local-tcp-host', route: () => ({ ok: true, route: 'LOCAL_TCP', routeLabel: 'LOCAL TCP', relayed: false }) },
    { id: 'steam-p2p-host', route: () => ({ ok: true, route: 'DIRECT_P2P', routeLabel: 'DIRECT P2P', relayed: false, remotePop: 'nrt' }) },
  ]);
  assert.strictEqual(sm.getRouteReport().route, 'DIRECT_P2P');
});

test('session.getRouteReport：Provider 抛异常不炸整个报告', () => {
  const sm = sessionWith([
    { id: 'steam-p2p-host', route() { throw new Error('句柄失效'); } },
    { id: 'local-tcp-host', route: () => ({ ok: true, route: 'LOCAL_TCP', routeLabel: 'LOCAL TCP', relayed: false }) },
  ]);
  const out = sm.getRouteReport();
  assert.strictEqual(out.channels.length, 2);
  assert.strictEqual(out.channels[0].route, 'UNKNOWN');
  assert.match(out.channels[0].reason, /句柄失效/);
  assert.strictEqual(out.channels[1].route, 'LOCAL_TCP');
});

test('session.getRouteReport：没有通道时一切落 UNKNOWN，不报直连', () => {
  const sm = sessionWith([]);
  const out = sm.getRouteReport();
  assert.strictEqual(out.route, 'UNKNOWN');
  assert.strictEqual(out.relayed, false);
  assert.strictEqual(out.relayPop, null);
  assert.strictEqual(out.remotePop, null);
  assert.strictEqual(out.steamInBytesPerSec, null);
  assert.deepStrictEqual(out.channels, []);
});

// ---------------------------------------------------------------------------
// 带宽诊断：这几项是判断"到底是不是 Steam 在限速"的唯一证据，必须算对。
// ---------------------------------------------------------------------------

/** 造一条可汇总的活连接样本。 */
function live(extra = {}) {
  return {
    available: true,
    route: 'DIRECT_P2P',
    relayed: false,
    ping: 40,
    steamInBytesPerSec: 20480,
    steamOutBytesPerSec: 10240,
    sendRateBytesPerSecond: 131072,
    pendingReliable: 0,
    sentUnackedReliable: 0,
    usecQueueTime: 0,
    qualityLocal: 1,
    steamInPacketsPerSec: 100,
    steamOutPacketsPerSec: 100,
    ...extra,
  };
}

test('summarize：发送上限取最小的那条连接，取平均会把最慢的一条掩盖掉', () => {
  const out = R.summarize([
    live({ sendRateBytesPerSecond: 262144 }),
    live({ sendRateBytesPerSecond: 65536 }),
    live({ sendRateBytesPerSecond: 524288 }),
  ]);
  assert.strictEqual(out.sendRateBytesPerSecond, 65536);
});

test('summarize：积压与丢包按总和报，排队时间取最大', () => {
  const out = R.summarize([
    live({ pendingReliable: 4096, sentUnackedReliable: 1024, usecQueueTime: 3000 }),
    live({ pendingReliable: 8192, sentUnackedReliable: 2048, usecQueueTime: 9000 }),
  ]);
  assert.strictEqual(out.pendingReliable, 12288);
  assert.strictEqual(out.sentUnackedReliable, 3072);
  assert.strictEqual(out.usecQueueTime, 9000);
});

test('summarize：新增字段同样遵守"缺一条就整体落 null"，不拿局部求和冒充总量', () => {
  const out = R.summarize([
    live({ pendingReliable: 4096 }),
    live({ pendingReliable: null }),
  ]);
  assert.strictEqual(out.pendingReliable, null);
  assert.strictEqual(out.sendRateBytesPerSecond, 131072, '其它字段仍然照常汇总');
});

test('summarize：没有活连接时新字段全部落 null，不填 0', () => {
  const out = R.summarize([]);
  assert.strictEqual(out.sendRateBytesPerSecond, null);
  assert.strictEqual(out.pendingReliable, null);
  assert.strictEqual(out.usecQueueTime, null);
  assert.strictEqual(out.qualityLocal, null);
});

test('diagnose：积压很高时点名瓶颈在 Steam 线路，而不是本地', () => {
  const out = R.diagnose({ route: 'DIRECT_P2P', relayed: false, ping: 60, pendingReliable: 200 * 1024, sendRateBytesPerSecond: 131072, usecQueueTime: 4000 });
  assert.strictEqual(out.level, 'warn');
  assert.match(out.text, /积压/);
  assert.match(out.text, /瓶颈在 Steam 线路/);
  assert.match(out.text, /128 KB\/s/);
});

test('diagnose：没有积压但往返很高时说清卡的是延迟不是带宽', () => {
  const out = R.diagnose({ route: 'DIRECT_P2P', relayed: false, ping: 210, pendingReliable: 0, sendRateBytesPerSecond: 524288 });
  assert.strictEqual(out.level, 'warn');
  assert.match(out.text, /卡的是延迟不是带宽/);
});

test('diagnose：中继连接会直接点名中继 POP', () => {
  const out = R.diagnose({ route: 'STEAM_SDR_RELAY', relayed: true, relayPop: 'tyo1', ping: 90, pendingReliable: 0 });
  assert.match(out.text, /Steam 中继 tyo1/);
});

test('diagnose：没有连接时如实说没有连接，不编一句正常的出来', () => {
  const out = R.diagnose({ route: 'UNKNOWN' });
  assert.strictEqual(out.level, 'idle');
  assert.match(out.text, /没有活动连接/);
});

test('diagnose：多条连接线路不一致时明说读数不能代表整体', () => {
  const out = R.diagnose({ route: 'MIXED', relayed: true, ping: 30 });
  assert.strictEqual(out.level, 'warn');
  assert.match(out.text, /线路不一致/);
});

test('diagnose：一切正常时不报 warn', () => {
  const out = R.diagnose({ route: 'DIRECT_P2P', relayed: false, ping: 35, pendingReliable: 0, sendRateBytesPerSecond: 262144, usecQueueTime: 500 });
  assert.strictEqual(out.level, 'ok');
  assert.match(out.text, /直连/);
});

// 传输偏好接进诊断之后新增的几条。要求"罚分已压到底还是走中继"这件事
// 必须被点出来 —— 否则用户会以为调参没生效，继续白调带宽。

test('diagnose：配置了强制直连却仍然走中继时，明说打洞没成功', () => {
  const out = R.diagnose({
    route: 'STEAM_SDR_RELAY',
    relayed: true,
    relayPop: 'hkg1',
    ping: 70,
    pendingReliable: 0,
    netConfig: { available: true, transport: 'ice' },
  });
  assert.strictEqual(out.level, 'warn');
  assert.match(out.text, /ICE 打洞没成功/);
  assert.match(out.text, /再调带宽没有用/);
});

test('diagnose：没有传输偏好或偏好是 auto 时，不硬塞"打洞失败"的结论', () => {
  const plain = R.diagnose({ route: 'STEAM_SDR_RELAY', relayed: true, relayPop: 'hkg1', ping: 70, pendingReliable: 0 });
  assert.ok(!/打洞没成功/.test(plain.text));
  const auto = R.diagnose({
    route: 'STEAM_SDR_RELAY', relayed: true, relayPop: 'hkg1', ping: 70, pendingReliable: 0,
    netConfig: { available: true, transport: 'auto' },
  });
  assert.ok(!/打洞没成功/.test(auto.text));
});

test('diagnose：强制直连且真的直连上了，如实说明中继不会来抢路', () => {
  const out = R.diagnose({
    route: 'DIRECT_P2P', relayed: false, ping: 30, pendingReliable: 0,
    netConfig: { available: true, transport: 'ice' },
  });
  assert.strictEqual(out.level, 'ok');
  assert.match(out.text, /禁止中继抢路/);
});

test('diagnose：netConfig 是 null 时不影响原有判定', () => {
  const out = R.diagnose({ route: 'DIRECT_P2P', relayed: false, ping: 35, pendingReliable: 0, netConfig: null });
  assert.strictEqual(out.level, 'ok');
  assert.match(out.text, /没有经过中继/);
});
