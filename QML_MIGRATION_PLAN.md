# Stronghold Link 0.14.4 —— QML 前端迁移方案

本文件回答四个问题：**为什么迁**、**迁成什么样**、**怎么迁**、**怎么算迁完**。
所有数字都是本机实测，测量方法写在 `qml-qa/QML_MEMORY_AUDIT.md` 与 `QML_QA_REPORT.md` 里。

基线：仓库 `Stronghold-Link/source`，分支 `qml-migration`，代码基线**严格回到 v0.14.4 标签**
（0.14.5 / 0.14.6 的传输层改动已全部撤销，见 `CHANGELOG.md` 的「0.14.4 基线重建」一节）。

---

## 一、为什么迁

现版本的前端是 Electron + HTML/CSS/Chromium：一个把 Chromium 塞进内网穿透工具里的渲染层。
它带来的问题是结构性的，而不是"能不能优化"的问题：

1. **体积与内存不成比例。** 便携包里的 `Stronghold Link.exe` 单文件 210 MB，`resources/app.asar`
   另外 12.7 MB。本机实测 Electron 0.14.4 起来后是 **5 个进程、进程树 Working Set 约 805 MiB**
   （同口径下 Qt 版约 318 MiB）。
2. **渲染层与业务层纠缠。** `electron/main.cjs` 同时干三件事：建窗口、当 IPC 宿主、装业务逻辑。
   想换界面就得动业务代码，想测业务就得起 Electron。
3. **`app.asar` 是不可持续维护的交付物。** 打过包的 asar 只能当"取证材料"，不能当源码仓库改。
4. **旧界面有 7 个视图**（Home / Library / Session / Network / Adapters / Friends / Settings），
   其中四个是开发期的中间产物，维护成本高但对用户没有价值。

目标不是"换个画法"，而是把**表现层整体换掉**，并且让业务层从此与界面无关。

---

## 二、迁成什么样（目标架构）

三层，进程边界清楚：

```
┌─────────────────────────────────────────────┐
│ StrongholdLink.exe（Qt 6.8.3 / Qt Quick）    │  ← 只有三个顶层页
│  main.cpp            进程入口、命令行开关      │
│  backendbridge.{h,cpp}  唯一的 C++ 桥         │
│  qml/                界面（Main + 12 组件 + 3 页）│
└──────────────────┬──────────────────────────┘
                   │ stdin/stdout：JSON Lines（协议独占 stdout）
┌──────────────────▼──────────────────────────┐
│ node stronghold-backend.cjs（Electron-free）  │
│  backend/business.cjs   从 electron/main.cjs 摘出 │
│  network/*.cjs（33 个）  网络栈原样保留          │
└─────────────────────────────────────────────┘
```

### 硬约束（不可协商）

| 约束 | 具体要求 |
| --- | --- |
| 界面技术 | 原生 Qt Quick/QML。**禁止** QtWebEngine / WebView / 任何内嵌页面 |
| 顶层页数 | **恰好三个**：`session`（会话）、`friends`（好友）、`setting`（设置）。旧版另外四个视图删除，**不留隐藏的兼容层** |
| 后端形态 | `stronghold-backend.cjs` 不含任何 Electron 依赖，通过 stdin/stdout 说 JSON Lines |
| stdout 纯净 | `stdout` 只走协议帧。任何 `console.log`、横幅、进度条都不许出现（诊断走 stderr / 日志文件） |
| 无本地控制口 | 不许开"未认证的 localhost TCP/HTTP 控制端口" |
| 不执行 shell | QML 不许调 shell；C++ 桥只暴露白名单 `Q_INVOKABLE` 方法 |
| 路径与兼容 | 保留 `%APPDATA%\stronghold-link` 配置/日志路径与便携式 Steam DLL/SDK 解析；缺 `steam_api64.dll` 必须由 `diagnoseSteam()` 预检给出可读诊断，**绝不允许进程崩溃** |

### 协议契约（`backend/stronghold-backend.cjs`）

请求 / 响应 / 事件 / 错误四种帧，请求与响应靠 `id` 配对：

```jsonc
// 请求
{"type":"request","id":17,"method":"session.start","params":{ }}
// 成功响应
{"type":"response","id":17,"ok":true,"result":{ }}
// 事件（无 id，单向推送）
{"type":"event","name":"session.event","payload":{ }}
// 失败响应
{"type":"response","id":17,"ok":false,"error":{"code":"EPORTINUSE","message":"端口已被占用"}}
```

