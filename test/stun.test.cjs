'use strict';
// 网络 PHASE 6（STUN 协议层）单测：请求构造、响应解析、XOR-MAPPED-ADDRESS 解码、异常输入。
// 全部用按 RFC 5389 手工拼的字节向量验证，不联网。

const test = require('node:test');
const assert = require('node:assert');

const S = require('../network/direct-udp/stun.cjs');

/** 按 RFC 5389 拼一条 Binding Response。 */
function buildResponse({ transactionId, xorAddress = '203.0.113.7', xorPort = 54321, extra = [] } = {}) {
  const id = Buffer.from(transactionId);
  const attrs = [];

  const addr = Buffer.from(xorAddress.split('.').map(Number));
  const cookie = Buffer.alloc(4);
  cookie.writeUInt32BE(S.MAGIC_COOKIE, 0);
  const xAddr = Buffer.from(addr.map((b, i) => b ^ cookie[i]));
  const xPort = xorPort ^ (S.MAGIC_COOKIE >>> 16);
  const xorValue = Buffer.alloc(8);
  xorValue.writeUInt8(0, 0);
  xorValue.writeUInt8(0x01, 1);
  xorValue.writeUInt16BE(xPort, 2);
  xAddr.copy(xorValue, 4);
  const xorAttr = Buffer.alloc(4 + 8);
  xorAttr.writeUInt16BE(S.ATTR.XOR_MAPPED_ADDRESS, 0);
  xorAttr.writeUInt16BE(8, 2);
  xorValue.copy(xorAttr, 4);
  attrs.push(xorAttr);

  for (const attr of extra) attrs.push(attr);

  const body = Buffer.concat(attrs);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(S.MESSAGE_TYPES.BINDING_RESPONSE, 0);
  header.writeUInt16BE(body.length, 2);
  header.writeUInt32BE(S.MAGIC_COOKIE, 4);
  id.copy(header, 8);
  return Buffer.concat([header, body]);
}

test('Binding Request：20 字节、类型 0x0001、带 magic cookie 与 12 字节事务 ID', () => {
  const { buffer, transactionId } = S.buildBindingRequest();
  assert.equal(buffer.length, 20);
  assert.equal(buffer.readUInt16BE(0), S.MESSAGE_TYPES.BINDING_REQUEST);
  assert.equal(buffer.readUInt16BE(2), 0, '请求无属性，长度字段为 0');
  assert.equal(buffer.readUInt32BE(4), S.MAGIC_COOKIE);
  assert.equal(transactionId.length, 12);
  assert.equal(buffer.subarray(8, 20).toString('hex'), transactionId.toString('hex'));
});

test('事务 ID 必须是 12 字节，否则当场报错', () => {
  assert.throws(() => S.buildBindingRequest({ transactionId: Buffer.alloc(8) }), /12 字节/);
});

test('解析响应：XOR-MAPPED-ADDRESS 正确还原公网地址与端口', () => {
  const transactionId = S.newTransactionId();
  const response = buildResponse({ transactionId, xorAddress: '198.51.100.23', xorPort: 40000 });
  const parsed = S.parseMessage(response);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.typeName, 'BINDING_RESPONSE');
  assert.equal(parsed.transactionId, transactionId.toString('hex'));
  assert.deepEqual(parsed.xorMapped, { family: 'IPv4', port: 40000, address: '198.51.100.23' });
  assert.equal(S.matchesTransaction(parsed, transactionId), true);
});

test('MAPPED-ADDRESS（非 XOR）也能解，且两种属性可共存', () => {
  const transactionId = S.newTransactionId();
  const mappedValue = Buffer.alloc(8);
  mappedValue.writeUInt8(0, 0);
  mappedValue.writeUInt8(0x01, 1);
  mappedValue.writeUInt16BE(1234, 2);
  Buffer.from([10, 0, 0, 5]).copy(mappedValue, 4);
  const attr = Buffer.alloc(12);
  attr.writeUInt16BE(S.ATTR.MAPPED_ADDRESS, 0);
  attr.writeUInt16BE(8, 2);
  mappedValue.copy(attr, 4);

  const parsed = S.parseMessage(buildResponse({ transactionId, extra: [attr] }));
  assert.deepEqual(parsed.mapped, { family: 'IPv4', port: 1234, address: '10.0.0.5' });
  assert.equal(parsed.xorMapped.address, '203.0.113.7');
});

test('ERROR_CODE 属性解析成 3 位数字与原因文本', () => {
  const reason = Buffer.from('Unauthorized', 'utf8');
  const value = Buffer.alloc(4 + reason.length);
  value.writeUInt16BE(0, 0);
  value.writeUInt8(4, 2);          // class 4
  value.writeUInt8(1, 3);          // number 1 → 401
  reason.copy(value, 4);
  const attr = Buffer.alloc(4 + value.length);
  attr.writeUInt16BE(S.ATTR.ERROR_CODE, 0);
  attr.writeUInt16BE(value.length, 2);
  value.copy(attr, 4);

  const parsed = S.parseMessage(buildResponse({ transactionId: S.newTransactionId(), extra: [attr] }));
  assert.equal(parsed.errorCode, 401);
  assert.equal(parsed.reason, 'Unauthorized');
});

test('属性按 4 字节对齐跳过填充，后续属性仍能读到', () => {
  const transactionId = S.newTransactionId();
  // 先放一个长度为 5 的属性（需补 3 字节填充），再放 XOR-MAPPED-ADDRESS
  const paddingAttr = Buffer.alloc(4 + 5 + 3);
  paddingAttr.writeUInt16BE(0x8022, 0);   // SOFTWARE
  paddingAttr.writeUInt16BE(5, 2);
  Buffer.from('hello').copy(paddingAttr, 4);
  const parsed = S.parseMessage(buildResponse({ transactionId, extra: [paddingAttr] }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.xorMapped.address, '203.0.113.7', '填充跳过后仍应读到 XOR 地址');
});

test('异常输入一律如实拒绝，不抛异常', () => {
  assert.match(S.parseMessage(Buffer.alloc(4)).reason, /消息过短/);
  const badCookie = buildResponse({ transactionId: S.newTransactionId() });
  badCookie.writeUInt32BE(0xdeadbeef, 4);
  assert.match(S.parseMessage(badCookie).reason, /magic cookie/);
  const notStun = Buffer.alloc(20);
  notStun.writeUInt16BE(0x8001, 0);       // 类型高两位非 0
  assert.match(S.parseMessage(notStun).reason, /不是 STUN/);
  const shortBody = buildResponse({ transactionId: S.newTransactionId() });
  shortBody.writeUInt16BE(999, 2);        // 长度字段大于实际
  assert.match(S.parseMessage(shortBody).reason, /长度字段/);
});

test('事务 ID 不匹配时如实返回 false（不把别人的响应当自己的）', () => {
  const parsed = S.parseMessage(buildResponse({ transactionId: S.newTransactionId() }));
  assert.equal(S.matchesTransaction(parsed, S.newTransactionId()), false);
  assert.equal(S.matchesTransaction(null, 'abc'), false);
});
