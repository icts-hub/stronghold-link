'use strict';
// 大厅直连（lobby → session）单测：角色判断、缺信息时不启动、运行中不偷重启。

const test = require('node:test');
const assert = require('node:assert');

const { planLobbyConnect, ACTIONS } = require('../network/lobby-connect.cjs');

const LOBBY = { lobbyId: '109775241234567890', hostSteamId: '76561199054352286', port: 3000, game: '卫戍协议', version: '0.12.0' };

test('没有大厅：不启动，说明原因', () => {
  const out = planLobbyConnect({ role: 'joiner', lobby: null });
  assert.equal(out.action, ACTIONS.NONE);
  assert.match(out.reason, /还没有大厅/);
});

test('加入者：用大厅里的房主 SteamID 启动 Steam 隧道，端口自动分配', () => {
  const out = planLobbyConnect({ role: 'joiner', lobby: LOBBY, appId: 480, appVersion: '0.12.0' });
  assert.equal(out.action, ACTIONS.START);
  assert.equal(out.options.adapter, 'steam');
  assert.equal(out.options.role, 'joiner');
  assert.equal(out.options.hostSteamId, LOBBY.hostSteamId);
  assert.equal(out.options.localPort, 0, '入口端口交给系统自动分配');
  assert.equal(out.options.appId, 480);
  assert.ok(out.notes.some((n) => n.includes('不是这个')), '必须说明加入者连的不是房主端口');
});

test('加入者：大厅里没有房主信息时不启动（房主未启动房主会话）', () => {
  const out = planLobbyConnect({ role: 'joiner', lobby: { lobbyId: 'x', hostSteamId: '', port: 3000 } });
  assert.equal(out.action, ACTIONS.NONE);
  assert.match(out.reason, /还没有房主信息/);
});

test('已经连上同一条隧道：不重复启动', () => {
  const out = planLobbyConnect({
    role: 'joiner',
    lobby: LOBBY,
    session: { state: 'running', config: { adapter: 'steam', role: 'joiner', remoteHost: LOBBY.hostSteamId } },
  });
  assert.equal(out.action, ACTIONS.NONE);
  assert.match(out.reason, /已经通过大厅连上/);
});

test('已有别的会话在跑：不偷重启，让用户先停', () => {
  const joiner = planLobbyConnect({
    role: 'joiner', lobby: LOBBY,
    session: { state: 'running', config: { adapter: 'local', role: 'host', targetPort: 8080 } },
  });
  assert.equal(joiner.action, ACTIONS.NONE);
  assert.match(joiner.reason, /请先停止/);
  const host = planLobbyConnect({
    role: 'host', lobby: LOBBY,
    session: { state: 'running', config: { adapter: 'local', role: 'host', targetPort: 8080 } },
  });
  assert.equal(host.action, ACTIONS.NONE);
});

test('房主：用大厅里的服务端口启动房主会话', () => {
  const out = planLobbyConnect({ role: 'host', lobby: LOBBY, appId: 480 });
  assert.equal(out.action, ACTIONS.START);
  assert.equal(out.options.role, 'host');
  assert.equal(out.options.gamePort, 3000);
  assert.equal(out.options.targetHost, '127.0.0.1');
  assert.ok(out.notes.some((n) => n.includes('不会监听端口')), '必须说明房主侧不监听端口');
});

test('房主：大厅里没有服务端口时不启动（好友不知道连哪里）', () => {
  const out = planLobbyConnect({ role: 'host', lobby: { lobbyId: 'x', hostSteamId: '76561199054352286', port: null } });
  assert.equal(out.action, ACTIONS.NONE);
  assert.match(out.reason, /没有服务端口/);
});

test('房主已在等好友：不重复启动；版本不一致给出提示但不阻塞', () => {
  const same = planLobbyConnect({
    role: 'host', lobby: LOBBY,
    session: { state: 'running', config: { adapter: 'steam', role: 'host', targetPort: 3000 } },
  });
  assert.equal(same.action, ACTIONS.NONE);
  assert.match(same.reason, /在等好友/);

  const mismatched = planLobbyConnect({ role: 'joiner', lobby: { ...LOBBY, version: '0.11.0' }, appVersion: '0.12.0' });
  assert.equal(mismatched.action, ACTIONS.START, '版本不一致只提示，不阻止连接');
  assert.ok(mismatched.notes.some((n) => n.includes('0.11.0')));
});
