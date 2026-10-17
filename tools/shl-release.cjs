// 一次交付 = 一个可运行的版本目录 + 一条 git tag + 一份 CHANGELOG。
//
// 为什么需要它：D:\shl 是"跑起来的地方"，但每次构建都会覆盖同名 exe，
// 于是"最新做的东西在哪"就说不清了。这个脚本把每次交付固化下来：
//
//   D:\shl\
//     README.md                 ← 先看这个：源码在哪、最新版本是哪个、怎么重跑
//     LATEST.txt                ← 一行指向最新版本目录
//     CHANGELOG.md              ← 每次交付追加一段（时间/版本/commit/摘要）
//     releases\<version>-<sha>\  ← 一个完整可运行的便携包（解压即用，不用再装任何东西）
//
// 用法（在 source 目录下）：
//   node tools/shl-release.cjs "这次交付做了什么"
//   node tools/shl-release.cjs "..." --skip-build     # 复用上次构建产物
//   node tools/shl-release.cjs "..." --no-package     # 只记版本与 tag，不重新打包
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');                 // source/
const SHL = 'D:\\shl';
const QT_DIR = process.env.SHL_QT || 'D:\\Qt\\6.8.3\\mingw_64';
const MINGW_DIR = process.env.SHL_MINGW || 'D:\\Qt\\Tools\\mingw1310_64';

const argv = process.argv.slice(2);
const summary = argv.find((a) => !a.startsWith('--')) || '(未填写摘要)';
const skipBuild = argv.includes('--skip-build');
const noPackage = argv.includes('--no-package');

const sh = (cmd, args, cwd = ROOT) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, shell: false });
  if (r.status !== 0) {
    console.error(`[release] 失败：${cmd} ${args.join(' ')}\n${r.stderr || r.stdout || ''}`);
    process.exit(1);
  }
  return (r.stdout || '').trim();
};

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const sha = sh('git', ['rev-parse', '--short=7', 'HEAD']);
const full = sh('git', ['rev-parse', 'HEAD']);
const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
const dirty = sh('git', ['status', '--porcelain']).length > 0;
const stamp = `${pkg.version}-${sha}`;
const outDir = path.join(SHL, 'releases');
const dir = path.join(outDir, stamp);
const now = new Date();
const tz = 'UTC' + (-now.getTimezoneOffset() / 60 >= 0 ? '+' : '') + (-now.getTimezoneOffset() / 60);
const when = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} `
  + `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} (${tz})`;

console.log(`[release] ${stamp}  branch=${branch}  ${dirty ? '工作区有未提交改动（会一并记入）' : '工作区干净'}`);

// ── 1. 构建 ────────────────────────────────────────────────────────────────
if (!skipBuild) {
  const buildDir = path.join(ROOT, 'app_qml', 'build', 'release');
  const env = { ...process.env, PATH: `${path.join(QT_DIR, 'bin')};${path.join(MINGW_DIR, 'bin')};${process.env.PATH}` };
  console.log('[release] qmake + make …');
  const q = spawnSync('qmake.exe', [path.join(ROOT, 'app_qml', 'app_qml.pro')], { cwd: buildDir, env, encoding: 'utf8' });
  if (q.status !== 0) { console.error(q.stderr || q.stdout); process.exit(1); }
  const m = spawnSync('mingw32-make.exe', ['-f', 'Makefile.Release', '-j'], { cwd: buildDir, env, encoding: 'utf8' });
  if (m.status !== 0) { console.error((m.stdout || '') + (m.stderr || '')); process.exit(1); }
  console.log('[release] exe ->', fs.statSync(path.join(buildDir, 'release', 'StrongholdLink.exe')).size, '字节');
}

// ── 2. 打包到 releases\<version>-<sha> ─────────────────────────────────────
if (!noPackage) {
  fs.mkdirSync(outDir, { recursive: true });
  console.log('[release] 打包 …');
  const p = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'pack-qml.cjs'),
    '--out', path.join(outDir, stamp), '--skip-build', '--no-zip',
    '--qt', QT_DIR, '--mingw', MINGW_DIR], { cwd: ROOT, encoding: 'utf8' });
  const tail = ((p.stdout || '') + (p.stderr || '')).trim().split('\n').slice(-4).join('\n');
  console.log(tail);
  if (p.status !== 0) process.exit(1);

  // pack-qml 会建 <out>/<NAME>/；这里把它改名为 <version>-<sha>，让目录名就是版本号
  const staged = fs.readdirSync(path.join(outDir, stamp)).map((n) => path.join(outDir, stamp, n));
  const inner = staged.find((p2) => fs.statSync(p2).isDirectory() && /Stronghold-Link-/.test(path.basename(p2)));
  if (inner) {
    for (const ent of fs.readdirSync(inner)) {
      fs.renameSync(path.join(inner, ent), path.join(dir, ent));
    }
    fs.rmSync(inner, { recursive: true, force: true });
  }

  // QtQuick.Shapes：atlas 装饰层用 Shape/ShapePath，pack-qml 的固定清单里没有这个模块，
  // 缺了会报 module "QtQuick.Shapes" is not installed —— 这里补齐。
  const shapesSrc = path.join(QT_DIR, 'qml', 'QtQuick', 'Shapes');
  if (fs.existsSync(shapesSrc)) {
    const shapesDst = path.join(dir, 'qml', 'QtQuick', 'Shapes');
    fs.mkdirSync(shapesDst, { recursive: true });
    for (const f of fs.readdirSync(shapesSrc)) {
      fs.copyFileSync(path.join(shapesSrc, f), path.join(shapesDst, f));
    }
    const dll = path.join(QT_DIR, 'bin', 'Qt6QuickShapes.dll');
    if (fs.existsSync(dll)) fs.copyFileSync(dll, path.join(dir, 'Qt6QuickShapes.dll'));
    console.log('[release] 已补 QtQuick.Shapes 模块');
  }
}

// ── 3. 交付说明 + 版本目录里的 RELEASE.txt ────────────────────────────────
if (fs.existsSync(dir)) {
  fs.writeFileSync(path.join(dir, 'RELEASE.txt'), [
    `版本:    ${stamp}`,
    `时间:    ${when}`,
    `分支:    ${branch}`,
    `提交:    ${full}`,
    `摘要:    ${summary}`,
    '',
    '启动:    双击本目录里的「点我启动-StrongholdLink-QML版.cmd」',
    '来龙:    source 仓库的 git tag 为 release-' + stamp,
    '',
  ].join('\r\n'), 'utf8');
}

// ── 4. LATEST.txt / CHANGELOG.md / README.md ──────────────────────────────
fs.mkdirSync(SHL, { recursive: true });
fs.writeFileSync(path.join(SHL, 'LATEST.txt'),
  `${stamp}\r\n${path.join('releases', stamp)}\r\n${when}  ${summary}\r\n`, 'utf8');

const changelog = path.join(SHL, 'CHANGELOG.md');
if (!fs.existsSync(changelog)) {
  fs.writeFileSync(changelog, '# 交付记录\n\n每次交付一个可运行目录（D:\\shl\\releases\\<版本>-<commit>）。\n\n', 'utf8');
}
fs.appendFileSync(changelog, [
  `## ${stamp} — ${when}`,
  '',
  `- 提交：\`${full}\`（分支 ${branch}）`,
  `- 目录：\`D:\\shl\\releases\\${stamp}\``,
  `- 摘要：${summary}`,
  '',
].join('\n'), 'utf8');

