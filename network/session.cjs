'use strict';
// Stronghold Link — 会话控制器（运行在 Electron 主进程）。
//
// 一个「会话」= 一组通道（channel）。每条端口规则生成一个通道：
//   TCP 规则 -> network/tcp-relay.cjs
//   UDP 规则 -> network/udp-relay.cjs
// 房主与加入者都支持一次启动多条规则（多端口批量启动，阶段 2）。
//
// 规则语义（与配置里的 ports[] 一致，两端对称）：
//   { protocol: 'TCP'|'UDP', localPort, remotePort }
//   房主：localPort = 本地服务端口（转发目标），remotePort = 对好友开放的中继端口（监听）
//   加入者：localPort = 本机入口端口（监听），remotePort = 房主中继端口（转发目标）
//
// 状态机：idle -> starting -> running -> stopping -> idle，异常进入 error。
// 不在这里做的事：加密与真正的身份认证（阶段 3）、Steam P2P（阶段 4）。口令握手/逐包口令只是防误连。

const net = require('node:net');
const dgram = require('node:dgram');
const os = require('node:os');
const crypto = require('node:crypto');
const { withPortOwner, describeError } = require('./errors.cjs');
const { createLocalRelayProvider } = require('./providers/local-relay.cjs');
const { createSteamP2PProvider } = require('./providers/steam-p2p.cjs');
const { STEAM_ID_PATTERN } = require('./steam-adapter.cjs');
const { diagnoseSteam } = require('./steam-env.cjs');
const { normalizeRoutePolicy, describeRoutePolicy } = require('./route/policy.cjs');
const { planStandby } = require('./route/standby.cjs');
const { planMigration, describeMigration } = require('./route/migrate.cjs');
const { describeHints, getRecipe } = require('./adapters.cjs');

const STATES = Object.freeze({ IDLE: 'idle', STARTING: 'starting', RUNNING: 'running', STOPPING: 'stopping', ERROR: 'error' });
const READY_TIMEOUT_MS = 8000;
const PROBE_TIMEOUT_MS = 900;
const MAX_LOGS = 120;
const MAX_RULES = 16;
const INVITE_PREFIX = 'SHL1-';
const INVITE_VERSION = 2;
const PROTOCOLS = new Set(['TCP', 'UDP']);

/** 「不做转发」时的安全说明：不能让人以为有隧道。 */
function guidanceSecurityProfile() {
  return {
    mode: 'none',
    cipher: '不适用（未建立任何隧道）',
    kex: '不适用',
    kdf: '不适用',
    auth: '不适用（由目标服务自身与局域网环境决定）',
    replayProtection: '不适用',
    note: '这条连接方式不做任何转发：本工具只整理地址，流量走你自己的局域网/客户端直连。',
  };
}

/** 一次会话的安全属性（阶段 3）。未设口令时为明文转发。 */
function securityProfile(encrypted) {
  return encrypted
    ? {
      mode: 'psk-aead',
      cipher: 'AES-256-GCM',
      kex: 'X25519（每次会话临时密钥，前向保密）',
      kdf: 'HKDF-SHA256',
      auth: 'PSK（scrypt 硬化，双向 HMAC 认证）',
      replayProtection: 'TCP 严格递增记录号 / UDP 计数器 + 滑动窗口',
      note: '口令本身是唯一信任来源：口令泄露等于会话泄露。',
    }
    : {
      mode: 'plain',
      cipher: '无',
      kex: '无',
      kdf: '无',
      auth: '无（同一网络内知道端口的人都能连上）',
      replayProtection: '无',
      note: '未设置口令：链路上是明文，仅建议在完全可信的网络里临时使用。',
    };
}

function newToken() {
  return crypto.randomBytes(9).toString('base64url');
}

function intInRange(value, min, max, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    const err = new Error(`${label}必须是 ${min}–${max} 的整数`);
    err.code = 'EINVALIDPORT';
    err.friendly = err.message;
    throw err;
  }
  return n;
}

function cleanString(value, label, maxLength = 255) {
  if (typeof value !== 'string') { const e = new Error(`${label}必须是文本`); e.friendly = e.message; throw e; }
  const s = value.trim();
  if (!s) { const e = new Error(`${label}不能为空`); e.friendly = e.message; throw e; }
  if (s.length > maxLength) { const e = new Error(`${label}长度不能超过 ${maxLength} 个字符`); e.friendly = e.message; throw e; }
  if (/[\u0000-\u001f\u007f]/.test(s)) { const e = new Error(`${label}包含非法控制字符`); e.friendly = e.message; throw e; }
  return s;
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  err.friendly = message;
  throw err;
}

const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];

/** 把一条规则规范化；protocol 缺省为 TCP。 */
function normalizeRule(rule, index = 0) {
  const label = `第 ${index + 1} 条规则`;
  if (!rule || typeof rule !== 'object') fail('EINVALIDRULE', `${label}格式无效`);
  const protocol = String(rule.protocol || 'TCP').toUpperCase();
  if (!PROTOCOLS.has(protocol)) fail('EINVALIDRULE', `${label}的协议必须是 TCP 或 UDP`);
  return {
    protocol,
    localPort: intInRange(rule.localPort, 1, 65535, `${label}的本地端口`),
    remotePort: intInRange(rule.remotePort, 1, 65535, `${label}的远端端口`),
  };
}

/**
 * 把 IPC 入参整理成规则数组。
 * 支持两种写法：1) rules: [{protocol, localPort, remotePort}...]；2) 旧的单通道字段。
 */
