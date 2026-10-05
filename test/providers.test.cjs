'use strict';
// 网络 PHASE 2 单测：Provider 契约 + NetworkStats + Provider 注册表。
// 这一层不碰真实网络，全部用手写实现验证契约本身。

const test = require('node:test');
const assert = require('node:assert');

const P = require('../network/providers/provider.cjs');
const R = require('../network/providers/registry.cjs');
const S = require('../network/stats.cjs');

/** 一个最小的合规实现，用来验证包装层的状态机、事件、统计。 */
function fakeImplementation({ unreliable = true, failStart = false } = {}) {
  const sent = [];
  const inner = { stats: S.createStats() };
  return {
    inner,
    sent,
    implementation: {
      stats: inner.stats,
      async start(input) {
        if (failStart) throw new Error('绑定失败：端口被占用');
        return { input, transport: '127.0.0.1:0' };
      },
      async stop() { return { stopped: true }; },
      send(data, { channel }) { sent.push({ data: String(data), channel }); return { ok: true, channel }; },
      describe() { return { id: 'fake', hint: unreliable ? 'unreliable-ok' : 'reliable-only' }; },
    },
  };
}

function makeProvider(options = {}) {
  const { implementation, inner, sent } = fakeImplementation(options);
  const provider = P.createProvider({
    id: 'fake-provider',
    name: '假 Provider',
    capabilities: {
      transports: ['tcp', 'udp'],
      reliable: true,
      unreliable: options.unreliable !== false,
      p2p: options.p2p === true,
      natTraversal: options.natTraversal === true,
      encryption: options.encryption || 'psk-aead',
      maxPeers: 8,
      requiresReachablePort: true,
      notes: ['仅用于测试'],
    },
    implementation,
  });
  return { provider, inner, sent };
}

test('能力声明：字段归一化，缺省即「不支持」', () => {
  const caps = P.defineCapabilities({ transports: ['tcp', 'UDP', 'tcp', 'bogus'] });
  assert.deepEqual(caps.transports, ['TCP', 'UDP'], '去重并统一大写，非法项丢弃');
  assert.equal(caps.reliable, false, '未声明 reliable 时不能默认成支持');
  assert.equal(caps.unreliable, false);
  assert.equal(caps.p2p, false);
  assert.equal(caps.natTraversal, false);
  assert.equal(caps.encryption, 'none', '未知加密来源回落到 none，不能假装加密');
  assert.equal(caps.requiresReachablePort, false);

  const full = P.defineCapabilities({
    transports: ['UDP'], reliable: true, unreliable: true, p2p: true,
    natTraversal: true, encryption: 'steam-transport', maxPeers: 16, requiresReachablePort: false,
  });
  assert.deepEqual(full.transports, ['UDP']);
  assert.equal(full.encryption, 'steam-transport');
  assert.equal(full.maxPeers, 16);
});

test('契约校验：缺方法或没 id 都必须当场报错', () => {
  assert.throws(() => P.assertProvider(null), /必须是对象/);
  assert.throws(() => P.assertProvider({ id: 'x', getCapabilities: () => ({ transports: [] }) }), /缺少必需方法/);
  assert.throws(() => P.assertProvider({ getCapabilities: () => ({ transports: [] }) }), /必须有字符串 id/);
  assert.throws(
    () => P.assertProvider({ id: 'x', start() {}, stop() {}, send() {}, getStats() {}, getCapabilities: () => ({}) }),
    /transports 数组/,
  );
  const { provider } = makeProvider();
  assert.equal(P.assertProvider(provider), true, '合规实现应通过校验');
});

test('状态机：idle → starting → ready → stopping → stopped，失败进 error', async () => {
  const { provider } = makeProvider();
  const states = [];
  provider.onEvent((ev) => { if (ev.type === 'state') states.push(ev.to); });
  assert.equal(provider.getState(), P.PROVIDER_STATES.IDLE);

  await provider.start({ role: 'host' });
  assert.equal(provider.getState(), P.PROVIDER_STATES.READY);
  await assert.rejects(provider.start(), /已经启动/, '重复启动要报错');

  await provider.stop();
  assert.equal(provider.getState(), P.PROVIDER_STATES.STOPPED);
  await provider.stop(); // 幂等
  assert.deepEqual(states, ['starting', 'ready', 'stopping', 'stopped']);

  const bad = makeProvider({ failStart: true }).provider;
  await assert.rejects(bad.start(), /绑定失败/);
  assert.equal(bad.getState(), P.PROVIDER_STATES.ERROR);
  assert.match(bad.describe().lastError, /绑定失败/);
});

test('通道守卫：不支持的能力必须报错，不能静默降级', async () => {
  const { provider, sent } = makeProvider();
  await provider.start();

  const ok = provider.send('hello', { channel: P.CHANNELS.RELIABLE });
  assert.equal(ok.ok, true);
  assert.equal(sent[0].channel, 'reliable');

  const unreliable = provider.send('realtime', { channel: P.CHANNELS.UNRELIABLE });
  assert.equal(unreliable.channel, 'unreliable', '声明支持时不可靠通道应可用');

  assert.throws(() => provider.send('x', { channel: 'best-effort' }), /未知通道/);

  const reliableOnly = makeProvider({ unreliable: false }).provider;
  await reliableOnly.start();
  assert.throws(
    () => reliableOnly.send('x', { channel: P.CHANNELS.UNRELIABLE }),
    /不支持不可靠通道/,
    '不支持时必须抛错而不是改成可靠通道',
  );

  const idle = makeProvider().provider;
  assert.throws(() => idle.send('x'), /尚未就绪/, '未启动不允许发送');
});

