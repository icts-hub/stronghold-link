'use strict';
// 版本号散落在几个文件里，手工替换容易漏掉正则字面量里的那种（`/0\.12\.4 \/ Electron/`）。
// 用法：node diag\bump-version.cjs 0.12.4 0.12.5
const fs = require('node:fs');
const path = require('node:path');

const from = process.argv[2];
const to = process.argv[3];
if (!from || !to) {
  console.error('用法: node diag\\bump-version.cjs <旧版本> <新版本>');
  process.exit(1);
}
// 这个脚本有两份副本：仓库里的 diag/（root 就是上一级）和开发工作区根目录的 diag/
// （上一级是工作区，源码在 Stronghold-Link/source）。两种摆放都自动认出来。
const root = fs.existsSync(path.resolve(__dirname, '..', 'package.json'))
  ? path.resolve(__dirname, '..')
  : path.resolve(__dirname, '..', 'Stronghold-Link', 'source');
const files = [
  'package.json',
  'electron/main.cjs',
  'README.md',
  'dist-extras/README-FIRST.txt',
  'test/main-ipc.test.cjs',
  'test/ui-logic.test.cjs',
];
const dotted = (v) => v.replace(/\./g, '\\.');
let touched = 0;
for (const rel of files) {
  const p = path.join(root, rel);
  const before = fs.readFileSync(p, 'utf8');
  const after = before.split(from).join(to).split(dotted(from)).join(dotted(to));
  if (after !== before) {
    fs.writeFileSync(p, after);
    touched += 1;
    console.log(`改好 ${rel}`);
  } else {
    console.log(`没找到 ${from}：${rel}`);
  }
}
console.log(touched ? `共改了 ${touched} 个文件` : '一个文件都没改');
