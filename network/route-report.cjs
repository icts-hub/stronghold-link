'use strict';
// ============================================================================
// Stronghold Link — RouteReport（活连接线路判定）
//
// 目标：回答一个此前没人回答的问题 —— 这条 P2P 连接到底是直连还是走 Steam
// 中继。Steam Networking Sockets 把这件事藏在连接信息里，界面过去只能显示
// CONNECTED，无法区分两种线路，所以"慢"没法归因。
//
// 判定依据是 Valve 自己的字段，不做推测：
//   m_idPOPRelay  非 0  → 这条连接正在被中继，值是中继 POP
//   m_idPOPRelay  为 0  → 没有被中继；此时 m_idPOPRemote 非 0 表示对端所在 POP
//   两者都为 0          → 尚未协商出线路
//
// 三条硬规则：
//   1. 只读，不写。任何一步失败都退化为 available:false，绝不抛给数据面。
//   2. 不编造。拿不到的字段就是 null，界面显示 "—"。
//   3. POP 解码按 Steam 自己的字节序，不做大小写猜测。
// ============================================================================

/** SteamNetConnectionInfo_t 的固定长度。FFI 需要一块足够大的缓冲。 */
const CONNECTION_INFO_SIZE = 456;

/** m_addrRemote 在结构里的偏移，端口紧随其后 2 字节，网络字节序。 */
const ADDR_REMOTE_OFFSET = 148;

const ROUTE = {
  DIRECT: 'DIRECT_P2P',
  RELAY: 'STEAM_SDR_RELAY',
  UNKNOWN: 'UNKNOWN',
};

const ROUTE_LABEL = {
  [ROUTE.DIRECT]: 'DIRECT P2P',
  [ROUTE.RELAY]: 'STEAM SDR RELAY',
  [ROUTE.UNKNOWN]: 'UNKNOWN',
};

/**
 * SteamNetworkingPOPID 解码。
 * Valve 把四个 ASCII 字符打包成一个小端 uint32，"tyo1" 就是 0x316f7974。
 * 返回 null 表示没有值，不要拿 '0000' 之类的占位符冒充。
 */
function popCode(id) {
  const n = Number(id);
  if (!Number.isFinite(n) || n === 0) return null;
  let out = '';
  for (let i = 0; i < 4; i += 1) {
    const code = Math.trunc(n / 2 ** (i * 8)) & 0xff;
    if (code === 0) break;
    if (code < 32 || code > 126) return null;
    out += String.fromCharCode(code);
  }
  return out || null;
}

/**
 * 解析 SteamNetworkingIPAddr。
 * 结构是 16 字节地址 + 2 字节端口。IPv4 以 ::ffff:a.b.c.d 的形式存放。
 * 全零表示未设置，返回 host:null，不要伪装成 0.0.0.0。
 */
function parseIpAddr(buffer, offset = ADDR_REMOTE_OFFSET) {
  if (!buffer || buffer.length < offset + 18) return null;
  const port = buffer.readUInt16BE(offset + 16);
  let v4 = true;
  for (let i = 0; i < 10; i += 1) {
    if (buffer[offset + i] !== 0) { v4 = false; break; }
  }
  let host = null;
  if (v4 && buffer[offset + 10] === 0xff && buffer[offset + 11] === 0xff) {
    host = `${buffer[offset + 12]}.${buffer[offset + 13]}.${buffer[offset + 14]}.${buffer[offset + 15]}`;
  } else {
    let any = false;
    for (let i = 0; i < 16; i += 1) { if (buffer[offset + i] !== 0) { any = true; break; } }
    if (any) {
      const parts = [];
      for (let i = 0; i < 8; i += 1) parts.push(buffer.readUInt16BE(offset + i * 2).toString(16));
      host = parts.join(':');
    }
  }
  if (!host) return { host: null, port: null, family: null };
  return { host, port: port || null, family: host.includes(':') ? 6 : 4 };
}

/** 把 host/port 拼成可显示的地址；没有就是 null。 */
function formatAddress(addr) {
  if (!addr || !addr.host) return null;
  if (!addr.port) return addr.host;
  return addr.family === 6 ? `[${addr.host}]:${addr.port}` : `${addr.host}:${addr.port}`;
}

