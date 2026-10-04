'use strict';
// Stronghold Link — UDP 数据报中继内核（阶段 2 + 阶段 3 加密）。
//
// 角色：
//   host（房主）  监听 relayPort(UDP)，把每个「加入者机器的 UDP 源地址」映射成一个独立的本地 UDP socket，
//                 由这个 socket 与本地游戏端口 targetHost:targetPort 通信；游戏回包再发回对应加入者。
//   joiner（加入者）监听 localPort(UDP)，把本机游戏客户端的数据报送往房主 host:relayPort；
//                 房主回来的数据报转发回本机游戏客户端。
//
// 安全（阶段 3）：设置会话口令时，两端先做数据报握手（见 secure-datagram.cjs），
//   之后每个数据报都用 AES-256-GCM 加密并带序号，重放/篡改/无口令的数据报一律丢弃。
//   未设置口令时保持旧的裸转发行为（向后兼容）。
//
// 返回对象：{ socket, ready, stop, stats, options }，语义与 tcp-relay.cjs 一致。

const dgram = require('node:dgram');
const { describeError, decorate, makeError, validPort, normalizeToken } = require('./errors.cjs');
const { describeSecureReason } = require('./secure-stream.cjs');
const { SecureDatagramHost, SecureDatagramClient, denyPacket } = require('./secure-datagram.cjs');

const DEFAULT_CLIENT_IDLE_MS = 60000;
const DEFAULT_MAX_CLIENTS = 16;
const SWEEP_INTERVAL_MS = 5000;
const MAX_DATAGRAM = 65507;
const MAX_BUFFERED_LOCAL = 256;

function createStats(role) {
  return {
    role,
    clients: 0,            // 当前映射（TCP 版里等同活动连接数）
    totalClients: 0,
    connections: 0,
    packetsToPeer: 0,
    packetsFromPeer: 0,
    bytesToPeer: 0,
    bytesFromPeer: 0,
    rejected: 0,
    dropped: 0,
    failed: 0,
    encrypted: false,
    sessionId: null,
    startedAt: null,
  };
}