契约测试见 `test/backend-protocol.test.cjs`（id 配对、未知方法、错误传播、坏 JSON 行、超长行、
stdout 纯净性、后端崩溃、优雅退出）。

### 界面语言（参考 UI 复刻，不复刻"感觉"）

复刻的是参考项目 `the-masses-travels` 的**实际画法**，不是套一层相似配色：

- 色彩令牌：纸色 `#e9ecec` / `#eff1ef`，墨色 `#22282b`，次级 `#6c7679`，钴蓝 `#3a5bc2`，
  高亮蓝 `#2a3fff`，天蓝 `#4c92d4`
- 排版：标题用 Didone/Bodoni/Didot/Georgia 一类衬线，中文衬线用 Noto Serif SC，
  数字与状态用 Consolas/Cascadia Mono，操作按钮用 Bahnschrift/Segoe UI
- 图形语汇：细线分隔、页边刻度、十字准星、裁切角、圆环与环轨、构造网格、
  半调网点、错位双描边、纸张颗粒、拼贴
- **明确不要**：圆角卡片式 SaaS 堆叠、渐变发光、全屏模糊、默认 Material 观感
- 确定性：随机数用固定种子（`SketchRing.qml` / `SketchRule.qml` 内的确定性伪随机），
  **不许逐帧随机抖动**；页面隐藏或最小化时定时器与动画必须停

参考复刻的**法律边界**（详见 `ASSET_PROVENANCE.md` 第 5/6 条与 `THIRD_PARTY_NOTICES.txt`）：
参考项目在固定提交上没有 LICENSE，不能认定 MIT；其 `public/assets/game/` 里是《明日方舟》提取物，
上游明确禁止再分发。所以**只重写视觉规则，不引入任何字节** —— 没有复制它的 TypeScript 源码、
图片、字体或模型，分发目录里也不含其派生物。

---

## 三、怎么迁（阶段与验收）

### 阶段 0：锁基线、收材料

