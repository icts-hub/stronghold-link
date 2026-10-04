@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "EXE=%~dp0Stronghold Link.exe"
set "LOGDIR=%APPDATA%\stronghold-link"
if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>nul
set "LAUNCHLOG=%LOGDIR%\launcher.log"

echo.
echo ==========================================
echo   Stronghold Link 启动器
echo ==========================================
echo.

if not exist "%EXE%" (
  echo [X] 找不到 "Stronghold Link.exe"
  echo     请确认本 .cmd 与 exe 在同一文件夹（整个压缩包都要解压出来）。
  echo.
  pause
  exit /b 1
)

rem ---- 已知会让本程序闪退的「注入型」软件 ----
set "RISK="
for %%P in (GamePP.exe GamePPService.exe GPPLauncher.exe RTSS.exe MSIAfterburner.exe) do (
  tasklist /FI "IMAGENAME eq %%P" 2>nul | find /I "%%P" >nul && set "RISK=!RISK! %%P"
)
if not "!RISK!"=="" (
  echo [!] 检测到注入型软件：!RISK!
  echo     游戏加加的 GPP64.dll 已被证实会让本程序崩溃（Windows 事件日志可查）。
  echo     如果仍然闪退，请先完全退出这些软件再试。
  echo.
)

rem ---- 首次运行时，在本目录生成一个「兼容模式」快捷方式（避免直接双击 exe 闪退）----
if not exist "%~dp0Stronghold Link（兼容模式）.lnk" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%~dp0Stronghold Link（兼容模式）.lnk');" ^
    "$s.TargetPath='%EXE%'; $s.Arguments='--no-sandbox'; $s.WorkingDirectory='%~dp0';" ^
    "$s.Description='Stronghold Link 兼容模式（--no-sandbox）'; $s.Save()" >nul 2>nul
  if exist "%~dp0Stronghold Link（兼容模式）.lnk" echo [i] 已生成本目录内的「Stronghold Link（兼容模式）.lnk」，以后双击它即可。
)

rem ---- 先加日志头，便于事后排查 ----
echo [%DATE% %TIME%] === 启动器开始（版本 0.9.0）=== >> "%LAUNCHLOG%"

rem 说明：本机 Chromium 沙箱初始化会失败（现象是双击 exe 一闪就退、没有任何提示），
rem 所以这里默认先带 --no-sandbox 启动；如果成功就不再折腾。
echo [1/3] 兼容模式启动（--no-sandbox）...
start "" /wait "%EXE%" --no-sandbox %*
set "RC=%ERRORLEVEL%"
echo [%DATE% %TIME%] 尝试1(--no-sandbox) 退出码=%RC% >> "%LAUNCHLOG%"
if "%RC%"=="0" goto :done

echo [2/3] 兼容模式启用失败，改用 --no-sandbox --disable-gpu ...
start "" /wait "%EXE%" --no-sandbox --disable-gpu %*
set "RC=%ERRORLEVEL%"
echo [%DATE% %TIME%] 尝试2(--no-sandbox --disable-gpu) 退出码=%RC% >> "%LAUNCHLOG%"
if "%RC%"=="0" goto :done

echo [3/3] 再试一次标准模式（沙箱开启）...
start "" /wait "%EXE%" %*
set "RC=%ERRORLEVEL%"
echo [%DATE% %TIME%] 尝试3(标准模式) 退出码=%RC% >> "%LAUNCHLOG%"
if "%RC%"=="0" goto :done

echo.
echo ==========================================
echo   三种方式都启动失败（最后退出码 %RC%）
echo ==========================================
echo.
echo 请把下面两个日志发给开发者：
echo   1) %LOGDIR%\launcher.log
echo   2) %LOGDIR%\startup.log   （如果存在）
echo.
echo 常见原因：
echo   * 游戏加加 / NVIDIA Overlay / Nahimic 等注入型软件 —— 全部退出后再试；
echo   * 杀毒软件拦截 —— 把本程序所在文件夹加入信任列表；
echo   * 解压不完整 —— 用资源管理器重新完整解压，不要只复制 exe。
echo.
echo 也可以自己看系统事件日志里的崩溃模块：
echo   eventvwr.msc ^> Windows 日志 ^> 应用程序
echo.
pause
exit /b 1

:done
echo.
echo 程序已正常退出。启动日志：%LOGDIR%\startup.log
exit /b 0
