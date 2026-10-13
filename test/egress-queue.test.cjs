'use strict';
// 分流出站队列单测（0.14.3 延迟专项 Phase 2）：
//   流内严格 FIFO / 干道队列整段在前 / 流间轮转（大响应不许独占全局队列）/
//   quantum 决定"一条流的帧能让另一条等多久" / 前缀确认跨段出队正确 /
//   计数永不带病运行（total 现算，直连 push 也认）/ 最老等待可读 /
//   prepend 只动队头 / clear / dropTrunk 不越界。
// 全程纯内存，不碰真实 socket 与定时器。

const test = require('node:test');
const assert = require('node:assert/strict');

const egress = require('../network/egress-queue.cjs');

/** 造一个空 peer（形状与活路径一致：out 是普通数组，其余字段由 ensure 建立）。 */
function mkPeer() {
  return { out: [] };
}

/** 把计划里的段按 key 归总成可读形状，断言用。 */
function planKeys(planInfo) {
  return planInfo.plan.map((seg) => `${seg.key == null ? 'trunk' : seg.key}:${seg.buf.length}`);
}

test('enqueue：干道队列与流队列分开计，返回值是当前排队总字节', () => {
  const peer = mkPeer();
  assert.equal(egress.enqueue(peer, Buffer.from('hello'), null), 5, '干道队列 5 字节');
  assert.equal(egress.enqueue(peer, Buffer.from('aa'), 77), 7, '加上流 77 的 2 字节');
  assert.equal(peer.out.length, 1, '干道队列只有一个块');
  assert.equal(peer.outBytes, 7, '缓存计数与实际一致');
  assert.equal(egress.total(peer), 7);
});

test('planOut：干道队列整段排在所有流之前', () => {
  const peer = mkPeer();
  egress.enqueue(peer, Buffer.from('PING'), null);
  egress.enqueue(peer, Buffer.from('aaaa'), 2);
  const info = egress.planOut(peer);
  assert.deepEqual(planKeys(info), ['trunk:4', '2:4']);
  assert.equal(info.bytes, 8);
});

test('planOut：流内严格 FIFO，一条流的多帧顺序逐字节不变', () => {
  const peer = mkPeer();
  egress.enqueue(peer, Buffer.from('OPEN'), 5);
  egress.enqueue(peer, Buffer.from('DATA'), 5);
  egress.enqueue(peer, Buffer.from('CLOS'), 5);
  const info = egress.planOut(peer);
  assert.deepEqual(info.plan.map((s) => s.buf.toString()), ['OPEN', 'DATA', 'CLOS']);
});

test('轮转公平：900KB 的大响应不许把 20 字节的小包挡在后面', () => {
  const peer = mkPeer();
  // 流 2 = 地图区块（一个 900KB 的响应），流 3 = 玩家移动（20 字节，后到）。
  egress.enqueue(peer, Buffer.alloc(900 * 1024, 0x41), 2);
  egress.enqueue(peer, Buffer.from('MOVE-MOVE-MOVE-MOVE!'), 3);

  const info = egress.planOut(peer);
  const first = info.plan[0];
  assert.equal(first.key, 2, '计划第一段一定是最早排队的流');
  assert.equal(first.buf.length, egress.DEFAULT_FAIR_QUANTUM,
    `一个回合只准取走 quantum（${egress.DEFAULT_FAIR_QUANTUM}）字节 —— 多取一个字节，小包就多等一个字节`);
  const second = info.plan[1];
  assert.equal(second.key, 3, '第二条流必须在第二个回合就轮到，而不是等 900KB 全发完');
  assert.equal(second.buf.toString(), 'MOVE-MOVE-MOVE-MOVE!');
  // 整体仍然一个字节都不许丢：计划总量 = 入队总量。
  assert.equal(info.bytes, 900 * 1024 + 20);
  assert.equal(egress.total(peer), 900 * 1024 + 20, '取队不改队列，出队才改');
});

