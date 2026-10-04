# 第四阶段：Steam P2P 适配器（v0.7.0）

## 1. 这一阶段做到了什么 / 没做到什么

| 已实现（并有测试覆盖） | 未实现 / 未验证（不夸大） |
| --- | --- |
| Steam Networking Sockets 适配器：房主 `createListenSocketP2P` + poll group，加入者 `connectP2P(房主SteamID)` | **真实 Steam P2P 未能在本机验证**：缺少 Steamworks SDK redistributable，`init()` 会直接终止进程 |
| 把 Steam P2P 可靠消息流与「本机游戏的 TCP 端口」双向对接（每个对端一条本地连接） | Steam Lobby / 好友邀请 / Overlay 邀请（需要 matchmaking API 与真实 AppID） |
| Steam 环境诊断：模块、FFI 运行时、SDK 目录与库文件、AppID、Steam 客户端，逐项给出结论与修复指引 | UDP over Steam（Steam 的可靠消息用于 TCP 游戏流量；UDP 游戏仍走本地 UDP 中继） |
| 会话层第三种适配器：`adapter: 'steam'`，与 TCP/UDP 通道统一在同一个状态机里 | 应用层额外口令校验（Steam 通道已由 Steam 加密并基于 SteamID 认证，本工具不叠加） |
| 界面：适配器选择、Steam 字段、环境自检面板、Steam 通道展示（含本机 SteamID） | 打包分发 SDK（Valve 授权不允许随包分发，必须用户自行下载） |

## 2. 为什么真实 Steam 无法在本机验证（实测证据）

`steamworks-ffi-node` 是 FFI 绑定，缺少 `steam_api64.dll` 时它的行为不是「返回 false」，而是打印指引后**结束进程**。本机实测：

```
[Steamworks] Steamworks SDK library not found!
   Expected location: <app>/steamworks_sdk/redistributable_bin/win64/steam_api64.dll
   ...（列出全部搜索路径）
```

因此本阶段采取了三条工程措施，而不是「假装能用」：

1. **纯文件系统预检**（`network/steam-env.cjs`）：模块、`koffi`、SDK 目录、本平台库文件、AppID、Steam 客户端逐项检查，
   **不调用 `init()`**，所以永远不会因为环境缺失而崩进程。
2. **只有预检通过才 init**：`initSteamSdk()` 在预检不通过时抛出 `ESTEAMENV`，附带「缺什么 + 看哪份文档」。
3. **适配器测试用注入的假 SDK**：验证我们这一侧的桥接逻辑（状态机、accept/poll、消息搬运、上限、清理、与本地 TCP 对接），
   测试文件与说明里都明确写「这是假 SDK，不是真实 Steam」。

## 3. 新增文件

| 文件 | 作用 |
| --- | --- |
| `network/steam-env.cjs` | 环境诊断（模块/FFI/SDK/AppID/客户端），纯文件系统检查，可安全地随时调用 |
| `network/steam-adapter.cjs` | `createSteamHost` / `createSteamJoiner`：Steam P2P ↔ 本地 TCP 端口的双向桥接；`initSteamSdk` 带环境预检 |
| `test/steam-env.test.cjs`（7 例） | 候选目录、模块与 FFI（真实检查）、SDK 缺失/目录存在但缺库/就绪三种判定、AppID 文件、显式 AppID 优先 |
| `test/steam-adapter.test.cjs`（7 例） | SteamID 校验、房主接客与双向搬运、对端上限、stop 清理、加入者双向、单客户端限制、环境未就绪拒绝启动 |
| `test/steam-mock.cjs` | 共享的假 SDK（也在会话层测试里使用） |

`package.json` 新增 `optionalDependencies: { "steamworks-ffi-node": "^0.11.3" }`：
装不上也不影响应用本身（本地中继、加密、自检都照常工作）。

## 4. 会话层如何表达 Steam

Steam 没有「本地监听端口」这个概念，因此会话支持第二种表达方式：

