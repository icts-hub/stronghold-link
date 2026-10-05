'use strict';
// ============================================================================
// Stronghold Link — UPnP IGD（SSDP 发现 + SOAP 端口映射）
//
// 比 NAT-PMP 更可能被家用路由器支持，所以它是"自动端口映射"的主力路径：
//   1. 组播 M-SEARCH 找 InternetGatewayDevice；
//   2. 读设备描述 XML，取出 WANIPConnection / WANPPPConnection 的 controlURL；
//   3. 向 controlURL 发 SOAP 请求加/删端口映射。
//
// 全部是纯字符串与正则处理（不引 XML 库），收发由调用方用 dgram / http 完成。
// 解析失败一律如实返回 ok=false 与原因，不猜。
// ============================================================================

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const DEFAULT_ST = 'urn:schemas-upnp-org:device:InternetGatewayDevice:1';
const WAN_SERVICE_TYPES = Object.freeze([
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
]);

/** M-SEARCH 请求（普通字符串，按 CRLF 分行）。 */
function buildSsdpSearch({ st = DEFAULT_ST, mx = 2, host = SSDP_ADDRESS, port = SSDP_PORT } = {}) {
  // 注意：mx: 0 是非法值，应夹到 1，不能因为 0 是 falsy 就当成"没传"而回落到 2
  const raw = Number(mx);
  const seconds = Number.isFinite(raw) ? Math.max(1, Math.min(5, Math.floor(raw))) : 2;
  return [
    'M-SEARCH * HTTP/1.1',
    'HOST: ' + host + ':' + port,
    'MAN: "ssdp:discover"',
    'MX: ' + seconds,
    'ST: ' + st,
    '',
    '',
  ].join('\r\n');
}

function headerValue(text, name) {
  const re = new RegExp('^' + name + '\\s*:\\s*(.+)$', 'im');
  const hit = String(text || '').match(re);
  return hit ? hit[1].trim() : null;
}

/** 解析 SSDP 响应头。 */
function parseSsdpResponse(input) {
  const text = String(input || '');
  if (!text) return { ok: false, reason: '空响应', location: null, server: null, st: null, usn: null };
  if (!/^HTTP\/1\.[01]\s+200/i.test(text.trim())) {
    return { ok: false, reason: '不是 200 响应', location: null, server: null, st: null, usn: null };
  }
  const location = headerValue(text, 'LOCATION');
  if (!location) return { ok: false, reason: '响应缺少 LOCATION', location: null, server: headerValue(text, 'SERVER'), st: headerValue(text, 'ST'), usn: headerValue(text, 'USN') };
  return {
    ok: true,
    reason: null,
    location,
    server: headerValue(text, 'SERVER'),
    st: headerValue(text, 'ST'),
    usn: headerValue(text, 'USN'),
  };
}

/**
 * 从设备描述 XML 里找出 WAN 连接服务的 controlURL，并解析成绝对地址。
 * @returns {{ ok:boolean, reason:string|null, serviceType:string|null, controlUrl:string|null }}
 */
function resolveControlUrl(descriptionXml, baseUrl) {
  const xml = String(descriptionXml || '');
  if (!xml) return { ok: false, reason: '设备描述为空', serviceType: null, controlUrl: null };

  for (const serviceType of WAN_SERVICE_TYPES) {
    // 找包含该 serviceType 的 <service> 块
    const blocks = xml.match(/<service>[\s\S]*?<\/service>/gi) || [];
    for (const block of blocks) {
      const typeHit = block.match(/<serviceType>\s*([^<]+?)\s*<\/serviceType>/i);
      if (!typeHit || typeHit[1].trim() !== serviceType) continue;
      const urlHit = block.match(/<controlURL>\s*([^<]+?)\s*<\/controlURL>/i);
      if (!urlHit) continue;
      const raw = urlHit[1].trim();
      let resolved;
      try {
        resolved = new URL(raw, baseUrl).toString();
      } catch (err) {
        return { ok: false, reason: 'controlURL 无法解析：' + raw, serviceType, controlUrl: null };
      }
      return { ok: true, reason: null, serviceType, controlUrl: resolved };
    }
  }
  return { ok: false, reason: '设备描述里没有 WANIPConnection / WANPPPConnection 服务', serviceType: null, controlUrl: null };
}

