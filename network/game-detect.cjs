'use strict';
// ============================================================================
// Stronghold Link — 游戏识别（一键联机的基础）
//
// 做法：进程名（tasklist，毫秒级）与监听端口（netstat）交叉比对内置档案。
//   进程名对上 + 端口对上  -> high（几乎不可能误判）
//   只有进程名对上          -> high（用该进程真实监听的端口，支持自定义端口）
//   只有默认端口对上        -> medium（可能是别的程序占了同号端口）
//
// 诚实约定：
//   * 只**识别**并给出建议，不替用户改配置
//   * 认不出就返回空数组，不猜（宁可让用户手填，也不乱填）
//   * 档案里的端口是"默认端口"；实际以进程真实监听的端口为准
// ============================================================================

/** 游戏档案：进程名（小写，可多个）+ 默认端口 + 协议 + 好友端怎么连 */
/** 命令行证据：进程名太泛（javaw.exe 等）时，用它确认到底是哪个游戏 */
const CMD_HINTS = {
  'stronghold-protocol': [/server[\\/]index\.js/i, /stronghold/i, /卫戍/, /alliance/i, /room/i],
  'minecraft-java': [/minecraft/i, /server\.jar/i, /\.minecraft/i, /net\.minecraft/i, /forge|fabric|paper|spigot|bukkit/i],
  'minecraft-bedrock': [/minecraft.*bedrock|bedrock_server/i, /Minecraft\.Win10/i],
  'terraria': [/terraria/i],
  'valheim': [/valheim/i],
  'palworld': [/palserver|palworld/i],
  'dont-starve': [/dontstarve|dont_starve/i],
  'ark': [/shootergame|arkascended/i],
  'cs2': [/cs2|-game csgo/i],
  'l4d2': [/left4dead2/i],
  'rust': [/rustdedicated|\\rust\b/i],
  'factorio': [/factorio/i],
  '7dtd': [/7daystodie/i],
  'zomboid': [/projectzomboid/i],
  'starbound': [/starbound/i],
  'satisfactory': [/factorygame/i],
  'fivem': [/fivem/i],
  'mta': [/mtasa|gta_sa/i],
  'stardew': [/stardew/i],
  'warcraft3': [/warcraft iii|war3|wc3/i],
  'scpsl': [/scpsl/i],
  'among-us': [/among us/i],
};

