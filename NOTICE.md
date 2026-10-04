# 第三方组件与声明

## 运行依赖

| 组件 | 许可 | 用途 |
| --- | --- | --- |
| [Electron](https://www.electronjs.org/) | MIT | 桌面应用框架 |
| [steamworks-ffi-node](https://www.npmjs.com/package/steamworks-ffi-node) | MIT | Steamworks 的 Node.js FFI 绑定（可选依赖） |
| [koffi](https://koffi.dev/) | MIT | FFI 运行时（steamworks-ffi-node 依赖） |
| [Steamworks SDK](https://partner.steamgames.com/) | Valve 专有 | **不随本项目分发**，需使用者自行获取 |

## 不随本项目分发的内容

- **Steamworks SDK redistributable**（`steam_api64.dll`、`libsteam_api.so`、`libsteam_api.dylib` 等）：
  受 Valve 授权条款限制，仓库与发行包中均不包含。放置方式见 [steamworks_sdk/README.md](steamworks_sdk/README.md)。

## 商标

Steam 与 Steamworks 是 Valve Corporation 的商标或注册商标。
本项目为独立第三方工具，与 Valve Corporation 无隶属、赞助或认可关系。

## 使用限制

本工具只做**透明的字节转发**，不解析、不修改、不破解任何应用协议，也不提供任何绕过授权、
绕过反作弊或规避付费的能力。使用者应自行确保：
对自己转发的服务拥有合法权利，并遵守相关服务条款与当地法律法规。
