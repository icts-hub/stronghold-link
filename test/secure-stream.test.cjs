'use strict';
// TCP 安全通道测试（阶段 3）：握手认证、加密帧、篡改/重放拒绝、明文抦测
// 运行：node --test --test-isolation=none test/secure-stream.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { serverHandshake, clientHandshake, EncryptStream, DecryptStream } = require('../network/secure-stream.cjs');
const C = require('../network/crypto.cjs');
const h = require('./helpers.cjs');

/** 建一对已连接的 socket（服务端已 accept）。 */
function socketPair() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const client = net.createConnection({ host: '127.0.0.1', port });
      server.once('connection', (serverSide) => {
        server.close();
        client.setNoDelay(true);
        serverSide.setNoDelay(true);
        resolve({ client, server: serverSide });
      });
      client.once('error', reject);
    });
  });
}

/** 在两端跑完握手。必须先拿到房主侧结果并 accept()，加入者才会完成（真实中继也是这个顺序）。 */
async function handshakePair({ serverPass = 'pass-123456', clientPass = 'pass-123456', accept = true } = {}) {
  const { client, server } = await socketPair();
  const serverPending = serverHandshake(server, { passphrase: serverPass });
  const clientPending = clientHandshake(client, { passphrase: clientPass });
  const serverResult = await serverPending;
  const streams = accept ? serverResult.accept() : null;
  const clientResult = await clientPending;
  return { client, server, serverSide: serverResult, clientSide: clientResult, serverStreams: streams };
}

/** 把两条加密流接起来，返回一个「明文 socket」风格的接口。 */
function attachSecure(socket, rest, streams, extraRest) {
  socket.pipe(streams.decrypt);
  streams.encrypt.pipe(socket);
  streams.decrypt.on('error', () => socket.destroy());
  if (rest && rest.length) streams.decrypt.write(rest);
  if (extraRest && extraRest.length) streams.decrypt.write(extraRest);
  return streams;
}

test('双向认证握手：口令一致时两端得到同一个 sessionId 且能互相收发加密数据', async () => {
  const { client, server, serverSide, clientSide, serverStreams } = await handshakePair();
  try {
    assert.ok(serverSide.sessionId && serverSide.sessionId.length === 12);
    assert.equal(serverSide.sessionId, clientSide.sessionId, '两端应算出同一个会话标识');

    attachSecure(server, serverSide.rest, serverStreams);
    attachSecure(client, clientSide.rest, { encrypt: clientSide.encrypt, decrypt: clientSide.decrypt });

    const serverGot = new Promise((resolve) => serverStreams.decrypt.once('data', resolve));
    clientSide.encrypt.write(Buffer.from('hello-secure'));
    const received = await serverGot;
    assert.equal(received.toString(), 'hello-secure');

    const clientGot = new Promise((resolve) => clientSide.decrypt.once('data', resolve));
    serverStreams.encrypt.write(Buffer.from('reply-secure'));
    assert.equal((await clientGot).toString(), 'reply-secure');
  } finally {
    client.destroy();
    server.destroy();
  }
});

test('口令不一致：加入者立刻被告知口令不匹配，房主侧握手失败', async () => {
  const { client, server } = await socketPair();
  const serverSide = serverHandshake(server, { passphrase: 'right-pass' });
  const clientSide = clientHandshake(client, { passphrase: 'wrong-pass' });
  const clientError = clientSide.then(() => null, (err) => err);
  const serverError = serverSide.then(() => null, (err) => err);
  const [cErr, sErr] = await Promise.all([clientError, serverError]);
  assert.ok(cErr, '加入者必须报错');
  assert.match(cErr.message, /口令不匹配/);
  assert.ok(sErr, '房主也必须报错');
  assert.equal(sErr.reason, 'bad-tag');
  client.destroy();
  server.destroy();
});

test('篡改握手报文（改 hostNonce 一位）会被加入者识破', async () => {
  const { client, server } = await socketPair();
  // 房主正常握手，但在发出 OK-HELLO 前手动篡改 hostNonce
  const { serverHandshake: _unused } = require('../network/secure-stream.cjs');
  void _unused;
  const realWrite = server.write.bind(server);
  server.write = (data, ...rest) => {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    if (text.startsWith('SHL2-OK-HELLO')) {
      const parts = text.trim().split(/\s+/);
      const nonce = Buffer.from(parts[1], 'hex');
      nonce[0] ^= 0xff;
      parts[1] = nonce.toString('hex');
      return realWrite(`${parts.join(' ')}\n`, ...rest);
    }
    return realWrite(data, ...rest);
  };
  const serverSide = serverHandshake(server, { passphrase: 'p' });
  serverSide.catch(() => {});
  const clientSide = clientHandshake(client, { passphrase: 'p' });
  await assert.rejects(clientSide, (err) => {
    assert.match(err.message, /口令不匹配/);
    return true;
  });
  client.destroy();
  server.destroy();
});