- 代码基线回到 **v0.14.4 标签**（撤销 0.14.5 / 0.14.6），把 0.14.5/0.14.6 的实现另存到
  `D:\shl\_ref\` 仅供查阅，不参与构建。
- 固定参考项目提交 `7ea40aea1ff28f84c20d58eae5f30497b093517d`。
- 记录测试基线：`npm test` = **tests 822 / pass 821 / fail 0 / skipped 1**。

### 阶段 1：修传输层 P1（A-01）

干道重挂会吞掉出站队列里的字节：断开时只把**流对象**搬去寄存，而 `network/egress-queue.cjs`
里每条流自己的 FIFO 还压着"还没交给 Steam"的帧，那些字节随旧干道一起消失，流却被新干道原地复活，
于是对端看到的可靠字节流中间少了一截（表现为 Minecraft 报 `DataFormatException: unknown compression
method` 然后掉线）。

修法：断开时先 `egress.takePending(peer, peer.streams.keys())` 认领出来挂到流对象上带走，
重挂后用 `retagFrame(frame, streamId, generation)` 换新世代号补发，次序在 OPEN 之后、parkQueue 之前。
房主侧（`parkPeerStreams` / `adoptOrphanStreams`）与加入者侧（`parkTrunkStreams` /
`resumeOrphanStreams`）对称实现，两条回归用例都做过 fail-first（撤掉修复就红）。

**没有**恢复 0.14.6 的 Ack/Resume 与流级字节账本 —— 那批是在没有真机双机验收的前提下叠上去的。

### 阶段 2：拆后端，钉协议契约

把业务逻辑从 `electron/main.cjs` 摘到 `backend/business.cjs`，加 `backend/stronghold-backend.cjs`
作为 Electron-free 入口；契约测试见 `test/backend-protocol.test.cjs`。

### 阶段 3：QML 设计系统

先立 `qml/theme.js`（色彩/字号/间距令牌）与 `qml/Components/` 下的原语（`Plate`、`PaperPlate`、
`SketchRing`、`SketchRule`、`StatusReadout`、`PersonPlate`、`Meter`、`PlateButton`、`FieldInput`、
`ChoiceRow`、`NavBar`、`Constellation`），**先出三个静态布局，再上真实表单**。

### 阶段 4：三页接线

只有三个顶层页，每页只接**已验证**的桥方法。未实现的控件必须**可见地禁用**，
不许假装成功（这是验收会逐条查的项目）。

### 阶段 5：删旧渲染层并打包 Windows x64 便携版

删掉旧渲染层，打包产物里不许带 Steam SDK 开发文件与调试探针；`LICENSES/`、
`THIRD_PARTY_NOTICES.txt`、`ASSET_PROVENANCE.md`、`asset-provenance.json` 必须复制进
**分发目录内部**，并且 `node tools/verify-asset-provenance.cjs` 通过。

### 阶段 6：验收

含真机双机 P2P、10 分钟 soak、与 Minecraft / echo 客户端对账字节账本。

---

## 四、内存门槛：现状与结论

任务书写的是硬门槛 **进程树 Working Set ≤ 100 MiB**（104,857,600 字节），
口径是 **Qt 主进程 + Node 后端子进程**（不含 conhost）。

**实测：达不到。** 可见窗口口径下（隐藏窗口不渲染，测出来的数偏小约 76 MiB，所以必须可见）：

| 场景 | 进程树 WS max | 末次分解 |
| --- | --- | --- |
| 冷启动 ×5 | 320.5 MiB | Qt ≈ 209.5 + node ≈ 95 + conhost 7.3 |
| 60 秒空闲 | 317.9 MiB | Qt 198.5 + node 95.0 + conhost 7.3 |
| 页面往返 330 次 | 363.7 MiB | 页面往返是峰值场景 |
| 会话开始/停止 | 318.0 MiB | 会话本身只涨 1 MiB 级 |

校准阶梯说明**这不是"前端写得太重"**：空壳 `Window + 一行 Text` 是 36.3 MiB，
三页清空成空 `Item` 是 124.5 MiB，完整界面 123.1~133.7 MiB（隐藏口径）。
也就是说外壳与运行期本身就吃掉 87 MiB 以上，**删前端渲染层不可能压到 100 MiB 以下**。

更根本的地板：裸 Node 常驻进程本身就 49.0 MiB，Qt 空窗 36.3 MiB —— 两项相加已经 85 MiB，
再算上 Steam FFI（`lobby.friends` 拉 42 个好友一次涨 29 MiB，且这 29 MiB 在原生侧、不是泄漏）
就必然越线。

已排除的方向（都实测过，**无收益**）：渲染后端（default / software / angle 三者 241.6 / 241.1 / 241.2 MiB）、
Canvas 目标（`Canvas.Image`）、画布尺寸（原样/8×8 都一样）、页面（三页单开都是 133.8~134.3 MiB）、
字体（只用系统字体，没加载字体文件）。

**结论：Qt 路线相对 Electron 省约 2.5 倍（318 vs 805 MiB），方向站得住；但 100 MiB 门槛在
当前架构（Qt + 独立 Node 后端 + Steam FFI）下达不到。** 可做的优化按实测约能省 43 MiB
（按需加载 Steam −29、去掉 conhost 窗口 −7.3、延迟适配器 −6.7），即约 195 MiB，仍远超门槛。
要真正达标只有改变架构（例如把网络栈也搬进 C++、或后端与界面同进程）——那与任务书
「阶段 1 不重写 36 个网络模块」的要求冲突，属于**需要重新决策的范围**，不在本方案内擅自决定。

---

## 五、交付物

| 文件 | 作用 |
| --- | --- |
| `QML_MIGRATION_PLAN.md` | 本文件 |
| `AUDIT_FINDINGS.md` | 迁移前代码审计（13 项发现，含 A-01/A-02 两个 P1） |
| `QML_QA_REPORT.md` | 验收报告：场景、数字、原始数据位置、未验证项 |
| `qml-qa/QML_MEMORY_AUDIT.md` | 内存归因专报（逐进程总账与已排除项） |
| `ASSET_PROVENANCE.md` / `asset-provenance.json` | 素材来源台账 |
| `LICENSES/`、`THIRD_PARTY_NOTICES.txt` | 许可证全文与第三方声明 |
| `tools/verify-asset-provenance.cjs` | 打包守卫（已接进 `npm test`） |
