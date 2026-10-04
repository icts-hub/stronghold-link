'use strict';
// Stronghold Link — Electron 主进程。
//
// 两件事：
//   1) 游戏配置持久化（应用数据目录中的 game-profiles.json，写入用临时文件 + rename 保证原子性）；
//   2) 会话控制：把 network/session.cjs 暴露成一组受限 IPC，渲染进程只能调用这些操作。
//
// 安全基线：contextIsolation: true、nodeIntegration: false、sandbox: true，
// 渲染进程拿不到 Node.js，也拿不到任何文件路径，只能通过白名单 IPC 与会话交互。

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const nodeFs = require('node:fs');
const net = require('node:net');
const { SessionManager, inviteText, parseInvite } = require('../network/session.cjs');
const { createTcpJoiner } = require('../network/tcp-relay.cjs');
const { diagnoseSteam } = require('../network/steam-env.cjs');
const { describeAdapters, describeRecipes, describeHints } = require('../network/adapters.cjs');

const APP_DIR = path.resolve(__dirname, '..');
const appIdFromEnv = () => (process.env.SH_LINK_STEAM_APP_ID ? Number(process.env.SH_LINK_STEAM_APP_ID) : null);
const localAddress = () => require('../network/session.cjs').localIPv4();

const APP_VERSION = '0.9.0';
const CONFIG_PATH = () => path.join(app.getPath('userData'), 'game-profiles.json');
const MAX_PROFILES = 500;
const PROTOCOLS = new Set(['TCP', 'UDP', 'TCP + UDP', 'CUSTOM']);
const IS_SMOKE = process.argv.includes('--smoke');

// ---------------------------------------------------------------------------
// 启动日志：解决「双击后闪退、什么都看不到」的问题
// 日志写到 %APPDATA%\stronghold-link\startup.log（超过 256 KB 自动截断重写）。
// ---------------------------------------------------------------------------

const STARTUP_LOG = path.join(app.getPath('userData'), 'startup.log');
const LOG_LIMIT = 256 * 1024;

function logLine(...parts) {
  const text = `[${new Date().toISOString()}] ${parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')}`;
  try { console.log(text); } catch { /* 无控制台时忽略 */ }
  try {
    nodeFs.mkdirSync(path.dirname(STARTUP_LOG), { recursive: true });
    try {
      const stat = nodeFs.statSync(STARTUP_LOG);
      if (stat.size > LOG_LIMIT) nodeFs.writeFileSync(STARTUP_LOG, `${new Date().toISOString()} —— 日志超过上限，已截断 ——\n`);
    } catch { /* 文件不存在 */ }
    nodeFs.appendFileSync(STARTUP_LOG, `${text}\n`);
  } catch { /* 磁盘不可写时不能让启动失败 */ }
}

// ---------------------------------------------------------------------------
// 沙箱兼容：本机/受限环境里 Chromium 沙箱初始化会失败（表现为「双击一闪就退」，
// 没有任何提示）。这里在没显式给出 --no-sandbox 时自动补上，并写进启动日志。
// 想强制保留沙箱：设置环境变量 SHL_KEEP_SANDBOX=1。
// 注意：关掉的是 Chromium 的 OS 级沙箱；应用自身的 contextIsolation / nodeIntegration=false /
// preload 白名单 / CSP 全部保持开启。
// ---------------------------------------------------------------------------

const HAS_NO_SANDBOX_FLAG = process.argv.includes('--no-sandbox');
const KEEP_SANDBOX = process.env.SHL_KEEP_SANDBOX === '1';
if (!HAS_NO_SANDBOX_FLAG && !KEEP_SANDBOX) {
  try {
    app.commandLine.appendSwitch('no-sandbox');
  } catch { /* 失败也不影响后续流程 */ }
}

logLine('=== 启动 ===', `version=${APP_VERSION}`, `pid=${process.pid}`,
  `argv=${JSON.stringify(process.argv.slice(1))}`,
  `electron=${process.versions.electron} chrome=${process.versions.chrome} node=${process.versions.node}`,
  `platform=${process.platform}/${process.arch}`,
  `no-sandbox=${HAS_NO_SANDBOX_FLAG || (!KEEP_SANDBOX ? 'auto' : 'no')}`,
  `userData=${app.getPath('userData')}`);

