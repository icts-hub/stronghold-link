'use strict';
// Stronghold Link — preload。
// 只通过 contextBridge 暴露白名单方法；渲染进程无法直接 require Node、拿不到文件路径，
// 也不能发送任意 IPC 频道（频道名固定在主进程侧注册）。

const { contextBridge, ipcRenderer } = require('electron');

const SESSION_EVENT_CHANNEL = 'session:event';
const LOBBY_EVENT_CHANNEL = 'lobby:event';

contextBridge.exposeInMainWorld('strongholdLink', {
  version: '0.11.0',
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
