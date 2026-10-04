'use strict';
// UDP 安全通道测试（阶段 3）：数据报握手、加密往返、口令错误、重放/篡改丢弃
// 运行：node --test --test-isolation=none test/secure-datagram.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');

const D = require('../network/secure-datagram.cjs');
const C = require('../network/crypto.cjs');
const h = require('./helpers.cjs');

const KEY = '203.0.113.7:40000';

/** 跑一次握手流程，返回各步结果（不预设成功，便于测试失败分支）。 */
function establish({ hostPass = 'udp-pass-1', clientPass = 'udp-pass-1' } = {}) {
  const host = new D.SecureDatagramHost({ passphrase: hostPass });
  const client = new D.SecureDatagramClient({ passphrase: clientPass });
  const helloReply = host.handle(client.hello(), KEY);
  const authReply = client.handle(helloReply.reply);
  const readyOrDeny = authReply.action === 'send' ? host.handle(authReply.reply, KEY) : null;
  return { host, client, helloReply, authReply, readyOrDeny };
}

test('数据报握手：口令一致时房主回 READY，加入者进入 ready，双方 sessionId 一致', () => {
  const { host, client, readyOrDeny } = establish();
  assert.equal(readyOrDeny.kind, 'ready');
  const final = client.handle(readyOrDeny.reply);
  assert.equal(final.action, 'ready');
  assert.equal(client.ready, true);
  assert.equal(client.sessionId, readyOrDeny.sessionId);
  assert.equal(host.hasSession(KEY), true);
  assert.equal(host.sessionsCount(), 1);
});

test('口令不一致：加入者在校验房主标签时就失败，房主侧不会建立会话', () => {
  const { host, client, authReply } = establish({ hostPass: 'right', clientPass: 'wrong' });
  assert.equal(authReply.action, 'error');
  assert.equal(authReply.reason, 'bad-tag');
  assert.equal(client.state, 'failed');
  assert.match(client.lastError, /口令不匹配/);
  assert.equal(host.hasSession(KEY), false);
});

test('伪造 AUTH 标签：房主拒绝并回 DENY（服务端检查生效）', () => {
  const host = new D.SecureDatagramHost({ passphrase: 'p' });
  const client = new D.SecureDatagramClient({ passphrase: 'p' });
  const helloReply = host.handle(client.hello(), KEY);
  const authReply = client.handle(helloReply.reply);
  assert.equal(authReply.action, 'send');
  const forged = Buffer.from(authReply.reply);
  forged[5] ^= 0xff;
  const denied = host.handle(forged, KEY);
  assert.equal(denied.kind, 'deny');
  assert.match(denied.reply.subarray(1).toString('utf8'), /口令不匹配/);
  assert.equal(host.hasSession(KEY), false);
});

test('加密数据报往返：两端都能解出原文，第三方拿到的只是密文', () => {
  const { host, client, readyOrDeny } = establish();
  client.handle(readyOrDeny.reply);

  const secret = 'UDP-SECRET-PAYLOAD-77';
  const fromClient = client.seal(Buffer.from(secret));
  assert.ok(fromClient && fromClient[0] === D.TYPE_DATA);
  assert.equal(fromClient.includes(Buffer.from(secret)), false, '链路上不应出现明文');

  const openedAtHost = host.handle(fromClient, KEY);
  assert.equal(openedAtHost.action, 'data');
  assert.equal(openedAtHost.payload.toString(), secret);

  const replyPacket = host.seal(KEY, Buffer.from('from-host'));
  const openedAtClient = client.handle(replyPacket);
  assert.equal(openedAtClient.action, 'data');
  assert.equal(openedAtClient.payload.toString(), 'from-host');
});

test('DATA 早于 READY 到达也能解密（UDP 不保证顺序）', () => {
  const { host, client, readyOrDeny } = establish();
  // 加入者在收到 READY 之前就发包（此时密钥已确定）
  const packet = client.seal(Buffer.from('early-bird'));
  assert.ok(packet, '拿到 HELLO_OK 之后就应该能加密');
  const opened = host.handle(packet, KEY);
  assert.equal(opened.action, 'data');
  assert.equal(opened.payload.toString(), 'early-bird');
  client.handle(readyOrDeny.reply);
  assert.equal(client.ready, true);
});

