'use strict';
// Stronghold Link 后端业务分发（**不依赖 Electron**）。
//
// QML 版通过 backend/stronghold-backend.cjs 的 JSONL 协议调用这里；Electron 版在 Phase 5 被删除。
// 这一层只做三件事：参数白名单校验、调 network/*.cjs、把结果整理成可直接渲染的形状。
// 它不碰窗口、不碰渲染进程、不注册任何 IPC —— 那些是前端的事。
//
// 约定：
//   · 配置与日志位置与旧版完全一致：%APPDATA%\stronghold-link\{game-profiles.json, settings.json, startup.log}
//     （可用 SHL_CONFIG_DIR 覆盖，测试用；Electron 的 app.getPath('userData') 就是 ProductName 目录）
//   · 版本号单一来源 = package.json（旧版三处不一致见 AUDIT_FINDINGS A-05）
//   · 出错时抛 { code, friendly } 形状的错误，由协议层翻成 { ok:false, error:{ code, message } }

const path = require('node:path');
const fs = require('node:fs/promises');
const nodeFs = require('node:fs');
const { execFile } = require('node:child_process');

const pkg = require('../package.json');
const { SessionManager, inviteText, parseInvite } = require('../network/session.cjs');
const { diagnoseSteam } = require('../network/steam-env.cjs');
const { describeAdapters, describeRecipes, describeHints } = require('../network/adapters.cjs');
const { createLobbyManager } = require('../network/steam-lobby.cjs');
const listeningPorts = require('../network/listening-ports.cjs');
const procTable = require('../network/process-table.cjs');
const gameDetect = require('../network/game-detect.cjs');
const routeCatalog = require('../network/routes.cjs');
const netconfig = require('../network/steam-netconfig.cjs');
const { createRelayStatusMonitor } = require('../network/relay-status.cjs');

const VERSION = pkg.version;                       // 单一来源
const LOG_LIMIT = 256 * 1024;                      // 与旧版 STARTUP_LOG 的截断阈值一致
const MAX_PROFILES = 500;
const MAX_RULES = 16;
const DEFAULT_APP_ID = 480;

const TRANSPORT_CHOICES = Object.freeze(['env', 'auto', 'ice', 'relay']);
const TRANSPORT_LABELS = Object.freeze({
  env: '跟随启动环境',
  auto: '自动选路',
  ice: '强制直连',
  relay: '强制中继',
});
const DEFAULT_SETTINGS = Object.freeze({ transport: 'env' });

const SESSION_KEYS = ['role', 'relayPort', 'targetPort', 'targetHost', 'bindHost', 'authToken', 'maxConnections',
  'idleTimeoutMs', 'connectTimeoutMs', 'localPort', 'remoteHost', 'remotePort', 'game', 'rules', 'protocol',
  'adapter', 'gamePort', 'hostSteamId', 'appId', 'recipe'];
const NUMERIC_KEYS = ['relayPort', 'targetPort', 'localPort', 'remotePort', 'maxConnections', 'gamePort', 'appId',
  'idleTimeoutMs', 'connectTimeoutMs'];

const fail = (code, friendly) => {
  const err = new Error(friendly || code);
  err.code = code;
  err.friendly = friendly || code;
  return err;
};

