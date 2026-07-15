-- 追加 DB 検証用スキーマ（SQLite）。Phase 7。
--
-- H2 の検証（JdbcIntrospectorTest）と同じ形（users / orders / flyway_schema_history）を
-- SQLite の方言で表現し、層1（JDBC 標準メタデータ）だけで内省できることを確かめる。
-- SQLite にはスキーマ（ネームスペース）の概念が無く、コメント構文（COMMENT ON）も無い。
--
-- 文は「1文 = セミコロン終端、文中にセミコロンを含めない」で書く（テストの素朴な分割器のため）。

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  org_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX users_email_key ON users(email);

CREATE INDEX idx_users_created_at ON users(created_at);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  total NUMERIC(12, 2) NOT NULL,
  CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE flyway_schema_history (installed_rank INTEGER PRIMARY KEY);
