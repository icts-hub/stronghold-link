'use strict';
// 只读探针：从 Steam 大厅里读出房主写下的信息（含 shl_version），用来判断好友那边跑的是哪个版本。
//
// 应用自己早就读了这个值（network/steam-lobby.cjs 的 readHostInfo -> matchmaking.getLobbyData(id, 'shl_version')），
// 但 electron/main.cjs 的「已读到房主信息」日志只打了 SteamID 和端口，没打版本 ——
// 所以现场出问题时无法从 startup.log 判断对端版本。这个探针就是补上这一格。
//
// 独立进程运行：应用在跑的时候 SteamAPI_Init 照样能成功（已实测），不冲突。
// 用法：node tools\lobby-version-probe.cjs [大厅ID ...]
const path = require('node:path');

const DEFAULT_IDS = ['109775244181595249', '109775244180721517'];
const LOBBY_IDS = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_IDS;
const KEYS = ['shl_proto', 'shl_host', 'shl_version', 'shl_port', 'shl_game', 'shl_room'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const mod = require('steamworks-ffi-node');
  const SDK = mod.default || mod.SteamworksSDK;
  const steam = SDK.getInstance();
  if (typeof steam.setSdkPath === 'function') steam.setSdkPath(path.resolve(__dirname, '..', 'steamworks_sdk'));
  if (typeof steam.setDebug === 'function') steam.setDebug(false);
  if (!steam.init({ appId: 480 })) { console.log('SteamAPI_Init 失败'); process.exit(1); }

  const mm = steam.matchmaking;
  console.log('本机 SteamID', String(steam.getStatus?.().steamId || ''));
  const methods = new Set();
  for (let o = mm; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const n of Object.getOwnPropertyNames(o)) if (typeof mm[n] === 'function') methods.add(n);
  }
  console.log('matchmaking 方法：' + [...methods].sort().join(', '));

  for (const id of LOBBY_IDS) {
    const lobby = /^\d+$/.test(id) ? BigInt(id) : id;
    console.log(`\n=== 大厅 ${id} ===`);
    try { mm.requestLobbyData?.(lobby); } catch (err) { console.log('  requestLobbyData 失败：' + err.message); }
    for (let i = 0; i < 8; i += 1) { try { steam.runCallbacks?.(); } catch { /* 回调里出错不影响读数据 */ } await sleep(250); }
    try { console.log('  成员数 ' + (typeof mm.getNumLobbyMembers === 'function' ? mm.getNumLobbyMembers(lobby) : '?')); } catch (err) { console.log('  成员数读取失败：' + err.message); }
    let any = false;
    for (const k of KEYS) {
      let v;
      try { v = mm.getLobbyData(lobby, k); } catch (err) { v = 'ERR ' + err.message; }
      if (v !== undefined && v !== null && v !== '') any = true;
      console.log('  ' + k.padEnd(12) + JSON.stringify(v));
    }
    if (!any) console.log('  （一个字段都读不到：大厅可能已经关了，或者 getLobbyData 需要先成为成员）');
  }
  process.exit(0);
})();
