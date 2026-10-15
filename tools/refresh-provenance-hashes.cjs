#!/usr/bin/env node
/**
 * 台账哈希刷新器：把 asset-provenance.json 里"登记了具体文件"的条目，按磁盘实际内容重算 sha256。
 *
 * 为什么需要：每次改动被登记的源文件（app_qml/main.cpp、network/steam-adapter.cjs 之类），
 * 台账里的哈希就会过期，构建守卫 `tools/verify-asset-provenance.cjs` 会如实报错。
 * 手抄哈希既慢又容易抄错，这个脚本只做一件事：复算、对账、写回。
 *
 * 用法：
 *   node tools/refresh-provenance-hashes.cjs           # 预演，只打印差异
 *   node tools/refresh-provenance-hashes.cjs --write   # 写回 JSON
 *
 * 安全边界：
 *   · 只动 sha256 一个字段；条目、字段顺序、其它值一律不碰。
 *   · installed_path 指向目录或写 N/A 的条目跳过（无法哈希）。
 *   · 文件缺失时只报告，不写回，退出码 1。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const repoRoot = path.resolve(__dirname, '..');
const jsonPath = path.join(repoRoot, 'asset-provenance.json');
const write = process.argv.includes('--write');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const doc = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const records = Array.isArray(doc.assets) ? doc.assets : [];
let changed = 0;
let missing = 0;
let skipped = 0;

for (const rec of records) {
  const rel = rec.installed_path;
  if (!rel || rel === 'N/A') { skipped += 1; continue; }
  const abs = path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { skipped += 1; continue; }
  const actual = sha256(abs);
  if (rec.sha256 === actual) continue;
  changed += 1;
  console.log(`  ${write ? '写回' : '待更新'} [${rec.asset_id}] ${rel}`);
  console.log(`        台账 ${rec.sha256}`);
  console.log(`        磁盘 ${actual}`);
  if (write) rec.sha256 = actual;
}

// installed_files 里的分组（每个元素 {path, sha256}）同样复算。
const groups = (doc.INSTALLED_FILES && typeof doc.INSTALLED_FILES === 'object') ? doc.INSTALLED_FILES : {};
for (const [group, list] of Object.entries(groups)) {
  if (!Array.isArray(list)) continue;
  for (const item of list) {
    const rel = item && item.path;
    if (!rel) continue;
    const abs = path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      console.log(`  ✖ [${group}] 文件不存在：${rel}`);
      missing += 1;
      continue;
    }
    const actual = sha256(abs);
    if (item.sha256 === actual) continue;
    changed += 1;
    console.log(`  ${write ? '写回' : '待更新'} [${group}] ${rel}`);
    console.log(`        台账 ${item.sha256}`);
    console.log(`        磁盘 ${actual}`);
    if (write) item.sha256 = actual;
  }
}

if (missing) {
  console.log(`\n台账哈希刷新：有 ${missing} 个登记文件在磁盘上找不到，未写回。`);
  process.exit(1);
}

if (!changed) {
  console.log('台账哈希刷新：全部一致，无需改动。');
  process.exit(0);
}

if (!write) {
  console.log(`\n台账哈希刷新：${changed} 处待更新（加 --write 写回）；跳过 ${skipped} 条（目录/N/A）。`);
  process.exit(0);
}

// JSON.stringify 会丢掉原文件的缩进风格之外的东西，所以先探明缩进再写。
const raw = fs.readFileSync(jsonPath, 'utf8');
const indentMatch = raw.match(/\n(\s+)"/);
const indent = indentMatch ? indentMatch[1] : '  ';
fs.writeFileSync(jsonPath, JSON.stringify(doc, null, indent) + '\n', 'utf8');
console.log(`\n台账哈希刷新：已写回 ${changed} 处 → ${path.relative(repoRoot, jsonPath)}`);
console.log('注意：ASSET_PROVENANCE.md 里的哈希若是单独列出的，需要同步（守卫会检查两端一致）。');
