'use strict';
// 渲染进程 UI 逻辑测试：把 src/ui/index.html 里的真实内联脚本放进 DOM 桩里执行，
// 验证 端口数据模型 / 角色切换 / 启动停止接线 / 邀请码解析 / 状态与日志渲染。
// （本环境无法启动 Chromium，所以用 DOM 桩驱动同一份真实脚本，而不是重写一份逻辑。）
// 运行：node --test --test-isolation=none test/ui-logic.test.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8');
const inline = html.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(inline, 'index.html 里应存在内联脚本');
const uiCode = inline[1];

const SETTLED_PROFILE = {
  id: 'saved-1', name: 'Stronghold Link', transport: 'TCP', host: '127.0.0.1',
  ports: [{ protocol: 'TCP', localPort: 2300, remotePort: 2301 }],
  path: '', args: '', favorite: true, description: '已保存的配置（只有 ports[]，没有旧字段）',
};

function createElement(id) {
  const listeners = {};
  return {
    id, value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, checked: false,
    className: '', style: {}, dataset: {}, files: [], scrollTop: 0, scrollHeight: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    dispatch(type, event) { (listeners[type] || []).forEach((fn) => fn(event || {})); },
    appendChild(child) { this.innerHTML += (child && child.innerHTML) || ''; },
    select() {}, focus() {}, click() {}, closest() { return null; }, querySelectorAll() { return []; },
  };
}

function setup({ profiles = [], info = {}, steamReport = null, onSteamDiagnose = null, recipesList = null } = {}) {
  const hintInputs = [];
  const defaultRecipes = recipesList || [
    { id: 'local-ports', name: '本地中继（TCP / UDP 端口规则）', adapter: 'local', fields: ['rules'], available: true, summary: '通用端口转发' },
    { id: 'local-web', name: '本地中继 + 浏览器应用（页面与 WebSocket 同端口）', adapter: 'local', fields: ['rules'], available: true, summary: '浏览器应用：加入者打开本机入口即可' },
    { id: 'steam-tunnel', name: 'Steam P2P 隧道（需要 Steamworks SDK）', adapter: 'steam', fields: ['gamePort'], available: false, unavailableReason: '缺少 Steamworks SDK', summary: '跨网络不需要端口转发' },
    { id: 'lan-direct', name: '不做中继（局域网直连，仅生成连接说明）', adapter: 'none', fields: ['gamePort'], available: true, summary: '不做转发' },
  ];
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, createElement(id));
    return elements.get(id);
  };
  const timers = [];
  const calls = [];
  const eventHandlers = [];
  const appInfo = {
    name: 'Stronghold Link', version: '0.13.3', configPath: 'C:\\Users\\test\\AppData\\Roaming\\stronghold-link\\game-profiles.json',
    platform: 'win32', arch: 'x64', electron: '39.8.10', chrome: '142.0.0.0', node: '22.22.1', smoke: false, ...info,
  };
  let snapshot = {
    state: 'idle', role: null, config: null, invite: null, inviteText: '', warnings: [], logs: [],
    connections: 0, totalConnections: 0, rejected: 0, failed: 0, bytesToPeer: 0, bytesFromPeer: 0, startedAt: null, lastError: null,
  };
  const bridge = {
    version: '0.13.3',
    app: { info: async () => appInfo, revealConfig: async () => true },
    adapters: {
      recipes: async () => (defaultRecipes),
      recipeHints: async (input) => { hintInputs.push(input); return { hostHint: ['房主提示：本地游戏保持运行'], clientHint: ['加入者提示：浏览器打开 http://127.0.0.1:3000'] }; },
      list: async () => ([
        { id: 'tcp-relay', name: '本地 TCP 中继', status: 'ready', description: '已接入：可选择房主或加入者模式。' },
        { id: 'udp-relay', name: '本地 UDP 转发', status: 'ready', description: '已接入。' },
        { id: 'steam-p2p', name: 'Steam Networking', status: 'not-configured', description: '阶段 4。' },
      ]),
    },
    profiles: { load: async () => profiles, save: async (list) => list },
    steam: {
      diagnose: async () => {
        const report = steamReport || { available: true, blockers: [], steps: [], sdk: {} };
        if (typeof onSteamDiagnose === 'function') onSteamDiagnose(report);
        return report;
      },
    },
    session: {
      start: async (input) => {
        calls.push({ type: 'start', input });
        const host = input.role === 'host';
        snapshot = {
          ...snapshot, state: 'running', role: input.role, config: input,
          invite: host ? { code: 'SHL1-TESTCODE', host: '192.168.1.5', port: input.relayPort, token: input.authToken, game: input.game } : null,
          inviteText: host ? 'Stronghold Link 会话邀请\n房主地址：192.168.1.5\n中继端口：2301' : '',
        };
        return snapshot;
      },
      stop: async () => {
        calls.push({ type: 'stop' });
        snapshot = { ...snapshot, state: 'idle', role: null, config: null, invite: null, inviteText: '' };
        return snapshot;
      },
      status: async () => snapshot,
      checkPort: async (options) => {
        calls.push({ type: 'checkPort', options });
        return { free: true, port: options.relayPort, friendly: `端口 ${options.relayPort} 空闲，可以使用` };
      },
      parseInvite: async (code) => {
        calls.push({ type: 'parseInvite', code });
        return { v: 2, game: '测试游戏', host: '192.168.1.9', port: 2301, token: 'tok-9', rules: [{ protocol: 'TCP', localPort: 2300, remotePort: 2301 }, { protocol: 'UDP', localPort: 2300, remotePort: 2301 }] };
      },
      onEvent: (handler) => { eventHandlers.push(handler); return () => {}; },
    },
  };

  const document = {
    getElementById: get,
    querySelectorAll: () => [],
    createElement: (tag) => createElement(tag),
    addEventListener() {},
    title: 'Stronghold Link — Game Library',
  };
  // 真实浏览器里 window 有这些方法；桩里也要有，否则界面脚本初始化就会挂
  const windowListeners = [];
  const windowStub = {
    strongholdLink: bridge,
    __tt: null,
    devicePixelRatio: 1,
    addEventListener(type, fn) { windowListeners.push({ type, fn }); },
    removeEventListener() {},
    dispatch(type) { windowListeners.filter((l) => l.type === type).forEach((l) => l.fn({})); },
  };
  const sandbox = {
    document,
    window: windowStub,
    navigator: { clipboard: { writeText: async () => {} } },
    confirm: () => true,
    console,
    crypto: globalThis.crypto,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
    URL,
    Blob: class Blob { constructor() {} },
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t; },
    clearTimeout,
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); timers.push(t); return t; },
    clearInterval,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(uiCode, sandbox, { filename: 'index-inline.js' });

  return {
    get, calls, eventHandlers, hintInputs,
    setSnapshot: (next) => { snapshot = { ...snapshot, ...next }; },
    cleanup: () => { for (const t of timers) { clearInterval(t); clearTimeout(t); } },
  };
}

