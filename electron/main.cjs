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
const { execFileSync } = require('node:child_process');
const net = require('node:net');
const { SessionManager, inviteText, parseInvite } = require('../network/session.cjs');
const { createTcpJoiner } = require('../network/tcp-relay.cjs');
const { diagnoseSteam } = require('../network/steam-env.cjs');
const { describeAdapters, describeRecipes, describeHints } = require('../network/adapters.cjs');
const { createLobbyManager } = require('../network/steam-lobby.cjs');

const APP_DIR = path.resolve(__dirname, '..');
const appIdFromEnv = () => (process.env.SH_LINK_STEAM_APP_ID ? Number(process.env.SH_LINK_STEAM_APP_ID) : null);
/** 本机对外可用的局域网 IPv4：取「默认路由所在网卡」，避免挑到移动热点/虚拟网卡（实测会挑到 192.168.137.1）。缓存 30 秒。 */
let lanCache = { at: 0, value: null };
function lanAddressFromRoute() {
  const now = Date.now();
  if (lanCache.value && now - lanCache.at < 30000) return lanCache.value;
  try {
    const script = "\$r = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1; " +
      "if (\$r) { (Get-NetIPAddress -InterfaceIndex \$r.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | " +
      "Where-Object { \$_.IPAddress -notlike '169.254.*' } | Select-Object -First 1).IPAddress }";
    const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 8000 }).trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(out)) { lanCache = { at: now, value: out }; return out; }
  } catch (err) { /* 退回启发式 */ }
  return null;
}

// 优先用「默认路由所在网卡」的地址（真正联网、同局域网可达的那个）；失败才退回启发式
const localAddress = () => lanAddressFromRoute() || require('../network/session.cjs').localIPv4();

const APP_VERSION = '0.13.3';
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
// PHASE 6 分辨率矩阵：设计基准 1600×900，验收下面五档。
// 900×650 是窗口最小值（见 createWindow 的 minWidth/minHeight），必须和其余四档一起过。
const MATRIX_SIZES = [[900, 650], [1200, 800], [1366, 768], [1600, 900], [1920, 1080]];
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
const CAPTURE_VIEWS = ['home', 'library', 'session', 'network', 'adapters', 'friends', 'settings'];

// 内存占用实测的三个批处理模式。单点读数只能说明"现在多大"，
// 所以探针改成同一进程内逐项开关的成对比较，排除轮次之间上百兆的噪声。
const MEM_PROBE = (() => {
  const hit = process.argv.find((arg) => arg.startsWith('--mem-probe='));
  return hit ? hit.slice('--mem-probe='.length) : null;
})();
const MEM_FLOOR = (() => {
  const hit = process.argv.find((arg) => arg.startsWith('--mem-floor='));
  return hit ? hit.slice('--mem-floor='.length) : null;
})();
const MEM_SOAK = (() => {
  const hit = process.argv.find((arg) => arg.startsWith('--mem-soak='));
  return hit ? hit.slice('--mem-soak='.length) : null;
})();
// 探针用的两个开关：--stage3d=0 以关闭状态启动，--stage-release=1 最小化后释放三维
const STAGE3D_OFF = process.argv.includes('--stage3d=0');
const STAGE_RELEASE = process.argv.includes('--stage-release=1');

// 内存看护的启动钩子：真实实现在下面的生命周期块里，块作用域外看不到，所以用钩子暴露。
// totalWorkingSetMB 同理——它和 startMemoryWatch 定义在同一个 else 块里，
// 模块顶层的探针直接调用会报 ReferenceError: totalWorkingSetMB is not defined。
let startMemoryWatchHook = null;
let totalWorkingSetHook = null;
const totalWorkingSetMBProbe = () => Math.round(totalWorkingSetHook ? totalWorkingSetHook() : 0);

// ---------------------------------------------------------------------------
// 启动日志：解决「双击后闪退、什么都看不到」的问题
// 日志写到 %APPDATA%\stronghold-link\startup.log（超过 256 KB 自动截断重写）。
// ---------------------------------------------------------------------------

const STARTUP_LOG = path.join(app.getPath('userData'), 'startup.log');
const LOG_LIMIT = 256 * 1024;

// 打包版从控制台启动时，父进程一旦退出，stdout 管道就断了。Node 会把 EPIPE
// 作为异步 error 事件抛在 process.stdout 上，try/catch 拦不住，会直接
// uncaughtException 把整个应用带走。这里显式吞掉管道错误。
try { process.stdout.on('error', () => {}); } catch { /* 无 stdout */ }
try { process.stderr.on('error', () => {}); } catch { /* 无 stderr */ }

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
// 应用设置（应用数据目录中的 settings.json）
//
// transport —— Steam P2P 线路档位，可选项：
//   'env'   不覆盖，跟随启动时的 SHL_STEAM_TRANSPORT 环境变量，没有就用出厂默认（强制直连）。
//           保留这一档是为了不悄悄推翻 docs/STEAM-联机步骤.md 里「先 set 再启动」那套排查办法。
//   'auto' / 'ice' / 'relay'
//           界面里直接指定。优先级高于环境变量 —— 见 network/steam-netconfig.cjs 的
//           resolveNetConfig：overrides.transport 会盖掉 TRANSPORT_ENV。
//
// 为什么要做成设置而不是只有环境变量：环境变量必须在**进程启动那一刻**就有，
// 而这个程序有单实例锁（app.requestSingleInstanceLock），旧进程没退干净时新进程会静默自杀，
// 环境变量根本读不到 —— 现场就踩过这个坑：改了 .cmd 启动，界面里还是旧档位。
// ---------------------------------------------------------------------------

const SETTINGS_PATH = () => path.join(app.getPath('userData'), 'settings.json');
const TRANSPORT_CHOICES = Object.freeze(['env', 'auto', 'ice', 'relay']);
const DEFAULT_SETTINGS = Object.freeze({ transport: 'env' });

function validateSettings(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const transport = TRANSPORT_CHOICES.includes(src.transport) ? src.transport : DEFAULT_SETTINGS.transport;
  return { transport };
}

