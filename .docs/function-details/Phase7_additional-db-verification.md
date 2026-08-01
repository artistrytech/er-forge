# 詳細設計: フェーズ7 — 追加 DB の検証（SQL Server / Oracle / SQLite）

設計書 §1.3 は「**JDBC ドライバがあれば原則すべての DB に対応する**」「その他（SQL Server,
Oracle, SQLite, H2 …）は、ユーザーが JDBC ドライバの jar を追加するだけで、JDBC 標準メタデータの
範囲で動作する」と定める。フェーズ7では、これを **代表的な非 PostgreSQL / MySQL の DB で実際に
確かめる**。焦点は「**層1（`JdbcIntrospector`）だけで内省が成立するか**」であり、Enhancer（層2）は
対象外（PostgreSQL / MySQL のみ同梱）。

## 1. 検証の形

同梱サンプルの元データ（`dev-db/postgresql/migrations/000_init.sql`。26テーブル）を各 DB の
方言へ移植したものを用意し、内省結果を突き合わせる。DDL は
`dev-db/{sqlite,sqlserver,oracle}/migrations/000_init.sql` に置き、**手動 GUI 検証と自動テストで
共有する**（二重管理を避ける）。製品ごとの移植で変えたところは各ファイルの先頭に書いてある。

段階的なスキーマ変更（`001`〜`008`）は **PostgreSQL でのみ**用意する。差分検出・リネーム候補の
検証は層1に依存しないため製品ごとに繰り返す意味が薄く、`001` が扱う ENUM・部分インデックス・
式インデックスに至っては、拾う側の層2（`DialectEnhancer`）が PostgreSQL / MySQL にしか無い。

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
- **UNIQUE 制約の名前が残らない。** 表制約として書くと裏付けインデックスは
  `sqlite_autoindex_<表>_<連番>` になり、制約名が失われる。移植版では `CREATE UNIQUE INDEX` で
  明示的に名前を付け、他製品と内省結果が揃うようにしている。

> **上の2点（型アフィニティ・番兵 COLUMN_SIZE）は `TypeMapper` を実際に直したフェーズ7の成果。**
> SQLite の検証が無ければ、無意味な桁付き型が出力に混入していた。

### 2.2 SQL Server

- **スキーマモード。** `getSchemas()` が `dbo` を返す。名前空間は `dbo`、データベースは catalog。
- **IDENTITY** 列は `IS_AUTOINCREMENT=YES` で取れる。
- 型: `NVARCHAR`→string / `NVARCHAR(MAX)`→string / `DATETIME2`→datetime / `DATE`→date /
  `NUMERIC`→decimal / `INT`→int。
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
- **`ON DELETE` を書かない FK が `restrict` になる。** Oracle に `NO ACTION` は無く、ドライバは
  `DELETE_RULE = importedKeyRestrict` を返す。同じ DDL でも SQL Server / SQLite は `no action`
  になるため、**FK の削除規則は製品差がそのまま内省結果に出る**（26テーブルの移植版を
  3製品で流して確認した）。逆生成した定義を製品間で比較するときの注意点。
- **予約語は引用符が要る。** `COMMENT` は Oracle の予約語のため、移植版では `"COMMENT"` と
  書いている。大文字で引用しているので、内省結果は引用しない識別子と同じ大文字になる。

## 3. 運用上の含意（接続 UI・ドライバ）

- 新しい DB を使うときは、その JDBC ドライバ jar を `drivers/` に置くだけでよい（設計書 §3.2 / §7.2）。
  ロード済みドライバは `GET /__erd/drivers` に出る。
- **Oracle のコメント取得**のように、DB によっては接続プロパティが要るものがある。接続フォームの
  「追加プロパティ」（§7.5）で `oracle.jdbc.remarksReporting=true` のように渡す。
- Enhancer（層2）が無い DB では、CHECK 制約・部分/式インデックス・ENUM 値は取得されない
  （設計書 §7.4）。必要になった時点で `DialectEnhancer` を追加する（任意）。
