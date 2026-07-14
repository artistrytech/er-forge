-- DialectEnhancer（層2 / §7.4）が拾う DB 固有情報を一通り足す。
-- JDBC 標準メタデータでは取得できないものばかりで、適用後に逆生成すると
-- スキーマファイルの meta ではなく `dialect` に現れる（G-04 の表示対象）。

-- ENUM 型（TYPE_NAME は型名しか返さないため、値一覧は pg_enum から取る）。
-- 既存の varchar カラムを ENUM に移行する（型変更の差分も同時に出る）
CREATE TYPE public.order_status AS ENUM ('pending', 'paid', 'shipped', 'cancelled');

ALTER TABLE public.orders
    ALTER COLUMN status TYPE public.order_status
        USING status::public.order_status,
    ALTER COLUMN status SET DEFAULT 'pending';
COMMENT ON COLUMN public.orders.status IS '注文ステータス';

-- CHECK 制約（JDBC 標準に API が存在しない）
ALTER TABLE public.products
    ADD CONSTRAINT products_price_check CHECK (price >= 0);

-- 部分インデックス（WHERE 付き）と式インデックス。getIndexInfo では表現できない
ALTER TABLE public.users ADD COLUMN deleted_at TIMESTAMPTZ;
COMMENT ON COLUMN public.users.deleted_at IS '削除日時';

CREATE INDEX idx_users_active_email
    ON public.users (email)
    WHERE deleted_at IS NULL;

CREATE INDEX idx_users_lower_email
    ON public.users (lower(email));
