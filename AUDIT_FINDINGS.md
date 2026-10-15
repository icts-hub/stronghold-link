# AUDIT_FINDINGS —— QML 迁移前的代码审计（基线 0.14.4）

- 审计对象：`Stronghold-Link/source`，分支 `main`，基线提交 `33e9956`（"revert(net): 回滚到 0.14.4（撤销 0.14.5 / 0.14.6 的传输改动）"），tag `v0.14.4`。
- 审计方法：只读静态审计（grep + 定点阅读）+ 实际跑基线测试；不修改任何传输语义。
- 审计时间：见 §5 环境与命令记录。
- 本文件按提示词要求记录：证据（文件:行）、严重级别、复现步骤、影响、修复计划、修复 commit、剩余风险。

---

## 1. 基线事实（可复现）

| 项目 | 事实 | 证据 |
| --- | --- | --- |
| 版本 | `package.json` version = `0.14.4`；`electron/main.cjs:43` `APP_VERSION = '0.14.4'`；**`electron/preload.cjs:12` `version: '0.11.0'`（不一致）** | 见 A-05 |
| 基线测试 | `npm test` → **796 tests / 795 pass / 0 fail / 1 skipped / 32.4 s**（exit 0） | 本次审计实跑 |
| 测试文件 | `test/*.test.cjs` 共 **58** 个（README 写的是 42 个 / 518 用例，已过期） | 见 A-08 |
| 一级导航 | **7 个**：`home` / `library` / `session` / `network` / `adapters` / `friends` / `settings` | `src/ui/index.html:61-67` |
| 迁移目标 | 3 个：`session` / `friends` / `setting` | 提示词 §A(2) |
| 前端形态 | Electron + Chromium + `src/ui/index.html`（164 KB）+ `src/ui/styles/*` + `vendor/three.min.js` + GLB 背景 | `src/ui/` |
| 参考仓库 | `https://github.com/Funkierry/the-masses-travels`，已克隆并锁定 commit **`7ea40aea1ff28f84c20d58eae5f30497b093517d`**（2026-10-13 03:38:40 +1100） | `_ref/the-masses-travels` |
| 参考仓库许可 | **该 commit 无 `LICENSE` / `LICENSE.md` / `LICENSE.txt` / `COPYING`**；上游 `package.json` 无 `license` 字段且 `private: true` | 见 A-13 |

---

## 2. 问题清单（按严重级别）

| ID | 级别 | 标题 | 状态 |
| --- | --- | --- | --- |
| A-01 | **P1** | MUX 干道迁移吞掉"尚未交给 Steam"的字节 → 对端可靠字节流出现空洞 | 待修（Phase 1） |
| A-02 | **P1** | "已交给 Steam 但未被对端确认"的字节没有任何确认/补发协议 | 待修（Phase 1） |
| A-03 | P2 | 关闭日志口径不可信：kind/reason 硬编码，不区分关闭发起方 | 待修（Phase 1） |
| A-04 | P2 | 两套 MUX 实现并存（适配器内联 vs `mux-session.cjs`/`mux-stream.cjs`） | 文档化，禁止误切 |
| A-05 | P2 | 版本号三处不一致（`preload.cjs` 仍是 `0.11.0`） | 待修（Phase 2/5） |
| A-06 | P2 | `electron/main.cjs` 自动注入 Chromium `--no-sandbox` | 待删除（Phase 5） |
| A-07 | P2 | `backgroundThrottling: false`：窗口不可见时装饰动画照跑 | 待改（Phase 3/4） |
| A-08 | P3 | README 徽章与数字过期（0.13.3 / 518 用例 / 42 文件） | 待更新（Phase 5） |
| A-09 | P3 | 一级导航 7 个，与新信息架构冲突 | 待改（Phase 3/4/5） |
| A-10 | P3 | `docs/多通道选路设计.md` 描述的能力**未实现** | 待标注（Phase 4） |
| A-11 | P3 | 跨机 Steam P2P 缺真实验收证据（单测用的是假 SDK） | 待补（Phase 6） |
| A-12 | 环境 | 本机原本没有任何 Qt 工具链 | 已装（Qt 6.8.3 + MinGW 13.1.0） |
| A-13 | **授权** | 参考仓库自称 MIT 但当前证据不足；游戏提取素材不得再分发 | 见 §4 |

