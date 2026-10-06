# 第一阶段：真实 TCP 会话控制 v0.4.0

> 阶段 2 的 UDP 转发与多端口批量启动见 [PHASE2-UDP-MULTIPORT.md](PHASE2-UDP-MULTIPORT.md)。当前版本已到 0.5.0，会话由单通道扩展为多通道。本文件是阶段 1 的设计与测试记录。

## 1. 范围

| 完成 | 未做 |
| --- | --- |
| TCP 中继接入 Electron 主进程与会话界面 | UDP 数据报转发，阶段 2 |
| 房主 / 加入者两种模式，真实启停 | 身份认证与加密，阶段 3 |
| 端口冲突预检、可读错误提示 | Steam P2P / NAT 穿透，阶段 4 |
| 防重复启动、幂等停止、退出清理 | 多游戏多设备实测，阶段 6 |
| 可选口令握手，防误连，非加密 | Steam Lobby / 好友邀请 UI |
| 流量与连接统计、运行日志 | |
| 35 个自动化用例，本机回环真实端口 | |

## 2. 变更文件

| 文件 | 变更 |
| --- | --- |
| `network/tcp-relay.cjs` | 增强，签名兼容：`err.friendly` 错误分类、连接上限、连接超时、字节统计、口令握手、幂等 `stop()` |
| `network/session.cjs` | **新增**：状态机、参数校验、端口双重预检、邀请码编解码、日志环形缓冲 |
| `electron/main.cjs` | 重写：配置持久化补齐 `port/remotePort`；新增会话 IPC、输入白名单、错误文案翻译、单实例锁、`--smoke` |
| `electron/preload.cjs` | 白名单桥 `profiles / adapters / app / session`；`onEvent` 返回退订函数 |
| `src/ui/index.html` | 会话页真实启停、状态/流量/连接/日志/错误/警告、邀请码解析、适配器列表；修端口数据模型与多行规则解析；加 CSP |
| `test/*.test.cjs`、`test/helpers.cjs` | **新增**，node:test，无第三方依赖 |
| `package.json` | 版本 `0.4.0`；新增 `smoke` / `test` / `test:single` |
| `README.md`、本文档 | **新增** |

## 3. 数据流

```
房主：游戏服务(127.0.0.1:targetPort) <- tcp-relay host <- 监听 bindHost:relayPort <- 加入者
加入者：游戏客户端 -> 127.0.0.1:localPort -> tcp-relay joiner -> 房主 host:relayPort
渲染进程 -> preload(contextBridge) -> ipcMain -> SessionManager -> tcp-relay
主进程事件 -> webContents.send('session:event') -> preload.onEvent -> 界面状态/日志
```

## 4. 会话状态机

```
idle --start--> starting --ready--> running --stop--> stopping --> idle
                    |                                     ^
                    +--校验/绑定失败--> error -------------+ (可再次 start)
```

- `starting` / `running` 期间再次 `start` 直接拒绝，返回 `EALREADYRUNNING`。
- `stop()` 幂等；`starting` 期间调用先等启动结束。
- `before-quit`、`window-all-closed` 调 `SessionManager.shutdown()`：同步销毁 socket 并关闭监听，异常退出不留残余监听。

## 5. 口令握手协议：中继层，游戏数据零改动

```
加入者 -> 房主:  "SHL1 <token>\n"
房主(连接本地游戏端口成功后) -> 加入者: "SHL1-OK\n"     然后双方开始透明转发
房主(口令错误/房间已满/目标不可达) -> 加入者: "SHL1-DENY <原因>\n"
```

- 不设 `authToken` 就完全不握手，行为与旧版裸转发一致，有测试覆盖。
- 口令错误时加入者界面显示房主给出的原因，例如「口令不匹配」「房主本地游戏端口无响应」。
- 只用于防误连。**不是加密**：明文仍可在链路上被抓取，阶段 3 替换。

## 6. 端口检测为何用「绑定 + 连接」双重判断

Windows 允许 `0.0.0.0:P` 与 `127.0.0.1:P` 同时绑定，Linux 直接 `EADDRINUSE`。只判断能否 bind 会误报端口空闲，流量却被旧进程截走。`session.checkPort()` 绑定成功后主动连接一次，能连上就判为「已被监听」。

## 7. IPC 契约

见 `README.md` 表格。渲染进程只能调固定频道，入参走白名单与类型收紧，多余字段丢弃，有测试验证不会污染原型；错误统一翻成中文再抛给界面；界面只读会话数据，不持有 socket。

## 8. 测试记录：2026-10-04，本机 Windows + Node 24.21.0

```powershell
cd source
npm test                                  # 4 个文件、34 个用例
npm run test:single                       # 受限环境下的等价单进程模式：禁止子进程管道
node --test --test-isolation=none test/*.test.cjs
```

结果：**35 passed / 0 failed**。全部使用真实端口、真实 socket、真实数据转发。

