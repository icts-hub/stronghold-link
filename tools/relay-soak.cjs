// 长时稳定性压测：持续跑中继流量并周期采样内存/句柄/计数，给出增长趋势
//   用法：node tools/relay-soak.cjs [分钟数] [每秒包数]
// 说明：这是**本机回环**压测，用来发现"每包对象泄漏 / 统计无上限增长 / 句柄不释放"这类退化。
const { createRelayServer } = require('../network/relay/server.cjs');
const { createRelayClient } = require('../network/relay/client.cjs');

const minutes = Number(process.argv[2] || 1);
const rate = Number(process.argv[3] || 400);
const TOKEN = 'soak-token';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function sample() {
  const m = process.memoryUsage();
  let handles = 0;
  try { handles = process._getActiveHandles ? process._getActiveHandles().length : -1; } catch (e) { handles = -1; }
  return { heapMB: m.heapUsed / 1048576, rssMB: m.rss / 1048576, handles };
}

(async () => {
  const server = createRelayServer({ sessionToken: TOKEN, host: '127.0.0.1', port: 0, ratePerSec: 0 });
  const info = await server.start();
  const a = createRelayClient({ serverHost: '127.0.0.1', serverPort: info.port, sessionToken: TOKEN, sessionId: 7 });
  const b = createRelayClient({ serverHost: '127.0.0.1', serverPort: info.port, sessionToken: TOKEN, sessionId: 7 });
  await a.join();
  await b.join();
  let received = 0;
  b.onMessage(() => { received += 1; });

  const first = sample();
  console.log('起点：堆 ' + first.heapMB.toFixed(1) + ' MB，RSS ' + first.rssMB.toFixed(1) + ' MB，句柄 ' + first.handles);
  console.log('计划：' + minutes + ' 分钟，约 ' + rate + ' 包/秒，载荷 256B');

  const started = Date.now();
  let sent = 0;
  let lastReport = 0;
  const samples = [];
  const payload = Buffer.alloc(256, 9);

  while (Date.now() - started < minutes * 60000) {
    for (let i = 0; i < rate / 10; i += 1) { a.send(payload); sent += 1; }
    await wait(100);
    const elapsed = (Date.now() - started) / 1000;
    if (elapsed - lastReport >= 15) {
      lastReport = elapsed;
      const s = sample();
      samples.push({ t: elapsed, ...s, sent, received, dropped: server.getStats().dropped['rate-limited'] });
      console.log('  t=' + elapsed.toFixed(0) + 's  堆 ' + s.heapMB.toFixed(1) + ' MB  RSS ' + s.rssMB.toFixed(1)
        + ' MB  句柄 ' + s.handles + '  发送 ' + sent + '  收到 ' + received);
    }
  }

  const last = sample();
  const stats = server.getStats();
  const mins = Math.max(0.5, (Date.now() - started) / 60000);
  const heapGrowthPerMin = (last.heapMB - first.heapMB) / mins;
  const lossPct = sent === 0 ? 0 : ((sent - received) / sent) * 100;
  console.log('结束：堆 ' + last.heapMB.toFixed(1) + ' MB（增长 ' + heapGrowthPerMin.toFixed(2) + ' MB/分钟）'
    + '，RSS ' + last.rssMB.toFixed(1) + ' MB，句柄 ' + last.handles);
  console.log('流量：发送 ' + sent + ' 包，收到 ' + received + ' 包，收率 ' + (100 - lossPct).toFixed(2) + '%'
    + '，服务端转发 ' + stats.packetsForwarded + ' 包 / ' + stats.bytesForwarded + ' 字节');
  console.log('丢弃：' + JSON.stringify(stats.dropped));
  console.log('结论：' + (heapGrowthPerMin < 0.5 ? '堆增长平稳（<0.5 MB/分钟）' : '堆增长偏快，需要复核：' + heapGrowthPerMin.toFixed(2) + ' MB/分钟'));

  await a.close();
  await b.close();
  await server.stop();
  process.exit(0);
})();
