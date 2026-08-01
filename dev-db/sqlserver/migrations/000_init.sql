-- 追加 DB 検証用スキーマ（SQL Server / T-SQL）。Phase 7。
--
-- dev-db/postgresql/migrations/000_init.sql（同梱サンプルの元データ。26テーブル）を
-- SQL Server の方言へ移植したもの。スキーマは既定の dbo。
-- 手動 GUI 検証（docker compose --profile mssql up -d）と内省テスト
-- （SqlServerIntrospectorTest）で同じファイルを使う。
--
-- 確かめたいこと:
--   - スキーマモード（getSchemas() が dbo を返す）で内省できる
--   - IDENTITY 列が autoIncrement として取れる
--   - NVARCHAR / DATETIME2 / NUMERIC / DATE の logicalType 正規化
--   - PK の裏付けインデックスを畳み、UNIQUE 制約を uniques に振り分ける
--   - 複合主キー・複合 FK・自己参照のない多対多（user_roles / product_tag_mappings）
--
-- 移植で変えたところ（PostgreSQL 版との差）:
--   - SERIAL       ... INT IDENTITY(1, 1)
--   - VARCHAR      ... NVARCHAR（日本語を含むデータを想定するため）
--   - TEXT         ... NVARCHAR(MAX)
--   - TIMESTAMPTZ  ... DATETIME2。DATETIMEOFFSET はドライバ固有の DATA_TYPE を返し
--                      正規化の検証から外れるため使わない
--   - 制約名       ... PostgreSQL が自動で付けるのと同じ形（<表>_pkey / <表>_<列>_key /
--                      <表>_<列>_fkey）を明示的に付ける。内省結果を製品間で比べやすくするため
--   - コメント     ... 付けない。SQL Server の表・列コメントは拡張プロパティに入り、
--                      JDBC の REMARKS には出ない（論理名の初期値補完は PostgreSQL / Oracle で検証する）
--
-- 文は「1文 = セミコロン終端、文中にセミコロンを含めない」で書く（テストの素朴な分割器のため）。
-- このコメント自身にもセミコロン記号を書いてはならない（分割器は行コメントを剥がす前に分割する）。
-- DROP は冪等化のためテスト側が事前に流す（ここには置かない）。

-- -----------------------------
-- ユーザー管理
-- -----------------------------
CREATE TABLE dbo.users (
    id INT IDENTITY(1, 1) NOT NULL,
    email NVARCHAR(255) NOT NULL,
    password NVARCHAR(255) NOT NULL,
    created_at DATETIME2 DEFAULT SYSUTCDATETIME(),
    updated_at DATETIME2 DEFAULT SYSUTCDATETIME(),
    CONSTRAINT users_pkey PRIMARY KEY (id),
    CONSTRAINT users_email_key UNIQUE (email)
);

CREATE TABLE dbo.user_profiles (
    id INT IDENTITY(1, 1) NOT NULL,
    user_id INT NOT NULL,
    full_name NVARCHAR(255),
    phone_number NVARCHAR(20),
    birth_date DATE,
    CONSTRAINT user_profiles_pkey PRIMARY KEY (id),
    CONSTRAINT user_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES dbo.users(id)
);

CREATE TABLE dbo.user_addresses (
    id INT IDENTITY(1, 1) NOT NULL,
    user_id INT NOT NULL,
    address_line1 NVARCHAR(255) NOT NULL,
    address_line2 NVARCHAR(255),
    city NVARCHAR(100),
    postal_code NVARCHAR(20),
    country NVARCHAR(100),
    CONSTRAINT user_addresses_pkey PRIMARY KEY (id),
    CONSTRAINT user_addresses_user_id_fkey FOREIGN KEY (user_id) REFERENCES dbo.users(id)
);

CREATE TABLE dbo.user_sessions (
    id INT IDENTITY(1, 1) NOT NULL,
    user_id INT NOT NULL,
    session_token NVARCHAR(255) NOT NULL,
    created_at DATETIME2 DEFAULT SYSUTCDATETIME(),
    expires_at DATETIME2,
    CONSTRAINT user_sessions_pkey PRIMARY KEY (id),
    CONSTRAINT user_sessions_session_token_key UNIQUE (session_token),
    CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES dbo.users(id)
);

CREATE TABLE dbo.roles (
    id INT IDENTITY(1, 1) NOT NULL,
    role_name NVARCHAR(50) NOT NULL,
    CONSTRAINT roles_pkey PRIMARY KEY (id),
    CONSTRAINT roles_role_name_key UNIQUE (role_name)
);