async function settle(ms = 80) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test('界面自检：脚本引用的每个元素 id 都真实存在于 HTML 中', () => {
  const referenced = new Set();
  for (const match of uiCode.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)) referenced.add(match[1]);
  for (const match of uiCode.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) referenced.add(match[1]);
  assert.ok(referenced.size > 20, `应解析出足够多的 id，实际 ${referenced.size}`);

  const declared = new Set();
  for (const match of html.matchAll(/id="([A-Za-z0-9_-]+)"/g)) declared.add(match[1]);

  const missing = [...referenced].filter((id) => !declared.has(id));
  assert.deepEqual(missing, [], `脚本引用了 HTML 中不存在的 id：${missing.join(', ')}`);
});

test('游戏库用 ports[] 渲染端口，不再出现 undefined（修复旧数据模型缺陷）', async (t) => {
  const ui = setup({ profiles: [SETTLED_PROFILE] });
  t.after(ui.cleanup);
  await settle();

  const cardHtml = ui.get('gameList').innerHTML;
  assert.match(cardHtml, /LOCAL PORT 2300/);
  assert.match(cardHtml, /2300 → 2301/);
  assert.ok(!/undefined/.test(cardHtml), `卡片不应出现 undefined，实际：${cardHtml}`);
  assert.equal(ui.get('profileCount').textContent, '01 PROFILES');
  assert.equal(ui.get('detailName').textContent, 'Stronghold Link');
  assert.match(ui.get('detailEndpoint').textContent, /2300 → 2301/);
});

