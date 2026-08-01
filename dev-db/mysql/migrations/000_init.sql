-- 追加 DB 検証用スキーマ（MySQL）。
--
-- dev-db/postgresql/migrations/000_init.sql（同梱サンプルの元データ。26テーブル）を
-- MySQL の方言へ移植したもの。MySQL にスキーマ（ネームスペース）の概念は無く、
-- データベース（erd_sample）が catalog になる。
-- docker compose --profile mysql up -d のとき、初回起動でこのファイルが自動で流れる。
--
-- MySQL は PostgreSQL と並んで**層2（DialectEnhancer）を持つ**製品なので、層1だけの
-- SQL Server / Oracle / SQLite とは確かめたいことが違う:
--   - CHECK 制約が dialect に入る（MysqlEnhancer。JDBC 標準に API が無い。要 8.0.16+）
--   - unsigned・tinyint(1) の正規化（層1の TypeMapper が担当）
--   - AUTO_INCREMENT が autoIncrement として取れる
--   - FK を張ると InnoDB が**自動でインデックスを作る**（内省結果の indexes に出る）
--
-- 移植で変えたところ（PostgreSQL 版との差）:
--   - SERIAL       ... INT AUTO_INCREMENT（MySQL の SERIAL は BIGINT UNSIGNED の別名で
--                      意味が変わるため使わない）
--   - TEXT         ... TEXT（そのまま）
--   - NUMERIC      ... DECIMAL。MySQL では NUMERIC は DECIMAL の別名で、TYPE_NAME も DECIMAL になる
--   - TIMESTAMPTZ  ... DATETIME。MySQL の TIMESTAMP は 2038年問題と暗黙のタイムゾーン変換があり、
--                      検証用のスキーマには向かない
--   - コメント     ... 表コメント（COMMENT='...'）を付ける。MySQL は表・列コメントを
--                      information_schema に持ち、REMARKS として取れる
--   - 制約名       ... PostgreSQL が自動で付けるのと同じ形を明示的に付ける。ただし主キーの
--                      制約名は MySQL が常に PRIMARY に固定するため付けない
--
-- 文は「1文 = セミコロン終端、文中にセミコロンを含めない」で書く（テストの素朴な分割器のため）。
-- このコメント自身にもセミコロン記号を書いてはならない。
-- DROP は冪等化のためテスト側が事前に流す（ここには置かない）。

-- -----------------------------
-- ユーザー管理
-- -----------------------------
CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    password VARCHAR(255) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT users_email_key UNIQUE (email)
) COMMENT='ユーザー情報';

CREATE TABLE user_profiles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    full_name VARCHAR(255),
    phone_number VARCHAR(20),
    birth_date DATE,
    CONSTRAINT user_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id)
) COMMENT='ユーザープロファイル';

CREATE TABLE user_addresses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    address_line1 VARCHAR(255) NOT NULL,
    address_line2 VARCHAR(255),
    city VARCHAR(100),
    postal_code VARCHAR(20),
    country VARCHAR(100),
    CONSTRAINT user_addresses_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id)
) COMMENT='ユーザー住所';

CREATE TABLE user_sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    session_token VARCHAR(255) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    CONSTRAINT user_sessions_session_token_key UNIQUE (session_token),
    CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id)
) COMMENT='ユーザーログインセッション';

CREATE TABLE roles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    role_name VARCHAR(50) NOT NULL,
    CONSTRAINT roles_role_name_key UNIQUE (role_name)
) COMMENT='ロール（権限）';

CREATE TABLE user_roles (
    user_id INT NOT NULL,
    role_id INT NOT NULL,
    PRIMARY KEY (user_id, role_id),
    CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id),
    CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES roles(id)
) COMMENT='ユーザーとロールの紐付け';

-- -----------------------------
-- 商品管理
-- -----------------------------
CREATE TABLE product_categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    category_name VARCHAR(100) NOT NULL,
    CONSTRAINT product_categories_category_name_key UNIQUE (category_name)
) COMMENT='商品カテゴリ';

CREATE TABLE products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    category_id INT,
    product_name VARCHAR(255) NOT NULL,
    description TEXT,
    price DECIMAL(10, 2) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT products_category_id_fkey FOREIGN KEY (category_id) REFERENCES product_categories(id)
) COMMENT='商品';

CREATE TABLE product_images (
    id INT AUTO_INCREMENT PRIMARY KEY,
    product_id INT NOT NULL,
    image_url VARCHAR(500) NOT NULL,
    CONSTRAINT product_images_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id)
) COMMENT='商品画像';