/** 档位最终会变成什么（把环境变量与出厂默认也算进去），给界面显示用。 */
function effectiveTransport(transport) {
  try {
    const { resolveNetConfig } = require('../network/steam-netconfig.cjs');
    const overrides = transport && transport !== 'env' ? { transport } : {};
    return resolveNetConfig(overrides, process.env).transport || null;
  } catch (err) {
    return null;
  }
}

const TRANSPORT_LABELS = Object.freeze({
  env: '跟随启动环境',
  auto: '自动选路',
  ice: '强制直连',
  relay: '强制中继',
});

/** 把设置翻译成界面直接能显示的一整份状态（含"实际生效的是哪一档"）。 */
function describeSettings(saved) {
  let envKey = 'SHL_STEAM_TRANSPORT';
  try {
    const netconfig = require('../network/steam-netconfig.cjs');
    if (netconfig.TRANSPORT_ENV) envKey = netconfig.TRANSPORT_ENV;
  } catch (err) { /* 拿不到就用默认键名，不影响主流程 */ }
  const rawEnv = process.env[envKey];
  const effective = effectiveTransport(saved.transport);
  return {
    ...saved,
    choices: [...TRANSPORT_CHOICES],
    labels: { ...TRANSPORT_LABELS },
    effective,
    effectiveLabel: TRANSPORT_LABELS[effective] || effective || '未知',
    envKey,
    envValue: rawEnv ? String(rawEnv) : null,
  };
}

async function readSettings() {
  try {
    return validateSettings(JSON.parse(await fs.readFile(SETTINGS_PATH(), 'utf8')));
  } catch (err) {
    // 文件不存在或内容坏掉都不该让程序起不来：退回默认值，下一次保存会覆盖它。
    return { ...DEFAULT_SETTINGS };
  }
}

async function writeSettings(raw) {
  const clean = validateSettings(raw);
  const file = SETTINGS_PATH();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(clean, null, 2), 'utf8');
  await fs.rename(temp, file);
  return clean;
}

/**
 * 启动时要下发的 Steam 网络配置覆盖。
 * null = 什么都不覆盖（等价于旧版本的行为）。
 */
let sessionNetConfig = null;

/** 同步读一次设置，把 sessionNetConfig 准备好。在 registerIpc 里调一次即可。 */
function primeSettings() {
  try {
    const saved = validateSettings(JSON.parse(nodeFs.readFileSync(SETTINGS_PATH(), 'utf8')));
    sessionNetConfig = saved.transport === 'env' ? null : { transport: saved.transport };
    return saved;
  } catch (err) {
    sessionNetConfig = null;
    return { ...DEFAULT_SETTINGS };
  }
}

function applySettingToSession(saved) {
  sessionNetConfig = saved.transport === 'env' ? null : { transport: saved.transport };
  return saved;
}

// ---------------------------------------------------------------------------
// 隧道体检日志
//
// 连接为什么断、断在哪一侧、断的时候还积压着多少字节 —— 这些以前只有界面
// 能看到，而游戏卡住的时候界面恰恰是最不可靠的观察点（route 取样会退化成
// 「当前没有活动连接」）。这里把隧道事件原样写进 startup.log，出问题时直接
// 看日志最后几十行就能定位。
// ---------------------------------------------------------------------------

const PEER_STATS_LOG_MS = 2000;
const TUNNEL_ERROR_LOG_MS = 5000;
let lastPeerStatsLogAt = 0;
let lastTunnelErrorLogAt = 0;
let lastTunnelErrorKey = '';

function compact(value, limit = 200) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

const kib = (bytes) => Math.round((Number(bytes) || 0) / 1024);
const secs = (ms) => Math.round((Number(ms) || 0) / 1000);

// Steam 的连接结束原因（ESteamNetConnectionEnd）。数值区间本身就是分类：
// 1000–1999 应用层正常结束，2000–2999 应用层异常结束，3000–3999 本机侧网络问题，
// 4000–4999 对端侧网络问题，5000–5999 传输层问题。有了它才能分清"是谁断的"。
const CONNECTION_END_NAMES = new Map([
  [0, 'Steam 没给原因'],
  [3001, '本机处于离线模式'],
  [3002, '本机连不上 Steam 中继'],
  [3003, '本机的主中继不可用'],
  [3004, '本机网络配置有问题'],
  [3005, '账号权限不足'],
  [3006, '本机拿不到公网地址（打洞失败）'],
  [4001, '★对端超时：对方没在规定时间内回应'],
  [4002, '对端加密校验失败'],
  [4003, '对端证书不合法'],
  [4006, '对端协议版本不匹配'],
  [4007, '对端打洞失败（P2P ICE 拿不到公网地址）'],
  [5001, '传输层通用错误'],
  [5002, '传输层内部错误'],
  [5003, '★传输层超时'],
  [5005, '与 Steam 的连接出问题'],
  [5006, '建立不了中继会话'],
  [5008, 'P2P 会合失败'],
  [5009, '★NAT / 防火墙挡住了'],
  [5010, '对端没有回应连接请求'],
]);

const CONNECTION_END_KINDS = {
  ClosedByPeer: '对端关掉了这条 Steam 连接',
  ProblemDetectedLocally: '本机判定这条 Steam 连接出问题',
  LocalServiceClosed: '本机游戏服务把这条件接关了',
  LocalClientClosed: '浏览器/游戏自己关掉了本机连接',
  LocalTunnelAbort: '我们主动掐断了这条连接',
};

function describeEndReason(code) {
  if (code == null || code === '') return '未给';
  const n = Number(code);
  if (!Number.isFinite(n)) return String(code);
  const exact = CONNECTION_END_NAMES.get(n);
  if (exact) return `${n}（${exact}）`;
  if (n >= 1000 && n <= 1999) return `${n}（应用层正常结束）`;
  if (n >= 2000 && n <= 2999) return `${n}（应用层异常结束）`;
  if (n >= 3000 && n <= 3999) return `${n}（本机侧网络问题）`;
  if (n >= 4000 && n <= 4999) return `${n}（对端侧网络问题）`;
  if (n >= 5000 && n <= 5999) return `${n}（传输层问题）`;
  return `${n}（未知区间）`;
}

