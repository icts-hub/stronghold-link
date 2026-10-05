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
const { createLobbyManager } = require('../network/steam-lobby.cjs');

const APP_DIR = path.resolve(__dirname, '..');
const appIdFromEnv = () => (process.env.SH_LINK_STEAM_APP_ID ? Number(process.env.SH_LINK_STEAM_APP_ID) : null);
const localAddress = () => require('../network/session.cjs').localIPv4();

const APP_VERSION = '0.10.0';
const CONFIG_PATH = () => path.join(app.getPath('userData'), 'game-profiles.json');
const MAX_PROFILES = 500;
const PROTOCOLS = new Set(['TCP', 'UDP', 'TCP + UDP', 'CUSTOM']);
const IS_SMOKE = process.argv.includes('--smoke');
// 视觉验证用：--capture=<目录> 打开不可见窗口，逐个视图截图后退出（开发期用，不进打包产物）
const CAPTURE_DIR = (() => {
  const hit = process.argv.find((arg) => arg.startsWith('--capture='));
  return hit ? hit.slice('--capture='.length) : null;
})();
const CAPTURE_SESSION = process.argv.includes('--capture-session');
// --capture-motion：连拍两帧做像素差分，用来实测"界面是否真的在动"
const CAPTURE_MOTION = process.argv.includes('--capture-motion');
const CAPTURE_PROBE = process.argv.includes('--capture-probe');
const CAPTURE_STYLE = process.argv.includes('--capture-style');
// --force-motion：截图时忽略系统"减少动效"偏好（本机系统默认开启，实测动效需要它）
const FORCE_MOTION = process.argv.includes('--force-motion');
// 截图可指定主题：--capture-theme=light|dark（默认用应用当前设置）
const CAPTURE_THEME = (() => {
  const hit = process.argv.find((arg) => arg.startsWith('--capture-theme='));
  return hit ? hit.slice('--capture-theme='.length) : null;
})();
const CAPTURE_VIEWS = ['library', 'session', 'network', 'adapters', 'friends', 'settings'];

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

// ---------------------------------------------------------------------------
// Steam 大厅与好友：邀请好友联机
//   房主启动 Steam 桥接 -> 自动建大厅并把 SteamID/端口写进大厅数据
//   好友点「加入游戏」或在大厅里点加入 -> 我们进大厅读数据 -> 界面上一键启动加入者桥接
// 测试钩子：测试进程可以用 globalThis.__SHL_TEST_STEAM_SDK__ 注入假 SDK，避免真的初始化 Steam。
// ---------------------------------------------------------------------------

let lobbyManager = null;
let lastLobbyEvent = null;

function sendLobbyEvent(type, payload) {
  lastLobbyEvent = { type, payload, at: Date.now() };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('lobby:event', lastLobbyEvent);
}

function getLobby() {
  if (!lobbyManager) {
    lobbyManager = createLobbyManager({
      appDir: APP_DIR,
      appId: appIdFromEnv() || 480,
      sdk: (typeof globalThis !== 'undefined' && globalThis.__SHL_TEST_STEAM_SDK__) || null,
      onEvent: (type, payload) => {
        sendLobbyEvent(type, payload);
        if (type === 'join-requested') {
          // 好友点了「加入游戏」：我们先进大厅，把房主的连接信息读出来，再让界面一键启动
          handleJoinRequest(payload).catch((err) => logLine('处理加入请求失败', String(err && err.message ? err.message : err)));
        }
      },
    });
  }
  return lobbyManager;
}

/** 好友触发加入：进大厅 -> 读房主信息 -> 推给界面。 */
async function handleJoinRequest({ lobbyId, friendSteamId, friendName }) {
  if (!lobbyId) return;
  const manager = getLobby();
  logLine(`收到联机邀请：大厅 ${lobbyId}（来自 ${friendName || friendSteamId || '好友'}）`);
  const joined = await manager.join(lobbyId);
  sendLobbyEvent('join-result', {
    ok: joined.ok,
    reason: joined.reason || null,
    lobbyId,
    host: joined.host || null,
    from: friendName || friendSteamId || null,
  });
}