test('启动时从主进程读取版本、配置路径与适配器真实状态', async (t) => {
  const ui = setup();
  t.after(ui.cleanup);
  await settle();

  assert.equal(ui.get('appVersion').textContent, '0.13.3');
  assert.match(ui.get('setVersion').textContent, /0\.13\.3 \/ Electron 39\.8\.10/);
  assert.match(ui.get('setConfigPath').textContent, /game-profiles\.json$/);
  assert.match(ui.get('setRuntime').textContent, /Node 22\.22\.1/);
  assert.match(ui.get('setNetwork').textContent, /ready/);
  const adapters = ui.get('adapterList').innerHTML;
  assert.match(adapters, /Steam Networking/);
  assert.match(adapters, /not-configured/);
  assert.match(adapters, /本地 UDP 转发/);
});

test('房主模式：端口规则来自所选配置，角色切换会显示对应表单', async (t) => {
  const ui = setup({ profiles: [SETTLED_PROFILE] });
  t.after(ui.cleanup);
  await settle();

  ui.get('hostAction').onclick();
  assert.equal(ui.get('sessionRole').value, 'host');
  assert.equal(ui.get('hostFields').hidden, false);
  assert.equal(ui.get('joinFields').hidden, true);
  assert.equal(ui.get('hostRules').value, 'TCP,2300,2301', '端口规则应从配置的 ports[] 填入');
  assert.ok(ui.get('hostToken').value.length >= 8, '应自动生成会话口令');

  ui.get('sessionRole').value = 'joiner';
  ui.get('sessionRole').dispatch('change');
  assert.equal(ui.get('joinFields').hidden, false);
  assert.equal(ui.get('hostFields').hidden, true);
  assert.match(ui.get('sessionHint').textContent, /加入者/);
  assert.equal(ui.get('joinRules').value, 'TCP,2300,2301');
});

test('端口规则解析：多行 TCP/UDP 规则可用，格式错误有可读提示', async (t) => {
  const ui = setup({ profiles: [SETTLED_PROFILE] });
  t.after(ui.cleanup);
  await settle();
  ui.get('hostAction').onclick();

  ui.get('hostRules').value = 'TCP,2300,2301\nUDP,2300,2301';
  await ui.get('startSession').onclick();
  await settle();
  const start = ui.calls.find((c) => c.type === 'start');
  assert.deepEqual(JSON.parse(JSON.stringify(start.input.rules)), [
    { protocol: 'TCP', localPort: 2300, remotePort: 2301 },
    { protocol: 'UDP', localPort: 2300, remotePort: 2301 },
  ]);

  ui.calls.length = 0;
  ui.get('hostRules').value = 'TCP,2300';
  await ui.get('startSession').onclick();
  await settle();
  assert.equal(ui.calls.filter((c) => c.type === 'start').length, 0, '格式错误时不应启动会话');
  assert.match(ui.get('toast').textContent, /格式应为/);

  ui.calls.length = 0;
  ui.get('hostRules').value = 'SCTP,2300,2301';
  await ui.get('checkPort').onclick();
  await settle();
  assert.equal(ui.calls.filter((c) => c.type === 'checkPort').length, 0);
  assert.match(ui.get('toast').textContent, /只能是 TCP 或 UDP/);
});

test('启动/停止桥接：参数正确传给主进程，状态与按钮随之变化（不伪造连接成功）', async (t) => {
  const ui = setup({ profiles: [SETTLED_PROFILE] });
  t.after(ui.cleanup);
  await settle();

  ui.get('hostAction').onclick();
  ui.get('hostRules').value = 'TCP,2300,2301';
  const token = ui.get('hostToken').value;

  await ui.get('startSession').onclick();
  await settle();

  const start = ui.calls.find((c) => c.type === 'start');
  assert.ok(start, '应调用 session.start');
  assert.equal(start.input.role, 'host');
  assert.deepEqual(JSON.parse(JSON.stringify(start.input.rules)), [{ protocol: 'TCP', localPort: 2300, remotePort: 2301 }]);
  assert.equal(start.input.bindHost, '0.0.0.0');
  assert.equal(start.input.authToken, token);
  assert.equal(start.input.game, 'Stronghold Link');

  assert.equal(ui.get('sessionState').textContent, 'RUNNING');
  assert.match(ui.get('sessionState').className, /state-running/);
  assert.equal(ui.get('startSession').disabled, true, '运行中不允许重复启动');
  assert.equal(ui.get('stopSession').disabled, false);
  assert.equal(ui.get('inviteBox').hidden, false);
  assert.match(ui.get('inviteText').value, /Stronghold Link 会话邀请/);
  assert.match(ui.get('globalStatus').textContent, /HOST \/ LISTENING/);

  await ui.get('stopSession').onclick();
  await settle();
  assert.ok(ui.calls.some((c) => c.type === 'stop'));
  assert.equal(ui.get('sessionState').textContent, 'IDLE');
  assert.equal(ui.get('stopSession').disabled, true);
  assert.equal(ui.get('startSession').disabled, false);
});

