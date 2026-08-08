#!/bin/sh
# ============================================================
#  ER diagram tool - release build (macOS / Linux)
#  POSIX shell version of build-dist.bat. Behavior is the same.
#
#  Creates the distribution ZIP: server/build/dist/ERForge-<VERSION>.zip
#    1. npm ci in viewer/ (first run only)
#    2. Build the viewer (single index.html)
#    3. Build erd-server.jar (shadowJar)
#    4. Assemble the ZIP (design doc section 3.1)
#
#  Requirements: Node.js (npm) and JDK 17+ (JAVA_HOME or PATH)
#  Option: --no-pause  Do not wait for key input at the end
# ============================================================
set -e
cd "$(dirname "$0")"

NOPAUSE=""
if [ "$1" = "--no-pause" ]; then
    NOPAUSE=1
fi

# Do not wait when not running in an interactive terminal, so CI can call this as-is.
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
    echo "--- npm ci (first run only) ---"
    (cd viewer && npm ci)
    echo
fi

# ---- build all (gradle runs: viewer build -> shadowJar -> ZIP) ----
# ERD_RELEASE=1 marks this as a release build. The version embedded into
# index.html and erd-server.jar becomes the exact VERSION value.
# Other builds get a -dev suffix so they are easy to distinguish.
echo "--- build: viewer -> erd-server.jar -> ZIP ---"
export ERD_RELEASE=1
(cd server && chmod +x ./gradlew && ./gradlew packageDist --console=plain)

trap - EXIT

echo
echo "=== DONE ==="
# build.gradle.kts assembles the ZIP name from VERSION, the single source of truth.
# This is an ERD_RELEASE=1 release build, so no -dev suffix is added.
VERSION=$(tr -d ' \t\r\n' < VERSION)
echo "output: $(pwd)/server/build/dist/ERForge-$VERSION.zip"
echo "Upload this ZIP to GitHub Releases manually."
if [ -z "$NOPAUSE" ]; then
    printf 'Press Enter to continue...'
    read -r _
fi
exit 0
