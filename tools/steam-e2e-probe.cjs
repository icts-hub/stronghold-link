'use strict';
// 用真实的 Steam（不是假 SDK）跑一遍我们自己的 Steam 隧道：
//   本地回声服务 <- 房主 Steam 会话 <- Steam P2P（本机自连）<- 加入者 Steam 会话 <- 本机 TCP 客户端
// 独立进程运行；结果写到 steam-e2e-result.json。
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { SessionManager } = require('../network/session.cjs');

const out = { steps: [] };
const note = (name, value) => { out.steps.push({ name, value }); console.log(`[e2e] ${name}: ${JSON.stringify(value)}`); };
const save = (extra = {}) => {
  Object.assign(out, extra);
  try { fs.writeFileSync(path.join(__dirname, 'steam-e2e-result.json'), JSON.stringify(out, null, 2), 'utf8'); } catch { /* ignore */ }
  console.log('RESULT ' + JSON.stringify(out));
};

const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => resolve(server.address().port));
});
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1) 本地服务替身（回声）
  const echo = net.createServer((socket) => { socket.on('error', () => {}); socket.on('data', (d) => socket.write(d)); });
  const echoPort = await listen(echo, 0);
  note('echoPort', echoPort);

  const hostManager = new SessionManager({ appDir: path.join(__dirname, '..'), onEvent: (e) => { if (e.type === 'log') out.steps.push({ name: 'host-log', value: e.entry.text }); } });
  const joinManager = new SessionManager({ appDir: path.join(__dirname, '..'), onEvent: (e) => { if (e.type === 'log') out.steps.push({ name: 'join-log', value: e.entry.text }); } });

  // 2) 房主：Steam P2P 隧道
  const hostSnap = await hostManager.start({ role: 'host', adapter: 'steam', targetHost: '127.0.0.1', gamePort: echoPort, appId: 480, game: 'steam-e2e' });
  const steamId = hostSnap.invite && hostSnap.invite.steamId;
  note('host', { state: hostSnap.state, steamId, security: hostSnap.security.mode });
  if (!steamId) throw new Error('没有拿到本机 SteamID');

  // 3) 加入者：连自己的 SteamID（本机自连）
  const entryPort = await freePort();
  const joinSnap = await joinManager.start({ role: 'joiner', adapter: 'steam', hostSteamId: steamId, localPort: entryPort, appId: 480 });
  note('joiner', { state: joinSnap.state, entryPort, security: joinSnap.security.mode });

  // 4) 本机客户端连加入者入口 -> 应经 Steam 到房主 -> 到回声服务 -> 原路返回
  const client = net.createConnection({ host: '127.0.0.1', port: entryPort });
  await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
  note('client-connected', true);
  client.write('real-steam-e2e');

  let echoed = '';
  client.on('data', (d) => { echoed += d.toString('utf8'); });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !echoed.includes('real-steam-e2e')) await wait(200);
  note('echoed', echoed || '(超时未收到)');

  const hostState = hostManager.getSnapshot();
  const joinState = joinManager.getSnapshot();
  note('stats', {
    hostChannels: hostState.channels.map((c) => ({ protocol: c.protocol, peers: c.stats.connections, bytesDown: c.stats.bytesFromPeer, bytesUp: c.stats.bytesToPeer })),
    joinerChannels: joinState.channels.map((c) => ({ protocol: c.protocol, peers: c.stats.connections, bytesDown: c.stats.bytesFromPeer, bytesUp: c.stats.bytesToPeer })),
  });

  client.destroy();
  await joinManager.stop();
  await hostManager.stop();
  joinManager.shutdown();
  hostManager.shutdown();
  await new Promise((r) => echo.close(() => r()));

  const ok = echoed.includes('real-steam-e2e');
  save({ ok });
  process.exit(ok ? 0 : 2);
})().catch(async (err) => {
  save({ ok: false, error: String(err && err.stack ? err.stack : err).slice(0, 800) });
  process.exit(1);
});
