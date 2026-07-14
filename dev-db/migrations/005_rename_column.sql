-- カラムのリネーム（K-09 のリネーム候補・カラム編）。
--
-- 逆生成はこれを「削除 + 追加」としても解釈できてしまう。承認すればリネームとして扱われ、
-- そのカラムの論理名・注記（meta.columns.<name>）が新しい名前に追随する。
-- 却下すれば削除 + 追加になり、論理名は失われる（差分プレビューが警告する）。

ALTER TABLE public.user_profiles
    RENAME COLUMN full_name TO display_name;

COMMENT ON COLUMN public.user_profiles.display_name IS '表示名';