| 组 | 用例 | 覆盖 |
| --- | --- | --- |
| `test/tcp-relay.test.cjs` | 9 | 参数校验、错误文案、双向转发、256 KiB 完整性、端口占用、目标不可达、停止释放端口、幂等 stop、连接上限、口令握手对错与无口令兼容 |
| `test/session.test.cjs` | 10 | 邀请码往返与非法分支、房主启停与真实监听、防重复启动、端口冲突、64 KiB 端到端、口令错误日志、房主不可达只告警、`checkPort`、输入校验 |
| `test/main-ipc.test.cjs` | 9 | 频道注册、`app:info`、配置写回、会话启动到停止、错误文案无英文堆栈、入参白名单与原型污染、`check-port`/`parse-invite`、`before-quit` 释放端口 |
| `test/ui-logic.test.cjs` | 7 | 用 DOM 桩跑 **index.html 真实内联脚本**：界面自检、引用的 id 都存在、启动读版本与适配器状态、角色切换、启停接线、邀请码解析、状态事件渲染 |

实测：`256 KiB` 大包与 `64 KiB` 端到端字节级一致；`stop()` 后端口可重新绑定；口令错误时加入者日志出现「房主拒绝了本次连接：口令不匹配」，会话保持 `running`；重复 `start` 被拒且原会话状态不变。

## 9. 未验证

1. **Electron 真实启动**：本机已补测通过。受限进程树里 Chromium 沙箱无法初始化，退出码 `0x80000003`，加 `--no-sandbox` 才能启动。`npm run smoke:restricted` 得 `"ok": true`：渲染进程加载 → preload 桥 → IPC 启动房主会话 → 端口真实监听 → 加入者中继 → **真实数据往返** → 停止 → 端口释放。正常路径运行 8 秒无崩溃、stderr 零输出。`--no-sandbox` 没有写进应用默认参数。
2. **两台真机 / 跨 NAT / 防火墙放行**：本环境只有一台机器，无法验证。
3. **UDP 转发、身份认证与加密、Steam P2P**：尚未实现，属阶段 2/3/4。
4. **真实游戏联机**：`original/Stronghold-Protocol` 与本工具尚未联合实跑。该游戏走 WebSocket 文本帧，房主侧目标端口填游戏服务端口，加入者把客户端指向本地入口端口，需实机确认。

## 10. 双机联调清单

准备：两台电脑同局域网或同 VPN，Windows 防火墙允许专用网络。

1. A 机 `cd source && npm start`。
2. A 机游戏库选择或新增配置 `TCP,2300,2301`：本地游戏端口 2300，中继端口 2301。
3. A 机会话 → 角色「房主」→ 监听 `0.0.0.0` → 「检测端口」应提示空闲 → 「启动桥接」。
4. A 机状态应为 `RUNNING`，`Listen` 显示 `0.0.0.0:2301`。提示「本地游戏端口上没有检测到服务」就先启动游戏。
5. A 机「复制邀请信息」发给 B。
6. B 机 `cd source && npm start`。
7. B 机会话 → 角色「加入者」→ 粘贴邀请码 → 「解析」自动填地址、端口、口令 → 确认本地入口端口 2300 → 「启动桥接」。
8. B 机状态 `RUNNING`。出现「暂时连不上房主」警告就检查 A 机防火墙与网段。
9. B 机启动游戏客户端连 `127.0.0.1:2300`。A 机 `Live connections` 应变为 1，`Traffic` 开始增长。

| 现象 | 可能原因 |
| --- | --- |
| 启动时报「端口已被监听」 | 上次会话没退干净，或其它程序占用 |
| 日志「房主拒绝了本次连接：口令不匹配」 | 两端口令不一致，重新复制邀请码 |
| 日志「房主本地游戏端口无响应」 | A 机游戏服务没启动，或端口填错 |
| 能启动但游戏连不上 | 客户端连的不是本机入口端口；或游戏走 UDP，本版本不支持 |
| 只有本机能连 | 监听地址选了 `127.0.0.1`；或防火墙拦截入站 |

## 11. 下一步

- **阶段 2**：UDP 数据报转发，每个客户端地址映射一个本地 UDP socket，带回包地址改写；多端口规则批量启动。
- **阶段 3**：一次性密钥 → 密钥派生 → 载荷加密/MAC，替换口令握手，补重放防护。
- **阶段 4**：Steam Networking / SteamNetworkingSockets 适配器。需要 `steamworks-ffi-node` 与 SDK `redistributable_bin`，两者都不能随包分发；把 `original/Stronghold-Protocol` 的 `public/js/net.js` 接入 `SteamWebSocket`。`stronghold-steam-p2p-addon-v7` 尚未应用。
- **阶段 5**：适配器系统，TCP / UDP / Steam 统一接口与每游戏策略。
- **阶段 6**：多游戏多设备实测、错误提示与体验完善。
