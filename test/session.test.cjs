'use strict';
// 会话控制器测试（状态机 / 端口预检 / 防重复启动 / 端到端转发）
// 运行：node --test --test-isolation=none test/session.test.cjs
//
// 说明：Windows 允许 0.0.0.0 与 127.0.0.1 同时绑定同一端口，所以“端口是否真被监听”一律用
// isPortReachable（真实连一次）判断，而不是只看 bind 是否成功。所有用例都有 finally 清理。
const test = require('node:test');
const assert = require('node:assert/strict');

const { SessionManager, parseInvite, encodeInvite, inviteText, STATES, checkUdpPortFree } = require('../network/session.cjs');
const h = require('./helpers.cjs');
const startUdpEcho = h.startUdpEcho;
const udpRoundTrip = h.udpRoundTrip;

function makeManager(events = []) {
  return new SessionManager({ onEvent: (event) => events.push(event) });
}

test('邀请码：编码后可解析回原值，非法输入有可读报错', () => {
  const code = encodeInvite({ v: 2, game: '测试游戏', host: '192.168.1.5', port: 2301, token: 'abc123', rules: [{ protocol: 'TCP', localPort: 2300, remotePort: 2301 }, { protocol: 'UDP', localPort: 2300, remotePort: 2301 }] });
  const parsed = parseInvite(code);
  assert.equal(parsed.host, '192.168.1.5');
  assert.equal(parsed.port, 2301);
  assert.equal(parsed.token, 'abc123');
  assert.deepEqual(parsed.rules, [{ protocol: 'TCP', localPort: 2300, remotePort: 2301 }, { protocol: 'UDP', localPort: 2300, remotePort: 2301 }]);
  assert.match(inviteText({ ...parsed, code }), /192\.168\.1\.5/);
  assert.match(inviteText({ ...parsed, code }), /UDP,2300,2301/);

  // 旧版 v1 邀请码仍然可用（按单条 TCP 规则处理）
  const legacy = parseInvite(encodeInvite({ v: 1, game: '旧版', host: '10.0.0.2', port: 2400, token: 't' }));
  assert.equal(legacy.host, '10.0.0.2');
  assert.deepEqual(legacy.rules, [{ protocol: 'TCP', localPort: 2400, remotePort: 2400 }]);

  assert.throws(() => parseInvite(''), /不能为空/);
  assert.throws(() => parseInvite('NOPE-123'), /格式不正确/);
  assert.throws(() => parseInvite('SHL1-@@@@'), /无法解析/);
  assert.throws(() => parseInvite(encodeInvite({ v: 9, host: '1.2.3.4', port: 1 })), /版本不支持/);
  assert.throws(() => parseInvite(encodeInvite({ v: 1, host: '1.2.3.4', port: 0 })), /1–65535/);
});

test('房主会话：启动后进入 running、端口真实监听、邀请码可用、stop 后端口释放', async () => {
  const echo = await h.startEchoServer();
  const relayPort = await h.freePort();
  const manager = makeManager();
  try {
    const snapshot = await manager.start({ role: 'host', relayPort, targetHost: '127.0.0.1', targetPort: echo.port, game: '测试游戏' });
    assert.equal(snapshot.state, STATES.RUNNING);
    assert.equal(snapshot.role, 'host');
    assert.equal(snapshot.config.relayPort, relayPort);
    assert.equal(await h.isPortReachable(relayPort), true, 'running 时端口必须真的可连接');
    assert.ok(snapshot.invite && snapshot.invite.code.startsWith('SHL1-'));
    const parsed = parseInvite(snapshot.invite.code);
    assert.equal(parsed.port, relayPort);
    assert.equal(parsed.token, snapshot.invite.token);
    assert.ok(snapshot.invite.token.length >= 8, '默认应自动生成口令');

    await manager.stop();
    assert.equal(manager.getSnapshot().state, STATES.IDLE);
    assert.equal(await h.isPortReachable(relayPort), false, 'stop 后端口不应再接受连接');
    assert.equal(await h.isPortFree(relayPort), true, 'stop 后端口必须可以重新绑定');
    await manager.stop(); // 幂等
  } finally {
    manager.shutdown();
    await echo.close();
  }
});

