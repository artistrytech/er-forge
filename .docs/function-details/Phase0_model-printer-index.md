# 詳細設計: フェーズ0（モデル・決定論的プリンタ・`index.js` 生成・カーディナリティ・形式移行）

対象: **`server/core` の全体**（モデル定義、パーサ、決定論的プリンタ、派生ファイル生成、スキーマ形式の移行）と、それに関わる **E-02（カーディナリティ）/ A-04・A-09（形式バージョンと自動移行）**
関連: [K-08〜K-13（逆生成）](K08-K13_introspect-diff-apply.md)、[H-01〜H-13（ER図の編集）](H01-H13_layout-edit-sync-undo.md)、[O-03・J-01〜J-06（テーブル編集）](O03-O08_J01-J07_table-edit.md)、[P-01〜P-10（論理名・論理制約）](P01-P09_logical-names-constraints.md)
設計書: [1_architecture.md](../1_architecture.md) §5（データ形式）/ §3.5（バージョン整合性）

---

## 0. 位置づけ

**これはツールの最下層であり、他のすべてがこの上に乗る。** 逆生成もER図の保存もテーブル編集も、最終的には「モデルを決定論的プリンタでファイルに書く」に帰着する。ここが曖昧だと、上位のどの機能を正しく作っても Git 差分がノイズまみれになり、レビューできないデータが生まれる。

### 0.1 不変条件

| # | 不変条件 | 破られたときに起きること |
|---|---|---|
| INV-1 | **往復同一**: ファイル → 読み取り → 書き戻し で**バイト単位で完全一致**する | 開いて閉じただけで Git 差分が出る。全ファイルが一度書き換わり、レビュー不能になる |
| INV-2 | **モデル同一 → 出力同一**: 同じモデルからは、いつ・どの環境で出力しても同じバイト列が出る | 環境差（OS・ロケール・ハッシュ順）で差分が出る |
| INV-3 | **Java 実装と TypeScript 実装の出力が一致する**（TS 側は H-13 のエクスポートで必要） | 静的モードでエクスポートして貼り付けたファイルが、次回のサーバー保存で全行書き換わる |
| INV-4 | **人が読める。** 日本語の論理名・注記は `\uXXXX` にせず、そのまま出力する | Git 差分が読めない = 設計の意図がレビューできない、というツールの存在意義の否定 |
| INV-5 | **意味を変えずに差分を最小化する。** 1つの変更 = 1行の差分 | 型を1つ変えただけで数十行の差分が出て、レビューが機能しない |

---

## 1. モデル定義

### 1.1 machine-owned と human-owned を型で分離する

**「逆生成が `meta` を壊さない」を、規律ではなく型で保証する**（K 詳細設計 INV-1 / §6.2）。

```java
// server/core/model

/** DB から取得される情報。逆生成が上書きする */
record TableSchema(
    String name,                    // 物理名
    String schema,                  // ネームスペース（単一運用。GUI には出さない）
    String comment,                 // DB コメント（null 可）
    List<Column> columns,           // DB の物理順（ORDINAL_POSITION）
    List<String> primaryKey,        // KEY_SEQ 順
    List<UniqueConstraint> uniques,
    List<Index> indexes,
    List<ForeignKey> foreignKeys,
    Map<String, Object> dialect     // Enhancer が入れる DB 固有情報
) {}

/** 人が書く情報。逆生成は読まない・書かない（唯一の例外は K-14 の論理名初期値補完） */
record TableMeta(
    String displayName,                          // テーブル論理名
    List<String> tags,                           // 分類・検索用（P-12）
    String color,                                // 指定色（P-13）。タグとは独立
    String notes,
    Map<String, ColumnMeta> columns,             // カラム論理名・タグ・色・注記
    List<LogicalUnique> logicalUniques,
    List<LogicalForeignKey> logicalForeignKeys,
    Map<String, RelationMeta> relations          // カーディナリティ等（§5）
) {}

/** ファイル1枚に対応する。id は両者の外にある（リネーム時のみ変わる） */
record Table(String id, TableSchema schema, TableMeta meta) {}
```

