'use strict';
// Stronghold Link — Steam 数据报层的全局参数下发。
//
// 为什么需要这个模块：
//   steamworks-ffi-node 只绑定了 ISteamNetworkingUtils 的 15 个函数，**没有**
//   SetGlobalConfigValue* / SetConfigValue / SetConnectionConfigValue* / GetConfigValue 系列。而 Steam 的
//   带宽上下限、发送/接收缓冲、Nagle 时间、ICE 候选类型全部只能通过这几个函数设置。
//   缺了它们，Steam 就用自己那套保守默认值：发送缓冲小（突发就 LimitExceeded）、
//   速率上下限交给带宽估计器慢慢往上爬、只共享局域网 ICE 候选（公网直连打不通时
//   只能走中继，而中继天然更慢）。
//
// 参数取值参考 liangcka/chunyu-vpn 的 steam/steam_networking_manager.cpp:44-111 ——
// 那个项目同样是把 TCP 搬过 Steam，它在 SteamAPI_Init 之后立刻用 SetConfigValue 设了
// 一组全局参数，并且把 SendRateMin 与 SendRateMax 钉成同一个值，这正是 SDK 文档
// 对这两项的要求（"this option should always be set to the same value, to manually
// configure a [fixed rate]"）。
//
// 为什么用 Global 作用域而不是按连接下发：
//   ffi 的 connectP2P 把 nOptions 硬编码成 0（SteamNetworkingSocketsManager.js:331），
//   没有口子在建连时传 SteamNetworkingConfigValue_t。Global 作用域绕开了这个限制，
//   chunyu-vpn 也是全局设的。
//
// 本模块的三条纪律：
//   1. 设一项就读回来核对。SetConfigValue 返回 false 或读回值与请求值不符，都如实记进
//      report，绝不假装成功。
//   2. 任何一个符号缺失都只降级，不抛异常 —— 这是联机主路径上的代码。
//   3. 放宽认证的口子（IP_AllowWithoutAuth）默认**不**下发，要用得显式开。

const CONFIG_SCOPE_GLOBAL = 1;
const CONFIG_TYPE_INT32 = 1;

// k_ESteamNetworkingGetConfigValueResult
const GET_OK = 1;
const GET_OK_INHERITED = 2;

/** k_ESteamNetworkingConfigValue 的数值，名字与 Steamworks SDK 头文件一一对应。 */
const CONFIG_VALUE = {
  SendBufferSize: 9,
  SendRateMin: 10,
  SendRateMax: 11,
  NagleTime: 12,
  IP_AllowWithoutAuth: 23,
  TimeoutInitial: 24,
  TimeoutConnected: 25,
  MTU_PacketSize: 32,
  RecvBufferSize: 47,
  RecvBufferMessages: 48,
  P2P_Transport_ICE_Enable: 104,
  P2P_Transport_ICE_Penalty: 105,
  P2P_Transport_SDR_Penalty: 106,
};

/** k_nSteamNetworkingConfig_P2P_Transport_ICE_Enable_* */
const ICE_DISABLED = 0;
const ICE_PRIVATE = 2;  // RFC1918 / link-local
const ICE_PUBLIC = 4;   // STUN 反射地址，即公网直连所需的候选
const ICE_ALL = 0x7fffffff;

const MB = 1024 * 1024;

/**
 * 把 SDR 中继压到"万不得已才用"所需的惩罚值，单位**毫秒**。
 *
 * 官方文档对这项的原文（steamnetworkingtypes.h / docs.rs 镜像）：
 *   「When selecting P2P transport, add various penalties to the scores for
 *     selected transports. (Route selection scores are on a scale of milliseconds.
 *     The score begins with the route ping time and is then adjusted.)」
 * 也就是：**打分单位就是毫秒，起点是该路由的 ping，惩罚直接加在分数上。**
 * 所以给 SDR 加 10000 分，等于「除非直连 ICE 完全打不通（那时中继是唯一选项，
 * 分数再烂也会被选上），否则一律优先直连」。
 *
 * 注意：**Steam 没有"SDR 启用/禁用"这个开关**，罚分是唯一可用的杠杆。
 * 严格意义上的"禁用中继"做不到；"让中继只在直连失败时兜底"可以，
 * 这也正是我们想要的 —— 直连打不通时还能连上，而不是彻底连不上。
 */
const SDR_PENALTY_PREFER_DIRECT = 10000;