test('加密通道：链路上抓到的字节里不含明文，且第三方无法解密', async () => {
  const secret = 'SECRET-GAME-PAYLOAD-9f3c1a';

  // 直接对一对 socket 做「中间人只读」观察
  const { client, server } = await socketPair();
  const seen = [];
  server.on('data', (chunk) => seen.push(chunk)); // 只读观察（不消费，LineReader 仍会收到）
  const serverPending = serverHandshake(server, { passphrase: 'wire-pass' });
  const clientPending = clientHandshake(client, { passphrase: 'wire-pass' });
  const sRes = await serverPending;
  const sStreams = sRes.accept();
  const cRes = await clientPending;
  attachSecure(server, sRes.rest, sStreams);
  attachSecure(client, cRes.rest, { encrypt: cRes.encrypt, decrypt: cRes.decrypt });
  seen.length = 0; // 只看握手之后的数据

  const got = new Promise((resolve) => sStreams.decrypt.once('data', resolve));
  cRes.encrypt.write(Buffer.from(secret));
  const plaintext = await got;
  assert.equal(plaintext.toString(), secret, '对端应能解出原文');

  await h.wait(150);
  const onWire = Buffer.concat(seen);
  assert.ok(onWire.length > 0, '应该在链路上看到字节');
  assert.equal(onWire.includes(Buffer.from(secret)), false, `链路字节里绝不能出现明文，实际抓到：${onWire.toString('latin1')}`);
  assert.equal(onWire.includes(Buffer.from('SECRET')), false);
  client.destroy();
  server.destroy();
});

test('篡改密文：解密流报错并断开，不会把坏数据交给游戏', async () => {
  const { client, server, serverSide, clientSide, serverStreams } = await handshakePair();
  const failures = [];
  serverStreams.decrypt.onFailure = (reason) => failures.push(reason);
  const errors = [];
  serverStreams.decrypt.on('error', (err) => errors.push(err));
  attachSecure(server, serverSide.rest, serverStreams);

  // 用同一方向的真实密钥封一条记录，再改掉一个密文字节
  const tampered = Buffer.from(clientSide.encrypt.sealer.seal(Buffer.from('tamper-me')));
  tampered[tampered.length - 5] ^= 0xff;
  serverStreams.decrypt.write(tampered);
  await h.wait(200);
  assert.deepEqual(failures, ['auth-failed']);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /加密校验失败|篡改/);
  client.destroy();
  server.destroy();
});

test('重放同一条加密记录会被拒绝（严格计数器）', async () => {
  const { client, server, serverSide, clientSide, serverStreams } = await handshakePair();
  const failures = [];
  serverStreams.decrypt.onFailure = (reason) => failures.push(reason);
  serverStreams.decrypt.on('error', () => {});
  attachSecure(server, serverSide.rest, serverStreams);

  const frame = clientSide.encrypt.sealer.seal(Buffer.from('once'));
  serverStreams.decrypt.write(frame);
  serverStreams.decrypt.write(frame); // 原样重放
  await h.wait(200);
  assert.deepEqual(failures, ['replay-or-gap']);
  client.destroy();
  server.destroy();
});

test('跨连接重放（把 A 会话的密文塞进 B 会话）不会被接受', async () => {
  const first = await handshakePair();
  const firstFrame = Buffer.from(first.clientSide.encrypt.sealer.seal(Buffer.from('from-session-A')));
  first.client.destroy();
  first.server.destroy();

  const { client, server, serverSide, serverStreams } = await handshakePair();
  const failures = [];
  serverStreams.decrypt.onFailure = (reason) => failures.push(reason);
  serverStreams.decrypt.on('error', () => {});
  attachSecure(server, serverSide.rest, serverStreams);
  serverStreams.decrypt.write(firstFrame);
  await h.wait(200);
  assert.deepEqual(failures, ['auth-failed'], '换会话后密钥不同，旧密文必须解不开');
  client.destroy();
  server.destroy();
});