// 用数组拼，避免在模板字符串里混进反引号与反斜杠（那会直接语法错误）
const BT = String.fromCharCode(96);
const readme = [
  '# D:\\shl 说明（先看这里）',
  '',
  '## 最新一版在哪',
  '看 **LATEST.txt**，第一行是最新版本号，第二行是可直接运行的目录。',
  '',
  '- 最新目录：' + path.join(SHL, 'releases', stamp),
  '- 启动方式：双击该目录里的「点我启动-StrongholdLink-QML版.cmd」（或 START-HERE.cmd）',
  '- 这一版对应源码提交：' + full + '（分支 ' + branch + '，git tag release-' + stamp + '）',
  '',
  '## 这里都有什么',
  '| 路径 | 作用 |',
  '|---|---|',
  '| ' + path.join(SHL, 'releases') + '\\<版本>-<commit>\\ | 每次交付一个完整可运行目录（自带 Qt 运行库 + node + 后端） |',
  '| ' + path.join(SHL, 'CHANGELOG.md') + ' | 交付流水（时间 / 版本 / commit / 摘要） |',
  '| ' + path.join(SHL, 'LATEST.txt') + ' | 指向最新版本 |',
  '| ' + path.join(SHL, 'qmlrun2') + ' | 我平时调试用的"热"目录，会被反复覆盖，别把它当版本 |',
  '| ' + path.join(SHL, 'tools') + ' | 矢量化 / 轮廓重建等一次性脚本 |',
  '',
  '## 源码在哪',
  '- 仓库：' + ROOT,
  '- 分支：' + branch + '（远端 origin/qml-migration）',
  '- releases 目录名里的短 hash 就是那次的源码提交，可随时 git checkout <hash> 回到当时。',
  '',
  '## 再做一次交付',
  '在 source 目录下：',
  '',
  '    node tools/shl-release.cjs "这次改了什么"',
  '',
  '会依次做：构建 → 打包到 ' + path.join(SHL, 'releases', '<版本>-<commit>') + ' → 写 RELEASE.txt →',
  '更新 LATEST.txt / CHANGELOG.md / 本 README → 打 git tag release-<版本>-<commit>。',
  '',
].join('\r\n');
fs.writeFileSync(path.join(SHL, 'README.md'), readme, 'utf8');

// ── 5. 打 tag 并推送 ──────────────────────────────────────────────────────
const tag = `release-${stamp}`;
try {
  sh('git', ['tag', '-a', tag, '-m', `${stamp}: ${summary}`]);
  sh('git', ['push', 'origin', tag]);
  console.log(`[release] git tag ${tag} 已推送`);
} catch (e) {
  console.log(`[release] tag 已存在或推送失败，可稍后手动处理：${e.message}`);
}

console.log(`\n[release] ✔ ${stamp}`);
console.log(`  可运行目录：${dir}`);
console.log(`  最新指针：  ${path.join(SHL, 'LATEST.txt')}`);
console.log(`  交付流水：  ${changelog}`);
