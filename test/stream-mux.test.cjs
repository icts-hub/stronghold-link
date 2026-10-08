'use strict';
// 流多路复用分帧层单测（v2）：
//   帧往返 / 跨消息边界 / 批量解帧 / 长度前缀的防护 / 开场魔数与版本识别 /
//   世代校验（规格 §十七）/ 窗口额度 / 控制帧优先级（规格 §二十七）/ 奇偶流号（规格 §十一）。
// 全部本机可测，不依赖 Steam 运行时。

const test = require('node:test');
const assert = require('node:assert');

const M = require('../network/stream-mux.cjs');

test('一帧进一帧出：类型、流号、世代、载荷都对得上', () => {
  const frame = M.encodeData(7, 3, Buffer.from('hello'));
  assert.equal(frame.length, M.FRAME_HEADER + 5);
  const dec = M.createFrameDecoder();
  const frames = dec.push(frame);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, M.TYPE.Data);
  assert.equal(frames[0].streamId, 7);
  assert.equal(frames[0].generation, 3);
  assert.equal(frames[0].payload.toString(), 'hello');
  assert.equal(dec.pending, 0);
});

test('帧头是 13 字节：len 覆盖 type+streamId+generation+payload', () => {
  assert.equal(M.FRAME_HEADER, 13);
  const frame = M.encodeData(5, 1, Buffer.from('abc'));
  assert.equal(frame.readUInt32BE(0), 9 + 3);
  assert.equal(frame.readUInt8(4), M.TYPE.Data);
  assert.equal(frame.readUInt32BE(5), 5);
  assert.equal(frame.readUInt32BE(9), 1);
});

test('OPEN/CLOSE 是空载荷，RESET 带 1 字节原因码', () => {
  const dec = M.createFrameDecoder();
  const frames = dec.push(Buffer.concat([M.encodeOpen(1, 1), M.encodeClose(2, 2), M.encodeReset(3, 5)]));
  assert.deepEqual(frames.map((f) => [f.type, f.streamId, f.generation]), [
    [M.TYPE.Open, 1, 1],
    [M.TYPE.Close, 2, 2],
    [M.TYPE.Reset, 3, 5],
  ]);
  assert.equal(frames[0].payload.length, 0);
  assert.equal(frames[1].payload.length, 0);
  assert.equal(frames[2].payload.length, 1, 'RESET 只有原因码这 1 个字节');
});

test('Reset 带上原因码，日志里能说清楚为什么掐的这条流', () => {
  const frame = M.encodeReset(4, 1, M.RESET_REASON.Stale);
  const got = M.createFrameDecoder().push(frame)[0];
  assert.equal(got.type, M.TYPE.Reset);
  assert.equal(M.decodeResetReason(got.payload), M.RESET_REASON.Stale);
  assert.equal(M.RESET_REASON_NAMES[M.RESET_REASON.Stale], '收到过期世代的帧');
});

test('一个消息里塞多帧，一次全解出来', () => {
  const blob = Buffer.concat([
    M.encodeOpen(1, 1),
    M.encodeData(1, 1, Buffer.from('aaa')),
    M.encodeData(1, 1, Buffer.from('bbb')),
    M.encodeClose(1, 1),
  ]);
  const frames = M.createFrameDecoder().push(blob);
  assert.equal(frames.length, 4);
  assert.equal(frames[1].payload.toString(), 'aaa');
  assert.equal(frames[2].payload.toString(), 'bbb');
});

test('一帧被切成多条消息（发送层按 maxChunk 分片）也要能拼回来', () => {
  const payload = Buffer.alloc(10000);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  const frame = M.encodeData(42, 6, payload);
  const dec = M.createFrameDecoder();
  let got = 0;
  // 模拟发送层切成 4096 字节一条消息
  for (let offset = 0; offset < frame.length; offset += 4096) {
    const frames = dec.push(frame.subarray(offset, Math.min(offset + 4096, frame.length)));
    if (frames.length) {
      assert.equal(frames.length, 1);
      assert.equal(frames[0].streamId, 42);
      assert.equal(frames[0].generation, 6);
      assert.ok(frames[0].payload.equals(payload));
      got += 1;
    }
  }
  assert.equal(got, 1);
  assert.equal(dec.pending, 0);
});

test('字节流错乱时报 EMUXFRAME，而不是闷头分配内存', () => {
  const dec = M.createFrameDecoder({ maxFrame: 1024 });
  const bad = Buffer.alloc(8);
  bad.writeUInt32BE(4096, 0);      // 超过上限
  assert.throws(() => dec.push(bad), (err) => err.code === 'EMUXFRAME');

  const tooSmall = Buffer.alloc(8);
  tooSmall.writeUInt32BE(8, 0);    // 连 type+streamId+generation 都装不下
  assert.throws(() => M.createFrameDecoder().push(tooSmall), (err) => err.code === 'EMUXFRAME');
});

