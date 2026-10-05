'use strict';
// ============================================================================
// Stronghold Link — 进程表（含命令行），用于识别"名字太泛"的游戏进程
//
// 为什么需要它：Minecraft 的服务端进程常常就叫 javaw.exe / java.exe，
// 光看名字无法与"任何一个 Java 程序"区分；而且它的端口**每次都可能不同**
// （开局域网随机分配、服务端可在 server.properties 里随便改）。
//
// 所以：端口一律从 netstat 的真实监听表读（不猜默认值），
//       进程身份用命令行确认（含 minecraft / server.jar / .minecraft 等关键字）。
//
// 成本：一次全表命令行查询实测约 4.5 秒（这台机器），因此：
//   * 结果缓存（默认 30 秒），同一轮识别只查一次
//   * 只在"存在需要消歧的进程名"时才查，认得出名字的游戏不花这个时间
// ============================================================================

const { execFileSync } = require('node:child_process');

let cache = { at: 0, rows: [], source: null };
const CACHE_MS = 30000;

/** 需要靠命令行才能确认的进程名（Java 系、通用宿主） */
const AMBIGUOUS = new Set(['javaw.exe', 'java.exe', 'javaws.exe', 'python.exe', 'pythonw.exe', 'node.exe', 'dotnet.exe', 'wine.exe']);

function needsCommandLine(processName) {
  return AMBIGUOUS.has(String(processName || '').toLowerCase());
}

/** 解析 PowerShell 的 JSON 输出（数组或单对象） */
function parsePsJson(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  try {
    const v = JSON.parse(t);
    const arr = Array.isArray(v) ? v : [v];
    return arr
      .map((x) => ({
        pid: Number(x.ProcessId),
        name: String(x.Name || '').toLowerCase(),
        cmd: String(x.CommandLine || ''),
      }))
      .filter((x) => Number.isFinite(x.pid) && x.pid >= 0);
  } catch (err) {
    return [];
  }
}

/**
 * 读进程表（带命令行）。慢（~4.5s），有缓存。
 * @returns {{ ok:boolean, rows:Array<{pid:number,name:string,cmd:string}>, source:string, reason:string|null }}
 */
function readProcessTable({ force = false, timeoutMs = 20000 } = {}) {
  const now = Date.now();
  if (!force && cache.rows.length && now - cache.at < CACHE_MS) {
    return { ok: true, rows: cache.rows, source: cache.source + ' (cached)', reason: null };
  }
  try {
    const ps = 'powershell';
    const args = ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 3'];
    const out = execFileSync(ps, args, { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    const rows = parsePsJson(out);
    if (rows.length) {
      cache = { at: now, rows, source: 'cim' };
      return { ok: true, rows, source: 'cim', reason: null };
    }
    return { ok: false, rows: [], source: 'cim', reason: '进程表为空' };
  } catch (err) {
    return { ok: false, rows: [], source: 'cim', reason: '读取进程表失败：' + (err && err.message ? err.message : String(err)) };
  }
}

/** 按 PID 取命令行（命中缓存；没缓存时用整表换，避免逐个 4.5 秒） */
function commandLineFor(pid) {
  const table = readProcessTable({});
  if (!table.ok) return null;
  const hit = table.rows.find((r) => r.pid === Number(pid));
  return hit ? hit.cmd : null;
}

function clearCache() { cache = { at: 0, rows: [], source: null }; }

module.exports = { AMBIGUOUS, needsCommandLine, parsePsJson, readProcessTable, commandLineFor, clearCache, CACHE_MS };
