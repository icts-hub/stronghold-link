'use strict';
// ============================================================================
// Stronghold Link — 中继自检（用于界面上的真实测量）
//
// 在本机起一个中继服务端与两个客户端，走真实 UDP 回环：
//   入会 → 互投一条消息 → 连续心跳测 RTT/抖动/丢包 → 全部关停。
//
// 这个数字是**真实测量**，但必须说清适用范围：本机回环，不代表跨公网表现。
// 因此返回值里带 scope='loopback' 与 notes，界面照抄即可，不会误导用户。
// 任何一步失败都返回 ok:false 与原因，绝不返回估算值。
// ============================================================================

const crypto = require('node:crypto');
const { createRelayServer } = require('./server.cjs');
const { createRelayClient } = require('./client.cjs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} [options]
 * @param {number} [options.pings]      心跳次数（默认 8）
 * @param {number} [options.timeoutMs]  单次心跳超时
 * @param {Function} [options.now]
 */
async function runRelaySelfTest({ pings = 8, timeoutMs = 1200, now = Date.now } = {}) {
  const started = now();
  const token = crypto.randomBytes(16).toString('hex');
  const sessionId = crypto.randomBytes(2).readUInt16BE(0) + 1;
  let server = null;
  let a = null;
  let b = null;
  const notes = [];

  try {
    server = createRelayServer({ sessionToken: token, host: '127.0.0.1', port: 0 });
    const info = await server.start();

    a = createRelayClient({ serverHost: '127.0.0.1', serverPort: info.port, sessionToken: token, sessionId });
    b = createRelayClient({ serverHost: '127.0.0.1', serverPort: info.port, sessionToken: token, sessionId });
    const joinA = await a.join({ timeoutMs: 2000 });
    const joinB = await b.join({ timeoutMs: 2000 });
    if (!joinA.ok || !joinB.ok) {
      return {
        ok: false, measured: false, scope: 'loopback',
        reason: '中继自检未通过：' + (joinA.reason || joinB.reason || '入会失败'),
        rtt: null, jitter: null, packetLoss: null, samples: 0, delivered: 0,
        elapsedMs: now() - started, notes,
      };
    }

    // 真实投递一条消息，确认转发链路可用（不是只测心跳）
    const received = [];
    b.onMessage((payload) => received.push(payload.toString()));
    a.send(Buffer.from('RELAY-SELFTEST'));
    await wait(120);
    const delivered = received.filter((t) => t === 'RELAY-SELFTEST').length;
    if (delivered === 0) notes.push('心跳可用但消息未投递到对端：请留意');

    let replies = 0;
    for (let i = 0; i < Math.max(1, pings); i += 1) {
      const out = await a.ping({ timeoutMs });
      if (out.ok) replies += 1;
      await wait(15);
    }
    const quality = a.getQuality();
    const stats = server.getStats();

    if (quality.measured) {
      notes.push('本机回环测量：数字只反映本机中继链路，不代表跨公网表现');
      notes.push('中继不加密载荷：正式会话由上层安全通道加密');
    } else {
      notes.push('未取得心跳样本：延迟数据不可用');
    }
    if (stats.dropped['rate-limited'] > 0) notes.push('自检期间触发了限速丢弃，样本可能不完整');

    return {
      ok: quality.measured && delivered > 0,
      measured: Boolean(quality.measured),
      scope: 'loopback',
      reason: quality.measured ? null : '未取得心跳样本',
      rtt: quality.rtt,
      rttMin: quality.rttMin,
      rttMax: quality.rttMax,
      jitter: quality.jitter,
      packetLoss: quality.packetLoss,
      samples: quality.samples,
      replies,
      requested: Math.max(1, pings),
      delivered,
      serverPort: info.port,
      forwarded: stats.packetsForwarded,
      dropped: stats.dropped,
      elapsedMs: now() - started,
      notes,
    };
  } catch (err) {
    return {
      ok: false, measured: false, scope: 'loopback',
      reason: '中继自检异常：' + (err && err.message ? err.message : String(err)),
      rtt: null, jitter: null, packetLoss: null, samples: 0, delivered: 0,
      elapsedMs: now() - started, notes,
    };
  } finally {
    for (const client of [a, b]) { try { if (client) await client.close(); } catch (err) { /* 忽略 */ } }
    try { if (server) await server.stop(); } catch (err) { /* 忽略 */ }
  }
}

module.exports = { runRelaySelfTest };
