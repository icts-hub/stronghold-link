'use strict';
// 真机自连完整性探针：房主与加入者两个角色都跑在本机（真实 Steam P2P 自连），
// 让一端吐一串**伪随机**字节（随机分块、随机间隔，模拟 Minecraft 包长分布与打散），
// 另一端逐字节比对，回答一个只有真机能回答的问题：
//   **经过我们的隧道之后，可靠字节流是否与写出去的一模一样？**
//
// 为什么要它：现场是 Minecraft 客户端解码服务端数据时抛
// `DecoderException: DataFormatException: incorrect header check / unknown compression method`——
// 也就是"这条 TCP 流中间多/少/错了一段"。注入假 SDK 的单测能覆盖分帧与队列逻辑，
// 但覆盖不了真实 Steam 发送通道 + 真实 TCP + 真实事件循环下的字节完整性。
// 本探针把这四者放在一起，判决标准只有一条：**收到的字节必须逐字节等于写出的字节**。
//
// 自连回环（Steam 本机自连到自己的 SteamID）不含跨机网络，所以一旦出现不一致，
// 就只能是本机转发代码；反过来，如果不一致为 0，就能排除"我们这端在稳态下吞/重字节"。
//
// 用法：node tools\steam-integrity-probe.cjs [下行MB] [上行MB] [拒收百分比]
// 结果写 tools/steam-integrity-result.json

const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { SessionManager } = require('../network/session.cjs');

const DOWN_MB = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 8;
const UP_MB = Number(process.argv[3]) >= 0 ? Number(process.argv[3]) : 2;
const FLAKY_PCT = Number(process.argv[4]) > 0 ? Number(process.argv[4]) : 0;

// 给真实 Steam 发送通道注入"偶发拒收"：本机回环太快，正常跑一辈子也撞不到
// `k_EResultLimitExceeded`/暂时拒收，而"发送被拒之后重试"正是可靠字节流最容易出现空洞的地方。
// 注入点选在 SDK 单例的 sockets.sendMessage（适配器拿到的就是同一个实例）。
let flaky = null;
const injectFlakySends = (pct) => {
  const resolved = require.resolve('steamworks-ffi-node', { paths: [path.join(__dirname, '..'), __dirname, ...module.paths] });
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const mod = require(resolved);
  const SDK = mod.default || mod.SteamworksSDK;
  const steam = SDK.getInstance();
  const sockets = steam && (steam.networkingSockets || steam.sockets);
  if (!sockets || typeof sockets.sendMessage !== 'function') throw new Error('拿不到 steam.networkingSockets.sendMessage');
  const orig = sockets.sendMessage.bind(sockets);
  flaky = { pct, calls: 0, refusals: 0 };
  sockets.sendMessage = (connection, data, flags) => {
    flaky.calls += 1;
    if (Math.random() * 100 < pct) { flaky.refusals += 1; return { success: false, result: 2, injectedRefusal: true }; }
    return orig(connection, data, flags);
  };
  return flaky;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 23);
const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => resolve(server.address().port));
});
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

// xorshift32：伪随机但可复现，两边各自造出完全相同的字节
const makeSource = (bytes, seed = 0x1a2b3c4d) => {
  const buf = Buffer.allocUnsafe(bytes);
  let x = seed >>> 0;
  for (let i = 0; i < bytes; i += 1) {
    x ^= (x << 13) >>> 0; x >>>= 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0; x >>>= 0;
    buf[i] = x & 0xff;
  }
  return buf;
};
const firstDiff = (chunk, want, offset, len) => {
  for (let i = 0; i < len; i += 1) if (chunk[i] !== want[offset + i]) return offset + i;
  return -1;
};

