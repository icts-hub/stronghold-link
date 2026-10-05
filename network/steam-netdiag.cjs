'use strict';
// ============================================================================
// Stronghold Link — Steam 中继网络诊断
//
// 回答一个具体问题：**这台机器到 Steam 中继网络是什么状况、该走哪个 POP。**
// 用到的都是没有对端也能测的接口，因此本机就能拿到真实数字：
//   initRelayNetworkAccess / getRelayNetworkStatus / getLocalPingLocation
//   getPOPList / getPingToDataCenter / getDirectPingToPOP
//
// 原则：测不到就是 null + 原因，不填估算值、不填示例数字。
// ============================================================================

const { initSteamSdk } = require('./steam-adapter.cjs');

const DEFAULT_MAX_POPS = 12;
const DEFAULT_WAIT_MS = 2000;

/** 兼容绑定可能返回 number 或对象两种形状。 */
function readPing(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (value && typeof value === 'object') {
    for (const key of ['pingMs', 'ping', 'viaRelayPing', 'relayPing', 'directPing']) {
      const n = Number(value[key]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

/**
 * @param {object} options
 * @param {string} options.appDir
 * @param {number} [options.appId]
 * @param {object} [options.sdk]          注入的 SDK（测试用）
 * @param {object} [options.steamModule]  注入的模块（测试用）
 * @param {number} [options.maxPops]
 * @param {number} [options.waitMs]       等待 ping 测量完成的上限
 * @param {Function} [options.now]
 */
function createSteamNetworkDiagnostics({
  appDir,
  appId = null,
  sdk = null,
  steamModule = null,
  maxPops = DEFAULT_MAX_POPS,
  waitMs = DEFAULT_WAIT_MS,
  waitForReadyMs = 0,
  now = Date.now,
} = {}) {
  function utils() {
    let instance = sdk;
    if (!instance) {
      const init = initSteamSdk({ appDir, appId, sdk: null, steamModule });
      instance = init.steam;
    }
    return instance && instance.networkingUtils ? instance.networkingUtils : null;
  }

  function relayStatus(u) {
    try {
      const status = u.getRelayNetworkStatus ? u.getRelayNetworkStatus() : null;
      if (!status) return null;
      return {
        availability: status.availability === undefined ? null : status.availability,
        availabilityName: status.availabilityName || null,
        measuring: Boolean(status.pingMeasurementInProgress),
        networkConfigAvailability: status.networkConfigAvailability === undefined ? null : status.networkConfigAvailability,
      };
    } catch (err) {
      return null;
    }
  }

  function localLocation(u) {
    try {
      const loc = u.getLocalPingLocation ? u.getLocalPingLocation() : null;
      if (!loc) return null;
      return { locationString: loc.locationString || null, dataAge: Number.isFinite(loc.dataAge) ? loc.dataAge : null };
    } catch (err) {
      return null;
    }
  }

  function popList(u) {
    let raw = [];
    try {
      raw = (u.getPOPList ? u.getPOPList() : []) || [];
    } catch (err) {
      raw = [];
    }
    const pops = raw.map((pop) => {
      const id = pop && pop.popId !== undefined ? pop.popId : null;
      let direct = null;
      try {
        if (id !== null && u.getDirectPingToPOP) direct = readPing(u.getDirectPingToPOP(id));
      } catch (err) {
        direct = null;
      }
      let viaDataCenter = null;
      try {
        if (id !== null && u.getPingToDataCenter) viaDataCenter = readPing(u.getPingToDataCenter(id));
      } catch (err) {
        viaDataCenter = null;
      }
      return {
        code: (pop && pop.popCode) || null,
        id,
        pingViaRelay: readPing(pop && pop.pingViaRelay),
        pingToDataCenter: viaDataCenter,
        directPing: direct,
      };
    });
    // 按“到该 POP 的实测延迟”排序；测不到的排在最后（不是排最前）
    pops.sort((a, b) => {
      const av = a.pingViaRelay === null ? Number.POSITIVE_INFINITY : a.pingViaRelay;
      const bv = b.pingViaRelay === null ? Number.POSITIVE_INFINITY : b.pingViaRelay;
      return av - bv;
    });
    return pops.slice(0, Math.max(1, maxPops));
  }

  const NOT_READY = new Set(['Waiting', 'Retrying', 'NeverTried']);

  /** 中继网络是否就绪（Waiting / Retrying 都算没就绪 —— 此时读 POP 只会得到空列表）。 */
  function isReady(status) {
    if (!status) return false;
    if (status.measuring) return false;
    if (status.availabilityName && NOT_READY.has(status.availabilityName)) return false;
    return true;
  }

  /** 采集一次。测不到就如实说明原因，绝不填占位数字。 */
  async function collect() {
    const u = utils();
    if (!u) {
      return {
        available: false,
        reason: 'Steam 环境不可用（缺少 SDK 或未登录），无法读取中继网络状态',
        ready: false,
        waitedMs: 0,
        hint: null,
        relay: null,
        local: null,
        pops: [],
        popCount: 0,
        measuredAt: now(),
        notes: [],
      };
    }
    const notes = [];
    try {
      if (u.initRelayNetworkAccess) u.initRelayNetworkAccess();
    } catch (err) {
      notes.push('initRelayNetworkAccess 调用失败：' + (err && err.message ? err.message : String(err)));
    }

    // 等 ping 测量结束（有上限；到点没结束就如实标注 measuring）
    let status = relayStatus(u);
    const started = now();
    const budget = Math.max(waitMs, waitForReadyMs);
    while (status && !isReady(status) && now() - started < budget) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      status = relayStatus(u);
    }
    const waitedMs = now() - started;
    const ready = isReady(status);
    if (status && status.measuring) notes.push('ping 测量仍在进行，延迟数据可能不完整');
    if (!ready) {
      notes.push('Steam 中继网络未就绪（' + ((status && status.availabilityName) || '未知') + '）：'
        + '需要 Steam 客户端处于在线状态并完成中继网络预热，之后才能读到各 POP 的延迟。');
    }

    const pops = popList(u);
    const popCount = (() => {
      try {
        return Number(u.getPOPCount ? u.getPOPCount() : pops.length) || pops.length;
      } catch (err) {
        return pops.length;
      }
    })();
    if (!pops.length) notes.push('没有读到 POP 列表（中继网络可能尚未初始化完成）');

    return {
      available: true,
      reason: null,
      ready,
      waitedMs,
      hint: ready ? null : '中继网络未就绪：延迟数据不可用，请确认 Steam 客户端在线后重试',
      relay: status,
      local: localLocation(u),
      pops,
      popCount,
      measuredAt: now(),
      notes,
    };
  }

  return { collect };
}

module.exports = { DEFAULT_MAX_POPS, DEFAULT_WAIT_MS, readPing, createSteamNetworkDiagnostics };
