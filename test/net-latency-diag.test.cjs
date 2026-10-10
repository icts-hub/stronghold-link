'use strict';
// 每秒网络延迟诊断（延迟专项 Phase 1，用户 m13114）单测。
// 这个模块是"体感变慢"能不能被证伪的唯一依据，所以测试盯四件事：
//   1. Steam 真实读数（ping / pendingReliable / sentUnackedReliable / usecQueueTime）必须进样本 ——
//      用户点名要的几项就是这几项；
//   2. 拿不到的读数**必须是 null + UNAVAILABLE**，绝不许编一个数出来（这是本仓库的老规矩，
//      见 network-health.cjs / steam-adapter.cjs:2798 那句"宁可让界面显示—"）；
//   3. 必须复用适配器那唯一一个调度器（规格 §十八），注入之后不许自己再起 setInterval；
//   4. 没有 logDir 就绝不写文件（单测与探针不该往仓库里丢样本）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createNetLatencyDiag, parseDetailedStatus, usecToMs, DEFAULT_INTERVAL_MS,
} = require('../network/net-latency-diag.cjs');

/** 真的从探针输出里抄回来的形状（tools/steam-api-surface-probe.cjs）。 */
const DETAILED_TEXT = [
  'Current rates:',
  '    Ping:7ms    Max latency variance: ???ms',
  '    Bytes buffered: 0',
  'Lifetime stats:',
  '    Dropped   :          1 pkts  50.00%',
  '    OutOfOrder:          0 pkts   0.00%',
  '    OOOFixed  :          0 pkts   0.00%',
  '    Duplicate :          0 pkts   0.00%',
  '    SeqLurch  :          0 pkts   0.00%',
  '    Totals',
  '        Sent:       12 pkts       3456 bytes',
  '        Recv:        9 pkts       1234 bytes',
].join('\n');

/** 只实现本模块真正调用的那两个方法；realtime 按连接给不同值以便验证"取最差"。 */
function fakeSockets(realtimeOf, detailed = DETAILED_TEXT) {
  return {
    getConnectionRealTimeStatus: (connection) => realtimeOf(connection),
    getDetailedConnectionStatus: () => detailed,
  };
}

const REALTIME_A = {
  ping: 30,
  connectionQualityLocal: 1,
  connectionQualityRemote: 0.5,
  pendingReliable: 111,
  sentUnackedReliable: 222,
  pendingUnreliable: 0,
  usecQueueTime: 3500n,
  outBytesPerSec: 10,
  inBytesPerSec: 20,
  outPacketsPerSec: 1,
  inPacketsPerSec: 2,
  sendRateBytesPerSecond: 104857600,
};

test('★ Steam 真实读数必须进样本：RTT 取最差，可靠待发 / 未确认 / 排队时间都要有', () => {
  const diag = createNetLatencyDiag({
    role: 'joiner',
    now: () => 100000,
    monitorLoop: false,
    sockets: () => fakeSockets((c) => (c === 'c2' ? { ...REALTIME_A, ping: 88 } : REALTIME_A)),
    connections: () => [
      { connection: 'c1', label: 'peer-a' },
      { connection: 'c2', label: 'peer-b' },
    ],
  });
  const frame = diag.sample();

  assert.equal(frame.steamRttMs, 88, '多干道要取最差的那条 RTT，不是平均值');
  assert.equal(frame.steamConnections.length, 2);
  const [a] = frame.steamConnections;
  assert.equal(a.label, 'peer-a');
  assert.equal(a.rttMs, 30);
  assert.equal(a.pendingReliable, 111);
  assert.equal(a.sentUnackedReliable, 222);
  assert.equal(a.queueMs, 3.5, 'usecQueueTime 是 bigint 微秒，要换算成毫秒');
  assert.equal(a.sendRateBytesPerSecond, 104857600);
  // 丢包/乱序只能从 getDetailedConnectionStatus 那段文本里解析。
  assert.equal(a.pingMs, 7);
  assert.equal(a.droppedPackets, 1);
  assert.equal(a.outOfOrderPackets, 0);
  assert.equal(a.bytesBuffered, 0);

  const snap = diag.snapshot();
  assert.equal(snap.available, true);
  assert.equal(snap.steamPendingReliable, 111);
  assert.equal(snap.steamSentUnackedReliable, 222);
  assert.equal(snap.steamQueueMs, 3.5);
  diag.dispose();
});

