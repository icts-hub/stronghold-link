# 更新日志

## v0.14.5

修：**干道（Steam P2P 连接）断开重挂时，出站队列里"还没交给 Steam"的字节被整段丢掉 —— 对端 Minecraft 收到残缺的 TCP 字节流，报 `DataFormatException: unknown compression method` 后掉线**

### 现场是什么样

好友进世界后几秒到几十秒内必掉线（聊天框里反复"加入了游戏 / 退出了游戏"），而 Steam Lobby 全程在线；主机侧日志里每一条流都以 `流结束（本机游戏服务把这条件接关了）` 结束，看上去像"游戏服务自己关的"。客户端报：

```
Internal Exception: io.netty.handler.codec.DecoderException: java.util.zip.DataFormatException: unknown compression method
```

真机日志里能抓到关键一刻（`%APPDATA%\stronghold-link\startup.log`）：一条已下行 19 MB 的干道被 Steam 判死（`Relay received unexpected noconnection packet`，Steam 原因 5010），紧接着 `干道断了，先把 2 条本机连接寄存 60 秒等新干道来接`。

### 真因

1. **寄存只搬流对象，不搬出站队列。** `parkPeerStreams()` / `parkTrunkStreams()` 把本机 socket 挪进 `orphanStreams` 等新干道，但 `peer.out` / `egress` 里那些**已经排好队、只是还没交到 Steam 手里**的帧，既没有转移到流上、也没有任何标记，随旧 peer 一起消失。
2. **流却被"原地复活"。** 新干道用 `OPEN(同一个流号, 世代 + 1)` 把这条流原样挂回来继续收发 —— 两端都不认为连接断过。
3. 于是对端那条 TCP 可靠字节流的**中间少了一截**：Minecraft 的 netty 解码器按包长切分时错位，读出脏压缩头 ⇒ `unknown compression method` ⇒ 掉线并自动重连 ⇒ 主机侧只看到"玩家反复加入/退出"。
4. **日志把方向带反了。** 流结束的 `kind`/`reason` 是写死的"本机游戏服务把这条件接关了"，"我们自己 destroy（背压/迁移/清理）"和"游戏侧真的关了"长得一模一样；`stats.dropped` 又把迟到的 CLOSE/Window 也算成"丢了数据"，一起把人往错方向引。

### 现在怎么修

| # | 位置 | 改动 |
|---|------|------|
| 1 | `network/egress-queue.cjs` | 新增 `takePending(peer, ids)`：把"确认前缀之外、从没交给 Steam"的帧按队列 FIFO 整段取出（已确认的前缀早被 `commit()` 出队，所以取出来的**一定没送达**，补发不会重复） |
| 2 | `network/steam-adapter.cjs` | 新增 `retagFrame(frame, streamId, generation)`：跨世代补发前只改**这条流**的世代字段（偏移 9），其余字节原样 —— 否则对端按"迟到帧"整段丢掉，等于又丢一次 |
| 3 | `network/steam-adapter.cjs` | 房主 `parkPeerStreams()` 与加入者 `parkTrunkStreams()` 寄存前 `takePending()`，把待发帧挂到 `stream.pendingFrames` |
| 4 | `network/steam-adapter.cjs` | 房主 `adoptOrphan()` 与加入者 `resumeOrphanStreams()` 复活时，先补发 `pendingFrames`（`retagFrame` 成新世代），**再**补发寄存期间的 `parkQueue` —— 两段之间的先后顺序就是原始字节顺序 |
| 5 | `network/steam-adapter.cjs` | `schedulePeerReconnect()` 不再 `egress.clear(peer)`（旧注释"重发只会让对端收到重复字节"是错的：队列里只有没交给 Steam 的字节），改为 `takePending()` 后接回 `peer.queue` |
| 6 | `network/steam-adapter.cjs` | 关闭日志改为"谁动手谁留名"：新增 `STREAM_CLOSE_KINDS` / `noteLocalClose()` / `noteLocalCloseFor()` / `streamCloseInfo()`，13 条清理与关闭路径各自留名；`stream-left` 事件带 `by`（发起方）、`paused`、`backlogBytes`、`steamBacklogBytes`。删掉写死的 `本机游戏服务把这条件接关了` / `浏览器/游戏自己关掉了本机连接` |
| 7 | `network/steam-adapter.cjs` | 房主 socket `close` 补上 `firstGone(stream)` 守卫（与加入者侧一致）：同一条流只报一行；`destroyPeerStreams()` 支持 `kind`，协议错乱报 `BadFraming` 而不是笼统的 `TunnelClosed` |
| 8 | `network/steam-adapter.cjs` | 两处 `handleStreamFrame` 的"未知流"分支只在**带数据的帧**上记 `stats.dropped`：迟到的 CLOSE/Window 是收尾的正常顺序，记成丢字节会让这个指标失真 |
| 9 | `electron/main.cjs` | `CONNECTION_END_KINDS` 补齐 15 个 kind 的中文说明；`流结束（…）` 这一行追加 `发起方=` / `暂停=` / `本机待发=` / `Steam待发=` |
| 10 | `test/steam-adapter.test.cjs`（+7）、`test/egress-queue.test.cjs`（+2） | 见下表 |

### 新增回归测试

| 测试 | 钉住的东西 |
|------|-----------|
| 房主干道断开时压在出站队列里的字节，复活后必须接着送 | 本修复的核心：修前 `少了 30000 字节 … 26 !== 30026` |
| 加入者同场景（与房主同一套语义） | 两侧寄存/复活行为一致 |
| `takePending`：只取没交给 Steam 的帧 / 流内 FIFO + 按流号过滤 | 补发不重复、顺序不乱、不动别的流 |
| `retagFrame`：只改要跨世代重发的那条流 | 对端不误丢补发数据、别的流一个字节不动 |
| TCP 分段与合并读取（半个帧 / 两帧粘一起 / 本机分三次写） | 读取边界不是包边界：半个帧一个字节都不许写进去，方向两侧逐字节一致 |
| 背压暂停→恢复 | 暂停只是"先别生产"：不掐游戏连接、恢复后字节完整、`dropped === 0` |
| 重复清理（Close → Reset → 破干道） | 同一条流只出一条 `stream-left`、幂等、不误记账 |
| 关闭日志：游戏侧 / 对端 MUX / 我们清理三种关法 | 报出三种不同发起方，不许再甩锅给游戏侧 |

## v0.14.4

修：**"好友那边卡到 6.5 秒" —— 背压只盯着我们自己的队列，而 1.6 MB 的数据正压在 Steam 的发送缓冲里**

### 现场是什么样

房主侧 Minecraft 服务端推区块时，好友的人物移动成秒级延迟（最坏 6.5 秒）。同一时刻我们这一侧的所有队列读数都是 0：`globalQueueBytes=0`、`streamQueueBytes=0`、`tcpWritableLength=0`、`egressQueues=[]`、`dropped=0`。

### 真因

1. **背压看错了信号。** `applyBackpressure()` 只统计 `peerOutBytes()`（我们自己的出站队列），而 Steam 的发送缓冲有 2 MiB（`network/steam-netconfig.cjs` 的 `sendBufferSize`），灌满之前 `sendMessage` 一律回 success ⇒ 数据躺在 Steam 内部队列里，我们这边读数是 0，背压一次都不触发。
2. **"暂停本机 socket"从来没真的执行过。** 老代码只 `peer.socket.pause()`，而多路复用模式下 `peer.socket` 恒为 `null`，真正的数据源是每条流的 `stream.socket`。
3. **暂停会让 30 秒看门狗误判。** 暂停期间不再 flush，`lastProgressAt` 不再更新，正在慢慢排空的健康连接会被 destroy。

现场数据（`%APPDATA%\stronghold-link\net-latency-host-2026-10-12T15-28-21-927Z.jsonl`，242 帧）：`pendingReliable` 峰值 **1.62 MB**、`queueMs` 峰值 **6486 ms**（114 帧 >0，中位 1688 ms、p95 5765 ms）、RTT 57–62 ms、发送上限恒 256 KB/s。

### 现在怎么修

| # | 位置 | 改动 |
|---|------|------|
| 1 | `network/steam-adapter.cjs` | 新增 `readSteamRealtimeStatus()` / `steamBacklogBytes()` / `sampleSteamBacklog()`（按 20 ms 节流读 `getConnectionRealTimeStatus().pendingReliable`）/ `pumpPeerBackpressure()` / `collectSourceSockets()` / `pauseSourceSockets()` / `resumeSourceSockets()` |
| 2 | `network/steam-adapter.cjs` | `applyBackpressure()` 增加 Steam 高水位分支；暂停与硬上限销毁都作用到**该连接全部**数据源 socket（`peer.socket` + 各条流的 `stream.socket`） |
| 3 | `network/steam-adapter.cjs` | `resumeOrAbort()` 要求两路水位都降下来才恢复（防每 tick 抖动）；排空中的连接用 Steam 积压变小来刷新 `lastProgressAt`，不被 30 s 看门狗误杀 |
| 4 | `network/steam-adapter.cjs` | 房主泵与加入者泵每 tick 先 `pumpPeerBackpressure()`；`openStream` / `bindStream` / `bindLocalSocket` 绑上新 socket 时若已暂停则一并暂停 |
| 5 | `network/link-tuning.cjs` | 新增 `SHL_STEAM_BACKPRESSURE`（默认开，`0` = 回 0.14.3）、`SHL_STEAM_BACKLOG_HIGH`（默认 262144）、`SHL_STEAM_BACKLOG_LOW`（默认 65536），低水位高于高水位时自动压回并记 `notes` |
| 6 | `tools/steam-backpressure-model.cjs`（新增） | 确定性背压模型：生产端缓冲 → 出站队列 → Steam 缓冲（2 MiB，满则记账 `k_EResultLimitExceeded`）→ 按速率放行 → RTT；丢包整块重传、字节严格 FIFO、完整性守恒 |
| 7 | `tools/steam-egress-sim.cjs` | 新增 `--backpressure`：跑 6 策略 × 9 场景矩阵，按「零丢失 → 排队 → 吞吐 → 翻转最少 → 延迟」自动择优 |
| 8 | `test/steam-adapter.test.cjs`（+14）、`test/link-tuning.test.cjs`（+4）、`test/steam-backpressure-model.test.cjs`（新增 12） | 高低水位、滞回、连接间隔离、多流一起暂停、指标不可用回退、部分确认不抖动、慢连接不被误杀、模型零丢失与确定性 |
| 9 | `network/steam-adapter.cjs` 的 `feedDecoder()` | 顺带修掉一个 0.14.3 起就存在的崩溃：协议错乱分支引用了作用域外的 `states`，抛 `ReferenceError` 并把 Steam 回调循环带进 `ESTEAMCALLBACK` 致命错误（现场表现：应用层往返读数整局变成 `null`）。改为传 `null` |

