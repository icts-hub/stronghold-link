@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem ─────────────────────────────────────────────────────────────────────────
rem  Stronghold Link — QML 版启动器（Windows x64 便携包）
rem  本文件由仓库的 dist-extras-qml/ 提供；打包时 tools/pack-qml.cjs 会再复制成
rem  START-HERE.cmd（同一份内容，给非中文系统用）。
rem
rem  为什么要启动器：QML 版是 GUI 子系统程序（没有控制台窗口），被注入型 DLL 干掉或
rem  缺 Qt 运行库时会「一闪就退、什么都不说」。启动器负责把 --log 指到 %APPDATA%，
rem  失败时把退出码翻译成人话。
rem ─────────────────────────────────────────────────────────────────────────

set "EXE=%~dp0StrongholdLink.exe"
set "LOGDIR=%APPDATA%\stronghold-link"
set "QMLOG=%LOGDIR%\qml-startup.log"
set "LAUNCHLOG=%LOGDIR%\launcher.log"
if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>nul

echo.
echo ==========================================
echo   Stronghold Link（QML 版）启动器
echo ==========================================
echo.

if not exist "%EXE%" (
  echo [X] 找不到 StrongholdLink.exe
  echo     请确认本 .cmd 与 exe 在同一文件夹 —— 整个压缩包都要完整解压出来，
  echo     不要只把 exe 拖出来单独运行。
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0Qt6Core.dll" (
  echo [X] 缺少 Qt6Core.dll（Qt 运行库没跟 exe 在一起）
  echo     同样是解压不完整导致的：请重新完整解压整个压缩包。
  echo.
  pause
  exit /b 1
)

rem ---- 已知会让本程序崩溃的「注入型」软件 ----
set "RISK="
for %%P in (GamePP.exe GamePPService.exe GPPLauncher.exe RTSS.exe MSIAfterburner.exe) do (
  tasklist /FI "IMAGENAME eq %%P" 2>nul | find /I "%%P" >nul && set "RISK=!RISK! %%P"
)
if not "!RISK!"=="" (
  echo [!] 检测到注入型软件：!RISK!
  echo     游戏加加的 GPP64.dll 已被证实会让本程序崩溃（Windows 事件日志里能看到
  echo     Faulting module name: GPP64.dll）。如果启动后立刻闪退，先完全退出这些软件。
  echo.
)

echo [%DATE% %TIME%] === QML 启动器开始（包版本见 PORTABLE-CONTENTS.txt）=== >> "%LAUNCHLOG%"
echo 正在启动（日志：%QMLOG%）...
start "" /wait "%EXE%" --log "%QMLOG%" %*
set "RC=%ERRORLEVEL%"
echo [%DATE% %TIME%] 退出码=%RC% >> "%LAUNCHLOG%"

if "%RC%"=="0" goto :done

echo.
echo ==========================================
echo   程序退出码 %RC%
echo ==========================================
echo.
if "%RC%"=="-1073741819" goto :injected
if "%RC%"=="3221225477" goto :injected
if "%RC%"=="-1073741515" goto :missingdll
if "%RC%"=="3221225781" goto :missingdll
goto :other

:injected
echo 这是 0xC0000005（访问冲突）—— 典型原因是**有别的程序把 DLL 注进了本进程**。
echo 最常见的就是游戏加加（GPP64.dll），其次是各种游戏内覆盖层（RTSS / Nahimic /
echo 部分杀软的「行为防护」）。请把这些软件完全退出后重试。
echo.
echo 想自己确认是哪个模块干的：
echo   eventvwr.msc ^> Windows 日志 ^> 应用程序，找最近的应用程序错误事件，
echo   看 "Faulting module name" 那一行。
goto :tail

:missingdll
echo 这是 0xC0000135（找不到 DLL）—— Qt 运行库没有被正确解压到 exe 旁边。
echo 请重新完整解压压缩包；如果杀软报过毒，把整个文件夹加入信任列表再解压一次。
goto :tail

:other
echo 请把下面两个文件发给开发者：
echo   1) %LAUNCHLOG%
echo   2) %QMLOG%
echo 也可能是被注入型软件干掉的（见上面的检测结果）。
goto :tail

:tail
echo.
pause
exit /b 1

:done
echo.
echo 程序已正常退出。
echo 启动日志：%QMLOG%
exit /b 0
