'use strict';
// 网络 PHASE 6（打洞状态机）单测：用假 socket + 可控时钟验证双向打洞与失败路径。

const test = require('node:test');
const assert = require('node:assert');

const P = require('../network/direct-udp/punch.cjs');

function fakeSocket() {
  const sent = [];
  return {
    sent,
    send(buffer, port, address) { sent.push({ buffer: Buffer.from(buffer), port, address }); },
  };
}

function setup({ candidates = [{ address: '203.0.113.5', port: 40000 }], policy = {}, socket = fakeSocket() } = {}) {
  let clock = 1_000_000;
  const events = [];
  const puncher = P.createPuncher({
    socket,
    remoteCandidates: candidates,
    policy: { intervalMs: 250, budgetMs: 2000, ...policy },
    now: () => clock,
    onEstablished: (peer) => events.push({ type: 'established', peer }),
    onFailed: (reason) => events.push({ type: 'failed', reason }),
  });
  return { puncher, socket, events, advance: (ms) => { clock += ms; } };
}

test('包格式：magic + 类型 + 8 字节 nonce，解析严格', () => {
  const nonce = Buffer.from('0102030405060708', 'hex');
  const probe = P.buildPacket(P.PROBE_TYPE, nonce);
  assert.equal(probe.length, 13);
  assert.deepEqual(P.parsePacket(probe), { type: P.PROBE_TYPE, nonceHex: '0102030405060708' });
  assert.equal(P.parsePacket(Buffer.from('XXXX')), null, 'magic 不对要拒绝');
  assert.equal(P.parsePacket(Buffer.alloc(13)), null, 'magic 全 0 要拒绝');
  const badType = P.buildPacket(P.PROBE_TYPE, nonce);
  badType.writeUInt8(9, 4);
  assert.equal(P.parsePacket(badType), null, '未知类型要拒绝');
  assert.equal(P.parsePacket(Buffer.alloc(4)), null, '长度不对要拒绝');
});

test('启动：向所有候选各发一个探测包，并进入 punching', () => {
  const { puncher, socket } = setup({ candidates: [{ address: 'a', port: 1 }, { address: 'b', port: 2 }, { address: 'bad', port: 0 }] });
  const out = puncher.start();
  assert.equal(out.state, 'punching');
  assert.equal(socket.sent.length, 2, '端口非法的候选要过滤掉');
  assert.equal(puncher.snapshot().candidates, 2);
  assert.equal(puncher.snapshot().attempts, 1);
});

test('按间隔重复探测，超预算后如实失败并给原因', () => {
  const { puncher, socket, events, advance } = setup({ policy: { budgetMs: 1000, intervalMs: 250 } });
  puncher.start();
  for (let i = 0; i < 5; i += 1) { advance(250); puncher.tick(); }
  const snap = puncher.snapshot();
  assert.equal(snap.state, 'failed');
  assert.match(snap.reason, /打洞超时/);
  assert.ok(snap.attempts >= 4, '预算内应多次探测，实际 ' + snap.attempts);
  assert.ok(socket.sent.length >= snap.attempts, '每次探测至少发一个候选');
  assert.equal(events.filter((e) => e.type === 'failed').length, 1, '失败事件只报一次');
});

test('对端先打进来：立刻算打通，并回一个确认', () => {
  const { puncher, socket, events } = setup();
  puncher.start();
  const before = socket.sent.length;
  const nonce = Buffer.from('0a0b0c0d0e0f1011', 'hex');
  const out = puncher.handlePacket(P.buildPacket(P.PROBE_TYPE, nonce), { address: '198.51.100.9', port: 5555 });
  assert.equal(out.established, true);
  assert.equal(puncher.state, 'established');
  assert.deepEqual(puncher.snapshot().peer, { address: '198.51.100.9', port: 5555 });
  assert.equal(socket.sent.length, before + 1, '要回一个确认包');
  assert.equal(P.parsePacket(socket.sent[socket.sent.length - 1].buffer).type, P.ACK_TYPE);
  assert.equal(events[0].type, 'established');
});

