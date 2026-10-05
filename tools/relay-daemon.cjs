// 常驻运行入口：给 systemd / nssm / pm2 用
// 口令从环境变量 SHL_RELAY_TOKEN 读取；端口从 SHL_RELAY_PORT（默认 40000）
const { createRelayServer } = require('../network/relay/server.cjs');

const token = process.env.SHL_RELAY_TOKEN || '';
const port = Number(process.env.SHL_RELAY_PORT || 40000);
const ratePerSec = Number(process.env.SHL_RELAY_RATE || 300);

if (!token) {
  console.error('缺少 SHL_RELAY_TOKEN：没有口令就成了开放 UDP 代理，拒绝启动');
  process.exit(1);
}

(async () => {
  const server = createRelayServer({
    sessionToken: token,
    host: '0.0.0.0',
    port,
    ratePerSec,
    maxPeersPerSession: 2,
    idleTimeoutMs: 30000,
  });
  const info = await server.start();
  console.log('中继服务端已监听 0.0.0.0:' + info.port + '（限速 ' + ratePerSec + '/s，每会话 2 人，空闲 30 秒逐出）');

  setInterval(() => { server.sweep(); }, 5000);            // 空闲逐出
  setInterval(() => {
    const s = server.getStats();
    console.log(JSON.stringify({ at: new Date().toISOString(), peers: s.peersActive, sessions: s.sessionsActive, forwarded: s.packetsForwarded, bytes: s.bytesForwarded, evicted: s.evicted, dropped: s.dropped }));
  }, 60000);

  const shutdown = async () => { console.log('正在关闭…'); await server.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})();
