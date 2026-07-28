# 詳細設計: K-16 〜 K-18 — ビュー等の非テーブルオブジェクトの逆生成

設計書 §1.3 は「JDBC ドライバがあれば原則すべての DB に対応する」と定めるが、現行の
`JdbcIntrospector` は `getTables(..., new String[] { "TABLE" })` として**ビューを明示的に除外**して
いる。本設計は、この制限を外してビューを逆生成・ドキュメント化の対象に含める。

## 1. 方針

**「TABLE かそれ以外か」の二値だけを判断し、それ以外は DB が返した種別名をそのまま持って表示する。**
DB 製品ごとの分岐は層1（`JdbcIntrospector`）に一切入れない。

この方針を採る理由は次の3つである。

1. 種別の呼び方は DB ごとに違ううえ、同じ概念でも粒度が違う（PostgreSQL は
   `MATERIALIZED VIEW` を独立種別として返すが、**Oracle はマテリアライズドビューを `TABLE` として
   返す**）。正規化しようとすると DB 別分岐が層1に侵入する
2. ビューに対する PK / FK / インデックスは、標準メタデータを呼べば「取れる範囲で取れる」（後述の
   実測どおり例外は出ず、空か実データが返る）。**種別で処理を分岐する必要がない**
3. 未知の DB が新しい種別名を返しても、ルールが名前ベースなら自動的に追随する

### 1.1 スコープ

| 含む | 含まない（→ §11 実装未定） |
|---|---|
| ビュー等の一覧・列・コメントの取得（K-16） | ビュー → テーブルの依存関係の取得 |
| 種別（`kind`）の保存・差分・表示（K-16） | 依存エッジの描画（**描かないことが決定済み**） |
| 種別をまたぐリネーム候補の抑止（K-17） | Oracle のマテビュー判別（`ALL_MVIEWS`） |
| **ビュー定義 SQL の取得・保存・差分・表示（K-18）** | 差分プレビューの種別フィルタ |
| ER図へのノード表示（D-07）・カタログ詳細（O-10 / O-11） | ビュー列 → 元テーブル列の由来（lineage） |

定義 SQL（K-18）は標準メタデータでは取得できず、必ず DB 別のカタログ照会になる。これは層2
（`DialectEnhancer`）の担当であり、層1に分岐を入れない本方針と矛盾しない。**したがって層2の
Enhancer を持つ DB（PostgreSQL / MySQL）でのみ定義が取れる**（§8.4）。

## 2. 実測に基づく前提

設計判断の根拠として、`TableTypeProbeTest` で5つの DB を実測した結果を残す。ドライバを更新した際は
このプローブを流し直して前提が崩れていないか確認する。

| | H2 2.2.224 | SQLite 3.46 | PostgreSQL 16.9 | SQL Server 2022 | Oracle 23ai |
|---|---|---|---|---|---|
| `getTableTypes()` の種別数 | 5 | 4 | **18** | 3 | 3 |
| `types=null` の総件数 | 3 | 5 | **89** | 5 | 4 |
| うち不要（索引・列・同義語等） | 0 | 2 | **59** | 0 | 1 |
| 現行 `{"TABLE"}` | 2 | 2 | 27 | 4 | 2 |
| **本設計のルール** | **3** | **3** | **30** | **5** | **3** |

確定した事実は次のとおり。

- **`types=null`（全種別）は採れない。** PostgreSQL の `public` スキーマで 89件中59件が
  `INDEX`（35）と `SEQUENCE`（24）だった。これらはシステム領域ではないため、既存の
  ネームスペース指定では落ちない。Oracle では `SYNONYM` が同様に混入する
- **PostgreSQL の `PARTITIONED TABLE` は現行の `{"TABLE"}` では取れない。** pgjdbc は `"TABLE"` を
  relkind `'r'` にしか対応させないため、**パーティション親テーブルが逆生成に入っていない**
  （子パーティションは `TABLE` として個別に入る）。本設計のルール変更で自動的に解消する
- **H2 は `TABLE_TYPE` に `"BASE TABLE"` を返す。** 要求側は `"TABLE"` を受け付けるのに返す文字列は
  SQL 標準の呼称という非対称がある。`kind == "TABLE"` の二値判定をそのまま入れると、H2 では
  全テーブルが「特殊」に分類される（§3.2 の正規化が必要）