/**
 * 传输偏好的三档预设。每档只覆盖 ICE / SDR 相关的四项，
 * 其余参数仍走 DEFAULTS；逐项环境变量与显式 overrides 依旧能把预设里的某一项单独改掉。
 *
 * auto  —— 默认：不偏袒，谁 ping 低用谁（SDK 出厂行为）
 * ice   —— 强制直连：共享全部候选类型，SDR 加 10000ms 罚分，直连失败才回落中继
 * relay —— 强制中继：不共享任何 ICE 候选，只能走 SDR
 */
const TRANSPORT_PRESETS = {
  auto: {
    iceEnable: ICE_PUBLIC | ICE_PRIVATE,
    icePenalty: 0,
    sdrPenalty: 0,
  },
  ice: {
    iceEnable: ICE_ALL,
    icePenalty: 0,
    sdrPenalty: SDR_PENALTY_PREFER_DIRECT,
  },
  relay: {
    iceEnable: ICE_DISABLED,
    icePenalty: 0,
    sdrPenalty: 0,
  },
};

const TRANSPORT_MODES = Object.keys(TRANSPORT_PRESETS);
const DEFAULT_TRANSPORT = 'ice';

/** 传输偏好走单独的环境变量，不进 ENV_KEYS（它不是数值项）。 */
const TRANSPORT_ENV = 'SHL_STEAM_TRANSPORT';

/** 归一化传输偏好：认不出来的写法退回默认并留一条 note。 */
function parseTransport(raw, notes = []) {
  if (raw === undefined || raw === null) return DEFAULT_TRANSPORT;
  const text = String(raw).trim().toLowerCase();
  if (!text) return DEFAULT_TRANSPORT;
  if (TRANSPORT_MODES.includes(text)) return text;
  // 顺手认几个同义写法，省得记不住档位名
  const alias = { direct: 'ice', p2p: 'ice', sdr: 'relay', relayed: 'relay' };
  if (alias[text]) return alias[text];
  notes.push(`${TRANSPORT_ENV} 只认 ${TRANSPORT_MODES.join(' / ')}（收到 ${JSON.stringify(String(raw))}），已用默认的 ${DEFAULT_TRANSPORT}`);
  return DEFAULT_TRANSPORT;
}

/**
 * 默认下发的一组值。每一项都可以用 SHL_STEAM_* 环境变量或显式 overrides 覆盖。
 * 值为 null 表示"不下发这一项"。
 */
