'use strict';
// network/steam-netconfig.cjs 的单元测试。
//
// 这里全部用假 steam 对象跑，不需要真的 Steam 环境 —— 真实下发由
// tools/steam-netconfig-probe.cjs 负责验证。

const test = require('node:test');
const assert = require('node:assert');

const netconfig = require('../network/steam-netconfig.cjs');

const {
  DEFAULTS,
  ENV_KEYS,
  APPLY_ORDER,
  CONFIG_VALUE,
  ICE_DISABLED,
  ICE_PRIVATE,
  ICE_PUBLIC,
  ICE_ALL,
  SDR_PENALTY_PREFER_DIRECT,
  TRANSPORT_ENV,
  DEFAULT_TRANSPORT,
  resolveNetConfig,
  applyNetConfig,
  formatNetConfigReport,
  parseIntLoose,
  parseTransport,
  utilsHandle,
} = netconfig;

const MB = 1024 * 1024;

/**
 * 造一个假的 steamsdk：
 *   * loader 有 SteamAPI_SteamNetworkingUtils_SteamAPI（返回接口指针）
 *   * loader.getLibrary() 返回的对象上 func() 能声明出我们要的两个符号
 * 行为可用 options 调：setResults 决定每项 SetConfigValue 返回什么，
 * readValues 决定读回的值（默认读回请求值）。
 */
function fakeSteam(options = {}) {
  const calls = [];
  const reads = [];
  const sets = [];
  const setResults = options.setResults || {};
  const readValues = options.readValues || {};
  const noGetLibrary = Boolean(options.noGetLibrary);
  const noSetSymbol = Boolean(options.noSetSymbol);
  const noGlobalSymbol = Boolean(options.noGlobalSymbol);
  const throwOnSet = Boolean(options.throwOnSet);
  const setReturnsNonBoolean = Boolean(options.setReturnsNonBoolean);

  const library = {
    func(name) {
      // 真名是 SetGlobalConfigValueInt32（已解析 steam_api64.dll 的 PE 导出表确认：
      // ..._SetConfigValueInt32 这个符号在 DLL 里根本不存在）。
      if (name === 'SteamAPI_ISteamNetworkingUtils_SetGlobalConfigValueInt32') {
        if (noSetSymbol || noGlobalSymbol) throw new Error('symbol not found: ' + name);
        return (...args) => {
          const [, valueId, value] = args;
          calls.push({ name, args });
          if (throwOnSet) throw new Error('boom');
          sets.push({ valueId, value });
          if (Object.prototype.hasOwnProperty.call(setResults, valueId)) return setResults[valueId];
          return setReturnsNonBoolean ? 1 : true;
        };
      }
      // 只有全局专用入口缺失时才会退到通用版：作用域与数据类型变成显式参数，值按指针传。
      if (name === 'SteamAPI_ISteamNetworkingUtils_SetConfigValue') {
        if (!noGlobalSymbol) throw new Error('unexpected symbol ' + name);
        return (...args) => {
          const [, valueId, scope, scopeObj, dataType, box] = args;
          calls.push({ name, args });
          if (throwOnSet) throw new Error('boom');
          const value = Buffer.isBuffer(box) ? box.readInt32LE(0) : box;
          sets.push({ valueId, value, scope, scopeObj, dataType });
          if (Object.prototype.hasOwnProperty.call(setResults, valueId)) return setResults[valueId];
          return setReturnsNonBoolean ? 1 : true;
        };
      }
      if (name === 'SteamAPI_ISteamNetworkingUtils_GetConfigValue') {
        return (iface, valueId, scope, scopeObj, dataType, result, cbResult) => {
          reads.push({ valueId });
          if (Object.prototype.hasOwnProperty.call(readValues, valueId)
            && readValues[valueId] === null) {
            return -1; // k_ESteamNetworkingGetConfigValue_BadValue
          }
          dataType.writeInt32LE(1, 0); // Int32
          const value = Object.prototype.hasOwnProperty.call(readValues, valueId)
            ? readValues[valueId]
            : (sets.find((s) => s.valueId === valueId) || { value: 0 }).value;
          result.writeInt32LE(value, 0);
          if (cbResult) cbResult.writeBigUInt64LE(8n, 0);
          return 1; // OK
        };
      }
      throw new Error('unexpected symbol ' + name);
    },
  };

  const loader = {
    SteamAPI_SteamNetworkingUtils_SteamAPI: () => ({ __iface: true }),
  };
  if (!noGetLibrary) loader.getLibrary = () => library;

  const steam = { networkingUtils: { libraryLoader: loader } };
  return { steam, calls, reads, sets };
}