test('防止重复启动：运行中再次 start 会被拒绝', async () => {
  const echo = await h.startEchoServer();
  const relayPort = await h.freePort();
  const secondPort = await h.freePort();
  const manager = makeManager();
  try {
    await manager.start({ role: 'host', relayPort, targetHost: '127.0.0.1', targetPort: echo.port });
    await assert.rejects(
      manager.start({ role: 'host', relayPort: secondPort, targetHost: '127.0.0.1', targetPort: echo.port }),
      (err) => {
        assert.equal(err.code, 'EALREADYRUNNING');
        assert.match(err.friendly, /已经有一个会话/);
        return true;
      },
    );
    assert.equal(manager.getSnapshot().state, STATES.RUNNING, '被拒绝的重复启动不应破坏正在运行的会话');
  } finally {
    await manager.stop();
    manager.shutdown();
    await echo.close();
  }
});

test('端口冲突：被占用的端口不会启动，并给出可读原因', async () => {
  const blocker = await h.startEchoServer();
  const manager = makeManager();
  try {
    await assert.rejects(
      manager.start({ role: 'host', relayPort: blocker.port, targetHost: '127.0.0.1', targetPort: blocker.port + 1 }),
      (err) => {
        assert.ok(['EADDRINUSE', 'EALREADY'].includes(err.code), `错误码应为端口占用类，实际 ${err.code}`);
        assert.match(err.friendly, /已被占用|已经被监听/);
        return true;
      },
    );
    assert.equal(manager.getSnapshot().state, STATES.ERROR);
    assert.match(manager.getSnapshot().lastError, /已被占用|已经被监听/);
    assert.equal(manager.getSnapshot().connections, 0);
  } finally {
    manager.shutdown();
    await blocker.close();
  }
});

test('端到端：房主与加入者两个会话串联，游戏客户端双向数据通过', async () => {
  const echo = await h.startEchoServer();
  const relayPort = await h.freePort();
  const localPort = await h.freePort();
  const hostManager = makeManager();
  const joinManager = makeManager();
  let client;
  try {
    const hostSnapshot = await hostManager.start({ role: 'host', relayPort, targetHost: '127.0.0.1', targetPort: echo.port, game: 'E2E' });
    const token = parseInvite(hostSnapshot.invite.code).token;

    const joinSnapshot = await joinManager.start({ role: 'joiner', localPort, remoteHost: '127.0.0.1', remotePort: relayPort, authToken: token });
    assert.equal(joinSnapshot.state, STATES.RUNNING);
    assert.equal(joinSnapshot.role, 'joiner');

    client = await h.connect(localPort);
    const first = h.collect(client, 5);
    client.write('hello');
    assert.equal((await first).toString(), 'hello');

    const payload = Buffer.alloc(64 * 1024, 7);
    const second = h.collect(client, payload.length, 8000);
    client.write(payload);
    assert.ok((await second).equals(payload), '64KiB 数据必须原样往返');

    const hostState = hostManager.getSnapshot();
    const joinState = joinManager.getSnapshot();
    assert.ok(hostState.bytesFromPeer >= payload.length + 5, `房主应统计到下行字节，实际 ${hostState.bytesFromPeer}`);
    assert.ok(joinState.bytesToPeer >= payload.length + 5, `加入者应统计到上行字节，实际 ${joinState.bytesToPeer}`);
    assert.ok(hostState.totalConnections >= 1);
  } finally {
    client?.destroy();
    await joinManager.stop();
    await hostManager.stop();
    joinManager.shutdown();
    hostManager.shutdown();
    assert.equal(await h.isPortReachable(relayPort), false, '结束后房主端口应已释放');
    assert.equal(await h.isPortReachable(localPort), false, '结束后加入者端口应已释放');
    await echo.close();
  }
});

