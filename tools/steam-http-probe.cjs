'use strict';
// 用真实的 Steam 跑一遍「浏览器式」的 HTTP 往返 —— 现场症状是"浏览器一直转圈"，
// 而之前的 steam-e2e-probe.cjs 只测了 12 字节的回声，测不出响应体、分块、Connection: close
// 这些真正会卡住页面的东西。
//
// 结构（全部在本机自连，不需要第二台机器）：
//   目标 HTTP 服务 <- 房主 Steam 会话 <- Steam P2P <- 加入者 Steam 会话 <- 本机 HTTP 客户端
//
// 用法：
//   node tools\steam-http-probe.cjs              探针模式：房主转发到内置测试服务，逐字节比对
//   node tools\steam-http-probe.cjs game [port]  现场模式：房主转发到真实游戏端口（默认 3000）
//
// 探针模式的四组用例：
//   A 单发 GET /（HTTP/1.0 Connection: close）—— 现场"浏览器转圈"的最小复现
//   B 6 条并发 GET /（浏览器加载一个页面会开 6 条）
//   C 同一条连接上连着发 3 个 keep-alive 请求
//   D GET /big（512 KiB）—— 走分块路径
//
// 结果写到 tools/steam-http-result.json；每一项都逐字节比对，不靠"看起来对"。
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const { SessionManager } = require('../network/session.cjs');

const MODE = process.argv[2] === 'game' ? 'game' : 'probe';
const GAME_PORT = Number(process.argv[3] || 3000);
const out = { mode: MODE, steps: [], tests: [] };
const note = (name, value) => { out.steps.push({ name, value }); console.log(`[http] ${name}: ${JSON.stringify(value)}`); };
const save = (extra = {}) => {
  Object.assign(out, extra);
  try { fs.writeFileSync(path.join(__dirname, 'steam-http-result.json'), JSON.stringify(out, null, 2), 'utf8'); } catch { /* ignore */ }
  console.log('RESULT ' + JSON.stringify(out));
};
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

// ── 测试用页面：约 40 KiB 的 HTML（比现场那个 6304 字节的首页大一点，更能暴露分块问题）
const PAGE = Buffer.from(
  '<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body><h1>probe</h1>'
  + '<script>window.__PROBE__=1;</script>'
  + '<!-- ' + 'p'.repeat(40000) + ' -->'
  + '</body></html>',
  'utf8',
);
const BIG = Buffer.alloc(512 * 1024);
for (let i = 0; i < BIG.length; i++) BIG[i] = (i * 37 + 11) & 0xff;

const seen = [];
let t0 = Date.now();
const testServer = http.createServer((req, res) => {
  const at = Date.now();
  let got = 0;
  req.on('data', (d) => { got += d.length; });
  req.on('end', () => {
    seen.push({ url: req.url, method: req.method, atMs: at - t0, reqBytes: got });
    if (req.url.startsWith('/big')) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(BIG.length) });
      res.end(BIG);
      return;
    }
    if (req.url.startsWith('/keep')) {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '5' });
      res.end('keep\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(PAGE.length) });
    res.end(PAGE);
  });
});

