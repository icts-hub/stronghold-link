'use strict';
// MuxSession 单测：一条干道上的全部流。
//
// 这个文件盯的是规格里最要命的几条：
//   §三 / §三十七  25 条本机 TCP → 仍然只有 1 个会话（不是 25 条 Steam 连接）
//   §十二          数据优先于最终 CLOSE，收到 CLOSE 也不立刻 destroy
//   §十六 / §十七  transport 断了会话不死；旧世代的数据必须被丢弃
//   §二十五        帧坏了只掐那条流，不许 destroy all peers
//   §二十七        控制帧在**流之间**优先，但不能打乱**流内部**的顺序
//
// 全程不需要 Steam：这个模块刻意不知道 Steam 的存在。

const test = require('node:test');
const assert = require('node:assert/strict');

const mux = require('../network/stream-mux.cjs');
const { SESSION_STATE, createMuxSession } = require('../network/mux-session.cjs');

function fakeSocket() {
  const listeners = new Map();
  return {
    destroyed: false, paused: false, ended: false, written: [],
    write(buf) { this.written.push(Buffer.from(buf)); return true; },
    pause() { this.paused = true; },
    resume() { this.paused = false; },
    end() { this.ended = true; },
    destroy() { this.destroyed = true; },
    on(event, fn) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); return this; },
    removeListener(event, fn) { if (listeners.has(event)) listeners.get(event).delete(fn); return this; },
    listenerCount(event) { return listeners.has(event) ? listeners.get(event).size : 0; },
    fire(event, ...args) { for (const fn of [...(listeners.get(event) || [])]) fn(...args); },
  };
}

const decoder = () => mux.createFrameDecoder();
const feed = (session, ...frames) => session.receive(Buffer.concat(frames));

test('★ 25 条本机 TCP 只对应 1 个会话 —— 业务连接数不再决定 Steam 连接数（规格 §三 / §三十七）', () => {
  const session = createMuxSession({ role: 'joiner' });
  const sockets = [];
  for (let i = 0; i < 25; i += 1) {
    const sock = fakeSocket();
    sockets.push(sock);
    assert.ok(session.openStream(sock), `第 ${i + 1} 条本机连接必须能立刻开流，不许等握手`);
  }
  assert.equal(session.streamCount, 25);
  assert.equal(session.stats.streamsOpened, 25);
  // 这个模块里根本没有"连接"这个概念，只有一个会话 —— 所以不存在 25 条 Steam 连接的可能。
  assert.equal(session.transport, null);
  assert.equal(session.streamIds.length, 25);
});

test('加入者分配偶数流号，永不与房主的奇数号相撞（规格 §十一）', () => {
  const session = createMuxSession({ role: 'joiner' });
  const ids = [session.openStream(fakeSocket()).id, session.openStream(fakeSocket()).id, session.openStream(fakeSocket()).id];
  assert.deepEqual(ids, [2, 4, 6]);
  assert.ok(ids.every((id) => id % 2 === 0));
});

test('房主：收到 OPEN 才在本机开一条到游戏端口的连接，且不回 OPEN（规格 §十二）', () => {
  const opened = [];
  const session = createMuxSession({
    role: 'host',
    openLocalSocket: (streamId, generation) => { opened.push({ streamId, generation }); return fakeSocket(); },
  });
  feed(session, mux.encodeOpen(2, 1));
  assert.deepEqual(opened, [{ streamId: 2, generation: 1 }]);
  assert.equal(session.streamCount, 1);
  assert.equal(session.snapshotStream(2).state, 'OPEN', '接收侧开局就是 OPEN');
  const out = session.takeFrames();
  assert.equal(out.length, 0, '房主**不许**回一个 OPEN —— 只有发起方才发 OPEN');
});

test('房主拒绝奇数流号（那是房主自己的号段），只 Reset 这一条', () => {
  const session = createMuxSession({ role: 'host', openLocalSocket: () => fakeSocket() });
  feed(session, mux.encodeOpen(3, 1));
  assert.equal(session.streamCount, 0);
  assert.equal(session.stats.protocolViolations, 1);
  const out = session.takeFrames();
  assert.equal(out.length, 1);
  const f = decoder().push(out[0].buffer)[0];
  assert.equal(f.type, mux.TYPE.Reset);
  assert.equal(f.streamId, 3);
  assert.equal(mux.decodeResetReason(f.payload), mux.RESET_REASON.Protocol);
});