### 模型数字（heavy：区块 1 MB/s + 50 Hz 移动包，链路 256 KB/s、RTT 60 ms）

| 策略 | 移动包 p50 / p95 | 待发 p95 / 峰值 | 暂停占比 | 翻转 | 限额拒 |
|------|------------------|-----------------|----------|------|--------|
| 0.14.3（不暂停） | 2348 / 4336 ms | 2046.98 / 2048 KB | 0 | 0 | 837 |
| **A 256/64 KiB（选中）** | 1612 / **2020** ms | 88.04 / 316.39 KB | 0.93 | 11 | 0 |
| A128 128/32 KiB | 1356 / 1532 ms | 43.51 / 158.2 KB | 0.96 | 23 | 0 |
| A512 512/128 KiB | 2072 / 2736 ms | 509.63 / 514.06 KB | 0.81 | 7 | 0 |
| C 自适应 | 1216 / 1648 ms | 88.04 / 260.07 KB | 0.93 | 39 | 0 |

跨场景汇总：A 的最坏排队 p95 **1133 ms**（基线 8000 ms）、延迟比 0.6334、待发比 0.2266、吞吐比 1.0004（吞吐不降）；A128 更快但翻转约 2×；A512 峰值 2011 ms 超出 2000 ms 目标；C 翻转约 3×（自适应抖动）。`slow` 场景（生产端 180 KB/s < 链路）六种策略逐项相同 ⇒ 新背压不介入。

### 风险与未验证

- **真实校园网 + 真实对端的 A/B 未做**：没有跑空闲/区块突发/连续游戏三场景的基线-修复对照，上表全部是模型结果，不能当真机数据。
- 同机环回（真实 Steam P2P + SDR，4 条并发流每 20 ms 灌 256 KiB，20 s）：新背压开/关两次运行的应用层往返 p50 28 vs 29 ms、p95 都是 85 ms、max 125 vs 130 ms，环回链路上 Steam 待发量始终为 0 ⇒ 只能证明「开启后不劣化」，不能证明真机收益。
- 模型不含真实 Steam/SDR、拥塞控制、ACK 细节与本机事件循环开销。
- `pendingReliable` 是连接级指标，一条流灌满 Steam 缓冲时同一干道上的其它流会被一起暂停（多流只在模型里验证）。
- 需两边都升级才对称生效；对端留在 0.14.3 时其出站方向仍有同样的排队。

### 回滚

`SHL_STEAM_BACKPRESSURE=0` 完全退回 0.14.3 行为（不再调用 `getConnectionRealTimeStatus`，只按本机队列水位）。

## v0.14.3

修：**"地图一动人就飘" —— 出站队列按到达顺序发，一张 900KB 的地图区块能把一个 64 字节的移动包挡住 1.5 秒**

### 现场是什么样

两边都在动的时候，只要地图在加载（或者任何一条大响应的流在跑），另一边的移动就开始飘、延迟成秒级；链路越快越不明显。

### 真因

**发送口只有一条 FIFO，而且不分流。** `network/steam-adapter.cjs` 把地图区块、玩家移动、OPEN/CLOSE、会话帧**全部**塞进同一个 `peer.out` 数组先到先发（`queueOut()` 还每调一次就把整个数组求和一遍），`flushPeerOut()` 再把整队 `Buffer.concat` 成一条 payload 交给 Steam。于是一条 64 字节的移动包只要排在 900KB 的地图区块后面，就得等这 900KB 全部进发送缓冲。

### 现在怎么修

| # | 位置 | 改动 |
|---|------|------|
| 1 | `network/egress-queue.cjs`（新增） | 出站队列改成**每流一条 FIFO + 流间轮转**：干道队列（魔数、会话帧）整段最前，然后每条流每个回合最多 `quantum`（默认 4096）字节；**流内严格 FIFO**（同一条流的帧永远同一条队列，OPEN→DATA→CLOSE 不可能乱序）；只在**确认进了 Steam 缓冲之后**出队，且只出**被确认的前缀** |
| 2 | `network/steam-adapter.cjs` | `queueOut()` 接上新队列（删掉每次调用的 O(n) 求和）；`flushPeerOut()` 改成 `planOut → concat → sendChunk → commit 前缀`；`peerOutBytes()` 与所有"队列空了吗"的判断改用现算的 `egress.total()`；重连补发走 `egress.prepend()` |
| 3 | `network/steam-adapter.cjs` | `frameOutKey()` 直接从帧头第 5 字节读流号（二十多个 `pushFrames` 调用点一个都没改），魔数/会话帧/异常长度进干道队列 |
| 4 | `network/link-tuning.cjs` | 新增 `SHL_STEAM_FAIR_QUEUE`（默认开；**设 0 就是 0.14.2 的老调度**，现场回滚用）与 `SHL_STEAM_FAIR_QUANTUM`（默认 4096，范围 512~65536） |
| 5 | `network/net-latency-diag.cjs` | 诊断帧新增 `egressQueues`：每条流排了多少字节、最老那批等了多久 |
| 6 | `tools/steam-latency-probe.cjs`（新增） | 同一台机器自起房主 + 加入者（真实 Steam P2P + SDR）的真机探针；`--bulk-connections/--bulk-payload/--bulk-interval` 用来灌出"地图加载"那种负载 |
| 7 | `tools/steam-egress-sim.cjs`（新增） | **限速模型**：把"朋友家上行"按速率建模（512KB/s ~ 5MB/s），排队/取队用真实的 `egress-queue.cjs`、字节按真实的 13 字节帧头算 |
| 8 | `test/egress-queue.test.cjs`（新增） | 18 条：流内 FIFO / 轮转公平 / 量子粒度 / 前缀跨队列出队 / 计数现算 / 拥塞链路回归（见下） |
| 9 | `test/steam-adapter.test.cjs` | 新增 2 条端到端公平性用例（大响应不许独占队列；只确认了前缀时按计划逐队列出队）+ 1 条"正常停会话不许报 BadFraming" |
| 10 | `test/link-tuning.test.cjs` | 新增公平调度开关用例与 `fairQuantum` 边界 |

### 真机量不出来，是模型量出来的（这条必须写清楚）

- 本机环回（同一台机器自己连自己、走 Steam SDR）干道吞吐 **421MB/s**，`bytesBuffered / queueMs / pendingReliable` 全是 0，我们自己的出站队列在**每一个 1Hz 采样点都是 0 字节** ⇒ 公平调度在真机上**没有可调度对象**。公平开/关各 3 轮的真机 A/B 也**无法区分**（p50 都是 10~15ms，差异全落在噪声带内）。
- 想给真机限速复现朋友家上行，**这个绑定做不到**：`steamworks-ffi-node` 只有只读的 `m_nSendRateBytesPerSecond` 与枚举 `SendRateMin/SendRateMax`，**没有 `SetConfigValue`**（按 Stream 分 lane 的那几个 API 同样不存在）。
- 于是写了限速模型，**它第一次跑就抓出一个真缺陷**：`planOut()` 每次 flush 都从第一条流重新开始轮转，而一次 flush 被 Steam 接受的字节数经常**小于一个 quantum**（512KB/s ÷ 4ms = 2048B < 4096B）⇒ 第一条流永远排在计划最前面，后面的流（移动包所在流）**无限期饿死**，等待是 **p95 1556ms / max 1736ms**。修法：轮转起点**跨 flush 记住**（`peer.outCursorKey`），下一次从下一条流开始 ⇒ 同一场景 p50/p95/max 全部 **0ms**。回归用例是 `test/egress-queue.test.cjs` 里那条"一次 flush 吃不满一个 quantum 时，后面的流不许被饿死"。

### 模型数字（900KB 大响应 + 64B 移动包每 20ms，回调节拍 4ms）

| 限速 | 老（0.14.2）小包 p95 / max | 公平调度小包 p95 / max |
|------|------|------|
| 512KB/s | **1556ms / 1736ms** | 0ms / 0ms |
| 1024KB/s | 676ms / 856ms | 0ms / 0ms |
| 2048KB/s | 236ms / 416ms | 0ms / 0ms |
| 5120KB/s | 0ms / 152ms | 0ms / 0ms |

### 风险与未验证

- **真机侧的收益未验证**：只能在限速模型里量出来；跨机（真实两条上行）对照还没做，需要朋友那台机器的日志与一次联机对照。
- 模型的保真度有限：Steam/SDR 拥塞控制、丢包重传、事件循环开销都**没有**建模。
- 事件循环在 Windows 上有约 **15.6ms** 的地板（实测 `setInterval(4)` 实际 14.3ms、`setInterval(16)` 实际 25.0ms）：空闲时 `mean` 就有 10~16ms，低于地板的读数不能用来区分"空闲"与"轻微延迟"。诊断输出会明说这一点。
- 顺带修掉四个"量错"（不修读数就是假的）：`resolutionMs` 恒为 null（Node 24 上 `IntervalHistogram.resolution` 是 `undefined`）、空队列被写成 `最老=UNAVAILABLE`、加入者 `serve` 永远是 0（埋点埋在了 `mux:false` 才走的老路径上）、正常停会话被写成 `BadFraming / 数据流格式不对`。
- 完整报告见 `docs/0.14.3-网络延迟专项.md`。

### 测试

