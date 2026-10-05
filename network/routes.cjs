'use strict';
// ============================================================================
// Stronghold Link — 路由候选清单（界面与 RouteManager 共用）
//
// 把「有哪些路可走」与「这条路现在测得怎么样」拼成一份可展示的清单：
//   * 能力来自 Provider 注册表（谁支持不可靠、谁自带穿透、是否需要端口可达）；
//   * 分数来自 PHASE 5 的评分器；
//   * **测不到就如实标未测量**，并给出"为什么测不到"（需要真实对端 / 两台机器 / 未部署）。
//
// 这份清单是纯数据，不碰网络，便于单测与在界面直接渲染。
// ============================================================================

const { scoreQuality, rankCandidates } = require('./route/score.cjs');

/** 各候选"为什么现在测不到"的说明（本机条件下的事实，不是推测）。 */
const UNMEASURED_REASONS = Object.freeze({
  'local-tcp-host': '本地中继按端口转发，没有包级往返可测；速率与字节数来自真实计数',
  'local-tcp-joiner': '本地中继按端口转发，没有包级往返可测；速率与字节数来自真实计数',
  'local-udp-host': '本地中继按端口转发，没有包级往返可测；速率与字节数来自真实计数',
  'local-udp-joiner': '本地中继按端口转发，没有包级往返可测；速率与字节数来自真实计数',
  'steam-p2p-host': '需要真实对端连接才能读延迟；本机单账号无法构造',
  'steam-p2p-joiner': '需要真实对端连接才能读延迟；本机单账号无法构造',
  'direct-udp-host': '打洞需要两台机器；本机自打洞受 NAT 回环限制',
  'direct-udp-joiner': '打洞需要两台机器；本机自打洞受 NAT 回环限制',
  'sl-relay-host': '点 RELAY SELF-TEST 可本机实测（回环）',
  'sl-relay-joiner': '点 RELAY SELF-TEST 可本机实测（回环）',
});

/**
 * @param {object} options
 * @param {Array}  options.providers      [{ id, name, kind, available, unavailableReason, capabilities }]
 * @param {object} [options.qualityById]  id → 质量快照（真实测量结果，没有就是没测）
 * @param {object} [options.reliabilityById]
 */
const NAT_HINTS = Object.freeze({
  'endpoint-independent': '本机 NAT 实测为端点无关（打洞通常可行）',
  'address-dependent': '本机 NAT 实测为地址相关（对称倾向，打洞成功率低，建议走中继）',
  'multiple-exits': '本机为多出口网络（打洞基本不可行）',
  unknown: '本机 NAT 行为未测得',
});

function describeRouteCandidates({ providers = [], qualityById = {}, reliabilityById = {}, natMapping = null } = {}) {
  const entries = providers.map((p) => ({
    id: p.id,
    name: p.name || p.id,
    kind: p.kind || null,
    available: p.available !== false,
    unavailableReason: p.unavailableReason || null,
    capabilities: {
      transports: (p.capabilities && p.capabilities.transports) || [],
      reliable: Boolean(p.capabilities && p.capabilities.reliable),
      unreliable: Boolean(p.capabilities && p.capabilities.unreliable),
      p2p: Boolean(p.capabilities && p.capabilities.p2p),
      natTraversal: Boolean(p.capabilities && p.capabilities.natTraversal),
      encryption: (p.capabilities && p.capabilities.encryption) || 'none',
      requiresReachablePort: Boolean(p.capabilities && p.capabilities.requiresReachablePort),
    },
    quality: qualityById[p.id] || null,
    reliability: reliabilityById[p.id] === undefined ? null : reliabilityById[p.id],
  }));

  const ranked = rankCandidates(
    entries.map((e) => ({ id: e.id, name: e.name, quality: e.quality, reliability: e.reliability })),
  );
  const byId = new Map(ranked.map((r) => [r.id, r]));

  const candidates = entries.map((e) => {
    const scored = byId.get(e.id) || { score: null, measured: false, reasons: ['未测量'] };
    return {
      ...e,
      score: scored.score,
      measured: scored.measured,
      reasons: scored.reasons,
      unmeasuredReason: scored.measured
        ? null
        : ((UNMEASURED_REASONS[e.id] || '本机条件下无法测量')
          + (e.kind === 'direct' && natMapping ? '；' + (NAT_HINTS[natMapping] || NAT_HINTS.unknown) : '')),
      display: scored.measured ? (scored.score + ' 分') : '未测量',
    };
  });

  // 已测量的排前面（按分数），未测量的按原顺序排在后面
  candidates.sort((a, b) => {
    const av = a.measured ? a.score : Number.NEGATIVE_INFINITY;
    const bv = b.measured ? b.score : Number.NEGATIVE_INFINITY;
    if (av === bv) return 0;
    return bv - av;
  });

  return {
    measuredCount: candidates.filter((c) => c.measured).length,
    total: candidates.length,
    candidates,
    note: '未测量的候选不是 0 分：它们只是在本机条件下测不到，需要真实对端或两台机器',
  };
}

module.exports = { UNMEASURED_REASONS, NAT_HINTS, describeRouteCandidates, scoreQuality };
