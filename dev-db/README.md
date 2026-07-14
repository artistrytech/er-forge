# 動作確認用の DB 環境

逆生成（K-01〜K-15）を実際の DB に対して試すための PostgreSQL と、最小のマイグレーション実行ツール。

## 起動

```sh
cd dev-db
docker compose up -d          # 初回は .docs/sample-schema.sql（約30テーブル）が自動で流れる
npm install                   # マイグレーションツールの依存（pg）
```

| 項目 | 値 |
|---|---|
| JDBC URL | `jdbc:postgresql://localhost:5442/erd_sample` |
| ユーザー / パスワード | `erd` / `erd` |
| 対象スキーマ | `public` |

DB を作り直す（初期 DDL からやり直す）: `docker compose down -v && docker compose up -d`

> Docker が WSL 側にしか無い場合は `wsl docker compose up -d` のように呼ぶ。
> マイグレーションツールは TCP で繋ぐだけなので、Windows 側の node からそのまま動く。

## マイグレーション

```sh
node migrate.mjs status       # 適用済み / 未適用の一覧
node migrate.mjs up           # 未適用をすべて適用
node migrate.mjs up 003       # 003 まで適用して止める（段階的に逆生成を試す）
```

- `migrations/*.sql` をファイル名の昇順に適用する
- 適用済みかどうかは **`erd_migrate.schema_migrations`** テーブル1つで判断する
- 1ファイル = 1トランザクション。失敗すればロールバックし、記録も残らない

管理テーブルを **`public` ではなく専用スキーマに置いている**のは、`public` に置くと
このツール自身の管理テーブルが逆生成の対象になり、ER図に無関係なテーブルが現れるため。
（実在のマイグレーションツールが `public` に履歴テーブルを作る場合は、
無視リスト K-15 に `public.flyway_schema_history` のように登録して除外する。）

## 用意してあるマイグレーション

逆生成のどの挙動を試したいかで選ぶ。上から順に適用する前提。

| ファイル | 何が起きるか | 確認したい機能 |
|---|---|---|
| `001_dialect_features.sql` | ENUM 型・CHECK 制約・部分インデックス・式インデックスを追加 | **DialectEnhancer（層2）**。JDBC 標準では取れず、`dialect` に入る（G-04） |
| `002_add_wishlists.sql` | テーブル2件を追加（FK・UNIQUE つき） | 追加の検出、**未配置トレイ**（K-12）。配置するまで `diagrams/**` は変わらない |
| `003_add_column_with_comment.sql` | カラム追加 + DB コメント | **コメントからの論理名の初期値補完**（K-14 / P-02）。既存の論理名は上書きされない |
| `004_alter_column_type.sql` | 型・NULL可否・デフォルトの変更 | 変更の検出（カラム単位の差分） |
| `005_rename_column.sql` | カラムのリネーム | **カラムのリネーム候補**（K-09）。承認すれば論理名が追随する |
| `006_rename_table.sql` | テーブルのリネーム | **テーブルのリネーム候補**（K-09）。承認すれば **ER図の配置・論理名が保持される** |
| `007_add_constraints.sql` | UNIQUE と FK を追加 | エッジの増加、カーディナリティの導出（E-02） |
| `008_drop_table.sql` | テーブルを削除 | 削除の検出、**孤児ノード**（K-13）。ノードは自動削除されない |

> **リネーム候補には誤検出が混じる。** 例えば 002 と 008 を両方適用すると、
> 削除された `user_sessions` と追加された `wishlists` はカラム構成が似ている（`id` / `user_id` /
> `created_at`）ため、リネーム候補として提示される。**だから人が承認・訂正・却下する**
> （K-09）。差分プレビューで却下すれば「削除 + 追加」として扱われる。

## ツール側での試し方

1. `dev/drivers/` に PostgreSQL の JDBC ドライバ（`postgresql-*.jar`）を置く
2. `cd server && ./gradlew devServer` / `cd viewer && npm run dev`
3. ブートストラップで **サンプルデータを取り込む**（配置・論理名・論理制約が入った完成状態）
4. `#/introspect` から上の JDBC URL で接続 → 逆生成 → 差分プレビュー
5. `node migrate.mjs up 006` などで DB を進め、もう一度逆生成して差分を見る

これで「**逆生成しても ER図の配置・論理名・論理制約が失われない**」（フェーズ5の完了条件）を
実際の DB で確認できる。
