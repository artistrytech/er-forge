#!/bin/bash
# SQL Server の初期化（erd_sample データベース + 初期スキーマ）。
#
# SQL Server のイメージには初期化フックが無いため、compose の使い捨てサービス
# （sqlserver-init）がこのスクリプトを1回だけ実行する。
#
# **冪等にしておく必要がある**。docker compose up をもう一度打つと（コンテナが残っていても）
# このサービスは再実行されるため、素直に流すと CREATE TABLE が既存テーブルとぶつかって
# 毎回エラー終了する。テーブルが1つでもあれば何もしない。
set -eu

SQLCMD=/opt/mssql-tools18/bin/sqlcmd
SERVER=sqlserver
SA_PASSWORD="${MSSQL_SA_PASSWORD}"

run() {
    "$SQLCMD" -S "$SERVER" -U sa -P "$SA_PASSWORD" -C "$@"
}

run -Q "IF DB_ID('erd_sample') IS NULL CREATE DATABASE erd_sample"

tables=$(run -d erd_sample -h -1 -W -Q "SET NOCOUNT ON
SELECT COUNT(*) FROM sys.tables" | tr -d '[:space:]')

if [ "$tables" = "0" ]; then
    echo "applying /erd/000_init.sql"
    # -f 65001: DDL の日本語コメントを UTF-8 として読ませる
    run -d erd_sample -f 65001 -i /erd/000_init.sql
    echo "done"
else
    echo "erd_sample already has $tables table(s) - skipping the initial schema"
fi
