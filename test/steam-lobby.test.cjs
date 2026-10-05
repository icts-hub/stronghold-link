'use strict';
// Steam 大厅/好友测试：用注入的假 SDK（test/steam-mock.cjs），不是真实 Steam。
// 运行：node --test --test-isolation=none test/steam-lobby.test.cjs
//
// 覆盖：初始化、建房写数据、一键邀请、加入并读房主信息、好友列表映射、
// 好友点「加入游戏」的回调、成员变化、离开大厅、缺接口时的可读错误。
const test = require('node:test');
const assert = require('node:assert/strict');

const { createLobbyManager, DATA_KEYS, PROTO_TAG } = require('../network/steam-lobby.cjs');
const { createMockSdk, HOST_STEAM_ID } = require('./steam-mock.cjs');

const FRIEND_ID = '76561198000000042';

function setup() {
  const mock = createMockSdk();
  const events = [];
  const manager = createLobbyManager({
    sdk: mock.sdk,
    appId: 480,
    onEvent: (type, payload) => events.push({ type, payload }),
    memberPollMs: 40,
    callbackIntervalMs: 20,
  });
  const types = () => events.map((e) => e.type);
  const last = (type) => [...events].reverse().find((e) => e.type === type);
  return { mock, manager, events, types, last };
}

test('初始化：读出自己的 SteamID 与昵称，并触发 ready', async () => {
  const { manager, types, last } = setup();
  try {
    const info = await manager.attach();
    assert.ok(info.steam);
    assert.equal(manager.snapshot().steamId, HOST_STEAM_ID);
    assert.equal(manager.snapshot().name, '测试用户');
    assert.ok(types().includes('ready'));
    assert.equal(last('ready').payload.steamId, HOST_STEAM_ID);
    await manager.attach(); // 幂等
  } finally {
    await manager.stop();
  }
});

test('建房：把房主 SteamID / 端口 / 协议标记写进大厅数据', async () => {
  const { mock, manager, types, last } = setup();
  try {
    const result = await manager.create({ maxMembers: 4, hostSteamId: HOST_STEAM_ID, port: 3000, game: '卫戍协议', version: '0.10.0' });
    assert.equal(result.ok, true);
    assert.ok(result.lobbyId);
    assert.deepEqual(mock.state.lobby.created, [{ type: 1, maxMembers: 4 }]);

    const written = Object.fromEntries(mock.state.lobby.dataWrites.map((w) => [w.key, w.value]));
    assert.equal(written[DATA_KEYS.host], HOST_STEAM_ID);
    assert.equal(written[DATA_KEYS.port], '3000');
    assert.equal(written[DATA_KEYS.proto], PROTO_TAG);
    assert.equal(written[DATA_KEYS.version], '0.10.0');

    assert.ok(types().includes('lobby-created'));
    assert.equal(last('lobby-created').payload.lobbyId, result.lobbyId);

    // 成员里应包含自己且标记为房主
    const snapshot = manager.snapshot();
    assert.equal(snapshot.isOwner, true);
    assert.equal(snapshot.members.length, 1);
    assert.equal(snapshot.members[0].self, true);
    assert.equal(snapshot.members[0].owner, true);
  } finally {
    await manager.stop();
  }
});

test('建房失败时给出可读原因，不留下大厅', async () => {
  const { mock, manager } = setup();
  mock.state.lobby.createResult = false;
  try {
    const result = await manager.create({ port: 3000 });
    assert.equal(result.ok, false);
    assert.match(result.reason, /创建大厅失败|Steam 返回/);
    assert.equal(manager.lobbyId, null);
    assert.equal(manager.snapshot().error !== null, true);
  } finally {
    await manager.stop();
  }
});

test('一键邀请：调用 Steam 邀请接口并如实返回结果', async () => {
  const { mock, manager, last } = setup();
  try {
    // 还没建房时不能邀请
    assert.equal(manager.invite(FRIEND_ID).ok, false);
    assert.match(manager.invite(FRIEND_ID).reason, /还没有创建房间/);

    const created = await manager.create({ hostSteamId: HOST_STEAM_ID, port: 3000 });
    const invited = manager.invite(FRIEND_ID);
    assert.equal(invited.ok, true);
    assert.deepEqual(mock.state.lobby.invited, [{ lobbyId: created.lobbyId, steamId: FRIEND_ID }]);
    assert.equal(last('invited').payload.ok, true);

    // Steam 拒绝时要把原因带回来（例如对方不在好友列表）
    mock.state.lobby.inviteResult = false;
    const rejected = manager.invite(FRIEND_ID);
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason, /Steam 拒绝了这次邀请/);
  } finally {
    await manager.stop();
  }
});

test('加入大厅：读出房主写下的连接信息', async () => {
  const host = setup();   // 用同一个假 SDK 造一个“房主的大厅”
  const guest = createLobbyManager({ sdk: host.mock.sdk, appId: 480, onEvent: () => {}, memberPollMs: 40 });
  try {
    const created = await host.manager.create({ hostSteamId: HOST_STEAM_ID, port: 3000, game: '卫戍协议' });
    const joined = await guest.join(created.lobbyId);
    assert.equal(joined.ok, true);
    assert.equal(joined.host.hostSteamId, HOST_STEAM_ID);
    assert.equal(joined.host.port, 3000);
    assert.equal(joined.host.game, '卫戍协议');
    assert.equal(guest.snapshot().isOwner, false);
    assert.equal(host.mock.state.lobby.joined.includes(created.lobbyId), true);
  } finally {
    await guest.stop();
    await host.manager.stop();
  }
});

