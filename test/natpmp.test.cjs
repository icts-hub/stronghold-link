'use strict';
// 网络 PHASE 6（NAT-PMP）单测：请求字节、响应解析、结果码、异常输入。
// 全部按 RFC 6886 手工拼字节验证，不联网。

const test = require('node:test');
const assert = require('node:assert');

const N = require('../network/direct-udp/natpmp.cjs');

test('公网地址请求：2 字节，版本 0 + 操作码 0', () => {
  const buf = N.buildExternalAddressRequest();
  assert.equal(buf.length, 2);
  assert.deepEqual([...buf], [0, 0]);
});

test('映射请求：12 字节定长，字段位置与字节序正确', () => {
  const buf = N.buildMapRequest({ protocol: 'udp', internalPort: 40000, externalPort: 40001, lifetimeSeconds: 7200 });
  assert.equal(buf.length, 12);
  assert.equal(buf.readUInt8(0), 0, '版本');
  assert.equal(buf.readUInt8(1), N.OPCODES.MAP_UDP, 'UDP 操作码 1');
  assert.equal(buf.readUInt16BE(2), 0, '保留字段为 0');
  assert.equal(buf.readUInt16BE(4), 40000, '本机端口');
  assert.equal(buf.readUInt16BE(6), 40001, '建议外部端口');
  assert.equal(buf.readUInt32BE(8), 7200, '生命周期');

  const tcp = N.buildMapRequest({ protocol: 'tcp', internalPort: 22 });
  assert.equal(tcp.readUInt8(1), N.OPCODES.MAP_TCP, 'TCP 操作码 2');
  assert.equal(tcp.readUInt16BE(6), 0, '不指定时外部端口为 0（由网关决定）');
});

test('删除映射：生命周期 0', () => {
  const buf = N.buildDeleteMappingRequest({ protocol: 'udp', internalPort: 40000 });
  assert.equal(buf.readUInt32BE(8), 0);
  assert.equal(buf.readUInt16BE(4), 40000);
});

test('请求参数非法时当场报错', () => {
  assert.throws(() => N.buildMapRequest({ internalPort: 0 }), /1–65535/);
  assert.throws(() => N.buildMapRequest({ internalPort: 70000 }), /1–65535/);
  assert.throws(() => N.buildMapRequest({ internalPort: 100, lifetimeSeconds: -1 }), /生命周期/);
  assert.throws(() => N.buildMapRequest({ internalPort: 100, externalPort: 70000 }), /外部端口/);
});

test('解析公网地址响应：成功时带出 epoch 与地址', () => {
  const buf = Buffer.alloc(12);
  buf.writeUInt8(0, 0);
  buf.writeUInt8(0, 1);
  buf.writeUInt16BE(0, 2);                  // 成功
  buf.writeUInt32BE(123456, 4);             // epoch
  Buffer.from([203, 0, 113, 9]).copy(buf, 8);
  const parsed = N.parseResponse(buf, { expect: 'external' });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.epoch, 123456);
  assert.equal(parsed.externalAddress, '203.0.113.9');
  assert.equal(parsed.reason, null);
});

test('解析映射响应：成功时带出内外端口与生命周期', () => {
  const buf = Buffer.alloc(16);
  buf.writeUInt8(0, 0);
  buf.writeUInt8(1, 1);
  buf.writeUInt16BE(0, 2);
  buf.writeUInt32BE(999, 4);
  buf.writeUInt16BE(40000, 8);
  buf.writeUInt16BE(40001, 10);
  buf.writeUInt32BE(3600, 12);
  const parsed = N.parseResponse(buf, { expect: 'map' });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.internalPort, 40000);
  assert.equal(parsed.externalPort, 40001);
  assert.equal(parsed.lifetime, 3600);
});

test('失败结果码：ok=false 且给出中文原因（不谎报成功）', () => {
  const buf = Buffer.alloc(16);              // 完整长度，否则会先被长度校验拦下
  buf.writeUInt8(0, 0);
  buf.writeUInt8(1, 1);
  buf.writeUInt16BE(2, 2);                  // 未获授权
  const parsed = N.parseResponse(buf, { expect: 'map' });
  assert.equal(parsed.ok, false, '结果码非 0 就不能算成功');
  assert.equal(parsed.resultCode, 2);
  assert.match(parsed.reason, /未获授权/);
  assert.equal(N.resultName(5), '不支持该操作码');
  assert.match(N.resultName(99), /未知结果码 99/);
});

test('长度不符与过短输入如实拒绝', () => {
  assert.match(N.parseResponse(Buffer.alloc(2)).reason, /响应过短/);
  const mapButShort = Buffer.alloc(8);
  mapButShort.writeUInt16BE(0, 2);
  assert.match(N.parseResponse(mapButShort, { expect: 'map' }).reason, /映射响应应为 16 字节/);
  assert.match(N.parseResponse(mapButShort, { expect: 'external' }).reason, /公网地址响应应为 12 字节/);
});

test('版本不符时拒绝并报出版本号', () => {
  const buf = Buffer.alloc(12);
  buf.writeUInt8(1, 0);                     // 版本 1（未支持）
  const parsed = N.parseResponse(buf, { expect: 'external' });
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /版本不受支持：1/);
});

test('不声明期望类型时按长度推断，并标注推断依据', () => {
  const ext = Buffer.alloc(12);
  Buffer.from([192, 168, 1, 2]).copy(ext, 8);
  assert.equal(N.parseResponse(ext).inferred, 'external');
  const map = Buffer.alloc(16);
  assert.equal(N.parseResponse(map).inferred, 'map');
});
