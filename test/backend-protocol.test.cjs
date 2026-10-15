'use strict';
// 后端 JSONL 协议契约测试（Phase 2）。
//
// 覆盖提示词 §4.2 要求：并发请求 id 配对、未知方法、畸形/超长行、空行忽略、
// stdout 只许协议 JSONL、后端崩溃上报、优雅停机、重复实例保护。

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const BACKEND = path.join(__dirname, '..', 'backend', 'stronghold-backend.cjs');
const { createBackend, MAX_LINE_BYTES } = require('../backend/stronghold-backend.cjs');

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `shl-backend-${label}-`));
}

/** 假 stdout：把写进来的字节按行收集，方便断言"这一行是不是协议 JSONL"。 */
function fakeStream() {
  const chunks = [];
  return {
    write(text, cb) { chunks.push(String(text)); if (typeof cb === 'function') cb(); return true; },
    text: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').filter((l) => l.length > 0),
    json: () => chunks.join('').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l)),
  };
}

function makeBackend(label) {
  const dir = tempDir(label);
  const out = fakeStream();
  const err = fakeStream();
  const backend = createBackend({ stdout: out, stderr: err, configDir: dir, env: { ...process.env, SHL_CONFIG_DIR: dir } });
  return { backend, out, err, dir };
}

const waitFor = async (fn, timeoutMs = 5000) => {
  const started = Date.now();
  for (;;) {
    const hit = await fn();
    if (hit) return hit;
    if (Date.now() - started > timeoutMs) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 20));
  }
};

// ------------------------------------------------------------------ 进程内

test('协议：请求 → 响应，id 原样带回，result 直接给前端用', async () => {
  const { backend, out } = makeBackend('basic');
  await backend.handleLine(JSON.stringify({ type: 'request', id: 17, method: 'backend.ping', params: {} }));
  const [msg] = out.json();
  assert.equal(msg.type, 'response');
  assert.equal(msg.id, 17);
  assert.equal(msg.ok, true);
  assert.equal(typeof msg.result.version, 'string');
});

test('协议：并发请求按完成顺序写出，靠 id 配对（不许串号）', async () => {
  const { backend, out } = makeBackend('concurrent');
  // 两个请求同时发出：快的那个先回，但 id 必须各归各位。
  await Promise.all([
    backend.handleLine(JSON.stringify({ type: 'request', id: 'slow', method: 'app.info', params: {} })),
    backend.handleLine(JSON.stringify({ type: 'request', id: 'fast', method: 'backend.ping', params: {} })),
  ]);
  const byId = new Map(out.json().map((m) => [m.id, m]));
  assert.equal(byId.size, 2);
  assert.equal(byId.get('slow').result.backend, 'stronghold-backend');
  assert.equal(byId.get('fast').result.ok, true);
  // 每个响应都是完整一行 JSON，没有半行粘连
  assert.equal(out.lines().every((l) => { JSON.parse(l); return true; }), true);
});

test('协议：未知方法报 EUNDEFINED，不许静默当成功', async () => {
  const { backend, out } = makeBackend('unknown');
  await backend.handleLine(JSON.stringify({ type: 'request', id: 1, method: 'session.launch', params: {} }));
  const [msg] = out.json();
  assert.equal(msg.ok, false);
  assert.equal(msg.error.code, 'EUNDEFINED');
  assert.match(msg.error.message, /session\.launch/);
});

test('协议：畸形 JSON 报 EBADJSON，且不影响后续请求', async () => {
  const { backend, out } = makeBackend('badjson');
  await backend.handleLine('{"type":"request", id:3, method:');
  await backend.handleLine(JSON.stringify({ type: 'request', id: 4, method: 'backend.ping', params: {} }));
  const msgs = out.json();
  assert.equal(msgs[0].ok, false);
  assert.equal(msgs[0].error.code, 'EBADJSON');
  assert.equal(msgs[0].id, null);
  assert.equal(msgs[1].id, 4);
  assert.equal(msgs[1].ok, true);
});