全量 `npm test`：**766 tests / 765 通过 / 0 失败 / 1 跳过**。新增用例：`test/egress-queue.test.cjs` 18 条、`test/steam-adapter.test.cjs` 3 条、`test/link-tuning.test.cjs` 1 条、`test/net-latency-diag.test.cjs` 10 条。

### 升级顺序

**房主和朋友都要升到 0.14.3**：公平调度在发送侧（房主与加入者都改了），只有两边都是新版才谈得上"两个方向都不飘"。

## v0.14.2

修：**三个人同房时两条流会串线；还有一句最关键的地址提示从来没显示出来**（0.14.0 / 0.14.1 现场）

### 现场是什么样

1. **好友照着 Steam 邀请进来，就是找不到服务器。** 房主在 Minecraft 里「对局域网开放」，把端口分享出来，两个人都以为已经连上了 —— 但好友的「多人游戏」列表里永远不会有这个世界。
2. **「第三人要抢占隧道」**：三个人（房主 + 两个好友）的时候，两个好友的隧道会互相抢。

### 真因（三条独立的原因叠在一起）

**(1) 地址提示一直是一段死代码。** `src/ui/index.html` 的 `logConnectionAddresses()` 从写下来那天起就在调 `bold()`，而 `bold` 全仓库从未定义过。于是「选进程开局」成功之后（主进程其实**已经**把隧道建好了）走到这里就抛 `ReferenceError`，被 `initLobbyPort` 的 `catch` 抓成「配置出错：bold is not defined」：地址行与「复制」按钮**一次都没显示过**，后面的 `renderRoomSteps` 与 `refreshLobby` 也一起被跳过。**界面在报错，隧道其实是好的** —— 而"游戏里要手填 `127.0.0.1:<端口>`"这句最关键的话，从来没有出现在界面上。

**(2) Minecraft 根本不会因为 Steam 邀请就出现在好友的列表里 —— 这不是 bug，是协议。** 局域网世界靠 UDP 广播（`224.0.2.60:4445`）自己冒出来，而这条隧道只搬 TCP（`network/steam-adapter.cjs` 顶部注释就是「不做 UDP…只用于 TCP 流量」）；Steam 的「加入游戏」也只拉起游戏进程、不把地址传进去（Minecraft Java 没有 Steam 联机集成）。以前这件事只写在一条会被异常吞掉的大厅日志里。

**(3) 三人的真因是寄存流表的键错了。** 房主侧 `orphanStreams` 是**一张所有对端共用的扁平表，只按流号索引**；而每个加入者的流号都是**各自从 2 开始的偶数**（规格 §十一 只保证"房主奇 / 加入者偶"，保证不了加入者之间不重号）。于是干道断过一次之后：

  - 后一个加入者寄流时，会把前一个加入者寄存中的流**连同它的游戏 socket 一起 `destroy()`**；
  - 后一个加入者的 `OPEN(2)` 会**接管**前一个加入者的游戏 socket —— A 的数据被送到 B，B 的请求打到 A 的连接上。

### 现在怎么修

| # | 位置 | 改动 |
|---|------|------|
| 1 | `src/ui/index.html` | 补上缺失的 `bold()`（`'<b>' + esc(s) + '</b>'`）——「复制」按钮与地址行从此真的会显示 |
| 2 | `src/ui/index.html` | 新增醒目横幅 `#gameEntryBanner`：把「Steam 邀请只架隧道，游戏里还要自己填 `127.0.0.1:<端口>`」放在好友与大厅页最上面，带**一键复制地址** |
| 3 | `src/ui/index.html` | Minecraft 时横幅额外说清：不会出现在好友的「多人游戏」列表里、要走「多人游戏 → 直接连接」；基岩版走 UDP，这条隧道不支持 |
| 4 | `src/ui/index.html` | `logConnectionAddresses(port, role, game)` 带上游戏名；两个调用点分别传"检测到的游戏"与大厅里的 `hostInfo.game` |
| 5 | `network/steam-adapter.cjs` | 房主侧寄存流表改成 **`对端身份#流号`** 双键（`orphanKey()`，身份优先 SteamID），谁都不可能再认领别人的流 |
| 6 | `network/steam-adapter.cjs` | 加入者侧保持扁平表，但把"为什么这里安全"写进注释 |
| 7 | `test/steam-adapter.test.cjs` | 新用例：房主 + 两个加入者流号都是 2 —— 谁也不能抢走、销毁对方寄存中的流 |
| 8 | `test/ui-logic.test.cjs` | 新用例：走真实的「选进程开局」路径，断言横幅真的画出来、「复制地址」真的把 `127.0.0.1:25565` 写进剪贴板 |
| 9 | `electron/main.cjs` | 适配器的 notice（`Steam 连接事件：对端 …（判定为入站，接受 / 出站，跳过）` 那一类）**现在也写进 `startup.log`** |
| 10 | `test/session.test.cjs` | 新用例：钉死「`[Steam] ` 前缀」这个约定（主进程就靠它挑出该落盘的那一路） |
| 11 | `tools/build-guard.cjs`（新增） | 打包护栏：`package.json` 带 BOM ⇒ 拒绝；`app.asar` 没被重写过 ⇒ 拒绝；`app.asar` 里的 `APP_VERSION` 与 `package.json` 对不上 ⇒ 拒绝 |
| 12 | `tools/build-edition.cjs` | 接上这三道护栏。原来的判断是「退出码非 0，但 `win-unpacked` 还在就继续」—— 而那个目录可能是**上一次**打包留下的 |
| 13 | `test/build-guard.test.cjs`（新增） | 6 条用例钉住上述约定，其中一条直接读仓库自己的 `package.json` 查 BOM |
| 14 | `package.json` | 去掉文件开头的 UTF-8 BOM；`test` / `test:single` 两个脚本加上新的用例文件 |

### 险情：这一版**差点把 0.14.1 的包当成 0.14.2 发出去**

前两次 `npm run dist:full` 都"成功"产出了 `Stronghold-Link-0.14.2-win-x64.tar.xz`，可是打开包里的 `app.asar` 一看，里面写的是 `APP_VERSION = '0.14.1'` —— **版本名换了，代码是旧的**。

- **直接原因**：`package.json` 的第一个字节多了一个 UTF-8 BOM。electron-builder 内部的 `@electron/rebuild` 会直接 `JSON.parse` 这个文件，于是它停在 `Unexpected token '', "{ "name"... is not valid JSON` —— 而这一步发生在**写 `app.asar` 之前**。
- **为什么没被拦住**：`tools/build-edition.cjs` 有一段历史容错（这台机器上 builder 会在图标转 ICO 那步联网失败，但产物其实已经完整），它的判断是"退出码非 0，但 `win-unpacked` 还在就继续"。而那个 `win-unpacked` 是**上一次打包留下的旧目录**，里面的 `app.asar` 时间戳还停在 0.14.1 那次。
- **怎么发现的**：交付前的 asar 核验（把 `app.asar` 当文本读、逐条查本次改动引入的 ASCII 锚点）全军覆没 —— `orphanKey`、`gameEntryBanner`、`function bold(s)`、`startsWith('[Steam] ')`、`APP_VERSION = '0.14.2'` 一个都没命中。
- **现在的护栏**（`tools/build-guard.cjs`）三道都不看 electron-builder 的退出码，所以原有的容错场景照样能过。`test/build-guard.test.cjs` 里那条"读仓库自己的 `package.json` 查 BOM"的用例做过变异验证：把 BOM 加回去，它立刻红。
- 顺带确认：**0.14.0 与 0.14.1 的交付包是真的**（那两个提交里的 `package.json` 都没有 BOM）。
- **重打之后的真包**：`Stronghold-Link-0.14.2-win-x64.tar.xz`，96,337,948 字节，
  SHA256 `CC7E2D29464E6FFAE684DE165D2068BA696FE4F5F65C54AFDC3FEA352AA50BEB`；
  asar 里 13 条锚点全部命中，`--smoke` 8 步全过、渲染进程自报 `version: 0.14.2`。

### 升级顺序：**房主和朋友都要升到 0.14.2**

两边都有改动（横幅在界面侧、串线在房主侧）。混用不会连不上，但串线只在房主侧修好。

### 测试

`npm test` ⇒ **734 tests / 733 pass / 0 fail / 1 skipped**（上一版 0.14.1 是 725 / 724 / 0 / 1，+9 —— 三条功能用例 + 六条打包护栏用例）。

定向：`node --test --test-isolation=none test\steam-adapter.test.cjs` ⇒ 66 pass；`test\ui-logic.test.cjs` ⇒ 12 pass；`test\session.test.cjs` ⇒ 24 pass；`test\build-guard.test.cjs` ⇒ 6 pass。

新用例都做过**变异验证**（把修复藏起来，用例必须干净失败）：把 `orphanKey` 还原成只按流号 ⇒ 报「B 寄流时绝不能销毁 A 寄存中的那条流」；把 `bold()` 改名 ⇒ 报「不该再出现 bold 未定义：配置出错：bold is not defined」；把 `[Steam] ` 前缀去掉 ⇒ notice 那条用例立刻红；把 BOM 加回 `package.json` ⇒ 「package.json 绝不能带 UTF-8 BOM」立刻红，并且打包脚本当场以退出码 1 中止（`tools/build-edition.cjs:27`）。

### 这一版**没有**解决

- Minecraft 的「对局域网开放」世界仍然**不会**自动出现在好友的列表里（UDP 广播搬不过 TCP 隧道）。界面现在会明确告诉用户要手填地址，但**组播转发本身没做**。
- 基岩版（UDP）仍然不支持。
- 三个人的真机联机还没有实测过（本机只能跑到"两个加入者流号撞号"这一层）。

## v0.14.1

修：**干道握手的第一包丢了，整局就永久吊死** —— 0.14.0 首日现场（2026-10-08）的真因

### 现场是什么样

用户当房主、朋友当加入者，加入者的浏览器一直转圈。房主侧的日志是这一副样子：

    干道上开了一条流 流号=176 对端=76561199069304259
    隧道存量 1 条：:? 存活70s 上行0KiB 下行16KiB
    …… 之后一条新干道 292 秒 上行0KiB 下行0KiB，一个字节都没动

