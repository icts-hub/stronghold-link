'use strict';
// 一次性探针：验证真实 Steam SDK 能否初始化（缺 DLL 时该调用会直接终止进程，所以用独立进程跑）
const path = require('node:path');
const fs = require('node:fs');

const result = { step: 'start' };
function report(extra = {}) {
  Object.assign(result, extra);
  try { fs.writeFileSync(path.join(__dirname, 'steam-probe-result.json'), JSON.stringify(result, null, 2), 'utf8'); } catch { /* ignore */ }
  console.log('RESULT ' + JSON.stringify(result));
}

(async () => {
  const sdkRoot = path.resolve(__dirname, '..', 'steamworks_sdk');
  const dllPath = path.join(sdkRoot, 'redistributable_bin', 'win64', 'steam_api64.dll');
  result.dllExists = fs.existsSync(dllPath);
  result.dllSize = result.dllExists ? fs.statSync(dllPath).size : 0;
  if (!result.dllExists) return report({ step: 'no-dll', ok: false });

  let mod;
  try {
    mod = require('steamworks-ffi-node');
  } catch (err) {
    return report({ step: 'module-missing', ok: false, error: err.message });
  }
  const SDK = mod.default || mod.SteamworksSDK;
  const steam = SDK.getInstance();
  if (typeof steam.setDebug === 'function') steam.setDebug(true);
  if (typeof steam.setSdkPath === 'function') steam.setSdkPath(sdkRoot);
  result.step = 'init';
  let ok = false;
  try {
    ok = steam.init({ appId: 480 });
  } catch (err) {
    return report({ step: 'init-threw', ok: false, error: String(err && err.message ? err.message : err).slice(0, 300) });
  }
  result.initOk = Boolean(ok);
  if (!ok) return report({ step: 'init-failed', ok: false });

  try {
    if (steam.networkingUtils?.initRelayNetworkAccess) steam.networkingUtils.initRelayNetworkAccess();
    if (steam.networkingSockets?.initAuthentication) steam.networkingSockets.initAuthentication();
    for (let i = 0; i < 40; i += 1) {
      steam.runCallbacks?.();
      steam.networkingSockets?.runCallbacks?.();
      await new Promise((r) => setTimeout(r, 50));
    }
    result.identity = steam.networkingSockets?.getIdentity?.() || null;
    const status = steam.getStatus?.() || {};
    result.status = { steamId: status.steamId || null, userName: status.userName || status.personaName || null, appId: status.appId || null };
    const relay = steam.networkingUtils?.getRelayNetworkStatus?.();
    result.relay = relay ? { availability: relay.availability, name: relay.availabilityName, debug: String(relay.debugMessage || '').slice(0, 120) } : null;
    result.step = 'ready';
    report({ ok: Boolean(result.identity) });
  } catch (err) {
    report({ step: 'post-init-error', ok: false, error: String(err && err.message ? err.message : err).slice(0, 300) });
  } finally {
    try { steam.shutdown(); } catch { /* ignore */ }
  }
  process.exit(0);
})();
