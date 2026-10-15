Stronghold Link — QML 版便携包 / QML edition, portable
版本 version: 0.14.5        包内每个文件的 sha256 见 PORTABLE-CONTENTS.txt

怎么启动 / HOW TO START
-----------------------
  双击「点我启动-StrongholdLink-QML版.cmd」（英文名 START-HERE.cmd，内容相同）。
  也可以直接双击 StrongholdLink.exe；启动器多做的事是把启动日志写到
  %APPDATA%\stronghold-link\qml-startup.log，并在失败时把退出码翻译成人话。

  不需要装 Qt、不需要装 Node —— Qt 运行库与 node.exe 都在包里。

Steam 隧道要自备 Steamworks SDK / BRING YOUR OWN STEAMWORKS SDK
--------------------------------------------------------------
  本包**不含** Valve 的 steam_api64.dll（Steamworks 授权不允许随包分发）。
  要用 Steam P2P 隧道，请把你自己的 Steamworks SDK 里的 redistributable 放成：

      <本包>\steamworks_sdk\redistributable_bin\win64\steam_api64.dll

  即 exe 同级建一个 steamworks_sdk 目录（目录名必须是这个），把 DLL 放进去。
  没有它也能用：本地中继、局域网直连、TCP/UDP 端口转发都照常工作，
  只有「Steam 隧道」这一种连接方式不可用（界面里会给出诊断步骤）。
  测试用 AppID 480（Spacewar）请用小号，不要拿主号试。

数据放在哪 / WHERE DATA LIVES
-----------------------------
  %APPDATA%\stronghold-link\     会话档案 game-profiles.json
                                 后端单实例锁 backend.lock
                                 启动日志 qml-startup.log、launcher.log
  删掉这个目录 = 恢复出厂状态（会丢会话档案）。

Qt 与 LGPL / QT AND THE LGPL
----------------------------
  包里的 Qt6*.dll、plugins\、qml\ 来自 Qt 6.8.3，以 LGPL-3.0-only 授权、
  动态链接方式分发。**你可以用自己编译的 Qt6*.dll 覆盖包里的同名文件** ——
  本程序不加壳、不做完整性自校验、不阻止替换（这正是 LGPL 的要求）。
  Qt 全文：LICENSES\LGPL-3.0-only.txt

  本程序自身以 GPL-3.0-only 授权：LICENSES\GPL-3.0-only.txt
  第三方组件与素材来源：THIRD_PARTY_NOTICES.txt、ASSET_PROVENANCE.md、
  asset-provenance.json（四份法务文件都在包内）。

已知限制 / KNOWN LIMITS
-----------------------
  * 内存：空闲约 300~330 MiB，持续切页最坏约 375 MiB —— 高于 100 MiB 的目标。
    架构地板就已经是 92 MiB 左右（Node 后端 49 + Qt 窗口 36 + conhost 7）。
  * 只在 Windows 10/11 x64 上验证过；macOS / Linux 未测。
  * 真机「双机 + 双 Steam 账号」的 P2P 传输与 10 分钟字节账本对账还没做过
    （传输层测试目前跑在模拟 SDK 上）。
  * 注入型软件（游戏加加 GamePP、各类游戏内覆盖层）会让本程序以 0xC0000005
    退出；启动器会检测并提示，详见它打印的排查步骤。

包内容 / WHAT'S INSIDE
----------------------
  StrongholdLink.exe          QML 前端（界面与会话管理，Qt Quick，不含 QtWebEngine）
  Qt6*.dll / plugins\ / qml\  Qt 运行库（windeployqt --compiler-runtime 部署）
  node\node.exe               Node 运行时（后端是独立 Node 进程，不依赖 Electron）
  backend\  network\          后端与网络层（stdin/stdout JSON Lines 协议）
  node_modules\               steamworks-ffi-node + koffi（均为 MIT）
  LICENSES\ + 三份声明/台账    法务文件
  PORTABLE-CONTENTS.txt       本包完整文件清单与 sha256（打包时按实际结果生成）
