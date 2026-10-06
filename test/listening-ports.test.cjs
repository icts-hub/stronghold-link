'use strict';
// 端口探测单测：解析、过滤系统噪声、排序、建议规则（全部用固定文本，不依赖真机）

const test = require('node:test');
const assert = require('node:assert');

const P = require('../network/listening-ports.cjs');

const NETSTAT_TCP = `
  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1004
  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       8800
  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       8800
  TCP    0.0.0.0:52341          0.0.0.0:0              LISTENING       9900
  TCP    192.168.1.5:52100      1.2.3.4:443            ESTABLISHED     7700
`;
const NETSTAT_UDP = `
  Proto  Local Address          Foreign Address        State           PID
  UDP    0.0.0.0:27015          *:*                                    8800
  UDP    0.0.0.0:5353           *:*                                    1200
`;
const TASKLIST = `"svchost.exe","1004","Services","0","1,234 K"
"StrongholdProtocol.exe","8800","Console","1","45,678 K"
"chrome.exe","9900","Console","1","200,000 K"`;

test('解析 netstat：TCP/UDP 都认，地址与端口正确拆开', () => {
  const tcp = P.parseNetstat(NETSTAT_TCP, 'TCP');
  assert.equal(tcp.length, 5);
  const p3000 = tcp.find((e) => e.port === 3000);
  assert.equal(p3000.address, '0.0.0.0');
  assert.equal(p3000.pid, 8800);
  assert.equal(p3000.state, 'LISTENING');
  const udp = P.parseNetstat(NETSTAT_UDP, 'UDP');
  assert.equal(udp.length, 2);
  assert.equal(udp[0].protocol, 'UDP');
  assert.equal(udp[0].port, 27015);
});

test('解析 tasklist：pid → 进程名（小写）', () => {
  const m = P.parseTasklist(TASKLIST);
  assert.equal(m.get(1004), 'svchost.exe');
  assert.equal(m.get(8800), 'strongholdprotocol.exe');
});

test('过滤系统噪声：系统进程、特权端口、高位临时端口都被排除', () => {
  const names = P.parseTasklist(TASKLIST);
  const all = [...P.parseNetstat(NETSTAT_TCP, 'TCP'), ...P.parseNetstat(NETSTAT_UDP, 'UDP')]
    .map((e) => ({ ...e, process: names.get(e.pid) || null }));
  const ranked = P.rankCandidates(all);
  const ports = ranked.map((r) => r.port);
  assert.ok(ports.includes(3000), '游戏 TCP 端口应入选');
  assert.ok(ports.includes(27015), '游戏 UDP 端口应入选');
  assert.ok(!ports.includes(135), '135 是特权端口');
  assert.ok(!ports.includes(5353), '5353 是系统组播');
  assert.ok(!ports.includes(52341), '高位端口视为临时连接');
  assert.ok(!ports.includes(52100), 'ESTABLISHED 不是监听');
  assert.ok(ports.includes(8080), '127.0.0.1:8080 是合法的本地服务候选（本项目示例就用它）');
  assert.ok(ports.indexOf(3000) <= ports.indexOf(8080), '全网卡监听排在仅回环之前');
});

test('排序：监听全网卡的排在仅回环之前，且按端口升序', () => {
  const names = P.parseTasklist(TASKLIST);
  const all = [...P.parseNetstat(NETSTAT_TCP, 'TCP')].map((e) => ({ ...e, process: names.get(e.pid) || null }));
  const ranked = P.rankCandidates(all);
  const iAll = ranked.findIndex((r) => r.address === '0.0.0.0' && r.port === 3000);
  const iLoop = ranked.findIndex((r) => r.port === 8080);
  assert.ok(iAll >= 0);
  if (iLoop >= 0) assert.ok(iAll < iLoop, '0.0.0.0 的应排在 127.0.0.1 之前');
});

test('排除已占用端口：exclude 里的端口不会出现在候选里', () => {
  const names = P.parseTasklist(TASKLIST);
  const all = [...P.parseNetstat(NETSTAT_TCP, 'TCP'), ...P.parseNetstat(NETSTAT_UDP, 'UDP')]
    .map((e) => ({ ...e, process: names.get(e.pid) || null }));
  const ranked = P.rankCandidates(all, { exclude: [3000] });
  assert.ok(!ranked.some((r) => r.port === 3000));
});

