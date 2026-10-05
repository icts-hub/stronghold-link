'use strict';
// Stronghold Link — Electron 主进程。
//
// 两件事：
//   1) 游戏配置持久化（应用数据目录中的 game-profiles.json，写入用临时文件 + rename 保证原子性）；
//   2) 会话控制：把 network/session.cjs 暴露成一组受限 IPC，渲染进程只能调用这些操作。
//
// 安全基线：contextIsolation: true、nodeIntegration: false、sandbox: true，
// 渲染进程拿不到 Node.js，也拿不到任何文件路径，只能通过白名单 IPC 与会话交互。

const { app, BrowserWindow, dialog, ipcMain, shell, Menu } = require('electron');
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

const APP_VERSION = '0.12.0';
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
const CAPTURE_MATRIX = process.argv.includes('--capture-matrix');
const CAPTURE_STEAM = process.argv.includes('--capture-steam');
// PHASE 6 分辨率矩阵：设计基准 1440×900，验收下面四档
const MATRIX_SIZES = [[1200, 800], [1366, 768], [1600, 900], [1920, 1080]];
const MATRIX_THEMES = ['light', 'dark'];
// 窗口缩放扫描（只查溢出，不截图）
const SWEEP_WIDTHS = [1000, 1100, 1200, 1280, 1366, 1440, 1600, 1760, 1920];
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
let lastLobbyHostInfo = null;
let preferredGamePort = null;   // 用户在 FRIENDS 页选定的端口（最高优先级）   // 大厅交换来的房主信息（供 lobby:connect 用）
let lastLobbyEvent = null;

function sendLobbyEvent(type, payload) {
  lastLobbyEvent = { type, payload, at: Date.now() };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('lobby:event', lastLobbyEvent);
}

/**
 * 大厅要写进 shl_port 的端口：显式传入 > 当前会话配置 > 本机探测（自动认出正在监听的游戏服务）
 * 这样房主不必手填端口，好友加入后就能直接建立隧道。
 */
/** 大厅里显示的游戏名：显式传入 > 会话配置 > 本机识别 */
function resolveLobbyGame(input, config) {
  const explicit = input && input.game ? String(input.game).slice(0, 64) : '';
  if (explicit) return explicit;
  const fromSession = config && config.game ? String(config.game).slice(0, 64) : '';
  if (fromSession) return fromSession;
  try {
    const ports = require('../network/listening-ports.cjs');
    const games = require('../network/game-detect.cjs');
    const found = ports.listListeningPorts({});
    if (found && found.ok) {
      const game = games.pickPrimaryGame(found.entries);
      if (game) return game.name;
    }
  } catch (err) { /* 忽略 */ }
  return '';
}

function resolveLobbyPort(input, config) {
  const explicit = Number(input && input.port) > 0 ? Number(input.port) : 0;
  if (explicit) return explicit;
  // 运行中会话的"真实端口"优先于"用户曾经选过的端口"：
  // 否则会话换了端口之后，大厅仍会发布旧端口，好友连不上。
  const fromSession = Number(config && (config.targetPort || config.gamePort)) > 0
    ? Number(config.targetPort || config.gamePort)
    : (Array.isArray(config && config.rules) && config.rules[0] && Number(config.rules[0].localPort) > 0
        ? Number(config.rules[0].localPort) : 0);
  if (fromSession) return fromSession;
  if (Number(preferredGamePort) > 0) return Number(preferredGamePort);
  try {
    const ports = require('../network/listening-ports.cjs');
    const games = require('../network/game-detect.cjs');
    const found = ports.listListeningPorts({});
    if (found && found.ok) {
      // 先认游戏（一键联机的主路径）：认出就直接用它的端口
      const procTable = require('../network/process-table.cjs');
      let table = null;
      if (found.entries.some((e) => procTable.needsCommandLine(e.process))) {
        const t = procTable.readProcessTable({});
        if (t.ok) table = t.rows;
      }
      const game = games.pickPrimaryGame(found.entries, { processTable: table });
      if (game && Number(game.port) > 0) {
        logLine('大厅未指定端口：已识别到 ' + game.name + '（' + game.protocol + ' ' + game.port + '），自动使用');
        return Number(game.port);
      }
      const pick = ports.suggestSteamGamePort(found.entries, {});
      if (pick && Number(pick.port) > 0) {
        logLine('大厅未指定端口：已自动探测到本机服务端口 ' + pick.port + (pick.process ? '（' + pick.process + '）' : ''));
        return Number(pick.port);
      }
    }
  } catch (err) { /* 探测失败就不写端口，界面会提示原因 */ }
  return null;
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
      port: resolveLobbyPort({}, config),
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
/**
 * 归一化"大厅里的房主连接信息"。
 * 真实形状：snapshot().host = { hostSteamId, port, game, room, version }
 *          join() 返回 { ok, lobbyId, host: {...} }
 * 这里同时接受 { host: {...} } 与扁平对象，避免再出现"读错键名导致永远为空"的问题。
 */
function normalizeHostInfo(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const h = (raw.host && typeof raw.host === 'object') ? raw.host : raw;
  const hostSteamId = h.hostSteamId ? String(h.hostSteamId) : null;
  const portNum = Number(h.port) > 0 ? Number(h.port) : null;
  if (!hostSteamId && !portNum) return null;
  return {
    hostSteamId,
    port: portNum,
    game: h.game ? String(h.game) : '',
    room: h.room ? String(h.room) : '',
    version: h.version ? String(h.version) : '',
  };
}

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
      preferredGamePort = null;      // 会话停了：上次选的端口不再代表"有人在服务"
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
  let routeWatch = null;
ipcMain.handle('network:process-list', async (_event, raw) => {
  // 实时列出"正在监听的程序"，供用户自己挑（自动识别失败时的兜底路径）
  // 只用 netstat + tasklist（毫秒级）；命令行要单独点开某个进程才查（约 4.5 秒）
  try {
    const input = raw && typeof raw === 'object' ? raw : {};
    const filter = String(input.filter || '').trim().toLowerCase();
    const ports = require('../network/listening-ports.cjs');
    const games = require('../network/game-detect.cjs');
    const found = ports.listListeningPorts({});
    if (!found.ok) return { ok: false, reason: found.reason, rows: [] };

    const byPid = new Map();
    for (const e of found.entries) {
      if (!e || !Number(e.port)) continue;
      if (e.protocol === 'TCP' && e.state && e.state !== 'LISTENING') continue;   // 只要"在听"的
      if (!byPid.has(e.pid)) byPid.set(e.pid, { pid: e.pid, name: e.process || null, ports: [], kinds: new Set() });
      const row = byPid.get(e.pid);
      row.ports.push({ port: e.port, protocol: e.protocol, address: e.address });
      row.kinds.add(ports.classify(e, e.process));
    }

    const gameByPid = new Map();
    for (const g of games.detectGames(found.entries, { limit: 40 })) {
      if (g.pid !== undefined && !gameByPid.has(g.pid)) gameByPid.set(g.pid, g);
    }

    const rows = [...byPid.values()].map((r) => {
      const g = gameByPid.get(r.pid) || null;
      const kinds = [...r.kinds];
      return {
        pid: r.pid,
        name: r.name,
        ports: r.ports.sort((a, b) => a.port - b.port).slice(0, 8),
        portCount: r.ports.length,
        isGame: Boolean(g),
        gameName: g ? g.name : null,
        confidence: g ? g.confidence : null,
        isSystem: kinds.length === 1 && kinds[0] === 'system',
        isInfra: ports.isInfra({ port: r.ports[0] ? r.ports[0].port : 0, process: r.name }),
      };
    })
      .filter((r) => (filter ? String(r.name || '').toLowerCase().includes(filter) : true))
      .filter((r) => !r.isSystem)                                    // 系统进程不列（噪音）
      .sort((a, b) => (Number(b.isGame) - Number(a.isGame)) || (Number(a.isInfra) - Number(b.isInfra)) || String(a.name || '~').localeCompare(String(b.name || '~')))
      .slice(0, 120);

    return { ok: true, reason: null, rows, scannedAt: Date.now() };
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err), rows: [] };
  }
});