// ---------------------------------------------------------------- parseIntLoose

test('parseIntLoose：纯数字按字节，带 m/M 后缀按 MB', () => {
  assert.strictEqual(parseIntLoose('1024'), 1024);
  assert.strictEqual(parseIntLoose(2048), 2048);
  assert.strictEqual(parseIntLoose('2m'), 2 * MB);
  assert.strictEqual(parseIntLoose('2MB'), 2 * MB);
  assert.strictEqual(parseIntLoose(' 3 M '), 3 * MB);
});

test('parseIntLoose：空与非法值返回 null', () => {
  assert.strictEqual(parseIntLoose(''), null);
  assert.strictEqual(parseIntLoose('   '), null);
  assert.strictEqual(parseIntLoose(null), null);
  assert.strictEqual(parseIntLoose(undefined), null);
  assert.strictEqual(parseIntLoose('abc'), null);
  assert.strictEqual(parseIntLoose('12x'), null);
});

// -------------------------------------------------------------- resolveNetConfig

test('resolveNetConfig：默认值就是照 chunyu-vpn 定的那一组（发送速率除外）', () => {
  const { values, notes, changed, transport } = resolveNetConfig({}, {});
  assert.strictEqual(values.sendBufferSize, 2 * MB);
  assert.strictEqual(values.recvBufferSize, 2 * MB);
  assert.strictEqual(values.recvBufferMessages, 2048);
  // 发送速率是唯一一组**故意不跟** chunyu-vpn 的：它把上下限一起钉死在 4MB/s。
  // 默认现在是 null（不下发），保留 Steam 出厂值 262144 —— 写 0 会被夹成 1024 B/s，
  // 而且 min == max 会让 Steam 关掉带宽估计、把速率钉死，等于每条连接只有 1 KiB/s。
  assert.strictEqual(values.sendRateMin, null);
  assert.strictEqual(values.sendRateMax, null);
  assert.strictEqual(values.nagleTime, 0);
  // 默认档位是"强制直连"：共享全部候选类型 + 给 SDR 一个很大的毫秒罚分。
  assert.strictEqual(transport, 'ice');
  assert.strictEqual(values.iceEnable, ICE_ALL);
  assert.strictEqual(values.icePenalty, 0);
  assert.strictEqual(values.sdrPenalty, SDR_PENALTY_PREFER_DIRECT);
  // 放宽认证的口子默认不能开
  assert.strictEqual(values.ipAllowWithoutAuth, null);
  // 默认情况下没有任何改动，也不该有噪音 notes
  assert.deepStrictEqual(changed, []);
  assert.deepStrictEqual(notes, []);
});

test('resolveNetConfig：transport=auto 回到 SDK 出厂行为（不偏袒任何一侧）', () => {
  const { values, notes, transport } = resolveNetConfig({ transport: 'auto' }, {});
  assert.strictEqual(transport, 'auto');
  assert.strictEqual(values.iceEnable, ICE_PUBLIC | ICE_PRIVATE);
  assert.strictEqual(values.icePenalty, 0);
  assert.strictEqual(values.sdrPenalty, 0);
  assert.deepStrictEqual(notes, []);
});

test('resolveNetConfig：transport=relay 干脆不共享 ICE 候选', () => {
  const { values, transport } = resolveNetConfig({ transport: 'relay' }, {});
  assert.strictEqual(transport, 'relay');
  assert.strictEqual(values.iceEnable, ICE_DISABLED);
  assert.strictEqual(values.sdrPenalty, 0);
});

