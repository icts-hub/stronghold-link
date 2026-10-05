'use strict';
// 网络 PHASE 8（候选清单）单测：真实测量参与评分，测不到的如实标注原因，排序把未测量放后面。

const test = require('node:test');
const assert = require('node:assert');

const { describeRouteCandidates, UNMEASURED_REASONS } = require('../network/routes.cjs');

const PROVIDERS = [
  { id: 'sl-relay-host', name: 'Stronghold Relay', kind: 'relay', capabilities: { transports: ['UDP'], unreliable: true, p2p: false, natTraversal: true, encryption: 'none' } },
  { id: 'local-tcp-host', name: '本地 TCP 中继', kind: 'local', capabilities: { transports: ['TCP'], reliable: true, requiresReachablePort: true, encryption: 'psk-aead' } },
  { id: 'steam-p2p-host', name: 'Steam P2P', kind: 'steam', capabilities: { transports: ['TCP'], reliable: true, p2p: true, natTraversal: true, encryption: 'steam-transport' } },
];

test('真实测量参与评分：已测量的候选给出分数与显示值', () => {
  const out = describeRouteCandidates({
    providers: PROVIDERS,
    qualityById: { 'sl-relay-host': { rtt: 12, packetLoss: 0, jitter: 1, measured: true } },
  });
  const relay = out.candidates.find((c) => c.id === 'sl-relay-host');
  assert.equal(relay.measured, true);
  assert.equal(relay.score, 100);
  assert.equal(relay.display, '100 分');
  assert.equal(relay.unmeasuredReason, null);
  assert.equal(out.measuredCount, 1);
  assert.equal(out.total, 3);
});

test('测不到的候选：分数为 null、显示"未测量"，并给出本机事实层面的原因', () => {
  const out = describeRouteCandidates({ providers: PROVIDERS, qualityById: {} });
  const steam = out.candidates.find((c) => c.id === 'steam-p2p-host');
  assert.equal(steam.measured, false);
  assert.equal(steam.score, null, '未测量绝不能是 0 分');
  assert.equal(steam.display, '未测量');
  assert.match(steam.unmeasuredReason, /需要真实对端连接/);
  const direct = describeRouteCandidates({
    providers: [{ id: 'direct-udp-host', name: '直连 UDP', capabilities: {} }],
  }).candidates[0];
  assert.match(direct.unmeasuredReason, /两台机器/);
  assert.equal(out.note.includes('不是 0 分'), true, '说明里要写清未测量不等于 0 分');
});

test('排序：已测量的按分数在前，未测量的保持原顺序在后', () => {
  const out = describeRouteCandidates({
    providers: PROVIDERS,
    qualityById: {
      'local-tcp-host': { rtt: 40, packetLoss: 0, jitter: 2, measured: true },
      'sl-relay-host': { rtt: 150, packetLoss: 0.02, jitter: 30, measured: true },
    },
  });
  assert.deepEqual(out.candidates.map((c) => c.id), ['local-tcp-host', 'sl-relay-host', 'steam-p2p-host']);
  assert.ok(out.candidates[0].score > out.candidates[1].score);
  assert.equal(out.measuredCount, 2);
});

test('能力原样带出，未声明的一律按不支持（不猜）', () => {
  const out = describeRouteCandidates({ providers: [{ id: 'x', name: 'X', capabilities: { unreliable: true } }] });
  const caps = out.candidates[0].capabilities;
  assert.equal(caps.unreliable, true);
  assert.equal(caps.reliable, false);
  assert.equal(caps.p2p, false);
  assert.equal(caps.encryption, 'none');
  assert.equal(caps.requiresReachablePort, false);
  assert.equal(out.candidates[0].available, true, '没有明确不可用就算可用');
});

test('不可用的候选如实带出原因，且不参与"已测量"计数', () => {
  const out = describeRouteCandidates({
    providers: [{ id: 'sl-relay-host', name: 'Relay', available: false, unavailableReason: '服务端尚未部署公网实例', capabilities: { unreliable: true } }],
  });
  const c = out.candidates[0];
  assert.equal(c.available, false);
  assert.match(c.unavailableReason, /尚未部署/);
  assert.equal(out.measuredCount, 0);
});

test('每个已知候选都有"为什么测不到"的原因文案', () => {
  for (const [id, reason] of Object.entries(UNMEASURED_REASONS)) {
    assert.ok(typeof reason === 'string' && reason.length > 4, id + ' 缺少原因文案');
  }
  assert.ok(UNMEASURED_REASONS['steam-p2p-joiner'].includes('真实对端'));
  assert.ok(UNMEASURED_REASONS['sl-relay-host'].includes('RELAY SELF-TEST'));
});

test('空输入不报错：没有候选就是空清单', () => {
  const out = describeRouteCandidates({});
  assert.deepEqual(out.candidates, []);
  assert.equal(out.measuredCount, 0);
  assert.equal(out.total, 0);
});
