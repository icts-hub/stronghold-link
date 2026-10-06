# Stronghold Link

**通用内网穿透工具**，Electron 桌面应用：把本机的 TCP/UDP 服务开放给好友。
局域网或已有 VPN 走本地加密中继。跨网络可以走 **Steam P2P 隧道**：不需要公网 IP，不需要端口映射。

[![CI](https://github.com/icts-hub/stronghold-link/actions/workflows/ci.yml/badge.svg)](https://github.com/icts-hub/stronghold-link/actions/workflows/ci.yml)
![license](https://img.shields.io/badge/license-GPL--3.0--or--later-blue)
![tests](https://img.shields.io/badge/tests-158%20passing-brightgreen)
![version](https://img.shields.io/badge/version-0.12.0-informational)

- 本地 **TCP / UDP 中继**，多端口批量启动，会话级端到端加密，算法为 X25519 + AES-256-GCM
- **Steam P2P 隧道**：基于 Steam Networking Sockets，跨网络无需端口转发，需自备 Steamworks SDK
- 四种「连接方式」：端口转发 / 浏览器应用隧道 / Steam 隧道 / 局域网直连，其中局域网直连明确不转发
- 界面所有状态都来自真实中继进程：连接数、字节数、数据报数、拒绝与失败计数、逐条日志
- 六页控制终端界面：服务库 / 会话 / 网络 / 适配器 / 好友 / 系统，编号导航、等宽数据、真实遥测波形
- **Steam 好友与大厅**：一键邀请好友入房，好友接受后自动读到房主 SteamID 与端口

> **本项目与 Valve / Steam 无隶属关系。** Steamworks SDK 的 redistributable 受 Valve 授权限制，
> 仓库不含这些文件，需使用者自行放入：见 [steamworks_sdk/README.md](steamworks_sdk/README.md)。

## ⚠️ 风险提示：用 Steam 通道之前请先读这段

用 Steam 通道联机这件事，**后果是不确定的**，所以单独写在这里，不塞进免责声明里糊过去：

- AppID `480` 即 Spacewar，是 Valve 留给开发者做联调的测试 App。拿它长期跑个人联机，**会不会被 V 社判定为滥用、
  会不会限制或封禁账号，目前没有任何明确说法**，也找不到足够多的先例可以参考。我只能诚实地说：不知道。
- 所以**强烈建议用小号**：专门注册一个 Steam 账号来联机，别用主账号。万一真出事，损失只是一个空号。
- 本地中继的 TCP/UDP 端口规则和「不做中继」的局域网直连这两种方式**完全不碰 Steam 账号**，没有这层顾虑。
  能用就别用 Steam 通道。
- 另外，任何 P2P 隧道都是把服务暴露给对端机器：只跟信得过的人联机，别顺手把远程桌面、数据库这类东西开给不熟的人。

Steam 账号是你自己的资产，风险请你自行评估后再决定用不用这条路。


## 快速开始

```powershell
git clone https://github.com/icts-hub/stronghold-link.git
cd stronghold-link
npm install                # 需要 Node.js 20+；会装 electron 与可选依赖 steamworks-ffi-node
npm start                  # 启动图形界面
npm test                   # 158 个测试用例
```

想用 Steam 隧道：把 SDK 的 `steam_api64.dll` 放到 `steamworks_sdk/redistributable_bin/win64/`。
目录名写错一个字母也能识别，见 [steamworks_sdk/README.md](steamworks_sdk/README.md)。
然后在界面「会话 → Steam 环境自检」确认五项全绿。

## 四种连接方式

| 连接方式 | 适合 | 加入者怎么连 |
| --- | --- | --- |
| 本地中继，走 TCP / UDP 端口规则 | 任何 TCP/UDP 服务：Web、远程桌面、数据库、游戏服务 | 客户端连 `127.0.0.1:<本地入口端口>` |
| 本地中继 + 浏览器应用 | 先打开网页、网页再连 WebSocket 的应用 | **浏览器打开 `http://127.0.0.1:<本机入口端口>`** |
| Steam P2P 隧道 | 跨网络、有 Steamworks SDK、不想做端口映射 | 填房主 SteamID 后启动，客户端连本机入口端口 |
| 不做中继，即局域网直连 | 同一局域网 | 直接访问 `<房主IP>:<服务端口>`，**工具不转发任何流量** |

## 使用流程

### 房主

1. 「服务库」选择或新建配置。内置示例：本地 Web/HTTP `TCP,8080,8081`、远程桌面 `TCP,3389,3390`、通用 TCP/UDP。
2. 「会话」→ 选连接方式 → 角色 **房主 / HOST** → 监听地址 `0.0.0.0`。
3. 口令默认自动生成。口令即本次会话的密钥来源；不设口令时会明确标注 `明文`。
4. 「检测这些端口」确认空闲 →「启动桥接」。首次监听时 Windows 防火墙会弹窗，**必须允许专用网络**。
5. **Security** 行显示 `已加密 · AES-256-GCM + X25519` 后，点「复制邀请信息」发给好友，内含「加入者怎么做」。

### 加入者

1. 「会话」→ 粘贴邀请码 →「解析」。连接方式、地址、口令、端口规则一次填好。
2. 「启动桥接」，然后按提示操作：浏览器应用直接打开本机入口地址；原生客户端把服务器地址指向本机入口端口。
3. 两端的通道 `sessionId` 一致 = 走的是同一条加密会话。

### Steam 隧道（跨网络）

> 动手之前先看上面的 [风险提示](#️-风险提示用-steam-通道之前请先读这段)：请用小号，别用主账号。

完整字段级步骤见 [docs/STEAM-联机步骤.md](docs/STEAM-联机步骤.md)。要点：

- **需要两台不同的电脑 + 两个不同的 Steam 账号**。同一账号自连不是有效通路，实测 Steam 返回错误 8 并断开。
- 两端 **AppID 必须一致**，测试可用 `480`。
- 房主启动后会显示自己的 17 位 SteamID，把它发给加入者。
- 加入者填该 SteamID + 一个本机空闲端口，客户端连 `127.0.0.1:<那个端口>`。
- Steam 传输层自带加密与 SteamID 身份认证，因此这条路径**不需要口令**。

## 打包与分发

```powershell
npm run build:dir   # 免安装便携版 -> ../release/win-unpacked/
npm run build       # NSIS 安装包 -> ../release/Stronghold-Link-Setup-<版本>.exe（需能访问 GitHub）
```

便携版已实测「解压即用」：解压到干净目录后运行 `--smoke` 返回 `ok: true`、界面正常、stderr 无输出。
打包细节、以及打包版里 Steamworks SDK 该放在哪，即 exe 同级 `steamworks_sdk/`，见 [docs/PHASE6-BUILD.md](docs/PHASE6-BUILD.md)。

## 安全模型

| 项目 | 实现 |
| --- | --- |
| 密钥交换 | 每次会话临时 X25519，前向保密，密钥不落盘 |
| 身份认证 | 预共享口令经 scrypt 硬化 → 双向 HMAC 标签；口令不对任一端都无法握手 |
| 数据加密 | AES-256-GCM；TCP 为记录流：4B 长度 + 8B 计数器 + 密文 + 16B 标签；UDP 为逐包加密 |
| 防重放 | TCP 严格递增记录号；UDP 计数器 + 1024 滑动窗口 |
| 防篡改 | 任何一位被改动都会导致认证失败并断开/丢包 |
| 明确失败 | 口令不匹配、版本过旧、协议不符、对端已满都会给出中文原因 |

边界，不夸大：口令泄露等于会话泄露；邀请码含口令，请通过可信渠道发送；不抗流量分析；终端被攻破不在防护范围内。
进程侧基线：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，页面 CSP `default-src 'self'`，
渲染进程只能调用白名单 IPC。见 [docs/PHASE3-SECURITY.md](docs/PHASE3-SECURITY.md)。

## 目录结构

```
├─ electron/
│  ├─ main.cjs            主进程：配置持久化 + 会话控制 IPC + Steam 诊断 + 启动日志 + 单实例 + --smoke 自检
│  └─ preload.cjs         contextBridge 白名单桥（渲染进程拿不到 Node.js / 文件路径）
├─ network/
│  ├─ errors.cjs          错误码 → 中文文案、端口/口令校验、端口占用者查询
│  ├─ crypto.cjs          安全原语：scrypt PSK / X25519 / HKDF / AES-256-GCM / 重放窗口
│  ├─ secure-stream.cjs   TCP 安全通道：双向认证握手 + 加密帧变换流
│  ├─ secure-datagram.cjs UDP 安全通道：数据报握手状态机 + 逐包加密/重放窗口
│  ├─ tcp-relay.cjs       TCP 中继内核（加密/明文两种模式）
│  ├─ udp-relay.cjs       UDP 中继内核（会话映射 + 可选加密）
│  ├─ adapters.cjs        适配器与「连接方式」注册表（四种配方 + 两端连接说明）
│  ├─ steam-env.cjs       Steam 环境诊断（模块 / FFI / SDK / AppID / 客户端）
│  ├─ steam-adapter.cjs   Steam P2P ↔ 本地 TCP 端口桥接（每条本机连接一条 Steam 连接）
│  ├─ steam-lobby.cjs     Steam 大厅与好友：邀请、成员、房主信息交换
│  └─ session.cjs         会话控制器：多通道状态机、端口预检、邀请码、批量启动与回滚
├─ src/ui/index.html      界面外壳与全部视图（单文件 + 单块内联脚本，便于 DOM 桩测试）
├─ src/ui/styles/         设计系统：design-tokens / theme / typography / layout / motion / base / components / views
├─ src/ui/fonts/          内置字体子集（MiSans 免费商用 + Inter/Plex OFL，见同目录许可与 SOURCE.txt）
├─ test/                  node:test 测试（300 例）
├─ tools/                 开发工具：Steam 探针、MiSans 子集裁剪、CI 测试运行器、便携版打包、CHANGELOG 截取
└─ docs/                  阶段设计与测试报告（PHASE1 ~ PHASE6 + 排错与 Steam 步骤）
```

## 网络层（PHASE 2 起）

- 统一 Provider 契约与注册表：本地中继、Steam P2P、直连 UDP、Stronghold Relay
- 真实测量 RTT / 抖动 / 丢包。无样本时显示"未测量"，不填 0
- 路径评分与 RouteManager：阈值 55 分、滞回 12 分、观察窗 4 秒、冷却 15 秒
- NETWORK 页的 `RUN RELAY SELF-TEST` 会在本机起中继服务端与两个客户端实测一次
- 未测量的候选会写明原因：本地中继无包级往返 / Steam 需真实对端 / 打洞需两台机器

## 相关文档

- [跨机验证手册](docs/跨机验证手册.md)：打洞 / 自建中继 / Steam 端到端 / 局域网四类验证的步骤与回填表
- [中继部署](docs/中继部署.md)：守护进程、防火墙、systemd 示例、健康检查与安全边界
- [多通道选路设计](docs/多通道选路设计.md)：**未实现**，含影响面、测试计划与回滚方案

## 主进程 IPC 契约（渲染进程可见的全部能力）

| 频道 | 入参 | 返回 |
| --- | --- | --- |
| `profiles:load` / `profiles:save` | 配置数组，≤500 条 | 规范化后的配置数组 |
| `adapters:list` / `adapters:recipes` / `adapters:recipe-hints` | 连接方式与参数 | 适配器真实状态、配方清单、两端连接说明 |
| `session:start` | `{role, adapter, rules:[{protocol,localPort,remotePort}], targetHost/bindHost/remoteHost, authToken, gamePort, hostSteamId, appId, ...}` | 会话快照（`channels`、`security`、聚合统计）+ `inviteText` |
| `session:stop` / `session:status` | — | 会话快照 |
| `session:check-port` | `{relayPort/localPort, bindHost, protocol}` | `{free, protocol, friendly, inUseBySession}` |
| `session:parse-invite` | 邀请码，v1/v2 | `{host, port, token, game, rules}` |
| `steam:diagnose` | `{appId}` | Steam 环境自检报告，逐项 ok / 缺失原因 |
| `app:info` / `app:reveal-config` | — | 版本、配置路径、运行环境 / 打开配置目录 |

会话事件由主进程通过 `session:event` 推送 `state` 与 `log`，preload 只暴露订阅接口。

## 已实现的稳健性措施

- IPC 入参白名单化：多余字段丢弃、数值/字符串逐项收紧，`rules[]` 内部字段也过滤；含原型污染测试。
- 端口预检按协议分别做。TCP 为绑定 + 连接探测，UDP 为绑定；`EACCES` 是 Windows 保留端口段，翻译成可读原因。
  端口冲突时**报出占用者**，用 `netstat`/`tasklist`，例如 `node.exe (PID 243808)`。
- 防重复启动、停止幂等、批量启动失败自动回滚已建立通道、`before-quit` / `window-all-closed` 强制释放端口。
- scrypt 只在会话创建时执行一次，不随每个连接重复计算。
- 启动日志写在 `%APPDATA%\stronghold-link\startup.log`：记录 argv、版本、窗口创建、渲染进程加载、
  子进程退出、未捕获异常——「双击闪退」类问题可查。
- 便携版附带 `START-HERE.cmd` 启动器：检测注入型软件、失败自动换参数重试、把退出码写进 `launcher.log`。

## 测试

`npm test` 覆盖 **300 个用例**，31 个测试文件：适配器、加密、中继、会话、IPC、界面逻辑，以及网络 Provider / 路由评分与监督 / 中继服务端与客户端 / STUN / NAT-PMP / UPnP / 打洞 / 长时压测等新增部分。
全部使用本机回环真实端口与真实数据往返；包括**链路抓包无明文**、**跨会话重放被拒**、**伪造认证标签被拒**、
**旧协议明确拒绝**、**端口冲突带占用者提示**、**SDK 目录名容错**等实测项。
Steam 传输层逻辑用注入的假 SDK 测试，测试文件内明确标注，真实 Steam 的验证情况见下一节。

开发用探针，需要真实 Steam 环境：

```powershell
cd tools
node steam-appid-probe.cjs                       # SDK 初始化 / SteamID / Relay 状态
node steam-p2p-probe.cjs                         # 真实 listen/connect/accept/send/receive
node steam-diag-probe.cjs                        # 适配器细粒度：状态变化、句柄、sendReliable 结果
node steam-userdir-probe.cjs "D:\某个安装目录"    # 用指定目录里的 SDK 做真实初始化
```

## 已验证 / 未验证（诚实清单）

**已在本机实测通过**

- 本地 TCP/UDP 中继，明文与加密两种模式、多端口批量启动、端口预检与释放、停止幂等。
- 加密链路无明文、重放与篡改被拒、口令不匹配无法建立会话。
- Electron 打包版：`--smoke` 8 步全过、`ok: true`；解压到干净目录后同样通过。
- Steam，真实 SDK、真实 Steam 客户端、AppID 480：SDK 初始化成功、取得本机 SteamID、
  Relay 到达 `Current/Available`、`createListenSocketP2P` 成功、`connectP2P` → `Connecting` → `Connected`、
  `acceptConnection` 返回 OK、`sendReliable` 调用成功。

**未验证 / 已知限制**

- **跨两台电脑的真实数据往返**：本环境只有一台机器、一个 Steam 账号，无法构造第二端。
  同一账号自连**不可用**，实测 `sendReliable` 返回 `result=8` 并断开，这是 Steam 侧限制。
- Steam 好友邀请需要两台机器、两个账号，端到端未在本机验证；大厅与好友页已实现，真实数据可读。
- NSIS 安装包未在本机产出，下载组件被网络代理拦截，配置已就绪；便携版已可用。
- 跨公网不用 Steam 通道时需要端口映射或 VPN。
- **打洞**：STUN 已实测能取到公网映射，但跨两台机器的真实打洞**未验证**；同一 NAT 内部互打因缺回环而失败，属预期。
- **自建中继**：服务端与客户端已实现并在本机端到端跑通，但**尚未部署公网实例**。
- **Steam 连接级质量**：需要真实对端连接才能读到延迟，本机单账号无法构造，**未验证**。
- 本机网络实测：网关不支持 UPnP 与 NAT-PMP，两条自动端口映射路径都不可用。

## 排错

| 现象 | 处理 |
| --- | --- |
| 双击 exe 一闪就退 | 用包内 `START-HERE.cmd` 启动；关闭注入型软件，如游戏加加 GamePP / RTSS / MSI Afterburner，详见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) |
| 「端口已被监听」 | 报错里会写占用者；换端口，或把「本机入口端口」留空自动选择 |
| 「连接本地服务端口失败：ECONNREFUSED」 | 房主本机的目标服务没在运行，先把服务端起起来 |
| 加入者进不去房间 | 确认他打开的是 `http://127.0.0.1:<本机入口端口>`，即隧道入口，不是 `localhost:3000`，那是他自己机器的服务端 |
| Steam 自检有红项 | 按自检面板逐条提示处理；SDK 目录名容错见 [steamworks_sdk/README.md](steamworks_sdk/README.md) |

## License

[GPL-3.0-or-later](LICENSE)。第三方组件与商标声明见 [NOTICE.md](NOTICE.md)。

## 致谢

这工具最早就是为了跟朋友一起玩《卫戍协议：盟约》才动笔的，所以先谢 [sganggs](https://github.com/sganggs/Stronghold-Protocol)。

他把「卫戍协议：盟约」复刻成了浏览器里打开就能玩的 1–4 人联机合作，GPL-3.0 授权，531 星。
他的客户端是「先开网页，网页再用同源 WebSocket 连服务器」这种结构，本项目里
「本地中继 + 浏览器应用」这条连接方式由此而来——加入者不用在自己机器上装任何东西，浏览器打开隧道入口就行。
写联机那几天反复翻他的代码确认端口、房间码规则、WebSocket 地址怎么拼，省了大量试错。
房间码规则是 4 位字母、不含 I 和 O。两边是各自独立的程序，本项目没有包含对方任何代码。

感谢 Valve 和 Steam。Steamworks SDK 的 Networking Sockets 加 Steam Relay 网络，把「跨网络、免端口映射」
这件事做成了现成能力，这个工具说到底是它和本机端口之间的一层桥。Steam 与 Steamworks 是 Valve Corporation
的商标，本项目与 Valve 没有任何隶属或赞助关系，也不含其 SDK 文件；SDK 要自己放，见 [steamworks_sdk/README.md](steamworks_sdk/README.md)。

也要谢 [Electron](https://www.electronjs.org/)、[steamworks-ffi-node](https://www.npmjs.com/package/steamworks-ffi-node)
和 [koffi](https://koffi.dev/) 的作者与维护者，桌面外壳、Steam 的 Node 绑定、FFI 运行时这三块都是现成轮子，均为 MIT，
明细记在 [NOTICE.md](NOTICE.md)。

最后谢谢被我拉着测联机的朋友：两台机器、两个 Steam 账号，一遍遍听我说「再试一次」。

祝大家都能叠 325 层打出 799w 伤害。
