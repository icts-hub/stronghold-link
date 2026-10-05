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
  },
  steam: {
    diagnose: () => ipcRenderer.invoke('steam:diagnose'),
  },
  /** Steam 大厅与好友：邀请好友联机 */
  lobby: {
    status: () => ipcRenderer.invoke('lobby:status'),
    friends: () => ipcRenderer.invoke('lobby:friends'),
    create: (options) => ipcRenderer.invoke('lobby:create', options),
    join: (lobbyId) => ipcRenderer.invoke('lobby:join', { lobbyId }),
    leave: () => ipcRenderer.invoke('lobby:leave'),
    invite: (steamId) => ipcRenderer.invoke('lobby:invite', { steamId }),
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
  },
  session: {
    start: (options) => ipcRenderer.invoke('session:start', options),
    stop: () => ipcRenderer.invoke('session:stop'),
    status: () => ipcRenderer.invoke('session:status'),
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
