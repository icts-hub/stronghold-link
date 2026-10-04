'use strict';
// Stronghold Link — TCP 中继内核。
//
// 角色：
//   host（房主）  监听 relayPort，把每个连进来的对端管道到本机游戏端口 targetHost:targetPort。
//   joiner（加入者）监听 localPort，把每个连进来的本机游戏客户端管道到房主 host:relayPort。
//
// 说明：
//   * 纯 node:net 实现，不引入任何第三方依赖。
//   * 只做透明字节转发，不解析游戏协议；LAN / 已有 VPN 场景可直接使用。
//   * 可选“口令握手”：两端都设置同一个 authToken 时，先做一次中继层握手再转发游戏数据。
//     握手对游戏数据是透明的（握手完成后才开始管道，游戏流量一个字节都不会被改写）。
//     未设置 authToken 时行为与旧版完全一致（裸转发，向后兼容）。
//
// 返回对象：{ server, ready, stop, stats, options }
//   ready  -> Promise<{host, port}>，监听失败（如端口占用）时 reject，err 上带有 friendly 文案
//   stop() -> Promise<void>，幂等：重复调用安全，会强制断开所有活动连接并释放端口
//   stats  -> 实时统计（只读引用）：{ connections, totalConnections, bytesToPeer, bytesFromPeer, ... }

const net = require('node:net');
const { describeError, decorate, makeError, validPort, normalizeToken } = require('./errors.cjs');
const { serverHandshake, clientHandshake, describeSecureReason } = require('./secure-stream.cjs');
const { derivePsk } = require('./crypto.cjs');

const HANDSHAKE_MAGIC = 'SHL1';
const HANDSHAKE_OK = 'SHL1-OK';
const HANDSHAKE_DENY = 'SHL1-DENY';
const HANDSHAKE_TIMEOUT_MS = 5000;
const HANDSHAKE_MAX_BYTES = 512;

const DEFAULT_MAX_CONNECTIONS = 16;
const DEFAULT_CONNECT_TIMEOUT_MS = 8000;

function createStats(role) {
  return {
    role,
    connections: 0,        // 当前活动连接数
    totalConnections: 0,   // 累计接受的连接数
    bytesToPeer: 0,        // 本机 -> 对端
    bytesFromPeer: 0,      // 对端 -> 本机
    rejected: 0,           // 因超限/口令被拒的次数
    failed: 0,             // 上游连接失败次数
    startedAt: null,
  };
}

/** 读取一行握手文本；返回 { line, rest } 或 null（还没读到换行）。 */
function readLine(buffer) {
  const nl = buffer.indexOf(0x0a);
  if (nl < 0) return null;
  return { line: buffer.subarray(0, nl).toString('utf8').trim(), rest: buffer.subarray(nl + 1) };
}

