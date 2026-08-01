#!/bin/bash
# Oracle（gvenzl/oracle-free）の初期スキーマ投入。
#
# gvenzl のフック（/container-entrypoint-initdb.d）は **.sql を "sqlplus / as sysdba" で流す**。
# そのまま 000_init.sql を置くと CDB ルートの SYS スキーマに作られてしまうため、この .sh から
# アプリユーザー（APP_USER = erd → スキーマ ERD）で接続し直して流す。
# 000_init.sql 自体は /erd/ にマウントする（フックに拾わせない）。
#
# フックが走るのは**データベースを作った初回だけ**なので、冪等性は考えなくてよい。
set -eu

export NLS_LANG=.AL32UTF8   # 表コメントの日本語を化けさせない

echo "CONTAINER: applying /erd/000_init.sql as ${APP_USER}"
sqlplus -s -L "${APP_USER}/${APP_USER_PASSWORD}@//localhost:1521/${ORACLE_DATABASE:-FREEPDB1}" <<'SQL'
WHENEVER SQLERROR EXIT SQL.SQLERROR
SET DEFINE OFF
@/erd/000_init.sql
EXIT
SQL
echo "CONTAINER: DONE applying /erd/000_init.sql"
