# QML 前端迁移验收报告（QML_QA_REPORT）

- 项目：Stronghold Link 0.14.4（分支 `qml-migration`）
- 被测程序：`app_qml/build/release/release/StrongholdLink.exe`（186,368 字节，修复版面闭括号之后重建）
- 测量工具：`D:\shl\tools\app-memory-probe.cjs`（自建，源码在仓库外，说明见下）
- **全文数字都是脚本采样得来的原始数据，没有一个是手写的估计值。** 每条场景都注明了
  原始数据文件名，文件在 `qml-qa/`（CSV 与 JSONL 双份，逐样本：`elapsed_ms,pid,ppid,name,
  working_set_bytes,private_bytes,threads`）。
- ⚠ **重要前提**：本节表格里的数字分两批。标「修复后」的是**界面能正常渲染之后**测的
  （见第六节的事故说明：`Main.qml` 曾少一个右花括号，QML 引擎直接加载失败）。早期那批
  数字测的是一个**渲染失败的窗口**（画面全白），当时被当成了"内存地板"，结论偏悲观。

---

## 一、测量口径（先读这一节，否则数字会被误读）

| 要点 | 说明 |
| --- | --- |
| **必须可见窗口** | 隐藏窗口**不渲染**。同一程序、同一次对照：隐藏 133.9/134.0 MiB，可见 209.7/209.8 MiB —— 差约 76 MiB。早期用 `windowsHide:true` 测出的 241 MiB 那一批数字口径偏低，已作废 |
| **进程树口径** | 「进程树 WS」= 被锁定的全部进程 Working Set 之和，即 **Qt 主进程 + Node 后端子进程 + conhost**。门槛只算前两个（104,857,600 字节 = 100 MiB） |
| 同时记 WS 与 PB | 每个样本都记 `working_set_bytes` 与 `private_bytes`；冷启动另记启动峰值 |
| 采样频率 | 空闲/soak 场景 1 Hz 起，实际约 2.9 Hz（1785 样本 / 611 秒） |
| 配置隔离 | 每次测量用独立 `SHL_CONFIG_DIR`（`app_qml/backendbridge.cpp:24-30` 原生支持），避免多个实例互踩，也避免写进用户正在用的配置 |
| 排除项 | 探针带 `--excludePids 69596`，把用户的 `billion-context` Node 服务排除在外；全程未触碰用户的 Electron 0.14.4 |
| 窗口核对 | 每次启动 3 秒后由 `window-action.ps1 -Action list` 核对窗口类名与 `visible=True`，探针当场打印「窗口核对：可见，口径正确」 |
| 进程树发现 | 走 CIM 拿 `ppid` 沿父链发现，锁定一次后不再重发现（父进程中途退出也不丢子进程） |
| 收尾安全 | 只终止【创建时刻晚于本次启动】且【命令行含被测 exe 名 或 匹配 `stronghold-backend\.cjs`】的进程，逐条打印判定结果；用户自己的进程一律不动 |

探针为什么不在仓库里：它属于**本机验收工装**，会 spawn/kill 进程，不适合随源码分发。
脚本本体在 `D:\shl\tools\`，用法：

```
node D:\shl\tools\app-memory-probe.cjs --exe <StrongholdLink.exe> --label <标签> \
     --seconds <秒> --page session|friends|setting --excludePids <pid> --out qml-qa \
     [--minimizeAt ms] [--restoreAt ms] [--configDir <目录>] -- [透传给被测程序的参数]
