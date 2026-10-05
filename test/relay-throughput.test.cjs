'use strict';
// 网络 PHASE 11/12：真实中继链路的吞吐、丢包与内存护栏。
//
// 这些是**回归护栏**而不是跑分：断言放宽到"本机一定过"，用来抓"每包对象爆炸 /
// 统计无上限增长 / 句柄泄漏"这类退化。数字会打印出来，便于人工看趋势。

const test = require('node:test');
const assert = require('node:assert');

const { createRelayServer } = require('../network/relay/server.cjs');
const { createRelayClient } = require('../network/relay/client.cjs');

const TOKEN = 'perf-token';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRelay(options, fn) {
  const server = createRelayServer({ sessionToken: TOKEN, host: '127.0.0.1', ...options });
  const info = await server.start();
  const a = createRelayClient({ serverHost: '127.0.0.1', serverPort: info.port, sessionToken: TOKEN, sessionId: 5 });
  const b = createRelayClient({ serverHost: '127.0.0.1', serverPort: info.port, sessionToken: TOKEN, sessionId: 5 });
  await a.join();
  await b.join();
  try {
    await fn({ server, info, a, b });
  } finally {
    await a.close();
    await b.close();
    await server.stop();
  }
}

test('吞吐护栏：1000 个 512B 包在 8 秒内送达，计数精确、无静默丢弃', async () => {
  await withRelay({ ratePerSec: 0, maxPacketBytes: 1400 }, async ({ server, a, b }) => {
    const total = 1000;
    const size = 512;
    let received = 0;
    let bytes = 0;
    b.onMessage((payload) => { received += 1; bytes += payload.length; });

    const started = Date.now();
    for (let i = 0; i < total; i += 1) {
      a.send(Buffer.alloc(size, i % 251));
      if (i % 100 === 99) await wait(5);          // 让出事件循环，避免发送端压垮接收端
    }
    while (received < total && Date.now() - started < 8000) await wait(20);
    const elapsed = Date.now() - started;

    const stats = server.getStats();
    console.log('  [perf] ' + total + '×' + size + 'B 用时 ' + elapsed + 'ms，收到 ' + received
      + ' 包 / ' + bytes + ' 字节，服务端转发 ' + stats.packetsForwarded + ' 包 / ' + stats.bytesForwarded + ' 字节，'
      + '丢弃 ' + JSON.stringify(stats.dropped));

    assert.equal(received, total, '本机回环不应丢包，实际收到 ' + received);
    assert.equal(a.getStats().packetsToPeer, total, '发送方计数要精确');
    assert.equal(b.getStats().packetsFromPeer, total, '接收方计数要精确');
    assert.equal(stats.dropped.malformed + stats.dropped.oversized + stats.dropped['rate-limited'], 0, '不应有异常丢弃');
    assert.ok(elapsed < 8000, '耗时应远小于 8 秒，实际 ' + elapsed + 'ms');
  });
});

test('内存护栏：3 轮各 800 包后堆增长有限（统计不无上限增长）', async () => {
  await withRelay({}, async ({ a }) => {
    const before = process.memoryUsage().heapUsed;
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < 800; i += 1) {
        a.send(Buffer.alloc(256, 7));
        if (i % 100 === 99) await wait(3);
      }
      await wait(60);
    }
    global.gc && global.gc();
    const growth = (process.memoryUsage().heapUsed - before) / (1024 * 1024);
    console.log('  [perf] 2400 包后堆增长 ' + growth.toFixed(2) + ' MB');
    assert.ok(growth < 24, '堆增长应有限，实际 ' + growth.toFixed(2) + ' MB');
  });
});

test('限速下的稳定性：超限被丢弃且服务端仍保持可用（不排队、不雪崩）', async () => {
  await withRelay({ ratePerSec: 50 }, async ({ server, a, b }) => {
    let received = 0;
    b.onMessage(() => { received += 1; });
    for (let i = 0; i < 600; i += 1) {
      a.send(Buffer.alloc(128, 1));
      if (i % 50 === 49) await wait(10);
    }
    await wait(300);
    const stats = server.getStats();
    console.log('  [perf] 限速 50/s：送达 ' + received + ' 包，丢弃 ' + stats.dropped['rate-limited'] + ' 包');
    assert.ok(stats.dropped['rate-limited'] > 0, '应触发限速丢弃');
    assert.ok(received > 0, '限速不应把链路打死');
    assert.equal(server.getStats().peersActive, 2, '限速后连接仍在');
  });
});

test('大包边界：正好在上限内通过，超上限被丢弃', async () => {
  await withRelay({ maxPacketBytes: 1200 }, async ({ server, a, b }) => {
    let received = 0;
    let maxSeen = 0;
    b.onMessage((p) => { received += 1; maxSeen = Math.max(maxSeen, p.length); });
    a.send(Buffer.alloc(1200 - 9, 3));            // 头 9 字节 + 载荷 = 1200
    await wait(120);
    a.send(Buffer.alloc(1300, 3));
    await wait(120);
    console.log('  [perf] 边界包：送达 ' + received + ' 包，最大载荷 ' + maxSeen + ' 字节，超限丢弃 ' + server.getStats().dropped.oversized);
    assert.equal(received, 1, '上限内的包要过，超限的要丢');
    assert.equal(server.getStats().dropped.oversized, 1);
  });
});