test('轮转公平：quantum 决定一条大流让路多快（同一个队列，两个粒度两个结果）', () => {
  const build = () => {
    const peer = mkPeer();
    egress.enqueue(peer, Buffer.alloc(64 * 1024, 0x41), 2);
    egress.enqueue(peer, Buffer.from('X'), 3);
    return peer;
  };
  const fine = egress.planOut(build(), 512);
  assert.equal(fine.plan[1].key, 3, 'quantum=512 时 64KB 的第一回合只占 512 字节，小包第二个回合就出门');
  const coarse = egress.planOut(build(), 64 * 1024);
  assert.equal(coarse.plan[1].key, 3, 'quantum=64KB 时小包要等这 64KB 走完才轮到');
  assert.equal(coarse.plan[1].buf.length, 1);
  assert.equal(coarse.plan.length <= fine.plan.length, true, '粒度越大计划段数越少（合并得更多）');
});

test('commit：确认前缀按计划出队，横跨两个队列也不会丢错字节', () => {
  const peer = mkPeer();
  egress.enqueue(peer, Buffer.from('AAAA'), 2); // 4 字节
  egress.enqueue(peer, Buffer.from('BBBB'), 3); // 4 字节
  const info = egress.planOut(peer);
  assert.equal(info.bytes, 8);

  // Steam 只收下了前 6 字节：流的 4 字节 + 流 3 的 2 字节。
  const left = egress.commit(peer, info, 6);
  assert.equal(left, 2, '剩下 2 字节');
  assert.equal(peer.outStreams.has(2), false, '流 2 已经全部确认，队列要整条清掉');
  assert.equal(peer.outStreams.get(3).queue[0].toString(), 'BB', '流 3 只剩没被确认的那 2 字节');
  assert.equal(egress.total(peer), 2, '计数跟着出队一起走');
});

test('commit：确认字节数为 0 时一个字节都不许出队（发送失败必须原地等重试）', () => {
  const peer = mkPeer();
  egress.enqueue(peer, Buffer.from('hello'), 2);
  const info = egress.planOut(peer);
  assert.equal(egress.commit(peer, info, 0), 5);
  assert.equal(peer.outStreams.get(2).queue[0].toString(), 'hello');
});

test('commit：确认数超过计划量时按计划量封顶，不越界', () => {
  const peer = mkPeer();
  egress.enqueue(peer, Buffer.from('abc'), 2);
  const info = egress.planOut(peer);
  assert.equal(egress.commit(peer, info, 999), 0);
  assert.equal(egress.total(peer), 0);
});

test('total：现算真实队列长度 —— 外部直接往 peer.out 里 push 也认（测试桩与旧路径）', () => {
  const peer = mkPeer();
  egress.enqueue(peer, Buffer.alloc(10), 2);
  peer.out.push(Buffer.alloc(7));
  assert.equal(egress.total(peer), 17, '干道数组被直接改过，缓存计数不作数');
  assert.equal(egress.planOut(peer).bytes, 17);
});

test('queueRows：报每条队列的字节数与最老那批字节等了多久，按等待时间倒序', () => {
  const peer = mkPeer();
  egress.enqueue(peer, Buffer.alloc(100), 2, 1000);
  egress.enqueue(peer, Buffer.alloc(50), 3, 1500);
  egress.enqueue(peer, Buffer.from('PING'), null, 1600);

  const rows = egress.queueRows(peer, 2000);
  assert.deepEqual(rows.map((r) => r.key), ['2', '3', 'trunk'], '等得最久的排最前');
  assert.deepEqual(rows.map((r) => r.bytes), [100, 50, 4]);
  assert.deepEqual(rows.map((r) => r.waitedMs), [1000, 500, 400]);
  assert.deepEqual(rows.map((r) => r.frames), [1, 1, 1]);
  assert.equal(egress.queueRows(mkPeer(), 2000).length, 0, '空队列没有行');
});