test('resolveNetConfig：SHL_STEAM_TRANSPORT 环境变量同样能选档位', () => {
  const { transport, values } = resolveNetConfig({}, { [TRANSPORT_ENV]: 'auto' });
  assert.strictEqual(transport, 'auto');
  assert.strictEqual(values.sdrPenalty, 0);
  // 显式 overrides 优先于环境变量
  const both = resolveNetConfig({ transport: 'relay' }, { [TRANSPORT_ENV]: 'auto' });
  assert.strictEqual(both.transport, 'relay');
});

test('resolveNetConfig：认不出的档位退回默认并留 note', () => {
  const { transport, notes } = resolveNetConfig({ transport: 'turbo' }, {});
  assert.strictEqual(transport, DEFAULT_TRANSPORT);
  assert.strictEqual(notes.length, 1);
  assert.ok(notes[0].includes('turbo'));
});

test('resolveNetConfig：档位只提供基线，逐项值依旧能单独盖掉', () => {
  const { values, transport } = resolveNetConfig({ transport: 'ice', sdrPenalty: 500 }, {});
  assert.strictEqual(transport, 'ice');
  // 预设说 10000，显式给了 500 就用 500 —— 否则"选了档位就没法微调"。
  assert.strictEqual(values.sdrPenalty, 500);
  assert.strictEqual(values.sdrPenaltySource, 'override');
  // 没被显式盖掉的那几项仍跟着档位走
  assert.strictEqual(values.iceEnable, ICE_ALL);
});

test('resolveNetConfig：环境变量能覆盖默认值', () => {
  const env = { [ENV_KEYS.sendBufferSize]: String(8 * MB) };
  const { values } = resolveNetConfig({}, env);
  assert.strictEqual(values.sendBufferSize, 8 * MB);
  assert.strictEqual(values.sendBufferSizeSource, 'env');
});

test('resolveNetConfig：SHL_STEAM_SEND_RATE 同时钉死上下限', () => {
  const env = { [ENV_KEYS.sendRateMin]: '6m' };
  const { values } = resolveNetConfig({}, env);
  assert.strictEqual(values.sendRateMin, 6 * MB);
  assert.strictEqual(values.sendRateMax, 6 * MB);
});

test('resolveNetConfig：显式 overrides 优先于环境变量', () => {
  const env = { [ENV_KEYS.sendRateMin]: '6m' };
  const { values } = resolveNetConfig({ sendRateMin: 1024 }, env);
  assert.strictEqual(values.sendRateMin, 1024);
  assert.strictEqual(values.sendRateMinSource, 'override');
});

test('resolveNetConfig：min/max 不一致时取小值并留说明', () => {
  const { values, notes } = resolveNetConfig({ sendRateMin: 3 * MB, sendRateMax: 9 * MB }, {});
  assert.strictEqual(values.sendRateMin, 3 * MB);
  assert.strictEqual(values.sendRateMax, 3 * MB);
  assert.ok(notes.some((n) => n.includes('SendRateMin') && n.includes('SendRateMax')));
});

test('resolveNetConfig：只设一侧时把另一侧补成同值', () => {
  const a = resolveNetConfig({ sendRateMax: 5 * MB }, {});
  assert.strictEqual(a.values.sendRateMin, 5 * MB);
  const b = resolveNetConfig({ sendRateMin: 7 * MB }, {});
  assert.strictEqual(b.values.sendRateMax, 7 * MB);
});

test('resolveNetConfig：只调上限不会被默认下限拽回来', () => {
  // 默认上下限都是 4MB。只把上限调到 8MB 时，下限必须跟着变成 8MB，
  // 而不是因为"两者不一致"被一起压回 4MB —— 那样等于没调。
  const { values, notes } = resolveNetConfig({ sendRateMax: 8 * MB }, {});
  assert.strictEqual(values.sendRateMax, 8 * MB);
  assert.strictEqual(values.sendRateMin, 8 * MB);
  assert.deepStrictEqual(notes, []);
});

test('resolveNetConfig：两侧都没显式给时保持默认不动', () => {
  const { values, changed } = resolveNetConfig({}, {});
  assert.strictEqual(values.sendRateMin, DEFAULTS.sendRateMin);
  assert.strictEqual(values.sendRateMax, DEFAULTS.sendRateMax);
  assert.deepStrictEqual(changed, []);
});

