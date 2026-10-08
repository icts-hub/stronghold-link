'use strict';
// 只读探针：用**真实 Steam**（不是假 SDK）确认 0.14.0 那一层「Relay 感知」里的
// 两个 API 到底存不存在、返回值长什么样。
//
// 为什么必须单独跑这一趟：`network/relay-status.cjs` 与它在
// `network/steam-adapter.cjs` 里的接线（Phase 7）全部只跑在注入的假 SDK 上，
// 真机上 `getRelayNetworkStatus()` 的形状**没有被确认过**。如果真实 binding
// 里没有这个方法，Relay 一行会恒报 UNKNOWN、relayReady 恒 false —— 隧道本身
// 不受影响，但界面上「Relay 可用」那一栏会一直是「—」，日志里也永远看不出
// 「到底是校园网把中继挡了，还是我们根本没去问」。
//
// 本探针验证四件事：
//   1) networkingUtils.initRelayNetworkAccess / getRelayNetworkStatus 是否真的存在
//   2) 首次 getRelayNetworkStatus() 的**原始返回对象**长什么样（键名逐个打印）
//   3) 持续轮询若干秒，availability 真的会从 Waiting/Attempting 走到 Current 吗
//   4) relay-status.cjs 的 AVAILABILITY 枚举与真实返回的数值是否逐值对得上
//
// 用法：node tools\steam-relay-probe.cjs [观察秒数] [appId]

const path = require('node:path');
const fs = require('node:fs');

const { initSteamSdk } = require('../network/steam-adapter.cjs');
const relayStatus = require('../network/relay-status.cjs');

const seconds = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 15;
const appId = Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 480;
const appDir = path.join(__dirname, '..');

const out = { steps: [] };
const note = (name, value) => {
  out.steps.push({ name, value });
  console.log(`[relay] ${name}: ${JSON.stringify(value)}`);
};
const save = (extra = {}) => {
  Object.assign(out, extra);
  try {
    fs.writeFileSync(path.join(__dirname, 'steam-relay-result.json'), JSON.stringify(out, null, 2), 'utf8');
  } catch { /* 写不进去也不能影响结论 */ }
  console.log('RESULT ' + JSON.stringify({ ok: out.ok, steps: out.steps.length }));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const init = initSteamSdk({ appDir, appId });
  const steam = init.steam;
  note('steam-init', { injected: init.injected, appId, steamId: steam.localplayer ? steam.localplayer.getSteamId() : null });

  const utils = steam.networkingUtils;
  note('networkingUtils', {
    hasUtils: Boolean(utils),
    initRelayNetworkAccess: typeof (utils && utils.initRelayNetworkAccess),
    getRelayNetworkStatus: typeof (utils && utils.getRelayNetworkStatus),
  });

  if (!utils || typeof utils.getRelayNetworkStatus !== 'function') {
    note('verdict', '真实 binding 里没有 getRelayNetworkStatus —— relay-status.cjs 会恒报 UNKNOWN');
    save({ ok: false });
    process.exit(3);
  }

  // 首次原始返回：键名逐个列出来，别猜字段。
  let first = null;
  try {
    first = utils.getRelayNetworkStatus();
  } catch (err) {
    note('first-call-error', String(err && err.message ? err.message : err));
  }
  note('first-raw', first ? { keys: Object.keys(first), value: first } : null);

  // initRelayNetworkAccess 必须在问状态之前调过；initSteamSdk 里已经调了一次。
  if (typeof utils.initRelayNetworkAccess === 'function') utils.initRelayNetworkAccess();

  const transitions = [];
  const monitor = relayStatus.createRelayStatusMonitor({
    netUtils: utils,
    onEvent: (type, payload) => {
      if (type === 'relay-status') transitions.push(payload);
    },
  });
  monitor.init();

  const deadline = Date.now() + seconds * 1000;
  let lastValue = null;
  let pumped = 0;
  while (Date.now() < deadline) {
    // 必须跟着泵回调：真实适配器每轮都调 steam.runCallbacks()（steam-adapter.cjs:199）。
    // 不泵的话 Steam 的中继网络测量根本不推进，状态会永远停在 Waiting —— 那是探针的错，
    // 不是应用的错。
    try { steam.runCallbacks?.(); } catch { /* 泵不动也要继续观察 */ }
    pumped += 1;
    monitor.poll();
    const snap = monitor.snapshot();
    if (snap.availability !== lastValue) {
      lastValue = snap.availability;
      note('availability', { value: snap.availability, name: relayStatus.describeAvailability(snap.availability), ready: snap.ready, pumped });
    }
    if (snap.ready) break;
    await wait(500);
  }
  note('pumped', pumped);

  const snap = monitor.snapshot();
  note('final', {
    availability: snap.availability,
    name: relayStatus.describeAvailability(snap.availability),
    ready: snap.ready,
    everReady: snap.everReady,
    transitions: transitions.length,
    canOpenNewConnection: monitor.canOpenNewConnection(),
    initError: snap.initError || '',
    pollErrors: monitor.stats().pollErrors,
  });

  // 逐值核对：真实返回的 availability 必须落在 relay-status.cjs 认得的枚举里。
  const known = Object.values(relayStatus.AVAILABILITY);
  note('enum-match', {
    value: snap.availability,
    inOurEnum: known.includes(Number(snap.availability)),
    ourEnum: relayStatus.AVAILABILITY,
  });

  save({ ok: snap.availability !== null && snap.availability !== undefined });
  process.exit(0);
})().catch((err) => {
  out.error = String(err && err.stack ? err.stack : err).slice(0, 1200);
  console.error('[relay] failed', out.error);
  save({ ok: false });
  process.exit(1);
});
