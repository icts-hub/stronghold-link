'use strict';
// 会话安全原语测试（阶段 3）
// 运行：node --test --test-isolation=none test/crypto.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');

const c = require('../network/crypto.cjs');

test('PSK 派生：同口令同盐得到同一密钥，不同口令/不同盐得到不同密钥', () => {
  const a = c.derivePsk('correct horse', 'salt-1');
  const b = c.derivePsk('correct horse', 'salt-1');
  const d = c.derivePsk('correct horse', 'salt-2');
  const e = c.derivePsk('correct horse!', 'salt-1');
  assert.equal(a.length, 32);
  assert.ok(a.equals(b), '同输入必须确定');
  assert.ok(!a.equals(d), '换盐必须换密钥');
  assert.ok(!a.equals(e), '换口令必须换密钥');
  assert.throws(() => c.derivePsk(''), /不能为空/);
});

test('X25519：双方协商出相同的共享秘密，公钥为 32 字节', () => {
  const alice = c.generateKeyPair();
  const bob = c.generateKeyPair();
  const alicePub = c.publicKeyRaw(alice);
  const bobPub = c.publicKeyRaw(bob);
  assert.equal(alicePub.length, 32);
  assert.equal(bobPub.length, 32);
  const s1 = c.sharedSecret(alice, bobPub);
  const s2 = c.sharedSecret(bob, alicePub);
  assert.equal(s1.length, 32);
  assert.ok(s1.equals(s2), 'ECDH 双方必须一致');
  assert.ok(!s1.equals(c.sharedSecret(alice, c.publicKeyRaw(c.generateKeyPair()))), '换对端必须换秘密');
});

test('会话密钥派生：握手双方得到相同密钥，方向密钥不同，缺 PSK 或 ECDH 都推不出来', () => {
  const client = c.generateKeyPair();
  const server = c.generateKeyPair();
  const clientNonce = c.randomBytes(16);
  const hostNonce = c.randomBytes(16);
  const psk = c.derivePsk('passphrase');
  const ecdhC = c.sharedSecret(client, c.publicKeyRaw(server));
  const ecdhS = c.sharedSecret(server, c.publicKeyRaw(client));

  const keysC = c.deriveSessionKeys({ sharedSecret: ecdhC, psk, clientNonce, hostNonce });
  const keysS = c.deriveSessionKeys({ sharedSecret: ecdhS, psk, clientNonce, hostNonce });
  assert.ok(keysC.clientToServer.equals(keysS.clientToServer));
  assert.ok(keysC.serverToClient.equals(keysS.serverToClient));
  assert.ok(keysC.authKey.equals(keysS.authKey));
  assert.ok(!keysC.clientToServer.equals(keysC.serverToClient), '两个方向必须是不同密钥');

  // 口令不同 => 一切不同（认证意义所在）
  const wrong = c.deriveSessionKeys({ sharedSecret: ecdhS, psk: c.derivePsk('other'), clientNonce, hostNonce });
  assert.ok(!wrong.authKey.equals(keysC.authKey));
  assert.ok(!wrong.clientToServer.equals(keysC.clientToServer));

  // nonce 不同 => 密钥不同（防跨会话复用）
  const otherNonce = c.deriveSessionKeys({ sharedSecret: ecdhS, psk, clientNonce: c.randomBytes(16), hostNonce });
  assert.ok(!otherNonce.clientToServer.equals(keysC.clientToServer));
});

test('认证标签覆盖握手记录：篡改 nonce/公钥/角色都会导致校验失败', () => {
  const psk = c.derivePsk('pass');
  const authKey = c.deriveSessionKeys({
    sharedSecret: c.sharedSecret(c.generateKeyPair(), c.publicKeyRaw(c.generateKeyPair())),
    psk,
    clientNonce: c.randomBytes(16),
    hostNonce: c.randomBytes(16),
  }).authKey;
  const transcript = Buffer.from('transcript-bytes');
  const tag = c.authTag(authKey, transcript, 'server');
  assert.ok(c.timingSafeEqual(tag, c.authTag(authKey, transcript, 'server')));
  assert.ok(!c.timingSafeEqual(tag, c.authTag(authKey, Buffer.from('tampered'), 'server')));
  assert.ok(!c.timingSafeEqual(tag, c.authTag(authKey, transcript, 'client')), '方向标签必须不同（防反射）');
  assert.ok(!c.timingSafeEqual(tag, c.authTag(c.derivePsk('other'), transcript, 'server')));
});

