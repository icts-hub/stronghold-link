# 第六阶段：打包与分发（v0.9.0）

## 1. 本阶段的定位

工具已经通用化（本地 TCP/UDP 中继 + Steam P2P 隧道 + 端到端加密），不再绑定任何游戏；
`original/` 里的游戏工程与调试文本已删除。这一阶段解决「怎么把它交到别人手上」：

- 打包成**免安装便携版**：解压即用，已实测；
- 提供 **NSIS 安装包**的配置与命令（受当前网络限制未能在此生成，原因见第 4 节）；
- 说明 Steam 模式下用户需要自己放的那些文件（SDK 不能随包分发）。

## 2. electron-builder 配置（已写入 `package.json` 的 `build` 字段）

```json
{
  "appId": "com.strongholdlink.tunnel",
  "productName": "Stronghold Link",
  "electronDist": "node_modules/electron/dist",
  "directories": { "output": "../release" },
  "files": ["electron/**/*", "network/**/*", "src/**/*", "package.json", "!**/*.map", "!**/*.md", "!**/test/**"],
  "asar": true,
  "win": { "target": [{ "target": "nsis", "arch": ["x64"] }], "artifactName": "Stronghold-Link-Setup-${version}.${ext}" },
  "nsis": {
    "oneClick": false,
    "perMachine": false,
    "allowToChangeInstallationDirectory": true,
    "createDesktopShortcut": true,
    "createStartMenuShortcut": true,
    "shortcutName": "Stronghold Link",
    "deleteAppDataOnUninstall": false
  }
}
```

几个刻意的选择：

- **`electronDist` 指向本地 `node_modules/electron/dist`**：这样打包不需要联网重下 Electron（本机网络对 GitHub 有拦截，见第 4 节）。
  已 `npm install` 的机器都能直接打包。
- **`deleteAppDataOnUninstall: false`**：卸载时不删用户配置（`%APPDATA%\stronghold-link\game-profiles.json`），避免误删用户的服务配置与口令。
- **`files` 排除 `test/` 与 `*.md`**：安装包里只留运行需要的东西。
- **asar 开启**：源码打成归档，用户目录里不会散落源文件。

## 3. 构建命令与实测结果

```powershell
cd source
npm run build:dir   # 免安装版：输出 release/win-unpacked/
npm run build       # NSIS 安装包：输出 release/Stronghold-Link-Setup-<版本>.exe（需要能访问 GitHub）
```

**免安装版实测（2026-10-04，v0.8.0 打包基线上验证）**：

| 步骤 | 结果 |
| --- | --- |
| `npm run build:dir` | ✅ 生成 `release/win-unpacked/Stronghold Link.exe`（210 MB）+ `resources/app.asar`（5.7 MB） |
| 运行打包后的 exe（`--smoke`） | ✅ `"ok": true`，8 个步骤全通过，stderr 0 行 |
| 打包内界面标题 | ✅ `Stronghold Link — 通用内网穿透`，版本正确 |
| 打成 ZIP（`Stronghold-Link-<版本>-portable-win-x64.zip`，约 132 MB） | ✅ |
| **模拟用户：解压到干净目录再运行** | ✅ 133 个文件，`--smoke` 结果 `ok: true`，stderr 0 行 |
| 解压后打开图形界面 | ✅ 运行 7 秒无崩溃、stderr 0 行 |

生成便携版 ZIP 的命令（PowerShell，无需额外依赖）：

```powershell
cd source
npm run build:dir
$ver = (node -e "console.log(require('./package.json').version)")
Compress-Archive -Path '..\release\win-unpacked\*' -DestinationPath "..\release\Stronghold-Link-$ver-portable-win-x64.zip" -CompressionLevel Optimal -Force
```

## 4. NSIS 安装包为什么这次没生成（如实说明）

`npm run build` 走到 `target=nsis` 后失败：

```
• building    target=nsis file=...\release\Stronghold-Link-Setup-0.8.0.exe archs=x64
• downloaded  label=nsis-3.0.4.1.7z progress=100%      ← NSIS 本体下载成功
⨯ Response code 502 (Bad Gateway)                        ← 后续组件被代理拦截
```

- 本机网络存在 TLS 代理：先用 `NODE_OPTIONS=--use-system-ca` 解决了证书校验问题，但代理对 GitHub 的后续下载持续返回 **502**（连续重试 4 次都一样）。
- 已尝试关闭 exe 签名/元数据编辑（`signAndEditExecutable: false`）绕过 `winCodeSign`，仍然 502 —— 说明被拦的是另一组件（`nsis-resources`）。
- **这是网络环境限制，不是配置问题**：换到能直连 GitHub 的网络，`npm run build` 即可产出安装包（其余配置都已验证可用）。

## 5. Steam 模式下用户需要自己准备的东西

安装包**故意不包含** Steamworks SDK 的 redistributable（Valve 授权不允许再分发）。用户侧：

1. 把 SDK 的 `redistributable_bin` 放到 **exe 同级目录** 下的 `steamworks_sdk/`，例如：
   ```
   <安装目录>\steamworks_sdk\redistributable_bin\win64\steam_api64.dll
   ```
2. 或放到 `resources/` 下（`process.resourcesPath`），诊断会在这几处查找：
   应用目录、`resources/`、exe 同级目录、当前工作目录。
   （这是本阶段顺带修掉的一个打包相关问题：之前只找了应用目录，打包后用户根本没法放 DLL。）
3. 打开应用 → 会话 → 连接方式选 **Steam P2P 隧道** → 点「Steam 环境自检」，全绿后再启动。

`steamworks-ffi-node` 已作为 `optionalDependencies` 打进包里（含 koffi 运行时），所以用户不需要再 `npm install`。

## 6. 未验证的部分

- **NSIS 安装包**：未能在本机产出（网络限制），因此「安装 → 卸载 → 注册表/快捷方式」这条路径**没有实测**。
- **代码签名**：无证书，未签名；Windows SmartScreen 会提示未知发布者，这是未签名软件的常态。
- **应用图标**：当前使用 Electron 默认图标（构建日志有 `default Electron icon is used` 提示），要换图标就把 `.ico` 放到 `build/icon.ico`。
- **跨机实测**：安装包在另一台电脑上的表现（防火墙提示、首次运行）未验证。