- **Oracle のマテリアライズドビューは `TABLE_TYPE=TABLE` として返る。** `getPrimaryKeys` が1行、
  `getIndexInfo` が2行返り、通常テーブルと区別がつかない。**現状すでに通常テーブルとして
  逆生成に取り込まれている**
- **ビュー列の NULL 可否は DB で真逆。** PostgreSQL / H2 / SQLite は元テーブルが NOT NULL でも
  **全列 `"YES"`** を返し、SQL Server / Oracle は元テーブル準拠で `"NO"` を返す。
  `IS_NULLABLE` が `""`（不明）を返す DB は1つも無く、
  [`JdbcIntrospector`](../../server/src/main/java/erd/introspect/JdbcIntrospector.java) の
  「IS_NULLABLE is unknown」警告が量産される懸念は**無い**
- **ビューの `REMARKS`**: PostgreSQL ○ / Oracle ○（`oracle.jdbc.remarksReporting=true` 必須）/
  SQL Server ✕ / H2・SQLite ✕。**ビュー列の `REMARKS` は5 DB すべて `null`** であり、
  K-14（論理名の初期値補完）はビュー列には実質効かない
- **ビューへの `getPrimaryKeys` / `getImportedKeys` は5 DB すべて 0行・例外なし。** マテビューへの
  `getIndexInfo` は PostgreSQL 1行 / Oracle 2行と実データが返る

## 3. データ形式

### 3.1 `kind` の追加

`data/schema/**.js` の machine-owned 領域に `kind` を追加する。

```js
ERD.table({
  id: "public.v_active_users",
  name: "v_active_users",
  schema: "public",
  kind: "VIEW",                      // ← 追加。DB が返した TABLE_TYPE の原文
  comment: "有効なユーザーの抽出",
  columns: [
    { name: "id",    type: "int4",    logicalType: "int",    nullable: true },
    { name: "email", type: "varchar", logicalType: "string", nullable: true },
  ],
  meta: { /* human-owned。テーブルと同じ */ },
});
```

| 項目 | 決定 |
|---|---|
| 出力位置 | `schema` の直後、`comment` の前（決定論的プリンタのキー順に固定） |
| 所有権 | **machine-owned**（§5.7 のキー所有権表に追加）。逆生成が上書きする |
| 値 | DB が返した `TABLE_TYPE` の原文。大文字小文字も変えない |
| **`"TABLE"` のときは出力しない** | §3.3 の互換性のため。読み込み時に欠落は `"TABLE"` とみなす |
| `schemaVersion` | **上げない**。キーの追加は前方互換（V-4。未知キーは保持される） |

### 3.2 正規化は `"BASE TABLE"` の1件だけ

```java
/** TABLE_TYPE の正規化。SQL 標準の別名だけを畳み、それ以外は原文を保つ。 */
static String normalizeKind(String tableType) {
    if (tableType == null) return "TABLE";
    String t = tableType.trim();
    return t.equalsIgnoreCase("BASE TABLE") ? "TABLE" : t;
}
```

`"BASE TABLE"` は SQL 標準における「TABLE」の呼称であり、製品名による分岐ではない。これ以外の
正規化（`MATERIALIZED VIEW` → `VIEW` など）は**行わない**。

判定は常に `"TABLE".equalsIgnoreCase(kind)` とする（ドライバによる表記揺れへの保険）。

### 3.3 既存プロジェクトとの互換性

**`kind == "TABLE"` を出力しないことが、この設計で最も重要な決定である。** 常に出力する設計にすると、
ビュー対応後の初回逆生成で**既存の全テーブルに `kind: "TABLE"` 追加の差分**が出る。数百テーブルの
プロジェクトでは、意味のある差分（ビューの追加）がノイズに埋もれる。

| 状況 | 挙動 |
|---|---|
| 既存ファイル（`kind` なし）を読む | `kind = "TABLE"` として扱う |
| `kind = "TABLE"` を書く | キーを出力しない |
| 既存プロジェクトを再逆生成 | **既存テーブルには差分が出ない**。新規に見つかったビューだけが追加として出る |
| 移行（`MigrationRunner`） | **不要**。移行を1件も追加しない |

### 3.4 型定義の変更

