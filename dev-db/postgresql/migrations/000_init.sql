-- PostgreSQL用 DDLサンプル（約30テーブル）。dev-db の初期スキーマ（migrate.mjs が最初に流す）。
--
-- このファイルは2つの役割を兼ねる:
--   1. dev-db（PostgreSQL）の初期スキーマ。001 以降のマイグレーションはこの上に積む
--   2. **同梱サンプルデータの元データ**（gradlew generateSampleData がここをパースして
--      server/src/main/resources/erd-sample を生成する）
--
-- 2 のため、**このファイルは PostgreSQL 方言のままでなければならない**（パーサが PostgreSQL 前提）。
-- 他 DB 製品の同等スキーマは dev-db/<product>/migrations/000_init.sql に別に置いてある。
--
-- スキーマ: public

-- -----------------------------
-- ユーザー管理
-- -----------------------------
CREATE TABLE public.users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE public.users IS 'ユーザー情報';

CREATE TABLE public.user_profiles (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES public.users(id),
    full_name VARCHAR(255),
    phone_number VARCHAR(20),
    birth_date DATE
);
COMMENT ON TABLE public.user_profiles IS 'ユーザープロファイル';

CREATE TABLE public.user_addresses (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES public.users(id),
    address_line1 VARCHAR(255) NOT NULL,
    address_line2 VARCHAR(255),
    city VARCHAR(100),
    postal_code VARCHAR(20),
    country VARCHAR(100)
);
COMMENT ON TABLE public.user_addresses IS 'ユーザー住所';

CREATE TABLE public.user_sessions (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES public.users(id),
    session_token VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ
);
COMMENT ON TABLE public.user_sessions IS 'ユーザーログインセッション';

CREATE TABLE public.roles (
    id SERIAL PRIMARY KEY,
    role_name VARCHAR(50) NOT NULL UNIQUE
);
COMMENT ON TABLE public.roles IS 'ロール（権限）';

CREATE TABLE public.user_roles (
    user_id INT NOT NULL REFERENCES public.users(id),
    role_id INT NOT NULL REFERENCES public.roles(id),
    PRIMARY KEY (user_id, role_id)
);
COMMENT ON TABLE public.user_roles IS 'ユーザーとロールの紐付け';

-- -----------------------------
-- 商品管理
-- -----------------------------
CREATE TABLE public.product_categories (
    id SERIAL PRIMARY KEY,
    category_name VARCHAR(100) NOT NULL UNIQUE
);
COMMENT ON TABLE public.product_categories IS '商品カテゴリ';

