'use strict';
// 版本号一致性（审计 A-09）。
//
// 现场：`electron/preload.cjs` 里写死 `version: '0.11.0'`，而 package.json 与
// `electron/main.cjs` 的 APP_VERSION 是 `0.14.4`。于是界面"关于"里显示 0.11.0、
// 启动日志里写 0.14.4，用户报障时报的版本号跟日志对不上，排查先浪费一轮。
//
// 为什么这里用"读文本"而不是 require 那两个文件：
//   · electron/main.cjs 依赖 electron 运行时，在 node --test 里 require 不起来；
//   · 更要紧的是 build-guard 的第三道护栏靠**正则搜 asar 里的字面量**，
//     所以 main.cjs 必须保留 `APP_VERSION = 'x.y.z'` 这个形状 —— 这一条要一起钉住。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('★ 版本号只有一个来源：package.json 必须是合法 semver', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/,
    `package.json 的 version 必须是 semver，实际是 ${JSON.stringify(pkg.version)}`);
});

test('★ electron/main.cjs 的 APP_VERSION 必须等于 package.json（否则打包护栏搜到的版本是错的）', () => {
  const main = read(path.join('electron', 'main.cjs'));
  const m = /APP_VERSION\s*=\s*'([^']+)'/.exec(main);
  assert.ok(m, 'electron/main.cjs 里必须有 `const APP_VERSION = \'x.y.z\';` 这种字面量写法'
    + '（build-guard 用正则搜它，换成 require 会让护栏静默失效）');
  assert.equal(m[1], pkg.version,
    `electron/main.cjs 的 APP_VERSION 是 ${m[1]}，package.json 是 ${pkg.version} —— 两处必须一起改`);
});

test('★ electron/preload.cjs 暴露的版本必须来自主进程传入的 --shl-version（不许再写死）', () => {
  const preload = read(path.join('electron', 'preload.cjs'));
  assert.match(preload, /VERSION_FLAG\s*=\s*'--shl-version='/,
    'electron/preload.cjs 必须从 `--shl-version=` 命令行参数里取版本（主进程用 additionalArguments 传）');
  assert.match(preload, /version:\s*appVersion/,
    'electron/preload.cjs 暴露的 version 必须是解析出来的 appVersion，不能是字面量');
  assert.ok(!/version:\s*'\d+\.\d+\.\d+'/.test(preload),
    'electron/preload.cjs 里不许再出现写死的版本号字面量 —— A-09 就是这么来的');

  // 两端必须接得上：主进程要真的把这个参数传下去，否则界面会显示兜底值。
  const main = read(path.join('electron', 'main.cjs'));
  assert.match(main, /additionalArguments:\s*\[`--shl-version=\$\{APP_VERSION\}`\]/,
    'electron/main.cjs 建窗口时必须用 additionalArguments 把 `--shl-version=${APP_VERSION}` 传给 preload');
});

