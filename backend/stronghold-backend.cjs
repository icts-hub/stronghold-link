'use strict';
// Stronghold Link 后端常驻进程（QML 版专用，**不依赖 Electron**）。
//
// 协议：stdin / stdout 走 JSON Lines，一行一条消息。
//   {"type":"request","id":17,"method":"session.start","params":{...}}
//   {"type":"response","id":17,"ok":true,"result":{...}}
//   {"type":"response","id":17,"ok":false,"error":{"code":"EPORTINUSE","message":"端口已被占用"}}
//   {"type":"event","name":"session.event","payload":{...}}
//
// 硬性约定（对应 QML 迁移提示词 §4.2）：
//   · **stdout 只许协议 JSONL**：横幅、诊断、异常栈统统走 stderr 或 startup.log；
//   · 请求可以并发：响应按完成顺序写出，靠 id 配对；
//   · 未知方法 → EUNDEFINED；畸形 JSON → EBADJSON；空行忽略；单行上限 1 MiB → ELINETOOLONG；
//   · 后端内部异常不得让前端干等：兜底捕获 → 写出 backend.error 事件后退出，让前端如实报错；
//   · 单实例保护：配置目录里的 backend.lock 记 pid，已有活着的实例就拒绝启动；
//   · 优雅停机：app.shutdown 或 stdin 关闭 / SIGTERM / SIGINT → 停会话、放端口、清锁文件再退出。

const readline = require('node:readline');
const path = require('node:path');
const fs = require('node:fs');

const MAX_LINE_BYTES = 1024 * 1024;
const pkg = require('../package.json');
const { createBusiness } = require('./business.cjs');

function resolveConfigDir(env) {
  return path.resolve(env.SHL_CONFIG_DIR || path.join(env.APPDATA || path.join(__dirname, '..'), 'stronghold-link'));
}

