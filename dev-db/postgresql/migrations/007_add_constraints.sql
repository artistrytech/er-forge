-- 制約の追加（K-08 の「変更」/ E-01・E-02 のエッジとカーディナリティ）。
--
-- - UNIQUE が付くと、親から見た子の多重度が 0..N → 0..1 に変わる（物理から導出できる部分）
-- - FK が増えると ER図に実線エッジが1本増える
-- 「親から見た子の下限が 0 か 1 か」は業務ルールであり DB からは導出できない。
-- そこは meta.relations で人が設定する（P-11）。

-- 003 で追加した SKU に一意制約を付ける
ALTER TABLE public.products
    ADD CONSTRAINT products_sku_key UNIQUE (sku);

-- 新しい参照関係（キャンペーン → 対象カテゴリ）
ALTER TABLE public.point_promotions
    ADD COLUMN category_id INT REFERENCES public.product_categories(id);
COMMENT ON COLUMN public.point_promotions.category_id IS '対象カテゴリ';
