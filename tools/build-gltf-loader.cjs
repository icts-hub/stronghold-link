'use strict';

/* 把 three 的 examples/jsm/loaders/GLTFLoader.js 打成一份浏览器可直接用的 IIFE，
   挂到全局 THREE.GLTFLoader 上。

   为什么需要这一步：
   本项目把 three 以 build/three.min.js 的 IIFE 形式内置，运行时只有全局 THREE，
   没有 import map，也没有模块解析。GLTFLoader 只有 ESM 源码，直接放进 index.html
   会报 "Cannot use import statement outside a module"。
   所以用 esbuild 把它连同它依赖的两个 utils 一起打成 IIFE，并把 'three' 这个
   裸导入替换成 tools/three-shim.cjs，后者把全局 THREE 当模块导出。

   产物：src/ui/vendor/gltf-loader.js，加载顺序必须在 three.min.js 之后。

   用法：node tools/build-gltf-loader.cjs */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENTRY = path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'loaders', 'GLTFLoader.js');
const SHIM = path.join(ROOT, 'tools', 'three-shim.cjs');
const OUT = path.join(ROOT, 'src', 'ui', 'vendor', 'gltf-loader.js');

async function main() {
  if (!fs.existsSync(ENTRY)) {
    console.error('找不到 GLTFLoader 源文件：' + ENTRY);
    console.error('请先 npm install，确认 node_modules/three 存在。');
    process.exit(1);
  }

  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch (err) {
    console.error('找不到 esbuild，无法打包 GLTFLoader：' + err.message);
    process.exit(1);
  }

  const result = await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'iife',
    globalName: '__SHL_GLTF_BUNDLE',
    platform: 'browser',
    target: ['chrome120'],
    minify: true,
    legalComments: 'none',
    alias: { three: SHIM },
    outfile: OUT,
    banner: { js: '/* 由 tools/build-gltf-loader.cjs 生成，请勿手改。源：three/examples/jsm/loaders/GLTFLoader.js */' },
    footer: { js: 'if (typeof THREE !== "undefined" && __SHL_GLTF_BUNDLE) { THREE.GLTFLoader = __SHL_GLTF_BUNDLE.GLTFLoader; }' },
    metafile: true
  });

  const bytes = fs.statSync(OUT).size;
  console.log('已生成 ' + path.relative(ROOT, OUT) + '，' + bytes + ' 字节');
  for (const [file, info] of Object.entries(result.metafile.inputs)) {
    if (file.includes('node_modules')) console.log('  纳入 ' + file + '（' + info.bytes + ' 字节）');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