// ── 一个够用的 HTTP 客户端：按 Content-Length 收满就结束，收不满就等 close / 超时
function httpGet(port, reqText, { timeoutMs = 30000, wantKeepAlive = false, requests = 1 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let buf = Buffer.alloc(0);
    let settled = false;
    const bodies = [];
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* ignore */ }
      resolve({ elapsedMs: Date.now() - started, bodies, ...extra });
    };
    const timer = setTimeout(() => finish({ ok: false, error: `超时 ${timeoutMs}ms 仍未收到完整响应`, gotBytes: buf.length }), timeoutMs);

    let headerEnd = -1;
    let contentLength = null;
    let status = null;
    let consumed = 0;
    let doneCount = 0;
    const check = () => {
      for (;;) {
        if (headerEnd < 0) {
          const idx = buf.indexOf('\r\n\r\n');
          if (idx < 0) return;
          headerEnd = idx + 4;
          const head = buf.subarray(0, idx).toString('latin1');
          const first = head.split('\r\n')[0] || '';
          const m = /^HTTP\/\d\.\d\s+(\d{3})/.exec(first);
          status = m ? Number(m[1]) : null;
          const cl = /content-length:\s*(\d+)/i.exec(head);
          contentLength = cl ? Number(cl[1]) : null;
        }
        if (contentLength == null) {
          // 没有 Content-Length：保留全部剩余字节，等对端关连接
          if (consumed === 0) bodies[0] = Buffer.from(buf.subarray(headerEnd));
          return;
        }
        const bodyStart = consumed + headerEnd;
        if (buf.length - bodyStart < contentLength) return;
        bodies[doneCount] = Buffer.from(buf.subarray(bodyStart, bodyStart + contentLength));
        consumed = bodyStart + contentLength;
        headerEnd = -1;
        contentLength = null;
        doneCount += 1;
        if (doneCount >= requests) {
          finish({ ok: true, status, done: doneCount });
          return;
        }
      }
    };

    socket.on('error', (e) => finish({ ok: false, error: 'socket: ' + e.message, gotBytes: buf.length }));
    socket.on('connect', () => { try { socket.write(reqText); } catch (e) { finish({ ok: false, error: 'write: ' + e.message }); } });
    socket.on('data', (d) => { buf = Buffer.concat([buf, d]); check(); });
    socket.on('close', () => {
      if (settled) return;
      check();
      if (settled) return;
      const body = bodies[0];
      // 有 Content-Length 且已经收满 → 成功
      if (body) { finish({ ok: true, status, done: doneCount + (contentLength == null ? 0 : 0) }); return; }
      finish({ ok: false, error: wantKeepAlive ? '对端提前关了连接' : '对端关连接但响应不完整', status, gotBytes: buf.length });
    });
  });
}

const get = (port, reqText, opts) => httpGet(port, reqText, opts);
const getClose = (port, timeoutMs = 30000, url = '/') => get(port, `GET ${url} HTTP/1.0\r\nHost: probe\r\n\r\n`, { timeoutMs });
const sameBytes = (a, b) => Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && a.equals(b);

function record(name, r, expect) {
  const body = r.bodies[0];
  const entry = {
    name,
    ok: r.ok,
    status: r.status,
    elapsedMs: r.elapsedMs,
    bytes: body ? body.length : 0,
    expectBytes: expect ? expect.length : null,
    exact: expect ? sameBytes(body, expect) : null,
    error: r.error || null,
    gotBytes: r.gotBytes != null ? r.gotBytes : undefined,
  };
  out.tests.push(entry);
  console.log(`[http] ${name}: ${JSON.stringify(entry)}`);
  return entry;
}