test('★ 仓库里不许有第二份写死的版本号（源码范围内）', () => {
  // 只扫**代码**，不扫注释：注释里提到历史版本号（"以前这里是 0.11.0"）是排查线索，不是分叉。
  // 例外：electron/main.cjs 里那一份 APP_VERSION 是打包护栏依赖的字面量，允许存在。
  const stripComments = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
  const scanDirs = ['electron', 'network', 'shared'];
  const offenders = [];
  for (const dir of scanDirs) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (!name.endsWith('.cjs') && !name.endsWith('.js')) continue;
      const code = stripComments(fs.readFileSync(path.join(abs, name), 'utf8'));
      for (const hit of code.matchAll(/['"](\d+\.\d+\.\d+)['"]/g)) {
        if (dir === 'electron' && name === 'main.cjs' && hit[1] === pkg.version) continue;
        const line = code.slice(0, hit.index).split('\n').length;
        offenders.push(`${dir}/${name}:${line} 出现写死的版本号 ${hit[1]}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    `源码里不该有写死的版本号（应统一从 package.json 取）：\n  ${offenders.join('\n  ')}`);
});

test('★ README 的版本徽章不能与 package.json 脱节', () => {
  const readme = read('README.md');
  const m = /badge\/version-(\d+\.\d+\.\d+)-/.exec(readme);
  assert.ok(m, 'README 里应当有版本徽章（badge/version-x.y.z-）');
  assert.equal(m[1], pkg.version,
    `README 的版本徽章写着 ${m[1]}，package.json 是 ${pkg.version} —— 徽章是给人看的第一眼，必须同步`);
});

// 下面两条不是"版本号"，但同属"同一件事只有一个来源"这一类：
// 测试清单漏文件、许可证名与 LICENSE 正文不符，都曾经真实发生过（前者让 820 个用例静默变成 807 个）。

test('★ 磁盘上的每个 .test.cjs 都必须登记进 package.json 的 test 脚本（否则用例会静默消失）', () => {
  // 现场：重写 package.json 的 test 脚本时漏掉了 test/secure-stream.test.cjs，
  // `npm test` 照样退出码 0、照样报"全绿"，只是总数从 820 掉到 807 —— 少跑 13 个用例没人发现。
  const dir = path.join(root, 'test');
  const onDisk = fs.readdirSync(dir).filter((n) => n.endsWith('.test.cjs')).sort();
  const listed = new Set(
    (pkg.scripts.test.match(/test\/[A-Za-z0-9._-]+\.cjs/g) || []).map((s) => s.slice('test/'.length))
  );
  const missing = onDisk.filter((n) => !listed.has(n));
  assert.deepEqual(missing, [],
    `这些测试文件在磁盘上但没被 test 脚本执行（等于不存在）：\n  ${missing.join('\n  ')}`);
  const ghost = [...listed].filter((n) => !onDisk.includes(n));
  assert.deepEqual(ghost, [],
    `test 脚本里列了并不存在的测试文件：\n  ${ghost.join('\n  ')}`);
});

test('★ package.json 的 license 字段必须与 LICENSE 正文一致（不许写另一个版本）', () => {
  // 现场：LICENSE 是 GPLv3 全文（"Version 3, 29 June 2007"），package.json 却写 GPL-3.0-or-later。
  // 一个是"仅第 3 版"、一个是"第 3 版或更新"，差别能被下游工具当真。
  const license = read('LICENSE');
  const firstLines = license.split('\n').slice(0, 3).join('\n');
  assert.match(firstLines, /GNU GENERAL PUBLIC LICENSE/,
    'LICENSE 正文不像 GPL 全文 —— 先确认许可文件没被换掉');
  assert.match(firstLines, /Version 3, 29 June 2007/,
    `LICENSE 正文声明的版本与预期不符：\n${firstLines}`);
  assert.match(license, /either version 3 of the License, or\s*\(at your option\) any later version/,
    'GPLv3 全文里应当有"或任何更新版本"那段示例声明 —— 它是模板文字，不代表本项目选了 or-later');

  assert.equal(pkg.license, 'GPL-3.0-only',
    `package.json 的 license 是 ${pkg.license}，而 LICENSE 是 GPLv3 全文本身`
    + '（"Version 3, 29 June 2007"）—— 这里要写 GPL-3.0-only，不能写 or-later，'
    + '也不能写别的版本号；真要改授权，得同时换 LICENSE 正文');

  // 随包分发的许可证全文必须真的存在且就是根 LICENSE 的副本。
  const shipped = path.join(root, 'LICENSES', 'GPL-3.0-only.txt');
  assert.ok(fs.existsSync(shipped), 'LICENSES/GPL-3.0-only.txt 必须存在（分发目录里要带许可证全文）');
  assert.equal(fs.readFileSync(shipped, 'utf8'), license,
    'LICENSES/GPL-3.0-only.txt 必须与根 LICENSE 逐字节相同（GPL 要求随二进制附全文）');
});

// 下面这条同样属于"同一件事只有一个来源"，而且它曾经**被守卫漏掉**：
// assets[] 里每条记录只带一个 sha256（该组的代表文件），组内其余文件的哈希全靠
// installed_files 列表；守卫原先完全不看那个列表，刷新器又只认大写键名
// INSTALLED_FILES 而静默跳过小写的 installed_files。结果是：组内非代表文件（例如
// app_qml/qml/theme.js）改了以后台账哈希一直是旧的，而 `npm test` 一路绿灯。
test('★ 台账 installed_files 里每个文件的哈希都必须与磁盘一致（守卫不能只看代表文件）', () => {
  const manifest = JSON.parse(read('asset-provenance.json'));
  const crypto = require('node:crypto');
  const groups = [];
  for (const key of ['INSTALLED_FILES', 'installed_files']) {
    const g = manifest[key];
    if (g && typeof g === 'object' && !Array.isArray(g)) {
      for (const [name, list] of Object.entries(g)) {
        if (Array.isArray(list)) groups.push([`${key}.${name}`, list]);
      }
    }
  }
  assert.ok(groups.length > 0,
    '台账里必须有 installed_files（或 INSTALLED_FILES）分组 —— 键名一改，逐文件对账就等于没有');

  const drift = [];
  const missing = [];
  for (const [group, list] of groups) {
    for (const item of list) {
      if (!item || typeof item !== 'object' || !item.path) continue;
      const abs = path.join(root, item.path);
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { missing.push(`${group} → ${item.path}`); continue; }
      const actual = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
      if (String(item.sha256).toLowerCase() !== actual) {
        drift.push(`${item.path}（台账 ${item.sha256}，磁盘 ${actual}）`);
      }
    }
  }
  assert.deepEqual(missing, [],
    `台账里登记的文件在磁盘上找不到：\n  ${missing.join('\n  ')}`);
  assert.deepEqual(drift, [],
    '这些文件的台账哈希与磁盘不一致 —— 跑 `node tools/refresh-provenance-hashes.cjs --write`，'
    + '并同步 ASSET_PROVENANCE.md 里单独列出的哈希：\n  ' + drift.join('\n  '));
});

