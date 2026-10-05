// 用法：node tools/punch-one-shot.cjs host|joiner [对端公网地址:端口]
const dgram = require('node:dgram');
const S = require('../network/direct-udp/stun.cjs');
const P = require('../network/direct-udp/punch.cjs');
const role = process.argv[2] || 'host';
const peerArg = process.argv[3] || '';
const peer = peerArg ? { address: peerArg.split(':')[0], port: Number(peerArg.split(':')[1]) } : null;
(async () => {
  const socket = dgram.createSocket('udp4');
  await new Promise((r) => socket.bind(0, r));
  // 1) STUN 取本机公网映射
  const mapped = await new Promise((resolve) => {
    const { buffer, transactionId } = S.buildBindingRequest();
    const timer = setTimeout(() => resolve(null), 4000);
    socket.on('message', function onMsg(msg) {
      const parsed = S.parseMessage(msg);
      if (!S.matchesTransaction(parsed, transactionId)) return;
      clearTimeout(timer); socket.removeListener('message', onMsg);
      resolve(parsed.xorMapped || parsed.mapped || null);
    });
    socket.send(buffer, 19302, 'stun.l.google.com');
  });
  console.log('本机公网映射 = ' + (mapped ? mapped.address + ':' + mapped.port : '未取到'));
  console.log('本机内网端口 = ' + socket.address().port + '（请把上面这行公网映射发给对端）');
  if (!peer) { console.log('未提供对端候选，只报告映射；拿到对端地址后再跑一次并附上：<公网地址:端口>'); process.exit(0); }
  const puncher = P.createPuncher({ socket, remoteCandidates: [peer], policy: { budgetMs: 20000, intervalMs: 400 } });
  socket.on('message', (msg, rinfo) => puncher.handlePacket(msg, rinfo));
  puncher.start();
  const timer = setInterval(() => {
    const s = puncher.tick();
    if (s.state === 'established') { clearInterval(timer); console.log('打洞结果 = 成功，对端 ' + s.peer.address + ':' + s.peer.port + '，探测 ' + s.attempts + ' 次 / ' + s.elapsedMs + 'ms'); process.exit(0); }
    if (s.state === 'failed') { clearInterval(timer); console.log('打洞结果 = 失败（' + s.reason + '）'); process.exit(0); }
  }, 400);
})();
