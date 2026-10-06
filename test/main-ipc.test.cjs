'use strict';
// 主进程 IPC 链路测试：用 electron 桩加载真实的 electron/main.cjs，
// 直接调用它注册的 IPC 处理器，验证 配置持久化 / 会话控制 / 错误文案 / 事件推送。
// 运行：node --test --test-isolation=none test/main-ipc.test.cjs

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');

const h = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// electron 桩
// ---------------------------------------------------------------------------
const OUT_ROOT = path.join(__dirname, '..', 'test-out', 'ipc-userdata');
fs.rmSync(OUT_ROOT, { recursive: true, force: true });
fs.mkdirSync(OUT_ROOT, { recursive: true });
after(() => {
  fs.rmSync(OUT_ROOT, { recursive: true, force: true });
  try { fs.rmdirSync(path.dirname(OUT_ROOT)); } catch { /* 目录里还有别的东西就保留 */ }
});

const handlers = new Map();
const pushed = [];
const appEvents = [];

const electronStub = {
  app: {
    getPath: (name) => (name === 'userData' ? OUT_ROOT : path.join(OUT_ROOT, name)),
    requestSingleInstanceLock: () => true,
    on: (name, fn) => appEvents.push({ name, fn }),
    whenReady: () => Promise.resolve(),
    exit: () => {},
    quit: () => {},
  },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  },
  BrowserWindow: class BrowserWindow {
    constructor() {
      this.webContents = {
        send: (channel, payload) => pushed.push({ channel, payload }),
        on: () => {},
        once: () => {},
        executeJavaScript: async () => ({}),
      };
    }
    loadFile() {}
    on() {}
    isDestroyed() { return false; }
    destroy() {}
    static getAllWindows() { return []; }
  },
  dialog: { showErrorBox: () => {}, showMessageBox: async () => ({}) },
  shell: { showItemInFolder: () => {} },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, ...rest);
};
require('../electron/main.cjs');
Module._load = originalLoad;

const invoke = (channel, payload) => {
  const handler = handlers.get(channel);
  assert.ok(handler, `IPC 频道 ${channel} 应已注册`);
  // Electron 会把处理器里的同步抛出转成渲染进程侧的 rejected promise，这里保持一致。
  return Promise.resolve().then(() => handler({}, payload));
};

test('main.cjs 注册了预期的 IPC 频道', () => {
  for (const channel of ['profiles:load', 'profiles:save', 'adapters:list', 'session:start', 'session:stop', 'session:status', 'session:route', 'session:check-port', 'session:parse-invite', 'app:info', 'app:reveal-config', 'window:minimize', 'window:toggle-maximize', 'window:toggle-fullscreen', 'window:close', 'window:state']) {
    assert.ok(handlers.has(channel), `缺少 IPC 频道 ${channel}`);
  }
});

test('session:route 在空闲时如实报 UNKNOWN，不冒充直连', async () => {
  const report = await invoke('session:route', {});
  assert.ok(report && typeof report === 'object');
  assert.equal(report.route, 'UNKNOWN');
  assert.equal(report.relayed, false);
  assert.equal(report.steamInBytesPerSec, null);
  assert.ok(Array.isArray(report.channels));
});

test('window:* 无边框窗口按钮：拿不到真实窗口时如实降级，不抛异常', async () => {
  const state = await invoke('window:state', {});
  assert.equal(typeof state.ok, 'boolean');
  assert.equal(state.maximized, false, '桩窗口没有 isMaximized，应落 false 而不是抛异常');
  assert.equal(state.fullscreen, false);
  // 桩对象上这四个方法都不存在，处理器必须捕获后返回 ok:false + 可读原因，
  // 绝不能让 rejected promise 冒到渲染进程。
  for (const channel of ['window:minimize', 'window:toggle-maximize', 'window:toggle-fullscreen', 'window:close']) {
    const result = await invoke(channel, {});
    assert.equal(result.ok, false, `${channel} 在桩窗口上应返回 ok:false`);
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0, `${channel} 应给出原因`);
  }
});

test('app:info 返回真实版本与配置路径（基于桩 userData）', async () => {
  const info = await invoke('app:info');
  assert.equal(info.version, '0.12.0');
  assert.equal(info.name, 'Stronghold Link');
  assert.equal(info.configPath, path.join(OUT_ROOT, 'game-profiles.json'));
  assert.equal(info.smoke, false);
});