---

## 3. 详细条目

### A-01（P1）MUX 干道迁移吞掉"尚未交给 Steam"的字节

**证据（0.14.4 原始代码）**

- `network/steam-adapter.cjs:1190` `parkPeerStreams(peer, reason)`：干道断开时把流从 `peer.streams` 摘出、`stream.owner = null`、按 `orphanKey(peer, stream.id)` 寄存到 `orphanStreams`，**全程只搬流对象，没有碰出站队列**：
  ```js
  peer.streams.delete(stream.id);
  stream.owner = null;
  stream.parkedAt = now;
  ...
  orphanStreams.set(key, stream);
  ```
- `network/steam-adapter.cjs:1802` `parkTrunkStreams(peer, reason)`：加入者侧同一形状（`stream.trunk = null`）。
- `network/steam-adapter.cjs:1953` `egress.clear(peer)`：重连路径直接清空这条 peer 的出站队列，注释写着"重发只会让对端收到重复字节"——**该注释是错的**：队列里剩下的正是"从来没交给 Steam"的字节。
- `network/egress-queue.cjs`：`planOut()` 只把计划发给 Steam，`commit(peer, planInfo, confirmed)` 只把**已被 Steam 接受的前缀**出队；因此 flush 返回 `success` 之外的残留字节 = 一定没送达。
- `network/steam-adapter.cjs:1161` `adoptOrphan` / `:1830` `resumeOrphanStreams`：新干道上来后发 `OPEN(id, generation+1)` 并补发 `parkQueue`（寄存期间新产生的字节），**但没有任何地方补发"旧干道上已入队却未确认"的那一截**。

**复现步骤（确定性，不依赖双机）**

1. 用 `test/steam-mock.cjs` 起房主（真本机 TCP 游戏端口）+ 加入者，配对定帧（`answerHello`）。
2. 让加入者发一段字节，随后把 `sendMessage` 打成"暂时拒收"（`{success:false,result:2}`），再写 30000 字节 —— 这批字节留在本机 egress 队列里（未交给 Steam）。
3. 让干道 A 断开（`emitState(ClosedByPeer, 'I/O Operation Failed')`），再挂新干道 B（同流号、世代 +1）。
4. 收全干道 A + B 上的 DATA 帧拼成字节流，与游戏客户端写进去的原始字节逐字节比较。

**历史证据**：修复前该用例断言失败 —— `AssertionError ... 少了 30000 字节 ... 26 !== 30026`。

**影响**：对端这一条 TCP 流中间少一截。Minecraft 的 netty 解码器在包边界错位 → `io.netty.handler.codec.DecoderException: java.util.zip.DataFormatException: unknown compression method` / `incorrect header check` / `CorruptedFrameException: length wider than 21-bit`（CLIENTBOUND 方向）→ 客户端掉线并自动重连；因流是"原地复活"的，两端都不认为连接断过，主机侧只看到"玩家反复加入/退出"，Steam Lobby 一直在线。

**修复计划（Phase 1，最小范围）**：把三分法写进代码并用测试钉死 —— ① 还没交给 Steam（egress 队列）；② 交给 Steam 但未被确认；③ 对端确认已交付。① 在寄存时随流带走（`takePending`）、复活时按新世代重发（`retagFrame`）；② 用 `Resume(offset)` + `Ack(delivered)` 协议补发并去重；③ 绝不重发。

**状态**：待 Phase 1 修复并附回归测试。

### A-02（P1）"已交给 Steam 但未被对端确认"没有确认协议

**证据**：0.14.4 全仓 `grep -n "takePending\|retagFrame\|sentLog\|ackedBytes"` 无命中；`network/stream-mux.cjs` 的 `TYPE` 表只有 `Data/Open/Close/Reset/Window/Ping/Pong`，没有 Ack/Resume；`remoteCredit` 只写不读（`steam-adapter.cjs:1152` 初始化、`:1423` 房主收 Window、`:2290` 加入者收 Window），`encodeWindow` 在适配器里从不调用 ⇒ 现役路径没有基于信用的流控，也没有交付确认。

