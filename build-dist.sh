#!/bin/sh
# ============================================================
#  ER diagram tool - release build (macOS / Linux)
#  build-dist.bat の POSIX shell 版。動作は同じ。
#
#  配布 ZIP を作る: server/build/dist/erd.zip
#    1. viewer/ の npm install（初回のみ）
#    2. ビューアのビルド（単一 index.html）
#    3. erd-server.jar（shadowJar）
#    4. ZIP の組み立て（設計書 §3.1）
#
#  必要: Node.js (npm) と JDK 17+（JAVA_HOME か PATH）
#  オプション: --no-pause  最後にキー入力を待たない
# ============================================================
set -e
cd "$(dirname "$0")"

NOPAUSE=""
if [ "$1" = "--no-pause" ]; then
    NOPAUSE=1
fi

# 対話端末でなければ待たない（CI からそのまま呼べるように）
if [ ! -t 0 ]; then
    NOPAUSE=1
fi

fail() {
    trap - EXIT
    echo
    echo "[ERROR] Build failed. Check the log above."
    if [ -z "$NOPAUSE" ]; then
        printf 'Press Enter to continue...'
        read -r _
    fi
    exit 1
}
trap fail EXIT

echo "=== ER diagram tool: build distribution ZIP ==="
echo

# ---- prerequisites ----
if ! command -v npm >/dev/null 2>&1; then
    echo "[ERROR] npm not found. Install Node.js and add it to PATH."
    exit 1
fi
if [ -z "$JAVA_HOME" ] && ! command -v java >/dev/null 2>&1; then
    echo "[ERROR] Java not found. Install JDK 17+ and set JAVA_HOME or add java to PATH."
    exit 1
fi

# ---- viewer dependencies (first run only) ----
if [ ! -d "viewer/node_modules" ]; then
    echo "--- npm install (first run only) ---"
    (cd viewer && npm install)
    echo
fi

# ---- build all (gradle runs: viewer build -> shadowJar -> ZIP) ----
echo "--- build: viewer -> erd-server.jar -> ZIP ---"
(cd server && chmod +x ./gradlew && ./gradlew packageDist --console=plain)

trap - EXIT

echo
echo "=== DONE ==="
echo "output: $(pwd)/server/build/dist/erd.zip"
echo "Upload this ZIP to GitHub Releases manually."
if [ -z "$NOPAUSE" ]; then
    printf 'Press Enter to continue...'
    read -r _
fi
exit 0
