'use strict';
// 真机探针：**25 条本机 TCP 同时过去，Steam 层到底还是不是 1 条连接**。
//
// 为什么必须单独跑这一趟：`test/phase8-acceptance.test.cjs` 里那条「20 条本机连接进来，
// Steam 连接数仍然是 1」跑在注入的假 SDK 上（`### 8.4`）。规格 §三十七 与 §三十八-F
// 要的却是真机数字：**P2P 数量与 Minecraft TCP 数量无关**。0.13.3 的现场故障正是这一点
// 的反面 —— 一次页面加载开 6~25 条本机 TCP，每条都去握一次手，校园网下 25 条同时扑上来
// 时池子是空的，于是整整 25 秒页面一个字都拿不到。
//
// 本探针用真实 Steam（真实 steamworks-ffi-node + 真实 Steam 客户端，appId 480），
// 房主与加入者两个 SessionManager 都走 adapter: 'steam'，加入者连自己的 SteamID 做本机自连。
// 然后一次性开 N 条本机连接，每条要一份 4 KiB 响应，量三件事：
//
//   1) 全部 N 条拿到完整响应要多久（0.13.3 的失败形态是"卡 25 秒然后什么都没有"）
//   2) `snapshot.netState.activeSteamConnections` 是不是仍然只有 1 条（规格 §三十七）
//   3) `snapshot.netState.activeStreams` 是不是 N 条（一条本机连接 = 一条流）
//
// 用法：node tools\steam-mux-load-probe.cjs [连接条数] [每条响应字节数]
// 结果写 tools/steam-mux-load-result.json

const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');

const { SessionManager } = require('../network/session.cjs');

const COUNT = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 25;
const BODY_BYTES = Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 4096;
const appDir = path.join(__dirname, '..');

