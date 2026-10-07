'use strict';
// 像浏览器一样把一个页面连带它的资源全拉一遍，看是哪一条卡住。
// 用法：node diag\page-load.cjs [端口] [路径] [每条超时秒数]
const PORT = Number(process.argv[2] || 3000);
const PATH = process.argv[3] || '/';
const TIMEOUT_S = Number(process.argv[4] || 20);
const BASE = `http://127.0.0.1:${PORT}`;

const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';

async function grab(url, label) {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_S * 1000) });
    const buf = Buffer.from(await res.arrayBuffer());
    const ms = Date.now() - started;
    const rate = ms > 0 ? (buf.length / 1024 / (ms / 1000)).toFixed(1) : '-';
    console.log(`${stamp()}  ✔ ${res.status}  ${String(buf.length).padStart(9)} B  ${String(ms).padStart(7)} ms  ${String(rate).padStart(9)} KiB/s  ${label}`);
    return { ok: res.ok, body: buf, type: res.headers.get('content-type') || '', len: buf.length };
  } catch (err) {
    const ms = Date.now() - started;
    const cause = err && err.cause ? ` / cause=${err.cause.code || err.cause.message}` : '';
    console.log(`${stamp()}  ✘ ${String(ms).padStart(7)} ms  ${label}  ->  ${err.name}: ${err.message}${cause}`);
    return { ok: false, body: Buffer.alloc(0), type: '', len: 0 };
  }
}

(async () => {
  console.log(`目标 ${BASE}${PATH} · 每条超时 ${TIMEOUT_S}s`);
  const page = await grab(BASE + PATH, '页面本体');
  if (!page.ok) { console.log('页面本身就没拿到，后面的不用试了。'); process.exit(1); }

  const html = page.body.toString('utf8');
  const refs = new Set();
  for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const u = m[1];
    if (/^(https?:|data:|#|mailto:|javascript:)/i.test(u)) continue;
    refs.add(u.startsWith('/') ? u : '/' + u.replace(/^\.\//, ''));
  }
  const list = [...refs];
  console.log(`\n页面里引用 ${list.length} 个资源，逐个拉（串行，模拟"一条不通就转圈"）：\n`);

  let okBytes = 0;
  let bad = 0;
  for (const u of list) {
    const r = await grab(BASE + u, u);
    if (r.ok) okBytes += r.len; else bad += 1;
  }
  console.log(`\n合计：成功 ${list.length - bad}/${list.length} 个 · 共 ${(okBytes / 1024).toFixed(1)} KiB · 卡住或失败 ${bad} 个`);
})();