**Java** — [`TableSchema`](../../server/src/main/java/erd/core/model/TableSchema.java) に
`String kind` を `schema` の次に追加する。ただし `new TableSchema(...)` の呼び出しは本体・テストで
30箇所以上あるため、[`Table`](../../server/src/main/java/erd/core/model/Table.java) が
3引数の簡易コンストラクタを持つのと同じ形で、**`kind` を省いた9引数のコンストラクタを残す**
（`kind = "TABLE"` を補う）。これで既存の呼び出しは無改修で通り、変更が必要なのは
`JdbcIntrospector`・`DataFileParser`・`IntrospectApplier` の3箇所に限定される。

```java
public record TableSchema(
        String name, String schema, String kind, String comment,
        List<Column> columns, List<String> primaryKey, List<UniqueConstraint> uniques,
        List<IndexDef> indexes, List<ForeignKey> foreignKeys, Map<String, JsonNode> dialect) {

    public TableSchema {
        kind = (kind == null || kind.isBlank()) ? "TABLE" : kind;
        // 以降は現行どおり
    }

    /** kind を持たない既存の呼び出し（＝通常テーブル）向け。 */
    public TableSchema(String name, String schema, String comment, List<Column> columns,
                       List<String> primaryKey, List<UniqueConstraint> uniques,
                       List<IndexDef> indexes, List<ForeignKey> foreignKeys,
                       Map<String, JsonNode> dialect) {
        this(name, schema, "TABLE", comment, columns, primaryKey, uniques, indexes,
             foreignKeys, dialect);
    }

    /**
     * Jackson は {@code isXxx()} を bean のプロパティとみなす。{@code @JsonIgnore} が無いと
     * モデルの JSON 出力に {@code "table": true} という派生値が混入し、golden fixture が汚れる。
     */
    @JsonIgnore
    public boolean isTable() {
        return "TABLE".equalsIgnoreCase(kind);
    }
}
```

**TypeScript** — [`types.ts`](../../viewer/src/model/types.ts) の `zTable` と `zIndexTable` に
`kind: z.string().optional()` を追加する。**enum にはしない**（DB が返す任意の文字列を受けるため）。
省略時を `"TABLE"` として扱うヘルパを1つ置く。

```ts
export const isTableKind = (kind?: string) => !kind || kind.toUpperCase() === "TABLE";
```

## 4. K-16: 内省（層1）

### 4.1 対象種別の決定

`getTableTypes()` が返す種別を、**DB を問わない1つのルール**で絞る。

```java
/**
 * 取り込む種別か。「名前に TABLE か VIEW を含み、SYSTEM を含まない」だけで判断する。
 * 5 DB での実測（§2）で、索引・シーケンス・型・同義語・システム領域がすべて落ちることを確認済み。
 */
private static boolean isRelationLike(String tableType) {
    if (tableType == null) return false;
    String t = tableType.toUpperCase(Locale.ROOT);
    if (t.contains("SYSTEM")) return false;
    return t.contains("TABLE") || t.contains("VIEW");
}
```

各 DB での結果:

| DB | 採用 | 除外 |
|---|---|---|
| PostgreSQL | TABLE / VIEW / MATERIALIZED VIEW / FOREIGN TABLE / PARTITIONED TABLE / TEMPORARY TABLE / TEMPORARY VIEW | INDEX / PARTITIONED INDEX / SEQUENCE / TYPE / TEMPORARY INDEX / TEMPORARY SEQUENCE / SYSTEM * |
| Oracle | TABLE / VIEW | **SYNONYM** |
| SQL Server | TABLE / VIEW | SYSTEM TABLE |
| SQLite | TABLE / VIEW | SYSTEM TABLE / GLOBAL TEMPORARY |
| H2 | BASE TABLE / VIEW | GLOBAL TEMPORARY / LOCAL TEMPORARY / SYNONYM |

`TEMPORARY TABLE` / `TEMPORARY VIEW` が採用側に入るが、**PostgreSQL の一時オブジェクトは
`pg_temp_N` スキーマに属する**ため、ネームスペース指定（§1.2 の「1プロジェクト = 1スキーマ」）で
実質的に落ちる。ルールに条件を増やしてまで除外しない。

`getTableTypes()` が空を返す、または例外を投げるドライバに備え、
**フォールバックを `{"TABLE", "VIEW"}` とする**（現行の挙動を下回らない）。

### 4.2 `introspect` の変更点