test('大载荷被切成多帧发出去，拼回来一个字节都不差', () => {
  const payload = Buffer.alloc(200 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) % 256;
  const frames = M.encodeDataChunks(9, 2, payload, 64 * 1024);
  assert.equal(frames.length, 4);
  const dec = M.createFrameDecoder();
  const out = [];
  for (const frame of frames) {
    for (const f of dec.push(frame)) {
      assert.equal(f.type, M.TYPE.Data);
      assert.equal(f.streamId, 9);
      assert.equal(f.generation, 2);
      out.push(f.payload);
    }
  }
  assert.ok(Buffer.concat(out).equals(payload));
});

test('小载荷不再切分：一帧就是一帧', () => {
  const frames = M.encodeDataChunks(3, 1, Buffer.from('tiny'), 64 * 1024);
  assert.equal(frames.length, 1);
  assert.equal(M.createFrameDecoder().push(frames[0])[0].payload.toString(), 'tiny');
});

test('开场魔数只认完整前缀，业务数据不会被误判', () => {
  assert.equal(M.isHello(M.encodeHello()), true);
  // 老版本房主看到的会是游戏请求的第一段字节 —— 绝不能被当成魔数
  assert.equal(M.isHello(Buffer.from('GET / HTTP/1.1\r\n')), false);
  assert.equal(M.isHello(Buffer.from('SHLM')), false, '半个魔数不算');
  assert.equal(M.isHello(Buffer.alloc(0)), false);
  // 魔数后面就算还跟着别的东西，前面仍然判定成立（发送层可能把两段拼在一条消息里）
  assert.equal(M.isHello(Buffer.concat([M.encodeHello(), Buffer.from('xxx')])), true);
});

test('★ 解帧器跳过半路出现的握手魔数 —— 它会被粘在数据帧后面（BadFraming 的成因）', () => {
  // 为什么会有"半路的魔数"：干道的发送队列 steam-adapter.cjs 的 flushPeerOut 在
  // peer.out 有多项时是 Buffer.concat 成**一条**消息发出去的。房主补答的魔数完全
  // 可能排在已经排好的数据帧之后，于是线路上出现 "…数据帧… SHLMUX\\x02"。
  // 老解帧器把 'SHLM' 当长度读成 0x53484C4D = 1397247053，超上限当场 EMUXFRAME，
  // 整条干道以 BadFraming 收场 —— 刚救回来的隧道又被自己毙掉。
  const d = M.createFrameDecoder();
  const data = M.encodeData(2, 1, Buffer.from('payload'));
  const glued = Buffer.concat([data, M.encodeHello()]);

  assert.doesNotThrow(() => d.push(glued), '粘在后面的魔数绝不能再把解帧器打炸');
  d.reset();
  assert.deepEqual(d.push(glued).map((f) => f.type), [M.TYPE.Data], '数据帧照常解出来，魔数被静默跳过');
  assert.equal(d.pending, 0, '魔数不该在解帧器里留残留');

  // 魔数在最前面：老代码靠调用方手工切 7 字节，现在解帧器自己也能认
  d.reset();
  assert.deepEqual(d.push(Buffer.concat([M.encodeHello(), data])).map((f) => f.type), [M.TYPE.Data]);

  // 连续多条魔数（补发 + 重答叠在一起）要能全部跳过
  d.reset();
  assert.equal(d.push(Buffer.concat([M.encodeHello(), M.encodeHello(), M.encodeHello()])).length, 0);
  assert.equal(d.pending, 0, '三连魔数应当被整段跳掉');

  // 魔数被发送层切成两段喂进来：前缀没凑齐时要等着，不能报错
  d.reset();
  const hello = M.encodeHello();
  assert.equal(d.push(hello.subarray(0, 3)).length, 0);
  assert.equal(d.pending, 3, '半个魔数应当留在缓冲里等后续字节');
  assert.equal(d.push(hello.subarray(3)).length, 0);
  assert.equal(d.pending, 0);

  // 单个 'S'：以 0x53 开头的合法帧不存在（长度会读成 0x53xxxxxx，必然超上限），
  // 所以"等更多字节"永远是安全的。
  d.reset();
  assert.equal(d.push(Buffer.from('S')).length, 0);
  assert.equal(d.pending, 1);
  assert.equal(d.push(hello.subarray(1)).length, 0);
  assert.equal(d.pending, 0);
});

