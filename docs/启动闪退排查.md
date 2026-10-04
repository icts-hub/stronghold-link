# 启动闪退排查（打包后双击没反应 / 一闪就退）

## 1. 结论先说

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 双击 `Stronghold Link.exe`，一闪就退、没有任何提示 | 本机 **Chromium 沙箱初始化失败**。实测：不带参数 6 秒内进程已退出，且**不会生成 startup.log**（说明死在 Electron 主进程执行 JS 之前）；带 `--no-sandbox` 则 `--smoke` 返回 `ok: true`、窗口正常 | **用包里的 `点我启动-Stronghold-Link.cmd` 启动**（它默认带 `--no-sandbox`） |
| 有时带参数也崩，事件日志里出现第三方模块 | **注入型软件**：Windows 事件日志显示 `Faulting module name: GPP64.dll`（游戏加加 GamePP 3.7.57），stderr 里有 `fail CreateSemaphore[5]: ... GAMEPP-IPC-OVERLAY` | 完全退出**游戏加加**；建议一并关掉 NVIDIA Overlay、Nahimic、RTSS / MSI Afterburner |

> 重要：在 JS 里用 `app.commandLine.appendSwitch('no-sandbox')` **来不及**——沙箱在 JS 执行之前就已初始化。
> 这一点是实测否定的（加了它仍然没有 startup.log、仍然秒退），所以必须由**命令行参数**传入。

## 2. 正确启动方式

1. 把整个压缩包**完整解压**到一个新文件夹（不要只复制 exe，也不要覆盖旧版本）。
2. 双击 **`点我启动-Stronghold-Link.cmd`**。
   - 它会先检测注入型软件并给出提示；
   - 用 `--no-sandbox` 启动；失败自动换 `--no-sandbox --disable-gpu`；再失败才试标准模式；
   - 首次运行还会在包内生成一个 **`Stronghold Link（兼容模式）.lnk`**，之后直接双击这个快捷方式也行；
   - 三种方式都失败时，它会打印日志路径并暂停，不会一闪而过。
3. 可选：把生成的快捷方式发送到桌面。

## 3. 出问题时看这两个日志

| 文件 | 内容 |
| --- | --- |
| `%APPDATA%\stronghold-link\launcher.log` | 启动器的每一次尝试与退出码（`尝试1(--no-sandbox) 退出码=...`） |
| `%APPDATA%\stronghold-link\startup.log` | 应用内部启动轨迹：argv、版本、`app ready`、窗口创建、渲染进程加载成功/失败、`render-process-gone`、`child-process-gone`、`gpu-process-crashed`、未捕获异常、「另一个实例已在运行」等 |

判断口径：

- **有 launcher.log、没有 startup.log** → 进程死在 Electron 主进程之前 → 沙箱问题（用启动器）或被注入 DLL 干掉（退游戏加加）。
- **有 startup.log 且停在「app ready」之前** → 同上。
- **有 startup.log、停在「主窗口已创建」但没到「渲染进程加载完成」** → 渲染进程加载失败，日志里会有 `code/desc/url`。
- **正常一次的 startup.log 长这样**：
  ```
  === 启动 === version=0.9.0 ... no-sandbox=auto
  app ready
  主窗口已创建
  渲染进程加载完成
  ```

## 4. 自己动手验证（可选）

```powershell
# 直接验证 exe 本体没问题（会写结果文件，不会弹窗口）
& ".\Stronghold Link.exe" --smoke --no-sandbox --smoke-out="$env:TEMP\shl-smoke.json"
type "$env:TEMP\shl-smoke.json"     # 期望看到 "ok": true
```

`--smoke` 会走完「渲染进程加载 → preload 桥 → IPC → 房主会话 → 端口监听 → 加入者中继 → 数据往返 → 停止 → 端口释放」，
`"ok": true` 表示程序本身完全正常，问题只在启动方式或外部注入。

## 5. 其他可能

- **SmartScreen / 杀毒拦截**：本程序未做代码签名，Windows 会提示「未知发布者」。点「更多信息 → 仍要运行」；
  若被杀毒直接删除，请把该文件夹加入信任列表。
- **解压不全**：只把 exe 拖出来是跑不起来的，`resources/` 等目录必须一起解压。
- **已经有一个实例在跑**：新实例会立刻退出（日志里会写「另一个实例已在运行」）。
  打开任务管理器结束所有 `Stronghold Link` 进程后再启动。
- **想保留 Chromium 沙箱**（安全要求更高的场景）：设置环境变量 `SHL_KEEP_SANDBOX=1` 再启动。
  应用自身的 `contextIsolation` / `nodeIntegration=false` / preload 白名单 / CSP 始终不变。