[`JdbcIntrospector.introspect`](../../server/src/main/java/erd/introspect/JdbcIntrospector.java) の
変更は次の3点に閉じる。

1. **種別の決定と `getTables` の呼び出し**

```java
String[] types = relationLikeTypes(md);          // §4.1。失敗時は {"TABLE","VIEW"}
Map<String, String> kinds = new LinkedHashMap<>();
try (ResultSet rs = md.getTables(catalog, schema, "%", types)) {
    while (rs.next()) {
        String name = rs.getString("TABLE_NAME");
        if (!opts.accepts(ns, name)) continue;
        names.add(name);
        comments.put(name, trimToNull(rs.getString("REMARKS")));
        kinds.put(name, normalizeKind(rs.getString("TABLE_TYPE")));   // §3.2
    }
}
```

2. **`TableSchema` 生成時に `kind` を渡す**（`kinds.getOrDefault(name, "TABLE")`）

3. **制約取得を種別で分岐させない。** `getPrimaryKeys` / `getIndexInfo` / `getImportedKeys` は
   ビューに対してもそのまま呼ぶ。実測では5 DB とも例外を出さず、**マテビューでは実インデックスが
   取れる**（PostgreSQL 1行 / Oracle 2行）ため、呼ぶこと自体が有益である。ただし未知ドライバへの
   保険として、**テーブル1件ごとに try/catch し、失敗は警告にして続行する**（内省全体を止めない。
   §7.1 の2層構成と同じ思想）

```java
List<UniqueConstraint> uniques = new ArrayList<>();
List<IndexDef> indexes = new ArrayList<>();
try {
    indexes(md, catalog, schema, name, pk, uniques, indexes);
} catch (SQLException e) {
    warnings.add(name + ": Could not read index metadata (" + e.getMessage() + ")");
}
```

### 4.3 ビューの列の扱い

**特別扱いはしない。** `getColumns` は一括取得のままで、ビューの列も同じ経路で分配される
（`comments.containsKey(table)` の判定に載る）。

NULL 可否については、実測のとおり **PostgreSQL 系は全列 nullable、SQL Server / Oracle は元テーブル
準拠**と DB で意味が異なる。統一的に補正することも、統一的な注記を出すこともできないため、
**取れた値をそのまま保存・表示する**。

### 4.4 K-15（無視リスト）との関係

ビュー取り込みの ON/OFF を切り替える新しい設定は**設けない**。ビューを除外したい場合は、既存の
テーブル無視リスト（K-15、`config.js` の `ignoreTables`）に `public\.v_.*` のようなパターンを
登録する。

この判断には副次的な利点がある。取り込みフラグを設けると「フラグを OFF に戻した瞬間に全ビューが
削除候補になる」という問題（INV-6 が扱っているのと同じクラスの問題）を抱え込むが、無視リストは
**逆生成の入力と既存定義の双方から除外される**ため、この問題が構造的に起きない。

## 5. K-17: 差分と適用

### 5.1 `kind` の差分項目

`kind` は machine-owned なので、変更は差分項目として提示する（ドライバ更新で文字列が変わったときに
黙って書き換わらないようにするため）。

| 項目 | 値 |
|---|---|
| `id` | `table:<id>/kind` |
| `kind`（DiffItem の種別） | `"objectKind"` |
| `change` | `"modified"` |
| `selectable` | `true` |
| `before` / `after` | 種別名の原文 |

[`SchemaDiff.compare`](../../server/src/main/java/erd/core/diff/SchemaDiff.java) の `comment` 差分の
直後に追加する。`IntrospectApplier.merge` でも `comment` と同じ形で選択に応じて引き継ぐ。

### 5.2 種別をまたぐリネーム候補を出さない

[`RenameDetector.detectTables`](../../server/src/main/java/erd/core/diff/RenameDetector.java) は
**カラム構成シグネチャだけ**で比較する。ビューは元テーブルと列構成が一致することが多いため、
`users`（TABLE）と `v_users`（VIEW）が `COLUMNS_IDENTICAL`・スコア 1.0・確度「高」の
リネーム候補として提示されてしまう。

対策として、`SchemaDiff.plan` で `removedSchemas` / `addedSchemas` を**種別ごとにグループ分けし、
同じ種別どうしでのみ `detectTables` を呼ぶ**。

