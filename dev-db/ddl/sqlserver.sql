-- 追加 DB 検証用スキーマ（SQL Server / T-SQL）。Phase 7。
--
-- H2 の検証（JdbcIntrospectorTest）と同じ形（users / orders / flyway_schema_history）を
-- SQL Server の方言で表現する。スキーマは既定の dbo。
--
-- 確かめたいこと:
--   - スキーマモード（getSchemas() が dbo を返す）で内省できる
--   - IDENTITY 列が autoIncrement として取れる
--   - NVARCHAR / DATETIME2 / NUMERIC / BIT の logicalType 正規化
--   - ユニークインデックスと非ユニークインデックスの振り分け、FK の ON DELETE
--
-- 注意: SQL Server の表・列コメントは拡張プロパティに入り JDBC の REMARKS には出ない。
-- コメント（論理名の初期値補完）は PostgreSQL / Oracle 側で検証する。
--
-- 文は「1文 = セミコロン終端、文中にセミコロンを含めない」で書く（テストの素朴な分割器のため）。
-- DROP は冪等化のためテスト側が事前に流す（ここには置かない）。

CREATE TABLE dbo.users (
  id BIGINT IDENTITY(1, 1) PRIMARY KEY,
  email NVARCHAR(255) NOT NULL,
  org_id BIGINT NULL,
  is_active BIT NOT NULL DEFAULT 1,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

CREATE UNIQUE INDEX users_email_key ON dbo.users(email);

CREATE INDEX idx_users_created_at ON dbo.users(created_at);

CREATE TABLE dbo.orders (
  id BIGINT IDENTITY(1, 1) PRIMARY KEY,
  user_id BIGINT NOT NULL,
  total NUMERIC(12, 2) NOT NULL,
  CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES dbo.users(id) ON DELETE CASCADE
);

CREATE TABLE dbo.flyway_schema_history (installed_rank INT PRIMARY KEY);
