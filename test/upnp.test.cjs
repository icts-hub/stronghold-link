'use strict';
// 网络 PHASE 6（UPnP IGD）单测：SSDP 请求/响应、controlURL 解析、SOAP 报文与故障解析。

const test = require('node:test');
const assert = require('node:assert');

const U = require('../network/direct-udp/upnp.cjs');

const DEVICE_XML = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType>
        <controlURL>/ctl/L3F</controlURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
        <controlURL>/ctl/IPConn</controlURL>
      </service>
    </serviceList>
  </device>
</root>`;

function ssdpResponse({ location = 'http://192.168.1.1:1900/igd.xml', extra = '' } = {}) {
  return [
    'HTTP/1.1 200 OK',
    'CACHE-CONTROL: max-age=120',
    'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1',
    'USN: uuid:abc::urn:schemas-upnp-org:device:InternetGatewayDevice:1',
    'LOCATION: ' + location,
    'SERVER: Linux/3.14 UPnP/1.0 MiniUPnPd/2.1',
    extra,
    '',
    '',
  ].join('\r\n');
}

test('SSDP 请求：M-SEARCH 头齐全，MX 夹到 1–5 秒', () => {
  const text = U.buildSsdpSearch();
  assert.match(text, /^M-SEARCH \* HTTP\/1\.1\r\n/);
  assert.match(text, /HOST: 239\.255\.255\.250:1900/);
  assert.match(text, /MAN: "ssdp:discover"/);
  assert.match(text, /MX: 2/);
  assert.match(text, /ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1/);
  assert.match(U.buildSsdpSearch({ mx: 99 }), /MX: 5/, 'MX 超过 5 应夹到 5');
  assert.match(U.buildSsdpSearch({ mx: 0 }), /MX: 1/, 'MX 小于 1 应夹到 1');
});

test('SSDP 响应：解析 LOCATION / SERVER / ST / USN', () => {
  const parsed = U.parseSsdpResponse(ssdpResponse());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.location, 'http://192.168.1.1:1900/igd.xml');
  assert.match(parsed.server, /MiniUPnPd/);
  assert.match(parsed.st, /InternetGatewayDevice/);
  assert.match(parsed.usn, /^uuid:abc/);
});

test('SSDP 响应：非 200 或缺 LOCATION 都如实拒绝', () => {
  assert.match(U.parseSsdpResponse('HTTP/1.1 404 Not Found\r\n\r\n').reason, /不是 200/);
  assert.match(U.parseSsdpResponse('HTTP/1.1 200 OK\r\nSERVER: x\r\n\r\n').reason, /缺少 LOCATION/);
  assert.match(U.parseSsdpResponse('').reason, /空响应/);
});

test('controlURL：只认 WAN 连接服务，并解析成绝对地址', () => {
  const hit = U.resolveControlUrl(DEVICE_XML, 'http://192.168.1.1:1900/igd.xml');
  assert.equal(hit.ok, true);
  assert.equal(hit.serviceType, 'urn:schemas-upnp-org:service:WANIPConnection:1');
  assert.equal(hit.controlUrl, 'http://192.168.1.1:1900/ctl/IPConn', '相对路径要按 baseUrl 补全');
});

test('controlURL：没有 WAN 服务时给出可读原因（不猜）', () => {
  const xml = DEVICE_XML.replace('WANIPConnection', 'WANCommonInterfaceConfig');
  const miss = U.resolveControlUrl(xml, 'http://192.168.1.1:1900/igd.xml');
  assert.equal(miss.ok, false);
  assert.match(miss.reason, /没有 WANIPConnection/);
  assert.equal(U.resolveControlUrl('', 'http://x/').ok, false);
});

test('添加映射的 SOAP 报文：动作、服务类型与八个字段齐全', () => {
  const xml = U.buildAddPortMappingEnvelope({
    externalPort: 40000, internalPort: 40000, internalClient: '192.168.1.20', protocol: 'udp', leaseSeconds: 1800, description: 'SHL test',
  });
  assert.match(xml, /<u:AddPortMapping xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">/);
  assert.match(xml, /<NewExternalPort>40000<\/NewExternalPort>/);
  assert.match(xml, /<NewInternalPort>40000<\/NewInternalPort>/);
  assert.match(xml, /<NewProtocol>UDP<\/NewProtocol>/, '协议统一大写');
  assert.match(xml, /<NewInternalClient>192\.168\.1\.20<\/NewInternalClient>/);
  assert.match(xml, /<NewEnabled>1<\/NewEnabled>/);
  assert.match(xml, /<NewLeaseDuration>1800<\/NewLeaseDuration>/);
  assert.match(xml, /<NewPortMappingDescription>SHL test<\/NewPortMappingDescription>/);
});

test('SOAP 报文对描述做 XML 转义，参数非法当场报错', () => {
  const xml = U.buildAddPortMappingEnvelope({ externalPort: 1, internalPort: 1, description: 'a & b <c>' });
  assert.match(xml, /a &amp; b &lt;c&gt;/);
  assert.throws(() => U.buildAddPortMappingEnvelope({ externalPort: 0, internalPort: 1 }), /外部端口/);
  assert.throws(() => U.buildAddPortMappingEnvelope({ externalPort: 1, internalPort: 70000 }), /内部端口/);
  assert.throws(() => U.buildDeletePortMappingEnvelope({ externalPort: -1 }), /外部端口/);
});

test('删除映射的报文：动作与三个字段', () => {
  const xml = U.buildDeletePortMappingEnvelope({ externalPort: 40000, protocol: 'tcp' });
  assert.match(xml, /<u:DeletePortMapping /);
  assert.match(xml, /<NewExternalPort>40000<\/NewExternalPort>/);
  assert.match(xml, /<NewProtocol>TCP<\/NewProtocol>/);
  assert.doesNotMatch(xml, /NewInternalPort/, '删除不需要内部端口');
});

test('SOAP 响应：成功与故障严格区分，故障带出错误码与描述', () => {
  const ok = U.parseSoapResponse('<?xml version="1.0"?><s:Envelope><s:Body><u:AddPortMappingResponse xmlns:u="x"/></s:Body></s:Envelope>');
  assert.equal(ok.ok, true);
  assert.equal(ok.reason, null);

  const fault = U.parseSoapResponse('<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>718</errorCode><errorDescription>ConflictInMappingEntry</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>');
  assert.equal(fault.ok, false, '故障响应绝不能算成功');
  assert.equal(fault.errorCode, 718);
  assert.equal(fault.errorDescription, 'ConflictInMappingEntry');
  assert.match(fault.reason, /ConflictInMappingEntry/);

  assert.match(U.parseSoapResponse('').reason, /空响应/);
  assert.match(U.parseSoapResponse('<html>502</html>').reason, /没有预期的动作结果/);
});
