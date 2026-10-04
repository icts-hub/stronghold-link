'use strict';
// Steam 适配器细粒度诊断：包一层 SDK，记录状态变化/句柄/收发结果，定位数据为什么没到对端。
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const mod = require('steamworks-ffi-node');
const { initSteamSdk, createSteamHost, createSteamJoiner } = require('../network/steam-adapter.cjs');

const lines = [];
const log = (text) => { lines.push(text); console.log('[diag] ' + text); };
const save = (extra) => {
  try { fs.writeFileSync(path.join(__dirname, 'steam-diag-result.json'), JSON.stringify({ lines, ...extra }, null, 2), 'utf8'); } catch { /* ignore */ }
  console.log('RESULT ' + JSON.stringify(extra));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { steam } = initSteamSdk({ appDir: path.join(__dirname, '..'), appId: 480 });
  const api = steam.networkingSockets;

  // 包一层：记录所有状态变化（先注册，适配器之后注册的也会被调用）
  api.onConnectionStateChange((c) => log(`STATE conn=${c.connection} ${c.oldState}->${c.newState} ${c.info?.stateName || ''}`));
  const rawConnect = api.connectP2P.bind(api);
  api.connectP2P = (id, port) => { const h = rawConnect(id, port); log(`connectP2P(${id}, ${port}) -> handle=${h}`); return h; };
  const rawAccept = api.acceptConnection.bind(api);
  api.acceptConnection = (conn) => { const r = rawAccept(conn); log(`acceptConnection(${conn}) -> ${r}`); return r; };
  const rawSend = api.sendReliable.bind(api);
  api.sendReliable = (conn, data) => {
    const r = rawSend(conn, data);
    log(`sendReliable(conn=${conn}, ${Buffer.isBuffer(data) ? data.length : String(data).length}B) -> success=${r && r.success} result=${r && r.result}`);
    return r;
  };
  const rawPoll = api.receiveMessagesOnPollGroup.bind(api);
  api.receiveMessagesOnPollGroup = (group, max) => { const m = rawPoll(group, max) || []; if (m.length) log(`pollGroup 收到 ${m.length} 条`); return m; };
  const rawRecv = api.receiveMessages.bind(api);
  api.receiveMessages = (conn, max) => { const m = rawRecv(conn, max) || []; if (m.length) log(`receiveMessages(conn=${conn}) 收到 ${m.length} 条`); return m; };

  const echo = net.createServer((s) => { s.on('error', () => {}); s.on('data', (d) => { log(`回声服务收到 ${d.length}B，回发`); s.write(d); }); });
  const echoPort = await new Promise((res) => echo.listen(0, '127.0.0.1', () => res(echo.address().port)));
  log(`回声服务端口 ${echoPort}`);

  const host = createSteamHost({ appDir: path.join(__dirname, '..'), appId: 480, gamePort: echoPort, onEvent: (t, p) => log(`host 事件 ${t} ${JSON.stringify(p || {})}`) });
  const hostInfo = await host.ready;
  log(`房主就绪 steamId=${hostInfo.steamId}`);

  const entryPort = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const joiner = createSteamJoiner({ appDir: path.join(__dirname, '..'), appId: 480, localPort: entryPort, hostSteamId: hostInfo.steamId, onEvent: (t, p) => log(`joiner 事件 ${t} ${JSON.stringify(p || {})}`) });
  await joiner.ready;
  log(`加入者就绪 入口端口=${entryPort}`);

  const client = net.createConnection({ host: '127.0.0.1', port: entryPort });
  await new Promise((r) => client.once('connect', r));
  log('本机客户端已连接，开始发送');
  client.write('diag-payload');
  let back = '';
  client.on('data', (d) => { back += d.toString('utf8'); log(`客户端收到 ${d.length}B`); });

  for (let i = 0; i < 60 && !back.includes('diag-payload'); i += 1) await wait(500);
  log(`最终回包="${back}"`);
  log(`host stats=${JSON.stringify(host.stats)}`);
  log(`joiner stats=${JSON.stringify(joiner.stats)}`);

  client.destroy();
  await joiner.stop();
  await host.stop();
  await new Promise((r) => echo.close(() => r()));
  save({ ok: back.includes('diag-payload') });
  process.exit(0);
})().catch((err) => { save({ ok: false, error: String(err && err.stack ? err.stack : err).slice(0, 600) }); process.exit(1); });