旧干道被 Steam 以 4001 掐掉之后，新干道**建起来了、Steam 也报 Connected，但两边一个字节都没交换**，
之后每一条本机连接都挂不上去。本机自连的回环探针（`tools/steam-http-probe.cjs`）四组用例逐字节精确、
15~19ms —— **代码逻辑本身是对的，坏的是"握手第一包丢了之后没人管"这条路径。**

### 真因（三条叠在一起）

1. 干道建起来后，加入者立刻把魔数排进发送队列（`spawnTrunk` 里 `if (peer.framed === null) pushFrames(...)`）。
   `connectP2P` 刚返回、Steam 还没进 Connected，`sendMessage` 却已经报成功 —— **这一包可以丢，而代码没有任何重发。**
2. 丢包之后这条干道永远停在"还没谈妥"（`framed === null`），而 `hasLiveTrunk()` 判定"活的干道"时
   **只跳过 `framed === false`**，`null` 算活的 ⇒ `refillTrunks()` 从此再也不补新干道。同时
   `pickTrunk()` 只认 `framed === true`，所以之后每一条本机连接都只能进 `pendingSockets` **无限期等待**。
3. 旧干道断掉时被**寄存**的流只有 8 秒宽限（`STREAM_MIGRATE_GRACE_MS`），而这条线路上一次成功握手
   实测要 **6.8 / 9.4 / 17.4 秒** —— 宽限还没到，流就被清扫成 `TunnelClosed`，
   **浏览器那条连接被收掉，表现就是"一直转圈"。**

### 现在怎么修

- **补发魔数**：未谈妥的干道每 4 秒重发一次魔数（`PEER_HELLO_RETRY_MS`）。
- **超期换新**：30 秒还没等到应答（`PEER_HELLO_GIVEUP_MS`）就丢掉这条换一条重来，
  本机连接原地排队等着，**不用刷新页面**。
- **宽限 8 秒 → 60 秒**：`STREAM_MIGRATE_GRACE_MS` 必须盖住"放弃一条干道 + 重开一条并谈妥"的
  最坏情况，8 秒连一次成功握手都盖不住。
- **房主收到重复魔数会再答一次**（`stats.helloRepeat`）：房主早已定帧就不会再说第二句话，
  而加入者要等满 30 秒才放弃 —— 重答只要 7 个字节，把这 30 秒白等缩成一个重发周期。
- **★ 解帧器对魔数免疫**：`flushPeerOut` 在队列里有多项时会**拼成一条消息**发出去，
  所以重答的魔数会被粘在数据帧**后面**。以前 'SHLM' 会被当成帧长度读成 `1397247053`，
  判定为格式错（BadFraming），**把刚救回来的隧道又毙掉**。现在解帧器识别并跳过
  出现在任何位置的完整魔数（前缀不全就等更多字节 —— 合法帧的长度必然 ≥9，以 'S' 开头的合法帧不存在，
  所以没有歧义）。
- 两个新参数可用环境变量调：`SHL_STEAM_TRUNK_HELLO_RETRY_MS`、`SHL_STEAM_TRUNK_HELLO_GIVEUP_MS`。

### 升级顺序

**两边都要升到 0.14.1。** 补发魔数在加入者侧，重答与 60 秒宽限在房主侧；只升一边也能跑（协议没变），
但那一边的缺陷还在。大厅版本号不一致只会提示一句，不会互相连不上。

### 测试

725 条用例 / 724 通过 / 0 失败 / 1 跳过。新增两条回归用例，都做过变异验证（把修复关掉必然变红）：
`test/steam-adapter.test.cjs` 的「干道建起来但房主一直不应答（首包丢了）」，
`test/stream-mux.test.cjs` 的「解帧器跳过半路出现的握手魔数」。

## v0.14.0

改：**一条本机 TCP 不再等于一条 Steam P2P 连接** —— 一局只握一次手，页面里几十个连接共用同一条干道

### 现场是什么样

校园网下每次开页面都要等十几秒甚至干脆加载不出来。日志把原因写得很清楚：

    本机连接进来 127.0.0.1:56289 —— 临时握手（池子当时是空的）
    连接结束 理由=Timed out attempting to connect 握手耗时=30s Steam原因=5003

一个首页要开 6~25 条 TCP，而**每条 TCP 都去建一条独立的 Steam P2P 连接**。Steam 的
P2P 握手在这条线路上要 30 秒，失败率还高（5003 / 5008 / 4001）；12 分钟的日志里
预热池命中 53 次、临时握手 62 次 —— 命中率只有 46%。池子自己也撑不住：每条握手 30 秒，
池内连接寿命却只有 27~40 秒，**建得还没有死得快**（累计开 83 / 就绪 67 / 命中 52 /
未命中 57 / 换新 12 / 自死 15 / 均寿 31 秒）。

### 现在怎么工作

    游戏 → 本机 TCP → MUX 分帧 → 一条长期 Steam P2P（SDR）→ 对端 MUX → 本机 TCP → 游戏

- **一局只有一条干道**：隧道一起来就握好，之后不管开 1 个还是 25 个连接，Steam 层
  始终是这 1 条。实测 25 条本机 TCP → `connectedTo.length === 1`。
- **MUX 分帧**：`[长度][类型][流号][世代][载荷]`，可靠有序交给 Steam，我们只做流映射。
  流号房主用奇数、加入者用偶数，两边不会撞号。
- **干道断了不等于这半局作废**：已建立的连接全部**寄存**，新干道 8 秒内接上就把它们
  **原地复活**（同一个流号、世代 +1 重发 OPEN，房主那边连游戏端口的那条连接都认回来）。
  浏览器不需要重新加载页面。
- **世代号防串味**：旧连接上迟到的数据帧世代对不上，直接丢掉，不会被写进复活的流里。
- **预热池整段删除**：不再为"将来可能来的请求"提前建连接。相关参数
  `PEER_POOL_TARGET` / `PEER_POOL_MAX_IDLE_MS` 一并消失，别再改回来。
- **Steam backend 抖动不会杀掉已有连接**：只有真收到那条连接的关闭/异常回调才会动它。
- **整个网络层只有一个调度器**：0.13.3 的四个 per-peer 定时器（重连、魔数看门狗、
  统计、回调泵）全部收进一个统一 tick。
- **网络状态看得见了**：`[Steam] login= relay= transport=` / `[P2P] role=… state=…` /
  `[MUX] streams=…` 三行每 30 秒写进 `startup.log`，界面也不再是笼统的"连接中"。

### 升级顺序：**房主先升，朋友后升**

带内握手只能选一个方向兼容。这一版让**加入者先开口、房主被动应答**：

| 组合 | 结果 |
|---|---|
| 新房主 + 旧加入者 | ✅ 完全兼容。房主看到对端首包不是魔数，就一个字节都不多发，照旧走单连接 |
| 旧房主 + 新加入者 | ⚠️ 加入者发的魔数会被旧房主当成游戏流量转发。**加入者随后会自动退回单连接模式**（认到首包不是魔数），但要先浪费一次往返 |

所以：**先升房主**。房主升完之后，朋友升不升都能连；朋友升了才有多路复用。

### 测试

    722 个用例 / 721 通过 / 0 失败 / 1 跳过

其中新写的端到端验收（房主与加入者两侧真适配器同时跑，中间用桥对接）覆盖：
25 条并发仍只有 1 条 Steam 连接、连续建/关 100 条连接 Steam 连接数一条不多、
旧连接迟到数据被丢弃、WebSocket 长连接 60 个来回、1MB / 8MB / 32MB 大 payload
逐字节一致且单条消息不超过 4KB。

**仍未验证**：全部跑在注入的假 SDK 上 —— 逻辑与计数是对的，但"校园网下握手真的会成功"
只能靠两台真机验证（见 `docs/0.14.0-网络架构重构.md` 的 UNVERIFIED 段）。
另外本版**不建 Backup 连接**（规格明确允许），Primary 断开时走"新建一条 + 流复活"。

## 未发布

修：两处**只在日志里**的毛病 —— 一行从来没打出来，另一行把人带沟里

都不是传输路径的问题，但都在现场诊断最需要证据的时候掉了链子，所以单独记一笔。

### `[网络参数]` 那一行从来没出现过

v0.12.9 加了「全局参数实际生效情况」的日志，用来回答"建连超时到底放宽了没有"。
结果现场日志里**一行都没有**。原因是轮询次数和外部触发次数**共用一个计数器**：

    netConfigTries += 1;
    if (netConfigTries > 8) return;   // 约 12 秒还没拿到就放弃

而这个函数既被 `session:start` 调用，又被**每一个隧道事件**调用（`peer-stats` 每 2 秒
一条，还夹着 `client-added` / `peer-left`）。通道还没就绪，计数器就被事件刷爆了，
函数从此静默 return —— 连"放弃了"都不肯说一声。

现在轮询次数只由内部递归累加（`logNetConfigSoon(tries = 0)`），外面调多少次都只是
"催一下"，另加 `netConfigPolling` 保证同时只有一条轮询链；真等不到也会留一行
`[网络参数] 等了约 30 秒仍拿不到全局参数报告，放弃记录（不影响传输本身）` ——
**静默的"没有日志"和"忘了写日志"在现场是分不出来的**，这条教训值一行代码。

### `握手耗时=` 对长连接是错的

`attemptMs` 是"这一次 connectP2P 到连接结束"的时长，含义分两种，原来一律标成
`握手耗时`。现场因此出现过 `握手耗时=43s 存活=43s 上行=1KiB 下行=50KiB` 这种自相矛盾
的行 —— 那条连接明明连上并传了 50 KiB，43 秒是它的**寿命**，不是握手时间。

现在按"有没有数据来回"分别标成 `本次连接=` 与 `握手耗时=`：只有**一个字节都没来回过**
的那种才叫握手耗时，它才是判断"超时参数太紧还是链路真不通"的硬指标。

## v0.13.3

修：**找到"地图加载不出来、刷新一下就好"的正身** —— 加入者会把对端已经发来的最后一段字节连同关闭通知一起丢掉

