'use strict';

/* three 的别名替身。
   GLTFLoader 属于 three 的 examples，源码里写的是 `import { ... } from 'three'`。
   本项目把 three 以 IIFE 形式内置成全局 THREE，没有模块解析。
   打包 GLTFLoader 时把 'three' 指到这个文件，导入就落到全局对象上。 */

module.exports = globalThis.THREE;