ipcMain.handle('network:process-detail', async (_event, raw) => {
  // 只有用户点开某个进程时才查命令行（约 4.5 秒，带 30 秒缓存）
  try {
    const pid = Number(raw && raw.pid);
    if (!Number.isFinite(pid) || pid <= 0) return { ok: false, reason: 'PID 无效', detail: null };
    const procTable = require('../network/process-table.cjs');
    const table = procTable.readProcessTable(pid ? { force: false } : {});
    if (!table.ok) return { ok: false, reason: table.reason, detail: null };
    const hit = table.rows.find((r) => r.pid === pid) || null;
    if (!hit) return { ok: false, reason: '进程已退出（PID ' + pid + '）', detail: null };
    const games = require('../network/game-detect.cjs');
    let game = null;
    for (const p of games.PROFILES) {
      const hints = games.CMD_HINTS[p.id];
      if (hints && hints.some((re) => re.test(hit.cmd))) { game = p; break; }
    }
    return { ok: true, reason: null, detail: { pid, name: hit.name, cmd: hit.cmd, gameId: game ? game.id : null, gameName: game ? game.name : null } };
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err), detail: null };
  }
});

ipcMain.handle('network:listening-ports', async () => {
  // 探测本机监听端口，过滤系统与基础设施，排除本会话自己的端口，给出可转发的候选
  try {
    const ports = require('../network/listening-ports.cjs');
    const snap = session.getSnapshot ? session.getSnapshot() : {};
    const used = [];
    (snap.channels || []).forEach((c) => {
      if (c && c.listen && Number(c.listen.port) > 0) used.push(Number(c.listen.port));
      if (c && c.peer && Number(c.peer.port) > 0) used.push(Number(c.peer.port));
    });
    const found = ports.listListeningPorts({});
    if (!found.ok) return { ok: false, reason: found.reason, candidates: [], rules: [], steamPick: null, games: [], primaryGame: null, used };
    const candidates = ports.rankCandidates(found.entries, { exclude: used, limit: 12 });
    const games = require('../network/game-detect.cjs');
    const procTable = require('../network/process-table.cjs');
    let table = null;
    if (found.entries.some((e) => procTable.needsCommandLine(e.process))) {
      const t = procTable.readProcessTable({});            // ~4.5s，30 秒缓存；只在需要消歧时查
      if (t.ok) table = t.rows;
    }
    const detected = games.detectGames(found.entries, { limit: 6, processTable: table });
    const primary = games.pickPrimaryGame(found.entries, { processTable: table });
    return {
      ok: true,
      reason: null,
      used,
      games: detected,
      primaryGame: primary,
      candidates,
      steamPick: ports.suggestSteamGamePort(found.entries, { exclude: used }),
      rules: ports.suggestRules(found.entries, { exclude: used, max: 4, perProcess: 2 }),
      scannedAt: Date.now(),
    };
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err), candidates: [], rules: [], steamPick: null, games: [], primaryGame: null, used: [] };
  }
});

ipcMain.handle('network:nat-type', async () => {
  // NAT 映射行为实测：同一 socket 问两个 STUN 服务器，比较映射结果
  try {
    const { measureNatMapping } = require('../network/direct-udp/nat-type.cjs');
    return await measureNatMapping({});
  } catch (err) {
    return { ok: false, mapping: 'unknown', reason: String(err && err.message ? err.message : err), results: [], notes: [] };
  }
});

ipcMain.handle('network:route-watch', async (event, input) => {
  // 路由监看：按需启动/停止，状态由界面轮询读取（不新增事件通道）
  const action = (input && input.action) || 'state';
  try {
    if (action === 'start') {
      if (!routeWatch) {
        const { createRelayRouteWatch } = require('../network/route/watch.cjs');
        routeWatch = createRelayRouteWatch({
          intervalMs: Number(input && input.intervalMs) || 15000,
          pings: 4,
          onRouteChanged: (ev) => {
            console.log('[route] NETWORK_ROUTE_CHANGED ' + JSON.stringify(ev));
            // 接进会话事件流：会话在跑时，SESSION 页的终端会看到这一行
            try {
              if (sessionManager && typeof sessionManager.note === 'function') {
                sessionManager.note('路由切换：' + ev.from + ' → ' + ev.to + (ev.reason ? '（' + ev.reason + '）' : ''), 'warn');
              }
            } catch (err) { /* 日志注入失败不影响监看 */ }
            // 自动迁移：默认策略下只会记一行日志、不碰通道；开启多通道策略后才会真正迁移
            try {
              const { handleRouteChange } = require('../network/route/auto-migrate.cjs');
              handleRouteChange({ event: ev, session: sessionManager, log: (msg) => console.log(msg) })
                .catch((err) => console.log('[route] 自动迁移处理异常：' + (err && err.message ? err.message : err)));
            } catch (err) { /* 模块缺失不影响监看 */ }
          },
        });
      }
      routeWatch.start();
      return { ok: true, ...routeWatch.snapshot() };
    }
    if (action === 'stop') {
      if (routeWatch) routeWatch.stop();
      return { ok: true, running: false, ...(routeWatch ? routeWatch.snapshot() : {}) };
    }
    return { ok: true, running: Boolean(routeWatch && routeWatch.running), ...(routeWatch ? routeWatch.snapshot() : {}) };
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err), running: false };
  }
});

