# QML 前端内存实测报告（Qt Quick 主进程 + Node 后端子进程）

> 本报告的所有数字都来自本机实测，原始样本在 `qml-qa/raw/*.csv` 与 `qml-qa/raw/*.jsonl`，
> 采样脚本 `tools/sample-tree.cjs`（每秒一次，逐进程记录 Working Set / Private Bytes）。
> 没有任何手写或推测的数字。

## 1. 结论先说

**按任务书 §内存门槛（进程树 Working Set ≤ 100 MiB）判定：当前架构不达标，实测约 241 MiB，超出约 2.4 倍。**

这不是"还没优化"的程度问题，而是结构性差距：把界面全部掏空、只留一个空窗口，
Qt 进程本身仍有 36 MiB；只留三个空页面、没有任何 Canvas 和文本，就已经 124.5 MiB。
也就是说 **100 MiB 的总预算里，光是"Qt Quick 运行一个窗口"这一点就已经吃掉了可行空间**，
再把 Node 后端（裸 Node 常驻 49 MiB）加进来，数学上不可能收敛到 100 MiB。

可行的替代说法是"比 Electron 0.14.4 明显更省"，这需要单独量 Electron 版做对照（见 §6）。

## 2. 实测总账（应用完整启动，1440×900，空闲稳定态）

| 进程 | Working Set | Private Bytes | 说明 |
|---|---:|---:|---|
| `StrongholdLink.exe`（Qt Quick 主进程） | 133.5–135.1 MiB | 约 106 MiB | 只渲染界面，不含任何网络逻辑 |
| `node.exe`（后端） | 94.8–100.0 MiB | 约 51 MiB | 含 Steamworks FFI 与 42 个好友 |
| `conhost.exe`（后端控制台宿主） | 7.3 MiB | — | Node 子进程带来的附带进程 |
| **进程树合计** | **约 237–242 MiB** | **约 161 MiB** | 门槛 100 MiB → 超标 |

数据来源：`qml-qa/raw/v-current-*.csv`、`after-canvas-fix-*.csv`、`probe-tree-*.csv`。

## 3. Qt 侧的归因（同一可执行文件，只替换 QML）

用同一个 `StrongholdLink.exe`，只换打进 qrc 的 QML，逐级加内容，得到下表：

| 变体 | Qt 进程 WS | 相对增量 | 含义 |
|---|---:|---:|---|
| `st-minimal-shell`：Window + 一行 Text | 36.3 MiB | 基线 | Qt Quick 启动一个窗口的真实底线 |
| `st-real`：完整三页真实界面 | 123.1–135.1 MiB | **+87 ~ +99 MiB** | 界面内容的实际代价 |

在"只留空页面"（三个页面清空成空 `Item`，组件与画布一律不创建）时测得 **124.5 MiB**，
与完整界面几乎相同 —— 说明这 87 MiB 以上**不是页面内容造成的**，而是外壳/运行期本身。

### 3.1 已经排除的因素（都做过对照实验，均为实测）

| 假设 | 实验 | 结果 |
|---|---|---|
| Canvas 画布尺寸太大（`Plate` 填满父级 ×15） | 4 个变体：原样 / 8×8 画布 / 收窄贴合 / 加 `renderTarget: Canvas.Image` | Qt 均为 133.9 / 135.1 / 135.6 / 134.9 MiB —— **无差别** |
| GPU 驱动或交换链占内存 | `QT_OPENGL=software`、`QT_OPENGL=angle`、`QT_QUICK_BACKEND=software`、`QSG_RHI_BACKEND=null` | 133.6 / 133.4 / 133.5 MiB —— **无差别** |
| 哪个页面特别吃内存 | `--page session|friends|setting` 分别单开 | 133.8 / 134.3 / 133.8 MiB —— **无差别** |
| 自定义字体加载 | 检查 `main.cpp` 与 `theme.js` | 未调用 `addApplicationFont`，只用系统字体 Georgia/Consolas/Segoe UI —— **不是字体** |

**因此：`renderTarget: Canvas.Image` 这一改动无效，不应作为优化项写进结论。**
（改动本身无害，但没有任何内存收益，已从真实源码回滚语义上保留为"未采用"。）

## 4. Node 后端的归因（按 JSON Lines 协议逐步驱动，实测）

用 `tools/backend-memory-probe.cjs` 直接拉起 `backend/stronghold-backend.cjs`，
每步之间读后端自报的 `process.memoryUsage()` 与 Windows 侧 WS/PB：