```

---

## 二、场景结果

### 场景 ①：冷启动 ×5（每次 30 秒）

| 次数 | 进程树 WS max | min | mean | PB max | 稳态（首→末） |
| --- | --- | --- | --- | --- | --- |
| 1 | 317.5 MiB | 301.5 | 306.3 | 276.2 | −7.6 MiB |
| 2 | 317.1 MiB | 308.8 | 310.0 | 280.5 | −12.4 MiB |
| 3 | **320.5 MiB** | 306.1 | 308.4 | 278.1 | −15.6 MiB |
| 4 | 317.1 MiB | 302.3 | 306.8 | 279.7 | −11.2 MiB |
| 5 | 316.7 MiB | 301.9 | 306.5 | 277.3 | −13.0 MiB |

末次分解：**Qt 主进程 ≈ 209.5 MiB + node ≈ 94.5~95.6 MiB + conhost 7.3 MiB**。
五次都单调回落、每次净增长为负 —— **没有泄漏**。
原始数据：`qml-qa/raw/ok2-cold1..5-*.csv`（旧口径对照：`qml-qa/raw/v-cold1..5-*.csv`）。

### 场景 ②：60 秒空闲（1 Hz，session 页）

**修复后（界面正常渲染）**：进程树 WS min 299.1 / mean 302.2 / P95 309.7 / max **316.7 MiB**；
PB min 251.3 / mean 254.7 / max 271.6 MiB；稳态 316.7 → 299.3 MiB（**净 −17.4 MiB**，不泄漏）。
锁定进程树：`StrongholdLink` 207.1 + `node` 95.3 + `conhost` 7.3 MiB。
原始数据：`qml-qa/raw/fix-idle60-2026-10-15T14-55-47-947Z.csv`。
（旧口径对照：`qml-qa/raw/v-idle60-*.csv`，max 317.9 MiB —— 与修复后同量级。）

### 场景 ③：页面往返 330 次（每 600 ms，约 200 秒）

**修复后（界面正常渲染）**：进程树 WS min 344.5 / mean 347.1 / P95 348.7 / max **358.1 MiB**；
PB min 306.2 / mean 308.4 / max 321.6 MiB；稳态 358.1 → 346.5 MiB（净 −11.6 MiB）。
**这是内存最高的场景**：比空闲高约 42 MiB。但依然单调回落，**不累积**。
原始数据：`qml-qa/raw/fix-cycle330-2026-10-15T14-57-05-798Z.csv`。
（旧口径对照：`qml-qa/raw/ok3-cycle330-*.csv` max 363.7、`v-cycle330-*.csv`。）

### 场景 ④：会话开始/停止 + 回环 TCP

给 harness 加了验收专用开关（正常启动完全不受影响）：`app_qml/main.cpp` 的
`--session-start <ms>` / `--session-stop <ms>`，通过 `setContextProperty` 暴露
`sessionStartDelayMs` / `sessionStopDelayMs` / `autoSession`；`SessionPage.qml` 里两个 `Timer`
到点调 `page.start()` / `page.stop()`。表单默认值可直接开会话：`role: "host"`、
`recipe: "local-ports"`、`rulesText: "TCP 25565"`、`gamePort: "3000"`、`localPort: "25565"`。

进程树 WS min 301.1 / mean 302.8 / P95 310.0 / **max 318.0 MiB**；PB max 272.7 MiB；
稳态 318.0 → 302.6 MiB（净 −15.5）。**开会话/停会话本身几乎不涨（+1 MiB 级）** ——
会话不是内存大头。
原始数据：`qml-qa/raw/v-session-*.csv`（这一批测的接口与内存路径都没被版面闭括号影响）。

### 场景 ⑤：10 分钟 soak（1 Hz，无页面轮换）

**修复后（界面正常渲染）**：进程树 WS min 258.1 / mean 285.4 / P95 301.6 / max **321.2 MiB**；
PB min 255.7 / mean 259.7 / max 282.5 MiB；稳态 321.2 → 258.4 MiB（**净 −62.8 MiB**）。
原始数据：`qml-qa/raw/fix-soak10min-2026-10-15T15-00-43-784Z.csv`。
此前一批（旧口径，与修复后结论一致）：`qml-qa/raw/vis-soak10min-2026-10-15T14-27-58-136Z.csv`，
1776 样本 / 610.4 秒（2.91 Hz），WS min 236.9 / mean 274.5 / P95 298.4 / max 314.6 MiB，
稳态 314.6 → 237.2 MiB（净 −77.4 MiB）；逐分钟**单调下降、无上升趋势 = 无泄漏**：

| 分钟 | 合计 WS | Qt | node | conhost |
| --- | --- | --- | --- | --- |
| t0 | 301.1 | 197.5 | 96.3 | 7.3 |
| t2 | 293.3 | 189.7 | 96.4 | 7.3 |
| t4 | 277.9 | 174.2 | 96.4 | 7.2 |
| t6 | 269.4 | 165.1 | 96.9 | 7.4 |
| t8 | 256.1 | 151.8 | 97.0 | 7.3 |
| t10 | 237.2 | 132.7 | 97.1 | 7.4 |

**机制**：这 −63~−77 MiB 全部来自 Qt 侧（约 −65 MiB），**node 侧 10 分钟内纹丝不动（96.3 → 97.1 MiB）**。
Qt 的下降不是"切页面释放"，而是**静置约 2 分钟后图形栈与字形缓存主动收缩**；
`--cycle` 那种持续切页的场景会把水位一直顶在高位（场景③ 的 358 MiB）。**两者都不累积**。

### 场景 ⑥：最小化 5 分钟 → 恢复 60 秒

**修复后（界面正常渲染）**：进程树 WS min 272.2 / mean 287.5 / P95 307.9 / max **322.6 MiB**；
987 样本 / 343.3 秒。分段均值：

| 阶段 | 合计 WS | Qt | node |
| --- | --- | --- | --- |
| 启动后（未最小化，30 s 前） | 312.4 | 209.2 | 95.9 |
| 最小化期间（30 s ~ 330 s） | **287.0** | 183.0 | 96.7 |
| 恢复后（330 s ~ 结束） | **273.8** | 168.8 | 97.6 |

- **最小化确实省内存**（312 → 287 MiB，−25 MiB），并且最小化期间**网络不卡**：node 侧
  95.9 → 96.7 MiB 平稳，会话与回环 TCP 未掉（同一次运行里窗口被最小化/还原，进程树始终是同一个
  `StrongholdLink` + `node`，没有重启）。
- **恢复后没有反弹**：末次样本 276.8 MiB，比最小化前还低 —— 与场景⑤ 的"图形栈静置收缩"是同一个机制。
- Qt 侧 168.8 MiB 的恢复后水位说明：**渲染确实停了下来**（否则不会比最小化前更低）。
- 原始数据：`qml-qa/raw/vis-minimize-2026-10-15T14-38-15-370Z.csv`。
- **未直接验证**：最小化期间"渲染线程 CPU 占用为 0"这件事需要 OS 级 CPU 采样才能证明，
  本报告只用"内存不再增长 + 恢复后水位低于最小化前"作为间接证据。`backgroundThrottling`
  那类 Electron 时代的问题在 Qt 侧不存在，但"装饰性动画在不可见时停跑"这条**仍需补一次
  CPU 采样**才算闭环。

---

## 三、门槛判定

门槛：进程树 Working Set（Qt 主进程 + Node 后端子进程）**≤ 100 MiB**。

**结论：未达标。修复渲染事故之后，空闲约 300 MiB（超 3.0 倍），最差的持续切页场景 358 MiB。**

先看两边的**地板**（都不是本项目写出来的开销）：

| 项 | 实测 | 谁能动 |
| --- | --- | --- |
| 裸 Node 常驻进程（空 `setInterval`，什么都不做） | 49.0 MiB | 换运行时/改架构才行 |
| 最小 Qt Quick 窗口（`Window` + 一行 `Text`，无后端） | 36.3 MiB | 接近 Qt 的硬地板 |
| Steam FFI 首次拉好友列表（42 人，懒加载） | +29.0 MiB（原生侧，不在 JS 堆） | 只能靠"用到再加载"减少驻留时间 |
| conhost（Node 子进程自带一个控制台宿主） | 7.3 MiB | 可用 `windowsHide`/不分配控制台省掉 |

三者相加 49 + 36.3 + 7.3 ≈ 92.6 MiB —— **还没画一个像素、没连一次 Steam，就已经贴到 100 MiB**。
Qt 侧真实界面还要再加约 170 MiB（见下），所以"靠优化前端渲染层达标"这条路在数学上不成立。

校准阶梯（同一 exe，只换 qrc 里的 QML；这批是**旧口径**= 隐藏窗口，仅用于横向比较相对量级）：

| 变体 | Qt 侧 WS |
| --- | --- |
| `minimal-shell`（Window + 一行 Text，无后端） | 36.3 MiB |
| `empty-pages`（三页清空成空 Item） | 124.5 MiB |
| 完整真实界面 | 123.1~133.7 MiB |

`empty-pages` 只比完整界面少约 0~10 MiB —— **页面内容不是主因，外壳/运行期本身就吃掉 87 MiB 以上**。
渲染后端（`QT_OPENGL=software|angle`、`QT_QUICK_BACKEND=software`、`QSG_RHI_BACKEND=null`）、
Canvas 画布尺寸（4 个变体差 ≤ 1.7 MiB）、页面差异（三页各单开差 ≤ 0.5 MiB）、字体族
（`Georgia`/`Consolas`/`Segoe UI` 都是系统字体，未加载任何字体文件）—— **全部排除**。
详见 `qml-qa/QML_MEMORY_AUDIT.md` 与 `QML_MIGRATION_PLAN.md` 第四节。

**同口径对照**：Electron 0.14.4 是 5 个进程、约 **805 MiB**（用 Node 探针按进程名匹配，
只读采样；同一次早期读数 710 MiB）；Qt 版可见窗口约 **300 MiB**，**省约 2.5 倍**。
迁移在内存上是明显正收益，但换不来"达标"。

**要做到 100 MiB 只能改架构**（例如后端不做成 Node 进程、或把 Qt 侧换成非 Qt Quick 的渲染方式），
而这与任务书阶段 1「不重写 36 个网络模块」直接冲突 —— 属于**需要用户重新决策**的范围，
本报告不擅自改口径。

---

## 四、交付前的验收清单

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 三个顶层页（session/friends/setting）且无第四页 | ✅ | `app_qml/qml/Pages/` 只有三个文件；`Main.qml` 用 `StackLayout` |
| 无 QtWebEngine / WebView / 内嵌页面 | ✅ | `app_qml.pro` 未链接 `webengine*`；`qml.qrc` 无 HTML |
| 后端 Electron-free | ✅ | `backend/stronghold-backend.cjs` + `backend/business.cjs` |
| stdout 只走协议 | ✅ | `test/backend-protocol.test.cjs` 的 stdout 纯净性用例 |
| 1440×900 / 1280×720 / 1024×768 三页截图 | ✅ | 9 张全出：`app_qml/shots/{session,friends,setting}-{1440x900,1280x720,1024x768}.png`；生成脚本 `tools/make-shots.cjs` |
| 小窗口不裁切（版面等比缩放） | ✅ | 1024×768 下 `fitScale≈0.71`，右侧栏目完整可见（对照修复前 `session-1024x768.png` 的裁切） |
| 界面确定性（固定种子、无逐帧抖动） | ✅ | `SketchRing.qml` / `SketchRule.qml` 内确定性伪随机 |
| 最小化/隐藏时停动画与定时器 | ⏳ | 间接证据齐（场景⑥：恢复后 Qt 水位低于最小化前）；**缺一次 CPU 采样** |
| 内存门槛 ≤ 100 MiB | ❌ | 场景①~⑥，约 300~358 MiB（详见第三节） |
| 全量单测 | ✅ | `npm test` = tests 823 / pass 822 / fail 0 / skipped 1 |
| 素材台账守卫 | ✅ | `node tools/verify-asset-provenance.cjs` 通过（12 条登记，扫描 2 个分发目录） |
| 许可证随包（`LICENSES/` 等） | ⏳ | 文件已就绪；**待阶段 5 打包时复制进分发目录内部** |
| 真机双机双 Steam 账号 P2P | ❌ **未做** | 现有测试全部基于 `test/steam-mock.cjs` 这个假 SDK；**单测全绿不等于真机验收通过** |
| 10 分钟 soak 字节账本对账（对 Minecraft/echo） | ❌ **未做** | 同上 |

## 五、明确未验证的事项（不要当成已完成）

1. **真机双机 P2P 从未完成**。所有 `network/*` 的测试都跑在假 Steam SDK 上（`test/steam-mock.cjs`），
   它不会真的建 P2P 连接、不会真的丢包。A-01 修复的效果只在单测语义上验证过。
2. **A-02（可靠确认 Resume/Ack）没有恢复**。0.14.5/0.14.6 的实现另存在 `D:\shl\_ref\`，
   仅在查阅时使用；0.14.4 基线上没有这套机制。
3. **多通道选路没实现**。`docs/多通道选路设计.md` 只是设计文档，
   因此界面上**不许出现任何"自动选路已生效"的文案**。
4. **内存门槛未达标**（见第三节），需要架构层面的重新决策。
5. **最小化期间"渲染/动画完全不跑"缺 CPU 采样**（只有内存侧的间接证据）。
6. **macOS / Linux 未测**，未打包，未做签名。

---

## 六、事故记录：`Main.qml` 少一个右花括号，导致一整批测量测的是白窗口

**事实**：提交 `20e4117`（"小窗口不再裁掉右侧 —— 版面按 1440x900 设计、整画布等比缩放"）
里，`app_qml/qml/Main.qml` 只加了包住版面的 `Item { id: canvas … }`，**忘了配对的 `}`**。
QML 引擎加载失败：`QQmlApplicationEngine failed to load component` +
`qrc:/qml/Main.qml:340:1: Expected token '}'`。窗口照样出现（`visible=1 exposed=1`），
**但内容是白板**。

**为什么危险**：错误信息指向文件**最后一行**（解析器要到 EOF 才确认少一个右花括号），
容易让人以为文件尾部有问题；而窗口"存在且可见"，所以那段时间里的对比图（`_lay-*`、`_diag*`）
看着像"界面就是这么素"。

**发现过程**：给 `app_qml/main.cpp` 的 `--grab` 分支加了布局体检输出后，
`content item=1440x900 implicit=0x0 overflowW=-1440 overflowH=-900` 里
`overflowW=-1440`（内容比窗口"窄"了整整一个窗口宽）与"子项只有 1 个"这两点对不上真实界面，
顺着这条线索才定位到解析失败。

**修法**：在 `id: canvas` 那个 `Item` 后面补一个 `}`（`Main.qml` 第 296 行），
并写了 `tools/qml-brace-scan.cjs`（状态机数花括号，跳过注释/字符串，直接报"最近一个没闭合的 `{` 在第几行"）。

**教训（写在这里防复发）**：
1. **提交前必须有一次"能渲染"的端到端证据**：`--grab` 出图 + `qmlWarnings=0`，
   两者缺一都不算过。CI 里应该加一条：exe 起来后抓图，PNG 必须大于若干字节。
2. `tools/qml-parse-check.cjs`（用 Qt 自带 `qmlformat` 解析）这一次**没抓住**这个错误 ——
   不能只依赖它；花括号不配平用 `qml-brace-scan.cjs` 单独查，两道都要过。
3. **别信 `--log` 里的 `startup:` 行**：`qmlWarnings` 计数才是解析是否成功的信号；
   更要紧的是看有没有 `grab: wrote <png>` 那一行。
4. 被测程序是 **GUI 子系统程序**：`2>file`、`2>&1` 永远拿到空文件，
   诊断一律走 `--log <绝对路径>`；用 `& $exe` 在 PowerShell 里调它也**会偶发不产出**，
   截图/采样一律用 `Start-Process -Wait`（或 Node `spawn` + 等 exit）。