(async () => {
  const down = makeSource(DOWN_MB * 1024 * 1024, 0x1a2b3c4d);
  const up = UP_MB > 0 ? makeSource(UP_MB * 1024 * 1024, 0x5e6f7081) : Buffer.alloc(0);
  const result = { downMB: DOWN_MB, upMB: UP_MB, down: null, up: null, channel: null, pass: false };

  const logs = [];
  const tag = (who) => (e) => { if (e.type === 'log') logs.push(`${who}: ${e.entry.text}`); };

  // 本机服务端：先吐 down（随机分块），再收 up 并逐字节比对
  const server = net.createServer(async (socket) => {
    socket.on('error', () => {});
    let stopped = false;
    const stop = () => { stopped = true; };
    socket.on('close', stop);
    try {
      let off = 0;
      while (off < down.length && !stopped) {
        const len = Math.min(down.length - off, 64 + Math.floor(Math.random() * 65536));
        if (!socket.write(down.subarray(off, off + len))) await new Promise((r) => socket.once('drain', r));
        off += len;
        if (Math.random() < 0.15) await wait(Math.floor(Math.random() * 3));
      }
    } catch { /* 对端关了 */ }
    if (up.length) {
      const rec = { got: 0, mismatchAt: -1, mismatchBytes: 0 };
      socket.on('data', (d) => {
        const at = rec.mismatchAt < 0 ? firstDiff(d, up, rec.got, d.length) : rec.mismatchAt;
        if (at >= 0 && rec.mismatchAt < 0) rec.mismatchAt = at;
        if (at >= 0) rec.mismatchBytes += d.length;
        rec.got += d.length;
        server.upRec = rec;
      });
    }
  });
  const gamePort = await listen(server, 0);

  const hostManager = new SessionManager({ appDir: path.join(__dirname, '..'), onEvent: tag('房主') });
  const joinManager = new SessionManager({ appDir: path.join(__dirname, '..'), onEvent: tag('加入者') });

  if (FLAKY_PCT > 0) {
    try { injectFlakySends(FLAKY_PCT); console.log(`${stamp()} 已给真实 Steam 发送通道注入 ${FLAKY_PCT}% 随机拒收（逼出重试/背压路径）`); } catch (e) { console.log(`${stamp()} 拒收注入失败（跳过，本次不覆盖该路径）：${String(e).slice(0, 140)}`); }
  }

  const hostSnap = await hostManager.start({ role: 'host', adapter: 'steam', targetHost: '127.0.0.1', gamePort, appId: 480, game: 'integrity-test' });
  const steamId = hostSnap.invite && hostSnap.invite.steamId;
  if (!steamId) throw new Error('没有拿到本机 SteamID');
  console.log(`${stamp()} 房主就绪 ${steamId}（本机游戏端口 ${gamePort}）`);

  const entryPort = await freePort();
  await joinManager.start({ role: 'joiner', adapter: 'steam', hostSteamId: steamId, localPort: entryPort, appId: 480 });
  console.log(`${stamp()} 加入者就绪，入口 127.0.0.1:${entryPort}`);

  const client = net.createConnection({ host: '127.0.0.1', port: entryPort });
  client.on('error', (e) => { result.clientError = String(e && e.code ? e.code : e); });
  await new Promise((r) => { client.once('connect', r); client.once('error', r); });

  const rec = { got: 0, mismatchAt: -1, mismatchBytes: 0, t0: Date.now(), firstByteAt: 0, chunks: [] };
  client.on('data', (d) => {
    if (!rec.firstByteAt) rec.firstByteAt = Date.now();
    if (rec.mismatchAt < 0) {
      const at = firstDiff(d, down, rec.got, d.length);
      if (at >= 0) { rec.mismatchAt = at; rec.mismatchBytes += d.length; }
    } else rec.mismatchBytes += d.length;
    rec.got += d.length;
    rec.chunks.push(Buffer.from(d));
  });

  console.log(`${stamp()} 下载方向开始：${DOWN_MB} MB 伪随机字节，随机分块`);
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && rec.got < down.length && rec.mismatchAt < 0) await wait(200);
  const elapsed = (Date.now() - rec.t0) / 1000;
  const downPass = rec.mismatchAt < 0 && rec.got === down.length;
  result.down = {
    want: down.length, got: rec.got, pass: downPass,
    mismatchAt: rec.mismatchAt, mismatchBytes: rec.mismatchBytes,
    elapsedSec: Number(elapsed.toFixed(2)), firstByteMs: rec.firstByteAt ? rec.firstByteAt - rec.t0 : null,
    kibPerSec: Number((rec.got / elapsed / 1024).toFixed(1)),
  };
  if (rec.mismatchAt >= 0) {
    // 把"收到的字节"和"写出的字节"对齐看清楚：收到的这一段在源里到底对应哪儿
    const all = Buffer.concat(rec.chunks);
    const at = rec.mismatchAt;
    const sample = all.subarray(at, Math.min(at + 64, all.length));
    const foundAt = down.indexOf(sample);
    const expect = down.subarray(at, at + 64);
    const expectFoundAt = all.indexOf(expect);
    const back = Math.max(0, at - 128);
    result.down.diagnosis = {
      receivedAtMismatch: sample.subarray(0, 24).toString('hex'),
      expectedAtMismatch: expect.subarray(0, 24).toString('hex'),
      receivedTailFoundInSourceAt: foundAt,
      expectedBytesFoundInReceivedAt: expectFoundAt,
      deltaBytes: foundAt - at,
      receivedAroundMismatch: all.subarray(back, at + 32).toString('hex'),
      sourceAroundMismatch: down.subarray(back, at + 32).toString('hex'),
      firstChunkSizes: rec.chunks.slice(0, 8).map((c) => c.length),
    };
    console.log(`${stamp()} 诊断：收到的字节在源里的位置 ${foundAt}（期望 ${at}，差 ${foundAt - at} B）；源里该位置的字节在收到的流里出现在 ${expectFoundAt}`);
  }
  console.log(`${stamp()} 下载方向 ${downPass ? '逐字节一致 ✓' : '不一致 ✗'}  收到 ${rec.got}/${down.length} B  用时 ${elapsed.toFixed(1)}s  首个不一致偏移 ${rec.mismatchAt}`);

  if (up.length && rec.mismatchAt < 0 && rec.got === down.length) {
    console.log(`${stamp()} 上传方向开始：${UP_MB} MB 伪随机字节`);
    let off = 0;
    while (off < up.length) {
      const len = Math.min(up.length - off, 64 + Math.floor(Math.random() * 65536));
      if (!client.write(up.subarray(off, off + len))) await new Promise((r) => client.once('drain', r));
      off += len;
      if (Math.random() < 0.15) await wait(Math.floor(Math.random() * 3));
    }
    const upDeadline = Date.now() + 60000;
    while (Date.now() < upDeadline && (!server.upRec || server.upRec.got < up.length) && (!server.upRec || server.upRec.mismatchAt < 0)) await wait(200);
    const r = server.upRec || { got: 0, mismatchAt: -1, mismatchBytes: 0 };
    const upPass = r.mismatchAt < 0 && r.got === up.length;
    result.up = { want: up.length, got: r.got, pass: upPass, mismatchAt: r.mismatchAt, mismatchBytes: r.mismatchBytes };
    console.log(`${stamp()} 上传方向 ${upPass ? '逐字节一致 ✓' : '不一致 ✗'}  收到 ${r.got}/${up.length} B  首个不一致偏移 ${r.mismatchAt}`);
  }

  const hs = hostManager.getSnapshot();
  const js = joinManager.getSnapshot();
  result.channel = { host: hs.channels.map((c) => ({ up: c.stats.bytesToPeer, down: c.stats.bytesFromPeer, stalls: c.stats.sendStalls ?? null, dropped: c.stats.dropped ?? null })), joiner: js.channels.map((c) => ({ up: c.stats.bytesToPeer, down: c.stats.bytesFromPeer, stalls: c.stats.sendStalls ?? null, dropped: c.stats.dropped ?? null })) };
  result.pass = !!(result.down && result.down.pass) && (!result.up || result.up.pass);
  if (flaky) result.flakySends = { pct: flaky.pct, calls: flaky.calls, refusals: flaky.refusals };
  console.log(`通道统计 ${JSON.stringify(result.channel)}`);
  if (flaky) console.log(`发送拒收注入：共 ${flaky.calls} 次调用，其中 ${flaky.refusals} 次被拒（${flaky.pct}% 概率）`);
  const interesting = logs.filter((l) => /停|断|错误|失败|超时|pause|stall|寄存|迁移|格式|流|干道|MUX|dropped|丢弃/.test(l));
  if (interesting.length) { console.log('--- 隧道日志 ---'); for (const l of interesting.slice(-25)) console.log('  ' + l); }

  fs.writeFileSync(path.join(__dirname, 'steam-integrity-result.json'), JSON.stringify(result, null, 2));
  console.log(`\n=== ${result.pass ? '通过：隧道逐字节一致' : '失败：隧道改变了字节流'} ===`);

  client.destroy();
  await joinManager.stop();
  await hostManager.stop();
  joinManager.shutdown();
  hostManager.shutdown();
  await new Promise((r) => server.close(() => r()));
  process.exit(result.pass ? 0 : 1);
})().catch((err) => { console.log('探针异常：' + String(err && err.stack ? err.stack : err).slice(0, 900)); process.exit(1); });