const out = { count: COUNT, bodyBytes: BODY_BYTES, steps: [] };
const note = (name, value) => {
  out.steps.push({ name, value });
  console.log(`[load] ${name}: ${JSON.stringify(value)}`);
};
const save = (extra = {}) => {
  Object.assign(out, extra);
  try {
    fs.writeFileSync(path.join(__dirname, 'steam-mux-load-result.json'), JSON.stringify(out, null, 2), 'utf8');
  } catch { /* ignore */ }
  console.log('RESULT ' + JSON.stringify({ ok: out.ok, count: COUNT, ms: out.ms, steamConnections: out.steamConnections, streams: out.streams }));
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

// 可复现的图案：收完之后逐字节比对，不只看长度 —— 串线（流之间数据混到一起）
// 在没有校验的时候看起来和成功一模一样。
const PATTERN = Buffer.alloc(BODY_BYTES);
for (let i = 0; i < BODY_BYTES; i += 1) PATTERN[i] = (i * 37 + 11) & 0xff;

(async () => {
  // 1) 本地"游戏服务"：连上来就吐一份定长响应，然后继续收（模拟 HTTP 响应体）。
  const served = new Set();
  const srv = net.createServer((socket) => {
    socket.setNoDelay(true);
    socket.on('error', () => {});
    socket.write(PATTERN);
    socket.on('data', () => { /* 请求内容不关心，响应已经先发出去了 */ });
    socket.on('close', () => served.delete(socket));
    served.add(socket);
  });
  const srvPort = await listen(srv, 0);
  note('servicePort', srvPort);
  note('bodyBytes', BODY_BYTES);

  const hostManager = new SessionManager({
    appDir,
    onEvent: (e) => { if (e.type === 'log') out.steps.push({ name: 'host-log', value: e.entry.text }); },
  });
  const joinManager = new SessionManager({
    appDir,
    onEvent: (e) => { if (e.type === 'log') out.steps.push({ name: 'join-log', value: e.entry.text }); },
  });

  // 2) 房主：Steam P2P 隧道，出口指向本机那个"游戏服务"
  const hostSnap = await hostManager.start({
    role: 'host', adapter: 'steam', targetHost: '127.0.0.1', gamePort: srvPort, appId: 480, game: 'steam-mux-load',
  });
  const steamId = hostSnap.invite && hostSnap.invite.steamId;
  note('host', { state: hostSnap.state, steamId, security: hostSnap.security.mode });
  if (!steamId) throw new Error('没有拿到本机 SteamID');

  // 3) 加入者：连自己的 SteamID（本机自连）
  const entryPort = await freePort();
  const joinSnap = await joinManager.start({
    role: 'joiner', adapter: 'steam', hostSteamId: steamId, localPort: entryPort, appId: 480,
  });
  note('joiner', { state: joinSnap.state, entryPort, security: joinSnap.security.mode });

  // 先等干道真的就绪，再一起扑上去 —— 否则量到的是"干道还没握完手"，
  // 不是"多路复用撑不撑得住并发"。
  //
  // 注意取的是 getRouteReport() 而不是 getSnapshot()：netState 只挂在路线报告上
  // （session.cjs:558），getSnapshot() 里没有这一项 —— 拿 getSnapshot() 读会得到
  // undefined，然后所有断言都"通过"（因为 0 <= 2 恒真），看起来一片绿其实什么都没验。
  const waitTrunk = async (manager, ms) => {
    const deadline = Date.now() + ms;
    let last = null;
    while (Date.now() < deadline) {
      last = (manager.getRouteReport() || {}).netState || null;
      // 状态值是 network-health.cjs 的 LINK_STATE.P2P_CONNECTED（大写），
      // 不是小写的 'p2p-connected' —— 写错会白等满整个超时窗口。
      if (last && Number(last.activeSteamConnections) >= 1 && last.state === 'P2P_CONNECTED') {
        return { ready: true, state: last.state, activeSteamConnections: last.activeSteamConnections };
      }
      await wait(200);
    }
    return { ready: false, state: last ? last.state : null, activeSteamConnections: last ? last.activeSteamConnections : null };
  };
  const trunkAt = Date.now();
  const trunk = await waitTrunk(joinManager, 20000);
  note('trunk-ready', { ...trunk, ms: Date.now() - trunkAt });

  // 4) 一起开 N 条本机连接，每条要一份定长响应，逐条计时。
  const results = [];
  const t0 = Date.now();
  await Promise.all(Array.from({ length: COUNT }, (_unused, index) => new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port: entryPort });
    const got = [];
    let bytes = 0;
    let settled = false;
    const finish = (ok, why) => {
      if (settled) return;
      settled = true;
      results[index] = { index, ok, why: why || '', bytes, ms: Date.now() - t0 };
      try { sock.destroy(); } catch { /* ignore */ }
      resolve();
    };
    const timer = setTimeout(() => finish(false, '超时'), 30000);
    sock.on('data', (chunk) => {
      got.push(chunk);
      bytes += chunk.length;
      if (bytes >= BODY_BYTES) {
        clearTimeout(timer);
        const all = Buffer.concat(got).subarray(0, BODY_BYTES);
        finish(all.equals(PATTERN), all.equals(PATTERN) ? '' : '内容不对（可能串线）');
      }
    });
    sock.on('error', (err) => { clearTimeout(timer); finish(false, String(err && err.message ? err.message : err)); });
    sock.once('connect', () => { sock.write(`GET ${index}\n`); });
  })));
  const ms = Date.now() - t0;

  const okCount = results.filter((r) => r && r.ok).length;
  const failed = results.filter((r) => r && !r.ok);
  const times = results.filter((r) => r && r.ok).map((r) => r.ms).sort((a, b) => a - b);
  note('load', {
    total: COUNT,
    ok: okCount,
    failed: failed.length,
    firstOkMs: times.length ? times[0] : null,
    medianMs: times.length ? times[Math.floor(times.length / 2)] : null,
    lastOkMs: times.length ? times[times.length - 1] : null,
    wallMs: ms,
    failures: failed.slice(0, 5).map((r) => ({ index: r.index, why: r.why })),
  });

  // 5) 此刻的 Steam 层账目 —— 这就是规格 §三十七 要的那个数字。
  //
  // 读数必须在**连接还开着的时候**取：流随本机 socket 关闭而消失，
  // 等 25 条都 destroy 完再读，activeStreams 只会是 0。
  const route = joinManager.getRouteReport() || {};
  const hostRoute = hostManager.getRouteReport() || {};
  const ns = route.netState || {};
  const hostNs = hostRoute.netState || {};
  note('steam-layer', {
    netStatePresent: Boolean(route.netState),
    joinerActiveSteamConnections: ns.activeSteamConnections,
    joinerMaxActiveSteamConnections: ns.maxActiveSteamConnections,
    joinerActiveStreams: ns.activeStreams,
    joinerStreamsOpened: ns.streamsOpened,
    joinerState: ns.state,
    joinerStateLabel: ns.stateLabel,
    joinerLinkState: route.netState ? undefined : route.route,
    hostActiveSteamConnections: hostNs.activeSteamConnections,
    hostActiveStreams: hostNs.activeStreams,
    localTcpSocketsStillOpen: served.size,
  });

  // 读不到 netState 就不许判"通过" —— 否则 undefined 会让下面每条断言都恒真。
  const haveReading = Boolean(route.netState) && ns.activeSteamConnections !== undefined;
  const verdict = {
    netStateRead: haveReading,
    // 这条是"真的读到了 Steam 层账目"的守卫：读不到就不许判通过。
    steamConnectionsRead: haveReading,
    allEchoed: okCount === COUNT,
    // 规格 §三十七 / §三十八-F：25 条本机 TCP 不该变成 25 条 Steam 连接。
    steamConnectionsBounded: haveReading && Number(ns.activeSteamConnections) <= 2,
    steamConnectionsFarBelowStreams: haveReading && Number(ns.activeSteamConnections) < COUNT,
    streamsMatchLocal: haveReading && Number(ns.activeStreams) === COUNT,
  };
  note('verdict', verdict);
  out.ms = ms;
  out.steamConnections = ns.activeSteamConnections;
  out.streams = ns.activeStreams;

  // 6) 收拾干净
  await joinManager.stop();
  await hostManager.stop();
  joinManager.shutdown();
  hostManager.shutdown();
  for (const s of served) { try { s.destroy(); } catch { /* ignore */ } }
  await new Promise((r) => srv.close(() => r()));

  const ok = verdict.allEchoed && verdict.steamConnectionsRead && verdict.steamConnectionsFarBelowStreams;
  save({ ok });

  // SessionManager.shutdown()（session.cjs:1227）是"退出路径"用的同步方法，
  // 它调用 provider.stop() 但**不 await** —— 原生 FFI 的收摊可能还在另一个线程上跑。
  // 这时候立刻 process.exit()，析构会和原生线程抢堆，进程以
  // 0xC0000374（STATUS_HEAP_CORRUPTION）退出、连 RESULT 都来不及打。
  // 那是**探针的收尾姿势**问题，不是产品缺陷：产品里没人这么退。
  //
  // 默认仍然强制退出（好让脚本有个确定的退出码）；设 SHL_NO_FORCE_EXIT=1
  // 就改成"只设退出码、让事件循环自己走干净"，用来判别崩到底是收尾姿势还是别的东西。
  process.exitCode = ok ? 0 : 2;
  await wait(500);
  if (!process.env.SHL_NO_FORCE_EXIT) process.exit(ok ? 0 : 2);
})().catch(async (err) => {
  out.error = String(err && err.stack ? err.stack : err).slice(0, 1200);
  console.error('[load] failed', out.error);
  save({ ok: false });
  process.exit(1);
});