function escapeXml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function envelope(serviceType, action, body) {
  return '<?xml version="1.0"?>\r\n'
    + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
    + '<s:Body>'
    + '<u:' + action + ' xmlns:u="' + serviceType + '">' + body + '</u:' + action + '>'
    + '</s:Body></s:Envelope>';
}

/** 添加端口映射的 SOAP 请求体。 */
function buildAddPortMappingEnvelope({
  serviceType = WAN_SERVICE_TYPES[0],
  externalPort,
  internalPort,
  internalClient = '0.0.0.0',
  protocol = 'UDP',
  leaseSeconds = 3600,
  description = 'Stronghold Link',
} = {}) {
  const ext = Number(externalPort);
  const int = Number(internalPort);
  if (!Number.isInteger(ext) || ext < 1 || ext > 65535) throw new Error('外部端口必须是 1–65535 的整数');
  if (!Number.isInteger(int) || int < 1 || int > 65535) throw new Error('内部端口必须是 1–65535 的整数');
  const proto = String(protocol).toUpperCase() === 'TCP' ? 'TCP' : 'UDP';
  const lease = Math.max(0, Math.floor(Number(leaseSeconds) || 0));
  const body = '<NewRemoteHost></NewRemoteHost>'
    + '<NewExternalPort>' + ext + '</NewExternalPort>'
    + '<NewProtocol>' + proto + '</NewProtocol>'
    + '<NewInternalPort>' + int + '</NewInternalPort>'
    + '<NewInternalClient>' + escapeXml(internalClient) + '</NewInternalClient>'
    + '<NewEnabled>1</NewEnabled>'
    + '<NewPortMappingDescription>' + escapeXml(description) + '</NewPortMappingDescription>'
    + '<NewLeaseDuration>' + lease + '</NewLeaseDuration>';
  return envelope(serviceType, 'AddPortMapping', body);
}

/** 删除端口映射的 SOAP 请求体。 */
function buildDeletePortMappingEnvelope({ serviceType = WAN_SERVICE_TYPES[0], externalPort, protocol = 'UDP' } = {}) {
  const ext = Number(externalPort);
  if (!Number.isInteger(ext) || ext < 1 || ext > 65535) throw new Error('外部端口必须是 1–65535 的整数');
  const proto = String(protocol).toUpperCase() === 'TCP' ? 'TCP' : 'UDP';
  const body = '<NewRemoteHost></NewRemoteHost>'
    + '<NewExternalPort>' + ext + '</NewExternalPort>'
    + '<NewProtocol>' + proto + '</NewProtocol>';
  return envelope(serviceType, 'DeletePortMapping', body);
}

/**
 * 解析 SOAP 响应：成功或故障都要如实区分。
 * @returns {{ ok:boolean, errorCode:number|null, errorDescription:string|null, reason:string|null }}
 */
function parseSoapResponse(input) {
  const text = String(input || '');
  if (!text) return { ok: false, errorCode: null, errorDescription: null, reason: '空响应' };
  const fault = /<s:Fault|<faultcode|<UPnPError/i.test(text);
  const codeHit = text.match(/<errorCode>\s*(\d+)\s*<\/errorCode>/i);
  const descHit = text.match(/<errorDescription>\s*([^<]*?)\s*<\/errorDescription>/i);
  if (fault || codeHit) {
    const code = codeHit ? Number(codeHit[1]) : null;
    const description = descHit ? descHit[1] : null;
    return {
      ok: false,
      errorCode: code,
      errorDescription: description,
      reason: description ? ('网关拒绝：' + description + (code === null ? '' : '（' + code + '）')) : '网关返回故障响应',
    };
  }
  if (!/<u:AddPortMappingResponse|<u:DeletePortMappingResponse/i.test(text)) {
    return { ok: false, errorCode: null, errorDescription: null, reason: '响应里没有预期的动作结果' };
  }
  return { ok: true, errorCode: null, errorDescription: null, reason: null };
}

module.exports = {
  SSDP_ADDRESS,
  SSDP_PORT,
  DEFAULT_ST,
  WAN_SERVICE_TYPES,
  buildSsdpSearch,
  parseSsdpResponse,
  resolveControlUrl,
  buildAddPortMappingEnvelope,
  buildDeletePortMappingEnvelope,
  parseSoapResponse,
};