test('★ 拿不到的读数必须是 null + UNAVAILABLE，绝不许编一个数出来', () => {
  const diag = createNetLatencyDiag({
    role: 'host',
    now: () => 1000,
    monitorLoop: false,
    // 老绑定 / 探针环境下这两个方法可能没有：不许因此编造 0。
    sockets: () => ({}),
    connections: () => [{ connection: 'c1', label: 'peer-a' }],
  });
  const frame = diag.sample();

  assert.equal(frame.steamRttMs, null);
  assert.equal(frame.steamConnections[0].rttMs, null);
  assert.equal(frame.steamConnections[0].pendingReliable, null);
  assert.ok(frame.unavailable.some((s) => s.startsWith('rttMs')), '没测到就要在 unavailable 里点名');

  // 活路径只应答 Pong、从不发 Ping ⇒ MUX RTT 没有样本，永远只能是 UNAVAILABLE。
  assert.equal(diag.snapshot().muxRttMs, null);
  assert.ok(frame.unavailable.some((s) => s.includes('Ping')), 'MUX RTT 没样本的原因要写明');
  assert.match(frame.line, /MUX-RTT=UNAVAILABLE/);
  assert.match(frame.line, /网络RTT=UNAVAILABLE/);
  diag.dispose();
});

test('★ 必须复用适配器那唯一一个调度器（规格 §十八），注入之后不许自己起计时器', () => {
  const calls = [];
  const scheduler = {
    every: (key, ms) => { calls.push(['every', key, ms]); },
    cancel: (key) => { calls.push(['cancel', key]); },
  };

  const realSetInterval = global.setInterval;
  let ownTimers = 0;
  global.setInterval = (...args) => { ownTimers += 1; return realSetInterval(...args); };
  try {
    const diag = createNetLatencyDiag({ now: () => 1000, monitorLoop: false, scheduler });
    assert.equal(diag.start(), true);
    assert.deepEqual(calls[0], ['every', 'net-latency', DEFAULT_INTERVAL_MS]);
    assert.equal(ownTimers, 0, '注入了调度器就不许再自己 setInterval（会变成第二个调度器）');
    assert.equal(diag.running, true);
    diag.stop();
    assert.deepEqual(calls[1], ['cancel', 'net-latency']);
    assert.equal(diag.running, false);

    // 没有调度器的场合（单测 / 探针）才退回自己的计时器，并且 stop 要能收干净。
    const solo = createNetLatencyDiag({ now: () => 1000, monitorLoop: false });
    solo.start();
    assert.equal(ownTimers, 1);
    solo.stop();
    assert.equal(solo.running, false);
  } finally {
    global.setInterval = realSetInterval;
  }
});