test('恶意客户端伪造 AUTH 标签：房主侧的认证检查必须拦下并给出原因', async () => {
  const { client, server } = await socketPair();
  const serverPending = serverHandshake(server, { passphrase: 'shared-pass' });
  const serverError = serverPending.then(() => null, (err) => err);

  // 手工扮演一个「知道口令但故意发错标签」的客户端
  const { generateKeyPair, publicKeyRaw, randomBytes, derivePsk, sharedSecret, deriveSessionKeys, authTag, PROTOCOL_TAG } = C;
  const keys = generateKeyPair();
  const pub = publicKeyRaw(keys);
  const nonce = randomBytes(16);
  client.write(`SHL2 ${nonce.toString('hex')} ${pub.toString('hex')}\n`);
  const reply = await new Promise((resolve) => client.once('data', (chunk) => resolve(chunk.toString('utf8').trim())));
  const parts = reply.split(/\s+/);
  assert.equal(parts[0], 'SHL2-OK-HELLO');
  const hostNonce = Buffer.from(parts[1], 'hex');
  const hostPub = Buffer.from(parts[2], 'hex');
  const serverTag = Buffer.from(parts[3], 'hex');
  const psk = derivePsk('shared-pass');
  const sessionKeys = deriveSessionKeys({ sharedSecret: sharedSecret(keys, hostPub), psk, clientNonce: nonce, hostNonce });
  // 先用真标签确认房主标签本身是合法的，再故意发一个错误标签
  assert.ok(C.timingSafeEqual(authTag(sessionKeys.authKey, Buffer.concat([Buffer.from(PROTOCOL_TAG), nonce, pub, hostNonce, hostPub]), 'server'), serverTag));
  const wrongTag = Buffer.from(authTag(sessionKeys.authKey, Buffer.from('not-the-transcript'), 'client'));
  client.write(`SHL2-AUTH ${wrongTag.toString('hex')}\n`);

  const err = await serverError;
  assert.ok(err, '房主必须拒绝伪造标签');
  assert.equal(err.reason, 'bad-tag');
  const denyLine = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(''), 1000);
    client.on('data', (chunk) => { clearTimeout(timer); resolve(chunk.toString('utf8')); });
  });
  assert.match(denyLine, /SHL2-DENY/);
  assert.match(denyLine, /口令不匹配/);
  client.destroy();
  server.destroy();
});

test('旧版明文握手（SHL1）会被明确拒绝并给出升级提示', async () => {  const { client, server } = await socketPair();
  const serverSide = serverHandshake(server, { passphrase: 'p' });
  const serverError = serverSide.then(() => null, (err) => err);
  client.write('SHL1 some-token\n');
  const lines = [];
  client.on('data', (chunk) => lines.push(chunk.toString('utf8')));
  const err = await serverError;
  assert.equal(err.reason, 'legacy-peer');
  await h.wait(150);
  assert.match(lines.join(''), /0\.5\.0 之前/);
  client.destroy();
  server.destroy();
});

test('非协议数据（例如直接把游戏客户端接到加密端口）会被拒绝', async () => {
  const { client, server } = await socketPair();
  const serverSide = serverHandshake(server, { passphrase: 'p' });
  const serverError = serverSide.then(() => null, (err) => err);
  client.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
  const err = await serverError;
  assert.equal(err.reason, 'bad-protocol');
  client.destroy();
  server.destroy();
});

test('握手超时：对端不回应时房主在超时后放弃', async () => {
  const { client, server } = await socketPair();
  const started = Date.now();
  const err = await serverHandshake(server, { passphrase: 'p', timeoutMs: 400 }).then(() => null, (e) => e);
  assert.ok(err, '应超时失败');
  assert.equal(err.reason, 'timeout');
  assert.ok(Date.now() - started >= 350, '不应过早失败');
  client.destroy();
  server.destroy();
});

test('大数据量经加密流往返仍然逐字节一致', async () => {
  const { client, server, serverSide, clientSide, serverStreams } = await handshakePair();
  attachSecure(server, serverSide.rest, serverStreams);
  attachSecure(client, clientSide.rest, { encrypt: clientSide.encrypt, decrypt: clientSide.decrypt });

  const payload = Buffer.alloc(512 * 1024);
  for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
  const received = h.collect(serverStreams.decrypt, payload.length, 8000);
  clientSide.encrypt.write(payload);
  const result = await received;
  assert.equal(result.length, payload.length);
  assert.ok(result.equals(payload), '512KiB 经加密流必须逐字节一致');
  client.destroy();
  server.destroy();
});

test('EncryptStream / DecryptStream 作为独立流可用（分片写入也能还原）', async () => {
  const key = C.randomBytes(32);
  const encrypt = new EncryptStream(C.createSealer(key));
  const decrypt = new DecryptStream(C.createOpener(key));
  encrypt.pipe(decrypt);
  // 制造 TCP 分片：把帧切碎写入
  const frame = C.createSealer(key).seal(Buffer.from('fragmented-payload'));
  const chunks = [];
  decrypt.on('data', (chunk) => chunks.push(chunk));
  for (let i = 0; i < frame.length; i += 3) decrypt.write(frame.subarray(i, i + 3));
  await h.wait(150);
  assert.equal(Buffer.concat(chunks).toString(), 'fragmented-payload');
});
