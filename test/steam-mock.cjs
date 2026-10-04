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
  const sdk = {
    runCallbacks: () => { state.callbacks += 1; },
    networkingSockets: sockets,
    networkingUtils: { initRelayNetworkAccess: () => {} },
    init: () => true,
    shutdown: () => {},
    setDebug: () => {},
    setSdkPath: () => {},
    getStatus: () => ({ steamId: identity }),
  };
  state.emitState = (change) => { for (const handler of handlers) handler(change); };
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