test('timeoutInitial：默认放宽到 30 秒（出厂 10 秒会把 7~18 秒的握手判死）', () => {
  // 现场证据（0.12.8 的 startup.log）：加入者每次新建 P2P 连接都要重新握手，
  // 而这条线路上**成功的握手本身就要 6.8 / 9.4 / 17.4 秒**；
  // 出厂 TimeoutInitial 是 10 秒，正好卡在分布中间 —— 于是日志里
  // 5003（k_ESteamNetConnectionEnd_Misc_Timeout）出现 25 次，正常结束只有 15 次。
  assert.strictEqual(netconfig.VALUE_ID.timeoutInitial, 24);
  assert.strictEqual(netconfig.LABEL.timeoutInitial, 'TimeoutInitial');
  assert.strictEqual(DEFAULTS.timeoutInitial, 30000);
  assert.strictEqual(resolveNetConfig({}, {}).values.timeoutInitial, 30000);
  // 建连超时必须先于缓冲/速率下发：后面的项失败时至少超时已经放宽了。
  assert.ok(APPLY_ORDER.indexOf('timeoutInitial') < APPLY_ORDER.indexOf('sendBufferSize'));
  // 不写进 changed：它本身就是 DEFAULTS 的一部分，不是"和出厂值不同"。
  assert.deepStrictEqual(resolveNetConfig({}, {}).changed, []);

  const env = resolveNetConfig({}, { [ENV_KEYS.timeoutInitial]: '10000' });
  assert.strictEqual(env.values.timeoutInitial, 10000);
  assert.ok(env.changed.includes('TimeoutInitial=10000'), '覆盖时要如实报出与默认值的差别');

  // 连上之后的超时不碰：出厂值对"慢但在动"的长连接是合适的，
  // 调小会把隧道判死（这个坑在 steam-adapter 的 PEER_PAUSE_ABORT_MS 注释里记过一次）。
  assert.strictEqual(DEFAULTS.timeoutConnected, null);
  assert.strictEqual(resolveNetConfig({}, {}).values.timeoutConnected, null);
});

test('resolveNetConfig：非法环境变量退回默认并留下 notes', () => {
  const env = { [ENV_KEYS.sendBufferSize]: 'not-a-number' };
  const { values, notes } = resolveNetConfig({}, env);
  assert.strictEqual(values.sendBufferSize, DEFAULTS.sendBufferSize);
  assert.ok(notes.some((n) => n.includes(ENV_KEYS.sendBufferSize)));
});

test('resolveNetConfig：空字符串等于没设置，不产生 notes', () => {
  const env = { [ENV_KEYS.sendBufferSize]: '   ' };
  const { values, notes } = resolveNetConfig({}, env);
  assert.strictEqual(values.sendBufferSize, DEFAULTS.sendBufferSize);
  assert.strictEqual(notes.length, 0);
});

test('resolveNetConfig：显式 null 表示跳过这一项', () => {
  const { values } = resolveNetConfig({ sendBufferSize: null }, {});
  assert.strictEqual(values.sendBufferSize, null);
});

test('resolveNetConfig：可以在环境变量里打开 IP_AllowWithoutAuth', () => {
  const env = { [ENV_KEYS.ipAllowWithoutAuth]: '2' };
  const { values } = resolveNetConfig({}, env);
  assert.strictEqual(values.ipAllowWithoutAuth, 2);
});

test('resolveNetConfig：多次调用不共享内部状态', () => {
  const a = resolveNetConfig({ sendBufferSize: 1 }, {});
  const b = resolveNetConfig({}, {});
  assert.strictEqual(a.values.sendBufferSize, 1);
  assert.strictEqual(b.values.sendBufferSize, DEFAULTS.sendBufferSize);
  assert.notStrictEqual(a.notes, b.notes);
});

// --------------------------------------------------------------------- utilsHandle

test('utilsHandle：拿不到 networkingUtils 时返回 null', () => {
  assert.strictEqual(utilsHandle(null), null);
  assert.strictEqual(utilsHandle({}), null);
  assert.strictEqual(utilsHandle({ networkingUtils: {} }), null);
  // 有 loader 但没有接口访问器
  assert.strictEqual(utilsHandle({ networkingUtils: { libraryLoader: {} } }), null);
  // 访问器抛错也不能把异常冒出去
  const throwing = { networkingUtils: { libraryLoader: {
    SteamAPI_SteamNetworkingUtils_SteamAPI() { throw new Error('nope'); },
  } } };
  assert.strictEqual(utilsHandle(throwing), null);
});

