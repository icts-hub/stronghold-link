'use strict';
// Stronghold Link — preload。
// 只通过 contextBridge 暴露白名单方法；渲染进程无法直接 require Node、拿不到文件路径，
// 也不能发送任意 IPC 频道（频道名固定在主进程侧注册）。

const { contextBridge, ipcRenderer } = require('electron');

const SESSION_EVENT_CHANNEL = 'session:event';

contextBridge.exposeInMainWorld('strongholdLink', {
  version: '0.9.1',
  profiles: {
    load: () => ipcRenderer.invoke('profiles:load'),
    save: (profiles) => ipcRenderer.invoke('profiles:save', profiles),
  },
  adapters: {
    list: () => ipcRenderer.invoke('adapters:list'),
    recipes: () => ipcRenderer.invoke('adapters:recipes'),
    recipeHints: (input) => ipcRenderer.invoke('adapters:recipe-hints', input),
  },
  steam: {
    diagnose: () => ipcRenderer.invoke('steam:diagnose'),
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