test('配置持久化：写入后能读回，且补齐 ports/port/remotePort 字段', async () => {
  const saved = await invoke('profiles:save', [{
    id: 'p1', name: '测试游戏', transport: 'TCP', host: '127.0.0.1',
    ports: [{ protocol: 'TCP', localPort: 2300, remotePort: 2301 }],
  }]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].port, 2300, '应补出 port 兼容字段');
  assert.equal(saved[0].remotePort, 2301);
  assert.deepEqual(saved[0].ports, [{ protocol: 'TCP', localPort: 2300, remotePort: 2301 }]);

  const loaded = await invoke('profiles:load');
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].name, '测试游戏');
  assert.equal(loaded[0].ports[0].remotePort, 2301);

  await assert.rejects(invoke('profiles:save', [{ name: '', transport: 'TCP' }]), /配置名称无效/);
  await assert.rejects(invoke('profiles:save', [{ name: 'x', transport: 'TCP', ports: [{ protocol: 'TCP', localPort: 0, remotePort: 1 }] }]), /1–65535/);
});

test('适配器列表是动态状态：会话运行时会变成 running', async () => {
  const echo = await h.startEchoServer();
  const relayPort = await h.freePort();
  try {
    const before = await invoke('adapters:list');
    assert.equal(before.find((a) => a.id === 'tcp-relay').status, 'ready');
    assert.equal(before.find((a) => a.id === 'udp-relay').status, 'ready');
    // Steam 适配器的状态取决于本机是否放了 SDK（DLL 存在时是 ready，否则 not-configured）
    assert.ok(['ready', 'not-configured'].includes(before.find((a) => a.id === 'steam-p2p').status));

    await invoke('session:start', { role: 'host', relayPort, targetHost: '127.0.0.1', targetPort: echo.port, game: '测试游戏' });

    const after = await invoke('adapters:list');
    const tcp = after.find((a) => a.id === 'tcp-relay');
    assert.equal(tcp.status, 'running');
    assert.match(tcp.description, /房主/);
  } finally {
    await invoke('session:stop');
    await echo.close();
  }
});

test('会话 IPC：启动 -> 状态 -> 事件推送 -> 停止，端口真实释放', async () => {
  const echo = await h.startEchoServer();
  const relayPort = await h.freePort();
  pushed.length = 0;
  try {
    const snapshot = await invoke('session:start', { role: 'host', relayPort, targetHost: '127.0.0.1', targetPort: echo.port, game: '测试游戏' });
    assert.equal(snapshot.state, 'running');
    assert.ok(snapshot.invite && snapshot.invite.code.startsWith('SHL1-'));
    assert.match(snapshot.inviteText, /房主地址/);
    assert.equal(await h.isPortReachable(relayPort), true);

    assert.ok(pushed.some((p) => p.channel === 'session:event' && p.payload.type === 'state'), '主进程应向渲染进程推送会话事件');

    const status = await invoke('session:status');
    assert.equal(status.state, 'running');
    assert.equal(status.config.relayPort, relayPort);

    const stopped = await invoke('session:stop');
    assert.equal(stopped.state, 'idle');
    assert.equal(await h.isPortReachable(relayPort), false);
  } finally {
    await invoke('session:stop');
    await echo.close();
  }
});

test('会话 IPC：重复启动与端口占用都返回可读中文提示（不含英文堆栈）', async () => {
  const echo = await h.startEchoServer();
  const relayPort = await h.freePort();
  try {
    await invoke('session:start', { role: 'host', relayPort, targetHost: '127.0.0.1', targetPort: echo.port });
    await assert.rejects(invoke('session:start', { role: 'host', relayPort: await h.freePort(), targetHost: '127.0.0.1', targetPort: echo.port }), (err) => {
      assert.match(err.message, /已经有一个会话/);
      assert.ok(!/EADDRINUSE|at Object/.test(err.message), '不应把英文错误码或堆栈直接抛给界面');
      return true;
    });
  } finally {
    await invoke('session:stop');
  }

  const busy = await h.startEchoServer();
  try {
    await assert.rejects(invoke('session:start', { role: 'host', relayPort: busy.port, targetHost: '127.0.0.1', targetPort: busy.port + 1 }), (err) => {
      assert.match(err.message, /已被占用|已经被监听/);
      return true;
    });
  } finally {
    await invoke('session:stop');
    await busy.close();
    await echo.close();
  }
});

test('IPC 入参白名单：多余字段被丢弃，非对象被拒绝', async () => {
  const echo = await h.startEchoServer();
  const relayPort = await h.freePort();
  try {
    const started = await invoke('session:start', {
      role: 'host', relayPort, targetHost: '127.0.0.1', targetPort: echo.port,
      evil: { toString() { throw new Error('不应被执行'); } },
      __proto__: { polluted: true },
      notAllowedPath: 'C:\\Windows',
    });
    assert.equal(started.state, 'running');
    assert.equal(started.config.notAllowedPath, undefined);
    assert.equal({}.polluted, undefined, '不应污染原型');

    await assert.rejects(invoke('session:start', 'not-an-object'), /会话参数无效/);
    await invoke('session:stop');
    await assert.rejects(invoke('session:start', { role: 'nope', relayPort: 1, targetPort: 2 }), /角色必须是/);
  } finally {
    await invoke('session:stop');
    await echo.close();
  }
});

