# 詳細設計: フェーズ7 — 追加 DB の検証（SQL Server / Oracle / SQLite）

設計書 §1.3 は「**JDBC ドライバがあれば原則すべての DB に対応する**」「その他（SQL Server,
Oracle, SQLite, H2 …）は、ユーザーが JDBC ドライバの jar を追加するだけで、JDBC 標準メタデータの
範囲で動作する」と定める。フェーズ7では、これを **代表的な非 PostgreSQL / MySQL の DB で実際に
確かめる**。焦点は「**層1（`JdbcIntrospector`）だけで内省が成立するか**」であり、Enhancer（層2）は
対象外（PostgreSQL / MySQL のみ同梱）。

## 1. 検証の形

H2 の検証（`JdbcIntrospectorTest`）と**同じスキーマ**（`users` / `orders` /
`flyway_schema_history`）を各 DB の方言で用意し、内省結果を突き合わせる。DDL は
`dev-db/ddl/{sqlite,sqlserver,oracle}.sql` に置き、**手動 GUI 検証と自動テストで共有する**
（二重管理を避ける）。

| DB | ドライバ | 実行環境 | テスト |
|---|---|---|---|
| SQLite | `org.xerial:sqlite-jdbc` | **プロセス内**（docker 不要） | `SqliteIntrospectorTest`（常時実行） |
| SQL Server | `com.microsoft.sqlserver:mssql-jdbc` | docker compose（profile: `mssql`） | `SqlServerIntrospectorTest`（未起動なら skip） |
| Oracle | `com.oracle.database.jdbc:ojdbc11` | docker compose（profile: `oracle`、gvenzl/oracle-free） | `OracleIntrospectorTest`（未起動なら skip） |

- ドライバはいずれも **`testImplementation`** にとどめる。配布物には同梱せず、利用者が `drivers/` に
  自分で置く前提（設計書 §7.2）を崩さないため。
- SQL Server / Oracle のテストは `@BeforeEach` で接続を試み、失敗したら `assumeTrue` で **skip**
  する。Docker を CI の必須ゲートにしない（設計書 §2.1 の Testcontainers と同じ扱い）。
- 実行手順は [dev-db/README.md](../../dev-db/README.md#追加-db-の検証phase-7-sql-server--oracle--sqlite) を参照。

## 2. 検証で判明した DB ごとの挙動

層1だけで内省するうえで各 DB に固有の癖がある。**忠実性のため `type` は DB 生の原文を保ち、
表示・比較には正規化型 `logicalType` を使う**（設計書 §5.7）という二重保持の方針が、ここで効く。

### 2.1 SQLite

- **ネームスペースが無い。** `getSchemas()` が空 → catalog モードにフォールバックする経路
  （設計書 §7.3）を通る。`namespaces()` は空リストを返し、内省は名前空間を空文字で行う。
- **型アフィニティ。** SQLite は宣言型を緩く扱い、`NUMERIC(12,2)` を JDBC の `DATA_TYPE=FLOAT`
  で返す。`TYPE_NAME` は `NUMERIC` のままなので、**TYPE_NAME が numeric / decimal のものは
  固定小数点（decimal）に救う**ようにした（`TypeMapper`）。`type` は原文 `numeric` を保持する。
- **COLUMN_SIZE が番兵値。** TEXT・NUMERIC などに対して `COLUMN_SIZE = 2000000000` を返す。
  これをそのまま桁として付けると `text(2000000000)` のような無意味な型が `data/schema/**.js` に
  載る。**上限（`MAX_DECLARED_SIZE = 1_000_000`）を超える COLUMN_SIZE は「無制限」とみなし、
  桁を書き出さない**ようにした（`TypeMapper`）。これは SQLite に限らず、無制限型に大きな値を返す
  任意のドライバに効く堅牢化。
- コメント構文（`COMMENT ON`）が無いため、論理名のコメント補完（K-14）は対象外。
- 内部テーブル（`sqlite_schema` / `sqlite_sequence`）は `getTables(type=TABLE)` で除外され、
  内省結果に現れない。

> **上の2点（型アフィニティ・番兵 COLUMN_SIZE）は `TypeMapper` を実際に直したフェーズ7の成果。**
> SQLite の検証が無ければ、無意味な桁付き型が出力に混入していた。

### 2.2 SQL Server

- **スキーマモード。** `getSchemas()` が `dbo` を返す。名前空間は `dbo`、データベースは catalog。
- **IDENTITY** 列は `IS_AUTOINCREMENT=YES` で取れる。
- 型: `NVARCHAR`→string / `BIT`→bool / `DATETIME2`→datetime / `NUMERIC`→decimal。
- **表・列コメントは JDBC の `REMARKS` に出ない**（拡張プロパティに入るため）。コメント補完
  （K-14）は PostgreSQL / Oracle 側で検証する。
- 既定 DB（master）に検証用 DB が無いため、docker compose の `sqlserver-init` が
  `erd_sample` を作成する。

### 2.3 Oracle

- **識別子を既定で大文字に畳む。** テーブル名・カラム名が `USERS` / `EMAIL` のように大文字で返る。
  内省・除外パターン照合ともに、返ってきた大文字の名前で一貫して扱えることを確認した。
- **コメントは接続プロパティが要る。** `oracle.jdbc.remarksReporting=true` を付けないと
  `REMARKS` が空になる。テストはこのプロパティを付けて接続し、コメント補完（K-14）の前提が
  満たせることを確認する。実運用でも、Oracle に対してはこのプロパティを付けて接続する必要がある
  （接続 UI の「追加プロパティ」§7.5 で指定できる）。
- 型: `VARCHAR2`→string / `CLOB`→string / `TIMESTAMP`→datetime / `NUMBER`系→decimal。
  Oracle の `NUMBER` は整数用途でも固定小数点として扱われる（`id` も logicalType は decimal）。
- **12c+ の `GENERATED ... AS IDENTITY`** は `IS_AUTOINCREMENT=YES` で取れる。

## 3. 運用上の含意（接続 UI・ドライバ）

- 新しい DB を使うときは、その JDBC ドライバ jar を `drivers/` に置くだけでよい（設計書 §3.2 / §7.2）。
  ロード済みドライバは `GET /__erd/drivers` に出る。
- **Oracle のコメント取得**のように、DB によっては接続プロパティが要るものがある。接続フォームの
  「追加プロパティ」（§7.5）で `oracle.jdbc.remarksReporting=true` のように渡す。
- Enhancer（層2）が無い DB では、CHECK 制約・部分/式インデックス・ENUM 値は取得されない
  （設計書 §7.4）。必要になった時点で `DialectEnhancer` を追加する（任意）。