test('协议：超长行报 ELINETOOLONG（1 MiB 上限），不把内存吃满', async () => {
  const { backend, out } = makeBackend('toolong');
  const huge = `{"type":"request","id":9,"method":"backend.ping","params":{"pad":"${'x'.repeat(MAX_LINE_BYTES)}"}}`;
  await backend.handleLine(huge);
  const [msg] = out.json();
  assert.equal(msg.ok, false);
  assert.equal(msg.error.code, 'ELINETOOLONG');
  assert.equal(msg.id, null);
});

test('协议：空行忽略；type 不是 request 报 EBADREQUEST', async () => {
  const { backend, out } = makeBackend('shape');
  await backend.handleLine('');
  await backend.handleLine('   ');
  assert.equal(out.lines().length, 0, '空行不该产生任何输出');
  await backend.handleLine(JSON.stringify({ type: 'event', id: 5, method: 'x' }));
  const [msg] = out.json();
  assert.equal(msg.ok, false);
  assert.equal(msg.error.code, 'EBADREQUEST');
  assert.equal(msg.id, 5);
});

test('协议：method 不是字符串 → EBADREQUEST；响应里 id 为 null 也不许崩', async () => {
  const { backend, out } = makeBackend('method');
  await backend.handleLine(JSON.stringify({ type: 'request', id: 6, method: 42 }));
  const [msg] = out.json();
  assert.equal(msg.ok, false);
  assert.equal(msg.error.code, 'EBADREQUEST');
  assert.equal(msg.id, 6);
});

test('业务：app.info 的版本号与 package.json 同源，配置目录在 %APPDATA%\\stronghold-link 形状下', async () => {
  const { backend } = makeBackend('info');
  const info = await backend.business.dispatch('app.info', {});
  const pkg = require('../package.json');
  assert.equal(info.version, pkg.version);
  assert.equal(info.configDir, backend.dataDir);
  assert.match(info.logFile, /startup\.log$/);
  assert.match(info.settingsFile, /settings\.json$/);
});

test('业务：settings.save → settings.load 往返一致，并且真的落盘', async () => {
  const { backend, dir } = makeBackend('settings');
  const saved = await backend.business.dispatch('settings.save', { transport: 'relay' });
  assert.equal(saved.transport, 'relay');
  assert.equal(saved.effectiveLabel, '强制中继');
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(raw.transport, 'relay');
  const loaded = await backend.business.dispatch('settings.load', {});
  assert.equal(loaded.transport, 'relay');
});

test('业务：非法 transport 落回默认值（不写脏数据）', async () => {
  const { backend, dir } = makeBackend('settings-bad');
  const saved = await backend.business.dispatch('settings.save', { transport: 'warp-drive' });
  assert.equal(saved.transport, 'env');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).transport, 'env');
});

test('业务：会话参数白名单 —— 多余字段被丢掉，netConfig 由后端注入（前端改不了线路）', async () => {
  const { backend } = makeBackend('sanitize');
  await backend.business.dispatch('settings.save', { transport: 'ice' });
  const { session } = backend.business._internals;
  let seen = null;
  session.start = async (input) => { seen = input; return { role: input.role, state: 'running', config: input, channels: [] }; };
  await backend.business.dispatch('session.start', { role: 'host', relayPort: 25565, evil: 'nope', netConfig: { transport: 'relay' } });
  assert.equal(seen.evil, undefined);
  assert.equal(seen.netConfig.transport, 'ice');
  assert.equal(seen.relayPort, 25565);
});

test('业务：会话参数非法时抛可读错误（带 code，供前端直接显示）', async () => {
  const { backend } = makeBackend('sanitize-bad');
  await assert.rejects(() => backend.business.dispatch('session.start', { role: 'host', rules: [] }), (err) => {
    assert.equal(err.code, 'EINPUT');
    assert.match(err.friendly, /端口规则/);
    return true;
  });
});

// ------------------------------------------------------------ 独立进程