function createBusiness({
  appDir,
  configDir = null,
  env = process.env,
  log = () => {},
  onEvent = () => {},
  sessionFactory = null,
  lobbyFactory = null,
} = {}) {
  const baseDir = path.resolve(appDir || path.join(__dirname, '..'));
  const dataDir = path.resolve(configDir
    || env.SHL_CONFIG_DIR
    || path.join(env.APPDATA || baseDir, 'stronghold-link'));
  const profilesPath = path.join(dataDir, 'game-profiles.json');
  const settingsPath = path.join(dataDir, 'settings.json');
  const logPath = path.join(dataDir, 'startup.log');

  let sessionNetConfig = null;      // 线路档位覆盖（null = 不覆盖，跟随环境变量）
  let preferredGamePort = null;
  let lobbyManager = null;
  let lastLobbyHostInfo = null;
  let relayMonitor = null;

  // ---------------------------------------------------------------- 日志

  function writeLogLine(text) {
    const line = `[${new Date().toISOString()}] ${text}\n`;
    try {
      nodeFs.mkdirSync(dataDir, { recursive: true });
      const stat = nodeFs.existsSync(logPath) ? nodeFs.statSync(logPath) : { size: 0 };
      if (stat.size > LOG_LIMIT) nodeFs.writeFileSync(logPath, '', 'utf8');
      nodeFs.appendFileSync(logPath, line, 'utf8');
    } catch { /* 日志写不进去不能影响主流程 */ }
    log(text);
  }

  // ---------------------------------------------------------- 设置 / 配置

  const validateSettings = (raw) => {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return { transport: TRANSPORT_CHOICES.includes(src.transport) ? src.transport : DEFAULT_SETTINGS.transport };
  };

  function effectiveTransport(transport) {
    try {
      const overrides = transport && transport !== 'env' ? { transport } : {};
      return netconfig.resolveNetConfig(overrides, env).transport || null;
    } catch { return null; }
  }

  function describeSettings(saved) {
    let envKey = 'SHL_STEAM_TRANSPORT';
    try { if (netconfig.TRANSPORT_ENV) envKey = netconfig.TRANSPORT_ENV; } catch { /* 用默认键名 */ }
    const effective = effectiveTransport(saved.transport);
    return {
      ...saved,
      choices: [...TRANSPORT_CHOICES],
      labels: { ...TRANSPORT_LABELS },
      effective,
      effectiveLabel: TRANSPORT_LABELS[effective] || effective || '未知',
      envKey,
      envValue: env[envKey] ? String(env[envKey]) : null,
    };
  }

  async function readSettings() {
    try {
      return validateSettings(JSON.parse(await fs.readFile(settingsPath, 'utf8')));
    } catch { return { ...DEFAULT_SETTINGS }; }
  }

  async function writeSettings(raw) {
    const clean = validateSettings(raw);
    await fs.mkdir(dataDir, { recursive: true });
    const temp = `${settingsPath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(clean, null, 2), 'utf8');
    await fs.rename(temp, settingsPath);
    return clean;
  }

  function applySettingToSession(saved) {
    sessionNetConfig = saved.transport === 'env' ? null : { transport: saved.transport };
    return saved;
  }

  function primeSettings() {
    try {
      const saved = validateSettings(JSON.parse(nodeFs.readFileSync(settingsPath, 'utf8')));
      applySettingToSession(saved);
      return saved;
    } catch {
      applySettingToSession({ ...DEFAULT_SETTINGS });
      return { ...DEFAULT_SETTINGS };
    }
  }

  async function readProfiles() {
    try {
      const raw = JSON.parse(await fs.readFile(profilesPath, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { profiles: [] };
      const list = Array.isArray(raw.profiles) ? raw.profiles : [];
      return { profiles: list.slice(0, MAX_PROFILES) };
    } catch { return { profiles: [] }; }
  }

  async function writeProfiles(raw) {
    const list = raw && Array.isArray(raw.profiles) ? raw.profiles.slice(0, MAX_PROFILES) : [];
    await fs.mkdir(dataDir, { recursive: true });
    const temp = `${profilesPath}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ profiles: list }, null, 2), 'utf8');
    await fs.rename(temp, profilesPath);
    return { profiles: list };
  }

  // ------------------------------------------------------------ 会话

  const session = (sessionFactory || ((opts) => new SessionManager(opts)))({
    appDir: baseDir,
    logDir: dataDir,
    onEvent: (event) => {
      if (event && event.type === 'tunnel') {
        try { writeLogLine(`[tunnel] ${JSON.stringify(event.payload || event)}`); } catch { /* 忽略 */ }
      }
      if (event && event.type === 'log' && event.entry && typeof event.entry.text === 'string'
        && event.entry.text.startsWith('[Steam] ')) {
        writeLogLine(`[session] ${event.entry.text}`);
      }
      onEvent('session.event', event);
    },
  });

  function sanitizeSessionInput(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('EINPUT', '会话参数无效');
    const out = {};
    for (const key of SESSION_KEYS) {
      if (!(key in raw) || raw[key] === undefined || raw[key] === null) continue;
      if (key === 'rules') {
        if (!Array.isArray(raw.rules) || !raw.rules.length || raw.rules.length > MAX_RULES) {
          throw fail('EINPUT', `端口规则必须是 1–${MAX_RULES} 条的数组`);
        }
        out.rules = raw.rules.map((rule) => {
          if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw fail('EINPUT', '端口规则格式无效');
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
    // 线路档位只能由后端按本机设置注入，前端不许直接改 Steam 传输层配置。
    delete out.netConfig;
    if (sessionNetConfig) out.netConfig = { ...sessionNetConfig };
    return out;
  }

  const appIdFromEnv = () => (env.SH_LINK_STEAM_APP_ID ? Number(env.SH_LINK_STEAM_APP_ID) : null);
  const localAddress = () => {
    try { return require('../network/session.cjs').localIPv4(); } catch { return null; }
  };

  const withInviteText = (snapshot) => ({
    ...snapshot,
    inviteText: snapshot && snapshot.invite ? inviteText(snapshot.invite) : '',
  });

  // ------------------------------------------------------------ 大厅

  function sendLobbyEvent(type, payload) {
    onEvent('lobby.event', { type, payload: payload || {}, at: Date.now() });
  }

  function getLobby() {
    if (!lobbyManager) {
      lobbyManager = (lobbyFactory || createLobbyManager)({
        appDir: baseDir,
        appId: appIdFromEnv() || DEFAULT_APP_ID,
        sdk: (typeof globalThis !== 'undefined' && globalThis.__SHL_TEST_STEAM_SDK__) || null,
        onEvent: (type, payload) => {
          sendLobbyEvent(type, payload);
          if (type === 'join-requested') {
            handleJoinRequest(payload).catch((err) => writeLogLine(`处理加入请求失败 ${err && err.message ? err.message : err}`));
          }
        },
      });
    }
    return lobbyManager;
  }

  async function handleJoinRequest({ lobbyId, friendSteamId, friendName }) {
    if (!lobbyId) return;
    const manager = getLobby();
    writeLogLine(`收到联机邀请：大厅 ${lobbyId}（来自 ${friendName || friendSteamId || '好友'}）`);
    const joined = await manager.join(lobbyId);
    lastLobbyHostInfo = joined && joined.host ? joined.host : null;
    sendLobbyEvent('join-result', {
      ok: Boolean(joined && joined.ok),
      reason: (joined && joined.reason) || null,
      lobbyId,
      host: (joined && joined.host) || null,
      from: friendName || friendSteamId || null,
    });
  }

  function resolveLobbyPort(input, config) {
    const explicit = Number(input && input.port) > 0 ? Number(input.port) : 0;
    if (explicit) return explicit;
    const fromSession = Number(config && (config.targetPort || config.gamePort)) > 0
      ? Number(config.targetPort || config.gamePort)
      : (Array.isArray(config && config.rules) && config.rules[0] && Number(config.rules[0].localPort) > 0
        ? Number(config.rules[0].localPort) : 0);
    if (fromSession) return fromSession;
    if (Number(preferredGamePort) > 0) return Number(preferredGamePort);
    try {
      const found = listeningPorts.listListeningPorts({});
      if (found && found.ok) {
        let table = null;
        if (found.entries.some((e) => procTable.needsCommandLine(e.process))) {
          const t = procTable.readProcessTable({});
          if (t.ok) table = t.rows;
        }
        const game = gameDetect.pickPrimaryGame(found.entries, { processTable: table });
        if (game && Number(game.port) > 0) return Number(game.port);
        const pick = listeningPorts.suggestSteamGamePort(found.entries, {});
        if (pick && Number(pick.port) > 0) return Number(pick.port);
      }
    } catch { /* 探测失败就不写端口 */ }
    return null;
  }

  function resolveLobbyGame(input, config) {
    const explicit = input && input.game ? String(input.game).slice(0, 64) : '';
    if (explicit) return explicit;
    const fromSession = config && config.game ? String(config.game).slice(0, 64) : '';
    if (fromSession) return fromSession;
    try {
      const found = listeningPorts.listListeningPorts({});
      if (found && found.ok) {
        const game = gameDetect.pickPrimaryGame(found.entries);
        if (game) return game.name;
      }
    } catch { /* 忽略 */ }
    return '';
  }

  async function openLobbyForSession(snapshot) {
    const config = (snapshot && snapshot.config) || {};
    if (config.adapter !== 'steam' || !snapshot || snapshot.role !== 'host') return null;
    const manager = getLobby();
    try {
      const result = await manager.create({
        maxMembers: Number(config.maxConnections) > 0 ? Math.min(Number(config.maxConnections) + 1, 64) : 4,
        hostSteamId: (snapshot.channels && snapshot.channels[0] && snapshot.channels[0].steamId) || null,
        port: resolveLobbyPort({}, config),
        game: String(config.game || ''),
        version: VERSION,
      });
      writeLogLine(result && result.ok
        ? `已创建 Steam 大厅 ${result.lobbyId}，可在好友页一键邀请`
        : `创建 Steam 大厅失败：${(result && result.reason) || '未知原因'}`);
      return result || null;
    } catch (err) {
      writeLogLine(`创建 Steam 大厅失败：${err && err.message ? err.message : err}`);
      return null;
    }
  }

  // ------------------------------------------------------- 线路与诊断

  function relayMonitorOnce() {
    if (!relayMonitor) {
      try { relayMonitor = createRelayStatusMonitor({}); } catch { relayMonitor = null; }
    }
    return relayMonitor;
  }

  async function relaySelfTest() {
    const monitor = relayMonitorOnce();
    if (!monitor || typeof monitor.snapshot !== 'function') {
      return { measured: false, reason: '本机没有可用的 Relay 状态监视器', availability: 'UNKNOWN' };
    }
    try {
      const snap = monitor.snapshot();
      return { measured: true, ...snap };
    } catch (err) {
      return { measured: false, reason: String(err && err.message ? err.message : err), availability: 'UNKNOWN' };
    }
  }

  function routeReport() {
    try {
      const candidates = routeCatalog.describeRouteCandidates({});
      const policy = typeof session.getRoutePolicy === 'function' ? session.getRoutePolicy() : null;
      return {
        ok: true,
        routePolicy: policy,
        candidates: Array.isArray(candidates) ? candidates : (candidates && candidates.candidates) || [],
        natHints: routeCatalog.NAT_HINTS || null,
        measured: false,
        unmeasuredReasons: routeCatalog.UNMEASURED_REASONS || null,
      };
    } catch (err) {
      return { ok: false, reason: String(err && err.message ? err.message : err), candidates: [] };
    }
  }

  function listeningPortsReport() {
    const found = listeningPorts.listListeningPorts({});
    if (!found || !found.ok) return { ok: false, reason: (found && found.reason) || '端口探测失败', candidates: [] };
    let table = null;
    try {
      if (found.entries.some((e) => procTable.needsCommandLine(e.process))) {
        const t = procTable.readProcessTable({});
        if (t.ok) table = t.rows;
      }
    } catch { /* 没有进程表也能给候选 */ }
    const ranked = listeningPorts.rankCandidates(found.entries, { processTable: table });
    const game = gameDetect.pickPrimaryGame(found.entries, { processTable: table });
    const pick = listeningPorts.suggestSteamGamePort(found.entries, {});
    return {
      ok: true,
      candidates: Array.isArray(ranked) ? ranked : [],
      game: game || null,
      steamPick: pick || null,
      rules: (() => {
        try { return listeningPorts.suggestRules(found.entries, {}); } catch { return []; }
      })(),
      used: found.used || null,
    };
  }

  function processListReport() {
    const table = procTable.readProcessTable({});
    if (!table || !table.ok) return { ok: false, reason: (table && table.reason) || '进程列表不可用', rows: [] };
    return { ok: true, rows: (table.rows || []).slice(0, 200) };
  }

  // ------------------------------------------------------------ 分发

  const routes = {
    'app.info': async () => ({
      version: VERSION,
      appDir: baseDir,
      configDir: dataDir,
      profilesFile: profilesPath,
      settingsFile: settingsPath,
      logFile: logPath,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      backend: 'stronghold-backend',
    }),
    'app.revealConfig': async () => {
      await new Promise((resolve) => {
        execFile('explorer.exe', [dataDir], { windowsHide: true }, () => resolve());
      });
      return { ok: true, configDir: dataDir };
    },
    'app.metrics': async () => {
      const mem = process.memoryUsage();
      return {
        ok: true,
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        externalBytes: mem.external,
        uptimeMs: Math.round(process.uptime() * 1000),
      };
    },
    'settings.load': async () => describeSettings(await readSettings()),
    'settings.save': async (params) => {
      const saved = applySettingToSession(await writeSettings(params));
      const info = describeSettings(saved);
      writeLogLine(`线路档位改为 ${saved.transport}（实际生效：${info.effectiveLabel}）`);
      return info;
    },
    'profiles.load': async () => readProfiles(),
    'profiles.save': async (params) => writeProfiles(params),

    'adapters.list': async () => {
      const running = session.state === 'running';
      const snapshot = session.getSnapshot();
      const config = (snapshot && snapshot.config) || {};
      const channelSummary = running
        ? (session.channels || []).map((c) => `${c.rule.protocol}:${c.listen.port}`).join('、')
        : '';
      const steamDiagnosis = diagnoseSteam({ appDir: baseDir, appId: appIdFromEnv() });
      return describeAdapters({
        steamDiagnosis,
        running,
        role: session.role,
        adapter: config.adapter || (running ? 'local' : null),
        rules: config.rules || [],
        channelSummary,
      });
    },
    'adapters.recipes': async () => {
      const steamDiagnosis = diagnoseSteam({ appDir: baseDir, appId: appIdFromEnv() });
      return describeRecipes({ steamAvailable: Boolean(steamDiagnosis.available) });
    },
    'adapters.recipeHints': async (params) => {
      const input = params && typeof params === 'object' ? params : {};
      const recipe = typeof input.recipe === 'string' ? input.recipe.slice(0, 40) : 'local-ports';
      const rules = Array.isArray(input.rules) ? input.rules.slice(0, MAX_RULES).map((rule) => ({
        protocol: String((rule && rule.protocol) || 'TCP').toUpperCase(),
        localPort: Number(rule && rule.localPort),
        remotePort: Number(rule && rule.remotePort),
      })).filter((rule) => Number.isInteger(rule.localPort) && Number.isInteger(rule.remotePort)) : [];
      return describeHints(recipe, {
        rules,
        gamePort: Number(input.gamePort) || null,
        localPort: Number(input.localPort) || null,
        targetHost: typeof input.targetHost === 'string' ? input.targetHost.slice(0, 255) : '127.0.0.1',
        lanAddress: localAddress(),
        game: typeof input.game === 'string' ? input.game.slice(0, 80) : '',
      });
    },
    'steam.diagnose': async () => diagnoseSteam({ appDir: baseDir, appId: appIdFromEnv() }),

    'session.start': async (params) => {
      const input = sanitizeSessionInput(params);
      if (Number(input.gamePort) > 0) preferredGamePort = Number(input.gamePort);
      const snapshot = await session.start(input);
      openLobbyForSession(snapshot).catch(() => { /* 建房失败不影响桥接 */ });
      return withInviteText(snapshot);
    },
    'session.stop': async () => {
      const snapshot = await session.stop();
      preferredGamePort = null;
      if (lobbyManager && lobbyManager.lobbyId && lobbyManager.isOwner) {
        lobbyManager.leave();
        sendLobbyEvent('lobby-left', { lobbyId: null, reason: '会话已停止' });
      }
      return snapshot;
    },
    'session.status': async () => withInviteText(session.getSnapshot()),
    'session.route': async () => {
      try { return session.getRouteReport(); } catch (err) {
        return { ok: false, route: 'UNKNOWN', routeLabel: 'UNKNOWN', reason: String(err && err.message ? err.message : err), channels: [] };
      }
    },
    'session.checkPort': async (params) => {
      const input = sanitizeSessionInput(params);
      return session.checkPort({
        port: input.relayPort != null ? input.relayPort : (input.localPort != null ? input.localPort : input.port),
        host: input.bindHost,
        protocol: input.protocol,
      });
    },
    'session.parseInvite': async (params) => {
      const code = typeof params === 'string' ? params : (params && params.code) || '';
      return parseInvite(String(code).slice(0, 4096));
    },

    'network.listeningPorts': async () => listeningPortsReport(),
    'network.processList': async () => processListReport(),
    'network.routes': async () => routeReport(),
    'network.relaySelfTest': async () => relaySelfTest(),

    'lobby.status': async () => {
      const manager = getLobby();
      const snap = typeof manager.snapshot === 'function' ? manager.snapshot() : {};
      return { ok: true, ...snap, hostInfo: lastLobbyHostInfo };
    },
    'lobby.friends': async () => {
      const manager = getLobby();
      const list = await manager.listFriends();
      return { ok: true, friends: Array.isArray(list) ? list : [] };
    },
    'lobby.create': async (params) => {
      const manager = getLobby();
      const input = params && typeof params === 'object' ? params : {};
      const snap = session.getSnapshot();
      const config = (snap && snap.config) || {};
      const result = await manager.create({
        maxMembers: Number(input.maxMembers) > 0 ? Math.min(Number(input.maxMembers), 64) : 4,
        hostSteamId: input.hostSteamId ? String(input.hostSteamId) : null,
        port: resolveLobbyPort(input, config),
        game: resolveLobbyGame(input, config),
        version: VERSION,
      });
      return { ok: Boolean(result && result.ok), ...(result || {}) };
    },
    'lobby.join': async (params) => {
      const input = params && typeof params === 'object' ? params : {};
      const lobbyId = input.lobbyId ? String(input.lobbyId) : (typeof params === 'string' ? params : '');
      if (!lobbyId) throw fail('EINPUT', '缺少大厅 ID');
      const manager = getLobby();
      const joined = await manager.join(lobbyId);
      lastLobbyHostInfo = (joined && joined.host) || null;
      return { ok: Boolean(joined && joined.ok), ...(joined || {}) };
    },
    'lobby.leave': async () => {
      const manager = getLobby();
      const result = await manager.leave();
      lastLobbyHostInfo = null;
      return { ok: Boolean(result && result.ok), ...(result || {}) };
    },
    'lobby.invite': async (params) => {
      const input = params && typeof params === 'object' ? params : {};
      const steamId = input.steamId ? String(input.steamId) : '';
      if (!steamId) throw fail('EINPUT', '缺少 SteamID');
      return getLobby().invite(steamId);
    },
    'lobby.setRoom': async (params) => {
      const input = params && typeof params === 'object' ? params : {};
      const room = input.room ? String(input.room).slice(0, 64) : '';
      return getLobby().setRoom(room);
    },
    'lobby.stop': async () => {
      if (lobbyManager) await lobbyManager.stop();
      lastLobbyHostInfo = null;
      return { ok: true };
    },
  };

  primeSettings();

  return {
    version: VERSION,
    dataDir,
    logPath,
    methods: Object.keys(routes).sort(),
    /** 未知方法必须报 EUNDEFINED，而不是静默当成功。 */
    async dispatch(method, params) {
      const handler = routes[method];
      if (typeof handler !== 'function') throw fail('EUNDEFINED', `未知方法：${method}`);
      return handler(params);
    },
    async shutdown() {
      try { await session.stop(); } catch { /* 已经停了 */ }
      try { if (lobbyManager) await lobbyManager.stop(); } catch { /* 已经停了 */ }
      try { if (typeof session.shutdown === 'function') session.shutdown(); } catch { /* 忽略 */ }
      try { if (relayMonitor && typeof relayMonitor.stop === 'function') relayMonitor.stop(); } catch { /* 忽略 */ }
      return { ok: true };
    },
    /** 供测试与协议层查询的内部句柄（不属于协议的一部分）。 */
    _internals: { session, getLobby, writeLogLine },
  };
}

module.exports = { createBusiness, VERSION, TRANSPORT_CHOICES };
