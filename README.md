# ER図管理ツール（開発リポジトリ）

設計書は [.docs/1_architecture.md](.docs/1_architecture.md) と
[.docs/2_functions.md](.docs/2_functions.md) を参照。

## 構成

| ディレクトリ | 内容 |
|---|---|
| `server/` | Java 17 / Gradle。core（モデル・決定論的プリンタ・index生成・移行）と web（Javalin） |
| `viewer/` | TypeScript / React / Vite。単一 `index.html` に全アセットをインライン化 |
| `fixtures/` | Java / TS 共通の golden fixture（プリンタ出力の一致を保証） |
| `distribution/` | 配布 ZIP に同梱する固定ファイル（起動スクリプト・README） |

## ビルド

```sh
# ビューア（viewer/dist/index.html を生成）
cd viewer && npm install && npm run build

# サーバー（server/build/libs/erd-server.jar を生成）
cd server && ./gradlew shadowJar
```

## テスト

```sh
cd viewer && npm run typecheck && npm test && npm run e2e   # e2e はビルド後に file:// スモーク
cd server && ./gradlew test
```

## リリース（ZIP 化手順。設計書 §3.1）

```sh
cd server && ./gradlew packageDist
```

`server/build/dist/erd-<version>.zip` が生成される
（ビューアのビルド → shadowJar → `distribution/` との合成まで自動で行う）。
これを GitHub Releases に手動アップロードする。バージョンは `server/build.gradle.kts` の
`version` で管理する。

## 同梱サンプルデータの再生成

`.docs/sample-schema.sql` を変更した場合:

```sh
cd server && ./gradlew generateSampleData
```

`server/src/main/resources/erd-sample/` が再生成されるので、目視確認してコミットする。