test('加入不存在的大厅：失败并给出 Steam 响应码', async () => {
  const { manager } = setup();
  try {
    const result = await manager.join('109775242000000999');
    assert.equal(result.ok, false);
    assert.match(result.reason, /进入大厅失败/);
    assert.equal(manager.lobbyId, null);
  } finally {
    await manager.stop();
  }
});

test('好友点「加入游戏」：触发 join-requested，且请求可取走', async () => {
  const { mock, manager, types, last } = setup();
  try {
    await manager.create({ hostSteamId: HOST_STEAM_ID, port: 3000 });
    mock.state.emitJoinRequested({ lobbyId: '109775242000000777', friendSteamId: FRIEND_ID });
    assert.ok(types().includes('join-requested'));
    const payload = last('join-requested').payload;
    assert.equal(payload.lobbyId, '109775242000000777');
    assert.equal(payload.friendSteamId, FRIEND_ID);
    assert.deepEqual(manager.takePendingJoin(), payload);
    assert.equal(manager.takePendingJoin(), null, '取走后应为空');
  } finally {
    await manager.stop();
  }
});

test('命令行 +connect_lobby：读得出要加入的大厅 ID', async () => {
  const { mock, manager } = setup();
  try {
    // 未 attach 时也能从命令行解析（Steam 启动我们时就是这样传的）
    assert.equal(manager.connectLobbyFromCommandLine(['app.exe', '+connect_lobby', '109775242000000555']), '109775242000000555');
    assert.equal(manager.connectLobbyFromCommandLine(['app.exe']), null);
    assert.equal(manager.connectLobbyFromCommandLine(['app.exe', '+connect_lobby', 'not-a-number']), null);

    // attach 之后优先用 SDK 给的答案
    await manager.attach();
    assert.equal(manager.connectLobbyFromCommandLine(), null);
    mock.state.lobby.cmdLobbyId = '109775242000000556';
    assert.equal(manager.connectLobbyFromCommandLine(['app.exe']), '109775242000000556');
  } finally {
    await manager.stop();
  }
});

test('成员变化：好友进房会推 members 事件并标出新增的人', async () => {
  const { mock, manager, types, last } = setup();
  try {
    mock.state.addFriend(FRIEND_ID, '好友甲');
    const created = await manager.create({ hostSteamId: HOST_STEAM_ID, port: 3000 });
    mock.state.addLobbyMember(created.lobbyId, FRIEND_ID);
    const ok = await waitFor(() => last('members') && last('members').payload.members.length === 2, 2000);
    assert.equal(ok, true, '应收到 2 人的成员事件');
    const payload = last('members').payload;
    assert.equal(payload.added.some((m) => m.steamId === FRIEND_ID && m.name === '好友甲'), true);
    assert.ok(types().includes('members'));
  } finally {
    await manager.stop();
  }
});

test('好友列表：只留真正的好友，在线优先，并标出在同一大厅的人', async () => {
  const { mock, manager } = setup();
  try {
    mock.state.addFriend(FRIEND_ID, '在线好友', 1);
    mock.state.addFriend('76561198000000043', '离线好友', 0);
    mock.state.addFriend('76561198000000044', '陌生人', 1, 2); // 非好友关系，应被过滤
    const created = await manager.create({ hostSteamId: HOST_STEAM_ID, port: 3000 });
    mock.state.setFriendLobby(FRIEND_ID, created.lobbyId);

    const friends = await manager.listFriends();
    assert.equal(friends.length, 2);
    assert.equal(friends[0].name, '在线好友');
    assert.equal(friends[0].online, true);
    assert.equal(friends[0].inOurLobby, true);
    assert.equal(friends[1].name, '离线好友');
    assert.equal(friends[1].online, false);
    assert.equal(friends.some((f) => f.name === '陌生人'), false);
  } finally {
    await manager.stop();
  }
});

test('离开大厅：清空状态并触发 lobby-left', async () => {
  const { mock, manager, types } = setup();
  try {
    const created = await manager.create({ hostSteamId: HOST_STEAM_ID, port: 3000 });
    manager.leave();
    assert.equal(manager.lobbyId, null);
    assert.equal(manager.snapshot().members.length, 0);
    assert.deepEqual(mock.state.lobby.left, [created.lobbyId]);
    assert.ok(types().includes('lobby-left'));
  } finally {
    await manager.stop();
  }
});

test('Steam 绑定缺少大厅/好友接口时给出可读错误', async () => {
  const manager = createLobbyManager({ sdk: { runCallbacks: () => {} }, appId: 480 });
  try {
    await assert.rejects(manager.attach(), (err) => {
      assert.equal(err.code, 'ESTEAMAPI');
      assert.match(err.friendly, /大厅|好友/);
      return true;
    });
  } finally {
    await manager.stop();
  }
});

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('空载荷的加入请求会被忽略并记录（实测 Steam 会派发一次空回调）', async () => {
  const { mock, manager, types, last } = setup();
  try {
    await manager.attach();
    mock.state.emitJoinRequested({ lobbyId: '', friendSteamId: '' });
    assert.equal(types().includes('join-requested'), false, '空载荷不应触发 join-requested');
    assert.ok(types().includes('error'), '应记录一条可排查的错误');
    assert.match(last('error').payload.reason, /没有大厅 ID/);
    assert.equal(manager.takePendingJoin(), null);

    mock.state.emitJoinRequested({ lobbyId: '0', friendSteamId: '76561198000000042' });
    assert.equal(types().includes('join-requested'), false, 'lobbyId=0 同样无效');

    mock.state.emitJoinRequested({ lobbyId: '109775242000000777', friendSteamId: FRIEND_ID });
    assert.equal(types().includes('join-requested'), true, '正常载荷仍要触发');
  } finally {
    await manager.stop();
  }
});
