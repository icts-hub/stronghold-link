# 素材来源台账（ASSET_PROVENANCE）

本文件与同目录的 `asset-provenance.json` 是**同一份台账**的两种呈现：JSON 给机器读、给构建守卫
`tools/verify-asset-provenance.cjs` 校验，本文件给人看。两份内容必须一致 —— 守卫会把本文件里
找不到的哈希判为不一致并让构建失败。

- 项目：Stronghold Link 0.14.4
- 仓库：`C:\Users\18072\Documents\deepseek-harness\default-workspace\Stronghold-Link\source`
- 分支：`qml-migration`
- 本项目许可：**GPL-3.0-only**（仓库根目录 `LICENSE`，674 行，sha256
  `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986`）

## 字段约定

| 字段 | 含义 |
| --- | --- |
| `included_in_release` | `true` = 会随便携包/安装包分发；`false` = 只在仓库里或只作参考 |
| `redistribution_status` | `OK` 可再分发；`NO_REDISTRIBUTION` 上游明确禁止再分发；`UNVERIFIED` 权利没查清（**不许** `included_in_release=true`）；`N/A` 不适用（要写理由） |
| `sha256` | 文件内容的 SHA-256；指向目录或不适用时写 `N/A` 并说明 |

守卫会在以下情况让构建失败：字段缺失；`included_in_release=true` 却标着 `UNVERIFIED`/`NO_REDISTRIBUTION`；
台账哈希与磁盘不符；分发目录里出现未登记的图片/音频/字体/SVG/模型/JS-CSS 片段；
`ASSET_PROVENANCE.md` 与 JSON 互相矛盾；参考项目的游戏提取物派生物在权利未查清时出现在分发目录里。

## 总览

| # | asset_id | 内容 | 许可 | 随包分发 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | `shipped-third-party-notices` | 随包分发的第三方声明与许可证全文（`THIRD_PARTY_NOTICES.txt` + `LICENSES/`） | N/A（声明汇总） | 是 | OK |
| 2 | `project-license-gpl3` | 本项目 GPL-3.0 全文 | GPL-3.0-only | 是 | OK |
| 3 | `project-third-party-notices` | 开发期依赖清单（`NOTICE.md`） | N/A（声明汇总） | 是 | OK |
| 4 | `mig-qml-frontend` | QML 前端与 C++ 桥（迁移新增） | GPL-3.0-only | 是 | OK |
| 5 | `mig-backend-split` | Electron-free 后端入口与业务层 | GPL-3.0-only | 是 | OK |
| 6 | `ref-ui-study` | 参考项目界面规则（**只学习，未分发任何字节**） | UNVERIFIED | **否** | UNVERIFIED |
| 7 | `ref-game-derivatives` | 参考项目内《明日方舟》提取物派生物 | NO_REDISTRIBUTION | **否** | NO_REDISTRIBUTION |
| 8 | `qa-screenshots` | 本项目 QML 界面三页截图（三页 × 三分辨率，共 9 张） | GPL-3.0-only | 否 | OK |
| 9 | `qt-runtime` | Qt 6.8.3 运行库 | LGPL-3.0-only（动态链接） | 是 | OK（待补哈希） |
| 10 | `steamworks-sdk` | Steamworks SDK（`steam_api64.dll`） | Valve 专有 | **否** | NO_REDISTRIBUTION |
| 11 | `steamworks-ffi-node` | steamworks-ffi-node + koffi | MIT | 是 | OK（待补哈希） |
| 12 | `node-runtime` | Node.js 运行时（后端子进程） | MIT（本体） | **待定** | N/A |

## 逐条说明

### 1. `shipped-third-party-notices` — 随包分发的第三方声明与许可证全文

这是**必须进分发目录**的那一组文件。`THIRD_PARTY_NOTICES.txt` 的 sha256 是
`235b22a10007f5262fad501388d2ebc4cada47f1932195b261dc51d4d6aceeed`，它逐条说明随包组件、
各自的许可与许可证全文位置。`LICENSES/` 下四个文件：