test('enqueue：空队列的入队时刻才算"这批积压等了多久"，后续入队不改锚点', () => {
  const peer = mkPeer();
  egress.enqueue(peer, Buffer.from('a'), 2, 1000);
  egress.enqueue(peer, Buffer.from('b'), 2, 1900);
  assert.equal(egress.oldestAt(peer), 1000, '同一批积压共用第一个字节的入队时刻');
  assert.equal(egress.queueRows(peer, 2000)[0].waitedMs, 1000);
  egress.clear(peer);
  assert.equal(egress.oldestAt(peer), 0, '清空之后没有锚点');
  egress.enqueue(peer, Buffer.from('c'), 2, 3000);
  assert.equal(egress.oldestAt(peer), 3000, '重新积压要重新打点');
});

test('prepend：重连补发插到队头，帧序不变（旧版路径）', () => {
  const peer = mkPeer();
  egress.enqueue(peer, Buffer.from('old'), null);
  egress.prepend(peer, [Buffer.from('re1'), Buffer.from('re2')], 5000);
  assert.deepEqual(peer.out.map((b) => b.toString()), ['re1', 're2', 'old']);
  assert.equal(egress.total(peer), 9);
  assert.equal(egress.oldestAt(peer), 5000, '补发的字节等的时间从补发那一刻算');
});

test('clear：整队清空，计数与锚点一起归零', () => {
  const peer = mkPeer();
  egress.enqueue(peer, Buffer.alloc(16), 2);
  egress.enqueue(peer, Buffer.alloc(16), null);
  egress.clear(peer);
  assert.equal(egress.total(peer), 0);
  assert.equal(peer.out.length, 0);
  assert.equal(peer.outStreams.size, 0);
  assert.equal(egress.planOut(peer).bytes, 0);
});

test('dropTrunk：按字节跨块丢弃，最后一块可以只丢一部分；丢多了不越界', () => {
  const peer = mkPeer();
  egress.enqueue(peer, Buffer.from('abc'), null);
  egress.enqueue(peer, Buffer.from('defg'), null);
  egress.enqueue(peer, Buffer.from('hi'), null);
  assert.equal(egress.dropTrunk(peer, 4), 5);
  assert.deepEqual(peer.out.map((b) => b.toString()), ['efg', 'hi']);
  assert.equal(egress.dropTrunk(peer, 999), 0, '丢的比剩的多也不许越界');
  assert.equal(peer.outTrunkAt, 0, '队列空了锚点也要清掉');
});

test('planOut：整块取走时复用原 Buffer，不额外复制（大响应的内存代价不能翻倍）', () => {
  const peer = mkPeer();
  const buf = Buffer.alloc(1024, 0x41);
  egress.enqueue(peer, buf, 2);
  const info = egress.planOut(peer, 4096);
  assert.equal(info.plan[0].buf, buf, '整块走时必须是同一个对象');
});

test('DEFAULT_FAIR_QUANTUM 取 maxChunk 同量级（4KB），别把大块切碎也别让人等太久', () => {
  assert.equal(egress.DEFAULT_FAIR_QUANTUM, 4096);
});

test('★ 拥塞链路回归：一次 flush 吃不满一个 quantum 时，轮转起点要跨调用往前走 —— 后面的流不许被饿死', () => {
  // 现场症状：地图一动人就飘。512KB/s 的链路上每个 4ms tick 只发得出 2048 字节，
  // 而 quantum 是 4096 —— 如果 planOut 每次都从第一条流重新开始（cursor 不落盘），
  // 那 900KB 的大响应排在最前面、小包所在的那条流要等到它**全部发完**才轮到（秒级）。
  // 这里用"每轮只确认 1 字节"把那种极端拥塞复现出来。
  const peer = mkPeer();
  egress.enqueue(peer, Buffer.alloc(64 * 1024, 0x41), 2); // 大响应的流
  egress.enqueue(peer, Buffer.from('MOVE!'), 3); // 小包，后到

  const seen = [];
  for (let round = 0; round < 8; round += 1) {
    const info = egress.planOut(peer);
    assert.ok(info.bytes > 0, '还没轮到就说明计划空了');
    seen.push(info.plan[0].key);
    egress.commit(peer, info, 1); // 本轮只被接受 1 个字节
  }

  assert.ok(
    seen.slice(0, 2).includes(3),
    `第二条流必须在头两轮内拿到发送机会，实际轮转顺序 ${JSON.stringify(seen)} —— 每轮都从第一条流重来会让小包饿到秒级`,
  );
  assert.notEqual(peer.outCursorKey, null, '游标要留在 peer 上供下一次 flush 用');
});