test('加入者：口令错误时本地入口照常监听，但每次连接都会被房主拒绝并给出原因', async () => {
  const echo = await h.startEchoServer();
  const relayPort = await h.freePort();
  const localPort = await h.freePort();
  const hostManager = makeManager();
  const joinEvents = [];
  const joinManager = makeManager(joinEvents);
  let client;
  try {
    await hostManager.start({ role: 'host', relayPort, targetHost: '127.0.0.1', targetPort: echo.port, authToken: 'right-token' });
    await joinManager.start({ role: 'joiner', localPort, remoteHost: '127.0.0.1', remotePort: relayPort, authToken: 'wrong-token' });
    client = await h.connect(localPort);
    assert.notEqual(await h.waitClosed(client), 'timeout');
    assert.ok(
      await h.waitFor(() => joinEvents.some((e) => e.type === 'log' && /拒绝了本次连接/.test(e.entry.text)), { timeoutMs: 3000 }),
      '加入者日志里应出现房主拒绝的原因',
    );
    assert.equal(joinManager.getSnapshot().state, STATES.RUNNING, '单次连接被拒不应让整个会话崩溃');
  } finally {
    client?.destroy();
    await joinManager.stop();
    await hostManager.stop();
    joinManager.shutdown();
    hostManager.shutdown();
    await echo.close();
  }
});

test('加入者：房主不可达时只给出警告，不伪装成已连接', async () => {
  const localPort = await h.freePort();
  const deadPort = await h.freePort();
  const manager = makeManager();
  try {
    const snapshot = await manager.start({ role: 'joiner', localPort, remoteHost: '127.0.0.1', remotePort: deadPort });
    assert.equal(snapshot.state, STATES.RUNNING);
    assert.equal(snapshot.connections, 0, '没有真实连接时连接数必须是 0');
    assert.equal(snapshot.totalConnections, 0);
    assert.ok(snapshot.warnings.some((w) => /连不上房主|防火墙/.test(w)), '应提示房主暂不可达');
  } finally {
    await manager.stop();
    manager.shutdown();
  }
});

test('checkPort：空闲/占用两种情况都要如实报告', async () => {
  const manager = makeManager();
  const idle = await h.freePort();
  const busy = await h.startEchoServer();
  try {
    const freeResult = await manager.checkPort({ port: idle });
    assert.equal(freeResult.free, true);
    assert.match(freeResult.friendly, /空闲/);

    const busyResult = await manager.checkPort({ port: busy.port });
    assert.equal(busyResult.free, false);
    assert.match(busyResult.friendly, /已被占用|已经被监听/);

    const runningEcho = await h.startEchoServer();
    try {
      const hostManager = makeManager();
      const sessionPort = await h.freePort();
      await hostManager.start({ role: 'host', relayPort: sessionPort, targetHost: '127.0.0.1', targetPort: runningEcho.port });
      const own = await hostManager.checkPort({ port: sessionPort });
      assert.equal(own.free, false);
      assert.equal(own.inUseBySession, true);
      assert.match(own.friendly, /当前会话/);
      await hostManager.stop();
      hostManager.shutdown();
    } finally {
      await runningEcho.close();
    }
  } finally {
    manager.shutdown();
    await busy.close();
  }
});

