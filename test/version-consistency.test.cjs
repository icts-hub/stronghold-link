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
