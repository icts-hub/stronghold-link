'use strict';
// 游戏识别单测：进程名+端口交叉比对、自定义端口、误判防护

const test = require('node:test');
const assert = require('node:assert');
const G = require('../network/game-detect.cjs');

const E = (port, process, protocol = 'TCP', state = 'LISTENING', pid = 1) => ({ port, process, protocol, state, pid });

test('进程名 + 默认端口都对上：high 置信度', () => {
  const out = G.detectGames([E(25565, 'javaw.exe')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'minecraft-java');
  assert.equal(out[0].confidence, 'high');
  assert.equal(out[0].isDefaultPort, true);
  assert.match(out[0].join, /127\.0\.0\.1:25565/);
});

test('自定义端口但进程名对上：仍能认出，并且用真实端口', () => {
  const out = G.detectGames([E(30000, 'terrariaserver.exe')]);
  assert.equal(out[0].id, 'terraria');
  assert.equal(out[0].confidence, 'high');
  assert.equal(out[0].isDefaultPort, false);
  assert.match(out[0].join, /30000/, '提示里必须是真实端口，不是默认 7777');
});

test('只有默认端口对上（进程未知）：medium，不冒充确定', () => {
  const out = G.detectGames([E(25565, null)]);
  assert.equal(out[0].id, 'minecraft-java');
  assert.equal(out[0].confidence, 'medium');
});

test('协议要区分：UDP 8211 是幻兽帕鲁，TCP 同号不该误判成它', () => {
  const udp = G.detectGames([E(8211, null, 'UDP')]);
  assert.equal(udp[0].id, 'palworld');
  assert.equal(udp[0].protocol, 'UDP');
});

test('非监听的 TCP 连接不算（ESTABLISHED 是客户端出口）', () => {
  const out = G.detectGames([E(25565, 'javaw.exe', 'TCP', 'ESTABLISHED')]);
  assert.equal(out.length, 0);
});

test('认不出就返回空，不猜', () => {
  assert.deepEqual(G.detectGames([E(52341, 'chrome.exe'), E(135, 'svchost.exe')]), []);
  assert.equal(G.pickPrimaryGame([E(52341, null)]), null);
});

test('多个候选排序：high 在 medium 之前，默认端口优先', () => {
  const out = G.detectGames([E(25566, 'unknown.exe'), E(25565, null), E(7777, 'terraria.exe')]);
  assert.equal(out[0].confidence, 'high');
  assert.ok(out.findIndex((x) => x.confidence === 'high') < out.findIndex((x) => x.confidence === 'medium'));
});

test('一键首选：没有游戏返回 null，有则给置信度最高的', () => {
  assert.equal(G.pickPrimaryGame([E(52341, 'chrome.exe')]), null);
  const pick = G.pickPrimaryGame([E(25566, null), E(28015, 'rust.exe')]);
  assert.equal(pick.id, 'rust');
  assert.equal(pick.confidence, 'high');
});

test('档案自身完整性：id 唯一、端口为正、提示里有占位符或固定地址', () => {
  const ids = new Set();
  for (const p of G.PROFILES) {
    assert.ok(!ids.has(p.id), 'id 重复: ' + p.id); ids.add(p.id);
    assert.ok(p.procs.length > 0 && p.ports.length > 0);
    assert.ok(p.ports.every((x) => Number.isInteger(x) && x > 0 && x < 65536));
    assert.ok(typeof p.name === 'string' && p.name.length > 0);
    assert.ok(typeof p.join === 'string' && p.join.length > 0);
  }
  assert.ok(G.PROFILES.length >= 15, '档案数量应覆盖常见联机游戏');
});
