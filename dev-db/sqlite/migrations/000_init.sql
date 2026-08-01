-- 追加 DB 検証用スキーマ（SQLite）。Phase 7。
--
-- dev-db/postgresql/migrations/000_init.sql（同梱サンプルの元データ。26テーブル）を
-- SQLite の方言へ移植したもの。SQLite にはスキーマ（ネームスペース）の概念が無いため、
-- 層1（JdbcIntrospector）が catalog モードへフォールバックする経路の検証に使う。
-- サーバーを立てないので、内省テスト（SqliteIntrospectorTest）はプロセス内で完結する。
--
-- 確かめたいこと:
--   - スキーマの無い DB でも標準メタデータで内省できる
--   - INTEGER PRIMARY KEY AUTOINCREMENT が autoIncrement として取れる
--   - 型アフィニティ（宣言型がそのまま TYPE_NAME に出る）でも正規化が成立する
--   - PK の裏付けインデックスを畳み、UNIQUE 制約を uniques に振り分ける
--
-- 移植で変えたところ（PostgreSQL 版との差）:
--   - SERIAL       ... INTEGER PRIMARY KEY AUTOINCREMENT。SQLite では rowid の別名として
--                      **列定義にインラインで書く**必要があるため、単独主キーだけ制約名を付けない
--   - TIMESTAMPTZ  ... DATETIME。SQLite に日付時刻型は無く、宣言型がそのまま記録される
--   - コメント     ... 付けない（SQLite に COMMENT 構文が無い）。論理名の初期値補完は
--                      PostgreSQL / Oracle 側で検証する
--   - 制約名       ... PostgreSQL が自動で付けるのと同じ形を明示的に付ける
--   - UNIQUE       ... 表制約ではなく **CREATE UNIQUE INDEX** で書く。SQLite は UNIQUE 制約の
--                      裏付けインデックスに sqlite_autoindex_<表>_<連番> という名前を付け、
--                      制約名を残さないため、内省結果が他製品と揃わなくなる
--
-- 文は「1文 = セミコロン終端、文中にセミコロンを含めない」で書く（テストの素朴な分割器のため）。
-- このコメント自身にもセミコロン記号を書いてはならない。
-- DROP は不要（テストは :memory: に毎回作り直す）。

-- -----------------------------
-- ユーザー管理
-- -----------------------------
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email VARCHAR(255) NOT NULL,
    password VARCHAR(255) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX users_email_key ON users(email);

CREATE TABLE user_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    full_name VARCHAR(255),
    phone_number VARCHAR(20),
    birth_date DATE,
    CONSTRAINT user_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE user_addresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    address_line1 VARCHAR(255) NOT NULL,
    address_line2 VARCHAR(255),
    city VARCHAR(100),
    postal_code VARCHAR(20),
    country VARCHAR(100),
    CONSTRAINT user_addresses_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE user_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    session_token VARCHAR(255) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE UNIQUE INDEX user_sessions_session_token_key ON user_sessions(session_token);

CREATE TABLE roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role_name VARCHAR(50) NOT NULL
);

CREATE UNIQUE INDEX roles_role_name_key ON roles(role_name);

CREATE TABLE user_roles (
    user_id INTEGER NOT NULL,
    role_id INTEGER NOT NULL,
    CONSTRAINT user_roles_pkey PRIMARY KEY (user_id, role_id),
    CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id),
    CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES roles(id)
);

-- -----------------------------
-- 商品管理
-- -----------------------------
CREATE TABLE product_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_name VARCHAR(100) NOT NULL
);

CREATE UNIQUE INDEX product_categories_category_name_key ON product_categories(category_name);

CREATE TABLE products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER,
    product_name VARCHAR(255) NOT NULL,
    description TEXT,
    price NUMERIC(10, 2) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT products_category_id_fkey FOREIGN KEY (category_id) REFERENCES product_categories(id)
);

CREATE TABLE product_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    image_url VARCHAR(500) NOT NULL,
    CONSTRAINT product_images_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE inventories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT inventories_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE product_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT product_reviews_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id),
    CONSTRAINT product_reviews_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE product_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag_name VARCHAR(50) NOT NULL
);

CREATE UNIQUE INDEX product_tags_tag_name_key ON product_tags(tag_name);

CREATE TABLE product_tag_mappings (
    product_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    CONSTRAINT product_tag_mappings_pkey PRIMARY KEY (product_id, tag_id),
    CONSTRAINT product_tag_mappings_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id),
    CONSTRAINT product_tag_mappings_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES product_tags(id)
);

-- -----------------------------
-- 注文管理
-- -----------------------------
CREATE TABLE orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    order_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(50) NOT NULL,
    CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    price NUMERIC(10, 2) NOT NULL,
    CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id),
    CONSTRAINT order_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE shipments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    shipment_date DATETIME,
    carrier VARCHAR(100),
    CONSTRAINT shipments_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE TABLE order_status_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    status VARCHAR(50) NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT order_status_logs_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE TABLE order_cancellations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    reason TEXT,
    cancelled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT order_cancellations_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id)
);

-- -----------------------------
-- 決済管理
-- -----------------------------
CREATE TABLE payment_methods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    method_name VARCHAR(50) NOT NULL
);

CREATE UNIQUE INDEX payment_methods_method_name_key ON payment_methods(method_name);

CREATE TABLE payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    payment_method_id INTEGER,
    payment_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    amount NUMERIC(10, 2) NOT NULL,
    CONSTRAINT payments_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id),
    CONSTRAINT payments_payment_method_id_fkey FOREIGN KEY (payment_method_id) REFERENCES payment_methods(id)
);

CREATE TABLE payment_histories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id INTEGER NOT NULL,
    status VARCHAR(50) NOT NULL,
    processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT payment_histories_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES payments(id)
);

CREATE TABLE refunds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id INTEGER NOT NULL,
    refund_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    amount NUMERIC(10, 2) NOT NULL,
    CONSTRAINT refunds_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES payments(id)
);

-- -----------------------------
-- ポイント管理
-- -----------------------------
CREATE TABLE points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT points_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE point_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    points INTEGER NOT NULL,
    transaction_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    description VARCHAR(255),
    CONSTRAINT point_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE point_campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_name VARCHAR(100) NOT NULL,
    start_date DATE,
    end_date DATE
);

CREATE TABLE point_bonus_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    bonus_rate NUMERIC(5, 2) NOT NULL,
    CONSTRAINT point_bonus_rules_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES point_campaigns(id)
);
