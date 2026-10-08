'use strict';
// 打包护栏单测 —— 2026-10-09 的事故：package.json 多了个 UTF-8 BOM，
// electron-builder 在写 app.asar 之前就失败退出，而 build-edition.cjs 的容错
// 分支看到 win-unpacked 还在（那是上一次的）就继续，把 0.14.1 的 app.asar
// 改名成 0.14.2 压进了 tar.xz。这里把三道护栏本身和它们的接线都钉住。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const G = require('../tools/build-guard.cjs');
const root = path.join(__dirname, '..');

const BOM_BYTES = [0xef, 0xbb, 0xbf];

test('★ 仓库自身的 package.json 绝不能带 UTF-8 BOM（0.14.2 就是被它害的）', () => {
  const bytes = fs.readFileSync(path.join(root, 'package.json'));
  assert.equal(G.hasBom(bytes), false,
    'package.json 带 BOM 时 electron-builder 的 @electron/rebuild 会 JSON.parse 失败，'
    + '而它发生在写 app.asar 之前 —— 上一次的旧 app.asar 会被当成本次版本打出去');
  assert.doesNotThrow(() => G.assertNoBom('package.json', bytes));
});

test('assertNoBom：认出 BOM 并说清后果，没有 BOM（或太短）时放行', () => {
  const withBom = Buffer.concat([Buffer.from(BOM_BYTES), Buffer.from('{"name":"x"}', 'utf8')]);
  assert.equal(G.hasBom(withBom), true);
  assert.throws(() => G.assertNoBom('package.json', withBom), /UTF-8 BOM/);
  // 报错文案必须点明「旧 app.asar 被打包出去」这个后果，否则看日志的人不知道有多严重
  assert.throws(() => G.assertNoBom('package.json', withBom), /旧 app\.asar/);
  assert.equal(G.hasBom(Buffer.from('{"name":"x"}', 'utf8')), false);
  assert.doesNotThrow(() => G.assertNoBom('package.json', Buffer.from('{"name":"x"}', 'utf8')));
  // 空文件 / 一两个字节的残片不能把它弄崩
  assert.doesNotThrow(() => G.assertNoBom('package.json', Buffer.alloc(0)));
  assert.doesNotThrow(() => G.assertNoBom('package.json', Buffer.from([0x7b])));
  assert.equal(G.hasBom(null), false);
});

test('asarVersion / assertAsarVersion：从 asar 里读出真正打进去的版本', () => {
  const asar = Buffer.from("...const CONFIG_PATH = 1; const APP_VERSION = '0.14.2';\nrest", 'latin1');
  assert.equal(G.asarVersion(asar), '0.14.2');
  assert.doesNotThrow(() => G.assertAsarVersion(asar, '0.14.2'));

  // 现场那种情况：包名叫 0.14.2，asar 里其实是 0.14.1 —— 报错里两个版本都要出现
  const stale = Buffer.from("const APP_VERSION = '0.14.1';", 'latin1');
  assert.throws(() => G.assertAsarVersion(stale, '0.14.2'),
    (err) => /0\.14\.1/.test(err.message) && /0\.14\.2/.test(err.message));

  assert.equal(G.asarVersion(Buffer.from('什么也没有', 'latin1')), null);
  assert.throws(() => G.assertAsarVersion(Buffer.from('什么也没有', 'latin1'), '0.14.2'), /找不到/);
});

test('assertAsarRewritten：产物没被重写过就拒绝继续', () => {
  const before = { size: 12673416, mtimeMs: 1000 };
  assert.throws(() => G.assertAsarRewritten(before, { size: 12673416, mtimeMs: 1000 }),
    /没有重新写出 app\.asar/);
  assert.doesNotThrow(() => G.assertAsarRewritten(before, { size: 12673416, mtimeMs: 2000 }));
  assert.doesNotThrow(() => G.assertAsarRewritten(before, { size: 12680000, mtimeMs: 1000 }));
  // 之前压根没有产物（干净的 release 目录）时只看「现在有没有」
  assert.doesNotThrow(() => G.assertAsarRewritten(null, { size: 1, mtimeMs: 1 }));
  assert.throws(() => G.assertAsarRewritten(before, null), /没有产出 resources\/app\.asar/);
});

test('statOf：真实文件给得出大小与时间，缺失文件返回 null 而不是抛异常', () => {
  const st = G.statOf(path.join(root, 'package.json'));
  assert.ok(st && st.size > 0 && st.mtimeMs > 0);
  assert.equal(G.statOf(path.join(root, 'no-such-file-0.14.2.cjs')), null);
});

test('三道护栏必须真的接在打包脚本上（不许被重构掉）', () => {
  const script = fs.readFileSync(path.join(root, 'tools', 'build-edition.cjs'), 'utf8');
  assert.match(script, /require\('\.\/build-guard\.cjs'\)/, '打包脚本必须引入护栏模块');
  assert.match(script, /guard\.assertNoBom\(/, '缺护栏 1：打之前查 package.json 的 BOM');
  assert.match(script, /guard\.assertAsarRewritten\(/, '缺护栏 2：打之后查 app.asar 有没有被重写');
  assert.match(script, /guard\.assertAsarVersion\(/, '缺护栏 3：打之后查 app.asar 里的版本号');
});
