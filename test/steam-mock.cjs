'use strict';
// 假 SDK（仅用于测试我们的桥接逻辑）：实现 steamworks-ffi-node 里我们用到的那部分 API。
// 注意：这不是真实 Steam——真实 Steam P2P 需要 Steamworks SDK redistributable，无法随包分发。
//
// 支持多条并发连接（connectP2P 每次返回新的句柄），这样才能验证「通用内网穿透」需要的多路复用。

const LISTEN = 11;
const POLL = 22;
const FIRST_CONNECTION = 101;
const HOST_STEAM_ID = '76561198000000001';
const STATE = { Connecting: 1, Connected: 3, ClosedByPeer: 4, ProblemDetectedLocally: 5 };

function createMockSdk({ identity = HOST_STEAM_ID } = {}) {
  const handlers = [];
  const clientQueues = new Map(); // connection -> [messages]
  let nextConnection = FIRST_CONNECTION;
  const state = {
    accepted: [],
    pollGroups: [],
    sent: [],            // { connection, data }
    closed: [],          // { connection, reason, message }
    pollQueue: [],
    active: new Set(),
    listenClosed: false,
    pollDestroyed: false,
    callbacks: 0,
    identity,
    connectedTo: [],     // { steamId, port, handle }
    clientQueues,
  };
  const sockets = {
    createListenSocketP2P: () => LISTEN,
    createPollGroup: () => POLL,
    onConnectionStateChange: (handler) => { handlers.push(handler); return () => { handlers.length = 0; }; },
    acceptConnection: (connection) => { state.accepted.push(connection); state.active.add(connection); return 0; },
    setConnectionPollGroup: (connection, group) => { state.pollGroups.push({ connection, group }); return true; },
    receiveMessagesOnPollGroup: (group, max) => state.pollQueue.splice(0, max),
    receiveMessages: (connection, max) => (clientQueues.get(connection) || []).splice(0, max),
    sendMessage: (connection, data, flags) => {
    state.sent.push({ connection, data: Buffer.from(data), flags, via: 'sendMessage' });
    return { success: true, result: 1 };
  },
  sendReliable: (connection, data) => { state.sent.push({ connection, data: Buffer.from(data) }); return { success: true, result: 1, messageNumber: BigInt(state.sent.length) }; },
    isConnectionActive: (connection) => state.active.has(connection),
    closeConnection: (connection, reason, message, linger) => { state.closed.push({ connection, reason, message, linger }); state.active.delete(connection); return true; },
    closeListenSocket: () => { state.listenClosed = true; return true; },
    destroyPollGroup: () => { state.pollDestroyed = true; return true; },
    getIdentity: () => identity,
    connectP2P: (steamId, port) => {
      const handle = nextConnection;
      nextConnection += 1;
      state.connectedTo.push({ steamId, port, handle });
      state.active.add(handle);
      clientQueues.set(handle, []);
      return handle;
    },
    getConnectionInfo: () => ({ identityRemote: identity, state: 3, endDebugMessage: '' }),
    initAuthentication: () => 0,
  };
  // ---- 全局网络参数（network/steam-netconfig.cjs）：把真正下发的每一对 (valueId, value) 记下来 ----
  // 桩必须应答这两个符号，否则 applyNetConfig 会判定"这套 SDK 没有网络参数接口"，
  // 线路档位就无从观察。真名是 SetGlobalConfigValueInt32（_SetConfigValueInt32 在 DLL 里不存在）。
  state.configSets = [];
  const configLibrary = {
    func(name) {
      if (name === 'SteamAPI_ISteamNetworkingUtils_SetGlobalConfigValueInt32') {
        return (...args) => {
          const valueId = args[1];
          let value = args[2];
          if (args.length >= 6 && Buffer.isBuffer(args[5])) value = args[5].readInt32LE(0);
          state.configSets.push({ valueId, value });
          return true;
        };
      }
      if (name === 'SteamAPI_ISteamNetworkingUtils_GetConfigValue') {
        return (iface, valueId, scope, scopeObj, dataType, result, cbResult) => {
          const last = state.configSets.filter((s) => s.valueId === valueId).pop();
          dataType.writeInt32LE(1, 0);
          result.writeInt32LE(last ? last.value : 0, 0);
          if (cbResult) cbResult.writeBigUInt64LE(8n, 0);
          return 1;
        };
      }
      throw new Error('unexpected symbol ' + name);
    },
  };
  const sdk = {
    runCallbacks: () => { state.callbacks += 1; },
    networkingSockets: sockets,
    networkingUtils: {
      initRelayNetworkAccess: () => {},
      libraryLoader: {
        SteamAPI_SteamNetworkingUtils_SteamAPI: () => ({ __iface: true }),
        getLibrary: () => configLibrary,
      },
    },
    init: () => true,
    shutdown: () => {},
    setDebug: () => {},
    setSdkPath: () => {},
    getStatus: () => ({ steamId: identity }),
  };
  state.emitState = (change) => { for (const handler of handlers) handler(change); };

  // ---- 大厅（matchmaking）与好友（friends）：给 network/steam-lobby.cjs 的测试用 ----
  const lobbies = new Map(); // lobbyId -> { owner, members: [], data: Map, max, joinable }
  let nextLobbyId = 109775242000000001n;
  const lobby = {
    lobbies,
    created: [],
    joined: [],
    left: [],
    invited: [],
    dataWrites: [],
    inviteResult: true,
    joinResult: true,
    createResult: true,
    cmdLobbyId: null,
    joinRequestHandlers: [],
  };
  const findLobby = (id) => lobbies.get(String(id)) || null;

  sdk.matchmaking = {
    createLobby: async (type, maxMembers) => {
      lobby.created.push({ type, maxMembers });
      if (!lobby.createResult) return { success: false, response: 3 };
      const id = String(nextLobbyId);
      nextLobbyId += 1n;
      lobbies.set(id, { owner: identity, members: [identity], data: new Map(), max: maxMembers, joinable: true });
      return { success: true, lobbyId: id, response: 1 };
    },
    joinLobby: async (id) => {
      lobby.joined.push(String(id));
      const target = findLobby(id);
      if (!lobby.joinResult || !target) return { success: false, response: 2 };
      if (!target.members.includes(identity)) target.members.push(identity);
      return { success: true, response: 1 };
    },
    leaveLobby: (id) => {
      lobby.left.push(String(id));
      const target = findLobby(id);
      if (target) target.members = target.members.filter((m) => m !== identity);
    },
    inviteUserToLobby: (id, steamId) => {
      lobby.invited.push({ lobbyId: String(id), steamId: String(steamId) });
      return lobby.inviteResult;
    },
    onGameLobbyJoinRequested: (handler) => {
      lobby.joinRequestHandlers.push(handler);
      return () => { lobby.joinRequestHandlers = lobby.joinRequestHandlers.filter((h) => h !== handler); };
    },
    getConnectLobbyIdFromCommandLine: () => lobby.cmdLobbyId,
    setLobbyData: (id, key, value) => {
      lobby.dataWrites.push({ lobbyId: String(id), key, value: String(value) });
      const target = findLobby(id);
      if (target) target.data.set(key, String(value));
      return true;
    },
    getLobbyData: (id, key) => { const target = findLobby(id); return target ? (target.data.get(key) || '') : ''; },
    getAllLobbyData: (id) => { const target = findLobby(id); return target ? Object.fromEntries(target.data) : {}; },
    getLobbyDataCount: (id) => { const target = findLobby(id); return target ? target.data.size : 0; },
    getLobbyMembers: (id) => { const target = findLobby(id); return target ? [...target.members] : []; },
    getNumLobbyMembers: (id) => { const target = findLobby(id); return target ? target.members.length : 0; },
    getLobbyOwner: (id) => { const target = findLobby(id); return target ? target.owner : ''; },
    getLobbyMemberLimit: (id) => { const target = findLobby(id); return target ? target.max : 0; },
    setLobbyJoinable: (id, joinable) => { const target = findLobby(id); if (target) target.joinable = joinable; return true; },
    requestLobbyData: () => true,
    pollChatMessages: () => 0,
    onChatMessage: () => () => {},
    getPendingChatMessages: () => [],
  };

  const friendList = [];
  const friendGames = new Map();
  sdk.friends = {
    getPersonaName: () => '测试用户',
    getPersonaState: () => 1,
    getAllFriends: () => friendList.map((f) => ({ ...f })),
    getFriendPersonaName: (steamId) => {
      const hit = friendList.find((f) => f.steamId === String(steamId));
      return hit ? hit.personaName : '[unknown]';
    },
    getFriendGamePlayed: (steamId) => friendGames.get(String(steamId)) || null,
  };

  state.lobby = lobby;
  state.friendList = friendList;
  state.friendGames = friendGames;
  /** 往好友列表里塞一个人。 */
  state.addFriend = (steamId, personaName, personaState = 1, relationship = 3) => {
    friendList.push({ steamId: String(steamId), personaName, personaState, relationship });
  };
  /** 让某个好友处于某个大厅（用于 inOurLobby 判断）。 */
  state.setFriendLobby = (steamId, lobbyId) => {
    friendGames.set(String(steamId), { gameId: '480', gameIP: 0, gamePort: 0, queryPort: 0, steamIDLobby: String(lobbyId) });
  };
  /** 往大厅里加一个成员（模拟好友进房）。 */
  state.addLobbyMember = (lobbyId, steamId) => {
    const target = findLobby(lobbyId);
    if (target && !target.members.includes(String(steamId))) target.members.push(String(steamId));
  };
  /** 触发「好友点了加入游戏」。 */
  state.emitJoinRequested = ({ lobbyId, friendSteamId }) => {
    for (const handler of lobby.joinRequestHandlers) handler({ lobbyId: String(lobbyId), friendSteamId: String(friendSteamId) });
  };

  /** 向某个 Steam 连接「投递」一条来自对端的消息。 */
  state.pushToClient = (connection, data) => {
    const queue = clientQueues.get(connection) || [];
    queue.push({ connection, data: Buffer.from(data) });
    clientQueues.set(connection, queue);
  };
  /** 向房主侧的 poll 队列投递一条来自某个对端的消息。 */
  state.pushToHost = (connection, data) => {
    state.pollQueue.push({ connection, data: Buffer.from(data) });
  };
  return { sdk, sockets, state };
}

module.exports = { createMockSdk, LISTEN, POLL, FIRST_CONNECTION, HOST_STEAM_ID, STATE };