test('utilsHandle：networkingUtils 缺失时退回 networkingSockets 的 loader', () => {
  const loader = { SteamAPI_SteamNetworkingUtils_SteamAPI: () => ({ ok: true }) };
  const handle = utilsHandle({ networkingSockets: { libraryLoader: loader } });
  assert.ok(handle);
  assert.deepStrictEqual(handle.iface, { ok: true });
});

// ------------------------------------------------------------------- applyNetConfig

test('applyNetConfig：逐项下发并读回核对', () => {
  const { steam, sets, reads } = fakeSteam();
  const report = applyNetConfig(steam, {}, {});

  assert.strictEqual(report.available, true);
  assert.strictEqual(report.reason, null);

  // 默认 13 项里 IP_AllowWithoutAuth、MTU、SendRateMin、SendRateMax、TimeoutConnected
  // 是 null，应当被跳过 → 8 项
  assert.strictEqual(report.applied.length, 8);
  assert.ok(!report.applied.some((e) => e.key === 'ipAllowWithoutAuth'));
  assert.ok(!report.applied.some((e) => e.key === 'mtuPacketSize'));
  assert.ok(!report.applied.some((e) => e.key === 'sendRateMin'), '发送速率默认不下发');
  assert.ok(!report.applied.some((e) => e.key === 'sendRateMax'), '发送速率默认不下发');
  assert.ok(!report.applied.some((e) => e.key === 'timeoutConnected'), '连上之后的超时不碰');

  // 每一项都真的调了 SetConfigValue，并且都读回来核对过
  assert.strictEqual(sets.length, 8);
  assert.strictEqual(reads.length, 8);

  for (const entry of report.applied) {
    assert.strictEqual(entry.ok, true);
    assert.strictEqual(entry.effective, entry.requested);
    assert.strictEqual(entry.note, undefined);
  }

  // 数值确实是对应枚举
  const sendBuffer = report.applied.find((e) => e.key === 'sendBufferSize');
  assert.strictEqual(sendBuffer.valueId, CONFIG_VALUE.SendBufferSize);
  assert.strictEqual(sendBuffer.requested, 2 * MB);
  const ice = report.applied.find((e) => e.key === 'iceEnable');
  assert.strictEqual(ice.requested, ICE_ALL);
  assert.strictEqual(report.transport, 'ice');
});

test('applyNetConfig：SetConfigValue 返回 false 时如实标注没生效', () => {
  const { steam } = fakeSteam({ setResults: { [CONFIG_VALUE.NagleTime]: false } });
  const report = applyNetConfig(steam, {}, {});

  const nagle = report.applied.find((e) => e.key === 'nagleTime');
  assert.strictEqual(nagle.ok, false);
  assert.match(nagle.note, /返回 false/);
  assert.ok(report.notes.some((n) => n.includes('NagleTime')));
});

test('applyNetConfig：返回值是 0 而不是 true 时也算失败', () => {
  const { steam } = fakeSteam({ setReturnsNonBoolean: true, setResults: { [CONFIG_VALUE.NagleTime]: 0 } });
  const report = applyNetConfig(steam, {}, {});
  const nagle = report.applied.find((e) => e.key === 'nagleTime');
  assert.strictEqual(nagle.ok, false);
});