const DEFAULTS = {
  // 可靠发送缓冲。满了 sendMessage 会返回 k_EResultLimitExceeded，
  // 我们在 steam-adapter 里对失败返回 -1 —— 也就是说缓冲小了会直接丢数据。
  sendBufferSize: 2 * MB,
  // 接收缓冲。对端突发时本机来不及取，缓冲小了 Steam 会丢。
  recvBufferSize: 2 * MB,
  // 单次能积压的接收消息**条数**上限。我们每泵最多取 maxMessageBatch(默认 128) 条，
  // 主线程被 IPC / 内存看护挤到时这条数就是安全垫。
  recvBufferMessages: 2048,
  // 发送速率上下限（字节/秒）。**null = 不下发这一项**，保留 Steam 出厂值 256 KiB/s。
  //
  // ★ 这里绝不能写 0，也绝不能"手动定一个不算大的值"。实测结论（tools/steam-sendrate-probe.cjs
  //   与 tools/steam-sendrate-scan-probe.cjs 的逐值扫描）：
  //   - 不下发时 Steam 出厂值是 SendRateMin = SendRateMax = 262144（头文件：default value is 256K）；
  //   - 下发 0 会被 Valve 的 SNP_ClampSendRate() 夹成 **1024 B/s**（硬下限就是 1024，128/512/1023 全变 1024）；
  //   - 更致命的是同一个函数里 `if (nMin == nMax)` 会**关掉带宽估计**、把发送速率钉死在该值上，
  //     而下面"两者必须一致"的逻辑保证了 min 永远等于 max ⇒ 0/0 等于把每条连接钉死在 1 KiB/s。
  //   现场那条隧道的 0.9 KiB/s、以及"吞吐随连接数线性增长"（1/4/12 条 → 0.9/3.1/8.5 KiB/s，
  //   也就是每条各自被钉在 1 KiB/s）都和这个数字严丝合缝。
  //
  // 历史：原本照抄 chunyu-vpn 把上下限一起钉死在 4 MB/s，实测在 120ms RTT 的公网中继线路上有害
  // （12.6 KiB 的文件卡了 2606 ms；两条并发流合计 182 KiB/s，反而比单流 430 KiB/s 更慢），
  // 于是改成了 0 —— 但"0 = 不限速"这个理解是错的，正确做法是**不下发**（null）。
  // 确实要手动定速时才用 SHL_STEAM_SEND_RATE，并且要接受"钉死、关掉拥塞控制"这个语义。
  sendRateMin: null,
  sendRateMax: null,
  // Nagle 时间（微秒）。小于 MTU 的消息默认会先攒一小会儿再发；游戏的小包正是这一类，
  // 设为 0 等于全局关掉这个攒包延迟。我们在发送标志里已经带了 NoNagle，
  // 这里是再钉一道，覆盖那些没带标志的路径。
  nagleTime: 0,
  // ★ 建连握手的超时（毫秒）。**Steam 出厂值是 10 秒**（头文件 steamnetworkingtypes.h:1146
  //   k_ESteamNetworkingConfig_TimeoutInitial = 24，注释「Timeout value (in ms) to use when
  //   first connecting」）。
  //
  //   为什么必须调：这条线路上**成功的握手本身就要 6.8 / 9.4 / 17.4 秒**（0.12.8 隧道日志实测，
  //   client-added 到"连接已接通"的间隔）。10 秒的出厂值会把一大批"本来能成"的连接判死，
  //   Steam 给出的结束原因是 5003 k_ESteamNetConnectionEnd_Misc_Timeout，日志里写作
  //   "Timed out attempting to connect"。0.12.8 上线后 startup.log 的直方图：
  //   **5003 出现 25 次，而正常结束（1000）只有 15 次** —— 这就是"极其不稳定、很容易卡"的真身。
  //
  //   30 秒 ≈ 实测最慢一次（17.4 秒）的两倍，够 ICE 打洞走完再回落到 SDR 中继。
  //   想恢复出厂行为就设 SHL_STEAM_TIMEOUT_INITIAL=10000。
  timeoutInitial: 30000,
  // 连上之后的空闲/无响应超时。**不下发**（null）：Steam 的出厂值对长连接是合适的，
  //   贸然调小会把"慢但在动"的隧道判死 —— 这个坑以前踩过一次，见
  //   network/steam-adapter.cjs 里 PEER_PAUSE_ABORT_MS 上方那段注释。
  timeoutConnected: null,
  // 允许共享哪几类 ICE 候选。默认只给局域网，公网直连就没戏；
  // Public | Private 才允许 STUN 反射地址，也就是公网直连。
  iceEnable: ICE_PUBLIC | ICE_PRIVATE,
  // 路由选择打分时的附加惩罚（单位毫秒），0 = 不偏袒任何一侧，谁 ping 低用谁。
  icePenalty: 0,
  sdrPenalty: 0,
  // 不下发：允许**未认证**连接。这是降低安全门槛的口子，对外只开给好友的用法不需要它。
  ipAllowWithoutAuth: null,
  // 不下发：UDP 包载荷上限。改大能减少大块 TCP 的分片数，但会引入分片风险，
  // 想调的人自己显式开。
  mtuPacketSize: null,
};

/** 环境变量名 → DEFAULTS 的键。 */
const ENV_KEYS = {
  sendBufferSize: 'SHL_STEAM_SEND_BUFFER',
  recvBufferSize: 'SHL_STEAM_RECV_BUFFER',
  recvBufferMessages: 'SHL_STEAM_RECV_MESSAGES',
  sendRateMin: 'SHL_STEAM_SEND_RATE',
  sendRateMax: 'SHL_STEAM_SEND_RATE',
  nagleTime: 'SHL_STEAM_NAGLE_TIME',
  timeoutInitial: 'SHL_STEAM_TIMEOUT_INITIAL',
  timeoutConnected: 'SHL_STEAM_TIMEOUT_CONNECTED',
  iceEnable: 'SHL_STEAM_ICE_ENABLE',
  icePenalty: 'SHL_STEAM_ICE_PENALTY',
  sdrPenalty: 'SHL_STEAM_SDR_PENALTY',
  ipAllowWithoutAuth: 'SHL_STEAM_IP_ALLOW_NO_AUTH',
  mtuPacketSize: 'SHL_STEAM_MTU',
};

