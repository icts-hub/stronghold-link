'use strict';
// Steam 大厅（Lobby）与好友：把「邀请好友联机」这件事包成一组可测的操作。
//
// 设计要点：
//   * 大厅只用来**交换连接信息**，真正的数据通路还是 Steam P2P 隧道（network/steam-adapter.cjs）。
//     房主建房时把 host SteamID / 服务端口 / 版本写进大厅数据；
//     好友点「加入游戏」或在大厅里进房后，我们读这些数据就能自动配好加入者会话。
//   * 好友点 Steam 里的「加入游戏」时，Steam 会用 `+connect_lobby <id>` 启动本程序，
//     这种情况用 getConnectLobbyIdFromCommandLine() 读出来（见 connectLobbyFromCommandLine）。
//   * 不调用 init 就没法用；缺 SDK 时抛带 friendly 的错误，界面据此提示自检。

const { initSteamSdk } = require('./steam-adapter.cjs');

/** 写进大厅的数据键（前缀 shl_ 以避免和别的 App 冲突）。 */
const DATA_KEYS = {
  host: 'shl_host',        // 房主 SteamID
  port: 'shl_port',        // 房主要共享的本机服务端口
  game: 'shl_game',        // 备注名
  version: 'shl_version',  // 程序版本，用于提示版本不一致
  proto: 'shl_proto',      // 协议标记，避免有人误加入别的大厅
};
const PROTO_TAG = 'stronghold-link/1';

/** ELobbyType（来自 steamworks-ffi-node 的枚举定义）。 */
const LOBBY_TYPES = { private: 0, friends: 1, public: 2, invisible: 3 };

const STATE_NAMES = {
  0: '离线', 1: '在线', 2: '忙碌', 3: '离开', 4: '打盹', 5: '想交易', 6: '想玩', 7: '隐身',
};
const RELATIONSHIP_FRIEND = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 创建大厅管理器。懒加载：调用 attach()（或任一需要 SDK 的方法）时才初始化 Steam。
 * @param {object} options
 * @param {string} [options.appDir]      用于查找 SDK/模块
 * @param {number} [options.appId]       AppID，默认 480
 * @param {object} [options.sdk]         注入 SDK（测试用，跳过真实 init）
 * @param {object} [options.steamModule] 注入模块（测试用）
 * @param {Function} [options.onEvent]   事件回调 (type, payload)
 * @param {Function} [options.sdkFactory] 自定义获取 SDK 的方式（主进程用它注入测试替身）
 */