test('数据通路：对端 DATA → 写进本机 socket（规格 §二十五 的最后一步）', () => {
  const sock = fakeSocket();
  const session = createMuxSession({ role: 'host', openLocalSocket: () => sock });
  feed(session, mux.encodeOpen(2, 1));
  feed(session, mux.encodeData(2, 1, Buffer.from('GET / HTTP/1.1\r\n')));
  assert.equal(sock.written.length, 1);
  assert.equal(sock.written[0].toString(), 'GET / HTTP/1.1\r\n');
  assert.equal(session.stats.bytesToLocal, 16);
});

test('★ 旧世代的迟到数据必须直接丢弃，绝不能写进本机 socket（规格 §十七）', () => {
  const sock = fakeSocket();
  const session = createMuxSession({ role: 'host', openLocalSocket: () => sock });
  feed(session, mux.encodeOpen(2, 3));            // 这条流当前世代 = 3
  feed(session, mux.encodeData(2, 2, Buffer.from('来自旧 transport 的脏数据')));
  assert.equal(sock.written.length, 0, 'stale 数据一字节都不许落地');
  assert.equal(session.stats.staleFrames, 1);
});

test('★ 世代比本机新 = 协议违规：只掐这一条流，别的流毫发无损（规格 §二十五）', () => {
  const sockA = fakeSocket();
  const sockB = fakeSocket();
  const byId = { 2: sockA, 4: sockB };
  const session = createMuxSession({ role: 'host', openLocalSocket: (id) => byId[id] });
  feed(session, mux.encodeOpen(2, 1), mux.encodeOpen(4, 1));
  assert.equal(session.streamCount, 2);

  feed(session, mux.encodeData(2, 9, Buffer.from('未来世代')));   // stream 2 违规
  assert.equal(sockA.destroyed, true, '违规的那条流要掐掉');
  assert.equal(session.streamCount, 1, '只少了一条流');
  assert.equal(sockB.destroyed, false, '另一条流绝不能受牵连');
  assert.equal(session.getStream(4).state, 'OPEN');
});

test('★ 帧坏了：receive 如实报错，但一条流都不许被毁（规格 §二十五「不要 destroy all peers」）', () => {
  const sock = fakeSocket();
  const session = createMuxSession({ role: 'host', openLocalSocket: () => sock });
  feed(session, mux.encodeOpen(2, 1));
  const bad = Buffer.alloc(13);
  bad.writeUInt32BE(2, 0);   // len = 2 < 9，非法
  const rc = session.receive(bad);
  assert.equal(rc.ok, false);
  assert.equal(rc.code, 'EMUXFRAME');
  assert.equal(session.streamCount, 1, '坏帧不能带走会话里的流');
  assert.equal(sock.destroyed, false);
  // 解码器必须已经重置，下一条 transport 才能干干净净地接上
  assert.equal(session.receive(mux.encodeData(2, 1, Buffer.from('ok'))).ok, true);
  assert.equal(sock.written[0].toString(), 'ok');
});

test('★ 收到 CLOSE 用 end()，不用 destroy()；本机还有数据要发时停在半关（规格 §十二）', () => {
  const sock = fakeSocket();
  const session = createMuxSession({ role: 'host', openLocalSocket: () => sock });
  feed(session, mux.encodeOpen(2, 1));
  feed(session, mux.encodeClose(2, 1));
  assert.equal(sock.ended, true, '对端说完就给它一个干净的 EOF');
  assert.equal(sock.destroyed, false, '不许 destroy —— 0.13.3 就是这么丢掉最后一段响应的');
  // 本机这一侧还能继续往外发：流停在 HALF_CLOSED_REMOTE
  assert.equal(session.getStream(2).state, 'HALF_CLOSED_REMOTE');
});

test('★ 数据优先于最终 CLOSE：本机 push 的数据排在自己的 CLOSE 前面（规格 §十二）', () => {
  const sock = fakeSocket();
  const session = createMuxSession({ role: 'joiner' });
  const stream = session.openStream(sock);
  session.takeFrames();                       // 取走 OPEN
  sock.fire('data', Buffer.from('第一段'));
  sock.fire('data', Buffer.from('第二段'));
  sock.fire('end');                            // 本机 socket 关了 -> 排 CLOSE
  const types = [];
  while (true) {
    const out = session.takeFrames();
    if (!out.length) break;
    for (const f of out) types.push(mux.typeName(decoder().push(f.buffer)[0].type));
  }
  assert.deepEqual(types, ['Data', 'Data', 'Close'], '两段数据必须都在 CLOSE 之前发出去');
  // 我们这一侧说完了，但对端还没说 —— 停在半关，绝不抢先 destroy（规格 §十二）。
  assert.equal(stream.state, 'HALF_CLOSED_LOCAL');
});