test('session:check-port 与 session:parse-invite 的可用/不可用分支', async () => {
  const idle = await h.freePort();
  const busy = await h.startEchoServer();
  try {
    const free = await invoke('session:check-port', { relayPort: idle, bindHost: '127.0.0.1' });
    assert.equal(free.free, true);
    const used = await invoke('session:check-port', { relayPort: busy.port, bindHost: '127.0.0.1' });
    assert.equal(used.free, false);

    const invite = 'SHL1-' + Buffer.from(JSON.stringify({ v: 1, game: '测试游戏', host: '192.168.1.7', port: 2301, token: 'tok-1' })).toString('base64url');
    const parsed = await invoke('session:parse-invite', invite);
    assert.equal(parsed.host, '192.168.1.7');
    assert.equal(parsed.port, 2301);
    assert.equal(parsed.token, 'tok-1');
    await assert.rejects(invoke('session:parse-invite', 'garbage'), /格式不正确/);
  } finally {
    await busy.close();
  }
});

test('会话 IPC：多端口批量（TCP + UDP）一次启动，通道状态与 UDP 监听都通过 IPC 返回', async () => {
  const tcpEcho = await h.startEchoServer();
  const udpEcho = await h.startUdpEcho();
  const tcpPort = await h.freePort();
  const udpPort = await h.freeUdpPort();
  try {
    const snapshot = await invoke('session:start', {
      role: 'host',
      bindHost: '127.0.0.1',
      targetHost: '127.0.0.1',
      rules: [
        { protocol: 'TCP', localPort: tcpEcho.port, remotePort: tcpPort, evil: { toString() { throw new Error('不应被执行'); } } },
        { protocol: 'UDP', localPort: udpEcho.port, remotePort: udpPort },
      ],
    });
    assert.equal(snapshot.state, 'running');
    assert.equal(snapshot.channels.length, 2);
    assert.deepEqual(snapshot.channels.map((c) => c.protocol).sort(), ['TCP', 'UDP']);
    assert.equal(snapshot.channels[0].rule.evil, undefined, '规则内部字段也必须走白名单');
    assert.equal(await h.isPortReachable(tcpPort), true, 'TCP 通道应真实监听');

    const udpStatus = await invoke('session:check-port', { relayPort: udpPort, bindHost: '127.0.0.1', protocol: 'UDP' });
    assert.equal(udpStatus.protocol, 'UDP');
    assert.equal(udpStatus.inUseBySession, true, 'UDP 通道应真实占用该端口');

    const status = await invoke('session:status');
    assert.equal(status.channels.length, 2);
    assert.equal(status.config.rules.length, 2);
    assert.match(status.inviteText, /UDP,/);
  } finally {
    await invoke('session:stop');
    await udpEcho.close();
    await tcpEcho.close();
  }

  await assert.rejects(invoke('session:start', { role: 'host', rules: 'nope' }), /端口规则必须是/);
  await assert.rejects(invoke('session:start', { role: 'host', rules: [{ protocol: 'TCP', localPort: 0, remotePort: 1 }] }), /1–65535/);
});

test('会话 IPC 会带上安全信息与弱口令告警（阶段 3）', async () => {
  const echo = await h.startEchoServer();
  const relayPort = await h.freePort();
  const weakPort = await h.freePort();
  try {
    const encrypted = await invoke('session:start', { role: 'host', relayPort, targetHost: '127.0.0.1', targetPort: echo.port, authToken: 'long-enough-pass' });
    assert.equal(encrypted.security.mode, 'psk-aead');
    assert.equal(encrypted.security.cipher, 'AES-256-GCM');
    await invoke('session:stop');

    const weak = await invoke('session:start', { role: 'host', relayPort: weakPort, targetHost: '127.0.0.1', targetPort: echo.port, authToken: 'abc' });
    assert.equal(weak.security.mode, 'psk-aead');
    assert.ok(weak.warnings.some((w) => /短于 8 个字符/.test(w)), '弱口令应通过 IPC 返回告警');
    const invite = await invoke('session:parse-invite', weak.invite.code);
    assert.equal(invite.token, 'abc');
  } finally {
    await invoke('session:stop');
    await echo.close();
  }
});