test('★ clear 之后轮转游标要归零，新会话不受上一次会话的起点影响', () => {
  const peer = mkPeer();
  egress.enqueue(peer, Buffer.alloc(8), 2);
  egress.enqueue(peer, Buffer.alloc(8), 3);
  egress.planOut(peer);
  assert.notEqual(peer.outCursorKey, null);
  egress.clear(peer);
  assert.equal(peer.outCursorKey, null);

  egress.enqueue(peer, Buffer.from('aaaa'), 2);
  egress.enqueue(peer, Buffer.from('bbbb'), 3);
  assert.equal(egress.planOut(peer).plan[0].key, 2, '干净的新队列仍然从最早排队的流开始');
});

test('★ takePending：只取"还没交给 Steam"的帧 —— 已确认的前缀绝不再取（补发不会重复）', () => {
  // 这条是 0.14.5 数据丢失修复的正确性底线：干道断开时我们把出站队列里剩下的字节交给流带走，
  // 在新干道上按新世代补发。要是把**已经进了 Steam 可靠队列**的字节也带走，对端就会收到重复
  // 字节 —— 那和丢字节一样会让 Minecraft 的解码器错位。
  // 语义保证来自 commit：只有被 Steam 接受的**前缀**才会出队，所以取出来的一定没送达。
  const peer = mkPeer();
  egress.enqueue(peer, Buffer.from('AAAA'), 2); // 会被确认
  egress.enqueue(peer, Buffer.from('BBBB'), 2); // 不会被确认
  egress.enqueue(peer, Buffer.from('CCCC'), 3);
  egress.enqueue(peer, Buffer.from('PING'), null);

  const info = egress.planOut(peer);
  egress.commit(peer, info, 8); // Steam 只收下了干道队列那 4 字节（PING）+ 流 2 的第一块（AAAA）

  const taken = egress.takePending(peer, null);
  assert.equal(taken.trunk.length, 0, '已确认的干道帧不许再取出来（再发一遍就是重复字节）');
  assert.deepEqual([...taken.streams.keys()], [2, 3], '没确认的流队列都要取出来');
  assert.equal(taken.streams.get(2)[0].toString(), 'BBBB', '只取没确认的那一块');
  assert.equal(taken.streams.get(3)[0].toString(), 'CCCC');
  assert.equal(egress.total(peer), 0, '取过之后队列必须干净（否则会原地重发）');
  assert.equal(egress.planOut(peer).bytes, 0, '再计划一次取不到任何帧');
});

test('★ takePending：流内 FIFO 顺序原样带出，且按流号过滤时不动别的流', () => {
  // 顺序同样是正确性：补发时这些帧会按取出的顺序重新入队，串一下就是字节乱序。
  const peer = mkPeer();
  egress.enqueue(peer, Buffer.from('OPEN'), 2);
  egress.enqueue(peer, Buffer.from('DATA'), 2);
  egress.enqueue(peer, Buffer.from('CLOSE'), 2);
  egress.enqueue(peer, Buffer.from('KEEP'), 3);
  egress.enqueue(peer, Buffer.from('PING'), null);

  const taken = egress.takePending(peer, [2]);
  assert.deepEqual(taken.streams.get(2).map((b) => b.toString()), ['OPEN', 'DATA', 'CLOSE'],
    '流内顺序必须原样带出');
  assert.equal(taken.trunk.length, 0, '按流过滤时不碰干道队列');
  assert.equal(peer.outStreams.has(2), false, '取走的流队列要摘掉');
  assert.equal(peer.outStreams.get(3).queue[0].toString(), 'KEEP', '别的流的字节一个都不许动');
  assert.equal(egress.total(peer), 8, '剩下的计数要现算准确（KEEP 4 + PING 4）');
});