function normalizeRules(input, role) {
  let rules;
  if (Array.isArray(input.rules)) {
    if (!input.rules.length) fail('EINVALIDRULE', '至少需要一条端口规则');
    if (input.rules.length > MAX_RULES) fail('EINVALIDRULE', `一次最多启动 ${MAX_RULES} 条端口规则`);
    rules = input.rules.map((rule, index) => normalizeRule(rule, index));
  } else if (role === 'host') {
    rules = [normalizeRule({ protocol: input.protocol || 'TCP', localPort: input.targetPort, remotePort: input.relayPort }, 0)];
  } else {
    rules = [normalizeRule({ protocol: input.protocol || 'TCP', localPort: input.localPort, remotePort: input.remotePort }, 0)];
  }

  const seen = new Map();
  for (const rule of rules) {
    const key = `${rule.protocol}`;
    const listenPort = role === 'host' ? rule.remotePort : rule.localPort;
    const targetPort = role === 'host' ? rule.localPort : rule.remotePort;
    if (seen.has(`${key}:${listenPort}`)) fail('EDUPLICATE', `同一个 ${rule.protocol} 监听端口 ${listenPort} 出现了多次，请检查规则`);
    seen.set(`${key}:${listenPort}`, true);
    const targetHost = role === 'host' ? (input.targetHost || '127.0.0.1') : (input.remoteHost || '');
    if (listenPort === targetPort && LOOPBACK.includes(targetHost)) {
      fail('EPORTCONFLICT', `${rule.protocol} 规则里 ${listenPort} 同时是监听端口和转发目标，会形成自我循环`);
    }
  }
  return rules;
}

/** 取本机第一个可用的局域网 IPv4（用于生成邀请信息）。 */
function localIPv4() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const [name, list] of Object.entries(nets)) {
    for (const info of list || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      candidates.push({ name, address: info.address });
    }
  }
  const preferred = candidates.find((c) => /^192\.168\./.test(c.address))
    || candidates.find((c) => /^10\./.test(c.address))
    || candidates.find((c) => /^172\.(1[6-9]|2\d|3[01])\./.test(c.address));
  return (preferred || candidates[0] || null)?.address || '127.0.0.1';
}

function encodeInvite(payload) {
  return INVITE_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** 解析邀请码（兼容 v1 单通道与 v2 多规则）。格式不正确时抛出带 friendly 文案的错误。 */
function parseInvite(code) {
  const raw = String(code || '').trim();
  const failInvite = (msg) => { const e = new Error(msg); e.code = 'EINVALIDINVITE'; e.friendly = msg; throw e; };
  if (!raw) failInvite('邀请码不能为空');
  if (!raw.toUpperCase().startsWith(INVITE_PREFIX)) failInvite('邀请码格式不正确（应以 SHL1- 开头）');
  let payload;
  try {
    payload = JSON.parse(Buffer.from(raw.slice(INVITE_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    failInvite('邀请码内容无法解析，请确认复制完整');
  }
  if (!payload || typeof payload !== 'object') failInvite('邀请码内容无效');
  if (payload.v !== 1 && payload.v !== INVITE_VERSION) failInvite(`邀请码版本不支持（v${payload.v}），请确认两端版本一致`);
  const host = cleanString(payload.host, '邀请码中的地址', 255);
  const port = intInRange(payload.port, 1, 65535, '邀请码中的端口');
  const token = typeof payload.token === 'string' ? payload.token : '';
  let rules;
  if (Array.isArray(payload.rules)) {
    rules = payload.rules.map((rule, index) => normalizeRule(rule, index));
  } else {
    rules = [{ protocol: 'TCP', localPort: port, remotePort: port }];
  }
  return { v: payload.v, game: typeof payload.game === 'string' ? payload.game.slice(0, 80) : '', host, port, token, rules };
}

function inviteText(info) {
  if (info.adapter === 'steam') {
    const lines = [
      'Stronghold Link Steam 邀请',
      `服务：${info.game || '未指定'}`,
      `传输方式：Steam P2P（加密与身份认证由 Steam 负责）`,
      `房主 SteamID：${info.steamId || info.host}`,
      '',
      '加入者怎么做：',
    ];
    for (const hint of info.hints || []) lines.push(`  · ${hint}`);
    return lines.join('\n');
  }

  if (info.adapter === 'none') {
    const lines = [
      'Stronghold Link 连接说明（本次不做转发）',
      `服务：${info.game || '未指定'}`,
      `房主地址：${info.host}:${info.port}`,
      '',
      '加入者怎么做：',
    ];
    for (const hint of info.hints || []) lines.push(`  · ${hint}`);
    lines.push('', '注意：这条路径不经过本工具转发，需要双方在同一局域网（或已有 VPN）。');
    return lines.join('\n');
  }

  const lines = [
    'Stronghold Link 会话邀请',
    `服务：${info.game || '未指定'}`,
    `房主地址：${info.host}`,
    `口令：${info.token || '（无，双方都不要填口令）'}`,
    '端口规则（协议,本地端口,远端端口）：',
  ];
  for (const rule of info.rules || []) lines.push(`  ${rule.protocol},${rule.localPort},${rule.remotePort}`);
  lines.push(`邀请码：${info.code}`);
  if (Array.isArray(info.hints) && info.hints.length) {
    lines.push('', '加入者怎么做：');
    for (const hint of info.hints) lines.push(`  · ${hint}`);
  }
  return lines.join('\n');
}

/** TCP 端口是否空闲（绑定 + 主动连接双重判断）。 */
function checkTcpPortFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const server = net.createServer();
    const done = (free, code) => {
      try { server.removeAllListeners(); } catch { /* ignore */ }
      resolve({ free, code: code || null, port, host });
    };
    server.once('error', (err) => done(false, err.code || 'ERROR'));
    server.once('listening', () => server.close(() => done(true)));
    try { server.listen(port, host); } catch (err) { done(false, err.code || 'ERROR'); }
  });
}

/**
 * 让操作系统分配一个当前空闲的 TCP 端口。
 * 用途：加入者/房主的「监听端口」留空或写 0 时自动挑一个，避免「3000 被游戏服务端占用」这种冲突。
 * （先 listen(0) 拿到号码再关掉，随后立刻由中继重新绑定；存在极小竞态，因此失败会有清晰报错。）
 */
function allocateFreePort(host = '0.0.0.0') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** UDP 端口是否空闲（Windows 上 UDP 会按地址精确判定，绑定成功即可认为空闲）。 */
function checkUdpPortFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    let settled = false;
    const done = (free, code) => {
      if (settled) return;
      settled = true;
      try { socket.removeAllListeners(); } catch { /* ignore */ }
      resolve({ free, code: code || null, port, host });
    };
    socket.once('error', (err) => done(false, err.code || 'ERROR'));
    try {
      socket.bind({ port, address: host, exclusive: true }, () => socket.close(() => done(true)));
    } catch (err) { done(false, err.code || 'ERROR'); }
  });
}

