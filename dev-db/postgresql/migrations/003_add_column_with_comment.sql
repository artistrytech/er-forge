-- カラムの追加と、コメントからの論理名の初期値補完（K-14 / P-02）。
--
-- 逆生成の適用時、論理名が未設定のカラムに限り、DB コメントの1行目が
-- meta.columns.<name>.displayName の初期値として書き込まれる。
-- **すでに人が設定した論理名は決して上書きされない**（そこが確認したい点）。

ALTER TABLE public.products
    ADD COLUMN sku VARCHAR(64),
    ADD COLUMN discontinued_at TIMESTAMPTZ;

COMMENT ON COLUMN public.products.sku IS '商品コード（SKU）';
COMMENT ON COLUMN public.products.discontinued_at IS '販売終了日時';

-- 既存カラムにコメントを後付けする。ここも「未設定なら補完、設定済みなら不変」の対象
COMMENT ON COLUMN public.products.price IS '販売価格（税抜）';
