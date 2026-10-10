'use strict';
// ============================================================================
// 出站公平调度的**限速对照模型**（0.14.3 延迟专项 Phase 3 取证之一）
// ============================================================================
//
// ── 为什么需要它 ────────────────────────────────────────────────────────────
//
// 真机环回链路（同一台机器自己连自己、走 Steam SDR）实测能到 **400MB/s 上下**：
// 出站队列根本不积压（诊断帧里 干道=0B 流=0B、Steam 侧 bytesBuffered=0 queueMs=0）。
// 也就是说，**真机上量不出公平调度的收益** —— 只能量出"在这条链路上它不是瓶颈"。
//
// 而用户抱怨的"地图一动，人就飘"恰恰发生在**朋友家上行 1~5MB/s** 的链路上：
// 一个 900KB 的地图区块排在出站队列里，按 512KB/s 上行要用满 1800ms —— 这期间
// 50Hz 的移动包全排在它后面。这条链路在真机上造不出来（本机没有带宽瓶颈，
// steamworks-ffi-node 0.11.3 也没暴露 SetConfigValue，改不了 Steam 的发送速率）。
//
// 所以这里把那条链路**按给定速率模型化**，排队与取队全部交给**真实的**
// network/egress-queue.cjs（enqueue / planOut / commit），字节数按**真实的**
// 帧头（13 字节）算。量出来的就是"小包要等多久"。
//
// ── 模型里有什么 ────────────────────────────────────────────────────────────
//   · 真实的 egress-queue.cjs 与真实的 stream-mux 帧编码；
//   · 一条干道按给定速率放行字节（每 tick 一个字节预算，等价于 Steam 发送缓冲的容量）；
//   · 生产端：大响应一次性到齐（900KB 在本地 socket 上几十毫秒就传完了，相对秒级链路可忽略），
//     小包按固定间隔产生（默认 20ms = 50Hz 游戏输入）；
//   · 回调节拍 4ms（link-tuning 的 callbackIntervalMs；Windows 实测 setInterval(4) ≈ 14.3ms，
//     这里只取配置值，属于模型的一部分）。
//
// ── 模型里没有什么（报告里必须如实写）──────────────────────────────────────
//   · 没有 Steam、没有 SDR 拥塞控制、没有丢包重传、没有对端确认延迟；
//   · 没有本地 TCP 与事件循环的开销 —— 那些是真机上量到的另一部分（见 Phase 1/3 真机数据）。
//
// 用法：
//   node tools/steam-egress-sim.cjs
//   node tools/steam-egress-sim.cjs --rates 512,1024,2048,5120 --quantums 512,4096,16384
//   node tools/steam-egress-sim.cjs --big 900 --small 64 --small-interval 20 --tick 4 --json out.json
const fs = require('node:fs');
const path = require('node:path');
const egress = require('../network/egress-queue.cjs');
const mux = require('../network/stream-mux.cjs');

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const eq = argv.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const listOf = (name, fallback) => argOf(name, fallback).split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);

const RATES_KB = listOf('--rates', '512,1024,2048,5120');   // KB/s（千字节/秒）
const QUANTUMS = listOf('--quantums', '512,4096,16384');    // 流间轮转量子（字节）
const BIG_KB = Number(argOf('--big', '900'));               // 大响应大小（KB）
const SMALL_BYTES = Number(argOf('--small', '64'));         // 小包载荷（字节）
const SMALL_INTERVAL_MS = Math.max(1, Number(argOf('--small-interval', '20')));
const TICK_MS = Math.max(1, Number(argOf('--tick', '4')));  // 回调节拍
const DURATION_MS = Math.max(SMALL_INTERVAL_MS * 2, Number(argOf('--duration', '4000')));
const JSON_OUT = argOf('--json', '');
const QUIET = argv.includes('--quiet');

const BIG_STREAM = 2;
const SMALL_STREAM = 3;

