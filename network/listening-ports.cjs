'use strict';
// ============================================================================
// Stronghold Link — 本机监听端口探测（用于自动推荐要转发的端口）
//
// 做什么：枚举本机正在监听的 TCP/UDP 端口 + 归属进程，过滤掉系统噪声，
// 给出"像是游戏/服务端"的候选，并按可用性排序。
//
// 诚实约定：
//   * 只**推荐**，不自动替用户决定；候选里带进程名，让用户一眼认出自己的游戏
//   * 探测不到就返回空数组 + 原因，不编造
//   * 解析函数与系统调用分离：解析可单测，系统调用只在真机跑
// ============================================================================

const { execFileSync } = require('node:child_process');

const SYSTEM_PIDS = new Set([0, 4]);
const SYSTEM_NAMES = new Set([
  'system', 'idle', 'registry', 'memcompression', 'smss.exe', 'csrss.exe', 'wininit.exe',
  'services.exe', 'lsass.exe', 'winlogon.exe', 'svchost.exe', 'dwm.exe', 'fontdrvhost.exe',
  'spoolsv.exe', 'sihost.exe', 'ctfmon.exe', 'searchindexer.exe', 'securityhealthservice.exe',
  'taskhostw.exe', 'runtimebroker.exe', 'explorer.exe',
]);
const WELL_KNOWN_PORTS = new Set([
  135, 137, 138, 139, 445, 504, 1900, 3702, 5040, 5353, 5355, 7680,   // Windows / 发现协议
  500, 4500,                                                            // IPSec / IKE（实测本机在听）
  902, 912,                                                             // VMware 服务
  1434,                                                                 // SQL Server Browser
  47001, 5985,                                                          // WinRM
]);
const EPHEMERAL_FROM = 49152;
/** 明显不是"用户游戏"的进程（Steam 自身、许可证、容器、虚拟化、数据库、本工具）——排在真实候选之后 */
const INFRA_PATTERNS = [
  /^steam\.exe$/, /steamwebhelper/, /steamcommunity/, /lmgrd/, /flexnet/, /docker/, /vmware/i,
  /vmnat/, /sqlservr/, /sqlbrowser/, /caddy/, /com\.docker/,
  // 只排除"本工具自己的进程"，不能误伤用户要玩的游戏（例如 Stronghold Protocol）
  /^stronghold[ -]?link(\.exe)?$/, /^electron(\.exe)?$/,
];
const INFRA_PORTS = new Set([27036, 27037, 27060]);   // Steam 自身端口
function isInfra(entry) {
  if (INFRA_PORTS.has(entry.port)) return true;
  const name = String(entry.process || '');
  if (!name) return false;
  return INFRA_PATTERNS.some((re) => re.test(name));
}

/** 解析 netstat -ano 输出。返回 [{ protocol, address, port, pid, state }] */
function parseNetstat(text, protocol = 'TCP') {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || !/^(TCP|UDP)/i.test(t)) continue;
    const parts = t.split(/\s+/);
    if (parts.length < 4) continue;
    const proto = parts[0].toUpperCase();
    const local = parts[1];
    const state = proto === 'TCP' ? (parts[3] || '') : 'LISTENING';
    const pidRaw = proto === 'TCP' ? parts[4] : parts[3];
    const pid = Number(pidRaw);
    const m = local.match(/^(.*):(\d+)$/);
    if (!m || !Number.isFinite(pid)) continue;
    out.push({ protocol: protocol === 'UDP' ? 'UDP' : proto, address: m[1], port: Number(m[2]), pid, state: String(state).toUpperCase() });
  }
  return out;
}

/** 解析 tasklist /FO CSV /NH 输出 → Map(pid → name) */
function parseTasklist(text) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || !t.startsWith('"')) continue;
    const cells = t.split('","').map((c) => c.replace(/^"|"$/g, ''));
    const name = cells[0];
    const pid = Number(cells[1]);
    if (name && Number.isFinite(pid)) map.set(pid, name.toLowerCase());
  }
  return map;
}

/** 分类：系统噪声 / 像服务端 / 像客户端 */
function classify(entry, processName) {
  if (SYSTEM_PIDS.has(entry.pid)) return 'system';
  if (processName && SYSTEM_NAMES.has(processName)) return 'system';
  if (WELL_KNOWN_PORTS.has(entry.port)) return 'system';
  if (entry.protocol === 'TCP' && entry.state !== 'LISTENING') return 'client';
  if (entry.port >= EPHEMERAL_FROM) return 'client';            // 高位端口多为临时连接
  return 'server';
}