**影响**：Steam 只保证"连接活着时按序送达"；干道一断，这段字节可能已送达也可能永远丢了，而代码默认它送达（流照样原地复活）⇒ 与 A-01 同源的字节流空洞，且**无日志可查**。

**修复计划**：接收端每交付满 32 KiB 回一次累计 `Ack(delivered)`；发送端保留最近 512 KiB 已发字节，复活时先发 `Resume(start)` 再补发；接收端按 `Resume` 切掉重复前缀（`takeDelivery`）；若 `start` 超过本机已交付位置（对端记录已被内存上限挤掉）**如实报错断开**（`ERESUMEGAP`），绝不交出一条有洞的流。

**状态**：待 Phase 1。

### A-03（P2）关闭日志口径不可信

**证据（硬编码的 kind/reason，不看真实发起方）**：`network/steam-adapter.cjs:1151`（房主游戏 socket close → 一律 `本机服务端口把这条件接关了（响应正常收尾，或游戏侧自己超时）`）、`:1419`（老路径）、`:2532`（加入者本地 socket close → 一律 `浏览器/游戏自己关掉了这条本机连接`）、`:2792`（老路径）。

**影响**：我们自己 `destroy()` 掉的流会被报成"游戏侧关的"，排查方向被带反（现场就发生过：真正原因是干道迁移空洞，日志却指向游戏服务端）。这与提示词 §3.3(3) 完全一致。

**修复计划**：所有关闭点先"留名"（`LocalServiceClosed` / `LocalClientClosed` / `PeerStreamClosed` / `PeerStreamReset` / `TunnelAbort` / `TunnelClosed` / `BadFraming` / `MigrateExpired` / `OverflowAborted` / `BackpressureAborted` / `SessionStopped` / `ProtocolViolation`），日志行追加 `发起方=`、`暂停=`、`本机待发=`、`Steam待发=`；渲染端补新 kind 的中文名，删除与实际原因不符的旧文案。

**状态**：待 Phase 1。

### A-04（P2）两套 MUX 实现并存

**证据**：现役路径是 `network/steam-adapter.cjs` 内的内联实现，它只 require 三件套 —— `stream-mux.cjs`（分帧，`:21`）、`mux-scheduler.cjs`（唯一调度器，`:29`）、`SESSION_STATE`（状态枚举，`:31`）。另一套是 `network/mux-session.cjs`（23.2 KB，`createMuxSession`）+ `network/mux-stream.cjs`（12.6 KB，`createMuxStream`）+ `mux-backpressure.cjs`（7.0 KB），**只有测试在跑**：`test/mux-session.test.cjs`、`test/mux-stream.test.cjs`、`test/campus-profile.test.cjs`；`network/network-health.cjs:16` 与适配器一样只借枚举。

**风险**：迁移期间误把某条路径切到第二套，会绕过真机验证过的实现。

**处理**：本阶段不合并、不切换（提示词 §3.3(2)）；在 `QML_MIGRATION_PLAN.md` 里写明真实调用路径与差异；第二套保留原状 + 原有测试。**状态**：已记录，不改代码。

### A-05（P2）版本号三处不一致

**证据**：`electron/preload.cjs:12` `version: '0.11.0'`；`package.json:3` `0.14.4`；`electron/main.cjs:43` `APP_VERSION = '0.14.4'`。

**修复计划**：迁移后版本号单一来源（`package.json` 或生成的头文件）+ 一致性测试；QML 版 Setting 页显示真实版本。**状态**：待 Phase 2/5。

### A-06（P2）自动注入 `--no-sandbox`

**证据**：`electron/main.cjs:129-147`（`HAS_NO_SANDBOX_FLAG` / `KEEP_SANDBOX = process.env.SHL_KEEP_SANDBOX === '1'` → `app.commandLine.appendSwitch('no-sandbox')`，并写进启动日志 `no-sandbox=...`）。

