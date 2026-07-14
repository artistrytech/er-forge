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

## 開発環境の起動

リリースビルドを作り直さなくても、**サーバーと HMR 付きビューアを繋いだ状態**で開発できる。
ターミナルを2つ使う。

```sh
# 1) Java サーバー（データは dev/ 以下。ブラウザは開かない）
cd server && ./gradlew devServer

# 2) ビューア（vite dev。ブラウザが自動で開く）
cd viewer && npm run dev:server
```

`http://localhost:5173/?t=erd-dev` が開く。ソースを保存すればビューアは HMR で即反映され、
サーバー側を直したときは `gradlew devServer` を再起動する。

| | 内容 |
|---|---|
| プロジェクトディレクトリ | `dev/`（Git 管理外）。設計書 §3.3 の `erd/` にあたる |
| 初回起動 | `dev/data/` が空なのでブートストラップ画面が出る。**サンプルを取り込めばすぐ触れる** |
| JDBC ドライバ | `dev/drivers/*.jar` に置く（逆生成を試す場合） |
| サーバーのポート | `5321`（使用中なら自動で繰り上がる）。`ERD_PORT` で変更できる |
| トークン | `erd-dev` に固定（`ERD_TOKEN`）。dev の URL を固定するためであり、配布物は毎回ランダム |

**仕組み**: ビューアはデータを常に `<script src="data/**.js">` の相対パスで読む（設計書 §4.3。
読み込み経路はモードによらず1本）。そこで vite dev が `/data` と `/__erd` を Java サーバーへ
プロキシし、本番とまったく同じ経路を通す。`GET /__erd/health` が通るのでサーバーモードになる（A-01）。

> `npm run dev`（`:server` なし）はビューア単体の起動で、`viewer/public/data/**` の固定データを
> 読む（サーバー不要）。`dev:server` ではこの `public/` を無効化している。有効なままだと
> `public/data/**` が `/data` を先に掴み、**サーバーの実データではなく古い固定データ**を
> 見てしまうことがあるため。

`ERD_PORT` を変えた場合は、ビューア側にも同じ値を渡す（プロキシ先を合わせるため）:

```sh
cd server && ERD_PORT=5400 ./gradlew devServer
cd viewer && ERD_PORT=5400 npm run dev:server
```

PowerShell では `$env:ERD_PORT="5400"` を先に実行する。

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

## リリース

Windows ではリポジトリ直下の **`build-dist.bat`** をダブルクリック（または実行）するだけでよい
（npm install → viewer ビルド → shadowJar → ZIP 組み立てまで自動。`--no-pause` で自動化にも使える）。

手動で行う場合:

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