/** 下发顺序：先缓冲与速率，再 Nagle，最后才是路由选择与认证相关的开关。 */
const APPLY_ORDER = [
  'timeoutInitial',
  'timeoutConnected',
  'sendBufferSize',
  'recvBufferSize',
  'recvBufferMessages',
  'sendRateMin',
  'sendRateMax',
  'nagleTime',
  'mtuPacketSize',
  'iceEnable',
  'icePenalty',
  'sdrPenalty',
  'ipAllowWithoutAuth',
];

/** 每个键对应的 k_ESteamNetworkingConfigValue。 */
const VALUE_ID = {
  sendBufferSize: CONFIG_VALUE.SendBufferSize,
  recvBufferSize: CONFIG_VALUE.RecvBufferSize,
  recvBufferMessages: CONFIG_VALUE.RecvBufferMessages,
  sendRateMin: CONFIG_VALUE.SendRateMin,
  sendRateMax: CONFIG_VALUE.SendRateMax,
  nagleTime: CONFIG_VALUE.NagleTime,
  timeoutInitial: CONFIG_VALUE.TimeoutInitial,
  timeoutConnected: CONFIG_VALUE.TimeoutConnected,
  mtuPacketSize: CONFIG_VALUE.MTU_PacketSize,
  iceEnable: CONFIG_VALUE.P2P_Transport_ICE_Enable,
  icePenalty: CONFIG_VALUE.P2P_Transport_ICE_Penalty,
  sdrPenalty: CONFIG_VALUE.P2P_Transport_SDR_Penalty,
  ipAllowWithoutAuth: CONFIG_VALUE.IP_AllowWithoutAuth,
};

/** 人类可读的名字，进报告用，日志里比数字好认。 */
const LABEL = {
  sendBufferSize: 'SendBufferSize',
  recvBufferSize: 'RecvBufferSize',
  recvBufferMessages: 'RecvBufferMessages',
  sendRateMin: 'SendRateMin',
  sendRateMax: 'SendRateMax',
  nagleTime: 'NagleTime',
  timeoutInitial: 'TimeoutInitial',
  timeoutConnected: 'TimeoutConnected',
  mtuPacketSize: 'MTU_PacketSize',
  iceEnable: 'P2P_Transport_ICE_Enable',
  icePenalty: 'P2P_Transport_ICE_Penalty',
  sdrPenalty: 'P2P_Transport_SDR_Penalty',
  ipAllowWithoutAuth: 'IP_AllowWithoutAuth',
};

/** 解析一个十进制整数；带 m/M 后缀按 MB 算，纯数字按字节算。解析不了返回 null。 */
function parseIntLoose(raw) {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const match = /^(-?\d+)\s*(m|mb)?$/i.exec(text);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  return match[2] ? base * MB : base;
}

/**
 * 解析最终要下发的值。优先级：overrides > 环境变量 > 默认值。
 *
 * @param {object} [overrides]
 * @param {object} [env]
 * @returns {{ values:object, notes:string[], changed:string[] }}
 */