CREATE TABLE dbo.user_roles (
    user_id INT NOT NULL,
    role_id INT NOT NULL,
    CONSTRAINT user_roles_pkey PRIMARY KEY (user_id, role_id),
    CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES dbo.users(id),
    CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES dbo.roles(id)
);

-- -----------------------------
-- 商品管理
-- -----------------------------
CREATE TABLE dbo.product_categories (
    id INT IDENTITY(1, 1) NOT NULL,
    category_name NVARCHAR(100) NOT NULL,
    CONSTRAINT product_categories_pkey PRIMARY KEY (id),
    CONSTRAINT product_categories_category_name_key UNIQUE (category_name)
);

CREATE TABLE dbo.products (
    id INT IDENTITY(1, 1) NOT NULL,
    category_id INT,
    product_name NVARCHAR(255) NOT NULL,
    description NVARCHAR(MAX),
    price NUMERIC(10, 2) NOT NULL,
    created_at DATETIME2 DEFAULT SYSUTCDATETIME(),
    CONSTRAINT products_pkey PRIMARY KEY (id),
    CONSTRAINT products_category_id_fkey FOREIGN KEY (category_id) REFERENCES dbo.product_categories(id)
);

CREATE TABLE dbo.product_images (
    id INT IDENTITY(1, 1) NOT NULL,
    product_id INT NOT NULL,
    image_url NVARCHAR(500) NOT NULL,
    CONSTRAINT product_images_pkey PRIMARY KEY (id),
    CONSTRAINT product_images_product_id_fkey FOREIGN KEY (product_id) REFERENCES dbo.products(id)
);

CREATE TABLE dbo.inventories (
    id INT IDENTITY(1, 1) NOT NULL,
    product_id INT NOT NULL,
    quantity INT NOT NULL DEFAULT 0,
    CONSTRAINT inventories_pkey PRIMARY KEY (id),
    CONSTRAINT inventories_product_id_fkey FOREIGN KEY (product_id) REFERENCES dbo.products(id)
);

CREATE TABLE dbo.product_reviews (
    id INT IDENTITY(1, 1) NOT NULL,
    product_id INT NOT NULL,
    user_id INT NOT NULL,
    rating INT NOT NULL,
    comment NVARCHAR(MAX),
    created_at DATETIME2 DEFAULT SYSUTCDATETIME(),
    CONSTRAINT product_reviews_pkey PRIMARY KEY (id),
    CONSTRAINT product_reviews_rating_check CHECK (rating BETWEEN 1 AND 5),
    CONSTRAINT product_reviews_product_id_fkey FOREIGN KEY (product_id) REFERENCES dbo.products(id),
    CONSTRAINT product_reviews_user_id_fkey FOREIGN KEY (user_id) REFERENCES dbo.users(id)
);

CREATE TABLE dbo.product_tags (
    id INT IDENTITY(1, 1) NOT NULL,
    tag_name NVARCHAR(50) NOT NULL,
    CONSTRAINT product_tags_pkey PRIMARY KEY (id),
    CONSTRAINT product_tags_tag_name_key UNIQUE (tag_name)
);

CREATE TABLE dbo.product_tag_mappings (
    product_id INT NOT NULL,
    tag_id INT NOT NULL,
    CONSTRAINT product_tag_mappings_pkey PRIMARY KEY (product_id, tag_id),
    CONSTRAINT product_tag_mappings_product_id_fkey FOREIGN KEY (product_id) REFERENCES dbo.products(id),
    CONSTRAINT product_tag_mappings_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES dbo.product_tags(id)
);

-- -----------------------------
-- 注文管理
-- -----------------------------
CREATE TABLE dbo.orders (
    id INT IDENTITY(1, 1) NOT NULL,
    user_id INT NOT NULL,
    order_date DATETIME2 DEFAULT SYSUTCDATETIME(),
    status NVARCHAR(50) NOT NULL,
    CONSTRAINT orders_pkey PRIMARY KEY (id),
    CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES dbo.users(id)
);

CREATE TABLE dbo.order_items (
    id INT IDENTITY(1, 1) NOT NULL,
    order_id INT NOT NULL,
    product_id INT NOT NULL,
    quantity INT NOT NULL,
    price NUMERIC(10, 2) NOT NULL,
    CONSTRAINT order_items_pkey PRIMARY KEY (id),
    CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES dbo.orders(id),
    CONSTRAINT order_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES dbo.products(id)
);

CREATE TABLE dbo.shipments (
    id INT IDENTITY(1, 1) NOT NULL,
    order_id INT NOT NULL,
    shipment_date DATETIME2,
    carrier NVARCHAR(100),
    CONSTRAINT shipments_pkey PRIMARY KEY (id),
    CONSTRAINT shipments_order_id_fkey FOREIGN KEY (order_id) REFERENCES dbo.orders(id)
);