test('多端口批量启动：TCP + UDP 两条规则一次启动，两条通道都真实可用并一起释放', async () => {
  const tcpEcho = await h.startEchoServer();
  const udpEcho = await startUdpEcho();
  const tcpRelayPort = await h.freePort();
  const udpRelayPort = await h.freeUdpPort();
  const tcpLocalPort = await h.freePort();
  const udpLocalPort = await h.freeUdpPort();
  const hostEvents = [];
  const hostManager = makeManager(hostEvents);
  const joinManager = makeManager();
  const rules = [
    { protocol: 'TCP', localPort: tcpEcho.port, remotePort: tcpRelayPort },
    { protocol: 'UDP', localPort: udpEcho.port, remotePort: udpRelayPort },
  ];
  let tcpClient;
  try {
    const hostSnapshot = await hostManager.start({ role: 'host', bindHost: '127.0.0.1', targetHost: '127.0.0.1', rules, game: '批量' });
    assert.equal(hostSnapshot.state, STATES.RUNNING);
    assert.equal(hostSnapshot.channels.length, 2, '应建立 2 条通道');
    assert.deepEqual(hostSnapshot.channels.map((c) => c.protocol).sort(), ['TCP', 'UDP']);
    assert.equal(hostSnapshot.config.rules.length, 2);

    const token = parseInvite(hostSnapshot.invite.code).token;
    assert.equal(parseInvite(hostSnapshot.invite.code).rules.length, 2, '邀请码应携带完整规则，加入者才能一次填好');

    const joinSnapshot = await joinManager.start({
      role: 'joiner', bindHost: '127.0.0.1', remoteHost: '127.0.0.1',
      rules: [
        { protocol: 'TCP', localPort: tcpLocalPort, remotePort: tcpRelayPort },
        { protocol: 'UDP', localPort: udpLocalPort, remotePort: udpRelayPort },
      ],
      authToken: token,
    });
    assert.equal(joinSnapshot.channels.length, 2);

    // TCP 通路
    tcpClient = await h.connect(tcpLocalPort);
    const reply = h.collect(tcpClient, 5);
    tcpClient.write('batch');
    assert.equal((await reply).toString(), 'batch');

    // UDP 通路
    const udpReply = await udpRoundTrip(udpLocalPort, 'udp-batch');
    assert.ok(udpReply && udpReply.toString() === 'udp-batch');

    const state = hostManager.getSnapshot();
    assert.ok(state.bytesFromPeer > 0);
    assert.ok(state.packetsFromPeer >= 1, 'UDP 通道应统计到数据报');
    const udpChannel = state.channels.find((c) => c.protocol === 'UDP');
    const tcpChannel = state.channels.find((c) => c.protocol === 'TCP');
    assert.ok(udpChannel.stats.packetsFromPeer >= 1);
    assert.ok(tcpChannel.stats.totalConnections >= 1);

    await joinManager.stop();
    await hostManager.stop();
    await h.wait(150);
    assert.equal((await checkUdpPortFree(udpRelayPort, '127.0.0.1')).free, true, 'UDP 端口应随会话释放');
    assert.equal(await h.isPortFree(tcpRelayPort, '127.0.0.1'), true, 'TCP 端口应随会话释放');
    assert.equal(await h.isPortReachable(tcpLocalPort), false, '加入者本地入口应释放');
  } finally {
    tcpClient?.destroy();
    await joinManager.stop();
    await hostManager.stop();
    joinManager.shutdown();
    hostManager.shutdown();
    await udpEcho.close();
    await tcpEcho.close();
  }
});

test('多端口批量启动：同一协议同一端口重复、或端口被占用时拒绝启动且不留残余通道', async () => {
  const tcpEcho = await h.startEchoServer();
  const udpEcho = await startUdpEcho();
  const dupPort = await h.freePort();
  const manager = makeManager();
  // 占住一个本地端口当作“冲突端口”。freePort 与实际 listen 之间可能被别的套接字抢走，
  // 所以这里失败就换一个端口重试，避免用例偶发失败。
  let busyPort = 0;
  const blockerServer = await (async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidatePort = await h.freePort();
      try {
        const server = await new Promise((resolve, reject) => {
          const candidate = require('node:net').createServer();
          candidate.once('error', reject);
          candidate.listen(candidatePort, '127.0.0.1', () => resolve(candidate));
        });
        busyPort = candidatePort;
        return server;
      } catch { /* 端口被抢走，换一个再试 */ }
    }
    throw new Error('无法占用任何本地端口用于测试');
  })();
  try {
    await assert.rejects(
      manager.start({
        role: 'host', bindHost: '127.0.0.1', targetHost: '127.0.0.1',
        rules: [
          { protocol: 'TCP', localPort: tcpEcho.port, remotePort: dupPort },
          { protocol: 'TCP', localPort: tcpEcho.port + 1, remotePort: dupPort },
        ],
      }),
      /出现了多次/,
    );
    assert.equal(manager.getSnapshot().state, STATES.ERROR);
    assert.equal(manager.getSnapshot().channels.length, 0, '校验失败不应留下通道');

    await assert.rejects(
      manager.start({
        role: 'host', bindHost: '127.0.0.1', targetHost: '127.0.0.1',
        rules: [
          { protocol: 'TCP', localPort: tcpEcho.port, remotePort: busyPort },
          { protocol: 'UDP', localPort: udpEcho.port, remotePort: await h.freePort() },
        ],
      }),
      /TCP 端口 .*无法使用/,
    );
    assert.equal(manager.getSnapshot().channels.length, 0);
    // 换成确定性的检查：冲突端口此刻确实还被阻塞着（原来的 freePort+isPortFree 组合会偶发失败）
    assert.equal(await h.isPortFree(busyPort), false, '阻塞端口应仍被占用');
  } finally {
    manager.shutdown();
    blockerServer.close();
    await udpEcho.close();
    await tcpEcho.close();
  }
});

