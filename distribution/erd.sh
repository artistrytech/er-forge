#!/bin/sh
# ER図管理ツール サーバーモード起動スクリプト（macOS / Linux）
cd "$(dirname "$0")" || exit 1
exec java -jar erd-server.jar
