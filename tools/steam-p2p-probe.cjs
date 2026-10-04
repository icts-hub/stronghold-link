'use strict';
// 真实 Steam P2P 回环探针：用本机 Steam 账号连自己，验证 listen socket / accept / 收发 是否真的能用。
// 独立进程运行（缺 SDK 时 SteamAPI_Init 会终止进程，不能放在应用主进程里试）。
const path = require('node:path');
const fs = require('node:fs');

const out = { steps: [] };
const note = (name, value) => { out.steps.push({ name, value }); console.log(`[steam-p2p] ${name}: ${JSON.stringify(value)}`); };
const save = (extra = {}) => {
  Object.assign(out, extra);
  try { fs.writeFileSync(path.join(__dirname, 'steam-p2p-result.json'), JSON.stringify(out, null, 2), 'utf8'); } catch { /* ignore */ }
  console.log('RESULT ' + JSON.stringify(out));
};

(async () => {
  const mod = require('steamworks-ffi-node');
  const SDK = mod.default || mod.SteamworksSDK;
  const { ESteamNetworkingConnectionState, k_HSteamNetConnection_Invalid, k_HSteamListenSocket_Invalid } = mod;
  const steam = SDK.getInstance();
  if (typeof steam.setSdkPath === 'function') steam.setSdkPath(path.resolve(__dirname, '..', 'steamworks_sdk'));
  if (typeof steam.setDebug === 'function') steam.setDebug(false);
  if (!steam.init({ appId: 480 })) return save({ ok: false, error: 'init failed' });

  const sockets = steam.networkingSockets;
  const ownId = steam.getStatus?.().steamId || sockets.getIdentity?.();
  note('steamId', ownId);

  steam.networkingUtils?.initRelayNetworkAccess?.();
  sockets.initAuthentication?.();

  const tick = () => { try { steam.runCallbacks(); } catch {} try { sockets.runCallbacks(); } catch {} };

  // 等 Steam Relay 就绪（Current = 100）
  let relay = null;
  for (let i = 0; i < 120; i += 1) {
    tick();
    relay = steam.networkingUtils?.getRelayNetworkStatus?.() || null;
    if (relay && Number(relay.availability) === 100) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  note('relay', relay ? { availability: relay.availability, name: relay.availabilityName } : null);

  const listenSocket = sockets.createListenSocketP2P(0);
  note('listenSocket', listenSocket);
  if (listenSocket === k_HSteamListenSocket_Invalid) return save({ ok: false, error: 'createListenSocketP2P failed' });
  const pollGroup = sockets.createPollGroup();
  note('pollGroup', pollGroup);
  if (!pollGroup) return save({ ok: false, error: 'createPollGroup failed' });

  const accepted = [];
  const received = [];
  let sentOk = false;
  let connected = false;

  const off = sockets.onConnectionStateChange((change) => {
    note('state', { connection: change.connection, old: change.oldState, next: change.newState, info: change.info?.stateName || '' });
    if (change.newState === ESteamNetworkingConnectionState.Connecting) {
      const r = sockets.acceptConnection(change.connection);
      accepted.push({ connection: change.connection, result: r });
      if (pollGroup) sockets.setConnectionPollGroup(change.connection, pollGroup);
      return;
    }
    if (change.newState === ESteamNetworkingConnectionState.Connected) {
      connected = true;
      const result = sockets.sendReliable(change.connection, Buffer.from('shl-steam-ping'));
      sentOk = Boolean(result && result.success);
      note('send', { success: sentOk });
    }
  });

  const connection = sockets.connectP2P(String(ownId), 0);
  note('connectP2P', { connection, selfConnect: true });
  if (connection === k_HSteamNetConnection_Invalid) return save({ ok: false, error: 'connectP2P failed' });

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    tick();
    const messages = pollGroup ? (sockets.receiveMessagesOnPollGroup(pollGroup, 32) || []) : [];
    for (const message of messages) {
      const text = Buffer.isBuffer(message.data) ? message.data.toString('utf8') : String(message.data);
      received.push(text);
      note('received', text);
    }
    const direct = sockets.receiveMessages?.(connection, 32) || [];
    for (const message of direct) {
      const text = Buffer.isBuffer(message.data) ? message.data.toString('utf8') : String(message.data);
      received.push(text);
      note('received-direct', text);
    }
    if (received.length > 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  note('summary', { connected, acceptedCount: accepted.length, sentOk, received });
  try { off?.(); } catch {}
  try { sockets.closeConnection(connection, 0, 'probe done', false); } catch {}
  try { sockets.closeListenSocket(listenSocket); } catch {}
  try { sockets.destroyPollGroup(pollGroup); } catch {}
  try { steam.shutdown(); } catch {}
  save({ ok: connected && received.length > 0 });
  process.exit(0);
})().catch((err) => {
  save({ ok: false, error: String(err && err.stack ? err.stack : err).slice(0, 500) });
  process.exit(1);
});
