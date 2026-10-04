'use strict';
// 测试辅助：端口分配、回声服务器、端口占用探测、异步等待。无第三方依赖。

const net = require('node:net');
const dgram = require('node:dgram');

/** 向系统要一个当前空闲的端口（用完立即释放）。 */
function freePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** 向系统要一个当前空闲的 UDP 端口（TCP 与 UDP 的可用端口并不等价，必须分别探测）。 */
function freeUdpPort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', reject);
    socket.bind({ port: 0, address: host, exclusive: true }, () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

function listen(server, port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
  });
}

/** 端口是否能被绑定（true = 空闲，可以绑定）。 */
function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/** 是否有服务正在该端口上接受连接（比绑定检测更可靠，跨平台一致）。 */
function isPortReachable(port, host = '127.0.0.1', timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** 启动一个“游戏服务器”替身：把收到的数据原样写回。 */
async function startEchoServer(host = '127.0.0.1') {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => socket.write(chunk));
  });
  const port = await freePort(host);
  await listen(server, port, host);
  return {
    port,
    server,
    connections: () => sockets.size,
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await close(server);
    },
  };
}

/** 连接到端口，返回 socket（connect 失败时 reject）。 */
function connect(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询等待条件成立。 */
async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 25 } = {}) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - started > timeoutMs) return false;
    await wait(intervalMs);
  }
}

/** 收集 socket 收到的数据，直到达到期望字节数或超时。 */
function collect(socket, expectedBytes, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    const finish = () => {
      socket.off('data', onData);
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    };
    const onData = (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= expectedBytes) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    socket.on('data', onData);
  });
}

/** 等待 socket 关闭；返回 'closed' 或 'error:CODE'。 */
function waitClosed(socket, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    socket.once('close', () => finish('closed'));
    socket.once('error', (err) => finish(`error:${err.code || err.message}`));
  });
}

/** 启动一个 UDP 回声服务器（UDP 版“游戏服务”替身），并记录来源。 */
async function startUdpEcho(host = '127.0.0.1') {
  const port = await freeUdpPort(host);
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const seen = [];
    socket.on('error', reject);
    socket.on('message', (msg, rinfo) => {
      seen.push({ msg, rinfo });
      socket.send(msg, rinfo.port, rinfo.address);
    });
    socket.bind({ port, address: host, exclusive: true }, () => resolve({
      port,
      seen,
      peers: () => new Set(seen.map((s) => `${s.rinfo.address}:${s.rinfo.port}`)).size,
      close: () => new Promise((r) => socket.close(r)),
    }));
  });
}

/** 发一个 UDP 数据报并等待回包（超时返回 null）。 */
function udpRoundTrip(port, payload, { host = '127.0.0.1', timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* ignore */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on('error', () => finish(null));
    socket.on('message', (msg) => finish(msg));
    socket.send(Buffer.from(payload), port, host, (err) => { if (err) finish(null); });
  });
}

/** 只发不收（用于验证“被丢弃/不被转发”），等一小会儿让数据报到达。 */
function udpSend(port, payload, { host = '127.0.0.1' } = {}) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.send(Buffer.from(payload), port, host, () => {
      setTimeout(() => { try { socket.close(); } catch { /* ignore */ } resolve(); }, 120);
    });
  });
}

module.exports = { freePort, freeUdpPort, listen, close, isPortFree, isPortReachable, startEchoServer, connect, wait, waitFor, collect, waitClosed, startUdpEcho, udpRoundTrip, udpSend };
