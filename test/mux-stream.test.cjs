'use strict';
// MuxStream 单测：一条本机 TCP 在干道上的化身。
// 这个模块不碰 Steam，所以可以用一个假 socket 把生命周期、背压、世代号全跑一遍。

const test = require('node:test');
const assert = require('node:assert/strict');

const mux = require('../network/stream-mux.cjs');
const { STATE, DEFAULT_MAX_QUEUED_BYTES, createMuxStream } = require('../network/mux-stream.cjs');

/** 假 socket：记下 write / pause / resume / end / destroy，并且能手动触发事件。 */
function fakeSocket() {
  const listeners = new Map();
  return {
    destroyed: false,
    paused: false,
    ended: false,
    written: [],
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

const events = [];
const collector = (type, payload) => events.push({ type, payload });

/** takeFrame() 给的是整帧字节；要读控制帧里的东西得先过一遍解码器。 */
function payloadOf(frame) {
  const decoded = mux.createFrameDecoder().push(frame.buffer);
  assert.equal(decoded.length, 1, '一条帧切出来的必须正好是一帧');
  return decoded[0].payload;
}

test('接收侧（房主）开局就是 OPEN：对端已经发过 Open 了，我们不该回一个', () => {
  const s = createMuxStream({ id: 2, generation: 1, role: 'host', accepted: true, onEvent: collector });
  assert.equal(s.state, STATE.OPEN);
  assert.equal(s.hasPending(), false, '接收侧不许往队列里塞 Open 帧');
  assert.equal(s.allocatesId, false, '房主不分配流号');
});

test('发起侧（加入者）开局是 OPENING，open() 之后排出 OPEN 帧并进 OPEN', () => {
  const s = createMuxStream({ id: 2, generation: 1, role: 'joiner', onEvent: collector });
  assert.equal(s.state, STATE.OPENING);
  assert.equal(s.allocatesId, true, '加入者才有分配流号的权力');
  s.open();
  assert.equal(s.state, STATE.OPEN);
  const frame = s.takeFrame();
  assert.equal(frame.type, mux.TYPE.Open);
  assert.equal(frame.bytes, 0, '控制帧不占水位');
  // 解出来必须是同一条流、同一个世代
  const decoded = mux.createFrameDecoder().push(frame.buffer);
  assert.equal(decoded.length, 1);
  assert.deepEqual({ t: decoded[0].type, id: decoded[0].streamId, g: decoded[0].generation }, { t: mux.TYPE.Open, id: 2, g: 1 });
});

test('★ push 的字节一块不漏：200KB 被切成多帧，水位按净载荷算（帧头 13 字节不计）', () => {
  const s = createMuxStream({ id: 4, generation: 1, role: 'joiner' });
  const payload = Buffer.alloc(200000, 7);
  const accepted = s.push(payload);
  assert.equal(accepted, 200000);
  assert.equal(s.queuedBytes, 200000, '水位必须等于净载荷，否则阈值和规格里的 MiB 数字对不上');

  const decoder = mux.createFrameDecoder();
  let total = 0;
  let frames = 0;
  while (s.hasPending()) {
    const f = s.takeFrame();
    frames += 1;
    for (const d of decoder.push(f.buffer)) { total += d.payload.length; assert.equal(d.streamId, 4); }
  }
  assert.equal(total, 200000, '拼回来的字节数必须一字节不差');
  assert.ok(frames > 1, '这一坨必须被切成多帧，不能塞进一条巨大 Steam 消息');
  assert.equal(s.queuedBytes, 0, '取空之后水位必须归零');
});

test('★ 数据优先于最终 CLOSE —— 队列严格 FIFO，不看优先级重排（规格 §十二）', () => {
  const s = createMuxStream({ id: 2, generation: 1, role: 'joiner' });
  s.open();
  s.takeFrame(); // 丢掉 Open
  s.push(Buffer.from('这是最后一段响应'));
  s.push(Buffer.from('还不能丢'));
  s.closeLocal(); // 本机这一侧说完了 -> 排 CLOSE

  const order = [];
  while (s.hasPending()) order.push(s.takeFrame().type);
  assert.deepEqual(order, [mux.TYPE.Data, mux.TYPE.Data, mux.TYPE.Close],
    'CLOSE 必须排在它前面那两段数据之后，否则就是重演 0.13.3「最后一段字节还没写出去就 destroy」');
});

test('队头优先级暴露出去，好让调度器决定先服务谁（规格 §二十七）', () => {
  const s = createMuxStream({ id: 2, generation: 1, role: 'joiner' });
  assert.equal(s.headPriority(), null, '没积压时没有队头');
  s.push(Buffer.from('x'));
  assert.equal(s.headPriority(), mux.PRIORITY[mux.TYPE.Data]);
  s.reset(mux.RESET_REASON.Shutdown);
  assert.equal(s.headPriority(), mux.PRIORITY[mux.TYPE.Data], 'Reset 排在数据后面，队头还是数据');
});

test('★ 半关两个方向都记着：收到 CLOSE 不代表可以立刻收摊（规格 §十二）', () => {
  const sock = fakeSocket();
  const s = createMuxStream({ id: 2, generation: 1, role: 'joiner', socket: sock });
  s.closeRemote();
  assert.equal(s.state, STATE.HALF_CLOSED_REMOTE);
  assert.equal(sock.destroyed, false, '收到 CLOSE 绝不允许直接 destroy 对端 socket');
  assert.equal(s.isClosed, false, '本机这一侧还有话没说完，流不能算关完');
  s.closeLocal();
  assert.equal(s.state, STATE.CLOSED, '两边都关完才算 CLOSED');
});

test('reset 带上原因码并终结这条流；CLOSED 用 end()、RESET 用 destroy()', () => {
  const sockA = fakeSocket();
  const a = createMuxStream({ id: 2, generation: 1, role: 'joiner', socket: sockA });
  a.reset(mux.RESET_REASON.StreamLimit);
  const frame = a.takeFrame();
  assert.equal(frame.type, mux.TYPE.Reset);
  assert.equal(mux.decodeResetReason(payloadOf(frame)), mux.RESET_REASON.StreamLimit);
  a.dispose({ hard: true });
  assert.equal(sockA.destroyed, true);

  const sockB = fakeSocket();
  const b = createMuxStream({ id: 4, generation: 1, role: 'joiner', socket: sockB });
  b.dispose({ hard: false });
  assert.equal(sockB.ended, true);
  assert.equal(sockB.destroyed, false, '优雅关闭走 end()，不 destroy');
});

test('世代号只增不减，重新挂载 transport 之后老世代的数据能被认出来（规格 §十六 / §十七）', () => {
  const s = createMuxStream({ id: 8, generation: 1, role: 'joiner' });
  assert.equal(s.generation, 1);
  assert.equal(s.bumpGeneration(), 2);
  assert.equal(s.bumpGeneration(), 3);
  assert.equal(mux.checkGeneration({ type: mux.TYPE.Data, generation: 2 }, s.generation), 'stale', '旧 connection 上的迟到数据必须是 stale');
  assert.equal(mux.checkGeneration({ type: mux.TYPE.Data, generation: 3 }, s.generation), 'ok');
  assert.equal(mux.checkGeneration({ type: mux.TYPE.Data, generation: 4 }, s.generation), 'future');
});

test('pauseLocal / resumeLocal 作用在本机 socket 上，重复调用不重复动手', () => {
  const sock = fakeSocket();
  const s = createMuxStream({ id: 2, generation: 1, role: 'joiner', socket: sock });
  assert.equal(s.localPaused, false);
  assert.equal(s.pauseLocal(), true);
  assert.equal(sock.paused, true);
  assert.equal(s.pauseLocal(), false, '已经暂停了不该再调一次 socket.pause');
  assert.equal(s.resumeLocal(), true);
  assert.equal(sock.paused, false);
  assert.equal(s.resumeLocal(), false);
});

test('socket 已经销毁时 pause/resume 不抛异常（收尾阶段经常撞上）', () => {
  const sock = fakeSocket();
  sock.destroyed = true;
  const s = createMuxStream({ id: 2, generation: 1, role: 'joiner', socket: sock });
  assert.equal(s.pauseLocal(), false);
  assert.equal(s.resumeLocal(), false);
  assert.equal(s.writeLocal(Buffer.from('x')), false);
});

test('listen / disposeListeners 精确摘除监听器，不留 EventEmitter 泄漏（规格 §三十六）', () => {
  const sock = fakeSocket();
  const s = createMuxStream({ id: 2, generation: 1, role: 'joiner', socket: sock });
  let hits = 0;
  s.listen('data', () => { hits += 1; });
  s.listen('end', () => { hits += 10; });
  assert.equal(sock.listenerCount('data'), 1);
  sock.fire('data', Buffer.from('a'));
  sock.fire('end');
  assert.equal(hits, 11);
  s.disposeListeners();
  assert.equal(sock.listenerCount('data'), 0);
  assert.equal(sock.listenerCount('end'), 0);
  sock.fire('data', Buffer.from('b'));
  assert.equal(hits, 11, '摘掉之后不该再被叫到');
});

test('writeLocal 把对端来的字节写进本机 socket，并记进字节数', () => {
  const sock = fakeSocket();
  const s = createMuxStream({ id: 2, generation: 1, role: 'host', accepted: true, socket: sock });
  s.writeLocal(Buffer.from('HTTP/1.1 200 OK'));
  assert.equal(sock.written.length, 1);
  assert.equal(sock.written[0].toString(), 'HTTP/1.1 200 OK');
  assert.equal(s.snapshot().inBytes, 15);
});

test('Window 额度：收得进 noteRemoteCredit，发得出 sendWindow', () => {
  const s = createMuxStream({ id: 2, generation: 1, role: 'joiner' });
  assert.equal(s.remoteCredit, 1024 * 1024, '初始额度 1 MiB');
  s.noteRemoteCredit(0);
  assert.equal(s.remoteCredit, 0, '对端说 0 就必须是 0（负数/NaN 也归零，不能变成"无限额度"）');
  s.noteRemoteCredit(-5);
  assert.equal(s.remoteCredit, 0);
  s.noteRemoteCredit(NaN);
  assert.equal(s.remoteCredit, 0);
  s.sendWindow(4096);
  const f = s.takeFrame();
  assert.equal(f.type, mux.TYPE.Window);
  assert.equal(mux.decodeWindowCredit(payloadOf(f)), 4096);
});

test('积压超过硬上限时报 onOverflow，让上层只掐这一条流（规格 §二十五）', () => {
  const seen = [];
  const s = createMuxStream({
    id: 2, generation: 1, role: 'joiner',
    maxQueuedBytes: 1000,
    onOverflow: (stream) => seen.push(stream.id),
  });
  s.push(Buffer.alloc(600, 1));
  assert.equal(seen.length, 0);
  s.push(Buffer.alloc(600, 1));
  assert.deepEqual(seen, [2], '越过上限必须给出信号，不能无限吃内存');
});

test('默认硬上限是 4 MiB，不是无限', () => {
  assert.equal(DEFAULT_MAX_QUEUED_BYTES, 4 * 1024 * 1024);
  const s = createMuxStream({ id: 2, generation: 1, role: 'joiner' });
  assert.equal(s.snapshot().maxQueuedBytes, DEFAULT_MAX_QUEUED_BYTES);
});

test('snapshot 把诊断要用的字段都交出来（规格 §十九 / §三十）', () => {
  const s = createMuxStream({ id: 6, generation: 3, role: 'joiner' });
  s.push(Buffer.from('hello'));
  const snap = s.snapshot();
  for (const key of ['id', 'role', 'generation', 'state', 'queuedBytes', 'maxQueuedSeen', 'remoteCredit',
    'localPaused', 'pending', 'ageMs', 'idleMs', 'inBytes', 'outBytes', 'outFrames', 'inFrames',
    'windowsIn', 'windowsOut', 'staleDropped']) {
    assert.ok(Object.prototype.hasOwnProperty.call(snap, key), `snapshot 缺少字段 ${key}`);
  }
  assert.equal(snap.id, 6);
  assert.equal(snap.generation, 3);
  assert.equal(snap.queuedBytes, 5);
  assert.equal(snap.outFrames, 1);
});

test('已经关掉的流不再收数据（防止关流之后又冒出新字节）', () => {
  const s = createMuxStream({ id: 2, generation: 1, role: 'joiner' });
  s.reset(mux.RESET_REASON.Shutdown);
  assert.equal(s.push(Buffer.from('晚了')), 0);
  assert.equal(s.hasPendingData(), false);
});

test('事件流：stream-open / stream-half-closed / stream-closed / stream-reset 都报得出来', () => {
  const seen = [];
  const s = createMuxStream({ id: 2, generation: 1, role: 'joiner', onEvent: (t) => seen.push(t) });
  s.open();
  s.closeLocal();
  assert.ok(seen.includes('stream-open'));
  assert.ok(seen.includes('stream-half-closed'));
  const seen2 = [];
  const r = createMuxStream({ id: 4, generation: 1, role: 'joiner', onEvent: (t) => seen2.push(t) });
  r.reset(mux.RESET_REASON.Protocol);
  assert.ok(seen2.includes('stream-reset'));
});