/**
 * 由连接信息判定线路。只认 m_idPOPRelay，不看 ping、不看质量分。
 * @param {object} info getConnectionInfo 的返回值，允许缺字段
 */
function classify(info) {
  // 判定只看 POP ID 本身是否为零；POP 文本解不出来时仍然如实报 relayed，
  // 只是 relayPop/remotePop 落 null，避免"编码异常"被误判成"没有中继"。
  const relayId = Number(info && info.popIdRelay) || 0;
  const remoteId = Number(info && info.popIdRemote) || 0;
  const relayed = relayId !== 0;
  let route = ROUTE.UNKNOWN;
  if (relayed) route = ROUTE.RELAY;
  else if (remoteId !== 0) route = ROUTE.DIRECT;
  return {
    route,
    routeLabel: ROUTE_LABEL[route],
    relayed,
    relayPop: popCode(relayId),
    remotePop: popCode(remoteId),
    relayPopId: relayId,
    remotePopId: remoteId,
  };
}

/**
 * 自己发一次 FFI 读原始结构拿 m_addrRemote。
 * steamworks-ffi-node 的 getConnectionInfo 把 remoteAddress 直接写成空串，
 * 所以只能绕过它。任何一步不可用就返回 null，不抛。
 */
function readRawAddress(steam, connection) {
  try {
    const sockets = steam && steam.networkingSockets;
    if (!sockets || typeof sockets.getInterface !== 'function') return null;
    const loader = sockets.libraryLoader;
    if (!loader || typeof loader.SteamAPI_ISteamNetworkingSockets_GetConnectionInfo !== 'function') return null;
    const iface = sockets.getInterface();
    if (!iface) return null;
    const buffer = Buffer.alloc(CONNECTION_INFO_SIZE);
    const ok = loader.SteamAPI_ISteamNetworkingSockets_GetConnectionInfo(iface, connection, buffer);
    if (!ok) return null;
    return parseIpAddr(buffer, ADDR_REMOTE_OFFSET);
  } catch (err) {
    return null;
  }
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 采一份活连接的线路报告。
 *
 * @param {object} steam       已初始化的 steam 模块
 * @param {*}      connection  HSteamNetConnection
 * @param {object} [options]
 * @param {Function} [options.now]
 * @param {object} [options.info]      注入连接信息，测试用
 * @param {object} [options.realtime]  注入实时状态，测试用
 * @param {object} [options.address]   注入远端地址，测试用
 */
function sampleRoute(steam, connection, options = {}) {
  const { now = Date.now } = options;
  const sockets = steam && steam.networkingSockets;
  if (!sockets || connection == null) return null;

  let info = options.info;
  if (info === undefined) {
    try {
      info = typeof sockets.getConnectionInfo === 'function' ? sockets.getConnectionInfo(connection) : null;
    } catch (err) {
      info = null;
    }
  }
  if (!info) return { available: false, reason: 'NO_CONNECTION_INFO', sampledAt: now() };

  let realtime = options.realtime;
  if (realtime === undefined) {
    try {
      realtime = typeof sockets.getConnectionRealTimeStatus === 'function'
        ? sockets.getConnectionRealTimeStatus(connection)
        : null;
    } catch (err) {
      realtime = null;
    }
  }

  const address = options.address !== undefined ? options.address : readRawAddress(steam, connection);
  const lines = classify(info);
  const rt = realtime || {};

  return {
    available: true,
    connection: typeof connection === 'bigint' ? String(connection) : connection,
    state: num(info.state),
    stateName: info.stateName || null,
    ...lines,
    remoteAddress: formatAddress(address),
    remoteHost: address && address.host ? address.host : null,
    remotePort: address && address.port ? address.port : null,
    ping: num(rt.ping),
    qualityLocal: num(rt.connectionQualityLocal),
    qualityRemote: num(rt.connectionQualityRemote),
    steamInBytesPerSec: num(rt.inBytesPerSec),
    steamOutBytesPerSec: num(rt.outBytesPerSec),
    steamInPacketsPerSec: num(rt.inPacketsPerSec),
    steamOutPacketsPerSec: num(rt.outPacketsPerSec),
    sendRateBytesPerSecond: num(rt.sendRateBytesPerSecond),
    pendingReliable: num(rt.pendingReliable),
    sentUnackedReliable: num(rt.sentUnackedReliable),
    usecQueueTime: num(rt.usecQueueTime),
    sampledAt: now(),
  };
}

/**
 * 对多条连接取样并汇总。汇总只报"是否全部走同一条线路"，
 * 混合时 route 置 MIXED，绝不挑一条代表全部。
 */
function summarize(reports) {
  const list = (reports || []).filter(Boolean);
  const live = list.filter((r) => r.available);
  const routes = new Set(live.map((r) => r.route));
  let route = ROUTE.UNKNOWN;
  if (routes.size === 1) route = live[0].route;
  else if (routes.size > 1) route = 'MIXED';
  const sum = (key) => live.reduce((acc, r) => (r[key] == null ? acc : acc + r[key]), 0);
  const anyNull = (key) => live.some((r) => r[key] == null);
  // 合计与均值都要求"每条都有值"，缺一条就整体落 null，不做局部求和冒充总量。
  const total = (key) => (live.length && !anyNull(key) ? sum(key) : null);
  const avg = (key) => (live.length && !anyNull(key) ? Math.round(sum(key) / live.length) : null);
  return {
    count: live.length,
    route,
    routeLabel: route === 'MIXED' ? 'MIXED' : (ROUTE_LABEL[route] || 'UNKNOWN'),
    relayed: live.some((r) => r.relayed),
    relayPop: live.find((r) => r.relayPop)?.relayPop || null,
    remotePop: live.find((r) => r.remotePop)?.remotePop || null,
    remoteAddress: live.find((r) => r.remoteAddress)?.remoteAddress || null,
    ping: avg('ping'),
    steamInBytesPerSec: total('steamInBytesPerSec'),
    steamOutBytesPerSec: total('steamOutBytesPerSec'),
    sampledAt: Date.now(),
    connections: list,
  };
}

/**
 * 原始 socket 字节计数的差分计。
 *
 * 这是用户要的 RAW SOCKET RX：直接数本地 net.Socket 收发了多少字节，
 * 与 Steam 侧自己报的 inBytesPerSec 对照，就能分清"链路真的慢"还是"统计口径不对"。
 *
 * 第一次采样没有上一个点，速率如实落 null —— 不拿累计值当速率，也不填 0。
 */
function createRawSocketMeter(options = {}) {
  const { now = Date.now } = options;
  let last = null;
  return {
    read(counters, at = now()) {
      const src = counters || {};
      const pick = (key) => num(src[key]) ?? 0;
      const current = {
        bytesToPeer: pick('bytesToPeer'),
        bytesFromPeer: pick('bytesFromPeer'),
        packetsToPeer: pick('packetsToPeer'),
        packetsFromPeer: pick('packetsFromPeer'),
      };
      let rawTx = null;
      let rawRx = null;
      if (last && at > last.at) {
        const seconds = (at - last.at) / 1000;
        const tx = current.bytesToPeer - last.bytesToPeer;
        const rx = current.bytesFromPeer - last.bytesFromPeer;
        // 计数器回绕或会话重启会让差分为负，此时宁可落 null 也不报负数速率
        if (tx >= 0) rawTx = Math.round(tx / seconds);
        if (rx >= 0) rawRx = Math.round(rx / seconds);
      }
      last = { at, ...current };
      return { ...current, rawTxBytesPerSec: rawTx, rawRxBytesPerSec: rawRx, sampledAt: at };
    },
  };
}

module.exports = {
  CONNECTION_INFO_SIZE,
  ADDR_REMOTE_OFFSET,
  ROUTE,
  ROUTE_LABEL,
  popCode,
  parseIpAddr,
  formatAddress,
  classify,
  readRawAddress,
  sampleRoute,
  summarize,
  createRawSocketMeter,
};
