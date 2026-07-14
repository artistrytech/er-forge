/**
 * 最小のマイグレーション実行ツール。
 *
 *   node migrate.mjs status   適用済み / 未適用の一覧を表示する
 *   node migrate.mjs up       未適用のマイグレーションを順に適用する
 *   node migrate.mjs up 003   003 まで適用して止める（逆生成を段階的に試すため）
 *
 * 仕組みはこれだけ:
 * - `migrations/*.sql` をファイル名の昇順に適用する（連番を先頭に付ける）
 * - 適用済みかどうかは管理テーブル1つで判断する
 * - 1ファイル = 1トランザクション。失敗したらロールバックし、記録も残さない
 *   （PostgreSQL は DDL もトランザクションに入るため、中途半端な適用が残らない）
 *
 * 管理テーブルは **public ではなく専用スキーマ（erd_migrate）に置く**。
 * public に置くと、このツール自身の管理テーブルが逆生成の対象になり、
 * ER図に無関係なテーブルが現れてしまう（実在のマイグレーションツールが public に
 * 履歴テーブルを作る場合は、無視リスト K-15 に登録して除外する）。
 *
 * 接続先は docker compose の DB（localhost:5442）。DATABASE_URL で上書きできる。
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "migrations");
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://erd:erd@localhost:5442/erd_sample";

const SCHEMA = "erd_migrate";
const TABLE = `${SCHEMA}.schema_migrations`;

function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

async function applied(client) {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const res = await client.query(`SELECT version FROM ${TABLE} ORDER BY version`);
  return new Set(res.rows.map((r) => r.version));
}

async function status(client) {
  const done = await applied(client);
  for (const file of migrationFiles()) {
    console.log(`${done.has(file) ? "適用済み" : "未適用  "}  ${file}`);
  }
  const pending = migrationFiles().filter((f) => !done.has(f)).length;
  console.log(`\n未適用: ${pending} 件`);
}

/** @param until 指定すると、ファイル名がこの文字列で始まるものまで適用して止める */
async function up(client, until) {
  const done = await applied(client);
  let count = 0;
  for (const file of migrationFiles()) {
    if (!done.has(file)) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(`INSERT INTO ${TABLE} (version) VALUES ($1)`, [file]);
        await client.query("COMMIT");
        console.log(`適用: ${file}`);
        count++;
      } catch (e) {
        await client.query("ROLLBACK");
        console.error(`失敗: ${file}\n  ${e.message}`);
        process.exitCode = 1;
        return;
      }
    }
    // 停止判定は「適用済みかどうか」に関わらず行う。
    // 適用済みを飛ばすときに一緒に飛ばすと、up 001 が全件適用してしまう
    if (until !== undefined && file.startsWith(until)) break;
  }
  console.log(count === 0 ? "未適用のマイグレーションはありません。" : `${count} 件を適用しました。`);
}

const [command = "status", arg] = process.argv.slice(2);
const client = new pg.Client({ connectionString: DATABASE_URL });
try {
  await client.connect();
} catch (e) {
  console.error(`DB に接続できません（${DATABASE_URL}）: ${e.message}`);
  console.error("docker compose up -d で起動しているか確認してください。");
  process.exit(1);
}
try {
  if (command === "status") {
    await status(client);
  } else if (command === "up") {
    await up(client, arg);
  } else {
    console.error(`使い方: node migrate.mjs [status|up] [連番]`);
    process.exitCode = 1;
  }
} finally {
  await client.end();
}
