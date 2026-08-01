# ER図管理ツール（開発リポジトリ）

**テーブル定義書とER図にまつわる「よくある困りごと」を、まとめて解決するツール。**

| よくある課題 | このツールなら |
|---|---|
| **メンテナンスが追い付かず陳腐化する**。DB は変わっているのに定義書は昔のまま | 実 DB に接続して**スキーマを逆生成**し、差分をプレビューして取り込める。人が書くのは論理名・注記など**人にしか書けない情報**だけ。実体とドキュメントがずれない |
| **特定のソフトやツールがないと閲覧できない**。Excel、専用エディタ、有償ライセンス…… | 成果物は**単一の `index.html`**。ブラウザで開くだけで誰でも見られる。閲覧だけなら Java もサーバーも不要 |
| **1ツールでは機能が足りず情報が分散する**。ER図はA、定義書はB、補足メモはC | **ER図・テーブルカタログ・論理名・論理制約・タグ・注記**を1つのワークスペースで扱う。同じデータを2つのビューから見る形なので、二重管理が起きない |
| **Gitで差分を追えない**。バイナリ形式なのでレビューもマージもできない | データは**決定論的に整形したテキスト**として出力。同じ内容なら常に同じバイト列になるので、`git diff` が読めるし、プルリクエストで普通にレビューできる |

**成果物をリポジトリに置き、コードと同じワークフローで育てていく**——それがこのツールの立ち位置。

## 構成

| ディレクトリ | 内容 |
|---|---|
| `server/` | Java 17 / Gradle。core（モデル・決定論的プリンタ・index生成・移行）と web（Javalin） |
| `viewer/` | TypeScript / React / Vite。単一 `index.html` に全アセットをインライン化 |
| `fixtures/` | Java / TS 共通の golden fixture（プリンタ出力の一致を保証） |
| `distribution/` | 配布 ZIP に同梱する固定ファイル（起動スクリプト・README） |
| `dev-db/` | 動作確認用の DB（PostgreSQL / SQL Server / Oracle の docker compose）と、DB 製品ごとのスキーマ・マイグレーション（→ [README](dev-db/README.md)） |

## 開発環境の起動

リリースビルドを作り直さなくても、**サーバーと HMR 付きビューアを繋いだ状態**で開発できる。
**配布物とまったく同じ経路**（Java サーバーが `workspace-*/data/**.js` を配信し、ビューアは `<script>` で読む）
で動くため、dev だけ挙動が違うということがない。ターミナルを2つ使う。

```sh
# 1) Java サーバー（データは dev/ 以下。ブラウザは開かない）
cd server && ./gradlew devServer

# 2) ビューア（vite dev。ブラウザが自動で開く）
cd viewer && npm run dev
```

`http://localhost:5173/?t=erd-dev` が開く。ソースを保存すればビューアは HMR で即反映され、
サーバー側を直したときは `gradlew devServer` を再起動する。

| | 内容 |
|---|---|
| プロジェクトディレクトリ | `dev/`（Git 管理外）。配布物での `erd/` にあたる |
| データ | `dev/workspace-<id>/data/`（ワークスペース単位） |
| 初回起動 | ワークスペースが無ければ作成画面 → ブートストラップ画面が出る。**サンプルを取り込めばすぐ触れる** |
| JDBC ドライバ | `dev/drivers/*.jar` に置く（逆生成を試す場合。→ [dev-db/](dev-db/README.md)）。設定は `dev/config.js`（全ワークスペース共通） |
| サーバーのポート | `5321`（使用中なら自動で繰り上がる）。`ERD_PORT` で変更できる |
| トークン | `erd-dev` に固定（`ERD_TOKEN`）。dev の URL を固定するためであり、配布物は毎回ランダム |

**仕組み**: ビューアはデータを常に `<script src="workspace-<id>/data/**.js">` の相対パスで読む
（読み込み経路はモードによらず1本）。そこで vite dev が `/workspace-*/data/`・
`/workspaces.js`・`/__erd` を Java サーバーへプロキシする。`GET /__erd/health` が通るので
サーバーモードになる（A-01）。