**处理**：QML 版不再有 Chromium，Phase 5 删除该逻辑并检查无 Chromium 残留。**状态**：待 Phase 5。

### A-07（P2）`backgroundThrottling: false`

**证据**：`electron/main.cjs:1695`、`:2242`（主窗口与探针窗口）。

**处理**：QML 版要求"窗口隐藏/最小化时停装饰动画、网络后端照常跑"；在 Phase 3 的设计系统里用 `Application.state`/`QQuickWindow.visibility` 驱动动画暂停位。**状态**：待 Phase 3/4。

### A-08（P3）README 数字过期

**证据**：`README.md:8` `tests-518 passing`、`:9` `version-0.13.3`、`:37` "518 个测试用例"、`:139` "42 个文件 518 个用例"、`:181` "覆盖 518 个用例，42 个测试文件"。实际：58 个测试文件、796 个用例、版本 0.14.4。**状态**：待 Phase 5 更新。

### A-09（P3）一级导航 7 个

**证据**：`src/ui/index.html:61-67`（`data-view="home|library|session|network|adapters|friends|settings"`），另有 Library/Adapters 页内容（`:125`、`:451`）与 `renderAdapters()`（`:1841`）。

**处理**：新 UI 只保留 session / friends / setting；旧页面与相关 CSS/JS 在 Phase 5 整层删除，不留隐藏兼容层。**状态**：待 Phase 3/4/5。

### A-10（P3）未实现的能力不得显示为可用

**证据**：`docs/多通道选路设计.md`（4,104 B）描述多通道选路，代码里没有实现。**处理**：Setting 页只展示已实现项；未实现项标"未实现"并禁用。**状态**：待 Phase 4。

### A-11（P3）跨机 Steam P2P 验收缺证据

**证据**：`test/steam-mock.cjs` 是假 SDK（`sendMessage` 永远成功）；单测通过 ≠ 真机双机验收。**处理**：Phase 6 给出双机清单（两台机器、两个 Steam 账号、同一 AppID、10 分钟流量 soak、双向断开、干道断开且出站队列非空、恢复后逐字节一致）；本机若无法完成，如实标"未验证"。**状态**：待 Phase 6。

### A-12（环境）Qt 工具链

审计时本机无任何 Qt（`qmake`/`qtpaths6`/`windeployqt`/`cmake`/`ninja`/`cl` 均不存在；`C:\Qt`、`D:\Qt`、`vcpkg`、`msys64` 均无；磁盘上的 `Qt6Core.dll` 只属于 AutoCAD / Nsight / X-Rite 等成品软件）。已通过 `pip install aqtinstall` → `aqt install-qt windows desktop 6.8.3 win64_mingw -O D:\Qt --archives qtbase qtdeclarative qtsvg qttools qtshadertools qtimageformats` + `aqt install-tool windows desktop tools_mingw1310 -O D:\Qt` 安装（见 §5 命令记录）。**状态**：安装完成，`D:\Qt\6.8.3\mingw_64\bin\qmake.exe` 与 `windeployqt.exe` 可用。

---

## 4. 授权与来源（对应提示词 §6）

### A-13（授权红线）参考仓库许可证据不足

- 参考仓库：`https://github.com/Funkierry/the-masses-travels`
- 锁定的 commit：`7ea40aea1ff28f84c20d58eae5f30497b093517d`（2026-10-13 03:38:40 +1100，`Add collage visuals and illustrated README with demo assets`）
- 该 commit 根目录文件：`ASSETS.json`、`package.json`、`README.md`、`THIRD_PARTY_NOTICES.txt`、`VALIDATION.md`、`scripts/`、`src/` —— **没有 `LICENSE` / `LICENSE.md` / `LICENSE.txt` / `COPYING`**；`package.json` 无 `license` 字段且 `private: true`。
- 结论：**需求方"参考项目是 MIT"的说法目前没有独立证据**。按提示词要求，不得据此伪造 LICENSE，也不得把 Three.js 的 MIT 扩大解释为整个仓库的许可。

