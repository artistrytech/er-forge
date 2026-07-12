@echo off
rem ER図管理ツール サーバーモード起動スクリプト（Windows）
chcp 65001 > nul
cd /d "%~dp0"
java -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 -jar erd-server.jar
if errorlevel 1 pause
