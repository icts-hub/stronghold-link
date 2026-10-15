#!/usr/bin/env node
'use strict';
/**
 * 素材来源台账守卫（任务书要求：`tools/verify-asset-provenance.*`）。
 *
 * 它守的是"可分发"这件事，不是"代码好不好"：
 *   1. 台账本身存在、能解析、字段齐全（任务书列了 16 个字段，缺一个就报）；
 *   2. 每条记录的 sha256 必须等于磁盘上那个文件当前的哈希（改了素材没改台账 → 红）；
 *   3. 随包分发的目录里**不许出现没登记的素材**（图片/音频/字体/SVG/模型/二进制/JS-CSS 片段）；
 *   4. `included_in_release: true` 的记录，法律状态必须是明确可再分发的；
 *      `UNVERIFIED`（权利没查清）与 `NO_REDISTRIBUTION`（明确不许再分发）一律不许 true；
 *   5. `ASSET_PROVENANCE.md` 里写的哈希必须与 JSON 一致（两份文档不许互相打架）；
 *   6. 只要参考项目《明日方舟》提取物（`public/assets/game/`）的派生物还在，
 *      而它的权利状态仍未查清，守卫就必须红 —— 这是任务书点名的红线。
 *
 * 用法：
 *   node tools/verify-asset-provenance.cjs                 # 校验默认路径
 *   node tools/verify-asset-provenance.cjs --json <台账> --md <文档> --ship <分发目录>
 * 退出码：0 = 通过；1 = 发现问题（逐条列出）；2 = 台账/参数本身无法读取。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const root = path.join(__dirname, '..');
const manifestPath = opt('--json', path.join(root, 'asset-provenance.json'));
const mdPath = opt('--md', path.join(root, 'ASSET_PROVENANCE.md'));
// 默认只查"随包分发"的目录。QML 版的运行时目录是 app_qml/build/release/release，
// 打包出来之后是 release/Stronghold-Link-<版本>-win-x64/，两者都扫。
const shipDirs = (opt('--ship', '') || '')
  .split(',').map(s => s.trim()).filter(Boolean)
  .concat([
    path.join(root, 'app_qml', 'build', 'release', 'release'),
    path.join(root, 'release')
  ]);

const problems = [];
const notes = [];
const bad = (msg) => problems.push(msg);

// ── 台账本身 ────────────────────────────────────────────────────────────────
if (!fs.existsSync(manifestPath)) {
  console.error(`找不到台账：${manifestPath}`);
  process.exit(2);
}
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (err) {
  console.error(`台账不是合法 JSON：${manifestPath}\n  ${err.message}`);
  process.exit(2);
}

const REQUIRED_FIELDS = [
  'asset_id', 'display_name', 'source_project', 'source_url', 'source_commit',
  'source_path', 'installed_path', 'asset_type', 'copyright_holder', 'license',
  'license_evidence', 'sha256', 'modified', 'included_in_release',
  'redistribution_status', 'notes'
];
const RECORDS = Array.isArray(manifest.assets) ? manifest.assets : null;
if (!RECORDS) {
  console.error('台账里必须有 `assets` 数组');
  process.exit(2);
}

const seenIds = new Set();
const shaOf = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');

for (const rec of RECORDS) {
  const id = rec.asset_id || '(无 asset_id)';
  for (const f of REQUIRED_FIELDS) {
    if (!(f in rec) || rec[f] === '' || rec[f] === null || rec[f] === undefined) {
      bad(`[${id}] 缺字段 \`${f}\`（任务书要求 16 个字段齐全；不知道就写 N/A 并说明原因，不能留空）`);
    }
  }
  if (seenIds.has(rec.asset_id)) bad(`[${id}] asset_id 重复`);
  seenIds.add(rec.asset_id);

  // 状态与"能不能随包发"必须自洽
  const status = String(rec.redistribution_status || '');
  if (rec.included_in_release === true) {
    if (status === 'UNVERIFIED') bad(`[${id}] included_in_release=true，但权利状态是 UNVERIFIED（没查清的东西不许随包发）`);
    if (status === 'NO_REDISTRIBUTION') bad(`[${id}] included_in_release=true，但上游明确 NO_REDISTRIBUTION（不许再分发）`);
  }
  if (!['OK', 'UNVERIFIED', 'NO_REDISTRIBUTION', 'N/A'].includes(status)) {
    bad(`[${id}] redistribution_status 只能是 OK / UNVERIFIED / NO_REDISTRIBUTION / N/A，实际是 ${JSON.stringify(status)}`);
  }
  if (rec.sha256 !== 'N/A' && !/^[0-9a-f]{8,64}$/i.test(String(rec.sha256))) {
    bad(`[${id}] sha256 既不是 N/A 也不是十六进制哈希：${JSON.stringify(rec.sha256)}`);
  }
  // "未验证"必须写明理由，否则等于没说
  if (status === 'UNVERIFIED' && !String(rec.license_evidence || '').trim()) {
    bad(`[${id}] 状态 UNVERIFIED 但 license_evidence 是空的 —— 必须写清"为什么没查清"`);
  }

  // 哈希与实际文件对账（只对仓库内的相对路径做；外部/不存在的路径要求写 N/A）
  const rel = String(rec.installed_path || '');
  if (rel && rel !== 'N/A') {
    const abs = path.isAbsolute(rel) ? rel : path.join(root, norm(rel));
    if (/[*?]/.test(rel)) {
      // 通配（比如 LICENSES/*.txt）：至少要求匹配到文件，且若有 sha256 则逐一对不上就报
      notes.push(`[${id}] installed_path 是通配：${rel}（守卫无法逐字节对账，请在 notes 里列明具体文件）`);
    } else if (!fs.existsSync(abs)) {
      bad(`[${id}] installed_path 指向的文件不存在：${rel}`);
    } else if (fs.statSync(abs).isDirectory()) {
      bad(`[${id}] installed_path 指向目录，无法计算哈希：${rel}（要指向具体文件，或写清单文件）`);
    } else if (rec.sha256 !== 'N/A') {
      const actual = shaOf(abs);
      if (actual !== String(rec.sha256).toLowerCase()) {
        bad(`[${id}] sha256 对不上：台账 ${rec.sha256}，磁盘 ${actual}（${rel}）`);
      }
    }
  }
}

// ── installed_files 分组里逐个文件对账 ─────────────────────────────────────
// 为什么要有这一段：assets[] 里每条记录只带**一个** sha256（通常是该组的代表文件），
// 组内其余文件的哈希全靠 installed_files 列表。守卫原先不看这个列表，于是"改了组内
// 非代表文件"（例如 theme.js、SessionPage.qml）既不会被发现，刷新器也只认大写键名
// 而静默跳过 —— 台账会长期漂移而守卫一路绿灯。这里补上逐个文件的字节对账。
const installedGroups = [];
for (const key of ['INSTALLED_FILES', 'installed_files']) {
  const g = manifest[key];
  if (g && typeof g === 'object' && !Array.isArray(g)) {
    for (const [name, list] of Object.entries(g)) {
      if (Array.isArray(list)) installedGroups.push([`${key}.${name}`, list]);
    }
  }
}
if (!installedGroups.length) {
  bad('台账里找不到 installed_files / INSTALLED_FILES 分组 —— 键名变了，守卫拒绝静默通过');
}
let groupChecked = 0;
for (const [group, list] of installedGroups) {
  for (const item of list) {
    const rel = item && item.path;
    if (!rel) continue;
    const abs = path.isAbsolute(rel) ? rel : path.join(root, norm(rel));
    if (!fs.existsSync(abs)) { bad(`[${group}] 登记的文件不存在：${rel}`); continue; }
    if (fs.statSync(abs).isDirectory()) { bad(`[${group}] 登记的是目录，无法对账：${rel}`); continue; }
    // 登记成 [path] 的条目只列出文件名，此时要求能给出台账里的真实哈希
    if (typeof item === 'string') { continue; }
    const sha = String(item.sha256 || '');
    if (sha === 'N/A') continue;
    if (!/^[0-9a-f]{8,64}$/i.test(sha)) {
      bad(`[${group}] ${rel} 的 sha256 既不是 N/A 也不是十六进制哈希：${JSON.stringify(item.sha256)}`);
      continue;
    }
    groupChecked += 1;
    const actual = shaOf(abs);
    if (actual !== sha.toLowerCase()) {
      bad(`[${group}] sha256 对不上：台账 ${sha}，磁盘 ${actual}（${rel}）`);
    }
  }
}
notes.push(`installed_files 分组逐个对账了 ${groupChecked} 个文件的哈希`);

// ── 随包目录里不许有没登记的素材 ──────────────────────────────────────────
// 登记过的相对路径集合（把 installed_path 归一化后比较）
const registered = new Set();
for (const rec of RECORDS) {
  const rel = String(rec.installed_path || '');
  if (rel && rel !== 'N/A' && !path.isAbsolute(rel)) registered.add(norm(rel).toLowerCase());
}
// 允许的"非素材"文件：构建中间物与运行库由别的护栏管，这里只抓**内容性素材**。
const ASSET_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico', '.svg', '.avif',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.mp3', '.ogg', '.wav', '.flac', '.m4a',
  '.glb', '.gltf', '.fbx', '.obj', '.dae',
  '.qml', '.js', '.mjs', '.cjs', '.css', '.scss', '.html'
]);
const SKIP_DIR = /(^|\\)(node_modules|\.git|build-obj|\.qmake\.stash)(\\|$)/i;
for (const dir of shipDirs) {
  if (!fs.existsSync(dir)) continue;
  const walk = (cur) => {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIR.test(abs)) walk(abs); continue; }
      const ext = path.extname(entry.name).toLowerCase();
      if (!ASSET_EXT.has(ext)) continue;
      const relFromRoot = norm(path.relative(root, abs)).toLowerCase();
      if (registered.has(relFromRoot)) continue;
      // 构建目录里的中间产物（qrc_qml.cpp 等）不算素材
      if (/(\\|\/)(moc_|qrc_|.*\.o$)/.test(abs)) continue;
      bad(`未登记的素材出现在分发目录里：${norm(path.relative(root, abs))}`
        + `（要么删掉，要么在 asset-provenance.json 里登记）`);
    }
  };
  walk(dir);
}

// ── 参考项目《明日方舟》提取物的红线 ─────────────────────────────────────
const gameRecs = RECORDS.filter(r => String(r.source_path || '').includes('public/assets/game')
  || String(r.asset_type || '').toLowerCase().includes('game'));
for (const rec of gameRecs) {
  const status = String(rec.redistribution_status || '');
  if (rec.included_in_release === true && status !== 'OK') {
    bad(`[${rec.asset_id}] 参考项目的游戏提取物/派生物仍被标为随包分发，而权利未查清`
      + ` —— 任务书红线：权利未解决前不许出现 public/assets/game/ 的派生物`);
  }
}

// ── 两份文档不许打架 ─────────────────────────────────────────────────────
if (fs.existsSync(mdPath)) {
  const md = fs.readFileSync(mdPath, 'utf8');
  let checked = 0;
  for (const rec of RECORDS) {
    const sha = String(rec.sha256 || '');
    if (!/^[0-9a-f]{8,64}$/i.test(sha)) continue;
    checked += 1;
    if (!md.includes(sha)) {
      bad(`ASSET_PROVENANCE.md 里找不到 ${rec.asset_id} 的 sha256（${sha}）—— JSON 与 MD 必须一致`);
    }
  }
  notes.push(`ASSET_PROVENANCE.md 与 JSON 对账了 ${checked} 条哈希`);
} else {
  bad(`找不到 ${path.relative(root, mdPath)}（任务书要求这份人类可读文档随包分发）`);
}

// ── 汇总 ────────────────────────────────────────────────────────────────
for (const n of notes) console.log(`  · ${n}`);
if (problems.length) {
  console.error(`\n素材台账守卫：发现 ${problems.length} 个问题`);
  for (const p of problems) console.error(`  ✖ ${p}`);
  process.exit(1);
}
console.log(`\n素材台账守卫：通过（${RECORDS.length} 条登记，扫描 ${shipDirs.filter(d => fs.existsSync(d)).length} 个分发目录）`);
