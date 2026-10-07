'use strict';
// 预热连接池的现场判决：在**真实 Steam P2P**上量"浏览器开一条新连接要等多久"。
//
// 为什么必须有它：单元测试用的是假 SDK，握手是瞬间完成的，量不出"排队限速"这件事。
// 而现场的病根恰恰就是那个排队 —— 新建的 Steam P2P 连接大约每 2~4 秒才放行一条。
// 所以只有在本机把房主 + 加入者都跑起来（真 SDK、真握手），才能回答：
//   「0.13.0 的池子到底有没有让用户不用等？」
//
// 用法：
//   node diag\pool-verify.cjs             # 池子默认开启（4 条）
//   node diag\pool-verify.cjs 0           # 基线：池子关掉，每条连接现握手
//   node diag\pool-verify.cjs 4 8         # 池子 4 条，开 8 条连接来测
//
// 输出里认三样东西：
//   ① 每条连接的"连上→首字节"毫秒数（命中池子应该是几十毫秒，现握手是 2000~4000+）
//   ② 预热池 命中/未命中 计数
//   ③ 有没有 5003（Steam 建连超时）

const path = require('node:path');
const net = require('node:net');
const http = require('node:http');

// 这个脚本有两份副本：仓库里的 diag/（ROOT 就是上一级）和开发工作区根目录的 diag/
// （上一级是工作区，源码在 Stronghold-Link/source）。两种摆放都自动认出来。
const fs = require('node:fs');
const IN_REPO = fs.existsSync(path.resolve(__dirname, '..', 'network', 'session.cjs'));
const ROOT = IN_REPO
  ? path.resolve(__dirname, '..')
  : path.resolve(__dirname, '..', 'Stronghold-Link', 'source');
const { SessionManager } = require(path.join(ROOT, 'network', 'session.cjs'));

const POOL = process.argv[2] != null ? String(process.argv[2]) : '';
const PROBES = Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 8;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 23);
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const tunnelEvents = [];
const logs = [];

