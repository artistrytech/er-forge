#!/bin/sh
# ER図管理ツール 起動スクリプト（macOS / Linux）
#   ./erd.sh          サーバーを起動する（既定）
#   ./erd.sh export   閲覧用 ZIP を書き出す（Git / Java を使わない相手に渡す用）
cd "$(dirname "$0")" || exit 1
exec java -jar erd-server.jar "$@"