| 文件 | 许可 | sha256 |
| --- | --- | --- |
| `LICENSES/GPL-3.0-only.txt` | GPL-3.0-only（本项目自身） | `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986` |
| `LICENSES/LGPL-3.0-only.txt` | LGPL-3.0-only（Qt） | `e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118` |
| `LICENSES/steamworks-ffi-node-MIT.txt` | MIT（steamworks-ffi-node 0.11.3） | `163e3136d3d1067a2fe50cf159236a3aab50fec8cfa5b1d0bbec1aeae39df58f` |
| `LICENSES/koffi-MIT.txt` | MIT（koffi 3.3.2） | `22bcbbbacd739b026a8dc484f62a31484ce4c4e31f3408b60b29b4e41d62b290` |

来源可核：`GPL-3.0-only.txt` 就是仓库根 `LICENSE`（逐字节相同，同一 sha256）；
`LGPL-3.0-only.txt` 取自 <https://www.gnu.org/licenses/lgpl-3.0.txt>；
两个 MIT 全文分别复制自 `node_modules/steamworks-ffi-node/LICENSE`（Copyright (c) 2025 Artur Khutak）
与 `node_modules/koffi/LICENSE.txt`（Copyright (C) 2026 Niels Martignène）。

**任务书的硬要求**：`LICENSES/`、`THIRD_PARTY_NOTICES.txt`、本文件与 `asset-provenance.json`
必须出现在**分发目录内部**，不能只留在 git 里、也不能藏进 `app.asar`；同时应用内
「设置 → 关于 / 开源许可」要有入口。打包脚本收尾时必须复制这些文件。

### 2. `project-license-gpl3` — 本项目自身的许可证

仓库根目录 `LICENSE` 是 GNU GPL v3 全文（第 1-2 行即 `GNU GENERAL PUBLIC LICENSE` /
`Version 3, 29 June 2007`），sha256 `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986`。
GPL-3.0 要求随二进制分发时提供完整许可证文本，因此分发目录根部与 `LICENSES/` 都要各放一份。

### 2. `project-third-party-notices` — 声明汇总

`NOTICE.md`，sha256 `6906537d73adba1d3e20d491297cfb281a23b808aac5fd9929bd783204208c88`。

**阅读陷阱**：`NOTICE.md` 现在写的 Electron / Three.js / MiSans / Inter 条目描述的是
**旧 Electron 渲染层**的依赖。QML 版不再打包 Electron、Three.js 与那两套字体子集，
所以看这份声明时必须对照本台账的第 3、5 条，不能据此认为 QML 包里还有 Electron。

### 3. `mig-qml-frontend` — QML 前端与 C++ 桥

本项目迁移中新增的代码，受根目录 `LICENSE`（GPL-3.0）覆盖，不含任何第三方代码片段。
入口文件 `app_qml/main.cpp`，sha256 `b1cf1dc87584c8403faa849c57c21d932b2f489fe0a8cd55d630e9d82bb68006`。
全部 14 个源码文件的逐个哈希：

| 文件 | sha256 |
| --- | --- |
| `app_qml/app_qml.pro` | `72c2ddc91388367e3222c37f52bfbec8c3146c2ed43e5d16483ecfe79f294b20` |
| `app_qml/main.cpp` | `711c88da3a7d39083eb2c2e041aa9aec2a6299cdaf896d918acf4f1b4e140e99` |
| `app_qml/backendbridge.h` | `c9b482175c9c53319831ad1b12f3e265af500c21123061186b3808b7a6314ffd` |
| `app_qml/backendbridge.cpp` | `59c1b379ba09031c7ebf77181ff2985d224f100b07594a85b97ddcd60f6a3bfb` |
| `app_qml/qml.qrc` | `16ec6d0155f30e942f7c88b412e7f86d6c3f3918e40cca5e344df0eb26085e2f` |
| `app_qml/qml/Main.qml` | `1ced2ba10c6627d434f68ea78902f4e70f5b0805fdbaa3617029bfd8b6802f9e` |
| `app_qml/qml/theme.js` | `0b40b078bc4e8c042a26e9b1be38ee1fd8c584dad6cec638978743a196afddb3` |
| `app_qml/qml/logic.js` | `afae0d3ada031b9a083fece0eba4c00c1f75ca7e9e37a3d093583e7d8c9c0a77` |
| `app_qml/qml/Pages/SessionPage.qml` | `04693ee8cce42a92b8654fec3ce0e2d48f9e757004f0278611227e4da2f801e7` |
| `app_qml/qml/Pages/FriendsPage.qml` | `76cf5e07c8c098518b7fe4a557809d1d83ab9728d7e91b775eaa75096ef6b36d` |
| `app_qml/qml/Pages/SettingPage.qml` | `d1cd99c28a64c8713fc064cadb24450fb435ec5f3048abdf193ae6b82956dd91` |
| `app_qml/qml/Components/HeroPlate.qml` | `0d37016e07c8793dc89e3ecd3b7f11ec88fe7e6592f706fd6205f0b1f2c760c0` |
| `app_qml/qml/plate/sketch.js` | `289ed1c68622af87825244952f60d707c3c181f48fb2f531a6a21066e2b65f67` |
| `app_qml/qml/plate/hero.js` | `cb7cadd4b4c925b6aa7bd4e40bb97f0ff2464d529cadebcbed56c88f7b84699a` |
| `app_qml/qml/Pages/SettingPage.qml` | `d286af92487deb29281046fe1a770d7d541b95117a37e670b9669d65ffb63342` |