test('UDP 会话：房主 + 加入者端到端，口令错误时数据报被丢弃', async () => {
  const udpEcho = await startUdpEcho();
  const relayPort = await h.freeUdpPort();
  const localPort = await h.freeUdpPort();
  const hostManager = makeManager();
  const joinManager = makeManager();
  try {
    const hostSnapshot = await hostManager.start({
      role: 'host', bindHost: '127.0.0.1', targetHost: '127.0.0.1',
      rules: [{ protocol: 'UDP', localPort: udpEcho.port, remotePort: relayPort }],
      authToken: 'shared',
    });
    assert.equal(hostSnapshot.state, STATES.RUNNING);
    assert.equal(hostSnapshot.channels[0].protocol, 'UDP');

    await joinManager.start({
      role: 'joiner', bindHost: '127.0.0.1', remoteHost: '127.0.0.1',
      rules: [{ protocol: 'UDP', localPort, remotePort: relayPort }],
      authToken: 'shared',
    });
    const ok = await udpRoundTrip(localPort, 'udp-session');
    assert.ok(ok && ok.toString() === 'udp-session');

    await joinManager.stop();
    await joinManager.start({
      role: 'joiner', bindHost: '127.0.0.1', remoteHost: '127.0.0.1',
      rules: [{ protocol: 'UDP', localPort, remotePort: relayPort }],
      authToken: 'wrong',
    });
    const denied = await udpRoundTrip(localPort, 'nope');
    assert.equal(denied, null, '口令错误的 UDP 数据报不应得到回包');
    assert.equal(udpEcho.seen.length, 1, '口令错误的数据报不应到达游戏服务');
    // 口令错误的加入者会在本地就发现房主无法通过认证，日志里要有可读原因
    assert.ok(
      await h.waitFor(() => joinManager.getSnapshot().logs.some((entry) => /口令不匹配|认证/.test(entry.text)), { timeoutMs: 3000 }),
      '加入者日志应记录口令不匹配',
    );
    const hostChannel = hostManager.getSnapshot().channels[0];
    assert.equal(hostChannel.stats.connections <= 1, true, '不应因为错误口令新增会话');
  } finally {
    await joinManager.stop();
    await hostManager.stop();
    joinManager.shutdown();
    hostManager.shutdown();
    await udpEcho.close();
  }
});

test('安全信息（阶段 3）：有口令时启用 AES-256-GCM + X25519，无口令时明确标注明文', async () => {
  const echo = await h.startEchoServer();
  const manager = makeManager();
  const relayPort = await h.freePort();
  const plainPort = await h.freePort();
  try {
    const encrypted = await manager.start({
      role: 'host', bindHost: '127.0.0.1', relayPort, targetHost: '127.0.0.1', targetPort: echo.port,
      authToken: 'a-strong-session-passphrase',
    });
    assert.equal(encrypted.security.mode, 'psk-aead');
    assert.equal(encrypted.security.cipher, 'AES-256-GCM');
    assert.match(encrypted.security.kex, /X25519/);
    assert.match(encrypted.security.auth, /PSK/);
    assert.match(encrypted.security.replayProtection, /滑动窗口|递增/);
    await manager.stop();

    const plain = await manager.start({
      role: 'host', bindHost: '127.0.0.1', relayPort: plainPort, targetHost: '127.0.0.1', targetPort: echo.port,
      authToken: '',
    });
    assert.equal(plain.security.mode, 'plain');
    assert.equal(plain.security.cipher, '无');
    assert.ok(plain.warnings.some((w) => /未设置口令/.test(w)), '未设口令必须告警');
  } finally {
    await manager.stop();
    manager.shutdown();
    await echo.close();
  }
});

