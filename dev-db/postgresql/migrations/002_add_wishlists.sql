-- テーブルの追加（K-08 の「追加」/ K-12 の未配置トレイ）。
-- 適用後に逆生成すると、2テーブルが「追加」として現れ、どのページにも配置されていないため
-- 未配置トレイに NEW バッジ付きで並ぶ。ここから配置するまで diagrams/** は一切変わらない。

CREATE TABLE public.wishlists (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES public.users(id),
    title VARCHAR(255) NOT NULL,
    is_public BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE public.wishlists IS 'ほしい物リスト';
COMMENT ON COLUMN public.wishlists.title IS 'リスト名';

CREATE TABLE public.wishlist_items (
    id SERIAL PRIMARY KEY,
    wishlist_id INT NOT NULL REFERENCES public.wishlists(id) ON DELETE CASCADE,
    product_id INT NOT NULL REFERENCES public.products(id),
    added_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (wishlist_id, product_id)
);
COMMENT ON TABLE public.wishlist_items IS 'ほしい物リスト明細';