其中 12 个 `Components/*.qml` 与 `qml.qrc` 里列出的其它资源同属本记录，哈希以 `qml.qrc` 的清单为准
（守卫会在它们出现在分发目录而未登记时报错）。

### 4. `mig-backend-split` — 后端拆分

从 `electron/main.cjs` 摘出的业务逻辑，同属本项目 GPL-3.0 源码：

| 文件 | sha256 |
| --- | --- |
| `backend/stronghold-backend.cjs` | `4f0768101db4d3df6e5ab2262a35f853288617fa7f429ad365a0f5961b20f79b` |
| `backend/business.cjs` | `cd26e630e6359d162458ce4d266d650826d7eee1b2cd260d328d8e7ce5661a06` |

`network/` 下 33 个 `.cjs` 未改动，仍是同一份 GPL-3.0 源码。

### 5. `ref-ui-study` — 参考项目（**只学习，未分发任何字节**）

- 来源：`https://github.com/Funkierry/the-masses-travels`
- 固定提交：`7ea40aea1ff28f84c20d58eae5f30497b093517d`
- 研读文件：`src/sketch.ts`、`src/collage.ts`、`src/plates.ts`、`src/graphic.css`、`src/style.css` 等
- **不能据此认定它 MIT**：该提交的根目录列不出 `LICENSE`；`package.json` 没有 `license` 字段
  且是 `"private": true`；`src/*.ts` 没有版权头。
- **阅读陷阱**：它自带的 `THIRD_PARTY_NOTICES.txt:10-28` 里那段 MIT 正文是 **three.js** 的，
  不是这个项目自身的许可。只看那段就下"整仓库 MIT"的结论是错的。

因此本记录的状态是 `UNVERIFIED`，且 `included_in_release=false` —— 没有从它引入任何字节。
`app_qml/qml` 里复刻的是**视觉规则**（纸色 `#e9ecec`/`#eff1ef`、墨色 `#22282b`、次级 `#6c7679`、
钴蓝 `#3a5bc2`、高亮蓝 `#2a3fff`、天蓝 `#4c92d4`；细线、页边刻度、十字准星、切角、尺线、
拼贴、套印式双描边），实现方式是 QML `Canvas` 自写：随机数由固定种子的伪随机生成器给出，
曲线是参数方程，没有逐行移植它的 TypeScript。

### 6. `ref-game-derivatives` — 《明日方舟》游戏提取物派生物（**红线：不许分发**）

参考项目的 `public/assets/game/**` 里是《明日方舟》客户端提取物（地图、图集切图、立绘、活动 BGM）。
其自带 `THIRD_PARTY_NOTICES.txt` 原文写明这些提取物 *"for private study only. They must not be
redistributed."*，README 也把美术与音乐署名给鹰角网络。

所以：**裁剪/调色/压缩后的派生物同样不许分发**。本项目一个字节都没有引入 ——
`app_qml` 下唯一的位图是第 7 条那三张自渲染截图，而它们也不进便携包。

### 7. `qa-screenshots` — 本项目界面截图

由本项目 QML 界面用 `--grab` 开关自行渲染（画面内容全是本项目自己的界面元素），
三页 × 三分辨率共 9 张，仅用于文档与验收，`included_in_release=false`。
生成脚本 `tools/make-shots.cjs`（串行、带重试；注意被测程序是 GUI 子系统程序，
必须由它自己拼好 Qt 的 PATH，否则会以 `0xC0000135` 直接退出、连日志都不写）：