```java
// 種別をまたぐリネームは実在しない（DROP TABLE + CREATE VIEW は「削除 + 追加」である）
List<RenameCandidate> candidates = new ArrayList<>();
for (String kind : union(kindsOf(removedSchemas), kindsOf(addedSchemas))) {
    candidates.addAll(renames.detectTables(
            filterByKind(removedSchemas, kind), filterByKind(addedSchemas, kind)));
}
```

カラムのリネーム検出（`detectColumns`）は同一オブジェクト内の比較なので変更不要。

### 5.3 適用（`IntrospectApplier`）

- `merge` の戻り値を組み立てる `new TableSchema(...)` に `kind` を渡す。選択されていない `kind` 差分は
  旧値を保つ（`comment` と同じ扱い）
- `withForeignKeys` ヘルパも `kind` を引き継ぐ。**ここを落とすと、FK 剪定が走ったテーブルの
  `kind` が黙って `"TABLE"` に戻る**（INV-1 を破る典型的な見落とし）
- 追加されたビューは他のテーブルと同じく `TableMeta.EMPTY` で作られ、未配置トレイ（K-12）に入る
- ビューは FK を持たないため、参照整合性（V-2）の剪定ロジックには影響しない

### 5.4 ガード

初回のビュー取り込みでは、ビューの本数だけ「追加」項目が並ぶ。既存の `MASS_DELETE` /
`PLACED_DELETE` ガードは削除方向のみを見ているため**発火しない**。

差分プレビューで種別が読めるよう、追加・削除の要約に種別を前置する
（`VIEW, 2 columns`）。**種別による折りたたみ / 絞り込みは実装していない**（§11.4）。
ビューが数十本あるプロジェクトで初回プレビューが読みにくい場合に着手する。

## 6. 表示

### 6.1 `index.js`（D-07 の前提）

ER図はこの索引だけでノードを描くため、`kind` を索引にも載せる。

```js
ERD.index({
  tables: [
    { id: "public.users", name: "users", schema: "public", columns: 8, pk: true, diagrams: ["core"] },
    { id: "public.v_active_users", name: "v_active_users", schema: "public",
      kind: "VIEW", columns: 2, diagrams: ["core"] },
  ],
});
```

`kind == "TABLE"` のときは出力しない（§3.3 と同じ理由。索引は派生ファイルなので互換性の問題は
無いが、差分の読みやすさのため規則を揃える）。

### 6.2 D-07: ER図のノード

| | 表現 |
|---|---|
| 枠線 | **破線**（通常テーブルは実線） |
| バッジ | ノード名の脇に**種別名の原文**を小さく表示（`VIEW` / `MATERIALIZED VIEW` / `FOREIGN TABLE` …） |
| 色 | `meta.color` の指定色をそのまま使う。**種別による自動着色はしない**（色は human-owned。§5.7） |
| エッジ | **依存エッジは描かない**。ビューが関係を持つのは、人が論理外部制約（P-06）を書いた場合のみ |

種別名は DB の原文であり翻訳しないため、i18n の対象外とする（バッジのラベル自体が値）。

> **ビューは既定で孤立ノードになる。** 依存エッジを描かない決定の当然の帰結であり、ER図上で
> ビューと元テーブルを結びたい場合は論理外部制約を人が定義する。この運用は MySQL のように
> 依存関係を自動取得できない DB でも同じように機能するという利点がある。

### 6.3 O-10: カタログのオブジェクト詳細

- 種別バッジを出す（ER図と同じ表記）。編集の可否には触れない（§7 のとおりテーブルと同じ）
- **空のセクションを出さない。** ビューでは主キー・ユニーク・インデックス・外部キーが空になるのが
  普通なので、「制約なし」の空カードを4つ並べない
- 被参照（他テーブルからの参照）は現行どおり表示する。ビューを参照する論理外部制約があれば出る
- **NULL 可否は取れた値をそのまま出す。** DB による意味の違い（§2）を UI で吸収しようとしない
- 左パネルの行にも種別を出し、**検索語が種別名にも当たる**ようにする（`view` と打てばビューだけ残る）。
  種別専用のフィルタ UI は設けない（既存の検索入力1本に寄せる）

### 6.4 差分プレビュー（`DiffTree`）

- 新しい項目種別 `objectKind` のラベルを i18n に追加
- 追加・削除の要約に種別を前置する（`VIEW, 2 columns`）

## 7. 編集機能との整合

