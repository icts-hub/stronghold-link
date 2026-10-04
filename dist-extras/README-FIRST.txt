Stronghold Link (portable, v0.9.0) — universal tunnel / 通用内网穿透

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