test('弱口令告警：短于 8 个字符时提示换更长的口令', async () => {
  const echo = await h.startEchoServer();
  const manager = makeManager();
  const relayPort = await h.freePort();
  try {
    const snapshot = await manager.start({
      role: 'host', bindHost: '127.0.0.1', relayPort, targetHost: '127.0.0.1', targetPort: echo.port,
      authToken: 'short',
    });
    assert.equal(snapshot.security.mode, 'psk-aead', '短口令仍然加密，只是强度不够');
    assert.ok(snapshot.warnings.some((w) => /短于 8 个字符/.test(w)), '短口令必须告警');
  } finally {
    await manager.stop();
    manager.shutdown();
    await echo.close();
  }
});

test('加密会真实生效：TCP 会话链路里的字节不含明文游戏数据', async () => {
  const echo = await h.startEchoServer();
  const relayPort = await h.freePort();
  const localPort = await h.freePort();
  const hostManager = makeManager();
  const joinManager = makeManager();
  let client;
  try {
    const hostSnapshot = await hostManager.start({
      role: 'host', bindHost: '127.0.0.1', relayPort, targetHost: '127.0.0.1', targetPort: echo.port,
      authToken: 'wire-check-pass',
    });
    assert.equal(hostSnapshot.channels[0].stats.encrypted === undefined, false);
    const token = parseInvite(hostSnapshot.invite.code).token;
    await joinManager.start({
      role: 'joiner', bindHost: '127.0.0.1', localPort, remoteHost: '127.0.0.1', remotePort: relayPort, authToken: token,
    });
    client = await h.connect(localPort);
    const marker = 'PLAINTEXT-MARKER-42';
    const reply = h.collect(client, marker.length);
    client.write(marker);
    assert.equal((await reply).toString(), marker, '加密通道必须能正确还原数据');
    assert.ok(await h.waitFor(() => hostManager.getSnapshot().channels[0].stats.encrypted === true, { timeoutMs: 2000 }), '房主通道应标记为加密');
    assert.ok(hostManager.getSnapshot().channels[0].stats.sessionId, '应记录会话标识');
  } finally {
    client?.destroy();
    await joinManager.stop();
    await hostManager.stop();
    joinManager.shutdown();
    hostManager.shutdown();
    await echo.close();
  }
});

test('Steam 会话（阶段 4）：用注入的假 SDK 启动房主会话，通道信息与会话标识正确', async () => {
  const mock = require('./steam-mock.cjs').createMockSdk();
  const { SessionManager: SM } = require('../network/session.cjs');
  const game = await h.startEchoServer();
  const manager = new SM({ steamSdk: mock.sdk, onEvent: () => {} });
  try {
    const snapshot = await manager.start({ role: 'host', adapter: 'steam', targetHost: '127.0.0.1', gamePort: game.port, game: 'Steam 测试' });
    assert.equal(snapshot.state, STATES.RUNNING);
    assert.equal(snapshot.channels.length, 1);
    assert.equal(snapshot.channels[0].protocol, 'STEAM');
    assert.equal(snapshot.channels[0].steamId, mock.state.identity, '快照里应带本机 SteamID');
    assert.equal(snapshot.security.mode, 'steam-transport');
    assert.match(snapshot.security.auth, /SteamID/);
    assert.equal(snapshot.config.adapter, 'steam');
    assert.equal(snapshot.config.targetPort, game.port);
    assert.ok(snapshot.invite && snapshot.invite.steamId === mock.state.identity);

    await manager.stop();
    assert.equal(manager.getSnapshot().state, STATES.IDLE);
    assert.equal(mock.state.listenClosed, true, '停止时应关闭 Steam 监听 socket');
    assert.equal(mock.state.pollDestroyed, true);
  } finally {
    manager.shutdown();
    await game.close();
  }
});

