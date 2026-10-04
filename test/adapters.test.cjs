'use strict';
// 适配器与「连接配方」注册表测试（阶段 5）
// 运行：node --test --test-isolation=none test/adapters.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');

const A = require('../network/adapters.cjs');

test('配方清单：四条覆盖「端口转发 / 浏览器应用 / Steam / 不做转发」，字段声明正确', () => {
  assert.equal(A.RECIPES.length, 4);
  const ids = A.RECIPES.map((r) => r.id);
  assert.deepEqual(ids, ['local-ports', 'local-web', 'steam-tunnel', 'lan-direct']);
  assert.equal(A.getRecipe('local-web').adapter, 'local');
  assert.equal(A.getRecipe('steam-tunnel').adapter, 'steam');
  assert.equal(A.getRecipe('lan-direct').adapter, 'none');
  assert.equal(A.getRecipe('nope'), null);
  for (const recipe of A.RECIPES) {
    assert.ok(recipe.name && recipe.summary, `${recipe.id} 应有名称与说明`);
    assert.ok(Array.isArray(recipe.fields) && recipe.fields.length, `${recipe.id} 应声明字段`);
  }
});

test('配方列表：Steam 未就绪时标记为不可用并给出原因', () => {
  const withoutSteam = A.describeRecipes({ steamAvailable: false });
  const steam = withoutSteam.find((r) => r.id === 'steam-tunnel');
  assert.equal(steam.available, false);
  assert.match(steam.unavailableReason, /Steamworks SDK/);
  assert.equal(withoutSteam.find((r) => r.id === 'local-ports').available, true, '本地中继永远可用');

  const withSteam = A.describeRecipes({ steamAvailable: true });
  assert.equal(withSteam.find((r) => r.id === 'steam-tunnel').available, true);
});

test('适配器列表：反映 Steam 真实诊断结果与运行状态', () => {
  const idle = A.describeAdapters({ steamDiagnosis: { available: false, blockers: ['缺少 Steamworks SDK 的 redistributable'] } });
  assert.equal(idle.find((a) => a.id === 'tcp-relay').status, 'ready');
  assert.equal(idle.find((a) => a.id === 'udp-relay').status, 'ready');
  const steam = idle.find((a) => a.id === 'steam-p2p');
  assert.equal(steam.status, 'not-configured');
  assert.match(steam.description, /缺少 Steamworks SDK/);
  assert.equal(idle.find((a) => a.id === 'guidance-only').status, 'ready');

  const running = A.describeAdapters({
    steamDiagnosis: { available: true },
    running: true,
    role: 'host',
    channelSummary: 'TCP:2301、UDP:2301',
  });
  assert.equal(running.find((a) => a.id === 'tcp-relay').status, 'running');
  assert.match(running.find((a) => a.id === 'tcp-relay').description, /TCP:2301/);
  assert.equal(running.find((a) => a.id === 'steam-p2p').status, 'running');
});

test('组装启动参数：本地配方产出 adapter=local + rules，且房主/加入者字段不同', () => {
  const rules = [{ protocol: 'TCP', localPort: 3000, remotePort: 3001 }];
  const host = A.buildStartInput('local-web', { role: 'host', rules, bindHost: '0.0.0.0', token: 'abc', game: '卫戍协议：盟约' });
  assert.equal(host.adapter, 'local');
  assert.equal(host.recipe, 'local-web');
  assert.equal(host.bindHost, '0.0.0.0');
  assert.equal(host.authToken, 'abc');
  assert.equal(host.rules.length, 1);
  assert.equal(host.remoteHost, undefined, '房主不应有 remoteHost');

  const joiner = A.buildStartInput('local-ports', { role: 'joiner', rules, remoteHost: '192.168.1.5', token: 'abc' });
  assert.equal(joiner.bindHost, '127.0.0.1');
  assert.equal(joiner.remoteHost, '192.168.1.5');
  assert.equal(joiner.targetHost, undefined);

  assert.throws(() => A.buildStartInput('local-ports', { role: 'host', rules: [] }), /至少一条端口规则/);
  assert.throws(() => A.buildStartInput('nope', { role: 'host' }), /未知的连接方式/);
  assert.throws(() => A.buildStartInput('local-ports', { role: 'wat', rules }), /角色必须是/);
});

test('组装启动参数：Steam 与「不做转发」两种配方的字段', () => {
  const steamHost = A.buildStartInput('steam-tunnel', { role: 'host', gamePort: '3000', appId: '480', game: 'g' });
  assert.deepEqual(steamHost, { role: 'host', adapter: 'steam', targetHost: '127.0.0.1', gamePort: 3000, appId: 480, game: 'g', recipe: 'steam-tunnel' });

  const steamJoin = A.buildStartInput('steam-tunnel', { role: 'joiner', hostSteamId: ' 76561198000000001 ', localPort: '3000', appId: 480 });
  assert.equal(steamJoin.hostSteamId, '76561198000000001');
  assert.equal(steamJoin.localPort, 3000);

  const none = A.buildStartInput('lan-direct', { role: 'host', gamePort: 3000, game: 'g' });
  assert.equal(none.adapter, 'none');
  assert.equal(none.gamePort, 3000);
});

test('连接说明：浏览器应用配方给出「打开本机入口」与「直连房主」两种方式', () => {
  const rules = [{ protocol: 'TCP', localPort: 3000, remotePort: 3001 }];
  const web = A.describeHints('local-web', { rules, lanAddress: '192.168.1.5', game: '卫戍协议：盟约' });
  assert.ok(web.clientHint.some((h) => /http:\/\/127\.0\.0\.1:3000/.test(h)), '应给出本机入口 URL');
  assert.ok(web.clientHint.some((h) => /192\.168\.1\.5:3001/.test(h)), '应给出直连房主的 URL');
  assert.ok(web.clientHint.some((h) => /口令必须与房主一致/.test(h)));
  assert.ok(web.hostHint.some((h) => /对好友开放：192\.168\.1\.5:3001/.test(h)));

  const ports = A.describeHints('local-ports', { rules, lanAddress: '192.168.1.5' });
  assert.ok(ports.clientHint.some((h) => /客户端连接 127\.0\.0\.1:3000/.test(h)));
  assert.equal(ports.clientHint.some((h) => /浏览器打开/.test(h)), false, '纯端口配方不该提示浏览器打开');
});

test('连接说明：Steam 与「不做转发」的说明要如实', () => {
  const steam = A.describeHints('steam-tunnel', { gamePort: 3000, lanAddress: '192.168.1.5', localPort: 3000 });
  assert.ok(steam.hostHint.some((h) => /SteamID/.test(h)));
  assert.ok(steam.clientHint.some((h) => /AppID 一致/.test(h)));

  const none = A.describeHints('lan-direct', { gamePort: 3000, lanAddress: '192.168.1.5' });
  assert.ok(none.hostHint.some((h) => /不做任何转发/.test(h)));
  assert.ok(none.clientHint.some((h) => /本工具不参与流量转发/.test(h)), '必须说清它不是隧道');
  assert.deepEqual(A.describeHints('nope', {}), { hostHint: [], clientHint: [] });
});