**ビューはテーブルとまったく同じように編集できる。種別による分岐を編集系に一切持ち込まない。**

| 機能 | ビューでの扱い |
|---|---|
| 編集画面（O-03）への導線 | テーブルと同じ。ヘッダのペンアイコンから入る |
| `meta` の編集（論理名・タグ・色・注記） | 許可。ドキュメント化の中心 |
| 論理制約（P-01〜P-09） | 許可。ビュー間・ビュー↔テーブルの関係を人が表現する唯一の手段（§6.2） |
| ER図への配置・レイアウト（H 系） | 許可。ノードとして通常どおり扱う |
| `TableService` の種別チェック | **持たない** |

### 7.1 なぜ「ビューのスキーマを読み取り専用にする」を採らないのか

当初は「ビューは DB 側で生成されるものだから、列や制約を人が編集できると *DDL を発行するのか* という
誤解を生む」と考え、`kind != "TABLE"` のスキーマ更新を `TableService` で拒否し、UI の編集導線も
出さない設計にしていた。**これは誤りだった。**

現状のテーブル編集画面（[`TableEdit`](../../viewer/src/catalog/TableEdit.tsx)）が扱えるのは
**human-owned（`meta`）だけ**である。カラムや制約の編集（J-03 / J-04）は未実装で、保存要求も
`meta` しか送らない。つまり守るべき「スキーマの手動編集」がそもそも存在しない。

その状態で種別ガードを入れると、防げるものが何も無いまま**ビューの論理名・タグ・注記の編集まで
塞いでしまう**（編集導線ごと消えるため）。ドキュメント化という本機能の目的に真っ向から反する。

> **将来 J-03 / J-04（カラム・制約の手動編集）を実装するときに、この判断を見直すこと。**
> そのときは「ビューではカラム編集の UI を出さない」という形になるはずで、
> 種別で編集の入口ごと塞ぐ形には戻さない（`meta` の編集は常に許す）。

## 8. K-18: ビュー定義 SQL

ビューは「どんな列があるか」だけでは説明にならない。**何を抽出しているのか**が本体であり、
ドキュメント化という目的からすればここが中心になる。

### 8.1 なぜ `dialect` に入れないのか

`dialect` は差分検出で**マップ全体を1項目として**比較する
（[`SchemaDiff`](../../server/src/main/java/erd/core/diff/SchemaDiff.java) の `dialect` 比較）。
定義をここに入れると、差分プレビューに出るのは「dialect が変わった」という1行と、
JSON を丸ごと文字列化した before / after だけになり、**何がどう変わったのか読めない**。

そこで `TableSchema.definition` という**一級のフィールド**に置き、専用の差分項目
（`kind = "definition"`）を出す。

### 8.2 なぜ行の配列で持つのか

[`JsText.quote`](../../server/src/main/java/erd/core/io/JsText.java) は `\n` をエスケープする。
定義を1本の文字列で持つと、複数行の SQL が**1行の巨大なリテラル**になり、
「1つの変更 = 1行の差分」（INV-5）が壊れる。WHERE 句を1つ足しただけで数百文字の行がまるごと
置き換わった差分になり、レビューできない。

```js
definition: [
  " SELECT u.id,",
  "    u.email,",
  "    o.id AS order_id",
  "   FROM users u",
  "     LEFT JOIN orders o ON o.user_id = u.id",
  "  WHERE u.email IS NOT NULL;",
],
```

出力位置は `foreignKeys` の後・`dialect` の前。ビューでは制約がすべて空になるため、
実際にはカラム表のすぐ下に来る。

### 8.3 行分割の決定論性

同じ定義から常に同じ配列が出ないと、意味のない Git 差分が出る
（`Dialects.Builder.splitLines`）。

- 改行コードを `\n` に正規化（CRLF / CR を吸収）
- 各行の**行末の空白を落とす**
- 先頭と末尾の空行を捨てる
- それ以外は DB が返したまま。**サーバー側で SQL を整形しない**

### 8.4 取得元と DB ごとの差

