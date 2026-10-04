'use strict';
// 用「用户自己的目录 + 他自己的官方 SDK」做真实初始化验证。
// 用法：node steam-userdir-probe.cjs "D:\\Stronghold-Link-0.9.0-portable-win-x64"
const fs = require('node:fs');
const { initSteamSdk, resolveOwnSteamId } = require('../network/steam-adapter.cjs');
const { diagnoseSteam } = require('../network/steam-env.cjs');

const appDir = process.argv[2] || process.cwd();
const out = { appDir };

(async () => {
  const report = diagnoseSteam({ appDir, appId: 480 });
  out.diagnose = {
    available: report.available,
    blockers: report.blockers,
    sdkPath: report.sdk.libraryPath,
    sdkDirName: report.sdk.dirName,
    sdkNote: report.sdk.note,
    steps: report.steps.map((s) => `${s.ok ? 'OK ' : 'XX '} ${s.title}`),
  };
  console.log('诊断:', JSON.stringify(out.diagnose, null, 1));
  if (!report.available) { out.ok = false; fs.writeFileSync('steam-userdir-result.json', JSON.stringify(out, null, 2)); process.exit(1); }

  const { steam, injected } = initSteamSdk({ appDir, appId: 480 });
  out.injected = injected;
  out.initOk = true;
  try {
    for (let i = 0; i < 60; i += 1) {
      steam.runCallbacks?.();
      steam.networkingSockets?.runCallbacks?.();
      await new Promise((r) => setTimeout(r, 50));
    }
    out.steamId = resolveOwnSteamId(steam);
    const relay = steam.networkingUtils?.getRelayNetworkStatus?.();
    out.relay = relay ? { availability: relay.availability, name: relay.availabilityName } : null;
    const listen = steam.networkingSockets?.createListenSocketP2P?.(0);
    out.listenSocket = listen;
    out.ok = Boolean(out.steamId) && listen !== 0 && listen != null;
    try { steam.networkingSockets?.closeListenSocket?.(listen); } catch { /* ignore */ }
  } finally {
    try { steam.shutdown(); } catch { /* ignore */ }
  }
  fs.writeFileSync('steam-userdir-result.json', JSON.stringify(out, null, 2));
  console.log('RESULT', JSON.stringify(out));
  process.exit(out.ok ? 0 : 2);
})().catch((err) => {
  out.ok = false;
  out.error = String(err && err.stack ? err.stack : err).slice(0, 600);
  fs.writeFileSync('steam-userdir-result.json', JSON.stringify(out, null, 2));
  console.log('RESULT', JSON.stringify(out));
  process.exit(1);
});