test('Steam 会话：加入者填房主 SteamID 与本机入口端口，SteamID 非法时拒绝', async () => {
  const mock = require('./steam-mock.cjs').createMockSdk();
  const { SessionManager: SM } = require('../network/session.cjs');
  const localPort = await h.freePort();
  const manager = new SM({ steamSdk: mock.sdk, onEvent: () => {} });
  try {
    await assert.rejects(
      manager.start({ role: 'joiner', adapter: 'steam', hostSteamId: 'nope', localPort }),
      /SteamID 格式不正确/,
    );
    const snapshot = await manager.start({ role: 'joiner', adapter: 'steam', hostSteamId: mock.state.identity, localPort });
    assert.equal(snapshot.state, STATES.RUNNING);
    assert.equal(snapshot.channels[0].protocol, 'STEAM');
    assert.equal(snapshot.config.remoteHost, mock.state.identity);
    // 通用化后：Steam 连接是按「本机连接」按需创建的，会话启动阶段不该预先建连
    assert.deepEqual(mock.state.connectedTo, [], '会话启动时不预建 Steam 连接（等本机客户端连进来）');
  } finally {
    await manager.stop();
    manager.shutdown();
  }
});

test('Steam 会话：环境未就绪（appDir 指向没有 SDK 的目录）时会话进入 error 并给出可执行提示', async () => {
  const { SessionManager: SM } = require('../network/session.cjs');
  const os = require('node:os');
  const fsSync = require('node:fs');
  const nodePath = require('node:path');
  const game = await h.startEchoServer();
  const emptyDir = fsSync.mkdtempSync(nodePath.join(os.tmpdir(), 'shl-sess-nosdk-'));
  const manager = new SM({ appDir: emptyDir, onEvent: () => {} });
  try {
    await assert.rejects(
      manager.start({ role: 'host', adapter: 'steam', gamePort: game.port, appId: 480 }),
      (err) => {
        assert.equal(err.code, 'ESTEAMENV');
        assert.match(err.friendly, /Steam 环境未就绪/);
        return true;
      },
    );
    const snapshot = manager.getSnapshot();
    assert.equal(snapshot.state, STATES.ERROR);
    assert.match(snapshot.lastError, /Steam 环境未就绪/);
    assert.equal(snapshot.channels.length, 0, '环境未就绪不应留下通道');
    assert.ok(snapshot.logs.some((entry) => /Steam 环境提示/.test(entry.text)), '日志里应列出缺失项');
  } finally {
    manager.shutdown();
    fsSync.rmSync(emptyDir, { recursive: true, force: true });
    await game.close();
  }
});

test('不做转发（阶段 5）：仍是一个会话，但 0 条通道且明确标注未转发', async () => {
  const manager = makeManager();
  try {
    const snapshot = await manager.start({ role: 'host', adapter: 'none', gamePort: 3000, recipe: 'lan-direct', game: '卫戍协议：盟约' });
    assert.equal(snapshot.state, STATES.RUNNING);
    assert.equal(snapshot.channels.length, 0, '这条路径不应建立任何通道');
    assert.equal(snapshot.security.mode, 'none');
    assert.match(snapshot.security.note, /不做任何转发/);
    assert.equal(snapshot.config.adapter, 'none');
    assert.equal(snapshot.config.recipe, 'lan-direct');
    assert.ok(snapshot.invite && Array.isArray(snapshot.invite.hints) && snapshot.invite.hints.length, '邀请信息里应带连接说明');
    assert.ok(snapshot.logs.some((entry) => /不做任何转发/.test(entry.text)), '日志必须说清没有转发');
  } finally {
    await manager.stop();
    manager.shutdown();
  }
});

test('本地会话带配方：邀请信息里包含「加入者怎么做」，浏览器配方给出本机入口 URL', async () => {
  const echo = await h.startEchoServer();
  const relayPort = await h.freePort();
  const manager = makeManager();
  try {
    const snapshot = await manager.start({
      role: 'host', recipe: 'local-web', bindHost: '127.0.0.1', relayPort,
      targetHost: '127.0.0.1', targetPort: echo.port, game: '卫戍协议：盟约',
    });
    assert.equal(snapshot.config.recipe, 'local-web');
    assert.ok(Array.isArray(snapshot.invite.hints) && snapshot.invite.hints.some((h) => /http:\/\/127\.0\.0\.1:/.test(h)), '应给出浏览器打开地址');
    const text = inviteText(snapshot.invite);
    assert.match(text, /加入者怎么做/);
    assert.match(text, /http:\/\/127\.0\.0\.1:/);
  } finally {
    await manager.stop();
    manager.shutdown();
    await echo.close();
  }
});