```js
// 房主
{ role:'host', adapter:'steam', targetHost:'127.0.0.1', gamePort: 2300, appId: 480 }
// 加入者
{ role:'joiner', adapter:'steam', hostSteamId:'7656119xxxxxxxxxx', localPort: 2300, appId: 480 }
```

- 通道 `protocol` 为 `STEAM`；房主的通道带 `steamId`（本机 SteamID，界面会显示出来发给好友）。
- 安全信息为 `mode: 'steam-transport'`，界面显示「Steam 传输层加密」——**不是**我们的 AES 层（不重复加密）。
- 端口预检：加入者检查本机入口端口；房主检查本地游戏端口是否有服务（只告警不阻断）。
- 上限沿用 `maxConnections`（默认 16，Steam 场景建议不超过 4）。

## 5. 测试记录（本机 Windows + Node 24.21.0）

```powershell
cd source
npm test        # 106 个用例（10 个测试文件）
```

结果：**106 passed / 0 failed**

| 组 | 用例数 |
| --- | --- |
| `test/crypto.test.cjs` | 7 |
| `test/secure-stream.test.cjs` | 13 |
| `test/secure-datagram.test.cjs` | 12 |
| `test/steam-env.test.cjs` | 7 |
| `test/steam-adapter.test.cjs` | 7 |
| `test/tcp-relay.test.cjs` | 10 |
| `test/udp-relay.test.cjs` | 10 |
| `test/session.test.cjs` | 18 |
| `test/main-ipc.test.cjs` | 12 |
| `test/ui-logic.test.cjs` | 10 |

另外：`npm run smoke:restricted` 在 v0.7.0 上仍为 `"ok": true`（渲染进程 → preload → IPC → 加密会话 → 真实转发 → 停止 → 释放端口）。

## 6. 你这边要做的配置（做完才能用真实 Steam）

1. **安装依赖**（已作为 optionalDependency，若未装上就手动装）：
   ```powershell
   cd source
   npm install steamworks-ffi-node
   ```
2. **下载 Steamworks SDK**：登录 <https://partner.steamgames.com/> → SDK 下载 → 解压。
3. **放置 redistributable**（本工具会在这些位置查找，按优先级）：
   ```
   source/steamworks_sdk/redistributable_bin/win64/steam_api64.dll
   ```
   也可以放到应用目录上一级或上两级；自定义路径可通过 `sdkPath` 传入。
4. **AppID**：测试用 `480`（Spacewar，需要 Steam 已登录）；正式使用填你自己的 AppID。
   也可以在 `source/steam_appid.txt` 里写一行数字。
5. **启动 Steam 客户端并登录**（两台机器各一个 Steam 账号）。
6. 打开应用 → 会话 → 传输适配器选 **Steam P2P** → 点「Steam 环境自检」：
   全绿之后再「启动桥接」。

> 首次联调建议：房主启动后界面会显示**本机 SteamID**，把它发给好友；好友填进「房主 SteamID」并启动。
> 跨网络测试时，两台机器不要在同一 Wi-Fi 下，这样能真正验证 NAT 穿透。
> 控制台会打印 `Steam Relay / FindingRoute / Connected / Disconnected` 等状态，便于排查。

## 7. 已知限制与风险

1. **SDK 缺失会终止进程**：这是上游库的行为。本工具用预检挡住了这条路径，但如果你手动绕过预检直接 init，
   进程仍会被终止。请在配置好 DLL 之后再启用 Steam 适配器。
2. **未验证的部分**：真实 P2P 建连、NAT 穿透、SDR 中继、Steam 好友邀请、多对端并发、跨机压力。这些都需要真实 SDK 与两个 Steam 账号。
3. **单客户端限制**：加入者侧一次只服务一个本机游戏客户端（Steam 连接是 1 对 1 的隧道语义），第二个会被拒绝并记录。
4. **TCP-only 隧道**：Steam 可靠消息用于搬运 TCP 游戏流量；UDP 游戏请使用本地 UDP 中继（阶段 2）。
5. **打包**：`electron-builder` 打出的安装包不会包含 SDK 的 DLL，用户需要按第 6 节自行放置（或你在安装器里提供下载步骤）。
