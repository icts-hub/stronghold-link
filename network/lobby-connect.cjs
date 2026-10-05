'use strict';
// ============================================================================
// Stronghold Link — 用大厅信息直接建立隧道（lobby → session）
//
// 大厅里已经交换了：房主 SteamID（shl_host）、房主要共享的服务端口（shl_port）、
// 版本（shl_version）。这个模块只做一件事：把这些信息变成"该不该启动会话、用什么参数"。
//
// 为什么单独成模块：真正的启动要走 session.start（会开监听、连 Steam），
// 把判断抽出来就能用假数据测透，接线时只剩"照着执行"。
//
// 诚实约定：任何条件不满足都返回 action='none' **并说明原因**；
// 不在会话已运行时偷偷重启（避免用户正在用的时候被打断）。
// ============================================================================

const ACTIONS = Object.freeze({ NONE: 'none', START: 'start' });

function cleanId(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

/**
 * @param {object} options
 * @param {'host'|'joiner'} options.role        本机在大厅里的角色
 * @param {object} options.lobby                { lobbyId, hostSteamId, port, game, version }
 * @param {object} [options.session]            会话快照 { state, config }
 * @param {number} [options.appId]
 * @param {string} [options.appVersion]
 * @param {string} [options.targetHost]         房主侧本地服务地址（默认 127.0.0.1）
 */
function planLobbyConnect({ role = 'joiner', lobby = null, session = null, appId = null, appVersion = null, targetHost = '127.0.0.1' } = {}) {
  const notes = [];
  const state = session && session.state ? String(session.state) : 'idle';
  const config = (session && session.config) || {};
  const running = state === 'running';
  const lobbyId = cleanId(lobby && lobby.lobbyId);
  const hostSteamId = cleanId(lobby && lobby.hostSteamId);
  const port = Number(lobby && lobby.port) > 0 ? Number(lobby.port) : null;

  if (!lobbyId) {
    return { action: ACTIONS.NONE, options: null, reason: '还没有大厅：先创建或加入一个大厅', notes };
  }

  const isSteamSession = config.adapter === 'steam';
  const sessionRole = config.role || null;

  if (role === 'joiner') {
    if (!hostSteamId) {
      return {
        action: ACTIONS.NONE, options: null, notes,
        reason: '大厅里还没有房主信息：房主那边可能还没启动 Steam 房主会话（大厅信息由房主写入）',
      };
    }
    if (running && isSteamSession && sessionRole === 'joiner' && cleanId(config.remoteHost) === hostSteamId) {
      return { action: ACTIONS.NONE, options: null, reason: '已经通过大厅连上了这条隧道', notes };
    }
    if (running) {
      return {
        action: ACTIONS.NONE, options: null, notes,
        reason: '当前已有会话在运行（' + (config.adapter || '未知') + ' / ' + (sessionRole || '未知') + '）：请先停止，再通过大厅连接',
      };
    }
    if (lobby.version && appVersion && String(lobby.version) !== String(appVersion)) {
      notes.push('大厅由版本 ' + lobby.version + ' 创建，本机是 ' + appVersion + '：协议不一致时可能连不上');
    }
    if (port) notes.push('房主共享的服务端口：' + port + '；本机入口端口也取同一个数字（' + port + '），这样你只需打开 127.0.0.1:' + port);
    notes.push('入口端口与房主服务端口同号 = 实测可用的配方；若该端口在你本机已被占用（例如你自己也开着游戏），会直接报错并提示先关掉它或换一个端口');
    return {
      action: ACTIONS.START,
      // 关键：入口端口取"房主服务端口同一个数字"，而不是随机分配。
      // 用户实测：两端都用 3000 时可以直接联机；随机端口会导致好友照旧打开 3000（连到自己那边）而失败。
      options: { adapter: 'steam', role: 'joiner', hostSteamId, localPort: Number(port) > 0 ? Number(port) : 0, appId: appId || null },
      reason: '用大厅里的房主 SteamID 建立 Steam 隧道（入口端口与房主服务端口同号）',
      notes,
    };
  }

  // 房主：需要大厅里写着要共享的服务端口
  if (!port) {
    return {
      action: ACTIONS.NONE, options: null, notes,
      reason: '大厅里没有服务端口：房主建大厅时要填写「本地服务端口」，否则好友不知道连哪里',
    };
  }
  if (running && isSteamSession && sessionRole === 'host' && Number(config.targetPort) === port) {
    return { action: ACTIONS.NONE, options: null, reason: '已经以房主身份在等好友了', notes };
  }
  if (running) {
    return {
      action: ACTIONS.NONE, options: null, notes,
      reason: '当前已有会话在运行（' + (config.adapter || '未知') + ' / ' + (sessionRole || '未知') + '）：请先停止，再重新建房',
    };
  }
  notes.push('房主侧不会监听端口：Stronghold 会去连本机的 ' + targetHost + ':' + port + '，请确保该服务已启动');
  return {
    action: ACTIONS.START,
    options: { adapter: 'steam', role: 'host', targetHost, gamePort: port, appId: appId || null },
    reason: '以房主身份共享 ' + targetHost + ':' + port + '，并把信息留在大厅里',
    notes,
  };
}

module.exports = { ACTIONS, planLobbyConnect };