| DB | 取得元 | 状況 |
|---|---|---|
| PostgreSQL | `pg_get_viewdef(oid, true)`（`relkind IN ('v','m')`） | **実装済み。** 整形済みの複数行で返る。マテビューも取れる |
| MySQL | `information_schema.VIEWS.VIEW_DEFINITION` | **実装済み。** ただし整形されず**1行で返る**（後述） |
| SQL Server | `sys.sql_modules.definition` | **未実装**（層2の Enhancer が無い） |
| Oracle | `ALL_VIEWS.TEXT`（LONG 型） | **未実装**（層2の Enhancer が無い） |
| SQLite | `sqlite_master.sql` | **未実装**（層2の Enhancer が無い） |

**MySQL は定義を1行で返す。** PostgreSQL の `pg_get_viewdef(oid, true)` と違って改行を復元する
手段が無く、`definition` は1要素の配列になる。定義を変えると1行まるごとの差分になるが、
**整形して行に割るのはサーバー側に SQL パーサを抱えることを意味する**ため採らない
（正確さを優先し、DB が返したものをそのまま保つ）。

SQL Server / Oracle / SQLite に定義が要るなら、それぞれの `DialectEnhancer` を追加する。
層1には手を入れずに済む（設計書 §7.1 の2層構成が意図どおり効く箇所）。

### 8.5 「取れなかった」と「消えた」を区別する

層2の Enhancer は権限やバージョンで失敗しうる（`Dialects.enhance` が警告に落として続行する）。
そのとき定義は空で返ってくるが、**これを「定義が削除された」差分にしてはならない。**
毎回の逆生成で削除候補が出続け、差分プレビューが信用されなくなる。

そこで差分・適用の両方で、**新しい定義が空のときは既存の定義を保つ**。

```java
// SchemaDiff: 空になった定義は差分にしない
if (!oldSchema.definition().equals(neu.definition()) && !neu.definition().isEmpty()) { ... }

// IntrospectApplier: 空で上書きしない
List<String> definitionValue = neu.definition().isEmpty() ? oldSchema.definition() : ...;
```

### 8.6 表示（O-11）

- カタログのオブジェクト詳細に「定義」セクションを置き、行を改行で繋ぎ直して等幅ブロックで出す。
  **長い行は折り返さず横スクロールさせる**（SQL は行の対応が読めることが重要で、折り返すと
  行番号の感覚が壊れる）
- 差分プレビューでは、`definition` 項目だけ before / after を**ブロックで縦に並べる**
  （他の項目と同じ行内表示にすると読めない）

## 9. 移行と互換性

| 観点 | 結論 |
|---|---|
| `manifest.schemaVersion` | **上げない**。キーの追加は前方互換（V-4） |
| `Migration` の追加 | **不要** |
| 旧ビューアで新データを開く | `kind` は未知キーとして無視され、**ビューが通常テーブルとして描画される**。壊れはしない |
| 新ビューアで旧データを開く | `kind` 欠落 = `"TABLE"`、`definition` 欠落 = 空。差分ゼロ |
| `manifest.tables` のキー名 | **据え置く**。ビューも `tables` マップに載る。意味的にはずれるが、キー名変更は後方互換を破るため `kind` で判別する |
| ファイル配置 | `schema/<ns>/<name>.js` に同居。**テーブルとビューは DB 上同一の名前空間にあるため ID 衝突は起きない** |

## 10. テスト観点

| # | 観点 | 場所 |
|---|---|---|
| T-1 | `kind = "TABLE"` は出力されず、既存 golden fixture がバイト一致のまま | `GoldenFixtureTest` / `RoundTripTest` |
| T-2 | `kind = "VIEW"` を持つテーブルの往復同一（parse → print がバイト一致） | 新規 fixture（`v_active_users.table.js`）+ `GoldenFixtureTest` |
| T-3 | `kind` の変更が1行だけの差分になる | `DiffMinimalityTest` |
| T-4 | H2 の `"BASE TABLE"` が `"TABLE"` に正規化され、ビューが `"VIEW"` で取れる | `JdbcIntrospectorTest` |
| T-5 | SQLite でビューが取れ、`sqlite_schema` / `sqlite_sequence` が除外される | `SqliteIntrospectorTest` |
| T-6 | **種別をまたぐリネーム候補が出ない**（列構成が同一の TABLE と VIEW） | `SchemaDiffTest` |
| T-7 | `kind` 差分の選択・非選択が正しく反映され、FK 剪定後も `kind` が保たれる | `IntrospectApplierTest` |
| T-8 | `kind` 無しの既存モデルを再逆生成しても差分が出ない | `SchemaDiffTest` |
| T-9 | ビューでも `meta` を保存でき、保存後も `kind` が残る（種別で拒否しない） | `TableServiceTest` |
| T-10 | 種別の実測値がドライバ更新後も前提どおり | `TableTypeProbeTest`（アサーション無しの記録用） |
| T-11 | 定義 SQL が `dialect` ではなく専用フィールドに入る | `DialectsTest` |
| T-12 | 行分割が決定論的（CRLF / 行末空白 / 前後の空行を吸収する） | `DialectsTest` |
| T-13 | 定義を含むファイルの往復同一 | `DialectsTest` |
| T-14 | **定義の1行を変更 → 差分が1行**（K-18 の核心。1本の文字列だと壊れる） | `DiffMinimalityTest` |
| T-15 | 層2 が定義を取れなかった回に「定義が消えた」差分を出さない | `SchemaDiffTest` |
| T-16 | 層2 が定義を取れなかった回に既存の定義を消さない | `IntrospectApplierTest` |
| T-17 | FK の剪定が走っても `kind` と `definition` が保たれる | `IntrospectApplierTest` |

