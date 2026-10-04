'use strict';
const { execFileSync } = require('node:child_process');
// 中继内核共用工具：错误码 -> 中文文案、端口/口令校验。
// TCP 与 UDP 中继都从这里取，避免两份实现漂移。

/** 把系统错误码翻译成用户能看懂的一句话（写入 err.friendly，err.code/err.message 保持原样）。 */
function describeError(err, ctx = {}) {
  if (!err) return '未知错误';
  const where = ctx.host ? `${ctx.host}:${ctx.port ?? ''}` : (ctx.port != null ? `端口 ${ctx.port}` : '');
  switch (err.code) {
    case 'EADDRINUSE': return `端口 ${ctx.port} 已被占用：可能本程序已经启动了一个会话，或被其它软件占用。`;
    case 'EACCES': return `端口 ${ctx.port} 无法绑定：可能被系统保留（Windows 动态端口排除范围），或权限不足。请换一个端口，或以管理员身份运行。`;
    case 'EADDRNOTAVAIL': return `本机没有地址 ${ctx.host}：请检查监听地址设置。`;
    case 'ECONNREFUSED': return `目标 ${where} 拒绝连接：对方没有在监听这个端口。`;
    case 'ETIMEDOUT': return `连接 ${where} 超时：请检查地址、端口和防火墙。`;
    case 'EHOSTUNREACH': return `无法到达主机 ${ctx.host}：请检查 IP、网段和防火墙。`;
    case 'ENETUNREACH': return '网络不可达：请检查本机网络连接。';
    case 'ENOTFOUND': return `无法解析主机名 ${ctx.host}。`;
    case 'ECONNRESET': return '连接被对端重置。';
    case 'EPIPE': return '连接已被对端关闭。';
    case 'EMSGSIZE': return '数据包超过 UDP 上限（单个数据报最大 65507 字节），已丢弃。';
    default: return err.message || String(err);
  }
}

function decorate(err, ctx) {
  if (err && !err.friendly) err.friendly = describeError(err, ctx);
  return err;
}

function makeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function validPort(value, label = '端口') {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw makeError('EINVALIDPORT', `${label}必须是 1–65535 的整数`);
  return n;
}

function normalizeToken(token) {
  if (token == null) return '';
  const s = String(token).trim();
  if (!s) return '';
  if (s.length > 64) throw makeError('EINVALIDTOKEN', '口令长度不能超过 64 个字符');
  if (/[\s\r\n]/.test(s)) throw makeError('EINVALIDTOKEN', '口令不能包含空格或换行');
  return s;
}

/**
 * 查出某个 TCP 端口被哪个进程占用（只在端口冲突时调用，失败就返回 null）。
 * 实测价值：用户遇到「端口已被监听」时最想知道的就是「那是谁」——
 * 例如 3000 被 `node.exe server/index.js`（游戏服务端）占用。
 */
function describePortOwner(port, { timeoutMs = 3000 } = {}) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      if (cols.length < 5) continue;
      const local = cols[1] || '';
      const pid = cols[cols.length - 1];
      if (!/^\d+$/.test(pid)) continue;
      const portText = local.slice(local.lastIndexOf(':') + 1);
      if (Number(portText) === Number(port)) pids.add(pid);
    }
    if (pids.size === 0) return null;
    const names = [];
    for (const pid of pids) {
      let name = null;
      try {
        const task = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
        const matched = task.match(/^"([^"]+)"/m);
        if (matched) name = matched[1];
      } catch { /* 取不到名字 */ }
      const label = name ? (/\.[a-z0-9]+$/i.test(name) ? name : `${name}.exe`) : null;
      names.push(label ? `${label} (PID ${pid})` : `PID ${pid}`);
    }
    return names.join('、');
  } catch {
    return null;
  }
}

/** 在错误文本里追加「谁占用了端口」；拿不到占用者就原样返回。 */
function withPortOwner(text, port) {
  try {
    const owner = describePortOwner(port);
    return owner ? `${text}（占用者：${owner}）` : text;
  } catch {
    return text;
  }
}

module.exports = { describeError, decorate, makeError, validPort, normalizeToken, describePortOwner, withPortOwner };