### 现场是什么样

浏览器点开地图 → 一直转圈 → 刷新一下就好了；或者页面出来了但图片/脚本半截。
听起来像"网络不稳"，其实是**一个 100% 确定性的数据丢失**：只要游戏服务是
"回完响应立刻关连接"的写法，那个响应就永远到不了浏览器。

### 真机 A/B：唯一变量是"服务端回完关不关连接"

同一个脚本、同一段代码、同一分钟，只把探针请求换一个 HTTP 版本：

| 探针请求 | 结果 |
|---|---|
| `GET / HTTP/1.1`（服务端回完**不关**本地连接） | **3/3 通过，平均 10 ms**，`加入者 上行+27B 下行+150B` |
| `GET / HTTP/1.0`（服务端回完**立刻关**本地连接） | **4/4 失败，全部 40 秒超时**，`加入者 上行+27B 下行+0B` |

失败那 4 条的房主侧计数是 `上行+122B 下行+27B` —— **122 字节的响应确实产生了、
也确实排进了房主的发送队列，可加入者一个字节都没收到。**

为什么现场必然踩这一支：游戏服务正是 HTTP/1.0 + `Connection: close` 的写法。
用户自己的 `startup.log` 里就有大量这类指纹：

```
连接结束（对端关掉了这条 Steam 连接）理由=本地服务连接关闭 Steam原因=1000（应用层正常结束）
```

近 800 行断开原因直方图里 `1000` 出现 **92 次**。

### 病因（两条，叠在一起）

1. **加入者**：房主"发完最后一个响应就关"时，"连接关闭"的通知和最后一段数据几乎
   同时到达。原来的顺序是收到通知就 `dropPeer` —— 而数据还躺在 Steam 的接收队列里
   没被泵走（泵是按 tick 跑的，状态回调随时会插进来），**那段数据再没人读，直接没了。**
2. **`dropPeer`**：收尾时用 `peer.socket.destroy()`。`destroy()` 会把**还在写缓冲里
   没冲出去的字节一起丢掉** —— 刚搬过来的最后一个响应往往正躺在那里。

### 改了什么

- `network/steam-adapter.cjs` 新增 `drainReceivedInto(peer)`：拆连接之前先把 Steam
  接收队列读干净、写进本机 socket（`receiveMessages` 循环到空或不足一批为止，绝不死循环）。
  加入者的断开分支在 `dropPeer` 之前调用它；拿到过字节就**不再算"首字节都没回来"**，
  也就不会白白触发重连重放。
- `dropPeer` 收尾改成：**有积压时走 `end()`**（先冲干净再 FIN），只有真没积压才 `destroy()`。
- 房主侧同步补齐（上一轮遗留）：本地服务连接关闭时先 `drainThenClose()` 把 `peer.out`
  抽干再用 `linger = true` 关 Steam 连接，与 `dropPeer` 的 linger 语义对齐。

### 测试

`test/steam-adapter.test.cjs` 新增「加入者：对端"发完最后一个响应就关连接"时，
那段响应也必须送到本机客户端」——同步地先送数据再发关闭通知，中间不给泵任何机会。
**这条用例有真正的判别力：把 `drainReceivedInto` 临时关掉，它就会红**（58/59），
开着就是绿的（59/59）。全量 **518/518 通过**（上一版 517）。

### 顺带补上的观测工具

- `diag/pool-verify.cjs`：新增 `SHL_PROBE_DELAY_MS`（连上后先等 N 毫秒再发请求，
  用来分辨"刚交接那一刻发数据会丢"和"这条链路根本发不出去"；实测等 5 秒照样复现，
  **与交接时机无关**）；`peer-stats` 截断从 200 字符放宽到 4000，收尾时打印双方最后
  两条 `peer-stats`（每条都带 `queue` = 此刻压在 `peer.out` 里没发出去的字节）。

## v0.13.2

验：把预热连接的**死因分开数** —— 实机盯 4 分半，确认池子没有在白白抢握手名额

- 起因是个看着很吓人的数字：`diag/pool-verify.cjs` 的"只盯不碰"模式跑了 150 秒，
  却造出了 **44 条**预热连接。按"4 个槽位 × 约 34 秒寿命"算，同时段只该造 ~18 条。
  多出来的那些如果真是**自己断的**，每一次补货都要多抢一次 Steam 握手名额（现场实测
  约 1 条/3 秒），池子就会反过来把用户自己的连接挤到队尾 —— 这正好是用户反复说的
  "极其不稳定"。而现场日志里预热连接的死亡是**静默**的（`dropPeer` 直接丢掉，
  不留一行日志），根本查不出死因。
- 于是给 `network/steam-adapter.cjs` 的 `dropPeer` 加了 `warmWhy`，把两条路分开：
  - **换新**（`poolRetired`）：看门狗按寿命主动换新，**计划内**，一条换一条，
    不额外占用握手名额。触发点 `Connected` 分支里那个 `setTimeout`。
  - **自死**（`poolLost`）：连接自己断了，**计划外**，补货就是一次额外的握手。
    触发点是 `ClosedByPeer / ProblemDetectedLocally` 分支。
  - `poolLifeMs` 累计所有预热连接活过的毫秒数，除以 (换新+自死) 就是**平均寿命**。
- **实机结果（真 SDK、真握手、真 SDR 中继，4 个槽位，约 270 秒）**：
  `累计开45 就绪45 命中8 未命中0 换新33 自死0 均寿33s`，`备用4/4` 全程满员。
  - **自死 = 0。** 一条都没有意外断掉，多出来的那些全是看门狗按计划换新。
  - **均寿 33 秒**，正好落在设计区间 `45000ms × (0.6~0.9)` = 27~40.5 秒的中位数上。
  - 33 次换新 = 4 个槽位 × 270 秒 ÷ 33 秒寿命，**和设计值严丝合缝**。
    （之前算出"多了一倍"是因为盯池子的循环每轮自己还要花 ~4 秒读统计，
    实际墙钟是 270 秒而不是 150 秒 —— 虚惊一场，但这个死因计数值得永久留在日志里。）
- 三条计数一起补进两道白名单（`network/providers/steam-p2p.cjs` 的 `extras()`、
  `network/session.cjs` 的 `channelStats()`），现场日志里现在长这样：
  `预热池 备用4/4 累计开45 就绪45 命中8 未命中0 换新33 自死0 均寿33s`。
  判读方法：**自死明显大于 0** 才说明池子在空转、在跟用户抢握手；`均寿` 远低于 27 秒
  同理。两个数都正常，池子就是在帮忙而不是在添乱。
- 全量测试仍 **516/516 通过**。

## v0.13.1

验：把 0.13.0 的预热池放到**真实 Steam P2P** 上做 A/B —— 顺带抓出两个"看不见"的毛病

- 单测用的是假 SDK，握手瞬间完成，**量不出"排队限速"**；而现场的病根恰恰是排队。
  于是新增 `diag/pool-verify.cjs`：在本机把房主 + 加入者都跑起来（真 SDK、真握手、
  真 SDR 中继），逐条开本机连接，量"连上→首字节"，并打出池子的四个计数。
  用法：`node diag\pool-verify.cjs [池子条数] [测几条]`，`SHL_STEAM_POOL=0` 就是基线。
- **A/B 结果（同一台机器、同一分钟，各 6 条连接）**：
  | | 命中池子 | 现握手 | 池子计数 |
  |---|---|---|---|
  | 池子开（4 条） | **6 条 / 平均 10 ms** | 0 条 | 累计开10 就绪10 **命中6 未命中0** |
  | 池子关（基线） | 0 条 | 6 条 / 平均 11 ms | 累计开0 就绪0 **命中0 未命中6** |
  回环上握手本来就只要 ~11 ms，所以时间差不明显；**关键是"未命中"从 6 变成 0** ——
  意味着没有一条连接需要用户等握手。真实链路上那一次握手就是现场量到的 2~40 秒。
  补货也对：目标 4 条、被领走 6 条，`poolCreated` 一共 10 条，不多不少。
- **抓出的毛病一：池子的四个计数根本走不到外面。** 它们在 `steam-adapter` 里涨得好好的，
  但 `network/providers/steam-p2p.cjs` 的 `extras()` 和 `network/session.cjs` 的
  `channelStats()` 都是**白名单**，四道字段被整整齐齐丢掉 ⇒ 界面和日志永远显示
  "命中0 未命中0"，看起来像池子根本没工作。两处都补上了。
- **抓出的毛病二：`poolReady` 会重复计数。** 真实 Steam 上同一条连接会不止一次报
  `Connected`（中继换路会重报），于是出现"就绪 8 > 累计开 4"这种荒唐数字。
  用 `peer.readyCounted` 保证一条只数一次，现在恒有 `poolReady <= poolCreated`。
- 新增两条回归测试（514 → **516**）：同一条预热连接被报两次 `Connected` 只能算一条就绪；
  Steam Provider 的统计快照必须带上池子的四个计数（防止哪天又被白名单吃掉）。

## v0.13.0

修：别再让用户等握手了 —— 加入者提前把连好的连接养在池子里，浏览器一进来直接拿现成的

- 0.12.9 的隧道日志把最后一层遮羞布也掀了。**Steam 的 P2P 握手是"排队"的，大约每 2~4 秒才放行一条**，
  和带宽、和文件大小都无关：
  - 加入者侧 `startup.log`，本机端口 `58280 / 62181 / 59934 / 64850` 四条连接在
    `19:25:21.571/573/575/577`（同一秒）发起，接通时刻分别是 `19:25:22.997`（+1.43 s）、
    `19:25:25.103`（+3.53 s）、`19:25:29.322`（+7.75 s）、`19:25:32.110`（+10.55 s）——
    一条接一条，稳稳的 2~4 秒一条。
  - 并发压到 5 条以上就直接雪崩：`63093` 等了 **36.2 s**、`65039` **35.4 s**、
    `52589` **44.7 s**、`51128` **44.6 s**，中间穿插一堆
    `5003（★传输层超时）` 和 `⟳第1/2/3次重连`。对照样本：单独一条 `58014` 只用 **6.0 s**。
  - 没连上的那几条在 `隧道存量` 里一直停在 `End-to-end connection: connecting` /
    `performing rendezvous`；连上的是 `connected Remote host is in data center 'tyo'`（东京 SDR 中继）。
