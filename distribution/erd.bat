@echo off
rem ============================================================
rem  ER diagram tool - launcher (Windows)
rem    erd.bat          Start the server (default; also double-click)
rem    erd.bat export   Write a viewer-only ZIP for people without Git/Java
rem    erd.bat help     Show usage
rem
rem  NOTE: keep this file ASCII-only. cmd.exe reads the batch file with the
rem  console codepage before "chcp 65001" takes effect, so multibyte comments
rem  get garbled and their fragments are executed as commands.
rem ============================================================
chcp 65001 > nul
cd /d "%~dp0"
java -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 -jar erd-server.jar %*
rem  Keep the window open on failure (double-click use), but still report the
rem  exit code so "erd.bat export" can be used from a script.
if errorlevel 1 (
    pause
    exit /b 1
)