- **逆生成の適用は `Table#withSchema(newSchema)`（`meta` を引き継ぐ）しか呼べない。**
- **テーブル編集の保存は `Table#withSchema(..).withMeta(..)`（両方を置換）。**
- この2つを別メソッドにすることで、「丸ごと差し替えて `meta` が消える」という事故を型レベルで防ぐ。

### 1.2 カラムと制約

```java
record Column(
    String name,
    String type,            // DB 生の型文字列（TYPE_NAME 由来。忠実性の担保）
    LogicalType logicalType,// 正規化型（表示・比較に使う）
    boolean nullable,
    String defaultValue,    // null = デフォルトなし
    boolean autoIncrement,
    boolean generated,
    String comment
) {}

enum LogicalType { STRING, INT, FLOAT, DECIMAL, BOOL, DATE, TIME, DATETIME,
                   JSON, UUID, BINARY, ENUM, ARRAY, OTHER }

record UniqueConstraint(String name, List<String> columns) {}
record Index(String name, List<String> columns, boolean unique) {}
record ForeignKey(String name, List<String> columns, Ref ref, String onDelete, String onUpdate) {}
record Ref(String table, List<String> columns) {}

record LogicalUnique(String name, List<String> columns, String notes) {}
record LogicalForeignKey(String name, List<String> columns, Ref ref, String notes) {}
// ↑ 論理外部制約は onDelete / onUpdate を持たない（DB に制約がない以上、参照動作は存在しない）
```

### 1.3 TypeScript 側（zod）

ビューアは同じ形を zod で定義する。**Java とは別実装になるため、次で一致を保証する。**

- **golden fixture を単一のソースとする。** `test/fixtures/*.js`（データファイル）と `test/fixtures/*.model.json`（それに対応するモデルの JSON 表現）を1組にし、Java / TS 双方のテストが同じ fixture を読む。
- Java: `parse(fixture.js)` → JSON 化 → `fixture.model.json` と一致すること / `print(model)` → `fixture.js` と**バイト一致**すること
- TS: 同上
- **fixture を追加せずに新しいフィールドを足すことを禁止する**（CI で fixture カバレッジを検査する）

---

## 2. 決定論的プリンタ

### 2.1 全体構造

各ファイルは**グローバル API 呼び出し1つ**である。

```js
ERD.table({
  …
});
```

- 先頭に BOM を付けない。UTF-8。
- 改行は **LF** のみ。
- ファイル末尾に**改行1つ**（`});\n`）。
- ファイル冒頭にヘッダコメントを**入れない**（「自動生成」等のコメントは差分ノイズを生むだけ）。
  同じ理由で `manifest.js` は**生成時刻（`generatedAt`）も接続元 DB（`source`）も持たない**。
  どちらもファイルの中身と無関係に書き換わる。既存ファイルにあるものはパーサが読み捨てるため、
  次の書き込みで消える（読まずに放置すると未知キーとして保持され、古い値が残り続ける）。

### 2.2 インデントと区切り

- インデントは**スペース2**。タブを使わない。
- **末尾カンマを常に付ける**（配列・オブジェクトの最後の要素にも）。末尾要素の追加が1行差分で済む（INV-5）。
- キーと値の区切りは `: `（コロン + スペース1）。
- 配列・オブジェクトのリテラル内では、要素の**前後に空白を1つ**入れる（`{ name: "id", … }`）。

### 2.3 キーの引用

| 条件 | 出力 |
|---|---|
| JS の識別子として妥当（`/^[A-Za-z_$][A-Za-z0-9_$]*$/`） | **引用符なし**（`name:`, `created_at:`） |
| それ以外（ドットを含むテーブルID、記号を含むカラム名、予約語） | **二重引用符**（`"public.users":`） |

