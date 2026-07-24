@echo off
rem ============================================================
rem  ER diagram tool - release build (Windows only)
rem
rem  Builds the distribution ZIP: server\build\dist\erd.zip
rem    1. npm install for viewer/ (first run only)
rem    2. viewer build (single index.html)
rem    3. erd-server.jar (shadowJar)
rem    4. assemble the ZIP (architecture doc section 3.1)
rem
rem  Requires: Node.js (npm) and JDK 17+ (JAVA_HOME or PATH)
rem  Option:   --no-pause  do not wait for a key at the end
rem
rem  NOTE: keep this file ASCII-only. cmd.exe mis-parses batch
rem  files that contain multibyte text (both UTF-8 and CP932,
rem  depending on the console codepage), executing garbled
rem  line fragments as commands.
rem ============================================================
setlocal
cd /d "%~dp0"

set "NOPAUSE="
if /i "%~1"=="--no-pause" set "NOPAUSE=1"

echo === ER diagram tool: build distribution ZIP ===
echo.

rem ---- prerequisites ----
where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm not found. Install Node.js and add it to PATH.
    goto :fail
)
if defined JAVA_HOME goto :java_ok
where java >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Java not found. Install JDK 17+ and set JAVA_HOME or add java to PATH.
    goto :fail
)
:java_ok

rem ---- viewer dependencies (first run only) ----
if not exist "viewer\node_modules" (
    echo --- npm install ^(first run only^) ---
    pushd viewer
    call npm install
    if errorlevel 1 (
        popd
        goto :fail
    )
    popd
    echo.
)

rem ---- build all (gradle runs: viewer build -> shadowJar -> ZIP) ----
echo --- build: viewer -^> erd-server.jar -^> ZIP ---
pushd server
call .\gradlew.bat packageDist --console=plain
if errorlevel 1 (
    popd
    goto :fail
)
popd

echo.
echo === DONE ===
for %%f in ("server\build\dist\erd.zip") do echo output: %%~ff
echo Upload this ZIP to GitHub Releases manually.
if not defined NOPAUSE pause
exit /b 0

:fail
echo.
echo [ERROR] Build failed. Check the log above.
if not defined NOPAUSE pause
exit /b 1