function startBackend(dir) {
  const child = spawn(process.execPath, [BACKEND], {
    env: { ...process.env, SHL_CONFIG_DIR: dir, ELECTRON_RUN_AS_NODE: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  let buffered = '';
  child.stdout.on('data', (buf) => {
    buffered += buf.toString('utf8');
    let idx = buffered.indexOf('\n');
    while (idx >= 0) {
      const line = buffered.slice(0, idx);
      buffered = buffered.slice(idx + 1);
      if (line.trim()) stdout.push(line);
      idx = buffered.indexOf('\n');
    }
  });
  child.stderr.on('data', (buf) => stderr.push(buf.toString('utf8')));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
  return { child, stdout, stderr, exited, send };
}

test('进程：真实子进程里 stdout 每一行都是协议 JSONL，诊断只走 stderr', async () => {
  const dir = tempDir('proc');
  const proc = startBackend(dir);
  try {
    await waitFor(() => proc.stderr.join('').includes('就绪'));
    proc.send({ type: 'request', id: 1, method: 'app.info', params: {} });
    await waitFor(() => proc.stdout.length >= 1);
    const msg = JSON.parse(proc.stdout[0]);
    assert.equal(msg.type, 'response');
    assert.equal(msg.id, 1);
    assert.equal(msg.ok, true);
    // stdout 里不能出现横幅/日志字样
    assert.equal(proc.stdout.every((l) => /^\{"type":"(response|event)"/.test(l)), true);
    assert.match(proc.stderr.join(''), /\[backend\]/);
  } finally {
    proc.child.kill();
    await proc.exited;
  }
});

test('进程：app.shutdown 先回响应再优雅退出（退出码 0），并清掉锁文件', async () => {
  const dir = tempDir('shutdown');
  const proc = startBackend(dir);
  await waitFor(() => proc.stderr.join('').includes('就绪'));
  const lock = path.join(dir, 'backend.lock');
  assert.equal(fs.existsSync(lock), true, '启动后应当有锁文件');
  proc.send({ type: 'request', id: 42, method: 'app.shutdown', params: {} });
  const code = await proc.exited;
  assert.equal(code, 0);
  const last = JSON.parse(proc.stdout[proc.stdout.length - 1]);
  assert.equal(last.id, 42);
  assert.equal(last.ok, true);
  assert.equal(fs.existsSync(lock), false, '退出后锁文件必须被清掉');
});

test('进程：已有活着的实例时拒绝启动（EINSTANCE + 退出码 3）', async () => {
  const dir = tempDir('lock');
  fs.writeFileSync(path.join(dir, 'backend.lock'), JSON.stringify({ pid: process.pid }), 'utf8');
  const proc = startBackend(dir);
  const code = await proc.exited;
  assert.equal(code, 3);
  const event = JSON.parse(proc.stdout[0]);
  assert.equal(event.type, 'event');
  assert.equal(event.name, 'backend.error');
  assert.equal(event.payload.code, 'EINSTANCE');
});

test('进程：锁文件里的 pid 已经死了 → 允许接管启动（陈旧锁不算冲突）', async () => {
  const dir = tempDir('stale');
  fs.writeFileSync(path.join(dir, 'backend.lock'), JSON.stringify({ pid: 999999 }), 'utf8');
  const proc = startBackend(dir);
  try {
    await waitFor(() => proc.stderr.join('').includes('就绪'));
    proc.send({ type: 'request', id: 2, method: 'backend.ping', params: {} });
    await waitFor(() => proc.stdout.length >= 1);
    assert.equal(JSON.parse(proc.stdout[0]).ok, true);
  } finally {
    proc.child.kill();
    await proc.exited;
  }
});

test('进程：后端崩溃时必须上报 backend.error 事件并带非零退出码（不许静默消失）', async () => {
  const dir = tempDir('crash');
  const script = `
    const { createBackend } = require(${JSON.stringify(BACKEND)});
    const b = createBackend({ configDir: ${JSON.stringify(dir)} });
    b.installCrashHandlers();
    setTimeout(() => { throw new Error('模拟后端崩溃'); }, 50);
  `;
  const child = spawn(process.execPath, ['-e', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b) => { out += b.toString('utf8'); });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 1);
  const event = JSON.parse(out.trim().split('\n').pop());
  assert.equal(event.name, 'backend.error');
  assert.equal(event.payload.code, 'ECRASH');
  assert.match(event.payload.message, /模拟后端崩溃/);
});