- 而**游戏服务器（Node http，`keepAliveTimeout = 5000 ms`）每 5 秒就把空闲连接关掉一次**，
  房主随即关掉对应的 Steam 连接（日志里成片的
  `连接结束（对端关掉了这条 Steam 连接）理由=本地服务连接关闭 Steam原因=1000（应用层正常结束）`）。
  于是浏览器不得不反复新建连接 ⇒ **反复重新排队握手**。这就是"每次都无法加载出地图、
  刷新完之后很难回房间"的完整链路。
- **改法：加入者侧预热连接池（`network/steam-adapter.cjs`）。** 隧道一起来就在后台把
  `PEER_POOL_TARGET = 4` 条连接一条一条握好、养在池子里（间隔 `PEER_POOL_MIN_GAP_MS = 250 ms`，
  失败按 3 s→15 s 退避，一次只开一条 —— Steam 本来就是一条一条放行的，同时压只会互相拖慢）。
  浏览器/游戏一开连接，`takeWarmPeer()` 直接把它接上池子里那条**已经握完手**的连接，
  **建连耗时归零**，握手发生在用户看不见的时候。
  - 池子里的连接最多闲 `PEER_POOL_MAX_IDLE_MS = 45000 ms`，到点主动换成新的 ——
    比游戏服务器那 60 秒的 `headersTimeout` 早一步，池子里永远是能用的。
    **到期时间带 60%~90% 的随机抖动**：几条预热连接是在同一秒里养起来的，不抖开就会
    一起死、一起重握，正好排在用户此刻的真实连接前面。
  - 池子里的连接死了会**安静地**补货（没有人在等它，不报错、不刷屏）；被领走的那条若在
    1 秒内就死了，会被记成一次失败进入退避，避免房主一直秒关时补货变成死循环。
  - 新增 `SHL_STEAM_POOL` 环境变量 / `poolTarget` 选项，**设成 0 就完全退回老行为**
    （每条连接现握手），方便对照验证。
- `DEFAULT_MAX_PEERS` 16 → **32**，`network/session.cjs` 的 `maxConnections` 默认值同步
  16 → 32：池子是"额外"占用的连接，4 人房（3 个加入者各开 6 条 ≈ 18）叠上池子会撞上限被拒。
- **现场可见性**：`[隧道] 隧道存量` 行现在多一段
  `｜ 预热池 备用3/4 累计开7 就绪5 命中12 未命中1`，`[隧道] 本机连接进来` 会写明这条是
  `拿的是池子里现成的（养了8s）` 还是 `临时握手（池子当时是空的）`。
  新增 `stats.poolCreated / poolReady / poolHits / poolMisses` 四个只涨不跌的计数，
  **现场只要看"未命中"是不是 0，就知道用户还要不要等握手。**
- 新增两条回归测试（512 → **514**）：预热池在没有任何本机客户端时就把连接养好、
  第一条本机连接直接命中且不再发起新握手（并且请求/回包真的走得通）；
  池子里的连接不会被领两次、也不会超过目标条数。
  测试里的 `joinJoiner()` 包装默认 `poolTarget: 0` —— 池子会在后台偷偷建连接，
  会让所有"数连接条数"的断言失准，被测的是数据通路而不是池子。

## v0.12.9

修：找到"极其不稳定"的真身 —— **Steam 出厂的建连超时 10 秒太紧**，而且 0.12.8 的重连把它放大成了 42 秒干等

- 0.12.8 的隧道日志终于把真凶照出来了。加入者侧 `startup.log` 的断开原因直方图：
  **`5003（k_ESteamNetConnectionEnd_Misc_Timeout）` 25 次**、正常结束（`1000`）15 次、
  未给原因 15 次。原样日志行是
  `理由=Timed out attempting to connect ⟳第1次重连 Steam原因=5003（★传输层超时） 存活=10s`。
  **存活=10s 这个数字就是答案**：不是网络不通，是 Steam 自己到点就把还没握完的手收掉了。
- 成功的握手其实**本来就要 6.8 / 9.4 / 17.4 秒**（从日志里 `client-added` 到 `连接已接通` 的间隔算出来）。
  出厂值 10 秒正好卡在这个分布的正中间 —— 所以表现是"时好时坏、随机几条建不起来"，
  而不是稳定地坏。通道本身完全健康：同一时刻 22/22 个资源全过、
  `/vendor/pixi.min.js` 616 ms（723 KiB/s）、`pixi-spine.js` 415 ms（852 KiB/s）。
- **改法一：把建连超时放宽到 30 秒**（`network/steam-netconfig.cjs`）。
  新增 `timeoutInitial`（`k_ESteamNetworkingConfig_TimeoutInitial = 24`，
  头文件 `steamnetworkingtypes.h:1146`），默认 **30000 ms**，可用 `SHL_STEAM_TIMEOUT_INITIAL` 覆盖，
  设成 `10000` 就回到出厂行为。它排在 `APPLY_ORDER` 最前面 —— 后面的项失败时至少超时已经放宽了。
  同时补上 `timeoutConnected`（id 25）但**默认不下发**：出厂值对"慢但在动"的长连接是合适的，
  调小会把隧道判死（这个坑在 `PEER_PAUSE_ABORT_MS` 的注释里已经记过一次）。
- **改法二：只重试"快失败"**（`network/steam-adapter.cjs`，新增 `PEER_RETRY_FAST_MS = 5000`）。
  0.12.8 对任何失败都重试，而慢失败要等满 10 秒超时，于是 `10 秒 × 3 次 + 退避 ≈ 40 秒` ——
  实测 `diag/latency.cjs` 的**首次请求首字节 42533 ms**，比不重试还糟：
  浏览器的请求和游戏的加载画面早就在干等里超时了（现场截图正是游戏那句
  「加载时间较长…如长时间无响应，请刷新页面」）。
  现在只有握手在 5 秒内就被判死（对端主动关、连接数满、旧连接被替换）才重连 ——
  那才是重试真正有价值的场景；慢失败说明链路在挣扎，再压三次握手只会更坏。
- 每次失败还会在日志里带上 **`握手耗时=Ns`**，这样"到底是不是撞上了建连超时"从日志一眼可判，
  不用再猜。`peer-left` 新增 `attemptMs` / `retried` 两个字段。
- 新增**全局参数下发结果的日志**（`electron/main.cjs`）：会话起来后补一条
  `[网络参数] 传输偏好=… 下发=成功 实际生效：✔SendBufferSize=2097152 ✔TimeoutInitial=30000 …`。
  以前这份报告只进界面，而游戏卡住的时候界面恰恰最不可靠。现在"超时到底放宽了没有"看日志就知道。
- 新增两条回归测试（510 → **512**）：`timeoutInitial` 默认 30 秒且可覆盖、
  慢失败必须立刻如实关掉本机连接（不许重连成 40 秒）。

## v0.12.8

修：加入者的连接"建不起来"就悄悄重连一次，而不是让浏览器干等

- 现场症状是**页面一直转圈**，而且和大小无关。实测（加入者侧，`diag/page-load.cjs` +
  `diag/range-one.cjs`，每条都开全新连接）：
  `16 KB` 的 `/js/main.js` 会 20 秒超时而 `456 KB` 的 `/vendor/pixi.min.js` 1916 ms 就过；
  连续 10 条全新连接各只取 64 KiB，**10/10 全部 0 字节失败**（8 次 `ECONNRESET`、
  各耗时 1.2~2.5 秒 —— 正好是一次 Steam P2P 握手的时间），
  而同一时刻普通请求 180 毫秒就回来了。同一份大图连发两段各 900 KiB 都能过
  （累计 1.758 MB，**已经超过之前怀疑的 ~1.4 MB 阈值**），第三段 1.25 MB 才 30 秒超时。
  ⇒ **瓶颈既不是带宽也不是文件大小，是"新建的 Steam P2P 连接经常根本建不起来"。**
- 为什么会表现成"整个页面卡死"：浏览器的**每一条** TCP 连接都对应**一条独立的** Steam P2P
  连接（`network/steam-adapter.cjs` 注释里写明），一个首页要开十几条。
  只要其中几条握手没成，页面就一直转圈。
- 改法（`network/steam-adapter.cjs`）：加入者侧，当一条连接**一个字节都没回来**就被关掉时，
  不再直接掐掉本机客户端，而是**悄悄重连**并把那段请求**重放**出去：
  - 重连上限 `PEER_RECONNECT_MAX = 3`，退避 `PEER_RECONNECT_DELAY_MS = 150`（×第几次，150/300/450 ms）。
  - 重放留档 `PEER_REPLAY_MAX = 64 KiB`：只记**真的进了 Steam 队列**的那段前缀；
    对端一旦回过任何字节就立刻作废 —— 半程的响应没法重放，那种情况只能断开让浏览器自己重来。
  - 重连期间本机 socket 保持打开，数据继续进 `peer.queue`，连上后由 `Connected` 分支补发。
  - 重试耗尽（3 次）后才如实关掉本机连接，不让浏览器无限干等。
  - 新增 `stats.reconnects` 累计重连次数；`peer-left` 带 `willRetry` / `retry`，
    日志里显示成 `⟳第2次重连`，一眼能分清"偶发几次"和"一直在失败"。
- 新增两条回归测试（508 → **510**）：握手失败要重连并重放、重试有上限最终如实收尾。

## v0.12.7

诊断（先把证据补上，再谈修）
- 上一个版本把"每条连接 1 KB/s"修好之后，实测速率从 **0.9 KiB/s 涨到 157~211 KiB/s（约 200 倍）**，
  但立刻暴露出两个新问题：**大文件传到约 1.4 MB 必断**、**延迟有时特别高**。
  这两个问题光看界面查不出来 —— 界面在出事时只会显示"当前没有活动连接"。
