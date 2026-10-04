'use strict';
// Stronghold Link — 适配器与「连接方式」注册表。
//
// 解决的问题：不同类型的服务，跨网络访问方式差别很大——
//   * 原生 TCP/UDP 服务（Web、RDP、游戏服务、自建程序）：房主开放端口，加入者把客户端指向本机入口；
//   * 浏览器应用（页面 + WebSocket 同端口）：加入者**不需要在本机跑服务**，
//     浏览器打开本机入口端口，页面与 WebSocket 一起经隧道到房主；
//   * 同局域网：其实不需要任何中继，只要把地址说清楚；
//   * Steam P2P：跨网络时不需要端口转发，但需要 Steamworks SDK。
// 本模块把这些差异收敛成「配方（recipe）」：每个配方声明它需要哪些字段、怎么组装会话参数、
// 以及两端各自该怎么连。这样做的好处是：加新服务类型只需要加一条配方，不用改界面逻辑。

const ADAPTER_KINDS = {
  local: {
    id: 'local',
    name: '本地中继',
    capabilities: { tcp: true, udp: true, multiChannel: true, needsSdk: false, encryption: 'PSK-AEAD（AES-256-GCM）' },
  },
  steam: {
    id: 'steam',
    name: 'Steam P2P',
    capabilities: { tcp: true, udp: false, multiChannel: false, needsSdk: true, encryption: 'Steam 传输层加密' },
  },
  none: {
    id: 'none',
    name: '不做转发（仅生成连接说明）',
    capabilities: { tcp: false, udp: false, multiChannel: false, needsSdk: false, encryption: '不适用' },
  },
};

function rule0(rules = []) {
  return rules[0] || { protocol: 'TCP', localPort: 0, remotePort: 0 };
}

/** 配方定义。fields 决定界面显示哪些输入；hints 决定两端怎么连。 */
const RECIPES = [
  {
    id: 'local-ports',
    name: '本地中继（TCP / UDP 端口规则）',
    adapter: 'local',
    summary: '房主把中继端口转发到本机服务；加入者把客户端连到本机入口端口。自带 AES-256-GCM 加密。',
    fields: ['rules', 'bindHost', 'token'],
    supportsSteam: false,
    defaultGamePort: 2300,
  },
  {
    id: 'local-web',
    name: '本地中继 + 浏览器应用（页面与 WebSocket 同端口）',
    adapter: 'local',
    summary: '适合「先打开网页、网页再连 WebSocket」的应用（内网面板、浏览器游戏等）：加入者不用在本机跑服务，浏览器直接打开本机入口端口，页面与 WebSocket 都经隧道到房主。',
    fields: ['rules', 'bindHost', 'token'],
    supportsSteam: false,
    defaultGamePort: 3000,
  },
  {
    id: 'steam-tunnel',
    name: 'Steam P2P 隧道（需要 Steamworks SDK）',
    adapter: 'steam',
    summary: '跨网络不需要端口转发；房主创建 Steam P2P 监听，加入者用房主 SteamID 直连。加密与身份认证由 Steam 负责。',
    fields: ['gamePort', 'appId', 'hostSteamId'],
    supportsSteam: true,
    defaultGamePort: 3000,
  },
  {
    id: 'lan-direct',
    name: '不做中继（局域网直连，仅生成连接说明）',
    adapter: 'none',
    summary: '同一局域网时最省事：加入者直接访问房主 IP 与服务端口。本工具不建立任何隧道，只把地址整理清楚，并如实显示「未转发」。',
    fields: ['gamePort'],
    supportsSteam: false,
    defaultGamePort: 3000,
  },
];

function getRecipe(id) {
  return RECIPES.find((recipe) => recipe.id === id) || null;
}

/** 配方列表（供界面显示），可附带 Steam 可用性。 */
function describeRecipes({ steamAvailable = false } = {}) {
  return RECIPES.map((recipe) => ({
    id: recipe.id,
    name: recipe.name,
    adapter: recipe.adapter,
    summary: recipe.summary,
    fields: recipe.fields,
    defaultGamePort: recipe.defaultGamePort,
    available: recipe.supportsSteam ? Boolean(steamAvailable) : true,
    unavailableReason: recipe.supportsSteam && !steamAvailable ? '缺少 Steamworks SDK（见 docs/PHASE4-STEAM.md）' : null,
  }));
}

/** 适配器列表（供 IPC/界面显示）。 */
function describeAdapters({ steamDiagnosis = null, running = false, role = null, channelSummary = '' } = {}) {
  const steamReady = Boolean(steamDiagnosis?.available);
  const suffix = running ? `会话进行中（${role === 'host' ? '房主' : '加入者'}）：${channelSummary || '—'}` : null;
  return [
    {
      id: 'tcp-relay',
      name: '本地 TCP 中继（加密）',
      status: running && role ? 'running' : 'ready',
      supported: ['TCP'],
      description: suffix
        ? `${suffix}${suffix.includes('明文') ? '' : ' · 加密会话'}`
        : '已接入：多端口规则、AES-256-GCM 加密会话（口令可选）、连接数与流量统计。',
    },
    {
      id: 'udp-relay',
      name: '本地 UDP 转发（加密）',
      status: running && role ? 'running' : 'ready',
      supported: ['UDP'],
      description: suffix || '已接入：按对端会话做地址映射的数据报转发，逐包加密 + 重放窗口，空闲 60 秒回收。',
    },
    {
      id: 'steam-p2p',
      name: 'Steam P2P（Networking Sockets）',
      status: steamReady ? (running ? 'running' : 'ready') : 'not-configured',
      supported: ['reliable'],
      description: steamReady
        ? '已就绪：房主创建 Steam P2P 监听，加入者用房主 SteamID 直连；加密与身份认证由 Steam 传输层负责。'
        : `未就绪：${steamDiagnosis?.blockers?.[0] || '缺少 Steamworks SDK'}。设置步骤见 docs/PHASE4-STEAM.md；界面「Steam 环境自检」可看清单。`,
    },
    {
      id: 'guidance-only',
      name: '不做转发（仅连接说明）',
      status: running ? 'running' : 'ready',
      supported: [],
      description: '局域网直连时使用：本工具不建立隧道，只把房主地址与端口整理好，状态里会明确显示「未转发任何流量」。',
    },
  ];
}

