'use strict';
// Steam 待发可靠数据背压的确定性模型单测（0.14.4）：
//   策略/场景定义形状 / 同参数可复现 / 生产=送达+在途 的完整性守恒 /
//   0.14.3 从不暂停 / 双水位把待发压在"高水位 + 一个读批次"以内且不丢吞吐 /
//   滞回不抖 / 生产端低于链路速率时完全不介入 / 丢包只重传不丢数据 /
//   生产端容量截断不产生凭空字节 / B 的排队时间门确实改变恢复时机 / C 会重算水位。
// 全程纯内存与确定性 tick，不碰真实 Steam、socket 与定时器。

const test = require('node:test');
const assert = require('node:assert/strict');

const model = require('../tools/steam-backpressure-model.cjs');
const { simulateBackpressure, SCHEMES, SCENARIOS, KB, READ_BYTES_PER_TICK } = model;

const schemeById = (id) => SCHEMES.find((s) => s.id === id);
const scenarioById = (id) => SCENARIOS.find((s) => s.id === id);

/** 跑某策略在某场景下的一次实验（策略与场景都按定义取参数）。 */
function run(schemeId, scenarioId, extra = {}) {
  const sch = schemeById(schemeId);
  const sc = scenarioById(scenarioId);
  return simulateBackpressure({
    scheme: sch.id,
    backlogHigh: sch.backlogHigh,
    queueLowMs: sch.queueLowMs,
    ...sc.options,
    ...extra,
  });
}

test('策略与场景定义：id 唯一、都有非空 label、默认高水位 256KiB', () => {
  const ids = SCHEMES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, '策略 id 不重复');
  assert.ok(ids.includes('off') && ids.includes('A') && ids.includes('B') && ids.includes('C'), '四种候选都在');
  for (const s of SCHEMES) assert.ok(typeof s.label === 'string' && s.label.length > 0, `${s.id} 有 label`);

  const scIds = SCENARIOS.map((s) => s.id);
  assert.equal(new Set(scIds).size, scIds.length, '场景 id 不重复');
  for (const s of SCENARIOS) assert.ok(s.options && typeof s.options === 'object', `${s.id} 有 options`);

  const dflt = simulateBackpressure({ scheme: 'A', durationMs: 400 });
  assert.equal(dflt.params.highKB, 256, '不传 backlogHigh 时默认 256KiB');
  assert.equal(dflt.params.lowKB, 64, '默认低水位是高水位的 1/4');
});

test('确定性：同参数两次运行结果完全一致', () => {
  const a = run('A', 'heavy');
  const b = run('A', 'heavy');
  assert.deepEqual(a, b, '固定种子的模型必须可复现');
  const l1 = run('A', 'lossy');
  const l2 = run('A', 'lossy');
  assert.deepEqual(l1, l2, '带丢包重传的场景同样可复现');
});

test('完整性守恒：全部场景 × 全部策略都满足 生产 = 送达 + 仍留在管道里', () => {
  const checked = ['heavy', 'sustained', 'burst900', 'slow', 'lossy', 'cap'];
  for (const scId of checked) {
    for (const sch of SCHEMES) {
      const r = run(sch.id, scId);
      assert.equal(r.integrity.lostBytes, 0, `${scId}/${sch.id} 不允许有字节凭空消失`);
      assert.equal(r.integrity.balanced, true, `${scId}/${sch.id} 完整性账必须平`);
      assert.equal(
        r.integrity.producedBytes,
        r.integrity.deliveredBytes + r.integrity.bufferedBytes,
        `${scId}/${sch.id} 生产 = 送达 + 在途/缓冲`,
      );
    }
  }
});

test('0.14.3（off）：从不暂停、从不翻转，重负载下待发堆到 Steam 缓冲上限', () => {
  const off = run('off', 'heavy');
  assert.equal(off.pauseRatio, 0, '旧行为没有任何暂停');
  assert.equal(off.flips, 0, '旧行为没有任何翻转');
  assert.ok(off.pending.peakKB >= 1900, `旧行为会把 2MiB 的 Steam 缓冲灌满（实测峰值 ${off.pending.peakKB}KB）`);
  assert.ok(off.pending.p95KB > 1000, `旧行为待发 p95 上千 KB（实测 ${off.pending.p95KB}KB）`);
  assert.ok(off.limitExceeded > 0, '灌满后 sendMessage 被拒并被记账');
});

test('A 双水位：高水位触发暂停，待发峰值不超过"高水位 + 一个读批次"', () => {
  const a = run('A', 'heavy');
  const bound = (256 * KB + READ_BYTES_PER_TICK) / KB;
  assert.ok(a.flips > 0, '高水位到点必须暂停');
  assert.ok(a.pauseRatio > 0.5, `重负载下大部分 tick 处于暂停（实测 ${a.pauseRatio}）`);
  assert.ok(a.pending.peakKB <= bound, `峰值得在高水位+一个读批次以内（${a.pending.peakKB} <= ${bound}）`);
  assert.ok(a.pending.peakKB > 256, '峰值应当确实摸到过高水位，否则说明根本没触发');
});