test('AEAD 记录：往返一致、计数器递增、篡改/重放/换密钥都解不开', () => {
  const key = c.randomBytes(32);
  const otherKey = c.randomBytes(32);
  const sealer = c.createSealer(key);
  const opener = c.createOpener(key);
  const otherOpener = c.createOpener(otherKey);

  const payload = Buffer.from('游戏数据 hello 世界');
  const f1 = sealer.seal(payload);
  const f2 = sealer.seal(payload);
  assert.notEqual(f1.readBigUInt64BE(4), f2.readBigUInt64BE(4), '计数器必须递增');
  assert.ok(!f1.subarray(12).includes(payload.subarray(0, 6)), '密文里不应出现明文片段');

  const r1 = opener.open(f1);
  assert.equal(r1.ok, true);
  assert.ok(r1.plaintext.equals(payload));

  // 重放同一条记录
  assert.deepEqual(opener.open(f1), { ok: false, reason: 'replay-or-gap' });
  // 顺序错乱（先开后到）
  assert.deepEqual(opener.open(f2), { ok: true, plaintext: payload });

  // 篡改密文
  const f3 = sealer.seal(Buffer.from('tamper-me'));
  const tampered = Buffer.from(f3);
  tampered[tampered.length - c.TAG_LENGTH - 1] ^= 0xff;
  assert.deepEqual(opener.open(tampered), { ok: false, reason: 'auth-failed' });

  // 篡改计数器（等价于重放）
  const f4 = sealer.seal(Buffer.from('counter'));
  const reCountered = Buffer.from(f4);
  reCountered.writeBigUInt64BE(0n, 4);
  assert.equal(opener.open(reCountered).ok, false);

  // 长度字段与实际不符
  const f5 = sealer.seal(Buffer.from('length'));
  const badLen = Buffer.from(f5);
  badLen.writeUInt32BE(badLen.readUInt32BE(0) + 1, 0);
  assert.deepEqual(opener.open(badLen), { ok: false, reason: 'length-mismatch' });

  // 换密钥解不开（用新的封装器保证计数器对齐，否则会先被顺序检查拦下）
  const freshSealer = c.createSealer(key);
  const f6 = freshSealer.seal(Buffer.from('secret'));
  assert.deepEqual(otherOpener.open(f6), { ok: false, reason: 'auth-failed' });

  // 空载荷与上限（用独立的封装/解封对，避免受上面的计数器推进影响）
  const pairSealer = c.createSealer(key);
  const pairOpener = c.createOpener(key);
  const empty = pairSealer.seal(Buffer.alloc(0));
  assert.equal(pairOpener.open(empty).ok, true);
  assert.throws(() => sealer.seal(Buffer.alloc(c.MAX_RECORD_LENGTH + 1)), /大小上限/);
});

test('UDP 重放窗口：乱序接受、重复拒绝、过旧拒绝', () => {
  const win = c.createReplayWindow(16);
  assert.equal(win.accept(0n), true);
  assert.equal(win.accept(0n), false, '重复必须拒绝');
  assert.equal(win.accept(5n), true, '乱序在窗口内应接受');
  assert.equal(win.accept(2n), true, '回填旧序号应接受');
  assert.equal(win.accept(2n), false);
  assert.equal(win.accept(100n), true);
  assert.equal(win.accept(1n), false, '落后超过窗口大小应拒绝');
  assert.equal(win.accept(99n), true);
  assert.equal(win.highest, 100n);
});

test('timingSafeEqual 对不同长度返回 false 且不抛错', () => {
  assert.equal(c.timingSafeEqual(Buffer.from('abc'), Buffer.from('abc')), true);
  assert.equal(c.timingSafeEqual(Buffer.from('abc'), Buffer.from('abd')), false);
  assert.equal(c.timingSafeEqual(Buffer.from('abc'), Buffer.from('abcd')), false);
});
