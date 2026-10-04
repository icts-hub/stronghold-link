'use strict';
// 从 CHANGELOG.md 里取出指定版本的段落，供 gh release --notes-file 使用。
// 用法：node tools/changelog-for.cjs 0.9.1
// 找不到该版本时：把整个文件输出，并把退出码设为 1（workflow 里有回退逻辑）。
const fs = require('node:fs');
const path = require('node:path');

const version = String(process.argv[2] || '').replace(/^v/, '').trim();
const file = path.join(__dirname, '..', 'CHANGELOG.md');
const text = fs.readFileSync(file, 'utf8');
const lines = text.split(/\r?\n/);

const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const heading = new RegExp('^##\\s+v?' + escaped + '(\\s|$)');

const start = lines.findIndex((line) => heading.test(line));
if (start === -1) {
  console.error(`[changelog] 没有找到 v${version} 段落，输出整个文件`);
  process.stdout.write(text);
  process.exit(1);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
  if (/^##\s+/.test(lines[i])) { end = i; break; }
}

process.stdout.write(lines.slice(start, end).join('\n').trimEnd() + '\n');