test('resolveNetConfig：默认不下发发送速率（回归：写 0 会被 Steam 夹成 1024 B/s 并钉死）', () => {
  // 现场证据：隧道实测 0.9 KiB/s，且吞吐随连接数严格线性（1/4/12 条 → 0.9/3.1/8.5 KiB/s），
  // 也就是每条连接各自被钉在 1 KiB/s。逐值扫描（tools/steam-sendrate-scan-probe.cjs）确认：
  // 下发 0 会被 Valve 的 SNP_ClampSendRate() 夹成 1024（硬下限就是 1024），
  // 而同一个函数里 `if (nMin == nMax)` 会关掉带宽估计、把发送速率钉死在该值上。
  // 更早那次钉死 4MB/s 也是错的，只是方向相反：钉得太高，拥塞时不许降速。
  // 正确做法是**不下发**，保留 Steam 出厂值 262144（256 KiB/s）。
  const { values, changed } = resolveNetConfig({}, {});
  assert.strictEqual(values.sendRateMin, null, '默认必须不下发：写 0 会被夹成 1024 B/s');
  assert.strictEqual(values.sendRateMax, null, '默认必须不下发：min == max 会让 Steam 关掉带宽估计');
  assert.deepStrictEqual(changed, [], '默认值不该被记进 changed');
});

test('applyNetConfig：读回值与请求值不符时点名', () => {
  const { steam } = fakeSteam({ readValues: { [CONFIG_VALUE.SendRateMax]: 12345 } });
  // 显式传入而不是依赖默认值，否则改默认值会连带改坏这条用例的语义
  const report = applyNetConfig(steam, { sendRateMin: 4 * MB, sendRateMax: 4 * MB }, {});
  const rate = report.applied.find((e) => e.key === 'sendRateMax');
  assert.strictEqual(rate.requested, 4 * MB);
  assert.strictEqual(rate.effective, 12345);
  assert.match(rate.note, /读回的是 12345/);
  assert.ok(report.notes.some((n) => n.includes('SendRateMax')));
});

test('applyNetConfig：读不回来时不假装核对过', () => {
  const { steam } = fakeSteam({ readValues: { [CONFIG_VALUE.SendBufferSize]: null } });
  const report = applyNetConfig(steam, {}, {});
  const entry = report.applied.find((e) => e.key === 'sendBufferSize');
  assert.strictEqual(entry.effective, null);
  assert.match(entry.note, /读不回来/);
  // 读不回来不该被算进"没生效"的失败清单
  assert.ok(!report.notes.some((n) => n.includes('没有生效')));
});

test('applyNetConfig：SetConfigValue 抛错时记下来而不是把异常冒出去', () => {
  const { steam } = fakeSteam({ throwOnSet: true });
  const report = applyNetConfig(steam, {}, {});
  assert.strictEqual(report.available, true);
  assert.ok(report.applied.every((e) => e.ok === false));
  assert.ok(report.applied.every((e) => /调用抛错/.test(e.note)));
});

test('applyNetConfig：没有 getLibrary 时降级，不抛', () => {
  const { steam } = fakeSteam({ noGetLibrary: true });
  const report = applyNetConfig(steam, {}, {});
  assert.strictEqual(report.available, false);
  assert.match(report.reason, /没有导出 SetGlobalConfigValueInt32/);
  assert.deepStrictEqual(report.applied, []);
});

test('applyNetConfig：两个符号都不存在时降级，不抛', () => {
  const { steam } = fakeSteam({ noSetSymbol: true });
  const report = applyNetConfig(steam, {}, {});
  assert.strictEqual(report.available, false);
  assert.match(report.reason, /SetGlobalConfigValueInt32/);
  assert.match(report.reason, /SetConfigValue/);
});

test('applyNetConfig：只有全局专用入口缺失时，退回通用 SetConfigValue 且照常读回核对', () => {
  const MB = 1024 * 1024;
  const { steam, sets } = fakeSteam({ noGlobalSymbol: true });
  const report = applyNetConfig(steam, { sendRateMax: 8 * MB }, {});
  assert.strictEqual(report.available, true, '通用版可用就不该降级');
  assert.ok(report.applied.length > 0);
  assert.ok(report.applied.every((e) => e.ok), '通用版下发也要算成功');
  // 通用版必须按 Global 作用域 + Int32 类型调用，值按指针传
  const rate = sets.find((s) => s.valueId === 11);
  assert.ok(rate, 'SendRateMax 应被下发');
  assert.strictEqual(rate.value, 8 * MB);
  assert.strictEqual(rate.scope, 1, '作用域必须是 Global');
  assert.strictEqual(rate.dataType, 1, '数据类型必须是 Int32');
});

test('applyNetConfig：拿不到接口时说明原因', () => {
  const report = applyNetConfig({}, {}, {});
  assert.strictEqual(report.available, false);
  assert.match(report.reason, /ISteamNetworkingUtils/);
});

