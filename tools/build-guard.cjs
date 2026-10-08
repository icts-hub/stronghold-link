'use strict';
// 打包护栏 —— 三道，任何一道都能拦住 2026-10-09 那次事故。
//
// 事故经过：`package.json` 的第一个字节多了一个 UTF-8 BOM（EF BB BF）。
// electron-builder 的 @electron/rebuild 会直接 JSON.parse 这个文件，于是它在
//   ⨯ Unexpected token '', "{ "name"... is not valid JSON   failedTask=build
// 处就退出了 —— 而这一步发生在「写 resources/app.asar」之前。build-edition.cjs
// 原本的容错分支是「退出码非 0 没关系，win-unpacked 还在就继续」，可那个
// win-unpacked 是上一次打包留下的旧目录；结果 0.14.1 的 app.asar 被改名成
// 0.14.2 一路压进了 tar.xz 准备交付。asar 里搜 APP_VERSION 一直是 0.14.1。
//
// 所以三道护栏是：
//   1) 打之前 —— package.json 绝不能带 BOM（就地给出可读的报错，而不是让
//      electron-builder 吐一句看不懂的 JSON 错误再被容错分支吞掉）。
//   2) 打之后 —— app.asar 必须真的被重新写过（mtime 或大小得有变化）。
//   3) 打之后 —— app.asar 里的 APP_VERSION 必须等于 package.json 的版本。
//
// 这三条都不依赖 electron-builder 的退出码，所以「图标转 ICO 那步联网失败
// 但产物其实完整」那种既有的容错场景照样能过。

// UTF-8 BOM 的三个字节
const BOM = [0xef, 0xbb, 0xbf];

const hasBom = (buf) => Buffer.isBuffer(buf) && buf.length >= 3
  && buf[0] === BOM[0] && buf[1] === BOM[1] && buf[2] === BOM[2];

// 1) BOM 检查。只检查真正会被 electron-builder 解析的那几个 JSON 文件 ——
//    Node 自己加载 .cjs / .json 时会剥掉 BOM，所以只有 builder 直接读的那个
//    package.json 会炸。（仓库里另有十几个历史遗留的 BOM 文件，无害，不动。）
const assertNoBom = (relPath, buf) => {
  if (!hasBom(buf)) return;
  throw new Error(
    `${relPath} 带 UTF-8 BOM（EF BB BF）：electron-builder 的 @electron/rebuild `
    + '会 JSON.parse 失败，而它发生在写 app.asar 之前 —— 结果是上一次的旧 app.asar '
    + '被打包成本次版本发出去（0.14.2 真踩过）。请把它存成「UTF-8 无 BOM」。');
};

// app.asar 是二进制容器，但里面是明文。用 latin1 读，搜 ASCII 版本号即可
// （中文锚点会乱码，所以别用中文串去核验 asar）。
const asarVersion = (buf) => {
  const text = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf);
  const m = /APP_VERSION\s*=\s*'([^']+)'/.exec(text);
  return m ? m[1] : null;
};

const statOf = (file) => {
  try {
    const s = require('node:fs').statSync(file);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch (err) {
    return null;
  }
};

// 2) 必须真的重写过
const assertAsarRewritten = (before, after) => {
  if (!after) {
    throw new Error('electron-builder 跑完却没有产出 resources/app.asar —— 拒绝继续打包');
  }
  if (before && before.size === after.size && before.mtimeMs === after.mtimeMs) {
    throw new Error(
      'electron-builder 没有重新写出 app.asar（大小与 mtime 都没变）：它多半在写 asar 之前 '
      + '就失败了，而 win-unpacked 是上一次留下的旧目录。拒绝把上一次的旧产物当成本次版本打包出去。');
  }
};

// 3) 版本必须对得上
const assertAsarVersion = (buf, expected) => {
  const got = asarVersion(buf);
  if (got !== expected) {
    throw new Error(
      `app.asar 里的 APP_VERSION 是 ${got === null ? '（找不到）' : got}，`
      + `但 package.json 说这一版是 ${expected} —— 打进包里的是旧代码，不能交付。`);
  }
};

module.exports = { hasBom, assertNoBom, asarVersion, assertAsarRewritten, assertAsarVersion, statOf };