## 11. 実装未定の項目

いずれも**着手予定は無い**。必要になったときに、この節を出発点にする。

### 11.1 ビュー → テーブルの依存関係

ビュー → 参照元テーブルの依存は **DB 間で取得可否が非対称**である。

| DB | 取得元 |
|---|---|
| PostgreSQL | `pg_depend` + `pg_rewrite` |
| SQL Server | `sys.sql_expression_dependencies` |
| Oracle | `ALL_DEPENDENCIES` |
| **MySQL** | **相当するカタログが無い**（定義 SQL のパースが必要） |

MySQL だけ構造的に対応できない。**定義 SQL を正規表現でパースして FROM 句を拾う実装は採らない**
（確実に破綻する）。

なお、依存関係を取得できても**エッジとして描画しないことは決定済み**である（1つのビューが5テーブルを
参照するようなケースで ER図が過密になるため）。取得する場合の用途はカタログ詳細での一覧表示に
限られる。**現状は、人が書く論理外部制約（P-06）で代替できる**——これは MySQL のように自動取得
できない DB でも同じように機能するという利点がある。

### 11.2 SQL Server / Oracle / SQLite の定義 SQL

K-18 は層2の Enhancer を持つ PostgreSQL / MySQL でのみ動く（§8.4）。他の DB でも定義が要るなら、
それぞれの `DialectEnhancer` を追加する。クエリは §8.4 の表に控えてある。層1には手を入れない。

Oracle の `ALL_VIEWS.TEXT` は LONG 型であり、**ResultSet の列を昇順に読まないと `ORA-17027` に
なる**点に注意する（層1の `getColumns` でまったく同じ罠を踏んだ。
[`JdbcIntrospector`](../../server/src/main/java/erd/introspect/JdbcIntrospector.java) の
カラム読み取りループのコメントを参照）。

### 11.3 Oracle のマテリアライズドビュー判別

Oracle はマテビューを `TABLE_TYPE = TABLE` として返すため、通常テーブルと区別できない（§2）。
`ALL_MVIEWS` を引いて `kind` を上書きすれば区別できる。層2の担当。
**現状すでに通常テーブルとして取り込まれており、実害は出ていない。**

### 11.4 差分プレビューの種別フィルタ

ビューが数十本あるプロジェクトで初回プレビューが読みにくい場合、`DiffTree` に種別による
折りたたみ / 絞り込みを追加する。現状は要約への種別前置（`VIEW, 2 columns`。§6.4）まで。

### 11.5 パーティション親テーブルの扱い

K-16 により PostgreSQL の `PARTITIONED TABLE`（パーティション親）が新たに取り込まれるように
なった。**子パーティションは以前から `TABLE` として個別に取り込まれている**ため、月次パーティションが
数十ある表では ER図・一覧が肥大する。これは K-16 が持ち込んだ問題ではないが、気になる場合は
無視リスト（K-15）に `public\..*_20\d{2}` のようなパターンを登録して除外する。

### 11.6 ビュー列の由来（lineage）

ビューの列が元テーブルのどの列から来ているかを辿る機能。
`SELECT * FROM <view> WHERE 1=0` の `ResultSetMetaData.getTableName` / `getColumnName` で
取得できる場合があるが、ドライバ依存で式列は空になる。