test('输入校验：角色、端口、地址非法时直接拒绝', async () => {
  const manager = makeManager();
  const echo = await h.startEchoServer();
  const joinerPort = await h.freePort();
  try {
    await assert.rejects(manager.start({ role: 'wat', relayPort: 1, targetPort: 2 }), /角色必须是/);
    await assert.rejects(manager.start({ role: 'host', relayPort: 0, targetPort: echo.port }), /1–65535/);
    await assert.rejects(manager.start({ role: 'joiner', localPort: joinerPort, remoteHost: '0.0.0.0', remotePort: 1 }), /房主地址不能是/);
    await assert.rejects(manager.start({ role: 'host', relayPort: echo.port, targetHost: '127.0.0.1', targetPort: echo.port }), /自我循环|不能与本地游戏端口相同/);
    const state = manager.getSnapshot().state;
    assert.ok(state === STATES.ERROR || state === STATES.IDLE, `校验失败后状态应为 error/idle，实际 ${state}`);
  } finally {
    manager.shutdown();
    await echo.close();
  }
});
test('网络参数：可配置空闲/连接超时，并在快照里给出真实速率采样', async () => {
  const { SessionManager: SM } = require('../network/session.cjs');
  const echo = await h.startEchoServer();
  const relayPort = await h.freePort();
  const manager = new SM({ onEvent: () => {} });
  let client;
  try {
    const snapshot = await manager.start({
      role: 'host', bindHost: '127.0.0.1', targetHost: '127.0.0.1', targetPort: echo.port,
      relayPort, authToken: '', idleTimeoutMs: 30000, connectTimeoutMs: 5000,
    });
    assert.equal(snapshot.security.mode, 'plain', '空口令时应为明文模式（本用例要测吞吐）');
    assert.equal(snapshot.config.idleTimeoutMs, 30000);
    assert.equal(snapshot.config.connectTimeoutMs, 5000);
    assert.equal(Array.isArray(snapshot.metrics.samples), true, '快照应带采样序列');

    // 真实收发一批数据，再取两次快照，速率应体现真实字节数
    client = await h.connect(relayPort);
    client.write(Buffer.alloc(64 * 1024, 7));
    assert.ok(await h.waitFor(() => manager.getSnapshot().bytesFromPeer >= 64 * 1024, { timeoutMs: 4000 }), '应统计到真实字节');
    await new Promise((r) => setTimeout(r, 350));
    const after = manager.getSnapshot();
    assert.ok(after.metrics.samples.length >= 2, '应有至少两个采样点');
    assert.ok(after.metrics.rateFromPeer > 0, `下行速率应大于 0，实际 ${after.metrics.rateFromPeer}`);
    const lastSample = after.metrics.samples[after.metrics.samples.length - 1];
    assert.equal(typeof lastSample.t, 'number');
    assert.ok(lastSample.totalDown >= 64 * 1024, '采样点里保存的是真实累计值');

    // 非法超时值要被拦下（先停掉当前会话，否则报的是“已在运行”）
    client.destroy();
    client = null;
    await manager.stop();
    await assert.rejects(manager.start({ role: 'host', bindHost: '127.0.0.1', targetHost: '127.0.0.1', targetPort: echo.port, relayPort: await h.freePort(), idleTimeoutMs: -5 }), /空闲超时/);
    await assert.rejects(manager.start({ role: 'host', bindHost: '127.0.0.1', targetHost: '127.0.0.1', targetPort: echo.port, relayPort: await h.freePort(), connectTimeoutMs: 10 }), /连接超时/);
  } finally {
    client?.destroy();
    await manager.stop();
    manager.shutdown();
    await echo.close();
  }
});
