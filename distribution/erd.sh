#!/bin/sh
# ER diagram management tool startup script (macOS / Linux)
#   ./erd.sh          Start the server (default)
#   ./erd.sh export   Export a viewer ZIP for people who do not use Git / Java
cd "$(dirname "$0")" || exit 1
exec java -jar erd-server.jar "$@"
