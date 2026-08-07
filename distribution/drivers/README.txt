English
=======

Place JDBC driver JAR files in this directory.

When the server starts, `drivers/*.jar` is scanned automatically and used for
schema reverse engineering from databases. Loaded drivers can be checked in the
GUI reverse engineering screen.

Driver Download (Easy and Recommended)
--------------------------------------

Drivers are not bundled in the distribution. Open the GUI reverse engineering
screen (reverse engineering from database), choose the database you use, and
download the driver from there.

  - When you choose a database, the setting is saved to `data/config.js`
    (tracked by Git and shared by the team)
  - The actual JAR file is downloaded into this directory (`drivers/`) on each
    user's environment
  - Once someone on the team has configured it, other members will see a
    "missing drivers" message when they open the reverse engineering screen, and
    can get set up by downloading the driver

Default versions are prepared for major databases (PostgreSQL / MySQL /
SQL Server / Oracle / SQLite / H2). Versions and Maven repositories can be
changed freely from the screen.

Manual Placement
----------------

For drivers not listed in the screen, or JAR files from an internal repository,
place them directly in this `drivers/` directory and restart the server.

  Examples:
    drivers/postgresql-42.7.4.jar
    drivers/mysql-connector-j-9.1.0.jar

Notes
-----

JAR files in this directory are not tracked by Git. The bundled `erd/.gitignore`
already excludes `drivers/*.jar`. This `README.txt` is tracked by Git.
Only the setting that describes which driver to use (`config.js`) is shared; the
actual JAR files are kept by each user.

Drivers are intentionally not bundled. This leaves redistribution decisions to
users according to each driver's license, such as GPLv2 with the FOSS exception
for MySQL or the Oracle Free Use Terms and Conditions for Oracle.

日本語
======

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

このディレクトリの jar は Git 管理しません（同梱の erd/.gitignore が drivers/*.jar を
除外済みです）。この README.txt は Git 管理します。
共有するのは「どのドライバを使うか」という設定（config.js）だけで、jar の実体は各自が持ちます。

同梱していないのは意図的です。各ドライバのライセンス（MySQL は GPLv2 + FOSS 例外、
Oracle は Oracle Free Use Terms and Conditions など）に応じた再配布判断を、
利用者側に委ねるためです。