/**
 * 由配方 + 当前表单值组装会话启动参数。
 * 只做组装与校验，不碰网络（便于单测）。
 */
function buildStartInput(recipeId, params = {}) {
  const recipe = getRecipe(recipeId);
  if (!recipe) {
    const err = new Error(`未知的连接方式：${recipeId}`);
    err.friendly = err.message;
    throw err;
  }
  const { role } = params;
  if (role !== 'host' && role !== 'joiner') {
    const err = new Error('角色必须是 host（房主）或 joiner（加入者）');
    err.friendly = err.message;
    throw err;
  }
  const game = params.game || '';

  if (recipe.adapter === 'local') {
    if (!Array.isArray(params.rules) || !params.rules.length) {
      const err = new Error('这条连接方式需要至少一条端口规则');
      err.friendly = err.message;
      throw err;
    }
    return role === 'host'
      ? { role, adapter: 'local', rules: params.rules, bindHost: params.bindHost || '0.0.0.0', targetHost: params.targetHost || '127.0.0.1', authToken: params.token ?? undefined, game, recipe: recipe.id }
      : { role, adapter: 'local', rules: params.rules, bindHost: '127.0.0.1', remoteHost: params.remoteHost, authToken: params.token ?? undefined, game, recipe: recipe.id };
  }

  if (recipe.adapter === 'steam') {
    const appId = params.appId ? Number(params.appId) : null;
    return role === 'host'
      ? { role, adapter: 'steam', targetHost: params.targetHost || '127.0.0.1', gamePort: Number(params.gamePort), appId, game, recipe: recipe.id }
      : { role, adapter: 'steam', hostSteamId: String(params.hostSteamId || '').trim(), localPort: Number(params.localPort), appId, game, recipe: recipe.id };
  }

  // 不做转发：仍然是「一个会话」，但有 0 条通道，只提供连接说明
  return {
    role,
    adapter: 'none',
    gamePort: Number(params.gamePort),
    game,
    recipe: recipe.id,
    notes: params.notes || '',
  };
}

/**
 * 生成两端的连接说明：房主看 hostHint，加入者看 clientHint（邀请信息里也会带上）。
 * 纯函数，便于界面预览与测试。
 */
function describeHints(recipeId, params = {}) {
  const recipe = getRecipe(recipeId);
  if (!recipe) return { hostHint: [], clientHint: [] };
  const rules = Array.isArray(params.rules) ? params.rules : [];
  const first = rule0(rules);
  const lan = params.lanAddress || '（本机局域网 IP）';
  const gameName = params.game || '目标服务';
  const hostHint = [];
  const clientHint = [];

  if (recipe.adapter === 'local') {
    const isWeb = recipe.id === 'local-web';
    hostHint.push(`本机服务保持运行：${params.targetHost || '127.0.0.1'}:${first.localPort}`);
    hostHint.push(`对好友开放：${lan}:${first.remotePort}（${rules.length} 条规则，协议 ${rules.map((r) => r.protocol).join('/')}）`);
    if (rules.length > 1) hostHint.push('多条规则会一起启动，端口占用会逐个预检。');
    if (isWeb) {
      clientHint.push(`浏览器打开 http://127.0.0.1:${first.localPort} （页面与 WebSocket 都经隧道到房主，不需要在本机装 ${gameName}）`);
      clientHint.push(`也可以让浏览器直接访问房主：http://${lan}:${first.remotePort}`);
    } else {
      clientHint.push(`客户端连接 127.0.0.1:${first.localPort}（本机入口端口）`);
      clientHint.push(`若客户端支持自定义地址，也可直接填 ${lan}:${first.remotePort}`);
    }
    clientHint.push('口令必须与房主一致；不一致时加入者日志会显示「口令不匹配」。');
    return { hostHint, clientHint };
  }

  if (recipe.adapter === 'steam') {
    hostHint.push(`Steam 会话启动后，把界面显示的「本机 SteamID」发给好友（不需要端口转发）。`);
    if (params.gamePort) hostHint.push(`本地服务端口：${params.targetHost || '127.0.0.1'}:${params.gamePort}`);
    clientHint.push('会话 → 加入者 → 传输适配器选 Steam P2P → 填房主 SteamID → 启动桥接。');
    if (params.localPort) clientHint.push(`客户端连接 127.0.0.1:${params.localPort}`);
    clientHint.push('双方 Steam 必须登录，且 AppID 一致（测试可用 480）。');
    return { hostHint, clientHint };
  }

  hostHint.push(`不做任何转发：请确保本机防火墙允许 ${params.gamePort || first.localPort} 入站。`);
  hostHint.push(`把地址发给好友：${lan}:${params.gamePort || first.localPort}`);
  clientHint.push(`浏览器/客户端直接打开 http://${lan}:${params.gamePort || first.localPort}`);
  clientHint.push('这条路径依赖同一局域网（或已有 VPN），本工具不参与流量转发。');
  return { hostHint, clientHint };
}

module.exports = {
  ADAPTER_KINDS,
  RECIPES,
  getRecipe,
  describeRecipes,
  describeAdapters,
  buildStartInput,
  describeHints,
};