- 连接断开的原因 Steam 其实一直都有（`endReason` / `endDebugMessage` /
  `getDetailedConnectionStatus`），只是我们读完就扔了。这个版本把它们留下来：

隧道体检（`network/steam-adapter.cjs`）
- 每 15 秒给所有活着的连接拍一次快照（`peer-stats`）：本机端口、存活时长、
  上送/下收字节、还积压着多少字节、是否处于"暂停读本地 socket"或"已停摆"状态，
  外加 `getDetailedConnectionStatus` 读出的 Steam 侧 `Bytes buffered` /
  `Est avail bandwidth` / 丢包率 —— 这是唯一能直接区分"线路真慢"和"我们自己发得慢"的一手数据。
- `peer-left` 不再只说一句"连接断开"，现在带上：
  `kind`（**本地判定这条连接出问题** / **对端关掉了它**）、`endReason`、
  `endDebugMessage`、这条连接**活了多久**、**实际搬了多少上下行字节**、断开时的残留队列。

日志（`network/session.cjs` + `electron/main.cjs`）
- 隧道生命周期事件（`listening` / `client-added` / `peer-connected` / `peer-left` /
  `peer-stats` / `rejected` / `error` / `stopped`）以前只有前几个会进日志，
  **`peer-left` 连 case 都没有**，掉进 `default` 就静默消失了 —— 所以"是谁在第几秒关掉了连接"
  从来查不出来。现在全部以 `[协议:端口]` 前缀记进会话日志。
- `electron/main.cjs` 新增 `logTunnelEvent`，把上述事件写进 `startup.log`
  （`peer-stats` 2 秒节流、`error` 同阶段同代码 5 秒节流），出问题时直接看日志最后几十行。

断开理由（第二轮）
- Steam 的结束原因（`ESteamNetConnectionEnd`）现在翻译成人话再记：
  `4001 ★对端超时`、`4006 对端协议版本不匹配`、`4007 对端打洞失败`、`5003 ★传输层超时`、
  `5009 ★NAT/防火墙挡住了` 等，认不出来的按区间兜底（1000–1999 应用层正常结束、
  2000–2999 应用层异常结束、3000–3999 本机侧网络问题、4000–4999 对端侧网络问题、5000–5999 传输层问题）。
- **找到一处以前根本查不出来的断点**：房主的本地 socket 一旦 `close`，代码会顺手把整条 Steam
  连接也关掉（`steam.networkingSockets.closeConnection(connection, 0, '本地服务连接关闭', false)`），
  而当时只记了一句"连接断开"。⇒「游戏服务自己断了」和「网络断了」在日志里长得一模一样，
  这正是"传到 1.4 MB 就断"一直定不了位的原因之一。现在分成
  `LocalServiceClosed`（本机服务端口关了它）/ `LocalClientClosed`（浏览器或游戏自己关了）/
  `LocalTunnelAbort`（我们主动掐断，附带 `dropWhy`：本机积压超硬上限，或暂停 30 秒一个字节都没送出去）。
- 同一条连接只报一次结束（`firstGone`），避免本地 socket 与 Steam 两侧各报一行把日志淹掉。
- `resumeOrAbort` 的"毫无进展"起点改为 `Math.max(pausedAt, lastProgressAt, lastSendAt)`，
  修掉"暂停之前留下的陈旧时间戳导致刚到 30 秒就误杀一条其实在动的连接"这个隐患。
- 已知未解决：本机零延迟回环压测 8 MB **完全不触发**这个切断
  （`tools/steam-local-throughput.cjs 8 1` → 8.00 MB / 0.3s / 32768 KiB/s），
  所以它必须依赖真实高延迟链路，只能靠现场日志抓。

测试：507 → **508 例**，新增用例盯住"断开时必须报出谁关的、活了多久、搬了多少字节"。

## v0.12.6

网络（★ 找到并修掉了"每条连接只有 1 KB/s"的根因）
- **根因**：`network/steam-netconfig.cjs` 的默认值里 `sendRateMin: 0, sendRateMax: 0`，注释写的是
  "0 = 不限速，完全交给 Steam 自己的拥塞控制"。**这个理解是错的，而且方向正好相反。**
- 实测（`tools/steam-sendrate-probe.cjs` 与 `tools/steam-sendrate-scan-probe.cjs` 逐值扫描）：
  - 不下发这两项时，Steam 的出厂值是 `SendRateMin = SendRateMax = 262144`（256 KiB/s）；
  - 下发 `0` 会被 Valve 的 `SNP_ClampSendRate()` 夹成 **1024 B/s**（硬下限就是 1024：`-1`、`0`、`512`、`1023` 全部读回 1024）；
  - 同一个函数里还有一句 `if (nMin == nMax)`：**min 等于 max 时 Steam 会直接关掉带宽估计**，
    把发送速率钉死在该值上。而配置里"两者必须一致"的逻辑保证了 min 永远等于 max ⇒
    **0/0 等于把每条 Steam 连接钉死在 1 KiB/s。**
- 现场读数与这个数字严丝合缝：隧道实测 **0.9 KiB/s**；吞吐随连接数**严格线性**增长
  （1/4/12 条 → 0.9 / 3.1 / 8.5 KiB/s，即每条各自 1 KiB/s）；同一条链路 ping 只有 23ms、
  丢包 0%、Steam 自己估计可用带宽 256 KB/s —— 全都指向"不是链路的问题，是被钉住了"。
- 改法：默认值从 `0` 改成 **`null`（不下发）**，保留 Steam 出厂值 256 KiB/s。
  - 不改成 `262144`：那依然是显式钉死（照样关掉带宽估计），只是这次钉得高一点。
  - 确实要手动定速时才用 `SHL_STEAM_SEND_RATE`，并且要接受"钉死、关掉拥塞控制"这个语义。
  - 新增一条提醒：该值 ≤ 1024 时会在报告里点名"会被夹到 1024 且会关掉带宽估计"。
- 顺带更正三处基于错误理解的测试断言（原来写着"下限必须是 0""上限必须是 0，交给 Steam 自己的拥塞控制"）。
- 自查办法：`node tools/steam-netconfig-probe.cjs`，输出里应当是 `SendRateMin = （不下发）`、
  `SendRateMax = （不下发）`，且"下发结果：7 项成功"、没有任何"没有生效"。

## v0.12.5

界面（线路档位终于不用再靠 .cmd 设环境变量了）
- 以前换 Steam 线路档位只能在启动前 `set SHL_STEAM_TRANSPORT=...`，而本程序有**单实例锁**：
  旧进程没退干净时新进程会静默自杀（`electron/main.cjs` 记「另一个实例已在运行，本次启动退出」），
  环境变量根本没被读到 —— 现场就踩过这个坑，表现为"点了强制中继，软件里还显示强制直连"。
- 现在做成设置项，落在应用数据目录的 `settings.json`：
  - 界面「System」页新增 **02 Network route**，四选一：**跟随启动环境 / 自动选路 / 强制直连（默认）/ 强制中继**，
    下面直接给出"当前实际生效的档位"和它对应的 ICE / SDR 参数说明。
  - **保留"跟随启动环境"这一档**，是为了不悄悄推翻 `docs/STEAM-联机步骤.md` 里「先 set 再启动」那套排查办法；
    它是出厂默认值，所以老办法照旧能用。
  - 档位经 `session:start` 注入会话参数（`sanitizeSessionInput` 里由主进程统一盖写，
    **渲染进程无法左右 Steam 传输层配置**），一路走到 `createSteamHost` / `createSteamJoiner` 的 `netConfig`。
    每次会话启动都会重新下发，**改完重开会话即可生效，不必重启程序**。
  - 新增 IPC `settings:load` / `settings:save`，`app:info` 增加 `settingsPath`。
- 顺手修一个测试基建缺陷：`test/steam-mock.cjs` 的假 SDK 没有任何网络参数符号，
  于是"档位有没有真的下发"根本无从观察。现在它应答 `SetGlobalConfigValueInt32` / `GetConfigValue`
  并记录每一对 `(valueId, value)`。
- 新增测试：「线路档位：默认跟随启动环境，能改、能落盘，非法值退回默认」与
  「Steam 会话：线路档位从会话参数一路下发到 Steam 网络配置」（断言 104 号
  `P2P_Transport_ICE_Enable` 在强制中继下确实被设成 0）。

## v0.12.4

网络（修的是"大文件总是传到 28 KB 就断"）
- 修一个把**慢连接误判成死连接**的看门狗缺陷：`network/steam-adapter.cjs` 的 `flushPeerOut` 只要有**任何一片**
  没发出去就返回 `-1`（这是对的，剩下的要留给泵重试），但 `peer.lastSendAt` **只在整块发完时才更新**。
  背压期间 Steam 发送缓冲长期是满的，几乎每次 flush 都只能确认头一片，于是：
  - `peer.out` 涨到 1 MiB 触发背压，本地 socket 被 `pause()`；
  - `resumeOrAbort` 里判定"可以恢复"的条件 `written > 0` 永远不成立，积压又降不到 128 KiB 低水位 ⇒ **暂停的 socket 永远醒不过来**；
  - `resumeOrAbort` 判"空闲"用的 `peer.lastSendAt` 冻在最后一次**整块发完**的时刻 ⇒ **满 30 秒必然把连接掐掉**。
  三条叠在一起：**任何超过 1 MiB 的传输，注定在最后一次完整发送后 30 秒被自己杀死。**
- 现场读数完全对得上：每条连接都恰好送到 28672 字节（正文 28322 + 请求头约 350，**正好 7 × 4096**）就断，
  耗时 31.7 / 34.2 / 32.5 / 34.2 / 38.3 秒，五轮全在同一字节数上断。
- 改法：`flushPeerOut` 只要确认了**前缀**就记 `peer.lastProgressAt = Date.now()`；
  `resumeOrAbort` 判空闲改成 `peer.lastProgressAt || peer.lastSendAt || peer.pausedAt`。