test('魔数带版本号：认得出对面是别的版本，好安全退回单连接模式', () => {
  assert.equal(M.MUX_VERSION, 2);
  assert.equal(M.HELLO_BYTES.length, 7);
  assert.equal(M.encodeHello().readUInt8(6), 2);

  assert.equal(M.helloVersion(M.encodeHello()), 2);
  assert.equal(M.isOurHello(M.encodeHello()), true);

  // 0.14.0 开发期的 v1 帧格式（没有 generation）必须被认出来、且判定为"不是我们的版本"
  const v1 = Buffer.from('SHLMUX\x01', 'binary');
  assert.equal(M.isHello(v1), true, '魔数认得出来');
  assert.equal(M.helloVersion(v1), 1);
  assert.equal(M.isOurHello(v1), false, '版本不同 ⇒ 不当成多路复用');

  // 半包（只到魔数、版本字节还没到）不能瞎猜版本
  assert.equal(M.helloVersion(Buffer.from('SHLMUX', 'ascii')), null);
  assert.equal(M.isOurHello(Buffer.from('SHLMUX', 'ascii')), false);
});

test('世代校验：旧连接迟到的帧必须被丢弃（规格 §十七）', () => {
  const mk = (g) => ({ generation: g });
  assert.equal(M.checkGeneration(mk(3), 3), 'ok');
  assert.equal(M.checkGeneration(mk(2), 3), 'stale', '旧世代 ⇒ 丢弃');
  assert.equal(M.checkGeneration(mk(1), 3), 'stale');
  assert.equal(M.checkGeneration(mk(4), 3), 'future', '比本地新又不是 Open ⇒ 协议违规');
});

test('窗口额度往返：0 表示"别再发了"（规格 §十三 的端到端背压）', () => {
  const dec = M.createFrameDecoder();
  const frames = dec.push(Buffer.concat([M.encodeWindow(8, 1, 1048576), M.encodeWindow(8, 1, 0)]));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].type, M.TYPE.Window);
  assert.equal(frames[0].streamId, 8);
  assert.equal(M.decodeWindowCredit(frames[0].payload), 1048576);
  assert.equal(M.decodeWindowCredit(frames[1].payload), 0);
  // 负数/NaN 一律按 0 处理，不能发出一个"负数额度"让对端算出无限窗口
  assert.equal(M.decodeWindowCredit(M.encodeWindow(8, 1, -5).subarray(13)), 0);
  assert.equal(M.decodeWindowCredit(M.encodeWindow(8, 1, NaN).subarray(13)), 0);
});

test('Ping / Pong 挂在 streamId = 0 上（整条干道，不是某条流）', () => {
  const frames = M.createFrameDecoder().push(Buffer.concat([M.encodePing(), M.encodePong()]));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].type, M.TYPE.Ping);
  assert.equal(frames[1].type, M.TYPE.Pong);
  assert.ok(frames.every((f) => f.streamId === M.STREAM_ID_SESSION));
  assert.ok(frames.every((f) => f.payload.length === 0));
});

test('流号奇偶分开：房主奇数、加入者偶数，两边永远不会撞号（规格 §十一）', () => {
  assert.equal(M.STREAM_ID_SESSION, 0);
  assert.equal(M.STREAM_ID_HOST_START % 2, 1, '房主从奇数开始');
  assert.equal(M.STREAM_ID_CLIENT_START % 2, 0, '加入者从偶数开始');
  // 各自按 +2 递增，集合不相交
  const host = new Set();
  const client = new Set();
  for (let i = 0; i < 50; i++) host.add(M.STREAM_ID_HOST_START + i * 2);
  for (let i = 0; i < 50; i++) client.add(M.STREAM_ID_CLIENT_START + i * 2);
  for (const id of client) assert.equal(host.has(id), false, `流号 ${id} 撞了`);
});

test('控制帧优先级：RESET > CLOSE > OPEN > WINDOW > PING/PONG > DATA（规格 §二十七）', () => {
  const order = [M.TYPE.Reset, M.TYPE.Close, M.TYPE.Open, M.TYPE.Window, M.TYPE.Ping, M.TYPE.Pong, M.TYPE.Data];
  const ranks = order.map((t) => M.PRIORITY[t]);
  for (let i = 1; i < ranks.length; i++) assert.ok(ranks[i] >= ranks[i - 1], '优先级必须单调不降');
  assert.ok(M.PRIORITY[M.TYPE.Reset] < M.PRIORITY[M.TYPE.Data], 'RESET 必须先于 DATA');
  assert.ok(M.PRIORITY[M.TYPE.Close] < M.PRIORITY[M.TYPE.Data], 'CLOSE 必须先于 DATA');
  assert.ok(M.PRIORITY[M.TYPE.Open] < M.PRIORITY[M.TYPE.Data], 'OPEN 必须先于 DATA');
  assert.equal(M.PRIORITY[M.TYPE.Data], M.PRIORITY_MAX, 'DATA 是最低优先级');
});

test('帧类型名字可读（日志里不要打数字）', () => {
  assert.equal(M.typeName(M.TYPE.Data), 'Data');
  assert.equal(M.typeName(M.TYPE.Window), 'Window');
  assert.equal(M.typeName(0x7f), '未知(127)');
});