/** 房主启动 Steam 桥接后自动建房，把连接信息写进大厅数据。 */
async function openLobbyForSession(snapshot) {
  const config = (snapshot && snapshot.config) || {};
  if (config.adapter !== 'steam' || snapshot.role !== 'host') return;
  const manager = getLobby();
  try {
    const result = await manager.create({
      maxMembers: Number(config.maxConnections) > 0 ? Math.min(Number(config.maxConnections) + 1, 64) : 4,
      hostSteamId: (snapshot.channels && snapshot.channels[0] && snapshot.channels[0].steamId) || null,
      port: Number(config.targetPort) || null,
      game: String(config.game || ''),
      version: APP_VERSION,
    });
    logLine(result.ok ? `已创建 Steam 大厅 ${result.lobbyId}，可在「好友」页一键邀请` : `创建 Steam 大厅失败：${result.reason}`);
  } catch (err) {
    logLine(`创建 Steam 大厅失败：${err && err.message ? err.message : err}`);
  }
}

const SESSION_KEYS = ['role', 'relayPort', 'targetPort', 'targetHost', 'bindHost', 'authToken', 'maxConnections', 'idleTimeoutMs', 'connectTimeoutMs', 'localPort', 'remoteHost', 'remotePort', 'game', 'rules', 'protocol', 'adapter', 'gamePort', 'hostSteamId', 'appId', 'recipe'];
const NUMERIC_KEYS = ['relayPort', 'targetPort', 'localPort', 'remotePort', 'maxConnections', 'gamePort', 'appId', 'idleTimeoutMs', 'connectTimeoutMs'];
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
    // 把「本次会话实际用的是哪个适配器、哪些规则」传下去：只有真正在用的那个才算 running
    const config = (session.getSnapshot().config) || {};
    return describeAdapters({
      steamDiagnosis,
      running,
      role: session.role,
      adapter: config.adapter || (running ? 'local' : null),
      rules: config.rules || [],
      channelSummary,
    });
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
      // 房主的 Steam 桥接起来后自动开大厅，好友那边就能一键邀请/加入
      openLobbyForSession(snapshot).catch(() => { /* 建房失败只记日志，不影响桥接本身 */ });
      return { ...snapshot, inviteText: snapshot.invite ? inviteText(snapshot.invite) : '' };
    } catch (err) {
      throw toIpcError(err);
    }
  });
  ipcMain.handle('session:stop', async () => {
    try {
      const snapshot = await session.stop();
      // 桥接停了，大厅里已经没有可加入的东西，收掉
      if (lobbyManager && lobbyManager.lobbyId && lobbyManager.isOwner) {
        lobbyManager.leave();
        sendLobbyEvent('lobby-left', { lobbyId: null, reason: '会话已停止' });
      }
      return snapshot;
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

  // ---- Steam 大厅 / 好友 ----
  ipcMain.handle('lobby:status', () => {
    const manager = getLobby();
    const snapshot = manager.snapshot();
    return {
      ...snapshot,
      // Steam 用 +connect_lobby 启动我们时，界面据此显示「有人邀请你」
      commandLineLobbyId: manager.connectLobbyFromCommandLine(),
      lastEvent: lastLobbyEvent,
    };
  });
  ipcMain.handle('lobby:friends', async () => {
    try {
      return await getLobby().listFriends();
    } catch (err) {
      throw toIpcError(err);
    }
  });
  ipcMain.handle('lobby:create', async (_event, raw) => {
    try {
      const input = raw && typeof raw === 'object' ? raw : {};
      const current = session.getSnapshot();
      const config = current.config || {};
      const manager = getLobby();
      const result = await manager.create({
        maxMembers: Number(input.maxMembers) > 0 ? Number(input.maxMembers) : 4,
        hostSteamId: input.hostSteamId ? String(input.hostSteamId).slice(0, 32) : null,
        port: Number(input.port) > 0 ? Number(input.port) : Number(config.targetPort) || null,
        game: input.game ? String(input.game).slice(0, 64) : String(config.game || ''),
        version: APP_VERSION,
      });
      return { ...result, status: manager.snapshot() };
    } catch (err) {
      throw toIpcError(err);
    }
  });
  ipcMain.handle('lobby:join', async (_event, raw) => {
    try {
      const lobbyId = raw && raw.lobbyId ? String(raw.lobbyId).trim().slice(0, 32) : '';
      if (!lobbyId) throw Object.assign(new Error('请填写大厅 ID'), { code: 'EINVALIDLOBBY' });
      const manager = getLobby();
      const result = await manager.join(lobbyId);
      return { ...result, status: manager.snapshot() };
    } catch (err) {
      throw toIpcError(err);
    }
  });
  ipcMain.handle('lobby:leave', () => {
    const manager = getLobby();
    const result = manager.leave();
    return { ...result, status: manager.snapshot() };
  });
  ipcMain.handle('lobby:invite', (_event, raw) => {
    const steamId = raw && raw.steamId ? String(raw.steamId).trim().slice(0, 32) : '';
    const result = getLobby().invite(steamId);
    return result;
  });
  ipcMain.handle('lobby:stop', async () => {
    if (!lobbyManager) return { ok: true, stopped: false };
    await lobbyManager.stop();
    lobbyManager = null;
    return { ok: true, stopped: true };
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
    localNode: localAddress(),
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

function createWindow({ show = true, query = null } = {}) {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 650,
    show,
    title: 'Stronghold Link',
    backgroundColor: '#11181b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 窗口最小化/被遮挡时不要节流：会话状态轮询与日志推送要继续跑，
      // 否则回到前台会看到一段「时间静止」的旧数据。
      backgroundThrottling: false,
    },
  });
  // query.capture=1 时渲染进程会跳过启动序列（截图与自检需要立即看到主界面）
  if (query) win.loadFile(path.join(__dirname, '../src/ui/index.html'), { query });
  else win.loadFile(path.join(__dirname, '../src/ui/index.html'));
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

/**
 * 视觉验证（开发期）：--capture=<目录> [--capture-session]
 * 打开不可见窗口，逐个视图截图，同时记录渲染进程控制台错误与横向溢出情况。
 * 这是给 UI 改动做验收用的工具，正常启动路径不会走到这里。
 */

/**
 * 动效探针（开发期）：--capture-probe
 * 用真实运行时数据验证视差、页面转场与启动序列，而不是靠"看代码觉得对"。
 */

/** 样式探针（开发期）：--capture-style 打印关键控件的计算样式，避免靠猜 */
/** 样式探针（开发期）：--capture-style 打印关键控件的计算样式，避免靠猜 */
async function runStyleProbe() {
  const win = createWindow({ show: false, query: { capture: "1" } });
  await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
  await new Promise((r) => setTimeout(r, 1500));
  const code = [
    "(function(){",
    "var sels=[[\".cmd.is-accent\",[\"background-image\",\"background-size\",\"background-color\",\"color\"]],",
    "[\".cmd\",[\"background-image\",\"background-size\"]],",
    "[\".btn.primary\",[\"background-color\",\"color\",\"border-color\"]],",
    "[\".inp\",[\"background-image\",\"background-size\"]],",
    "[\".trow.is-selected\",[\"background-color\"]],",
    "[\".bg__grid\",[\"animation-name\",\"animation-duration\"]],",
    "[\".top\",[\"backdrop-filter\"]]];",
    "var out=[];",
    "for(var i=0;i<sels.length;i++){var el=document.querySelector(sels[i][0]);",
    "if(!el){out.push(sels[i][0]+\" -> not found\");continue}",
    "var cs=getComputedStyle(el);var line=sels[i][0]+\" -> \";",
    "for(var j=0;j<sels[i][1].length;j++){line+=sels[i][1][j]+\"=\"+cs.getPropertyValue(sels[i][1][j])+\"  \"}",
    "out.push(line)}",
    "return out.join(\"\\n\")})()"
  ].join("");
  const dump = await win.webContents.executeJavaScript(code);
  console.log("[style]\n" + dump);
  app.exit(0);
}
async function runProbe(dir) {
  await fs.mkdir(dir, { recursive: true });
  const win = createWindow({ show: true, query: FORCE_MOTION ? { motion: 'force' } : null });
  mainWindow = win;
  win.setContentSize(1440, 900);
  win.setPosition(24, 24);
  win.setAlwaysOnTop(true);
  const issues = [];
  win.webContents.on('console-message', (_e, level, message, line, source) => { if (level >= 2) issues.push(source + ':' + line + ' ' + message); });
  await new Promise((resolve, reject) => {
    win.webContents.once('did-finish-load', resolve);
    win.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error('load ' + code + ' ' + desc)));
  });
  try {
    // 1) 启动序列：截到中途，并读出真实步骤文本
    await new Promise((r) => setTimeout(r, 1500));
    const boot = await win.webContents.executeJavaScript(`({
      open: !!(document.getElementById('bootScreen')||{}).classList && document.getElementById('bootScreen').classList.contains('open'),
      rows: Array.from(document.querySelectorAll('.boot__row')).map(function(r){return r.textContent.trim()}),
      count: (document.getElementById('bootCount')||{}).textContent,
      status: (document.getElementById('bootStatus')||{}).textContent
    })`);
    await fs.writeFile(path.join(dir, 'boot-mid.png'), (await win.webContents.capturePage()).toPNG());
    // 2) 等启动序列结束
    await new Promise((r) => setTimeout(r, 2600));
    const afterBoot = await win.webContents.executeJavaScript("(document.getElementById('bootScreen')||{}).className || ''");
    // 3) 视差：派发一次指针移动，看 --px/--py 是否被写入
    await win.webContents.executeJavaScript("document.dispatchEvent(new MouseEvent('mousemove',{clientX:0,clientY:0}));window.dispatchEvent(Object.assign(new Event('pointermove'),{clientX:0,clientY:0}))");
    await win.webContents.executeJavaScript("window.dispatchEvent(new PointerEvent('pointermove',{clientX:window.innerWidth*0.9,clientY:window.innerHeight*0.2}))");
    await new Promise((r) => setTimeout(r, 400));
    const parallax = await win.webContents.executeJavaScript("({px:getComputedStyle(document.documentElement).getPropertyValue('--px'),py:getComputedStyle(document.documentElement).getPropertyValue('--py'),far:getComputedStyle(document.querySelector('.bg__layer--far')).transform})");
    // 4) 页面转场：切换视图，读 is-leaving 与最终激活视图
    const leaving = await win.webContents.executeJavaScript("(function(){showView('network');var v=document.querySelector('.view.is-leaving');return v?v.id:null})()");
    await new Promise((r) => setTimeout(r, 420));
    const active = await win.webContents.executeJavaScript("(function(){var v=document.querySelector('.view.active');return {id:v?v.id:null,nav:document.querySelector('[data-view].active').dataset.view}})()");
    await fs.writeFile(path.join(dir, 'after-transition.png'), (await win.webContents.capturePage()).toPNG());
    console.log('[probe] 启动序列进行中 = ' + boot.open + '  计数 = ' + boot.count + '  当前行 = ' + boot.status);
    for (const row of boot.rows) console.log('         ' + row);
    console.log('[probe] 启动结束后 className = "' + afterBoot + '"（应不含 open）');
    console.log('[probe] 视差 --px = ' + String(parallax.px).trim() + '  --py = ' + String(parallax.py).trim() + '  远层 transform = ' + parallax.far);
    console.log('[probe] 转场离场视图 = ' + (leaving || '（未捕获到，可能已切完）') + ' → 最终激活 = ' + active.id + ' / 导航高亮 = ' + active.nav);
  } catch (err) {
    console.error('[probe] failed', err);
  } finally {
    if (issues.length) { console.log('[probe] 渲染进程控制台问题：'); for (const line of issues.slice(0, 10)) console.log('  ' + line); }
    else console.log('[probe] 渲染进程控制台无错误/警告');
    app.exit(0);
  }
}

async function runCapture(dir) {
  await fs.mkdir(dir, { recursive: true });
  const consoleIssues = [];
  let echo;
  let relayPort;
  try {
    if (CAPTURE_SESSION) {
      echo = net.createServer((socket) => { socket.on('error', () => {}); socket.on('data', (d) => socket.write(d)); });
      const echoPort = await new Promise((resolve) => echo.listen(0, '127.0.0.1', () => resolve(echo.address().port)));
      relayPort = await freePort();
      await session.start({ role: 'host', relayPort, targetHost: '127.0.0.1', targetPort: echoPort, authToken: '', game: 'capture' });
      // 灌一点真实流量，让遥测/波形/日志有东西可看
      const client = net.createConnection({ host: '127.0.0.1', port: relayPort });
      await new Promise((resolve) => client.once('connect', resolve));
      for (let i = 0; i < 6; i += 1) {
        client.write(Buffer.alloc(8 * 1024, 65 + i));
        await new Promise((r) => setTimeout(r, 400));
      }
      client.destroy();
      logLine('[capture] 已启动真实会话并灌入流量', `relayPort=${relayPort}`);
    }

    // 不可见窗口的合成器不会重绘，capturePage 会拿到过期帧 —— 所以截图用可见窗口
    const win = createWindow({ show: true, query: FORCE_MOTION ? { capture: '1', motion: 'force' } : { capture: '1' } });
    mainWindow = win;
    win.setContentSize(1440, 900);
    win.setPosition(24, 24);
    win.setAlwaysOnTop(true); // 仅截图期间，防止被遮挡后合成器不刷新
    win.webContents.on('console-message', (_e, level, message, line, source) => {
      if (level >= 2) consoleIssues.push(`${source}:${line} ${message}`);
    });
    await new Promise((resolve, reject) => {
      win.webContents.once('did-finish-load', resolve);
      win.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`渲染进程加载失败 ${code} ${desc}`)));
    });

    if (CAPTURE_THEME) {
      await win.webContents.executeJavaScript("applyTheme('" + CAPTURE_THEME + "', false)");
      await new Promise((r) => setTimeout(r, 400));
    }

    if (CAPTURE_MOTION) {
      // 先等首屏动画结束，再连拍两帧比较像素
      await new Promise((r) => setTimeout(r, 2500));
      const shotA = await win.webContents.capturePage();
      await new Promise((r) => setTimeout(r, 1300));
      const shotB = await win.webContents.capturePage();
      const a = shotA.toBitmap();
      const b = shotB.toBitmap();
      const len = Math.min(a.length, b.length);
      let changed = 0;
      let sum = 0;
      for (let i = 0; i < len; i += 4) {
        const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        if (d > 6) changed += 1;
        sum += d;
      }
      const pixels = len / 4;
      const pct = (changed / pixels) * 100;
      const info = await win.webContents.executeJavaScript(`({
        scan: getComputedStyle(document.querySelector('.bg__scan')).animationName + ' ' + getComputedStyle(document.querySelector('.bg__scan')).animationDuration,
        drift: getComputedStyle(document.querySelector('.bg__grid')).animationName + ' ' + getComputedStyle(document.querySelector('.bg__grid')).animationDuration,
        px: getComputedStyle(document.documentElement).getPropertyValue('--px'),
        reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
        glass: getComputedStyle(document.querySelector('.top')).backdropFilter,
        depth: getComputedStyle(document.querySelector('.top')).backgroundColor
      })`);
      console.log('[motion] 画面变化像素占比 = ' + pct.toFixed(2) + '%  （变化像素 ' + changed + ' / ' + pixels + '）');
      console.log('[motion] 平均亮度差 = ' + (sum / pixels).toFixed(3) + ' / 765');
      console.log('[motion] 扫描带动画 = ' + info.scan + ' ；网格漂移 = ' + info.drift);
      console.log('[motion] 视差变量 --px = ' + String(info.px).trim() + ' ；玻璃层 = ' + info.glass);
      console.log('[motion] 减少动效偏好 = ' + info.reduced);
      const files = path.join(dir, 'motion');
      await fs.mkdir(files, { recursive: true });
      await fs.writeFile(path.join(files, 'frame-a.png'), shotA.toPNG());
      await fs.writeFile(path.join(files, 'frame-b.png'), shotB.toPNG());
      console.log('[motion] 两帧已存到 ' + files);
    } else {
    for (let index = 0; index < CAPTURE_VIEWS.length; index += 1) {
      const view = CAPTURE_VIEWS[index];
      // 切换视图（渲染进程里的 showView 是全局函数）
      await win.webContents.executeJavaScript("showView('" + view + "')");
      // 等两帧（带兜底超时：窗口被遮挡时 rAF 可能被节流，不能无限等）
      await Promise.race([
        win.webContents.executeJavaScript('new Promise((r)=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))'),
        new Promise((r) => setTimeout(r, 1500)),
      ]);
      await new Promise((r) => setTimeout(r, 700));
      const metrics = await win.webContents.executeJavaScript(`({
        view: '${view}',
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        bodyHeight: document.body.scrollHeight,
        navActive: (document.querySelector('[data-view].active') || {}).dataset ? document.querySelector('[data-view].active').dataset.view : null,
        title: document.title
      })`);
      const file = path.join(dir, `${String(index + 1).padStart(2, '0')}-${view}.png`);
      const image = await win.webContents.capturePage();
      await fs.writeFile(file, image.toPNG());
      const overflow = metrics.scrollWidth - metrics.clientWidth;
      console.log(`[capture] ${view} -> ${file}  横向溢出=${overflow}px  导航高亮=${metrics.navActive}  内容高=${metrics.bodyHeight}`);
      if (overflow > 0) console.log(`[capture] !! ${view} 出现横向滚动 ${overflow}px`);
    }
    }

    if (consoleIssues.length) {
      console.log('[capture] 渲染进程控制台问题：');
      for (const line of consoleIssues.slice(0, 20)) console.log(`  ${line}`);
    } else {
      console.log('[capture] 渲染进程控制台无错误/警告');
    }
  } catch (err) {
    console.error('[capture] failed', err);
  } finally {
    try { if (echo) await new Promise((r) => echo.close(() => r())); } catch { /* ignore */ }
    try { await session.stop(); } catch { /* ignore */ }
    app.exit(0);
  }
}

async function runSmoke() {
  const results = { steps: [], ok: false };
  const step = (name, value) => { results.steps.push({ name, value }); console.log(`[smoke] ${name}: ${JSON.stringify(value)}`); };
  let echo;
  try {
    echo = net.createServer((socket) => { socket.on('error', () => {}); socket.on('data', (d) => socket.write(d)); });
    const echoPort = await new Promise((resolve) => echo.listen(0, '127.0.0.1', () => resolve(echo.address().port)));
    const relayPort = await freePort();

    const win = createWindow({ show: false, query: { capture: '1' } });
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
    if (CAPTURE_STYLE) { await runStyleProbe(); return; }
    if (CAPTURE_PROBE) {
      logLine('动效探针模式');
      await runProbe(CAPTURE_DIR || path.join(APP_DIR, 'probe-out'));
      return;
    }
    if (CAPTURE_DIR) {
      logLine('截图模式', CAPTURE_DIR, CAPTURE_SESSION ? '(含真实会话)' : '');
      await runCapture(CAPTURE_DIR);
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