test('加入者模式：粘贴邀请码后自动填好地址、口令与全部端口规则', async (t) => {
  const ui = setup({ profiles: [SETTLED_PROFILE] });
  t.after(ui.cleanup);
  await settle();

  ui.get('invitePaste').value = 'SHL1-FAKE';
  await ui.get('applyInvite').onclick();
  await settle();

  assert.equal(ui.get('sessionRole').value, 'joiner');
  assert.equal(ui.get('joinFields').hidden, false);
  assert.equal(ui.get('joinHost').value, '192.168.1.9');
  assert.equal(ui.get('joinToken').value, 'tok-9');
  assert.equal(ui.get('joinRules').value, 'TCP,2300,2301\nUDP,2300,2301', '邀请码里的多端口规则应一次填好');
  assert.equal(ui.get('sessionProfile').value, 'saved-1', '邀请码里的游戏名匹配不到时保持原选择');
});

test('状态事件推送：通道、连接数、流量、错误、警告、日志都如实渲染', async (t) => {
  const ui = setup({ profiles: [SETTLED_PROFILE] });
  t.after(ui.cleanup);
  await settle();
  assert.equal(ui.eventHandlers.length >= 1, true, '应订阅 session 事件');

  const runningSnapshot = {
    state: 'running', role: 'host',
    config: { role: 'host', bindHost: '0.0.0.0', rules: [{ protocol: 'TCP', localPort: 2300, remotePort: 2301 }] },
    invite: null, inviteText: '',
    channels: [
      { protocol: 'TCP', rule: { protocol: 'TCP', localPort: 2300, remotePort: 2301 }, listen: { host: '0.0.0.0', port: 2301 }, peer: { host: '127.0.0.1', port: 2300 }, stats: { connections: 2, totalConnections: 3, rejected: 0, failed: 0, bytesToPeer: 2048, bytesFromPeer: 1024, packetsToPeer: 0, packetsFromPeer: 0 } },
      { protocol: 'UDP', rule: { protocol: 'UDP', localPort: 2300, remotePort: 2301 }, listen: { host: '0.0.0.0', port: 2301 }, peer: { host: '127.0.0.1', port: 2300 }, stats: { connections: 1, totalConnections: 1, rejected: 0, failed: 0, bytesToPeer: 512, bytesFromPeer: 512, packetsToPeer: 7, packetsFromPeer: 9 } },
    ],
    connections: 3, totalConnections: 4, rejected: 1, failed: 0,
    bytesToPeer: 2048, bytesFromPeer: 1024, packetsToPeer: 7, packetsFromPeer: 9, startedAt: Date.now(),
    lastError: '目标 127.0.0.1:2300 拒绝连接：对方没有在监听这个端口。',
    warnings: ['本地游戏端口 127.0.0.1:2300 上暂时没有检测到服务；如果游戏还没启动，可以稍后再启动游戏。'],
    logs: [
      { ts: Date.now(), level: 'info', text: '房主会话已就绪' },
      { ts: Date.now(), level: 'warn', text: '警告日志' },
      { ts: Date.now(), level: 'error', text: '错误日志' },
    ],
  };
  ui.setSnapshot(runningSnapshot);
  ui.eventHandlers[0]({ type: 'state', snapshot: runningSnapshot });
  await settle();

  assert.equal(ui.get('sessionConnections').textContent, '3');
  assert.equal(ui.get('sessionTraffic').textContent, '2.0 KiB / 1.0 KiB');
  assert.equal(ui.get('sessionPackets').textContent, '7 / 9');
  assert.equal(ui.get('sessionRejected').textContent, '1 / 0');
  assert.equal(ui.get('sessionError').hidden, false);
  assert.match(ui.get('sessionError').textContent, /拒绝连接/);
  assert.equal(ui.get('sessionWarnings').hidden, false);
  assert.match(ui.get('sessionWarnings').innerHTML, /没有检测到服务/);
  assert.match(ui.get('sessionLogs').innerHTML, /警告日志/);
  assert.match(ui.get('sessionLogs').innerHTML, /logwarn/);
  assert.match(ui.get('sessionLogs').innerHTML, /logerror/);
  assert.equal(ui.get('logCount').textContent, '3 条');

  const channels = ui.get('channelList').innerHTML;
  assert.match(channels, /TCP/);
  assert.match(channels, /UDP/);
  assert.match(channels, /0\.0\.0\.0:2301/);
  assert.match(channels, /127\.0\.0\.1:2300/);
  assert.match(channels, /包 ↑7\/↓9/, 'UDP 通道应显示数据报统计');
  assert.equal(ui.get('channelCount').textContent, '2 条');
  assert.equal(ui.get('sessionState').textContent, 'RUNNING');
});

