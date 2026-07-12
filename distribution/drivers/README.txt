このディレクトリには JDBC ドライバの jar を置きます。

サーバー起動時に drivers/*.jar が自動スキャンされ、DB からのスキーマ逆生成に
使用されます（逆生成は今後のバージョンで提供予定です）。

例:
  drivers/postgresql-42.7.4.jar
  drivers/mysql-connector-j-9.1.0.jar

このディレクトリは Git 管理しないでください（.gitignore に erd/drivers/ を追加）。