function resolveNetConfig(overrides = {}, env = process.env) {
  const notes = [];
  const changed = [];
  const values = {};

  // 传输偏好先定下来：它给 ICE / SDR 那几项提供"基线默认值"。
  // 下面的逐项环境变量与显式 overrides 依旧能把预设里的某一项单独盖掉，
  // 所以"选 ice 档 + 再把 sdrPenalty 调成别的"这种组合是合法的。
  const transportRaw = overrides && overrides.transport !== undefined
    ? overrides.transport
    : (env ? env[TRANSPORT_ENV] : undefined);
  const transport = parseTransport(transportRaw, notes);
  const base = { ...DEFAULTS, ...TRANSPORT_PRESETS[transport] };

  const sources = {};
  for (const key of APPLY_ORDER) {
    const fallback = base[key];
    let value = fallback;
    let source = 'default';

    const envKey = ENV_KEYS[key];
    const rawEnv = envKey && env ? env[envKey] : undefined;
    if (rawEnv !== undefined && rawEnv !== null && String(rawEnv).trim() !== '') {
      const parsed = parseIntLoose(rawEnv);
      if (parsed === null) {
        notes.push(`${envKey} 不是合法数字（收到 ${JSON.stringify(String(rawEnv))}），已退回默认值`);
      } else {
        value = parsed;
        source = 'env';
      }
    }

    if (overrides && Object.prototype.hasOwnProperty.call(overrides, key) && overrides[key] !== undefined) {
      const raw = overrides[key];
      if (raw === null) {
        value = null;
        source = 'override';
      } else {
        const parsed = typeof raw === 'number' && Number.isFinite(raw) ? raw : parseIntLoose(raw);
        if (parsed === null) {
          notes.push(`显式传入的 ${key} 不是合法数字（收到 ${JSON.stringify(String(raw))}），已忽略`);
        } else {
          value = parsed;
          source = 'override';
        }
      }
    }

    values[key] = value;
    // source 只在有意义的地方留痕，避免默认情况刷屏
    if (source !== 'default') sources[key] = source;
  }

  // SendRateMin 与 SendRateMax 必须一致，否则 Steam 的行为没有定义（SDK 文档明确要求）。
  const minExplicit = sources.sendRateMin !== undefined;
  const maxExplicit = sources.sendRateMax !== undefined;
  if (values.sendRateMin !== null && values.sendRateMax !== null && values.sendRateMin !== values.sendRateMax) {
    if (minExplicit !== maxExplicit) {
      // 只有一侧是显式给的：以显式那一侧为准，另一侧跟着走。
      // 否则"只把上限调到 8MB"会被默认的下限 4MB 拽回来，等于没调。
      const chosen = minExplicit ? values.sendRateMin : values.sendRateMax;
      values.sendRateMin = chosen;
      values.sendRateMax = chosen;
    } else {
      const pinned = Math.min(values.sendRateMin, values.sendRateMax);
      notes.push(`SendRateMin(${values.sendRateMin}) 与 SendRateMax(${values.sendRateMax}) 不一致，`
        + `SDK 要求两者相同，已一并取较小的 ${pinned}`);
      values.sendRateMin = pinned;
      values.sendRateMax = pinned;
    }
  }
  // 只设了一侧、另一侧被显式关掉（null）时，也把另一侧补成同值，保持"手动定速"的语义。
  if (values.sendRateMin !== null && values.sendRateMax === null) values.sendRateMax = values.sendRateMin;
  if (values.sendRateMax !== null && values.sendRateMin === null) values.sendRateMin = values.sendRateMax;

  // 显式定速时提醒一句：这一项一旦设了就是"钉死 + 关掉带宽估计"，设小了会直接毁掉吞吐。
  if (values.sendRateMax !== null && Number.isFinite(values.sendRateMax) && values.sendRateMax <= 1024) {
    notes.push(`发送速率被钉在 ${values.sendRateMax} B/s：Steam 的下限是 1024 B/s（更小的值会被夹到 1024），`
      + '而且 min == max 会让 Steam 关掉带宽估计。想恢复自适应就别设这一项。');
  }

  // changed 在补值之后再算，否则记录的是"改了一半"的中间值。
  for (const key of APPLY_ORDER) {
    const value = values[key];
    if (value === null && base[key] !== null) changed.push(`${LABEL[key]}=跳过`);
    else if (value !== null && value !== base[key]) changed.push(`${LABEL[key]}=${value}`);
  }
  for (const key of Object.keys(sources)) values[`${key}Source`] = sources[key];

  return { values, notes, changed, transport };
}

/** 拿到 NetworkingUtils 接口与它的 libraryLoader；任何一步不可用返回 null。 */
function utilsHandle(steam) {
  const candidates = [steam && steam.networkingUtils, steam && steam.networkingSockets];
  for (const manager of candidates) {
    if (!manager) continue;
    const loader = manager.libraryLoader;
    if (!loader) continue;
    if (typeof loader.SteamAPI_SteamNetworkingUtils_SteamAPI !== 'function') continue;
    let iface = null;
    try {
      iface = loader.SteamAPI_SteamNetworkingUtils_SteamAPI();
    } catch (err) {
      iface = null;
    }
    if (!iface) continue;
    return { loader, iface, manager };
  }
  return null;
}

