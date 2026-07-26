# ER図管理ツール

DB スキーマの ER 図・テーブルカタログを Git 管理できる形式で保守するツールです。

## 同梱物

| ファイル | 説明 |
|---|---|
| `erd-server.jar` | サーバーモード本体（要 Java 17+） |
| `index.html` | ビューア。ブラウザで直接開ける単一 HTML |
| `erd.bat` / `erd.sh` | サーバーモードの起動スクリプト |
| `drivers/` | JDBC ドライバの置き場（初期は空。**全ワークスペース共通**）。逆生成画面から主要 DB のドライバをダウンロードできる。手動で jar を置くことも可（`drivers/README.txt` 参照） |

## セットアップ

1. この ZIP の中身をプロジェクトリポジトリの `erd/` ディレクトリに展開する
2. `.gitignore` に以下を追加する（手動。ツールは自動追記しません）

   ```
   erd/erd-server.jar
   erd/drivers/
   erd/erd.sh
   erd/erd.bat
   .erd/
   ```

3. `.gitattributes` に以下を追加する

   ```
   erd/index.html binary
   erd/workspace-*/data/** text eol=lf
   ```

## 使い方

### 編集者（サーバーモード。要 Java 17+）

`erd.bat`（Windows）または `./erd.sh`（macOS / Linux）を実行すると、
`http://127.0.0.1:5321/` でサーバーが起動し、ブラウザが自動で開きます。

初回はワークスペースの作成画面が表示されます。**ワークスペースはデータベース1つ分**で、
ID（英数・ハイフン・アンダーバー。省略時は `default`）と表示名を入力すると
`workspace-<ID>/` が作られます。複数の DB を扱う場合は、アプリタイトル横の
プルダウンから追加・切り替えできます。

続けてブートストラップ画面が表示されます。「サンプルデータを取り込む」を選ぶと、
約30テーブルの完成済みサンプルが `workspace-<ID>/data/` に書き出され、DB なしで機能を試せます。

編集後は `erd/index.html`・`erd/workspaces.js`・`erd/workspace-*/data/**`
（ドライバ設定を変えた場合は `erd/config.js` も）をコミット・プッシュしてください。

### 閲覧者（静的モード。Java 不要）

`git pull` して `erd/index.html` をブラウザで開くだけです。
ER図の閲覧・検索・テーブルカタログがそのまま使えます。