ipcMain.handle('network:routes', async (event, input) => {
  // 返回候选路径清单：能力来自 Provider 注册表，分数来自真实测量（没有测量就是未测量）
  try {
    const registry = require('../network/providers/registry.cjs').createRegistry();
    require('../network/providers/local-relay.cjs').registerLocalRelayProviders(registry);
    require('../network/providers/steam-p2p.cjs').registerSteamProvider(registry);
    require('../network/providers/direct-udp.cjs').registerDirectUDPProvider(registry);
    require('../network/providers/sl-relay.cjs').registerSlRelayProvider(registry);
    const providers = registry.describeAll ? registry.describeAll() : registry.list();
    const qualityById = {};
    if (input && input.measure) {
      const { runRelaySelfTest } = require('../network/relay/selftest.cjs');
      const measured = await runRelaySelfTest({ pings: 6 });
      if (measured && measured.measured) {
        for (const id of ['sl-relay-host', 'sl-relay-joiner']) {
          qualityById[id] = { rtt: measured.rtt, packetLoss: measured.packetLoss, jitter: measured.jitter, measured: true, samples: measured.samples };
        }
      }
    }
    let natMapping = null;
    if (input && input.measure) {
      try {
        const { measureNatMapping } = require('../network/direct-udp/nat-type.cjs');
        const nat = await measureNatMapping({});
        natMapping = nat.ok ? nat.mapping : 'unknown';
      } catch (err) { natMapping = 'unknown'; }
    }
    const { describeRouteCandidates } = require('../network/routes.cjs');
    const described = describeRouteCandidates({ providers, qualityById, natMapping });

    // 用同一份候选跑一次决策：让界面能看到"现在选哪条、为什么、策略是什么"
    const { createRouteManager } = require('../network/route/manager.cjs');
    const manager = createRouteManager({ now: Date.now });
    manager.setCandidates(described.candidates.map((c) => ({ id: c.id, name: c.name })));
    for (const c of described.candidates) {
      if (c.measured && c.quality) manager.update(c.id, c.quality);
    }
    const decision = manager.tick();
    let routePolicy = null;
    try {
      const { normalizeRoutePolicy, describeRoutePolicy } = require('../network/route/policy.cjs');
      const live = sessionManager && typeof sessionManager.getRoutePolicy === 'function' ? sessionManager.getRoutePolicy() : normalizeRoutePolicy(null);
      routePolicy = { enabled: Boolean(live.enabled), standby: live.standby || 'none', description: live.description || describeRoutePolicy(live) };
    } catch (err) {
      routePolicy = { enabled: false, standby: 'none', description: '多通道选路未启用（默认）：只建主通道，切换不会重建会话通道' };
    }
    return { ok: true, natMapping, routePolicy, ...described, decision: { ...manager.snapshot(), lastAction: decision.action, lastReason: decision.reason } };
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err), candidates: [], measuredCount: 0, total: 0 };
  }
});

ipcMain.handle('network:relay-selftest', async () => {
  // 本机真实测量：起临时中继服务端 + 两个客户端，测 RTT/抖动/丢包后全部关停
  try {
    const { runRelaySelfTest } = require('../network/relay/selftest.cjs');
    return await runRelaySelfTest({ pings: 8 });
  } catch (err) {
    return { ok: false, measured: false, scope: 'loopback', reason: String(err && err.message ? err.message : err), rtt: null, jitter: null, packetLoss: null, samples: 0, notes: [] };
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
  // 角色信息给界面用：加入者不该看到"选进程/选端口"（那是房主的操作）
  const withRole = (snap) => Object.assign({}, snap || {}, {
    isOwner: Boolean(lobbyManager && lobbyManager.isOwner),
    role: lobbyManager && lobbyManager.isOwner ? 'host' : (lobbyManager && lobbyManager.lobbyId ? 'joiner' : null),
  });
    const manager = getLobby();
    const snapshot = manager.snapshot();
    // 角色信息（加入者不该看到"选进程/选端口"）：挂在 snapshot 上，返回时会被 ...snapshot 展开
    try {
      snapshot.isOwner = Boolean(manager.isOwner);
      snapshot.role = manager.isOwner ? 'host' : (manager.lobbyId ? 'joiner' : null);
      // 界面用的统一字段（真实键是 snapshot.host）
      snapshot.hostInfo = normalizeHostInfo(snapshot.host);
    } catch (err) { /* 忽略 */ }
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
        port: resolveLobbyPort(input, config),
        game: resolveLobbyGame(input, config),
      room: String(input.room || '').slice(0, 16),
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
      // 注意：真实数据在 result.host 里（键名是 host，不是 hostInfo）
      lastLobbyHostInfo = normalizeHostInfo(result) || null;
      logLine(lastLobbyHostInfo
        ? ('已读到房主信息：SteamID ' + (lastLobbyHostInfo.hostSteamId || '-') + ' · 端口 ' + (lastLobbyHostInfo.port || '-'))
        : '大厅里暂时读不到房主信息（房主还没开局？）');
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
  ipcMain.handle('app:open-url', async (_event, raw) => {
  // 好友端"打开游戏"：避免他手输地址连到自己的服务器。只允许 http/https，且只允许本机/内网地址。
  try {
    const url = String((raw && raw.url) || '').trim();
    if (!/^https?:\/\//i.test(url)) return { ok: false, reason: '只允许 http/https 地址' };
    let host = '';
    try { host = new URL(url).hostname; } catch (err) { return { ok: false, reason: '地址格式无效' }; }
    const localish = host === 'localhost' || host === '127.0.0.1' || host === '::1' || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (!localish) return { ok: false, reason: '只允许打开本机或内网地址：' + host };
    await shell.openExternal(url);
    logLine('已用默认浏览器打开 ' + url);
    return { ok: true, url };
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('lobby:set-room', async (_event, raw) => {
  // 房主在游戏里建好房后，把房间号（或整条邀请链接）写进大厅，好友点开即进房
  try {
    const input = raw && typeof raw === 'object' ? raw : {};
    let code = String(input.room || '').trim();
    const m = code.match(/[?&]room=([A-Za-z0-9]+)/);      // 支持直接粘贴游戏的邀请链接
    if (m) code = m[1];
    code = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
    if (!code) return { ok: false, reason: '请填写房间号（或粘贴游戏里的邀请链接）' };
    const manager = getLobby();
    const r = manager.setRoom ? manager.setRoom(code) : { ok: false, reason: '当前大厅管理器不支持写入房间号' };
    if (r && r.ok) {
      lastLobbyHostInfo = Object.assign({}, lastLobbyHostInfo || {}, { room: code, port: preferredGamePort });
      logLine('已把房间号 ' + code + ' 写入大厅：好友点「打开游戏并进入房间」即可直接进房');
    }
    return r;
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err) };
  }
});

/** 探测本机某个 HTTP 地址（用于验证隧道是否真的把房主的网页送过来了） */
function httpProbe(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const http = require('node:http');
      const req = http.get(url, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (body.length < 4096) body += c; });
        res.on('end', () => finish({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, looksLikeGame: /<html|<!doctype/i.test(body) }));
      });
      req.setTimeout(timeoutMs, () => { req.destroy(); finish({ ok: false, status: 0, reason: '超时 ' + timeoutMs + 'ms（隧道没有把数据送过来）' }); });
      req.on('error', (err) => finish({ ok: false, status: 0, reason: err && err.message ? err.message : String(err) }));
    } catch (err) {
      finish({ ok: false, status: 0, reason: String(err && err.message ? err.message : err) });
    }
  });
}