CREATE TABLE public.products (
    id SERIAL PRIMARY KEY,
    category_id INT REFERENCES public.product_categories(id),
    product_name VARCHAR(255) NOT NULL,
    description TEXT,
    price NUMERIC(10,2) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE public.products IS '商品';

CREATE TABLE public.product_images (
    id SERIAL PRIMARY KEY,
    product_id INT NOT NULL REFERENCES public.products(id),
    image_url VARCHAR(500) NOT NULL
);
COMMENT ON TABLE public.product_images IS '商品画像';

CREATE TABLE public.inventories (
    id SERIAL PRIMARY KEY,
    product_id INT NOT NULL REFERENCES public.products(id),
    quantity INT NOT NULL DEFAULT 0
);
COMMENT ON TABLE public.inventories IS '在庫管理';

CREATE TABLE public.product_reviews (
    id SERIAL PRIMARY KEY,
    product_id INT NOT NULL REFERENCES public.products(id),
    user_id INT NOT NULL REFERENCES public.users(id),
    rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE public.product_reviews IS '商品レビュー';

CREATE TABLE public.product_tags (
    id SERIAL PRIMARY KEY,
    tag_name VARCHAR(50) NOT NULL UNIQUE
);
COMMENT ON TABLE public.product_tags IS '商品タグ';

CREATE TABLE public.product_tag_mappings (
    product_id INT NOT NULL REFERENCES public.products(id),
    tag_id INT NOT NULL REFERENCES public.product_tags(id),
    PRIMARY KEY (product_id, tag_id)
);
COMMENT ON TABLE public.product_tag_mappings IS '商品とタグのマッピング';

-- -----------------------------
-- 注文管理
-- -----------------------------
CREATE TABLE public.orders (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES public.users(id),
    order_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(50) NOT NULL
);
COMMENT ON TABLE public.orders IS '注文';

CREATE TABLE public.order_items (
    id SERIAL PRIMARY KEY,
    order_id INT NOT NULL REFERENCES public.orders(id),
    product_id INT NOT NULL REFERENCES public.products(id),
    quantity INT NOT NULL,
    price NUMERIC(10,2) NOT NULL
);
COMMENT ON TABLE public.order_items IS '注文アイテム';

CREATE TABLE public.shipments (
    id SERIAL PRIMARY KEY,
    order_id INT NOT NULL REFERENCES public.orders(id),
    shipment_date TIMESTAMPTZ,
    carrier VARCHAR(100)
);
COMMENT ON TABLE public.shipments IS '出荷情報';

CREATE TABLE public.order_status_logs (
    id SERIAL PRIMARY KEY,
    order_id INT NOT NULL REFERENCES public.orders(id),
    status VARCHAR(50) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE public.order_status_logs IS '注文ステータス履歴';

CREATE TABLE public.order_cancellations (
    id SERIAL PRIMARY KEY,
    order_id INT NOT NULL REFERENCES public.orders(id),
    reason TEXT,
    cancelled_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE public.order_cancellations IS '注文キャンセル情報';

-- -----------------------------
-- 決済管理
-- -----------------------------
CREATE TABLE public.payment_methods (
    id SERIAL PRIMARY KEY,
    method_name VARCHAR(50) NOT NULL UNIQUE
);
COMMENT ON TABLE public.payment_methods IS '支払方法マスタ';

CREATE TABLE public.payments (
    id SERIAL PRIMARY KEY,
    order_id INT NOT NULL REFERENCES public.orders(id),
    payment_method_id INT REFERENCES public.payment_methods(id),
    payment_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    amount NUMERIC(10,2) NOT NULL
);
COMMENT ON TABLE public.payments IS '支払情報';

CREATE TABLE public.payment_histories (
    id SERIAL PRIMARY KEY,
    payment_id INT NOT NULL REFERENCES public.payments(id),
    status VARCHAR(50) NOT NULL,
    processed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE public.payment_histories IS '支払履歴詳細';

CREATE TABLE public.refunds (
    id SERIAL PRIMARY KEY,
    payment_id INT NOT NULL REFERENCES public.payments(id),
    refund_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    amount NUMERIC(10,2) NOT NULL
);
COMMENT ON TABLE public.refunds IS '返金情報';

-- -----------------------------
-- ポイント管理
-- -----------------------------
CREATE TABLE public.points (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES public.users(id),
    balance INT NOT NULL DEFAULT 0
);
COMMENT ON TABLE public.points IS 'ポイント残高';

CREATE TABLE public.point_transactions (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES public.users(id),
    points INT NOT NULL,
    transaction_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    description VARCHAR(255)
);
COMMENT ON TABLE public.point_transactions IS 'ポイント履歴';

CREATE TABLE public.point_campaigns (
    id SERIAL PRIMARY KEY,
    campaign_name VARCHAR(100) NOT NULL,
    start_date DATE,
    end_date DATE
);
COMMENT ON TABLE public.point_campaigns IS 'ポイントキャンペーン';

CREATE TABLE public.point_bonus_rules (
    id SERIAL PRIMARY KEY,
    campaign_id INT NOT NULL REFERENCES public.point_campaigns(id),
    bonus_rate NUMERIC(5,2) NOT NULL -- 例: 10.00 (%表記)
);
COMMENT ON TABLE public.point_bonus_rules IS 'ボーナスポイントルール';