/** 排序：服务端优先，其次监听全网卡（0.0.0.0）优先，再按端口升序 */
function rankCandidates(entries, { exclude = [], limit = 12 } = {}) {
  const skip = new Set((exclude || []).map((p) => Number(p)).filter((p) => Number.isFinite(p)));
  return entries
    .filter((e) => e && !skip.has(Number(e.port)))
    .map((e) => ({ ...e, kind: classify(e, e.process) }))
    .filter((e) => e.kind === 'server')
    .sort((a, b) => {
      const rank = (e) => (isInfra(e) ? 2 : (e.process ? 0 : 1));   // 基础设施排最后
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      const aw = a.address === '0.0.0.0' || a.address === '::' ? 0 : 1;
      const bw = b.address === '0.0.0.0' || b.address === '::' ? 0 : 1;
      if (aw !== bw) return aw - bw;
      return a.port - b.port;
    })
    .slice(0, limit);
}

/** 为本地中继生成建议规则：本地端口 P → 对好友开放的 P+1（避开已占用） */
function suggestRules(entries, { exclude = [], max = 4, used = [], perProcess = 2 } = {}) {
  const taken = new Set([...exclude, ...used].map(Number));
  const seen = new Map();
  const rules = [];
  for (const c of rankCandidates(entries, { exclude, limit: max * 4 })) {
    if (rules.length >= max) break;
    const key = c.process || ('port:' + c.port);
    const usedFor = seen.get(key) || 0;
    if (usedFor >= perProcess) continue;              // 同一进程只推荐前 N 个端口
    seen.set(key, usedFor + 1);
    let remote = c.port + 1;
    while (taken.has(remote)) remote += 1;
    taken.add(remote);
    rules.push({ protocol: c.protocol, localPort: c.port, remotePort: remote, process: c.process || null });
  }
  return rules;
}

/** 给 Steam 房主会话挑一个最可能的游戏服务端口 */
function suggestSteamGamePort(entries, { exclude = [] } = {}) {
  const top = rankCandidates(entries, { exclude, limit: 3 }).filter((e) => !isInfra(e))[0];
  return top ? { port: top.port, protocol: top.protocol, process: top.process || null } : null;
}

/**
 * 真机探测（Windows）：netstat -ano -p TCP/UDP + 一次 tasklist 批量取进程名
 * @returns {{ ok:boolean, entries:Array, reason:string|null }}
 */
function listListeningPorts({ timeoutMs = 12000 } = {}) {
  try {
    const tcp = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
    const udp = execFileSync('netstat', ['-ano', '-p', 'UDP'], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
    const entries = [...parseNetstat(tcp, 'TCP'), ...parseNetstat(udp, 'UDP')];
    let names = new Map();
    try {
      const list = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
      names = parseTasklist(list);
    } catch (err) { /* 批量失败则走下面的逐个兜底 */ }
    if (names.size === 0) {
      // 兜底：只给"像服务端"的端口补查进程名（最多 12 个），否则慢
      const pids = [...new Set(entries.filter((e) => e.port < EPHEMERAL_FROM && !WELL_KNOWN_PORTS.has(e.port)).map((e) => e.pid))].slice(0, 12);
      for (const pid of pids) {
        try {
          const one = execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
          const parsed = parseTasklist(one);
          const name = parsed.get(pid);
          if (name) names.set(pid, name);
        } catch (err) { /* 单个查不到就跳过 */ }
      }
    }
    const withNames = entries.map((e) => ({ ...e, process: names.get(e.pid) || null }));
    return { ok: true, entries: withNames, reason: null };
  } catch (err) {
    return { ok: false, entries: [], reason: '端口探测失败：' + (err && err.message ? err.message : String(err)) };
  }
}

module.exports = {
  isInfra, INFRA_PORTS, INFRA_PATTERNS,
  SYSTEM_PIDS, SYSTEM_NAMES, WELL_KNOWN_PORTS, EPHEMERAL_FROM,
  parseNetstat, parseTasklist, classify, rankCandidates, suggestRules, suggestSteamGamePort, listListeningPorts,
};