test('★ 排队字节与最老等待时间：只有记了入队时刻（peer.outAt）才算得出等待时间', () => {
  const t0 = 50000;
  let t = t0;
  const stream = {
    id: 2,
    connected: true,
    queue: [Buffer.alloc(100)],
    socket: { writableLength: 4096 },
    remoteCredit: 1048576,
    bytesToPeer: 10,
    bytesFromPeer: 20,
  };
  const peer = {
    steamId: 'peer-a',
    outAt: t0,
    paused: false,
    stalled: false,
    frames: 7,
    framed: true,
    streams: new Map([[2, stream]]),
  };
  const diag = createNetLatencyDiag({
    role: 'host',
    now: () => t,
    monitorLoop: false,
    sockets: () => ({}),
    peers: () => new Map([['peer-a', peer]]),
    peerLabel: (p) => p.steamId,
    peerOutBytes: () => 2048,
    streamsOf: (p) => p.streams,
  });

  const first = diag.sample();
  assert.equal(first.globalQueueBytes, 2048);
  assert.equal(first.oldestQueuedMs, 0);
  assert.equal(first.peers[0].label, 'peer-a');

  t = t0 + 250;
  const second = diag.sample();
  assert.equal(second.oldestQueuedMs, 250, '这一批积压已经等了 250ms');
  assert.equal(second.streamQueueBytes, 100);
  assert.equal(second.tcpWritableLength, 4096);
  assert.equal(second.streams[0].stream, 2);
  assert.equal(second.streams[0].writableLength, 4096);

  // 有字节但没记入队时刻 ⇒ 算不出等待时间，只能标 UNAVAILABLE（哪怕它是 0 也不许填）。
  delete peer.outAt;
  const third = diag.sample();
  assert.equal(third.oldestQueuedMs, null);
  assert.ok(third.unavailable.some((s) => s.startsWith('oldestQueuedMs')));

  // 反过来：**队列本来就是空的**时，"最老的等待"是 0，不许报 UNAVAILABLE ——
  // 那会让人以为是"读不出来"，而不是"没有积压"（真机第一次跑就是这样被误读的）。
  const idle = createNetLatencyDiag({
    role: 'host',
    now: () => t,
    monitorLoop: false,
    sockets: () => ({}),
    peers: () => new Map(),
    peerLabel: () => '?',
  });
  const idleFrame = idle.sample();
  assert.equal(idleFrame.globalQueueBytes, 0);
  assert.equal(idleFrame.oldestQueuedMs, null, '空队列本来就算不出等待时间');
  assert.match(idleFrame.line, /最老=0ms\(空闲\)/);
  idle.dispose();
  diag.dispose();
});

test('★ 事件循环延迟：默认开着（perf_hooks），关掉时必须给出原因', () => {
  const on = createNetLatencyDiag({ now: () => 1, sockets: () => ({}) });
  const frame = on.sample();
  assert.equal(frame.eventLoop.available, true);
  assert.equal(typeof frame.eventLoop.p50Ms, 'number');
  assert.equal(typeof frame.eventLoop.p99Ms, 'number');
  // 直方图的 resolution 在 Node 24 上读不到（实测 undefined），所以只报**配置值**，
  // 并附带"这台机器的地板"说明 —— 不许拿 NaN 冒充读数。
  assert.equal(frame.eventLoop.configuredResolutionMs, 10);
  assert.match(frame.eventLoop.floorNote, /15\.6/);
  assert.equal(frame.eventLoop.resolutionMs, undefined);
  on.dispose();

  const off = createNetLatencyDiag({ now: () => 1, monitorLoop: false, sockets: () => ({}) });
  const dark = off.sample();
  assert.equal(dark.eventLoop.available, false);
  assert.match(dark.eventLoop.reason, /monitorEventLoopDelay/);
  off.dispose();
});

