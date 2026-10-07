// 现场延迟探针：连打 N 次同一个小路径，分别记 首字节/完成 时间，看是"每次都慢"还是"第一次慢"。
// 用法: node diag\latency.cjs [端口] [路径] [次数]
const PORT = Number(process.argv[2] || 3000);
const PATH_ = process.argv[3] || '/';
const N = Number(process.argv[4] || 5);
const ts = () => new Date().toISOString().slice(11, 23);

(async () => {
  for (let i = 1; i <= N; i++) {
    const t0 = Date.now();
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}${PATH_}`, { cache: 'no-cache' });
      const tHead = Date.now() - t0;
      let got = 0;
      let tFirst = 0;
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!got) tFirst = Date.now() - t0;
        got += value.length;
      }
      const tEnd = Date.now() - t0;
      console.log(`${ts()}  #${i}  HTTP ${r.status}  首字节 ${tFirst || tHead}ms  头 ${tHead}ms  完成 ${tEnd}ms  ${got} B  ${(got / 1024 / (tEnd / 1000)).toFixed(1)} KiB/s  cl=${r.headers.get('content-length') || '-'} ce=${r.headers.get('content-encoding') || '-'}`);
    } catch (e) {
      console.log(`${ts()}  #${i}  【断流】${Date.now() - t0}ms  ${e.message}  ${e.cause ? e.cause.message || e.cause.code : ''}`);
    }
  }
})();