function logTunnelEvent(event) {
  const type = event && event.event;
  const payload = (event && event.payload) || {};
  const tag = event && event.channel ? `[${event.channel}] ` : '';

  if (type === 'peer-stats') {
    const now = Date.now();
    if (now - lastPeerStatsLogAt < PEER_STATS_LOG_MS) return;
    lastPeerStatsLogAt = now;
    const peers = Array.isArray(payload.peers) ? payload.peers : [];
    const pool = payload.pool;
    // 池子那一段即使一条连接都没有也要打（"池子是空的"本身就是最关键的现场证据）。
    const poolText = pool
      ? `预热池 备用${pool.warm || 0}/${pool.target || 0} 累计开${pool.created || 0} 就绪${pool.ready || 0} 命中${pool.hits || 0} 未命中${pool.misses || 0} 换新${pool.retired || 0} 自死${pool.lost || 0} 均寿${(pool.retired || pool.lost) ? Math.round((pool.lifeMs || 0) / ((pool.retired || 0) + (pool.lost || 0)) / 1000) : 0}s`
      : '';
    if (!peers.length && !poolText) return; // 没有连接也没池子就没必要刷屏
    const text = peers
      .map((p) => `:${p.port || '?'} 存活${secs(p.ageMs)}s 上行${kib(p.bytesToPeer)}KiB 下行${kib(p.bytesFromPeer)}KiB 残留${kib(p.outBytes)}KiB${p.paused ? ' 暂停中' : ''}${p.stalled ? ' 已停摆' : ''}${p.status ? ` | ${compact(p.status, 120)}` : ''}`)
      .join(' || ');
    logLine(`${tag}隧道存量 ${peers.length} 条${poolText ? ` ｜ ${poolText}` : ''}：${text || '（无连接）'}`);
    return;
  }

  if (type === 'peer-left') {
    const kind = CONNECTION_END_KINDS[payload.kind] || payload.kind || '未知方式';
    // willRetry：这次不是收尾，而是"一个字节都没回来"的握手失败，正在悄悄重连。
    // 打上标记才看得出"偶发几次"和"一直在失败"的区别 —— 后者说明线路或对端根本没通。
    const retry = payload.willRetry ? ` ⟳第${payload.retry || '?'}次重连` : '';
    // attemptMs：这一次握手从 connectP2P 到被 Steam 判死用了多久。**这是判断
    // "到底是超时参数太紧还是链路真不通"的唯一硬指标** —— 卡在 ~10000ms 就是
    // 撞上了出厂 TimeoutInitial（已由 network/steam-netconfig.cjs 的 timeoutInitial=30000 放宽），
    // 卡在 ~30000ms 则是放宽之后仍然握不上手，得换线路档位。
    const attempt = Number.isFinite(payload.attemptMs) ? ` 握手耗时=${secs(payload.attemptMs)}s` : '';
    const retried = payload.retried ? ` 已重试${payload.retried}次` : '';
    logLine(
      `${tag}连接结束（${kind}）理由=${payload.reason || '无'}${retry}${attempt}${retried} `
      + `Steam原因=${describeEndReason(payload.endReason)} 存活=${secs(payload.ageMs)}s `
      + `上行=${kib(payload.bytesToPeer)}KiB 下行=${kib(payload.bytesFromPeer)}KiB 残留=${kib(payload.outBytes)}KiB`,
    );
    return;
  }

  if (type === 'client-added') {
    // 命中池子 = 这条本机连接一秒钟都没等（浏览器/游戏不会看到转圈）。
    // 这条日志是"预热池到底有没有用"最直接的证据：满屏"临时握手"就说明池子被抽干了。
    const how = payload.warm ? `拿的是池子里现成的（养了${secs(payload.waitedMs)}s）` : '临时握手（池子当时是空的）';
    logLine(`${tag}本机连接进来 ${payload.peer || '?'} —— ${how}`);
    return;
  }

  if (type === 'peer-connected') {
    logLine(`${tag}连接已接通 ${payload.peer || ''} 本机端口=${payload.port || '?'}`);
    return;
  }

  if (type === 'error') {
    const err = payload.error || {};
    const key = `${payload.stage || ''}|${err.code || ''}`;
    const now = Date.now();
    if (key === lastTunnelErrorKey && now - lastTunnelErrorLogAt < TUNNEL_ERROR_LOG_MS) return;
    lastTunnelErrorLogAt = now;
    lastTunnelErrorKey = key;
    logLine(`${tag}隧道错误 阶段=${payload.stage || '未知'} 代码=${err.code || '无'} 说明=${err.friendly || err.message || compact(err)}`);
    return;
  }

  if (type === 'rejected') {
    logLine(`${tag}拒绝了本机连接 原因=${payload.reason || '未知'} 来源=${payload.peer || '未知'}`);
    return;
  }

  if (type === 'stopped') {
    logLine(`${tag}隧道已停止`);
    return;
  }

  logLine(`${tag}隧道事件 ${type} ${compact(payload, 160)}`);
}

// ---------------------------------------------------------------------------
// 全局网络参数下发结果
//
// 为什么非要写进日志：`TimeoutInitial` 这类参数**只有真的下发给 Steam 才有效**，
// 而下发是"设一项读回一项"的（见 network/steam-netconfig.cjs 的三条纪律）。
// 界面上的「Steam globals」那一行能看，可游戏卡住的时候界面恰恰最不可靠。
// 写进 startup.log 之后，"建连超时到底放宽了没有"从日志一眼可判，不用再猜。
// ---------------------------------------------------------------------------

let netConfigLogged = false;
let netConfigTries = 0;

function formatNetConfigApplied(applied) {
  if (!Array.isArray(applied) || !applied.length) return '无';
  return applied.map((item) => {
    if (!item || typeof item !== 'object') return String(item);
    const shown = item.effective === null || item.effective === undefined ? '读不回' : item.effective;
    const flag = item.ok === false ? '✘' : (item.effective !== item.requested ? '≠' : '✔');
    return `${flag}${item.name || item.key}=${shown}`;
  }).join(' ');
}

/**
 * 会话起来之后补一条"全局参数实际生效情况"的日志。
 *
 * 路由报告要等通道注册好才有 netConfig，所以隔一会儿轮询几次；
 * 拿到一次就永远不再写（一个进程只关心自己启动时那一份）。
 */
