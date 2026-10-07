Stronghold Link (portable, v0.13.3) — universal tunnel / 通用内网穿透

HOW TO START / 怎么启动
-----------------------
Double-click  START-HERE.cmd    (Chinese name: 点我启动-Stronghold-Link.cmd)
Do NOT double-click "Stronghold Link.exe" directly — on machines where the Chromium
sandbox cannot initialise it exits instantly with no message. The launcher retries
with --no-sandbox and writes logs.

FOUR CONNECTION METHODS / 四种连接方式
-------------------------------------
1) Local relay (TCP/UDP port rules)      - across networks / with a VPN, encrypted
2) Local relay + browser app             - web apps: joiner opens http://127.0.0.1:<entry>
3) Steam P2P tunnel                      - across the internet, no port forwarding
4) No relay (LAN direct)                 - same LAN, tool forwards nothing

RISK WARNING / 风险提示
------------------------
Using Steam for P2P multiplayer is RISKY: AppID 480 is Valve's test app, and whether
Valve treats this as abuse (account limits / bans) is unknown. USE A THROWAWAY STEAM
ACCOUNT, not your main one. The local relay and LAN-direct modes do not touch Steam at all.
用 Steam 通道联机属于风险行为，V 社是否封禁没有明确说法——请用小号，别用主账号。

STEAM / Steam 联机
------------------
Put the Steamworks SDK redistributable here (either spelling is accepted):
  steamworks_sdk\redistributable_bin\win64\steam_api64.dll
  steamwork_sdk\redistributable_bin\win64\steam_api64.dll   (also OK)
Then: Session -> connection method "Steam P2P tunnel" -> "Steam environment self-check"
should be all green. You need TWO machines with TWO different Steam accounts (a single
account cannot usefully connect to itself — Steam returns error 8). Full steps: STEAM-GUIDE.md

LOGS / 日志
-----------
%APPDATA%\stronghold-link\startup.log
%APPDATA%\stronghold-link\launcher.log