/**
 * 声明绑定里缺失的符号。
 * 绑定只在 load() 时声明它自己要用到的函数，设置全局参数这一族从来没人用过，
 * 所以这里直接从底层 koffi 库句柄上补声明（getLibrary() 是 loader 的公开方法）。
 *
 * **踩过的坑**：一开始按 C++ 重载名写成 `..._SetConfigValueInt32`，koffi 直接报
 * `Cannot find function 'SteamAPI_ISteamNetworkingUtils_SetConfigValueInt32' in shared library`。
 * 解析 steam_api64.dll 的 PE 导出表（1078 个符号）后确认：**这个符号根本不存在**。
 * 真正的名字是：
 *   · `SteamAPI_ISteamNetworkingUtils_SetGlobalConfigValueInt32(iface, eValue, nValue)`  ← 全局作用域专用，最好用
 *   · `SteamAPI_ISteamNetworkingUtils_SetConfigValue(iface, eValue, eScope, scopeObj, eDataType, pArg)`
 *   · `SteamAPI_ISteamNetworkingUtils_SetConnectionConfigValueInt32(...)`                 ← 连接作用域
 * typed 变体只按 **作用域** 分（Global / Connection），不按数据类型分（Int32 是类型不是作用域）。
 * 所以优先用 SetGlobalConfigValueInt32；万一别的 SDK 版本只有通用版，再退到 SetConfigValue。
 */
function bindMissingSymbols(loader) {
  const lib = typeof loader.getLibrary === 'function' ? loader.getLibrary() : null;
  if (!lib || typeof lib.func !== 'function') return null;

  let setInt32 = null;
  let globalScope = true;
  let getValue = null;
  const failures = [];

  try {
    setInt32 = lib.func(
      'SteamAPI_ISteamNetworkingUtils_SetGlobalConfigValueInt32',
      'bool',
      ['void*', 'int', 'int'],
    );
  } catch (err) {
    failures.push('SetGlobalConfigValueInt32: ' + (err && err.message ? err.message : String(err)));
  }

  if (!setInt32) {
    try {
      setInt32 = lib.func(
        'SteamAPI_ISteamNetworkingUtils_SetConfigValue',
        'bool',
        ['void*', 'int', 'int', 'int64', 'int', 'void*'],
      );
      globalScope = false;
    } catch (err) {
      failures.push('SetConfigValue: ' + (err && err.message ? err.message : String(err)));
    }
  }

  try {
    getValue = lib.func(
      'SteamAPI_ISteamNetworkingUtils_GetConfigValue',
      'int',
      ['void*', 'int', 'int', 'int64', 'void*', 'void*', 'void*'],
    );
  } catch (err) {
    failures.push('GetConfigValue: ' + (err && err.message ? err.message : String(err)));
  }

  if (!setInt32) return null;
  return { setInt32, globalScope, getValue, failures };
}

/** 按绑定到的是哪一个入口，用对应的调用形式下发一项 int32。 */
function setInt32Value(bound, iface, valueId, value) {
  if (bound.globalScope) return Boolean(bound.setInt32(iface, valueId, value));
  // 通用版：作用域 Global、作用域对象 0、数据类型 Int32、值按指针传。
  const box = Buffer.alloc(8);
  box.writeInt32LE(Number(value) | 0, 0);
  return Boolean(bound.setInt32(iface, valueId, CONFIG_SCOPE_GLOBAL, 0, CONFIG_TYPE_INT32, box));
}

/** 读回一项当前生效的 int32 值。读不到返回 null（不抛）。 */
function readBackInt32(bound, iface, valueId) {
  if (!bound || typeof bound.getValue !== 'function') return null;
  try {
    const dataType = Buffer.alloc(4);
    const result = Buffer.alloc(8);
    const cbResult = Buffer.alloc(8);
    cbResult.writeBigUInt64LE(8n, 0);
    const rc = bound.getValue(iface, valueId, CONFIG_SCOPE_GLOBAL, 0, dataType, result, cbResult);
    // OK_INHERITED 也算数：它返回的是当前**生效**值（只是没在这一层显式设过）。
    if (rc !== GET_OK && rc !== GET_OK_INHERITED) return null;
    if (dataType.readInt32LE(0) !== CONFIG_TYPE_INT32) return null;
    return result.readInt32LE(0);
  } catch (err) {
    return null;
  }
}

/**
 * 把一组全局参数下发给 Steam，并逐项读回核对。
 *
 * @param {object} steam     已初始化的 steam 模块
 * @param {object} [options] 覆盖 DEFAULTS 的值（键名见 DEFAULTS）
 * @param {object} [env]     环境变量表，测试用
 * @returns {{ available:boolean, reason:string|null, transport:string, applied:Array, notes:string[], values:object, changed:string[] }}
 */
