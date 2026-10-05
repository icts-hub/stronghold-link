'use strict';
// ============================================================================
// 把 Three.js 打成单文件经典脚本（开发工具，构建期运行）
//
// 为什么需要它：
//   Three 0.186 起是 ESM-only（build/three.cjs 只是转发壳）。我们的渲染进程是
//   sandbox + contextIsolation，CSP 为 script-src 'self'，且用 file:// 加载页面，
//   不能直接用 ESM import（file:// 下会被 CORS 拦）。所以这里把 Three 打成
//   IIFE + 全局变量 THREE 的单文件，作为静态资源随界面一起分发。
//
// 用法：
//   npm run vendor:three      （需要 devDependencies 里的 three 与 esbuild）
//
// 产物：src/ui/vendor/three.min.js（已入库；Three 为 MIT 许可，见 NOTICE.md）
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'src', 'ui', 'vendor');
const OUT_FILE = path.join(OUT_DIR, 'three.min.js');

function threeVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'three', 'package.json'), 'utf8'));
  return pkg.version;
}

async function main() {
  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch (err) {
    console.error('缺少 esbuild：请先执行  npm install');
    process.exit(1);
  }
  const entry = path.join(ROOT, 'node_modules', 'three', 'build', 'three.module.js');
  if (!fs.existsSync(entry)) {
    console.error('找不到 Three 入口：' + entry + '（请先 npm install）');
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    globalName: 'THREE',
    minify: true,
    target: ['chrome120'],
    legalComments: 'inline',
    outfile: OUT_FILE,
    logLevel: 'warning',
    banner: {
      js: `/* Three.js r${threeVersion()} (MIT) —— 由 tools/vendor-three.cjs 生成，请勿手工编辑。\n   重新生成：npm run vendor:three */`,
    },
  });
  if (result.errors && result.errors.length) {
    console.error('打包失败');
    process.exit(1);
  }
  const size = fs.statSync(OUT_FILE).size;
  console.log(`已生成 src/ui/vendor/three.min.js  ${(size / 1024).toFixed(1)} KB  (Three r${threeVersion()})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