function logNetConfigSoon() {
  if (netConfigLogged) return;
  netConfigTries += 1;
  if (netConfigTries > 8) return; // 约 12 秒还没拿到就放弃，不刷屏
  setTimeout(() => {
    if (netConfigLogged) return;
    try {
      const report = session.getRouteReport();
      const nc = report && report.netConfig;
      if (!nc) { logNetConfigSoon(); return; }
      netConfigLogged = true;
      logLine(`[网络参数] 传输偏好=${nc.transport || '?'} 下发=${nc.available ? '成功' : `失败（${nc.reason || '原因未知'}）`}`
        + ` 实际生效：${formatNetConfigApplied(nc.applied)}`);
      if (Array.isArray(nc.changed) && nc.changed.length) logLine(`[网络参数] 与出厂值不同：${nc.changed.join(' ')}`);
      if (Array.isArray(nc.notes) && nc.notes.length) logLine(`[网络参数] 备注：${nc.notes.join('；')}`);
    } catch (err) {
      logNetConfigSoon();
    }
  }, 1500);
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

const session = new SessionManager({
  appDir: APP_DIR,
  onEvent: (event) => {
    if (event && event.type === 'tunnel') {
      logTunnelEvent(event);
      // 会话可能是自动起来的（大厅一键加入），不一定走 session:start。
      // 隧道事件一开始流，就说明通道已经就绪，这时候去读全局参数报告最靠谱。
      logNetConfigSoon();
    }
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
  // 线路档位只能由主进程决定：先丢掉调用方可能塞进来的任何值，再按本机设置注入。
  // 渲染进程不该有能力改 Steam 传输层配置。
  delete out.netConfig;
  if (sessionNetConfig) out.netConfig = { ...sessionNetConfig };
  return out;
}

/** 把主进程内部的错误翻译成渲染进程能直接展示的文案（IPC 只保留 message）。 */
/**
 * 归一化"大厅里的房主连接信息"。
 * 真实形状：snapshot().host = { hostSteamId, port, game, room, version }
 *          join() 返回 { ok, lobbyId, host: {...} }
 * 这里同时接受 { host: {...} } 与扁平对象，避免再出现"读错键名导致永远为空"的问题。
 */
/**
 * 会话 AppID 的唯一解析入口。
 * 必须与「SESSION 页手动启动」用同一个值：两端 AppID 不一致时，
 * Steam 会接受 P2P 连接但**不转发数据** —— 表现为"隧道已建立、HTTP 却超时"。
 */
function resolveSessionAppId(input, snapshot) {
  const explicit = Number(input && input.appId) > 0 ? Number(input.appId) : 0;
  if (explicit) return explicit;
  const cfg = (snapshot && snapshot.config) || {};
  const fromConfig = Number(cfg.appId) > 0 ? Number(cfg.appId) : 0;
  if (fromConfig) return fromConfig;
  try {
    // 与 adapters:list / diagnoseSteam 用的是同一个来源，避免两处解析不一致
    const env = Number(appIdFromEnv());
    if (env > 0) return env;
  } catch (err) { /* 忽略 */ }
  return null;
}

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
  primeSettings();   // 线路档位必须在任何一次 session:start 之前就准备好
  ipcMain.handle('profiles:load', () => readProfiles());
  ipcMain.handle('profiles:save', (_event, profiles) => writeProfiles(profiles));
  // 线路档位：界面读写都走这里，改完立刻生效（下一次启动会话时下发），不需要重启程序。
  ipcMain.handle('settings:load', async () => {
    const saved = await readSettings();
    return describeSettings(saved);
  });
  ipcMain.handle('settings:save', async (_event, raw) => {
    const saved = applySettingToSession(await writeSettings(raw));
    const info = describeSettings(saved);
    logLine(`线路档位改为 ${saved.transport}（实际生效：${info.effectiveLabel}）`);
    return info;
  });

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
      logNetConfigSoon();
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
  // 活连接的线路报告：走的是 Steam 中继还是点对点直连，两端 POP 各是哪个，
  // 以及原始 socket 计数与 Steam 自报速率的对照。空转时如实回 UNKNOWN，不冒充直连。
  ipcMain.handle('session:route', () => {
    try {
      return session.getRouteReport();
    } catch (err) {
      return { ok: false, route: 'UNKNOWN', routeLabel: 'UNKNOWN', reason: err.message, channels: [] };
    }
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

// 把异常变成一句人话：界面只展示 message，从不展示堆栈。
const errText = (err) => String(err && err.message ? err.message : err);

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
      try {
        const url = 'http://127.0.0.1:' + entry + '/';
        const r = await httpProbe(url);
        const gameName = String((info && info.game) || '');
        const httpish = !/minecraft|java 版|基岩|terraria|泰拉|幻兽|帕鲁|英灵|valheim|rust|cs2|factorio/i.test(gameName);
        add(httpish ? '隧道转发 HTTP（仅浏览器类游戏有意义）' : '隧道转发 HTTP（对 ' + (gameName || '本游戏') + ' 无意义，超时属正常）', r.ok || !httpish,
          r.ok ? ('GET ' + url + ' → HTTP ' + r.status + (r.looksLikeGame ? ' · 内容是网页（说明数据真的从房主那边过来了）' : ' · 但内容不像游戏页面'))
               : ('GET ' + url + ' 失败：' + r.reason + ' → 隧道没起作用'));
        // 这一支是"加入者的隧道已经在跑"。入口端口就是 entry 本身，不是房主的服务端口：
        // 本地入口由加入者这侧自己挑，和房主端口不同号是正常的，照实说明即可。
        const samePort = Number(port) === Number(entry);
        add('浏览器该打开的地址', true, samePort
          ? (url + '（入口端口 ' + entry + ' 与房主服务端口同号，直接用这个地址打开）')
          : (url + '（入口端口 ' + entry + ' 与房主服务端口 ' + (port || '-') + ' 不同，这是正常的：只打开这个本地入口地址）'));
      } catch (err) {
        add('隧道入口', false, '这一项没能检查完：' + errText(err));
      }
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
          const addr4 = '127.0.0.1:' + e3;
            const r3 = await httpProbe(url3);
            add('隧道入口', true, '已自动建立：' + url3 + '（入口端口与房主服务端口同号）');
            add('隧道转发 HTTP（决定性）', r3.ok, r3.ok ? ('GET ' + url3 + ' → HTTP ' + r3.status + (r3.looksLikeGame ? ' · 内容是网页（数据确实来自房主）' : ' · 内容不像游戏页面')) : ('GET ' + url3 + ' 失败：' + r3.reason + ' → 隧道没把数据送过来'));
            add('浏览器该打开的地址', true, url3);
            add('本游戏请这样测隧道', true, '打开 Minecraft → 多人游戏 → 直接连接 → 填 ' + addr4 + '（Minecraft 走二进制协议，HTTP 探测本来就会超时）');
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
    // 自检自己出错时，**绝不能把已经拿到的检查项丢掉** —— 那正是最需要它的时候。
    // 老代码在这里 return { ok:false }，而界面在 ok:false 时把整份报告替换成一行
    // "自检失败"，等于自检在最需要它的场景下失效（用户实际遇到的就是这个）。
    checks.push({ name: '自检', ok: false, detail: '自检本身出错：' + errText(err) + '（以上是出错前已经拿到的结果）' });
    return { ok: true, checks, verdict: '发现断点：见标红项' };
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
        appId: resolveSessionAppId(input, session.getSnapshot()),
      }));
      logLine('已按选定端口 ' + port + ' 启动房主会话（AppID ' + (resolveSessionAppId(input, session.getSnapshot()) || '未指定') + '），准备等待好友加入');
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
      appId: resolveSessionAppId(input, current),
      appVersion: APP_VERSION,
    });
    if (plan.action !== 'start') {
      // "已经连上了"不是失败，而是"已就绪"：直接把入口端口与网址返回，界面照常打开游戏。
      // 之前把它当失败处理，用户看到的是"连接失败：已经通过大厅连上了这条隧道" —— 与事实相反。
      const cur0 = session.getSnapshot();
      const ch0 = cur0.channels && cur0.channels[0];
      const entryNow = ch0 && ch0.listen ? ch0.listen.port : null;
      const alreadyUp = /已经通过大厅连上|已经以房主身份在等/.test(String(plan.reason || ''));
      if (alreadyUp && entryNow) {
        return {
          ok: true, already: true, action: 'none', reason: plan.reason, notes: plan.notes,
          room: (info && info.room) || '',
          hostPort: Number(info && info.port) > 0 ? Number(info.port) : null,
          entryPort: entryNow,
          entryUrl: 'http://127.0.0.1:' + entryNow,
          entryHint: '隧道已就绪：用浏览器打开 http://127.0.0.1:' + entryNow,
          snapshot: cur0, status: snap,
        };
      }
      // 一键纠正：加入者本机残留房主会话时，先停掉它再重试（用户点按钮才会走到这里）
      if (plan.needsHostStop && input.fix === true) {
        try {
          await session.stop();
          logLine('已按「以加入者身份重连」停掉本机残留的房主会话');
        } catch (err) { /* 停不掉就按原样返回原因 */ }
        const retry = planLobbyConnect({
          role: manager.isOwner ? 'host' : 'joiner',
          lobby, session: session.getSnapshot(),
          appId: resolveSessionAppId(input, current),
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
    settingsPath: SETTINGS_PATH(),
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
  // 真实进程内存，界面底部状态条直接读这个值，不做估算
  ipcMain.handle('app:metrics', () => {
    let procs = [];
    try {
      procs = app.getAppMetrics().map((x) => ({
        type: String((x.type || 'unknown')),
        mb: Number((((x.memory && x.memory.workingSetSize) || 0) / 1024).toFixed(1)),
        cpu: Number(((x.cpu && x.cpu.percentCPUUsage) || 0).toFixed(1)),
      }));
    } catch (err) { procs = []; }
    const totalMB = Number(procs.reduce((sum, p) => sum + p.mb, 0).toFixed(0));
    return { totalMB, processes: procs };
  });
  // 无边框窗口的自绘窗口按钮。全部只操作主窗口，拿不到窗口时如实返回 ok:false。
  const windowAction = (fn) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, reason: 'NO_WINDOW' };
    try { fn(mainWindow); } catch (err) { return { ok: false, reason: String((err && err.message) || err) }; }
    return { ok: true, ...readWindowState() };
  };
  // 只读窗口状态，任何一步失败都落 false，绝不让界面因为读状态而报错。
  // 测试桩里的 mainWindow 是个只有少数字段的对象，所以每个方法都要先看存在性。
  const readWindowState = () => {
    const w = mainWindow;
    const alive = w != null && typeof w.isDestroyed === 'function' && !w.isDestroyed();
    const call = (fn) => { try { return !!fn(); } catch (err) { return false; } };
    return {
      maximized: alive && typeof w.isMaximized === 'function' ? call(() => w.isMaximized()) : false,
      fullscreen: alive && typeof w.isFullScreen === 'function' ? call(() => w.isFullScreen()) : false,
    };
  };
  ipcMain.handle('window:minimize', () => windowAction((w) => w.minimize()));
  ipcMain.handle('window:toggle-maximize', () => windowAction((w) => {
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
  }));
  ipcMain.handle('window:toggle-fullscreen', () => windowAction((w) => {
    w.setFullScreen(!w.isFullScreen());
  }));
  ipcMain.handle('window:close', () => windowAction((w) => w.close()));
  ipcMain.handle('window:state', () => {
    const state = readWindowState();
    const ready = mainWindow != null;
    return { ok: ready, ...state };
  });
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

function createWindow({ show = true, query = null } = {}) {
  const win = new BrowserWindow({
    autoHideMenuBar: true,          // 不显示原生菜单栏（界面自带导航）
    // 去掉原生标题栏：那一条深色横条与整体空间化界面冲突，且白占 32px 高度。
    // 代价是窗口按钮要自己画，最小化/最大化/全屏/关闭四个按钮在界面右上角，
    // 顶部留一条 30px 拖动区。原生 Aero Snap 仍然可用，拖动标题区到屏幕边缘即可。
    frame: false,
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
      // 界面里没有一个可编辑的文本域，拼写检查只会在渲染进程常驻一套词典与后台请求。
      spellcheck: false,
    },
  });
  // query.capture=1 时渲染进程会跳过启动序列（截图与自检需要立即看到主界面）
  if (query) win.loadFile(path.join(__dirname, '../src/ui/index.html'), { query });
  else win.loadFile(path.join(__dirname, '../src/ui/index.html'));
  win.webContents.on('did-finish-load', () => logLine('渲染进程加载完成'));
  // 无边框窗口：窗口状态改变后要主动告诉渲染进程，界面上的最大化/全屏按钮
  // 才能显示正确的图标与 pressed 状态。原生拖动、双击标题区、Win+方向键、
  // 以及系统全屏切换都会走到这里。
  const pushWindowState = () => {
    if (win.isDestroyed()) return;
    const state = { maximized: win.isMaximized(), fullscreen: win.isFullScreen() };
    try { win.webContents.send('window:state', state); } catch (err) { /* 忽略 */ }
  };
  for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) {
    win.on(ev, pushWindowState);
  }
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
  const shotViews = CAPTURE_VIEWS.slice();
  const win = createWindow({ show: true, query: { capture: "1", ...(FORCE_MOTION ? { motion: "force" } : {}) } });
  mainWindow = win;
  if (typeof startMemoryWatchHook === 'function') startMemoryWatchHook();
  // 最小化 / 隐藏 / 失焦时通知渲染进程停掉所有动画（省电、省 CPU/内存）
  const notifyActivity = (active) => {
    try { if (win && !win.isDestroyed()) win.webContents.send('app:activity', { active: Boolean(active) }); } catch (err) { /* 忽略 */ }
  };
  // 仅用于自测：SHL_PAUSE_TEST=1 时 3 秒后强制发一次"暂停"，便于对比 CPU 占用
  // 仅用于自测：SHL_PAUSE_TEST=1 时 3 秒后真实最小化窗口（走完整路径：minimize 事件 -> IPC -> 渲染进程暂停）
  if (process.env.SHL_PAUSE_TEST === '1') setTimeout(() => { try { win.minimize(); } catch (err) { /* 忽略 */ } }, 3000);
  try {
    win.on('minimize', () => notifyActivity(false));
    win.on('hide', () => notifyActivity(false));
    win.on('blur', () => notifyActivity(false));
    win.on('restore', () => notifyActivity(true));
    win.on('show', () => notifyActivity(true));
    win.on('focus', () => notifyActivity(true));
    win.webContents.on('did-finish-load', () => notifyActivity(win.isFocused() && !win.isMinimized()));
  } catch (err) { /* 事件挂载失败不影响主流程 */ }   // 启动总内存看护（超阈值降级 / 重载）
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
// 内存实测三件套
// 所有数字都取自 app.getAppMetrics() 的 workingSetSize，与任务管理器同源。
//   --mem-floor=<json>  空壳基线：同样的 webPreferences，页面换成一张白纸
//   --mem-soak=<json>   长稳序列：正常界面挂机，每 30 秒一采样，看内存涨不涨
//   --mem-probe=<json>  成对比较：同进程内逐项开关三维与模糊，取改前改后的差值
// ---------------------------------------------------------------------------

// 空壳基线。用来把「Electron 自身的地板」与「本应用多出来的部分」分开报数，
// 否则无法判断某个内存目标到底能不能达到。
async function runMemFloor(outPath) {
  const floorWin = new BrowserWindow({
    width: 1400,
    height: 900,
    show: true,
    backgroundColor: '#11181b',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false
    }
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await floorWin.loadURL('data:text/html,<title>floor</title><body style="background:%2311181b"></body>');
  await wait(14000);
  const procs = app.getAppMetrics().map((x) => ({
    type: x.type,
    service: x.serviceName || null,
    mb: Math.round(((x.memory && x.memory.workingSetSize) || 0) / 1024)
  })).sort((a, b) => b.mb - a.mb);
  const total = totalWorkingSetMBProbe();
  console.log('[mem] floor blank  total=' + total + ' MB  ' +
    procs.map((p) => p.type + (p.service ? '(' + p.service + ')' : '') + ':' + p.mb).join(' '));
  try {
    nodeFs.writeFileSync(outPath, JSON.stringify({
      samples: [{ label: 'blank', totalMB: total, procs: procs }],
      note: '空壳基线：同样的 webPreferences，页面替换成一张白纸，用来分离 Electron 地板与应用自身开销'
    }, null, 2), 'utf8');
    console.log('[mem] 写出 ' + outPath);
  } catch (err) { console.log('[mem] 写出失败 ' + err.message); }
  try { floorWin.destroy(); } catch (err) { /* 忽略 */ }
}

// 长稳序列。单点读数只能说明"现在多大"，涨不涨要靠时间序列。
async function runMemSoak(outPath) {
  const soakWin = createWindow({ show: true, query: FORCE_MOTION ? { motion: 'force' } : undefined });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const rows = [];
  const take = async (t) => {
    const procs = app.getAppMetrics().map((x) => ({
      type: x.type,
      service: x.serviceName || null,
      mb: Math.round(((x.memory && x.memory.workingSetSize) || 0) / 1024)
    })).sort((a, b) => b.mb - a.mb);
    const total = totalWorkingSetMBProbe();
    // 关键对照：workingSetSize 含共享页，会被系统与别的进程带偏；
    // 只有渲染进程自己的 JS 堆与 DOM 数才是"我们分配的"。
    // 三个数一起看才能分清「我们自己涨了」与「系统记账变了」。
    let heap = null;
    let dom = null;
    try {
      const js = await soakWin.webContents.executeJavaScript(
        "({heap:(performance.memory&&Math.round(performance.memory.usedJSHeapSize/1048576))||null," +
        "dom:document.getElementsByTagName('*').length})"
      );
      heap = js.heap;
      dom = js.dom;
    } catch (err) { /* 采样失败不打断序列 */ }
    console.log('[soak] t=' + t + 's  total=' + total + ' MB  ' +
      procs.map((p) => p.type + ':' + p.mb).join(' ') +
      '  | jsHeap=' + heap + 'MB dom=' + dom);
    rows.push({ at: t, totalMB: total, procs: procs, jsHeapMB: heap, domNodes: dom });
  };
  await new Promise((resolve) => soakWin.webContents.once('did-finish-load', resolve));
  const minutes = Math.max(1, Number(process.env.SHL_SOAK_MIN || 5));
  const step = 30;
  for (let t = 0; t <= minutes * 60; t += step) {
    if (t > 0) await wait(step * 1000);
    await take(t);
  }
  const first = rows[0].totalMB;
  const last = rows[rows.length - 1].totalMB;
  const peak = rows.reduce((m, r) => Math.max(m, r.totalMB), 0);
  console.log('[soak] 起 ' + first + ' MB  末 ' + last + ' MB  峰 ' + peak + ' MB  净增 ' + (last - first) + ' MB');
  try {
    nodeFs.writeFileSync(outPath, JSON.stringify({
      minutes: minutes, stepSeconds: step, samples: rows,
      firstMB: first, lastMB: last, peakMB: peak, netGrowthMB: last - first,
      note: '正常界面挂机序列，用来判断内存是否随时间上涨'
    }, null, 2), 'utf8');
    console.log('[soak] 写出 ' + outPath);
  } catch (err) { console.log('[soak] 写出失败 ' + err.message); }
  try { soakWin.destroy(); } catch (err) { /* 忽略 */ }
}

// 成对比较。逐轮单独跑不同配置没有可比性，同一配置两轮之间能差 100MB 以上，
// 所以把开关搬进同一个进程，每项都是"改之前 / 改之后"两次读数。
// 顺序：关模糊 → 还原 → 销毁三维 → 重建。
async function runMemProbe(outPath) {
  const stage3d = STAGE3D_OFF ? '0' : '1';
  const release = STAGE_RELEASE ? '1' : '0';
  const query = Object.assign({ capture: '1' },
    FORCE_MOTION ? { motion: 'force' } : {},
    { stage3d: stage3d, stagerelease: release });
  const win = createWindow({ show: true, query: query });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const sample = (label) => {
    const procs = app.getAppMetrics().map((x) => ({
      type: x.type,
      pid: x.pid,
      name: x.name || null,
      service: x.serviceName || null,
      mb: Math.round(((x.memory && x.memory.workingSetSize) || 0) / 1024),
      cpu: x.cpu && typeof x.cpu.percentCPUUsage === 'number' ? Number(x.cpu.percentCPUUsage.toFixed(1)) : null
    })).sort((a, b) => b.mb - a.mb);
    const total = totalWorkingSetMBProbe();
    console.log('[mem] ' + label + '  total=' + total + ' MB  ' +
      procs.map((p) => p.type + (p.service ? '(' + p.service + ')' : '') + ':' + p.mb).join(' '));
    return { label: label, totalMB: total, procs: procs };
  };
  // 每份读数都带上渲染进程自报的三维状态，避免"以为关了其实没关"
  const stageState = async () => {
    try {
      return await win.webContents.executeJavaScript(
        "({attr:document.documentElement.getAttribute('data-stage-3d')," +
        "canvas:!!document.querySelector('.stage-canvas')," +
        "has3d:document.documentElement.classList.contains('has-3d')," +
        "live:!!(window.__shlStage&&window.__shlStage.live())})"
      );
    } catch (err) { return { error: String((err && err.message) || err) }; }
  };
  // 渲染进程侧的内存构成：只看总 Working Set 无法判断该往哪里优化
  const rendererDiag = async () => {
    try {
      return await win.webContents.executeJavaScript(`(() => {
        const m = performance.memory || {};
        const sheets = Array.from(document.styleSheets);
        let rules = 0; try { for (const s of sheets) rules += (s.cssRules || []).length; } catch (e) { /* 跨源 */ }
        let gl = null;
        try {
          const c = document.createElement('canvas');
          const g = c.getContext('webgl2') || c.getContext('webgl');
          if (g) {
            const d = g.getExtension('WEBGL_debug_renderer_info');
            gl = d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
            const lose = g.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
          }
        } catch (e) { /* 忽略 */ }
        return {
          jsHeapMB: m.usedJSHeapSize ? Math.round(m.usedJSHeapSize / 1048576) : null,
          jsTotalMB: m.totalJSHeapSize ? Math.round(m.totalJSHeapSize / 1048576) : null,
          domNodes: document.getElementsByTagName('*').length,
          sheets: sheets.length,
          rules: rules,
          canvases: document.querySelectorAll('canvas').length,
          backdropNodes: (() => { let n = 0; for (const el of document.querySelectorAll('*')) { const s = getComputedStyle(el); if (s.backdropFilter && s.backdropFilter !== 'none') n++; } return n; })(),
          scripts: Array.from(document.scripts).map((s) => (s.src || '').split('/').pop()).filter(Boolean),
          gl: gl
        };
      })()`);
    } catch (err) { return { error: String((err && err.message) || err) }; }
  };
  const setNoBlur = async (on) => {
    try {
      return await win.webContents.executeJavaScript(`(() => {
        const id = '__shl_noblur';
        const old = document.getElementById(id);
        if (${on ? 'true' : 'false'}) {
          if (!old) {
            const s = document.createElement('style');
            s.id = id;
            s.textContent = '*{backdrop-filter:none !important;-webkit-backdrop-filter:none !important}';
            document.head.appendChild(s);
          }
        } else if (old) { old.remove(); }
        return document.getElementById(id) ? 'on' : 'off';
      })()`);
    } catch (err) { return 'error:' + String((err && err.message) || err); }
  };
  const setStage3d = async (on) => {
    try {
      return await win.webContents.executeJavaScript(
        "(function(){ if(!window.__shlStage) return 'no-api'; " +
        (on ? "if(!window.__shlStage.live()) window.__shlStage.enable(); return 'enable';"
          : "window.__shlStage.disable(); return 'disable';") +
        ' })()'
      );
    } catch (err) { return 'error:' + String((err && err.message) || err); }
  };
  const reading = async (label) => {
    const row = Object.assign(sample(label), { stage: await stageState() });
    row.blur = await win.webContents.executeJavaScript(
      "document.getElementById('__shl_noblur') ? 'off' : 'on'"
    ).catch(() => '?');
    return row;
  };

  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  await wait(16000);                       // 等 GLB 加载完、阵列稳定、GPU 侧缓存落定

  const rows = [];
  rows.push(await reading('baseline'));
  await setNoBlur(true);   await wait(14000); rows.push(await reading('no-blur'));
  await setNoBlur(false);  await wait(14000); rows.push(await reading('blur-back'));
  await setStage3d(false); await wait(14000); rows.push(await reading('no-3d'));
  await setStage3d(true);  await wait(16000); rows.push(await reading('3d-back'));

  const delta = (a, b) => rows[a].totalMB - rows[b].totalMB;
  console.log('[mem] 成对差值  关模糊=' + delta(1, 0) + 'MB  还原=' + delta(2, 1) +
    'MB  销毁三维=' + delta(3, 2) + 'MB  重建三维=' + delta(4, 3) + 'MB');

  const out = {
    argv: { stage3d: stage3d, release: release, forceMotion: FORCE_MOTION },
    samples: rows,
    paired: { noBlur: delta(1, 0), blurBack: delta(2, 1), no3d: delta(3, 2), back3d: delta(4, 3) },
    renderer: await rendererDiag(),
    note: 'Working Set 取自 app.getAppMetrics()，与任务管理器同源。成对差值在同进程内测得，排除轮次噪声。'
  };
  const rd = out.renderer || {};
  console.log('[mem] 渲染进程 diag  jsHeap=' + rd.jsHeapMB + 'MB/' + rd.jsTotalMB + 'MB  dom=' + rd.domNodes +
    '  sheets=' + rd.sheets + '  rules=' + rd.rules + '  canvas=' + rd.canvases +
    '  backdrop=' + rd.backdropNodes + '  gl=' + rd.gl);
  try {
    nodeFs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
    console.log('[mem] 写出 ' + outPath);
  } catch (err) { console.log('[mem] 写出失败 ' + err.message); }
  try { win.destroy(); } catch (err) { /* 忽略 */ }
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

const gotLock = (IS_SMOKE || CAPTURE_MATRIX || MEM_PROBE || MEM_FLOOR || MEM_SOAK) ? true : app.requestSingleInstanceLock();
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
// 注：曾试过 --low-mem（关闭 GPU 加速）以降内存，实测反而从 ~400MB 升到 ~515MB（软件合成更耗内存），故移除。
// max-semi-space-size 压小新生代，四个进程各让出几 MB；界面实测 JS 堆只有 12MB，不怕多跑几次小 GC。
try { app.commandLine.appendSwitch('js-flags', '--max-old-space-size=192 --max-semi-space-size=4'); } catch (err) { /* 忽略 */ }

// 内存硬护栏 1.5／2：关掉本项目用不到的 Chromium 后台服务。
// 这些都是浏览器形态才需要的常驻件：组件更新、翻译、媒体路由、自动填充联网、媒体会话、崩溃上报。
// 本项目只加载本地文件，网络全部自己用 net.Socket 与 Steam 走，关掉不损失任何功能。
// 刻意不动 CalculateNativeWinOcclusion：窗口被遮挡时停止渲染是省 CPU 的关键，
// 最小化与失焦的暂停另走 win.on('minimize'/'blur') 那条链路。
// 实测记录：这一批开关加上 spellcheck:false，两次跑 baseline 仍是 393 / 395MB，
// 与不加之前的 388-394MB 无差别。留着是因为无害，且能少起几个后台任务，别指望它降内存。
try {
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  app.commandLine.appendSwitch('disable-domain-reliability');
  app.commandLine.appendSwitch('disable-breakpad');
  app.commandLine.appendSwitch('disable-client-side-phishing-detection');
  app.commandLine.appendSwitch('no-default-browser-check');
  app.commandLine.appendSwitch('no-first-run');
  app.commandLine.appendSwitch('disk-cache-size', '1');
  app.commandLine.appendSwitch('disable-features', [
    'MediaRouter',
    'OptimizationHints',
    'Translate',
    'HardwareMediaKeyHandling',
    'MediaSessionService',
    'GlobalMediaControls',
    'AutofillServerCommunication',
    'CertificateTransparencyComponentUpdater'
  ].join(','));
} catch (err) { /* 忽略 */ }


// 内存硬护栏 2／2：总 Working Set 看护（超阈值先降级视觉，再超阈值重载界面回收内存）
const MEM_WARN_MB = Number(process.env.SHL_MEM_WARN_MB || 300);
const MEM_RELOAD_MB = Number(process.env.SHL_MEM_RELOAD_MB || 480);
let memWatchTimer = null;
function totalWorkingSetMB() {
  try {
    return app.getAppMetrics().reduce((sum, x) => sum + ((x.memory && x.memory.workingSetSize) || 0), 0) / 1024;
  } catch (err) { return 0; }
}
totalWorkingSetHook = totalWorkingSetMB;
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
startMemoryWatchHook = startMemoryWatch;
app.on('will-quit', () => { if (memWatchTimer) { clearInterval(memWatchTimer); memWatchTimer = null; } });

app.whenReady().then(async () => {
    logLine('app ready');
    // 界面全部是本地文件，从不发 HTTP 请求；关掉拼写检查并清掉历史 HTTP 缓存，
    // 省下渲染进程常驻的词典与磁盘缓存映射。失败不影响启动。
    try {
      const defaultSession = require('electron').session.defaultSession;
      defaultSession.setSpellCheckerEnabled(false);
      defaultSession.clearCache().catch(() => { /* 忽略 */ });
    } catch (err) { /* 忽略 */ }
    registerIpc();
    if (IS_SMOKE) {
      const ok = await runSmoke();
      app.exit(ok ? 0 : 1);
      return;
    }
    if (CAPTURE_STEAM) { await runSteamProbe(); return; }
    if (MEM_FLOOR) { await runMemFloor(MEM_FLOOR); return; }
    if (MEM_SOAK) { await runMemSoak(MEM_SOAK); return; }
    if (MEM_PROBE) { await runMemProbe(MEM_PROBE); return; }
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