/** 房主：UDP 端口 <-> 每个加入者一个本地游戏 socket。 */
function createUdpHost(options = {}) {
  const {
    bindHost = '0.0.0.0',
    relayPort,
    targetHost = '127.0.0.1',
    targetPort,
    authToken = '',
    clientIdleMs = DEFAULT_CLIENT_IDLE_MS,
    maxClients = DEFAULT_MAX_CLIENTS,
    onEvent = null,
  } = options;

  const listenPort = validPort(relayPort, '中继端口');
  const upstreamPort = validPort(targetPort, '本地服务端口');
  const token = normalizeToken(authToken);

  const clients = new Map(); // key: "addr:port" -> { address, port, socket, bound, queue, lastSeen }
  const stats = createStats('host');
  let stopped = false;
  let sweepTimer = null;

  const emit = (type, payload) => {
    if (typeof onEvent !== 'function') return;
    try { onEvent(type, payload); } catch { /* 事件回调不允许影响转发 */ }
  };

  const secure = token
    ? new SecureDatagramHost({
      passphrase: token,
      // 房间上限在握手阶段判断：超限的加入者拿到的是明确的「房间已满」，而不是先连上再被丢包
      canAccept: (key) => clients.has(key) || clients.size < maxClients,
      onEvent: (type, payload) => {
        if (type === 'secure-handshake') {
          stats.encrypted = true;
          stats.sessionId = payload.sessionId;
          emit('secure-handshake', payload);
        } else if (type === 'secure-failure') {
          stats.dropped += 1;
          emit('error', { stage: 'secure', error: { code: 'ESECURE', friendly: describeSecureReason(payload.reason), message: payload.reason } });
        } else if (type === 'secure-deny') {
          stats.rejected += 1;
          emit('rejected', { reason: 'bad-token', peer: payload.key });
        } else if (type === 'session-expired') {
          emit('client-expired', { peer: payload.key });
        }
      },
    })
    : null;

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });

  const createClientSocket = (rinfo) => {
    const key = `${rinfo.address}:${rinfo.port}`;
    const client = {
      key,
      address: rinfo.address,
      port: rinfo.port,
      socket: dgram.createSocket({ type: 'udp4', reuseAddr: false }),
      bound: false,
      queue: [],
      lastSeen: Date.now(),
    };
    client.socket.on('message', (data) => {
      if (stopped) return;
      stats.packetsToPeer += 1;
      stats.bytesToPeer += data.length;
      const outbound = secure ? secure.seal(key, data) : data;
      if (!outbound) { stats.dropped += 1; return; }
      socket.send(outbound, client.port, client.address, (err) => {
        if (err) { stats.dropped += 1; emit('error', { stage: 'send-to-client', error: { code: err.code, friendly: describeError(err), message: err.message } }); }
      });
    });
    client.socket.on('error', (err) => {
      stats.failed += 1;
      emit('error', { stage: 'client-socket', error: { code: err.code, friendly: describeError(err), message: err.message } });
    });
    client.socket.bind(0, '0.0.0.0', () => {
      client.bound = true;
      for (const datagram of client.queue.splice(0)) client.socket.send(datagram, upstreamPort, targetHost);
      emit('client-ready', { peer: key });
    });
    clients.set(key, client);
    stats.clients = clients.size;
    stats.totalClients += 1;
    stats.connections = clients.size;
    emit('client-added', { peer: key });
    return client;
  };

  const sendUpstream = (client, payload) => {
    if (client.bound) client.socket.send(payload, upstreamPort, targetHost);
    else client.queue.push(payload);
  };

  socket.on('message', (message, rinfo) => {
    if (stopped) return;
    const key = `${rinfo.address}:${rinfo.port}`;
    let payload = message;

    if (secure) {
      const result = secure.handle(message, key);
      if (result.action === 'reply') {
        socket.send(result.reply, rinfo.port, rinfo.address, (err) => {
          if (err) stats.dropped += 1;
        });
        if (result.kind === 'ready') {
          // 上限在建立映射之前检查，否则超限的加入者也会被建立会话
          if (clients.size >= maxClients) {
            stats.rejected += 1;
            secure.drop(key);
            emit('rejected', { reason: 'max-clients', peer: key, limit: maxClients });
            socket.send(denyPacket('房间已满'), rinfo.port, rinfo.address, () => {});
            return;
          }
          if (!clients.has(key)) createClientSocket(rinfo);
        }
        return;
      }
      if (result.action !== 'data') {
        stats.rejected += 1;
        if (stats.rejected <= 5) emit('rejected', { reason: result.reason, peer: key });
        return;
      }
      payload = result.payload;
    }

    if (!payload.length) { stats.dropped += 1; return; }

    let client = clients.get(key);
    if (!client) {
      if (clients.size >= maxClients) {
        stats.rejected += 1;
        emit('rejected', { reason: 'max-clients', peer: key, limit: maxClients });
        return;
      }
      client = createClientSocket(rinfo);
    }
    client.lastSeen = Date.now();
    stats.packetsFromPeer += 1;
    stats.bytesFromPeer += payload.length;
    sendUpstream(client, payload);
  });

  socket.on('error', (err) => {
    decorate(err, { host: bindHost, port: listenPort });
    stats.failed += 1;
    emit('error', { stage: 'listen', error: { code: err.code, friendly: err.friendly, message: err.message } });
  });

  const ready = new Promise((resolve, reject) => {
    const onError = (err) => {
      decorate(err, { host: bindHost, port: listenPort });
      stats.failed += 1;
      reject(err);
    };
    socket.once('error', onError);
    socket.bind({ port: listenPort, address: bindHost, exclusive: true }, () => {
      socket.off('error', onError);
      socket.on('error', (err) => {
        decorate(err, { host: bindHost, port: listenPort });
        emit('error', { stage: 'listen', error: { code: err.code, friendly: err.friendly, message: err.message } });
      });
      stats.startedAt = Date.now();
      sweepTimer = setInterval(() => {
        const now = Date.now();
        for (const [key, client] of clients) {
          if (now - client.lastSeen <= clientIdleMs) continue;
          clients.delete(key);
          if (secure) secure.drop(key);
          try { client.socket.close(); } catch { /* 已关闭 */ }
          stats.clients = clients.size;
          stats.connections = clients.size;
          emit('client-expired', { peer: key, idleMs: now - client.lastSeen });
        }
        if (secure) secure.sweep(now);
      }, SWEEP_INTERVAL_MS);
      sweepTimer.unref?.();
      const info = { host: bindHost, port: listenPort };
      emit('listening', Object.assign({ protocol: 'UDP', encrypted: Boolean(secure) }, info));
      resolve(info);
    });
  });
  ready.catch(() => { /* 由调用方决定如何提示 */ });

  const stop = () => {
    if (stopped) return Promise.resolve();
    stopped = true;
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
    for (const client of clients.values()) {
      try { client.socket.close(); } catch { /* 已关闭 */ }
    }
    clients.clear();
    stats.clients = 0;
    stats.connections = 0;
    return new Promise((resolve) => {
      try { socket.close(() => { emit('stopped', {}); resolve(); }); } catch { emit('stopped', {}); resolve(); }
    });
  };

  return {
    socket,
    ready,
    stop,
    stats,
    options: { role: 'host', protocol: 'UDP', bindHost, relayPort: listenPort, targetHost, targetPort: upstreamPort, authToken: token, maxClients, encrypted: Boolean(secure) },
  };
}