(async () => {
  let targetPort;
  if (MODE === 'game') {
    targetPort = GAME_PORT;
  } else {
    targetPort = await listen(testServer, 0);
    note('testServerPort', targetPort);
    const direct = await getClose(targetPort);
    note('direct-baseline', {
      ok: direct.ok, status: direct.status,
      bytes: direct.bodies[0] ? direct.bodies[0].length : 0,
      exact: direct.ok && sameBytes(direct.bodies[0], PAGE),
      elapsedMs: direct.elapsedMs,
    });
  }
  // 直连对照（两种情况都做）
  const directTarget = await getClose(targetPort, 10000);
  note('target-direct', {
    port: targetPort, ok: directTarget.ok, status: directTarget.status,
    bytes: directTarget.bodies[0] ? directTarget.bodies[0].length : 0,
    elapsedMs: directTarget.elapsedMs,
    head: directTarget.bodies[0] ? directTarget.bodies[0].subarray(0, 32).toString('latin1') : null,
  });

  const hostManager = new SessionManager({
    appDir: path.join(__dirname, '..'),
    onEvent: (e) => { if (e.type === 'log') out.steps.push({ name: 'host-log', value: e.entry.text }); },
  });
  const joinManager = new SessionManager({
    appDir: path.join(__dirname, '..'),
    onEvent: (e) => { if (e.type === 'log') out.steps.push({ name: 'join-log', value: e.entry.text }); },
  });

  let entryPort = null;
  try {
    t0 = Date.now();
    const hostSnap = await hostManager.start({
      role: 'host', adapter: 'steam', targetHost: '127.0.0.1', gamePort: targetPort, appId: 480, game: 'steam-http',
    });
    const steamId = hostSnap.invite && hostSnap.invite.steamId;
    note('host', { state: hostSnap.state, steamId, security: hostSnap.security.mode });
    if (!steamId) throw new Error('没有拿到本机 SteamID');

    entryPort = await freePort();
    const joinSnap = await joinManager.start({
      role: 'joiner', adapter: 'steam', hostSteamId: steamId, localPort: entryPort, appId: 480,
    });
    note('joiner', { state: joinSnap.state, entryPort, security: joinSnap.security.mode });
    note('tunnel-ready-ms', Date.now() - t0);

    record('A 单发 GET /（HTTP/1.0 close）', await getClose(entryPort, 30000), MODE === 'probe' ? PAGE : null);

    const bStarted = Date.now();
    const bResults = await Promise.all([0, 1, 2, 3, 4, 5].map(() => getClose(entryPort, 45000)));
    for (let i = 0; i < bResults.length; i++) record(`B 并发 GET / #${i + 1}`, bResults[i], MODE === 'probe' ? PAGE : null);
    note('B-wall-ms', Date.now() - bStarted);

    if (MODE === 'probe') {
      const keepReq = 'GET /keep HTTP/1.1\r\nHost: probe\r\nConnection: keep-alive\r\n\r\n';
      record('C keep-alive×3', await get(entryPort, keepReq.repeat(3), { timeoutMs: 30000, wantKeepAlive: true, requests: 3 }), Buffer.from('keep\n'));
      record('D GET /big（512KiB）', await getClose(entryPort, 90000, '/big'), BIG);
    }

    const hostState = hostManager.getSnapshot();
    const joinState = joinManager.getSnapshot();
    note('stats', {
      hostChannels: hostState.channels.map((c) => ({
        protocol: c.protocol, peers: c.stats.connections, bytesDown: c.stats.bytesFromPeer, bytesUp: c.stats.bytesToPeer,
      })),
      joinerChannels: joinState.channels.map((c) => ({
        protocol: c.protocol, peers: c.stats.connections, bytesDown: c.stats.bytesFromPeer, bytesUp: c.stats.bytesToPeer,
        streamsOpened: c.stats.streamsOpened, streamsClosed: c.stats.streamsClosed,
        staleFrames: c.stats.staleFrames, dropped: c.stats.dropped,
      })),
    });
    note('server-seen-count', seen.length);
    note('server-seen', seen.map((s) => ({ url: s.url, atMs: s.atMs, reqBytes: s.reqBytes })));

    const hostRoute = typeof hostManager.getRouteReport === 'function' ? hostManager.getRouteReport() : null;
    if (hostRoute) note('host-netState', hostRoute.netState || null);
    const joinRoute = typeof joinManager.getRouteReport === 'function' ? joinManager.getRouteReport() : null;
    if (joinRoute) note('join-netState', joinRoute.netState || null);

    const aTest = out.tests.find((t) => t.name.startsWith('A '));
    const bTests = out.tests.filter((t) => t.name.startsWith('B '));
    const cTest = out.tests.find((t) => t.name.startsWith('C '));
    const dTest = out.tests.find((t) => t.name.startsWith('D '));
    const summary = {
      A: aTest ? (aTest.exact === null ? aTest.ok : aTest.exact) : false,
      B: bTests.filter((t) => (t.exact === null ? t.ok : t.exact)).length + '/' + bTests.length,
      C: cTest ? cTest.ok : null,
      D: dTest ? dTest.exact : null,
      serverSaw: seen.length,
    };
    note('summary', summary);
    const allOk = summary.A && bTests.length === 6 && bTests.every((t) => (t.exact === null ? t.ok : t.exact))
      && (MODE !== 'probe' || (cTest && cTest.ok && dTest && dTest.exact));
    save({ ok: Boolean(allOk) });
  } catch (err) {
    save({ ok: false, error: String(err && err.stack ? err.stack : err).slice(0, 1200) });
  } finally {
    try { await joinManager.stop(); } catch { /* ignore */ }
    try { await hostManager.stop(); } catch { /* ignore */ }
    try { joinManager.shutdown(); } catch { /* ignore */ }
    try { hostManager.shutdown(); } catch { /* ignore */ }
    try { await new Promise((r) => testServer.close(() => r())); } catch { /* ignore */ }
  }
  process.exitCode = 0;
  await wait(500);
  process.exit(0);
})().catch(async (err) => {
  save({ ok: false, error: String(err && err.stack ? err.stack : err).slice(0, 1200) });
  process.exit(1);
});