/** 兼容旧调用：默认按 TCP 检查。 */
function checkPortFree(port, host = '0.0.0.0') {
  return checkTcpPortFree(port, host);
}

/** TCP 可达性探测（仅用于启动提示，不阻断会话）。 */
function probe(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** UDP 端口是否已被占用 = 本地游戏服务是否已经在监听（用于提示，不阻断）。 */
function probeUdpPort(host, port) {
  return checkUdpPortFree(port, host).then((result) => !result.free);
}

/**
 * 通道统计：统一从 Provider 取。
 * Provider 内部镜像内核的计数（network/stats.cjs），所以这里读到的仍是内核的真实数字；
 * 字段名与重构前保持一致，界面与 RouteManager 不需要跟着改。
 */
function channelStats(channel) {
  const empty = {
    connections: 0, totalConnections: 0, rejected: 0, failed: 0,
    bytesToPeer: 0, bytesFromPeer: 0, packetsToPeer: 0, packetsFromPeer: 0,
    encrypted: false, sessionId: null, totalPeers: 0, rateToPeer: 0, rateFromPeer: 0,
  };
  if (!channel || !channel.provider || typeof channel.provider.getStats !== 'function') return empty;
  const s = channel.provider.getStats() || {};
  return {
    connections: s.connections || 0,
    totalConnections: s.totalConnections || 0,
    rejected: s.rejected || 0,
    failed: s.failed || 0,
    bytesToPeer: s.bytesToPeer || 0,
    bytesFromPeer: s.bytesFromPeer || 0,
    packetsToPeer: s.packetsToPeer || 0,
    packetsFromPeer: s.packetsFromPeer || 0,
    encrypted: Boolean(s.encrypted),
    sessionId: s.sessionId || null,
    totalPeers: s.totalPeers || 0,
    rateToPeer: s.rateToPeer || 0,
    rateFromPeer: s.rateFromPeer || 0,
  };
}

function newStats() {
  return { connections: 0, totalConnections: 0, rejected: 0, failed: 0, bytesToPeer: 0, bytesFromPeer: 0, packetsToPeer: 0, packetsFromPeer: 0 };
}

/** Steam 通道的安全属性：加密与身份认证由 Steam 传输层负责，我们不叠加自己的口令层。 */
function steamSecurityProfile() {
  return {
    mode: 'steam-transport',
    cipher: 'Steam 传输层加密（Valve SDR）',
    kex: 'Steam Networking Sockets（NAT 穿透 / 中继自动选择）',
    kdf: '不适用',
    auth: 'SteamID 身份（Steam 账号）',
    replayProtection: '由 Steam 传输层保证',
    note: 'Steam 通道自带加密与身份认证，本工具不再叠加口令层；不需要填会话口令。',
  };
}

class SessionManager {
  constructor({ onEvent = null, appDir = null, steamSdk = null, steamModule = null } = {}) {
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
    // 多通道选路开关（默认关闭，见 docs/多通道选路设计.md）；这里只保存策略，不改通道行为
    this.routePolicy = normalizeRoutePolicy(null);
    this.appDir = appDir || require('node:path').resolve(__dirname, '..');
    // 仅供测试注入假 SDK；生产路径由 steam-adapter 自己初始化真实 SDK
    this.steamSdk = steamSdk;
    this.steamModule = steamModule;
    this.state = STATES.IDLE;
    this.role = null;
    /** 真实计数的采样序列（最多 60 点），停止时清空 */
    this.samples = [];
    this.channels = [];
    this.relay = null; // 兼容字段：第一个通道的 Provider（P3 起 relay 即 provider）
    this.config = null;
    this.invite = null;
    this.security = securityProfile(false);
    this.lastError = null;
    this.warnings = [];
    this.samples = [];
    this.logs = [];
    this.startedAt = null;
    this._pending = null;
    this._seq = 0;
  }

  log(text, level = 'info') {
    const entry = { seq: ++this._seq, ts: Date.now(), level, text };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
    this._emit({ type: 'log', entry });
  }

  _emit(event) {
    if (!this.onEvent) return;
    try { this.onEvent(event); } catch { /* 事件监听方出错不影响会话 */ }
  }

  _setState(state) {
    this.state = state;
    this._emit({ type: 'state', snapshot: this.getSnapshot() });
  }

  _aggregate() {
    const total = newStats();
    for (const channel of this.channels) {
      const s = channelStats(channel);
      total.connections += s.connections || 0;
      total.totalConnections += s.totalConnections || 0;
      total.rejected += s.rejected || 0;
      total.failed += s.failed || 0;
      total.bytesToPeer += s.bytesToPeer || 0;
      total.bytesFromPeer += s.bytesFromPeer || 0;
      total.packetsToPeer += s.packetsToPeer || 0;
      total.packetsFromPeer += s.packetsFromPeer || 0;
    }
    return total;
  }

  getSnapshot() {
    const totals = this._aggregate();
    const metrics = this.state === STATES.RUNNING ? this._sampleMetrics(totals) : { rateToPeer: 0, rateFromPeer: 0, samples: this.samples.slice(-60) };
    return {
      metrics,
      state: this.state,
      role: this.role,
      startedAt: this.startedAt,
      lastError: this.lastError,
      config: this.config,
      invite: this.invite,
      security: this.security,
      warnings: this.warnings.slice(0, 8),
      channels: this.channels.map((channel) => ({
        protocol: channel.rule.protocol,
        rule: channel.rule,
        listen: channel.listen,
        peer: channel.peer,
        steamId: channel.steamId || null,
        provider: channel.provider ? channel.provider.id : null,
        stats: channelStats(channel),
      })),
      ...totals,
      logs: this.logs.slice(-40),
    };
  }

  _label(channel) {
    return `[${channel.rule.protocol}:${channel.listen.port}]`;
  }

  _handleRelayEvent(type, payload = {}, channel) {
    const tag = channel ? this._label(channel) : '';
    switch (type) {
      case 'listening':
        this.log(this.role === 'host'
          ? `${tag} 已监听，转发到 ${channel.peer.host}:${channel.peer.port}`
          : `${tag} 已监听本机入口，转发到房主 ${channel.peer.host}:${channel.peer.port}`);
        break;
      case 'connection':
        this.log(`${tag} 新的本机连接：${payload.peer || '未知来源'}`);
        break;
      case 'client-added':
        this.log(`${tag} 新的对端会话：${payload.peer || '未知来源'}`);
        break;
      case 'client-expired':
      case 'local-expired':
        this.log(`${tag} 会话超时回收：${payload.peer || ''}`, 'warn');
        break;
      case 'handshake-ok':
        this.log(`${tag} 口令验证通过：${payload.peer || '未知来源'}`, 'ok');
        break;
      case 'peer-connected':
        this.log(`${tag} 已接通${this.role === 'host' ? '本地服务端口' : '房主中继'}`, 'ok');
        break;
      case 'rejected':
        this.log(`${tag} 已拒绝一个连接（${
          payload.reason === 'max-connections' || payload.reason === 'max-clients' || payload.reason === 'max-peers' ? '超过上限'
            : payload.reason === 'single-client' ? 'Steam 通道拒绝了这个本机客户端'
              : payload.reason === 'bad-token' || payload.reason === 'token' ? '口令不匹配'
                : payload.reason === 'handshake-timeout' ? '握手超时'
                  : payload.reason === 'accept-failed' ? '本地接受 Steam 连接失败'
                    : payload.reason}）`, 'warn');
        break;
      case 'idle-timeout':
        this.log(`${tag} 连接空闲超时，已断开：${payload.peer || ''}`, 'warn');
        break;
      case 'error':
        this.lastError = payload.error?.friendly || payload.error?.message || '未知错误';
        this.log(`${tag} 转发错误（${payload.stage}）：${this.lastError}`, 'error');
        if (payload.stage === 'listen') this._setState(STATES.ERROR);
        break;
      case 'stopped':
        this.log(`${tag} 通道已停止，端口已释放`);
        break;
      default:
        break;
    }
  }

  async checkPort({ port, host = '0.0.0.0', protocol = 'TCP' } = {}) {
    const p = intInRange(port, 1, 65535, '端口');
    const h = cleanString(host, '监听地址', 255);
    const proto = String(protocol).toUpperCase() === 'UDP' ? 'UDP' : 'TCP';
    const ownChannel = this.state === STATES.RUNNING
      ? this.channels.find((channel) => channel.rule.protocol === proto && channel.listen.port === p
        && (channel.listen.host === h || channel.listen.host === '0.0.0.0'))
      : null;
    if (ownChannel) {
      return { free: false, code: 'EALREADY', port: p, host: h, protocol: proto, inUseBySession: true, friendly: `${proto} 端口 ${p} 正被当前会话使用` };
    }

    const result = proto === 'UDP' ? await checkUdpPortFree(p, h) : await checkTcpPortFree(p, h);
    let free = result.free;
    let code = result.code;

    // Windows 允许 0.0.0.0 与 127.0.0.1 同时绑定同一 TCP 端口，所以“绑定成功”不等于“没人监听”。
    if (free && proto === 'TCP') {
      const probeHost = h === '0.0.0.0' ? '127.0.0.1' : (h === '::' ? '::1' : h);
      if (await probe(probeHost, p, 400)) { free = false; code = 'EALREADY'; }
    }

    return {
      free,
      code,
      port: p,
      host: h,
      protocol: proto,
      inUseBySession: false,
      friendly: free
        ? `${proto} 端口 ${p} 空闲，可以使用`
        : code === 'EALREADY'
          ? `${proto} 端口 ${p} 已经被监听：可能是上次没有正常退出的会话，或其它程序正在使用。`
          : describeError({ code, message: code }, { port: p, host: h }),
    };
  }

  async start(input = {}) {
    if (this.state === STATES.STARTING || this.state === STATES.RUNNING) {
      fail('EALREADYRUNNING', '已经有一个会话在运行中，请先停止当前会话');
    }
    if (this.state === STATES.STOPPING) {
      fail('ESTOPPING', '会话正在停止，请稍后再试');
    }
    const role = input.role;
    if (role !== 'host' && role !== 'joiner') fail('EINVALIDROLE', '角色必须是 host（房主）或 joiner（加入者）');

    this._pending = this._start(input, role);
    try {
      return await this._pending;
    } finally {
      this._pending = null;
    }
  }

  async _start(input, role) {
    this.lastError = null;
    this.warnings = [];
    this._setState(STATES.STARTING);
    this.log(role === 'host' ? '正在以房主模式启动桥接…' : '正在以加入者模式启动桥接…');

    try {
      if (input.adapter === 'steam') await this._startSteam(input, role);
      else if (input.adapter === 'none') await this._startGuidanceOnly(input, role);
      else if (role === 'host') await this._startHost(input);
      else await this._startJoiner(input);
    } catch (err) {
      this.lastError = err.friendly || err.message || '启动失败';
      this.log(`启动失败：${this.lastError}`, 'error');
      await this._teardownChannels();
      this.role = null;
      this.channels = [];
      this.relay = null;
      this._setState(STATES.ERROR);
      throw err;
    }
    return this.getSnapshot();
  }

  _channelOptions(input, role) {
    return {
      bindHost: cleanString(input.bindHost || (role === 'host' ? '0.0.0.0' : '127.0.0.1'), '监听地址', 255),
      authToken: input.authToken === undefined
        ? (role === 'host' ? newToken() : '')
        : String(input.authToken).trim(),
      maxConnections: intInRange(input.maxConnections ?? 16, 1, 64, '最大连接数'),
      // 真实可调的超时（0 = 不启用空闲超时）；透传给 tcp/udp 中继
      idleTimeoutMs: intInRange(input.idleTimeoutMs ?? 0, 0, 3600000, '空闲超时(ms)'),
      connectTimeoutMs: intInRange(input.connectTimeoutMs ?? 8000, 500, 60000, '连接超时(ms)'),
    };
  }

  /**
   * 采样真实计数的历史序列（供界面画速率曲线）。
   * 数据只来自中继的真实累计计数，按调用时刻取差分得到 B/s；不做任何平滑或伪造。
   * 最多保留 60 个点，只在会话运行期间累积。
   */
  _sampleMetrics(totals) {
    const now = Date.now();
    const last = this.samples.length ? this.samples[this.samples.length - 1] : null;
    if (last && now - last.t < 200) {
      return { rateToPeer: last.up, rateFromPeer: last.down, samples: this.samples.slice(-60) };
    }
    let up = 0;
    let down = 0;
    if (last) {
      const seconds = Math.max(0.05, (now - last.t) / 1000);
      up = Math.max(0, Math.round(((totals.bytesToPeer - last.totalUp) || 0) / seconds));
      down = Math.max(0, Math.round(((totals.bytesFromPeer - last.totalDown) || 0) / seconds));
    }
    this.samples.push({ t: now, up, down, conns: totals.connections || 0, totalUp: totals.bytesToPeer || 0, totalDown: totals.bytesFromPeer || 0 });
    if (this.samples.length > 60) this.samples.splice(0, this.samples.length - 60);
    return { rateToPeer: up, rateFromPeer: down, samples: this.samples.slice(-60) };
  }

  async _preflight(rules, role, bindHost) {
    for (const rule of rules) {
      // 抢端口拦截（房主）：本机服务端口 == 对好友开放的端口时，房主会在本机监听这个端口，
      // 而本机服务（例如游戏自带的 3000）也在用同一个端口 -> 必然 EADDRINUSE。
      // 直接自动避让到下一个空闲端口，并明确告知：本机服务端口不变，变的只是"对好友开放"的那个。
      if (role === 'host' && Number(rule.remotePort) === Number(rule.localPort)) {
        const original = Number(rule.localPort);
        let next = original + 1;
        let picked = 0;
        while (next <= 65535) {
          const probeFree = await this.checkPort({ port: next, host: bindHost, protocol: rule.protocol });
          if (probeFree.free) { picked = next; break; }
          next += 1;
        }
        if (!picked) fail('EADDRINUSE', `${rule.protocol} 端口 ${original} 既是本机服务端口又要对好友开放，且找不到可用替代端口，请手动改「对好友开放的端口」`);
        rule.remotePort = picked;
        this.warnings.push(
          `${rule.protocol} 端口 ${original} 同时是本机服务端口和对外开放端口：房主会在本机监听它，必然和你本机的服务（例如游戏）抢占同一个端口。` +
          `已自动把「对好友开放」的端口改为 ${picked}；你本机的服务端口仍然是 ${original}，邀请码里带的也是 ${picked}。`
        );
      }
      const listenPort = role === 'host' ? rule.remotePort : rule.localPort;
      const result = await this.checkPort({ port: listenPort, host: bindHost, protocol: rule.protocol });
      if (!result.free) {
        const base = `${rule.protocol} 端口 ${listenPort} 无法使用：${result.friendly}`;
        const owner = String(result.owner || result.friendly || '');
        const isGameLike = /node\.exe|stronghold|卫戍/i.test(owner);
        const hint = role === 'joiner'
          ? (isGameLike
              // 好友本机跑了游戏服务：这是联机失败的经典原因，必须说清而不是让他换端口了事
              ? '。看起来你本机也在运行游戏服务：玩联机时**不需要**在好友这边启动游戏 —— 关掉本机的游戏窗口，然后直接用浏览器打开隧道地址（界面会给出 http://127.0.0.1:<入口端口>），游戏会从房主那边送过来。'
              : '。入口端口可以换一个（例如 8080）：它只是你本机的入口，只要浏览器打开**同一个**端口即可。')
          : '。请把「对好友开放的端口」换成别的（例如 ' + (listenPort + 1) + '）。';
        fail(result.code || 'EADDRINUSE', withPortOwner(base + hint, listenPort));
      }
    }
  }

  async _openChannels(input, role, rules, bindHost, authToken, maxConnections, timeouts = {}) {
    const targetHost = role === 'host' ? cleanString(input.targetHost || '127.0.0.1', '本地服务地址', 255) : null;
    const remoteHost = role === 'host' ? null : cleanString(input.remoteHost, '房主地址', 255);
    if (role === 'joiner' && remoteHost === '0.0.0.0') fail('EINVALIDHOST', '房主地址不能是 0.0.0.0，请填写房主的局域网 IP 或邀请码');

    await this._preflight(rules, role, bindHost);

    // 启动前提示（只告警，不阻断）
    for (const rule of rules) {
      if (role === 'host') {
        const reachable = rule.protocol === 'TCP' ? await probe(targetHost, rule.localPort) : await probeUdpPort(targetHost, rule.localPort);
        if (!reachable) {
          this.warnings.push(`${rule.protocol} 目标端口 ${targetHost}:${rule.localPort} 上暂时没有检测到服务；如果服务还没启动，可以稍后再启动。`);
        }
      } else if (rule.protocol === 'TCP' && !(await probe(remoteHost, rule.remotePort))) {
        this.warnings.push(`暂时连不上房主 ${remoteHost}:${rule.remotePort}（TCP）：可能是房主还没开始会话、地址填错，或被防火墙拦截。桥接仍会启动。`);
      }
    }
    if (role === 'host' && bindHost === '0.0.0.0' && localIPv4() === '127.0.0.1') {
      this.warnings.push('没有检测到局域网 IPv4 地址，加入者可能无法通过局域网连接。');
    }
    if (role === 'host' && !authToken) this.warnings.push('本次会话未设置口令：链路上是明文，同一网络内知道端口的人都可以连上。');
    if (role === 'host' && authToken && authToken.length < 8) {
      this.warnings.push('会话口令短于 8 个字符：口令是唯一的信任来源，建议点「随机生成」换一个更长的口令。');
    }
    this.security = securityProfile(Boolean(authToken));

    const channels = [];
    try {
      for (const rule of rules) {
        const listenPort = role === 'host' ? rule.remotePort : rule.localPort;
        const peerPort = role === 'host' ? rule.localPort : rule.remotePort;
        const peerHost = role === 'host' ? targetHost : remoteHost;
        // 先建通道占位，再创建中继，这样事件回调能带上通道上下文（日志里显示协议与端口）。
        const channel = { rule, listen: { host: bindHost, port: listenPort }, peer: { host: peerHost, port: peerPort }, provider: null };

        // 统一走 Provider：session 不再关心底层是 TCP/UDP/Steam 内核
        const relayOptions = role === 'host'
          ? (rule.protocol === 'UDP'
            ? { bindHost, relayPort: listenPort, targetHost, targetPort: rule.localPort, authToken, maxClients: maxConnections, idleTimeoutMs: timeouts.idleTimeoutMs }
            : { bindHost, relayPort: listenPort, targetHost, targetPort: rule.localPort, authToken, maxConnections, idleTimeoutMs: timeouts.idleTimeoutMs, connectTimeoutMs: timeouts.connectTimeoutMs })
          : (rule.protocol === 'UDP'
            ? { bindHost, localPort: listenPort, host: remoteHost, relayPort: rule.remotePort, authToken, maxClients: maxConnections, idleTimeoutMs: timeouts.idleTimeoutMs }
            : { bindHost, localPort: listenPort, host: remoteHost, relayPort: rule.remotePort, authToken, maxConnections, idleTimeoutMs: timeouts.idleTimeoutMs, connectTimeoutMs: timeouts.connectTimeoutMs });
        channel.provider = createLocalRelayProvider({ role, protocol: rule.protocol, options: relayOptions });
        channel.provider.onEvent((ev) => this._handleRelayEvent(ev.type, ev.payload || ev, channel));

        channels.push(channel);
        this.channels = channels; // 让 _teardownChannels 能回收已建立的通道
        await channel.provider.start({});
        await this._awaitReady(channel.provider, { host: bindHost, port: listenPort, protocol: rule.protocol });
        this.log(`${this._label(channel)} 通道就绪`, 'ok');
      }
    } catch (err) {
      await this._teardownChannels();
      throw err;
    }
    return channels;
  }

  /**
   * Steam P2P 会话（阶段 4）：没有本地监听端口规则，靠 Steam Networking Sockets 直连。
   * 房主只需要「本地服务端口」，加入者只需要「本机入口端口 + 房主 SteamID」。
   */
  async _startSteam(input, role) {
    const base = this._channelOptions(input, role);
    const appId = input.appId == null || input.appId === '' ? null : intInRange(input.appId, 1, 2 ** 31 - 1, 'Steam AppID');
    const diagnosis = diagnoseSteam({ appDir: this.appDir, appId });
    for (const blocker of diagnosis.blockers) this.log(`Steam 环境提示：${blocker}`, 'warn');

    if (role === 'host') {
      const gameHost = cleanString(input.targetHost || '127.0.0.1', '本地服务地址', 255);
      const gamePort = intInRange(input.gamePort, 1, 65535, '本地服务端口');
      if (!(await probe(gameHost, gamePort))) {
        this.warnings.push(`本地服务端口 ${gameHost}:${gamePort} 上暂时没有检测到服务；如果服务还没启动，可以稍后再启动。`);
      }
      const channel = {
        rule: { protocol: 'STEAM', localPort: gamePort, remotePort: 0 },
        listen: { host: 'steam', port: 0 },
        peer: { host: gameHost, port: gamePort },
        provider: null,
        steamId: null,
      };
      this.channels = [channel];
      channel.provider = createSteamP2PProvider({
        role: 'host',
        options: {
          appDir: this.appDir,
          appId,
          sdk: this.steamSdk,
          steamModule: this.steamModule,
          gameHost,
          gamePort,
          maxPeers: base.maxConnections,
        },
      });
      channel.provider.onEvent((ev) => this._handleRelayEvent(ev.type, ev.payload || ev, channel));
      await channel.provider.start({});
      const info = await this._awaitReady(channel.provider, { host: 'steam', port: 0, protocol: 'STEAM' });
      channel.steamId = info.steamId || null;

      this.role = 'host';
      this.startedAt = Date.now();
      this.security = steamSecurityProfile();
      this.config = {
        role: 'host', adapter: 'steam', bindHost: base.bindHost, rules: [{ protocol: 'STEAM', localPort: gamePort, remotePort: 0 }],
        maxConnections: base.maxConnections, hasToken: false, targetHost: gameHost, targetPort: gamePort, appId: appId || diagnosis.appId || 480,
      };
      this.invite = {
        code: null, host: channel.steamId || '(启动后显示)', port: 0, token: '', game: String(input.game || ''),
        rules: [], steamId: channel.steamId, adapter: 'steam',
        hints: describeHints('steam-tunnel', { gamePort, targetHost: gameHost, game: String(input.game || '') }).clientHint,
      };
      for (const warning of this.warnings) this.log(warning, 'warn');
      this._setState(STATES.RUNNING);
      this.log(`Steam 房主会话已就绪：把 SteamID ${channel.steamId || '(未知)'} 发给好友`, 'ok');
      return;
    }

    const autoPort = input.localPort == null || input.localPort === '' || Number(input.localPort) === 0;
    const localPort = autoPort ? await allocateFreePort(base.bindHost) : intInRange(input.localPort, 1, 65535, '本地入口端口');
    if (autoPort) this.log(`本机入口端口未指定，已自动选择空闲端口 ${localPort}（客户端请连 ${base.bindHost}:${localPort}）`, 'info');
    const hostSteamId = cleanString(input.hostSteamId, '房主 SteamID', 64);
    if (!STEAM_ID_PATTERN.test(hostSteamId)) fail('EINVALIDSTEAMID', '房主 SteamID 格式不正确（应以 7656119 开头的 17 位数字）');
    const portCheck = await this.checkPort({ port: localPort, host: base.bindHost, protocol: 'TCP' });
    if (!portCheck.free) fail(portCheck.code || 'EADDRINUSE', withPortOwner(`TCP 端口 ${localPort} 无法使用：${portCheck.friendly}`, localPort));

    const channel = {
      rule: { protocol: 'STEAM', localPort, remotePort: 0 },
      listen: { host: base.bindHost, port: localPort },
      peer: { host: hostSteamId, port: 0 },
      provider: null,
      steamId: hostSteamId,
    };
    this.channels = [channel];
    channel.provider = createSteamP2PProvider({
      role: 'joiner',
      options: {
        appDir: this.appDir,
        appId,
        sdk: this.steamSdk,
        steamModule: this.steamModule,
        bindHost: base.bindHost,
        localPort,
        hostSteamId,
      },
    });
    channel.provider.onEvent((ev) => this._handleRelayEvent(ev.type, ev.payload || ev, channel));
    await channel.provider.start({});
    await this._awaitReady(channel.provider, { host: base.bindHost, port: localPort, protocol: 'STEAM' });

    this.role = 'joiner';
    this.startedAt = Date.now();
    this.security = steamSecurityProfile();
    this.config = {
      role: 'joiner', adapter: 'steam', bindHost: base.bindHost, rules: [{ protocol: 'STEAM', localPort, remotePort: 0 }],
      maxConnections: base.maxConnections, hasToken: false, localPort, remoteHost: hostSteamId, remotePort: 0,
      appId: appId || diagnosis.appId || 480,
    };
    this.invite = null;
    for (const warning of this.warnings) this.log(warning, 'warn');
    this._setState(STATES.RUNNING);
    this.log(`Steam 加入者会话已就绪：客户端连 ${base.bindHost}:${localPort} -> 房主 ${hostSteamId}`, 'ok');
  }

  /**
   * 「不做转发」：局域网直连时只整理连接说明（0 条通道）。
   * 刻意保留为独立流程，并让状态里明确显示「未转发任何流量」——不能让人以为已经有隧道。
   */
  async _startGuidanceOnly(input, role) {
    const gamePort = intInRange(input.gamePort, 1, 65535, '服务端口');
    const recipe = input.recipe || 'lan-direct';
    const address = localIPv4();
    const hints = describeHints(recipe, { gamePort, lanAddress: address, game: String(input.game || '') });

    this.channels = [];
    this.role = role;
    this.startedAt = Date.now();
    this.security = guidanceSecurityProfile();
    this.config = {
      role, adapter: 'none', recipe, gamePort, rules: [], maxConnections: 0, hasToken: false,
      bindHost: null, targetHost: null, targetPort: gamePort,
    };
    this.invite = role === 'host'
      ? {
        code: null, host: address, port: gamePort, token: '', game: String(input.game || ''),
        rules: [], adapter: 'none', recipe, hints: hints.clientHint, hostHints: hints.hostHint,
      }
      : null;
    for (const line of hints.hostHint) this.log(line);
    this._setState(STATES.RUNNING);
    this.log('已就绪，但本次会话不做任何转发（仅连接说明）。', 'warn');
  }

  async _startHost(input) {
    const base = this._channelOptions(input, 'host');
    const rules = normalizeRules(input, 'host');
    const channels = await this._openChannels(input, 'host', rules, base.bindHost, base.authToken, base.maxConnections, base);

    this.role = 'host';
    this.startedAt = Date.now();
    this.config = {
      role: 'host',
      adapter: 'local',
      recipe: input.recipe || 'local-ports',
      bindHost: base.bindHost,
      rules: rules.map((rule) => ({ ...rule })),
      maxConnections: base.maxConnections,
      idleTimeoutMs: base.idleTimeoutMs,
      connectTimeoutMs: base.connectTimeoutMs,
      hasToken: Boolean(base.authToken),
      // 单通道时保留旧的扁平字段，兼容既有界面与调用
      relayPort: rules[0].remotePort,
      targetHost: cleanString(input.targetHost || '127.0.0.1', '本地服务地址', 255),
      targetPort: rules[0].localPort,
    };

    const address = localIPv4();
    const code = encodeInvite({
      v: INVITE_VERSION,
      game: String(input.game || '').slice(0, 80),
      host: address,
      port: rules[0].remotePort,
      token: base.authToken,
      rules: rules.map((rule) => ({ ...rule })),
    });
    const recipe = input.recipe || 'local-ports';
    const hints = describeHints(recipe, { rules, lanAddress: address, targetHost: this.config.targetHost, game: String(input.game || '') });
    for (const line of hints.hostHint) this.log(line);
    this.invite = {
      code, host: address, port: rules[0].remotePort, token: base.authToken, game: String(input.game || ''),
      rules: rules.map((rule) => ({ ...rule })), adapter: 'local', recipe, hints: hints.clientHint, hostHints: hints.hostHint,
    };

    for (const warning of this.warnings) this.log(warning, 'warn');
    this._setState(STATES.RUNNING);
    this.log(`房主会话已就绪：${channels.length} 条通道，对外地址 ${address}`, 'ok');
  }

  async _startJoiner(input) {
    const base = this._channelOptions(input, 'joiner');
    const rules = normalizeRules(input, 'joiner');
    const remoteHost = cleanString(input.remoteHost, '房主地址', 255);
    const channels = await this._openChannels(input, 'joiner', rules, base.bindHost, base.authToken, base.maxConnections, base);

    this.role = 'joiner';
    this.startedAt = Date.now();
    this.config = {
      role: 'joiner',
      bindHost: base.bindHost,
      rules: rules.map((rule) => ({ ...rule })),
      maxConnections: base.maxConnections,
      idleTimeoutMs: base.idleTimeoutMs,
      connectTimeoutMs: base.connectTimeoutMs,
      hasToken: Boolean(base.authToken),
      localPort: rules[0].localPort,
      remoteHost,
      remotePort: rules[0].remotePort,
    };
    this.invite = null;

    for (const warning of this.warnings) this.log(warning, 'warn');
    this._setState(STATES.RUNNING);
    this.log(`加入者会话已就绪：${channels.length} 条通道 -> 房主 ${remoteHost}`, 'ok');
  }

  /**
   * 把外部事件写进会话日志流（供路由监看等外部模块使用）。
   * 只走既有的 log 通道，不改变会话状态或通道行为。
   */
  /** 多通道策略：只读，供界面展示；开关关闭时行为与从前一致。 */
  getRoutePolicy() {
    return { ...this.routePolicy, description: describeRoutePolicy(this.routePolicy) };
  }

  /** 通道描述符：供备用决策与迁移计划使用（只读快照，不改通道）。 */
  _channelDescriptors() {
    return (this.channels || []).map((c) => ({
      id: (c.provider && c.provider.id) || 'channel',
      provider: (c.provider && c.provider.id) || null,
      port: (c.listen && c.listen.port) || null,
      ready: Boolean(c.provider && typeof c.provider.getState === 'function' && c.provider.getState() === 'ready'),
      standby: c.standby === true,
      ref: c,
    }));
  }

  /** 备用通道决策（不建通道，只回答该不该建；策略关闭时永远返回不建）。 */
  planStandbyChannel(candidates = []) {
    return planStandby({
      policy: this.routePolicy,
      channels: this._channelDescriptors(),
      candidates,
      sessionRunning: this.state === STATES.RUNNING,
    });
  }

  /**
   * 切到备用通道：按 route/migrate.cjs 的清单执行（先停主 → 备绑同端口 → 验证 → 提升）。
   * 只在显式调用时动作；任何拒绝条件都会如实返回原因、不做任何改动。
   * 注意：切换会中断连接，客户端需要重连（不承诺无缝迁移）。
   */
  async migrateToStandby() {
    const all = this.channels || [];
    const currentRef = all.find((c) => c.standby !== true);
    const standbyRef = all.find((c) => c.standby === true);
    const describeRef = (c) => (c ? {
      id: (c.provider && c.provider.id) || 'channel',
      provider: (c.provider && c.provider.id) || null,
      port: (c.listen && c.listen.port) || null,
      ready: Boolean(c.provider && typeof c.provider.getState === 'function' && c.provider.getState() === 'ready'),
    } : null);

    const plan = planMigration({
      current: describeRef(currentRef),
      standby: describeRef(standbyRef),
      samePort: true,
      allowInterrupt: this.routePolicy.enabled,
    });
    if (!plan.ok) {
      this.note('拒绝切换：' + plan.reason, 'warn');
      return { ok: false, reason: plan.reason, steps: [] };
    }

    this.note(describeMigration(plan), 'warn');
    const done = [];
    try {
      // 1) 先停主通道（释放入口端口）
      await currentRef.provider.stop();
      done.push('stop-channel');
      // 2) 让备用接管同一入口端口
      await standbyRef.provider.start({ port: plan.targetPort });
      done.push('bind-channel');
      // 3) 验证备用确实就绪
      const state = typeof standbyRef.provider.getState === 'function' ? standbyRef.provider.getState() : null;
      if (state !== 'ready') throw new Error('备用通道未进入 ready（当前 ' + state + '）');
      done.push('verify-channel');
      // 4) 提升为当前通道
      standbyRef.standby = false;
      currentRef.standby = true;
      this.relay = standbyRef.provider;
      done.push('promote-channel');
      this._emit({ type: 'log', entry: { level: 'ok', message: '已切换到备用通道（连接会中断，客户端需重连）', at: Date.now() } });
      return { ok: true, steps: done, plan };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      this.note('切换失败：' + message + '，开始回滚', 'error');
      try {
        await standbyRef.provider.stop();
        await currentRef.provider.start({ port: plan.rollback[0].port });
        this.note('已回滚到原通道（端口 ' + plan.rollback[0].port + '）', 'warn');
        return { ok: false, reason: message, steps: done, rolledBack: true };
      } catch (rollbackErr) {
        const rm = rollbackErr && rollbackErr.message ? rollbackErr.message : String(rollbackErr);
        this.note('回滚也失败：' + rm + '（两条通道可能都不可用）', 'error');
        return { ok: false, reason: message, steps: done, rolledBack: false, rollbackError: rm };
      }
    }
  }

  note(text, level = 'info') {
    const message = String(text === undefined || text === null ? '' : text);
    if (!message) return false;
    this.log(message, level);
    return true;
  }

  async _awaitReady(relay, where) {
    let timer;
    try {
      // 返回中继 ready 的结果：Steam 通道需要里面的 steamId，TCP/UDP 通道是 {host, port}
      return await Promise.race([
        relay.ready,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error(`启动超时：${where.protocol || ''} ${where.host}:${where.port} 在 ${READY_TIMEOUT_MS / 1000} 秒内没有进入监听状态`);
            err.code = 'ETIMEDOUT';
            err.friendly = err.message;
            reject(err);
          }, READY_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      if (!err.friendly) err.friendly = describeError(err, where);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async _teardownChannels() {
    const channels = this.channels;
    this.channels = [];
    this.relay = null;
    for (const channel of channels) {
      if (!channel.provider) continue;
      try { await channel.provider.stop(); } catch { /* 停止失败不阻断状态复位 */ }
    }
  }

  async stop() {
    if (this.state === STATES.IDLE) return this.getSnapshot();
    if (this._pending) { try { await this._pending; } catch { /* 启动失败由 start() 抛出 */ } }
    if (!this.channels.length) {
      this.role = null; this.config = null; this.invite = null;
      this._setState(STATES.IDLE);
      return this.getSnapshot();
    }

    this._setState(STATES.STOPPING);
    this.log('正在停止桥接…');
    await this._teardownChannels();
    this.role = null;
    this.config = null;
    this.invite = null;
    this.startedAt = null;
    this.warnings = [];
    this._setState(STATES.IDLE);
    return this.getSnapshot();
  }

  /** 应用退出时调用：尽最大努力同步释放端口，不等待回调。 */
  shutdown() {
    const channels = this.channels;
    this.channels = [];
    this.relay = null;
    this.state = STATES.IDLE;
    this.role = null;
    this.config = null;
    this.invite = null;
    for (const channel of channels) {
      try { if (channel.provider) channel.provider.stop(); } catch { /* 退出路径，忽略 */ }
    }
  }
}

module.exports = {
  SessionManager,
  securityProfile,
  steamSecurityProfile,
  STATES,
  encodeInvite,
  parseInvite,
  inviteText,
  localIPv4,
  checkPortFree,
  checkTcpPortFree,
  checkUdpPortFree,
  probeUdpPort,
  normalizeRule,
  normalizeRules,
  newToken,
  MAX_RULES,
};