test('收到自己探测的确认：peer 用确认来源，且标记 confirmed', () => {
  const { puncher, socket } = setup();
  puncher.start();
  const ourNonce = P.parsePacket(socket.sent[0].buffer).nonceHex;
  const out = puncher.handlePacket(P.buildPacket(P.ACK_TYPE, Buffer.from(ourNonce, 'hex')), { address: '203.0.113.5', port: 40000 });
  assert.equal(out.established, true);
  assert.equal(out.confirmed, true);
  assert.equal(puncher.snapshot().confirmed, true);
  assert.match(puncher.snapshot().reason, /确认/);
});

test('陌生 nonce 的确认包不能把连接"打成已建立"（防误判）', () => {
  const { puncher } = setup();
  puncher.start();
  const out = puncher.handlePacket(P.buildPacket(P.ACK_TYPE, Buffer.from('ffffffffffffffff', 'hex')), { address: '10.0.0.1', port: 9 });
  assert.equal(out.ignored, 'nonce 不是本端发出的');
  assert.equal(puncher.state, 'punching', '状态不能变');
  assert.equal(puncher.snapshot().peer, null);
});

test('重复的探测包只处理一次（去重），其它协议的包原样忽略', () => {
  const { puncher, socket } = setup();
  puncher.start();
  const nonce = Buffer.from('1111111111111111', 'hex');
  puncher.handlePacket(P.buildPacket(P.PROBE_TYPE, nonce), { address: '1.1.1.1', port: 1 });
  const replies = socket.sent.length;
  const dup = puncher.handlePacket(P.buildPacket(P.PROBE_TYPE, nonce), { address: '1.1.1.1', port: 1 });
  assert.equal(dup.duplicate, true);
  assert.equal(socket.sent.length, replies, '重复包不再回确认');
  assert.equal(puncher.handlePacket(Buffer.from('hello world!!'), { address: '1.1.1.1', port: 1 }).handled, false);
  assert.equal(puncher.handlePacket(P.buildPacket(P.PROBE_TYPE, nonce), null).handled, false, '缺来源地址要拒绝');
});

test('没有 socket 或没有候选：如实失败，不假装在打洞', () => {
  const noSocket = P.createPuncher({ socket: null, remoteCandidates: [{ address: 'a', port: 1 }] });
  assert.equal(noSocket.start().state, 'failed');
  assert.match(noSocket.snapshot().reason, /没有可用的 UDP socket/);

  const noCandidates = P.createPuncher({ socket: fakeSocket(), remoteCandidates: [] });
  assert.equal(noCandidates.start().state, 'failed');
  assert.match(noCandidates.snapshot().reason, /没有可用的对端候选地址/);
});

test('打通后再 tick 不改变状态，也不再多发探测', () => {
  const { puncher, socket, advance } = setup();
  puncher.start();
  puncher.handlePacket(P.buildPacket(P.PROBE_TYPE, Buffer.from('2222222222222222', 'hex')), { address: '2.2.2.2', port: 2 });
  const sent = socket.sent.length;
  advance(5000);
  const snap = puncher.tick();
  assert.equal(snap.state, 'established');
  assert.equal(socket.sent.length, sent, '已打通就不再发探测包');
  assert.ok(snap.elapsedMs >= 0);
});

test('stop：未打通时算失败并保留原因，已打通时保持打通', () => {
  const a = setup();
  a.puncher.start();
  assert.equal(a.puncher.stop().state, 'failed');
  const b = setup();
  b.puncher.start();
  b.puncher.handlePacket(P.buildPacket(P.PROBE_TYPE, Buffer.from('3333333333333333', 'hex')), { address: '3.3.3.3', port: 3 });
  assert.equal(b.puncher.stop().state, 'established');
});