const percentile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const round2 = (n) => Number(n.toFixed(2));

/** 与 steam-adapter.cjs 的 frameOutKey 同一条规则：流号从帧头第 5 字节读。 */
function frameKey(frame, fairOn) {
  if (!fairOn) return null;
  if (!Buffer.isBuffer(frame) || frame.length < 9) return null;
  if (mux.isHello(frame)) return null;
  const streamId = frame.readUInt32BE(5);
  return streamId === 0 ? null : streamId;
}

/**
 * 跑一次：给定链路速率、调度模式与量子，返回测量结果。
 *
 * @param {{rateBytesPerMs:number, fairOn:boolean, quantum:number}} scenario
 */
function simulate({ rateBytesPerMs, fairOn, quantum }) {
  const peer = {};
  const bigFrames = mux.encodeDataChunks(BIG_STREAM, 1, Buffer.alloc(BIG_KB * 1024, 0x41));
  const bigBytes = bigFrames.reduce((sum, f) => sum + f.length, 0);
  const smallFrame = mux.encodeData(SMALL_STREAM, 1, Buffer.alloc(Math.max(1, SMALL_BYTES - 13), 0x2e));

  // 大响应一次性到齐（本地 socket 上的传输时间相对秒级链路可忽略）。
  for (const frame of bigFrames) egress.enqueue(peer, frame, frameKey(frame, fairOn), 0);

  const smallTotal = Math.floor(DURATION_MS / SMALL_INTERVAL_MS);
  const smallEnqueuedAt = [];
  const waits = [];
  let produced = 0;
  let smallAcceptedBytes = 0;
  let smallCompleted = 0;
  let now = 0;
  let credit = 0;
  let sentBytes = 0;
  let bigAccepted = 0;
  let segments = 0;
  let flushes = 0;
  let bigDoneAt = null;
  let queueBytesWhenFirstSmall = null;

  // 认小包靠**缓冲范围包含**，不靠段的队列 key：老调度（flat）下所有帧都进干道队列，
  // key 一律是 null，按 key 认会让整个老模式什么都量不到（首跑就是这么翻车的）。
  // 被量子截断的段是 subarray，与原帧共用同一个 ArrayBuffer 且范围落在原帧之内 ——
  // Node 的 Buffer 池不会让两个未释放的缓冲区范围重叠，所以这个判据是可靠的。
  const isSmallSeg = (buf) => buf === smallFrame
    || (buf.buffer === smallFrame.buffer
      && buf.byteOffset >= smallFrame.byteOffset
      && buf.byteOffset + buf.length <= smallFrame.byteOffset + smallFrame.length);

  while (now < 600000) {
    while (produced < smallTotal && (produced + 1) * SMALL_INTERVAL_MS <= now) {
      if (produced === 0) queueBytesWhenFirstSmall = egress.total(peer);
      egress.enqueue(peer, smallFrame, frameKey(smallFrame, fairOn), now);
      smallEnqueuedAt.push(now);
      produced += 1;
    }

    credit += rateBytesPerMs * TICK_MS;
    let budget = Math.floor(credit);
    if (budget > 0 && egress.total(peer) > 0) {
      const planInfo = egress.planOut(peer, quantum);
      segments += planInfo.plan.length;
      flushes += 1;
      let accepted = 0;
      let smallTaken = 0;
      for (const seg of planInfo.plan) {
        if (budget <= 0) break;
        const take = Math.min(seg.buf.length, budget);
        if (isSmallSeg(seg.buf)) {
          smallTaken += take;
          smallAcceptedBytes += take;
          while (smallAcceptedBytes >= smallFrame.length && smallCompleted < smallEnqueuedAt.length) {
            waits.push(now - smallEnqueuedAt[smallCompleted]);
            smallAcceptedBytes -= smallFrame.length;
            smallCompleted += 1;
          }
        }
        accepted += take;
        budget -= take;
      }
      if (accepted > 0) {
        egress.commit(peer, planInfo, accepted);
        credit -= accepted;
        sentBytes += accepted;
        // 这个模型里只有两个生产者（大响应 + 小包），所以"非小包就是大响应"是精确的，
        // 不必去猜哪一段属于大响应。
        bigAccepted += accepted - smallTaken;
        if (bigDoneAt === null && bigAccepted >= bigBytes) bigDoneAt = now;
      }
    }

    if (produced >= smallTotal && egress.total(peer) === 0) break;
    now += TICK_MS;
  }

  const sorted = [...waits].sort((a, b) => a - b);
  return {
    rateKBps: Math.round(rateBytesPerMs * 1000 / 1024),
    mode: fairOn ? 'fair' : 'flat',
    quantum: fairOn ? quantum : null,
    bigKB: BIG_KB,
    bigBytes,
    bigDoneMs: bigDoneAt,
    small: {
      n: sorted.length,
      p50Ms: sorted.length ? round2(percentile(sorted, 0.5)) : null,
      p95Ms: sorted.length ? round2(percentile(sorted, 0.95)) : null,
      maxMs: sorted.length ? round2(sorted[sorted.length - 1]) : null,
      meanMs: sorted.length ? round2(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null,
    },
    plans: { flushes, segments, segmentsPerFlush: flushes ? round2(segments / flushes) : 0 },
    queuedBytesBeforeFirstSmall: queueBytesWhenFirstSmall,
    simMs: now,
  };
}

const rows = [];
for (const rateKB of RATES_KB) {
  const rateBytesPerMs = rateKB * 1024 / 1000;
  rows.push(simulate({ rateBytesPerMs, fairOn: false, quantum: egress.DEFAULT_FAIR_QUANTUM }));
  for (const quantum of QUANTUMS) rows.push(simulate({ rateBytesPerMs, fairOn: true, quantum }));
}

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);
if (!QUIET) {
  console.log('出站公平调度 —— 限速模型对照（大响应 ' + BIG_KB + 'KB，小包 ' + SMALL_BYTES + 'B / ' + SMALL_INTERVAL_MS + 'ms，回调节拍 ' + TICK_MS + 'ms）');
  console.log('模型：真实 egress-queue.cjs + 真实帧头；不含 Steam / SDR / 丢包 / 事件循环开销。');
  console.log('');
  console.log(pad('限速', 10) + pad('模式', 12) + num('小包排队 p50', 14) + num('p95', 9) + num('最大', 9) + num('大响应完成', 13) + num('计划段/tick', 12));
  console.log('-'.repeat(79));
  for (const r of rows) {
    const mode = r.mode === 'flat' ? '老(0.14.2)' : `公平 q=${r.quantum}`;
    console.log(
      pad(`${r.rateKBps}KB/s`, 10) + pad(mode, 12)
      + num(`${r.small.p50Ms}ms`, 14) + num(`${r.small.p95Ms}ms`, 9) + num(`${r.small.maxMs}ms`, 9)
      + num(`${r.bigDoneMs}ms`, 13) + num(r.plans.segmentsPerFlush, 12),
    );
  }
  console.log('');
}

if (JSON_OUT) {
  const out = path.isAbsolute(JSON_OUT) ? JSON_OUT : path.join(__dirname, '..', JSON_OUT);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    at: new Date().toISOString(),
    model: {
      bigKB: BIG_KB, smallBytes: SMALL_BYTES, smallIntervalMs: SMALL_INTERVAL_MS,
      tickMs: TICK_MS, durationMs: DURATION_MS, ratesKBps: RATES_KB, quantums: QUANTUMS,
      note: '真机环回链路 400MB/s 量不出队列积压，故用限速模型量小包排队时延；排队/取队是真实 egress-queue.cjs。',
    },
    rows,
  }, null, 2), 'utf8');
  if (!QUIET) console.log('结果写入 ' + out);
}