test('Steam IPC（阶段 4）：诊断报告可用，环境未就绪时会话给出可执行错误', async () => {
  const report = await invoke('steam:diagnose');
  assert.equal(typeof report.available, 'boolean');
  assert.equal(Array.isArray(report.steps), true);
  assert.ok(report.steps.some((s) => s.title.includes('SDK')), '诊断报告应包含 SDK 步骤');
  assert.equal(report.sdk.library, require('../network/steam-env.cjs').PLATFORM_LIBRARY[process.platform]);
  // 未就绪时要说清楚缺什么：可能是 SDK 文件，也可能是可选依赖没装（CI 常见）
  if (!report.available) {
    assert.ok(report.blockers.length > 0);
    assert.ok(
      report.blockers.some((b) => /redistributable|steam_api|steamworks-ffi-node|koffi/.test(b)),
      `blockers 应指出可执行的原因：${report.blockers.join('；')}`,
    );
  }

  const adapters = await invoke('adapters:list');
  const steam = adapters.find((a) => a.id === 'steam-p2p');
  assert.equal(steam.status, report.available ? 'ready' : 'not-configured');
  assert.match(steam.description, report.available ? /已就绪/ : /未就绪/);

  const game = await h.startEchoServer();
  try {
    if (!report.available) {
      await assert.rejects(invoke('session:start', { role: 'host', adapter: 'steam', gamePort: game.port, appId: 480 }), (err) => {
        assert.match(err.message, /Steam 环境未就绪/);
        return true;
      });
      const after = await invoke('session:status');
      assert.equal(after.channels.length, 0, '环境未就绪不应留下通道');
    } else {
      // 本机装了 SDK（例如用游戏自带的 steam_api64.dll）：不能在这里真跑 Steam 会话——
      // 那会在测试进程里初始化 Steam；只确认适配器状态与错误拦截即可。
      assert.equal(steam.status, 'ready');
    }
    // 非法 SteamID 必须被拦下（不依赖 SDK 是否可用）
    await assert.rejects(invoke('session:start', { role: 'joiner', adapter: 'steam', hostSteamId: 'bad', localPort: await h.freePort() }), /SteamID 格式不正确/);
  } finally {
    await invoke('session:stop');
    await game.close();
  }
});

test('连接配方 IPC（阶段 5）：配方列表、连接说明、配置里的 recipe 持久化', async () => {
  const recipes = await invoke('adapters:recipes');
  assert.equal(recipes.length, 4);
  const web = recipes.find((r) => r.id === 'local-web');
  assert.match(web.name, /浏览器应用/);
  assert.equal(web.available, true);
  const steam = recipes.find((r) => r.id === 'steam-tunnel');
  assert.equal(typeof steam.available, 'boolean');

  const hints = await invoke('adapters:recipe-hints', {
    recipe: 'local-web',
    rules: [{ protocol: 'TCP', localPort: 3000, remotePort: 3001 }],
    game: '卫戍协议：盟约',
  });
  assert.ok(hints.clientHint.some((h) => /http:\/\/127\.0\.0\.1:3000/.test(h)), '应给出浏览器打开地址');
  assert.ok(hints.hostHint.some((h) => /对好友开放/.test(h)));

  const noneHints = await invoke('adapters:recipe-hints', { recipe: 'lan-direct', gamePort: 3000 });
  assert.ok(noneHints.clientHint.some((h) => /不参与流量转发/.test(h)), '「不做转发」必须说清楚');

  // recipe 会随配置一起持久化
  const saved = await invoke('profiles:save', [{
    id: 'p-recipe', name: '卫戍协议：盟约', transport: 'TCP', recipe: 'local-web',
    ports: [{ protocol: 'TCP', localPort: 3000, remotePort: 3001 }],
  }]);
  assert.equal(saved[0].recipe, 'local-web');
  const loaded = await invoke('profiles:load');
  assert.equal(loaded.find((p) => p.id === 'p-recipe').recipe, 'local-web');
});

test('退出清理：window-all-closed / before-quit 都会释放端口', async () => {
  const echo = await h.startEchoServer();
  const relayPort = await h.freePort();
  try {
    await invoke('session:start', { role: 'host', relayPort, targetHost: '127.0.0.1', targetPort: echo.port });
    assert.equal(await h.isPortReachable(relayPort), true);

    const quitHook = appEvents.find((e) => e.name === 'before-quit');
    assert.ok(quitHook, '应注册 before-quit 清理钩子');
    quitHook.fn();
    assert.equal(await h.waitFor(async () => !(await h.isPortReachable(relayPort, '127.0.0.1', 300)), { timeoutMs: 3000 }), true, '退出钩子必须释放端口');
  } finally {
    await invoke('session:stop');
    await echo.close();
  }
});