function createLobbyManager({
  appDir,
  appId = 480,
  sdk = null,
  steamModule = null,
  onEvent = () => {},
  sdkFactory = null,
  memberPollMs = 1500,
  callbackIntervalMs = 50,
} = {}) {
  let steam = null;
  let matchmaking = null;
  let friends = null;
  let stopLoop = null;
  let memberTimer = null;
  let offJoinRequested = null;
  let stopped = false;
  let attaching = null;

  let lobbyId = null;
  let isOwner = false;
  let members = [];
  let lastMembersKey = '';
  let pendingJoin = null;      // 未处理完的加入请求（界面还没起来时先存着）
  let lastError = null;
  let own = { steamId: null, name: null };
  let friendCache = [];

  const emit = (type, payload = {}) => {
    try { onEvent(type, payload); } catch { /* 事件回调出错不影响主流程 */ }
  };

  const memberName = (steamId) => {
    try {
      const name = friends?.getFriendPersonaName?.(steamId);
      return name && name !== '[unknown]' ? name : String(steamId);
    } catch {
      return String(steamId);
    }
  };

  const readMembers = () => {
    if (!lobbyId) return [];
    try {
      const ids = matchmaking.getLobbyMembers(lobbyId) || [];
      const ownerId = matchmaking.getLobbyOwner?.(lobbyId) || null;
      return ids.map((id) => ({
        steamId: String(id),
        name: memberName(id),
        owner: ownerId ? String(id) === String(ownerId) : false,
        self: own.steamId ? String(id) === String(own.steamId) : false,
      }));
    } catch (err) {
      lastError = String(err && err.message ? err.message : err);
      return [];
    }
  };

  const refreshMembers = (reason = 'poll') => {
    const next = readMembers();
    const key = next.map((m) => `${m.steamId}${m.owner ? '*' : ''}`).join(',');
    members = next;
    if (key !== lastMembersKey) {
      const added = next.filter((m) => !lastMembersKey.includes(m.steamId));
      lastMembersKey = key;
      emit('members', { lobbyId, members: next, reason, added: added.map((m) => ({ steamId: m.steamId, name: m.name })) });
    }
  };

  /** 读取大厅里房主写下的连接信息。 */
  const readHostInfo = () => {
    if (!lobbyId) return null;
    try {
      const host = matchmaking.getLobbyData(lobbyId, DATA_KEYS.host) || '';
      if (!host) return null;
      return {
        lobbyId,
        hostSteamId: String(host),
        hostName: memberName(host),
        port: Number(matchmaking.getLobbyData(lobbyId, DATA_KEYS.port)) || null,
        game: matchmaking.getLobbyData(lobbyId, DATA_KEYS.game) || '',
        version: matchmaking.getLobbyData(lobbyId, DATA_KEYS.version) || '',
      };
    } catch (err) {
      lastError = String(err && err.message ? err.message : err);
      return null;
    }
  };

  const startLoops = () => {
    if (!stopLoop) {
      const timer = setInterval(() => {
        if (stopped) return;
        try { steam.runCallbacks?.(); } catch (err) { lastError = String(err && err.message ? err.message : err); }
        try { matchmaking.pollChatMessages?.(); } catch { /* 聊天不是必需 */ }
      }, callbackIntervalMs);
      if (typeof timer.unref === 'function') timer.unref();
      stopLoop = () => clearInterval(timer);
    }
    if (!memberTimer && lobbyId) {
      const timer = setInterval(() => { if (!stopped && lobbyId) refreshMembers(); }, memberPollMs);
      if (typeof timer.unref === 'function') timer.unref();
      memberTimer = () => clearInterval(timer);
    }
  };

  const stopLoops = () => {
    if (stopLoop) stopLoop();
    stopLoop = null;
    if (memberTimer) memberTimer();
    memberTimer = null;
  };

  /** 初始化 Steam 并订阅事件；可重复调用。 */
  async function attach() {
    if (stopped) throw Object.assign(new Error('大厅管理器已停止'), { friendly: '大厅管理器已停止' });
    if (steam) return { steam, matchmaking, friends };
    if (attaching) return attaching;

    attaching = (async () => {
      const init = sdkFactory ? sdkFactory() : { steam: sdk, injected: Boolean(sdk) };
      const resolved = init && init.steam ? init : initSteamSdk({ appDir, appId, sdk, steamModule });
      steam = resolved.steam;
      matchmaking = steam.matchmaking;
      friends = steam.friends;
      if (!matchmaking || !friends) {
        throw Object.assign(new Error('当前 Steam 绑定没有提供 matchmaking/friends 接口'), {
          code: 'ESTEAMAPI',
          friendly: '当前 Steam 绑定缺少大厅/好友接口，无法使用邀请功能（需要 steamworks-ffi-node 0.11+）。',
        });
      }

      try {
        own.steamId = steam.getStatus?.().steamId || null;
        own.name = friends.getPersonaName?.() || null;
      } catch { /* 取不到就留空 */ }

      offJoinRequested = matchmaking.onGameLobbyJoinRequested((event) => {
        const rawLobbyId = event && event.lobbyId != null ? String(event.lobbyId) : '';
        // Steam 偶尔会派发一个空载荷（实测遇到过）；没有有效大厅 ID 的直接忽略并记一笔
        if (!rawLobbyId || rawLobbyId === '0') {
          lastError = '收到一次没有大厅 ID 的加入请求，已忽略';
          emit('error', { stage: 'join-requested', reason: lastError, raw: event ? Object.keys(event) : null });
          return;
        }
        const request = {
          lobbyId: String(event?.lobbyId || ''),
          friendSteamId: String(event?.friendSteamId || ''),
          friendName: memberName(event?.friendSteamId),
        };
        pendingJoin = request;
        emit('join-requested', request);
      });

      startLoops();
      emit('ready', { steamId: own.steamId, name: own.name, appId });
      return { steam, matchmaking, friends };
    })();

    try {
      return await attaching;
    } finally {
      attaching = null;
    }
  }

  /** 建房：把连接信息写进大厅数据，好友加入后就能读到。 */
  async function create({ maxMembers = 4, type = 'friends', hostSteamId = null, port = null, game = '', version = '' } = {}) {
    await attach();
    if (lobbyId) return { ok: true, lobbyId, alreadyOpen: true };

    const lobbyType = LOBBY_TYPES[type] ?? LOBBY_TYPES.friends;
    const result = await matchmaking.createLobby(lobbyType, Math.max(2, Math.min(250, Number(maxMembers) || 4)));
    if (!result || !result.success || !result.lobbyId) {
      const reason = result && result.response ? `Steam 返回 ${result.response}` : '创建大厅失败';
      lastError = reason;
      emit('error', { stage: 'create-lobby', reason });
      return { ok: false, reason };
    }

    lobbyId = String(result.lobbyId);
    isOwner = true;
    lastMembersKey = '';
    refreshMembers('created');
    startLoops();

    const values = {
      [DATA_KEYS.proto]: PROTO_TAG,
      [DATA_KEYS.host]: String(hostSteamId || own.steamId || ''),
      [DATA_KEYS.version]: String(version || ''),
      [DATA_KEYS.game]: String(game || ''),
    };
    if (port) values[DATA_KEYS.port] = String(port);
    try {
      for (const [key, value] of Object.entries(values)) matchmaking.setLobbyData(lobbyId, key, value);
      matchmaking.setLobbyJoinable?.(lobbyId, true);
    } catch (err) {
      lastError = String(err && err.message ? err.message : err);
    }

    emit('lobby-created', { lobbyId, members, hostSteamId: values[DATA_KEYS.host], port: port || null });
    return { ok: true, lobbyId, hostSteamId: values[DATA_KEYS.host] };
  }

  /** 加入别人的大厅，并读出房主的连接信息。 */
  async function join(targetLobbyId) {
    await attach();
    const id = String(targetLobbyId || '').trim();
    if (!id) return { ok: false, reason: '大厅 ID 不能为空' };
    if (lobbyId && lobbyId === id) {
      const info = readHostInfo();
      return { ok: true, lobbyId, host: info, alreadyIn: true };
    }
    if (lobbyId) leave();

    const result = await matchmaking.joinLobby(id);
    if (!result || !result.success) {
      const reason = result && result.response ? `进入大厅失败（Steam 响应 ${result.response}）` : '进入大厅失败';
      lastError = reason;
      emit('error', { stage: 'join-lobby', reason });
      return { ok: false, reason };
    }

    lobbyId = id;
    isOwner = false;
    lastMembersKey = '';
    startLoops();
    // 大厅数据可能需要拉一下才有（自己刚进房时本地缓存可能是空的）
    try { matchmaking.requestLobbyData?.(lobbyId); } catch { /* 忽略 */ }
    await sleep(120);
    refreshMembers('joined');

    const host = readHostInfo();
    emit('lobby-joined', { lobbyId, members, host });
    return { ok: true, lobbyId, host };
  }

  function leave() {
    if (!lobbyId) return { ok: true };
    const previous = lobbyId;
    try { matchmaking.leaveLobby(previous); } catch (err) { lastError = String(err && err.message ? err.message : err); }
    lobbyId = null;
    isOwner = false;
    members = [];
    lastMembersKey = '';
    emit('lobby-left', { lobbyId: previous });
    return { ok: true, lobbyId: previous };
  }

  /** 一键邀请：把好友拉进当前大厅，Steam 会给他弹邀请。 */
  function invite(steamId) {
    const target = String(steamId || '').trim();
    if (!target) return { ok: false, reason: '缺少 SteamID' };
    if (!lobbyId) return { ok: false, reason: '还没有创建房间，先启动一次房主桥接' };
    if (!matchmaking) return { ok: false, reason: 'Steam 尚未就绪' };
    try {
      const ok = Boolean(matchmaking.inviteUserToLobby(lobbyId, target));
      if (!ok) lastError = 'Steam 拒绝了这次邀请（对方可能不在好友列表、或当前离线）';
      emit('invited', { steamId: target, name: memberName(target), ok, lobbyId });
      return { ok, reason: ok ? null : lastError };
    } catch (err) {
      const reason = String(err && err.message ? err.message : err);
      lastError = reason;
      emit('invited', { steamId: target, ok: false, reason });
      return { ok: false, reason };
    }
  }

  /** 好友列表（只列真正的好友关系，带在线状态与在玩什么）。 */
  async function listFriends() {
    await attach();
    try {
      const all = friends.getAllFriends?.() || [];
      friendCache = all
        .filter((f) => Number(f.relationship) === RELATIONSHIP_FRIEND)
        .map((f) => {
          let game = null;
          try {
            const info = friends.getFriendGamePlayed?.(f.steamId);
            if (info && (info.gameId || info.steamIDLobby)) {
              game = {
                gameId: info.gameId ? String(info.gameId) : null,
                lobbyId: info.steamIDLobby && String(info.steamIDLobby) !== '0' ? String(info.steamIDLobby) : null,
              };
            }
          } catch { /* 取不到在玩什么不影响列表 */ }
          return {
            steamId: String(f.steamId),
            name: f.personaName && f.personaName !== '[unknown]' ? f.personaName : String(f.steamId),
            state: Number(f.personaState) || 0,
            stateName: STATE_NAMES[Number(f.personaState)] || '未知',
            online: Number(f.personaState) > 0 && Number(f.personaState) !== 7,
            game,
            inOurLobby: Boolean(game && game.lobbyId && lobbyId && game.lobbyId === lobbyId),
          };
        })
        .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, 'zh-Hans-CN'));
      emit('friends', { friends: friendCache });
      return friendCache;
    } catch (err) {
      const reason = String(err && err.message ? err.message : err);
      lastError = reason;
      emit('error', { stage: 'friends', reason });
      return [];
    }
  }

  /**
   * Steam 用 `+connect_lobby <id>` 启动我们时，读出要加入的大厅 ID。
   * 优先问 SDK；SDK 还没 attach（或 init 失败）时退化为自己解析命令行，
   * 这样即使 Steam 环境有问题，也能把「有人邀请你」这件事显示出来。
   */
  function connectLobbyFromCommandLine(argv = process.argv) {
    try {
      const fromSdk = matchmaking?.getConnectLobbyIdFromCommandLine?.();
      if (fromSdk) return String(fromSdk);
    } catch { /* 继续看命令行 */ }
    const list = Array.isArray(argv) ? argv : [];
    const index = list.findIndex((a) => a === '+connect_lobby' || a === '+connect');
    const value = index >= 0 ? list[index + 1] : null;
    return value && /^\d+$/.test(String(value)) ? String(value) : null;
  }

  /** 取走待处理的加入请求（界面起来后主动拉一次）。 */
  function takePendingJoin() {
    const value = pendingJoin;
    pendingJoin = null;
    return value;
  }

  function snapshot() {
    return {
      attached: Boolean(steam),
      ready: Boolean(steam && matchmaking),
      steamId: own.steamId,
      name: own.name,
      appId,
      lobbyId,
      isOwner,
      joinable: Boolean(lobbyId),
      members: members.length ? members : readMembersForSnapshot(),
      host: readHostInfo(),
      friends: friendCache,
      pendingJoin,
      error: lastError,
    };
  }

  function readMembersForSnapshot() {
    return lobbyId ? readMembers() : [];
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    stopLoops();
    try { offJoinRequested?.(); } catch { /* ignore */ }
    offJoinRequested = null;
    leave();
    try { steam?.shutdown?.(); } catch { /* 由调用方决定是否关闭 Steam */ }
    emit('stopped', {});
  }

  return {
    attach,
    create,
    join,
    leave,
    invite,
    listFriends,
    connectLobbyFromCommandLine,
    takePendingJoin,
    snapshot,
    stop,
    get lobbyId() { return lobbyId; },
    get isOwner() { return isOwner; },
  };
}

module.exports = {
  createLobbyManager,
  DATA_KEYS,
  PROTO_TAG,
  LOBBY_TYPES,
  STATE_NAMES,
};