CREATE TABLE inventories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    product_id INT NOT NULL,
    quantity INT NOT NULL DEFAULT 0,
    CONSTRAINT inventories_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id)
) COMMENT='在庫管理';

CREATE TABLE product_reviews (
    id INT AUTO_INCREMENT PRIMARY KEY,
    product_id INT NOT NULL,
    user_id INT NOT NULL,
    rating INT NOT NULL,
    comment TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT product_reviews_rating_check CHECK (rating BETWEEN 1 AND 5),
    CONSTRAINT product_reviews_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id),
    CONSTRAINT product_reviews_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id)
) COMMENT='商品レビュー';

CREATE TABLE product_tags (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tag_name VARCHAR(50) NOT NULL,
    CONSTRAINT product_tags_tag_name_key UNIQUE (tag_name)
) COMMENT='商品タグ';

CREATE TABLE product_tag_mappings (
    product_id INT NOT NULL,
    tag_id INT NOT NULL,
    PRIMARY KEY (product_id, tag_id),
    CONSTRAINT product_tag_mappings_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id),
    CONSTRAINT product_tag_mappings_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES product_tags(id)
) COMMENT='商品とタグのマッピング';

-- -----------------------------
-- 注文管理
-- -----------------------------
CREATE TABLE orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    order_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(50) NOT NULL,
    CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id)
) COMMENT='注文';

CREATE TABLE order_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_id INT NOT NULL,
    product_id INT NOT NULL,
    quantity INT NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id),
    CONSTRAINT order_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id)
) COMMENT='注文アイテム';

CREATE TABLE shipments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_id INT NOT NULL,
    shipment_date DATETIME,
    carrier VARCHAR(100),
    CONSTRAINT shipments_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id)
) COMMENT='出荷情報';

CREATE TABLE order_status_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_id INT NOT NULL,
    status VARCHAR(50) NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT order_status_logs_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id)
) COMMENT='注文ステータス履歴';

CREATE TABLE order_cancellations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_id INT NOT NULL,
    reason TEXT,
    cancelled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT order_cancellations_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id)
) COMMENT='注文キャンセル情報';

-- -----------------------------
-- 決済管理
-- -----------------------------
CREATE TABLE payment_methods (
    id INT AUTO_INCREMENT PRIMARY KEY,
    method_name VARCHAR(50) NOT NULL,
    CONSTRAINT payment_methods_method_name_key UNIQUE (method_name)
) COMMENT='支払方法マスタ';

CREATE TABLE payments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_id INT NOT NULL,
    payment_method_id INT,
    payment_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    amount DECIMAL(10, 2) NOT NULL,
    CONSTRAINT payments_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id),
    CONSTRAINT payments_payment_method_id_fkey FOREIGN KEY (payment_method_id) REFERENCES payment_methods(id)
) COMMENT='支払情報';

CREATE TABLE payment_histories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    payment_id INT NOT NULL,
    status VARCHAR(50) NOT NULL,
    processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT payment_histories_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES payments(id)
) COMMENT='支払履歴詳細';

CREATE TABLE refunds (
    id INT AUTO_INCREMENT PRIMARY KEY,
    payment_id INT NOT NULL,
    refund_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    amount DECIMAL(10, 2) NOT NULL,
    CONSTRAINT refunds_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES payments(id)
) COMMENT='返金情報';

-- -----------------------------
-- ポイント管理
-- -----------------------------
CREATE TABLE points (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    balance INT NOT NULL DEFAULT 0,
    CONSTRAINT points_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id)
) COMMENT='ポイント残高';

CREATE TABLE point_transactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    points INT NOT NULL,
    transaction_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    description VARCHAR(255),
    CONSTRAINT point_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id)
) COMMENT='ポイント履歴';

CREATE TABLE point_campaigns (
    id INT AUTO_INCREMENT PRIMARY KEY,
    campaign_name VARCHAR(100) NOT NULL,
    start_date DATE,
    end_date DATE
) COMMENT='ポイントキャンペーン';

CREATE TABLE point_bonus_rules (
    id INT AUTO_INCREMENT PRIMARY KEY,
    campaign_id INT NOT NULL,
    bonus_rate DECIMAL(5, 2) NOT NULL,
    CONSTRAINT point_bonus_rules_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES point_campaigns(id)
) COMMENT='ボーナスポイントルール';