ipcMain.handle('selftest:save', async (_event, raw) => {
  // 把自检文本写到桌面旁的文件，便于直接把两侧输出发给我定位
  try {
    const text = String((raw && raw.text) || '').slice(0, 20000);
    const dir = app.getPath('userData');
    const file = require('node:path').join(dir, 'selftest-' + Date.now() + '.txt');
    require('node:fs').writeFileSync(file, text, 'utf8');
    logLine('自检结果已保存：' + file);
    return { ok: true, file };
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('lobby:selftest', async () => {
  // 联机自检：逐环打印真实状态，直接指出断点在哪一环
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: ok === null ? null : Boolean(ok), detail });
  try {
    const manager = lobbyManager || getLobby();
    const snap = (manager.snapshot ? manager.snapshot() : {}) || {};
    const isOwner = Boolean(manager.isOwner);
    const members = Array.isArray(snap.members) ? snap.members : [];
    add('大厅', Boolean(snap.lobbyId), snap.lobbyId ? ('大厅 ' + snap.lobbyId + ' · ' + (isOwner ? '我是房主' : '我是加入者') + ' · 成员 ' + members.length + ' 人') : '还没有大厅（房主请先建房；好友请先接受邀请）');

    const s = session.getSnapshot();
    const cfg = s.config || {};
    const entry = s.channels && s.channels[0] && s.channels[0].listen ? s.channels[0].listen.port : null;
    add('会话', s.state === 'running',
      'state=' + s.state + ' · adapter=' + (cfg.adapter || '-') + ' · role=' + (cfg.role || '-') +
      (cfg.adapter === 'steam' ? (' · 房主SteamID=' + (cfg.remoteHost || '-') + ' · 游戏端口=' + (cfg.gamePort || cfg.targetPort || '-')) : ''));

    const info = lastLobbyHostInfo || normalizeHostInfo(snap.host) || normalizeHostInfo(snap.hostInfo) || {};
    const port = Number(info.port) > 0 ? Number(info.port) : (Number(snap.port) > 0 ? Number(snap.port) : null);
    add('大厅里的连接信息', Boolean(info.hostSteamId || port),
      '房主SteamID=' + (info.hostSteamId || '-') + ' · 端口=' + (port || '-') + ' · 游戏=' + (info.game || '-') + ' · 房间号=' + (info.room || '-'));

    // 角色一致性：这两种情况会直接导致"好友进不来 / 看不到房间"
    if (isOwner && s.state !== 'running') {
      add('角色一致性', false, '你是这个大厅的房主，但还没启动房主会话：请在自己这边「选择要转发的进程」选端口开局，好友才有东西可连');
    } else if (!isOwner && snap.lobbyId && s.state === 'running' && cfg.adapter === 'steam' && cfg.role === 'host') {
      add('角色一致性', false, '你既是别人大厅的成员，又在当房主（会在本机起第二台服务器）：请先点 LEAVE 离开大厅，只用房主身份');
    } else if (isOwner) {
      add('角色一致性', true, '你是房主且会话在运行，配置一致');
    }
    if (isOwner) {
      add('房主本地服务', null, '房主侧不监听端口，只连 127.0.0.1:' + (cfg.gamePort || cfg.targetPort || '-') + '（隧道好不好用由好友侧自检判定）');
    } else if (entry) {
      const url = 'http://127.0.0.1:' + entry + '/';
      const r = await httpProbe(url);
      add('隧道转发 HTTP（决定性）', r.ok,
        r.ok ? ('GET ' + url + ' → HTTP ' + r.status + (r.looksLikeGame ? ' · 内容是网页（说明数据真的从房主那边过来了）' : ' · 但内容不像游戏页面'))
             : ('GET ' + url + ' 失败：' + r.reason + ' → 隧道没起作用'));
      add('浏览器该打开的地址', true, url + '（只打开这个；不要打开 127.0.0.1:' + (port || 3000) + '，那是你自己那边）');
    } else {
      const ownerId = (info.hostSteamId || snap.hostSteamId || '-');
      const noHostInfo = !(info.hostSteamId || port);
      // 自检顺手把加入者隧道试起来（自检即修复），并把被拒的真实原因写进结果里
      let attempt = null;
      try {
        const { planLobbyConnect } = require('../network/lobby-connect.cjs');
        const plan = planLobbyConnect({
          role: 'joiner',
          lobby: { lobbyId: snap.lobbyId || null, hostSteamId: info.hostSteamId || snap.hostSteamId || null, port: port, game: info.game || '', version: info.version || '' },
          session: s,
          appId: Number(cfg.appId) > 0 ? Number(cfg.appId) : null,
          appVersion: APP_VERSION,
        });
        attempt = { action: plan.action, reason: plan.reason, needsHostStop: Boolean(plan.needsHostStop) };
        if (plan.action === 'start') {
          const snap3 = await session.start(sanitizeSessionInput(plan.options));
          const e3 = snap3.channels && snap3.channels[0] && snap3.channels[0].listen ? snap3.channels[0].listen.port : null;
          if (e3) {
            const url3 = 'http://127.0.0.1:' + e3 + '/';
            const r3 = await httpProbe(url3);
            add('隧道入口', true, '已自动建立：' + url3 + '（入口端口与房主服务端口同号）');
            add('隧道转发 HTTP（决定性）', r3.ok, r3.ok ? ('GET ' + url3 + ' → HTTP ' + r3.status + (r3.looksLikeGame ? ' · 内容是网页（数据确实来自房主）' : ' · 内容不像游戏页面')) : ('GET ' + url3 + ' 失败：' + r3.reason + ' → 隧道没把数据送过来'));
            add('浏览器该打开的地址', true, url3);
          } else {
            add('隧道入口', false, '会话起来了但没有入口端口（异常，请把此文件发我）');
          }
        } else {
          add('隧道入口', false, '没能建立加入者隧道：' + plan.reason + (attempt.needsHostStop ? '（可点四步卡里的「以加入者身份重连」）' : ''));
        }
      } catch (err) {
        add('隧道入口', false, '尝试建立隧道时出错：' + (err && err.message ? err.message : err) + (noHostInfo ? ('　（大厅房主 ' + ownerId + ' 尚未写入端口）') : ''));
      }
      if (attempt) add('启动计划', attempt.action === 'start' ? true : false, 'action=' + attempt.action + ' · reason=' + attempt.reason);
    }
    return { ok: true, checks, verdict: checks.some((c) => c.ok === false) ? '发现断点：见标红项' : '未发现断点' };
  } catch (err) {
    return { ok: false, checks, verdict: '自检本身出错：' + (err && err.message ? err.message : err) };
  }
});

ipcMain.handle('lobby:prepare', async (_event, raw) => {
  // FRIENDS 页选完端口后的一键配置：记住端口 -> 必要时启动房主会话 -> 建/更新大厅
  // 之后好友只需要点「接受邀请」，其余全自动
  try {
    const input = raw && typeof raw === 'object' ? raw : {};
    const port = Number(input.port) > 0 ? Number(input.port) : 0;
    if (!port) return { ok: false, reason: '没有选择端口' };
    // 加入者误点"选进程开局"会把本机变成另一台服务器，好友那边就永远看不到房主的房间
    if (lobbyManager && lobbyManager.lobbyId && !lobbyManager.isOwner) {
      return {
        ok: false,
        reason: '你现在是好友大厅的成员（加入者），加入者不需要选端口：直接点「打开游戏并进入房间」即可。要自己开房请先点 LEAVE 离开大厅。',
      };
    }

    let snapshot = session.getSnapshot();
    const running = snapshot && snapshot.state === 'running';
    const cfg = (snapshot && snapshot.config) || {};
    const sameHost = running && cfg.adapter === 'steam' && cfg.role === 'host' && Number(cfg.targetPort) === port;
    if (!sameHost) {
      if (running) {
        return { ok: false, reason: '已有会话在运行（' + (cfg.adapter || '未知') + ' / ' + (cfg.role || '未知') + '），请先停止再换端口' };
      }
      snapshot = await session.start(sanitizeSessionInput({
        adapter: 'steam',
        role: 'host',
        targetHost: '127.0.0.1',
        gamePort: port,
        appId: Number(input.appId) > 0 ? Number(input.appId) : null,
      }));
      logLine('已按选定端口 ' + port + ' 启动房主会话，准备等待好友加入');
    }
    preferredGamePort = port;      // 只有真正起来了才记住（失败时不留脏值）

    const hostSteamId = (snapshot.channels && snapshot.channels[0] && snapshot.channels[0].steamId) || null;
    const game = String(input.game || cfg.game || '');
    let lobbyResult = null;
    try {
      const manager = getLobby();
      lobbyResult = await manager.create({
        maxMembers: Number(cfg.maxConnections) > 0 ? Math.min(Number(cfg.maxConnections) + 1, 64) : 4,
        hostSteamId,
        port,
        game,
        version: APP_VERSION,
      });
      lastLobbyHostInfo = { hostSteamId, port, game };
      if (lobbyResult && lobbyResult.ok) logLine('大厅已就绪（端口 ' + port + '），好友点接受邀请即可');
    } catch (err) {
      lobbyResult = { ok: false, reason: String(err && err.message ? err.message : err) };
    }

    return {
      ok: true,
      port,
      game,
      sameHost,
      hostSteamId,
      lobbyId: (lobbyResult && lobbyResult.lobbyId) || null,
      lobbyOk: Boolean(lobbyResult && lobbyResult.ok),
      lobbyReason: (lobbyResult && lobbyResult.reason) || null,
      listen: (snapshot.channels && snapshot.channels[0] && snapshot.channels[0].listen) || null,
    };
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('lobby:connect', async (_event, raw) => {
  // 用大厅里已交换的信息直接建立 Steam 隧道（房主写 shl_host/shl_port，加入者读取）
  try {
    const input = raw && typeof raw === 'object' ? raw : {};
    const manager = getLobby();
    const snap = manager.snapshot ? manager.snapshot() : {};
    const info = lastLobbyHostInfo || normalizeHostInfo(snap.host) || normalizeHostInfo(snap.hostInfo) || {};
    const lobby = {
      lobbyId: snap.lobbyId || info.lobbyId || null,
      hostSteamId: info.hostSteamId || snap.hostSteamId || null,
      port: info.port || snap.port || null,
      game: info.game || '',
      version: info.version || '',
    };
    const current = session.getSnapshot();
    const { planLobbyConnect } = require('../network/lobby-connect.cjs');
    const plan = planLobbyConnect({
      role: manager.isOwner ? 'host' : 'joiner',
      lobby,
      session: current,
      appId: Number(input.appId) > 0 ? Number(input.appId) : (Number(current.config && current.config.appId) || null),
      appVersion: APP_VERSION,
    });
    if (plan.action !== 'start') {
      // 一键纠正：加入者本机残留房主会话时，先停掉它再重试（用户点按钮才会走到这里）
      if (plan.needsHostStop && input.fix === true) {
        try {
          await session.stop();
          logLine('已按「以加入者身份重连」停掉本机残留的房主会话');
        } catch (err) { /* 停不掉就按原样返回原因 */ }
        const retry = planLobbyConnect({
          role: manager.isOwner ? 'host' : 'joiner',
          lobby, session: session.getSnapshot(),
          appId: Number(input.appId) > 0 ? Number(input.appId) : (Number(current.config && current.config.appId) || null),
          appVersion: APP_VERSION,
        });
        if (retry.action === 'start') {
          const snap2 = await session.start(sanitizeSessionInput(retry.options));
          const entry2 = snap2.channels && snap2.channels[0] && snap2.channels[0].listen ? snap2.channels[0].listen.port : null;
          return {
            ok: true, action: 'start', reason: retry.reason, notes: retry.notes, fixed: true,
            room: (info && info.room) || '',
            hostPort: Number(info && info.port) > 0 ? Number(info.port) : null,
            entryPort: entry2,
            entryUrl: entry2 ? ('http://127.0.0.1:' + entry2) : null,
            entryHint: entry2 ? ('用浏览器打开 http://127.0.0.1:' + entry2 + '（入口端口与房主服务端口同号）') : null,
            snapshot: snap2, status: snap,
          };
        }
        return { ok: false, action: 'none', reason: retry.reason, notes: retry.notes, status: snap };
      }
      return { ok: false, action: 'none', reason: plan.reason, notes: plan.notes, needsHostStop: Boolean(plan.needsHostStop), status: snap };
    }
    const snapshot = await session.start(sanitizeSessionInput(plan.options));
    if (manager.isOwner) openLobbyForSession(snapshot).catch(() => { /* 建房失败不影响隧道 */ });
    const entry = snapshot.channels && snapshot.channels[0] && snapshot.channels[0].listen ? snapshot.channels[0].listen.port : null;
    return {
      ok: true, action: 'start', reason: plan.reason, notes: plan.notes,
      entryPort: entry,
      room: (info && info.room) || (snap && snap.room) || '',
      hostPort: Number(info && info.port) > 0 ? Number(info.port) : (Number(snap && snap.port) > 0 ? Number(snap.port) : null),
      entryUrl: plan.options.role === 'joiner' && entry ? ('http://127.0.0.1:' + entry) : null,
      entryHint: plan.options.role === 'joiner' && entry
        ? ('用浏览器打开 http://127.0.0.1:' + entry + ' —— 这个入口端口和房主的游戏端口无关，也不需要和房主填一样的数字；房主在游戏里建好房间后把房间码发给你即可')
        : null,
      snapshot,
      status: snap,
    };
  } catch (err) {
    return { ok: false, action: 'none', reason: String(err && err.message ? err.message : err), notes: [] };
  }
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
    autoHideMenuBar: true,          // 不显示原生菜单栏（界面自带导航）
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
/** Steam 真实链路探针：--capture-steam（需要本机 Steam 已登录） */
async function runSteamProbe() {
  const win = createWindow({ show: false, query: { capture: "1" } });
  await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
  await new Promise((r) => setTimeout(r, 1200));
  const code = [
    "(async function(){",
    "  const out={};",
    "  const d=await window.strongholdLink.steam.diagnose();",
    "  out.available=d.available; out.blockers=d.blockers;",
    "  out.steps=(d.steps||[]).map(function(s){return (s.ok?\"OK  \":\"FAIL\")+\" \"+s.title+\" — \"+s.detail});",
    "  try{ const f=await window.strongholdLink.lobby.friends(); out.friends=f.length; out.online=f.filter(function(x){return x.online}).length; }catch(e){ out.friendsError=String((e&&e.message)||e); }",
    "  const st=await window.strongholdLink.lobby.status();",
    "  out.lobbyReady=st.ready; out.persona=st.name; out.steamId=st.steamId; out.lobbyId=st.lobbyId;",
    "  return out;",
    "})()"
  ].join("\n");
  try {
    const out = await win.webContents.executeJavaScript(code);
    console.log("[steam] Steam 环境可用 = " + out.available);
    for (const line of out.steps || []) console.log("        " + line);
    if (out.blockers && out.blockers.length) console.log("[steam] 阻塞项：" + out.blockers.join("；"));
    console.log("[steam] 大厅就绪 = " + out.lobbyReady + "  账号 = " + out.persona + " / " + out.steamId);
    console.log("[steam] 好友列表 = " + (out.friendsError ? "读取失败：" + out.friendsError : out.friends + " 人（在线 " + out.online + "）"));
  } catch (err) { console.error("[steam] failed", err); }
  app.exit(0);
}

/** 分辨率矩阵 + 窗口缩放扫描：--capture-matrix */
/** 分辨率矩阵 + 窗口缩放扫描：--capture-matrix
 *  溢出检查覆盖全部 6 页（便宜）；截图只给最复杂的 2 页（昂贵）。
 *  每一步单独容错：单页失败不影响整轮。 */
async function runMatrix(dir) {
  await fs.mkdir(dir, { recursive: true });
  const issues = [];
  const shotViews = ["library", "session"];
  const win = createWindow({ show: true, query: { capture: "1", ...(FORCE_MOTION ? { motion: "force" } : {}) } });
  mainWindow = win;
  startMemoryWatch();   // 启动总内存看护（超阈值降级 / 重载）
  win.setPosition(20, 20);
  win.setAlwaysOnTop(true);
  win.webContents.on("console-message", (_e, level, message, line, source) => { if (level >= 2) issues.push(source + ":" + line + " " + message); });
  await new Promise((resolve, reject) => {
    win.webContents.once("did-finish-load", resolve);
    win.webContents.once("did-fail-load", (_e, code, desc) => reject(new Error("load " + code + " " + desc)));
  });
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  let measured = 0;
  let overflow = 0;
  let shots = 0;
  const failures = [];
  try {
    for (const [w, h] of MATRIX_SIZES) {
      win.setContentSize(w, h);
      await settle(320);
      for (const theme of MATRIX_THEMES) {
        try { await win.webContents.executeJavaScript("applyTheme(\"" + theme + "\", false)"); } catch (e) { failures.push(w + "x" + h + " " + theme + " theme: " + e.message); }
        const outDir = path.join(dir, w + "x" + h, theme);
        await fs.mkdir(outDir, { recursive: true });
        for (let i = 0; i < CAPTURE_VIEWS.length; i += 1) {
          const view = CAPTURE_VIEWS[i];
          try {
            await win.webContents.executeJavaScript("showView(\"" + view + "\")");
            // 页面转场：180ms 淡出 + 300ms 进入 + 28ms 递延，等足够久再截图/测量
            await settle(900);
            const mt = await win.webContents.executeJavaScript("({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth})");
            const over = mt.sw - mt.cw;
            measured += 1;
            if (over > 0) { overflow += 1; console.log("[matrix] !! " + w + "x" + h + " " + theme + " " + view + " 横向溢出 " + over + "px"); }
            if (shotViews.includes(view)) {
              const image = await win.webContents.capturePage();
              await fs.writeFile(path.join(outDir, String(i + 1).padStart(2, "0") + "-" + view + ".png"), image.toPNG());
              shots += 1;
            }
          } catch (err) {
            failures.push(w + "x" + h + " " + theme + " " + view + ": " + (err && err.message ? err.message : String(err)));
          }
        }
        console.log("[matrix] " + w + "x" + h + " " + theme + " 已完成（累计测量 " + measured + " 次 / 截图 " + shots + " 张）");
      }
    }
    const sweep = [];
    try {
      await win.webContents.executeJavaScript("showView(\"library\")");
      for (const w of SWEEP_WIDTHS) {
        win.setContentSize(w, 900);
        await settle(240);
        const mt = await win.webContents.executeJavaScript("({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth})");
        sweep.push(w + ":" + (mt.sw - mt.cw));
      }
    } catch (err) { failures.push("sweep: " + (err && err.message ? err.message : String(err))); }
    console.log("[matrix] 缩放扫描（宽:溢出px） " + sweep.join("  "));
    console.log("[matrix] 合计：测量 " + measured + " 次，截图 " + shots + " 张，横向溢出 " + overflow + " 次");
    if (failures.length) { console.log("[matrix] 单步失败 " + failures.length + " 次："); for (const f of failures.slice(0, 12)) console.log("    " + f); }
  } catch (err) {
    console.error("[matrix] failed", err);
  } finally {
    if (issues.length) { console.log("[matrix] 渲染进程控制台问题："); for (const line of issues.slice(0, 10)) console.log("  " + line); }
    else console.log("[matrix] 渲染进程控制台无错误/警告");
    app.exit(0);
  }
}
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
    const routes = await win.webContents.executeJavaScript("(async () => { try { return await window.strongholdLink.network.routes({ measure: true }); } catch (e) { return { ok: false, reason: String(e && e.message || e) }; } })()");
    console.log('[probe] 候选清单（真实测量） = ' + JSON.stringify((routes.candidates || []).map((c) => ({ id: c.id, display: c.display, measured: c.measured, reason: c.unmeasuredReason }))));
    const policyOut = await win.webContents.executeJavaScript("(async () => { try { const r = await window.strongholdLink.network.routes({}); return r.routePolicy; } catch (e) { return { error: String(e && e.message || e) }; } })()");
    console.log('[probe] 策略状态（含说明） = ' + JSON.stringify(policyOut));
    const routed = await win.webContents.executeJavaScript("(async () => { try { const r = await window.strongholdLink.network.routes({ measure: true }); return { nat: r.natMapping, direct: (r.candidates || []).filter((c) => c.kind === 'direct').map((c) => c.unmeasuredReason)[0] }; } catch (e) { return { error: String(e && e.message || e) }; } })()");
    console.log('[probe] 候选原因（含 NAT） = ' + JSON.stringify(routed));
    const watchStart = await win.webContents.executeJavaScript("(async () => { try { return await window.strongholdLink.network.routeWatch({ action: 'start', intervalMs: 3000 }); } catch (e) { return { ok: false, reason: String(e && e.message || e) }; } })()");
    await new Promise((r) => setTimeout(r, 4000));
    const watchState = await win.webContents.executeJavaScript("(async () => { try { return await window.strongholdLink.network.routeWatch({ action: 'state' }); } catch (e) { return { ok: false, reason: String(e && e.message || e) }; } })()");
    const watchStop = await win.webContents.executeJavaScript("(async () => { try { return await window.strongholdLink.network.routeWatch({ action: 'stop' }); } catch (e) { return { ok: false }; } })()");
    console.log('[probe] 路由监看（真实） = ' + JSON.stringify({ started: watchStart.running, polls: watchState.polls, current: watchState.current, score: watchState.currentScore, routeChanges: watchState.routeChanges, failures: watchState.measurement && watchState.measurement.failures, lastRtt: watchState.measurement && watchState.measurement.last && watchState.measurement.last.rtt, stopped: watchStop.running }));
    const scan = await win.webContents.executeJavaScript("(async () => { try { const r = await window.strongholdLink.network.listeningPorts(); return { ok: r.ok, n: (r.candidates||[]).length, top: (r.candidates||[]).slice(0,3).map(c => c.protocol+':'+c.port+':'+(c.process||'?')), steam: r.steamPick && r.steamPick.port, rules: (r.rules||[]).length, used: r.used }; } catch (e) { return { ok: false, err: String(e && e.message || e) }; } })()");
    console.log('[probe] 端口探测（真实） = ' + JSON.stringify(scan));
    const diag = await win.webContents.executeJavaScript("(async () => { try { const r = await window.strongholdLink.network.routes({ measure: true }); return r.decision; } catch (e) { return { error: String(e && e.message || e) }; } })()");
    console.log('[probe] 路由决策（真实测量） = ' + JSON.stringify({ state: diag.state, current: diag.current, currentScore: diag.currentScore, routeChanges: diag.routeChanges, lastAction: diag.lastAction, lastReason: diag.lastReason, logCount: (diag.log || []).length, policy: diag.policy }));
    const relay = await win.webContents.executeJavaScript("(async () => { try { return await window.strongholdLink.network.relaySelfTest(); } catch (e) { return { measured: false, reason: String(e && e.message || e) }; } })()");
    console.log('[probe] 中继自检（真实测量） = ' + JSON.stringify({ measured: relay.measured, rtt: relay.rtt, jitter: relay.jitter, packetLoss: relay.packetLoss, samples: relay.samples, delivered: relay.delivered, scope: relay.scope, reason: relay.reason }));
    const boot = await win.webContents.executeJavaScript(`({
      open: !!(document.getElementById('bootScreen')||{}).classList && document.getElementById('bootScreen').classList.contains('open'),
      rows: Array.from(document.querySelectorAll('.boot__row')).map(function(r){return r.textContent.trim()}),
      count: (document.getElementById('bootCount')||{}).textContent,
      status: (document.getElementById('bootStatus')||{}).textContent,
      three: (typeof window.THREE !== 'undefined') ? ('r' + window.THREE.REVISION) : 'MISSING',
      webgl: (function(){ try { var c=document.createElement('canvas'); var g=c.getContext('webgl2')||c.getContext('webgl'); return g ? 'yes' : 'no'; } catch(e){ return 'throw:'+e.message; } })(),
      stage: (function(){ var c=document.querySelector('.stage-canvas'); if(!c) return 'missing'; return c.width+'x'+c.height; })(),
      fxOwner: (typeof window.__rhineFxOwner !== 'undefined'),
      fxPointer: (getComputedStyle(document.documentElement).getPropertyValue('--fx-pointer-x') || '').trim().slice(0, 6),
      fxInteractive: document.querySelectorAll('.fx-interactive').length,
      fxGlass: (function(){ var el=document.querySelector('.panel')||document.querySelector('.top')||document.body; var v=getComputedStyle(el).backdropFilter||getComputedStyle(el).webkitBackdropFilter; return v||'none'; })(),
      silkSurfaces: document.querySelectorAll('.fx-silk-surface').length,
      silkLoopTasks: (window.__silkLoop ? window.__silkLoop.size : -1),
      silkPackets: document.querySelectorAll('#routeDiagram .silk-packet').length,
      silkRevealed: document.querySelectorAll('.is-revealed').length,
      silkWatching: document.querySelectorAll('.silk-watch').length,
      silkLite: document.documentElement.classList.contains('fx-lite'),
      ribbonStrands: document.querySelectorAll('.ribbon-strand').length,
      ribbonAccent: document.querySelectorAll('.ribbon-strand.is-accent').length,
      ribbonW: (function(){ var w=document.querySelector('.ribbon-wrap'); return w? Math.round(w.getBoundingClientRect().width):0; })(),
      docScrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      widest: (function(){ var out=[], all=document.querySelectorAll('body *'); for (var i=0;i<all.length;i++){ try{ var r=all[i].getBoundingClientRect(); if(r.width>0 && r.right>window.innerWidth+2){ out.push((all[i].tagName.toLowerCase())+'.'+(String(all[i].className||'').split(' ')[0])+'#'+(all[i].id||'')+'@'+Math.round(r.right)); } }catch(e){} if(out.length>=8)break; } return out; })(),
      bodyScrollW: document.body.scrollWidth,
      silkEase: (getComputedStyle(document.documentElement).getPropertyValue('--ease-smooth')||'').trim(),
      ambientNodes: document.querySelectorAll('.ambient-system > div').length,
      ambientOrbits: document.querySelectorAll('.ambient-orbit').length,
      ambientFlows: document.querySelectorAll('.ambient-flow').length,
      idleT: (getComputedStyle(document.documentElement).getPropertyValue('--fx-idle-t')||'').trim(),
      idlePhase: (getComputedStyle(document.documentElement).getPropertyValue('--fx-idle-phase')||'').trim(),
      orbitDur: (function(){ var el=document.querySelector('.ambient-orbit'); if(!el) return 'none'; var cs=getComputedStyle(el); return cs.animationDuration + '/' + cs.animationName; })(),
      glowDur: (function(){ var el=document.querySelector('.ambient-glow'); if(!el) return 'none'; var cs=getComputedStyle(el); return cs.animationDuration + '/' + cs.animationName; })(),
      flowDur: (function(){ var el=document.querySelector('.ambient-flow i'); if(!el) return 'none'; var cs=getComputedStyle(el); return cs.animationDuration + '/' + cs.animationName; })(),
      nodeDur: (function(){ var el=document.querySelector('.ambient-node'); if(!el) return 'none'; var cs=getComputedStyle(el); return cs.animationDuration + '/' + cs.animationName; })(),
      gridDur: (function(){ var el=document.querySelector('.bg__grid'); if(!el) return 'none'; var cs=getComputedStyle(el); return cs.animationDuration + '/' + cs.animationName; })()
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
    console.log('[probe] 启动序列进行中 = ' + boot.open + '  Three = ' + boot.three + '  WebGL = ' + boot.webgl + '  舞台 = ' + boot.stage);
  console.log('[probe] 动态层 = owner:' + boot.fxOwner + ' pointerX:' + boot.fxPointer + ' interactive:' + boot.fxInteractive + ' glass:' + boot.fxGlass);
  const silk2 = await win.webContents.executeJavaScript("(async () => { const p=document.querySelector('[data-view=\"network\"]'); if(p) p.click(); await new Promise(r=>setTimeout(r,1200)); return { packets: document.querySelectorAll('#routeDiagram .silk-packet').length, loop: (window.__silkLoop?window.__silkLoop.size:-1), lite: document.documentElement.classList.contains('fx-lite') }; })()");
  console.log('[probe] 网络页包流 = ' + JSON.stringify(silk2));
  console.log('[probe] 待机运动 = nodes:' + boot.ambientNodes + ' orbits:' + boot.ambientOrbits + ' flows:' + boot.ambientFlows + ' idleT:' + boot.idleT + ' phase:' + boot.idlePhase);
  console.log('[probe] 分层速度 = grid:' + boot.gridDur + ' | glow:' + boot.glowDur + ' | orbit:' + boot.orbitDur + ' | flow:' + boot.flowDur + ' | node:' + boot.nodeDur);
  console.log('[probe] 进程选择器 = ' + JSON.stringify(await win.webContents.executeJavaScript("(async () => { try { const r = await window.strongholdLink.network.processList({}); return { ok: r.ok, n: (r.rows||[]).length, sample: (r.rows||[]).slice(0,2).map(x => (x.name||'?')+':'+(x.ports[0]?x.ports[0].port:'-')) }; } catch (e) { return { ok:false, err:String(e&&e.message||e) }; } })()")));
  console.log('[probe] produce = ' + JSON.stringify({ hasPrepare: true }));
  console.log('[probe] 菜单栏 = ' + JSON.stringify({ visible: win.isMenuBarVisible(), autoHide: win.isMenuBarAutoHide(), appMenu: Menu.getApplicationMenu() === null }));
  console.log('[probe] 溢出元凶 = ' + JSON.stringify(boot.widest) + '  bodyScrollW:' + boot.bodyScrollW);
  console.log('[probe] 签名层 = strands:' + boot.ribbonStrands + ' accent:' + boot.ribbonAccent + ' wrapW:' + boot.ribbonW + ' docScrollW:' + boot.docScrollW + ' innerW:' + boot.innerW);
  console.log('[probe] 丝滑层 = surfaces:' + boot.silkSurfaces + ' loopTasks:' + boot.silkLoopTasks + ' packets:' + boot.silkPackets + ' revealed:' + boot.silkRevealed + '/' + boot.silkWatching + ' lite:' + boot.silkLite + ' ease:' + boot.silkEase);
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

  // 去掉应用菜单：界面自带导航，原生 File/Edit/View 菜单与整体设计冲突
try { Menu.setApplicationMenu(null); } catch (err) { /* 忽略 */ }

// 内存硬护栏 1／2：给 V8 设堆上限，避免 JS 堆无界增长导致进程被系统杀掉（闪退）
try { app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256'); } catch (err) { /* 忽略 */ }

// 内存硬护栏 2／2：总 Working Set 看护（超阈值先降级视觉，再超阈值重载界面回收内存）
const MEM_WARN_MB = Number(process.env.SHL_MEM_WARN_MB || 300);
const MEM_RELOAD_MB = Number(process.env.SHL_MEM_RELOAD_MB || 480);
let memWatchTimer = null;
function totalWorkingSetMB() {
  try {
    return app.getAppMetrics().reduce((sum, x) => sum + ((x.memory && x.memory.workingSetSize) || 0), 0) / 1024;
  } catch (err) { return 0; }
}
function startMemoryWatch() {
  if (memWatchTimer) return;
  let warned = false;
  memWatchTimer = setInterval(() => {
    const mb = totalWorkingSetMB();
    if (!mb) return;
    if (mb >= MEM_WARN_MB && !warned) {
      warned = true;
      logLine('内存看护：总 Working Set ' + mb.toFixed(0) + ' MB 已达阈值 ' + MEM_WARN_MB + ' MB，请求界面降级');
      try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:mem-pressure', { mb: Math.round(mb) }); } catch (err) { /* 忽略 */ }
    }
    if (mb >= MEM_RELOAD_MB) {
      logLine('内存看护：总 Working Set ' + mb.toFixed(0) + ' MB 超过 ' + MEM_RELOAD_MB + ' MB，重载界面以回收内存（防止闪退）');
      try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload(); } catch (err) { /* 忽略 */ }
    }
    if (mb < MEM_WARN_MB * 0.75) warned = false;
  }, 10000);
  if (memWatchTimer.unref) memWatchTimer.unref();
}
app.on('will-quit', () => { if (memWatchTimer) { clearInterval(memWatchTimer); memWatchTimer = null; } });

app.whenReady().then(async () => {
    logLine('app ready');
    registerIpc();
    if (IS_SMOKE) {
      const ok = await runSmoke();
      app.exit(ok ? 0 : 1);
      return;
    }
    if (CAPTURE_STEAM) { await runSteamProbe(); return; }
    if (CAPTURE_MATRIX) { await runMatrix(CAPTURE_DIR || path.join(APP_DIR, 'matrix-out')); return; }
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