test('连接方式（阶段 5）：默认配置是通用服务示例，浏览器配方会给出加入者怎么连', async (t) => {
  const ui = setup(); // profiles.load 返回空 -> 使用内置默认配置
  t.after(ui.cleanup);
  await settle();

  const cardHtml = ui.get('gameList').innerHTML;
  assert.match(cardHtml, /本地 Web \/ HTTP 服务（示例）/, '默认配置应是通用服务示例');
  assert.match(cardHtml, /远程桌面 RDP（示例）/);
  assert.match(cardHtml, /8080 → 8081/, '应显示服务端口 8080 与中继端口 8081');
  assert.match(cardHtml, /3389 → 3390/, 'RDP 示例的中继端口应与本机 3389 错开');
  assert.equal(/经典城堡策略游戏/.test(cardHtml), false, '旧的城堡游戏占位说明应已移除');
  assert.equal(ui.get('profileCount').textContent, '04 PROFILES');

  // 选择第一条（本地 Web 服务）后，连接方式应自动切到浏览器配方
  ui.get('sessionProfile').dispatch('change');
  await settle();
  assert.equal(ui.get('sessionRecipe').value, 'local-web', '配置里的 recipe 应被应用');
  assert.match(ui.get('recipeSummary').textContent, /浏览器应用/);

  // 房主：本地字段可见，端口规则来自配置
  ui.get('sessionRole').value = 'host';
  ui.get('sessionRole').dispatch('change');
  assert.equal(ui.get('hostFields').hidden, false);
  assert.equal(ui.get('hostRules').value, 'TCP,8080,8081');

  // 连接说明（走主进程的 recipe-hints）
  await ui.get('refreshHints').onclick();
  await settle();
  assert.equal(ui.hintInputs.length >= 1, true, '应调用 adapters.recipeHints');
  assert.equal(ui.hintInputs[0].recipe, 'local-web');
  const hints = ui.get('hintBox').innerHTML;
  assert.match(hints, /房主提示/);
  assert.match(hints, /加入者提示/);
  assert.match(hints, /127\.0\.0\.1:3000/);

  // 「不做转发」配方：显示对应字段并明确不是隧道
  ui.get('sessionRecipe').value = 'lan-direct';
  ui.get('sessionRecipe').dispatch('change');
  assert.equal(ui.get('hostFields').hidden, true);
  assert.equal(ui.get('noneFields').hidden, false);
  assert.match(ui.get('sessionHint').textContent, /不做转发/);
  ui.get('noneGamePort').value = '3000';
  await ui.get('startSession').onclick();
  await settle();
  const start = ui.calls.find((c) => c.type === 'start');
  assert.equal(start.input.adapter, 'none');
  assert.equal(start.input.recipe, 'lan-direct');
  assert.equal(start.input.gamePort, 3000);
});

