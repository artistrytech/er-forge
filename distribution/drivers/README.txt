このディレクトリには JDBC ドライバの jar を置きます。

サーバー起動時に drivers/*.jar が自動スキャンされ、DB からのスキーマ逆生成に
使用されます。ロード済みドライバは GUI の逆生成画面で確認できます。

■ ドライバの取得（かんたん・推奨）

配布物にドライバは同梱していません。GUI の逆生成画面（DB からの逆生成）を開くと、
使う DB を選んでダウンロードできます。

  - 使う DB を選ぶと、設定は data/config.js に保存されます（Git 管理・チーム共有）
  - jar の実体はこのディレクトリ（drivers/）にダウンロードされます（各自の環境）
  - 一度チームの誰かが設定すれば、他メンバーは逆生成画面を開いたときに
    「未取得のドライバがあります」と表示され、ダウンロードするだけで揃います

主要 DB（PostgreSQL / MySQL / SQL Server / Oracle / SQLite / H2）は既定バージョンを
用意しています。バージョンや Maven リポジトリは画面から任意に変更できます。

■ 手動で置くこともできます

ここに無い DB のドライバや、社内リポジトリの jar は、この drivers/ に直接置いて
サーバーを再起動すれば使えます。

  例:
    drivers/postgresql-42.7.4.jar
    drivers/mysql-connector-j-9.1.0.jar

■ 注意

このディレクトリ（の jar）は Git 管理しないでください（.gitignore に erd/drivers/ を追加）。
共有するのは「どのドライバを使うか」という設定（config.js）だけで、jar の実体は各自が持ちます。

同梱していないのは意図的です。各ドライバのライセンス（MySQL は GPLv2 + FOSS 例外、
Oracle は Oracle Free Use Terms and Conditions など）に応じた再配布判断を、
利用者側に委ねるためです。
