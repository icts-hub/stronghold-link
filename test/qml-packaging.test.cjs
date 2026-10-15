'use strict';
// QML 版便携包的打包契约（阶段 5）。
//
// 为什么要有它：打包器本身只有在装了 Qt + MinGW 的机器上才跑得起来，CI 与新克隆都跑不了，
// 所以「包里不许有 Valve 的东西」这条**法务红线**以前只能靠人肉检查 —— 而它一旦漏了，
// 漏的是 Valve 的 redistributable 和静态库，属于发出去就收不回来的错误。
// 这里把打包器的规则函数拉出来单独验：规则红不红，不需要 Qt 也能当场知道。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pack = require('../tools/pack-qml.cjs');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('★ 打包器：Valve 运行库 / 静态库 / 探针 / 测试 一律判违规', () => {
  // 现场：QML 版的 Steam 隧道靠用户自备 steam_api64.dll，包里绝不能顺手带上；
  // koffi 的 koffi.lib 是链接期导入库，曾经躺在 node_modules 里等着被打进包。
  const bad = [
    'steam_api64.dll',
    'steamworks_sdk/redistributable_bin/win64/steam_api64.dll',
    'node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.lib',
    'backend/shl-probe.cjs',
    'tools/net-latency-probe.exe',
    'test/steam-mock.cjs',
    'qml-qa/raw/opt-idle213.csv',
    'qml-startup.log',
    'Qt6Core.dll.map',
    'network/session.test.cjs',
  ];
  const hits = pack.forbiddenHits(bad);
  for (const f of bad) {
    assert.ok(hits.some((h) => h.startsWith(`${f} `)), `${f} 没被拦下`);
  }
});

test('★ 打包器：正常包内容不许被规则误伤', () => {
  // 误伤同样致命：规则太宽会把 Qt 的 QML 模块、node 运行时、许可证全判死，包就压不出来。
  const good = [
    'StrongholdLink.exe',
    'Qt6Core.dll',
    'Qt6QuickLayouts.dll',
    'platforms/qwindows.dll',
    'qml/QtQuick/Controls/qmldir',
    'qml/QtQml/Base/plugins.qmltypes',
    'node/node.exe',
    'backend/stronghold-backend.cjs',
    'network/steam-adapter.cjs',
    'node_modules/koffi/src/koffi/index.cjs',
    'node_modules/steamworks-ffi-node/prebuilds/win32-x64/steam-overlay.node',
    'LICENSES/LGPL-3.0-only.txt',
    'THIRD_PARTY_NOTICES.txt',
    'PORTABLE-CONTENTS.txt',
    '点我启动-StrongholdLink-QML版.cmd',
  ];
  assert.deepEqual(pack.forbiddenHits(good), [], '这些是包里本来就该有的文件');
});

test('打包器：必需文件清单自洽，且自身不含违规项', () => {
  assert.deepEqual(pack.missingRequired(pack.REQUIRED_FILES), []);
  assert.deepEqual(pack.missingRequired(pack.REQUIRED_FILES.filter((f) => f !== 'node/node.exe')), ['node/node.exe'],
    '少一个必需文件必须报出来（缺 node.exe 就是后端起不来）');
  assert.deepEqual(pack.forbiddenHits(pack.REQUIRED_FILES), [],
    '必需清单里出现违规项 = 规则和清单在互相打架，先修一个');

  // 阶段 5 点名的四类法务件 + 清单本身，必须在必需清单里（漏了就等于没打进去）。
  for (const must of [
    'LICENSES/LGPL-3.0-only.txt', 'LICENSES/GPL-3.0-only.txt',
    'THIRD_PARTY_NOTICES.txt', 'ASSET_PROVENANCE.md', 'asset-provenance.json',
    'PORTABLE-CONTENTS.txt',
  ]) {
    assert.ok(pack.REQUIRED_FILES.includes(must), `必需清单里少了 ${must}`);
  }
  // Qt 的 QML 布局模块与 MinGW 运行库是"缺了就白屏/起不来"的那一类，单列出来防回退。
  for (const must of ['Qt6QuickLayouts.dll', 'Qt6Qml.dll', 'platforms/qwindows.dll',
    'libgcc_s_seh-1.dll', 'libstdc++-6.dll', 'libwinpthread-1.dll']) {
    assert.ok(pack.REQUIRED_FILES.includes(must), `必需清单里少了 ${must}`);
  }
  // koffi 的根 index.cjs 只是 50 字节转发层，真正的入口在 src/ 下 —— 剪依赖时最容易剪错。
  assert.ok(pack.REQUIRED_FILES.includes('node_modules/koffi/src/koffi/index.cjs'),
    'koffi 的真正入口是 src/koffi/index.cjs，剪掉它 require 就崩');
});

test('打包器：包名与版本跟着 package.json 走，zip 名与目录名一致', () => {
  assert.equal(pack.VERSION, pkg.version, '打包器读的就是 package.json 的 version');
  assert.equal(pack.artifactName, `Stronghold-Link-${pkg.version}-qml-win-x64`);
  assert.match(pack.artifactName, /-qml-win-x64$/, 'QML 版包名要带 qml，别和 Electron 版的可移植包混淆');
});

test('★ dist-extras-qml 的启动器：中文代码页、退出码翻译、不带 Chromium 参数', () => {
  const dir = path.join(root, 'dist-extras-qml');
  assert.ok(fs.existsSync(dir), 'QML 版的分发附加文件目录必须存在');
  const files = fs.readdirSync(dir);
  assert.ok(files.includes('README-FIRST.txt'), '要有一份给用户先读的说明');
  const launcher = files.find((n) => n.endsWith('.cmd'));
  assert.ok(launcher, '要有一个双击就能跑的启动器');
  const cmd = read(path.join('dist-extras-qml', launcher));

  assert.match(cmd, /chcp\s+65001/i, '带中文的 .cmd 必须先切 UTF-8 代码页，否则提示全是乱码');
  assert.ok(!/--no-sandbox/.test(cmd), '--no-sandbox 是 Electron/Chromium 的参数，QML 版不该带');
  assert.match(cmd, /StrongholdLink\.exe/, '启动器要启的是 QML 版自己的 exe');
  // 两种"看起来一样、其实是两回事"的崩溃要分开翻译，否则用户排错会走错方向。
  assert.match(cmd, /-1073741819|3221225477/, '0xC0000005（注入型软件）要翻译成人话');
  assert.match(cmd, /-1073741515|3221225781/, '0xC0000135（缺 DLL）要翻译成人话');
  assert.match(cmd, /GamePP|RTSS|MSIAfterburner/i, '要提示先关注入型软件 —— 本机就是被 GamePP 注入打崩的');
});

test('dist-extras-qml 的说明书：自备 Valve 库、法务件、已知限制都写清楚', () => {
  const txt = read('dist-extras-qml/README-FIRST.txt');
  assert.match(txt, /steam_api64\.dll/, '要写明 Steam 隧道需要用户自备 steam_api64.dll 及其放置路径');
  for (const must of ['LICENSES', 'PORTABLE-CONTENTS.txt', 'LGPL']) {
    assert.ok(txt.includes(must), `说明书里要提到 ${must}`);
  }
});

test('打包器不参与 npm test（它需要 Qt，CI 上跑不了）', () => {
  assert.ok(!/pack-qml/.test(pkg.scripts.test),
    'tools/pack-qml.cjs 需要 Qt + MinGW，不能塞进 npm test，否则新克隆和 CI 全红');
});