CREATE TABLE dbo.order_status_logs (
    id INT IDENTITY(1, 1) NOT NULL,
    order_id INT NOT NULL,
    status NVARCHAR(50) NOT NULL,
    updated_at DATETIME2 DEFAULT SYSUTCDATETIME(),
    CONSTRAINT order_status_logs_pkey PRIMARY KEY (id),
    CONSTRAINT order_status_logs_order_id_fkey FOREIGN KEY (order_id) REFERENCES dbo.orders(id)
);

CREATE TABLE dbo.order_cancellations (
    id INT IDENTITY(1, 1) NOT NULL,
    order_id INT NOT NULL,
    reason NVARCHAR(MAX),
    cancelled_at DATETIME2 DEFAULT SYSUTCDATETIME(),
    CONSTRAINT order_cancellations_pkey PRIMARY KEY (id),
    CONSTRAINT order_cancellations_order_id_fkey FOREIGN KEY (order_id) REFERENCES dbo.orders(id)
);

-- -----------------------------
-- 決済管理
-- -----------------------------
CREATE TABLE dbo.payment_methods (
    id INT IDENTITY(1, 1) NOT NULL,
    method_name NVARCHAR(50) NOT NULL,
    CONSTRAINT payment_methods_pkey PRIMARY KEY (id),
    CONSTRAINT payment_methods_method_name_key UNIQUE (method_name)
);

CREATE TABLE dbo.payments (
    id INT IDENTITY(1, 1) NOT NULL,
    order_id INT NOT NULL,
    payment_method_id INT,
    payment_date DATETIME2 DEFAULT SYSUTCDATETIME(),
    amount NUMERIC(10, 2) NOT NULL,
    CONSTRAINT payments_pkey PRIMARY KEY (id),
    CONSTRAINT payments_order_id_fkey FOREIGN KEY (order_id) REFERENCES dbo.orders(id),
    CONSTRAINT payments_payment_method_id_fkey FOREIGN KEY (payment_method_id) REFERENCES dbo.payment_methods(id)
);

CREATE TABLE dbo.payment_histories (
    id INT IDENTITY(1, 1) NOT NULL,
    payment_id INT NOT NULL,
    status NVARCHAR(50) NOT NULL,
    processed_at DATETIME2 DEFAULT SYSUTCDATETIME(),
    CONSTRAINT payment_histories_pkey PRIMARY KEY (id),
    CONSTRAINT payment_histories_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES dbo.payments(id)
);

CREATE TABLE dbo.refunds (
    id INT IDENTITY(1, 1) NOT NULL,
    payment_id INT NOT NULL,
    refund_date DATETIME2 DEFAULT SYSUTCDATETIME(),
    amount NUMERIC(10, 2) NOT NULL,
    CONSTRAINT refunds_pkey PRIMARY KEY (id),
    CONSTRAINT refunds_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES dbo.payments(id)
);

-- -----------------------------
-- ポイント管理
-- -----------------------------
CREATE TABLE dbo.points (
    id INT IDENTITY(1, 1) NOT NULL,
    user_id INT NOT NULL,
    balance INT NOT NULL DEFAULT 0,
    CONSTRAINT points_pkey PRIMARY KEY (id),
    CONSTRAINT points_user_id_fkey FOREIGN KEY (user_id) REFERENCES dbo.users(id)
);

CREATE TABLE dbo.point_transactions (
    id INT IDENTITY(1, 1) NOT NULL,
    user_id INT NOT NULL,
    points INT NOT NULL,
    transaction_date DATETIME2 DEFAULT SYSUTCDATETIME(),
    description NVARCHAR(255),
    CONSTRAINT point_transactions_pkey PRIMARY KEY (id),
    CONSTRAINT point_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES dbo.users(id)
);

CREATE TABLE dbo.point_campaigns (
    id INT IDENTITY(1, 1) NOT NULL,
    campaign_name NVARCHAR(100) NOT NULL,
    start_date DATE,
    end_date DATE,
    CONSTRAINT point_campaigns_pkey PRIMARY KEY (id)
);

CREATE TABLE dbo.point_bonus_rules (
    id INT IDENTITY(1, 1) NOT NULL,
    campaign_id INT NOT NULL,
    bonus_rate NUMERIC(5, 2) NOT NULL,
    CONSTRAINT point_bonus_rules_pkey PRIMARY KEY (id),
    CONSTRAINT point_bonus_rules_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES dbo.point_campaigns(id)
);