test('统计：直接镜像中继内核的计数，并按时间差分出速率', () => {
  const kernelStats = { connections: 0, bytesToPeer: 0, bytesFromPeer: 0 };
  const stats = S.mirrorStats(kernelStats, { now: () => 0 });
  const fields = Object.keys(S.emptyCounters());
  for (const key of fields) assert.equal(kernelStats[key], 0, `镜像时补零：${key}`);

  let clock = 1000;
  const timed = S.mirrorStats(kernelStats, { now: () => clock });
  timed.snapshot();                     // 第一个点
  kernelStats.bytesToPeer = 1000;
  kernelStats.bytesFromPeer = 500;
  clock += 1000;
  const snap = timed.snapshot();        // 1 秒后
  assert.equal(snap.rateToPeer, 1000, '1 秒 1000 字节 → 1000 B/s');
  assert.equal(snap.rateFromPeer, 500);
  assert.equal(snap.samples.length, 2);

  // 采样节流：200ms 内的重复采样不再新增点
  clock += 100;
  const throttledSnap = timed.snapshot();
  assert.equal(throttledSnap.samples.length, 2, '200ms 内不新增采样点');
});

test('统计：自建计数、未知字段拒绝、reset 清零', () => {
  const stats = S.createStats();
  stats.add('connections');
  stats.add('bytesToPeer', 2048);
  const snap = stats.snapshot();
  assert.equal(snap.connections, 1);
  assert.equal(snap.bytesToPeer, 2048);
  assert.throws(() => stats.add('nonsense'), /未知的统计字段/);
  stats.reset();
  assert.equal(stats.sampleCount, 0, 'reset 后没有采样点');
  assert.equal(stats.snapshot().bytesToPeer, 0, 'reset 后计数归零（snapshot 本身会采一个点）');
});

test('Provider 把统计与质量串起来：内核计数 → 快照；无样本 → NOT MEASURED', async () => {
  const { provider, inner } = makeProvider();
  await provider.start();
  inner.stats.add('connections');
  inner.stats.add('bytesToPeer', 4096);
  const snapshot = provider.getStats();
  assert.equal(snapshot.connections, 1);
  assert.equal(snapshot.bytesToPeer, 4096);

  const quality = provider.getQuality();
  assert.equal(quality.measured, false, '没有探针样本时不能声称已测量');
  assert.equal(quality.rtt, null);
  assert.equal(quality.jitter, null);
  assert.equal(quality.packetLoss, null);
});

test('事件与消息订阅：可退订，单个订阅者异常不影响其它订阅者', async () => {
  const { provider } = makeProvider();
  const seen = [];
  const off = provider.onEvent((ev) => seen.push(ev.type === 'state' ? ev.to : ev.type));
  provider.onEvent(() => { throw new Error('订阅者自己炸了'); });
  const messages = [];
  const offMessage = provider.onMessage((m) => messages.push(m));

  await provider.start();
  assert.ok(seen.includes('starting') && seen.includes('ready'), '事件应送达');
  provider.deliver({ channel: 'reliable', data: 'x' });
  assert.equal(messages.length, 1);

  off();
  offMessage();
  const before = seen.length;
  await provider.stop();
  assert.equal(seen.length, before, '退订后不再收到事件');
  assert.throws(() => provider.onEvent(null), /需要函数/);
});

test('注册表：登记 / 取用 / 过滤 / 能力摘要；非法输入当场报错', () => {
  const registry = R.createRegistry();
  registry.register({
    id: 'steam-p2p', name: 'Steam P2P', kind: R.PROVIDER_KINDS.STEAM,
    create: () => { throw new Error('未使用'); },
    capabilities: { transports: ['TCP'], reliable: true, p2p: true, natTraversal: true, encryption: 'steam-transport' },
  });
  registry.register({
    id: 'local-relay', name: '本地中继', kind: R.PROVIDER_KINDS.LOCAL,
    create: () => { throw new Error('未使用'); },
    capabilities: { transports: ['TCP', 'UDP'], reliable: true, encryption: 'psk-aead', requiresReachablePort: true },
  });
  registry.register({
    id: 'sl-relay', name: 'Stronghold Relay', kind: R.PROVIDER_KINDS.RELAY,
    create: () => { throw new Error('未使用'); },
    capabilities: { transports: ['UDP'], reliable: false, unreliable: true },
    available: false, unavailableReason: '服务端尚未部署',
  });

  assert.equal(registry.size(), 3);
  assert.equal(registry.has('steam-p2p'), true);
  assert.equal(registry.get('steam-p2p').capabilities.natTraversal, true);
  assert.throws(() => registry.get('nope'), /未注册的 Provider/);
  assert.throws(() => registry.register({ name: 'x', create() {} }), /需要 id/);
  assert.throws(() => registry.register({ id: 'y' }), /create 工厂函数/);
  assert.throws(() => registry.register({ id: 'z', create() {}, kind: 'weird' }), /kind 非法/);

  assert.equal(registry.list({ kind: R.PROVIDER_KINDS.LOCAL }).length, 1);
  assert.equal(registry.list({ onlyAvailable: true }).length, 2, '未部署的 Provider 不出现在可用列表');

  const described = registry.describeAll();
  const relay = described.find((d) => d.id === 'sl-relay');
  assert.equal(relay.available, false);
  assert.match(relay.unavailableReason, /尚未部署/);
  const steam = described.find((d) => d.id === 'steam-p2p');
  assert.match(steam.summary, /p2p/);
  assert.match(steam.summary, /nat-traversal/);
  assert.match(steam.summary, /enc:steam-transport/);
});