**因此本项目的落地策略（记录为决策）**：

1. **不直接搬用上游代码文件**。设计系统按上游 README 公开描述的算法（圆环半径叠两层正弦、收笔越过起点、标线中段拱起两端冲出、笔刷沿法线渐细成闭合轮廓、关键线偏移二次描、景深线宽倍率、固定 seed）**自行实现**为 QML/JS 组件，并在 `ASSET_PROVENANCE.md` 中如实标注"算法行为参考上游 README 描述、代码为 Stronghold 自写、未复制上游源文件"。
2. **不打包上游任何素材**，尤其不打包 `public/assets/game/`（上游 `THIRD_PARTY_NOTICES.txt` 与 README 明确：从《明日方舟》PC 客户端提取的地图/图集/美术/BGM 仅供私人学习、不得再分发；注明出处不等于获得再分发许可）。
3. 若后续拿到权利人/作者的**有效 MIT 证据（固定到某个 commit）**，再单独评估是否直接移植上游代码，并按 §6 补齐 MIT 全文 + 版权行 + 清单字段；在此之前，"包含上游代码的公开源码/二进制发布"是**发布阻断项**。
4. 图形全部按固定 seed 程序化生成（不引入第三方图片），字体只使用系统已装字体或确认许可的字体（见 Phase 3 记录），`LICENSES/` + `THIRD_PARTY_NOTICES.txt` + `ASSET_PROVENANCE.md` + `asset-provenance.json` + `tools/verify-asset-provenance.*` 随包提供。

---

## 5. 命令与运行记录（可复现）

```powershell
# 仓库与基线
cd Stronghold-Link\source
git log --oneline -1                  # 33e9956 revert(net): 回滚到 0.14.4 ...
git status --porcelain                # 只有未跟踪的 docs/项目说明书.md（现已入库 dc6ec4e）
git tag -a v0.14.4 -m "0.14.4 基线：QML 迁移起点"   # 已打
git switch -c qml-migration           # 迁移分支
$env:ELECTRON_RUN_AS_NODE=$null; npm test        # 796 tests / 795 pass / 0 fail / 1 skipped / 32.4s

# 参考仓库（只读克隆，避开大素材）
git clone --depth 1 --filter=blob:none --sparse https://github.com/Funkierry/the-masses-travels.git _ref\the-masses-travels
git -C _ref\the-masses-travels sparse-checkout set --no-cone src README.md VALIDATION.md ASSETS.json THIRD_PARTY_NOTICES.txt package.json
git -C _ref\the-masses-travels log -1 --format=%H   # 7ea40aea1ff28f84c20d58eae5f30497b093517d

# Qt 工具链
python -m pip install aqtinstall
python -m aqt install-qt windows desktop 6.8.3 win64_mingw -O D:\Qt --archives qtbase qtdeclarative qtsvg qttools qtshadertools qtimageformats
python -m aqt install-tool windows desktop tools_mingw1310 -O D:\Qt
```

---

## 6. 剩余风险与未验证事项

1. **双机 Steam P2P 未验证**：本轮所有网络结论都基于假 SDK 单测与代码论证；真实两台机器 / 两个 Steam 账号的联机验收仍未完成（需要第二台机器与第二个账号）。
2. **A-01/A-02 的修复只保证"我们这一层"字节一致**：若 Steam 传输层本身出错，只能靠 A-02 的 Ack/Resume 暴露（`ERESUMEGAP`）而不是静默交出一条有洞的流。
3. **内存目标（≤100 MiB，进程树 Working Set）尚未实测**：Phase 5 才会得到第一份真实采样；在拿到逐秒原始数据前，任何"达标"说法都不成立。
4. **授权**：A-13 未解决前，包含上游代码或许可未确认素材的发布一律阻断。
5. **Qt 版本与运行时**：安装的是 Qt 6.8.3 / MinGW 13.1.0；Qt 运行时的可再分发许可以 Qt 官方条款为准，`LICENSES/` 必须随包附上对应文本（Phase 5）。
