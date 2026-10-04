# Steamworks SDK 放这里（这个目录里的二进制不会进 Git）

Steam P2P 隧道需要 Valve 的 **Steamworks SDK redistributable**。
Valve 的授权**不允许**把它随本项目分发，所以仓库里不含这些文件，需要你自己放。

## 需要什么

按平台放对应的库文件：

| 平台 | 文件 | 放置路径 |
| --- | --- | --- |
| Windows x64 | `steam_api64.dll` | `steamworks_sdk/redistributable_bin/win64/steam_api64.dll` |
| Windows x86 | `steam_api.dll` | `steamworks_sdk/redistributable_bin/steam_api.dll` |
| Linux | `libsteam_api.so` | `steamworks_sdk/redistributable_bin/linux64/libsteam_api.so` |
| macOS | `libsteam_api.dylib` | `steamworks_sdk/redistributable_bin/osx/libsteam_api.dylib` |

## 从哪来

1. **官方渠道（推荐）**：登录 <https://partner.steamgames.com/> → SDK → 下载后取 `redistributable_bin`。
   Steamworks 合作方账号可免费注册。
2. 也可以从你已安装的任意 Steam 游戏目录里拷贝 `steam_api64.dll`
   （它就是这个 redistributable 本身，例如 `<Steam>\steamapps\common\<某游戏>\steam_api64.dll`）。
   ⚠️ 仅供本地自测；对外分发请用官方 SDK 并遵守 Valve 的授权条款。

## 目录名容错

程序会依次尝试这些目录名，写错一个字母也能认出来：

```
steamworks_sdk/    steamwork_sdk/    steamworks-sdk/    SteamworksSDK/
```

也支持把 `steam_api64.dll` 直接放在项目根目录或 exe 同级目录（不推荐，但能用）。
启动后应用会给出**逐项自检**（会话 → Steam 环境自检），缺什么会明确写出来。

## 放置后

```powershell
npm start          # 或启动便携版
# 会话 → 连接方式「Steam P2P 隧道」→ 点「Steam 环境自检」，五项全绿即可
```

自检全绿后还需要：**Steam 客户端已登录**、两端 **AppID 一致**（测试可用 `480`）、
以及**两台不同的电脑、两个不同的 Steam 账号**（同一个账号自己连自己不是有效通路，
实测 Steam 会返回错误 8 并断开）。
