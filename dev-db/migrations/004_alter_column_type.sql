-- 型・NULL 可否・デフォルトの変更（K-08 の「変更」）。
-- 差分プレビューではカラム単位まで展開され、1カラム1行の差分になる（§5.11）。

-- 桁数の拡張（varchar(255) → varchar(512)）
ALTER TABLE public.products
    ALTER COLUMN product_name TYPE VARCHAR(512);

-- NULL 可 → NOT NULL + デフォルト
UPDATE public.products SET description = '' WHERE description IS NULL;
ALTER TABLE public.products
    ALTER COLUMN description SET DEFAULT '',
    ALTER COLUMN description SET NOT NULL;

-- 数値型の精度変更
ALTER TABLE public.products
    ALTER COLUMN price TYPE NUMERIC(12,2);