> vite の `public/` は**使わない**（`publicDir: false`）。`public/` 配下に同名のデータを置くと
> そちらを先に掴み、**サーバーの実データではなくそちらを見てしまう**ことがあるため、経路を1本に固定している。
> 静的モード（`file://`）の確認は、ビルドした `index.html` を `workspaces.js` と
> `workspace-<id>/data/` の隣に置いて開く（`npm run e2e` がまさにそれを組み立てている）。

`ERD_PORT` を変えた場合は、ビューア側にも同じ値を渡す（プロキシ先を合わせるため）:

```sh
cd server && ERD_PORT=5400 ./gradlew devServer
cd viewer && ERD_PORT=5400 npm run dev
```

PowerShell では `$env:ERD_PORT="5400"` を先に実行する。

### 動作確認用の DB

逆生成を実 DB に対して試すための PostgreSQL（docker compose）と、
段階的に適用できるマイグレーション一式を [dev-db/](dev-db/README.md) に用意している。

コンテナは**空の DB で起動する**。スキーマは初期化（`000_init.sql`）も含めて migrate.mjs で入れる。

```sh
cd dev-db && docker compose up -d && npm install
node migrate.mjs up 000     # 初期スキーマ（約30テーブル。同梱サンプルの元データ）
node migrate.mjs up 001     # ENUM / CHECK / 部分・式インデックスまで適用
```

追加 DB の内省検証（Phase 7）として **SQL Server / Oracle**（docker compose の profile 分け）と
**SQLite**（docker 不要・プロセス内）も用意している。詳細は
[dev-db/README.md](dev-db/README.md#追加-db-の検証phase-7-sql-server--oracle--sqlite) を参照。

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

手順:

1. リポジトリ直下の **`VERSION`** を更新してコミットする（例 `0.3.0`）
2. **タグを打つ**: `git tag v0.3.0`（**タグと `VERSION` は必ず一致させる**）
3. Windows なら **`build-dist.bat`**、macOS / Linux なら **`./build-dist.sh`** を実行する
   （npm install → viewer ビルド → shadowJar → ZIP 組み立てまで自動。`--no-pause` で自動化にも使える）
4. `server/build/dist/erd.zip` を GitHub Releases に手動アップロードする

手動でビルドする場合:

```sh
cd server && ERD_RELEASE=1 ./gradlew packageDist
```

ZIP 名にバージョンは含めない（リリースのバージョンは GitHub Releases のタグで示す）。

### バージョン

**リポジトリ直下の `VERSION`（1行）が単一の真実源**。ビルド時に `index.html`（vite の define）と
`erd-server.jar`（マニフェストの `Implementation-Version`）の両方へ焼き込まれ、画面右上の
**information（ⓘ）** に表示される。サーバーモードでは jar 側の版も `GET /__erd/health` から取得して
並べ、食い違っていれば注意文を出す（`index.html` だけ差し替えたときに気づける）。

**リリースビルド（`build-dist.*`）だけが `ERD_RELEASE=1`** を立て、`VERSION` そのままの版になる。
それ以外の手元ビルドは `-dev` が付く（例 `0.2.0-dev`）。`gradlew devServer` のような jar 外実行は `dev`。

データ形式の版（`schemaVersion`）とは**独立した軸**で、連動させない。

JDBC ドライバは配布物に同梱しない。利用者は逆生成画面から主要 DB のドライバを
Maven からダウンロードできる（設定は全ワークスペース共通の `erd/config.js` の `drivers`、既定バージョンは
`DriverCatalog`）。ライセンス（MySQL は GPL、Oracle は proprietary）と ZIP サイズを
避けるための方針。

## 同梱サンプルデータの再生成

`dev-db/postgresql/migrations/000_init.sql`（dev-db の初期スキーマ = 同梱サンプルの元データ）を
変更した場合:

```sh
cd server && ./gradlew generateSampleData
```

`server/src/main/resources/erd-sample/` が再生成されるので、目視確認してコミットする。