function applyNetConfig(steam, options = {}, env = process.env) {
  const { values, notes, changed, transport } = resolveNetConfig(options, env);
  const blank = { available: false, reason: null, transport, applied: [], notes, values, changed };

  const handle = utilsHandle(steam);
  if (!handle) {
    blank.reason = '拿不到 ISteamNetworkingUtils 接口，Steam 全局网络参数未下发';
    return blank;
  }

  const bound = bindMissingSymbols(handle.loader);
  if (!bound) {
    blank.reason = 'Steamworks 库没有导出 SetGlobalConfigValueInt32 / SetConfigValue，无法下发全局网络参数'
      + '（Steamworks SDK redistributable 版本可能过旧）';
    return blank;
  }
  if (bound.failures && bound.failures.length) {
    notes.push('部分符号声明失败，读回核对会缺失：' + bound.failures.join('；'));
  }

  const applied = [];
  for (const key of APPLY_ORDER) {
    const value = values[key];
    if (value === null) continue; // 显式跳过
    const valueId = VALUE_ID[key];
    const label = LABEL[key];

    let ok = false;
    let error = null;
    try {
      ok = setInt32Value(bound, handle.iface, valueId, value);
    } catch (err) {
      error = err && err.message ? err.message : String(err);
    }

    const effective = readBackInt32(bound, handle.iface, valueId);
    const entry = { key, name: label, valueId, requested: value, ok, effective };

    if (error) {
      entry.note = '调用抛错：' + error;
    } else if (!ok) {
      entry.note = 'SetConfigValue 返回 false，这一项没生效';
    } else if (effective === null) {
      entry.note = '已下发，但读不回来（GetConfigValue 不可用），无法核对';
    } else if (effective !== value) {
      entry.note = `已下发但读回的是 ${effective}，与请求值不符`;
    }
    applied.push(entry);
  }

  const failed = applied.filter((e) => !e.ok || (e.effective !== null && e.effective !== e.requested));
  if (failed.length) {
    notes.push(`有 ${failed.length} 项没有生效：` + failed.map((e) => e.name).join('、'));
  }

  return { available: true, reason: null, transport, applied, notes, values, changed };
}

/** 传输偏好的人类可读名字，进报告用。 */
const TRANSPORT_LABEL = {
  auto: '自动（谁 ping 低用谁）',
  ice: '强制直连（SDR 中继只在打不通时兜底）',
  relay: '强制中继（不共享 ICE 候选）',
};

/** 把报告压成几行日志文本。没有可用信息时返回空数组。 */
function formatNetConfigReport(report) {
  if (!report) return [];
  const lines = [];
  const mode = TRANSPORT_LABEL[report.transport] || report.transport || '未指定';
  if (!report.available) {
    lines.push('[SteamNetConfig] 未下发：' + (report.reason || '原因未知') + `（传输偏好 ${mode}）`);
    for (const note of report.notes || []) lines.push('[SteamNetConfig] ' + note);
    return lines;
  }

  const shown = (report.applied || []).map((e) => {
    const actual = e.effective === null ? '未核对' : String(e.effective);
    return `${e.name}=${e.requested}(实际 ${actual})`;
  });
  lines.push('[SteamNetConfig] 传输偏好：' + mode);
  if (shown.length) lines.push('[SteamNetConfig] 已下发 ' + shown.length + ' 项：' + shown.join('，'));

  for (const note of report.notes || []) lines.push('[SteamNetConfig] ' + note);
  return lines;
}

module.exports = {
  CONFIG_VALUE,
  CONFIG_SCOPE_GLOBAL,
  CONFIG_TYPE_INT32,
  ICE_DISABLED,
  ICE_PRIVATE,
  ICE_PUBLIC,
  ICE_ALL,
  SDR_PENALTY_PREFER_DIRECT,
  TRANSPORT_PRESETS,
  TRANSPORT_MODES,
  TRANSPORT_ENV,
  TRANSPORT_LABEL,
  DEFAULT_TRANSPORT,
  DEFAULTS,
  ENV_KEYS,
  APPLY_ORDER,
  VALUE_ID,
  LABEL,
  resolveNetConfig,
  applyNetConfig,
  formatNetConfigReport,
  // 导出给测试用
  parseIntLoose,
  parseTransport,
  utilsHandle,
  bindMissingSymbols,
  setInt32Value,
  readBackInt32,
};