test('★ 没有 logDir 绝不写文件；给了 logDir 就一帧一行 JSONL', async () => {
  const quiet = createNetLatencyDiag({ now: () => 1234, monitorLoop: false, sockets: () => ({}) });
  quiet.sample();
  assert.equal(quiet.stats.filePath, null, '没给 logDir 就不该产出任何文件');
  quiet.dispose();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shl-latency-'));
  try {
    const diag = createNetLatencyDiag({
      role: 'host', now: () => 1700000000000, monitorLoop: false, sockets: () => ({}), logDir: dir,
    });
    assert.equal(diag.start(), true); // start 会立刻先采一帧
    diag.sample();
    diag.dispose();

    // createWriteStream 是**异步**打开文件的：dispose() 之后文件不一定已经落盘，
    // 所以要等一小会儿（最多 2 秒）再读 —— 直接把"还没建好"当成"没写"会误判。
    let files = [];
    for (let i = 0; i < 40; i += 1) {
      files = fs.readdirSync(dir).filter((n) => n.startsWith('net-latency-host-'));
      if (files.length && fs.statSync(path.join(dir, files[0])).size > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(files.length, 1);
    const text = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    const lines = text.trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.role, 'host');
    assert.equal(first.seq, 1);
    assert.equal(JSON.parse(lines[1]).seq, 2);
    assert.ok(Array.isArray(first.unavailable));
    assert.equal(typeof first.line, 'string');
    assert.equal(diag.stats.fileWrites >= 2, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseDetailedStatus 解析 Steam 原文；解析不出来就 null', () => {
  const parsed = parseDetailedStatus(DETAILED_TEXT);
  assert.equal(parsed.pingMs, 7);
  assert.equal(parsed.maxLatencyVarianceMs, null, '??? 就是没测出来，不许当成 0');
  assert.equal(parsed.bytesBuffered, 0);
  assert.equal(parsed.droppedPackets, 1);
  assert.equal(parsed.outOfOrderPackets, 0);
  assert.equal(parsed.sentPackets, 12);
  assert.equal(parsed.sentBytes, 3456);
  assert.equal(parsed.recvPackets, 9);
  assert.equal(parsed.recvBytes, 1234);

  assert.equal(parseDetailedStatus(''), null);
  assert.equal(parseDetailedStatus(null), null);
  assert.equal(parseDetailedStatus(123), null);
  const empty = parseDetailedStatus('nothing useful here');
  assert.equal(empty.pingMs, null);
  assert.equal(empty.droppedPackets, null);
});

test('usecToMs 认 bigint / number，其它一律 null', () => {
  assert.equal(usecToMs(3500n), 3.5);
  assert.equal(usecToMs(2000), 2);
  assert.equal(usecToMs(0n), 0);
  assert.equal(usecToMs(null), null);
  assert.equal(usecToMs(undefined), null);
  assert.equal(usecToMs('3500'), 3.5);
  assert.equal(usecToMs('abc'), null);
});

test('recordPoll / recordServe：每轮收包与本地服务处理的耗时都要记账', () => {
  const diag = createNetLatencyDiag({ now: () => 9000, monitorLoop: false, sockets: () => ({}) });
  diag.recordPoll({ ms: 1, messages: 10 });
  diag.recordPoll({ ms: 2, messages: 20 });
  diag.recordPoll({ ms: 3, messages: 30 });
  diag.recordServe({ ms: 0.5, bytes: 100 });
  diag.recordServe({ ms: 1.5, bytes: 200 });
  diag.recordPoll({ ms: 'nonsense' }); // 脏数据不许污染统计

  const frame = diag.sample();
  assert.equal(frame.poll.count, 3);
  assert.equal(frame.poll.maxMs, 3);
  assert.equal(frame.poll.lastMs, 3);
  assert.equal(frame.poll.totalMessages, 60);
  assert.equal(frame.poll.avgMs, 2);
  assert.equal(frame.serve.count, 2);
  assert.equal(frame.serve.maxMs, 1.5);
  assert.equal(frame.serve.totalBytes, 300);

  const snap = diag.snapshot();
  assert.equal(snap.pollMaxMs, 3);
  assert.equal(snap.serveAvgMs, 1);
  diag.dispose();
});

test('★ 一帧文本里要同时看得到"网络 RTT / 我们排队 / Node"三段，好让人一眼分流', () => {
  const diag = createNetLatencyDiag({
    role: 'host',
    now: () => 1000,
    monitorLoop: false,
    sockets: () => fakeSockets(() => REALTIME_A),
    connections: () => [{ connection: 'c1', label: 'peer-a' }],
  });
  const { line } = diag.sample();
  assert.match(line, /^\[LT\] host up=0s/);
  assert.match(line, /网络RTT=30ms/);
  assert.match(line, /可靠待发=111/);
  assert.match(line, /未确认=222/);
  assert.match(line, /Steam排队=3.5ms/);
  assert.match(line, /本地TCP writable=/);
  assert.match(line, /Node 事件循环=/);
  assert.match(line, /收包分发=/);
  assert.match(line, /服务处理=/);
  diag.dispose();
});