/** 房主：监听并转发到本机游戏端口。 */
function createTcpHost(options = {}) {
  const {
    bindHost = '0.0.0.0',
    relayPort,
    targetHost = '127.0.0.1',
    targetPort,
    maxConnections = DEFAULT_MAX_CONNECTIONS,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    idleTimeoutMs = 0,
    authToken = '',
    onEvent = null,
  } = options;

  const listenPort = validPort(relayPort, '中继端口');
  const upstreamPort = validPort(targetPort, '本地游戏端口');
  const token = normalizeToken(authToken);
  const psk = token ? derivePsk(token) : null; // scrypt 只在这里跑一次，不随每个连接重复计算
  const sockets = new Set();
  const stats = createStats('host');
  let stopped = false;

  const emit = (type, payload) => {
    if (typeof onEvent !== 'function') return;
    try { onEvent(type, payload); } catch { /* 事件回调不允许影响转发 */ }
  };

  /**
   * 建立一条转发。streams 存在时表示走加密通道（阶段 3）：
   *   peer --密文--> decrypt --明文--> upstream(本地游戏)
   *   upstream --明文--> encrypt --密文--> peer
   * 字节统计一律统计「明文的游戏数据」，因此统计值在加密/非加密两种模式下含义一致。
   */
  const track = (socket, upstream, rest, streams = null) => {
    sockets.add(socket);
    stats.connections = sockets.size;
    stats.totalConnections += 1;
    stats.encrypted = Boolean(streams);
    socket.setNoDelay(true);
    upstream.setNoDelay(true);

    if (streams) {
      upstream.on('data', (chunk) => { stats.bytesToPeer += chunk.length; });
      streams.decrypt.on('data', (chunk) => { stats.bytesFromPeer += chunk.length; });
      streams.decrypt.on('error', (err) => {
        stats.failed += 1;
        emit('error', { stage: 'secure', error: { code: err.code || 'ESECURE', friendly: err.message, message: err.message } });
        socket.destroy();
        upstream.destroy();
      });
      streams.encrypt.on('error', () => { socket.destroy(); upstream.destroy(); });
      socket.pipe(streams.decrypt);
      streams.decrypt.pipe(upstream);
      upstream.pipe(streams.encrypt);
      streams.encrypt.pipe(socket);
      if (rest && rest.length) streams.decrypt.write(rest);
    } else {
      // 明文模式这里**不能**挂只做统计的 'data' 监听器：
      // 挂上会把 socket 切成 flowing 模式，而真正的转发 pipe 要等 upstream 连上才建立，
      // 这中间到达的字节会被统计器消费掉然后丢掉（Linux 上必现，Windows 上偶发）。
      // 计数与 pipe 一起在 upstream 的 connect 回调里挂，见下面。
    }

    let connected = false;
    const connectTimer = setTimeout(() => {
      if (connected) return;
      stats.failed += 1;
      const err = decorate(makeError('ETIMEDOUT', '连接本地服务端口超时'), { host: targetHost, port: upstreamPort });
      emit('error', { stage: 'upstream', peer: socket.remoteAddress, error: { code: err.code, friendly: err.friendly, message: err.message } });
      socket.destroy();
      upstream.destroy();
    }, connectTimeoutMs);

    const cleanup = () => {
      clearTimeout(connectTimer);
      sockets.delete(socket);
      stats.connections = sockets.size;
    };

    upstream.once('connect', () => {
      connected = true;
      clearTimeout(connectTimer);
      if (!streams) {
        // 关键顺序：计数监听器与 pipe 必须同时挂上。
        // 只要有任何 'data' 监听器先挂，socket 就进入 flowing 模式，
        // 之后 pipe 建立前到达的字节会被消费掉、不再回放，造成「连接后第一批数据丢失」。
        socket.on('data', (chunk) => { stats.bytesFromPeer += chunk.length; });
        upstream.on('data', (chunk) => { stats.bytesToPeer += chunk.length; });
        if (rest && rest.length) upstream.write(rest);
        socket.pipe(upstream);
        upstream.pipe(socket);
      }
      emit('peer-connected', { peer: socket.remoteAddress, peerPort: socket.remotePort });
    });

    upstream.once('error', (err) => {
      clearTimeout(connectTimer);
      stats.failed += 1;
      decorate(err, { host: targetHost, port: upstreamPort });
      emit('error', { stage: 'upstream', peer: socket.remoteAddress, error: { code: err.code, friendly: err.friendly, message: err.message } });
      cleanup();
      socket.destroy();
      upstream.destroy();
    });

    socket.on('error', () => { upstream.destroy(); });
    socket.on('close', () => { cleanup(); upstream.destroy(); });
    upstream.on('close', () => { cleanup(); socket.destroy(); });

    if (idleTimeoutMs > 0) {
      socket.setTimeout(idleTimeoutMs, () => { emit('idle-timeout', { peer: socket.remoteAddress }); socket.destroy(); upstream.destroy(); });
    }
  };

  const server = net.createServer((socket) => {
    if (stopped) { socket.destroy(); return; }
    if (sockets.size >= maxConnections) {
      stats.rejected += 1;
      emit('rejected', { reason: 'max-connections', peer: socket.remoteAddress, limit: maxConnections });
      socket.destroy();
      return;
    }

    const peer = `${socket.remoteAddress || '?'}:${socket.remotePort || '?'}`;
    emit('connection', { peer, address: socket.remoteAddress, port: socket.remotePort });

    if (!token) {
      track(socket, net.createConnection({ host: targetHost, port: upstreamPort }), null);
      return;
    }

    // 加密模式（阶段 3）：先做双向认证握手，再连本地游戏端口；连不上就把原因明确告诉加入者。
    serverHandshake(socket, {
      passphrase: token,
      psk,
      onEvent: (type, payload) => {
        if (type === 'secure-handshake') {
          stats.encrypted = true;
          stats.sessionId = payload.sessionId;
          emit('secure-handshake', { peer, sessionId: payload.sessionId });
        }
        if (type === 'secure-failure') {
          stats.failed += 1;
          emit('error', { stage: 'secure', peer, error: { code: 'ESECURE', friendly: describeSecureReason(payload.reason), message: payload.reason } });
        }
      },
    }).then((pending) => {
      if (stopped) { pending.deny('stopped'); return; }
      emit('handshake-ok', { peer, sessionId: pending.sessionId });
      const upstream = net.createConnection({ host: targetHost, port: upstreamPort });
      let settled = false;
      const failUpstream = (err) => {
        if (settled) return;
        settled = true;
        stats.failed += 1;
        decorate(err, { host: targetHost, port: upstreamPort });
        emit('error', { stage: 'upstream', peer: socket.remoteAddress, error: { code: err.code, friendly: err.friendly, message: err.message } });
        // 尚未 accept，所以可以用明文 DENY 把真正的原因告诉加入者
        pending.deny(err.friendly || '房主本地服务端口无响应');
        upstream.destroy();
      };
      const connectTimer = setTimeout(() => failUpstream(makeError('ETIMEDOUT', '连接本地服务端口超时')), connectTimeoutMs);
      upstream.once('error', (err) => { clearTimeout(connectTimer); failUpstream(err); });
      upstream.once('connect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        const streams = pending.accept();
        if (!streams) { upstream.destroy(); return; }
        track(socket, upstream, null, streams);
      });
      socket.once('close', () => { settled = true; clearTimeout(connectTimer); upstream.destroy(); });
    }).catch((err) => {
      stats.rejected += 1;
      emit('rejected', { reason: err.reason || 'secure-handshake', peer, detail: err.message });
      socket.destroy();
    });
  });

  const ready = new Promise((resolve, reject) => {
    const onListenError = (err) => {
      decorate(err, { host: bindHost, port: listenPort });
      stats.failed += 1;
      reject(err);
    };
    server.once('error', onListenError);
    server.once('listening', () => {
      server.off('error', onListenError);
      stats.startedAt = Date.now();
      const address = server.address();
      const info = { host: bindHost, port: address && typeof address === 'object' ? address.port : listenPort };
      server.on('error', (err) => {
        decorate(err, { host: bindHost, port: listenPort });
        emit('error', { stage: 'listen', error: { code: err.code, friendly: err.friendly, message: err.message } });
      });
      emit('listening', info);
      resolve(info);
    });
    server.listen(listenPort, bindHost);
  });
  ready.catch(() => { /* 由调用方决定如何提示，这里只避免未处理的 rejection */ });

  const stop = () => {
    if (stopped) return Promise.resolve();
    stopped = true;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    stats.connections = 0;
    return new Promise((resolve) => {
      if (!server.listening) { emit('stopped', {}); return resolve(); }
      server.close(() => { emit('stopped', {}); resolve(); });
      setTimeout(() => resolve(), 1500).unref?.();
    });
  };

  return { server, ready, stop, stats, options: { role: 'host', bindHost, relayPort: listenPort, targetHost, targetPort: upstreamPort, maxConnections, authToken: token } };
}