test('★ 控制帧在流之间优先：一条流的 CLOSE 不会被另一条流的 20 帧数据堵住（规格 §二十七）', () => {
  const session = createMuxSession({ role: 'joiner' });
  const a = session.openStream(fakeSocket());
  const b = session.openStream(fakeSocket());
  session.takeFrames();
  for (let i = 0; i < 20; i += 1) a.push(Buffer.alloc(100, i));  // a 积了一大堆数据
  b.closeLocal();                                                // b 只有一帧 CLOSE
  const out = session.takeFrames({ maxFrames: 4 });
  const first = decoder().push(out[0].buffer)[0];
  assert.equal(first.streamId, b.id, '队头是控制帧的那条流必须先被服务');
  assert.equal(first.type, mux.TYPE.Close);
});

test('★ transport 断了会话不销毁：流原地保留，重挂之后世代 +1 并重发 OPEN（规格 §十五 / §十六）', () => {
  const sock = fakeSocket();
  const session = createMuxSession({ role: 'joiner' });
  const stream = session.openStream(sock);
  session.attachTransport({ id: 'primary-1', send() { return true; } });
  session.markLive();
  assert.equal(session.state, SESSION_STATE.ACTIVE);
  session.takeFrames();
  assert.equal(stream.generation, 1);

  session.detachTransport('transport-lost');
  assert.equal(session.state, SESSION_STATE.DEGRADED, 'transport 没了只是降级');
  assert.equal(session.streamCount, 1, '会话和流都必须活着');
  assert.equal(sock.destroyed, false, '绝不能因为 Steam 连接断了就掐掉业务 socket');

  session.attachTransport({ id: 'primary-2', send() { return true; } });
  assert.equal(session.state, SESSION_STATE.RECOVERING);
  assert.equal(session.stats.reattachCount, 1);
  assert.equal(session.getStream(stream.id).generation, 2, '重新挂载必须推进世代号');
  const out = session.takeFrames();
  const f = decoder().push(out[0].buffer)[0];
  assert.equal(f.type, mux.TYPE.Open);
  assert.equal(f.streamId, stream.id);
  assert.equal(f.generation, 2, '重发 OPEN 就是 reattach —— 不需要另造 SESSION_HELLO');
});

test('宽限期没到不放弃，超了才用 end() 收摊（不是 destroy）', () => {
  let clock = 1000;
  const sock = fakeSocket();
  const session = createMuxSession({ role: 'joiner', now: () => clock });
  session.openStream(sock);
  session.attachTransport({ id: 'p1', send() { return true; } });
  session.detachTransport('lost');
  clock += 5000;
  assert.equal(session.graceExpired(), false, '5 秒就放弃太早了');
  assert.equal(session.streamCount, 1);
  clock += 60000;
  assert.equal(session.graceExpired(), true);
  assert.equal(session.state, SESSION_STATE.CLOSED);
  assert.equal(sock.ended, true);
  assert.equal(sock.destroyed, false);
});

test('会话级 Ping 回 Pong，并且记下 RTT（规格 §十八 统一心跳）', () => {
  let clock = 100000;
  const session = createMuxSession({ role: 'joiner', now: () => clock });

  // 对端发来 Ping：我们必须回 Pong，而且挂在流号 0 上（不占用任何业务流）。
  feed(session, mux.encodePing());
  const out = session.takeFrames();
  assert.equal(out.length, 1);
  const f = decoder().push(out[0].buffer)[0];
  assert.equal(f.type, mux.TYPE.Pong);
  assert.equal(f.streamId, mux.STREAM_ID_SESSION);

  // 我们自己发 Ping —— 由统一调度器调 heartbeat() 驱动，模块内不自建定时器。
  assert.equal(session.heartbeat(), 'ping', '到了间隔就该发心跳');
  clock += 40;
  session.dispatchFrame({ type: mux.TYPE.Pong, streamId: mux.STREAM_ID_SESSION, generation: 0, payload: Buffer.alloc(0) });
  assert.equal(session.health().rttMs, 40);

  // 对端一直不回：到 PONG_TIMEOUT_MS 必须如实报出来，让上层把连接标成 DEGRADED。
  clock += 20000;
  assert.equal(session.heartbeat(), 'pong-timeout');
});

