// 中继服务端健康检查：入会 + 若干轮真实心跳，按结果给出退出码（可用于监控/探活）
//   用法：node tools/relay-health.cjs <主机> <端口> <口令> [心跳次数]
//   退出码：0 正常；1 入会失败；2 心跳全部超时；3 抖动或丢包超阈值
const { createRelayClient } = require('../network/relay/client.cjs');

const host = process.argv[2] || '127.0.0.1';
const port = Number(process.argv[3] || 0);
const token = process.argv[4] || process.env.SHL_RELAY_TOKEN || '';
const pings = Number(process.argv[5] || 5);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!port) { console.log('用法：node tools/relay-health.cjs <主机> <端口> <口令> [心跳次数]'); process.exit(1); }
  if (!token) { console.log('未提供口令：可用第三个参数或环境变量 SHL_RELAY_TOKEN'); process.exit(1); }

  const client = createRelayClient({ serverHost: host, serverPort: port, sessionToken: token, sessionId: 1 });
  const join = await client.join({ timeoutMs: 5000 });
  if (!join.ok) { console.log('健康检查失败：入会未成功 · ' + join.reason); process.exit(1); }
  console.log('入会成功：端点 ID ' + join.peerId + '（' + join.elapsedMs + 'ms）');

  let replies = 0;
  for (let i = 0; i < Math.max(1, pings); i += 1) {
    const out = await client.ping({ timeoutMs: 2000 });
    if (out.ok) replies += 1;
    await wait(120);
  }
  const q = client.getQuality();
  await client.close();

  const loss = q.packetLoss === null ? 1 : q.packetLoss;
  console.log('心跳应答 ' + replies + '/' + pings
    + ' · 中位 RTT ' + q.rtt + 'ms · 最大 ' + q.rttMax + 'ms · 抖动 ' + q.jitter + 'ms · 丢包 ' + (loss * 100).toFixed(1) + '%');
  if (replies === 0) { console.log('健康检查失败：心跳全部超时'); process.exit(2); }
  if (loss > 0.2 || (q.jitter !== null && q.jitter > 100)) { console.log('健康检查告警：抖动或丢包超阈值'); process.exit(3); }
  console.log('健康检查通过');
  process.exit(0);
})();