test('applyNetConfig：显式 overrides 会传进实际下发值', () => {
  const { steam, sets } = fakeSteam();
  applyNetConfig(steam, { sendRateMax: 9 * MB, sendRateMin: 9 * MB }, {});
  const rate = sets.find((s) => s.valueId === CONFIG_VALUE.SendRateMax);
  assert.strictEqual(rate.value, 9 * MB);
});

// ------------------------------------------------------------- formatNetConfigReport

test('formatNetConfigReport：不可用时给出原因与 notes', () => {
  const lines = formatNetConfigReport({ available: false, reason: '没有接口', notes: ['补充说明'] });
  assert.strictEqual(lines.length, 2);
  assert.match(lines[0], /未下发：没有接口/);
  assert.match(lines[1], /补充说明/);
});

test('formatNetConfigReport：可用时列出每项请求值与实际值', () => {
  const report = {
    available: true,
    transport: 'ice',
    applied: [{ name: 'NagleTime', requested: 0, effective: 0, ok: true }],
    notes: [],
  };
  const lines = formatNetConfigReport(report);
  assert.strictEqual(lines.length, 2);
  // 第一行专门交代传输偏好，免得看日志的人以为中继还在参与竞争
  assert.match(lines[0], /传输偏好：强制直连/);
  assert.match(lines[1], /NagleTime=0\(实际 0\)/);
});

test('formatNetConfigReport：未下发时也带上传输偏好', () => {
  const lines = formatNetConfigReport({ available: false, transport: 'relay', reason: '没有接口', notes: [] });
  assert.match(lines[0], /没有接口/);
  assert.match(lines[0], /强制中继/);
});

test('parseTransport：同义写法与非法输入', () => {
  assert.strictEqual(parseTransport('direct'), 'ice');
  assert.strictEqual(parseTransport('P2P'), 'ice');
  assert.strictEqual(parseTransport('SDR'), 'relay');
  assert.strictEqual(parseTransport(''), DEFAULT_TRANSPORT);
  assert.strictEqual(parseTransport(undefined), DEFAULT_TRANSPORT);
  const notes = [];
  assert.strictEqual(parseTransport('nonsense', notes), DEFAULT_TRANSPORT);
  assert.strictEqual(notes.length, 1);
  assert.ok(notes[0].includes('nonsense'));
});

test('传输预设本身自洽：ice 档一定压过 auto 档的 SDR 分', () => {
  assert.ok(netconfig.SDR_PENALTY_PREFER_DIRECT > 1000, '罚分要远大于任何合理 ping，否则压不住中继');
  assert.ok(Array.isArray(netconfig.TRANSPORT_MODES));
  assert.deepStrictEqual(netconfig.TRANSPORT_MODES.slice().sort(), ['auto', 'ice', 'relay']);
  assert.ok(netconfig.TRANSPORT_MODES.includes(DEFAULT_TRANSPORT));
  // 三档都必须把 ICE/SDR 那四项给全，否则合并 base 时会漏项落回 DEFAULTS
  for (const mode of netconfig.TRANSPORT_MODES) {
    const preset = netconfig.TRANSPORT_PRESETS[mode];
    for (const key of ['iceEnable', 'icePenalty', 'sdrPenalty']) {
      assert.strictEqual(typeof preset[key], 'number', `${mode} 档缺 ${key}`);
    }
  }
});

test('formatNetConfigReport：null 报告返回空数组', () => {
  assert.deepStrictEqual(formatNetConfigReport(null), []);
});

// ------------------------------------------------------------------------ 覆盖面

test('APPLY_ORDER 里的每一项都有枚举号与标签', () => {
  for (const key of APPLY_ORDER) {
    assert.ok(Number.isInteger(netconfig.VALUE_ID[key]), key + ' 缺 VALUE_ID');
    assert.ok(typeof netconfig.LABEL[key] === 'string', key + ' 缺 LABEL');
    assert.ok(Number.isInteger(CONFIG_VALUE[netconfig.LABEL[key]]), key + ' 的 LABEL 不在 CONFIG_VALUE 里');
  }
});