/** 加入者：本机 UDP 入口 <-> 房主 UDP 中继。 */
function createUdpJoiner(options = {}) {
  const {
    bindHost = '127.0.0.1',
    localPort,
    host,
    relayPort,
    authToken = '',
    clientIdleMs = DEFAULT_CLIENT_IDLE_MS,
    maxClients = DEFAULT_MAX_CLIENTS,
    onEvent = null,
  } = options;

  const listenPort = validPort(localPort, '本地入口端口');
  const remotePort = validPort(relayPort, '房主中继端口');
  if (typeof host !== 'string' || !host.trim()) throw makeError('EINVALIDHOST', '房主地址不能为空');
  const remoteHost = host.trim();
  const token = normalizeToken(authToken);

  const locals = new Map(); // 本机游戏客户端（最近活跃）
  const stats = createStats('joiner');
  let stopped = false;
  let sweepTimer = null;
  let retryTimer = null;
  let handshakeStarted = false;
  const buffered = [];

  const emit = (type, payload) => {
    if (typeof onEvent !== 'function') return;
    try { onEvent(type, payload); } catch { /* 事件回调不允许影响转发 */ }
  };

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  const upstream = dgram.createSocket({ type: 'udp4', reuseAddr: false }); // 与房主通信的单一 socket（源端口稳定 = 房主侧一个会话）

  const secure = token
    ? new SecureDatagramClient({
      passphrase: token,
      onEvent: (type, payload) => {
        if (type === 'secure-handshake') {
          stats.encrypted = true;
          stats.sessionId = payload.sessionId;
          emit('secure-handshake', payload);
        } else if (type === 'secure-failure') {
          stats.dropped += 1;
          emit('error', { stage: 'secure', error: { code: 'ESECURE', friendly: describeSecureReason(payload.reason), message: payload.reason } });
        } else if (type === 'secure-deny') {
          stats.rejected += 1;
          emit('rejected', { reason: 'bad-token', detail: payload.reason });
        }
      },
    })
    : null;

  const sendToHost = (packet) => {
    upstream.send(packet, remotePort, remoteHost, (err) => {
      if (err) { stats.dropped += 1; emit('error', { stage: 'send-to-host', error: { code: err.code, friendly: describeError(err), message: err.message } }); }
    });
  };

  const startHandshake = () => {
    if (!secure || stopped) return;
    if (secure.ready || secure.state === 'failed') return;
    handshakeStarted = true;
    sendToHost(secure.hello());
    if (retryTimer) clearTimeout(retryTimer);
    if (secure.attempts < secure.maxAttempts) {
      retryTimer = setTimeout(() => { retryTimer = null; startHandshake(); }, secure.retryMs);
      retryTimer.unref?.();
    } else {
      emit('error', {
        stage: 'secure',
        error: { code: 'ETIMEDOUT', friendly: '加密握手失败：房主在限定次数内没有回应（地址/端口/防火墙，或对方版本过旧）。', message: 'handshake-timeout' },
      });
    }
  };

  const flushBuffered = () => {
    while (buffered.length) {
      const payload = buffered.shift();
      const packet = secure.seal(payload);
      if (!packet) { buffered.unshift(payload); return; }
      stats.packetsFromPeer += 1;
      stats.bytesFromPeer += payload.length;
      sendToHost(packet);
    }
  };

  const fanoutToLocals = (data) => {
    stats.packetsToPeer += 1;
    stats.bytesToPeer += data.length;
    const now = Date.now();
    for (const [key, local] of locals) {
      if (now - local.lastSeen > clientIdleMs) { locals.delete(key); continue; }
      socket.send(data, local.port, local.address, (err) => {
        if (err) { stats.dropped += 1; emit('error', { stage: 'send-to-local', error: { code: err.code, friendly: describeError(err), message: err.message } }); }
      });
    }
    stats.clients = locals.size;
    stats.connections = locals.size;
  };

  upstream.on('message', (data) => {
    if (stopped) return;
    if (!secure) { fanoutToLocals(data); return; }
    const result = secure.handle(data);
    if (result.action === 'send') { sendToHost(result.reply); return; }
    if (result.action === 'ready') { flushBuffered(); return; }
    if (result.action === 'error') {
      stats.failed += 1;
      emit('error', { stage: 'secure', error: { code: 'EDENIED', friendly: String(result.reason || '口令不匹配'), message: String(result.reason || 'bad-tag') } });
      return;
    }
    if (result.action !== 'data') { stats.rejected += 1; return; }
    fanoutToLocals(result.payload);
  });
  upstream.on('error', (err) => {
    stats.failed += 1;
    emit('error', { stage: 'remote', error: { code: err.code, friendly: describeError(err), message: err.message } });
  });

  socket.on('message', (message, rinfo) => {
    if (stopped) return;
    const key = `${rinfo.address}:${rinfo.port}`;
    const known = locals.get(key);
    if (!known && locals.size >= maxClients) {
      stats.rejected += 1;
      emit('rejected', { reason: 'max-clients', peer: key, limit: maxClients });
      return;
    }
    if (!known) {
      locals.set(key, { address: rinfo.address, port: rinfo.port, lastSeen: Date.now() });
      stats.clients = locals.size;
      stats.connections = locals.size;
      stats.totalClients += 1;
      emit('client-added', { peer: key });
    } else {
      known.lastSeen = Date.now();
    }

    if (!secure) {
      stats.packetsFromPeer += 1;
      stats.bytesFromPeer += message.length;
      sendToHost(message);
      return;
    }

    const packet = secure.seal(message);
    if (!packet) {
      // 密钥还没就绪：先缓存少量数据报，握手完成后立刻补发
      if (buffered.length < MAX_BUFFERED_LOCAL) buffered.push(Buffer.from(message));
      else stats.dropped += 1;
      if (!handshakeStarted || (secure.state === 'waiting' && !retryTimer)) startHandshake();
      return;
    }
    stats.packetsFromPeer += 1;
    stats.bytesFromPeer += message.length;
    sendToHost(packet);
  });

  const ready = new Promise((resolve, reject) => {
    const onError = (err) => {
      decorate(err, { host: bindHost, port: listenPort });
      stats.failed += 1;
      reject(err);
    };
    socket.once('error', onError);
    socket.bind({ port: listenPort, address: bindHost, exclusive: true }, () => {
      socket.off('error', onError);
      socket.on('error', (err) => {
        decorate(err, { host: bindHost, port: listenPort });
        emit('error', { stage: 'listen', error: { code: err.code, friendly: err.friendly, message: err.message } });
      });
      upstream.bind(0, '0.0.0.0', () => {
        stats.startedAt = Date.now();
        sweepTimer = setInterval(() => {
          const now = Date.now();
          for (const [key, local] of locals) {
            if (now - local.lastSeen > clientIdleMs) { locals.delete(key); emit('local-expired', { peer: key }); }
          }
          stats.clients = locals.size;
          stats.connections = locals.size;
        }, SWEEP_INTERVAL_MS);
        sweepTimer.unref?.();
        if (secure) startHandshake();
        const info = { host: bindHost, port: listenPort };
        emit('listening', Object.assign({ protocol: 'UDP', encrypted: Boolean(secure), remoteHost, remotePort }, info));
        resolve(info);
      });
    });
  });
  ready.catch(() => { /* 由调用方决定如何提示 */ });

  const stop = () => {
    if (stopped) return Promise.resolve();
    stopped = true;
    if (sweepTimer) clearInterval(sweepTimer);
    if (retryTimer) clearTimeout(retryTimer);
    sweepTimer = null;
    retryTimer = null;
    locals.clear();
    buffered.length = 0;
    stats.clients = 0;
    stats.connections = 0;
    return new Promise((resolve) => {
      let pending = 2;
      const done = () => { pending -= 1; if (pending <= 0) { emit('stopped', {}); resolve(); } };
      try { socket.close(done); } catch { done(); }
      try { upstream.close(done); } catch { done(); }
    });
  };

  return {
    socket,
    ready,
    stop,
    stats,
    options: { role: 'joiner', protocol: 'UDP', bindHost, localPort: listenPort, host: remoteHost, relayPort: remotePort, authToken: token, maxClients, encrypted: Boolean(secure) },
  };
}

module.exports = {
  createUdpHost,
  createUdpJoiner,
  MAX_DATAGRAM,
};