| 文件 | sha256 |
| --- | --- |
| `app_qml/shots/session-1440x900.png` | `dfa08dc2701794ab279e94171e461fd9f0a2bafc88522fd208c02b63540f2ccf` |
| `app_qml/shots/friends-1440x900.png` | `0ae8d6fbffe4e89c4fc944410f9d9d15e601b098c9c2abcfc9cd081dcccaa61e` |
| `app_qml/shots/setting-1440x900.png` | `866e0f59d7db8c5e8d23a8ec7d2c5cbbb9b86442ad9b5ea11f0ccf4d349c57d6` |
| `app_qml/shots/session-1280x720.png` | `8a37474f1603d01d90b6779de6bd23ed3c483c95c7c34e63f7a72beb10fb9890` |
| `app_qml/shots/friends-1280x720.png` | `0d01136604dbe6484d941718cf6950bf710edfd708208aaa9cc1ca61b30da225` |
| `app_qml/shots/setting-1280x720.png` | `d984ab43659484404fbd2e536f2af481a18d5d007d6b6ba8953502032d55602b` |
| `app_qml/shots/session-1024x768.png` | `d52ae86a93fb25a7be9e41f6474b4bede880ef60bae7ba9f3b719bc1db1d82af` |
| `app_qml/shots/friends-1024x768.png` | `707d9adfee29d9ea86e1297252b5f8f04ee40a59ba6e94eaab36e5d56322b1d4` |
| `app_qml/shots/setting-1024x768.png` | `215c59f5491f374f1260e14b2f0abce0a20ebc00673f82d61f33d7a51aa67fc7` |

### 8. `qt-runtime` — Qt 6.8.3（**待补哈希**）

便携包会把 Qt 运行库（`Qt6Core.dll`、`Qt6Gui.dll`、`Qt6Qml.dll`、`Qt6Quick.dll` 等）与
`platforms/qwindows.dll` 复制到 exe 旁边。LGPL-3.0 的义务：动态链接、随包附许可证全文、
**允许用户替换 Qt 库**（因此不得静态链接，也不得阻止替换 DLL）。最终打包时按实际复制进去的
DLL 清单补 `sha256`，并把 `LICENSE.LGPL3`（或 `LICENSE.GPL3`，取决于构建配置）复制到 `LICENSES/`。

### 9. `steamworks-sdk` — Valve 专有（**不许分发**）

Steamworks SDK 许可禁止把 SDK 的 DLL 重新分发；仓库 `.gitignore` 已把 `steamworks_sdk/**/*.dll`
排除，需使用者自行放入。便携包内不含 `steam_api64.dll`；缺失时必须由 `diagnoseSteam()` 预检
给出可读诊断，绝不允许进程崩溃。

### 10. `steamworks-ffi-node` — MIT（**待补哈希**）

`steamworks-ffi-node` 与其 FFI 运行时 `koffi` 均为 MIT。若便携包随附 `node_modules` 里的这两个包，
必须同时把它们的 `LICENSE` 全文复制到 `LICENSES/`。

### 11. `node-runtime` — Node.js（**分发决策待定**）

开发与验收期用的是系统安装的 Node（`D:\Program Files\nodejs\node.exe`）。
随包带 `node.exe` 就要附 Node 的 LICENSE（本体 MIT + 内嵌组件各自的许可）；
改为要求用户自装 Node 则不属于分发。**决策未定**，因此这一条的 `redistribution_status` 是
`N/A` 并注明待定 —— 任务书禁止在未验证前宣称可分发。

## 待办（必须做完才能发布）

1. `qt-runtime`、`steamworks-ffi-node` 的 `sha256` 按最终便携包内容补全。
2. 确定 `node-runtime` 的分发决策，并把结论写进 `README`/`NOTICE.md` 与打包脚本。
3. 打包脚本收尾时复制 `LICENSES/`、`NOTICE.md`、本文件与 `asset-provenance.json`
   **到分发目录内部**（不能只留在 git，也不能藏进 `app.asar`）。
4. 把 `node tools/verify-asset-provenance.cjs` 接进打包流程，让它失败即拒绝出包。