process.on('uncaughtException', (err) => logLine('UNCAUGHT', err && err.stack ? err.stack : String(err)));
process.on('unhandledRejection', (reason) => logLine('UNHANDLED_REJECTION', String(reason)));
app.on('child-process-gone', (_event, details) => logLine('CHILD_PROCESS_GONE', JSON.stringify(details)));
app.on('render-process-gone', (_event, _contents, details) => logLine('RENDER_PROCESS_GONE', JSON.stringify(details)));
app.on('gpu-process-crashed', () => logLine('GPU_PROCESS_CRASHED'));

let mainWindow = null;

// ---------------------------------------------------------------------------
// 配置持久化
// ---------------------------------------------------------------------------

function validateProfile(p) {
  if (!p || typeof p !== 'object' || typeof p.name !== 'string' || !p.name.trim()) throw new Error('配置名称无效');
  if (!PROTOCOLS.has(p.transport)) throw new Error('传输协议无效');
  const ports = Array.isArray(p.ports) ? p.ports : [{ protocol: p.transport, localPort: Number(p.port), remotePort: Number(p.remotePort || p.port) }];
  if (!ports.length || ports.length > 64) throw new Error('每个配置需要 1–64 条端口规则');
  const normalized = ports.map((rule) => {
    const protocol = String(rule.protocol || p.transport).toUpperCase();
    const localPort = Number(rule.localPort), remotePort = Number(rule.remotePort || rule.localPort);
    if (!['TCP', 'UDP'].includes(protocol)) throw new Error('端口规则协议必须是 TCP 或 UDP');
    for (const n of [localPort, remotePort]) if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('端口必须是 1–65535 的整数');
    return { protocol, localPort, remotePort };
  });
  // port / remotePort 是为了兼容早期界面（它读的是单值字段）；ports[] 才是唯一数据源。
  const primary = normalized[0];
  return {
    id: String(p.id || `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    name: p.name.trim().slice(0, 80),
    transport: p.transport,
    host: typeof p.host === 'string' ? p.host.slice(0, 255) : '127.0.0.1',
    port: primary.localPort,
    remotePort: primary.remotePort,
    ports: normalized,
    path: typeof p.path === 'string' ? p.path.slice(0, 1024) : '',
    args: typeof p.args === 'string' ? p.args.slice(0, 2048) : '',
    favorite: Boolean(p.favorite),
    recipe: typeof p.recipe === 'string' ? p.recipe.slice(0, 40) : null,
    description: typeof p.description === 'string' ? p.description.slice(0, 300) : '',
  };
}

async function readProfiles() {
  try {
    const data = JSON.parse(await fs.readFile(CONFIG_PATH(), 'utf8'));
    if (!Array.isArray(data)) return [];
    return data.slice(0, MAX_PROFILES).map(validateProfile);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function writeProfiles(profiles) {
  if (!Array.isArray(profiles) || profiles.length > MAX_PROFILES) throw new Error('配置数量超出限制');
  const clean = profiles.map(validateProfile);
  const file = CONFIG_PATH();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(clean, null, 2), 'utf8');
  await fs.rename(temp, file);
  return clean;
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

const session = new SessionManager({
  appDir: APP_DIR,
  onEvent: (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('session:event', event);
  },
});

const SESSION_KEYS = ['role', 'relayPort', 'targetPort', 'targetHost', 'bindHost', 'authToken', 'maxConnections', 'localPort', 'remoteHost', 'remotePort', 'game', 'rules', 'protocol', 'adapter', 'gamePort', 'hostSteamId', 'appId', 'recipe'];
const NUMERIC_KEYS = ['relayPort', 'targetPort', 'localPort', 'remotePort', 'maxConnections', 'gamePort', 'appId'];
const MAX_RULES = 16;

/** 只接受白名单字段，避免渲染进程往主进程塞任意对象。 */
function sanitizeSessionInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('会话参数无效');
  const out = {};
  for (const key of SESSION_KEYS) {
    if (!(key in raw) || raw[key] === undefined || raw[key] === null) continue;
    if (key === 'rules') {
      if (!Array.isArray(raw.rules) || !raw.rules.length || raw.rules.length > MAX_RULES) throw new Error(`端口规则必须是 1–${MAX_RULES} 条的数组`);
      out.rules = raw.rules.map((rule) => {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error('端口规则格式无效');
        return {
          protocol: String(rule.protocol || 'TCP').slice(0, 8),
          localPort: Number(rule.localPort),
          remotePort: Number(rule.remotePort),
        };
      });
      continue;
    }
    out[key] = NUMERIC_KEYS.includes(key) ? Number(raw[key]) : String(raw[key]).slice(0, key === 'authToken' ? 64 : 512);
  }
  return out;
}

/** 把主进程内部的错误翻译成渲染进程能直接展示的文案（IPC 只保留 message）。 */
function toIpcError(err) {
  const message = err && (err.friendly || err.message) ? (err.friendly || err.message) : '未知错误';
  const wrapped = new Error(message);
  if (err && err.code) wrapped.code = err.code;
  return wrapped;
}

function registerIpc() {
  ipcMain.handle('profiles:load', () => readProfiles());
  ipcMain.handle('profiles:save', (_event, profiles) => writeProfiles(profiles));

  ipcMain.handle('adapters:list', () => {
    const running = session.state === 'running';
    const channelSummary = running
      ? session.channels.map((channel) => `${channel.rule.protocol}:${channel.listen.port}`).join('、')
      : '';
    const steamDiagnosis = diagnoseSteam({ appDir: APP_DIR, appId: appIdFromEnv() });
    return describeAdapters({ steamDiagnosis, running, role: session.role, channelSummary });
  });

  // 连接配方（阶段 5）：把「不同游戏的联机方式」做成可选列表
  ipcMain.handle('adapters:recipes', () => {
    const steamDiagnosis = diagnoseSteam({ appDir: APP_DIR, appId: appIdFromEnv() });
    return describeRecipes({ steamAvailable: Boolean(steamDiagnosis.available) });
  });
  ipcMain.handle('adapters:recipe-hints', (_event, raw) => {
    const input = raw && typeof raw === 'object' ? raw : {};
    const recipe = typeof input.recipe === 'string' ? input.recipe.slice(0, 40) : 'local-ports';
    const rules = Array.isArray(input.rules) ? input.rules.slice(0, 16).map((rule) => ({
      protocol: String(rule?.protocol || 'TCP').toUpperCase(),
      localPort: Number(rule?.localPort),
      remotePort: Number(rule?.remotePort),
    })).filter((rule) => Number.isInteger(rule.localPort) && Number.isInteger(rule.remotePort)) : [];
    return describeHints(recipe, {
      rules,
      gamePort: Number(input.gamePort) || null,
      localPort: Number(input.localPort) || null,
      targetHost: typeof input.targetHost === 'string' ? input.targetHost.slice(0, 255) : '127.0.0.1',
      lanAddress: localAddress(),
      game: typeof input.game === 'string' ? input.game.slice(0, 80) : '',
    });
  });

  ipcMain.handle('session:start', async (_event, raw) => {
    try {
      const input = sanitizeSessionInput(raw);
      const snapshot = await session.start(input);
      return { ...snapshot, inviteText: snapshot.invite ? inviteText(snapshot.invite) : '' };
    } catch (err) {
      throw toIpcError(err);
    }
  });
  ipcMain.handle('session:stop', async () => {
    try {
      return await session.stop();
    } catch (err) {
      throw toIpcError(err);
    }
  });
  ipcMain.handle('session:status', () => {
    const snapshot = session.getSnapshot();
    return { ...snapshot, inviteText: snapshot.invite ? inviteText(snapshot.invite) : '' };
  });
  ipcMain.handle('session:check-port', async (_event, raw) => {
    try {
      const input = sanitizeSessionInput(raw);
      return await session.checkPort({ port: input.relayPort ?? input.localPort ?? input.port, host: input.bindHost, protocol: input.protocol });
    } catch (err) {
      throw toIpcError(err);
    }
  });
  ipcMain.handle('session:parse-invite', (_event, code) => {
    try {
      return parseInvite(String(code || ''));
    } catch (err) {
      throw toIpcError(err);
    }
  });
  ipcMain.handle('steam:diagnose', () => {
    try {
      return diagnoseSteam({ appDir: APP_DIR, appId: appIdFromEnv() });
    } catch (err) {
      throw toIpcError(err);
    }
  });
  ipcMain.handle('app:info', () => ({
    name: 'Stronghold Link',
    version: APP_VERSION,
    userData: app.getPath('userData'),
    configPath: CONFIG_PATH(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    smoke: IS_SMOKE,
  }));
  ipcMain.handle('app:reveal-config', async () => {
    await fs.mkdir(path.dirname(CONFIG_PATH()), { recursive: true });
    shell.showItemInFolder(CONFIG_PATH());
    return true;
  });
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

function createWindow({ show = true } = {}) {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 650,
    show,
    title: 'Stronghold Link',
    backgroundColor: '#101217',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '../src/ui/index.html'));
  win.webContents.on('did-finish-load', () => logLine('渲染进程加载完成'));
  win.webContents.on('did-fail-load', (_event, code, description, url) => logLine('渲染进程加载失败', `code=${code}`, `desc=${description}`, `url=${url}`));
  win.webContents.on('render-process-gone', (_event, details) => logLine('窗口渲染进程退出', JSON.stringify(details)));
  win.on('unresponsive', () => logLine('窗口无响应'));
  win.on('closed', () => { logLine('窗口已关闭'); if (mainWindow === win) mainWindow = null; });
  return win;
}

// ---------------------------------------------------------------------------
// 启动自检（--smoke）：不显示窗口，走真实 preload/IPC/会话链路，然后退出
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function reachable(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (ok) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(ok); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function runSmoke() {
  const results = { steps: [], ok: false };
  const step = (name, value) => { results.steps.push({ name, value }); console.log(`[smoke] ${name}: ${JSON.stringify(value)}`); };
  let echo;
  try {
    echo = net.createServer((socket) => { socket.on('error', () => {}); socket.on('data', (d) => socket.write(d)); });
    const echoPort = await new Promise((resolve) => echo.listen(0, '127.0.0.1', () => resolve(echo.address().port)));
    const relayPort = await freePort();

    const win = createWindow({ show: false });
    mainWindow = win; // 让会话事件也走真实的主进程 -> 渲染进程推送通道
    await new Promise((resolve, reject) => {
      win.webContents.once('did-finish-load', resolve);
      win.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`渲染进程加载失败 ${code} ${desc}`)));
    });
    step('renderer-loaded', true);

    const uiState = await win.webContents.executeJavaScript(`({
      title: document.title,
      hasBridge: typeof window.strongholdLink === 'object',
      hasStartButton: !!document.getElementById('startSession'),
      hasStopButton: !!document.getElementById('stopSession'),
      hasInviteBox: !!document.getElementById('inviteBox'),
      version: (document.getElementById('appVersion') || {}).textContent || ''
    })`);
    step('renderer-ui', uiState);

    const started = await win.webContents.executeJavaScript(
      `window.strongholdLink.session.start(${JSON.stringify({ role: 'host', relayPort, targetHost: '127.0.0.1', targetPort: echoPort, game: 'smoke' })})`,
    );
    step('session-start', { state: started.state, role: started.role, relayPort, invite: Boolean(started.invite && started.invite.code) });
    step('relay-listening', await reachable(relayPort));

    // 通过中继真实转发一次数据：渲染进程启动的房主会话 + 主进程侧的加入者中继。
    // （一个 SessionManager 同时只允许一个会话，所以这里加入者用中继内核直接起，不走 IPC。）
    const token = started.invite ? started.invite.token : '';
    const joinerPort = await freePort();
    const joiner = createTcpJoiner({ bindHost: '127.0.0.1', localPort: joinerPort, host: '127.0.0.1', relayPort, authToken: token });
    let echoOk = false;
    try {
      await joiner.ready;
      step('joiner-start', 'ok');
      echoOk = await new Promise((resolve) => {
        const socket = net.createConnection({ host: '127.0.0.1', port: joinerPort });
        let done = false;
        const finish = (ok) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(ok); };
        const timer = setTimeout(() => finish(false), 3000);
        socket.once('error', () => finish(false));
        socket.once('connect', () => socket.write('smoke-ping'));
        socket.on('data', (chunk) => { if (chunk.toString().includes('smoke-ping')) finish(true); });
      });
      step('roundtrip-through-relay', echoOk);
    } catch (err) {
      step('joiner-start', `failed: ${err.message}`);
    } finally {
      await joiner.stop();
    }

    const stopped = await win.webContents.executeJavaScript('window.strongholdLink.session.stop()');
    step('session-stop', { state: stopped.state });
    step('relay-port-released', !(await reachable(relayPort, '127.0.0.1', 400)));

    results.ok = Boolean(uiState.hasBridge && uiState.hasStartButton && started.state === 'running' && echoOk && stopped.state === 'idle');
    win.destroy();
  } catch (err) {
    results.error = err && err.stack ? err.stack : String(err);
    console.error('[smoke] failed', err);
  } finally {
    try { session.shutdown(); } catch { /* ignore */ }
    if (echo) await new Promise((resolve) => echo.close(() => resolve()));
  }
  // Windows 上 Electron 是 GUI 子系统程序，控制台输出不一定能被父进程捕获，
  // 所以自检结果同时写入文件（--smoke-out 或 userData 目录）。
  const outIndex = process.argv.findIndex((arg) => arg === '--smoke-out');
  const outArg = process.argv.find((arg) => arg.startsWith('--smoke-out='));
  const outPath = outIndex >= 0 && process.argv[outIndex + 1]
    ? process.argv[outIndex + 1]
    : (outArg ? outArg.slice('--smoke-out='.length) : path.join(app.getPath('userData'), 'smoke-result.json'));
  try {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, JSON.stringify(results, null, 2), 'utf8');
    console.log(`[smoke] result written to ${outPath}`);
  } catch (err) {
    console.error('[smoke] cannot write result file', err);
  }
  console.log(`[smoke] RESULT ${JSON.stringify(results)}`);
  return results.ok;
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

const gotLock = IS_SMOKE ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  // 已经有实例在跑：正常情况下第二个实例把已有窗口叫到前面就行；
  // 但如果那个实例是「僵住的、没有窗口」的，用户看到的现象就是「双击没反应」。
  logLine('另一个实例已在运行，本次启动退出（second-instance 会把已有窗口置前）');
  app.quit();
} else {
  app.on('second-instance', () => {
    logLine('收到 second-instance，尝试把已有窗口置前');
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    logLine('app ready');
    registerIpc();
    if (IS_SMOKE) {
      const ok = await runSmoke();
      app.exit(ok ? 0 : 1);
      return;
    }
    mainWindow = createWindow();
    logLine('主窗口已创建');
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow(); });
  }).catch((err) => {
    logLine('whenReady 失败', err && err.stack ? err.stack : String(err));
    if (!IS_SMOKE) dialog.showErrorBox('Stronghold Link 启动失败', String(err && err.message ? err.message : err));
  });

  app.on('window-all-closed', () => {
    if (IS_SMOKE) return; // 自检自己控制退出时机，否则结果文件还没写完就被结束
    session.shutdown(); // 关窗口就不能再留着监听端口
    logLine('所有窗口已关闭，退出');
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => { logLine('准备退出'); session.shutdown(); });

  process.on('uncaughtException', (err) => {
    console.error('[main] uncaught exception', err);
    logLine('UNCAUGHT(生命周期内)', err && err.stack ? err.stack : String(err));
    try { session.shutdown(); } catch { /* ignore */ }
    if (!IS_SMOKE) dialog.showErrorBox('Stronghold Link 发生错误', String(err && err.message ? err.message : err));
  });
}
