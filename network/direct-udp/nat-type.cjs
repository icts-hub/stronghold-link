'use strict';
// ============================================================================
// Stronghold Link — NAT 映射行为实测
//
// 做法：**同一个本地 socket** 向两个不同的 STUN 服务器各问一次公网映射，比较结果：
//   * 两个服务器看到的公网端口相同  → 端点无关映射（锥形 NAT，打洞通常可行）
//   * 端口不同                     → 地址相关映射（对称倾向，打洞成功率低）
//   * 公网地址也不同               → 多出口（打洞基本不可行）
//
// 这一点很关键：如果每个服务器用**不同** socket，端口不同是必然的，
// 什么都说明不了 —— 必须同 socket 才有意义。
// ============================================================================

const dgram = require('node:dgram');
const stun = require('./stun.cjs');

const DEFAULT_SERVERS = Object.freeze([
  { host: 'stun.l.google.com', port: 19302 },
  { host: 'stun.cloudflare.com', port: 3478 },
]);

/**
 * @param {object} [options]
 * @param {Array}  [options.servers]
 * @param {number} [options.timeoutMs]
 * @param {object} [options.socket]   注入用（测试）
 */
async function measureNatMapping({ servers = DEFAULT_SERVERS, timeoutMs = 5000, socket = null } = {}) {
  const own = !socket;
  const sock = socket || dgram.createSocket('udp4');
  const results = [];
  const notes = [];

  try {
    if (own) await new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      sock.once('error', onError);
      sock.bind(0, () => { sock.removeListener('error', onError); resolve(); });
    });

    const pending = new Map();
    const onMessage = (msg, rinfo) => {
      const parsed = stun.parseMessage(msg);
      if (!parsed.ok) return;
      const addr = parsed.xorMapped || parsed.mapped;
      if (!addr) return;
      const entry = pending.get(parsed.transactionId);
      if (!entry) return;                                  // 不是我们发出的请求
      results.push({ server: entry.server, address: addr.address, port: addr.port, family: addr.family });
      pending.delete(parsed.transactionId);
    };
    sock.on('message', onMessage);

    const ask = () => {
      for (const server of servers) {
        const { buffer, transactionId } = stun.buildBindingRequest();
        pending.set(transactionId.toString('hex'), { server: server.host + ':' + server.port });
        try { sock.send(buffer, server.port, server.host); } catch (err) { pending.delete(transactionId.toString('hex')); }
      }
    };
    ask();

    // 公共 STUN 服务器偶发不回包：拿到 2 个响应就够判断，够之前按间隔重发
    const started = Date.now();
    let lastAsk = started;
    while (results.length < 2 && Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (Date.now() - lastAsk > 1200) { ask(); lastAsk = Date.now(); }
    }
    try { sock.removeListener('message', onMessage); } catch (err) { /* 忽略 */ }

    if (results.length < 2) {
      return {
        ok: false,
        mapping: 'unknown',
        reason: '只收到 ' + results.length + ' 个 STUN 响应（至少需要 2 个才能判断映射行为）',
        results,
        notes,
        scope: 'local',
      };
    }

    const addresses = new Set(results.map((r) => r.address));
    const ports = new Set(results.map((r) => r.port));
    let mapping;
    if (addresses.size > 1) {
      mapping = 'multiple-exits';
      notes.push('两个服务器看到不同公网地址：可能是多出口网络，打洞基本不可行');
    } else if (ports.size === 1) {
      mapping = 'endpoint-independent';
      notes.push('端点无关映射：同一本地端口对不同目标是同一个公网端口，打洞通常可行');
    } else {
      mapping = 'address-dependent';
      notes.push('地址相关映射（对称倾向）：不同目标映射到不同公网端口，打洞成功率低，建议用中继');
    }

    return {
      ok: true,
      mapping,
      reason: null,
      publicAddress: [...addresses][0],
      publicPort: ports.size === 1 ? [...ports][0] : null,
      localPort: sock.address ? sock.address().port : null,
      results,
      notes,
      scope: 'local',
    };
  } catch (err) {
    return { ok: false, mapping: 'unknown', reason: '测量失败：' + (err && err.message ? err.message : String(err)), results, notes, scope: 'local' };
  } finally {
    if (own) { try { sock.close(); } catch (err) { /* 忽略 */ } }
  }
}

module.exports = { DEFAULT_SERVERS, measureNatMapping };