test('Steam 适配器界面：切换适配器会换成 Steam 字段，启动时传 Steam 参数，自检面板能渲染', async (t) => {
  const steamCalls = [];
  const ui = setup({
    profiles: [SETTLED_PROFILE],
    steamReport: {
      available: false,
      blockers: ['缺少 Steamworks SDK 的 redistributable 目录（steamworks_sdk/redistributable_bin）'],
      steps: [
        { ok: true, title: 'npm 依赖 steamworks-ffi-node', detail: 'C:\\app\\node_modules\\steamworks-ffi-node\\dist\\index.js' },
        { ok: false, title: 'Steamworks SDK redistributable', detail: '未找到；请把官方 SDK 的 redistributable_bin 放到 steamworks_sdk/ 下' },
        { ok: false, title: 'Steam 客户端', detail: '未在常见目录发现 Steam；请先安装并登录 Steam' },
      ],
      sdk: { library: 'win64/steam_api64.dll' },
    },
    onSteamDiagnose: (report) => steamCalls.push(report),
  });
  t.after(ui.cleanup);
  await settle();

  // 默认是本地中继：本地字段可见、Steam 字段隐藏
  ui.get('sessionRole').value = 'host';
  ui.get('sessionRole').dispatch('change');
  assert.equal(ui.get('hostFields').hidden, false);
  assert.equal(ui.get('steamHostFields').hidden, true);
  assert.equal(ui.get('steamDiagRow').hidden, true);

  ui.get('sessionRecipe').value = 'steam-tunnel';
  ui.get('sessionRecipe').dispatch('change');
  assert.equal(ui.get('hostFields').hidden, true, 'Steam 模式不应显示端口规则');
  assert.equal(ui.get('steamHostFields').hidden, false);
  assert.equal(ui.get('steamDiagRow').hidden, false);
  assert.match(ui.get('sessionHint').textContent, /Steam 房主/);

  // 环境自检按钮
  await ui.get('steamDiagnoseBtn').onclick();
  await settle();
  assert.equal(steamCalls.length, 1, '应调用 steam.diagnose');
  const reportHtml = ui.get('steamReport').innerHTML;
  assert.equal(ui.get('steamReport').hidden, false);
  assert.match(reportHtml, /还不能启动 Steam 会话/);
  assert.match(reportHtml, /Steamworks SDK redistributable/);
  assert.match(reportHtml, /PHASE4-STEAM/);

  // 房主启动：应传 adapter=steam 与 gamePort，而不是端口规则
  ui.get('steamGamePort').value = '2300';
  ui.get('steamAppIdHost').value = '480';
  await ui.get('startSession').onclick();
  await settle();
  const start = ui.calls.find((c) => c.type === 'start');
  assert.equal(start.input.adapter, 'steam');
  assert.equal(start.input.role, 'host');
  assert.equal(start.input.gamePort, 2300);
  assert.equal(start.input.appId, 480);
  assert.equal(start.input.rules, undefined, 'Steam 模式不应发送端口规则');

  // 加入者：应传 hostSteamId 与 localPort
  ui.calls.length = 0;
  await ui.get('stopSession').onclick();
  ui.get('sessionRole').value = 'joiner';
  ui.get('sessionRole').dispatch('change');
  assert.equal(ui.get('steamJoinFields').hidden, false);
  ui.get('steamHostId').value = '76561198000000001';
  ui.get('steamLocalPort').value = '2300';
  ui.get('steamAppIdJoin').value = '480';
  await ui.get('startSession').onclick();
  await settle();
  const joinStart = ui.calls.find((c) => c.type === 'start');
  assert.equal(joinStart.input.adapter, 'steam');
  assert.equal(joinStart.input.hostSteamId, '76561198000000001');
  assert.equal(joinStart.input.localPort, 2300);
});

test('安全状态展示：加密会话显示算法，明文会话明确标注未设置口令', async (t) => {
  const ui = setup({ profiles: [SETTLED_PROFILE] });
  t.after(ui.cleanup);
  await settle();

  const encrypted = {
    state: 'running', role: 'host', config: { role: 'host' }, invite: null, inviteText: '',
    security: { mode: 'psk-aead', cipher: 'AES-256-GCM', kex: 'X25519（每次会话临时密钥，前向保密）' },
    channels: [], warnings: [], logs: [], connections: 0, bytesToPeer: 0, bytesFromPeer: 0, packetsToPeer: 0, packetsFromPeer: 0, rejected: 0, failed: 0,
  };
  ui.eventHandlers[0]({ type: 'state', snapshot: encrypted });
  await settle();
  assert.match(ui.get('sessionSecurity').textContent, /已加密/);
  assert.match(ui.get('sessionSecurity').textContent, /AES-256-GCM/);
  assert.match(ui.get('sessionSecurity').textContent, /X25519/);

  ui.eventHandlers[0]({ type: 'state', snapshot: { ...encrypted, security: { mode: 'plain', cipher: '无' } } });
  await settle();
  assert.match(ui.get('sessionSecurity').textContent, /明文/);
  assert.match(ui.get('sessionSecurity').textContent, /未设置口令/);
});
