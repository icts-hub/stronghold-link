// 隧道体检：先验"字节流有没有被改坏"，再把连接按住不放，方便在界面上读 TELEMETRY。
// 用法: node diag\tunnel-check.cjs [端口] [按住秒数]
const crypto = require('node:crypto');
const PORT = Number(process.argv[2] || 3000);
const HOLD_SECONDS = Number(process.argv[3] || 180);
const ts = () => new Date().toISOString().slice(11, 23);

const PROBES = [
  '/',
  '/index.html',
  '/favicon.ico',
];

async function once(path) {
  const t0 = Date.now();
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { cache: 'no-cache' });
    const buf = Buffer.from(await r.arrayBuffer());
    const ms = Date.now() - t0;
    return {
      ok: true,
      status: r.status,
      len: buf.length,
      cl: r.headers.get('content-length') || '-',
      ce: r.headers.get('content-encoding') || '-',
      sha: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16),
      head: buf.subarray(0, 24).toString('latin1').replace(/[^\x20-\x7e]/g, '.'),
      ms,
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, err: (e.cause && (e.cause.code || e.cause.message)) || e.message };
  }
}

(async () => {
  console.log(`=== 完整性：同一个地址连取 3 次，哈希必须完全一样 ===`);
  for (const p of PROBES) {
    const rows = [];
    for (let i = 0; i < 3; i++) rows.push(await once(p));
    for (const [i, r] of rows.entries()) {
      console.log(r.ok
        ? `${ts()}  ${p}  #${i + 1}  HTTP ${r.status}  ${r.len} B  cl=${r.cl} ce=${r.ce}  ${r.ms}ms  sha=${r.sha}  「${r.head}」`
        : `${ts()}  ${p}  #${i + 1}  【失败】${r.ms}ms  ${r.err}`);
    }
    const good = rows.filter((r) => r.ok);
    const same = good.length > 1 && good.every((r) => r.sha === good[0].sha && r.len === good[0].len);
    console.log(`      → ${good.length}/${rows.length} 成功，${same ? '哈希一致（字节流没有被改坏）' : '★ 哈希不一致 = 传过来的字节被改了'}`);
  }

  console.log(`\n=== 按住连接 ${HOLD_SECONDS}s，供界面读 TELEMETRY ===`);
  const until = Date.now() + HOLD_SECONDS * 1000;
  let round = 0;
  while (Date.now() < until) {
    round += 1;
    const ctrl = new AbortController();
    const left = Math.min(until - Date.now(), 60000);
    const timer = setTimeout(() => ctrl.abort(), left);
    const t0 = Date.now();
    let got = 0;
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/assets/local/map/autochess/TX_autochessi_D.png`, { cache: 'no-cache', signal: ctrl.signal });
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
      }
      console.log(`${ts()}  第 ${round} 轮：传完 ${got} B / ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      const why = (e.cause && (e.cause.code || e.cause.message)) || e.name || e.message;
      console.log(`${ts()}  第 ${round} 轮：${((Date.now() - t0) / 1000).toFixed(1)}s 后断开，已收 ${got} B（${why}）`);
    } finally {
      clearTimeout(timer);
    }
    await new Promise((s) => setTimeout(s, 500));
  }
  console.log(`${ts()}  按住结束`);
})();