- **故意没有改成"有进展就 resume"**：积压还高时必须保持暂停，否则会一路读到 8 MiB 硬上限被 `destroy`，那是更糟的结局。
- 效果：慢速链路上最坏情况是**慢**，不会再变成莫名其妙的断流。
- 新增两个回归测试：「还在往外吐字节的慢连接不能掐断（哪怕 lastSendAt 很旧）」与
  「只确认了前缀也要记成"有进展"，否则慢速传输会被看门狗误杀」。

已知限制（不是本版能修的）
- 单条 Steam 连接的吞吐可能被**直连路径**限制得很低（现场见过 4096 字节/3.1 秒）。
  实测同一份代码在本机自连能跑 16 MB/s，说明瓶颈不在转发代码；遇到这种情况请用
  `改线路-1-自动选路.cmd` / `改线路-2-强制中继.cmd` 换路径再试。

测试
- 42 个测试文件 505 例

## v0.12.3

自检
- 修「联机自检」点一下就报"自检本身出错"：`electron/main.cjs` 里 `lobby:selftest` 的
  "加入者隧道已经在跑"这一支引用了只存在于另一个分支的局部量，抛 `ReferenceError: e3 is not defined`。
  偏偏这一支正是加入者的常态 —— 也就是自检最该有用的时候它必然崩。
- 自检出错不再吞掉结果：以前 `ok:false` 时界面把整份检查项全丢掉，只剩一行"自检失败：…"。
  现在出错也会把出错前已经拿到的检查项全部渲染出来，并在末尾补一条标明哪一步没查完。
- 新增回归测试：起一个真实会话再跑自检，断言报告完整、检查项 ≥4，且不含 `is not defined` 一类字样。

其他
- 订正 `network/steam-adapter.cjs` 里一句会误导人的陈旧注释（分片默认值是 4KB，不是 64KB）。

测试
- 42 个测试文件 503 例

## v0.12.2

网络（修的是"几 MB 的大文件传到一半必断"）
- 修一个把 Steam 可靠流戳出洞的缺陷：`network/steam-adapter.cjs` 的 `flushPeerOut` 原先**先清空发送队列、再看发送结果**，
  `sendMessage` 失败时整块数据已经不在队列里，调用方只把它计进 `stats.dropped` 就完事。
  可靠通道一旦少一段字节，对端（浏览器/游戏）就永远等不到那几个字节，几秒后连接被掐断。
- 实测症状：3.14 MiB 的图集 0/3 成功，每次都在 7.4 到 16.5 秒之间断流；
  同一个文件按 384 KiB 分片请求却 9/9 成功 —— 典型的"缓冲满了就丢数据"，不是带宽不够。
- 改成**先确认再出队**：`sendChunk` 返回的 `bytes` 是已进 Steam 发送缓冲的前缀长度，只丢这一段，
  剩下的留在队列里由泵重试。不整块重发是因为前面的片已经发出去了，重发会让对端字节流多出一段（比少一段更难查）。
- 补上背压：发送失败时暂停读本地 socket（积压到 1 MiB 触发，降到 128 KiB 恢复），
  而不是"读进来再丢掉"。积压涨到 8 MiB 说明这条连接已经坏了，主动断开让客户端重连，比让它永远挂着强。
- 同类问题一并修掉：`flushPeerOutSoon` 原先整个丢掉返回值；连接刚建立时补发预连接队列失败会直接丢包；
  预连接积压超过 256 块时静默丢掉最早一块。
- 新增 `stats.sendStalls` 计数，把"暂时发不出去、等重试"与真正的丢弃（`stats.dropped`）分开。
- 版本号统一：`electron/main.cjs` 的 `APP_VERSION` 一直停在 `0.12.0`，导致 0.12.1 的包对外仍自称 0.12.0
  （大厅的版本比对也看这个值），现已跟随 `package.json` 一起改。

测试
- 43 个测试文件 497 例

## v0.12.1

网络（吞吐）
- 去掉 `P2P_SendRateMin` / `P2P_SendRateMax` 固定的 4 MB/s 钳制，改为 0（不限制），交给 Steam 自己的拥塞控制。
  把最小发送速率钉在 4 MB/s，在这种高丢包的中继链路上会持续过冲、加重丢包与重传，
  实测有效吞吐只有 50 到 270 KiB/s。

测试
- 43 个测试文件 492 例

## v0.12.0

界面
- 空间化桌面重构：三维档案阵列背景、浮动玻璃模块、底部编号导航、底部系统状态条
- 七个页面共用同一层三维空间，切页只换信息模块，背景与玻璃层不重建
- 外壳按 1600x900 设计尺寸等比缩放，窗口大小变化时逻辑视口不变
- 去掉原生标题栏，右上角自绘最小化 / 最大化 / 全屏 / 关闭，F11 接管全屏
- 三维背景改成真开关：关闭时销毁几何、材质、环境贴图与渲染器并交还 WebGL 上下文；最小化可延迟释放
- 修窄面板里读数被推出面板外、首页文字贴边两处版式问题

网络
- 新增 Provider 契约（start/stop/send/getStats/getCapabilities + 状态机 + 能力声明）
- 现有 TCP/UDP 中继与 Steam 内核包装成 Provider，会话层不再直接依赖内核
- 新增统一统计：镜像内核计数，或自行计数，字段名一致
- 新增质量测量：RTT / 抖动 / 丢包，没有样本时返回"未测量"而不是 0
- Steam：中继网络与 POP 延迟诊断；发送改走 sendMessage + 4KB 分片 + 关 Nagle
- 新增路径评分（延迟/丢包/抖动/可靠性加权，缺项不参与计分）
- 新增 RouteManager：阈值、滞回、最小观察窗、冷却，四项防抖；切换标注为重建传输
- 新增直连 UDP 相关：STUN、NAT-PMP、UPnP IGD、双向打洞状态机、DirectUDPProvider
- 新增 Stronghold Relay：服务端（口令入会、会话内转发、限速、包上限、空闲逐出）与客户端
- 中继服务端已实现并本机端到端跑通，但尚未部署公网实例
- 新增线路报告：按连接信息里的中继 POP 是否非零判定走的是 Steam 中继还是直连
- 会话页显示 Current route / Remote POP / Relay POP / Ping / Remote address，Steam RX 与 Raw socket RX 对照
- 新增 tools/net-bench.cjs，测直连 TCP、Stronghold Relay、Steam SDR 三条链路的吞吐与分片开销账
- 实测本机加密中继 80 到 119 MB/s；Steam SDR 需要第二台机器与第二个账号，标注 NOT MEASURED

界面（NETWORK 页）
- 新增 RELAY SELF-TEST：本机起中继服务端与两个客户端，实测 RTT/抖动/丢包并显示
- 候选路径按真实清单渲染：已测量显示分数与理由，未测量显示原因
- 新增路由诊断块：状态、当前路径、排名、策略、本次决策与原因、最近日志

打包
- 新增 full 与 lite 双版本：dist:full / dist:lite / dist:both
- 精简版把 three.min.js、gltf-loader.js、stage.js 换成空壳并排除 GLB，界面只保留 CSS 动效与玻璃层

测试
- 40 个测试文件 405 例；新增部分全部使用真实回环端口与真实数据往返

## v0.11.0

界面
- 配色换成暖纸 / 暖黑 / 琥珀，旧的蓝色全部移除
- 亮暗两套主题，默认亮色，右上角可切换并记住选择
- 字体换成 MiSans 子集（3 字重、117 个文件、2.5 MB）+ Inter + IBM Plex Mono
- 设计系统拆成 8 个 CSS：design-tokens / theme / typography / layout / motion / base / components / views
- 六页改成「编号 + 步骤 + 读数」结构，诊断类控件收进 ADVANCED 折叠
- 会话页改成 01 TARGET / 02 PARAMETERS / 03 CONTROL
- 档案行操作从三个减到两个，删除移进配置编辑器
- 遥测改成大号读数，速率柱加最新样本游标
- 新增启动序列：6 步检查真实环境后进入主界面，可点击跳过
- 新增背景运动、玻璃层、指针视差、页面转场、数字滚动等动效，跟随系统「减少动态效果」
- 新增 NETWORK 页路径图：实线为在用路径，虚线为备用路径

网络
- 无改动

修复
- 提示框、错误框、邀请横幅因 CSS 覆盖 `hidden` 而空显示
- 适配器状态谎报：以前有任何会话就把四个都标成运行中
- 命令控件的琥珀下划线铺满整个元素（暗色下 OPEN 变实心块）
- 启动序列状态行停在第一步

其他
- 新增开发工具：`--capture-matrix`（分辨率矩阵）、`--capture-motion`（像素差分）、`--capture-probe`、`--capture-style`、`--capture-steam`
- 测试 140 → 158 例

## v0.10.0

视觉
- 重建设计系统与六个页面：服务库改为索引列表，会话页改为控制台，新增网络参数、适配器、好友与大厅页
- 内置 Inter 与 IBM Plex Mono 字体子集，中文回退系统字体

Steam
- 新增大厅管理器：创建大厅、写入房主 SteamID 与端口、一键邀请、读取房主信息
- 新增好友页：好友列表、邀请按钮、邀请横幅、按大厅 ID 加入
- 忽略 Steam 偶尔派发的空加入回调

网络
- 空闲超时、连接超时、最大连接数可在界面配置并透传给中继
- 会话快照新增速率采样，界面据此画真实速率柱状

修复
- `hidden` 属性被 CSS 覆盖导致空框显示
- 适配器状态谎报：只有真正在用的适配器才是 running

## v0.9.1

修复
- TCP 中继首批数据丢失：统计用的 data 监听在 pipe 之前挂上，连接后的头几个字节被吃掉

其他
- CI 补 Node 22 / 24 矩阵与日志上传

## v0.9.0

⚠️ 风险提示
- 用 Steam 通道联机属于风险行为，AppID 480 是 Valve 的测试 App，可能被判定滥用。请用小号。

新增
- 端口配置库、TCP / UDP 中继、会话口令加密、Steam P2P 隧道、连接配方、邀请码

已知限制
- 跨两台机器的真实数据往返未在本机实测
- Steam 通道自动化测试使用注入的假 SDK

许可
- GPL-3.0-or-later，发行包不含 Valve 的 Steamworks SDK