| 阶段 | 外部 WS | 外部 PB | 后端自报 RSS | 自报堆 | 增量 |
|---|---:|---:|---:|---:|---:|
| ① 启动就绪 | 54.9 MiB | 25.1 MiB | 54.9 MiB | 7.8 MiB | — |
| ② `app.metrics` | 54.9 MiB | 25.1 MiB | 54.9 MiB | 7.9 MiB | ±0 |
| ③ `adapters.list` | 61.6 MiB | 33.4 MiB | 61.6 MiB | 11.9 MiB | +6.7 MiB |
| ③ `network.listeningPorts` | 64.0 MiB | 36.1 MiB | 64.0 MiB | 11.8 MiB | +2.4 MiB |
| ③ `session.status` | 64.0 MiB | 36.1 MiB | 64.0 MiB | 11.8 MiB | ±0 |
| ③ `lobby.status` | 64.1 MiB | 36.1 MiB | 64.1 MiB | 11.9 MiB | ±0 |
| ④ **`lobby.friends`（拉 42 个好友）** | **93.1 MiB** | 50.7 MiB | 93.1 MiB | 10.1 MiB | **+29.0 MiB** |

关键读数：
- **裸 Node 常驻进程本身就是 49.0 MiB**（`setInterval` 空转，无任何业务代码）。这是运行期地板，无法通过改代码消除。
- 后端启动 + 36 个网络模块只额外花 **约 9 MiB**（54.9 → 64.1）。
- **`lobby.friends` 一项就 +29.0 MiB**，且堆几乎没变（11.9 → 10.1 MiB），
  说明这 29 MiB 全在**原生侧**：koffi FFI 绑定 + `steam_api64.dll` + Steam 客户端内部结构。
  这是加载 Steamworks SDK 的必然代价，不是泄漏。

## 5. 真正可做的优化（都经过实测或可从数据直接推导）

| 优化 | 实测/推导收益 | 代价 |
|---|---:|---|
| 把 `lobby.friends` 改为按需触发（进入好友页或开始会话才加载 Steam SDK） | **约 -29 MiB**（93.1 → 64.1 已实测） | 未进好友页时无法显示好友数；需 UI 明示"未加载" |
| 后端进程不产生控制台宿主（`windowsHide` / 无 `conhost`） | 约 -7.3 MiB | 后端诊断输出需改走日志文件 |
| 延迟加载 `adapters.list` 触发的适配器模块 | 约 -6.7 MiB（可推导） | 首次打开适配器列表变慢 |
| **合计** | **约 -43 MiB → 进程树约 195 MiB** | 仍远超 100 MiB |

即使把上述全部做完，**距离 100 MiB 仍有约一倍差距**，且 Qt 侧那 87 MiB 尚未找到可动的手术点
（已排除画布、渲染后端、页面内容、字体四个方向）。

## 6. 与 Electron 0.14.4 的对照（尚未完成，列为待办）

任务书原本的隐含前提是"QML 比 Electron 省很多"。本机已有 Electron 便携包
`D:\shl\Stronghold-Link-0.14.4-win-x64\...\Stronghold Link.exe`，
可用同一套 `tools/sample-tree.cjs` 直接量出 Electron 版的进程树 WS，做成同口径对照表。
**在这张表出来之前，不应该对外宣称任何"节省了 X%"的说法。**
这是下一步最该补的一次测量——它决定"241 MiB 到底算不算改善"。

## 7. 复现方式

```powershell
# 采一次应用进程树（18 秒，每秒一采样）
$env:PATH = "D:\Qt\6.8.3\mingw_64\bin;D:\Qt\Tools\mingw1310_64\bin;$env:PATH"
node D:\shl\tools\sample-tree.cjs --out qml-qa\raw --label my-run --seconds 18 -- `
  C:\...\Stronghold-Link\source\app_qml\build\release\StrongholdLink.exe

# 逐阶段量后端
node D:\shl\tools\backend-memory-probe.cjs backend\stronghold-backend.cjs

# 校准阶梯（只换 QML，不改 C++）
node D:\shl\tools\make-stage-variant.cjs <真实qml目录> <app_qml\qml> probe-empty-pages
```

## 8. 未验证 / 无法确认的项

- **Electron 0.14.4 的同口径进程树内存：未测**（§6）。所有"更省"的说法都等这次测量。
- Qt 侧 87 MiB 增量的**具体归属尚未定位**：已排除画布尺寸、渲染后端、页面内容、自定义字体；
  剩下的候选（QML 场景图节点数、JS 引擎、Qt 内部缓存）需要插桩才能区分。
  本轮的插桩变体（`probe-*`，注入 `console.log` 自检）**启动即退出，未能取到场景图计数**，
  该方向属于未完成，不应据此下任何结论。
- 两台真机、两个 Steam 账号的真实 P2P 验收，本报告完全不涉及（本机也无法完成）。