test('重放同一密文数据报会被丢弃，且不影响后续正常数据', () => {
  const { host, client, readyOrDeny } = establish();
  client.handle(readyOrDeny.reply);
  const packet = client.seal(Buffer.from('once-only'));
  assert.equal(host.handle(packet, KEY).action, 'data');
  const replay = host.handle(packet, KEY);
  assert.equal(replay.action, 'drop');
  assert.equal(replay.reason, 'replay');
  const next = client.seal(Buffer.from('next-one'));
  assert.equal(host.handle(next, KEY).action, 'data');
});

test('篡改密文数据报会被丢弃（GCM 认证失败）', () => {
  const { host, client, readyOrDeny } = establish();
  client.handle(readyOrDeny.reply);
  const packet = Buffer.from(client.seal(Buffer.from('tamper-udp')));
  packet[packet.length - 3] ^= 0xff;
  const result = host.handle(packet, KEY);
  assert.equal(result.action, 'drop');
  assert.equal(result.reason, 'auth-failed');
  // 后续正常包不受影响
  assert.equal(host.handle(client.seal(Buffer.from('still-fine')), KEY).action, 'data');
});

test('未握手的 DATA 会被丢弃（不能凭猜测发数据）', () => {
  const host = new D.SecureDatagramHost({ passphrase: 'p' });
  const client = new D.SecureDatagramClient({ passphrase: 'p' });
  const noHandshake = Buffer.concat([Buffer.from([D.TYPE_DATA]), Buffer.alloc(40, 7)]);
  assert.deepEqual(host.handle(noHandshake, KEY), { action: 'drop', reason: 'no-session' });
  assert.equal(client.handle(Buffer.from([D.TYPE_DATA, 1, 2, 3])).action, 'drop');
});

test('会话老化与清理：pending 超时丢弃，会话超时回收', () => {
  const host = new D.SecureDatagramHost({ passphrase: 'p', pendingTtlMs: 50, sessionIdleMs: 80 });
  const client = new D.SecureDatagramClient({ passphrase: 'p' });
  const helloReply = host.handle(client.hello(), KEY);
  host.sweep(Date.now() + 100);
  const lateAuth = client.handle(helloReply.reply);
  assert.equal(host.handle(lateAuth.reply, KEY).reason, 'no-pending', '过期的握手状态应被清理');

  // 重新完整握手后，会话空闲也会被回收
  const fresh = new D.SecureDatagramHost({ passphrase: 'p', sessionIdleMs: 60 });
  const c2 = new D.SecureDatagramClient({ passphrase: 'p' });
  const ok = fresh.handle(c2.hello(), KEY);
  const auth = c2.handle(ok.reply);
  fresh.handle(auth.reply, KEY);
  assert.equal(fresh.hasSession(KEY), true);
  fresh.sweep(Date.now() + 120);
  assert.equal(fresh.hasSession(KEY), false);
});

test('跨会话重放：把 A 会话的密文塞进 B 会话不被接受', () => {
  const first = establish();
  first.client.handle(first.readyOrDeny.reply);
  const stolenPacket = Buffer.from(first.client.seal(Buffer.from('from-session-A')));

  const second = establish();
  second.client.handle(second.readyOrDeny.reply);
  const result = second.host.handle(stolenPacket, KEY);
  assert.equal(result.action, 'drop');
  assert.ok(['auth-failed', 'replay'].includes(result.reason), `实际原因：${result.reason}`);
});

test('加入者可以在失败后重新握手（重传场景）', () => {
  const host = new D.SecureDatagramHost({ passphrase: 'p' });
  const client = new D.SecureDatagramClient({ passphrase: 'p' });
  const firstHello = client.hello();
  // 模拟第一次 HELLO 丢失：房主没收到，加入者重传
  const secondHello = client.hello();
  assert.equal(client.attempts, 2);
  const reply = host.handle(secondHello, KEY);
  assert.equal(reply.kind, 'hello-ok');
  const auth = client.handle(reply.reply);
  assert.equal(auth.action, 'send');
  const ready = host.handle(auth.reply, KEY);
  assert.equal(ready.kind, 'ready');
  assert.equal(client.handle(ready.reply).action, 'ready');
  void firstHello;
});

test('PSK 派生在两端一致（相同口令才能握上手的前提）', () => {
  const a = C.derivePsk('same-pass');
  const b = C.derivePsk('same-pass');
  const other = C.derivePsk('other-pass');
  assert.ok(a.equals(b));
  assert.ok(!a.equals(other));
  assert.equal(h.wait ? true : true, true);
});
