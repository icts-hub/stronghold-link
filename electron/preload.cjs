'use strict';
// Stronghold Link — preload。
// 只通过 contextBridge 暴露白名单方法；渲染进程无法直接 require Node、拿不到文件路径，
// 也不能发送任意 IPC 频道（频道名固定在主进程侧注册）。

const { contextBridge, ipcRenderer } = require('electron');

const SESSION_EVENT_CHANNEL = 'session:event';
const LOBBY_EVENT_CHANNEL = 'lobby:event';

/**
 * 版本号来自主进程（审计 A-09）。
 *
 * 这里以前写死 `'0.11.0'`，而 package.json / electron/main.cjs 的 APP_VERSION 是 `0.14.4`
 * —— 界面"关于"显示 0.11.0、启动日志写 0.14.4，用户报障报的版本号跟日志对不上。
 *
 * 现在由 `electron/main.cjs` 建窗口时用 `additionalArguments` 把 `--shl-version=<版本>`
 * 传下来（appVersionOf 读 APP_VERSION，也就是与 package.json 一致的那一份）。
 * 为什么不在这里直接 require('../package.json')：打出来的包是 app.asar，
 * preload 跑在渲染进程里，任何**新的**运行时依赖都会变成打包风险（少一个文件就是白屏）。
 * 命令行参数是 Electron 官方支持的路子，且在有沙箱的渲染进程里同样可用。
 * 兜底：拿不到参数时用主进程在同样拿不到时会用的那份声明，而不是再猜一个数字。
 */
const VERSION_FLAG = '--shl-version=';
const appVersion = (() => {
  const hit = process.argv.find((arg) => typeof arg === 'string' && arg.startsWith(VERSION_FLAG));
  if (hit) return hit.slice(VERSION_FLAG.length);
  // 兜底：只有极老的 shell / 直接加载 preload 的测试才会走到这里。
  return '0.0.0-unknown';
})();

contextBridge.exposeInMainWorld('strongholdLink', {
  version: appVersion,
  profiles: {
    load: () => ipcRenderer.invoke('profiles:load'),
    save: (profiles) => ipcRenderer.invoke('profiles:save', profiles),
  },
  adapters: {
    list: () => ipcRenderer.invoke('adapters:list'),
    recipes: () => ipcRenderer.invoke('adapters:recipes'),
    recipeHints: (input) => ipcRenderer.invoke('adapters:recipe-hints', input),
  },
  network: {
    relaySelfTest: () => ipcRenderer.invoke('network:relay-selftest'),
    routes: (input) => ipcRenderer.invoke('network:routes', input || {}),
    routeWatch: (input) => ipcRenderer.invoke('network:route-watch', input || {}),
    natType: () => ipcRenderer.invoke('network:nat-type'),
    listeningPorts: () => ipcRenderer.invoke('network:listening-ports'),
    openUrl: (url) => ipcRenderer.invoke('app:open-url', { url }),
    // 最小化/后台时是否暂停动画
    onActivity: (listener) => { const h = (_e, p) => listener(p); ipcRenderer.on('app:activity', h); return () => ipcRenderer.removeListener('app:activity', h); },
    processList: (input) => ipcRenderer.invoke('network:process-list', input || {}),
    processDetail: (pid) => ipcRenderer.invoke('network:process-detail', { pid }),
  },
  steam: {
    diagnose: () => ipcRenderer.invoke('steam:diagnose'),
  },
  /** 无边框窗口的自绘窗口按钮 */
  win: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
    close: () => ipcRenderer.invoke('window:close'),
    state: () => ipcRenderer.invoke('window:state'),
    onState: (handler) => {
      if (typeof handler !== 'function') return () => {};
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('window:state', listener);
      return () => ipcRenderer.removeListener('window:state', listener);
    },
  },
  /** Steam 大厅与好友：邀请好友联机 */
  lobby: {
    status: () => ipcRenderer.invoke('lobby:status'),
    friends: () => ipcRenderer.invoke('lobby:friends'),
    create: (options) => ipcRenderer.invoke('lobby:create', options),
    join: (lobbyId) => ipcRenderer.invoke('lobby:join', { lobbyId }),
    leave: () => ipcRenderer.invoke('lobby:leave'),
    invite: (steamId) => ipcRenderer.invoke('lobby:invite', { steamId }),
    connect: (input) => ipcRenderer.invoke('lobby:connect', input || {}),
    prepare: (input) => ipcRenderer.invoke('lobby:prepare', input || {}),
    setRoom: (room) => ipcRenderer.invoke('lobby:set-room', { room }),
    selftest: () => ipcRenderer.invoke('lobby:selftest'),
    saveSelftest: (text) => ipcRenderer.invoke('selftest:save', { text }),
    stop: () => ipcRenderer.invoke('lobby:stop'),
    /** 订阅大厅事件（成员变化、邀请结果、有人邀请你等） */
    onEvent: (handler) => {
      if (typeof handler !== 'function') return () => {};
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on(LOBBY_EVENT_CHANNEL, listener);
      return () => ipcRenderer.removeListener(LOBBY_EVENT_CHANNEL, listener);
    },
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    revealConfig: () => ipcRenderer.invoke('app:reveal-config'),
    /** 真实进程内存占用，供底部状态条显示 */
    metrics: () => ipcRenderer.invoke('app:metrics'),
  },
  /**
   * 应用设置。目前只有一项：Steam 线路档位（'env' | 'auto' | 'ice' | 'relay'）。
   * load() 会带回"实际生效的是哪一档"（把环境变量与出厂默认也算进去），界面直接显示它。
   */
  settings: {
    load: () => ipcRenderer.invoke('settings:load'),
    save: (input) => ipcRenderer.invoke('settings:save', input || {}),
  },
  session: {
    start: (options) => ipcRenderer.invoke('session:start', options),
    stop: () => ipcRenderer.invoke('session:stop'),
    status: () => ipcRenderer.invoke('session:status'),
    /** 活连接线路报告：直连 / Steam 中继、POP、本地 socket 与 Steam 各自的字节速率 */
    route: () => ipcRenderer.invoke('session:route'),
    checkPort: (options) => ipcRenderer.invoke('session:check-port', options),
    parseInvite: (code) => ipcRenderer.invoke('session:parse-invite', code),
    /** 订阅会话事件；返回取消订阅函数。渲染进程只能收到主进程推送的会话事件。 */
    onEvent: (handler) => {
      if (typeof handler !== 'function') return () => {};
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on(SESSION_EVENT_CHANNEL, listener);
      return () => ipcRenderer.removeListener(SESSION_EVENT_CHANNEL, listener);
    },
  },
});