test('建议规则：本地端口 P → 对好友开放 P+1，且避开已占用', () => {
  const names = P.parseTasklist(TASKLIST);
  const all = [...P.parseNetstat(NETSTAT_TCP, 'TCP'), ...P.parseNetstat(NETSTAT_UDP, 'UDP')]
    .map((e) => ({ ...e, process: names.get(e.pid) || null }));
  const rules = P.suggestRules(all, { exclude: [], used: [27016] });
  assert.ok(rules.length > 0);
  const r3000 = rules.find((r) => r.localPort === 3000);
  assert.equal(r3000.remotePort, 3001);
  const r27015 = rules.find((r) => r.localPort === 27015);
  assert.notEqual(r27015.remotePort, 27016, '27016 已被占用应避开');
  assert.ok(rules.every((r) => r.remotePort > 0));
  assert.ok(rules.length <= 4, '规则数受 max 限制');
});

test('Steam 端口建议：挑排序第一的候选，没有候选返回 null', () => {
  const names = P.parseTasklist(TASKLIST);
  const all = [...P.parseNetstat(NETSTAT_TCP, 'TCP'), ...P.parseNetstat(NETSTAT_UDP, 'UDP')]
    .map((e) => ({ ...e, process: names.get(e.pid) || null }));
  const pick = P.suggestSteamGamePort(all, { exclude: [] });
  assert.ok(pick && pick.port > 0);
  assert.equal(typeof pick.process, 'string');
  assert.equal(P.suggestSteamGamePort(all, { exclude: [3000, 27015, 8080] }), null);
});

test('真机探测：返回结构正确（有端口就带进程名，失败也有原因）', () => {
  const out = P.listListeningPorts({ timeoutMs: 8000 });
  assert.equal(typeof out.ok, 'boolean');
  assert.ok(Array.isArray(out.entries));
  if (process.platform !== 'win32') {
    // 解析器只认 Windows 的 netstat -ano 与 tasklist 输出，其他平台必须如实报不支持
    assert.equal(out.ok, false, '非 Windows 上不应声称探测成功');
    assert.equal(out.entries.length, 0);
    assert.ok(out.reason && out.reason.length > 4);
    return;
  }
  if (out.ok) {
    assert.ok(out.entries.length > 0, '本机至少应有若干监听端口');
    assert.ok(out.entries.every((e) => Number(e.port) > 0 && Number(e.pid) >= 0));
  } else {
    assert.ok(out.reason && out.reason.length > 4);
  }
});

test('基础设施类被排到最后（Steam 自身端口、许可证服务）', () => {
  const names = new Map([[1, 'steam.exe'], [2, 'lmgrd.exe'], [3, 'mygame.exe']]);
  const entries = [
    { protocol: 'TCP', address: '0.0.0.0', port: 27036, pid: 1, state: 'LISTENING', process: names.get(1) },
    { protocol: 'TCP', address: '0.0.0.0', port: 25734, pid: 2, state: 'LISTENING', process: names.get(2) },
    { protocol: 'TCP', address: '0.0.0.0', port: 3000, pid: 3, state: 'LISTENING', process: names.get(3) },
  ];
  const ranked = P.rankCandidates(entries);
  assert.equal(ranked[0].port, 3000, '真实游戏/服务应排第一');
  assert.equal(P.isInfra({ port: 27036, process: 'steam.exe' }), true);
  assert.equal(P.isInfra({ port: 3000, process: 'mygame.exe' }), false);
  const pick = P.suggestSteamGamePort(entries);
  assert.equal(pick.port, 3000, 'Steam 建议不能挑到 Steam 自己的端口');
});

test('同一进程默认最多推荐两个端口（很多游戏 TCP+UDP 同号）', () => {
  const entries = [
    { protocol: 'TCP', address: '0.0.0.0', port: 3000, pid: 5, state: 'LISTENING', process: 'game.exe' },
    { protocol: 'TCP', address: '0.0.0.0', port: 3001, pid: 5, state: 'LISTENING', process: 'game.exe' },
    { protocol: 'UDP', address: '0.0.0.0', port: 3002, pid: 5, state: 'LISTENING', process: 'game.exe' },
  ];
  const two = P.suggestRules(entries, { max: 4 });
  assert.equal(two.length, 2, '同一进程默认最多两个规则');
  const many = P.suggestRules(entries, { max: 4, perProcess: 3 });
  assert.equal(many.length, 3);
});