const PROFILES = [
  // 本项目配套的游戏：Node 权威服，网页与 WebSocket 共用 3000，房间号叫「同盟密钥」
  { id: 'stronghold-protocol', name: '卫戍协议：盟约', procs: ['node.exe', 'node', 'stronghold protocol.exe'], ports: [3000], protocol: 'TCP', join: '房主建房后把 4 位「同盟密钥」或「复制链接」发给好友；好友点「打开游戏并进入房间」即可' },
  { id: 'minecraft-java', name: 'Minecraft Java 版', procs: ['javaw.exe', 'java.exe', 'minecraft.exe'], ports: [25565], protocol: 'TCP', join: '多人游戏 → 直接连接 → 输入 127.0.0.1:{{port}}' },
  { id: 'minecraft-bedrock', name: 'Minecraft 基岩版', procs: ['minecraft.win10.exe', 'minecraftlauncher.exe'], ports: [19132], protocol: 'UDP', join: '服务器 → 添加服务器 → 地址 127.0.0.1，端口 {{port}}' },
  { id: 'terraria', name: '泰拉瑞亚', procs: ['terraria.exe', 'terrariaserver.exe', 'terrariaserverconfig.exe'], ports: [7777], protocol: 'TCP', join: '多人游戏 → 加入通过 IP → 127.0.0.1 端口 {{port}}' },
  { id: 'valheim', name: '英灵神殿 Valheim', procs: ['valheim.exe'], ports: [2456, 2457, 2458], protocol: 'UDP', join: '加入游戏 → 通过 IP 加入 → 127.0.0.1:{{port}}' },
  { id: 'palworld', name: '幻兽帕鲁', procs: ['palserver.exe', 'palworld.exe', 'palserver-win64-shipping.exe'], ports: [8211], protocol: 'UDP', join: '加入多人游戏 → 127.0.0.1:{{port}}' },
  { id: 'dont-starve', name: '饥荒联机版', procs: ['dontstarve_steam.exe'], ports: [10999], protocol: 'UDP', join: '浏览游戏 → 直连 → 127.0.0.1:{{port}}' },
  { id: 'ark', name: '方舟：生存进化', procs: ['shootergame.exe', 'arkascended.exe'], ports: [7777, 7778], protocol: 'UDP', join: '非官方服务器 → 收藏 → 127.0.0.1:{{port}}' },
  { id: 'cs2', name: 'CS2 / CS:GO', procs: ['cs2.exe', 'csgo.exe', 'hl2.exe'], ports: [27015], protocol: 'UDP', join: '控制台 connect 127.0.0.1:{{port}}' },
  { id: 'l4d2', name: '求生之路 2', procs: ['left4dead2.exe'], ports: [27015], protocol: 'UDP', join: '控制台 connect 127.0.0.1:{{port}}' },
  { id: 'rust', name: 'Rust', procs: ['rust.exe', 'rustdedicated.exe'], ports: [28015], protocol: 'UDP', join: 'F1 → client.connect 127.0.0.1:{{port}}' },
  { id: 'factorio', name: 'Factorio', procs: ['factorio.exe'], ports: [34197], protocol: 'UDP', join: '多人游戏 → 连接服务器 → 127.0.0.1:{{port}}' },
  { id: '7dtd', name: '七日杀', procs: ['7daystodie.exe'], ports: [26900], protocol: 'UDP', join: '加入游戏 → 连接到 IP → 127.0.0.1:{{port}}' },
  { id: 'zomboid', name: '僵尸毁灭工程', procs: ['projectzomboid64.exe', 'projectzomboid32.exe'], ports: [16261], protocol: 'UDP', join: '加入服务器 → 127.0.0.1:{{port}}' },
  { id: 'starbound', name: '星界边境', procs: ['starbound.exe', 'starbound_server.exe'], ports: [21025], protocol: 'TCP', join: '加入服务器 → 127.0.0.1:{{port}}' },
  { id: 'satisfactory', name: '幸福工厂', procs: ['factorygame.exe', 'factorygameserver.exe'], ports: [7777], protocol: 'UDP', join: '加入游戏 → 127.0.0.1:{{port}}' },
  { id: 'fivem', name: 'FiveM / GTA5', procs: ['fivem.exe', 'gta5.exe'], ports: [30120], protocol: 'TCP', join: 'F8 → connect 127.0.0.1:{{port}}' },
  { id: 'mta', name: 'MTA:SA', procs: ['gta_sa.exe', 'mtasa.exe'], ports: [22003], protocol: 'UDP', join: '快速连接 → 127.0.0.1:{{port}}' },
  { id: 'stardew', name: '星露谷物语', procs: ['stardew valley.exe'], ports: [24642], protocol: 'UDP', join: '合作 → 加入局域网游戏（本机入口端口）' },
  { id: 'warcraft3', name: '魔兽争霸 III', procs: ['warcraft iii.exe', 'war3.exe', 'wc3.exe'], ports: [6112], protocol: 'UDP', join: '局域网 → 找房主房间' },
  { id: 'scpsl', name: 'SCP：秘密实验室', procs: ['scpsl.exe'], ports: [7777], protocol: 'UDP', join: '直连 → 127.0.0.1:{{port}}' },
  { id: 'among-us', name: 'Among Us', procs: ['among us.exe'], ports: [22023], protocol: 'UDP', join: '在线 → 输入房间码' },
  { id: 'dst-together', name: '泰拉科技 / 通用 UDP', procs: ['terratech.exe'], ports: [7777], protocol: 'UDP', join: '直连 127.0.0.1:{{port}}' },
];

/** 名字太泛的进程：光凭名字不能断定是某个游戏，必须有命令行证据（或降级为 low） */
const AMBIGUOUS_PROCS = new Set(['javaw.exe', 'java.exe', 'javaws.exe', 'python.exe', 'pythonw.exe', 'node.exe', 'dotnet.exe', 'wine.exe', 'wine64.exe', 'mono.exe']);

const BY_PROC = new Map();
const BY_PORT = new Map();
for (const p of PROFILES) {
  for (const proc of p.procs) if (!BY_PROC.has(proc)) BY_PROC.set(proc, p);
  for (const port of p.ports) {
    if (!BY_PORT.has(port)) BY_PORT.set(port, []);
    BY_PORT.get(port).push(p);
  }
}

/**
 * 识别监听端口背后的游戏。
 * @param {Array} entries listListeningPorts() 的 entries（含 process/port/protocol）
 * @returns {Array} [{ id, name, port, protocol, process, confidence, join }]
 */
