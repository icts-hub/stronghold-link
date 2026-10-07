'use strict';
// 大流量版自连基准：把「房主 + 加入者」两个角色都跑在本机（Steam P2P 本机自连），
// 让本地服务端一次性吐 N MB，量**我们自己的隧道代码**到底能搬多快。
//
// 为什么要它：steam-mini-joiner 用一个完全不含应用转发代码的纯 Node 进程去连小五大帅b，
// 拿到的仍是「3167 毫秒、恰好 4096 字节」；本机自连的裸 sendMessage 基准又是 1544 KiB/s、
// 0 失败。两端夹出来的唯一解释只能是「转发代码在某个条件下降速」或「那台机器/那条线路的问题」。
// 这个脚本把房主搬到本机，就是要在这两者之间做一次判决。
//
// 用法：node tools\steam-local-throughput.cjs [MB] [并发连接数]
const path = require('node:path');
const net = require('node:net');
const { SessionManager } = require('../network/session.cjs');

const MB = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 4;
const LANES = Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 1;
const TOTAL = MB * 1024 * 1024;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => resolve(server.address().port));
});
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const logs = [];
const tag = (who) => (e) => { if (e.type === 'log') logs.push(`${who}: ${e.entry.text}`); };
const stamp = () => new Date().toISOString().slice(11, 23);

(async () => {
  // 本地服务：连上就一次性吐 TOTAL 字节
  const blob = Buffer.alloc(TOTAL, 0x5a);
  const servers = [];
  const ports = [];
  for (let i = 0; i < LANES; i += 1) {
    const srv = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.on('data', () => {});
      socket.write(blob);
    });
    servers.push(srv);
    ports.push(await listen(srv, 0));
  }
  console.log(`${stamp()} 本地服务就绪 ${ports.join(', ')}，每个要吐 ${MB} MB，并发 ${LANES}`);

  const hostManager = new SessionManager({ appDir: path.join(__dirname, '..'), onEvent: tag('房主') });
  const joinManager = new SessionManager({ appDir: path.join(__dirname, '..'), onEvent: tag('加入者') });

  const hostSnap = await hostManager.start({ role: 'host', adapter: 'steam', targetHost: '127.0.0.1', gamePort: ports[0], appId: 480, game: 'bulk-test' });
  const steamId = hostSnap.invite && hostSnap.invite.steamId;
  if (!steamId) throw new Error('没有拿到本机 SteamID');
  console.log(`${stamp()} 房主就绪 ${steamId}`);

  const entryPort = await freePort();
  const joinSnap = await joinManager.start({ role: 'joiner', adapter: 'steam', hostSteamId: steamId, localPort: entryPort, appId: 480 });
  console.log(`${stamp()} 加入者就绪，入口 127.0.0.1:${entryPort}`);

  const perLane = [];
  const clients = [];
  for (let i = 0; i < LANES; i += 1) {
    const c = net.createConnection({ host: '127.0.0.1', port: entryPort });
    const lane = { got: 0, startedAt: 0, doneAt: 0, closed: false, err: '' };
    perLane.push(lane);
    c.on('data', (d) => { if (!lane.startedAt) lane.startedAt = Date.now(); lane.got += d.length; });
    c.on('close', () => { lane.closed = true; lane.doneAt = lane.doneAt || Date.now(); });
    c.on('error', (e) => { lane.err = String(e && e.code ? e.code : e); });
    await new Promise((r) => { c.once('connect', r); c.once('error', r); });
    clients.push(c);
  }
  const t0 = Date.now();
  console.log(`${stamp()} 客户端已连上，开始计时`);

  const total = () => perLane.reduce((a, l) => a + l.got, 0);
  let lastAt = t0;
  let lastBytes = 0;
  let firstByteAt = 0;
  while (Date.now() - t0 < 90000 && total() < TOTAL) {
    await wait(250);
    const now = Date.now();
    if (!firstByteAt && total() > 0) { firstByteAt = now; console.log(`${stamp()} 首字节到达（距开始 ${now - t0}ms）`); }
    if (now - lastAt >= 2000) {
      const got = total();
      const inst = (got - lastBytes) / ((now - lastAt) / 1000) / 1024;
      console.log(`${stamp()} 累计 ${(got / 1024).toFixed(1)} KiB / ${(TOTAL / 1024).toFixed(0)} KiB  (${(got / TOTAL * 100).toFixed(1)}%)  瞬时 ${inst.toFixed(1)} KiB/s  各条 ${perLane.map((l) => (l.got / 1024).toFixed(0)).join('/')}`);
      lastAt = now;
      lastBytes = got;
    }
  }

  const elapsed = (Date.now() - t0) / 1000;
  const got = total();
  console.log(`\n=== 汇总 ===`);
  console.log(`搬运 ${(got / 1024 / 1024).toFixed(2)} MB / 目标 ${MB} MB，用时 ${elapsed.toFixed(1)}s，平均 ${(got / elapsed / 1024).toFixed(1)} KiB/s`);
  console.log(`首字节延迟 ${firstByteAt ? firstByteAt - t0 : '从未'} ms`);
  perLane.forEach((l, i) => console.log(`  条 ${i + 1}: ${(l.got / 1024).toFixed(1)} KiB  closed=${l.closed}  err=${l.err || '-'}`));
  const hs = hostManager.getSnapshot();
  const js = joinManager.getSnapshot();
  console.log(`房主通道 ${JSON.stringify(hs.channels.map((c) => ({ p: c.protocol, peers: c.stats.connections, up: c.stats.bytesToPeer, down: c.stats.bytesFromPeer, stalls: c.stats.sendStalls, dropped: c.stats.dropped })))}`);
  console.log(`加入通道 ${JSON.stringify(js.channels.map((c) => ({ p: c.protocol, peers: c.stats.connections, up: c.stats.bytesToPeer, down: c.stats.bytesFromPeer, stalls: c.stats.sendStalls, dropped: c.stats.dropped })))}`);

  const interesting = logs.filter((l) => /停|断|错误|失败|超时|pause|stall|缓冲/.test(l));
  if (interesting.length) { console.log(`\n--- 值得注意的日志 ---`); for (const l of interesting.slice(-25)) console.log('  ' + l); }

  for (const c of clients) c.destroy();
  await joinManager.stop();
  await hostManager.stop();
  joinManager.shutdown();
  hostManager.shutdown();
  for (const s of servers) await new Promise((r) => s.close(() => r()));
  process.exit(0);
})().catch((err) => { console.log('基准异常：' + String(err && err.stack ? err.stack : err).slice(0, 900)); process.exit(1); });
