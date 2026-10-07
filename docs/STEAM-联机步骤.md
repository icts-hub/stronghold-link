# 用 Steam 联机：完整步骤 v0.9.0

> ## 先看这个
>
> 用 Steam 做 P2P 联机**属于风险行为**：AppID 480 是 Valve 的测试 App，拿它跑个人联机**会不会被 V 社判定为滥用、会不会限制或封禁账号，目前没有明确说法**。
>
> **请使用不重要的账号，也就是小号，联机。不要用主账号。** Steam 账号是你自己的资产，风险请自行评估。不想承担这点不确定性，就用「本地中继」或「局域网直连」，那两种方式不碰 Steam 账号。

Steam 通道的作用：**不用端口映射、不用公网 IP**，通过 Steam 的 P2P 网络把本机服务开放给好友。房主在本机服务端口与 Steam P2P 之间做桥接，加入者在本机入口端口与 Steam P2P 之间做桥接。Steam 传输层自带加密与 SteamID 身份认证，所以这条路径**不需要口令**。

---

## 一、前置条件：只做一次

| 条件 | 说明 |
| --- | --- |
| **两台电脑、两个不同的 Steam 账号** | 必须。实测：同一个账号自己连自己**不是有效通路**，`sendReliable` 返回 `8`，失败，并断开连接，证据见第四节 |
| 两边都**已登录 Steam 客户端** | Steam 必须在运行且已登录，P2P 才可用 |
| **Steamworks SDK redistributable** | 包里 `steamworks_sdk\redistributable_bin\win64\steam_api64.dll`，已随本包放好，来源见同目录 `来源说明.txt`。对外分发请换成从 [partner.steamgames.com](https://partner.steamgames.com/) 下载的官方 SDK |
| **相同的 AppID** | 测试用 `480`，Valve 的公开测试 App。正式发布用自己的 AppID |
| 防火墙 | Steam 通道不需要放行端口，但房主侧**本机服务端口必须在本机可访问** |

放好之后，在界面「会话 → Steam P2P 隧道」里点 **Steam 环境自检**，应当五项全绿：

```
[OK] npm 依赖 steamworks-ffi-node
[OK] FFI 运行时 koffi
[OK] Steamworks SDK redistributable   steamworks_sdk\redistributable_bin\win64\steam_api64.dll
[OK] AppID                            480
[OK] Steam 客户端                      d:/steam/steam.exe
```

---

## 二、房主：开放服务的一方

1. 「服务库」选或建一个配置，端口填**你要共享的本机服务端口**，例如网页 8080、远程桌面 3389、游戏服务端口。
2. 「会话」→ 连接方式选 **Steam P2P 隧道**。
3. 连接角色：**房主 / HOST**。
4. 本地服务端口填第 1 步的端口。AppID 填 `480`。
5. 点「**启动桥接 ↗**」。
6. 右侧通道列表出现 `STEAM` 通道，日志显示：
   ```
   Steam 房主会话已就绪：把 SteamID 7656119905xxxxxxxx 发给好友
   ```
7. 把那个 **SteamID，17 位，7656119 开头**发给好友。不要发错成别的数字。
8. 好友连上后：`Live connections` 变 1，通道出现「已接通本地服务端口」，Traffic 开始增长。

房主的 SteamID 从 `steam.getStatus().steamId` 取，格式一定是 `7656119…`。之前版本显示的是 `4699065985603207176` 这种数字，那是 FFI 返回的原始 64 位，字节序错位，已修，见第四节。

---

## 三、加入者：连过去的一方

1. 「会话」→ 连接方式 **Steam P2P 隧道** → 连接角色：**加入者 / JOINER**。
2. **房主 SteamID**：粘贴房主发来的 17 位数字。格式不对会被拦下并提示。
3. **本机入口端口**：默认随机，例如 51234。这是你本机客户端要连的端口。
4. AppID 填 `480`，必须与房主一致。
5. 点「**启动桥接**」。
6. 启动你的客户端，把「服务器地址」填 **`127.0.0.1:<本机入口端口>`**。
   - 浏览器类服务：直接打开 `http://127.0.0.1:<本机入口端口>`
   - 远程桌面：`mstsc /v:127.0.0.1:<本机入口端口>`
   - 游戏：服务器地址填 `127.0.0.1`，端口填本机入口端口
7. 状态应显示通道 `STEAM`、`已接通房主中继`。

**连接是懒建立的**：加入者在没有本机客户端连入时不会创建 Steam 连接，这样不会白占资源。所以**先开客户端、再启动桥接**，或者启动桥接后再开客户端都行。

---

## 四、实测记录：本机，2026-10-04

用本机真实 Steam 实测，账号已登录，AppID 480，DLL 取自本机 Steam 游戏：

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| SDK 初始化 | 通过 | `init({appId:480})` → `true` |
| 取得本机 SteamID | 通过 | `getStatus().steamId` = `76561198000000000` |
| Steam Relay 网络 | 通过 | `availability: 100 (Current/Available)` |
| 房主监听 socket | 通过 | `createListenSocketP2P` → `65536` |
| P2P 连接状态机 | 通过 | `connectP2P` → `Connecting(1)` → `Connected(3)` |
| 连接被接受 | 通过 | `acceptConnection(listen 侧连接)` → `1`，k_EResultOK |
| **两个不同账号之间传数据** | **未验证** | 本机只有一个 Steam 账号，无法构造第二个账号 |
| 同账号自连传数据 | **无效** | `sendReliable` → `success=false, result=8`，随后连接断开；这不是我们的 bug，是 Steam 侧对自连的限制 |

**在这台机器上跑过的三个探针脚本**，可直接复跑：

```powershell
cd source
node steam-appid-probe.cjs   # SDK 初始化 / SteamID / Relay 状态
node steam-p2p-probe.cjs     # 真实 listen/connect/accept/send/receive，自连
node steam-diag-probe.cjs    # 细粒度：每次状态变化、句柄、sendReliable 结果
```

顺带修掉的两个真实问题：

1. **SteamID 字节序**：`networkingSockets.getIdentity()` 返回 `4699065985603207176`，即 `0x41366f9e00000008`，而正确的经典 SteamID64 是 `76561198000000000`，即 `0x0110000141366f9e`。现在优先用 `getStatus().steamId`，并对不符合 `7656119…` 的数字**按位重建** `universe=1<<56 | type=1<<52 | instance=1<<32 | raw>>32`。没有这个修正，加入者填房主 ID 会直接失败。
2. **房主误 accept 自己发起的出站连接**：同进程自连时，`info.listenSocket === 0` 的连接是我们自己发起的，`acceptConnection` 会返回 `11`。现在遇到 `listenSocket === 0` 直接跳过，不再当作「被拒绝的连接」。

---

## 五、直连优先：别让中继白白多一跳

Steam P2P 会在**直连(ICE 打洞)**和**中继(SDR)**之间自己选一条。出厂默认是「谁 ping 低用谁」，
听起来很合理，但实际选路分数里中继经常因为候选更多而抢先被选中，于是明明能直连的两个人在绕远路。

工具默认把这一档改成了**强制直连**，并且在连上之后逐项读回核对，所以这一条不是「预期生效」而是「已经生效」：

| 参数 | 出厂默认 | 本工具默认 | 作用 |
| --- | --- | --- | --- |
| `P2P_Transport_ICE_Enable` | 只共享局域网候选 | `0x7fffffff`(全部候选) | 允许交换 STUN 反射地址，也就是公网打洞的前提 |
| `P2P_Transport_SDR_Penalty` | `0` | `10000` | 给中继的选路分数加 10000 毫秒罚分 |
| `P2P_Transport_ICE_Penalty` | `0` | `0` | 不给直连加任何罚分 |

选路分数**以该路由的 ping 为起点、单位就是毫秒**，所以给中继加 10000 分等于：
「只要直连 ICE 能打通，就一定用直连」。直连彻底打不通时中继仍然会被选上 —— 这是**故意留的兜底**，
不是漏配：Steam 没有「彻底禁用中继」的开关，罚分是唯一可用的杠杆，把中继罚到永远不选
只会让打不通的用户彻底连不上，而不是变快。

三档可以用环境变量切换(重启工具生效)：

```bat
set SHL_STEAM_TRANSPORT=ice     :: 强制直连(默认)
set SHL_STEAM_TRANSPORT=auto    :: 回到 Steam 出厂行为，谁 ping 低用谁
set SHL_STEAM_TRANSPORT=relay   :: 强制中继，完全不共享 ICE 候选
```

会话页的 **STEAM GLOBALS** 一行会显示当前档位(`强制直连 · 9 项已下发 · …`)。
如果那里显示「强制直连」而 **CURRENT ROUTE** 仍然是中继，诊断文字会直接告诉你
**ICE 打洞没成功**(常见于双方都在对称 NAT 或运营商级 NAT 后面)——
这种情况下再调带宽、调分片都不会有用，得先换网络环境或改用别的组网方式。

---

## 六、排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 自检里 SDK 一项是红的 | `steam_api64.dll` 不在 `steamworks_sdk\redistributable_bin\win64\` 下。注意是 exe 同级目录，不是 `resources` |
| 自检里 Steam 客户端是红的 | Steam 没装或没登录；工具会读注册表 `HKCU\Software\Valve\Steam` |
| 加入者填 SteamID 被拦 | 必须是 `7656119` 开头的 17 位数字。房主那里的数字要原样复制 |
| 两边都启动但一直没有流量 | 加入者侧要**先让本机客户端连上本机入口端口**，Steam 连接是那时才建立的。另外两边 AppID 必须一致 |
| 启动桥接直接报「Steam 环境未就绪」 | 自检面板里会逐条列出缺什么，按提示补 |
| 诊断说「ICE 打洞没成功」 | 双方至少有一侧在对称 NAT / 运营商级 NAT 后面，直连打不通只能走中继。换网络(手机热点、其他宽带)或改用 Tailscale/ZeroTier 组网 |
| 想确认当前到底走没走中继 | 会话页 CURRENT ROUTE 一行由 Steam 自报的 POP ID 判定，不是猜的；对照 RAW SOCKET RX 与 STEAM RX 还能分清「线路真慢」和「统计口径不对」 |
| 启动后进程直接消失 | 见 [启动闪退排查.md](启动闪退排查.md)：沙箱用启动器，注入型软件关游戏加加 |

---

## 七、和另外三种连接方式怎么选

| 场景 | 用哪种 |
| --- | --- |
| 两人在同一个局域网 | 「不做中继，局域网直连」最省事 |
| 跨网络，但你有公网端口或已有 VPN | 「本地中继，TCP/UDP 端口规则」，自带端到端加密 |
| 跨网络，什么都没有 | **Steam P2P 隧道**，即本文；或装 Tailscale/ZeroTier 之类组网 |
| 浏览器应用，网页与 WebSocket 同端口 | 「本地中继 + 浏览器应用」 |