function detectGames(entries, { limit = 8, processTable = null } = {}) {
  const out = [];
  const seen = new Set();
  const cmdOf = (pid) => {
    if (!processTable || !Array.isArray(processTable)) return null;
    const hit = processTable.find((r) => r && r.pid === Number(pid));
    return hit ? String(hit.cmd || '') : null;
  };
  for (const e of entries || []) {
    if (!e || !Number(e.port)) continue;
    const proc = String(e.process || '').toLowerCase();
    // 只认"服务端在听"的端口
    if (e.protocol === 'TCP' && e.state && e.state !== 'LISTENING') continue;
    const byProc = proc ? BY_PROC.get(proc) : null;
    const byPort = BY_PORT.get(Number(e.port)) || [];
    let profile = null;
    let confidence = null;
    let evidence = null;
    const ambiguous = proc ? AMBIGUOUS_PROCS.has(proc) : false;
    if (byProc && ambiguous) {
      // 泛名进程（javaw.exe / java.exe 等）：名字本身不能定身份，分三种情况
      const cmd = cmdOf(e.pid);
      const hints = CMD_HINTS[byProc.id];
      if (cmd && hints && hints.some((re) => re.test(cmd))) {
        // 命令行确认 -> 最可靠，随机端口也认
        profile = byProc; confidence = 'high'; evidence = '命令行确认：' + byProc.name;
      } else if (cmd) {
        // 取到命令行但不像 -> 明确否决（普通 Java 程序不该被当成 Minecraft）
        profile = null; confidence = null;
      } else if (byPort.includes(byProc)) {
        // 没取到命令行，但端口正是该游戏的默认端口 -> 名字 + 默认端口是强证据
        profile = byProc; confidence = 'high'; evidence = '进程名 + 默认端口 ' + e.port + ' 一致（未取命令行）';
      } else {
        // 名字像、端口不是默认值、又没有命令行 -> 只能算未确认
        profile = byProc; confidence = 'low'; evidence = '进程名 ' + e.process + ' 可能是 ' + byProc.name + '，端口非默认且未取到命令行，未确认';
      }
    }
    else if (byProc && byPort.includes(byProc)) { profile = byProc; confidence = 'high'; evidence = '进程名与默认端口一致'; }
    else if (byProc) { profile = byProc; confidence = 'high'; evidence = '进程名为 ' + e.process + '（端口非默认，已按真实监听端口处理）'; }
    else if (byPort.length === 1) { profile = byPort[0]; confidence = 'medium'; evidence = '仅端口 ' + e.port + ' 命中默认端口'; }
    else if (byPort.length > 1) { profile = byPort.find((p) => p.protocol === e.protocol) || byPort[0]; confidence = 'medium'; evidence = '端口 ' + e.port + ' 与多个档案重合'; }
    if (!profile) {
      // 没有档案命中：若进程名很泛（javaw.exe 等），用命令行反查是不是 Minecraft 这类游戏
      const cmd = cmdOf(e.pid);
      if (cmd) {
        for (const p of PROFILES) {
          const hints = CMD_HINTS[p.id];
          if (hints && hints.some((re) => re.test(cmd))) { profile = p; confidence = 'high'; evidence = '命令行命中 ' + p.name; break; }
        }
      }
    }
    if (!profile) continue;
    const key = profile.id + ':' + e.protocol;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: profile.id,
      name: profile.name,
      port: Number(e.port),
      protocol: e.protocol || profile.protocol,
      process: e.process || null,
      pid: e.pid,
      confidence,
      evidence,
      isDefaultPort: profile.ports.includes(Number(e.port)),
      join: String(profile.join).replace('{{port}}', String(e.port)),
    });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return out
    .sort((a, b) => (rank[a.confidence] - rank[b.confidence]) || (Number(b.isDefaultPort) - Number(a.isDefaultPort)) || (a.port - b.port))
    .slice(0, limit);
}

/** 一键联机时选哪一个：优先 high 置信度 + 默认端口 */
function pickPrimaryGame(entries, options) {
  const games = detectGames(entries, options || {});
  // 只取"可确认"的：未取到命令行的泛名进程（low）不参与一键自动选端口
  const solid = games.filter((x) => x.confidence !== 'low');
  return solid.length ? solid[0] : null;
}

module.exports = { PROFILES, CMD_HINTS, AMBIGUOUS_PROCS, detectGames, pickPrimaryGame };