test('A 双水位：p95 与峰值都明显低于 0.14.3，且吞吐不下降', () => {
  const off = run('off', 'heavy');
  const a = run('A', 'heavy');
  assert.ok(a.pending.p95KB < off.pending.p95KB * 0.5, '待发 p95 至少砍半');
  assert.ok(a.move.p95Ms < off.move.p95Ms, '移动包 p95 延迟必须下降');
  assert.ok(a.throughputKBps >= off.throughputKBps * 0.99, '吞吐不许因为背压下降');
});

test('滞回：固定水位的策略不会每 tick 反复翻转（自适应策略抖动更多）', () => {
  for (const id of ['A', 'A128', 'A512', 'B']) {
    const r = run(id, 'heavy');
    const seconds = r.simMs / 1000;
    assert.ok(r.flips <= 6 * seconds, `${id} 重负载下翻转次数应受限（实测 ${r.flips} 次 / ${seconds}s）`);
  }
  const a512 = run('A512', 'heavy');
  const a128 = run('A128', 'heavy');
  assert.ok(a512.flips < a128.flips, '水位越高、翻转越少（滞回宽度的直接体现）');
  const c = run('C', 'heavy');
  const a = run('A', 'heavy');
  assert.ok(c.flips > a.flips, `C 按 1Hz 重算水位，翻转明显多于固定水位 A（${c.flips} > ${a.flips}）`);
});

test('生产端低于链路速率时，背压完全不介入（与 0.14.3 逐项相同）', () => {
  const off = run('off', 'slow');
  assert.equal(off.pending.peakKB, 0.78, '慢生产端下 Steam 缓冲几乎为空');
  for (const sch of SCHEMES) {
    const r = run(sch.id, 'slow');
    assert.equal(r.pauseRatio, 0, `${sch.id} 不应暂停`);
    assert.equal(r.flips, 0, `${sch.id} 不应翻转`);
    assert.equal(r.pending.p95KB, off.pending.p95KB, `${sch.id} 待发与旧行为一致`);
    assert.equal(r.move.p95Ms, off.move.p95Ms, `${sch.id} 延迟与旧行为一致`);
  }
});

test('丢包场景：只重传不丢数据，完整性仍然平', () => {
  const a = run('A', 'lossy');
  assert.ok(a.loss.events > 0, '2% 丢包应当真的发生重传');
  assert.ok(a.loss.retriedKB > 0, '重传字节要被记账');
  assert.equal(a.integrity.lostBytes, 0, '重传不能变成丢数据');
  assert.equal(a.integrity.balanced, true, '丢包链路下账也要平');
});

test('生产端容量截断：被抑制的字节不产生，也不计入送达', () => {
  const cap = run('A', 'cap');
  assert.ok(cap.suppressedKB > 0, '超过生产端缓冲的突发必须被截断');
  assert.equal(cap.integrity.lostBytes, 0, '截断的字节从未产生，不算丢失');
  assert.ok(cap.pending.peakKB <= (256 * KB + READ_BYTES_PER_TICK) / KB, '峰值同样被压在高水位附近');
});

test('B 的排队时间门：门越严越难恢复（翻转更少、暂停更久）', () => {
  const loose = run('B', 'heavy', { queueLowMs: 1e9 });
  const strict = run('B', 'heavy', { queueLowMs: 0 });
  const a = run('A', 'heavy');
  assert.equal(loose.flips, a.flips, '门宽到失效时 B 等价于 A');
  assert.equal(loose.pauseRatio, a.pauseRatio, '门宽到失效时暂停占比也相同');
  assert.ok(strict.flips <= loose.flips, `门严时恢复更少（${strict.flips} <= ${loose.flips}）`);
  assert.ok(strict.pauseRatio >= loose.pauseRatio, `门严时暂停更久（${strict.pauseRatio} >= ${loose.pauseRatio}）`);
});

test('C 自适应：按实测速率重算水位，不再是固定 256KiB', () => {
  const c = run('C', 'heavy');
  assert.notEqual(c.params.highKB, 256, 'C 必须自适应改水位');
  assert.ok(c.params.highKB >= 64 && c.params.highKB <= 1024, `水位被夹在 64KiB~1024KiB（实测 ${c.params.highKB}KB）`);
  assert.equal(c.params.lowKB, Math.max(4, Math.round(c.params.highKB / 4)), '低水位保持高水位的 1/4');
  assert.ok(c.integrity.balanced, '自适应策略同样不许丢字节');
});