function createBackend({ env = process.env, stdout = process.stdout, stderr = process.stderr, configDir = null } = {}) {
  const dataDir = configDir || resolveConfigDir(env);
  const lockPath = path.join(dataDir, 'backend.lock');
  let lockOwned = false;
  let shuttingDown = false;

  const write = (obj) => { stdout.write(`${JSON.stringify(obj)}\n`); };
  const diag = (text) => { try { stderr.write(`[backend] ${text}\n`); } catch { /* 忽略 */ } };

  const respond = (id, result) => write({ type: 'response', id: id == null ? null : id, ok: true, result });
  const respondError = (id, code, message) => write({
    type: 'response',
    id: id == null ? null : id,
    ok: false,
    error: { code, message },
  });

  // ---------------------------------------------------------- 单实例保护

  function acquireLock() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      if (fs.existsSync(lockPath)) {
        const raw = fs.readFileSync(lockPath, 'utf8');
        const oldPid = Number((JSON.parse(raw) || {}).pid);
        if (Number.isInteger(oldPid) && oldPid > 0 && oldPid !== process.pid) {
          let alive = false;
          try { process.kill(oldPid, 0); alive = true; } catch { alive = false; }
          if (alive) return { ok: false, pid: oldPid };
        }
      }
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, version: pkg.version, at: Date.now() }), 'utf8');
      lockOwned = true;
      return { ok: true };
    } catch (err) {
      // 锁文件写不了不算致命：单实例保护是尽力而为，不能因此拒绝启动。
      diag(`锁文件不可用：${err && err.message ? err.message : err}`);
      return { ok: true, degraded: true };
    }
  }

  function releaseLock() {
    if (!lockOwned) return;
    try { fs.rmSync(lockPath, { force: true }); } catch { /* 忽略 */ }
    lockOwned = false;
  }

  // ------------------------------------------------------------ 业务

  const business = createBusiness({
    appDir: path.join(__dirname, '..'),
    configDir: dataDir,
    env,
    log: diag,
    onEvent: (name, payload) => write({ type: 'event', name, payload: payload == null ? null : payload }),
  });

  // ------------------------------------------------------------ 生命周期

  let exitAfterFlush = null;
  function flushAndExit(code) {
    if (exitAfterFlush) return;
    exitAfterFlush = setTimeout(() => process.exit(code), 2000);
    try {
      stdout.write('', () => {
        clearTimeout(exitAfterFlush);
        process.exit(code);
      });
    } catch {
      process.exit(code);
    }
  }

  async function shutdown(reason, code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    diag(`停机（${reason}）`);
    try { await business.shutdown(); } catch (err) { diag(`停机时出错：${err && err.message ? err.message : err}`); }
    releaseLock();
    flushAndExit(code);
  }

  // ------------------------------------------------------------ 协议

  async function handleMessage(msg) {
    const id = (typeof msg.id === 'number' || typeof msg.id === 'string') ? msg.id : null;
    const method = typeof msg.method === 'string' ? msg.method : '';
    if (!method) {
      respondError(id, 'EBADREQUEST', 'method 必须是非空字符串');
      return;
    }
    if (method === 'app.shutdown' || method === 'backend.shutdown') {
      respond(id, { ok: true, stopping: true });
      await shutdown('app.shutdown', 0);
      return;
    }
    if (method === 'backend.ping') {
      respond(id, { ok: true, version: pkg.version, pid: process.pid, uptimeMs: Math.round(process.uptime() * 1000) });
      return;
    }
    try {
      const result = await business.dispatch(method, msg.params);
      respond(id, result === undefined ? null : result);
    } catch (err) {
      const code = (err && err.code) || 'EINTERNAL';
      const message = (err && (err.friendly || err.message)) || '后端内部错误';
      diag(`方法 ${method} 失败：${code} ${message}`);
      respondError(id, code, message);
    }
  }

  async function handleLine(line) {
    const text = String(line == null ? '' : line);
    if (!text.trim()) return;                       // 空行忽略（不报错，也不当请求）
    if (Buffer.byteLength(text, 'utf8') > MAX_LINE_BYTES) {
      respondError(null, 'ELINETOOLONG', `单行请求超过 ${MAX_LINE_BYTES} 字节上限`);
      return;
    }
    let msg = null;
    try {
      msg = JSON.parse(text);
    } catch {
      respondError(null, 'EBADJSON', '请求不是合法 JSON');
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      respondError(null, 'EBADREQUEST', '请求必须是 JSON 对象');
      return;
    }
    if (msg.type !== 'request') {
      respondError(msg.id == null ? null : msg.id, 'EBADREQUEST', '只接受 type=request 的消息');
      return;
    }
    await handleMessage(msg);
  }

  function attach(input) {
    const rl = readline.createInterface({ input, terminal: false });
    rl.on('line', (line) => { handleLine(line).catch((err) => diag(`处理请求时异常：${err && err.message ? err.message : err}`)); });
    rl.on('close', () => { shutdown('stdin-closed').catch(() => flushAndExit(0)); });
    return rl;
  }

  function installCrashHandlers() {
    process.on('uncaughtException', (err) => {
      diag(`未捕获异常：${err && err.stack ? err.stack : err}`);
      try { write({ type: 'event', name: 'backend.error', payload: { code: 'ECRASH', message: String(err && err.message ? err.message : err) } }); } catch { /* 忽略 */ }
      releaseLock();
      flushAndExit(1);
    });
    process.on('unhandledRejection', (reason) => {
      diag(`未处理的 Promise 拒绝：${reason && reason.stack ? reason.stack : reason}`);
      try { write({ type: 'event', name: 'backend.error', payload: { code: 'EREJECTION', message: String(reason && reason.message ? reason.message : reason) } }); } catch { /* 忽略 */ }
      releaseLock();
      flushAndExit(1);
    });
    process.on('SIGINT', () => { shutdown('SIGINT').catch(() => flushAndExit(0)); });
    process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => flushAndExit(0)); });
    process.on('exit', releaseLock);
  }

  return {
    dataDir,
    lockPath,
    business,
    acquireLock,
    releaseLock,
    attach,
    installCrashHandlers,
    shutdown,
    handleLine,
    handleMessage,
    get shuttingDown() { return shuttingDown; },
  };
}

function main() {
  const backend = createBackend({});
  const lock = backend.acquireLock();
  if (!lock.ok) {
    // stdout 也可能没人读；这里仍按协议形状写一行错误事件，前端据此如实报错。
    process.stdout.write(`${JSON.stringify({
      type: 'event',
      name: 'backend.error',
      payload: { code: 'EINSTANCE', message: `已经有后端实例在运行（pid ${lock.pid}）` },
    })}\n`);
    process.stderr.write(`[backend] 已有实例 pid=${lock.pid}，本次启动退出\n`);
    process.exit(3);
  }
  backend.installCrashHandlers();
  backend.attach(process.stdin);
  process.stderr.write(`[backend] 就绪 version=${pkg.version} pid=${process.pid} config=${backend.dataDir}\n`);
}

if (require.main === module) main();

module.exports = { createBackend, resolveConfigDir, MAX_LINE_BYTES };