test('接进来的 RESET 只收掉那一条流', () => {
  const sockA = fakeSocket();
  const sockB = fakeSocket();
  const byId = { 2: sockA, 4: sockB };
  const session = createMuxSession({ role: 'host', openLocalSocket: (id) => byId[id] });
  feed(session, mux.encodeOpen(2, 1), mux.encodeOpen(4, 1));
  feed(session, mux.encodeReset(2, 1, mux.RESET_REASON.Backpressure));
  assert.equal(session.streamCount, 1);
  assert.equal(sockA.destroyed, true);
  assert.equal(sockB.destroyed, false);
  assert.equal(session.stats.streamsReset, 1);
});

test('流数上限：超了只 Reset 新来的那条，已建立的流一律不动', () => {
  const session = createMuxSession({ role: 'host', maxStreams: 2, openLocalSocket: () => fakeSocket() });
  feed(session, mux.encodeOpen(2, 1), mux.encodeOpen(4, 1), mux.encodeOpen(6, 1));
  assert.equal(session.streamCount, 2);
  const out = session.takeFrames();
  const f = decoder().push(out[0].buffer)[0];
  assert.equal(f.type, mux.TYPE.Reset);
  assert.equal(f.streamId, 6);
  assert.equal(mux.decodeResetReason(f.payload), mux.RESET_REASON.StreamLimit);
});

test('找不到流的 DATA 只记账丢掉，不误伤（可能是刚关掉的那条）', () => {
  const session = createMuxSession({ role: 'host', openLocalSocket: () => fakeSocket() });
  feed(session, mux.encodeData(99, 1, Buffer.from('孤儿数据')));
  assert.equal(session.stats.droppedFrames, 1);
  assert.equal(session.streamCount, 0);
});

test('Window 帧把对端额度写回这条流，额度回正就恢复读本机 socket', () => {
  const sock = fakeSocket();
  const session = createMuxSession({ role: 'joiner' });
  const stream = session.openStream(sock);
  stream.noteRemoteCredit(0);
  stream.pauseLocal();
  assert.equal(sock.paused, true);
  feed(session, mux.encodeWindow(stream.id, 1, 65536));
  assert.equal(stream.remoteCredit, 65536);
  assert.equal(sock.paused, false, '对端腾出额度就该恢复读，不然业务会僵死');
});

test('本机 socket write 返回 false 时给对端发 Window(0) —— 端到端背压（规格 §十三）', () => {
  const sock = fakeSocket();
  sock.write = () => false;                   // 本机写不动了
  const session = createMuxSession({ role: 'host', openLocalSocket: () => sock });
  feed(session, mux.encodeOpen(2, 1));
  session.takeFrames();
  feed(session, mux.encodeData(2, 1, Buffer.from('灌不动了')));
  const out = session.takeFrames();
  assert.equal(out.length, 1);
  const f = decoder().push(out[0].buffer)[0];
  assert.equal(f.type, mux.TYPE.Window);
  assert.equal(mux.decodeWindowCredit(f.payload), 0);
});

test('会话关掉之后不再收新的本机连接（避免半死不活地挂在那儿）', () => {
  const session = createMuxSession({ role: 'joiner' });
  session.close('done');
  assert.equal(session.state, SESSION_STATE.CLOSED);
  assert.equal(session.openStream(fakeSocket()), null);
  assert.equal(session.streamCount, 0);
});

test('health() 把规格 §十九 / §三十 要的字段都交出来', () => {
  const session = createMuxSession({ role: 'joiner' });
  session.openStream(fakeSocket());
  const h = session.health();
  for (const key of ['role', 'state', 'transport', 'activeStreams', 'queuedBytes', 'maxQueuedBytes',
    'globalPaused', 'pausedStreams', 'rttMs', 'uptimeMs', 'streamsOpened', 'streamsClosed',
    'streamsReset', 'staleFrames', 'droppedFrames', 'reattachCount', 'transportLost']) {
    assert.ok(Object.prototype.hasOwnProperty.call(h, key), `health 缺少字段 ${key}`);
  }
  assert.equal(h.activeStreams, 1);
  assert.equal(h.role, 'joiner');
});