**予約語（`default`, `new`, `class` …）はクォートする。** カラム名に `default` があるとファイルが構文エラーになる（`file://` では即座に読み込み失敗する）。予約語リストを実装に持つ。

### 2.4 値の書式

| 型 | 出力 |
|---|---|
| 文字列 | **二重引用符**。エスケープは §2.5 |
| 真偽値 | `true` / `false` |
| 整数 | そのまま（`120`）。**小数を出力しない**（座標は 8px スナップ + 整数化。§5.11 の規約） |
| null | **出力しない**（そのキーごと省略する。§2.6） |
| 空配列 `[]` / 空オブジェクト `{}` | **出力しない**（キーごと省略） |

### 2.5 文字列のエスケープ（INV-4 の核心）

**非 ASCII 文字（日本語）をエスケープしない。** そのまま UTF-8 で出力する。

エスケープするのは以下**のみ**。

| 文字 | 出力 |
|---|---|
| `"` | `\"` |
| `\` | `\\` |
| 改行 `U+000A` | `\n` |
| 復帰 `U+000D` | `\r` |
| タブ `U+0009` | `\t` |
| その他の制御文字（`U+0000`〜`U+001F`） | `\u00XX`（小文字16進） |
| **`U+2028`（LINE SEPARATOR）/ `U+2029`（PARAGRAPH SEPARATOR）** | **` ` / ` `** |

> **`U+2028` / `U+2029` は必ずエスケープする。** これらは JSON では有効な文字だが、**JavaScript の文字列リテラル内では改行として扱われ、構文エラーになる**（ES2019 以降は仕様上許容されたが、`build.target: es2019` の下で古いブラウザ・パーサに読ませる可能性がある以上、出力しない）。DB のコメントを Word からコピペした注記に混入する実例がある。**この1文字でファイル全体が読めなくなる**。

### 2.6 省略規則（デフォルト値表）

**「デフォルト値と一致するキーは出力しない」** を機械的に適用する。ただし**可読性のために例外を設ける**（下表の「常に出力」）。

| 対象 | キー | デフォルト | 出力条件 |
|---|---|---|---|
| Column | `name` `type` `logicalType` | — | **常に出力** |
| Column | `nullable` | — | **常に出力**（レビューで最も見る情報。省略すると `false` が消えて読みにくい） |
| Column | `default` | null | 非 null のとき |
| Column | `autoIncrement` | false | `true` のとき |
| Column | `generated` | false | `true` のとき |
| Column | `comment` | null | 非 null かつ非空のとき |
| Table | `comment` | null | 非 null かつ非空のとき |
| Table | `primaryKey` `uniques` `indexes` `foreignKeys` `dialect` `meta` | 空 | 空でないとき |
| ForeignKey | `onDelete` `onUpdate` | `"no action"` | それ以外のとき |
| Index | `unique` | false | `true` のとき |
| Diagram node | `w` | 自動 | 明示指定があるとき |
| Diagram edge | `waypoints` | 空 | 空でないとき |

### 2.7 キー順（固定）

**アルファベット順にしない。人が読む順序で固定する。**

| オブジェクト | キー順 |
|---|---|
| `ERD.table` | `id` `name` `schema` `comment` `columns` `primaryKey` `uniques` `indexes` `foreignKeys` `dialect` `meta` |
| Column | `name` `type` `logicalType` `nullable` `default` `autoIncrement` `generated` `comment` |
| ForeignKey | `name` `columns` `ref` `onDelete` `onUpdate` |
| Ref | `table` `columns` |
| `meta` | `displayName` `tags` `color` `notes` `columns` `logicalUniques` `logicalForeignKeys` `relations` |
| `meta.columns.<name>` | `displayName` `tags` `color` `notes` |
| `ERD.diagram` | `id` `title` `order` `nodes` `edges` |
| `ERD.manifest` | `schemaVersion` `config` `dictionary` `tables` `diagrams` |
| `ERD.index` | `tables` `relations` `tagsUsed` |
| `ERD.config` | `ignoreTables` |
| `ERD.dictionary` | `columns`（値は `displayName` `tags` `color` を持つオブジェクト） |

### 2.8 配列とマップの順序（INV-2 の核心）

**「配列は物理順を維持、マップは決定論的にソート」** を規則とする。

| 対象 | 順序 |
|---|---|
| `columns`（配列） | **DB の物理順**（`ORDINAL_POSITION`）。**アルファベット順にしない** |
| `primaryKey` / 制約の `columns`（配列） | **キー順**（`KEY_SEQ`） |
| `uniques` / `indexes` / `foreignKeys`（配列） | **制約名の昇順**（DB が返す順は不定のため、ここは決定論的にソートする） |
| `meta.columns`（マップ） | **テーブルの `columns` の物理順**（アルファベット順にしない。カラム表と並びが揃う） |
| `manifest.tables` / `index.tables` | **テーブルID の昇順** |
| `index.relations` / `diagrams.edges` | **エッジID の昇順** |
| `diagrams.nodes` | **テーブルID の昇順**（座標を動かしても行が移動しない = 差分が座標の1行だけになる） |
| `dictionary.columns` | **カラム物理名の昇順** |
| `config.ignoreTables`（配列） | **人が書いた順を維持**（意味のある並びかもしれないため、ソートしない） |

**ソートは常に「Unicode コードポイント順」で行う。** ロケール依存のソート（`Collator`）を使わない（環境で結果が変わり INV-2 を破る）。

### 2.9 出力例

```js
ERD.table({
  id: "public.users",
  name: "users",
  schema: "public",
  comment: "ユーザー情報",
  columns: [
    { name: "id", type: "serial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "email", type: "varchar(255)", logicalType: "string", nullable: false },
    { name: "org_id", type: "int4", logicalType: "int", nullable: true },
    { name: "created_at", type: "timestamptz", logicalType: "datetime", nullable: true, default: "CURRENT_TIMESTAMP" },
  ],
  primaryKey: ["id"],
  uniques: [
    { name: "users_email_key", columns: ["email"] },
  ],
  foreignKeys: [
    { name: "users_org_id_fkey", columns: ["org_id"], ref: { table: "public.organizations", columns: ["id"] }, onDelete: "set null" },
  ],
  meta: {
    displayName: "ユーザー",
    tags: ["core", "auth"],
    color: "blue",
    notes: "論理削除は deleted_at 運用",
    columns: {
      org_id: { displayName: "所属組織ID", tags: ["pii"], notes: "NULL は個人アカウント" },
      last_order_id: { tags: ["廃止"], color: "muted" },
    },
    relations: {
      "fk:users_org_id_fkey": { child: "1..N", notes: "組織には必ず1人以上の利用者がいる" },
    },
  },
});
```

**1カラム = 1行。** 型を変えても差分は1行、カラムを1つ足しても差分は1行（末尾カンマのおかげ）。

---

## 3. パーサ

### 3.1 読み込み

ラッパ（`ERD.table(` … `);`）を文字列操作で剥がし、中身のオブジェクトリテラルを **Jackson**（緩和フラグ付き）でパースする。JS パーサの自前実装は不要。

```java
JsonMapper.builder()
    .enable(JsonReadFeature.ALLOW_UNQUOTED_FIELD_NAMES)
    .enable(JsonReadFeature.ALLOW_SINGLE_QUOTES)
    .enable(JsonReadFeature.ALLOW_TRAILING_COMMA)
    .enable(JsonReadFeature.ALLOW_JAVA_COMMENTS)
    .build();
```

### 3.2 ラッパの剥がし方

- 先頭の `ERD.<fn>(` と末尾の `);`（前後の空白・改行を含む）を除去する。
- **どの `fn` だったかを検証する**（`schema/*.js` に `ERD.diagram(` が書かれていたらエラー）。
- 剥がした結果が1つのオブジェクトリテラルであることを確認する（複数の文が書かれていたら拒否）。

### 3.3 読み込み時の検証

パースに成功しても、モデルとして不正なものは**読み込み時に弾く**（壊れたモデルを上位に流さない）。

| # | 検証 | 失敗時 |
|---|---|---|
| V-1 | 必須キー（`id` `name` `columns`）が存在する | ファイル単位のエラーとして記録し、該当テーブルを「欠損」として扱う（A-05） |
| V-2 | `logicalType` が列挙に含まれる | 不明な値は `other` にフォールバックし、警告する |
| V-3 | `id` が `schema.name` と一致する | 不一致は警告し、`id` を正とする |
| V-4 | 未知のキーが含まれる | **エラーにせず保持し、そのまま書き戻す**（前方互換。新しいバージョンのツールが書いた未知フィールドを、古いツールが消さない） |

> **V-4 は重要である。** 未知キーを捨てる実装にすると、新旧のツールが混在したときに「開いて閉じただけで情報が消える」。`Map<String, Object> unknown` に退避し、プリンタが元の位置に書き戻す。

---

## 4. `index.js` の生成規則

`index.js` は **`schema/**` + `diagrams/**` からサーバーが必ず再生成する派生ファイル**であり、手編集を許さない。ER図はこのファイルだけでノードとエッジを描く（設計書 §6.1）ため、**ここの正しさが ER図の正しさそのものである**。

### 4.1 生成タイミング

- 逆生成の適用（K-11）
- `PUT /tables/:id`（**無条件に再生成する**。何が変わったか判定しない。§8.2）
- `POST /tables` / `DELETE /tables/:id`
- ページの追加・削除・`PATCH /diagrams/:id`（`diagrams` 所属が変わるため）
- 形式移行（§6）

### 4.2 `tables[]`

```js
{ id: "public.users", name: "users", displayName: "ユーザー", columns: 8, pk: true,
  tags: ["core", "auth"], color: "blue", diagrams: ["core"] }
```

- `displayName` は **`meta.displayName` の生の値**（未設定なら省略）。**物理名へのフォールバックはビューア側の解決関数で行う**（P 詳細設計 §1.1）。ここで解決済みの値を入れると、「論理名が設定されているか」が区別できなくなり、未整備ハイライト（O-07）が作れない。
- `diagrams` は、そのテーブルを含むページID の昇順。空配列なら**省略する**（＝未配置。K-12 の導出元）。
- `color` は **`meta.color` の生の値**（未設定なら省略。P-13）。**ER図はこの索引だけでノードを描くため、ここに載せないと ER図だけ色が付かない。** カラムの色・カラムのタグは載せない（カラムを描く画面は必ずスキーマファイルを読み込んでいる）。
- ファイル末尾の `tagsUsed` は、使用中タグ（テーブル ∪ カラム個別）のコードポイント順の集合。タグ入力の候補用（P-12）。**カラム辞書の共通タグは含めない**（含めると辞書を保存するたびに索引の再生成が要る。辞書はビューアが常に直接読むので、候補はそこから足せる）。

### 4.3 `relations[]`（エッジ）

```js
{ id: "public.users#fk:users_org_id_fkey", kind: "physical",
  from: "public.users", to: "public.organizations",
  columns: [["org_id", "id"]],
  cardinality: { parent: "0..1", child: "0..N" } }
```

| フィールド | 生成規則 |
|---|---|
| `id` | `<参照元テーブルID>#<種別>:<制約名>`。種別は `fk`（物理）/ `lfk`（論理外部制約） |
| `kind` | `"physical"`（`foreignKeys`）/ `"logical"`（`meta.logicalForeignKeys`） |
| `from` | **参照元**（FK を持つ側 = 子） |
| `to` | **参照先**（参照される側 = 親） |
| `columns` | `[[参照元カラム, 参照先カラム], …]`（`KEY_SEQ` 順） |
| `cardinality` | §5 |

- **物理 FK と論理外部制約を同じ配列に入れる。** ビューアは `kind` で線種（実線 / 破線）だけを変える。これによりハイライト・追跡・N ホップ探索（E-05 / E-06）が両者を区別せずに扱える。
- 参照先テーブルが存在しない場合（参照切れ）も **`relations` に含める**（`dangling: true` を付ける）。整合性チェック（M-04）が拾えるようにするため。ER図では孤立エッジとして描かない（描画対象は両端のノードがページ上にあるものだけ）。

---

## 5. カーディナリティ（E-02）

### 5.1 物理情報だけでは決まらない

**DB のスキーマから機械的に導出できるのは、多重度の一部だけである。**

| 多重度 | DB から分かるか | 根拠 |
|---|---|---|
| 子から見た**親**が `0..1` か `1..1` か | **分かる** | FK カラムが NULL 可なら `0..1`、すべて NOT NULL なら `1..1` |
| 親から見た**子**が `0..1` か `0..N` か | **分かる** | FK カラムに一意制約（PK / UNIQUE / 論理一意制約）があれば `0..1`、なければ `0..N` |
| 親から見た子の**下限が 0 か 1 か**（`0..N` か `1..N` か） | **分からない** | 「組織には最低1人の利用者が必要」は**業務ルール**であり、DB の外部キー制約では表現できない |

したがって、**カーディナリティは「物理からの導出値」を既定とし、人がメタデータで上書きする**。

### 5.2 データ形式（`meta.relations`）

**参照元テーブル（FK を持つ側）の `meta` に置く。** FK の定義がそのテーブルにあるため、同じ場所で完結する。

```js
meta: {
  relations: {
    // キー = エッジID の後半（<種別>:<制約名>）。物理・論理の両方に付けられる
    "fk:users_org_id_fkey":     { child: "1..N", notes: "組織には必ず1人以上の利用者がいる" },
    "lfk:lfk_users_last_order":  { parent: "0..1" },
  },
}
```

| キー | 値 | 意味 |
|---|---|---|
| `parent` | `"0..1"` / `"1..1"` | **子から見た親**の多重度。省略時は物理から導出 |
| `child` | `"0..1"` / `"1..1"` / `"0..N"` / `"1..N"` | **親から見た子**の多重度。省略時は物理から導出 |
| `notes` | 文字列 | なぜその多重度なのかの根拠（業務ルール） |

- **部分上書きができる**（`child` だけ設定し、`parent` は導出値のまま、など）。
- **human-owned。逆生成は読まない・書かない**（INV: 論理制約と同じ扱い）。
- 未設定のリレーションは、`meta.relations` にキー自体を作らない（ファイルに書かない）。

### 5.3 解決（サーバーが `index.js` を生成するときに確定させる）

```
resolve(relation):
  physical.parent = すべての FK カラムが NOT NULL ? "1..1" : "0..1"
  physical.child  = FK カラム集合に一意制約あり   ? "0..1" : "0..N"
      （一意制約 = PK / uniques / meta.logicalUniques。カラム集合が完全一致するもの）

  cardinality.parent = meta.relations[key]?.parent ?? physical.parent
  cardinality.child  = meta.relations[key]?.child  ?? physical.child
```

- **`index.relations[].cardinality` には解決後の値のみを載せる。** ビューアは導出ロジックを持たない（サーバーとビューアで判定がズレるのを防ぐ）。
- ただし**「導出値か、人が設定した値か」の区別は残す**（`explicit: ["child"]`）。詳細ダイアログ（E-10）で「この多重度は手動設定です」と示し、根拠（`notes`）を表示するため。

### 5.4 表示（鳥の足記号）

| 多重度 | 端点の記号 |
|---|---|
| `0..1` | ○ + │（任意・1） |
| `1..1` | ‖（必須・1） |
| `0..N` | ○ + 鳥の足（任意・多） |
| `1..N` | │ + 鳥の足（必須・多） |

- **人が設定した多重度**であることを、詳細ダイアログ（E-10）とテーブル詳細（O-02）で明示する。
- 論理一意制約（P-06）を追加すると `physical.child` が `0..N` → `0..1` に変わるため、**`index.js` の再生成が必要**（§4.1）。

### 5.5 編集 UI

| 場所 | 操作 |
|---|---|
| テーブル編集画面（O-03）の FK / 論理外部制約の行 | 多重度をドロップダウンで設定（既定は「自動（物理から導出）」） |
| リレーション詳細ダイアログ（E-10） | 現在の多重度と、それが導出値か手動設定かを表示。編集画面へのリンク |

---

## 6. `schemaVersion` と自動移行（A-04 / A-09）

### 6.1 方針

**サーバーが起動時に自動で移行する。** ユーザーに手作業を求めない。

| 状態 | 挙動 |
|---|---|
| `data.schemaVersion` **==** サーバーの `CURRENT_VERSION` | そのまま起動 |
| `data.schemaVersion` **<** `CURRENT_VERSION` | **自動移行**（§6.3）。完了後、GUI に「データ形式を v1 → v2 に移行しました。差分をコミットしてください」と通知する |
| `data.schemaVersion` **>** `CURRENT_VERSION` | **起動を中止する。**「このデータは新しい形式（v3）です。`erd-server.jar` を更新してください」。**データには一切触れない**（古いツールが新しいデータを壊さない） |

### 6.2 静的モード（ビューア）は移行しない

- ビューアは `SUPPORTED_VERSION`（そのリリースが読める版）を持つ。
- 不一致なら**描画せず、バナーを出す**。「データ形式が古い（v1）です。編集者がサーバーを起動すると自動的に移行されます」/「index.html が古いです。Release から更新してください」。
- **中途半端に読んで表示しない。** 誤ったER図を見せるより、明確に止まる方が安全である。
- `index.html` と `data/**` は**同じコミットで更新される**（編集者がサーバーで移行 → 両方をコミット）ため、メンバーがこの状態に遭遇するのは移行の過渡期のみである。

### 6.3 移行の実行

```
1. data.schemaVersion を読む（manifest.js のみを先にパースする）
2. 適用すべき移行の列を決める（v1→v2, v2→v3, … を順に）
3. data/** の全体を .local/backup/<timestamp>/ にコピー（§8.6 と同じ仕組み）
4. 全ファイルをモデルとして読み込む（旧バージョンのリーダーで）
5. 移行関数を順に適用する（Migration#apply(ProjectModel) → ProjectModel）
6. manifest.schemaVersion を CURRENT_VERSION にする
7. index.js を再生成する
8. 全ファイルを決定論的プリンタで書き出し、ATOMIC_MOVE で一括置換（§8.6）
9. 失敗したらバックアップから完全復元し、起動を中止する
```

- **移行は「全ファイルが書き換わる」大きな Git 差分を生む。** GUI で「移行による変更です。単独のコミットにすることを推奨します」と明示する。
- 移行は**冪等**とする（同じバージョンに対して2回実行しても結果が同じ）。
- **移行関数は削除しない。** v1→v2 の移行は、v5 のツールにも残す（古いリポジトリを開ける必要があるため）。

### 6.4 移行関数の形

```java
interface Migration {
    int fromVersion();                       // 1
    int toVersion();                         // 2
    ProjectModel apply(ProjectModel model);  // 純粋関数。I/O をしない
    String description();                    // GUI に出す説明（「カーディナリティを meta.relations に移動」）
}
```

- I/O を持たせない（テストしやすく、ドライランできる）。
- **各移行に対して golden fixture を必ず用意する**（`fixtures/v1/**` → `fixtures/v2/**` に一致すること）。

### 6.5 バージョンを上げる基準

`schemaVersion` は**後方互換を破る変更のときのみ**インクリメントする。

| 変更 | バージョンを上げるか |
|---|---|
| **キーの追加**（未知キーは保持される。§3.3 V-4） | **上げない** |
| キーの削除・リネーム・意味の変更 | **上げる** |
| 値の形式の変更（文字列 → オブジェクト等） | **上げる** |
| キー順・書式の変更（プリンタの整形） | 上げない（ただし全ファイルが書き換わるため、リリースノートで告知する） |

---

## 7. テスト観点

| # | 観点 | 期待 |
|---|---|---|
| T-1 | **往復**: fixture を読んで書き戻す | **バイト単位で完全一致**（INV-1）。全 fixture について |
| T-2 | **べき等**: 同じモデルを2回書く | 同一のバイト列（INV-2） |
| T-3 | **Java / TS の一致**: 同じ fixture を両実装で出力 | **バイト単位で一致**（INV-3） |
| T-4 | 日本語の論理名・注記を含むテーブルを出力 | `\uXXXX` にならず、そのまま読める（INV-4） |
| T-5 | 注記に `U+2028` を含める → 出力 → ブラウザで `file://` から読む | **エスケープされ、構文エラーにならない**（§2.5） |
| T-6 | カラム名に予約語（`default`）を持つテーブル | キーがクォートされ、構文エラーにならない（§2.3） |
| T-7 | カラムの型を1つ変更して保存 | **Git 差分が1行**（INV-5） |
| T-8 | カラムを末尾に1つ追加して保存 | Git 差分が**1行**（末尾カンマ。§2.2） |
| T-9 | ノードを1つ動かして保存 | Git 差分が**1行**（`nodes` がテーブルID 昇順のため、行が移動しない。§2.8） |
| T-10 | 未知のキーを含む fixture を読んで書き戻す | **未知キーが保持される**（§3.3 V-4） |
| T-11 | 環境（OS / ロケール / JVM）を変えて出力 | 同一のバイト列（§2.8 のコードポイント順ソート） |
| T-12 | FK カラムが NOT NULL + ユニーク | `cardinality: { parent: "1..1", child: "0..1" }`（§5.3） |
| T-13 | `meta.relations` で `child: "1..N"` を設定 | `index.relations` に反映され、`explicit: ["child"]` が付く |
| T-14 | 論理一意制約（P-06）を FK カラムに追加 | `index.js` の再生成で `child` が `0..N` → `0..1` に変わる（§5.4） |
| T-15 | v1 のデータでサーバーを起動 | 自動移行され、`schemaVersion: 2` になる。**バックアップが残る**（§6.3） |
| T-16 | 移行の途中で失敗（ディスクフル） | `data/**` が**移行前と完全に同一**（§6.3-9） |
| T-17 | v3 のデータを v2 のサーバーで開く | **起動を中止**し、データを書き換えない（§6.1） |
| T-18 | v1 のデータを v2 のビューアで `file://` から開く | 描画せず、バナーを表示する（§6.2） |

**T-1 / T-2 / T-3 はフェーズ0の完了条件そのもの**であり、これが通るまで上位の実装に進まない。

---

## 8. 設計書・機能一覧への反映

**すべて反映済み。**

| # | 内容 | 反映先 |
|---|---|---|
| 8.1 | **カーディナリティを `meta.relations` として持つ**（物理から導出できない多重度がある。§5） | 設計書 §5.7 / §5.5、機能一覧 E-02 / **P-11（新規）** |
| 8.2 | **`index.relations` の `optional` / `toOne` を `cardinality` に置き換える**（§4.3） | 設計書 §5.5 |
| 8.3 | **`schemaVersion` の自動移行**（サーバー起動時。MVP に含める。§6） | 設計書 §3.5、機能一覧 **A-09（新規）** / A-04 |
| 8.4 | **未知キーの保持**（前方互換。§3.3 V-4） | 設計書 §5.12 |
| 8.5 | **書式規約の厳密化**（エスケープ・キー順・省略規則・ソート順） | 設計書 §5.11 からこの詳細設計へリンク |