(async () => {
  // 本地"游戏服务"替身：**真的用 node:http**，因为现场的游戏服务就是 Node http。
  // 这一点很关键：池子里的连接是"连上但一句话不说"的，Node 对它们用的是
  // headersTimeout（默认 60 秒），而不是有响应之后的 keepAliveTimeout（5 秒）。
  // 拿裸 net.createServer 冒充就量不出这个寿命，池子的看门狗到底够不够早也就无从判断。
  const body = 'ok';
  // SHL_BIG_BYTES：让替身按 /big 路径吐一大坨（默认 512 KiB），用来验证
  // "大响应还在路上、服务端就把本地连接关了"这条路径会不会被截断。
  const bigBody = Buffer.alloc(Number(process.env.SHL_BIG_BYTES || 524288), 0x41);
  const game = http.createServer((req, res) => {
    const out = req.url && req.url.startsWith('/big') ? bigBody : Buffer.from(body);
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': String(out.length) });
    res.end(out);
  });
  game.headersTimeout = 60000;
  game.keepAliveTimeout = 5000;
  const gamePort = await freePort();
  await new Promise((r) => game.listen(gamePort, '127.0.0.1', r));

  const onEvent = (who) => (e) => {
    if (e.type === 'log') logs.push(`${who}: ${e.entry.text}`);
    else if (e.type === 'tunnel') {
      // peer-stats 带着每条连接此刻还压着多少字节，截短了就看不出名堂，所以单独放宽。
      const cap = e.event === 'peer-stats' ? 4000 : 200;
      tunnelEvents.push(`${who}|${e.event}|${JSON.stringify(e.payload || {}).slice(0, cap)}`);
    }
  };

  const hostManager = new SessionManager({ appDir: ROOT, onEvent: onEvent('房主') });
  const joinManager = new SessionManager({ appDir: ROOT, onEvent: onEvent('加入者') });

  const hostSnap = await hostManager.start({ role: 'host', adapter: 'steam', targetHost: '127.0.0.1', gamePort, appId: 480, game: 'pool-verify' });
  const steamId = hostSnap.invite && hostSnap.invite.steamId;
  if (!steamId) throw new Error('没有拿到本机 SteamID（Steam 没起来？）');
  console.log(`${stamp()} 房主就绪 ${steamId}`);

  const entry = await freePort();
  await joinManager.start({ role: 'joiner', adapter: 'steam', hostSteamId: steamId, localPort: entry, appId: 480 });
  console.log(`${stamp()} 加入者就绪，入口 127.0.0.1:${entry}；池子=${POOL === '' ? '默认' : POOL}，要测 ${PROBES} 条连接`);

  const statsOf = () => {
    const ch = joinManager.getSnapshot().channels.find((c) => c.protocol === 'STEAM');
    return (ch && ch.stats) || {};
  };
  // 上行到底走到哪一步了：分别读加入者与房主的通道计数。
  // 只看加入者的话，"发出去了"和"对端收到了"分不清 —— 排查上行断流时必须两边都看。
  const bothOf = () => {
    const pick = (mgr) => {
      const ch = mgr.getSnapshot().channels.find((c) => c.protocol === 'STEAM');
      const s = (ch && ch.stats) || {};
      return {
        up: s.bytesToPeer || 0,
        down: s.bytesFromPeer || 0,
        peers: s.connections || 0,
        // 上行计数是在"入队"时加的，所以它涨了并不代表发出去了。
        // 这三个计数才能说明字节到底卡在哪一步：
        //   dropped    = 本机服务有响应，但 Steam 连接已被判为不活跃，直接丢掉
        //   sendStalls = Steam 发送缓冲满，数据留在 peer.out 里等泵重试
        //   outBytes   = 此刻还压在 peer.out 里的字节数
        dropped: s.dropped || 0,
        sendStalls: s.sendStalls || 0,
        outBytes: s.outBytes || 0,
        failed: s.failed || 0,
        rejected: s.rejected || 0,
      };
    };
    return { join: pick(joinManager), host: pick(hostManager) };
  };

  console.log(`${stamp()} 通道清单：${JSON.stringify(joinManager.getSnapshot().channels.map((c) => ({ p: c.protocol, keys: Object.keys(c.stats || {}).length })))}`);

  // 等池子养起来（最多 40 秒）。池子关掉时这一步会直接跳过。
  const poolTarget = POOL === '' ? 4 : Number(POOL);
  if (poolTarget > 0) {
    const t0 = Date.now();
    let tick = 0;
    while (Date.now() - t0 < 40000) {
      const s = statsOf();
      // 判"池子养好了"要看 connections（池子里现存的条数），不能看 poolReady ——
      // poolReady 是"累计就绪次数"，被领走后再补货也会涨，拿它当条数会提前放行。
      if ((s.connections || 0) >= poolTarget) break;
      tick += 1;
      if (tick % 5 === 0) console.log(`${stamp()}   等池子 ${((Date.now() - t0) / 1000).toFixed(0)}s：备用${s.connections || 0} 累计开${s.poolCreated || 0} 就绪${s.poolReady || 0} 命中${s.poolHits || 0} 未命中${s.poolMisses || 0}`);
      await wait(500);
    }
    const s = statsOf();
    console.log(`${stamp()} 池子就绪判定：备用${s.connections || 0} 累计开${s.poolCreated || 0} 就绪${s.poolReady || 0}（目标 ${poolTarget}），等了 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // 逐条开连接（顺序的 —— 同时开就分不清"是排队慢"还是"池子没货"）。
  const results = [];
  if (PROBES === 0) {
    // 只看不碰：盯 150 秒，确认池子里的连接能自己活过游戏服务器的 headersTimeout（60 秒）。
    // 池子的看门狗是 45 秒 × 60%~90% 抖动，必须早于 60 秒换新，否则池子里全是死连接。
    for (let i = 0; i < 30; i += 1) {
      const s = statsOf();
      console.log(`${stamp()} 盯池子 ${(i * 5).toString().padStart(3)}s  备用${s.connections || 0} 累计开${s.poolCreated || 0} 就绪${s.poolReady || 0} 命中${s.poolHits || 0} 未命中${s.poolMisses || 0} 换新${s.poolRetired || 0} 自死${s.poolLost || 0} 均寿${(s.poolRetired || s.poolLost) ? Math.round((s.poolLifeMs || 0) / ((s.poolRetired || 0) + (s.poolLost || 0)) / 1000) : 0}s`);
      await wait(5000);
    }
  }
  for (let i = 1; i <= PROBES; i += 1) {
    const before = statsOf();
    const b = bothOf();
    const row = await new Promise((resolve) => {
      const t0 = Date.now();
      const c = net.createConnection({ host: '127.0.0.1', port: entry });
      let settled = false;
      const finish = (ok, note) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { c.destroy(); } catch { /* ignore */ }
        resolve({ i, ms: Date.now() - t0, ok, note });
      };
      const timer = setTimeout(() => finish(false, '40s 超时'), 40000);
      // SHL_PROBE_DELAY_MS：连上之后先等一会儿再发请求。
      // 用来分辨"在刚交接的那一刻发数据会丢"和"这条链路根本发不出去"。
      const delayMs = Number(process.env.SHL_PROBE_DELAY_MS || 0);
      // SHL_PROBE_PATH / SHL_PROBE_WANT：请求指定路径，并等够 want 字节才算过。
      const probePath = process.env.SHL_PROBE_PATH || '/';
      const want = Number(process.env.SHL_PROBE_WANT || 0);
      let got = 0;
      c.on('connect', () => {
        // 默认 HTTP/1.0：服务端回完响应立刻关本地连接，正是现场游戏服务的行为。
        // SHL_PROBE_HTTP=1.1 可切到 keep-alive，用来对照"服务端不主动关"时是否就好了。
        const httpVer = process.env.SHL_PROBE_HTTP || '1.0';
        const send = () => { try { c.write(`GET ${probePath} HTTP/${httpVer}\r\nHost: x\r\n\r\n`); } catch { /* ignore */ } };
        if (delayMs > 0) setTimeout(send, delayMs); else send();
      });
      c.on('data', (d) => {
        got += d.length;
        if (!want || got >= want) finish(true, `${got}B${want && got >= want ? ' 完整' : ''}`);
      });
      c.on('end', () => { if (got > 0) finish(true, `${got}B（对端先关）`); });
      c.on('close', () => { if (!settled) finish(got > 0, got > 0 ? `${got}B（短了）` : '连接关掉、0 字节'); });
      c.on('error', (e) => finish(false, e && e.code ? e.code : String(e)));
    });
    const after = statsOf();
    const a = bothOf();
    const warm = (after.poolHits || 0) > (before.poolHits || 0);
    row.pool = warm ? '命中池子' : '现握手';
    results.push(row);
    console.log(`${stamp()} #${row.i} ${row.ok ? '✔' : '✘'} ${String(row.ms).padStart(6)}ms  ${row.pool}  ${row.note}`);
    console.log(`        加入者 上行+${a.join.up - b.join.up}B 下行+${a.join.down - b.join.down}B 条数${a.join.peers} ↓丢弃${a.join.dropped - b.join.dropped} 发送卡${a.join.sendStalls - b.join.sendStalls} 积压${a.join.outBytes}B`);
    console.log(`        房主   上行+${a.host.up - b.host.up}B 下行+${a.host.down - b.host.down}B 条数${a.host.peers} ↓丢弃${a.host.dropped - b.host.dropped} 发送卡${a.host.sendStalls - b.host.sendStalls} 积压${a.host.outBytes}B`);
    await wait(300);
  }

  const s = statsOf();
  console.log(`\n=== 汇总（池子=${POOL === '' ? '默认4' : POOL}）===`);
  const hitRows = results.filter((r) => r.pool === '命中池子');
  const missRows = results.filter((r) => r.pool === '现握手');
  const avg = (rows) => (rows.length ? Math.round(rows.reduce((a, r) => a + r.ms, 0) / rows.length) : 0);
  console.log(`命中池子 ${hitRows.length} 条，平均 ${avg(hitRows)} ms`);
  console.log(`现握手   ${missRows.length} 条，平均 ${avg(missRows)} ms`);
  console.log(`失败 ${results.filter((r) => !r.ok).length} 条`);
  console.log(`预热池 累计开${s.poolCreated || 0} 就绪${s.poolReady || 0} 命中${s.poolHits || 0} 未命中${s.poolMisses || 0} 换新${s.poolRetired || 0} 自死${s.poolLost || 0} 均寿${(s.poolRetired || s.poolLost) ? Math.round((s.poolLifeMs || 0) / ((s.poolRetired || 0) + (s.poolLost || 0)) / 1000) : 0}s`);

  console.log(`\n--- 通道全景 ---`);
  for (const c of joinManager.getSnapshot().channels) {
    console.log(`  ${c.protocol} role=${c.role || '?'} stats=${JSON.stringify(c.stats).slice(0, 400)}`);
  }
  console.log(`  client-added 事件 ${tunnelEvents.filter((e) => e.includes('|client-added|')).length} 条`);
  for (const e of tunnelEvents.filter((x) => x.includes('|client-added|')).slice(-10)) console.log('    ' + e);

  const reasons = tunnelEvents.filter((e) => e.includes('|peer-left|')).map((e) => (e.match(/"endReason":(\d+)/) || [])[1]).filter(Boolean);
  const hist = {};
  for (const r of reasons) hist[r] = (hist[r] || 0) + 1;
  console.log(`连接结束原因直方图 ${JSON.stringify(hist)}`);

  // peer-stats 里每条连接都带 queue（此刻还压在 peer.out 里没发出去的字节）。
  // 上行计数是入队时加的，所以"发了"和"发出去了"只能靠这个区分。
  for (const who of ['房主', '加入者']) {
    const rows = tunnelEvents.filter((e) => e.startsWith(`${who}|peer-stats|`)).slice(-2);
    if (!rows.length) continue;
    console.log(`\n--- ${who} peer-stats（最后两条）---`);
    for (const r of rows) console.log('  ' + r);
  }

  const interesting = logs.filter((l) => /预热池|本机连接进来|连接结束|超时|失败/.test(l));
  if (interesting.length) { console.log('\n--- 隧道日志 ---'); for (const l of interesting.slice(-20)) console.log('  ' + l); }

  await joinManager.stop().catch(() => {});
  await hostManager.stop().catch(() => {});
  joinManager.shutdown();
  hostManager.shutdown();
  await new Promise((r) => game.close(() => r()));
  process.exit(0);
})().catch((err) => {
  console.log('判决异常：' + String(err && err.stack ? err.stack : err).slice(0, 1200));
  process.exit(1);
});
