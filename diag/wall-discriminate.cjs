// 判别：这堵墙是「按连接寿命」还是「按单次请求时长」？
// 手法：在同一条 keep-alive 连接上，先要一个 1 KB 的小文件，等 6 秒，再要那个 3.14 MiB 的大文件。
//   若大文件在约 2 秒后被杀 → 从【连接建立】算起的 8 秒墙（说明有个按连接的定时器没清）。
//   若大文件跑满约 7.5 秒才被杀 → 按【单次请求】算的墙。
const http = require('node:http');

const AGENT = new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
const SMALL = '/js/render/app.js';
const BIG = '/assets/local/map/autochess/TX_autochessi_D.png';

let t0 = 0;
function req(path, label) {
  return new Promise((resolve) => {
    const started = Date.now();
    let got = 0, status = 0, total = 0;
    const r = http.get({ host: '127.0.0.1', port: 3000, path, agent: AGENT, headers: { 'cache-control': 'no-cache' } }, (res) => {
      status = res.statusCode;
      total = Number(res.headers['content-length'] || 0);
      res.on('data', (c) => { got += c.length; });
      res.on('end', () => { console.log(`  ${label}: 【结束】HTTP ${status} 读到 ${got}/${total} B，用时 ${Date.now() - started} ms（连接已建立 ${Date.now() - t0} ms）`); resolve(); });
      res.on('aborted', () => console.log(`  ${label}: 【aborted】读到 ${got} B，用时 ${Date.now() - started} ms`));
      res.on('close', () => resolve());
    });
    r.on('socket', (s) => {
      if (!t0) t0 = Date.now();
      s.on('close', () => console.log(`  ${label}: socket close（读到 ${got} B，用时 ${Date.now() - started} ms）`));
    });
    r.on('error', (e) => { console.log(`  ${label}: 【错误】${e.code} ${e.message}，读到 ${got} B，用时 ${Date.now() - started} ms（连接已建立 ${Date.now() - t0} ms）`); resolve(); });
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('--- 复现实验 A：连着下两次大文件（第 2 次从连接建立算起已过若干秒）---');
  await req(BIG, 'A-第1次大文件');
  await req(BIG, 'A-第2次大文件');

  t0 = 0;
  console.log('\n--- 判别实验 B：小文件 → 等 6 秒 → 大文件（同一条 keep-alive 连接）---');
  await req(SMALL, 'B-小文件');
  console.log('  （等 6 秒，连接保持空闲）');
  await sleep(6000);
  await req(BIG, 'B-大文件');
  AGENT.destroy();
})();