/** 加入者：监听本机入口端口，把游戏客户端转发到房主中继。 */
function createTcpJoiner(options = {}) {
  const {
    bindHost = '127.0.0.1',
    localPort,
    host,
    relayPort,
    maxConnections = DEFAULT_MAX_CONNECTIONS,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    idleTimeoutMs = 0,
    authToken = '',
    onEvent = null,
  } = options;

  const listenPort = validPort(localPort, '本地入口端口');
  const remotePort = validPort(relayPort, '房主中继端口');
  if (typeof host !== 'string' || !host.trim()) throw makeError('EINVALIDHOST', '房主地址不能为空');
  const remoteHost = host.trim();
  const token = normalizeToken(authToken);
  const psk = token ? derivePsk(token) : null; // 同上：每个中继只派生一次
  const sockets = new Set();
  const stats = createStats('joiner');
  let stopped = false;

  const emit = (type, payload) => {
    if (typeof onEvent !== 'function') return;
    try { onEvent(type, payload); } catch { /* 事件回调不允许影响转发 */ }
  };

  /**
   * 建立一条转发。streams 存在时走加密通道（阶段 3）：
   *   本机游戏客户端 --明文--> encrypt --密文--> 房主
   *   房主 --密文--> decrypt --明文--> 本机游戏客户端
   */
  const attach = (socket, remote, rest, streams = null) => {
    sockets.add(socket);
    stats.connections = sockets.size;
    stats.totalConnections += 1;
    stats.encrypted = Boolean(streams);
    socket.setNoDelay(true);
    remote.setNoDelay(true);

    if (streams) {
      // toPeer = 本机游戏发给房主的明文；fromPeer = 房主回来的明文
      socket.on('data', (chunk) => { stats.bytesToPeer += chunk.length; });
      streams.decrypt.on('data', (chunk) => { stats.bytesFromPeer += chunk.length; });
      streams.decrypt.on('error', (err) => {
        stats.failed += 1;
        emit('error', { stage: 'secure', error: { code: err.code || 'ESECURE', friendly: err.message, message: err.message } });
        socket.destroy();
        remote.destroy();
      });
      streams.encrypt.on('error', () => { socket.destroy(); remote.destroy(); });
      socket.pipe(streams.encrypt);
      streams.encrypt.pipe(remote);
      remote.pipe(streams.decrypt);
      streams.decrypt.pipe(socket);
      if (rest && rest.length) streams.decrypt.write(rest);
    } else {
      socket.on('data', (chunk) => { stats.bytesToPeer += chunk.length; });
      remote.on('data', (chunk) => { stats.bytesFromPeer += chunk.length; });
      if (rest && rest.length) remote.write(rest);
      socket.pipe(remote);
      remote.pipe(socket);
    }

    const cleanup = () => { sockets.delete(socket); stats.connections = sockets.size; };
    socket.on('error', () => remote.destroy());
    socket.on('close', () => { cleanup(); remote.destroy(); });
    remote.on('error', () => { cleanup(); socket.destroy(); });
    remote.on('close', () => { cleanup(); socket.destroy(); });

    if (idleTimeoutMs > 0) {
      socket.setTimeout(idleTimeoutMs, () => { emit('idle-timeout', { peer: socket.remoteAddress }); socket.destroy(); remote.destroy(); });
    }
  };

  const server = net.createServer((socket) => {
    if (stopped) { socket.destroy(); return; }
    if (sockets.size >= maxConnections) {
      stats.rejected += 1;
      emit('rejected', { reason: 'max-connections', peer: socket.remoteAddress, limit: maxConnections });
      socket.destroy();
      return;
    }
    const remote = net.createConnection({ host: remoteHost, port: remotePort });
    emit('connection', { peer: `${socket.remoteAddress || '?'}:${socket.remotePort || '?'}` });

    let settled = false;
    const fail = (err, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      stats.failed += 1;
      decorate(err, { host: remoteHost, port: remotePort });
      if (reason) err.friendly = reason;
      emit('error', { stage: 'remote', error: { code: err.code, friendly: err.friendly, message: err.message } });
      socket.destroy();
      remote.destroy();
    };

    const connectTimer = setTimeout(() => fail(makeError('ETIMEDOUT', '连接房主中继超时')), connectTimeoutMs);

    if (!token) {
      remote.once('connect', () => { settled = true; clearTimeout(connectTimer); attach(socket, remote, null); });
      remote.once('error', (err) => fail(err));
      return;
    }

    // 加密模式（阶段 3）：与房主完成双向认证握手后才开始转发。
    remote.once('connect', () => {
      clientHandshake(remote, {
        passphrase: token,
        psk,
        onEvent: (type, payload) => {
          if (type === 'secure-handshake') {
            stats.encrypted = true;
            stats.sessionId = payload.sessionId;
            emit('secure-handshake', { sessionId: payload.sessionId, peer: `${remoteHost}:${remotePort}` });
          }
          if (type === 'secure-failure') {
            stats.failed += 1;
            emit('error', { stage: 'secure', error: { code: 'ESECURE', friendly: describeSecureReason(payload.reason), message: payload.reason } });
          }
        },
      }).then((secure) => {
        if (settled) { remote.destroy(); return; }
        settled = true;
        clearTimeout(connectTimer);
        emit('secure-handshake', { sessionId: secure.sessionId });
        attach(socket, remote, secure.rest, secure);
      }).catch((err) => {
        const detail = err.denyReason || err.message || '未知原因';
        fail(err, `房主拒绝了本次连接：${detail}`);
      });
    });
    remote.once('error', (err) => fail(err));
  });

  const ready = new Promise((resolve, reject) => {
    const onListenError = (err) => {
      decorate(err, { host: bindHost, port: listenPort });
      stats.failed += 1;
      reject(err);
    };
    server.once('error', onListenError);
    server.once('listening', () => {
      server.off('error', onListenError);
      stats.startedAt = Date.now();
      const address = server.address();
      const info = { host: bindHost, port: address && typeof address === 'object' ? address.port : listenPort };
      server.on('error', (err) => {
        decorate(err, { host: bindHost, port: listenPort });
        emit('error', { stage: 'listen', error: { code: err.code, friendly: err.friendly, message: err.message } });
      });
      emit('listening', Object.assign({ remoteHost, remotePort }, info));
      resolve(info);
    });
    server.listen(listenPort, bindHost);
  });
  ready.catch(() => { /* 由调用方决定如何提示，这里只避免未处理的 rejection */ });

  const stop = () => {
    if (stopped) return Promise.resolve();
    stopped = true;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    stats.connections = 0;
    return new Promise((resolve) => {
      if (!server.listening) { emit('stopped', {}); return resolve(); }
      server.close(() => { emit('stopped', {}); resolve(); });
      setTimeout(() => resolve(), 1500).unref?.();
    });
  };

  return { server, ready, stop, stats, options: { role: 'joiner', bindHost, localPort: listenPort, host: remoteHost, relayPort: remotePort, maxConnections, authToken: token } };
}

module.exports = {
  createTcpHost,
  createTcpJoiner,
  describeError,
  validPort,
  normalizeToken,
  HANDSHAKE_MAGIC,
  HANDSHAKE_OK,
  HANDSHAKE_DENY,
};
