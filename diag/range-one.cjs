'use strict';
// 一次进程只发一个 Range 请求 = 每次都是全新连接，用来把"连接复用"这个变量排除掉。
// 用 node:http 的 agent:false 而不是 fetch —— undici 的连接池会偷偷复用，
// 而 Connection: close 这个头本身就会让服务端关连接，两个都会污染结论。
// 用法：node diag\range-one.cjs [端口] [路径] [字节数] [起点] [超时秒]
const http = require('node:http');
const PORT = Number(process.argv[2] || 3000);
const FILE = process.argv[3] || '/assets/local/map/autochess/TX_autochessi_D.png';
const SIZE = Number(process.argv[4] || 1310720);
const START = Number(process.argv[5] || 0);
const TIMEOUT_S = Number(process.argv[6] || 25);

const started = Date.now();
let got = 0;
let note = '';
let settled = false;

const finish = () => {
  if (settled) return;
  settled = true;
  const ms = Date.now() - started;
  const pct = ((got / SIZE) * 100).toFixed(1);
  console.log(
    `起点 ${String(START).padStart(8)}  要 ${String(SIZE).padStart(8)} B  收到 ${String(got).padStart(8)} B (${pct.padStart(5)}%)  `
    + `${String(ms).padStart(6)} ms  ${String((got / 1024 / (ms / 1000) || 0).toFixed(1)).padStart(8)} KiB/s  ${note}`,
  );
};

const req = http.get(
  { host: '127.0.0.1', port: PORT, path: FILE, agent: false, headers: { Range: `bytes=${START}-${START + SIZE - 1}` } },
  (res) => {
    note = `HTTP ${res.statusCode} · cl=${res.headers['content-length']}`;
    res.on('data', (chunk) => { got += chunk.length; });
    res.on('end', () => { note += ' · 正常结束'; finish(); });
    res.on('aborted', () => { note += ' · aborted'; finish(); });
    res.on('error', (err) => { note += ` · ✘ ${err.code || err.name}: ${err.message}`; finish(); });
  },
);
req.setTimeout(TIMEOUT_S * 1000, () => { note += ` · ✘ 超时 ${TIMEOUT_S}s`; req.destroy(); finish(); });
req.on('error', (err) => { note += ` · ✘ ${err.code || err.name}: ${err.message}`; finish(); });
