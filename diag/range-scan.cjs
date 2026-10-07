'use strict';
// 用分段请求把"每条连接 / 每次请求能搬多少字节"卡到很窄的区间里。
// 关键设计：所有请求复用一个 keep-alive 连接（undici 默认就会复用），
// 这样"累计预算"和"单次预算"能被区分开。
// 用法：node diag\range-scan.cjs [端口] [路径] [秒数] [size1,size2,...]
const PORT = Number(process.argv[2] || 3000);
const FILE = process.argv[3] || '/assets/local/map/autochess/TX_autochessi_D.png';
const TIMEOUT_S = Number(process.argv[4] || 30);
const SIZES = (process.argv[5] || '921600,921600,1310720,1458176,1507328')
  .split(',').map((s) => Number(s.trim())).filter((n) => n > 0);

const url = `http://127.0.0.1:${PORT}${FILE}`;
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';

let offset = 0;
let cumulativeAsked = 0;
let cumulativeGot = 0;

(async () => {
  console.log(`复用同一个 keep-alive 连接，向 ${url} 连发 ${SIZES.length} 段请求：\n`);
  for (const size of SIZES) {
    const start = offset;
    const end = offset + size - 1;
    const started = Date.now();
    let got = 0;
    let note = '';
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(TIMEOUT_S * 1000) });
      const buf = Buffer.from(await res.arrayBuffer());
      got = buf.length;
      note = `HTTP ${res.status}`;
    } catch (err) {
      const cause = err && err.cause ? ` / cause=${err.cause.code || err.cause.message}` : '';
      note = `✘ ${err.name}: ${err.message}${cause}`;
    }
    const ms = Date.now() - started;
    cumulativeAsked += size;
    cumulativeGot += got;
    const pct = ((got / size) * 100).toFixed(1);
    console.log(
      `${stamp()}  要 ${String(size).padStart(8)} B (${start}~${end})  收到 ${String(got).padStart(8)} B (${pct.padStart(5)}%)  `
      + `${String(ms).padStart(6)} ms  ${String((got / 1024 / (ms / 1000) || 0).toFixed(1)).padStart(8)} KiB/s  ${note}`,
    );
    console.log(`${' '.repeat(8)}累计：要 ${(cumulativeAsked / 1024).toFixed(0)} KiB · 拿到 ${(cumulativeGot / 1024).toFixed(0)} KiB`);
    offset = end + 1;
    if (got < size) { console.log(`\n第 ${SIZES.indexOf(size) + 1} 段没拿全，后面的段没意义，停。`); break; }
  }
})();
