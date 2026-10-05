// 双机中继验证：一端当服务端，两台机器各自当客户端测真实 RTT
//   机器A：node tools/relay-one-shot.cjs server 40000
//   机器B：node tools/relay-one-shot.cjs client <A的IP> 40000
const { createRelayServer } = require('../network/relay/server.cjs');
const { createRelayClient } = require('../network/relay/client.cjs');

const role = process.argv[2] || 'server';
const arg1 = process.argv[3] || '127.0.0.1';
const arg2 = process.argv[4] || '40000';
const TOKEN = 'manual-test-token';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (role === 'server') {
    const server = createRelayServer({ sessionToken: TOKEN, host: '0.0.0.0', port: Number(arg1) || 40000 });
    const info = await server.start();
    console.log('中继服务端已监听 0.0.0.0:' + info.port);
    console.log('请在另外两台机器上运行： node tools/relay-one-shot.cjs client <本机IP> ' + info.port);
    setInterval(() => {
      const s = server.getStats();
      console.log('  状态：端点 ' + s.peersActive + '，转发 ' + s.packetsForwarded + ' 包 / ' + s.bytesForwarded + ' 字节，丢弃 ' + JSON.stringify(s.dropped));
    }, 10000);
    return;
  }

  const client = createRelayClient({ serverHost: arg1, serverPort: Number(arg2), sessionToken: TOKEN, sessionId: 42 });
  const joined = await client.join({ timeoutMs: 5000 });
  if (!joined.ok) { console.log('入会失败：' + joined.reason); process.exit(1); }
  console.log('已入会：端点 ID ' + joined.peerId + '（耗时 ' + joined.elapsedMs + 'ms）');
  let fromPeer = 0;
  client.onMessage((payload) => { fromPeer += 1; console.log('  收到对端消息：' + payload.toString()); });
  for (let i = 0; i < 10; i += 1) {
    const out = await client.ping({ timeoutMs: 2000 });
    if (!out.ok) { console.log('  心跳 ' + (i + 1) + ' 超时'); continue; }
    console.log('  心跳 ' + (i + 1) + ' RTT ' + out.rttMs + 'ms');
    client.send(Buffer.from('来自端点 ' + joined.peerId + ' 的第 ' + (i + 1) + ' 次消息'));
    await wait(500);
  }
  const q = client.getQuality();
  console.log('真实测量汇总：中位 RTT ' + q.rtt + 'ms · 最小 ' + q.rttMin + 'ms · 最大 ' + q.rttMax + 'ms · 抖动 ' + q.jitter + 'ms · 丢包 ' + (q.packetLoss * 100).toFixed(1) + '% · 样本 ' + q.samples);
  console.log('收到对端消息 ' + fromPeer + ' 条');
  await client.close();
  process.exit(0);
})();
